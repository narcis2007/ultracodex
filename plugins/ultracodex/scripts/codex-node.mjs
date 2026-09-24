#!/usr/bin/env node
// ultracodex runner — runs one Codex CLI job (`codex exec`, `exec review` or
// `exec resume`) on behalf of Claude Code, outside the lifetime of any single
// Bash tool call.
//
// `start` validates the request and hands it to a detached supervisor, which owns
// the Codex process: it enforces the deadline, tears down exactly the process
// tree it started (taskkill /T on Windows, the process group elsewhere), retries
// transient API failures with backoff, and writes one fail-closed JSON envelope
// with provenance (thread id, model, effort, token usage). Callers poll with
// `wait`, which returns within two minutes, so no Bash call ever blocks for long
// and a relay that stops polling is detected and cleaned up.
//
// Every command prints exactly one JSON line tagged {"ultracodex":1,...}.
// Exit codes: 0 done/ok, 1 failed or rejected, 2 usage error, 3 still running.

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNNER_VERSION = "0.3.0";
export const RUNNER_FILE = fileURLToPath(import.meta.url);

export const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const SANDBOXES = Object.freeze(["read-only", "workspace-write"]);
export const TIERS = Object.freeze(["light", "daily", "final"]);
export const KINDS = Object.freeze(["verify", "ask", "review", "implement"]);

// Routing policy (owner's rule, 2026-09-23): luna always at max; sol at xhigh for
// fan-out verification and max for single long tasks; astra at max for the final
// or hardest work. `ultra` is never chosen implicitly — a caller must ask for it.
export const POLICY = Object.freeze({
  models: Object.freeze({ light: "gpt-6-luna", daily: "gpt-6-sol", final: "gpt-6-astra" }),
  efforts: Object.freeze({
    light: Object.freeze({ verify: "max", ask: "max", review: "max", implement: "max" }),
    daily: Object.freeze({ verify: "xhigh", ask: "max", review: "max", implement: "max" }),
    final: Object.freeze({ verify: "max", ask: "max", review: "max", implement: "max" }),
  }),
  // Per-attempt deadline = base(kind) × model factor × effort factor. Generous on
  // purpose: a deadline is a runaway guard, not an estimate (measured on this
  // machine: astra@max review lens 25–35 min, implementation 30–60 min).
  baseDeadlineSec: Object.freeze({ verify: 1500, ask: 1800, review: 2700, implement: 5400 }),
  modelFactor: Object.freeze({ "gpt-6-luna": 0.5, "gpt-6-sol": 1, "gpt-6-astra": 1.5 }),
  effortFactor: Object.freeze({ low: 0.5, medium: 0.6, high: 0.8, xhigh: 1, max: 1, ultra: 1.5 }),
  // Concurrency weight: an astra run counts as two slots.
  weight: Object.freeze({ "gpt-6-astra": 2 }),
  // Models whose catalog entry lists `ultra` (used when no catalog cache exists yet).
  ultraModels: Object.freeze(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]),
});

export const MAX_TIMEOUT_SEC = 4 * 3600;
export const MAX_TASK_BYTES = 4 * 1024 * 1024;
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_META_BYTES = 8 * 1024;
export const DEFAULT_MAX_WAIT_SEC = 110; // stays under the Bash tool's 2-minute default timeout
export const FRAME_SCHEMA_MARK = "---ULTRACODEX-SCHEMA---";
export const FRAME_TASK_MARK = "---ULTRACODEX-TASK---";

function envInt(name, fallback, env = process.env) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Timing knobs; the env overrides exist so the offline tests run in seconds.
export const TIMING = Object.freeze({
  pollMs: envInt("ULTRACODEX_POLL_MS", 1000),
  aliveMs: envInt("ULTRACODEX_ALIVE_MS", 10_000),
  lostAfterMs: envInt("ULTRACODEX_LOST_AFTER_MS", 120_000),
  backoffMs: envInt("ULTRACODEX_BACKOFF_MS", 20_000),
  slotPollMs: envInt("ULTRACODEX_SLOT_POLL_MS", 2000),
  slotStaleMs: envInt("ULTRACODEX_SLOT_STALE_MS", 60_000),
  killGraceMs: envInt("ULTRACODEX_KILL_GRACE_MS", 5000),
  minOrphanSec: envInt("ULTRACODEX_MIN_ORPHAN_SEC", 60),
  minTimeoutSec: envInt("ULTRACODEX_MIN_TIMEOUT_SEC", 60),
  treeSnapshotMs: envInt("ULTRACODEX_TREE_SNAPSHOT_MS", 20_000), // fallback mode only (no Job Object)
});

// ─── small utilities ────────────────────────────────────────────────────────

export class RequestError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

class UsageError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Races a promise against a timer that is cleared as soon as the race settles, so a
// finished supervisor never lingers on a pending timer.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() => clearTimeout(timer));
}
const nowIso = () => new Date().toISOString();
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compact(text, max = 2000) {
  const value = String(text ?? "").trim();
  return value.length <= max ? value : value.slice(0, max) + "...<truncated>";
}

function isFileSync(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirSync(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readTextSafe(file) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      // EBUSY/EPERM while a writer renames the file on Windows — retry shortly.
    }
  }
  return null;
}

function readJsonSafe(file) {
  const text = readTextSafe(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // brief spin: a reader may hold the target open on Windows
      }
    }
  }
}

// A synchronous pause without spinning the CPU (callers below are synchronous).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows refuses a rename for a moment when a scanner (Defender, the indexer) holds a
// handle on something just written: EPERM/EACCES/EBUSY, measured at ~1 % of directory
// renames. Those are retried for up to ~1 s; anything else (ENOENT: someone else moved
// it first, EEXIST/ENOTEMPTY: the target was recreated) is thrown at once.
function renameRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 40) throw error;
      sleepSync(25);
    }
  }
}

function writeText(file, text) {
  try {
    fs.writeFileSync(file, text);
  } catch {
    // best effort (heartbeats)
  }
}

function appendLine(file, line) {
  try {
    fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
  } catch {
    // best effort (supervisor log)
  }
}

function stripQuotes(value) {
  return String(value).trim().replace(/^"|"$/g, "");
}

function pathEntries(env = process.env) {
  return String(env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => stripQuotes(entry))
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values));
}

// ─── text integrity (shared with the Workflow helper) ───────────────────────

// Trailing spaces and no-break spaces (U+00A0) at line ends; built from char codes so
// the source stays pure ASCII.
const TRAILING_SPACE_RE = new RegExp("[ " + String.fromCharCode(0xa0) + "]+$", "gm");

// The Workflow helper applies the same normalization before hashing and sending,
// so the runner can prove the relay copied the request byte-for-byte.
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(TRAILING_SPACE_RE, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

// FNV-1a over UTF-16 code units, 8 hex digits. Integrity against accidental
// corruption by the relaying model, not a security primitive.
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function schemaHash(schema) {
  return fnv1a(schema === null || schema === undefined ? "null" : JSON.stringify(schema));
}

// ─── policy ─────────────────────────────────────────────────────────────────

export function tierForModel(model) {
  return Object.entries(POLICY.models).find(([, slug]) => slug === model)?.[0] ?? null;
}

export function computeDeadlineSec(model, effort, kind) {
  const base = POLICY.baseDeadlineSec[kind] ?? POLICY.baseDeadlineSec.ask;
  const modelFactor = POLICY.modelFactor[model] ?? 1;
  const effortFactor = POLICY.effortFactor[effort] ?? 1;
  return clamp(Math.round(base * modelFactor * effortFactor), 120, MAX_TIMEOUT_SEC);
}

export function resolvePolicy({ tier = "daily", kind = "ask", model, effort, timeoutSec } = {}) {
  const resolvedModel = model ?? POLICY.models[tier] ?? POLICY.models.daily;
  const effectiveTier = tierForModel(resolvedModel) ?? tier;
  const resolvedEffort = effort ?? POLICY.efforts[effectiveTier]?.[kind] ?? "max";
  return {
    tier: effectiveTier,
    kind,
    model: resolvedModel,
    effort: resolvedEffort,
    timeoutSec: timeoutSec ?? computeDeadlineSec(resolvedModel, resolvedEffort, kind),
    weight: POLICY.weight[resolvedModel] ?? 1,
  };
}

export function policyTable() {
  const rows = [];
  for (const tier of TIERS) {
    for (const kind of KINDS) rows.push(resolvePolicy({ tier, kind }));
  }
  return rows;
}

// ─── schema presets & strictness ────────────────────────────────────────────

const STR = Object.freeze({ type: "string" });

export const SCHEMA_PRESETS = Object.freeze({
  verdict: {
    type: "object",
    additionalProperties: false,
    required: ["refuted", "confidence", "reasoning"],
    properties: {
      refuted: { type: "boolean", description: "true when the claim does not hold (or cannot be confirmed)" },
      confidence: { type: "number", description: "0..1" },
      reasoning: STR,
    },
  },
  score: {
    type: "object",
    additionalProperties: false,
    required: ["score", "rationale"],
    properties: { score: { type: "number", description: "0..10" }, rationale: STR },
  },
  review: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings"],
    properties: {
      verdict: { type: "string", enum: ["approve", "approve_with_nits", "request_changes", "blocked"] },
      summary: STR,
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "severity",
            "category",
            "title",
            "file",
            "line",
            "evidence",
            "failure_scenario",
            "recommendation",
            "confidence",
          ],
          properties: {
            id: STR,
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            category: STR,
            title: STR,
            file: STR,
            line: { type: ["integer", "null"] },
            evidence: STR,
            failure_scenario: STR,
            recommendation: STR,
            confidence: { type: "number", description: "0..1" },
          },
        },
      },
    },
  },
  implement: {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "tasks", "files_changed", "commands_run", "tests", "open_questions", "risks"],
    properties: {
      status: { type: "string", enum: ["complete", "partial", "blocked"] },
      summary: STR,
      tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "status", "reason_if_not_done"],
          properties: {
            id: STR,
            title: STR,
            status: { type: "string", enum: ["done", "partial", "not_done"] },
            reason_if_not_done: { type: ["string", "null"] },
          },
        },
      },
      files_changed: { type: "array", items: STR },
      commands_run: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["command", "exit_code", "outcome"],
          properties: { command: STR, exit_code: { type: ["integer", "null"] }, outcome: STR },
        },
      },
      tests: {
        type: "object",
        additionalProperties: false,
        required: ["ran", "passed", "failed", "notes"],
        properties: {
          ran: { type: "boolean" },
          passed: { type: ["integer", "null"] },
          failed: { type: ["integer", "null"] },
          notes: STR,
        },
      },
      open_questions: { type: "array", items: STR },
      risks: { type: "array", items: STR },
    },
  },
});

function escapePointer(key) {
  return String(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

// OpenAI strict structured outputs reject a schema before the run starts when any
// object lacks additionalProperties:false or leaves a property out of `required`
// — at every nesting level. Checking it here turns a dead 10-second run into an
// immediate, precise error.
export function checkStrictSchema(schema) {
  if (!isPlainObject(schema)) return ["#: schema must be a JSON object"];
  const errors = [];
  if (schema.type !== "object") errors.push('#: root "type" must be "object"');
  const visit = (node, pointer, depth) => {
    if (depth > 64) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1));
      return;
    }
    if (!isPlainObject(node)) return;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object") || isPlainObject(node.properties)) {
      if (node.additionalProperties !== false) {
        errors.push(`${pointer}: additionalProperties must be false`);
      }
      const properties = isPlainObject(node.properties) ? Object.keys(node.properties) : [];
      const required = Array.isArray(node.required) ? node.required : [];
      const missing = properties.filter((name) => !required.includes(name));
      const unknown = required.filter((name) => !properties.includes(name));
      if (missing.length) {
        errors.push(`${pointer}: "required" must list every property (missing: ${missing.join(", ")})`);
      }
      if (unknown.length) {
        errors.push(`${pointer}: "required" names unknown properties (${unknown.join(", ")})`);
      }
    }
    for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
      if (!isPlainObject(node[key])) continue;
      for (const [name, child] of Object.entries(node[key])) {
        visit(child, `${pointer}/${key}/${escapePointer(name)}`, depth + 1);
      }
    }
    for (const key of ["items", "additionalItems", "contains", "not"]) {
      if (node[key] && typeof node[key] === "object") visit(node[key], `${pointer}/${key}`, depth + 1);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      if (Array.isArray(node[key])) visit(node[key], `${pointer}/${key}`, depth + 1);
    }
  };
  visit(schema, "#", 0);
  return errors;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function typeMatches(value, type) {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return true;
  }
}

function resolveLocalRef(root, ref) {
  if (ref === "#" || ref === "") return root;
  if (!ref.startsWith("#/")) return null;
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object" || !(key in node)) return null;
    node = node[key];
  }
  return node;
}

// Defense in depth: Codex already enforces --output-schema server-side; this
// re-checks the strict subset (types, enums, required, extra keys, items, anyOf,
// local $ref) on what actually came back.
export function validateValue(value, schema, root = schema, at = "$", errors = [], depth = 0) {
  if (depth > 64 || !isPlainObject(schema)) return errors;
  if (typeof schema.$ref === "string") {
    const target = resolveLocalRef(root, schema.$ref);
    return target ? validateValue(value, target, root, at, errors, depth + 1) : errors;
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some(
      (option) => validateValue(value, option, root, at, [], depth + 1).length === 0
    );
    if (!matches) errors.push(`${at}: matches none of anyOf`);
    return errors;
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) errors.push(`${at}: must equal const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${at}: not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at}: expected ${types.join("|")}`);
      return errors;
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) errors.push(`${at}.${name}: missing`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        validateValue(child, properties[name], root, `${at}.${name}`, errors, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}.${name}: not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateValue(child, schema.additionalProperties, root, `${at}.${name}`, errors, depth + 1);
      }
    }
  }
  if (Array.isArray(value)) {
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => validateValue(item, schema.items, root, `${at}[${index}]`, errors, depth + 1));
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${at}: too many items`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${at}: too long`);
  }
  return errors;
}

// ─── requests ───────────────────────────────────────────────────────────────

const REQUEST_FIELDS = new Set([
  "v",
  "task",
  "taskFile",
  "schema",
  "schemaFile",
  "schemaPreset",
  "cwd",
  "sandbox",
  "tier",
  "kind",
  "model",
  "effort",
  "hermetic",
  "network",
  "timeoutSec",
  "maxAttempts",
  "replaySafe",
  "workItems",
  "attached",
  "orphanAfterSec",
  "ephemeral",
  "label",
  "serviceTier",
  "addDirs",
  "images",
  "profile",
  "review",
  "resume",
  "taskHash",
  "schemaHash",
  "meta",
  "nonce",
]);

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const COMMIT_RE = /^[0-9a-fA-F]{7,40}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
export const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function expectBoolean(raw, name, fallback) {
  if (raw[name] === undefined) return fallback;
  if (typeof raw[name] !== "boolean") throw new RequestError("invalid_request", `${name} must be a boolean`);
  return raw[name];
}

function expectInteger(raw, name, lo, hi, fallback) {
  if (raw[name] === undefined || raw[name] === null) return fallback;
  const value = raw[name];
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw new RequestError("invalid_request", `${name} must be an integer from ${lo} to ${hi}`);
  }
  return value;
}

function expectEnum(raw, name, allowed, fallback) {
  if (raw[name] === undefined || raw[name] === null) return fallback;
  if (!allowed.includes(raw[name])) {
    throw new RequestError("invalid_request", `${name} must be one of: ${allowed.join(", ")}`);
  }
  return raw[name];
}

function readBoundedFile(file, maxBytes, name) {
  const resolved = path.resolve(file);
  let info;
  try {
    info = fs.statSync(resolved);
  } catch {
    throw new RequestError("invalid_request", `${name} does not exist: ${resolved}`);
  }
  if (!info.isFile()) throw new RequestError("invalid_request", `${name} is not a file: ${resolved}`);
  if (info.size > maxBytes) throw new RequestError("invalid_request", `${name} exceeds ${maxBytes} bytes`);
  return fs.readFileSync(resolved, "utf8");
}

export function modelSupportsEffort(model, effort, catalog) {
  const entry = catalog?.models?.find((item) => item.slug === model);
  if (entry && Array.isArray(entry.efforts) && entry.efforts.length) return entry.efforts.includes(effort);
  if (effort === "ultra") return POLICY.ultraModels.includes(model);
  return true;
}

// Returns a normalized request (task text loaded and normalized, schema resolved)
// or throws RequestError(kind, message).
// requestDigest is trusted input: framedToRaw's digest of a verified, signed request (never
// a request field). Requests from the conversation get directDigest(task).
export function validateRequest(raw, { catalog = null, requestDigest: signedDigest = null } = {}) {
  if (!isPlainObject(raw)) throw new RequestError("invalid_request", "request must be a JSON object");
  const unknown = Object.keys(raw).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknown.length) throw new RequestError("invalid_request", `unknown request fields: ${unknown.join(", ")}`);
  if (raw.nonce !== undefined && (typeof raw.nonce !== "string" || !NONCE_RE.test(raw.nonce))) {
    throw new RequestError("invalid_request", "nonce must look like <32 hex>.<counter>");
  }

  if (raw.review !== undefined && raw.resume !== undefined) {
    throw new RequestError("invalid_request", "review and resume are mutually exclusive");
  }
  const mode = raw.review !== undefined ? "review" : raw.resume !== undefined ? "resume" : "exec";

  if (raw.task !== undefined && raw.taskFile !== undefined) {
    throw new RequestError("invalid_request", "give either task or taskFile, not both");
  }
  let task = "";
  if (raw.taskFile !== undefined) {
    if (typeof raw.taskFile !== "string" || !raw.taskFile.trim()) {
      throw new RequestError("invalid_request", "taskFile must be a non-empty path");
    }
    task = readBoundedFile(raw.taskFile, MAX_TASK_BYTES, "taskFile");
  } else if (raw.task !== undefined) {
    if (typeof raw.task !== "string") throw new RequestError("invalid_request", "task must be a string");
    task = raw.task;
  }
  task = normalizeText(task);
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
    throw new RequestError("invalid_request", `task exceeds ${MAX_TASK_BYTES} bytes`);
  }
  if (!task && mode !== "review") throw new RequestError("invalid_request", "task must not be empty");

  const schemaSources = ["schema", "schemaFile", "schemaPreset"].filter(
    (key) => raw[key] !== undefined && raw[key] !== null
  );
  if (schemaSources.length > 1) {
    throw new RequestError("invalid_request", "give at most one of schema, schemaFile, schemaPreset");
  }
  let schema = null;
  if (raw.schema !== undefined && raw.schema !== null) {
    if (!isPlainObject(raw.schema)) throw new RequestError("invalid_request", "schema must be a JSON object");
    schema = raw.schema;
  } else if (raw.schemaFile !== undefined && raw.schemaFile !== null) {
    try {
      schema = JSON.parse(readBoundedFile(raw.schemaFile, MAX_SCHEMA_BYTES, "schemaFile"));
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError("invalid_request", `schemaFile is not valid JSON: ${error.message}`);
    }
  } else if (raw.schemaPreset !== undefined && raw.schemaPreset !== null && raw.schemaPreset !== "none") {
    schema = SCHEMA_PRESETS[raw.schemaPreset];
    if (!schema) {
      throw new RequestError(
        "invalid_request",
        `schemaPreset must be one of: ${Object.keys(SCHEMA_PRESETS).join(", ")}, none`
      );
    }
    schema = JSON.parse(JSON.stringify(schema));
  }
  if (schema) {
    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) {
      throw new RequestError("invalid_request", `schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
    }
    const problems = checkStrictSchema(schema);
    if (problems.length) {
      throw new RequestError("schema", `schema is not valid for OpenAI strict mode: ${problems.join("; ")}`);
    }
  }

  if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !raw.cwd.trim())) {
    throw new RequestError("invalid_request", "cwd must be a non-empty string");
  }
  const cwd = path.resolve(raw.cwd ?? process.cwd());
  if (!isDirSync(cwd)) throw new RequestError("invalid_request", `cwd is not a directory: ${cwd}`);

  const sandbox = expectEnum(raw, "sandbox", SANDBOXES, "read-only");
  if (mode === "review" && sandbox !== "read-only") {
    throw new RequestError("invalid_request", "review mode is read-only");
  }
  const tier = expectEnum(raw, "tier", TIERS, "daily");
  const defaultKind = mode === "review" ? "review" : sandbox === "workspace-write" ? "implement" : "ask";
  const kind = expectEnum(raw, "kind", KINDS, defaultKind);

  if (raw.model !== undefined && (typeof raw.model !== "string" || !MODEL_RE.test(raw.model))) {
    throw new RequestError("invalid_request", "model contains unsupported characters");
  }
  const effort = expectEnum(raw, "effort", EFFORTS, undefined);
  const minTimeout = Math.max(1, TIMING.minTimeoutSec);
  const timeoutSec = expectInteger(raw, "timeoutSec", minTimeout, MAX_TIMEOUT_SEC, undefined);
  const policy = resolvePolicy({ tier, kind, model: raw.model, effort, timeoutSec });
  // A batch of N items needs more time than one; scale the default deadline (x1.25 per
  // extra 1..4 items, at most x4). An explicit timeoutSec is never changed.
  const workItems = expectInteger(raw, "workItems", 1, 256, 1);
  const scaledTimeoutSec =
    timeoutSec ?? Math.min(MAX_TIMEOUT_SEC, Math.round(policy.timeoutSec * Math.min(4, 1 + (workItems - 1) * 0.25)));

  if (catalog?.models?.length && !catalog.models.some((item) => item.slug === policy.model)) {
    throw new RequestError(
      "model",
      `model ${policy.model} is not in the local Codex catalog (${catalog.models.map((m) => m.slug).join(", ")})`
    );
  }
  if (!modelSupportsEffort(policy.model, policy.effort, catalog)) {
    throw new RequestError("effort", `effort ${policy.effort} is not supported by ${policy.model}`);
  }

  let review = null;
  if (mode === "review") {
    if (!isPlainObject(raw.review)) throw new RequestError("invalid_request", "review must be an object");
    const extra = Object.keys(raw.review).filter((key) => !["base", "commit", "uncommitted", "title"].includes(key));
    if (extra.length) throw new RequestError("invalid_request", `unknown review fields: ${extra.join(", ")}`);
    const targets = ["base", "commit", "uncommitted"].filter(
      (key) => raw.review[key] !== undefined && raw.review[key] !== false && raw.review[key] !== null
    );
    if (targets.length !== 1) {
      throw new RequestError("invalid_request", "review needs exactly one of base, commit, uncommitted");
    }
    if (raw.review.base !== undefined && (typeof raw.review.base !== "string" || !BRANCH_RE.test(raw.review.base))) {
      throw new RequestError("invalid_request", "review.base must be a branch name");
    }
    if (raw.review.commit !== undefined && (typeof raw.review.commit !== "string" || !COMMIT_RE.test(raw.review.commit))) {
      throw new RequestError("invalid_request", "review.commit must be a commit sha");
    }
    if (raw.review.uncommitted !== undefined && raw.review.uncommitted !== true) {
      throw new RequestError("invalid_request", "review.uncommitted must be true when given");
    }
    if (raw.review.title !== undefined && (typeof raw.review.title !== "string" || raw.review.title.length > 200)) {
      throw new RequestError("invalid_request", "review.title must be a string of at most 200 characters");
    }
    review = {
      base: raw.review.base ?? null,
      commit: raw.review.commit ?? null,
      uncommitted: raw.review.uncommitted === true,
      title: raw.review.title ?? null,
    };
  }

  let resume = null;
  if (mode === "resume") {
    if (!isPlainObject(raw.resume) || typeof raw.resume.sessionId !== "string" || !SESSION_RE.test(raw.resume.sessionId)) {
      throw new RequestError("invalid_request", "resume.sessionId must be a Codex session/thread id");
    }
    const extra = Object.keys(raw.resume).filter((key) => key !== "sessionId");
    if (extra.length) throw new RequestError("invalid_request", `unknown resume fields: ${extra.join(", ")}`);
    resume = { sessionId: raw.resume.sessionId };
  }

  const listOf = (name, check, what) => {
    if (raw[name] === undefined) return [];
    if (!Array.isArray(raw[name]) || raw[name].length > 8) {
      throw new RequestError("invalid_request", `${name} must be an array of at most 8 paths`);
    }
    return raw[name].map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) throw new RequestError("invalid_request", `${name} entries must be paths`);
      const resolved = path.resolve(entry);
      if (!check(resolved)) throw new RequestError("invalid_request", `${name} entry is not ${what}: ${resolved}`);
      return resolved;
    });
  };

  let label = null;
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== "string") throw new RequestError("invalid_request", "label must be a string");
    label = raw.label.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
  }
  if (raw.profile !== undefined && (typeof raw.profile !== "string" || !PROFILE_RE.test(raw.profile))) {
    throw new RequestError("invalid_request", "profile must be a plain profile name");
  }
  let meta = null;
  if (raw.meta !== undefined && raw.meta !== null) {
    if (!isPlainObject(raw.meta)) throw new RequestError("invalid_request", "meta must be a JSON object");
    if (Buffer.byteLength(JSON.stringify(raw.meta), "utf8") > MAX_META_BYTES) {
      throw new RequestError("invalid_request", `meta exceeds ${MAX_META_BYTES} bytes`);
    }
    meta = raw.meta;
  }

  // A retry replays the whole task. For a writing task (workspace-write, or a resumed
  // session that may be writable) that can apply its effects twice, so it is never
  // retried automatically unless the caller vouches that the task is idempotent.
  const mutating = sandbox === "workspace-write" || mode === "resume";
  const replaySafe = expectBoolean(raw, "replaySafe", false);
  const maxAttempts = expectInteger(raw, "maxAttempts", 1, 4, mutating ? 1 : 2);
  if (mutating && maxAttempts > 1 && !replaySafe) {
    throw new RequestError(
      "invalid_request",
      "automatic retries of a writing task could apply its effects twice; set replaySafe: true only if the task is idempotent"
    );
  }

  const orphanFloor = Math.max(1, TIMING.minOrphanSec);
  return {
    mode,
    task,
    taskHash: fnv1a(task),
    schema,
    cwd,
    sandbox,
    tier: policy.tier,
    kind,
    model: policy.model,
    effort: policy.effort,
    timeoutSec: scaledTimeoutSec,
    workItems,
    weight: policy.weight,
    hermetic: expectBoolean(raw, "hermetic", true),
    network: expectBoolean(raw, "network", false),
    maxAttempts,
    replaySafe,
    attached: expectBoolean(raw, "attached", true),
    orphanAfterSec: expectInteger(raw, "orphanAfterSec", orphanFloor, 3600, Math.max(orphanFloor, 300)),
    ephemeral: expectBoolean(raw, "ephemeral", kind !== "implement" && mode !== "resume"),
    label,
    serviceTier: expectEnum(raw, "serviceTier", ["default", "priority"], null),
    addDirs: listOf("addDirs", isDirSync, "a directory"),
    images: listOf("images", isFileSync, "a file"),
    profile: raw.profile ?? null,
    review,
    resume,
    meta,
    nonce: raw.nonce ?? null,
    requestDigest: signedDigest ?? directDigest(task),
  };
}

// ─── framed requests (what the Workflow relay pipes in) ─────────────────────
//
// Frame: one JSON header line, the schema, then the raw task. Hashes in the header
// let the runner reject a copy the relaying model altered.
//
// Frames from the Workflow helper are *encoded* ("UCXF1" first line) because two
// things break text on its way through a model's Bash tool call on Windows:
//   • backslash pairs get halved (`\\` → `\`), and
//   • a command longer than ~7 KB is cut off by the Windows command-line limit.
// So `%`, `\`, `'` and invisible/control characters are percent-encoded (the
// encoded text contains no quote or backslash at all), lines longer than
// FRAME_LINE_MAX are split with a `%+` continuation suffix (`%` never occurs raw),
// and the frame travels in parts of at most FRAME_PART_MAX characters, one small
// `part` command each.

export const FRAME_MAGIC = "UCXF1";
export const FRAME_LINE_MAX = 400;
export const FRAME_PART_MAX = 1600;

// Everything a copying model could drop, reorder or misread travels escaped:
// % \ ' , every control (Cc), format (Cf: soft hyphen, bidi controls, zero-width
// characters, BOM, tag characters …), lone surrogate (Cs) and separator/space
// character (Z*) except the plain space, and variation selectors.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zs}\p{Zl}\p{Zp}]/u;

export function mustEscape(char) {
  const code = char.codePointAt(0);
  if (code === 0x0a || code === 0x20) return false;
  if (code === 0x25 || code === 0x5c || code === 0x27) return true;
  if ((code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef)) return true;
  return INVISIBLE_RE.test(char);
}

export function encodeFrameText(text) {
  let out = "";
  for (const char of String(text)) {
    if (!mustEscape(char)) {
      out += char;
      continue;
    }
    const code = char.codePointAt(0);
    if (code === 0x25) out += "%25";
    else if (code === 0x5c) out += "%5C";
    else if (code === 0x27) out += "%27";
    else if (code > 0xffff) out += "%U" + code.toString(16).toUpperCase().padStart(6, "0");
    else out += "%u" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

// Page data (see "Paged results") is encoded the same way plus the double quote, so a
// page line holds no backslash and no quote at all: its JSON needs no escaping, and a
// copying relay has nothing to "fix". An encoded frame never contains a raw %22 (every
// % is escaped), so decoding it here too is backward compatible.
export function encodePageText(text) {
  return encodeFrameText(text).replace(/"/g, "%22");
}

export function decodeFrameText(text) {
  return String(text).replace(/%(25|5C|27|22|u[0-9A-F]{4}|U[0-9A-F]{6})/g, (match, code) => {
    if (code === "25") return "%";
    if (code === "5C") return "\\";
    if (code === "27") return "'";
    if (code === "22") return '"';
    if (code[0] === "u") return String.fromCharCode(parseInt(code.slice(1), 16));
    return String.fromCodePoint(parseInt(code.slice(1), 16));
  });
}

// Joins `%+` continuation lines, then percent-decodes each logical line.
export function unwrapEncodedFrame(lines) {
  const logical = [];
  let pending = "";
  for (const line of lines) {
    if (line.endsWith("%+")) {
      pending += line.slice(0, -2);
      continue;
    }
    logical.push(decodeFrameText(pending + line));
    pending = "";
  }
  if (pending) logical.push(decodeFrameText(pending));
  return logical;
}

// `encoded: true` (relay uploads) always percent-decodes; otherwise a leading FRAME_MAGIC
// line marks an encoded frame and anything else is read as a plain frame.
export function parseFramed(text, { encoded = false } = {}) {
  let lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const magicAt = lines.findIndex((line) => line.trim() !== "");
  const hasMagic = magicAt >= 0 && lines[magicAt].trim() === FRAME_MAGIC;
  if (encoded || hasMagic) {
    const body = hasMagic ? lines.slice(magicAt + 1) : lines;
    while (body.length && body.at(-1) === "") body.pop();
    lines = unwrapEncodedFrame(body);
  }
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first += 1;
  let header;
  try {
    header = JSON.parse(lines[first] ?? "");
  } catch {
    throw new RequestError("relay_corruption", "framed request header is not a JSON line");
  }
  if (!isPlainObject(header)) throw new RequestError("relay_corruption", "framed request header is not an object");
  const schemaAt = lines.findIndex((line, index) => index > first && line.trim() === FRAME_SCHEMA_MARK);
  const taskAt = lines.findIndex((line, index) => index > schemaAt && line.trim() === FRAME_TASK_MARK);
  if (schemaAt < 0 || taskAt < 0) {
    throw new RequestError("relay_corruption", "framed request is missing its schema/task markers");
  }
  const schemaText = lines.slice(schemaAt + 1, taskAt).join("\n").trim();
  let schema = null;
  if (schemaText && schemaText !== "null") {
    try {
      schema = JSON.parse(schemaText);
    } catch {
      throw new RequestError("relay_corruption", "framed schema is not valid JSON");
    }
  }
  return { header, schema, task: lines.slice(taskAt + 1).join("\n") };
}

// Returns { raw, requestDigest }. The transport hashes (h, taskHash, schemaHash) catch a
// relay's copying mistakes (retryable); the request signature (rmac, see "request and
// result authentication") proves the Workflow helper built this exact request — a frame
// a relay composed itself, however consistent its hashes, is refused.
export function framedToRaw({ header, schema, task }, { key = null } = {}) {
  // A frame without its integrity fields is never accepted: omitting them must not be
  // a way around the checks.
  for (const field of ["h", "taskHash", "schemaHash"]) {
    if (typeof header[field] !== "string" || !/^[0-9a-f]{8}$/.test(header[field])) {
      throw new RequestError("relay_corruption", `framed request lacks its ${field}`);
    }
  }
  const { h, rmac, ...rest } = header;
  if (fnv1a(JSON.stringify(rest)) !== h) {
    throw new RequestError("relay_corruption", "request header differs from what the workflow sent (hash mismatch)");
  }
  if (fnv1a(normalizeText(task)) !== header.taskHash) {
    throw new RequestError("relay_corruption", "task text differs from what the workflow sent (hash mismatch)");
  }
  if (schemaHash(schema) !== header.schemaHash) {
    throw new RequestError("relay_corruption", "schema differs from what the workflow sent (hash mismatch)");
  }
  if (typeof header.nonce !== "string" || !NONCE_RE.test(header.nonce)) {
    throw new RequestError("unauthenticated_request", "relayed request carries no valid nonce");
  }
  const { rmac: omitted, ...signed } = header; // every field the helper signed, in its order
  const digest = requestDigest(signed, schema, task);
  if (typeof rmac !== "string" || !KEY_RE.test(rmac) || !key || !sameHex(rmac, requestMac(key, digest))) {
    throw new RequestError(
      "unauthenticated_request",
      "the request is not signed with this machine's key: a relay may only upload requests the Workflow helper built"
    );
  }
  // Framed requests come from a relaying model. Whatever it was told, it may only
  // start read-only, hermetic jobs with the task it was given inline — never a
  // write sandbox, a resumed (possibly writable) session, local files or config.
  const forbidden = ["taskFile", "schemaFile", "resume", "addDirs", "images", "profile", "network"].filter(
    (key) => header[key] !== undefined && header[key] !== null && header[key] !== false
  );
  if (header.sandbox !== undefined && header.sandbox !== "read-only") forbidden.push("sandbox");
  if (header.hermetic === false) forbidden.push("hermetic");
  if (forbidden.length) {
    throw new RequestError("invalid_request", `relayed requests are read-only and hermetic; not allowed: ${forbidden.join(", ")}`);
  }
  const raw = { ...header, task };
  delete raw.v;
  delete raw.h;
  delete raw.taskHash;
  delete raw.schemaHash;
  delete raw.rmac;
  if (schema !== null) raw.schema = schema;
  return { raw, requestDigest: digest };
}

// ─── locating the Codex CLI ─────────────────────────────────────────────────

const TARGETS = Object.freeze({
  "win32-x64": ["x86_64-pc-windows-msvc", "@openai/codex-win32-x64"],
  "win32-arm64": ["aarch64-pc-windows-msvc", "@openai/codex-win32-arm64"],
  "darwin-x64": ["x86_64-apple-darwin", "@openai/codex-darwin-x64"],
  "darwin-arm64": ["aarch64-apple-darwin", "@openai/codex-darwin-arm64"],
  "linux-x64": ["x86_64-unknown-linux-musl", "@openai/codex-linux-x64"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "@openai/codex-linux-arm64"],
});

function nativeFromPackageRoot(root) {
  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) return null;
  const [triple, platformPackage] = target;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = [];
  try {
    const require = createRequire(path.join(root, "bin", "codex.js"));
    const packageJson = require.resolve(`${platformPackage}/package.json`);
    candidates.push(path.join(path.dirname(packageJson), "vendor", triple, "bin", exe));
  } catch {
    // fall through to the legacy in-package vendor layout
  }
  candidates.push(path.join(root, "vendor", triple, "bin", exe));
  return candidates.find((candidate) => isFileSync(candidate)) ?? null;
}

// Mirrors what the npm shim (bin/codex.js) does: find the native binary and set the
// same two environment variables — but spawns the binary directly, so the process
// tree we tear down is rooted at codex itself rather than at a Node wrapper.
function launcherFromPackageRoot(root, source) {
  const script = path.join(root, "bin", "codex.js");
  if (!isFileSync(script)) return null;
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // keep the lexical root
  }
  const native = nativeFromPackageRoot(realRoot);
  if (native) {
    return {
      command: native,
      argsPrefix: [],
      env: { CODEX_MANAGED_PACKAGE_ROOT: realRoot, CODEX_MANAGED_BY_NPM: "1" },
      displayPath: native,
      source: `${source}:npm-native`,
    };
  }
  return { command: process.execPath, argsPrefix: [script], env: {}, displayPath: script, source: `${source}:npm-script` };
}

function findOnPath(command, env = process.env) {
  const names =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"].map((ext) => command + ext) : [command];
  for (const directory of pathEntries(env)) {
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (isFileSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveCodexLauncher({ env = process.env, explicitPath } = {}) {
  const explicit = explicitPath ?? env.ULTRACODEX_CODEX_PATH;
  if (explicit) {
    const candidate = path.resolve(stripQuotes(explicit));
    if (!isFileSync(candidate)) throw new Error(`configured Codex executable does not exist: ${candidate}`);
    const extension = path.extname(candidate).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(extension)) {
      if (path.basename(candidate) === "codex.js") {
        const launcher = launcherFromPackageRoot(path.dirname(path.dirname(candidate)), "explicit");
        if (launcher) return launcher;
      }
      return { command: process.execPath, argsPrefix: [candidate], env: {}, displayPath: candidate, source: "explicit:script" };
    }
    if ([".cmd", ".bat", ".ps1"].includes(extension)) {
      const launcher = launcherFromPackageRoot(path.join(path.dirname(candidate), "node_modules", "@openai", "codex"), "explicit");
      if (launcher) return launcher;
      throw new Error(`cannot resolve the Codex binary behind ${candidate}; point ULTRACODEX_CODEX_PATH at codex.exe or codex.js`);
    }
    return { command: candidate, argsPrefix: [], env: {}, displayPath: candidate, source: "explicit" };
  }

  const roots = [];
  if (process.platform === "win32" && env.APPDATA) roots.push(path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex"));
  for (const directory of pathEntries(env)) {
    roots.push(path.join(directory, "node_modules", "@openai", "codex"));
    roots.push(path.join(directory, "..", "lib", "node_modules", "@openai", "codex"));
  }
  for (const root of unique(roots.map((root) => path.resolve(root)))) {
    const launcher = launcherFromPackageRoot(root, "npm");
    if (launcher) return launcher;
  }

  const onPath = findOnPath("codex", env);
  if (onPath) {
    let real = onPath;
    try {
      real = fs.realpathSync(onPath);
    } catch {
      // keep the PATH entry
    }
    if (path.basename(real) === "codex.js") {
      const launcher = launcherFromPackageRoot(path.dirname(path.dirname(real)), "path");
      if (launcher) return launcher;
    }
    if (process.platform !== "win32" || path.extname(real).toLowerCase() === ".exe") {
      return { command: real, argsPrefix: [], env: {}, displayPath: real, source: "path" };
    }
  }
  throw new Error("Codex CLI was not found. Install it (npm i -g @openai/codex) or set ULTRACODEX_CODEX_PATH.");
}

// Hermetic runs skip ~/.codex/config.toml, which also drops the Windows sandbox
// choice; carry that one setting over so read-only still means sandboxed.
export function readUserWindowsSandbox(env = process.env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  const text = readTextSafe(path.join(home, "config.toml"));
  if (text === null) return null;
  // Accepts the TOML spellings Codex itself accepts: a [windows] table (quoted or not),
  // a top-level dotted key windows.sandbox = "…", and an inline table windows = { sandbox = "…" }.
  let table = null; // null = top level
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\s*("windows"|'windows'|windows)\s*\]$/.exec(line);
    if (line.startsWith("[")) {
      table = header ? "windows" : "other";
      continue;
    }
    if (table === "windows") {
      const match = /^["']?sandbox["']?\s*=\s*["']([A-Za-z0-9_-]+)["']/.exec(line);
      if (match) return match[1];
    } else if (table === null) {
      const dotted = /^["']?windows["']?\s*\.\s*["']?sandbox["']?\s*=\s*["']([A-Za-z0-9_-]+)["']/.exec(line);
      if (dotted) return dotted[1];
      const inline = /^["']?windows["']?\s*=\s*\{[^}]*\bsandbox\s*=\s*["']([A-Za-z0-9_-]+)["']/.exec(line);
      if (inline) return inline[1];
    }
  }
  return null;
}

// ─── codex invocation ───────────────────────────────────────────────────────

export function buildCodexArgs(request, files, { platform = process.platform, windowsSandbox = null } = {}) {
  const args = ["exec"];
  if (request.mode === "review") args.push("review");
  if (request.mode === "resume") args.push("resume", request.resume.sessionId);
  // `-i` takes several values; keep it before any other flag so the trailing `-`
  // (prompt from stdin) is never swallowed as an image path.
  if (request.mode !== "review") for (const image of request.images) args.push("-i", image);
  if (request.mode === "review") {
    if (request.review.base) args.push("--base", request.review.base);
    else if (request.review.commit) args.push("--commit", request.review.commit);
    else if (request.review.uncommitted) args.push("--uncommitted");
    if (request.review.title) args.push("--title", request.review.title);
  }
  if (request.mode === "exec") args.push("-s", request.sandbox, "-C", request.cwd);
  if (request.mode !== "review") args.push("--skip-git-repo-check");
  args.push("--json", "-o", files.lastMessage);
  args.push("-m", request.model, "-c", `model_reasoning_effort="${request.effort}"`);
  if (files.schema) args.push("--output-schema", files.schema);
  if (request.ephemeral) args.push("--ephemeral");
  if (request.hermetic) {
    args.push("--ignore-user-config");
    if (platform === "win32" && windowsSandbox) args.push("-c", `windows.sandbox="${windowsSandbox}"`);
  }
  if (request.mode === "exec" && request.sandbox === "workspace-write" && request.network) {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  if (request.serviceTier) args.push("-c", `service_tier="${request.serviceTier}"`);
  // `exec review` / `exec resume` accept neither -p nor --add-dir (codex-cli 0.156).
  if (request.mode === "exec" && request.profile) args.push("-p", request.profile);
  if (request.mode === "exec") for (const directory of request.addDirs) args.push("--add-dir", directory);
  if (request.task) args.push("-");
  return args;
}

function addUsage(total, usage) {
  if (!isPlainObject(usage)) return total;
  const next = { ...(total ?? {}) };
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") next[key] = (next[key] ?? 0) + value;
  }
  return next;
}

export function summarizeEvents(text) {
  const summary = {
    threadId: null,
    usage: null,
    turnsCompleted: 0,
    turnFailed: null,
    errors: [],
    warnings: [],
    lastAgentMessage: null,
    nonJsonLines: 0,
  };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      summary.nonJsonLines += 1;
      continue;
    }
    switch (event?.type) {
      case "thread.started":
        summary.threadId = event.thread_id ?? summary.threadId;
        break;
      case "turn.completed":
        summary.turnsCompleted += 1;
        summary.usage = addUsage(summary.usage, event.usage);
        break;
      case "turn.failed":
        summary.turnFailed = isPlainObject(event.error) ? event.error : { message: String(event.error ?? "turn failed") };
        break;
      case "error":
        summary.errors.push(String(event.message ?? ""));
        break;
      case "item.completed":
        if (event.item?.type === "agent_message") summary.lastAgentMessage = String(event.item.text ?? "");
        else if (event.item?.type === "error") summary.warnings.push(String(event.item.message ?? ""));
        break;
      default:
        break;
    }
  }
  return summary;
}

// Codex wraps API errors as a JSON string inside the event message:
// {"type":"error","status":400,"error":{"type":..,"code":..,"message":..,"param":..}}
export function parseApiError(message) {
  const text = String(message ?? "");
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) {
      return {
        status: parsed.status ?? parsed.error?.status ?? null,
        code: parsed.error?.code ?? null,
        type: parsed.error?.type ?? null,
        param: parsed.error?.param ?? null,
        message: String(parsed.error?.message ?? parsed.message ?? text),
      };
    }
  } catch {
    // plain text
  }
  const status = /\b([45]\d\d)\b/.exec(text);
  return { status: status ? Number(status[1]) : null, code: null, type: null, param: null, message: text };
}

// MCP servers from the user's config log OAuth refresh failures on stderr even
// when the run itself is fine; never classify a run by those lines.
const STDERR_NOISE = [/codex_rmcp_client/i, /failed to refresh OAuth tokens/i];

export function classifyFailure({ summary = null, stderr = "", exitCode = null, timedOut, cancelled, abandoned, spawnError, emptyOutput } = {}) {
  const result = (kind, retryable, message, status = null) => ({ kind, retryable, message: compact(message), status });
  if (cancelled) return result("cancelled", false, "cancelled on request; the Codex process tree was stopped");
  if (abandoned) return result("abandoned", false, "the caller stopped polling; the Codex process tree was stopped");
  if (timedOut) return result("timeout", false, "deadline reached; the Codex process tree was stopped");
  if (spawnError) return result("spawn", false, String(spawnError));
  const failure = summary?.turnFailed?.message ?? summary?.errors?.at(-1) ?? null;
  const stderrText = String(stderr ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !STDERR_NOISE.some((pattern) => pattern.test(line)))
    .join("\n");
  const api = parseApiError(failure ?? stderrText);
  const message = (api.message || stderrText || "").trim() || `codex exited with code ${exitCode}`;
  const text = `${api.code ?? ""} ${api.param ?? ""} ${message}`.toLowerCase();
  const status = api.status;
  if (api.code === "invalid_json_schema" || /invalid_json_schema|invalid schema for response_format/.test(text)) {
    return result("schema", false, message, status);
  }
  if (api.code === "unsupported_value" && /reasoning/.test(text)) return result("effort", false, message, status);
  if (/model.{0,60}(not supported|not found|does not exist)|model_not_found|unknown model/.test(text)) {
    return result("model", false, message, status);
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|not logged in|please (log|sign) in|codex login|invalid api key|token (has )?expired/.test(text)) {
    return result("auth", false, message, status);
  }
  if (/usage limit|usage_limit|quota|out of credits|purchase more|limit reached for your plan/.test(text)) {
    return result("usage_limit", false, message, status);
  }
  if (status === 429 || /rate.?limit|too many requests/.test(text)) return result("rate_limit", true, message, status);
  if ((status && status >= 500) || /overloaded|internal server error|server error|bad gateway|service unavailable|gateway timeout/.test(text)) {
    return result("server", true, message, status);
  }
  if (/stream disconnected|connection (reset|closed|refused|error)|error sending request|timed out|network|dns error|tls|econnreset|enotfound|socket hang up/.test(text)) {
    return result("network", true, message, status);
  }
  if (status === 400) return result("invalid_request", false, message, status);
  if (emptyOutput && exitCode === 0) return result("empty_output", true, "codex exited cleanly but wrote no final message", status);
  return result("execution", false, message, status);
}

// ─── run directories ────────────────────────────────────────────────────────

export function ucxHome(env = process.env) {
  return env.ULTRACODEX_HOME ? path.resolve(env.ULTRACODEX_HOME) : path.join(os.homedir(), ".ultracodex");
}

export function runPaths(runId, env = process.env) {
  const dir = path.join(ucxHome(env), "runs", runId);
  return {
    dir,
    request: path.join(dir, "request.json"),
    task: path.join(dir, "task.md"),
    schema: path.join(dir, "schema.json"),
    state: path.join(dir, "state.json"),
    result: path.join(dir, "result.json"),
    heartbeat: path.join(dir, "heartbeat"),
    alive: path.join(dir, "alive"),
    cancel: path.join(dir, "cancel"),
    log: path.join(dir, "supervisor.log"),
  };
}

// ─── request and result authentication ─────────────────────────────────────
//
// A per-machine secret (~/.ultracodex/key) is fetched once per workflow by a dedicated
// key agent (its own agent type: the relay guard never lets a job relay read the key),
// together with a fresh nonce. With it the Workflow helper:
//   • signs every request it builds: rmac = HMAC(key, "ucx-request" \n requestDigest),
//     where requestDigest = SHA-256 of the exact signed header (model, effort, tier, cwd,
//     schema preset, nonce, …), the schema and the task. The runner starts a relayed job
//     only with a valid rmac, so a relay hijacked by reviewed content cannot start a job
//     of its own — for instance one that asks Codex to read this key and sign a forgery;
//   • verifies every result: mac = HMAC(key, "ucx-result" \n runId \n requestDigest \n
//     kind \n body), kind being "result" (schema) or "text". A result is thereby bound
//     to the one request the helper made (nonce: no replay of an older run of the same
//     task) and to the payload type it returns.
// Each nonce starts one run; a second upload of the same request joins the first run.
// SHA-256 (not the 32-bit transport hashes) binds everything, so nobody holding the key
// can search for a request whose own digest matches a MAC embedded in it.

export function keyPath(env = process.env) {
  return path.join(ucxHome(env), "key");
}

const KEY_RE = /^[0-9a-f]{64}$/;
export const NONCE_RE = /^[0-9a-f]{32}\.[1-9]\d{0,6}$/;

// Created once, published complete: the key is written to a private temp file and linked
// into place, so a concurrent reader never sees an empty or partial key and a second
// creator never replaces the first one's key.
export function ensureKey(env = process.env) {
  const file = keyPath(env);
  const read = () => (readTextSafe(file) ?? "").trim();
  let current = read();
  if (KEY_RE.test(current)) return current;
  fs.mkdirSync(ucxHome(env), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      if (error.code !== "EEXIST") {
        // a filesystem without hard links: exclusive create (a reader may briefly see it empty)
        try {
          fs.writeFileSync(file, fs.readFileSync(tmp, "utf8"), { flag: "wx", mode: 0o600 });
        } catch (inner) {
          if (inner.code !== "EEXIST") throw inner;
        }
      }
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      current = read();
      if (KEY_RE.test(current)) return current;
      sleepSync(10); // an older runner's creator (open, then write) may still be writing
    }
    // Never repaired automatically: two repairers could each hand out a different key.
    throw new RequestError("key_invalid", `the ultracodex key at ${file} exists but is not valid (left by an interrupted older runner?); delete it and a new one is created`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function hmacHex(key, text) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(String(text), "utf8").digest("hex");
}

function sameHex(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

// signedHeader: the frame header exactly as the helper signed it (every field but rmac).
export function requestDigest(signedHeader, schema, task) {
  return sha256Hex(`${JSON.stringify(signedHeader)}\n${schema === null || schema === undefined ? "null" : JSON.stringify(schema)}\n${task}`);
}

export function requestMac(key, digest) {
  return hmacHex(key, `ucx-request\n${digest}`);
}

// Requests started from the conversation (start --request) are not relayed; their results
// are bound to the task alone and never match a relayed request's digest.
export function directDigest(task) {
  return sha256Hex(`ucx-direct\n${task}`);
}

export function resultMac(key, runId, digest, kind, body) {
  return hmacHex(key, `ucx-result\n${runId}\n${digest}\n${kind}\n${body}`);
}

// The exact string resultHash and mac cover: the result JSON, or the final text.
export function resultBody(envelope) {
  return envelope.result !== undefined && envelope.result !== null ? JSON.stringify(envelope.result) : String(envelope.text ?? "");
}

export function newRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function updateState(paths, patch) {
  const current = readJsonSafe(paths.state) ?? {};
  writeJsonAtomic(paths.state, { ...current, ...patch, updatedAt: nowIso() });
}

function readNumber(file) {
  const value = Number(readTextSafe(file));
  return Number.isFinite(value) ? value : 0;
}

// ─── machine-wide concurrency slots ─────────────────────────────────────────

function slotsDir(env = process.env) {
  return path.join(ucxHome(env), "slots");
}

export function maxConcurrent(env = process.env) {
  const value = Number(env.ULTRACODEX_MAX_CONCURRENT);
  return Number.isInteger(value) && value >= 0 ? value : 4;
}

// Layout: slots/slot-N/ is the lease (taken with an atomic mkdir), and inside it
// lease-<runId>/owner.json is its owner's generation. An owner only ever writes inside
// its own generation directory, so after its lease was reclaimed its renewals fail with
// ENOENT instead of overwriting the new owner — the displacement is noticed, never hidden.
function leaseDir(dir, runId) {
  return path.join(dir, `lease-${runId}`);
}

function slotOwner(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const lease = names.find((name) => name.startsWith("lease-"));
  if (lease) {
    const leasePath = path.join(dir, lease);
    const owner = readJsonSafe(path.join(leasePath, "owner.json"));
    return owner ? { ...owner, leasePath } : { runId: lease.slice("lease-".length), pid: null, beatAt: null, partial: true, leasePath };
  }
  return readJsonSafe(path.join(dir, "owner.json")); // pre-0.3 layout
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function debrisIsOld(dir) {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > TIMING.slotStaleMs;
  } catch {
    return true;
  }
}

// A slot is reclaimed only when its owner is provably gone: its supervisor PID is dead,
// or the reclaimer has watched the same beatAt through a full stale window of its own
// polls. Polls are counted, not clocks: after a suspend the owner renews within
// aliveMs of waking, long before a waiting run could confirm it stale — so a live
// owner never loses its slot to a laptop lid.
function ownerGone(dir, owner, watch) {
  // A taker between mkdir and its first write, debris — or an owner.json that could not be
  // read this instant (Windows sharing violation). The lease directory's own mtime moves on
  // every renewal (each writes and renames a file inside it), so a live owner is never "old".
  if (!owner || owner.partial) return debrisIsOld(owner?.leasePath ?? dir);
  if (owner.pid && !pidAlive(owner.pid)) return true;
  const seen = watch.suspects.get(dir);
  if (!seen || seen.beatAt !== owner.beatAt || seen.runId !== owner.runId) {
    watch.suspects.set(dir, { beatAt: owner.beatAt, runId: owner.runId, firstPoll: watch.poll });
    return false;
  }
  return watch.poll - seen.firstPoll >= Math.max(2, Math.ceil(TIMING.slotStaleMs / Math.max(1, TIMING.slotPollMs)));
}

const sameOwner = (a, b) => Boolean(a && b) && a.runId === b.runId && a.beatAt === b.beatAt;

// Reclaiming moves out only the generation it judged gone (only one reclaimer can win
// that rename), then checks it moved that very owner — if the owner renewed meanwhile, it
// is put straight back where nobody else can have recreated it (an owner never recreates
// its generation directory, and the slot directory stays in place). The slot directory
// itself is only moved when it holds no generation (debris) or a pre-0.3 owner file.
function tryTakeSlot(index, runId, watch) {
  const dir = path.join(slotsDir(), `slot-${index}`);
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const judged = slotOwner(dir);
    if (!ownerGone(dir, judged, watch)) return null;
    if (judged?.leasePath) {
      const generation = judged.leasePath;
      const tombstone = `${dir}.stale-${randomBytes(4).toString("hex")}`;
      try {
        renameRetry(generation, tombstone);
      } catch {
        return null; // another reclaimer won, or the owner released it
      }
      const moved = readJsonSafe(path.join(tombstone, "owner.json"));
      const same = judged.partial ? moved === null : sameOwner(moved, judged);
      if (!same) {
        try {
          renameRetry(tombstone, generation); // it renewed after all: give it back
        } catch {
          // its owner notices through lost() on its next renewal
        }
        return null;
      }
      fs.rmSync(tombstone, { recursive: true, force: true });
      watch.suspects.delete(dir);
      // the slot directory is now empty and fresh: no other taker judges it gone
    } else if (judged) {
      // A pre-0.3 owner file directly in the slot: only that file moves, never the directory.
      const legacy = path.join(dir, "owner.json");
      const tombstone = `${dir}.stale-${randomBytes(4).toString("hex")}`;
      try {
        renameRetry(legacy, tombstone);
      } catch {
        return null;
      }
      if (!sameOwner(readJsonSafe(tombstone), judged)) {
        try {
          renameRetry(tombstone, legacy);
        } catch {
          // an older runner's owner rewrites its file on its next renewal
        }
        return null;
      }
      fs.rmSync(tombstone, { force: true });
      watch.suspects.delete(dir);
    } else {
      // Empty debris: removed only while still empty (rmdir fails on a directory another
      // taker has just filled), then taken fresh — the shared directory is never moved.
      try {
        fs.rmdirSync(dir);
      } catch {
        return null;
      }
      watch.suspects.delete(dir);
      try {
        fs.mkdirSync(dir);
      } catch {
        return null;
      }
    }
  }
  try {
    fs.mkdirSync(leaseDir(dir, runId));
  } catch {
    return null;
  }
  // Two takers that judged the same debris can both end up here: one generation wins
  // (the smaller run id), the other backs out before it runs anything.
  const rival = generationsIn(dir).find((name) => name !== `lease-${runId}` && name < `lease-${runId}`);
  if (rival) {
    fs.rmSync(leaseDir(dir, runId), { recursive: true, force: true });
    return null;
  }
  writeJsonAtomic(path.join(leaseDir(dir, runId), "owner.json"), { runId, pid: process.pid, beatAt: Date.now() });
  return dir;
}

function generationsIn(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith("lease-"));
  } catch {
    return [];
  }
}

// Release touches only this run's own generation: it moves lease-<runId> out of the slot
// (ENOENT: the slot was reclaimed, so nothing of ours is left in it) and then removes the
// slot directory only if it is empty — an atomic rmdir that fails when a new owner is in
// it. An empty slot directory is fresh (its mtime just moved), so nobody reclaims it in
// between, and a taker's mkdir fails until it is gone. No other owner's lease is ever moved.
function releaseSlot(dir, runId) {
  const moved = `${dir}.released-${runId}-${randomBytes(3).toString("hex")}`;
  try {
    renameRetry(leaseDir(dir, runId), moved);
  } catch {
    return; // no longer ours
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty (a new owner) or already gone: nothing to do
  }
  fs.rmSync(moved, { recursive: true, force: true });
}

// Takes `weight` slots out of ULTRACODEX_MAX_CONCURRENT (default 4) across every
// Claude session on the machine; waits while they are busy. All-or-nothing, so two
// heavy runs can never deadlock each holding half of what they need. Renewal and
// release are fenced by owner: a supervisor whose lease was reclaimed never
// overwrites or deletes the new owner's slot.
export async function acquireSlots(weight, runId, shouldStop) {
  const limit = maxConcurrent();
  const empty = { release() {}, touch() {}, lost: () => [], stopped: null };
  if (limit === 0) return empty;
  fs.mkdirSync(slotsDir(), { recursive: true });
  const need = Math.min(Math.max(1, weight), limit);
  const releaseAll = (dirs) => {
    for (const dir of dirs) releaseSlot(dir, runId);
  };
  const watch = { suspects: new Map(), poll: 0 };
  for (;;) {
    watch.poll += 1;
    const stopBefore = shouldStop();
    if (stopBefore) return { ...empty, stopped: stopBefore };
    const taken = [];
    for (let index = 0; index < limit && taken.length < need; index += 1) {
      const dir = tryTakeSlot(index, runId, watch);
      if (dir) taken.push(dir);
    }
    if (taken.length === need) {
      const lost = new Set();
      return {
        stopped: null,
        touch() {
          for (const dir of taken) {
            try {
              // fails with ENOENT once the lease was reclaimed: nothing of the new owner is touched.
              // Keeps trying after a failure: a reclaimer that moved the slot away by mistake
              // puts it back, and a lease that stopped renewing would then really go stale.
              writeJsonAtomic(path.join(leaseDir(dir, runId), "owner.json"), { runId, pid: process.pid, beatAt: Date.now() });
              // another generation beside ours: the slot is double-booked (reported, as lost)
              if (generationsIn(dir).length > 1) lost.add(dir);
              else lost.delete(dir);
            } catch {
              lost.add(dir);
            }
          }
        },
        release() {
          releaseAll(taken);
        },
        lost: () => [...lost],
      };
    }
    releaseAll(taken);
    await sleep(TIMING.slotPollMs);
  }
}

// ─── process-tree teardown ──────────────────────────────────────────────────
//
// Only process trees this runner started are ever stopped: the owner runs parallel Codex
// sessions. POSIX: the child's own process group. Windows reuses PIDs quickly and keeps a
// dead parent's PID in its orphans' records, so ownership is proven there, never inferred:
//   • primary — a Job Object: before it spawns Codex, the supervisor has a small helper put
//     it into a fresh job, so every process of the run is born into the job, including
//     ones whose parent has exited. Stopping terminates exactly the job's members (each
//     through a handle checked to belong to the job), never a PID looked up later;
//   • fallback (no job: PowerShell or Add-Type unavailable) — processes are killed only
//     through a handle opened before their identity (PID + creation time) was checked,
//     children are only attributed through parents whose PID is pinned, and what can no
//     longer be proven is reported as possibleLeftovers, never killed.

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function windowsPowerShell(env = process.env) {
  return path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(script, { timeout = 60_000 } = {}) {
  return spawnSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    cwd: path.dirname(windowsPowerShell()), // neither the repository nor the home (which must stay deletable)
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Creation times are FILETIMEs (~1.3e17, far beyond 2^53): kept as BigInt, never as a
// Number, or an identity check against the exact value would silently fail.
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), created: BigInt(match[3]) });
  }
  return rows;
}

// pid, parent pid and creation time (FILETIME) of every process, or null when unavailable.
export function windowsProcessTable() {
  const out = runPowerShell(
    "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }",
    { timeout: 30_000 }
  );
  if (out.status !== 0 || !out.stdout) return null;
  return parseProcessTable(out.stdout);
}

// Descendants of `root` in `table`. Sound only when `root` is alive or its PID is pinned
// by the caller (a held handle), because every further parent is a live row of the table:
// a child created after its live parent was created can only be that parent's. (The
// creation-time checks also refuse an orphan whose dead parent's PID a younger process
// took.) Never call it for a parent that died unpinned: its PID may have served another
// process since.
export function windowsDescendants(root, table) {
  const byParent = new Map();
  const byPid = new Map();
  for (const proc of table) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc);
    byPid.set(proc.pid, proc);
  }
  const found = [];
  const seen = new Set([root.pid]);
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    const holder = byPid.get(parent.pid);
    const reusedAt = holder && holder.created > parent.created ? holder.created : Infinity;
    for (const proc of byParent.get(parent.pid) ?? []) {
      if (seen.has(proc.pid) || proc.created < parent.created || proc.created >= reusedAt) continue;
      seen.add(proc.pid);
      found.push(proc);
      queue.push(proc);
    }
  }
  return found;
}

// The run's root as it appears in `table`: matched by the creation time recorded while we
// held its handle, or — before any snapshot — by PID only while the child is unexited (an
// open handle keeps Windows from reusing the PID).
function windowsRoot(child, table, tracked) {
  const created = tracked?.get(child.pid);
  const alive = child.exitCode === null && child.signalCode === null;
  return table.find((proc) => proc.pid === child.pid && (created !== undefined ? proc.created === created : alive)) ?? null;
}

// Fallback mode only: remembers the live tree by identity, through live parents.
export function trackWindowsTree(child, tracked, table = windowsProcessTable()) {
  if (!table) return;
  const root = windowsRoot(child, table, tracked);
  if (!root) return;
  tracked.set(root.pid, root.created);
  for (const proc of windowsDescendants(root, table)) tracked.set(proc.pid, proc.created);
}

// ── the Job Object helper ──
// A PowerShell process (outside the job) that owns the job handle for the supervisor's
// lifetime: `ready 1` once the supervisor is in the job; `kill` terminates every member
// but the supervisor and answers `killed N left M [pid,…]`; `exit` or end of input ends it.
// When the supervisor dies, the helper sees end of input and exits too; the job's members
// keep running (a lost supervisor's Codex is reported, never killed).
const JOB_SOURCE = `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class UcxJob {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, out int returned);
  public static int[] Members(IntPtr job) {
    int size = 8 + IntPtr.Size * 16384;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      int returned;
      if (!QueryInformationJobObject(job, 3, buffer, size, out returned)) return null;
      int count = Marshal.ReadInt32(buffer, 4);
      int[] pids = new int[count];
      for (int i = 0; i < count; i++) pids[i] = (int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
      return pids;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  // Every member but keep, each terminated through a handle checked to be in this job
  // after it was opened: a PID can be reused, a job membership cannot be faked. Repeated
  // until no member is left, since a member can start a child while the sweep runs.
  public static string KillAllBut(IntPtr job, int keep) {
    int killed = 0;
    for (int round = 0; round < 8; round++) {
      int[] pids = Members(job);
      if (pids == null) return "error " + Marshal.GetLastWin32Error();
      List<IntPtr> held = new List<IntPtr>();
      foreach (int pid in pids) {
        if (pid == keep) continue;
        IntPtr h = OpenProcess(0x00100000 | 0x1000 | 0x0001, false, pid);
        if (h == IntPtr.Zero) continue;
        bool member;
        if (IsProcessInJob(h, job, out member) && member) { if (TerminateProcess(h, 1)) killed++; held.Add(h); } else CloseHandle(h);
      }
      if (held.Count == 0) break;
      foreach (IntPtr h in held) { WaitForSingleObject(h, 3000); CloseHandle(h); }
    }
    int[] after = Members(job);
    List<string> left = new List<string>();
    if (after != null) foreach (int pid in after) if (pid != keep) left.Add(pid.ToString());
    return "killed " + killed + " left " + left.Count + (left.Count > 0 ? " " + String.Join(",", left.ToArray()) : "");
  }
}`;

function jobHelperScript(pid) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "function Say($text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }",
    "try {",
    `  Add-Type -TypeDefinition @'\n${JOB_SOURCE}\n'@`,
    "  $job = [UcxJob]::CreateJobObject([IntPtr]::Zero, [IntPtr]::Zero)",
    "  if ($job -eq [IntPtr]::Zero) { Say ('ready 0 create ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }",
    `  $target = [UcxJob]::OpenProcess(0x0101, $false, ${Number(pid)})`,
    "  if ($target -eq [IntPtr]::Zero) { Say ('ready 0 open ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }",
    "  if (-not [UcxJob]::AssignProcessToJobObject($job, $target)) { Say ('ready 0 assign ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }",
    "  [void][UcxJob]::CloseHandle($target)",
    "} catch { Say ('ready 0 ' + $_.Exception.Message.Replace([char]10, ' ')); exit 1 }",
    "Say 'ready 1'",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine()",
    "  if ($line -eq $null -or $line -eq 'exit') { break }",
    `  if ($line -eq 'kill') { Say ([UcxJob]::KillAllBut($job, ${Number(pid)})) }`,
    "}",
  ].join("\n");
}

// Puts process `pid` (default: this one) into a fresh Job Object. Resolves `ready` to
// true once it is in; `kill()` resolves to a teardown report, or null when the helper is
// unavailable (the caller then falls back).
export function startWindowsJob({ pid = process.pid, readyMs = 30_000, killMs = 40_000 } = {}) {
  const unavailable = { ready: Promise.resolve(false), kill: async () => null, close() {}, reason: null };
  let helper;
  try {
    helper = spawn(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(jobHelperScript(pid), "utf16le").toString("base64")], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      cwd: path.dirname(windowsPowerShell()),
    });
  } catch (error) {
    return { ...unavailable, reason: error.message };
  }
  let usable = true;
  const waiting = [];
  const settleAll = () => {
    usable = false;
    while (waiting.length) waiting.shift()(null);
  };
  helper.on("error", settleAll);
  helper.on("exit", settleAll);
  helper.stdin.on("error", () => {});
  let buffered = "";
  helper.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (line) waiting.shift()?.(line);
    }
  });
  // one request at a time; a late or missing answer makes the helper unusable (never desync)
  const answer = (ms) =>
    new Promise((resolve) => {
      if (!usable) return resolve(null);
      const timer = setTimeout(() => {
        usable = false;
        resolve(null);
      }, ms);
      waiting.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  const controller = {
    reason: null,
    ready: answer(readyMs).then((line) => {
      if (line === "ready 1") return true;
      controller.reason = line ?? "no answer";
      usable = false;
      return false;
    }),
    async kill() {
      if (!usable) return null;
      const reply = answer(killMs);
      helper.stdin.write("kill\n");
      const match = /^killed (\d+) left (\d+)(?: ([\d,]+))?$/.exec((await reply) ?? "");
      if (!match) {
        usable = false;
        return null;
      }
      const survivors = match[3] ? match[3].split(",").map(Number) : [];
      return { targeted: Number(match[1]) + survivors.length, survivors, method: "job" };
    },
    close() {
      if (helper.exitCode === null) {
        try {
          helper.stdin.end("exit\n");
        } catch {
          // already gone
        }
      }
    },
  };
  return controller;
}

// ── fallback: kills through pinned handles ──
// Each process is killed only through a handle opened before its identity was checked
// (while the handle is held, its PID cannot be reused, so the table shows exactly it).
// Children started meanwhile are attributed only to parents whose PID is pinned — held by
// this script, or by the caller (the root, whose handle Node holds until it yields).
function pinnedKillScript(seeds, pinnedParents) {
  const assign = (name, pairs) => pairs.map(([pid, created]) => `$${name}[${Number(pid)}] = [long]${BigInt(created)}`).join("\n");
  return `$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Say($text) { [Console]::Out.WriteLine($text) }
$want = @{}
${assign("want", seeds)}
$parents = @{}
${assign("parents", pinnedParents)}
$held = @{}
for ($round = 0; $round -lt 5 -and $want.Count -gt 0; $round++) {
  $pinned = @{}
  foreach ($procId in @($want.Keys)) {
    try { $p = [System.Diagnostics.Process]::GetProcessById([int]$procId); $null = $p.Handle; $pinned[[int]$procId] = $p } catch { Say ('unpinned ' + $procId) }
  }
  $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.CreationDate })
  $created = @{}
  foreach ($r in $rows) { $created[[int]$r.ProcessId] = $r.CreationDate.ToFileTimeUtc() }
  foreach ($procId in @($pinned.Keys)) {
    $p = $pinned[$procId]
    if ($created[$procId] -ne $want[$procId]) { $p.Dispose(); continue }
    try { if (-not $p.HasExited) { $p.Kill() } } catch { }
    $held[$procId] = $p
    $parents[$procId] = $want[$procId]
  }
  $want = @{}
  foreach ($r in $rows) {
    $pp = [int]$r.ParentProcessId
    $procId = [int]$r.ProcessId
    if ($parents.ContainsKey($pp) -and -not $held.ContainsKey($procId) -and -not $parents.ContainsKey($procId) -and $created[$procId] -ge $parents[$pp]) { $want[$procId] = $created[$procId] }
  }
}
foreach ($procId in @($held.Keys)) { if ($held[$procId].WaitForExit(3000)) { Say ('killed ' + $procId) } else { Say ('survived ' + $procId) } }
Say 'done'`;
}

function runPinnedKill(seeds, pinnedParents) {
  if (!seeds.length && !pinnedParents.length) return { killed: [], survivors: [], ok: true };
  const out = runPowerShell(pinnedKillScript(seeds, pinnedParents));
  const lines = String(out.stdout ?? "").split(/\r?\n/).map((line) => line.trim());
  const pick = (word) => lines.filter((line) => line.startsWith(`${word} `)).map((line) => Number(line.slice(word.length + 1)));
  return { killed: pick("killed"), survivors: [...pick("survived"), ...pick("unpinned")], ok: lines.includes("done") };
}

function windowsPinnedStop(child, tracked, { killRoot }) {
  const alive = child.exitCode === null && child.signalCode === null;
  const table = windowsProcessTable();
  if (!table) {
    if (killRoot && alive) child.kill("SIGKILL"); // through Node's own handle: never another process
    return { targeted: killRoot && alive ? 1 : 0, survivors: [], method: "pinned", unverified: true };
  }
  const root = windowsRoot(child, table, tracked);
  if (root) tracked.set(root.pid, root.created);
  const seeds = new Map();
  for (const [pid, created] of tracked) {
    const live = table.find((proc) => proc.pid === pid && proc.created === created);
    if (!live) continue;
    if (pid !== child.pid) seeds.set(pid, created);
    for (const proc of windowsDescendants(live, table)) if (proc.pid !== child.pid) seeds.set(proc.pid, proc.created);
  }
  // The root goes through Node's own handle, which stays open until this synchronous code
  // yields — so its PID is pinned and its last-moment children can still be attributed.
  const rootPinned = Boolean(killRoot && root && alive);
  if (rootPinned) child.kill("SIGKILL");
  const report = runPinnedKill([...seeds], rootPinned ? [[root.pid, root.created]] : []);
  const after = windowsProcessTable();
  // Reconciled against the final table, whatever the script said: every targeted identity
  // still present is a survivor — a skipped or failed kill is never reported as clean.
  const aimed = new Map(seeds);
  if (rootPinned) aimed.set(root.pid, root.created);
  const survivors = after
    ? [...aimed].filter(([pid, created]) => after.some((proc) => proc.pid === pid && proc.created === created)).map(([pid]) => pid)
    : [...report.survivors];
  // Children of tracked processes that died before the teardown: probably ours, but their
  // parent's PID is no longer pinned, so nothing proves it — reported, never killed.
  const dead = [...tracked].filter(([pid, created]) => !(after ?? table).some((proc) => proc.pid === pid && proc.created === created));
  const handled = new Set([...seeds.keys(), ...report.killed, child.pid]);
  const possible = (after ?? []).filter((proc) => !handled.has(proc.pid) && dead.some(([pid, created]) => proc.ppid === pid && proc.created >= created));
  const result = { targeted: report.killed.length + (rootPinned ? 1 : 0), survivors, method: "pinned" };
  if (possible.length) result.possibleLeftovers = possible.map((proc) => proc.pid);
  if (possible.length || !after || !report.ok) result.unverified = true;
  return result;
}

// Stops the process tree this supervisor started and resolves once it is gone (or the
// escalation window has passed), reporting what survived. See the section comment.
export async function stopOwnedTree(child, { platform = process.platform, tracked = null, job = null } = {}) {
  if (!child?.pid) return { targeted: 0, survivors: [] };
  if (platform === "win32") {
    const viaJob = job ? await job.kill() : null;
    return viaJob ?? windowsPinnedStop(child, tracked ?? new Map(), { killRoot: true });
  }
  const signalGroup = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // already gone
      }
    }
  };
  signalGroup("SIGTERM");
  const graceUntil = Date.now() + TIMING.killGraceMs;
  while (Date.now() < graceUntil && groupAlive(child.pid)) await sleep(100);
  if (groupAlive(child.pid)) {
    signalGroup("SIGKILL");
    const hardUntil = Date.now() + 5000;
    while (Date.now() < hardUntil && groupAlive(child.pid)) await sleep(100);
  }
  return { targeted: 1, survivors: groupAlive(child.pid) ? [`process group ${child.pid}`] : [] };
}

// After a normal exit, whatever the run started and left behind (e.g. a dev server Codex
// forgot) is stopped: on POSIX the child's own process group, on Windows the job's members
// (fallback: the tracked identities still alive and their live descendants).
async function reapLeftovers(child, tracked, { platform = process.platform, job = null } = {}) {
  if (!child?.pid) return { targeted: 0, survivors: [] };
  if (platform === "win32") {
    const viaJob = job ? await job.kill() : null;
    if (viaJob) return viaJob;
    if (!tracked?.size) return { targeted: 0, survivors: [] }; // the root was never identified
    return windowsPinnedStop(child, tracked, { killRoot: false });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // nothing left
  }
  return { targeted: 0, survivors: [] };
}

// ─── the supervisor ─────────────────────────────────────────────────────────

// A gap this long between ticks of a 1-second loop means the machine was suspended.
const SUSPEND_GAP_MS = 30_000;

// Suspend detector: after a sleep, nobody could poll and the wall clock jumped, so
// the missing heartbeat is not abandonment and the lost time is not work.
export function makeClock(request) {
  let last = Date.now();
  let graceUntil = 0;
  return {
    tick() {
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (gap > SUSPEND_GAP_MS) {
        graceUntil = now + request.orphanAfterSec * 1000;
        return gap;
      }
      return 0;
    },
    inGrace: () => Date.now() < graceUntil,
  };
}

function stopReason(paths, request, clock = null) {
  if (fs.existsSync(paths.cancel)) return "cancelled";
  if (request.attached && !clock?.inGrace()) {
    const beat = readNumber(paths.heartbeat);
    if (beat && Date.now() - beat > request.orphanAfterSec * 1000) return "abandoned";
  }
  return null;
}

async function sleepUnlessStopped(ms, check) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const stop = check();
    if (stop) return stop;
    await sleep(Math.min(TIMING.pollMs, Math.max(1, until - Date.now())));
  }
  return check();
}

function probeCodexVersion(launcher) {
  try {
    const output = spawnSync(launcher.command, [...launcher.argsPrefix, "--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, ...launcher.env },
    });
    return String(output.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

export function catalogPath(env = process.env) {
  return path.join(ucxHome(env), "models.json");
}

export function loadCatalog(env = process.env) {
  const catalog = readJsonSafe(catalogPath(env));
  return catalog && Array.isArray(catalog.models) ? catalog : null;
}

export function parseCatalog(text) {
  const parsed = JSON.parse(text);
  const models = Array.isArray(parsed) ? parsed : parsed.models;
  if (!Array.isArray(models)) throw new Error("unexpected `codex debug models` output");
  return models
    .filter((model) => typeof model?.slug === "string")
    .map((model) => ({
      slug: model.slug,
      displayName: model.display_name ?? null,
      description: model.description ?? null,
      visibility: model.visibility ?? null,
      defaultEffort: model.default_reasoning_level ?? null,
      efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort).filter(Boolean),
      contextWindow: model.context_window ?? null,
    }));
}

export function refreshCatalog(launcher, env = process.env) {
  const output = spawnSync(launcher.command, [...launcher.argsPrefix, "debug", "models"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...launcher.env },
  });
  if (output.status !== 0) throw new Error(compact(output.stderr || "codex debug models failed", 500));
  const catalog = { fetchedAt: nowIso(), models: parseCatalog(output.stdout) };
  fs.mkdirSync(ucxHome(env), { recursive: true });
  writeJsonAtomic(catalogPath(env), catalog);
  return catalog;
}

function catalogIsFresh(catalog) {
  return Boolean(catalog) && Date.now() - Date.parse(catalog.fetchedAt ?? 0) < 24 * 3600 * 1000;
}

function baseEnvelope(request, runId) {
  return {
    ultracodex: 1,
    runnerVersion: RUNNER_VERSION,
    runId,
    label: request.label,
    kind: request.kind,
    meta: request.meta,
  };
}

function failureEnvelope(request, runId, state, classification, provenance = {}) {
  return {
    ...baseEnvelope(request, runId),
    ok: false,
    state,
    error: classification,
    provenance,
  };
}

function buildProvenance(request, extra) {
  return {
    model: request.model,
    effort: request.effort,
    tier: request.tier,
    mode: request.mode,
    sandbox: request.mode === "review" ? "read-only" : request.sandbox,
    hermetic: request.hermetic,
    cwd: request.cwd,
    taskHash: request.taskHash,
    ...extra,
  };
}

function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new SyntaxError("final message is not JSON");
  }
}

async function runAttempt(request, paths, attempt, context) {
  const attemptDir = path.join(paths.dir, `attempt-${attempt}`);
  fs.mkdirSync(attemptDir, { recursive: true });
  const files = {
    events: path.join(attemptDir, "events.jsonl"),
    stderr: path.join(attemptDir, "stderr.log"),
    lastMessage: path.join(attemptDir, "last.txt"),
    schema: request.schema ? paths.schema : null,
  };
  const args = buildCodexArgs(request, files, { windowsSandbox: context.windowsSandbox });
  appendLine(paths.log, `${nowIso()} attempt ${attempt}: ${context.launcher.displayPath} ${args.join(" ")}`);
  // Checked right before every spawn: a run cancelled or abandoned while it was
  // queued or backing off never starts Codex.
  const early = stopReason(paths, request, context.clock);
  if (early) {
    return {
      done: true,
      envelope: failureEnvelope(request, context.runId, early, classifyFailure({ cancelled: early === "cancelled", abandoned: early === "abandoned" })),
    };
  }
  const eventsFd = fs.openSync(files.events, "w");
  const stderrFd = fs.openSync(files.stderr, "w");
  const startedAt = Date.now();
  let child;
  let spawnError = null;
  try {
    child = spawn(context.launcher.command, [...context.launcher.argsPrefix, ...args], {
      cwd: request.cwd,
      env: { ...process.env, ...context.launcher.env },
      stdio: ["pipe", eventsFd, stderrFd],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    spawnError = error;
  } finally {
    fs.closeSync(eventsFd);
    fs.closeSync(stderrFd);
  }

  let outcome = { exitCode: null, stop: null, timedOut: false };
  if (child && !spawnError) {
    // Listeners first: from here on the child is owned, and every path below either
    // waits for it or stops its tree — it is never left running unsupervised.
    let exited = false;
    let exitCode = null;
    const exitedPromise = new Promise((resolve) => {
      child.once("exit", (code) => {
        exited = true;
        exitCode = code;
        resolve();
      });
      child.once("error", (error) => {
        spawnError = spawnError ?? error;
        exited = true;
        resolve();
      });
    });
    try {
      let deadlineAt = startedAt + request.timeoutSec * 1000;
      try {
        if (process.env.ULTRACODEX_TEST_FAULT === "state-write") throw new Error("injected state-write failure");
        updateState(paths, {
          state: "running",
          attempt,
          codexPid: child.pid,
          attemptStartedAt: new Date(startedAt).toISOString(),
          deadlineAt: new Date(deadlineAt).toISOString(),
        });
      } catch (error) {
        appendLine(paths.log, `${nowIso()} state write failed after spawn (run continues): ${error.message}`);
      }
      child.stdin.on("error", () => {});
      child.stdin.end(request.task ? request.task + "\n" : "");
      const fault = /^post-spawn(?::(\d+))?$/.exec(process.env.ULTRACODEX_TEST_FAULT ?? "");
      if (fault) {
        if (fault[1]) await sleep(Number(fault[1])); // let the child get as far as starting its own children
        throw new Error("injected post-spawn failure");
      }
      let stop = null;
      let timedOut = false;
      let teardown = null;
      let nextSnapshotAt = Date.now() + Math.min(2000, TIMING.treeSnapshotMs);
      while (!exited) {
        await withTimeout(exitedPromise, TIMING.pollMs);
        if (exited) break;
        const suspendedMs = context.clock.tick();
        if (suspendedMs) {
          deadlineAt += suspendedMs; // time asleep is not time worked
          appendLine(paths.log, `${nowIso()} resumed after ~${Math.round(suspendedMs / 1000)} s suspended; deadline moved`);
        }
        // snapshots only without a job: the job already knows every member
        if (process.platform === "win32" && !context.job && Date.now() >= nextSnapshotAt) {
          trackWindowsTree(child, context.tracked);
          nextSnapshotAt = Date.now() + TIMING.treeSnapshotMs;
        }
        if (Date.now() >= deadlineAt) timedOut = true;
        else stop = stopReason(paths, request, context.clock);
        if (timedOut || stop) {
          appendLine(paths.log, `${nowIso()} stopping codex pid ${child.pid}: ${timedOut ? "deadline" : stop}`);
          teardown = await stopOwnedTree(child, { tracked: context.tracked, job: context.job });
          await withTimeout(exitedPromise, 10_000); // a tree that survives the stop is reported, not awaited forever
          break;
        }
      }
      if (!timedOut && !stop) teardown = await reapLeftovers(child, context.tracked, { job: context.job });
      if (teardown?.survivors?.length) appendLine(paths.log, `${nowIso()} still running after teardown: ${teardown.survivors.join(", ")}`);
      if (teardown?.possibleLeftovers?.length) {
        appendLine(paths.log, `${nowIso()} possibly left running (ancestry not provable, not stopped): ${teardown.possibleLeftovers.join(", ")}`);
      }
      outcome = { exitCode, stop, timedOut, teardown };
    } catch (error) {
      appendLine(paths.log, `${nowIso()} supervisor error after spawn, stopping its codex tree: ${error.message}`);
      await stopOwnedTree(child, { tracked: context.tracked, job: context.job });
      throw error;
    }
  }

  const durationMs = Date.now() - startedAt;
  const summary = summarizeEvents(readTextSafe(files.events) ?? "");
  const stderr = readTextSafe(files.stderr) ?? "";
  const lastMessage = (readTextSafe(files.lastMessage) ?? "").trim();
  const provenance = buildProvenance(request, {
    threadId: summary.threadId,
    usage: summary.usage,
    durationMs,
    attempts: attempt,
    codexVersion: context.codexVersion,
    launcher: context.launcher.source,
  });
  // leftovers stopped after a normal exit, or ones that may have been left
  if (outcome.teardown?.targeted || outcome.teardown?.possibleLeftovers?.length || outcome.teardown?.survivors?.length) provenance.teardown = outcome.teardown;

  if (!spawnError && !outcome.stop && !outcome.timedOut && outcome.exitCode === 0 && lastMessage) {
    if (!request.schema) {
      return {
        done: true,
        envelope: {
          ...baseEnvelope(request, context.runId),
          ok: true,
          state: "done",
          text: lastMessage,
          resultHash: fnv1a(lastMessage),
          mac: resultMac(context.key, context.runId, request.requestDigest ?? directDigest(request.task), "text", lastMessage),
          provenance,
        },
      };
    }
    let parsed;
    try {
      parsed = extractJsonObject(lastMessage);
    } catch (error) {
      return {
        done: true,
        envelope: failureEnvelope(request, context.runId, "failed", { kind: "parse", retryable: false, message: error.message, status: null }, provenance),
      };
    }
    const problems = validateValue(parsed, request.schema);
    if (problems.length) {
      return {
        done: true,
        envelope: failureEnvelope(
          request,
          context.runId,
          "failed",
          { kind: "schema_mismatch", retryable: false, message: compact(problems.join("; ")), status: null },
          provenance
        ),
      };
    }
    // resultHash lets the Workflow helper prove the result survived the relay's transcription.
    return {
      done: true,
      envelope: {
        ...baseEnvelope(request, context.runId),
        ok: true,
        state: "done",
        result: parsed,
        resultHash: fnv1a(JSON.stringify(parsed)),
        mac: resultMac(context.key, context.runId, request.requestDigest ?? directDigest(request.task), "result", JSON.stringify(parsed)),
        provenance,
      },
    };
  }

  const classification = classifyFailure({
    summary,
    stderr,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    cancelled: outcome.stop === "cancelled",
    abandoned: outcome.stop === "abandoned",
    spawnError,
    emptyOutput: !lastMessage,
  });
  const state = outcome.timedOut ? "timeout" : outcome.stop ?? "failed";
  provenance.stderrTail = compact(stderr.split(/\r?\n/).filter((line) => line.trim()).slice(-8).join("\n"), 1200);
  if (outcome.teardown) provenance.teardown = outcome.teardown;
  if (outcome.teardown?.survivors?.length) {
    // never claim a clean stop that did not happen
    classification.message = compact(
      `${classification.message.replace(/; the Codex process tree was stopped$/, "")}; ${outcome.teardown.survivors.length} process(es) of this run could not be stopped: ${outcome.teardown.survivors.join(", ")}`
    );
  } else if (outcome.teardown?.unverified) {
    const why = outcome.teardown.possibleLeftovers?.length
      ? `processes ${outcome.teardown.possibleLeftovers.join(", ")} may be left over from it (their ancestry cannot be proven, so they were not stopped)`
      : "the stop of the Codex process tree could not be verified (no process table)";
    classification.message = compact(`${classification.message.replace(/; the Codex process tree was stopped$/, "")}; ${why}`);
  }
  return { done: false, classification, envelope: failureEnvelope(request, context.runId, state, classification, provenance) };
}

export async function superviseRun(runId) {
  const paths = runPaths(runId);
  const stored = readJsonSafe(paths.request);
  if (!stored) return;
  const request = { ...stored, task: readTextSafe(paths.task) ?? "", schema: stored.hasSchema ? readJsonSafe(paths.schema) : null };
  const log = (line) => appendLine(paths.log, `${nowIso()} ${line}`);
  writeText(paths.alive, String(Date.now()));
  updateState(paths, { state: "queued", supervisorPid: process.pid });
  let slot = null;
  let slotLost = false;
  let lostBeats = 0;
  const beat = setInterval(() => {
    writeText(paths.alive, String(Date.now()));
    try {
      slot?.touch();
    } catch {
      // a vanished slot is reclaimed by the next taker
    }
    lostBeats = slot?.lost?.().length ? lostBeats + 1 : 0;
    if (!slotLost && lostBeats >= 2) {
      // Another run reclaimed our lease (only possible if this supervisor stalled past the
      // stale window); one failed renewal can be a reclaimer that put the slot back.
      // Say so: this run now counts above the machine-wide cap.
      slotLost = true;
      log("slot lease lost to another run; this run continues above the machine-wide cap");
      try {
        updateState(paths, { slotLost: true });
      } catch {
        // state is informational here
      }
    }
  }, TIMING.aliveMs);
  let envelope;
  // Windows: joining a Job Object before anything is spawned lets the kernel, not PID
  // bookkeeping, say which processes belong to this run (see "process-tree teardown").
  let job = process.platform === "win32" && process.env.ULTRACODEX_NO_JOB !== "1" ? startWindowsJob() : null;
  try {
    const clock = makeClock(request);
    const check = () => {
      clock.tick();
      return stopReason(paths, request, clock);
    };
    // Blocking probes run before any slot is taken: they can stall the event loop, and
    // a held slot must keep renewing its lease.
    const launcher = resolveCodexLauncher();
    let catalog = loadCatalog();
    if (!catalogIsFresh(catalog)) {
      try {
        catalog = refreshCatalog(launcher);
      } catch (error) {
        log(`catalog refresh failed: ${error.message}`);
      }
    }
    const context = {
      runId,
      launcher,
      clock,
      key: ensureKey(),
      tracked: new Map(), // Windows: pid -> creation time of every descendant seen (identity-checked)
      codexVersion: probeCodexVersion(launcher),
      windowsSandbox: request.hermetic ? readUserWindowsSandbox() : null,
      job: null,
    };
    if (job) {
      if (await job.ready) {
        context.job = job;
        log("process tree: Job Object");
      } else {
        log(`process tree: no Job Object (${job.reason ?? "unavailable"}); identity-checked fallback`);
        job.close();
        job = null;
      }
    }
    if (catalog?.models?.length && !catalog.models.some((item) => item.slug === request.model)) {
      envelope = failureEnvelope(request, runId, "failed", {
        kind: "model",
        retryable: false,
        message: `model ${request.model} is not in the local Codex catalog`,
        status: null,
      });
    } else if (!modelSupportsEffort(request.model, request.effort, catalog)) {
      envelope = failureEnvelope(request, runId, "failed", {
        kind: "effort",
        retryable: false,
        message: `effort ${request.effort} is not supported by ${request.model}`,
        status: null,
      });
    } else {
      slot = await acquireSlots(request.weight, runId, check);
      if (slot.stopped) {
        envelope = failureEnvelope(request, runId, slot.stopped, classifyFailure({ cancelled: slot.stopped === "cancelled", abandoned: slot.stopped === "abandoned" }));
      } else {
        let spent = null; // tokens of every attempt, not only the last: what the run cost
        for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
          const outcome = await runAttempt(request, paths, attempt, context);
          envelope = outcome.envelope;
          spent = addUsage(spent, envelope.provenance?.usage);
          if (spent && envelope.provenance) envelope.provenance.usageTotal = spent;
          if (outcome.done || !outcome.classification.retryable || attempt === request.maxAttempts) break;
          log(`attempt ${attempt} failed (${outcome.classification.kind}); backing off`);
          updateState(paths, { state: "backoff", attempt });
          const stop = await sleepUnlessStopped(TIMING.backoffMs * attempt, check);
          if (stop) {
            envelope = failureEnvelope(request, runId, stop, classifyFailure({ cancelled: stop === "cancelled", abandoned: stop === "abandoned" }), envelope.provenance);
            break;
          }
        }
      }
    }
  } catch (error) {
    envelope = failureEnvelope(request, runId, "failed", {
      kind: "execution",
      retryable: false,
      message: compact(`supervisor error: ${error.stack ?? error.message}`),
      status: null,
    });
  } finally {
    clearInterval(beat);
    job?.close();
    try {
      slot?.release();
    } catch {
      // slot directories are reclaimed when stale
    }
  }
  if (slotLost) envelope.provenance = { ...(envelope.provenance ?? {}), slotLost: true };
  writeJsonAtomic(paths.result, envelope);
  updateState(paths, { state: envelope.state, finishedAt: nowIso() });
  log(`finished: ${envelope.state}${envelope.ok ? "" : ` (${envelope.error?.kind})`}`);
}

// ─── commands ───────────────────────────────────────────────────────────────

function print(value, pretty = false) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
}

// The Bash tool hands a model only a short preview of any output over ~30 000
// characters, so a large result would never reach the Workflow. Above PAGED_THRESHOLD
// `wait`/`result` print a compact envelope — paged: {pages, chars, enc, hashes} — and
// `page RUN K` prints slice K of the page data: the body JSON percent-encoded
// (encodePageText), so a relay copies plain text instead of doubly escaped JSON (measured:
// Sonnet dropped characters from the escaped form twice in a row). Each page has its own
// hash, so the helper keeps the good pages of every reply; resultHash and mac still cover
// the whole decoded body.
export const PAGED_THRESHOLD = 24_000;
export const PAGE_CHARS = 10_000;
export const MAX_PAGES = 400; // 4 MB of page data: far beyond any real result; the helper refuses more

export function pageBody(envelope) {
  return JSON.stringify(envelope.result !== undefined && envelope.result !== null ? { result: envelope.result } : { text: envelope.text ?? "" });
}

export function pageData(envelope) {
  return encodePageText(pageBody(envelope));
}

export function compactEnvelope(envelope) {
  if (envelope.ok !== true || JSON.stringify(envelope).length <= PAGED_THRESHOLD) return envelope;
  const data = pageData(envelope);
  const pages = Math.ceil(data.length / PAGE_CHARS);
  const hashes = pages <= MAX_PAGES ? Array.from({ length: pages }, (_, index) => fnv1a(data.slice(index * PAGE_CHARS, (index + 1) * PAGE_CHARS))) : [];
  const compact = { ...envelope, paged: { pages, chars: data.length, enc: "pct", hashes, ...(pages > MAX_PAGES ? { tooLarge: true } : {}) } };
  delete compact.result;
  delete compact.text;
  return compact;
}

function printFinal(envelope, pretty) {
  const out = pretty ? envelope : compactEnvelope(envelope);
  // from the main conversation, the whole result is simply read from this file
  if (out.paged && RUN_ID_RE.test(String(envelope.runId ?? ""))) out.paged = { ...out.paged, file: runPaths(envelope.runId).result };
  print(out, pretty);
  return envelope.ok ? 0 : 1;
}

export function cmdPage(runId, pageText, { pretty = false } = {}) {
  if (!RUN_ID_RE.test(String(runId ?? ""))) throw new UsageError("page needs a run id");
  const page = Number(pageText);
  const envelope = readJsonSafe(runPaths(runId).result);
  if (!envelope || envelope.ok !== true) {
    print(rejection("unknown_run", `no finished result for ${runId}`, { runId }), pretty);
    return 1;
  }
  const data = pageData(envelope);
  const pages = Math.ceil(data.length / PAGE_CHARS);
  if (!Number.isInteger(page) || page < 1 || page > Math.min(pages, MAX_PAGES)) throw new UsageError(`page must be 1..${Math.min(pages, MAX_PAGES)}`);
  print({ ultracodex: 1, runId, page, pages, data: data.slice((page - 1) * PAGE_CHARS, page * PAGE_CHARS) }, pretty);
  return 0;
}

function rejection(kind, message, extra = {}) {
  return {
    ultracodex: 1,
    runnerVersion: RUNNER_VERSION,
    ok: false,
    state: "rejected",
    error: { kind, retryable: kind === "relay_corruption", message: compact(message), status: null },
    ...extra,
  };
}

async function readInput(source) {
  if (source === "-") {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_TASK_BYTES + MAX_SCHEMA_BYTES + 64 * 1024) throw new RequestError("invalid_request", "stdin is too large");
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return readBoundedFile(source, MAX_TASK_BYTES + MAX_SCHEMA_BYTES + 64 * 1024, "request");
}

// { raw, requestDigest }: a framed request must be signed (see framedToRaw); a JSON
// request from the conversation is trusted as it is.
async function loadRawRequest(options) {
  if (options.framed) return framedToRaw(parseFramed(await readInput(options.framed)), { key: ensureKey() });
  if (!options.request) throw new UsageError("--request FILE|- or --framed FILE|- is required");
  const text = await readInput(options.request);
  try {
    return { raw: JSON.parse(text), requestDigest: null };
  } catch (error) {
    throw new RequestError("invalid_request", `request is not valid JSON: ${error.message}`);
  }
}

function persistRun(request) {
  const runId = newRunId();
  const paths = runPaths(runId);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.task, request.task);
  if (request.schema) fs.writeFileSync(paths.schema, JSON.stringify(request.schema, null, 2));
  const stored = { ...request, hasSchema: Boolean(request.schema) };
  delete stored.task;
  delete stored.schema;
  writeJsonAtomic(paths.request, stored);
  writeText(paths.heartbeat, String(Date.now()));
  writeJsonAtomic(paths.state, {
    state: "starting",
    runId,
    createdAt: nowIso(),
    label: request.label,
    kind: request.kind,
    model: request.model,
    effort: request.effort,
    tier: request.tier,
    timeoutSec: request.timeoutSec,
    attached: request.attached,
    cwd: request.cwd,
  });
  return { runId, paths };
}

export async function cmdStart(options) {
  let loaded;
  try {
    loaded = await loadRawRequest(options);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    print(rejection(error.kind ?? "invalid_request", error.message), options.pretty);
    return 1;
  }
  return startFromRaw(loaded.raw, options, { requestDigest: loaded.requestDigest });
}

export const INBOX_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
export const MAX_PARTS = 256;

function keepRejected(name, text) {
  try {
    const dir = path.join(ucxHome(), "rejected");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}-${Date.now()}.txt`), text);
  } catch {
    // diagnostics only
  }
}

// One part of an encoded frame, piped in by the relay:
//   part new 1 N HASH      opens a fresh upload (the runner allocates its id) with part 1
//   part UPLOAD k N HASH   adds part k to that open upload
// A part whose hash does not match is refused on its own (`part_rejected`) so the
// relay resends just that part. When the last missing part arrives, exactly one caller
// claims the upload (atomic rename), assembles, verifies and starts it, and prints the
// same line `start` would. Upload ids are never chosen by the caller, so identical
// requests from different workflows or sessions cannot collide.
export async function cmdPart(uploadArg, indexText, totalText, hashText, options = {}) {
  const index = Number(indexText);
  const total = Number(totalText);
  const opening = uploadArg === "new";
  if ((!opening && !INBOX_ID_RE.test(String(uploadArg ?? ""))) || !Number.isInteger(total) || total < 1 || total > MAX_PARTS || !Number.isInteger(index) || index < 1 || index > total) {
    throw new UsageError("part needs new|UPLOAD_ID INDEX TOTAL HASH (1 <= INDEX <= TOTAL <= 256)");
  }
  if (opening && index !== 1) throw new UsageError("part new opens an upload with part 1");
  if (!/^[0-9a-f]{8}$/.test(String(hashText ?? ""))) throw new UsageError("part HASH (8 hex digits) is required");
  let text = (await readInput("-")).replace(/\r\n?/g, "\n");
  if (text.endsWith("\n")) text = text.slice(0, -1); // the heredoc adds exactly one newline
  const base = { ultracodex: 1, runnerVersion: RUNNER_VERSION };
  if (fnv1a(text) !== hashText) {
    keepRejected(`${opening ? "new" : uploadArg}-part${index}`, text);
    print(
      {
        ...base,
        ok: false,
        state: "part_rejected",
        upload: opening ? null : uploadArg,
        part: index,
        total,
        error: { kind: "relay_corruption", retryable: true, message: `part ${index}/${total} differs from what the workflow sent; resend it exactly`, status: null },
      },
      options.pretty
    );
    return 1;
  }
  const inboxRoot = path.join(ucxHome(), "inbox");
  const uploadId = opening ? `ucx-${randomBytes(6).toString("hex")}` : uploadArg;
  const dir = path.join(inboxRoot, uploadId);
  if (opening) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "total"), String(total));
  } else {
    const recorded = Number(readTextSafe(path.join(dir, "total")));
    if (!recorded) {
      print(rejection("unknown_upload", `no open upload ${uploadId}; start again with: part new 1 ${total} …`, { upload: uploadId }), options.pretty);
      return 1;
    }
    if (recorded !== total) {
      print(rejection("relay_corruption", `upload ${uploadId} has ${recorded} parts, not ${total}`, { upload: uploadId }), options.pretty);
      return 1;
    }
  }
  const partFile = path.join(dir, `part-${index}`);
  fs.writeFileSync(`${partFile}.tmp`, text);
  renameRetry(`${partFile}.tmp`, partFile);
  let received = 0;
  for (let part = 1; part <= total; part += 1) if (isFileSync(path.join(dir, `part-${part}`))) received += 1;
  if (received < total) {
    print({ ...base, ok: null, state: "receiving", upload: uploadId, received, total, next: `part ${uploadId} <k> ${total} <hash>` }, options.pretty);
    return 3;
  }
  const claimed = `${dir}.assembling-${randomBytes(3).toString("hex")}`;
  try {
    // the directory was written a moment ago, so a scanner may still hold it: retried
    renameRetry(dir, claimed);
  } catch {
    print(rejection("upload_busy", `upload ${uploadId} is already being assembled`, { upload: uploadId }), options.pretty);
    return 1;
  }
  const framed = Array.from({ length: total }, (_, part) => readTextSafe(path.join(claimed, `part-${part + 1}`)) ?? "").join("\n");
  fs.rmSync(claimed, { recursive: true, force: true });
  let loaded;
  try {
    loaded = framedToRaw(parseFramed(framed, { encoded: true }), { key: ensureKey() });
  } catch (error) {
    keepRejected(`${uploadId}-frame`, framed);
    print(rejection(error.kind ?? "relay_corruption", error.message, { upload: uploadId }), options.pretty);
    return 1;
  }
  return startFromRaw(loaded.raw, options, { requestDigest: loaded.requestDigest });
}

// ── request registration ──
// Before each upload, the helper announces the request's digest through its key agent
// (`expect DIGEST`), a channel no relay and no Codex job can use: relays may only run
// part/wait/page, and a read-only Codex sandbox cannot write this registry. The runner starts
// a relayed job only for an announced digest, and consumes the announcement when it does.
const EXPECT_TTL_MS = 24 * 3600 * 1000;

function expectedPath(digest) {
  return path.join(ucxHome(), "expected", digest);
}

function nonceMarker(nonce) {
  return path.join(ucxHome(), "nonces", nonce);
}

function existingRunForNonce(nonce, { waitMs = 0 } = {}) {
  const marker = nonceMarker(nonce);
  const until = Date.now() + waitMs;
  for (;;) {
    const runId = (readTextSafe(marker) ?? "").trim();
    if (RUN_ID_RE.test(runId)) return runId;
    if (Date.now() >= until) return null;
    sleepSync(20);
  }
}

export function cmdExpect(digest, { pretty = false } = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(digest ?? ""))) throw new UsageError("expect needs a 64-hex request digest");
  const file = expectedPath(digest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, nowIso());
  print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: true, expected: digest }, pretty);
  return 0;
}

// The line `start` prints for a run, also used when a signed request is uploaded again.
function startedLine(runId, request, state) {
  return {
    ultracodex: 1,
    runnerVersion: RUNNER_VERSION,
    ok: null,
    state: state === "starting" ? "queued" : state ?? "queued",
    runId,
    label: request.label,
    model: request.model,
    effort: request.effort,
    tier: request.tier,
    kind: request.kind,
    timeoutSec: request.timeoutSec,
    next: `wait ${runId}`,
  };
}

async function startFromRaw(raw, options, { requestDigest = null } = {}) {
  let request;
  try {
    request = validateRequest(raw, { catalog: loadCatalog(), requestDigest });
  } catch (error) {
    print(rejection(error.kind ?? "invalid_request", error.message), options.pretty);
    return 1;
  }
  let registration = null;
  if (requestDigest) {
    if (!request.nonce) {
      print(rejection("unauthenticated_request", "a relayed request needs a nonce"), options.pretty);
      return 1;
    }
    // A second upload of a request that already started (a retrying relay) joins that run.
    const joined = existingRunForNonce(request.nonce);
    if (joined) {
      print(startedLine(joined, request, readJsonSafe(runPaths(joined).state)?.state), options.pretty);
      return 3;
    }
    // Otherwise the request must have been announced through the helper's key agent: a frame
    // anyone else composed — even one signed with a key read off the disk — starts nothing.
    registration = expectedPath(requestDigest);
    if (!isFileSync(registration) || Date.now() - fs.statSync(registration).mtimeMs > EXPECT_TTL_MS) {
      print(rejection("unregistered_request", "the Workflow helper did not announce this request to the runner"), options.pretty);
      return 1;
    }
  }
  const { runId, paths } = persistRun(request);
  if (requestDigest) {
    // One run per signed request (atomic): the loser of a race joins the winner's run.
    const marker = nonceMarker(request.nonce);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    try {
      fs.writeFileSync(marker, runId, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      fs.rmSync(paths.dir, { recursive: true, force: true }); // never started
      const existing = existingRunForNonce(request.nonce, { waitMs: 1000 });
      if (!existing) {
        print(rejection("nonce_reused", "this signed request was already uploaded"), options.pretty);
        return 1;
      }
      print(startedLine(existing, request, readJsonSafe(runPaths(existing).state)?.state), options.pretty);
      return 3;
    }
    fs.rmSync(registration, { force: true }); // consumed: the announcement starts one run, once
  }
  const supervisor = spawn(process.execPath, [RUNNER_FILE, "supervise", runId], {
    // Never the (possibly untrusted) repository, and not the home either: a process's working
    // directory cannot be deleted on Windows, and nothing is resolved relative to it anyway.
    cwd: path.dirname(process.execPath),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  let spawnFailure = null;
  supervisor.on("error", (error) => {
    spawnFailure = error;
  });
  supervisor.unref();
  for (let index = 0; index < 50; index += 1) {
    if (spawnFailure || readJsonSafe(paths.state)?.supervisorPid) break;
    await sleep(100);
  }
  if (spawnFailure) {
    print(rejection("spawn", `could not start the supervisor: ${spawnFailure.message}`, { runId }), options.pretty);
    return 1;
  }
  print(startedLine(runId, request, (readJsonSafe(paths.state) ?? {}).state), options.pretty);
  return 3;
}

export async function cmdWait(runId, { maxWaitSec = DEFAULT_MAX_WAIT_SEC, pretty = false } = {}) {
  if (!RUN_ID_RE.test(String(runId ?? ""))) throw new UsageError("wait needs a run id");
  const paths = runPaths(runId);
  if (!isDirSync(paths.dir)) {
    print(rejection("unknown_run", `no such run: ${runId}`, { runId, state: "unknown" }), pretty);
    return 1;
  }
  const until = Date.now() + maxWaitSec * 1000;
  let staleSince = null;
  for (;;) {
    const result = readJsonSafe(paths.result);
    if (result) return printFinal(result, pretty);
    writeText(paths.heartbeat, String(Date.now()));
    const state = readJsonSafe(paths.state) ?? {};
    const lastSign = Math.max(readNumber(paths.alive), Date.parse(state.createdAt ?? 0) || 0);
    // Declared lost only if the supervisor stays silent while we watch — right after a
    // suspend every timestamp is old, and the supervisor needs a moment to tick again.
    const silent = Date.now() - lastSign > TIMING.lostAfterMs;
    staleSince = silent ? staleSince ?? Date.now() : null;
    if (silent && Date.now() - staleSince >= Math.min(30_000, TIMING.lostAfterMs)) {
      print(
        {
          ultracodex: 1,
          runnerVersion: RUNNER_VERSION,
          ok: false,
          state: "lost",
          runId,
          label: state.label ?? null,
          error: {
            kind: "supervisor_lost",
            retryable: false,
            message:
              `the supervisor stopped reporting; codex pid ${state.codexPid ?? "?"} may still be running. ` +
              "It is NOT stopped automatically — check `status` and ask the owner before stopping anything.",
            status: null,
          },
        },
        pretty
      );
      return 1;
    }
    if (Date.now() >= until) {
      const startedAt = Date.parse(state.attemptStartedAt ?? state.createdAt ?? 0) || Date.now();
      print(
        {
          ultracodex: 1,
          runnerVersion: RUNNER_VERSION,
          ok: null,
          state: state.state === "starting" ? "queued" : state.state ?? "queued",
          runId,
          label: state.label ?? null,
          attempt: state.attempt ?? null,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          timeoutSec: state.timeoutSec ?? null,
          next: `wait ${runId}`,
        },
        pretty
      );
      return 3;
    }
    await sleep(Math.min(TIMING.pollMs, Math.max(1, until - Date.now())));
  }
}

function listRunIds() {
  const dir = path.join(ucxHome(), "runs");
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => RUN_ID_RE.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function describeRun(runId) {
  const paths = runPaths(runId);
  const state = readJsonSafe(paths.state) ?? {};
  const result = readJsonSafe(paths.result);
  const alive = readNumber(paths.alive);
  return {
    runId,
    state: result?.state ?? state.state ?? "unknown",
    ok: result ? result.ok : null,
    label: state.label ?? null,
    kind: state.kind ?? null,
    model: state.model ?? null,
    effort: state.effort ?? null,
    attempt: state.attempt ?? null,
    createdAt: state.createdAt ?? null,
    finishedAt: state.finishedAt ?? null,
    codexPid: result ? null : state.codexPid ?? null,
    supervisorAlive: result ? false : Date.now() - alive < TIMING.lostAfterMs,
    errorKind: result?.error?.kind ?? null,
    cwd: state.cwd ?? null,
  };
}

export function cmdStatus(runId, { all = false, pretty = false } = {}) {
  if (runId) {
    if (!RUN_ID_RE.test(runId)) throw new UsageError("status takes an optional run id");
    if (!isDirSync(runPaths(runId).dir)) {
      print(rejection("unknown_run", `no such run: ${runId}`, { runId, state: "unknown" }), pretty);
      return 1;
    }
    print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: true, runs: [describeRun(runId)] }, pretty);
    return 0;
  }
  const ids = listRunIds();
  const runs = (all ? ids : ids.slice(0, 30)).map(describeRun);
  print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: true, home: ucxHome(), maxConcurrent: maxConcurrent(), runs }, pretty);
  return 0;
}

export async function cmdCancel(runId, { pretty = false } = {}) {
  if (!RUN_ID_RE.test(String(runId ?? ""))) throw new UsageError("cancel needs a run id");
  const paths = runPaths(runId);
  if (!isDirSync(paths.dir)) {
    print(rejection("unknown_run", `no such run: ${runId}`, { runId, state: "unknown" }), pretty);
    return 1;
  }
  if (!readJsonSafe(paths.result)) writeText(paths.cancel, nowIso());
  return cmdWait(runId, { maxWaitSec: 30, pretty });
}

export function cmdResult(runId, { pretty = false } = {}) {
  if (!RUN_ID_RE.test(String(runId ?? ""))) throw new UsageError("result needs a run id");
  const result = readJsonSafe(runPaths(runId).result);
  if (result) return printFinal(result, pretty);
  print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: null, ...describeRun(runId) }, pretty);
  return 3;
}

export function cmdGc({ olderThanDays = 7, pretty = false } = {}) {
  const removed = [];
  const cutoff = Date.now() - olderThanDays * 24 * 3600 * 1000;
  for (const runId of listRunIds()) {
    const paths = runPaths(runId);
    const result = readJsonSafe(paths.result);
    const state = readJsonSafe(paths.state) ?? {};
    const finished = Date.parse(state.finishedAt ?? state.createdAt ?? 0) || 0;
    const abandonedDir = !result && Date.now() - readNumber(paths.alive) > 2 * 24 * 3600 * 1000;
    if ((result && finished < cutoff) || (abandonedDir && finished < cutoff)) {
      fs.rmSync(paths.dir, { recursive: true, force: true });
      removed.push(runId);
    }
  }
  const inboxes = [];
  const day = 24 * 3600 * 1000;
  // A consumed nonce is kept as long as its run: a replayed frame then joins that run, and
  // once both are gone the frame's announcement (consumed at the start) is long gone too.
  for (const [sub, maxAge] of [["inbox", day], ["rejected", day], ["expected", day], ["relay-roles", day], ["nonces", Math.max(day, olderThanDays * day)]]) {
    try {
      const root = path.join(ucxHome(), sub);
      for (const name of fs.readdirSync(root)) {
        const entry = path.join(root, name);
        if (Date.now() - fs.statSync(entry).mtimeMs > maxAge) {
          fs.rmSync(entry, { recursive: true, force: true });
          inboxes.push(`${sub}/${name}`);
        }
      }
    } catch {
      // nothing there yet
    }
  }
  const slots = [];
  try {
    for (const name of fs.readdirSync(slotsDir())) {
      const dir = path.join(slotsDir(), name);
      const owner = slotOwner(dir);
      // gc removes only provably dead leases: tombstones/debris, an owner whose PID is gone,
      // or a lease generation nobody has renewed for a stale window.
      const debris = name.includes(".stale-") || name.includes(".released-") || name.includes(".tmp-");
      const dead = debris || !owner ? debrisIsOld(dir) : owner.partial ? debrisIsOld(owner.leasePath) : Boolean(owner.pid) && !pidAlive(owner.pid);
      if (dead) {
        fs.rmSync(dir, { recursive: true, force: true });
        slots.push(name);
      }
    }
  } catch {
    // no slots yet
  }
  print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: true, removedRuns: removed, removedStaleInboxes: inboxes, removedStaleSlots: slots }, pretty);
  return 0;
}

// Can this machine put a process into a Job Object (PowerShell + Add-Type)? Without it,
// teardown uses the identity-checked fallback. Tried on a throwaway process.
async function probeWindowsJob() {
  const started = Date.now();
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const job = startWindowsJob({ pid: dummy.pid });
  try {
    const ok = await job.ready;
    return ok ? { ok: true, ms: Date.now() - started } : { ok: false, reason: job.reason ?? "unavailable", fallback: "identity-checked" };
  } finally {
    job.close();
    dummy.kill();
  }
}

export async function cmdPreflight({ live = false, pretty = false } = {}) {
  const report = { ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: false, modelCallMade: false, node: process.version };
  let launcher;
  try {
    launcher = resolveCodexLauncher();
  } catch (error) {
    report.error = { kind: "cli_not_found", message: error.message };
    print(report, pretty);
    return 1;
  }
  report.codex = { path: launcher.displayPath, source: launcher.source, version: probeCodexVersion(launcher) };
  const login = spawnSync(launcher.command, [...launcher.argsPrefix, "login", "status"], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, ...launcher.env },
  });
  const loginText = `${login.stdout ?? ""}${login.stderr ?? ""}`.trim();
  report.auth = { loggedIn: login.status === 0 && /logged in/i.test(loginText), detail: compact(loginText, 200) };
  try {
    const catalog = refreshCatalog(launcher);
    report.catalog = catalog.models.map((model) => ({ slug: model.slug, efforts: model.efforts, visibility: model.visibility }));
  } catch (error) {
    report.catalog = null;
    report.catalogError = error.message;
  }
  report.windowsSandbox = process.platform === "win32" ? readUserWindowsSandbox() : null;
  if (process.platform === "win32") report.windowsJob = await probeWindowsJob();
  report.home = ucxHome();
  report.maxConcurrent = maxConcurrent();
  report.policy = policyTable().map(({ tier, kind, model, effort, timeoutSec }) => ({ tier, kind, model, effort, timeoutSec }));
  const missingPolicyModels = Object.values(POLICY.models).filter(
    (slug) => report.catalog && !report.catalog.some((model) => model.slug === slug)
  );
  report.missingPolicyModels = missingPolicyModels;
  try {
    fs.mkdirSync(path.join(ucxHome(), "runs"), { recursive: true });
    report.homeWritable = true;
  } catch {
    report.homeWritable = false;
  }
  report.ok = Boolean(report.auth.loggedIn && report.homeWritable && missingPolicyModels.length === 0);
  if (report.ok && live) {
    report.modelCallMade = true;
    const request = validateRequest(
      {
        task: 'Return exactly {"ok": true} as the structured output. Do not run any tools.',
        schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
        tier: "light",
        kind: "verify",
        timeoutSec: 300,
        maxAttempts: 1,
        label: "preflight:live",
        cwd: os.tmpdir(),
      },
      { catalog: loadCatalog() }
    );
    const { runId } = persistRun(request);
    await superviseRun(runId);
    const result = readJsonSafe(runPaths(runId).result);
    report.live = { runId, ok: Boolean(result?.ok && result.result?.ok === true), state: result?.state, error: result?.error ?? null, provenance: result?.provenance ?? null };
    report.ok = report.live.ok;
  }
  print(report, pretty);
  return report.ok ? 0 : 1;
}

export async function cmdDryRun(options) {
  let request;
  try {
    const loaded = await loadRawRequest(options);
    request = validateRequest(loaded.raw, { catalog: loadCatalog(), requestDigest: loaded.requestDigest });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    print(rejection(error.kind ?? "invalid_request", error.message), options.pretty);
    return 1;
  }
  let launcher = null;
  try {
    launcher = resolveCodexLauncher();
  } catch (error) {
    launcher = { displayPath: null, source: `unresolved: ${error.message}` };
  }
  const files = { lastMessage: "<run>/attempt-1/last.txt", schema: request.schema ? "<run>/schema.json" : null };
  print(
    {
      ultracodex: 1,
      runnerVersion: RUNNER_VERSION,
      ok: true,
      modelCallMade: false,
      codex: { path: launcher.displayPath, source: launcher.source },
      args: buildCodexArgs(request, files, { windowsSandbox: request.hermetic ? readUserWindowsSandbox() : null }),
      model: request.model,
      effort: request.effort,
      tier: request.tier,
      kind: request.kind,
      timeoutSec: request.timeoutSec,
      weight: request.weight,
      taskBytes: Buffer.byteLength(request.task, "utf8"),
      taskHash: request.taskHash,
      schema: request.schema ? "custom-or-preset" : null,
    },
    options.pretty
  );
  return 0;
}

function helpText() {
  return [
    `ultracodex runner ${RUNNER_VERSION}`,
    "",
    "  node codex-node.mjs start (--request FILE|- | --framed FILE|-)   start a job, prints its run id",
    "  node codex-node.mjs part INBOX_ID K N  < part                     relay upload: part K of N; the last part starts the job",
    "  node codex-node.mjs wait RUN_ID [--max-wait SEC]                 poll (default 110 s); repeat while running",
    "  node codex-node.mjs run (--request FILE|- | --framed FILE|-)     start + one wait",
    "  node codex-node.mjs status [RUN_ID] [--all]                      list runs",
    "  node codex-node.mjs result RUN_ID                                print the final envelope",
    "  node codex-node.mjs page RUN_ID K                                 slice K of a large (paged) result",
    "  node codex-node.mjs key                                          the per-machine key and a fresh nonce (for the helper's key agent)",
    "  node codex-node.mjs expect DIGEST                                announce a request the helper built (for the helper's key agent)",
    "  node codex-node.mjs cancel RUN_ID                                stop that run's own process tree",
    "  node codex-node.mjs preflight [--live]                           check CLI, auth, catalog (no model call unless --live)",
    "  node codex-node.mjs policy | models | schema PRESET              routing policy, catalog, schema presets",
    "  node codex-node.mjs schema-check --schema FILE|-                 OpenAI strict-mode check for a schema",
    "  node codex-node.mjs dry-run (--request FILE|- | --framed FILE|-) show the codex invocation, no model call",
    "  node codex-node.mjs gc [--older-than-days N]                     remove finished run directories",
    "",
    "Exit codes: 0 done, 1 failed/rejected, 2 usage error, 3 still running.",
  ].join("\n");
}

function parseCli(argv) {
  const [command = "help", ...rest] = argv;
  const options = {
    command,
    positionals: [],
    pretty: false,
    all: false,
    live: false,
    request: null,
    framed: null,
    maxWait: null,
    schema: null,
    olderThanDays: null,
  };
  const valued = {
    "--request": "request",
    "--framed": "framed",
    "--max-wait": "maxWait",
    "--schema": "schema",
    "--older-than-days": "olderThanDays",
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--pretty") options.pretty = true;
    else if (token === "--all") options.all = true;
    else if (token === "--live") options.live = true;
    else if (valued[token]) {
      const value = rest[index + 1];
      if (value === undefined) throw new UsageError(`${token} requires a value`);
      options[valued[token]] = value;
      index += 1;
    } else if (token.startsWith("--")) throw new UsageError(`unknown option ${token}`);
    else options.positionals.push(token);
  }
  for (const name of ["maxWait", "olderThanDays"]) {
    if (options[name] !== null) {
      const value = Number(options[name]);
      if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${name} must be a non-negative number`);
      options[name] = value;
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  // Absolute before anything else: supervisors run with the home as their working
  // directory, where a relative ULTRACODEX_HOME would resolve somewhere else.
  if (process.env.ULTRACODEX_HOME) process.env.ULTRACODEX_HOME = path.resolve(process.env.ULTRACODEX_HOME);
  let options;
  try {
    options = parseCli(argv);
    const id = options.positionals[0];
    switch (options.command) {
      case "help":
      case "--help":
        process.stdout.write(helpText() + "\n");
        return 0;
      case "start":
        return await cmdStart(options);
      case "part":
        return await cmdPart(options.positionals[0], options.positionals[1], options.positionals[2], options.positionals[3], options);
      case "run": {
        const started = await captureStart(options);
        if (!started.runId) return started.exitCode;
        return await cmdWait(started.runId, { maxWaitSec: options.maxWait ?? DEFAULT_MAX_WAIT_SEC, pretty: options.pretty });
      }
      case "wait":
        return await cmdWait(id, { maxWaitSec: options.maxWait ?? DEFAULT_MAX_WAIT_SEC, pretty: options.pretty });
      case "page":
        return cmdPage(id, options.positionals[1], options);
      case "key": {
        // for the Workflow helper's key agent: the key, a fresh nonce for this workflow's
        // requests, and keyCheck, which catches a mis-copied key or nonce
        const key = ensureKey();
        const nonce = randomBytes(16).toString("hex");
        print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: true, key, nonce, keyCheck: fnv1a(`${key}:${nonce}`) }, options.pretty);
        return 0;
      }
      case "expect":
        return cmdExpect(id, options);
      case "status":
        return cmdStatus(id, options);
      case "result":
        return cmdResult(id, options);
      case "cancel":
        return await cmdCancel(id, options);
      case "gc":
        return cmdGc({ olderThanDays: options.olderThanDays ?? 7, pretty: options.pretty });
      case "preflight":
        return await cmdPreflight(options);
      case "dry-run":
        return await cmdDryRun(options);
      case "policy":
        print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: true, policy: POLICY, table: policyTable() }, options.pretty);
        return 0;
      case "models": {
        const catalog = refreshCatalog(resolveCodexLauncher());
        print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: true, ...catalog }, options.pretty);
        return 0;
      }
      case "schema": {
        const preset = SCHEMA_PRESETS[id];
        if (!preset) throw new UsageError(`schema needs one of: ${Object.keys(SCHEMA_PRESETS).join(", ")}`);
        print(preset, options.pretty);
        return 0;
      }
      case "schema-check": {
        if (!options.schema) throw new UsageError("schema-check needs --schema FILE|-");
        let schema;
        try {
          schema = JSON.parse(await readInput(options.schema));
        } catch (error) {
          print(rejection("invalid_request", `schema is not valid JSON: ${error.message}`), options.pretty);
          return 1;
        }
        const errors = checkStrictSchema(schema);
        print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ok: errors.length === 0, errors }, options.pretty);
        return errors.length ? 1 : 0;
      }
      case "supervise":
        if (!RUN_ID_RE.test(String(id ?? ""))) throw new UsageError("supervise needs a run id");
        await superviseRun(id);
        return 0;
      default:
        throw new UsageError(`unknown command: ${options.command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      print(rejection("usage", error.message), true);
      return 2;
    }
    print(rejection(error.kind ?? "execution", error.message));
    return 1;
  }
}

// `run` = start, then wait on the id start printed.
async function captureStart(options) {
  const write = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk, ...rest) => {
    captured += chunk;
    return true;
  };
  let exitCode;
  try {
    exitCode = await cmdStart(options);
  } finally {
    process.stdout.write = write;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(captured.trim().split("\n").at(-1));
  } catch {
    parsed = null;
  }
  if (!parsed?.runId || exitCode !== 3) {
    process.stdout.write(captured);
    return { runId: null, exitCode };
  }
  return { runId: parsed.runId, exitCode };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
