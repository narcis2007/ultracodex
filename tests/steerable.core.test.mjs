// Steerable workflow nodes (0.6.0), part 1: a one-shot job that runs as ONE turn of a session on a private
// app-server (request `steerable: true`) — its request validation, results that are a one-shot run's field for
// field, steering, interrupting, retries, deadlines and the listings. The Codex CLI is the offline fake.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { continuationPrompt, validateRequest } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { eventually, pidAlive, runCli } from "./helpers.mjs";
import { hasResult, readJson, readState, requests, runDir, send, serverSpawns, sessionEvents, sessionHome, spawns, untilEvent, untilState, wait } from "./helpers-session.mjs";
import { macOf, runExec, startNode, turnTexts } from "./helpers-steerable.mjs";

const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
const request = (fields, cwd = process.cwd()) => validateRequest({ task: "x", cwd, ...fields });

// ── the request ──

test("steerable: a plain exec-mode job of any kind and sandbox; never a session, a review, a resume, with images or a profile", (t) => {
  assert.equal(request({}).steerable, false, "off by default");
  assert.equal(request({ steerable: true }).steerable, true);
  assert.equal(request({ steerable: false }).steerable, false);
  for (const kind of ["verify", "ask", "review"]) assert.equal(request({ steerable: true, kind }).kind, kind);
  assert.equal(request({ steerable: true, sandbox: "workspace-write" }).sandbox, "workspace-write", "any sandbox for a direct request");
  const steerable = request({ steerable: true, label: "node" });
  assert.deepEqual([steerable.session, steerable.askOrchestrator, steerable.idleTtlSec, steerable.askTimeoutSec], [false, false, null, null], "no session options");
  assert.throws(() => request({ steerable: "yes" }), /steerable must be a boolean/);
  assert.throws(() => request({ steerable: true, session: true }), /cannot also be a session/);
  assert.throws(() => request({ steerable: true, review: { uncommitted: true } }), /cannot run a review/);
  assert.throws(() => request({ steerable: true, resume: { sessionId: "01a0cec5-503d" } }), /cannot resume a thread/);
  assert.throws(() => request({ steerable: true, profile: "impl" }), /cannot use a profile/);
  assert.throws(() => request({ steerable: true, images: [path.join(process.cwd(), "package.json")] }), /cannot take images/);
  assert.equal(request({ steerable: true, images: [] }).steerable, true, "an empty list is no image");
  // the session-only options still mean nothing without a session
  assert.throws(() => request({ steerable: true, idleTtlSec: 60 }), /need session: true/);
  // retries and deadlines are the one-shot rules
  assert.equal(request({ steerable: true }).maxAttempts, 2);
  assert.equal(request({ steerable: true, sandbox: "workspace-write" }).maxAttempts, 1, "a writing task is not retried unless it is replay-safe");
});

// ── results ──

test("a steerable job's result is a one-shot run's: the same envelope fields, signed for the same request, plus backend and steers", async (t) => {
  const { home, env } = sessionHome(t);
  for (const [name, fields, answer] of [
    ["text", {}, "plain answer"],
    ["schema", { schema: SCHEMA }, "structured"],
  ]) {
    const task = `${name}\nFAKE_ANSWER=${answer}`;
    const base = { task, tier: "light", kind: "verify", label: `shape ${name}`, ...fields };
    const exec = await runExec({ ...env, FAKE_CODEX_OUTPUT: fields.schema ? JSON.stringify({ answer }) : answer }, home, base);
    const runId = await startNode({ ...env, FAKE_CODEX_OUTPUT: "unused" }, home, base);
    const node = (await wait(env, runId)).json;
    assert.equal(node.ok, true, name);
    assert.deepEqual(Object.keys(node).sort(), Object.keys(exec).sort(), `${name}: the envelope has exactly the fields of a one-shot run's`);
    assert.equal(node.state, "done");
    assert.equal(node.runId, runId);
    assert.equal(node.label, `shape ${name}`);
    if (fields.schema) assert.deepEqual(node.result, { answer }, "the schema's JSON, parsed");
    else assert.equal(node.text, answer);
    assert.equal(node.resultHash, exec.resultHash, "the same payload hashes the same");
    assert.equal(node.mac, macOf(home, node, task), "signed with the machine key for this very request (a direct run's digest)");
    // provenance: every field a one-shot run reports, from the session backend, plus what is new
    const missing = Object.keys(exec.provenance).filter((key) => !(key in node.provenance));
    assert.deepEqual(missing, [], `${name}: nothing the exec provenance has is missing`);
    assert.deepEqual(Object.keys(node.provenance).filter((key) => !(key in exec.provenance)), [], "and nothing else: the same fields");
    assert.deepEqual([exec.provenance.backend, node.provenance.backend], ["exec", "session"]);
    assert.deepEqual([node.provenance.model, node.provenance.effort, node.provenance.tier, node.provenance.mode, node.provenance.sandbox, node.provenance.hermetic, node.provenance.attempts], ["gpt-6.1-terra", "xhigh", "light", "exec", "read-only", true, 1]);
    assert.equal(node.provenance.taskHash, exec.provenance.taskHash);
    assert.match(node.provenance.threadId, /^01a0fake-/);
    assert.ok(node.provenance.usage.output_tokens > 0 && node.provenance.durationMs >= 0 && node.provenance.codexVersion);
    assert.equal(node.provenance.steers, undefined, "nothing was steered");
    assert.equal(node.session, undefined, "not a session's envelope");
  }
});

test("wait, result and status print a steerable job as they print a one-shot run; the job ends with its turn", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startNode(env, home, { task: "end me\nFAKE_ANSWER=done\nFAKE_TURN_MS=1500", tier: "light", label: "node" });
  assert.ok(await untilState(home, runId, "running"));
  const running = await runCli(["wait", runId, "--max-wait", "0"], { env });
  assert.equal(running.code, 3);
  assert.deepEqual([running.json.ok, running.json.state, running.json.steerable, running.json.session, running.json.turn, running.json.label], [null, "running", true, undefined, undefined, "node"]);
  assert.equal(running.json.attempt, 1);
  const active = (await runCli(["status", runId], { env })).json.runs[0];
  assert.deepEqual([active.state, active.steerable, active.session, active.turnActive, active.label, active.ok], ["running", true, true, true, "node", null]);
  const final = await wait(env, runId);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(final.json.text, "done");
  // the job is over: result.json exists, nothing idles, nothing is revivable
  assert.equal(hasResult(home, runId), true);
  const state = readState(home, runId);
  assert.deepEqual([state.state, state.turnActive, state.singleTurn], ["done", false, true]);
  const again = await runCli(["wait", runId, "--max-wait", "0"], { env });
  assert.equal(again.code, 0);
  assert.equal(JSON.stringify(again.json), JSON.stringify(final.json), "wait prints the stored result as it is");
  const result = await runCli(["result", runId], { env });
  assert.equal(JSON.stringify(result.json), JSON.stringify(final.json), "result too — not a session's latest turn");
  const ended = (await runCli(["status", runId], { env })).json.runs[0];
  assert.deepEqual([ended.state, ended.ok, ended.steerable, ended.turnActive, ended.supervisorAlive], ["done", true, true, false, false]);
  const methods = requests(calls()).map((entry) => entry.method);
  assert.deepEqual(methods.filter((method) => method.startsWith("turn/") || method.startsWith("thread/")), ["thread/start", "turn/start"], "one thread, one turn");
  assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), "the app-server is gone with the job");
  // no revive: a message after the end is a rejection, not a new turn
  const late = await send(env, runId, "one more thing");
  assert.deepEqual([late.code, late.json.outcome, late.json.reason], [1, "rejected", "session_ended"]);
  assert.equal(requests(calls(), "turn/start").length, 1);
  assert.deepEqual(readJson(path.join(runDir(home, runId), "turns", "1.json")).text, "done", "the turn is recorded like a session's");
});

test("a steerable job is found by its label: status --sessions and the sessions the owner has, running or ended", async (t) => {
  const { home, env } = sessionHome(t);
  const mine = { ...env, ULTRACODEX_OWNER: "owner-a" };
  const node = await startNode(mine, home, { task: "listed\nFAKE_TURN_MS=2500", tier: "light", label: "lens: code" });
  const other = await startNode({ ...env, ULTRACODEX_OWNER: "owner-b" }, home, { task: "theirs\nFAKE_ANSWER=x", tier: "light", label: "lens: security" });
  assert.ok(await untilState(home, node, "running"));
  const listed = (await runCli(["status", "--sessions", "--owner", "owner-a"], { env })).json;
  assert.deepEqual(listed.runs.map((run) => [run.runId, run.label, run.steerable, run.state]), [[node, "lens: code", true, "running"]], "only that owner's, with its label");
  const everyone = (await runCli(["status", "--sessions", "--all"], { env })).json;
  assert.deepEqual(everyone.runs.map((run) => run.runId).sort(), [node, other].sort());
  assert.equal((await wait(env, node)).code, 0);
  const after = (await runCli(["status", "--sessions", "--owner", "owner-a"], { env })).json;
  assert.deepEqual(after.runs.map((run) => [run.runId, run.state, run.ok]), [[node, "done", true]], "an ended one appears like any ended run");
  assert.equal((await runCli(["status", "--mine"], { env: mine })).json.runs.some((run) => run.runId === node), true);
});

// ── steering ──

test("send --mode steer reaches the running turn, is counted, and is in the events; queue mode is rejected; answer is rejected", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startNode(env, home, { task: "steer me\nFAKE_WAIT_STEER=1\nFAKE_ANSWER=base", tier: "light", label: "node" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "turn_started"));
  const queued = await send(env, runId, "later please", "--mode", "queue");
  assert.deepEqual([queued.code, queued.json.ok, queued.json.outcome, queued.json.reason], [1, false, "rejected", "single_turn"], "the job ends with its turn: nothing to queue behind it");
  const answer = await runCli(["answer", runId, "call-1", "--text", "pg"], { env });
  assert.deepEqual([answer.code, answer.json.outcome, answer.json.reason], [1, "rejected", "single_turn"], "nothing asks a question here");
  assert.equal(requests(calls(), "turn/steer").length, 0, "neither reached Codex");
  const steered = await send(env, runId, "use the other file", "--mode", "steer");
  assert.deepEqual([steered.code, steered.json.ok, steered.json.outcome, steered.json.turn], [0, true, "steered", 1]);
  const final = await wait(env, runId);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(final.json.text, 'base steered: ["use the other file"]');
  assert.equal(final.json.provenance.steers, 1);
  assert.equal(final.json.provenance.attempts, 1);
  assert.equal(requests(calls(), "turn/start").length, 1, "the steer did not start a turn");
  assert.deepEqual(requests(calls(), "turn/steer")[0].params.input, [{ type: "text", text: "use the other file", text_elements: [] }]);
  const events = sessionEvents(home, runId);
  assert.deepEqual(events.filter((event) => event.type === "steer").map((event) => [event.text, event.outcome]), [["use the other file", "steered"]]);
  assert.equal(events.some((event) => event.type === "followup"), false);
  // the events command shows the feed of a node
  const feed = (await runCli(["events", runId], { env })).stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(feed, events);
  assert.equal(feed.at(-1).type, "turn_completed", "no idle, no dormant: the feed ends with the turn");
});

test("a message without a mode (auto) steers a running node; between turns or after the end it is rejected, never queued", async (t) => {
  // the retry runs 5 s (the directives of the request are not repeated in a continuation)
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_BACKOFF_MS: "3000", FAKE_CODEX_TURN_MS: "5000" });
  const runId = await startNode(env, home, { task: "auto\nFAKE_FAIL_FIRST=1", tier: "light" });
  // turn 1 fails at once (a retryable server failure); the job backs off before its retry: no active turn
  assert.ok(await untilState(home, runId, "backoff"));
  const between = await send(env, runId, "too early");
  assert.deepEqual([between.code, between.json.outcome, between.json.reason], [1, "rejected", "no_active_turn"]);
  assert.ok(await untilEvent(home, runId, (event) => event.type === "turn_started" && event.turn === 2, 30_000));
  const auto = await send(env, runId, "while it runs");
  assert.deepEqual([auto.code, auto.json.outcome, auto.json.turn], [0, "steered", 2], "auto steers");
  const final = await wait(env, runId);
  assert.equal(final.json.ok, true, final.stdout);
  assert.match(final.json.text, /steered: \["while it runs"\]/);
  assert.equal(final.json.provenance.steers, 1);
  assert.equal(requests(calls(), "turn/start").length, 2);
});

test("interrupt ends the job as interrupted — a user's interrupt is never retried", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startNode(env, home, { task: "stop me\nFAKE_TURN_MS=60000", tier: "light", maxAttempts: 3 });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "turn_started"));
  const out = await runCli(["interrupt", runId], { env });
  assert.deepEqual([out.code, out.json.ok, out.json.outcome], [0, true, "interrupted"]);
  const final = await wait(env, runId);
  assert.equal(final.code, 1, final.stdout);
  assert.deepEqual([final.json.ok, final.json.state, final.json.error.kind, final.json.error.retryable], [false, "interrupted", "interrupted", false]);
  assert.equal(final.json.provenance.attempts, 1);
  assert.equal(final.json.session, undefined);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(requests(calls(), "turn/start").length, 1, "no retry, no continuation");
  assert.equal(readState(home, runId).state, "interrupted");
  assert.equal(sessionEvents(home, runId).some((event) => event.type === "idle"), false);
  assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), "the app-server is stopped");
  // nothing is running now
  assert.equal((await runCli(["interrupt", runId], { env })).json.reason, "session_ended");
});

// ── retries ──

test("a retryable failure with attempts left: backoff, then a retry continuation on the same thread", async (t) => {
  // (a continuation does not repeat the request's directives: the retry's answer comes from the environment)
  const { home, env, calls } = sessionHome(t, { FAKE_CODEX_OUTPUT: "recovered" });
  const task = "flaky\nFAKE_FAIL_FIRST=1";
  const runId = await startNode(env, home, { task, tier: "light", label: "flaky node" });
  const final = await wait(env, runId, 40);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.ok, final.json.text, final.json.provenance.attempts], [true, "recovered", 2]);
  assert.equal(final.json.mac, macOf(home, final.json, task));
  const texts = turnTexts(calls());
  assert.equal(texts.length, 2);
  assert.equal(texts[1], continuationPrompt("retry", task), "the continuation notice with the request, not the bare task again");
  assert.match(texts[1], /a transient error interrupted your turn/);
  assert.equal(requests(calls(), "thread/start").length, 1, "the same thread");
  assert.equal(requests(calls(), "thread/resume").length, 0);
  assert.equal(serverSpawns(calls()).length, 1, "the same app-server");
  const threads = requests(calls(), "turn/start").map((entry) => entry.params.threadId);
  assert.equal(threads[0], threads[1]);
  assert.equal(final.json.provenance.threadId, threads[0]);
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "turn_completed").map((event) => [event.ok, event.kind]), [[false, "server"], [true, undefined]]);
  assert.equal(readJson(path.join(runDir(home, runId), "turns", "1.json")).error.retryable, true);
  assert.deepEqual(final.json.provenance.usageTotal, { input_tokens: 120, cached_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 4 }, "the tokens of every turn of the job (the failed one used none in the fake)");
});

test("a failure that is not retryable, a used-up budget and maxAttempts 1 end the job without a retry", async (t) => {
  for (const [name, task, extra, kind, turns, hostEnv = {}] of [
    ["not retryable", "bad\nFAKE_FAIL_FIRST=1\nFAKE_FAIL_KIND=badRequest", {}, "invalid_request", 1],
    ["budget used up", "twice", {}, "server", 2, { FAKE_CODEX_FAIL_TURNS: "2" }],
    ["maxAttempts 1", "once\nFAKE_FAIL_FIRST=1", { maxAttempts: 1 }, "server", 1],
    ["a rate limit is retried too", "limited\nFAKE_FAIL_FIRST=1\nFAKE_FAIL_KIND=rateLimitExceeded\nFAKE_ANSWER=ok", {}, null, 2],
    ["a three-attempt budget", "thrice", { maxAttempts: 3 }, null, 3, { FAKE_CODEX_FAIL_TURNS: "2", FAKE_CODEX_OUTPUT: "third time lucky" }],
  ]) {
    const { home, env, calls } = sessionHome(t, hostEnv);
    const runId = await startNode(env, home, { task, tier: "light", ...extra });
    const final = await wait(env, runId, 40);
    assert.equal(requests(calls(), "turn/start").length, turns, name);
    assert.equal(final.json.provenance.attempts, turns, name);
    if (kind === null) {
      assert.equal(final.json.ok, true, `${name}: ${final.stdout}`);
      continue;
    }
    assert.equal(final.code, 1, `${name}: ${final.stdout}`);
    assert.deepEqual([final.json.ok, final.json.state, final.json.error.kind], [false, "failed", kind], name);
    assert.equal(final.json.session, undefined, name);
  }
});

test("a retry that cannot resume its thread starts a fresh one with the original task", async (t) => {
  // the app-server dies after the failing turn, so the retry must resume the thread on a new one — which it cannot
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_BACKOFF_MS: "1000", FAKE_CODEX_RESUME_FAILS: "1" });
  const task = "fresh\nFAKE_FAIL_FIRST=1\nFAKE_FAIL_EXIT=1\nFAKE_ANSWER=from scratch";
  const runId = await startNode(env, home, { task, tier: "light" });
  const final = await wait(env, runId, 40);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.text, final.json.provenance.attempts], ["from scratch", 2]);
  assert.equal(requests(calls(), "thread/resume").length, 1, "the saved thread was tried first");
  assert.equal(requests(calls(), "thread/start").length, 2, "then a fresh one");
  assert.equal(turnTexts(calls())[1], task, "the original task, not a continuation of a thread that is not there");
  assert.equal(final.json.provenance.previousThreadIds.length, 1);
  assert.notEqual(final.json.provenance.threadId, final.json.provenance.previousThreadIds[0]);
  assert.equal(serverSpawns(calls()).length, 3, "the first app-server, the one that tried to resume, the one with the fresh thread");
});

test("the backoff before a retry is stoppable: cancel ends the job at once", async (t) => {
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_BACKOFF_MS: "120000" });
  const runId = await startNode(env, home, { task: "back off\nFAKE_FAIL_FIRST=1", tier: "light" });
  assert.ok(await untilState(home, runId, "backoff"));
  const startedAt = Date.now();
  const cancelled = await runCli(["cancel", runId], { env });
  assert.equal(cancelled.json.state, "cancelled", cancelled.stdout);
  assert.ok(Date.now() - startedAt < 20_000, "not after the two-minute backoff");
  assert.equal(requests(calls(), "turn/start").length, 1);
  assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)));
});

// ── deadlines, cancel, orphans ──

test("timeoutSec bounds the job: a turn past it is interrupted and the job ends as timeout, not retried", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startNode(env, home, { task: "slow\nFAKE_TURN_MS=60000", tier: "light", timeoutSec: 2, maxAttempts: 3 });
  const final = await wait(env, runId, 40);
  assert.equal(final.code, 1, final.stdout);
  assert.deepEqual([final.json.state, final.json.error.kind, final.json.error.retryable], ["timeout", "timeout", false]);
  assert.equal(final.json.provenance.attempts, 1);
  assert.equal(requests(calls(), "turn/start").length, 1);
  assert.equal(requests(calls(), "turn/interrupt").length, 1, "the turn was interrupted, then the app-server stopped");
  assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)));
});

test("the deadline covers the retries too: a retry that would outlive the job's time is not started", async (t) => {
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_BACKOFF_MS: "3000" });
  // turn 1 fails at once; the backoff (3 s) would end after the 2 s deadline minus the minimum work time
  const runId = await startNode(env, home, { task: "no time\nFAKE_FAIL_FIRST=1", tier: "light", timeoutSec: 2 });
  const final = await wait(env, runId, 40);
  assert.equal(final.json.ok, false, final.stdout);
  assert.equal(final.json.error.kind, "server");
  assert.equal(requests(calls(), "turn/start").length, 1, "no retry: no work time left for it");
});

test("cancel and close end a running node as cancelled; the process tree is stopped", async (t) => {
  for (const command of ["cancel", "close"]) {
    const { home, env, calls } = sessionHome(t);
    const runId = await startNode(env, home, { task: `end me\nFAKE_TURN_MS=60000`, tier: "light" });
    assert.ok(await untilEvent(home, runId, (event) => event.type === "turn_started"));
    const out = await runCli([command, runId], { env });
    if (command === "cancel") assert.equal(out.json.state, "cancelled", out.stdout);
    else assert.deepEqual([out.code, out.json.outcome], [0, "closed"], "close is acknowledged once the job has ended");
    const final = await wait(env, runId);
    assert.deepEqual([final.json.ok, final.json.state, final.json.error.kind], [false, "cancelled", "cancelled"], command);
    assert.equal(final.json.session, undefined);
    assert.equal(requests(calls(), "turn/start").length, 1, command);
    assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), `${command}: the app-server is stopped`);
    assert.equal((await runCli(["close", runId], { env })).json.reason, "session_ended", "a second close: the job is over");
  }
});

test("a node nobody polls any more finishes by default and is abandoned with onOrphan: stop", async (t) => {
  const { home, env } = sessionHome(t);
  const finishing = await startNode(env, home, { task: "orphan\nFAKE_TURN_MS=4000\nFAKE_ANSWER=kept", tier: "light", orphanAfterSec: 1 });
  const stopping = await startNode(env, home, { task: "orphan 2\nFAKE_TURN_MS=30000", tier: "light", orphanAfterSec: 1, onOrphan: "stop" });
  assert.ok(await untilState(home, finishing, "running"));
  assert.ok(await eventually(async () => (await runCli(["status", finishing], { env })).json.runs[0].orphaned === true, { timeoutMs: 20_000 }), "unpolled: orphaned, still running");
  assert.equal((await runCli(["status", finishing], { env })).json.runs[0].state, "running", "nobody polls, and the run goes on");
  assert.ok(await eventually(() => hasResult(home, stopping), { timeoutMs: 30_000 }));
  assert.deepEqual([readJson(path.join(runDir(home, stopping), "result.json")).state, readJson(path.join(runDir(home, stopping), "result.json")).error.kind], ["abandoned", "abandoned"]);
  const final = await wait(env, finishing, 30);
  assert.deepEqual([final.json.ok, final.json.text], [true, "kept"], "the run went on and kept its result for whoever polls next");
});

test("the slot is held while the turn runs and given back after it", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_MAX_CONCURRENT: "1" });
  const first = await startNode(env, home, { task: "first\nFAKE_TURN_MS=3000\nFAKE_ANSWER=one", tier: "light" });
  assert.ok(await untilEvent(home, first, (event) => event.type === "turn_started"));
  const second = await startNode(env, home, { task: "second\nFAKE_ANSWER=two", tier: "light" });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(sessionEvents(home, second).some((event) => event.type === "turn_started"), false, "waiting for the slot");
  assert.equal((await runCli(["status", second], { env })).json.runs[0].state, "queued");
  assert.equal((await wait(env, first)).json.text, "one");
  assert.equal((await wait(env, second, 40)).json.text, "two");
  // a node cancelled while it waits for its slot never starts a turn
  const third = await startNode(env, home, { task: "third\nFAKE_TURN_MS=3000", tier: "light" });
  assert.ok(await untilEvent(home, third, (event) => event.type === "turn_started"));
  const fourth = await startNode(env, home, { task: "fourth", tier: "light" });
  const cancelled = await runCli(["cancel", fourth], { env });
  assert.equal(cancelled.json.state, "cancelled");
  assert.equal(sessionEvents(home, fourth).some((event) => event.type === "turn_started"), false);
  await wait(env, third);
});
