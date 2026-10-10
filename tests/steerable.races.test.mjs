// Steerable workflow nodes (0.6.0), part 6: races and budgets found in review — a cancel that arrives while the
// backend is still starting, a deadline the fallback must not renew, a suspension during the retry backoff, and
// the wait of a usage limit that ended without another turn.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { eventually, pidAlive, runCli } from "./helpers.mjs";
import { hasResult, readJson, requests, runDir, sessionHome, spawns, wait } from "./helpers-session.mjs";
import { limitAnswer, limitHome, startNode } from "./helpers-steerable.mjs";

const argvEntries = (home) => (fs.existsSync(path.join(home, "argv.jsonl")) ? fs.readFileSync(path.join(home, "argv.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

// a node whose app-server is slow to answer config/read: the cancel, close or abandonment arrives while the backend starts
async function startingNode(t, extra = {}) {
  const ctx = sessionHome(t, { FAKE_CODEX_CONFIG_READ_MS: "2500", ...extra });
  const runId = await startNode(ctx.env, ctx.home, { task: "quick\nFAKE_ANSWER=done", tier: "light", label: "starting" });
  assert.ok(await eventually(() => ctx.calls().some((entry) => entry.kind === "request" && entry.method === "initialize"), { timeoutMs: 30_000 }), "the app-server is up and answering config/read slowly");
  return { ...ctx, runId };
}

test("a node cancelled while its backend starts never starts its turn and ends cancelled — not done", async (t) => {
  const { home, env, calls, runId } = await startingNode(t);
  const cancelled = await runCli(["cancel", runId], { env });
  assert.deepEqual([cancelled.json.ok, cancelled.json.state, cancelled.json.error?.kind], [false, "cancelled", "cancelled"], cancelled.stdout);
  assert.equal(requests(calls(), "turn/start").length, 0, "no turn was started for a cancelled job");
  assert.equal(readJson(path.join(runDir(home, runId), "result.json")).state, "cancelled");
  assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), "the app-server is stopped");
});

test("a node closed while its backend starts: the close is acknowledged and the job is cancelled", async (t) => {
  const { home, env, calls, runId } = await startingNode(t);
  const closed = await runCli(["close", runId], { env });
  assert.deepEqual([closed.code, closed.json.outcome], [0, "closed"], closed.stdout);
  assert.equal((await wait(env, runId)).json.state, "cancelled");
  assert.equal(requests(calls(), "turn/start").length, 0);
  assert.equal(readJson(path.join(runDir(home, runId), "result.json")).state, "cancelled");
});

test("a node abandoned while its backend starts (onOrphan: stop) never starts its turn", async (t) => {
  const ctx = sessionHome(t, { FAKE_CODEX_CONFIG_READ_MS: "4000" });
  const runId = await startNode(ctx.env, ctx.home, { task: "quick", tier: "light", orphanAfterSec: 1, onOrphan: "stop" });
  assert.ok(await eventually(() => hasResult(ctx.home, runId), { timeoutMs: 40_000 }));
  const result = readJson(path.join(runDir(ctx.home, runId), "result.json"));
  assert.deepEqual([result.state, result.error.kind], ["abandoned", "abandoned"]);
  assert.equal(requests(ctx.calls(), "turn/start").length, 0);
});

test("a cancel that lands just before a quick turn completes wins over the result", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startNode(env, home, { task: "quick\nFAKE_CANCEL_BEFORE_COMPLETE=1\nFAKE_ANSWER=done", tier: "light" });
  const final = await wait(env, runId, 30);
  assert.deepEqual([final.json.ok, final.json.state, final.json.error?.kind], [false, "cancelled", "cancelled"], final.stdout);
  assert.equal(requests(calls(), "turn/start").length, 1, "the turn did run: the cancel came while it completed");
  assert.equal(final.json.text, undefined, "not committed as a result");
  assert.equal(final.json.session, undefined);
});

test("the fallback never renews the job's budget: a start that used it up ends the job as a timeout, exec never runs", async (t) => {
  const ctx = sessionHome(t, { FAKE_CODEX_CONFIG_READ: "hang", ULTRACODEX_CONFIG_READ_TIMEOUT_MS: "2500" });
  ctx.env.FAKE_CODEX_ARGV_LOG = path.join(ctx.home, "argv.jsonl");
  const runId = await startNode(ctx.env, ctx.home, { task: "no time", tier: "light", timeoutSec: 2 });
  const final = await wait(ctx.env, runId, 40);
  assert.equal(final.code, 1, final.stdout);
  assert.deepEqual([final.json.ok, final.json.state, final.json.error.kind, final.json.error.retryable], [false, "timeout", "timeout", false]);
  assert.match(final.json.error.message, /deadline was used up before its session backend failed over/);
  assert.equal(final.json.session, undefined);
  assert.equal(final.json.provenance.attempts, 0, "no turn and no exec attempt ever ran");
  assert.equal(argvEntries(ctx.home).filter((entry) => entry.argv[0] === "exec").length, 0, "codex exec never ran");
  assert.equal((await runCli(["status", runId], { env: ctx.env })).json.runs[0].state, "timeout");
});

test("a suspension during the retry backoff moves the job's deadline: the retry still runs", async (t) => {
  // turn 1 fails at once; the machine "sleeps" 4 s inside the backoff; the job's budget is 3 s of work
  const { home, env, calls } = sessionHome(t, { FAKE_CODEX_OUTPUT: "recovered", ULTRACODEX_TEST_FAULT: "suspend-in-backoff:4000", ULTRACODEX_SUSPEND_GAP_MS: "500" });
  const runId = await startNode(env, home, { task: "sleepy\nFAKE_FAIL_FIRST=1", tier: "light", timeoutSec: 3 });
  const final = await wait(env, runId, 40);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.ok, final.json.text, final.json.provenance.attempts], [true, "recovered", 2], "time asleep is not time worked");
  assert.equal(requests(calls(), "turn/start").length, 2);
  assert.match(fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8"), /resumed after ~\d+ s suspended; deadlines moved/);
});

test("the wait of a usage limit that ended without another turn is in the job's result", async (t) => {
  const { home, env } = limitHome(t, [limitAnswer({ allowed: false, resetsInSec: 3600 })]);
  const runId = await startNode(env, home, { task: "limited\nFAKE_USAGE_LIMIT=1", tier: "light", limitWaitSec: 3, timeoutSec: 60 });
  const final = await wait(env, runId, 60);
  assert.equal(final.code, 1, final.stdout);
  assert.deepEqual([final.json.ok, final.json.state, final.json.error.kind], [false, "failed", "usage_limit"]);
  assert.ok(final.json.provenance.limitWaitedSec >= 2, `the wait is reported (${final.json.provenance.limitWaitedSec})`);
  const stored = readJson(path.join(runDir(home, runId), "result.json"));
  assert.equal(stored.provenance.limitWaitedSec, final.json.provenance.limitWaitedSec, "result.json carries it too");
  assert.equal(readJson(path.join(runDir(home, runId), "turns", "1.json")).provenance.limitWaitedSec, final.json.provenance.limitWaitedSec, "as does the turn it belongs to");
});
