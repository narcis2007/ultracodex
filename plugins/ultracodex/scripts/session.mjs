// ultracodex sessions — a Codex job Claude can talk to while it runs.
//
// A one-shot run spawns `codex exec` and waits for its answer. A session (request
// `"session": true`, direct runs only — never Workflow relays) is driven through a private
// `codex app-server --listen stdio://` instead: JSON-RPC 2.0, one JSON object per line. The
// supervisor owns that process and the conversation (one Codex thread), and Claude can
//   - steer a running turn (`turn/steer`: Codex reads the message at its next step),
//   - send follow-ups after a turn (same thread, same context, no new run),
//   - interrupt a turn, read a compact event feed, answer questions Codex asks through the
//     client-side tool `ask_orchestrator`, and close the session when the job is done.
//
// State model (state.json `state`, as `status` shows it):
//   queued   starting, or waiting for a slot            running   a turn is active
//   backoff  a usage-limit / account wait (the Phase 1 logic, inside the session)
//   idle     the app-server is up, nothing pending; after `idleTtlSec` ->
//   dormant  no process at all; the thread is on disk; the next message revives the session
//   closed | cancelled | failed   the session ended for good (only then does result.json exist)
//
// Run directory (beside request.json, state.json ...): events.jsonl (compact event feed),
// inbox/ (messages from the CLI, handled in order, moved to inbox/done/), outbox/<id>.json
// (the supervisor's acknowledgement of each), turns/<n>.json (the envelope of turn n), queue/
// (accepted follow-ups not yet started) and supervisor.lock (one supervisor at a time).
//
// A steerable job (request `"steerable": true`: every Workflow node, relayed ones included) is the same driver in
// single-turn mode (`runSession({single: true})`, see runJob): one turn of a session, so the job can be steered
// while it runs, and it ends with that turn — its envelope is a one-shot run's. Before it may run that way a
// hermetic app-server's isolation is verified with config/read (isolationViolations), and a job whose first turn
// cannot be started is handed back to the caller to run on `codex exec` (`{fallback}`).
//
// This module imports the runner back (codex-node.mjs imports it too): every name taken from it
// is only ever used inside a function, never at load time.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  INBOX_ID_RE,
  MAX_ACCOUNT_HANDOFFS,
  MAX_TASK_BYTES,
  RUNNER_VERSION,
  RUN_ID_RE,
  SESSION_RE,
  TIMING,
  UsageError,
  acquireSlots,
  addUsage,
  baseEnvelope,
  buildProvenance,
  checkpointContinuation,
  classifyFailure,
  compact,
  compactEnvelope,
  continuationPrompt,
  directDigest,
  extractJsonObject,
  failureEnvelope,
  fnv1a,
  isDirSync,
  isPlainObject,
  launchSupervisor,
  managedAccountIdentity,
  nowIso,
  pidAlive,
  print,
  publicRunState,
  readBoundedFile,
  readJsonSafe,
  readNumber,
  readTextSafe,
  reapLeftovers,
  rejection,
  renameRetry,
  resolveCodexLauncher,
  resultMac,
  runPaths,
  sleep,
  sleepUnlessStopped,
  stopOwnedTree,
  stopReason,
  trackWindowsTree,
  tryUpdateState,
  updateState,
  validateValue,
  visibleAccountCheckpoint,
  waitForAccountChange,
  waitForLimitReset,
  withTimeout,
  writeJsonAtomic,
  writeText,
} from "./codex-node.mjs";

// ─── small helpers ──────────────────────────────────────────────────────────

const MAX_LINE_CHARS = 32 * 1024 * 1024; // one JSON-RPC line (a command's whole output can be big)
export const EVENT_CAP_BYTES = 8 * 1024 * 1024; // past this events.jsonl keeps only the structural events (the env knob is for tests)
// the items that are a step in flight: Codex is not interrupted between an item/started and its item/completed
const STEP_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"]);
const CHATTY_EVENTS = new Set(["command_started", "command", "file_change", "plan", "tool"]);
const MESSAGE_KINDS = new Set(["send", "interrupt", "answer", "close"]);

function clip(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// a path as an event shows it: relative to the job's cwd when it lies inside, else as it is
function relativeTo(cwd, file) {
  const absolute = String(file ?? "");
  const rel = path.relative(cwd, absolute);
  if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  return absolute;
}

const turnFile = (paths, n) => path.join(paths.turns, `${n}.json`);

function turnNumbers(paths) {
  try {
    return fs
      .readdirSync(paths.turns)
      .map((name) => /^(\d+)\.json$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function latestTurnEnvelope(paths) {
  const last = turnNumbers(paths).at(-1);
  return last === undefined ? null : readJsonSafe(turnFile(paths, last));
}

// ─── JSON-RPC over a line stream ────────────────────────────────────────────

export class RpcError extends Error {
  constructor(message, { code = null, data = null, method = null } = {}) {
    super(message);
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

// One end of a line-delimited JSON-RPC 2.0 connection. `feed` takes text from the peer's stdout;
// `send` (given by the owner) writes one object to its stdin. Requests are matched to answers by
// id; a message with a `method` AND an `id` is the peer asking us (its ids are its own, so they
// never mix with ours); one with only a `method` is a notification. Junk — a non-JSON line, a
// message of no known shape, a line beyond maxLineChars (dropped to the next newline) — is
// counted and skipped; nothing here throws into the stream.
export class JsonRpcClient {
  constructor({ send, onNotification = () => {}, onServerRequest = null, maxLineChars = MAX_LINE_CHARS } = {}) {
    this.send = send;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.maxLineChars = maxLineChars;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.skipping = false;
    this.closed = false;
    this.stats = { junk: 0, oversized: 0 };
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new RpcError("the connection is closed", { code: "closed", method }));
      const id = this.nextId;
      this.nextId += 1;
      const entry = { resolve, reject, method, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(`${method} did not answer within ${timeoutMs} ms`, { code: "timeout", method }));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      const body = { jsonrpc: "2.0", id, method };
      if (params !== undefined) body.params = params;
      if (!this.send(body)) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(new RpcError("could not write to the peer", { code: "closed", method }));
      }
    });
  }

  notify(method, params) {
    const body = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    return this.send(body);
  }

  feed(chunk) {
    let text = String(chunk ?? "");
    if (this.skipping) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      text = text.slice(newline + 1);
      this.skipping = false;
    }
    this.buffer += text;
    for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.handle(line);
    }
    if (this.buffer.length > this.maxLineChars) {
      this.buffer = "";
      this.skipping = true;
      this.stats.oversized += 1;
    }
  }

  handle(line) {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      // not a JSON-RPC line
    }
    if (!isPlainObject(message)) {
      this.stats.junk += 1;
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) this.serve(message);
      else this.notified(message);
      return;
    }
    if (message.id === undefined || message.id === null) {
      this.stats.junk += 1;
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return; // an answer to nothing we asked (or one that timed out)
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (isPlainObject(message.error)) {
      entry.reject(new RpcError(String(message.error.message ?? "request failed"), { code: message.error.code ?? null, data: message.error.data ?? null, method: entry.method }));
    } else {
      entry.resolve(message.result);
    }
  }

  notified(message) {
    try {
      this.onNotification(message);
    } catch {
      // a handler's failure is its own; the stream goes on
    }
  }

  serve(message) {
    const reply = (body) => {
      try {
        this.send({ jsonrpc: "2.0", id: message.id, ...body });
      } catch {
        // the peer is gone
      }
    };
    if (!this.onServerRequest) return reply({ error: { code: -32601, message: `method not found: ${message.method}` } });
    Promise.resolve()
      .then(() => this.onServerRequest(message))
      .then(
        (result) => reply({ result: result ?? {} }),
        (error) => reply({ error: { code: Number.isInteger(error?.code) ? error.code : -32603, message: String(error?.message ?? "internal error") } })
      );
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcError("the connection closed", { code: "closed", method: entry.method }));
      this.pending.delete(id);
    }
  }
}

// ─── the app-server's command line ──────────────────────────────────────────

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
const tomlKey = (name) => (TOML_BARE_KEY.test(name) ? name : JSON.stringify(name));

// The MCP servers the user's Codex config declares: `[mcp_servers.<name>]` or
// `[mcp_servers."<name>"]` headers (sub-tables such as `[mcp_servers.x.env]` are not servers),
// plus the two other TOML spellings of the same thing — `name = {…}` lines under a bare
// `[mcp_servers]` table and a top-level dotted key `mcp_servers.name.key = …`. A hermetic session
// disables each of them (`codex app-server` has no --ignore-user-config).
export function configuredMcpServers(env = process.env) {
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  const text = readTextSafe(path.join(home, "config.toml"));
  if (text === null) return [];
  const key = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))`;
  const header = new RegExp(String.raw`^\[\s*mcp_servers\s*\.\s*${key}\s*\]$`);
  const dotted = new RegExp(String.raw`^mcp_servers\s*\.\s*${key}\s*[.=]`);
  const inline = new RegExp(String.raw`^${key}\s*=\s*\{`);
  const named = (match) => {
    if (match[1] !== undefined) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return match[1];
      }
    }
    return match[2] ?? match[3];
  };
  const names = [];
  let table = null; // null = top level
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const server = header.exec(line);
      if (server) names.push(named(server));
      table = /^\[\s*mcp_servers\s*\]$/.test(line) ? "mcp_servers" : "other";
      continue;
    }
    if (table === null) {
      const server = dotted.exec(line);
      if (server) names.push(named(server));
    } else if (table === "mcp_servers") {
      const server = inline.exec(line);
      if (server) names.push(named(server));
    }
  }
  return [...new Set(names)];
}

// `codex app-server --listen stdio://` plus what the request asks for. Hermetic: no plugins, no
// apps, no notify hook, every configured MCP server disabled, and the Windows sandbox choice
// carried over (what `--ignore-user-config` would otherwise take away from `codex exec`). That is
// only the first half of isolation — `app-server` has no --ignore-user-config, so what is left of
// the user's config is judged by isolationViolations() from the app-server's own `config/read`
// before any thread starts. The service tier is one of the settings the driver owns: a hermetic
// session always states it ("default" unless the request names one), so the user's own
// `service_tier` never reaches a node (`codex exec --ignore-user-config` never sees it either).
export function buildAppServerArgs(request, { platform = process.platform, windowsSandbox = null, mcpServers = [] } = {}) {
  const args = ["app-server", "--listen", "stdio://"];
  if (request.hermetic) {
    args.push("--disable", "plugins", "--disable", "apps", "-c", "notify=[]");
    for (const name of mcpServers) args.push("-c", `mcp_servers.${tomlKey(name)}.enabled=false`);
    if (platform === "win32" && windowsSandbox) args.push("-c", `windows.sandbox="${windowsSandbox}"`);
  }
  if (request.sandbox === "workspace-write") {
    args.push("-c", `sandbox_workspace_write.network_access=${request.network}`);
    args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(request.addDirs ?? [])}`);
  }
  if (request.serviceTier || request.hermetic) args.push("-c", `service_tier="${request.serviceTier ?? "default"}"`);
  return args;
}

// ─── verified isolation: what is left of the user's config in a hermetic app-server ─────────────

// Client / UI / bookkeeping settings: nothing the model sees or can do depends on them.
const INERT_PREFIXES = ["tui", "desktop", "notice", "marketplaces", "projects", "profiles", "history", "analytics", "feedback"];
const INERT_KEYS = new Set(["file_opener", "check_for_update_on_startup", "disable_paste_burst", "hide_agent_reasoning", "suppress_unstable_features_warning"]);
// Set explicitly by the driver on every thread / turn (thread/start|resume: model, sandbox, approvalPolicy,
// approvalsReviewer; the `-c service_tier` flag; turn/start: effort), so the user's value never applies.
const DRIVER_OWNED_KEYS = new Set(["model", "model_reasoning_effort", "approval_policy", "approvals_reviewer", "sandbox_mode", "service_tier"]);
// What `-c` passes for a workspace-write request (a user value of these is overridden: origin sessionFlags).
const WRITE_OWNED_KEYS = ["sandbox_workspace_write.network_access", "sandbox_workspace_write.writable_roots"];
const MAX_ISOLATION_KEYS = 20;

const underKey = (key, name) => key === name || key.startsWith(`${name}.`);

// Decides from one `config/read` result ({config, origins}: the effective config, and for every
// effective dotted key the layer it came from) whether anything the user's config.toml (or a project
// layer) contributes could change what the model sees or can do in a hermetic run — the verification
// `codex exec --ignore-user-config` gets for free. Defaults, managed / system / MDM / enterprise layers
// apply to exec too, and session flags are ours; only the `user` and `project` layers are judged.
//   inert        client / UI / bookkeeping keys
//   neutralized  judged by the EFFECTIVE value (origins of array elements go stale after `-c`): plugins.* iff
//                features.plugins is false, apps.* iff features.apps is false, mcp_servers.<n>.* iff that server
//                is disabled, notify iff the effective notify hook list is empty
//   driver-owned model, effort, approval policy and reviewer, sandbox mode, service tier (set on every thread / turn),
//                and, for a workspace-write request, the two sandbox_workspace_write keys passed with `-c`
//   carried      windows.sandbox (exec carries it too: readUserWindowsSandbox)
// Everything else from those two layers is a violation. → { ok, keys } (keys: names only, never values,
// sorted, at most ~20; `more` counts the rest), or { ok: false, keys: ["<unverifiable>"] } when `origins`
// is missing or malformed — a check that cannot judge proves nothing.
export function isolationViolations(configRead, { request = {} } = {}) {
  const origins = isPlainObject(configRead) ? configRead.origins : null;
  if (!isPlainObject(origins)) return { ok: false, keys: ["<unverifiable>"] };
  const config = isPlainObject(configRead.config) ? configRead.config : {};
  const features = isPlainObject(config.features) ? config.features : {};
  const servers = isPlainObject(config.mcp_servers) ? config.mcp_servers : {};
  const writable = request.sandbox === "workspace-write";
  const serverOf = (rest) => {
    // the longest effective server name the key starts with (a name may itself contain dots)
    let found = null;
    for (const name of Object.keys(servers)) {
      if ((rest === name || rest.startsWith(`${name}.`)) && (found === null || name.length > found.length)) found = name;
    }
    return found;
  };
  const allowed = (key) => {
    if (INERT_KEYS.has(key) || INERT_PREFIXES.some((prefix) => underKey(key, prefix))) return true;
    if (DRIVER_OWNED_KEYS.has(key) || key === "windows.sandbox") return true;
    if (underKey(key, "sandbox_workspace_write")) return !writable || WRITE_OWNED_KEYS.some((owned) => underKey(key, owned));
    if (underKey(key, "plugins")) return features.plugins === false;
    if (underKey(key, "apps")) return features.apps === false;
    if (underKey(key, "notify")) return config.notify === undefined || (Array.isArray(config.notify) && config.notify.length === 0);
    if (key === "mcp_servers") return Object.values(servers).every((server) => isPlainObject(server) && server.enabled === false);
    if (key.startsWith("mcp_servers.")) {
      const name = serverOf(key.slice("mcp_servers.".length));
      return name !== null && isPlainObject(servers[name]) && servers[name].enabled === false;
    }
    return false;
  };
  const bad = new Set();
  for (const [key, origin] of Object.entries(origins)) {
    const type = origin?.name?.type;
    if (typeof type !== "string") {
      bad.add(key); // an origin that cannot be read cannot be judged
      continue;
    }
    if (type !== "user" && type !== "project") continue;
    if (!allowed(key)) bad.add(key);
  }
  if (!bad.size) return { ok: true, keys: [] };
  const sorted = [...bad].sort();
  return { ok: false, keys: sorted.slice(0, MAX_ISOLATION_KEYS), ...(sorted.length > MAX_ISOLATION_KEYS ? { more: sorted.length - MAX_ISOLATION_KEYS } : {}) };
}

// The client-side tool Codex calls to ask the orchestrating agent a question.
export const ASK_TOOL = Object.freeze({
  type: "function",
  name: "ask_orchestrator",
  description:
    "Ask the orchestrating agent (Claude Code, which assigned this task) a question and wait for the answer. Use it for decisions you cannot make from the code and instructions — not for things you can check yourself. Keep questions short and specific.",
  inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
});

// ─── failures ───────────────────────────────────────────────────────────────

// A failed turn's `error` ({message, codexErrorInfo, additionalDetails}) mapped to the runner's
// failure kinds. Precise text matches (the encrypted-reasoning rejection, a bad schema, a model
// or effort the account lacks) win over the structured info, which only says "badRequest" for
// them; for the rest the structured info decides, and the text classifier is the fallback.
export function classifySessionError(error) {
  const message = String(error?.message ?? "");
  const info = error?.codexErrorInfo;
  const name = typeof info === "string" ? info : isPlainObject(info) ? Object.keys(info)[0] ?? null : null;
  const status = isPlainObject(info) && isPlainObject(info[name]) ? info[name].httpStatusCode ?? null : null;
  const make = (kind, retryable) => ({ kind, retryable, message: compact(message || `codex reported ${name}`), status });
  const byText = classifyFailure({ summary: { turnFailed: { message } }, exitCode: 1 });
  if (["encrypted_history", "schema", "effort", "model"].includes(byText.kind)) return byText;
  switch (name) {
    case "usageLimitExceeded":
      return make("usage_limit", false);
    case "rateLimitExceeded":
      return make("rate_limit", true);
    case "unauthorized":
      return make("auth", false);
    case "contextWindowExceeded":
      return make("context", false);
    case "serverOverloaded":
    case "internalServerError":
      return make("server", true);
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return make("network", true);
    case "badRequest":
      return make("invalid_request", false);
    default:
      return byText;
  }
}

// ─── the event feed ─────────────────────────────────────────────────────────

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// the highest `seq` already in the file (a revived supervisor continues the counter)
export function lastEventSeq(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const seq = JSON.parse(lines[index])?.seq;
        if (Number.isInteger(seq)) return seq;
      } catch {
        // an empty last line, or a partial one
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

// events.jsonl: one compact JSON object per line, `seq` strictly increasing over the session's
// whole life. Past EVENT_CAP_BYTES only the structural events are kept (no command, file, plan,
// tool or commentary events) so a long session cannot fill the disk.
export class EventLog {
  constructor(file, turn = () => 0) {
    this.file = file;
    this.turn = turn;
    this.seq = lastEventSeq(file);
    this.size = fileSize(file);
    this.capped = false;
    const cap = Number(process.env.ULTRACODEX_EVENT_CAP_BYTES);
    this.cap = Number.isFinite(cap) && cap > 0 ? cap : EVENT_CAP_BYTES;
  }

  append(type, fields = {}) {
    if (this.size >= this.cap && (CHATTY_EVENTS.has(type) || (type === "message" && fields.phase !== "final_answer"))) {
      this.capped = true;
      return null;
    }
    this.seq += 1;
    const entry = { seq: this.seq, t: nowIso(), turn: this.turn(), type, ...fields };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      fs.appendFileSync(this.file, line);
      this.size += Buffer.byteLength(line);
    } catch {
      // the feed is informational
    }
    return entry;
  }
}

// The complete lines of `file` from byte `offset` on: { events, offset } with the offset after
// the last complete line (a line the supervisor is still writing is read on the next call).
export function readNewEvents(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { events: [], offset };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { events: [], offset };
    const buffer = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(0x0a, read - 1);
    if (end < 0) return { events: [], offset };
    const events = [];
    for (const line of buffer.toString("utf8", 0, end + 1).split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (isPlainObject(event)) events.push({ event, line });
      } catch {
        // a damaged line is skipped
      }
    }
    return { events, offset: offset + end + 1 };
  } catch {
    return { events: [], offset };
  } finally {
    fs.closeSync(fd);
  }
}

// ─── inbox / outbox ─────────────────────────────────────────────────────────

function newMessageId() {
  return `${Date.now().toString(36).padStart(9, "0")}-${randomBytes(4).toString("hex")}`;
}

// A message for the supervisor, written atomically (the supervisor never sees half of one).
export function writeInboxMessage(paths, fields) {
  fs.mkdirSync(paths.inbox, { recursive: true });
  const id = newMessageId();
  const message = { id, ...fields, createdAt: nowIso() };
  const tmp = path.join(paths.inbox, `${id}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(message));
  renameRetry(tmp, path.join(paths.inbox, `${id}.json`));
  return message;
}

// Messages waiting for the supervisor, oldest first (ids start with their creation time).
export function sessionPendingMessages(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.inbox);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && INBOX_ID_RE.test(name.slice(0, -5)))
    .sort()
    .map((name) => ({ id: name.slice(0, -5), file: path.join(paths.inbox, name), message: readJsonSafe(path.join(paths.inbox, name)) }));
}

function queuedItems(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.queue);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJsonSafe(path.join(paths.queue, name)))
    .filter((item) => isPlainObject(item) && typeof item.text === "string" && typeof item.id === "string");
}

export function sessionHasWork(paths) {
  return sessionPendingMessages(paths).length > 0 || queuedItems(paths).length > 0;
}

export function sessionIsRevive(paths) {
  const state = readJsonSafe(paths.state);
  return Boolean(state?.threadId) || (state?.turn ?? 0) > 0;
}

function moveInbox(paths, id) {
  try {
    fs.mkdirSync(paths.inboxDone, { recursive: true });
    renameRetry(path.join(paths.inbox, `${id}.json`), path.join(paths.inboxDone, `${id}.json`));
  } catch {
    // already moved
  }
}

function writeAck(paths, id, body) {
  try {
    fs.mkdirSync(paths.outbox, { recursive: true });
    writeJsonAtomic(path.join(paths.outbox, `${id}.json`), { id, ...body, at: nowIso() });
  } catch {
    // the sender then reports "pending"; the message was handled
  }
}

// ─── one supervisor at a time ───────────────────────────────────────────────

function lockIsStale(paths, held) {
  if (!held) {
    // a lock nobody finished writing is left alone unless it has sat there
    try {
      return Date.now() - fs.statSync(paths.lock).mtimeMs > 5000;
    } catch {
      return true;
    }
  }
  if (!pidAlive(held.pid)) return true;
  // the PID is alive, but may now belong to something else (a reboot, a reused PID): the
  // supervisor refreshes `alive` every few seconds, so a long silence settles it
  let lockAge = 0;
  try {
    lockAge = Date.now() - fs.statSync(paths.lock).mtimeMs;
  } catch {
    return true;
  }
  return Date.now() - readNumber(paths.alive) > TIMING.lostAfterMs && lockAge > TIMING.lostAfterMs;
}

const TAKEOVER_STALE_MS = 5000;

// Taking over a stale lock is exclusive too. Judging a lock stale and removing it are two steps, and
// two supervisors starting together (two senders reviving a dormant session) would both judge it
// stale; the second one's removal then took the first one's brand-new lock, and both believed they
// held it. So whoever removes the stale lock first creates `supervisor.lock.takeover` (exclusively),
// and under it checks that the lock is still the very one it judged. Returns the marker's path (the
// caller removes it once it has created its own lock), or null when another supervisor is taking
// over or the lock changed hands meanwhile.
function beginTakeover(paths, held) {
  const marker = `${paths.lock}.takeover`;
  try {
    fs.writeFileSync(marker, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      try {
        // a takeover that died halfway leaves its marker behind
        if (Date.now() - fs.statSync(marker).mtimeMs > TAKEOVER_STALE_MS) fs.rmSync(marker, { force: true });
      } catch {
        // gone already
      }
    }
    return null;
  }
  const now = readJsonSafe(paths.lock);
  const same = held ? Boolean(now) && now.pid === held.pid && now.startedAt === held.startedAt : !now;
  if (!same) {
    fs.rmSync(marker, { force: true });
    return null;
  }
  fs.rmSync(paths.lock, { force: true });
  return marker;
}

// Takes supervisor.lock (created exclusively; holds pid + start time) or returns null. A lock
// whose holder is gone is taken over (exclusively: see beginTakeover). With waitMs, waits for one
// that is still being held (a supervisor that is winding down hands its lock on within seconds).
export async function claimSupervisorLock(paths, { waitMs = 0 } = {}) {
  const mine = { pid: process.pid, startedAt: Date.now(), runner: RUNNER_VERSION };
  const deadline = Date.now() + waitMs;
  let takeovers = 0;
  let marker = null; // held from removing a stale lock until our own is created
  const dropMarker = () => {
    if (marker) fs.rmSync(marker, { force: true });
    marker = null;
  };
  for (;;) {
    try {
      fs.writeFileSync(paths.lock, JSON.stringify(mine), { flag: "wx" });
      dropMarker();
      return {
        stillHeld() {
          const held = readJsonSafe(paths.lock);
          if (held) return held.pid === mine.pid && held.startedAt === mine.startedAt;
          try {
            fs.writeFileSync(paths.lock, JSON.stringify(mine), { flag: "wx" }); // deleted under us, nobody else took it
            return true;
          } catch {
            return false;
          }
        },
        release() {
          const held = readJsonSafe(paths.lock);
          if (held && held.pid === mine.pid && held.startedAt === mine.startedAt) fs.rmSync(paths.lock, { force: true });
        },
      };
    } catch (error) {
      dropMarker();
      if (error.code !== "EEXIST") throw error;
    }
    dropMarker();
    const held = readJsonSafe(paths.lock);
    if (lockIsStale(paths, held) && takeovers < 5) {
      marker = beginTakeover(paths, held);
      if (marker) {
        takeovers += 1;
        continue;
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.max(1, Math.min(100, deadline - Date.now())));
  }
}

// A session's supervisor is alive while it holds the lock and keeps its `alive` file fresh.
export function sessionSupervisorAlive(paths) {
  const held = readJsonSafe(paths.lock);
  return Boolean(held) && !lockIsStale(paths, held);
}

// ─── the driver ─────────────────────────────────────────────────────────────

// Turns the app-server's account of a thread into the runner's envelopes. One instance drives one
// session for one supervisor process: it spawns the app-server when a turn needs it, handles the
// inbox, and returns when the session goes dormant or ends.
//
// outcome of run(): { envelope } the session ended (result.json is written), { dormant: true },
// or { fenced: true } another supervisor took the lock (nothing is written).
//
// `single: true` is the driver of a steerable workflow node (request `steerable`): ONE job, not a session. Its
// turn 1 is the job's task; the continuations a usage limit, an account change or a transient failure ask for
// run on the same thread and under the job's own deadline; the job's last envelope becomes result.json and the
// driver ends — no idle period, no dormancy, no revive. outcome: { envelope } | { fenced: true } | { fallback:
// { reason, kind } } when the app-server could not even be started for the first turn (the caller then runs the
// very same job on `codex exec`). Steering, interrupting, cancelling and `events` work as in a session; a
// message that would queue a follow-up, and an answer, are rejected (nothing asks a question here).
export async function runSession(args) {
  const driver = new SessionDriver(args);
  try {
    return await (driver.single ? driver.runJob() : driver.run());
  } finally {
    await driver.cleanup();
  }
}

// Failures of the first start that are not a reason to leave the session backend: the usage limit and the
// login have their own waits (and exec would meet the same wall).
const NO_FALLBACK_KINDS = new Set(["usage_limit", "auth"]);

class SessionDriver {
  constructor({ runId, request, paths, context, log, check, control, setSlot, single = false }) {
    this.single = Boolean(single);
    this.steers = 0; // steering messages accepted by the app-server (a steerable job reports them in its provenance)
    this.runId = runId;
    this.request = request;
    this.paths = paths;
    this.context = context;
    this.log = log;
    this.check = check;
    this.control = control;
    this.setSlot = setSlot;
    const saved = readJsonSafe(paths.state) ?? {};
    this.saved = saved;
    this.turn = Number(saved.turn) || 0; // turns begun
    this.threadId = typeof saved.threadId === "string" ? saved.threadId : null;
    this.threadIds = Array.isArray(saved.threadIds) ? saved.threadIds : [];
    this.usageTotal = isPlainObject(saved.usageTotal) ? saved.usageTotal : null;
    this.events = new EventLog(paths.events, () => this.turn);
    this.server = null;
    this.active = null; // the running turn
    this.chain = null; // the work item in progress (a turn plus its limit/account continuations)
    this.queue = [];
    this.questions = []; // ask_orchestrator calls waiting for an answer, oldest first
    this.phase = "queued";
    this.idleUntil = null;
    this.closeRequest = null;
    this.waitAbort = null;
    this.waitingInChain = false;
    this.ending = false;
    this.slot = null;
    this.nextSnapshotAt = 0;
    this.nextAccountCheckAt = 0;
    this.nextTurnAccountCheckAt = 0;
    this.handoff = false; // a turn was interrupted for an account switch and its continuation has not started yet
    // read by the Phase 1 limit/account waits through the run's context: how a session's inbox
    // reaches them (close and interrupt must not wait out a 24-hour limit wait)
    context.waitStop = () => this.waitStopHook();
  }

  // ── state and events ──

  publish(extra = {}) {
    if (this.control.fenced) return; // the session belongs to another supervisor now: its state is not ours to write
    const question = this.questions[0] ?? null;
    tryUpdateState(this.paths, {
      state: this.phase,
      session: true,
      threadId: this.threadId,
      threadIds: this.threadIds.length ? this.threadIds : undefined,
      turn: this.turn,
      turnActive: Boolean(this.active),
      steerable: Boolean(this.active?.steerable),
      idleUntil: this.idleUntil ? new Date(this.idleUntil).toISOString() : null,
      question: question ? { id: question.id, question: clip(question.question, 4000), since: question.since } : null,
      queued: this.queue.length,
      usageTotal: this.usageTotal ?? undefined,
      eventsCapped: this.events.capped || undefined,
      ...extra,
    });
  }

  tick() {
    const gap = this.context.clock.tick();
    if (!gap) return 0;
    // time asleep is not time worked, waited or idled
    if (this.active) this.active.deadlineAt += gap;
    if (this.idleUntil) this.idleUntil += gap;
    for (const question of this.questions) question.autoAt += gap;
    if (this.context.recoveryDeadlineAt) this.context.recoveryDeadlineAt += gap;
    this.log(`resumed after ~${Math.round(gap / 1000)} s suspended; deadlines moved`);
    return gap;
  }

  stopNow() {
    if (this.control.fenced) return "fenced";
    // an idle session is revivable, not abandoned: only a cancel ends it; a running turn also
    // honours onOrphan (see stopReason)
    if (this.active || this.chain) return stopReason(this.paths, this.request, this.context.clock);
    return fs.existsSync(this.paths.cancel) ? "cancelled" : null;
  }

  snapshotTree() {
    if (process.platform !== "win32" || this.context.job || !this.server || Date.now() < this.nextSnapshotAt) return;
    trackWindowsTree(this.server.child, this.context.tracked);
    this.nextSnapshotAt = Date.now() + TIMING.treeSnapshotMs;
  }

  // ── the main loop ──

  async run() {
    // The lock may have changed hands while the job helper started (seconds): before anything is
    // written, is the session still ours?
    if (!this.control.fenced && this.control.stillHeld && !this.control.stillHeld()) this.control.fenced = true;
    if (this.control.fenced) return this.fence();
    this.settleCrashedTurn();
    const first = !this.threadId && this.turn === 0;
    if (first) {
      this.queue.push({ id: "task", text: this.request.task, reason: "task", images: this.request.images ?? [], persisted: false });
    } else {
      this.queue = queuedItems(this.paths).map((item) => ({ ...item, persisted: true }));
    }
    this.publish({ supervisorPid: process.pid });
    for (;;) {
      if (this.control.fenced) return this.fence();
      this.tick();
      const stop = this.stopNow();
      if (stop) return this.stopOutcome(stop);
      await this.processInbox();
      if (this.closeRequest) return this.finishClose();
      if (this.queue.length) {
        const result = await this.runChain(this.queue[0]);
        if (result) return result;
        continue;
      }
      if (this.server?.exited) {
        this.events.append("error", { kind: "execution", message: "the app-server exited while idle", willRetry: false });
        return this.goDormant();
      }
      if (this.phase !== "idle") {
        if (!this.server) return this.goDormant(); // revived with nothing left to run
        this.goIdle();
      }
      if (this.accountSwitchedWhileIdle()) return this.dormantForAccount();
      if (Date.now() >= this.idleUntil) return this.goDormant();
      this.snapshotTree();
      await sleep(TIMING.pollMs);
    }
  }

  async cleanup() {
    this.context.waitStop = null;
    if (this.server) await this.stopServer({ force: true });
    if (this.slot) this.releaseSlot();
  }

  fence() {
    this.log("fenced: stopping the app-server without touching the session");
    return this.stopServer({ force: true }).then(() => ({ fenced: true }));
  }

  stopOutcome(stop) {
    if (stop === "fenced") return this.fence();
    // a `close` of a steerable job is a cancel: its sender is told "closed" once the job has ended
    return this.endForGood(stop, {
      classification: classifyFailure({ cancelled: stop === "cancelled", abandoned: stop === "abandoned" }),
      closeMessage: this.single ? this.closeRequest?.message ?? null : null,
    });
  }

  // A previous supervisor died mid-turn: its turn never wrote an envelope. Say so, so that
  // turn numbers, `wait` and `result` stay consistent.
  settleCrashedTurn() {
    settleCrashedTurn({ request: this.request, runId: this.runId, paths: this.paths, state: this.saved, events: this.events, context: this.context });
    this.questions = [];
  }

  // ── idle and dormant ──

  goIdle() {
    this.phase = "idle";
    this.idleUntil = Date.now() + this.request.idleTtlSec * 1000;
    // events first, state second: a follower that reads the state then flushes the events sees
    // everything up to this point
    this.events.append("idle", { idleUntil: new Date(this.idleUntil).toISOString() });
    this.publish({ state: "idle" });
  }

  // Has the managed account changed under an app-server that has nothing to do? A Codex process that
  // refreshes its tokens after a switch merges the old account's tokens into the new auth.json, so an
  // idle one must not hold the old login for its whole idle time. Never while a turn runs or one is
  // queued (a running turn is not stopped for a switch: the next turn follows it, see ensureServer),
  // and a missing or unreadable login (null) is not a switch. Checked at most every accountCheckMs.
  accountSwitchedWhileIdle({ now = false } = {}) {
    if (!this.server || this.server.exited || this.active || this.chain || this.queue.length) return false;
    if (!now && Date.now() < this.nextAccountCheckAt) return false;
    this.nextAccountCheckAt = Date.now() + TIMING.accountCheckMs;
    const current = managedAccountIdentity();
    return Boolean(current && this.server.login && current !== this.server.login);
  }

  dormantForAccount() {
    this.log("the managed account changed while the session was idle; going dormant so that no app-server keeps the old login (the next message resumes the thread on the new one)");
    return this.goDormant("account_change");
  }

  async goDormant(reason = null) {
    // An ephemeral thread is not saved by Codex: with the process gone nothing could revive it.
    if (this.request.ephemeral) return this.endForGood("closed");
    await this.stopServer();
    this.events.append("dormant", reason ? { reason } : {});
    this.phase = "dormant";
    this.idleUntil = null;
    this.publish({ state: "dormant", dormantAt: nowIso(), supervisorPid: null });
    return { dormant: true };
  }

  // ── slots ──

  async takeSlot() {
    const slot = await acquireSlots(this.request.weight, this.runId, () => this.waitStopHook() ?? this.check());
    if (slot.stopped) return { stopped: slot.stopped };
    this.slot = slot;
    this.setSlot(slot);
    return { slot };
  }

  releaseSlot() {
    try {
      this.slot?.release();
    } catch {
      // slot directories are reclaimed when stale
    }
    this.slot = null;
    this.setSlot(null);
  }

  // ── inbox ──

  finish(message, ack) {
    moveInbox(this.paths, message.id);
    writeAck(this.paths, message.id, ack);
  }

  async processInbox() {
    for (const entry of sessionPendingMessages(this.paths)) {
      const message = entry.message;
      if (!isPlainObject(message) || !MESSAGE_KINDS.has(message.kind)) {
        this.finish({ id: entry.id }, { outcome: "rejected", reason: "invalid_message" });
        continue;
      }
      if (this.closeRequest?.message.id === message.id) continue;
      if (this.ending) {
        this.finish(message, { outcome: "rejected", reason: "session_ended" });
        continue;
      }
      let verdict;
      switch (message.kind) {
        case "send":
          verdict = await this.onSend(message);
          break;
        case "interrupt":
          verdict = await this.onInterrupt(message);
          break;
        case "answer":
          verdict = this.onAnswer(message);
          break;
        default:
          verdict = await this.onClose(message);
      }
      if (verdict === "defer") break; // a turn that is still starting: keep the order
    }
  }

  // Accepts a follow-up as the next turn. The ack's `turn` is the number the turn will have
  // (a limit continuation in between would move it by one).
  enqueue(message, { started }) {
    // a message handled before its supervisor died (queued, not yet moved) arrives a second time
    const known = this.queue.find((entry) => entry.id === message.id);
    if (known) return this.finish(message, { outcome: "queued", turn: this.turn + 1 + this.queue.indexOf(known) });
    const ahead = this.queue.length;
    const item = { id: message.id, text: String(message.text), reason: "followup", mode: message.mode ?? "auto", createdAt: message.createdAt, images: [], persisted: true };
    fs.mkdirSync(this.paths.queue, { recursive: true });
    writeJsonAtomic(path.join(this.paths.queue, `${item.id}.json`), { id: item.id, text: item.text, reason: item.reason, mode: item.mode, createdAt: item.createdAt });
    this.queue.push(item);
    this.events.append("followup", { text: clip(item.text, 500) });
    if (this.phase === "idle") {
      this.phase = "queued";
      this.idleUntil = null;
    }
    this.publish();
    const expected = this.turn + 1 + ahead + (this.chain && !this.active ? 1 : 0);
    this.finish(message, { outcome: started && ahead === 0 ? "started" : "queued", turn: expected });
  }

  async onSend(message) {
    const mode = ["auto", "steer", "queue"].includes(message.mode) ? message.mode : "auto";
    if (typeof message.text !== "string" || !message.text.trim()) return this.finish(message, { outcome: "rejected", reason: "empty_message" });
    // a session that is being closed takes nothing new: a message acknowledged now would be lost
    if (this.closeRequest) return this.finish(message, { outcome: "rejected", reason: "session_closing" });
    // a steerable job ends with its turn: there is no follow-up to queue, so only a steer can be taken
    if (this.single && mode === "queue") return this.finish(message, { outcome: "rejected", reason: "single_turn" });
    const turn = this.active;
    // a turn being handed over to a new account takes nothing: the message goes into its continuation
    if (mode !== "queue" && (turn ? turn.interruptReason === "account_switch" : this.handoff)) return "defer";
    if (!turn) {
      if (mode === "steer" || this.single) return this.finish(message, { outcome: "rejected", reason: "no_active_turn" });
      return this.enqueue(message, { started: !this.chain });
    }
    if (mode === "queue") return this.enqueue(message, { started: false });
    if (!turn.id) return "defer"; // the turn's id is not known yet: steering needs it
    if (!turn.steerable) {
      if (mode === "steer" || this.single) return this.finish(message, { outcome: "rejected", reason: "not_steerable" });
      return this.enqueue(message, { started: false });
    }
    const steer = await this.steer(turn, message.text);
    this.events.append("steer", { text: clip(message.text, 500), outcome: steer.ok ? "steered" : steer.reason });
    if (steer.ok) {
      this.steers += 1;
      return this.finish(message, { outcome: "steered", turn: turn.n });
    }
    if (mode === "steer" || this.single) return this.finish(message, { outcome: "rejected", reason: steer.reason });
    // auto: the turn just ended (start a turn instead) or cannot take input (queue after it)
    return this.enqueue(message, { started: steer.reason === "no_active_turn" });
  }

  async steer(turn, text) {
    if (!this.server || this.server.exited) return { ok: false, reason: "no_active_turn" };
    try {
      await this.server.client.request(
        "turn/steer",
        { threadId: this.threadId, expectedTurnId: turn.id, input: [{ type: "text", text, text_elements: [] }] },
        { timeoutMs: 20_000 }
      );
      return { ok: true };
    } catch (error) {
      const info = error?.data?.codexErrorInfo;
      if (isPlainObject(info) && info.activeTurnNotSteerable) {
        turn.steerable = false;
        this.publish();
        return { ok: false, reason: "not_steerable" };
      }
      if (/no active turn/i.test(String(error?.message))) return { ok: false, reason: "no_active_turn" };
      if (/expected active turn id/i.test(String(error?.message))) return { ok: false, reason: "turn_mismatch" };
      return { ok: false, reason: "steer_failed" };
    }
  }

  async interruptTurn(turn) {
    if (!this.server || this.server.exited || !turn.id) return false;
    try {
      await this.server.client.request("turn/interrupt", { threadId: this.threadId, turnId: turn.id }, { timeoutMs: 10_000 });
      return true;
    } catch (error) {
      this.log(`turn/interrupt failed: ${error.message}`);
      return false;
    }
  }

  async onInterrupt(message) {
    const turn = this.active;
    if (!turn) return this.finish(message, { outcome: "no_active_turn" });
    if (!turn.id) return "defer";
    if (turn.interruptReason === null || turn.interruptReason === "account_switch") turn.interruptReason = "interrupt"; // a user's interrupt outranks a handoff in progress
    this.events.append("interrupt", {});
    this.failQuestions("The orchestrator interrupted the turn.");
    const interrupted = await this.interruptTurn(turn);
    return this.finish(message, interrupted ? { outcome: "interrupted", turn: turn.n } : { outcome: "no_active_turn" });
  }

  onAnswer(message) {
    if (this.single) return this.finish(message, { outcome: "rejected", reason: "single_turn" }); // nothing asks a question here
    const question = this.questions.find((entry) => entry.id === message.questionId);
    if (!question) return this.finish(message, { outcome: "no_such_question" });
    this.resolveQuestion(question, { text: String(message.text ?? ""), success: true, auto: false });
    return this.finish(message, { outcome: "answered" });
  }

  async onClose(message) {
    if (this.single) {
      this.closeAsCancel(message);
      return null;
    }
    const busy = Boolean(this.active || this.chain || this.queue.length); // a queued follow-up was acknowledged: closing would drop it
    if (busy && !message.force) return this.finish(message, { outcome: "rejected", reason: "turn_active" });
    this.closeRequest = { message, force: Boolean(message.force), archive: Boolean(message.archive) };
    if (this.active) {
      this.active.interruptReason ??= "closed";
      this.active.killAt ??= Date.now() + TIMING.killGraceMs; // an app-server that ignores the interrupt is stopped
      this.events.append("interrupt", {});
      this.failQuestions("The session is being closed.");
      await this.interruptTurn(this.active);
    }
    return null; // acknowledged when the session has closed
  }

  // A steerable job has no session to close: `close` is what `cancel RUN_ID` is — the same cancel file, so that
  // every wait and the running turn see it — and its sender is told "closed" once the job has ended (stopOutcome).
  closeAsCancel(message) {
    try {
      fs.writeFileSync(this.paths.cancel, nowIso());
    } catch {
      // the cancel file is how every wait learns of it: without it the close is refused
      this.finish(message, { outcome: "rejected", reason: "cancel_failed" });
      return false;
    }
    this.closeRequest = { message, force: true, archive: false };
    return true; // acknowledged when the job has ended
  }

  // Handled from inside the Phase 1 waits and the slot wait, where nothing can be awaited: a
  // sticky reason to stop waiting ("closed", "interrupted", "cancelled", ...), or null.
  waitStopHook() {
    if (this.waitAbort) return this.waitAbort;
    if (this.control.fenced) return (this.waitAbort = "fenced");
    for (const entry of sessionPendingMessages(this.paths)) {
      const message = entry.message;
      if (!isPlainObject(message) || !MESSAGE_KINDS.has(message.kind)) {
        this.finish({ id: entry.id }, { outcome: "rejected", reason: "invalid_message" });
        continue;
      }
      if (this.closeRequest?.message.id === message.id) continue;
      if (message.kind === "send") {
        const mode = ["auto", "steer", "queue"].includes(message.mode) ? message.mode : "auto";
        if (this.handoff && mode !== "queue") continue; // held until the continuation of an account switch runs: it takes it as a steer
        if (typeof message.text !== "string" || !message.text.trim()) this.finish(message, { outcome: "rejected", reason: "empty_message" });
        else if (this.closeRequest) this.finish(message, { outcome: "rejected", reason: "session_closing" });
        else if (this.single) this.finish(message, { outcome: "rejected", reason: mode === "queue" ? "single_turn" : "no_active_turn" });
        else if (mode === "steer") this.finish(message, { outcome: "rejected", reason: "no_active_turn" });
        else this.enqueue(message, { started: false });
      } else if (message.kind === "answer") {
        this.finish(message, this.single ? { outcome: "rejected", reason: "single_turn" } : { outcome: "no_such_question" });
      } else if (message.kind === "interrupt") {
        if (this.waitingInChain) {
          this.events.append("interrupt", {});
          this.finish(message, { outcome: "interrupted", turn: this.turn });
          return (this.waitAbort = "interrupted");
        }
        this.finish(message, { outcome: "no_active_turn" });
      } else if (this.single) {
        if (this.closeAsCancel(message)) return (this.waitAbort = "cancelled");
      } else {
        this.closeRequest = { message, force: Boolean(message.force), archive: Boolean(message.archive) };
        return (this.waitAbort = "closed");
      }
    }
    return null;
  }

  // ── ask_orchestrator ──

  onToolCall(params) {
    const reply = (text, success) => ({ contentItems: [{ type: "inputText", text }], success });
    if (params.threadId && params.threadId !== this.threadId) return reply("unknown thread", false);
    if (params.tool !== ASK_TOOL.name || !this.request.askOrchestrator) return reply("unknown tool", false);
    const question = typeof params.arguments?.question === "string" ? params.arguments.question.trim() : "";
    if (!question) return reply("ask_orchestrator needs a non-empty question", false);
    const id = String(params.callId ?? randomBytes(6).toString("hex"));
    return new Promise((resolve) => {
      const entry = { id, question, since: nowIso(), autoAt: Date.now() + this.request.askTimeoutSec * 1000, resolve };
      this.questions.push(entry);
      this.events.append("question", { id, question: clip(question, 4000) });
      this.publish();
    });
  }

  resolveQuestion(question, { text, success, auto }) {
    this.questions = this.questions.filter((entry) => entry !== question);
    this.events.append("answer", { id: question.id, auto });
    this.publish();
    question.resolve({ contentItems: [{ type: "inputText", text }], success });
  }

  failQuestions(text) {
    for (const question of [...this.questions]) this.resolveQuestion(question, { text, success: false, auto: true });
  }

  autoAnswerDue() {
    for (const question of [...this.questions]) {
      if (Date.now() < question.autoAt) continue;
      this.resolveQuestion(question, {
        text: `No answer from the orchestrator within ${this.request.askTimeoutSec} s. Proceed with your best judgement and state the assumption you made in your final answer.`,
        success: true,
        auto: true,
      });
    }
  }

  // ── the app-server ──

  async spawnServer() {
    const { launcher } = this.context;
    const mcpServers = this.request.hermetic ? configuredMcpServers() : [];
    const args = buildAppServerArgs(this.request, { windowsSandbox: this.context.windowsSandbox, mcpServers });
    this.log(`app-server: ${launcher.displayPath} ${args.join(" ")}`);
    try {
      if (fileSize(this.paths.appServerLog) > 4 * 1024 * 1024) fs.rmSync(this.paths.appServerLog, { force: true });
    } catch {
      // best effort
    }
    const errorFd = fs.openSync(this.paths.appServerLog, "a");
    let child;
    try {
      child = spawn(launcher.command, [...launcher.argsPrefix, ...args], {
        cwd: this.request.cwd,
        env: { ...process.env, ...launcher.env },
        stdio: ["pipe", "pipe", errorFd],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } finally {
      fs.closeSync(errorFd);
    }
    // `login`: the managed account this app-server started with, also for an ephemeral session (whose `account` is not tracked)
    const login = managedAccountIdentity();
    const server = { child, client: null, exited: false, exitCode: null, closing: false, spawnError: null, lastTotal: null, account: this.request.ephemeral ? null : login, login };
    const gone = deferred();
    server.gone = gone.promise;
    const markGone = (code) => {
      if (server.exited) return;
      server.exited = true;
      server.exitCode = code;
      server.client?.close();
      gone.resolve();
    };
    child.once("exit", (code, signal) => markGone(code ?? signal));
    child.once("error", (error) => {
      server.spawnError = error;
      markGone(null);
    });
    child.stdin.on("error", () => {});
    server.client = new JsonRpcClient({
      send: (message) => {
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
          return true;
        } catch {
          return false;
        }
      },
      onNotification: (message) => this.onNotification(server, message),
      onServerRequest: (message) => this.onServerRequest(server, message),
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => server.client.feed(chunk));
    child.stdout.on("error", () => {});
    if (process.platform === "win32" && !this.context.job) trackWindowsTree(child, this.context.tracked);
    return server;
  }

  // Closes the app-server's stdin (it exits cleanly in under a second), kills it only if it
  // lingers, then stops whatever it left behind — a dormant or ended session has no processes.
  async stopServer({ force = false } = {}) {
    const server = this.server;
    if (!server) return;
    server.closing = true;
    try {
      server.child.stdin.end();
    } catch {
      // already closed
    }
    if (!force) await withTimeout(server.gone, TIMING.killGraceMs);
    const { tracked, job } = this.context;
    const teardown = server.exited ? await reapLeftovers(server.child, tracked, { job }) : await stopOwnedTree(server.child, { tracked, job });
    await withTimeout(server.gone, 10_000);
    if (teardown?.survivors?.length) this.log(`still running after the app-server was stopped: ${teardown.survivors.join(", ")}`);
    if (teardown?.possibleLeftovers?.length) this.log(`possibly left running (ancestry not provable, not stopped): ${teardown.possibleLeftovers.join(", ")}`);
    server.client.close();
    if (this.server === server) this.server = null;
  }

  // MCP servers that report tools in a session that was meant to be hermetic: the names, or a
  // failure to find out (which is as bad: a check that cannot run proves nothing).
  async hermeticViolations(server) {
    const names = [];
    let cursor = null;
    for (let page = 0; page < 50; page += 1) {
      const answer = await server.client.request("mcpServerStatus/list", cursor ? { cursor } : {}, { timeoutMs: 60_000 });
      for (const entry of Array.isArray(answer?.data) ? answer.data : []) {
        if (isPlainObject(entry?.tools) && Object.keys(entry.tools).length) names.push(String(entry.name));
      }
      cursor = typeof answer?.nextCursor === "string" && answer.nextCursor ? answer.nextCursor : null;
      if (!cursor) break;
    }
    return names;
  }

  // `config/read` for a hermetic app-server, judged by isolationViolations: null when the configuration is
  // isolated, else { keys, more?, message } — the key names only, never a value.
  async configViolation(server) {
    let read = null;
    let readError = null;
    try {
      read = await server.client.request("config/read", { cwd: this.request.cwd, includeLayers: false }, { timeoutMs: TIMING.configReadTimeoutMs });
    } catch (error) {
      readError = error;
    }
    const verdict = readError ? { ok: false, keys: ["<unverifiable>"] } : isolationViolations(read, { request: this.request });
    if (verdict.ok) return null;
    const unverifiable = verdict.keys.length === 1 && verdict.keys[0] === "<unverifiable>";
    const message = unverifiable
      ? `could not verify that the app-server's configuration is isolated (${readError ? `config/read failed: ${readError.message}` : "config/read returned no readable origins"}); the app-server was stopped before any thread was started`
      : `a hermetic app-server found settings from the user's or the project's config that would change what the model sees or can do: ${verdict.keys.join(", ")}${verdict.more ? ` (and ${verdict.more} more)` : ""}; the app-server was stopped before any thread was started`;
    return { keys: verdict.keys, ...(verdict.more ? { more: verdict.more } : {}), message };
  }

  // The app-server up, a thread on it (started, or resumed with the sandbox the request asked
  // for), the hermetic check passed. { ok: true, restartedForAccount } or { fail, fatal }.
  async ensureServer(restartReason, { fresh = false } = {}) {
    let restartedForAccount = false;
    if (this.server && !this.server.exited) {
      const current = this.request.ephemeral ? null : managedAccountIdentity();
      if (restartReason !== "account_change" && !(current && this.server.account && current !== this.server.account)) return { ok: true, restartedForAccount };
      // the running app-server holds the old login: it is stopped and a new one resumes the thread
      restartedForAccount = restartReason !== "account_change";
      restartReason = "account_change";
      await this.stopServer();
    } else if (this.server) {
      await this.stopServer({ force: true });
    }
    let server;
    try {
      server = await this.spawnServer();
      this.server = server;
      await server.client.request(
        "initialize",
        { clientInfo: { name: "ultracodex", title: "ultracodex", version: RUNNER_VERSION }, capabilities: { experimentalApi: true } },
        { timeoutMs: 30_000 }
      );
      server.client.notify("initialized");
      if (this.request.hermetic) {
        // Verified isolation, before any thread exists: what is left of the user's config in this app-server
        // (it has no --ignore-user-config) must be inert, neutralized or owned by the driver. A check that
        // cannot run (an older Codex without config/read, a timeout) proves nothing.
        const violation = await this.configViolation(server);
        if (violation) {
          this.events.append("hermetic_violation", { keys: violation.keys, ...(violation.more ? { more: violation.more } : {}) });
          await this.stopServer({ force: true });
          return { fail: { kind: "hermetic_violation", retryable: false, message: compact(violation.message), status: null }, fatal: true };
        }
      }
      const params = { sandbox: this.request.sandbox, approvalPolicy: "never", model: this.request.model };
      if (this.request.hermetic) params.approvalsReviewer = "user"; // never the user's own `auto_review` subagent
      if (this.request.serviceTier) params.serviceTier = this.request.serviceTier;
      const resuming = !fresh && (Boolean(this.threadId) || this.request.mode === "resume");
      if (!resuming) {
        const started = await server.client.request(
          "thread/start",
          { ...params, cwd: this.request.cwd, ephemeral: this.request.ephemeral, ...(this.request.askOrchestrator ? { dynamicTools: [ASK_TOOL] } : {}) },
          { timeoutMs: 60_000 }
        );
        this.adoptThread(started?.thread?.id);
        this.events.append("session_started", { threadId: this.threadId });
      } else {
        const external = !this.threadId;
        const resumed = await server.client.request(
          "thread/resume",
          { ...params, threadId: this.threadId ?? this.request.resume.sessionId, excludeTurns: true, ...(external ? { cwd: this.request.cwd } : {}) },
          { timeoutMs: 60_000 }
        );
        this.adoptThread(resumed?.thread?.id ?? this.threadId ?? this.request.resume.sessionId);
        if (external) this.events.append("session_started", { threadId: this.threadId, askOrchestrator: false });
        else this.events.append("resumed", { reason: restartReason ?? "revive" });
      }
      if (this.request.hermetic) {
        let violations = null;
        let checkError = null;
        try {
          violations = await this.hermeticViolations(server);
        } catch (error) {
          checkError = error; // a check that cannot run proves nothing
        }
        if (violations === null || violations.length) {
          this.events.append("hermetic_violation", { servers: violations ?? [] });
          await this.stopServer({ force: true });
          const why =
            violations === null
              ? `could not verify that no MCP server is loaded (${checkError?.message ?? "unknown error"}); the app-server was stopped before any turn`
              : `a hermetic session found MCP servers with tools: ${violations.join(", ")}; the app-server was stopped before any turn`;
          return { fail: { kind: "hermetic_violation", retryable: false, message: compact(why), status: null }, fatal: true };
        }
      }
      return { ok: true, restartedForAccount };
    } catch (error) {
      const spawnError = server?.spawnError ?? (error?.code === "ENOENT" || error?.code === "EACCES" ? error : null);
      const detail = spawnError ? String(spawnError.message ?? spawnError) : String(error?.message ?? error);
      this.log(`app-server start failed: ${detail}`);
      await this.stopServer({ force: true }).catch(() => {});
      const classification = spawnError ? { kind: "spawn", retryable: false, message: compact(detail), status: null } : classifySessionError({ message: detail });
      return { fail: classification, fatal: !this.threadId };
    }
  }

  adoptThread(id) {
    if (typeof id !== "string" || !SESSION_RE.test(id)) throw new Error("the app-server did not return a thread id");
    if (this.threadId && this.threadId !== id && !this.threadIds.includes(this.threadId)) this.threadIds.push(this.threadId);
    this.threadId = id;
  }

  // ── notifications ──

  onServerRequest(server, message) {
    if (server !== this.server) throw Object.assign(new Error("stale connection"), { code: -32603 });
    if (message.method === "item/tool/call") return this.onToolCall(isPlainObject(message.params) ? message.params : {});
    // Approvals, user-input requests and elicitations are not expected with approvalPolicy
    // "never"; none is answered favourably.
    this.events.append("error", { kind: "unexpected_request", message: clip(`the app-server asked ${message.method}; declined`, 500), willRetry: false });
    throw Object.assign(new Error(`${message.method} is not supported by this client`), { code: -32601 });
  }

  emit(turn, type, fields) {
    if (!turn.started) turn.held.push([type, fields]);
    else this.events.append(type, fields);
  }

  markStarted(turn) {
    if (turn.started) return;
    turn.started = true;
    this.events.append("turn_started", { turnId: turn.id, reason: turn.reason });
    for (const [type, fields] of turn.held.splice(0)) this.events.append(type, fields);
  }

  onNotification(server, message) {
    if (server !== this.server) return;
    const params = isPlainObject(message.params) ? message.params : {};
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    const turn = this.active;
    if (message.method === "thread/tokenUsage/updated") return this.onUsage(server, params);
    if (!turn) return;
    if (turn.id && params.turnId && params.turnId !== turn.id) return;
    switch (message.method) {
      case "turn/started":
        if (!turn.id && typeof params.turn?.id === "string") turn.id = params.turn.id;
        if (turn.id) this.markStarted(turn);
        return;
      case "item/started":
        return this.onItemStarted(turn, params.item);
      case "item/completed":
        return this.onItemCompleted(turn, params.item);
      case "turn/plan/updated":
        return this.onPlan(turn, params.plan);
      case "error": {
        const error = isPlainObject(params.error) ? params.error : { message: String(params.error ?? "") };
        const classification = classifySessionError(error);
        turn.lastError = error;
        this.emit(turn, "error", { kind: classification.kind, message: clip(error.message, 500), willRetry: Boolean(params.willRetry) });
        return;
      }
      case "turn/completed": {
        const done = params.turn;
        if (!isPlainObject(done)) return;
        if (turn.id && done.id && done.id !== turn.id) return;
        turn.completed = done;
        this.finishActive(turn);
        return;
      }
      default:
    }
  }

  finishActive(turn) {
    if (turn.finished) return;
    turn.finished = true;
    turn.done.resolve();
  }

  onUsage(server, params) {
    const usage = params.tokenUsage;
    if (!isPlainObject(usage) || !isPlainObject(usage.total)) return;
    const shape = (breakdown) => ({
      input_tokens: Number(breakdown?.inputTokens) || 0,
      cached_input_tokens: Number(breakdown?.cachedInputTokens) || 0,
      output_tokens: Number(breakdown?.outputTokens) || 0,
      reasoning_output_tokens: Number(breakdown?.reasoningOutputTokens) || 0,
    });
    const total = shape(usage.total);
    let increment = shape(usage.last);
    if (server.lastTotal) {
      const diff = Object.fromEntries(Object.keys(total).map((key) => [key, total[key] - server.lastTotal[key]]));
      if (Object.values(diff).every((value) => value >= 0)) increment = diff;
    }
    server.lastTotal = total;
    this.usageTotal = addUsage(this.usageTotal, increment);
    if (this.active) this.active.usage = addUsage(this.active.usage, increment);
  }

  onItemStarted(turn, item) {
    if (!isPlainObject(item)) return;
    if (STEP_ITEMS.has(item.type) && typeof item.id === "string") turn.inFlight.set(item.id, item.type);
    if (item.type === "commandExecution") this.emit(turn, "command_started", { command: clip(item.command, 300) });
    else if (item.type === "mcpToolCall") this.emit(turn, "tool", { name: clip(`${item.server}/${item.tool}`, 200) });
    else if (item.type === "webSearch") this.emit(turn, "tool", { name: "web_search" });
    else if (item.type === "dynamicToolCall" && item.tool !== ASK_TOOL.name) this.emit(turn, "tool", { name: clip(item.tool, 200) });
  }

  onItemCompleted(turn, item) {
    if (!isPlainObject(item)) return;
    if (typeof item.id === "string") turn.inFlight.delete(item.id);
    switch (item.type) {
      case "agentMessage": {
        const text = String(item.text ?? "");
        turn.lastMessage = text;
        if (item.phase === "final_answer") turn.final = text;
        this.emit(turn, "message", { phase: item.phase ?? null, text: clip(text, 4000) });
        return;
      }
      case "commandExecution":
        this.emit(turn, "command", {
          command: clip(item.command, 300),
          exitCode: item.exitCode ?? null,
          status: item.status ?? null,
          durationMs: item.durationMs ?? null,
          outputTail: String(item.aggregatedOutput ?? "").slice(-600),
        });
        return;
      case "fileChange":
        this.emit(turn, "file_change", {
          status: item.status ?? null,
          changes: (Array.isArray(item.changes) ? item.changes : []).slice(0, 100).map((change) => ({
            path: relativeTo(this.request.cwd, change?.path),
            kind: change?.kind?.type ?? null,
            ...(change?.kind?.move_path ? { to: relativeTo(this.request.cwd, change.kind.move_path) } : {}),
          })),
        });
        return;
      default:
    }
  }

  onPlan(turn, plan) {
    if (!Array.isArray(plan)) return;
    const steps = plan.slice(0, 50).map((entry) => ({ step: clip(entry?.step, 300), status: String(entry?.status ?? "") }));
    const key = JSON.stringify(steps);
    if (turn.planKey === key) return;
    turn.planKey = key;
    this.emit(turn, "plan", { steps });
  }

  // ── one turn ──

  // Runs one turn: a slot, the app-server (started or revived if need be), turn/start, then the
  // loop that keeps the turn honest — deadline, cancel, inbox, questions — until it completes.
  // → { kind: "completed", envelope, classification, turn } | { kind: "stop", reason } |
  //   { kind: "start_failed", classification, fatal }.
  async executeTurn(spec, chain) {
    this.phase = "queued";
    this.idleUntil = null;
    this.publish();
    this.waitingInChain = true;
    const taken = await this.takeSlot();
    this.waitingInChain = false;
    if (taken.stopped === "interrupted") {
      // an interrupt while the turn was still waiting for its slot: that message is dropped
      this.dequeue(spec.item);
      this.waitAbort = null;
    }
    if (taken.stopped) return { kind: "stop", reason: taken.stopped };
    try {
      // a retry that cannot resume its thread starts a fresh one (spec.fresh): never on the old server's thread
      const up = spec.fresh
        ? await this.ensureServer("account_change", { fresh: true })
        : await this.ensureServer(spec.restart ? "account_change" : this.server ? null : "revive");
      if (up.fail) {
        this.dequeue(spec.item);
        return { kind: "start_failed", classification: up.fail, fatal: up.fatal };
      }
      if (up.restartedForAccount) chain.handoffs += 1; // the account changed while the session was idle
      this.dequeue(spec.item);
      const n = (this.turn += 1);
      const turn = {
        n,
        id: null,
        reason: spec.reason,
        steerable: true,
        started: false,
        held: [],
        finished: false,
        done: deferred(),
        startedAtMs: Date.now(),
        deadlineAt: spec.deadlineAt ?? Date.now() + this.request.timeoutSec * 1000,
        final: null,
        lastMessage: null,
        usage: null,
        completed: null,
        lastError: null,
        timedOut: false,
        killAt: null,
        killed: false,
        crashed: false,
        interruptReason: null,
        planKey: null,
        inFlight: new Map(), // item id -> type, of the steps (tool calls) that have started and not completed
        switchPending: false, // the managed account changed: waiting for a step boundary to hand the turn over
        switchSkipped: false,
      };
      turn.account = this.server.account;
      this.active = turn;
      this.phase = "running";
      this.publish({
        attempt: n,
        attemptStartedAt: new Date(turn.startedAtMs).toISOString(),
        deadlineAt: new Date(turn.deadlineAt).toISOString(),
      });
      const server = this.server;
      const input = [{ type: "text", text: spec.text, text_elements: [] }, ...(spec.images ?? []).map((file) => ({ type: "localImage", path: file }))];
      const params = { threadId: this.threadId, input, effort: this.request.effort };
      if (this.request.schema) params.outputSchema = this.request.schema;
      let startError = null;
      try {
        const answer = await server.client.request("turn/start", params, { timeoutMs: 60_000 });
        if (!turn.id && typeof answer?.turn?.id === "string") turn.id = answer.turn.id;
      } catch (error) {
        startError = error;
      }
      if (startError) {
        turn.startError = startError;
        turn.crashed = server.exited && !server.closing;
        this.markStarted(turn);
        this.finishActive(turn);
      } else {
        this.markStarted(turn);
        this.handoff = false; // the continuation of a switch is running: what was held back can steer it now
        await this.driveTurn(turn, server);
      }
      if (this.control.fenced) return { kind: "stop", reason: "fenced" };
      this.failQuestions("The turn ended before the question was answered.");
      this.active = null;
      const done = this.completeTurn(turn, chain);
      return { kind: "completed", ...done, turn };
    } finally {
      this.active = null;
      this.releaseSlot();
    }
  }

  dequeue(item) {
    this.queue = this.queue.filter((entry) => entry !== item);
    if (item?.persisted) fs.rmSync(path.join(this.paths.queue, `${item.id}.json`), { force: true });
  }

  async driveTurn(turn, server) {
    while (!turn.finished) {
      await withTimeout(Promise.race([turn.done.promise, server.gone]), TIMING.pollMs);
      if (turn.finished) break;
      if (server.exited) {
        turn.crashed = !server.closing;
        this.finishActive(turn);
        break;
      }
      this.tick();
      this.snapshotTree();
      const stop = this.stopNow();
      if (stop === "fenced") {
        // another supervisor owns the session now: stop the app-server and write nothing
        await this.stopServer({ force: true });
        this.finishActive(turn);
        break;
      }
      if (stop) {
        turn.interruptReason = stop;
        await this.abortTurn(turn, server);
        break;
      }
      await this.processInbox();
      this.autoAnswerDue();
      await this.followSwitch(turn, server);
      if (!turn.timedOut && Date.now() >= turn.deadlineAt) {
        turn.timedOut = true;
        turn.interruptReason = "timeout";
        turn.killAt = Date.now() + TIMING.killGraceMs;
        this.log(`turn ${turn.n}: deadline reached; interrupting`);
        this.failQuestions("The turn's deadline was reached.");
        await this.interruptTurn(turn);
      }
      if (turn.killAt && !turn.finished && Date.now() >= turn.killAt) {
        this.log(`turn ${turn.n}: the app-server did not end the turn after the interrupt; killing it`);
        turn.killed = true;
        await this.stopServer({ force: true });
        this.finishActive(turn);
      }
    }
  }

  // The managed ChatGPT account changed while this turn runs (followAccountSwitch): the turn is handed
  // over at the next step boundary (no tool call in flight, no question waiting) by interrupting it;
  // it then ends as an "account_switch" failure and continuation() resumes the thread on a new
  // app-server with the new login. A running command is never interrupted. Whether to follow is judged
  // when the switch is seen — not without a saved thread, not past the handoff budget, not with too
  // little time left — and again at the boundary itself (the step may have taken the time or the
  // account may be back): then the turn finishes on the old account. A pending handoff keeps watching
  // the account: A -> B -> A before the boundary cancels it.
  async followSwitch(turn, server) {
    if (this.request.followAccountSwitch === false || turn.finished || turn.switchSkipped || turn.interruptReason) return;
    const notFollowed = (why) => {
      turn.switchSkipped = true;
      turn.switchPending = false;
      this.log(`turn ${turn.n}: the managed account changed, but the turn is not followed (${why}); it finishes on the old account`);
      this.events.append("account_switch", { status: "not_followed", reason: why });
    };
    const cancelled = () => {
      turn.switchPending = false;
      this.log(`turn ${turn.n}: the managed account is back to the one this turn runs on; nothing to hand over`);
      this.events.append("account_switch", { status: "cancelled" });
    };
    if (Date.now() >= this.nextTurnAccountCheckAt) {
      this.nextTurnAccountCheckAt = Date.now() + TIMING.accountCheckMs;
      const current = managedAccountIdentity();
      if (turn.switchPending) {
        if (current === server.account) return cancelled();
      } else {
        if (!(current && server.account && current !== server.account)) return;
        const why = this.switchNotFollowedBecause(turn);
        if (why) return notFollowed(why);
        turn.switchPending = true;
        this.log(`turn ${turn.n}: the managed account changed; handing the turn over at the next step boundary`);
        this.events.append("account_switch", { status: "pending" });
      }
    }
    if (!turn.switchPending || turn.inFlight.size || this.questions.length) return;
    // the boundary: judged again, on fresh facts
    const current = managedAccountIdentity();
    if (current === server.account) return cancelled();
    if (!current) return; // unreadable just now: not a switch to follow, not an undo either
    const why = this.switchNotFollowedBecause(turn);
    if (why) return notFollowed(why);
    turn.interruptReason = "account_switch";
    turn.killAt = Date.now() + TIMING.killGraceMs; // an app-server that ignores the interrupt is stopped
    this.handoff = true;
    this.log(`turn ${turn.n}: no step in flight; interrupting it for the account switch`);
    this.events.append("account_switch", { status: "interrupting" });
    await this.interruptTurn(turn);
  }

  switchNotFollowedBecause(turn) {
    const chain = this.chain;
    if (this.request.ephemeral) return "an ephemeral session's thread is not saved";
    if (!(typeof this.threadId === "string" && SESSION_RE.test(this.threadId))) return "the thread cannot be resumed";
    if (chain && chain.handoffs >= MAX_ACCOUNT_HANDOFFS) return `the budget of ${MAX_ACCOUNT_HANDOFFS} account handoffs is used up`;
    if (turn.deadlineAt - Date.now() < Math.max(1, TIMING.minTimeoutSec) * 1000) return "too little work time is left";
    return null;
  }

  // A cancel, an abandoned caller or a fence: interrupt the turn, give it killGraceMs to end,
  // then stop the app-server.
  async abortTurn(turn, server) {
    this.log(`turn ${turn.n}: stopping (${turn.interruptReason})`);
    this.failQuestions("The turn was stopped.");
    await this.interruptTurn(turn);
    await withTimeout(Promise.race([turn.done.promise, server.gone]), TIMING.killGraceMs);
    if (!turn.finished) {
      turn.killed = true;
      await this.stopServer({ force: true });
      this.finishActive(turn);
    }
  }

  // The turn's envelope: the same fields, signing and failure kinds a one-shot run's have.
  buildEnvelope(turn, chain) {
    const { request, runId, context } = this;
    const durationMs = Date.now() - turn.startedAtMs;
    const provenance = buildProvenance(request, {
      backend: "session",
      threadId: this.threadId,
      usage: turn.usage ?? (this.single ? this.usageTotal : null), // a node's result is trusted only with token usage: a turn that reported none shows the job's total
      usageTotal: this.usageTotal,
      durationMs,
      ...(this.single ? { attempts: turn.n } : {}), // the turns this job has taken, as a one-shot run counts its attempts
      codexVersion: context.codexVersion,
      launcher: context.launcher.source,
    });
    if (this.steers) provenance.steers = this.steers;
    if (this.threadIds.length) provenance.previousThreadIds = [...this.threadIds];
    if (chain.handoffs > chain.limitResumes) provenance.accountHandoffs = chain.handoffs - chain.limitResumes;
    if (chain.limitResumes) provenance.limitResumes = chain.limitResumes;
    if (context.limitWaitedMs) provenance.limitWaitedSec = Math.round(context.limitWaitedMs / 1000);
    if (chain.checkpoints) provenance.contextRestarts = chain.checkpoints;
    // a session's envelope says which turn it is; a steerable job's is a one-shot run's, field for field
    const tag = this.single ? {} : { session: { turn: turn.n } };
    const fail = (state, classification) => ({ ...failureEnvelope(request, runId, state, classification, provenance), ...tag });
    const completed = turn.completed;
    const status = completed?.status;
    const reason = turn.interruptReason;

    if (turn.startError && !turn.crashed) return fail("failed", classifySessionError({ message: String(turn.startError.message ?? turn.startError) }));
    if (reason === "account_switch" && (turn.killed || status === "interrupted")) return fail("failed", { kind: "account_switch", retryable: false, message: "the managed account changed; the turn was interrupted at a step boundary and its thread continues on the new account", status: null });
    if (turn.killed) {
      if (reason === "cancelled" || reason === "abandoned") return fail(reason, classifyFailure({ cancelled: reason === "cancelled", abandoned: reason === "abandoned" }));
      if (reason === "closed") return fail("interrupted", { kind: "interrupted", retryable: false, message: "the session was closed while this turn ran; the app-server did not end the turn when interrupted and was stopped", status: null });
      return fail("timeout", { kind: "timeout", retryable: false, message: "the turn's deadline was reached and the app-server did not end the turn when interrupted; it was stopped", status: null });
    }
    if (turn.crashed || !completed) {
      return fail("failed", { kind: "execution", retryable: false, message: compact(`the app-server exited${this.server?.exitCode != null ? ` (code ${this.server.exitCode})` : ""} while the turn was running${this.single ? "" : "; the session is dormant and can be revived"}`), status: null });
    }
    if (status === "interrupted") {
      if (reason === "timeout") return fail("timeout", { kind: "timeout", retryable: false, message: "the turn's deadline was reached; it was interrupted", status: null });
      if (reason === "cancelled" || reason === "abandoned") return fail(reason, classifyFailure({ cancelled: reason === "cancelled", abandoned: reason === "abandoned" }));
      const closed = reason === "closed";
      return fail("interrupted", { kind: "interrupted", retryable: false, message: closed ? "the session was closed while this turn ran; the turn was interrupted" : "the turn was interrupted on request", status: null });
    }
    if (status === "failed") {
      const error = isPlainObject(completed.error) ? completed.error : turn.lastError ?? { message: "the turn failed" };
      return fail("failed", classifySessionError(error));
    }
    const text = String(turn.final ?? turn.lastMessage ?? "").trim();
    // (a one-shot run retries a clean exit without a final message; so does a steerable job)
    if (!text) return fail("failed", { kind: "empty_output", retryable: this.single, message: "the turn completed without a final message", status: null });
    const digest = request.requestDigest ?? directDigest(request.task);
    const base = { ...baseEnvelope(request, runId), ok: true, state: "done", ...tag };
    if (!request.schema) {
      return { ...base, text, resultHash: fnv1a(text), mac: resultMac(context.key, runId, digest, "text", text), provenance };
    }
    let parsed;
    try {
      parsed = extractJsonObject(text);
    } catch (error) {
      return fail("failed", { kind: "parse", retryable: false, message: error.message, status: null });
    }
    const problems = validateValue(parsed, request.schema);
    if (problems.length) return fail("failed", { kind: "schema_mismatch", retryable: false, message: compact(problems.join("; ")), status: null });
    return { ...base, result: parsed, resultHash: fnv1a(JSON.stringify(parsed)), mac: resultMac(context.key, runId, digest, "result", JSON.stringify(parsed)), provenance };
  }

  completeTurn(turn, chain) {
    const envelope = this.buildEnvelope(turn, chain);
    writeJsonAtomic(turnFile(this.paths, turn.n), envelope);
    const kind = envelope.error?.kind;
    this.events.append("turn_completed", {
      status: envelope.ok ? "completed" : ["interrupted", "timeout", "cancelled", "abandoned", "account_switch"].includes(kind) ? "interrupted" : "failed",
      ok: envelope.ok,
      durationMs: envelope.provenance?.durationMs ?? null,
      usage: turn.usage ?? null,
      ...(envelope.ok ? {} : { kind }),
    });
    this.publish({ turnActive: false });
    return { envelope, classification: envelope.ok ? null : envelope.error };
  }

  // ── a unit of work: one message's turn, and the continuations a limit or an account change asks for ──

  async runChain(first) {
    const chain = { text: first.text, handoffs: 0, limitResumes: 0, checkpoints: 0, checkpointHandoff: 0 };
    this.chain = chain;
    this.context.limitWaitedMs = 0;
    let spec = { item: first, text: first.text, reason: first.reason, images: first.images ?? [], deadlineAt: null, restart: false };
    try {
      for (;;) {
        const out = await this.executeTurn(spec, chain);
        if (out.kind === "stop") {
          if (out.reason === "closed") return this.finishClose();
          if (out.reason === "interrupted") break;
          return this.stopOutcome(out.reason);
        }
        if (out.kind === "start_failed") return this.startFailed(out, spec);
        if (out.envelope.ok || this.closeRequest) break;
        const stop = this.stopNow();
        if (stop) return this.stopOutcome(stop);
        const next = await this.continuation(out, chain);
        if (next?.stop) {
          if (next.stop === "closed") return this.finishClose();
          if (next.stop !== "interrupted") return this.stopOutcome(next.stop);
          break;
        }
        if (!next) break;
        spec = next;
      }
    } finally {
      this.chain = null;
      this.waitAbort = null;
      this.handoff = false;
    }
    if (this.closeRequest) return this.finishClose();
    if (this.queue.length) return null;
    if (!this.server || this.server.exited) return this.goDormant();
    // a switch that happened during the turn: no idle time on the old login
    if (this.accountSwitchedWhileIdle({ now: true })) return this.dormantForAccount();
    this.goIdle();
    return null;
  }

  // The server could not be started (or resumed) for a turn. Without a thread there is nothing to
  // revive: the session fails for good. With one, the turn fails and the session sleeps; a hermetic
  // violation ends it either way.
  async startFailed(out, spec) {
    if (out.fatal || !this.threadId) return this.endForGood("failed", { classification: out.classification });
    const n = (this.turn += 1);
    const envelope = failureEnvelope(this.request, this.runId, "failed", out.classification, buildProvenance(this.request, { threadId: this.threadId, usageTotal: this.usageTotal, durationMs: 0 }));
    envelope.session = { turn: n };
    writeJsonAtomic(turnFile(this.paths, n), envelope);
    this.events.append("turn_started", { turnId: null, reason: spec.reason });
    this.events.append("error", { kind: out.classification.kind, message: clip(out.classification.message, 500), willRetry: false });
    this.events.append("turn_completed", { status: "failed", ok: false, durationMs: 0, usage: null, kind: out.classification.kind });
    this.publish({ turnActive: false });
    this.chain = null;
    return this.goDormant();
  }

  // After a failed turn: the Phase 1 recovery, inside the session — wait for the usage limit to
  // reset or for another account (limitWaitSec; the budget, spacing and deadline rules are the
  // one-shot run's), then continue the same thread. → the next turn's spec, { stop }, or null.
  async continuation(out, chain) {
    const { request, context } = this;
    const kind = out.classification.kind;
    const thread = this.threadId;
    context.recoveryDeadlineAt = out.turn.deadlineAt;
    const minWork = Math.max(1, TIMING.minTimeoutSec) * 1000;
    if (kind === "account_switch") {
      // the account changed and the turn was handed over at a step boundary: no wait, the thread resumes
      // on a new app-server (ensureServer announces it as resumed {reason: account_change}); the handoff
      // budget and the deadline are the other continuations'. Rejected encrypted reasoning on the new
      // account takes the checkpoint branch below on the continuation's own failure.
      if (!(!request.ephemeral && typeof thread === "string" && SESSION_RE.test(thread) && chain.handoffs < MAX_ACCOUNT_HANDOFFS && context.recoveryDeadlineAt - Date.now() >= minWork)) return null;
      chain.handoffs += 1;
      this.log(`continuing the thread on the newly selected account (handoff ${chain.handoffs - chain.limitResumes})`);
      return { item: null, text: continuationPrompt("switch", chain.text), reason: "continuation", images: [], deadlineAt: context.recoveryDeadlineAt, restart: true };
    }
    if (kind === "encrypted_history" && chain.handoffs > chain.checkpointHandoff && context.recoveryDeadlineAt - Date.now() >= minWork) {
      // the new account cannot read the saved reasoning: continue from the visible history in a
      // fresh thread, which becomes the session's thread
      const checkpoint = visibleAccountCheckpoint(thread, this.paths);
      if (checkpoint) {
        chain.checkpoints += 1;
        chain.checkpointHandoff = chain.handoffs;
        this.log("account-bound reasoning was rejected; continuing from the visible checkpoint in a fresh thread");
        const fresh = await this.freshThread();
        if (fresh.fail) return null;
        return { item: null, text: checkpointContinuation({ ...request, task: chain.text }, checkpoint), reason: "continuation", images: [], deadlineAt: context.recoveryDeadlineAt, restart: false };
      }
    }
    const account = out.turn.account ?? null;
    if (!(!request.ephemeral && account && chain.handoffs < MAX_ACCOUNT_HANDOFFS && typeof thread === "string" && SESSION_RE.test(thread)
        && ["usage_limit", "auth", "rate_limit"].includes(kind) && context.recoveryDeadlineAt - Date.now() >= minWork)) return null;
    const limitWait = kind === "usage_limit" && request.limitWaitSec > 0;
    this.log(limitWait
      ? `turn ${out.turn.n} ended (usage_limit); waiting up to ${request.limitWaitSec} s for the limit to reset or the account to change`
      : `turn ${out.turn.n} ended (${kind}); waiting for an account change before resuming its thread`);
    this.releaseSlot(); // a waiting session holds no slot
    this.phase = "backoff";
    this.idleUntil = null;
    if (limitWait) this.events.append("limit_wait", { resumesAt: null });
    this.waitingInChain = true;
    let announced = null;
    const watch = (line) => {
      this.log(line);
      const resumesAt = /resumesAt (\S+)$/.exec(line)?.[1];
      if (resumesAt && resumesAt !== announced) {
        announced = resumesAt;
        this.events.append("limit_wait", { resumesAt });
      }
    };
    const change = limitWait
      ? await waitForLimitReset(this.paths, request, context, account, watch, chain.limitResumes)
      : await waitForAccountChange(this.paths, request, context, account, kind === "usage_limit");
    this.waitingInChain = false;
    if (context.limitWaitedMs) {
      // this turn's envelope may be the session's last word: it says how long the session waited
      const envelope = readJsonSafe(turnFile(this.paths, out.turn.n));
      if (envelope?.provenance) writeJsonAtomic(turnFile(this.paths, out.turn.n), { ...envelope, provenance: { ...envelope.provenance, limitWaitedSec: Math.round(context.limitWaitedMs / 1000) } });
    }
    if (change.stop) return { stop: change.stop };
    if ((change.changed || change.reset) && Date.now() < context.recoveryDeadlineAt) {
      chain.handoffs += 1;
      if (change.reset) chain.limitResumes += 1;
      if (change.reset) this.events.append("resumed", { reason: "limit_reset" }); // an account change is announced by the restart
      this.log(change.reset
        ? `usage is available again; continuing the thread (limit resume ${chain.limitResumes}, ${Math.round((context.recoveryDeadlineAt - Date.now()) / 1000)} s of work time left)`
        : `continuing the thread on the newly selected account (handoff ${chain.handoffs - chain.limitResumes})`);
      return { item: null, text: continuationPrompt(change.reset ? "reset" : kind, chain.text), reason: "continuation", images: [], deadlineAt: context.recoveryDeadlineAt, restart: Boolean(change.changed) };
    }
    if (change.expired) this.log(`the usage limit did not reset within ${request.limitWaitSec} s; giving up`);
    return null;
  }

  // ── a steerable job: one turn, its continuations and retries, then the end ──

  // The whole job. Turn 1 is the task; after it, in the order a one-shot run applies them: the account / limit
  // continuations (continuation(): the same thread, the job's own deadline), then a retry of a transient failure
  // (retryTurn()). Whatever ends the chain — a result, a failure, a cancel, an interrupt, the deadline — is the
  // job's envelope. → { envelope } | { fenced: true } | { fallback: { reason, kind } }
  async runJob() {
    // The lock may have changed hands while the job helper started: is the job still ours?
    if (!this.control.fenced && this.control.stillHeld && !this.control.stillHeld()) this.control.fenced = true;
    if (this.control.fenced) return this.fence();
    const first = { id: "task", text: this.request.task, reason: "task", images: [], persisted: false };
    this.queue = [first];
    this.publish({ supervisorPid: process.pid });
    const chain = { text: first.text, handoffs: 0, limitResumes: 0, checkpoints: 0, checkpointHandoff: 0, retries: 1 };
    this.chain = chain;
    this.context.limitWaitedMs = 0;
    let spec = { item: first, text: first.text, reason: first.reason, images: [], deadlineAt: null, restart: false, fresh: false, retry: false };
    let freshTried = false;
    try {
      for (;;) {
        if (this.control.fenced) return this.fence();
        const out = await this.executeTurn(spec, chain);
        if (out.kind === "stop") return this.stopped(out.reason);
        if (out.kind === "start_failed") {
          const failure = out.classification;
          // before any turn: the job has not started — it runs on exec instead (a start failure is not the job's)
          if (this.turn === 0 && !NO_FALLBACK_KINDS.has(failure.kind)) return this.fallback(failure);
          // a retry whose thread cannot be resumed starts a fresh thread with the original task, once
          if (spec.retry && !out.fatal && !freshTried) {
            freshTried = true;
            this.log(`the thread cannot be resumed for the retry (${failure.kind}); retrying in a fresh thread with the original task`);
            spec = { ...spec, text: this.request.task, fresh: true };
            continue;
          }
          return this.endForGood("failed", { classification: failure });
        }
        if (out.envelope.ok) return this.endForGood(out.envelope.state, { envelope: out.envelope });
        const kind = out.classification.kind;
        if (kind === "interrupted") return this.endForGood("interrupted", { envelope: out.envelope }); // on request: never retried
        const stop = this.stopNow();
        if (stop) return this.stopOutcome(stop);
        let next = await this.continuation(out, chain);
        if (next?.stop) return this.stopped(next.stop);
        if (next) chain.retries = 1; // a continuation starts the retry count again, as a resume does for a one-shot run
        else {
          next = await this.retryTurn(out, chain);
          if (next?.stop) return this.stopped(next.stop);
        }
        if (!next) return this.endForGood(out.envelope.state, { envelope: out.envelope });
        spec = next;
      }
    } finally {
      this.chain = null;
      this.waitAbort = null;
      this.handoff = false;
    }
  }

  // Why the chain stopped before an envelope of its own: a cancel (or a close, which is one), an abandoned caller,
  // a lost lock, or an interrupt that reached a wait.
  stopped(reason) {
    if (reason === "interrupted") {
      return this.endForGood("interrupted", { classification: { kind: "interrupted", retryable: false, message: "the job was interrupted on request", status: null } });
    }
    return this.stopOutcome(reason);
  }

  // The app-server could not be started for the first turn: give the job back untouched.
  fallback(failure) {
    const reason = clip(failure.message, 300);
    this.events.append("backend_fallback", { reason, kind: failure.kind });
    this.log(`the session backend could not start the job (${failure.kind}): ${reason}`);
    return { fallback: { reason, kind: failure.kind } };
  }

  // A retryable failure with attempts left: back off (stoppable), then a continuation turn on the same thread
  // that says a transient error interrupted the turn. The job's deadline is the first turn's, so it bounds
  // the retries too. → the next turn's spec, { stop }, or null.
  async retryTurn(out, chain) {
    const { request, context } = this;
    const failure = out.classification;
    if (!failure.retryable || chain.retries >= request.maxAttempts) return null;
    context.recoveryDeadlineAt = out.turn.deadlineAt;
    if (context.recoveryDeadlineAt - Date.now() < Math.max(1, TIMING.minTimeoutSec) * 1000) {
      this.log(`turn ${out.turn.n} failed (${failure.kind}) but too little work time is left for a retry`);
      return null;
    }
    chain.retries += 1;
    this.log(`turn ${out.turn.n} failed (${failure.kind}); backing off`);
    this.phase = "backoff";
    this.idleUntil = null;
    this.publish({ state: "backoff", attempt: out.turn.n });
    this.waitingInChain = true;
    const stop = await sleepUnlessStopped(TIMING.backoffMs * out.turn.n, () => this.waitStopHook() ?? this.check());
    this.waitingInChain = false;
    if (stop) return { stop };
    // the wait may have used up what was left of the job's time
    if (context.recoveryDeadlineAt - Date.now() < Math.max(1, TIMING.minTimeoutSec) * 1000) {
      this.log("no work time is left after the backoff; the job ends with its failure");
      return null;
    }
    return { item: null, text: continuationPrompt("retry", chain.text), reason: "continuation", images: [], deadlineAt: context.recoveryDeadlineAt, restart: false, fresh: false, retry: true };
  }

  // A fresh Codex thread on a new app-server (the checkpoint fallback), registered as the session's.
  async freshThread() {
    const up = await this.ensureServer("account_change", { fresh: true });
    return up.fail ? { fail: up.fail } : { ok: true };
  }

  // ── the end ──

  // The envelope a session ends with: the last turn's, with the final state.
  finalEnvelope(finalState, classification, extra = {}) {
    const last = latestTurnEnvelope(this.paths);
    if (this.single) {
      const provenance = last?.provenance ?? buildProvenance(this.request, { backend: "session", threadId: this.threadId, usageTotal: this.usageTotal });
      return this.shapeJob(failureEnvelope(this.request, this.runId, finalState, classification ?? { kind: "execution", retryable: false, message: "the job ended without a result", status: null }, provenance));
    }
    const session = { turn: this.turn, ended: finalState, ...extra };
    if (classification) {
      const provenance = last?.provenance ?? buildProvenance(this.request, { threadId: this.threadId, usageTotal: this.usageTotal });
      return { ...failureEnvelope(this.request, this.runId, finalState, classification, provenance), session };
    }
    if (last) return { ...last, state: finalState, session: { ...(last.session ?? {}), ...session } };
    return {
      ...failureEnvelope(this.request, this.runId, finalState, { kind: "closed", retryable: false, message: "the session was closed before any turn completed", status: null }, buildProvenance(this.request, { threadId: this.threadId })),
      session,
    };
  }

  async finishClose() {
    const { message, archive } = this.closeRequest;
    let archived = null;
    let archiveError = null;
    if (archive && this.threadId) {
      try {
        if (this.server && !this.server.exited) await this.server.client.request("thread/archive", { threadId: this.threadId }, { timeoutMs: 20_000 });
        else await archiveThread(this.threadId, this.request, this.context);
        archived = true;
      } catch (error) {
        archived = false;
        archiveError = clip(error.message, 300);
      }
    }
    return this.endForGood("closed", { extra: archive ? { archived } : {}, closeMessage: message, archiveError });
  }

  // A steerable job's envelope is a one-shot run's: no `session` field, the backend it ran on, the turns it took
  // (`attempts`), the steering messages it accepted, and the slot-lost mark the supervisor keeps.
  shapeJob(envelope) {
    const out = { ...envelope };
    delete out.session;
    const provenance = { ...(out.provenance ?? {}), backend: "session" };
    if (this.turn) provenance.attempts = this.turn;
    if (this.steers) provenance.steers = this.steers;
    if (this.control.slotLost) provenance.slotLost = true;
    return { ...out, provenance };
  }

  async endForGood(finalState, { classification = null, extra = {}, closeMessage = null, archiveError = null, envelope = null } = {}) {
    this.ending = true;
    this.failQuestions("The session ended.");
    await this.stopServer();
    if (finalState === "closed") this.events.append("closed", {});
    else if (finalState === "cancelled") this.events.append("cancelled", {});
    else if (finalState === "abandoned") this.events.append("cancelled", { reason: "abandoned" });
    else if (classification && !["hermetic_violation", "interrupted"].includes(classification.kind)) {
      this.events.append("error", { kind: classification.kind, message: clip(classification.message, 500), willRetry: false }); // hermetic_violation has its own event
    }
    const final = envelope ? this.shapeJob(envelope) : this.finalEnvelope(finalState, classification, extra);
    writeJsonAtomic(this.paths.result, final);
    this.phase = finalState;
    this.idleUntil = null;
    updateState(this.paths, { state: finalState, finishedAt: nowIso(), turnActive: false, steerable: false, idleUntil: null, question: null, queued: 0, supervisorPid: null });
    await finalAckDelay();
    // nobody is left to run what is still in the inbox: say so rather than leave senders waiting
    for (const entry of sessionPendingMessages(this.paths)) {
      if (entry.id === closeMessage?.id) continue;
      this.finish(entry.message ?? { id: entry.id }, { outcome: "rejected", reason: "session_ended" });
    }
    if (closeMessage) this.finish(closeMessage, { outcome: "closed", turn: this.turn, ...(archiveError || "archived" in extra ? { archived: Boolean(extra.archived), ...(archiveError ? { archiveError } : {}) } : {}) });
    return { envelope: final };
  }
}

// Test hook (ULTRACODEX_TEST_FINAL_ACK_DELAY_MS): holds back the acknowledgements of the messages a
// session ends with — after result.json is written, as always — so that a test can make the race
// between a command polling for its ack and the end of the session happen every time.
async function finalAckDelay() {
  const ms = Number(process.env.ULTRACODEX_TEST_FINAL_ACK_DELAY_MS);
  if (Number.isFinite(ms) && ms > 0) await sleep(ms);
}

// A session whose supervisor died during a turn: that turn gets a failure envelope. Also used by
// the CLI when it ends a session that has no live supervisor.
function settleCrashedTurn({ request, runId, paths, state, events, context = null }) {
  const n = Number(state?.turn) || 0;
  if (!state?.turnActive || !n || fs.existsSync(turnFile(paths, n))) return false;
  const provenance = buildProvenance(request, {
    threadId: state.threadId ?? null,
    usageTotal: state.usageTotal ?? null,
    codexVersion: context?.codexVersion ?? null,
  });
  const envelope = {
    ...failureEnvelope(request, runId, "failed", { kind: "execution", retryable: false, message: "the supervisor of this session stopped while the turn was running; the turn did not finish", status: null }, provenance),
    session: { turn: n },
  };
  writeJsonAtomic(turnFile(paths, n), envelope);
  events.append("error", { kind: "execution", message: "the previous supervisor stopped while the turn was running", willRetry: false });
  events.append("turn_completed", { status: "failed", ok: false, durationMs: null, usage: null, kind: "execution" });
  tryUpdateState(paths, { turnActive: false, question: null });
  return true;
}

// A steerable job whose session backend could not start (or was switched off) runs on exec after all: it is not a
// session any more, so what the driver and the starting command recorded for one is taken back — the session
// fields of state.json, and the messages in its inbox, which are told why nobody will read them. The event feed
// stays as a record of what happened; `backendFallback` in state.json says why.
export function abandonSteerableState(paths, { reason = null, kind = null } = {}) {
  for (const entry of sessionPendingMessages(paths)) {
    moveInbox(paths, entry.id);
    writeAck(paths, entry.id, { outcome: "rejected", reason: "backend_fallback", message: "this job runs on codex exec now and cannot be steered" });
  }
  const unset = Object.fromEntries(
    ["session", "singleTurn", "turn", "turnActive", "steerable", "threadId", "threadIds", "idleUntil", "question", "queued", "usageTotal", "eventsCapped", "attempt", "attemptStartedAt", "deadlineAt"].map((key) => [key, undefined])
  );
  tryUpdateState(paths, { ...unset, state: "queued", backendFallback: { reason: clip(reason ?? "", 300) || null, kind } });
}

// ─── a short-lived app-server (archiving a thread of a dormant session) ─────

async function archiveThread(threadId, request, context = null) {
  const launcher = context?.launcher ?? resolveCodexLauncher();
  const args = buildAppServerArgs({ ...request, sandbox: "read-only" }, { mcpServers: request.hermetic ? configuredMcpServers() : [] });
  const child = spawn(launcher.command, [...launcher.argsPrefix, ...args], {
    env: { ...process.env, ...launcher.env },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  child.stdin.on("error", () => {});
  const client = new JsonRpcClient({ send: (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); return true; } catch { return false; } } });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => client.feed(chunk));
  child.stdout.on("error", () => {});
  exited.then(() => client.close());
  try {
    await client.request("initialize", { clientInfo: { name: "ultracodex", title: "ultracodex", version: RUNNER_VERSION }, capabilities: { experimentalApi: true } }, { timeoutMs: 20_000 });
    client.notify("initialized");
    await client.request("thread/archive", { threadId }, { timeoutMs: 20_000 });
  } finally {
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    const grace = Math.max(1, Math.min(TIMING.killGraceMs, 3000));
    await withTimeout(exited, grace);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

// ─── CLI: ending a session nobody supervises ────────────────────────────────

// Closes (or cancels) a session that has no live supervisor — dormant, or one whose supervisor
// died — without spawning anything but, for archive, one short-lived app-server. The session
// lock is taken so that no supervisor is revived meanwhile.
export async function endDormantSession(runId, finalState, { archive = false } = {}) {
  const paths = runPaths(runId);
  const lock = await claimSupervisorLock(paths, { waitMs: 0 });
  if (!lock) return { ok: false, reason: "supervisor_active" };
  try {
    if (readJsonSafe(paths.result)) return { ok: true, already: true };
    const stored = readJsonSafe(paths.request);
    const state = readJsonSafe(paths.state) ?? {};
    if (!stored) return { ok: false, reason: "unknown_run" };
    const request = { ...stored, task: readTextSafe(paths.task) ?? "", schema: stored.hasSchema ? readJsonSafe(paths.schema) : null };
    const events = new EventLog(paths.events, () => state.turn ?? 0);
    settleCrashedTurn({ request, runId, paths, state, events });
    let archived = null;
    let archiveError = null;
    if (archive && state.threadId) {
      try {
        await archiveThread(state.threadId, request);
        archived = true;
      } catch (error) {
        archived = false;
        archiveError = clip(error.message, 300);
      }
    }
    events.append(finalState === "closed" ? "closed" : "cancelled", {});
    const last = latestTurnEnvelope(paths);
    const session = { turn: state.turn ?? 0, ended: finalState, ...(archive ? { archived } : {}) };
    const cancelled = finalState === "cancelled" ? classifyFailure({ cancelled: true }) : null;
    let envelope = cancelled
      ? { ...failureEnvelope(request, runId, finalState, cancelled, last?.provenance ?? buildProvenance(request, { threadId: state.threadId ?? null })), session }
      : last
        ? { ...last, state: finalState, session: { ...(last.session ?? {}), ...session } }
        : { ...failureEnvelope(request, runId, finalState, { kind: "closed", retryable: false, message: "the session was closed before any turn completed", status: null }, buildProvenance(request, { threadId: state.threadId ?? null })), session };
    if (state.singleTurn) {
      // a steerable job whose supervisor is gone is cancelled like any run: an envelope of a one-shot run's shape
      delete envelope.session;
      envelope = { ...envelope, provenance: { ...(envelope.provenance ?? {}), backend: "session", ...(state.turn ? { attempts: state.turn } : {}) } };
    }
    writeJsonAtomic(paths.result, envelope);
    updateState(paths, { state: finalState, finishedAt: nowIso(), turnActive: false, steerable: false, idleUntil: null, question: null, queued: 0, supervisorPid: null });
    await finalAckDelay();
    for (const entry of sessionPendingMessages(paths)) {
      moveInbox(paths, entry.id);
      writeAck(paths, entry.id, { outcome: "rejected", reason: "session_ended" });
    }
    return { ok: true, archived, ...(archiveError ? { archiveError } : {}) };
  } finally {
    lock.release();
  }
}

// ─── CLI: wait / result views of a session ──────────────────────────────────

function printTurn(envelope, paths, turn, state, pretty) {
  const shown = { ...envelope, session: { ...(envelope.session ?? {}), turn, state: state.state, idleUntil: state.idleUntil ?? null } };
  const out = compactEnvelope(shown);
  if (out.paged) out.paged = { ...out.paged, file: turnFile(paths, turn) };
  print(out, pretty);
  return envelope.ok ? 0 : 1;
}

// `wait` for a session: returns an exit code when there is something to report, else null (the
// usual running / backoff line follows). Something is: a question waiting for an answer, or a
// session that is idle or dormant with nothing pending and the latest turn's envelope written.
export function sessionWaitPrint(runId, paths, state, pretty) {
  const question = state.question;
  if (isPlainObject(question) && question.id && sessionSupervisorAlive(paths)) {
    print(
      {
        ultracodex: 1,
        runnerVersion: RUNNER_VERSION,
        ok: null,
        state: "running",
        waitingForAnswer: true,
        question: { id: question.id, question: question.question },
        runId,
        label: state.label ?? null,
        session: true,
        turn: state.turn ?? 0,
        turnActive: Boolean(state.turnActive),
        queued: state.queued ?? 0,
        next: `answer ${runId} ${question.id} --text "..."`,
      },
      pretty
    );
    return 3;
  }
  if (!["idle", "dormant"].includes(state.state) || state.turnActive || (state.queued ?? 0) > 0 || sessionPendingMessages(paths).length) return null;
  const turn = Number(state.turn) || 0;
  const envelope = turn ? readJsonSafe(turnFile(paths, turn)) : null;
  return envelope ? printTurn(envelope, paths, turn, state, pretty) : null;
}

// `result` for a session: a given turn's envelope, or the latest; null = fall through (the
// ended session's result.json, or the run's status line).
export function sessionResult(runId, paths, turn, pretty) {
  const state = readJsonSafe(paths.state) ?? {};
  if (turn !== null) {
    const envelope = readJsonSafe(turnFile(paths, turn));
    if (!envelope) {
      print(rejection("unknown_turn", `no turn ${turn} for ${runId} (turns: ${turnNumbers(paths).join(", ") || "none yet"})`, { runId }), pretty);
      return 1;
    }
    return printTurn(envelope, paths, turn, state, pretty);
  }
  if (readJsonSafe(paths.result)) return null;
  const latest = turnNumbers(paths).at(-1);
  const envelope = latest === undefined ? null : readJsonSafe(turnFile(paths, latest));
  return envelope ? printTurn(envelope, paths, latest, state, pretty) : null;
}

// ─── CLI: send / interrupt / answer / events / close ────────────────────────

const ACK_OK = new Set(["steered", "started", "queued", "interrupted", "answered", "closed"]);

function ackLine(runId, ack) {
  return {
    ultracodex: 1,
    runnerVersion: RUNNER_VERSION,
    ok: ack.outcome === "pending" ? null : ACK_OK.has(ack.outcome),
    outcome: ack.outcome,
    ...(ack.reason ? { reason: ack.reason } : {}),
    runId,
    ...(ack.turn !== undefined ? { turn: ack.turn } : {}),
    ...(ack.archived !== undefined ? { archived: ack.archived } : {}),
    ...(ack.archiveError ? { archiveError: ack.archiveError } : {}),
    ...(ack.message ? { message: ack.message } : {}),
  };
}

function printAck(runId, ack, pretty) {
  print(ackLine(runId, ack), pretty);
  return ack.outcome === "pending" ? 3 : ACK_OK.has(ack.outcome) ? 0 : 1;
}

// The run a session command is about, or null after printing why not.
function sessionRun(runId, pretty, { needOpen = true } = {}) {
  if (!RUN_ID_RE.test(String(runId ?? ""))) throw new UsageError("this command needs a run id");
  const paths = runPaths(runId);
  if (!isDirSync(paths.dir)) {
    print(rejection("unknown_run", `no such run: ${runId}`, { runId, state: "unknown" }), pretty);
    return null;
  }
  const state = readJsonSafe(paths.state) ?? {};
  if (!state.session) {
    printAck(runId, { outcome: "rejected", reason: "not_a_session", message: "this run was not started with \"session\": true (nor as a steerable job: \"steerable\": true)" }, pretty);
    return null;
  }
  writeText(paths.heartbeat, String(Date.now())); // any of these commands is a poll
  const result = readJsonSafe(paths.result);
  if (needOpen && result) {
    printAck(runId, { outcome: "rejected", reason: "session_ended", message: `the ${state.singleTurn ? "job" : "session"} ended (${result.state})` }, pretty);
    return null;
  }
  return { paths, state, result };
}

// A message is put in the inbox and acknowledged by the supervisor (an `outbox/<id>.json`). A
// dormant session, or one whose supervisor died (a reboot), gets a new supervisor: it resumes the
// thread and then reads the inbox like any other.
async function deliver(runId, run, fields, { waitMs = TIMING.ackWaitMs, revive = true, pretty }) {
  const { paths } = run;
  if (revive && !sessionSupervisorAlive(paths) && !(readJsonSafe(paths.state) ?? {}).threadId) {
    return printAck(runId, { outcome: "rejected", reason: "no_thread", message: "the session never got a thread, so there is nothing to revive" }, pretty);
  }
  const message = writeInboxMessage(paths, fields);
  const ackFile = path.join(paths.outbox, `${message.id}.json`);
  const reviveIfNeeded = () => {
    if (!revive || sessionSupervisorAlive(paths) || readJsonSafe(paths.result)) return;
    const state = readJsonSafe(paths.state) ?? {};
    if (state.threadId) launchSupervisor(runId);
  };
  reviveIfNeeded();
  const until = Date.now() + waitMs;
  let lastCheck = Date.now();
  let endedAt = null;
  for (;;) {
    const ack = readJsonSafe(ackFile);
    if (ack) return printAck(runId, ack, pretty);
    const ended = readJsonSafe(paths.result);
    if (ended) {
      // The supervisor writes result.json first and the acknowledgements after it (a "closed" ack
      // therefore implies the result exists), so a result without our ack is not yet an answer:
      // wait a short grace for the ack of this very message.
      endedAt ??= Date.now();
      if (Date.now() - endedAt >= TIMING.ackGraceMs) {
        const late = readJsonSafe(ackFile);
        if (late) return printAck(runId, late, pretty);
        // no ack even so: the end speaks for itself. A close that found the session closed is a close.
        if (fields.kind === "close" && (ended.state === "closed" || (ended.state === "cancelled" && (readJsonSafe(paths.state) ?? {}).singleTurn))) {
          const info = ended.session ?? {};
          return printAck(runId, { outcome: "closed", turn: info.turn ?? (readJsonSafe(paths.state) ?? {}).turn ?? 0, ...(info.archived !== undefined ? { archived: Boolean(info.archived) } : {}) }, pretty);
        }
        return printAck(runId, { outcome: "rejected", reason: "session_ended", message: `the session ended (${ended.state})` }, pretty);
      }
    } else if (Date.now() >= until) {
      return printAck(runId, { outcome: "pending", message: "not acknowledged yet; the supervisor will handle it" }, pretty);
    }
    if (Date.now() - lastCheck >= 1000) {
      lastCheck = Date.now();
      writeText(paths.heartbeat, String(Date.now()));
      reviveIfNeeded(); // the supervisor wound down after the message arrived
    }
    await sleep(Math.min(TIMING.pollMs, 100));
  }
}

function messageText(options, what) {
  if (options.message !== null && options.messageFile !== null) throw new UsageError("give either --message or --message-file, not both");
  let text = null;
  if (options.message !== null) text = options.message;
  else if (options.messageFile !== null) text = readBoundedFile(options.messageFile, MAX_TASK_BYTES, "message file");
  if (text === null || !text.trim()) throw new UsageError(`${what} needs (--message TEXT | --message-file FILE)`);
  return text;
}

export async function cmdSend(runId, options) {
  const text = messageText(options, "send");
  const mode = options.mode ?? "auto";
  if (!["auto", "steer", "queue"].includes(mode)) throw new UsageError("--mode must be one of: auto, steer, queue");
  const run = sessionRun(runId, options.pretty);
  if (!run) return 1;
  if (run.state.singleTurn) {
    // a steerable job ends with its turn: it can be steered while it runs, never given a follow-up — and it is
    // never revived: without a supervisor there is nobody to steer
    if (mode === "queue") return printAck(runId, { outcome: "rejected", reason: "single_turn", message: "this job ends with its turn: only --mode steer (or auto) can reach it, while it runs" }, options.pretty);
    if (!sessionSupervisorAlive(run.paths)) return printAck(runId, { outcome: "rejected", reason: "no_active_turn", message: "the job's supervisor is not running" }, options.pretty);
    return deliver(runId, run, { kind: "send", text, mode }, { revive: false, pretty: options.pretty });
  }
  return deliver(runId, run, { kind: "send", text, mode }, { pretty: options.pretty });
}

export async function cmdInterrupt(runId, options) {
  const run = sessionRun(runId, options.pretty);
  if (!run) return 1;
  // nothing runs without a supervisor: there is no turn to interrupt, and nothing is revived for it
  if (!sessionSupervisorAlive(run.paths)) return printAck(runId, { outcome: "no_active_turn", reason: "supervisor_not_running" }, options.pretty);
  return deliver(runId, run, { kind: "interrupt" }, { revive: false, pretty: options.pretty });
}

export async function cmdAnswer(runId, questionId, options) {
  if (!questionId) throw new UsageError("answer needs RUN_ID QUESTION_ID (--text TEXT | --file FILE)");
  if (options.text !== null && options.file !== null) throw new UsageError("give either --text or --file, not both");
  const text = options.text !== null ? options.text : options.file !== null ? readBoundedFile(options.file, MAX_TASK_BYTES, "answer file") : null;
  if (text === null) throw new UsageError("answer needs (--text TEXT | --file FILE)");
  const run = sessionRun(runId, options.pretty);
  if (!run) return 1;
  if (run.state.singleTurn) return printAck(runId, { outcome: "rejected", reason: "single_turn", message: "a steerable job asks no questions: nothing waits for an answer" }, options.pretty);
  if (!sessionSupervisorAlive(run.paths)) return printAck(runId, { outcome: "no_such_question", reason: "supervisor_not_running" }, options.pretty);
  return deliver(runId, run, { kind: "answer", questionId: String(questionId), text }, { revive: false, pretty: options.pretty });
}

export async function cmdClose(runId, options) {
  const run = sessionRun(runId, options.pretty, { needOpen: false });
  if (!run) return 1;
  const { paths } = run;
  if (run.state.singleTurn) {
    // a steerable job has no session to close: close is cancel (force and archive mean nothing here)
    if (run.result) return printAck(runId, { outcome: "rejected", reason: "session_ended", message: `the job ended (${run.result.state})` }, options.pretty);
    if (!sessionSupervisorAlive(paths)) {
      const ended = await endDormantSession(runId, "cancelled");
      if (ended.ok) return printAck(runId, { outcome: "closed", turn: (readJsonSafe(paths.state) ?? {}).turn ?? 0 }, options.pretty);
    }
    return deliver(runId, run, { kind: "close", force: true, archive: false }, { waitMs: TIMING.closeWaitMs, revive: false, pretty: options.pretty });
  }
  if (run.result) {
    const closed = run.result.state === "closed";
    return printAck(runId, closed ? { outcome: "closed", turn: run.result.session?.turn ?? run.state.turn ?? 0, message: "already closed" } : { outcome: "rejected", reason: "session_ended", message: `the session ended (${run.result.state})` }, options.pretty);
  }
  if (!sessionSupervisorAlive(paths)) {
    const ended = await endDormantSession(runId, "closed", { archive: options.archive });
    if (ended.ok) {
      const state = readJsonSafe(paths.state) ?? {};
      return printAck(runId, { outcome: "closed", turn: state.turn ?? 0, ...(options.archive ? { archived: Boolean(ended.archived), ...(ended.archiveError ? { archiveError: ended.archiveError } : {}) } : {}) }, options.pretty);
    }
    // a supervisor appeared meanwhile: it closes the session through its inbox
  }
  return deliver(runId, run, { kind: "close", force: options.force, archive: options.archive }, { waitMs: TIMING.closeWaitMs, revive: false, pretty: options.pretty });
}

export async function cmdEvents(runId, options) {
  const run = sessionRun(runId, options.pretty, { needOpen: false });
  if (!run) return 1;
  const { paths } = run;
  const since = options.since ?? 0;
  let lastSeq = since;
  let offset = 0;
  // everything complete in the file, whatever its size (one read takes at most a few megabytes)
  const flush = () => {
    for (;;) {
      const batch = readNewEvents(paths.events, offset);
      const progressed = batch.offset > offset;
      offset = batch.offset;
      for (const { event, line } of batch.events) {
        if (!Number.isInteger(event.seq) || event.seq <= since) continue;
        process.stdout.write(`${line}\n`);
        lastSeq = Math.max(lastSeq, event.seq);
      }
      if (!progressed) return;
    }
  };
  if (!options.follow) {
    flush();
    return 0;
  }
  const until = Date.now() + (options.maxWait ?? 570) * 1000;
  let lostSupervisor = false;
  for (;;) {
    writeText(paths.heartbeat, String(Date.now())); // following is polling
    // State first, events second: the supervisor appends an event before it publishes the state
    // that event announces, so everything up to that state is printed before the stream ends.
    const state = readJsonSafe(paths.state) ?? {};
    const result = readJsonSafe(paths.result);
    flush();
    let reason = null;
    if (result) reason = "ended";
    else if (isPlainObject(state.question) && state.question.id && sessionSupervisorAlive(paths)) reason = "question";
    else if (state.state === "idle") reason = "idle";
    else if (state.state === "dormant") reason = "dormant";
    else if (Date.now() - Math.max(readNumber(paths.alive), Date.parse(state.createdAt ?? 0) || 0) > TIMING.lostAfterMs && !sessionSupervisorAlive(paths)) {
      reason = "dormant"; // the supervisor vanished mid-turn: nothing runs; the next message revives the session
      lostSupervisor = true;
    } else if (Date.now() >= until) reason = "max_wait";
    if (reason) {
      const shown = result ? result.state : lostSupervisor ? "lost" : publicRunState(state.state);
      process.stdout.write(`${JSON.stringify({ type: "follow_end", reason, lastSeq, state: shown })}\n`);
      return ["question", "max_wait"].includes(reason) ? 3 : 0;
    }
    await sleep(Math.min(TIMING.pollMs, 250));
  }
}

