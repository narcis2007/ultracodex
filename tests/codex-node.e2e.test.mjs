// End-to-end runner tests: real `start`/`wait`/`cancel` processes, a detached
// supervisor, and the fake Codex CLI. No model quota is spent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FRAME_MAGIC,
  FRAME_SCHEMA_MARK,
  FRAME_TASK_MARK,
  SCHEMA_PRESETS,
  encodeFrameText,
  fnv1a,
  normalizeText,
  schemaHash,
} from "../plugins/ultracodex/scripts/codex-node.mjs";
import { eventually, fastEnv, makeHome, pidAlive, runCli, startAndWait, writeRequest } from "./helpers.mjs";

test("a structured run returns the parsed result with provenance", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const { started, final } = await startAndWait(env, { task: "verify something", schemaPreset: "verdict", tier: "light", kind: "verify", label: "t1", meta: { id: "f1" } }, { home });
  assert.equal(started.code, 3);
  assert.equal(started.json.model, "gpt-6-luna");
  assert.equal(started.json.effort, "max");
  assert.equal(final.ok, true);
  assert.equal(final.state, "done");
  assert.deepEqual(Object.keys(final.result).sort(), ["confidence", "reasoning", "refuted"]);
  assert.match(final.provenance.threadId, /^01a0fake-/);
  assert.equal(final.provenance.usage.output_tokens, 12);
  assert.equal(final.provenance.hermetic, true);
  assert.equal(final.provenance.attempts, 1);
  assert.deepEqual(final.meta, { id: "f1" });
  assert.equal(final.label, "t1");
});

test("a run without a schema returns text", async (t) => {
  const home = makeHome(t);
  const { final } = await startAndWait(fastEnv(home), { task: "say something\nFAKE_OUTPUT=plain words" }, { home });
  assert.equal(final.ok, true);
  assert.equal(final.text, "plain words");
  assert.equal(final.result, undefined);
  assert.equal(final.resultHash, fnv1a("plain words"), "text results carry a hash for the return trip too");
});

test("the prompt Codex receives is the normalized task, via stdin", async (t) => {
  const home = makeHome(t);
  const promptLog = path.join(home, "prompt.txt");
  const { final } = await startAndWait(fastEnv(home, { FAKE_CODEX_PROMPT_LOG: promptLog }), { task: "line\t1  \r\nline 2\r\n\r\n" }, { home });
  assert.equal(final.ok, true);
  assert.equal(fs.readFileSync(promptLog, "utf8"), "line    1\nline 2\n");
});

test("a transient 429 is retried with backoff and then succeeds", async (t) => {
  const home = makeHome(t);
  const counter = path.join(home, "counter");
  const argvLog = path.join(home, "argv.jsonl");
  const { final } = await startAndWait(
    fastEnv(home, { FAKE_CODEX_STATE: counter, FAKE_CODEX_ARGV_LOG: argvLog }),
    { task: "flaky\nFAKE_FAIL_FIRST=1", schemaPreset: "verdict" },
    { home }
  );
  assert.equal(final.ok, true);
  assert.equal(final.provenance.attempts, 2);
  assert.equal(fs.readFileSync(argvLog, "utf8").trim().split("\n").length, 2);
});

test("a strict-schema 400 from the API is final: no retry", async (t) => {
  const home = makeHome(t);
  const argvLog = path.join(home, "argv.jsonl");
  const directive = JSON.stringify({ status: 400, code: "invalid_json_schema", message: "Invalid schema for response_format 'codex_output_schema'" });
  const { final } = await startAndWait(fastEnv(home, { FAKE_CODEX_ARGV_LOG: argvLog }), { task: `x\nFAKE_API_ERROR=${directive}`, schemaPreset: "verdict" }, { home });
  assert.equal(final.ok, false);
  assert.equal(final.state, "failed");
  assert.equal(final.error.kind, "schema");
  assert.equal(final.error.retryable, false);
  assert.equal(fs.readFileSync(argvLog, "utf8").trim().split("\n").length, 1);
});

test("an empty final message is retried once, then reported as empty_output", async (t) => {
  const home = makeHome(t);
  const { final } = await startAndWait(fastEnv(home), { task: "x\nFAKE_NO_OUTPUT=1", schemaPreset: "verdict" }, { home });
  assert.equal(final.ok, false);
  assert.equal(final.error.kind, "empty_output");
  assert.equal(final.provenance.attempts, 2);
});

// The fake Codex's own pid, from its argv log.
function fakeCodexPids(argvLog) {
  return fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).pid) : [];
}

test("the deadline stops the whole Codex process tree, grandchildren included", async (t) => {
  const home = makeHome(t);
  const pidFile = path.join(home, "grandchild.pid");
  const argvLog = path.join(home, "argv.jsonl");
  const { final } = await startAndWait(
    fastEnv(home, { FAKE_CODEX_ARGV_LOG: argvLog }),
    // 4 s: long enough for the fake to start its child even on a loaded machine
    { task: `slow\nFAKE_SLEEP_MS=60000\nFAKE_SPAWN_CHILD=${pidFile}`, timeoutSec: 4, maxAttempts: 1 },
    { home }
  );
  assert.equal(final.ok, false);
  assert.equal(final.state, "timeout");
  assert.equal(final.error.kind, "timeout");
  const [codexPid] = fakeCodexPids(argvLog);
  assert.ok(codexPid, "codex was started");
  assert.ok(await eventually(() => !pidAlive(codexPid)), "codex itself must not survive the deadline");
  assert.ok(fs.existsSync(pidFile), "the fake started its child before the deadline");
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(await eventually(() => !pidAlive(grandchild)), "the grandchild must not survive the deadline");
});

test("cancel stops only that run and reports cancelled", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const pidFile = path.join(home, "grandchild.pid");
  const started = await runCli(["start", "--request", writeRequest(home, { task: `slow\nFAKE_SLEEP_MS=60000\nFAKE_SPAWN_CHILD=${pidFile}` })], { env });
  assert.ok(await eventually(() => fs.existsSync(pidFile)));
  const cancelled = await runCli(["cancel", started.json.runId], { env });
  assert.equal(cancelled.json.state, "cancelled");
  assert.equal(cancelled.json.error.kind, "cancelled");
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(await eventually(() => !pidAlive(grandchild)));
});

test("an attached run whose caller stops polling is torn down as abandoned", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const pidFile = path.join(home, "grandchild.pid");
  const started = await runCli(
    ["start", "--request", writeRequest(home, { task: `slow\nFAKE_SLEEP_MS=60000\nFAKE_SPAWN_CHILD=${pidFile}`, orphanAfterSec: 2 })],
    { env }
  );
  const runId = started.json.runId;
  // `result` and `status` never refresh the heartbeat — only `wait` does.
  assert.ok(
    await eventually(async () => (await runCli(["result", runId], { env })).json.state === "abandoned", { timeoutMs: 20_000, stepMs: 500 }),
    "the supervisor must notice the missing heartbeat"
  );
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(await eventually(() => !pidAlive(grandchild)));
});

test("a detached run (attached:false) survives without polling", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const started = await runCli(["start", "--request", writeRequest(home, { task: "bg\nFAKE_SLEEP_MS=2500", attached: false, orphanAfterSec: 1 })], { env });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const result = await runCli(["result", started.json.runId], { env });
  assert.equal(result.json.state, "done");
});

test("machine-wide slots queue a second run until the first finishes", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home, { ULTRACODEX_MAX_CONCURRENT: "1" });
  const first = await runCli(["start", "--request", writeRequest(home, { task: "first\nFAKE_SLEEP_MS=2500" })], { env });
  assert.ok(await eventually(async () => (await runCli(["status", first.json.runId], { env })).json.runs[0].state === "running"));
  const second = await runCli(["start", "--request", writeRequest(home, { task: "second" })], { env });
  const early = await runCli(["status", second.json.runId], { env });
  assert.equal(early.json.runs[0].state, "queued");
  const done = await runCli(["wait", second.json.runId, "--max-wait", "20"], { env });
  assert.equal(done.json.state, "done");
  const firstResult = JSON.parse(fs.readFileSync(path.join(home, "runs", first.json.runId, "result.json"), "utf8"));
  assert.equal(firstResult.state, "done");
});

function frame(header, schema, task) {
  return [JSON.stringify(header), FRAME_SCHEMA_MARK, schema === null ? "null" : JSON.stringify(schema), FRAME_TASK_MARK, task].join("\n");
}

test("a framed request from the relay runs; a corrupted copy is rejected before any run", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const task = "Check `this` $(and) that\\n with 'quotes'";
  const schema = SCHEMA_PRESETS.verdict;
  const header = { v: 1, tier: "daily", kind: "verify", label: "framed", taskHash: fnv1a(normalizeText(task)), schemaHash: schemaHash(schema) };
  header.h = fnv1a(JSON.stringify(header));
  const ok = await runCli(["run", "--framed", "-", "--max-wait", "20"], { env, input: frame(header, schema, task) });
  assert.equal(ok.json.state, "done");
  assert.equal(ok.json.provenance.model, "gpt-6-sol");
  assert.equal(ok.json.provenance.effort, "xhigh");

  const before = fs.readdirSync(path.join(home, "runs")).length;
  const bad = await runCli(["start", "--framed", "-"], { env, input: frame(header, schema, task.replace("quotes", "quote")) });
  assert.equal(bad.code, 1);
  assert.equal(bad.json.state, "rejected");
  assert.equal(bad.json.error.kind, "relay_corruption");
  assert.equal(bad.json.error.retryable, true);
  assert.equal(fs.readdirSync(path.join(home, "runs")).length, before);
});

test("an encoded frame uploaded in parts (out of order) starts once the last part lands", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const bs = String.fromCharCode(0x5c);
  const task = ["path C:" + bs + "x" + bs + "y and 50% and it's", "y".repeat(1900), "tail line"].join("\n");
  const schema = SCHEMA_PRESETS.verdict;
  const header = { v: 1, kind: "verify", tier: "light", label: "parts", taskHash: fnv1a(normalizeText(task)), schemaHash: schemaHash(schema) };
  header.h = fnv1a(JSON.stringify(header));
  const encoded = encodeFrameText(frame(header, schema, normalizeText(task)))
    .split("\n")
    .flatMap((line) => {
      const out = [];
      for (let rest = line; ; rest = rest.slice(700)) {
        if (rest.length <= 700) {
          out.push(rest);
          break;
        }
        out.push(rest.slice(0, 700) + "%+");
      }
      return out;
    });
  const lines = [FRAME_MAGIC, ...encoded];
  const parts = [lines.slice(0, 2), lines.slice(2, 4), lines.slice(4)].map((part) => part.join("\n") + "\n");
  assert.ok(parts.every((part) => !part.includes("'") && !part.includes(bs)), "parts are quote- and backslash-free");
  const hashOf = (index) => fnv1a(parts[index].slice(0, -1));
  const wrongFirst = await runCli(["part", "new", "1", "3", "00000000"], { env, input: parts[0] });
  assert.equal(wrongFirst.json.state, "part_rejected");
  assert.equal(wrongFirst.json.upload, null, "a rejected first part opens no upload");
  assert.equal(fs.readdirSync(path.join(home, "rejected")).length, 1, "the rejected copy is kept for diagnosis");
  const first = await runCli(["part", "new", "1", "3", hashOf(0)], { env, input: parts[0] });
  assert.equal(first.json.state, "receiving");
  const upload = first.json.upload;
  assert.match(upload, /^ucx-[0-9a-f]{12}$/, "the runner allocates the upload id");
  const wrong = await runCli(["part", upload, "3", "3", "00000000"], { env, input: parts[2] });
  assert.equal(wrong.json.state, "part_rejected");
  assert.equal(fs.existsSync(path.join(home, "inbox", upload, "part-3")), false, "a rejected part is not stored");
  const third = await runCli(["part", upload, "3", "3", hashOf(2)], { env, input: parts[2] });
  assert.equal(third.json.state, "receiving");
  assert.equal(third.code, 3);
  const last = await runCli(["part", upload, "2", "3", hashOf(1)], { env, input: parts[1] });
  assert.equal(last.code, 3, last.stdout);
  assert.ok(last.json.runId, "the last part starts the run");
  const done = await runCli(["wait", last.json.runId, "--max-wait", "20"], { env });
  assert.equal(done.json.state, "done");
  assert.equal(done.json.provenance.taskHash, fnv1a(normalizeText(task)));
  assert.equal(done.json.resultHash, fnv1a(JSON.stringify(done.json.result)));
  assert.equal(fs.existsSync(path.join(home, "inbox", upload)), false, "the upload is cleared after assembly");
  const unknown = await runCli(["part", "ucx-000000000000", "2", "3", hashOf(1)], { env, input: parts[1] });
  assert.equal(unknown.json.error.kind, "unknown_upload", "parts only go into an upload the runner opened");
  const whole = parts.join("").replace("tail line", "tail lime");
  const bad = await runCli(["part", "new", "1", "1", fnv1a(whole.slice(0, -1))], { env, input: whole });
  assert.equal(bad.json.error.kind, "relay_corruption", "a consistent but altered frame fails the frame hashes");
});

test("a run cancelled while queued never starts Codex", async (t) => {
  const home = makeHome(t);
  const argvLog = path.join(home, "argv.jsonl");
  const env = fastEnv(home, { ULTRACODEX_MAX_CONCURRENT: "1", FAKE_CODEX_ARGV_LOG: argvLog });
  const first = await runCli(["start", "--request", writeRequest(home, { task: "first\nFAKE_SLEEP_MS=2500" })], { env });
  assert.ok(await eventually(async () => (await runCli(["status", first.json.runId], { env })).json.runs[0].state === "running"));
  const second = await runCli(["start", "--request", writeRequest(home, { task: "second" })], { env });
  const cancelled = await runCli(["cancel", second.json.runId], { env });
  assert.equal(cancelled.json.state, "cancelled");
  await runCli(["wait", first.json.runId, "--max-wait", "20"], { env });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fs.readFileSync(argvLog, "utf8").trim().split("\n").length, 1, "only the first run ever spawned codex");
});

test("a failure after spawn stops the run's own tree; a failed state write does not end the run", async (t) => {
  const home = makeHome(t);
  const pidFile = path.join(home, "grandchild.pid");
  const argvLog = path.join(home, "argv.jsonl");
  // the fault fires 2.5 s after spawn, once the fake has started its own child
  const { final } = await startAndWait(
    fastEnv(home, { ULTRACODEX_TEST_FAULT: "post-spawn:2500", FAKE_CODEX_ARGV_LOG: argvLog }),
    { task: `x\nFAKE_SLEEP_MS=30000\nFAKE_SPAWN_CHILD=${pidFile}` },
    { home }
  );
  assert.equal(final.ok, false);
  assert.equal(final.error.kind, "execution");
  const [codexPid] = fakeCodexPids(argvLog);
  assert.ok(codexPid && fs.existsSync(pidFile), "codex and its child were running when the failure hit");
  assert.ok(await eventually(() => !pidAlive(codexPid)), "codex itself is stopped");
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(await eventually(() => !pidAlive(grandchild)), "nothing the run started is left running");
  const { final: survived } = await startAndWait(fastEnv(home, { ULTRACODEX_TEST_FAULT: "state-write" }), { task: "y" }, { home });
  assert.equal(survived.ok, true);
});

test("invalid requests are rejected with precise kinds", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const cases = [
    [{ task: "x", nope: true }, "invalid_request"],
    [{ task: "x", model: "gpt-6-luna", effort: "ultra" }, "effort"],
    [{ task: "x", schema: { type: "object", properties: { a: { type: "string" } }, required: [] } }, "schema"],
  ];
  for (const [request, kind] of cases) {
    const result = await runCli(["start", "--request", writeRequest(home, request)], { env });
    assert.equal(result.code, 1, JSON.stringify(request));
    assert.equal(result.json.error.kind, kind, JSON.stringify(request));
  }
});

test("review mode invokes `codex exec review` with the target flags", async (t) => {
  const home = makeHome(t);
  const argvLog = path.join(home, "argv.jsonl");
  const { final } = await startAndWait(fastEnv(home, { FAKE_CODEX_ARGV_LOG: argvLog }), { review: { base: "main" }, schemaPreset: "review", tier: "final" }, { home });
  assert.equal(final.ok, true);
  assert.equal(final.provenance.mode, "review");
  assert.equal(final.provenance.model, "gpt-6-astra");
  const argv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim()).argv;
  assert.deepEqual(argv.slice(0, 4), ["exec", "review", "--base", "main"]);
});

test("wait on an unknown run id fails cleanly; bad ids are usage errors", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const unknown = await runCli(["wait", "20260101T000000Z-abcdef"], { env });
  assert.equal(unknown.code, 1);
  assert.equal(unknown.json.error.kind, "unknown_run");
  const usage = await runCli(["wait", "../../etc"], { env });
  assert.equal(usage.code, 2);
});

test("preflight checks CLI, auth and catalog without a model call", async (t) => {
  const home = makeHome(t);
  const result = await runCli(["preflight"], { env: fastEnv(home) });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.modelCallMade, false);
  assert.ok(result.json.catalog.some((model) => model.slug === "gpt-6-sol"));
  assert.deepEqual(result.json.missingPolicyModels, []);
  const loggedOut = await runCli(["preflight"], { env: fastEnv(home, { FAKE_CODEX_LOGGED_OUT: "1" }) });
  assert.equal(loggedOut.json.ok, false);
  assert.equal(loggedOut.json.auth.loggedIn, false);
});

test("preflight --live runs one real round trip through the supervisor", async (t) => {
  const home = makeHome(t);
  const result = await runCli(["preflight", "--live"], { env: fastEnv(home, { FAKE_CODEX_OUTPUT: '{"ok":true}' }) });
  assert.equal(result.json.ok, true, result.stdout);
  assert.equal(result.json.live.ok, true);
  assert.equal(result.json.live.provenance.model, "gpt-6-luna");
});

test("dry-run shows the invocation without running codex", async (t) => {
  const home = makeHome(t);
  const argvLog = path.join(home, "argv.jsonl");
  const result = await runCli(["dry-run", "--request", writeRequest(home, { task: "x", tier: "final", kind: "review" })], {
    env: fastEnv(home, { FAKE_CODEX_ARGV_LOG: argvLog }),
  });
  assert.equal(result.json.ok, true);
  assert.equal(result.json.model, "gpt-6-astra");
  assert.ok(result.json.args.includes("--ignore-user-config"));
  assert.equal(fs.existsSync(argvLog), false);
});

test("schema-check and schema commands expose the strict checker and presets", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const file = path.join(home, "s.json");
  fs.writeFileSync(file, JSON.stringify({ type: "object", additionalProperties: false, required: [], properties: { a: { type: "string" } } }));
  const checked = await runCli(["schema-check", "--schema", file], { env });
  assert.equal(checked.code, 1);
  assert.match(checked.json.errors[0], /missing: a/);
  const preset = await runCli(["schema", "implement"], { env });
  assert.deepEqual(preset.json.required.sort(), ["commands_run", "files_changed", "open_questions", "risks", "status", "summary", "tasks", "tests"]);
});

test("gc removes finished runs older than the cutoff and keeps fresh ones", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const { started: oldRun } = await startAndWait(env, { task: "old" }, { home });
  const { started: newRun } = await startAndWait(env, { task: "new" }, { home });
  const statePath = path.join(home, "runs", oldRun.json.runId, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.finishedAt = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(statePath, JSON.stringify(state));
  const gc = await runCli(["gc", "--older-than-days", "7"], { env });
  assert.deepEqual(gc.json.removedRuns, [oldRun.json.runId]);
  assert.ok(fs.existsSync(path.join(home, "runs", newRun.json.runId)));
});
