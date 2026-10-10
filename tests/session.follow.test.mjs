// Sessions, part 6: running work follows a switch of the managed ChatGPT account. A turn that is
// running when the owner switches accounts is handed over at the next step boundary — no command or
// tool call in flight, no question waiting — by interrupting it; its thread then continues on a new
// app-server with the new login. The "account" is the test identity file (the real auth.json is never
// touched); the fake Codex plays the app-server.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MAX_ACCOUNT_HANDOFFS, continuationPrompt } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { RUNNER, eventually, runCli } from "./helpers.mjs";
import { readJson, readState, requests, runDir, send, serverSpawns, sessionEvents, sessionHome, startSession, untilEvent, untilState, wait } from "./helpers-session.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const switches = (home, runId) => sessionEvents(home, runId).filter((event) => event.type === "account_switch").map((event) => event.status);
const resumes = (home, runId) => sessionEvents(home, runId).filter((event) => event.type === "resumed").map((event) => event.reason);
const turnTexts = (calls) => requests(calls, "turn/start").map((entry) => entry.params.input[0].text);

// a session home whose managed account is the identity file; switchTo() is the owner switching
function followHome(t, extra = {}) {
  const ctx = sessionHome(t, { ULTRACODEX_ACCOUNT_CHECK_MS: "100", FAKE_CODEX_OUTPUT: "continued", ...extra });
  const identity = path.join(ctx.home, "identity.txt");
  fs.writeFileSync(identity, "account-a");
  ctx.env.ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE = identity;
  return { ...ctx, identity, switchTo: (name) => fs.writeFileSync(identity, name) };
}

test("a switch during a model step is followed within seconds: the turn is interrupted, the thread continues on a new app-server", async (t) => {
  const { home, env, calls, switchTo } = followHome(t);
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=30000", tier: "light", sandbox: "workspace-write" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const firstServer = serverSpawns(calls())[0].pid;
  const switchedAt = Date.now();
  switchTo("account-b");

  const final = await wait(env, runId, 60);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.ok, final.json.text, final.json.session.turn], [true, "continued", 2]);
  assert.equal(final.json.provenance.accountHandoffs, 1, "counted in the handoff budget");
  const events = sessionEvents(home, runId);
  const resumed = events.find((event) => event.type === "resumed");
  assert.equal(resumed.reason, "account_change");
  assert.ok(Date.parse(resumed.t) - switchedAt < 10_000, "within seconds of the switch");
  assert.deepEqual(switches(home, runId), ["pending", "interrupting"]);
  assert.deepEqual(resumes(home, runId), ["account_change"], "one resumed per handoff");
  const completed = events.filter((event) => event.type === "turn_completed");
  assert.deepEqual(completed.map((event) => [event.status, event.ok, event.kind]), [["interrupted", false, "account_switch"], ["completed", true, undefined]]);
  assert.equal(events.some((event) => event.type === "interrupt"), false, "not a user interrupt");
  assert.equal(readJson(path.join(runDir(home, runId), "turns", "1.json")).error.kind, "account_switch", "turn 1's envelope, numbered like any continuation");
  assert.equal(readJson(path.join(runDir(home, runId), "turns", "2.json")).text, "continued");
  assert.equal(serverSpawns(calls()).length, 2, "a new app-server holds the new login");
  assert.ok(await eventually(() => {
    try {
      process.kill(firstServer, 0);
      return false;
    } catch {
      return true;
    }
  }), "the old one is gone");
  const resume = requests(calls(), "thread/resume")[0].params;
  assert.deepEqual([resume.threadId, resume.sandbox], [final.json.provenance.threadId, "workspace-write"], "same thread, same sandbox");
  assert.equal(requests(calls(), "turn/interrupt").length, 1);
  assert.deepEqual(turnTexts(calls())[1], continuationPrompt("switch", "long\nFAKE_TURN_MS=30000"));
  assert.ok(requests(calls(), "mcpServerStatus/list").length >= 2, "the hermetic check ran on the new app-server too");
  await pause(500);
  assert.equal(readState(home, runId).state, "idle", "the new app-server started after the switch: nothing more to follow");
});

test("a switch during a running command waits for the command to finish, then follows; a command is never interrupted", async (t) => {
  const { home, env, calls, switchTo } = followHome(t);
  const runId = await startSession(env, home, { task: "run\nFAKE_COMMAND_MS=3000\nFAKE_TURN_MS=30000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command_started" && event.command === "held fake command"));
  switchTo("account-b");
  await pause(1200);
  assert.deepEqual(switches(home, runId), ["pending"], "seen, waiting for the step boundary");
  assert.equal(requests(calls(), "turn/interrupt").length, 0, "the command is still running: nothing is interrupted");

  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.text, final.json.session.turn], [true, "continued", 2], final.stdout);
  const held = sessionEvents(home, runId).find((event) => event.type === "command" && event.command === "held fake command");
  assert.equal(held.exitCode, 0, "the command ran to its end");
  const interrupt = requests(calls(), "turn/interrupt")[0];
  assert.ok(interrupt.at >= Date.parse(held.t), "the interrupt came after the command completed");
  assert.deepEqual(switches(home, runId), ["pending", "interrupting"]);
});

test("a pending question holds the handover until it is answered", async (t) => {
  const { home, env, calls, switchTo } = followHome(t);
  const runId = await startSession(env, home, { task: "decide\nASK: which database?\nFAKE_TURN_MS=30000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "question"));
  switchTo("account-b");
  await pause(1200);
  assert.deepEqual(switches(home, runId), ["pending"]);
  assert.equal(requests(calls(), "turn/interrupt").length, 0, "Codex is blocked on the orchestrator: not interrupted");

  assert.equal((await runCli(["answer", runId, "call-1", "--text", "postgres"], { env })).json.outcome, "answered");
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.session.turn], [true, 2], final.stdout);
  const events = sessionEvents(home, runId).map((event) => event.type === "account_switch" ? `switch:${event.status}` : event.type);
  assert.ok(events.indexOf("answer") < events.indexOf("switch:interrupting"), "handed over after the answer");
  assert.equal(requests(calls(), "turn/interrupt").length, 1);
});

test("followAccountSwitch false finishes the turn on the old account (the session then sleeps, as an idle one does)", async (t) => {
  const { home, env, calls, switchTo } = followHome(t);
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=3000\nFAKE_ANSWER=old", tier: "light", followAccountSwitch: false });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  switchTo("account-b");
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.text, final.json.session.turn], [true, "old", 1]);
  assert.equal(requests(calls(), "turn/interrupt").length, 0);
  assert.equal(serverSpawns(calls()).length, 1);
  assert.deepEqual(switches(home, runId), []);
  assert.ok(await untilState(home, runId, "dormant", 15_000), "the account check after the turn still puts it to sleep");
});

test("a run on the default (followAccountSwitch on) is only opted out by the request or ULTRACODEX_FOLLOW_ACCOUNT_SWITCH=0", async (t) => {
  const { home, env, calls, switchTo } = followHome(t, { ULTRACODEX_FOLLOW_ACCOUNT_SWITCH: "0" });
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=2500\nFAKE_ANSWER=old", tier: "light" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir(home, runId), "request.json"), "utf8")).followAccountSwitch, false);
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  switchTo("account-b");
  assert.equal((await wait(env, runId, 60)).json.text, "old");
  assert.equal(requests(calls(), "turn/interrupt").length, 0);
});

test("a missing or unreadable account, or a token refresh on the same one, is not a switch", async (t) => {
  const { home, env, calls, identity } = followHome(t);
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=3500\nFAKE_ANSWER=old", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  fs.writeFileSync(identity, "account-a\n"); // the same account (what a token refresh leaves)
  await pause(400);
  fs.writeFileSync(identity, ""); // no text: the real login is read, and this home has none
  await pause(400);
  fs.rmSync(identity); // gone
  await pause(400);
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.text, final.json.session.turn], [true, "old", 1]);
  assert.equal(requests(calls(), "turn/interrupt").length, 0);
  assert.equal(serverSpawns(calls()).length, 1);
  assert.deepEqual(switches(home, runId), []);
  await pause(500);
  assert.equal(readState(home, runId).state, "idle", "and nothing put it to sleep afterwards either");
});

test("the handover is not made when the budget of account handoffs is used up: the turn finishes on the old account", async (t) => {
  const { home, env, calls, switchTo } = followHome(t, { FAKE_CODEX_TURN_MS: "2500" });
  const runId = await startSession(env, home, { task: "go", tier: "light", timeoutSec: 600 });
  const started = () => sessionEvents(home, runId).filter((event) => event.type === "turn_started").length;
  for (let handoff = 1; handoff <= MAX_ACCOUNT_HANDOFFS; handoff += 1) {
    assert.ok(await eventually(() => started() === handoff, { timeoutMs: 30_000, stepMs: 25 }), `turn ${handoff} is running`);
    switchTo(`account-${handoff}`);
    assert.ok(await eventually(() => resumes(home, runId).length === handoff, { timeoutMs: 30_000, stepMs: 25 }), `handoff ${handoff} done`);
  }
  assert.ok(await eventually(() => started() === MAX_ACCOUNT_HANDOFFS + 1, { timeoutMs: 30_000, stepMs: 25 }));
  switchTo("account-last");
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.session.turn], [true, MAX_ACCOUNT_HANDOFFS + 1], final.stdout);
  assert.equal(final.json.provenance.accountHandoffs, MAX_ACCOUNT_HANDOFFS);
  const notFollowed = sessionEvents(home, runId).find((event) => event.type === "account_switch" && event.status === "not_followed");
  assert.match(notFollowed.reason, /budget of 8 account handoffs is used up/);
  assert.equal(requests(calls(), "turn/interrupt").length, MAX_ACCOUNT_HANDOFFS, "no interrupt for the one beyond the budget");
  assert.equal(serverSpawns(calls()).length, MAX_ACCOUNT_HANDOFFS + 1);
  assert.match(fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8"), /not followed \(the budget of 8 account handoffs is used up\)/);
});

test("a message sent during the handoff is held back and steers the continuation", async (t) => {
  const { home, env, calls, switchTo } = followHome(t, { FAKE_CODEX_RESUME_MS: "1500", FAKE_CODEX_TURN_MS: "3500" });
  const runId = await startSession(env, home, { task: "long", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const firstServer = serverSpawns(calls())[0].pid;
  switchTo("account-b");
  assert.ok(await untilEvent(home, runId, (event) => event.type === "account_switch" && event.status === "interrupting"));
  const ack = await send(env, runId, "also handle the empty case");
  assert.deepEqual([ack.json.ok, ack.json.outcome, ack.json.turn], [true, "steered", 2], ack.stdout);
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.session.turn], [true, 2], final.stdout);
  assert.match(final.json.text, /^continued steered: \["also handle the empty case"\]$/, "it reached the continuation");
  const steers = requests(calls(), "turn/steer");
  assert.equal(steers.length, 1, "not steered into the turn that was being handed over");
  assert.notEqual(steers[0].pid, firstServer, "the new app-server took it");
  const continuation = sessionEvents(home, runId).filter((event) => event.type === "turn_started")[1];
  assert.equal(steers[0].params.expectedTurnId, continuation.turnId);
  assert.equal(requests(calls(), "turn/start").length, 2, "and it did not start a turn of its own");
});

test("rejected encrypted reasoning on the new account continues from the visible history in a fresh thread", async (t) => {
  const { home, env, calls, switchTo } = followHome(t, { FAKE_CODEX_ENCRYPTED_RESUME: "1" });
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=30000", tier: "light", sandbox: "workspace-write" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  switchTo("account-b");
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.session.turn], [true, 3], final.stdout);
  assert.equal(final.json.provenance.contextRestarts, 1);
  assert.equal(final.json.provenance.accountHandoffs, 1);
  assert.equal(requests(calls(), "thread/start").length, 2, "a fresh thread for the checkpoint");
  assert.equal(requests(calls(), "thread/resume").length, 1, "the saved thread was tried first");
  assert.match(turnTexts(calls())[2], /encrypted reasoning was rejected/);
});

// ── notify ──

test("notify tells of the handoff once: one resumed line, no turn_done or ended for the interrupted part", async (t) => {
  const { home, env, switchTo } = followHome(t, { ULTRACODEX_OWNER: "owner-follow" });
  const child = spawn(process.execPath, [RUNNER, "notify", "--owner", "owner-follow", "--max-wait", "120"], { env, windowsHide: true });
  t.after(() => child.kill());
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      if (buffer.slice(0, at).trim()) lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  assert.ok(await eventually(() => fs.existsSync(path.join(home, "notify")), { timeoutMs: 20_000 }), "the watcher is up");
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=30000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  switchTo("account-b");
  assert.equal((await wait(env, runId, 60)).json.session.turn, 2);
  assert.ok(await eventually(() => lines.some((line) => line.codex === "turn_done"), { timeoutMs: 20_000 }));
  await pause(800);
  assert.deepEqual(
    lines.map((line) => [line.codex, line.turn ?? null, line.reason ?? null, line.ok ?? null]),
    [["resumed", null, "account_change", null], ["turn_done", 2, null, true]]
  );
});

// ── review findings ──

test("a switch that waits behind a command until too little work time is left is not followed: the turn finishes on the old account", async (t) => {
  const { home, env, calls, switchTo } = followHome(t, { ULTRACODEX_MIN_TIMEOUT_SEC: "60" });
  const runId = await startSession(env, home, { task: "run\nFAKE_COMMAND_MS=3000\nFAKE_TURN_MS=1500\nFAKE_ANSWER=old", tier: "light", timeoutSec: 62 });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command_started" && event.command === "held fake command"));
  switchTo("account-b");
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.text, final.json.session.turn], [true, "old", 1], final.stdout);
  assert.deepEqual(switches(home, runId), ["pending", "not_followed"], "accepted when seen, judged again at the boundary");
  const refused = sessionEvents(home, runId).find((event) => event.status === "not_followed");
  assert.match(refused.reason, /too little work time is left/);
  assert.equal(requests(calls(), "turn/interrupt").length, 0, "not interrupted");
  assert.equal(serverSpawns(calls()).length, 1);
});

test("a pending handoff keeps watching the account: A, B, A before the boundary cancels it", async (t) => {
  const { home, env, calls, switchTo } = followHome(t);
  const runId = await startSession(env, home, { task: "run\nFAKE_COMMAND_MS=3000\nFAKE_ANSWER=old", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command_started" && event.command === "held fake command"));
  switchTo("account-b");
  assert.ok(await untilEvent(home, runId, (event) => event.type === "account_switch" && event.status === "pending"));
  switchTo("account-a");
  assert.ok(await untilEvent(home, runId, (event) => event.type === "account_switch" && event.status === "cancelled"), "the way back is noticed while the command still runs");
  assert.equal(requests(calls(), "turn/interrupt").length, 0);

  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.text, final.json.session.turn], [true, "old", 1], final.stdout);
  assert.deepEqual(switches(home, runId), ["pending", "cancelled"], "no interrupt, no restart on the account it is already on");
  assert.equal(requests(calls(), "turn/interrupt").length, 0);
  assert.equal(serverSpawns(calls()).length, 1);
  assert.deepEqual(resumes(home, runId), []);
  await pause(500);
  assert.equal(readState(home, runId).state, "idle", "and the account is the one it started on: nothing puts it to sleep either");
});

test("a switch that is real again after a cancelled one is followed", async (t) => {
  const { home, env, switchTo } = followHome(t);
  const runId = await startSession(env, home, { task: "run\nFAKE_COMMAND_MS=2500\nFAKE_TURN_MS=30000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command_started" && event.command === "held fake command"));
  switchTo("account-b");
  assert.ok(await untilEvent(home, runId, (event) => event.type === "account_switch" && event.status === "pending"));
  switchTo("account-a");
  assert.ok(await untilEvent(home, runId, (event) => event.type === "account_switch" && event.status === "cancelled"));
  switchTo("account-c");
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.session.turn], [true, 2], final.stdout);
  assert.deepEqual(switches(home, runId), ["pending", "cancelled", "pending", "interrupting"]);
  assert.deepEqual(resumes(home, runId), ["account_change"]);
});

test("the continuation names the turn that was interrupted: a follow-up's text, not the first task", async (t) => {
  const { home, env, calls, switchTo } = followHome(t);
  const runId = await startSession(env, home, { task: "first job\nFAKE_ANSWER=one", tier: "light" });
  assert.equal((await wait(env, runId)).json.text, "one");
  const followUp = "second job: run the checks\nFAKE_TURN_MS=30000";
  assert.equal((await send(env, runId, followUp)).json.outcome, "started");
  assert.ok(await eventually(() => sessionEvents(home, runId).filter((event) => event.type === "command").length >= 2, { timeoutMs: 30_000, stepMs: 25 }), "the follow-up turn is running");
  switchTo("account-b");
  const final = await wait(env, runId, 60);
  assert.deepEqual([final.json.ok, final.json.text, final.json.session.turn], [true, "continued", 3], final.stdout);
  const texts = turnTexts(calls());
  assert.deepEqual(texts.slice(0, 2), ["first job\nFAKE_ANSWER=one", followUp]);
  assert.equal(texts[2], continuationPrompt("switch", followUp));
  assert.ok(texts[2].includes("<<<\nsecond job: run the checks"), "the interrupted turn's request");
  assert.ok(!texts[2].includes("first job"), "not the session's first task");
  assert.match(texts[2], /\(the ChatGPT account was switched\)/);
});
