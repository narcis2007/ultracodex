// Sessions, part 8: deadlines, crashes, failed revives, the event cap, resumed threads, slots and
// orphans — the ways a session can go wrong or be set up differently.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { eventually, pidAlive, runCli } from "./helpers.mjs";
import { hasResult, readJson, readState, requests, runDir, serverSpawns, sessionEvents, sessionHome, spawns, startSession, untilEvent, untilState, wait } from "./helpers-session.mjs";

const send = (env, runId, message, ...rest) => runCli(["send", runId, "--message", message, ...rest], { env });

test("each turn has its own deadline: the turn is interrupted, fails as timeout, and the session idles and goes on", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "slow\nFAKE_TURN_MS=60000", tier: "light", timeoutSec: 2 });
  const out = await wait(env, runId, 40);
  assert.equal(out.code, 1, out.stdout);
  assert.deepEqual([out.json.ok, out.json.state, out.json.error.kind, out.json.error.retryable], [false, "timeout", "timeout", false]);
  assert.match(out.json.error.message, /interrupted/);
  assert.equal(out.json.session.state, "idle");
  assert.equal(requests(calls(), "turn/interrupt").length, 1);
  assert.equal(serverSpawns(calls()).length, 1, "the app-server was not killed");
  // the next turn gets a fresh deadline
  assert.equal((await send(env, runId, "quick\nFAKE_ANSWER=fine")).json.outcome, "started");
  const next = await wait(env, runId);
  assert.deepEqual([next.json.ok, next.json.text], [true, "fine"]);
});

test("a turn that ignores the interrupt gets the app-server killed after killGraceMs; the session is dormant, revivable", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "stuck\nFAKE_HANG=1", tier: "light", timeoutSec: 2 });
  const out = await wait(env, runId, 40);
  assert.equal(out.json.error.kind, "timeout", out.stdout);
  assert.match(out.json.error.message, /did not end the turn when interrupted/);
  assert.equal(out.json.session.state, "dormant");
  const server = spawns(calls())[0];
  assert.ok(await eventually(() => !pidAlive(server.pid)), "the hung app-server is gone");
  assert.ok(await untilState(home, runId, "dormant"));
  assert.equal(hasResult(home, runId), false);
  assert.equal(sessionEvents(home, runId).at(-1).type, "dormant");
  // a message revives it
  assert.equal((await send(env, runId, "again\nFAKE_ANSWER=back")).json.outcome, "started");
  assert.equal((await wait(env, runId)).json.text, "back");
  assert.equal(requests(calls(), "thread/resume").length, 1);
});

test("an app-server that dies mid-turn fails that turn (execution) and leaves the session dormant, not restarted in a loop", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "boom\nFAKE_CRASH=1", tier: "light" });
  const out = await wait(env, runId, 40);
  assert.equal(out.code, 1, out.stdout);
  assert.deepEqual([out.json.ok, out.json.state, out.json.error.kind], [false, "failed", "execution"]);
  assert.match(out.json.error.message, /app-server exited/);
  assert.equal(out.json.session.state, "dormant");
  assert.ok(await untilState(home, runId, "dormant"));
  assert.equal(serverSpawns(calls()).length, 1, "no automatic restart");
  assert.equal(hasResult(home, runId), false, "the session can be revived");
  const completed = sessionEvents(home, runId).filter((event) => event.type === "turn_completed");
  assert.deepEqual(completed.map((event) => [event.status, event.ok]), [["failed", false]]);
  assert.equal((await send(env, runId, "recover\nFAKE_ANSWER=up")).json.outcome, "started");
  assert.equal((await wait(env, runId)).json.text, "up");
  assert.equal(serverSpawns(calls()).length, 2);
});

test("a revive that cannot resume the thread fails that turn and leaves the session dormant", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "a\nFAKE_ANSWER=a", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, runId)).code, 0);
  assert.ok(await untilState(home, runId, "dormant"));
  env.FAKE_CODEX_RESUME_FAILS = "1";
  const ack = await send(env, runId, "b");
  assert.equal(ack.json.outcome, "started");
  const failed = await wait(env, runId, 40);
  assert.equal(failed.json.ok, false, failed.stdout);
  assert.equal(failed.json.session.turn, 2);
  assert.match(failed.json.error.message, /no rollout found/);
  assert.ok(await untilState(home, runId, "dormant"));
  assert.equal(requests(calls(), "turn/start").length, 1);
  assert.equal(hasResult(home, runId), false, "the session is still there for a later try");
});

test("the event file is capped: past the cap only structural events are kept", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_EVENT_CAP_BYTES: "1500" });
  const runId = await startSession(env, home, { task: "chatty\nFAKE_ANSWER=end", tier: "light" });
  assert.equal((await wait(env, runId)).code, 0);
  const second = await send(env, runId, "again\nFAKE_ANSWER=end2");
  assert.equal(second.json.outcome, "started");
  assert.equal((await wait(env, runId)).json.text, "end2");
  const events = sessionEvents(home, runId);
  const types = events.map((event) => event.type);
  // the first turn crossed the cap (a command event alone is about a kilobyte): its later chatty events are gone
  const afterFirst = types.indexOf("idle") + 1;
  assert.ok(types.slice(0, afterFirst).includes("command_started") && !types.slice(0, afterFirst).includes("tool"), "the first turn was recorded until the cap");
  const late = types.slice(afterFirst);
  assert.deepEqual(late.filter((type) => type !== "idle"), ["followup", "turn_started", "message", "turn_completed"], "only structural events and the final answer");
  for (const chatty of ["command_started", "command", "file_change", "plan", "tool"]) assert.equal(late.includes(chatty), false, chatty);
  assert.equal(events.filter((event) => event.type === "message" && event.phase === "commentary").length, 1, "commentary stops");
  assert.ok(events.some((event) => event.type === "message" && event.phase === "final_answer" && event.text === "end2"), "final answers are kept");
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1), "seq has no gaps");
  assert.equal(readState(home, runId).eventsCapped, true);
});

test("an ephemeral session ends instead of sleeping: nothing could revive an unsaved thread", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "e\nFAKE_ANSWER=e", tier: "light", ephemeral: true, idleTtlSec: 1 });
  assert.equal((await wait(env, runId)).json.text, "e");
  assert.equal(requests(calls(), "thread/start")[0].params.ephemeral, true);
  assert.ok(await eventually(() => hasResult(home, runId), { timeoutMs: 20_000 }));
  assert.equal(readJson(path.join(runDir(home, runId), "result.json")).state, "closed");
  assert.equal(sessionEvents(home, runId).some((event) => event.type === "dormant"), false);
});

test("a session can resume an existing thread, with images and a service tier", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const image = path.join(home, "shot.png");
  fs.writeFileSync(image, "png");
  const thread = "01a0fake-ex7e-7000-8000-000000000001";
  const runId = await startSession(env, home, { task: "continue\nFAKE_ANSWER=resumed", tier: "light", resume: { sessionId: thread }, images: [image], serviceTier: "priority", sandbox: "workspace-write" });
  const out = await wait(env, runId);
  assert.equal(out.code, 0, out.stdout);
  assert.deepEqual([out.json.provenance.threadId, out.json.provenance.mode, out.json.text], [thread, "resume", "resumed"]);
  assert.equal(requests(calls(), "thread/start").length, 0);
  const resume = requests(calls(), "thread/resume")[0].params;
  assert.deepEqual([resume.threadId, resume.sandbox, resume.approvalPolicy, resume.serviceTier, resume.cwd], [thread, "workspace-write", "never", "priority", process.cwd()]);
  const input = requests(calls(), "turn/start")[0].params.input;
  assert.deepEqual(input.map((part) => part.type), ["text", "localImage"]);
  assert.equal(input[1].path, image);
  assert.ok(spawns(calls())[0].flags.includes('service_tier="priority"'));
  const started = sessionEvents(home, runId).find((event) => event.type === "session_started");
  assert.deepEqual([started.threadId, started.askOrchestrator], [thread, false], "a resumed thread cannot gain the ask tool");
});

test("a session holds a machine-wide slot only while a turn runs", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_MAX_CONCURRENT: "1" });
  const a = await startSession(env, home, { task: "a\nFAKE_TURN_MS=2500\nFAKE_ANSWER=a", tier: "light" });
  assert.ok(await untilEvent(home, a, (event) => event.type === "command"));
  const b = await startSession(env, home, { task: "b\nFAKE_ANSWER=b", tier: "light" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(readState(home, b).state, "queued", "b waits for a's slot");
  assert.equal(sessionEvents(home, b).some((event) => event.type === "turn_started"), false);
  assert.equal((await wait(env, a)).json.text, "a");
  assert.equal((await wait(env, b)).json.text, "b");
  const doneA = sessionEvents(home, a).find((event) => event.type === "turn_completed");
  const startB = sessionEvents(home, b).find((event) => event.type === "turn_started");
  assert.ok(Date.parse(startB.t) >= Date.parse(doneA.t) - 50, "b's turn began after a's ended");
  // both idle now: nobody holds a slot
  assert.ok(await eventually(() => !fs.existsSync(path.join(home, "slots")) || fs.readdirSync(path.join(home, "slots")).filter((name) => /^slot-\d+$/.test(name)).length === 0));
});

test("onOrphan: an unpolled running turn is torn down under stop; an idle session is never abandoned; cancel --orphaned spares it", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const stopped = await startSession(env, home, { task: "no one is watching\nFAKE_TURN_MS=60000", tier: "light", orphanAfterSec: 2, onOrphan: "stop" });
  // keep it attached until the turn runs (a caller that never polled would be abandoned before it started)
  assert.ok(await eventually(async () => {
    await runCli(["wait", stopped, "--max-wait", "0"], { env });
    return sessionEvents(home, stopped).some((event) => event.type === "command");
  }, { timeoutMs: 30_000, stepMs: 200 }));
  assert.ok(await eventually(() => hasResult(home, stopped), { timeoutMs: 30_000 }), "abandoned after nobody polled");
  const ended = readJson(path.join(runDir(home, stopped), "result.json"));
  assert.deepEqual([ended.state, ended.error.kind], ["abandoned", "abandoned"]);
  assert.equal(readJson(path.join(runDir(home, stopped), "turns", "1.json")).error.kind, "abandoned");
  assert.equal(requests(calls(), "turn/interrupt").length, 1);

  const idle = await startSession(env, home, { task: "quick\nFAKE_ANSWER=q", tier: "light", orphanAfterSec: 1, onOrphan: "stop" });
  assert.equal((await wait(env, idle)).code, 0);
  await new Promise((resolve) => setTimeout(resolve, 3000)); // unpolled for three times its orphanAfterSec
  assert.equal(readState(home, idle).state, "idle");
  assert.equal(hasResult(home, idle), false);
  const swept = await runCli(["cancel", "--orphaned"], { env });
  assert.deepEqual(swept.json.cancelled, [], "an idle session is revivable, not orphaned work");
  assert.equal(readState(home, idle).state, "idle");
});

test("status lists sessions with their state", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "s\nFAKE_ANSWER=s", tier: "light", label: "my session" });
  assert.equal((await wait(env, runId)).code, 0);
  const all = (await runCli(["status"], { env })).json;
  const row = all.runs.find((entry) => entry.runId === runId);
  assert.deepEqual([row.label, row.state, row.session, row.turn, row.supervisorAlive], ["my session", "idle", true, 1, true]);
});
