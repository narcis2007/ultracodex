// Sessions, part 3: idle -> dormant -> revived (also after a crash or a reboot), the supervisor
// lock, close, cancel and gc.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RUNNER, eventually, pidAlive, runCli } from "./helpers.mjs";
import { hasResult, jsonLines, readJson, readState, requests, runDir, sessionEvents, sessionHome, spawns, startSession, untilEvent, untilState, wait } from "./helpers-session.mjs";

const send = (env, runId, message, ...rest) => runCli(["send", runId, "--message", message, ...rest], { env });
const result = (home, runId) => readJson(path.join(runDir(home, runId), "result.json"));

test("after idleTtlSec the session goes dormant: no supervisor, no app-server; the next message revives it with the sandbox it asked for", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-extra-"));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const runId = await startSession(env, home, { task: "first\nFAKE_ANSWER=one", tier: "light", sandbox: "workspace-write", idleTtlSec: 1, addDirs: [extra] });
  assert.equal((await wait(env, runId)).json.text, "one");
  const supervisorPid = readState(home, runId).supervisorPid;
  assert.ok(pidAlive(supervisorPid));
  assert.ok(await untilState(home, runId, "dormant"), "dormant after the idle time");
  const first = spawns(calls())[0];
  assert.ok(await eventually(() => !pidAlive(supervisorPid) && !pidAlive(first.pid)), "the supervisor and the app-server are gone");
  assert.equal(readState(home, runId).supervisorPid, null);
  assert.equal(hasResult(home, runId), false, "dormant is not finished");
  assert.equal(fs.existsSync(path.join(runDir(home, runId), "supervisor.lock")), false, "the lock is released");
  assert.deepEqual(sessionEvents(home, runId).slice(-2).map((event) => event.type), ["idle", "dormant"]);
  // a plain wait on a dormant session returns the latest turn at once
  const dormantWait = await runCli(["wait", runId, "--max-wait", "1"], { env });
  assert.deepEqual([dormantWait.code, dormantWait.json.text, dormantWait.json.session.state], [0, "one", "dormant"]);
  const status = (await runCli(["status", runId], { env })).json.runs[0];
  assert.deepEqual([status.state, status.supervisorAlive, status.turnActive], ["dormant", false, false]);

  // the next message revives it: a new supervisor, thread/resume with the requested sandbox, a new turn
  const ack = await send(env, runId, "second\nFAKE_ANSWER=two");
  assert.deepEqual([ack.code, ack.json.outcome, ack.json.turn], [0, "started", 2], ack.stdout);
  const second = await wait(env, runId);
  assert.equal(second.json.text, "two");
  assert.equal(second.json.session.turn, 2);
  assert.equal(second.json.provenance.threadId, readState(home, runId).threadId);
  assert.equal(spawns(calls()).length, 2, "one app-server per awake period");
  const resume = requests(calls(), "thread/resume")[0].params;
  assert.deepEqual([resume.threadId, resume.sandbox, resume.approvalPolicy, resume.excludeTurns], [second.json.provenance.threadId, "workspace-write", "never", true]);
  assert.deepEqual(spawns(calls())[1].flags.filter((flag) => flag.startsWith("sandbox_workspace_write")), ["sandbox_workspace_write.network_access=false", `sandbox_workspace_write.writable_roots=${JSON.stringify([extra])}`]);
  assert.equal(requests(calls(), "thread/start").length, 1);
  const events = sessionEvents(home, runId);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1), "seq continues over the revive");
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("dormant") < types.indexOf("resumed"));
  assert.deepEqual(events.find((event) => event.type === "resumed").reason, "revive");
  assert.deepEqual(second.json.provenance.usageTotal.input_tokens, 240, "usage totals continue over the revive");
});

test("idleTtlSec 0 sleeps after every turn", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "a\nFAKE_ANSWER=a", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, runId)).json.text, "a");
  assert.ok(await untilState(home, runId, "dormant"));
  assert.equal((await send(env, runId, "b\nFAKE_ANSWER=b")).json.outcome, "started");
  assert.equal((await wait(env, runId)).json.text, "b");
});

test("a supervisor that died (a crash, a reboot) is replaced by the next message; two senders get one supervisor", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "first\nFAKE_ANSWER=one", tier: "light" });
  assert.equal((await wait(env, runId)).json.text, "one");
  const state = readState(home, runId);
  const lock = path.join(runDir(home, runId), "supervisor.lock");
  assert.equal(readJson(lock).pid, state.supervisorPid);
  process.kill(state.supervisorPid); // this test's own supervisor: no reboot needed to make it gone
  assert.ok(await eventually(() => !pidAlive(state.supervisorPid) && !pidAlive(spawns(calls())[0].pid)), "the app-server follows its supervisor (its stdin closes)");
  assert.equal(readState(home, runId).state, "idle", "the state still says idle: nobody wrote otherwise");
  assert.equal(fs.existsSync(lock), true, "a dead supervisor leaves its lock behind");
  assert.equal((await runCli(["status", runId], { env })).json.runs[0].supervisorAlive, false);

  const [a, b] = await Promise.all([send(env, runId, "from a\nFAKE_ANSWER=A"), send(env, runId, "from b\nFAKE_ANSWER=B")]);
  for (const ack of [a, b]) assert.ok(["started", "queued"].includes(ack.json.outcome), ack.stdout);
  assert.deepEqual([a.json.turn, b.json.turn].sort(), [2, 3], "each message got its own turn");
  const last = await wait(env, runId);
  assert.equal(last.json.session.turn, 3);
  assert.deepEqual([(await runCli(["result", runId, "--turn", "2"], { env })).json.ok, last.json.ok], [true, true]);
  assert.equal(spawns(calls()).length, 2, "only one new supervisor drove an app-server");
  assert.equal(requests(calls(), "thread/resume").length, 1);
  const holder = readJson(lock).pid;
  assert.ok(pidAlive(holder) && holder !== state.supervisorPid, "the lock belongs to the one new supervisor");
  const texts = requests(calls(), "turn/start").map((entry) => entry.params.input[0].text);
  assert.deepEqual(texts.slice(1).sort(), ["from a\nFAKE_ANSWER=A", "from b\nFAKE_ANSWER=B"]);
});

// The bug behind a flaky "two senders" run: two supervisors started together both took the dead
// supervisor's lock, one noticed at its first beat, and its driver — which starts seconds later, after
// the Job Object helper — still published its (stale) state at start-up. When that landed after the
// winner's last publish the session said "queued" for ever and `wait` never returned the result.
test("a supervisor that lost the session lock writes nothing to the session afterwards", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_ACK_WAIT_MS: "0" });
  const runId = await startSession(env, home, { task: "first\nFAKE_ANSWER=one", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, runId)).json.text, "one");
  assert.ok(await untilState(home, runId, "dormant"));
  const lock = path.join(runDir(home, runId), "supervisor.lock");
  const log = path.join(runDir(home, runId), "supervisor.log");
  const logged = (text) => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes(text);

  // a revive whose driver starts four seconds after its supervisor took the lock
  const slow = { ...env, ULTRACODEX_SESSION_START_DELAY_MS: "4000" };
  assert.equal((await send(slow, runId, "again\nFAKE_ANSWER=two")).json.outcome, "pending", "not acknowledged: nobody has read it yet");
  assert.ok(await eventually(() => fs.existsSync(lock) && Number.isInteger(readJson(lock).pid) && readJson(lock).pid !== process.pid));
  // another supervisor takes the lock from it (this process stands in for the winner, which is alive)
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), runner: "test" }));
  assert.ok(await eventually(() => logged("the session lock now belongs to another supervisor"), { timeoutMs: 20_000 }));
  // what the winner has published meanwhile
  const statePath = path.join(runDir(home, runId), "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ ...readJson(statePath), state: "idle", winnersMark: true }));
  assert.ok(await eventually(() => logged("fenced off; leaving the session"), { timeoutMs: 30_000 }), "the fenced supervisor leaves");
  assert.deepEqual([readState(home, runId).state, readState(home, runId).winnersMark], ["idle", true], "and leaves the winner's state as it found it");
  fs.rmSync(lock, { force: true });
});

test("a second supervisor for a live session leaves at once and touches nothing", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "x", tier: "light" });
  assert.equal((await wait(env, runId)).code, 0);
  const holder = readState(home, runId).supervisorPid;
  // a second supervisor for the same run leaves at once; the first keeps the session
  const { spawn } = await import("node:child_process");
  const intruder = spawn(process.execPath, [RUNNER, "supervise", runId], { env, stdio: "ignore", windowsHide: true });
  const code = await new Promise((resolve) => intruder.on("exit", resolve));
  assert.equal(code, 0);
  assert.equal(readJson(path.join(runDir(home, runId), "supervisor.lock")).pid, holder);
  assert.match(fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8"), /another supervisor owns this session/);
  assert.equal(spawns(calls()).length, 1);
  assert.equal(readState(home, runId).state, "idle", "the intruder did not touch the state");
});

test("close: an idle session ends for good; later messages are rejected as session_ended", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "done soon\nFAKE_ANSWER=fin", tier: "light" });
  assert.equal((await wait(env, runId)).json.text, "fin");
  const supervisorPid = readState(home, runId).supervisorPid;
  const closed = await runCli(["close", runId], { env });
  assert.deepEqual([closed.code, closed.json.ok, closed.json.outcome, closed.json.turn], [0, true, "closed", 1], closed.stdout);
  const ended = result(home, runId);
  assert.deepEqual([ended.state, ended.ok, ended.text, ended.session.ended, ended.session.turn], ["closed", true, "fin", "closed", 1], "the last turn's envelope with the final state");
  assert.ok(ended.mac && ended.resultHash);
  assert.equal(sessionEvents(home, runId).at(-1).type, "closed");
  assert.equal(readState(home, runId).state, "closed");
  assert.ok(await eventually(() => !pidAlive(supervisorPid) && !pidAlive(spawns(calls())[0].pid)), "nothing left running");
  assert.equal(requests(calls(), "thread/archive").length, 0, "the thread stays in Codex's history by default");
  const rejected = await send(env, runId, "anyone?");
  assert.deepEqual([rejected.code, rejected.json.ok, rejected.json.outcome, rejected.json.reason], [1, false, "rejected", "session_ended"]);
  // wait / result / status of an ended session are the usual ones
  const waited = await runCli(["wait", runId, "--max-wait", "1"], { env });
  assert.deepEqual([waited.code, waited.json.state, waited.json.text], [0, "closed", "fin"]);
  assert.equal((await runCli(["status", runId], { env })).json.runs[0].state, "closed");
  assert.equal((await runCli(["interrupt", runId], { env })).json.reason, "session_ended");
  const again = await runCli(["close", runId], { env });
  assert.deepEqual([again.code, again.json.outcome], [0, "closed"], "closing twice is harmless");
  const followed = await runCli(["events", runId, "--follow"], { env });
  assert.equal(JSON.parse(followed.stdout.trim().split("\n").at(-1)).reason, "ended");
});

test("close of a dormant session writes the end without spawning anything; --archive uses one short-lived app-server", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const quiet = await startSession(env, home, { task: "q\nFAKE_ANSWER=q", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, quiet)).code, 0);
  assert.ok(await untilState(home, quiet, "dormant"));
  const before = spawns(calls()).length;
  const closed = await runCli(["close", quiet], { env });
  assert.deepEqual([closed.code, closed.json.outcome], [0, "closed"], closed.stdout);
  assert.equal(spawns(calls()).length, before, "no app-server was started");
  assert.deepEqual([result(home, quiet).state, result(home, quiet).text], ["closed", "q"]);
  assert.equal(sessionEvents(home, quiet).at(-1).type, "closed");

  const archived = await startSession(env, home, { task: "a\nFAKE_ANSWER=a", tier: "light", idleTtlSec: 0 });
  const thread = (await wait(env, archived)).json.provenance.threadId;
  assert.ok(await untilState(home, archived, "dormant"));
  const spawned = spawns(calls()).length;
  const out = await runCli(["close", archived, "--archive"], { env });
  assert.deepEqual([out.code, out.json.outcome, out.json.archived], [0, "closed", true], out.stdout);
  assert.equal(spawns(calls()).length, spawned + 1, "archiving needs a short-lived app-server");
  assert.deepEqual(requests(calls(), "thread/archive").map((entry) => entry.params), [{ threadId: thread }]);
  assert.equal(result(home, archived).session.archived, true);
});

test("close of a live session: refused while a turn runs unless --force; --archive archives on the live server", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "busy\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const refused = await runCli(["close", runId], { env });
  assert.deepEqual([refused.code, refused.json.ok, refused.json.outcome, refused.json.reason], [1, false, "rejected", "turn_active"]);
  assert.equal(readState(home, runId).turnActive, true, "the turn goes on");
  assert.equal(hasResult(home, runId), false);
  const forced = await runCli(["close", runId, "--force", "--archive"], { env });
  assert.deepEqual([forced.code, forced.json.outcome, forced.json.archived], [0, "closed", true], forced.stdout);
  const ended = result(home, runId);
  assert.deepEqual([ended.state, ended.ok, ended.error.kind], ["closed", false, "interrupted"], "the interrupted turn is the last turn");
  assert.match(ended.error.message, /closed/);
  assert.equal(requests(calls(), "turn/interrupt").length, 1);
  assert.equal(requests(calls(), "thread/archive").length, 1);
  assert.equal(spawns(calls()).length, 1, "archived on the running app-server");
  const types = sessionEvents(home, runId).map((event) => event.type);
  assert.ok(types.indexOf("interrupt") < types.indexOf("turn_completed") && types.indexOf("turn_completed") < types.indexOf("closed"));
});

test("close with nothing ever completed: a failed-envelope result", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "never ends\nFAKE_HANG=1", tier: "light", timeoutSec: 600 });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const forced = await runCli(["close", runId, "--force"], { env });
  assert.equal(forced.json.outcome, "closed", forced.stdout);
  const ended = result(home, runId);
  assert.deepEqual([ended.state, ended.ok], ["closed", false]);
});

test("cancel stops a running session's turn and ends it as cancelled; a dormant one is cancelled without a process", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const supervisorPid = readState(home, runId).supervisorPid;
  const cancelled = await runCli(["cancel", runId], { env });
  assert.equal(cancelled.json.state, "cancelled", cancelled.stdout);
  assert.equal(cancelled.json.ok, false);
  assert.equal(cancelled.json.error.kind, "cancelled");
  assert.equal(requests(calls(), "turn/interrupt").length, 1, "the turn was interrupted first");
  assert.ok(await eventually(() => !pidAlive(supervisorPid) && !pidAlive(spawns(calls())[0].pid)));
  assert.equal(readJson(path.join(runDir(home, runId), "turns", "1.json")).error.kind, "cancelled");
  assert.equal(sessionEvents(home, runId).at(-1).type, "cancelled");
  assert.equal((await send(env, runId, "x")).json.reason, "session_ended");

  const dormant = await startSession(env, home, { task: "d\nFAKE_ANSWER=d", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, dormant)).code, 0);
  assert.ok(await untilState(home, dormant, "dormant"));
  const spawned = spawns(calls()).length;
  const out = await runCli(["cancel", dormant], { env });
  assert.deepEqual([out.json.state, out.json.error.kind], ["cancelled", "cancelled"], out.stdout);
  assert.equal(spawns(calls()).length, spawned);
});

test("gc removes dormant sessions older than the cutoff, never one whose supervisor is alive", async (t) => {
  const { home, env } = sessionHome(t);
  const dormant = await startSession(env, home, { task: "d", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, dormant)).code, 0);
  assert.ok(await untilState(home, dormant, "dormant"));
  const idle = await startSession(env, home, { task: "i", tier: "light", idleTtlSec: 600 });
  assert.equal((await wait(env, idle)).code, 0);
  const young = await runCli(["gc", "--older-than-days", "1"], { env });
  assert.deepEqual(young.json.removedRuns, [], "a freshly dormant session stays");
  // age the dormant one (and the idle one's state, which must not matter: its supervisor is alive)
  for (const [runId, days] of [[dormant, 3], [idle, 3]]) {
    const file = path.join(runDir(home, runId), "state.json");
    const state = readJson(file);
    const old = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ ...state, dormantAt: state.dormantAt ? old : undefined, updatedAt: old }));
  }
  const old = await runCli(["gc", "--older-than-days", "1"], { env });
  assert.deepEqual(old.json.removedRuns, [dormant]);
  assert.equal(fs.existsSync(runDir(home, dormant)), false);
  assert.equal(fs.existsSync(runDir(home, idle)), true, "a live session is never collected");
  assert.equal(jsonLines(path.join(home, "session.jsonl")).length > 0, true);
});

test("a message to a dormant session is never answered with the old turn: wait shows the session busy until the new turn is done; --message-file works", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_ACK_WAIT_MS: "0" });
  const runId = await startSession(env, home, { task: "first\nFAKE_ANSWER=old", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, runId)).json.text, "old");
  assert.ok(await untilState(home, runId, "dormant"));
  const file = path.join(home, "followup.txt");
  fs.writeFileSync(file, "second\nFAKE_TURN_MS=1500\nFAKE_ANSWER=new");
  const pending = await runCli(["send", runId, "--message-file", file], { env });
  assert.equal(pending.json.outcome, "pending", "no time to wait for the acknowledgement");
  const seen = [];
  for (let round = 0; round < 200; round += 1) {
    const out = await runCli(["wait", runId, "--max-wait", "0"], { env });
    seen.push(out.json.session?.turn !== undefined && out.json.text !== undefined ? out.json.text : `${out.json.state}`);
    if (out.json.text === "new") break;
    assert.notEqual(out.json.text, "old", `a wait returned the previous turn's answer (${seen.join(", ")})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(seen.at(-1), "new", seen.join(", "));
});

test("interrupt and answer on a session with no supervisor revive nothing", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "q", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, runId)).code, 0);
  assert.ok(await untilState(home, runId, "dormant"));
  const before = spawns(calls()).length;
  const interrupted = await runCli(["interrupt", runId], { env });
  assert.deepEqual([interrupted.code, interrupted.json.outcome, interrupted.json.reason], [1, "no_active_turn", "supervisor_not_running"]);
  const answered = await runCli(["answer", runId, "call-1", "--text", "x"], { env });
  assert.deepEqual([answered.code, answered.json.outcome], [1, "no_such_question"]);
  assert.equal(spawns(calls()).length, before);
  assert.equal(readState(home, runId).state, "dormant");
});

test("events --follow ends on dormant and counts as a poll", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "p\nFAKE_TURN_MS=2500", tier: "light", idleTtlSec: 1 });
  const heartbeat = () => Number(fs.readFileSync(path.join(runDir(home, runId), "heartbeat"), "utf8"));
  const before = heartbeat();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // following ends at idle first; follow again from there until the session sleeps
  const first = await runCli(["events", runId, "--follow", "--max-wait", "30"], { env });
  const idle = JSON.parse(first.stdout.trim().split("\n").at(-1));
  assert.equal(idle.reason, "idle");
  assert.ok(heartbeat() > before, "following refreshed the heartbeat");
  assert.ok(await untilState(home, runId, "dormant"));
  const second = await runCli(["events", runId, "--follow", "--since", String(idle.lastSeq), "--max-wait", "30"], { env });
  assert.equal(second.code, 0);
  const lines = second.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.type), ["dormant", "follow_end"]);
  assert.deepEqual([lines[1].reason, lines[1].state], ["dormant", "dormant"]);
});

test("a crashed supervisor mid-turn: wait reports it lost (and how to go on); the next send revives, the turn it lost is recorded as failed", async (t) => {
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_LOST_AFTER_MS: "1500" });
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const supervisorPid = readState(home, runId).supervisorPid;
  process.kill(supervisorPid);
  assert.ok(await eventually(() => !pidAlive(supervisorPid) && !pidAlive(spawns(calls())[0].pid)));
  const followed = await runCli(["events", runId, "--follow", "--max-wait", "20"], { env });
  const endLine = JSON.parse(followed.stdout.trim().split("\n").at(-1));
  assert.deepEqual([followed.code, endLine.reason, endLine.state], [0, "dormant", "lost"], "a follower is told that nothing runs any more");
  const lost = await runCli(["wait", runId, "--max-wait", "20"], { env });
  assert.deepEqual([lost.code, lost.json.state, lost.json.error.kind], [1, "lost", "supervisor_lost"], lost.stdout);
  assert.match(lost.json.error.message, /`send` revives the session/);
  const ack = await send(env, runId, "carry on\nFAKE_ANSWER=resumed");
  assert.deepEqual([ack.json.outcome, ack.json.turn], ["started", 2], ack.stdout);
  const out = await wait(env, runId);
  assert.deepEqual([out.json.ok, out.json.text, out.json.session.turn], [true, "resumed", 2]);
  const lostTurn = readJson(path.join(runDir(home, runId), "turns", "1.json"));
  assert.deepEqual([lostTurn.ok, lostTurn.error.kind], [false, "execution"]);
  assert.match(lostTurn.error.message, /supervisor of this session stopped/);
  assert.deepEqual(sessionEvents(home, runId).filter((event) => event.type === "turn_completed").map((event) => event.ok), [false, true]);
});

test("a supervisor whose lock was taken over stops without touching the session", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "x", tier: "light" });
  assert.equal((await wait(env, runId)).code, 0);
  const supervisorPid = readState(home, runId).supervisorPid;
  const lock = path.join(runDir(home, runId), "supervisor.lock");
  const stateFile = path.join(runDir(home, runId), "state.json");
  const before = fs.readFileSync(stateFile, "utf8");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); // another supervisor, as far as it can tell
  assert.ok(await eventually(() => !pidAlive(supervisorPid) && !pidAlive(spawns(calls())[0].pid)), "the fenced supervisor and its app-server are gone");
  assert.equal(fs.readFileSync(stateFile, "utf8"), before, "nothing was written");
  assert.equal(hasResult(home, runId), false);
  assert.equal(sessionEvents(home, runId).some((event) => event.type === "dormant" || event.type === "closed"), false);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid, "the new owner's lock is left alone");
  assert.match(fs.readFileSync(path.join(runDir(home, runId), "supervisor.log"), "utf8"), /lock now belongs to another supervisor/);
  fs.rmSync(lock); // so that the test's cleanup can close the session
});

// The supervisor writes result.json first and acknowledges afterwards; a command polling for its
// acknowledgement must not mistake that gap for "the session ended without me".
const finalAckDelay = (ms) => ({ ULTRACODEX_TEST_FINAL_ACK_DELAY_MS: String(ms) });

test("close is reported as closed (exit 0) even when its ack is written well after result.json", async (t) => {
  const { home, env } = sessionHome(t, finalAckDelay(1500));
  const idle = await startSession(env, home, { task: "q\nFAKE_ANSWER=q", tier: "light" });
  assert.equal((await wait(env, idle)).code, 0);
  const started = Date.now();
  const closed = await runCli(["close", idle], { env });
  assert.deepEqual([closed.code, closed.json.ok, closed.json.outcome], [0, true, "closed"], closed.stdout);
  assert.ok(Date.now() - started >= 1200, "the acknowledgement really came after result.json (the race happened)");
  assert.equal(result(home, idle).state, "closed");

  // the failing shape: a running turn, close --force --archive
  const live = await startSession(env, home, { task: "busy\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, live, (event) => event.type === "command"));
  const forced = await runCli(["close", live, "--force", "--archive"], { env });
  assert.deepEqual([forced.code, forced.json.ok, forced.json.outcome, forced.json.archived], [0, true, "closed", true], forced.stdout);
  assert.equal(result(home, live).session.archived, true);
});

test("close without any ack within the grace still reports closed when the session ended closed; other messages report session_ended", async (t) => {
  const { home, env } = sessionHome(t, finalAckDelay(2500));
  const runId = await startSession(env, home, { task: "q\nFAKE_ANSWER=q", tier: "light" });
  assert.equal((await wait(env, runId)).code, 0);
  const tight = { ...env, ULTRACODEX_ACK_GRACE_MS: "100" };
  const closed = await runCli(["close", runId, "--archive"], { env: tight });
  assert.deepEqual([closed.code, closed.json.ok, closed.json.outcome, closed.json.archived, closed.json.turn], [0, true, "closed", true, 1], closed.stdout);
  assert.equal(result(home, runId).state, "closed");
  // the real ack is still written later (the supervisor was only delayed)
  assert.ok(await eventually(() => fs.readdirSync(path.join(runDir(home, runId), "outbox")).length === 1, { timeoutMs: 10_000 }));
});

test("a message that lands in the inbox as the session ends is rejected as session_ended, never lost; later sends are refused at once", async (t) => {
  const { home, env } = sessionHome(t, finalAckDelay(2500));
  const runId = await startSession(env, home, { task: "q\nFAKE_ANSWER=q", tier: "light" });
  assert.equal((await wait(env, runId)).code, 0);
  const closing = runCli(["close", runId], { env }); // not awaited: its ack is held back
  assert.ok(await eventually(() => hasResult(home, runId), { timeoutMs: 20_000, stepMs: 20 }), "result.json is written first");
  // a message that arrived after the supervisor last looked at its inbox, but before it acknowledged anything
  const id = `${Date.now().toString(36).padStart(9, "0")}-deadbeef`;
  fs.writeFileSync(path.join(runDir(home, runId), "inbox", `${id}.json`), JSON.stringify({ id, kind: "send", text: "late", mode: "auto", createdAt: new Date().toISOString() }));
  const refused = await send(env, runId, "too late");
  assert.deepEqual([refused.code, refused.json.outcome, refused.json.reason], [1, "rejected", "session_ended"], "a command that starts after the end is refused up front");
  assert.ok(await eventually(() => fs.existsSync(path.join(runDir(home, runId), "outbox", `${id}.json`)), { timeoutMs: 15_000 }));
  const ack = readJson(path.join(runDir(home, runId), "outbox", `${id}.json`));
  assert.deepEqual([ack.outcome, ack.reason], ["rejected", "session_ended"]);
  assert.equal(fs.existsSync(path.join(runDir(home, runId), "inbox", `${id}.json`)), false, "moved to done");
  const closed = await closing;
  assert.deepEqual([closed.code, closed.json.outcome], [0, "closed"], closed.stdout);
});
