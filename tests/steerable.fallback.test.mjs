// Steerable workflow nodes (0.6.0), part 2: when the session backend cannot be used — a config the app-server
// cannot prove isolated, a Codex without config/read, an app-server that does not start, the kill switch — the
// very same job runs on `codex exec`, exactly as a non-steerable job: same run id, same signed request, same
// deadline, same attempts budget.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { abandonSteerableState } from "../plugins/ultracodex/scripts/session.mjs";
import { runPaths } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { eventually, makeHome, pidAlive, runCli, writeRequest } from "./helpers.mjs";
import { jsonLines, readJson, readState, requests, runDir, send, sessionEvents, sessionHome, spawns, wait } from "./helpers-session.mjs";
import { macOf, startNode } from "./helpers-steerable.mjs";

const argvEntries = (home) => jsonLines(path.join(home, "argv.jsonl"));
const execHome = (t, extra = {}) => {
  const ctx = sessionHome(t, extra);
  ctx.env.FAKE_CODEX_ARGV_LOG = path.join(ctx.home, "argv.jsonl");
  return ctx;
};

// what every fallback must show, whatever made it fall back
async function assertRanOnExec(ctx, runId, task, { kind, reason }) {
  const { home, env } = ctx;
  const final = await wait(env, runId, 40);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(final.json.ok, true);
  assert.equal(final.json.runId, runId, "the same run");
  assert.equal(final.json.provenance.backend, "exec", "the job says it ran on exec");
  assert.equal(final.json.provenance.attempts, 1);
  assert.equal(final.json.mac, macOf(home, final.json, task), "signed for the same request");
  assert.equal(final.json.session, undefined);
  // codex exec ran, hermetic, with the job's task on stdin
  const execs = argvEntries(home).filter((entry) => entry.argv[0] === "exec");
  assert.equal(execs.length, 1, "one exec attempt");
  assert.ok(execs[0].argv.includes("--ignore-user-config"));
  // the record of what happened
  const events = sessionEvents(home, runId);
  const fallback = events.find((event) => event.type === "backend_fallback");
  assert.equal(fallback.kind, kind);
  assert.match(fallback.reason, reason);
  assert.match(fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8"), /running it on codex exec instead/);
  // and no longer a session: its state is an exec run's, it is not listed, nothing can steer it
  const state = readState(home, runId);
  assert.deepEqual([state.state, state.session, state.singleTurn, state.turn, state.threadId, state.steerable], ["done", undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual([state.backendFallback.kind], [kind]);
  assert.equal((await runCli(["status", "--sessions", "--all"], { env })).json.runs.length, 0, "not a session any more");
  const described = (await runCli(["status", runId], { env })).json.runs[0];
  assert.equal(described.backendFallback.kind, kind);
  assert.equal(described.session, undefined);
  const late = await send(env, runId, "steer?");
  assert.deepEqual([late.json.outcome, late.json.reason], ["rejected", "not_a_session"]);
  return { final, events };
}

test("a config that is not isolated: no thread, then the same job on exec — and the app-server is gone", async (t) => {
  const ctx = execHome(t, { FAKE_CODEX_CONFIG_READ: "leak:developer_instructions" });
  const { home, env, calls } = ctx;
  const task = "fall back\nFAKE_OUTPUT=from exec";
  const runId = await startNode(env, home, { task, tier: "light", label: "node" });
  const { events } = await assertRanOnExec(ctx, runId, task, { kind: "hermetic_violation", reason: /developer_instructions/ });
  assert.equal((await wait(env, runId)).json.text, "from exec");
  assert.equal(requests(calls(), "thread/start").length, 0, "no thread was ever started");
  assert.equal(requests(calls(), "turn/start").length, 0);
  assert.deepEqual(events.find((event) => event.type === "hermetic_violation").keys, ["developer_instructions"]);
  assert.doesNotMatch(JSON.stringify(events), /leaked-value/, "never a value");
  assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), "the app-server is gone");
  // the deadline and the slot are the job's own, exec's: the run holds a slot only while its attempt runs
  assert.equal(readJson(path.join(runDir(home, runId), "result.json")).state, "done");
});

test("config/read missing on an older Codex, an app-server that does not start, an unreadable answer: the job runs on exec", async (t) => {
  for (const [name, extra, kind, reason] of [
    ["method not found", { FAKE_CODEX_CONFIG_READ: "error" }, "hermetic_violation", /config\/read failed: method not found/],
    ["no origins", { FAKE_CODEX_CONFIG_READ: "missing" }, "hermetic_violation", /no readable origins/],
    ["the app-server exits at once", { FAKE_CODEX_APP_SERVER_EXIT: "3" }, "network", /connection closed/],
  ]) {
    const ctx = execHome(t, extra);
    const task = `${name}\nFAKE_OUTPUT=from exec`;
    const runId = await startNode(ctx.env, ctx.home, { task, tier: "light" });
    await assertRanOnExec(ctx, runId, task, { kind, reason });
  }
});

test("the fallback keeps the job's deadline: the time the failed start took is not given back", async (t) => {
  // config/read hangs for 1.5 s, then the job runs on exec; its attempt has the 60 s minus that
  const ctx = execHome(t, { FAKE_CODEX_CONFIG_READ: "hang", ULTRACODEX_CONFIG_READ_TIMEOUT_MS: "1500" });
  const task = "deadline\nFAKE_OUTPUT=done";
  const runId = await startNode(ctx.env, ctx.home, { task, tier: "light", timeoutSec: 60 });
  await assertRanOnExec(ctx, runId, task, { kind: "hermetic_violation", reason: /did not answer within 1500 ms/ });
  const state = readState(ctx.home, runId);
  const window = Date.parse(state.deadlineAt) - Date.parse(state.attemptStartedAt);
  assert.ok(window > 20_000 && window < 59_000, `the attempt's window is the job's 60 s less the failed start (${window} ms)`);
});

test("a failure after the first turn started is not a fallback: the job's own rules apply", async (t) => {
  // turn 1 fails with a bad request: no retry, no second backend — the failure is the result
  const ctx = execHome(t);
  const runId = await startNode(ctx.env, ctx.home, { task: "bad\nFAKE_FAIL_FIRST=1\nFAKE_FAIL_KIND=badRequest", tier: "light" });
  const final = await wait(ctx.env, runId, 40);
  assert.equal(final.json.ok, false);
  assert.equal(final.json.error.kind, "invalid_request");
  assert.equal(final.json.provenance.backend, "session");
  assert.equal(argvEntries(ctx.home).filter((entry) => entry.argv[0] === "exec").length, 0, "exec never ran");
  assert.equal(sessionEvents(ctx.home, runId).some((event) => event.type === "backend_fallback"), false);
});

test("ULTRACODEX_NODE_BACKEND=exec: every steerable job runs on exec as before", async (t) => {
  const ctx = execHome(t, { ULTRACODEX_NODE_BACKEND: "exec", FAKE_CODEX_CONFIG_READ: "leak:developer_instructions" });
  const { home, env, calls } = ctx;
  const task = "kill switch\nFAKE_OUTPUT=exec says hi";
  const started = await runCli(["start", "--request", writeRequest(home, { task, steerable: true, tier: "light", label: "node" })], { env });
  assert.equal(started.code, 3, started.stdout);
  assert.equal(started.json.steerable, undefined, "not steerable: the start line does not promise it");
  const final = await wait(env, started.json.runId, 40);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(final.json.text, "exec says hi");
  assert.equal(final.json.provenance.backend, "exec");
  assert.equal(final.json.mac, macOf(home, final.json, task));
  assert.deepEqual(calls().filter((entry) => entry.kind === "spawn"), [], "no app-server was started");
  assert.equal(argvEntries(home).filter((entry) => entry.argv[0] === "exec").length, 1);
  const state = readState(home, started.json.runId);
  assert.deepEqual([state.session, state.singleTurn, state.backendFallback], [undefined, undefined, undefined], "an exec run's state, and no fallback to speak of");
  assert.equal((await runCli(["status", "--sessions", "--all"], { env })).json.runs.length, 0);
  assert.equal((await send(env, started.json.runId, "hi")).json.reason, "not_a_session");
  assert.equal(fs.existsSync(path.join(runDir(home, started.json.runId), "events.jsonl")), false);
});

test("abandonSteerableState: the session fields are taken back and the messages in the inbox are told why", (t) => {
  const home = makeHome(t);
  const previous = process.env.ULTRACODEX_HOME;
  process.env.ULTRACODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ULTRACODEX_HOME;
    else process.env.ULTRACODEX_HOME = previous;
  });
  const runId = "20261010T000000Z-abcdef";
  const paths = runPaths(runId);
  for (const dir of [paths.inboxDone, paths.outbox, paths.turns, paths.queue]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(paths.state, JSON.stringify({ state: "running", runId, label: "node", session: true, singleTurn: true, turn: 1, turnActive: true, steerable: true, threadId: "t", queued: 1, supervisorPid: 4242, attempt: 1, deadlineAt: "x" }));
  fs.writeFileSync(path.join(paths.inbox, "0abcdefgh-00000001.json"), JSON.stringify({ id: "0abcdefgh-00000001", kind: "send", text: "hi", mode: "steer" }));
  abandonSteerableState(paths, { reason: "hermetic: boom", kind: "hermetic_violation" });
  const state = readJson(paths.state);
  assert.deepEqual([state.state, state.runId, state.label, state.supervisorPid], ["queued", runId, "node", 4242], "what is the run's stays");
  for (const key of ["session", "singleTurn", "turn", "turnActive", "steerable", "threadId", "queued", "attempt", "deadlineAt"]) assert.equal(state[key], undefined, key);
  assert.deepEqual(state.backendFallback, { reason: "hermetic: boom", kind: "hermetic_violation" });
  const ack = readJson(path.join(paths.outbox, "0abcdefgh-00000001.json"));
  assert.deepEqual([ack.outcome, ack.reason], ["rejected", "backend_fallback"]);
  assert.equal(fs.readdirSync(paths.inbox).filter((name) => name.endsWith(".json")).length, 0, "the message was moved out of the inbox");
});

test("dry-run and preflight say which backend a steerable job runs on", async (t) => {
  const { home, env } = sessionHome(t);
  const file = path.join(home, "dry.json");
  fs.writeFileSync(file, JSON.stringify({ task: "x", steerable: true, tier: "light" }));
  const dry = await runCli(["dry-run", "--request", file], { env });
  assert.equal(dry.json.ok, true, dry.stdout);
  assert.deepEqual([dry.json.steerable, dry.json.backend], [true, "session"]);
  assert.deepEqual(dry.json.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.ok(dry.json.args.includes('service_tier="default"'));
  const killed = await runCli(["dry-run", "--request", file], { env: { ...env, ULTRACODEX_NODE_BACKEND: "exec" } });
  assert.deepEqual([killed.json.steerable, killed.json.backend], [true, "exec"]);
  assert.equal(killed.json.args[0], "exec");
  fs.writeFileSync(file, JSON.stringify({ task: "x", tier: "light" }));
  assert.equal((await runCli(["dry-run", "--request", file], { env })).json.backend, "exec", "an ordinary job");
  const preflight = await runCli(["preflight"], { env });
  assert.equal(preflight.json.nodeBackend, "session");
  assert.equal((await runCli(["preflight"], { env: { ...env, ULTRACODEX_NODE_BACKEND: "exec" } })).json.nodeBackend, "exec");
});
