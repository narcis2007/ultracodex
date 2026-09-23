// Offline tests for the generated plugin workflows and the embedded helper. A stub
// relay reassembles the helper's parts exactly as the runner's `part` command does
// and parses them with the runner's own parser, so helper↔runner framing drift
// (encoding, wrapping, hashes) fails here.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildOutputs } from "../tools/build.mjs";
import { fnv1a, framedToRaw, normalizeText, parseFramed, validateRequest } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { ROOT } from "./helpers.mjs";

const WORKFLOW_DIR = path.join(ROOT, "plugins", "ultracodex", "workflows");
const RELAY = "ultracodex:codex-relay";
const CATALOG = {
  models: [
    { slug: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { slug: "gpt-6-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { slug: "gpt-6-luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ],
};

function workflowSource(name) {
  return fs.readFileSync(path.join(WORKFLOW_DIR, `${name}.js`), "utf8");
}

const AsyncFunction = (async () => {}).constructor;

// Runs a generated workflow with stubbed runtime globals. `agent` is the stub.
async function runWorkflow(name, { agent, args }) {
  const body = workflowSource(name).replace(/^export const meta =/m, "const meta =");
  const logs = [];
  const phases = [];
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, index) => {
        let value = item;
        try {
          for (const stage of stages) value = await stage(value, item, index);
        } catch {
          return null;
        }
        return value;
      })
    );
  const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", "budget", "workflow", body);
  const result = await fn(agent, parallel, pipeline, (title) => phases.push(title), (message) => logs.push(message), args, { total: null }, null);
  return { result, logs, phases };
}

// Parses a START prompt the way the relay + runner pipeline would.
function receive(prompt) {
  const lines = prompt.split("\n");
  const delimiter = lines.find((line) => line.startsWith("DELIMITER: ")).slice("DELIMITER: ".length);
  const total = Number(lines.find((line) => line.startsWith("PARTS: ")).slice("PARTS: ".length));
  const parts = [];
  const hashes = [];
  let current = null;
  for (const line of lines) {
    const open = new RegExp(`^=====${delimiter} PART (\\d+)/(\\d+) ([0-9a-f]{8})=====$`).exec(line);
    if (open) {
      current = [];
      hashes.push(open[3]);
      continue;
    }
    if (line === `=====${delimiter} END=====`) {
      parts.push(current);
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  assert.equal(parts.length, total, "every announced part is present");
  parts.forEach((part, index) => assert.equal(fnv1a(part.join("\n")), hashes[index], `part ${index + 1} hash`));
  for (const part of parts) {
    const text = part.join("\n");
    assert.ok(text.length <= 1600 + 420, "a part fits comfortably in one Bash call");
    for (const char of text) {
      const code = char.codePointAt(0);
      assert.ok(code !== 0x27 && code !== 0x5c && (code >= 0x20 || code === 0x0a), `no quote/backslash/control char in parts (got U+${code.toString(16)})`);
    }
  }
  const framed = parts.map((part) => part.join("\n")).join("\n");
  const raw = framedToRaw(parseFramed(framed, { encoded: true }));
  return { request: validateRequest(raw, { catalog: CATALOG }), parts: parts.length, delimiter };
}

function okEnvelope(request, result, extra = {}) {
  const body = result === undefined ? { text: "plain text" } : { result };
  return JSON.stringify({
    ultracodex: 1,
    ok: true,
    state: "done",
    runId: "20260923T000000Z-abcdef",
    ...body,
    resultHash: fnv1a(result === undefined ? "plain text" : JSON.stringify(result)),
    provenance: { threadId: "01a0-thread", model: request.model, effort: request.effort, tier: request.tier, taskHash: request.taskHash, usage: { output_tokens: 7 } },
    ...extra,
  });
}

function exampleFor(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object") || schema.properties) {
    const value = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) value[key] = exampleFor(child);
    return value;
  }
  if (types.includes("null")) return null;
  if (types.includes("array")) return [];
  if (types.includes("boolean")) return false;
  if (types.includes("integer") || types.includes("number")) return 5;
  return "x";
}

test("generated workflows and the helper doc are in sync with tools/src", () => {
  for (const [file, content] of buildOutputs()) {
    assert.equal(fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n"), content, `${path.relative(ROOT, file)} is stale — run npm run build`);
  }
});

test("each workflow has a pure-literal meta first, matching phases, and no forbidden APIs", () => {
  for (const file of fs.readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    assert.match(source, /^export const meta = \{/, `${file}: meta must be the first statement`);
    const metaText = source.slice(source.indexOf("{"), source.indexOf("\n}\n") + 2);
    const stripped = metaText.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "S");
    assert.doesNotMatch(stripped, /[`(]|\.\.\.|\$\{/, `${file}: meta must be a pure literal`);
    const meta = new Function(`return (${metaText})`)();
    assert.ok(meta.name && meta.description);
    const called = new Set([...source.matchAll(/(?<![\w.])phase\(\s*'([^']+)'/g)].map((match) => match[1]));
    const declared = new Set((meta.phases ?? []).map((entry) => entry.title));
    for (const title of called) assert.ok(declared.has(title), `${file}: phase('${title}') missing from meta.phases`);
    assert.doesNotMatch(source, /Date\.now\(|Math\.random\(|new Date\(\)|\bimport\(/, `${file}: forbidden in workflow scripts`);
    for (const char of source) {
      const code = char.codePointAt(0);
      assert.ok(![0x00a0, 0x200b, 0x200c, 0x200d, 0x2028, 0x2029, 0xfeff].includes(code), `${file}: invisible character U+${code.toString(16)}`);
    }
  }
});

// A tiny script that just calls codexNode, built from the same helper.
function helperScript(bodyLines) {
  const helper = fs.readFileSync(path.join(ROOT, "tools", "src", "helper.js"), "utf8");
  return helper + "\n" + bodyLines.join("\n");
}

async function runHelper(bodyLines, agent) {
  const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", helperScript(bodyLines));
  return fn(agent, (thunks) => Promise.all(thunks.map((t) => t())), null, () => {}, () => {}, undefined);
}

test("codexNode frames hostile text byte-exactly through parts the runner accepts", async () => {
  const bs = String.fromCharCode(0x5c);
  const tricky = [
    "Windows path C:" + bs + "Users" + bs + "x and a literal %5C and 100%",
    "quotes ' \" ` and $(echo pwned) ${HOME}",
    "tab\there, nbsp" + String.fromCharCode(0xa0) + "inside, line-sep" + String.fromCharCode(0x2028) + "inside",
    "emoji " + String.fromCodePoint(0x1f600) + " and ăîșțâ",
    "x".repeat(3000),
    "UCX_P ---ULTRACODEX-TASK--- =====UCX_P END=====",
    ...Array.from({ length: 60 }, (_, i) => `filler line ${i} with some words to make the task long enough`),
  ].join("\n");
  let seen = null;
  const agent = async (prompt, opts) => {
    assert.equal(opts.agentType, RELAY);
    const received = receive(prompt);
    seen = received;
    return okEnvelope(received.request, { refuted: false, confidence: 0.9, reasoning: "ok" });
  };
  const result = await runHelper(
    [`return codexNode(${JSON.stringify(tricky)}, { schemaPreset: 'verdict', tier: 'light', label: 'hostile' })`],
    agent
  );
  assert.equal(result.refuted, false);
  assert.equal(result._codex.threadId, "01a0-thread");
  assert.equal(Object.keys(result).includes("_codex"), false, "provenance is non-enumerable");
  assert.ok(seen.parts > 2, "a long task travels in several parts");
  assert.equal(seen.request.task, normalizeText(tricky));
  assert.equal(seen.request.model, "gpt-6-luna");
  assert.equal(seen.request.effort, "max");
  assert.ok(seen.request.task.includes("C:" + bs + "Users" + bs + "x"), "backslashes survive");
  assert.ok(seen.request.task.includes(String.fromCharCode(0x2028)), "invisible characters survive");
});

test("a corrupted upload is retried once by an opus relay", async () => {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push(opts);
    const { request } = receive(prompt);
    if (calls.length === 1) {
      return JSON.stringify({ ultracodex: 1, ok: false, state: "rejected", error: { kind: "relay_corruption", retryable: true, message: "hash mismatch" } });
    }
    return okEnvelope(request, { refuted: true, confidence: 0.2, reasoning: "no" });
  };
  const result = await runHelper(["return codexNode('check this', { schemaPreset: 'verdict' })"], agent);
  assert.equal(result.refuted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, "opus");
});

test("a relay that stops early is followed by a collector; missing provenance is rejected", async () => {
  const prompts = [];
  let original = null;
  const agent = async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("ULTRACODEX COLLECT")) {
      assert.match(prompt, /RUN_ID: 20260923T000000Z-abcdef/);
      return okEnvelope(original, { refuted: false, confidence: 1, reasoning: "r" });
    }
    original = receive(prompt).request;
    return JSON.stringify({ ultracodex: 1, ok: null, state: "running", runId: "20260923T000000Z-abcdef" });
  };
  const collected = await runHelper(["return codexNode('slow one', { schemaPreset: 'verdict' })"], agent);
  assert.equal(collected.refuted, false);
  assert.equal(prompts.length, 2);

  const noProvenance = async () =>
    JSON.stringify({ ultracodex: 1, ok: true, state: "done", runId: "r", result: { refuted: false }, resultHash: fnv1a(JSON.stringify({ refuted: false })), provenance: {} });
  const forged = await runHelper(["return codexNode('x', { schemaPreset: 'verdict' })"], noProvenance);
  assert.equal(forged._codex_error, true);
  assert.equal(forged.kind, "no_provenance");

  const prose = await runHelper(["return codexNode('x', { schemaPreset: 'verdict' })"], async () => "I think the claim is true.");
  assert.equal(prose.kind, "relay_no_envelope");
});

test("a result garbled on the way back is fetched again; a persistent mismatch is an error", async () => {
  const good = { refuted: false, confidence: 0.9, reasoning: "real defect at a.ts:3" };
  const prompts = [];
  let original = null;
  const garbleOnce = async (prompt) => {
    prompts.push(prompt);
    if (!prompt.startsWith("ULTRACODEX COLLECT")) original = receive(prompt).request;
    const line = okEnvelope(original, good);
    // the first transcription drops a word: the hash no longer matches
    return prompts.length === 1 ? line.replace("real defect", "real") : line;
  };
  const fetched = await runHelper(["return codexNode('check', { schemaPreset: 'verdict' })"], garbleOnce);
  assert.equal(fetched.reasoning, good.reasoning);
  assert.match(prompts[1], /^ULTRACODEX COLLECT\nRUN_ID: /);

  const alwaysGarbled = async (prompt) => {
    if (!prompt.startsWith("ULTRACODEX COLLECT")) original = receive(prompt).request;
    return okEnvelope(original, good).replace("real defect", "real");
  };
  const failed = await runHelper(["return codexNode('check', { schemaPreset: 'verdict' })"], alwaysGarbled);
  assert.equal(failed._codex_error, true);
  assert.equal(failed.kind, "relay_corruption");

  const missingHash = async (prompt) => JSON.stringify({ ...JSON.parse(okEnvelope(receive(prompt).request, good)), resultHash: undefined });
  const unverifiable = await runHelper(["return codexNode('check', { schemaPreset: 'verdict' })"], async (prompt) =>
    prompt.startsWith("ULTRACODEX COLLECT") ? JSON.stringify({ ultracodex: 1, ok: true, state: "done", runId: "r", result: good, provenance: { threadId: "t", usage: { output_tokens: 1 } } }) : missingHash(prompt));
  assert.equal(unverifiable.kind, "relay_corruption", "a result without resultHash is not trusted");

  // a well-formed result for a different request (e.g. the relay collected the wrong run)
  const foreign = async (prompt) => okEnvelope({ ...receive(prompt).request, taskHash: "deadbeef" }, good);
  const mismatched = await runHelper(["return codexNode('check', { schemaPreset: 'verdict' })"], foreign);
  assert.equal(mismatched.kind, "relay_mismatch");
});

test("a rejected relay call is a failed node, never a vanished one", async () => {
  const rejecting = async () => {
    throw new Error("budget exhausted");
  };
  const failed = await runHelper(["return codexNode('check', { schemaPreset: 'verdict' })"], rejecting);
  assert.equal(failed._codex_error, true);
  assert.equal(failed.kind, "relay_failed");
  assert.match(failed.message, /budget exhausted/);
});

test("uploads ask the runner for a fresh upload id (no shared inboxes across workflows)", async () => {
  let prompt = "";
  await runHelper(["return codexNode('check', { schemaPreset: 'verdict' })"], async (p) => {
    prompt = p;
    return okEnvelope(receive(p).request, { refuted: true, confidence: 0.1, reasoning: "no" });
  });
  assert.match(prompt, /part new 1 /);
  assert.doesNotMatch(prompt, /INBOX: /);
});

test("the helper gate keeps at most 4 Codex jobs in flight, astra counting double", async () => {
  let active = 0;
  let peak = 0;
  const agent = async (prompt) => {
    const { request } = receive(prompt);
    active += request.model === "gpt-6-astra" ? 2 : 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= request.model === "gpt-6-astra" ? 2 : 1;
    return okEnvelope(request, { refuted: false, confidence: 1, reasoning: "r" });
  };
  await runHelper(["return Promise.all(Array.from({ length: 10 }, (_, i) => codexNode('job ' + i, { schemaPreset: 'verdict' })))"], agent);
  assert.equal(peak, 4);
  peak = 0;
  await runHelper(["return Promise.all(Array.from({ length: 6 }, (_, i) => codexNode('job ' + i, { schemaPreset: 'verdict', tier: 'final' })))"], agent);
  assert.equal(peak, 4, "two astra jobs at a time");
});

test("cross-review partitions fail-closed and keeps unverified findings visible", async () => {
  const finding = (id) => ({ id, title: "t" + id, file: "a.ts", line: 3, detail: "d", failure_scenario: "s", severity: "high" });
  const agent = async (prompt, opts) => {
    if (opts.agentType === RELAY) {
      const { request } = receive(prompt);
      if (request.label === "codex:security") {
        return JSON.stringify({ ultracodex: 1, ok: false, state: "failed", runId: "r2", error: { kind: "rate_limit", retryable: true, message: "429" } });
      }
      assert.equal(request.model, "gpt-6-sol");
      assert.equal(request.effort, "xhigh");
      return okEnvelope(request, {
        results: [
          { id: "correctness:1", refuted: false, confidence: 0.9, reasoning: "real" },
          { id: "correctness:2", refuted: true, confidence: 0.8, reasoning: "not reachable" },
        ],
      });
    }
    if (opts.label === "find:correctness") return { findings: [finding("1"), finding("2")] };
    if (opts.label === "find:security") return { findings: [finding("9")] };
    if (opts.label === "synthesize") return "REPORT";
    return { findings: [] };
  };
  const { result, logs } = await runWorkflow("cross-review", { agent, args: { dimensions: ["correctness", "security"] } });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.confirmed.map((f) => f.id), ["correctness:1"]);
  assert.deepEqual(result.refuted.map((f) => f.id), ["correctness:2"]);
  assert.deepEqual(result.unverified.map((f) => [f.id, f.error]), [["security:9", "rate_limit"]]);
  assert.ok(logs.some((line) => line.includes("UNVERIFIED")));
});

test("cross-review: an ambiguous batch answer is unverified and a dead finder makes the run incomplete", async () => {
  const finding = (id) => ({ id, title: "t" + id, file: "a.ts", line: 3, detail: "d", failure_scenario: "s", severity: "high" });
  const agent = async (prompt, opts) => {
    if (opts.agentType === RELAY) {
      const { request } = receive(prompt);
      return okEnvelope(request, {
        results: [
          { id: "correctness:1", refuted: false, confidence: 0.9, reasoning: "real" },
          { id: "correctness:1", refuted: true, confidence: 0.9, reasoning: "not real" },
          { id: "correctness:2", refuted: false, confidence: 0.8, reasoning: "real too" },
        ],
      });
    }
    if (opts.label === "find:correctness") return { findings: [finding("1"), finding("2")] };
    if (opts.label === "find:security") throw new Error("finder crashed");
    if (opts.label === "synthesize") return "REPORT";
    return { findings: [] };
  };
  const { result } = await runWorkflow("cross-review", { agent, args: { dimensions: ["correctness", "security"] } });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.confirmed.map((f) => f.id), ["correctness:2"]);
  assert.deepEqual(result.unverified, [{ id: "correctness:1", title: "t1", error: "ambiguous_verdict" }]);
  assert.deepEqual(result.failedDimensions.map((x) => x.dimension), ["security"]);
});

test("codex-review keeps a finding whose triage failed, as needs-info, and reports incomplete", async () => {
  const agent = async (prompt, opts) => {
    if (opts.agentType === RELAY) {
      const { request } = receive(prompt);
      const f = (id) => ({ id, severity: "high", category: "c", title: "t" + id, file: "x.rs", line: 1, evidence: "e", failure_scenario: "s", recommendation: "r", confidence: 0.7 });
      return okEnvelope(request, { verdict: "request_changes", summary: "sum", findings: [f("a")] });
    }
    if (opts.label?.startsWith("triage:")) throw new Error("triage agent died");
    if (opts.label === "report") return "FINAL";
    return null;
  };
  const { result } = await runWorkflow("codex-review", { agent, args: { lenses: ["code"] } });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.needsInfo.map((f) => f.id), ["code:a"]);
  assert.match(result.needsInfo[0].triage.reasoning, /triage failed/);
});

test("judge-panel reports a failed Codex generation instead of hiding it", async () => {
  const agent = async (prompt, opts) => {
    if (opts.agentType === RELAY) {
      const { request } = receive(prompt);
      if (request.label === "gen:codex") return JSON.stringify({ ultracodex: 1, ok: false, state: "failed", error: { kind: "usage_limit", message: "limit" } });
      return okEnvelope(request, { score: 7, rationale: "ok" });
    }
    if (opts.label?.startsWith("gen:")) return { approach: opts.label, plan: "p", risks: "r" };
    if (opts.label?.startsWith("judge:claude:")) return { score: 6, rationale: "ok" };
    if (opts.label === "synthesize") return "FINAL PLAN";
    return null;
  };
  const { result } = await runWorkflow("judge-panel", { agent, args: { problem: "How to X?" } });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.failedGenerations.map((f) => f.author), ["codex"]);
  assert.match(result.failedGenerations[0].why, /usage_limit/);
});

test("codex-review marks a failed lens as incomplete and routes findings through triage", async () => {
  const agent = async (prompt, opts) => {
    if (opts.agentType === RELAY) {
      const { request } = receive(prompt);
      assert.equal(request.kind, "review");
      assert.equal(request.model, "gpt-6-astra", "tier final → astra");
      assert.equal(request.effort, "max");
      if (request.label === "codex:domain") {
        return JSON.stringify({ ultracodex: 1, ok: false, state: "timeout", runId: "r", error: { kind: "timeout", retryable: false, message: "deadline" } });
      }
      const f = (id) => ({ id, severity: "high", category: "c", title: "t" + id, file: "x.rs", line: 1, evidence: "e", failure_scenario: "s", recommendation: "r", confidence: 0.7 });
      return okEnvelope(request, { verdict: "request_changes", summary: "sum", findings: [f("a"), f("b")] });
    }
    if (opts.label === "triage:code:a") return { verdict: "confirmed", reasoning: "seen it" };
    if (opts.label === "triage:code:b") return { verdict: "refuted", reasoning: "guarded" };
    if (opts.label === "report") return "FINAL";
    return null;
  };
  const { result } = await runWorkflow("codex-review", { agent, args: { tier: "final", base: "main" } });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.lenses, [
    { lens: "code", verdict: "request_changes", error: null },
    { lens: "domain", verdict: null, error: "timeout" },
  ]);
  assert.deepEqual(result.confirmed.map((f) => f.id), ["code:a"]);
  assert.deepEqual(result.refuted.map((f) => f.id), ["code:b"]);
});

test("crosscheck needs a claim and never reports an errored check as trustworthy", async () => {
  await assert.rejects(runWorkflow("crosscheck", { agent: async () => null, args: {} }), /args.claim/);
  const failing = async () => JSON.stringify({ ultracodex: 1, ok: false, state: "failed", error: { kind: "auth", message: "login" } });
  const failed = await runWorkflow("crosscheck", { agent: failing, args: { claim: "X holds" } });
  assert.equal(failed.result.status, "incomplete");
  assert.equal(failed.result.trustworthy, false);
  const passing = async (prompt) => {
    const { request } = receive(prompt);
    assert.equal(request.model, "gpt-6-astra");
    return okEnvelope(request, { refuted: false, confidence: 0.95, reasoning: "checked" });
  };
  const passed = await runWorkflow("crosscheck", { agent: passing, args: { claim: "X holds" } });
  assert.equal(passed.result.trustworthy, true);
  assert.equal(passed.result.verdict.codex.threadId, "01a0-thread");
});

test("judge-panel ranks only candidates judged by the other model family", async () => {
  const agent = async (prompt, opts) => {
    if (opts.agentType === RELAY) {
      const { request } = receive(prompt);
      if (request.label === "gen:codex") return okEnvelope(request, { approach: "codex way", plan: "p", risks: "r" });
      // the Codex juror is down for every candidate
      return JSON.stringify({ ultracodex: 1, ok: false, state: "failed", error: { kind: "server", message: "503" } });
    }
    if (opts.label?.startsWith("gen:")) return { approach: opts.label, plan: "p", risks: "r" };
    if (opts.label?.startsWith("judge:claude:")) return { score: opts.label.includes("codex") ? 8 : 6, rationale: "ok" };
    if (opts.label === "synthesize") return "FINAL PLAN";
    return null;
  };
  const { result } = await runWorkflow("judge-panel", { agent, args: { problem: "How to X?" } });
  assert.equal(result.status, "partial");
  assert.equal(result.winner, "codex", "only the Codex candidate got a cross-family (Claude) verdict");
  assert.deepEqual(result.ranking.map((entry) => entry.author), ["codex"]);
});
