// Steerable workflow nodes (0.6.0), part 3: what a node shares with every long job — the usage-limit wait, the
// account switch — and what it adds for the people around it: notifications that stay quiet (a review runs a
// dozen nodes), the MCP tool that lists them, and the guard that keeps relays and readers away from them.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { continuationPrompt } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { RUNNER, eventually, runCli } from "./helpers.mjs";
import { startServer } from "./helpers-mcp.mjs";
import { readJson, readState, requests, runDir, serverSpawns, sessionEvents, sessionHome, startSession, untilEvent, untilState, wait } from "./helpers-session.mjs";
import { followHome, limitHome, limitAnswer, macOf, startNode, turnTexts } from "./helpers-steerable.mjs";

// ── limits and account changes ──

test("a usage-limited node waits for the reset and continues its thread under the same job; nothing is replayed", async (t) => {
  const { home, env, calls, work } = limitHome(t, [limitAnswer({ allowed: false, resetsInSec: 3 }), limitAnswer({ allowed: true, usedPercent: 0 })]);
  const task = `implement once\nFAKE_USAGE_LIMIT=1\nFAKE_QUOTA_WORK=${work}`;
  const runId = await startNode(env, home, { task, tier: "light", timeoutSec: 30, label: "limited node" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "limit_wait" && event.resumesAt), "the wait learned the reset time");
  const waiting = await runCli(["wait", runId, "--max-wait", "0"], { env });
  assert.equal(waiting.code, 3);
  assert.deepEqual([waiting.json.ok, waiting.json.state, waiting.json.waitingForAccount, waiting.json.waitingForLimit, waiting.json.steerable, waiting.json.session], [null, "backoff", true, true, true, undefined], "the one-shot run's wait flags");
  assert.ok(waiting.json.resumesAt && waiting.json.limitWaitUntil);
  const final = await wait(env, runId, 60);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.ok, final.json.provenance.attempts, final.json.provenance.limitResumes, final.json.provenance.accountHandoffs], [true, 2, 1, undefined]);
  assert.ok(final.json.provenance.limitWaitedSec >= 2);
  assert.equal(final.json.mac, macOf(home, final.json, task));
  assert.equal(serverSpawns(calls()).length, 1, "the same app-server: the account did not change");
  assert.equal(turnTexts(calls())[1], continuationPrompt("reset", task), "the system notice with the request, not the bare task again");
  assert.equal(fs.readFileSync(work, "utf8"), "applied once\n");
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "resumed").map((event) => event.reason), ["limit_reset"]);
  assert.equal(readJson(path.join(runDir(home, runId), "turns", "1.json")).error.kind, "usage_limit");
  assert.equal(final.json.session, undefined);
});

test("an account switch while a node runs: handed over at a step boundary, the thread continues on a new app-server", async (t) => {
  const { home, env, calls, switchTo } = followHome(t);
  const task = "long\nFAKE_TURN_MS=30000";
  const runId = await startNode(env, home, { task, tier: "light", label: "followed" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  switchTo("account-b");
  const final = await wait(env, runId, 60);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.ok, final.json.text, final.json.provenance.attempts, final.json.provenance.accountHandoffs], [true, "continued", 2, 1]);
  assert.equal(final.json.mac, macOf(home, final.json, task));
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "resumed").map((event) => event.reason), ["account_change"]);
  assert.equal(serverSpawns(calls()).length, 2);
  assert.equal(requests(calls(), "thread/resume")[0].params.threadId, final.json.provenance.threadId);
  assert.equal(turnTexts(calls())[1], continuationPrompt("switch", task));
  assert.equal(readState(home, runId).state, "done");
});

test("a message sent while the turn is handed to a new account is held back and steers the continuation", async (t) => {
  const { home, env, calls, switchTo } = followHome(t, { FAKE_CODEX_RESUME_MS: "1500", FAKE_CODEX_TURN_MS: "20000" });
  const runId = await startNode(env, home, { task: "long\nFAKE_TURN_MS=30000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  switchTo("account-b");
  assert.ok(await untilEvent(home, runId, (event) => event.type === "account_switch" && event.status === "interrupting"));
  const sent = runCli(["send", runId, "--message", "use the new account", "--mode", "steer"], { env });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "resumed", 30_000));
  const ack = await sent;
  assert.deepEqual([ack.json.outcome, ack.json.turn], ["steered", 2], ack.stdout);
  await runCli(["interrupt", runId], { env });
  const final = await wait(env, runId, 40);
  assert.equal(final.json.state, "interrupted", "ended by the interrupt, not by the handoff");
  assert.equal(final.json.provenance.steers, 1);
  assert.equal(requests(calls(), "turn/steer").length, 1);
});

// ── notifications ──

// a watcher left running, whose lines are collected until the test stops it
function watchProcess(t, env, args) {
  const child = spawn(process.execPath, [RUNNER, "notify", ...args], { env, windowsHide: true });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  t.after(() => child.kill());
  return { lines, until: (predicate, timeoutMs = 30_000) => eventually(() => lines.some(predicate), { timeoutMs, stepMs: 50 }) };
}

test("notify and the channel say nothing of a node's turns, errors and end — a session's are still reported", async (t) => {
  const { home, env } = sessionHome(t);
  const owner = { ...env, ULTRACODEX_OWNER: "owner-a" };
  const watch = watchProcess(t, owner, ["--max-wait", "120"]);
  assert.ok(await eventually(() => fs.existsSync(path.join(home, "notify"))), "the watcher is up");
  await new Promise((resolve) => setTimeout(resolve, 500));
  // nodes that finish, fail, are interrupted and are cancelled — and a session that finishes a turn
  const ok = await startNode(owner, home, { task: "fine\nFAKE_ANSWER=ok", tier: "light", label: "lens: code" });
  const failing = await startNode(owner, home, { task: "bad\nFAKE_FAIL_FIRST=1\nFAKE_FAIL_KIND=badRequest", tier: "light", label: "lens: tests" });
  const interrupted = await startNode(owner, home, { task: "stop me\nFAKE_TURN_MS=60000", tier: "light", label: "lens: perf" });
  const cancelled = await startNode(owner, home, { task: "cancel me\nFAKE_TURN_MS=60000", tier: "light", label: "lens: sec" });
  const session = await startSession(owner, home, { task: "sess\nFAKE_ANSWER=s", tier: "light", label: "a session" });
  assert.ok(await untilEvent(home, interrupted, (event) => event.type === "turn_started"));
  assert.ok(await untilEvent(home, cancelled, (event) => event.type === "turn_started"));
  assert.equal((await runCli(["interrupt", interrupted], { env })).json.outcome, "interrupted");
  assert.equal((await runCli(["cancel", cancelled], { env })).json.state, "cancelled");
  for (const runId of [ok, failing, interrupted]) await wait(env, runId, 30);
  assert.ok(await watch.until((line) => line.codex === "turn_done" && line.runId === session), "the session's turn is reported");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(
    watch.lines.map((line) => [line.codex, line.runId]),
    [["turn_done", session]],
    "no turn_done, error or ended line for any node, whatever became of it"
  );
});

test("notify still says when a node waits for a usage limit, and when it went on", async (t) => {
  const { home, env } = limitHome(t, [limitAnswer({ allowed: false, resetsInSec: 4 }), limitAnswer({ allowed: true, usedPercent: 0 })]);
  const owner = { ...env, ULTRACODEX_OWNER: "owner-a" };
  const watch = watchProcess(t, owner, ["--max-wait", "120"]);
  assert.ok(await eventually(() => fs.existsSync(path.join(home, "notify"))));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const runId = await startNode(owner, home, { task: "limited\nFAKE_USAGE_LIMIT=1", tier: "light", label: "lens: code", timeoutSec: 30 });
  assert.ok(await watch.until((line) => line.codex === "limit_wait" && line.runId === runId), "paused on a limit: the owner wants to know");
  assert.ok(await watch.until((line) => line.codex === "resumed" && line.runId === runId, 60_000), "and that it went on");
  assert.equal((await wait(env, runId, 60)).json.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(watch.lines.map((line) => line.codex), ["limit_wait", "resumed"], "and nothing about its turns or its end");
  assert.equal(watch.lines[0].label, "lens: code");
});

// ── the MCP tools ──

test("codex_sessions lists a running node with steerable and its label; codex_send steers it and rejects a queue", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_OWNER: "owner-m" });
  const runId = await startNode(env, home, { task: "steer\nFAKE_WAIT_STEER=1\nFAKE_ANSWER=base", tier: "light", label: "lens: code" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "turn_started"));
  const server = startServer(t, env);
  await server.initialize();
  const listed = await server.call("codex_sessions");
  assert.deepEqual(listed.json.sessions.map((entry) => [entry.runId, entry.label, entry.steerable, entry.state, entry.owner]), [[runId, "lens: code", true, "running", "mine"]]);
  const queued = await server.call("codex_send", { runId, message: "later", mode: "queue" });
  assert.deepEqual([queued.json.outcome, queued.json.reason], ["rejected", "single_turn"]);
  const steered = await server.call("codex_send", { runId, message: "this way", mode: "steer" });
  assert.equal(steered.json.outcome, "steered");
  const events = await server.call("codex_events", { runId });
  assert.ok(events.json.events.some((event) => event.type === "steer"));
  assert.equal((await wait(env, runId)).json.provenance.steers, 1);
  const after = await server.call("codex_sessions");
  assert.deepEqual(after.json.sessions.map((entry) => [entry.runId, entry.state, entry.steerable]), [[runId, "done", true]], "an ended node is listed like any ended run");
  const result = await server.call("codex_result", { runId });
  assert.match(result.json.text, /steered: \["this way"\]/);
});

test("the sessions listing of a node whose backend fell back to exec has no steerable entry", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_OWNER: "owner-m", FAKE_CODEX_CONFIG_READ: "error" });
  const runId = await startNode(env, home, { task: "fall back\nFAKE_OUTPUT=x", tier: "light", label: "lens" });
  assert.equal((await wait(env, runId, 40)).json.provenance.backend, "exec");
  const server = startServer(t, env);
  await server.initialize();
  assert.deepEqual((await server.call("codex_sessions")).json.sessions, []);
  assert.equal((await untilState(home, runId, "done")), true);
});
