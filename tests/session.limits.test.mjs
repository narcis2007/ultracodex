// Sessions, part 5: usage limits and account changes inside a session — the one-shot run's
// recovery (limit wait, account handoff, checkpoint fallback, budget, spacing) applied to turns.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ACCOUNT_CONTINUATION } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { eventually, pidAlive, runCli } from "./helpers.mjs";
import { jsonLines, readJson, readState, requests, runDir, serverSpawns, sessionEvents, sessionHome, startSession, untilEvent, untilState, wait } from "./helpers-session.mjs";

const SECRET_ACCOUNT = "ACCOUNT-ID-MUST-NOT-LEAK";

function saveAccount(home, account) {
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account } }));
}

// one scripted answer of the fake's account/rateLimits/read (see fake-codex.mjs); resetsInSec is
// relative to the script's first probe
function limitAnswer({ allowed, usedPercent = 100, resetsInSec = 3600 }) {
  const codex = { limitId: "codex", primary: { usedPercent, windowDurationMins: 300, resetsAt: resetsInSec }, secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetsInSec + 86_400 } };
  return { result: { ordinaryUsageAllowed: allowed, accountId: SECRET_ACCOUNT, rateLimits: codex, rateLimitsByLimitId: { codex } } };
}

// a session home with an account, scripted rate-limit answers and the fake's logs
function limitHome(t, answers, extra = {}) {
  const ctx = sessionHome(t, { ULTRACODEX_LIMIT_WAIT_SEC: "120", ULTRACODEX_LIMIT_PROBE_MS: "60000", ...extra });
  saveAccount(ctx.home, "account-a");
  const script = path.join(ctx.home, "rate-limits.json");
  fs.writeFileSync(script, JSON.stringify(answers));
  const probeLog = path.join(ctx.home, "probe.jsonl");
  ctx.env.FAKE_CODEX_RATE_LIMITS = script;
  ctx.env.FAKE_CODEX_PROBE_LOG = probeLog;
  return { ...ctx, probeLog, work: path.join(ctx.home, "work.txt") };
}

const limited = (work, extra = "") => `implement once\nFAKE_USAGE_LIMIT=1\nFAKE_QUOTA_WORK=${work}${extra}`;
const turnTexts = (calls) => requests(calls, "turn/start").map((entry) => entry.params.input[0].text);

test("a usage-limited turn waits for the reset, then continues the same thread on the same app-server", async (t) => {
  const { home, env, calls, probeLog, work } = limitHome(t, [limitAnswer({ allowed: false, resetsInSec: 3 }), limitAnswer({ allowed: true, usedPercent: 0 })]);
  const runId = await startSession(env, home, { task: limited(work), tier: "light", sandbox: "workspace-write", timeoutSec: 30 });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "limit_wait" && event.resumesAt), "the wait learned the reset time");
  // while waiting: backoff with the Phase 1 flags
  const waiting = await runCli(["wait", runId, "--max-wait", "0"], { env });
  assert.equal(waiting.code, 3);
  assert.deepEqual([waiting.json.ok, waiting.json.state, waiting.json.waitingForAccount, waiting.json.waitingForLimit, waiting.json.session], [null, "backoff", true, true, true]);
  assert.ok(waiting.json.resumesAt && waiting.json.limitWaitUntil);
  const status = (await runCli(["status", runId], { env })).json.runs[0];
  assert.deepEqual([status.state, status.waitingForLimit, status.turnActive], ["backoff", true, false]);
  assert.equal(serverSpawns(calls()).length, 1);

  const final = await wait(env, runId, 60);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.ok, final.json.session.turn], [true, 2]);
  assert.equal(serverSpawns(calls()).length, 1, "the same app-server: the account did not change");
  assert.equal(requests(calls(), "thread/resume").length, 0);
  const texts = turnTexts(calls());
  assert.equal(texts.length, 2);
  assert.equal(texts[1], ACCOUNT_CONTINUATION, "the existing continuation prompt, not the task again");
  assert.equal(fs.readFileSync(work, "utf8"), "applied once\n", "the work was not replayed");
  const provenance = final.json.provenance;
  assert.equal(provenance.limitResumes, 1);
  assert.equal(provenance.accountHandoffs, undefined);
  assert.ok(provenance.limitWaitedSec >= 2, `waited ${provenance.limitWaitedSec} s`);
  assert.equal(provenance.threadId, readState(home, runId).threadId);
  // turn 1 is the failure that hit the limit (and says how long the session waited)
  const first = readJson(path.join(runDir(home, runId), "turns", "1.json"));
  assert.deepEqual([first.ok, first.error.kind, first.session.turn], [false, "usage_limit", 1]);
  assert.ok(first.provenance.limitWaitedSec >= 2);
  // the continuation got the work time turn 1 had left, waiting excluded
  const state = readState(home, runId);
  assert.ok(Date.parse(state.deadlineAt) - Date.parse(state.attemptStartedAt) > 27_000);
  const types = sessionEvents(home, runId).map((event) => event.type);
  assert.ok(types.indexOf("limit_wait") > types.indexOf("turn_completed"));
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "resumed").map((event) => event.reason), ["limit_reset"]);
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "turn_started").map((event) => event.reason), ["task", "continuation"]);
  assert.equal(sessionEvents(home, runId).filter((event) => event.type === "turn_completed").map((event) => event.ok).join(), "false,true");
  const probes = jsonLines(probeLog).filter((entry) => entry.method === "account/rateLimits/read");
  assert.equal(probes.length, 2);
  for (const name of ["supervisor.log", "state.json", "events.jsonl", "result.json"]) {
    const file = path.join(runDir(home, runId), name);
    if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(SECRET_ACCOUNT), name);
  }
});

test("an account switch during the wait restarts the app-server, resumes the thread with the sandbox, passes the hermetic check, continues", async (t) => {
  const { home, env, calls, work } = limitHome(t, [limitAnswer({ allowed: false })]);
  const runId = await startSession(env, home, { task: limited(work), tier: "light", sandbox: "workspace-write" });
  assert.ok(await untilState(home, runId, "limit_wait"));
  const firstServer = serverSpawns(calls())[0].pid;
  saveAccount(home, "account-b");
  const final = await wait(env, runId, 60);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(final.json.provenance.accountHandoffs, 1);
  assert.equal(final.json.provenance.limitResumes, undefined, "an account change is not a limit resume");
  assert.equal(serverSpawns(calls()).length, 2, "a new app-server holds the new login");
  assert.ok(await eventually(() => !pidAlive(firstServer)), "the old one is gone");
  const resume = requests(calls(), "thread/resume")[0].params;
  assert.deepEqual([resume.threadId, resume.sandbox, resume.approvalPolicy], [final.json.provenance.threadId, "workspace-write", "never"]);
  const methods = requests(calls()).map((entry) => `${entry.pid === firstServer ? "old" : "new"}:${entry.method}`);
  assert.ok(methods.indexOf("new:thread/resume") < methods.indexOf("new:mcpServerStatus/list") && methods.indexOf("new:mcpServerStatus/list") < methods.lastIndexOf("new:turn/start"), "resume, hermetic check, then the continuation");
  assert.equal(turnTexts(calls())[1], ACCOUNT_CONTINUATION);
  assert.equal(fs.readFileSync(work, "utf8"), "applied once\n");
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "resumed").map((event) => event.reason), ["account_change"]);
  assert.deepEqual(serverSpawns(calls())[1].flags.filter((flag) => flag.startsWith("sandbox_workspace_write")).length, 2);
});

test("a switch the failing turn itself causes is followed at once; rejected encrypted reasoning continues from the visible history in a fresh thread", async (t) => {
  const { home, env, calls, work } = limitHome(t, [limitAnswer({ allowed: false })], { FAKE_CODEX_ACCOUNT_AFTER_FAILURE: "account-b", FAKE_CODEX_ENCRYPTED_RESUME: "1" });
  const runId = await startSession(env, home, { task: limited(work, "\nFAKE_ANSWER=recovered"), tier: "light", sandbox: "workspace-write" });
  const final = await wait(env, runId, 60);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(requests(calls(), "thread/start").length, 2, "a fresh thread for the checkpoint");
  assert.equal(requests(calls(), "thread/resume").length, 1, "the saved thread was tried first");
  const state = readState(home, runId);
  const provenance = final.json.provenance;
  assert.equal(provenance.contextRestarts, 1);
  assert.equal(provenance.accountHandoffs, 1);
  assert.equal(provenance.threadId, state.threadId, "the fresh thread is the session's thread now");
  assert.equal(provenance.previousThreadIds.length, 1);
  assert.notEqual(provenance.previousThreadIds[0], provenance.threadId);
  assert.equal(requests(calls(), "thread/resume")[0].params.threadId, provenance.previousThreadIds[0]);
  assert.equal(final.json.session.turn, 3);
  const checkpoint = turnTexts(calls())[2];
  assert.match(checkpoint, /applied once/, "the visible tool output is in the checkpoint");
  assert.match(checkpoint, /Do not execute commands merely/);
  assert.match(checkpoint, /"originalTask":"implement once/, "the original message of this unit of work");
  assert.doesNotMatch(checkpoint, /PRIVATE_REASONING|PRIVATE_ENCRYPTED/, "hidden reasoning is never copied");
  assert.equal(fs.readFileSync(work, "utf8"), "applied once\n", "the work ran once");
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "session_started").length, 2);
  // later messages go to the new thread
  const ack = await runCli(["send", runId, "--message", "next\nFAKE_ANSWER=next"], { env });
  assert.equal(ack.json.outcome, "started");
  const next = await wait(env, runId);
  assert.equal(next.json.text, "next");
  assert.equal(requests(calls(), "turn/start").at(-1).params.threadId, provenance.threadId);
});

test("limitWaitSec 0 keeps only the short account wait, a reached cap ends the wait: the usage_limit turn stands and the session idles", async (t) => {
  {
    const { home, env, probeLog, work } = limitHome(t, [limitAnswer({ allowed: true, usedPercent: 0 })], { ULTRACODEX_ACCOUNT_WAIT_MS: "300" });
    const runId = await startSession(env, home, { task: limited(work), tier: "light", limitWaitSec: 0 });
    const out = await wait(env, runId, 30);
    assert.equal(out.code, 1, out.stdout);
    assert.equal(out.json.error.kind, "usage_limit");
    assert.equal(out.json.session.state, "idle", "the session lives on");
    assert.equal(jsonLines(probeLog).filter((entry) => entry.method === "account/rateLimits/read").length, 0, "no rate-limit probe");
    assert.match(fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8"), /waiting for an account change before resuming its thread/);
  }
  {
    const { home, env, calls, work } = limitHome(t, [limitAnswer({ allowed: false })]);
    const runId = await startSession(env, home, { task: limited(work), tier: "light", limitWaitSec: 2 });
    const out = await wait(env, runId, 30);
    assert.equal(out.json.error.kind, "usage_limit");
    assert.ok(out.json.provenance.limitWaitedSec >= 2);
    assert.equal(out.json.session.state, "idle");
    assert.match(fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8"), /the usage limit did not reset within 2 s; giving up/);
    assert.equal(requests(calls(), "turn/start").length, 1, "never resumed");
  }
});

test("a resume that hits the limit again is spaced out and counted: limit resumes in provenance, the spacing line in the log", async (t) => {
  const { home, env, work } = limitHome(t, [limitAnswer({ allowed: true, usedPercent: 100, resetsInSec: 1 })], { ULTRACODEX_LIMIT_PROBE_MS: "2500", FAKE_CODEX_USAGE_LIMITS: "2" });
  const runId = await startSession(env, home, { task: `implement once\nFAKE_QUOTA_WORK=${work}`, tier: "light" });
  const final = await wait(env, runId, 60);
  assert.equal(final.json.ok, true, final.stdout);
  assert.equal(final.json.provenance.limitResumes, 2);
  assert.equal(final.json.session.turn, 3);
  const log = fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8");
  assert.match(log, /usage reported allowed, but the previous limit resume failed again; resuming no earlier than /);
  assert.match(log, /limit resume 2/);
});

test("close, interrupt and cancel during a limit wait act at once; a message sent meanwhile is queued", async (t) => {
  const { home, env, calls, work } = limitHome(t, [limitAnswer({ allowed: false })], { ULTRACODEX_LIMIT_WAIT_SEC: "600" });
  const wake = (task) => startSession(env, home, { task, tier: "light" });
  // interrupt: the wait ends, the turn-1 envelope (usage_limit) stands, the session idles
  const one = await wake(limited(work));
  assert.ok(await untilState(home, one, "limit_wait"));
  const queued = await runCli(["send", one, "--message", "after the wait\nFAKE_ANSWER=later"], { env });
  assert.deepEqual([queued.json.outcome, queued.json.turn], ["queued", 3], queued.stdout);
  const steer = await runCli(["send", one, "--message", "now", "--mode", "steer"], { env });
  assert.deepEqual([steer.json.outcome, steer.json.reason], ["rejected", "no_active_turn"]);
  const interrupted = await runCli(["interrupt", one], { env });
  assert.deepEqual([interrupted.json.ok, interrupted.json.outcome], [true, "interrupted"], interrupted.stdout);
  // the queued message starts after the aborted wait
  const settled = await wait(env, one, 30);
  assert.equal(settled.json.text, "later", settled.stdout);
  assert.equal((await runCli(["result", one, "--turn", "1"], { env })).json.error.kind, "usage_limit");

  // close
  const two = await wake(`close me\nFAKE_USAGE_LIMIT=1\nFAKE_QUOTA_WORK=${work}2`);
  assert.ok(await untilState(home, two, "limit_wait"));
  const started = Date.now();
  const closed = await runCli(["close", two], { env });
  assert.deepEqual([closed.code, closed.json.outcome], [0, "closed"], closed.stdout);
  assert.ok(Date.now() - started < 15_000, "not after the 600 s wait");
  assert.deepEqual([readJson(path.join(runDir(home, two), "result.json")).state, readJson(path.join(runDir(home, two), "result.json")).error.kind], ["closed", "usage_limit"]);

  // cancel
  const three = await wake(`cancel me\nFAKE_USAGE_LIMIT=1\nFAKE_QUOTA_WORK=${work}3`);
  assert.ok(await untilState(home, three, "limit_wait"));
  const cancelled = await runCli(["cancel", three], { env });
  assert.equal(cancelled.json.state, "cancelled", cancelled.stdout);
  assert.equal(requests(calls(), "turn/start").filter((entry) => /cancel me|close me/.test(entry.params.input[0].text)).length, 2, "no turn was started after the waits ended");
});
