// Sessions, part 0: the small pieces that need no app-server — the supervisor lock, the event file
// reader, the inbox.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { TIMING, runPaths } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { EventLog, claimSupervisorLock, lastEventSeq, readNewEvents, sessionPendingMessages, sessionSupervisorAlive, writeInboxMessage } from "../plugins/ultracodex/scripts/session.mjs";
import { makeHome } from "./helpers.mjs";

function runDirectory(t) {
  const home = makeHome(t);
  const previous = process.env.ULTRACODEX_HOME;
  process.env.ULTRACODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ULTRACODEX_HOME;
    else process.env.ULTRACODEX_HOME = previous;
  });
  const runId = "20261009T120000Z-abcdef";
  const paths = runPaths(runId);
  fs.mkdirSync(paths.dir, { recursive: true });
  return paths;
}

// a PID that is certainly not alive: a process that has already exited
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

test("supervisor.lock: exclusive while its holder lives, taken over when the holder is gone, fenced when taken", async (t) => {
  const paths = runDirectory(t);
  const first = await claimSupervisorLock(paths);
  assert.ok(first);
  assert.equal(JSON.parse(fs.readFileSync(paths.lock, "utf8")).pid, process.pid);
  assert.equal(first.stillHeld(), true);
  assert.equal(sessionSupervisorAlive(paths), true);
  // a live holder (this process) is never taken from; the second claimant waits its time and gives up
  const started = Date.now();
  assert.equal(await claimSupervisorLock(paths, { waitMs: 300 }), null);
  assert.ok(Date.now() - started >= 250, "it waited");
  // the holder gone: its lock is stale and the next claim takes it over
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: await deadPid(), startedAt: Date.now() }));
  assert.equal(first.stillHeld(), false, "the first holder sees that the lock is no longer its own");
  assert.equal(sessionSupervisorAlive(paths), false);
  const second = await claimSupervisorLock(paths);
  assert.ok(second);
  assert.equal(second.stillHeld(), true);
  // release removes only one's own lock: the first supervisor's late release leaves the second's alone
  first.release();
  assert.equal(fs.existsSync(paths.lock), true);
  second.release();
  assert.equal(fs.existsSync(paths.lock), false);
  assert.equal(sessionSupervisorAlive(paths), false);
});

test("supervisor.lock: a live PID with a long silence (a reboot reused it) is stale; a half-written lock is left alone at first", async (t) => {
  const paths = runDirectory(t);
  // this process's PID, but the lock and the supervisor's `alive` file are far older than lostAfterMs
  const old = new Date(Date.now() - 3 * TIMING.lostAfterMs - 5000);
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: old.getTime() }));
  fs.utimesSync(paths.lock, old, old);
  fs.writeFileSync(paths.alive, String(old.getTime()));
  assert.equal(sessionSupervisorAlive(paths), false, "silence past lostAfterMs: not the supervisor any more");
  const taken = await claimSupervisorLock(paths);
  assert.ok(taken, "taken over");
  taken.release();
  // the same lock with a fresh heartbeat is a live supervisor
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  fs.utimesSync(paths.lock, old, old);
  fs.writeFileSync(paths.alive, String(Date.now()));
  assert.equal(sessionSupervisorAlive(paths), true);
  fs.rmSync(paths.lock);
  // a lock nobody finished writing: not taken for the first seconds
  fs.writeFileSync(paths.lock, "");
  assert.equal(await claimSupervisorLock(paths, { waitMs: 200 }), null);
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(paths.lock, stale, stale);
  assert.ok(await claimSupervisorLock(paths), "an empty lock that has sat there is debris");
});

test("EventLog: seq continues from the file; a half-written last line is not an event", (t) => {
  const paths = runDirectory(t);
  const first = new EventLog(paths.events, () => 3);
  const a = first.append("session_started", { threadId: "t" });
  assert.deepEqual([a.seq, a.turn, a.type, a.threadId], [1, 3, "session_started", "t"]);
  assert.ok(Date.parse(a.t));
  first.append("idle", {});
  // a revived supervisor continues the counter, whatever turn it starts from
  const second = new EventLog(paths.events, () => 4);
  assert.equal(second.append("resumed", { reason: "revive" }).seq, 3);
  // a line the supervisor was still writing when it died
  fs.appendFileSync(paths.events, '{"seq":4,"t":"x","turn":4,"type":"mes');
  assert.equal(lastEventSeq(paths.events), 3);
  const batch = readNewEvents(paths.events, 0);
  assert.deepEqual(batch.events.map(({ event }) => event.seq), [1, 2, 3]);
  assert.equal(readNewEvents(paths.events, batch.offset).events.length, 0, "nothing complete past the offset");
  fs.appendFileSync(paths.events, 'sage"}\n');
  const more = readNewEvents(paths.events, batch.offset);
  assert.deepEqual(more.events.map(({ event }) => [event.seq, event.type]), [[4, "message"]]);
  assert.equal(lastEventSeq(paths.events), 4);
  assert.equal(lastEventSeq(path.join(paths.dir, "missing.jsonl")), 0);
});

test("EventLog: past the cap only structural events are written", (t) => {
  const paths = runDirectory(t);
  const previous = process.env.ULTRACODEX_EVENT_CAP_BYTES;
  process.env.ULTRACODEX_EVENT_CAP_BYTES = "500";
  t.after(() => {
    if (previous === undefined) delete process.env.ULTRACODEX_EVENT_CAP_BYTES;
    else process.env.ULTRACODEX_EVENT_CAP_BYTES = previous;
  });
  const log = new EventLog(paths.events, () => 1);
  while (log.size < 500) assert.ok(log.append("command", { command: "x".repeat(100) }), "chatty events are kept while there is room");
  assert.equal(log.capped, false);
  for (const type of ["command_started", "command", "file_change", "plan", "tool"]) assert.equal(log.append(type, {}), null, type);
  assert.equal(log.append("message", { phase: "commentary", text: "x" }), null);
  assert.equal(log.append("message", { phase: null, text: "x" }), null);
  assert.equal(log.capped, true);
  for (const [type, fields] of [["message", { phase: "final_answer", text: "done" }], ["turn_completed", {}], ["question", {}], ["idle", {}], ["steer", {}], ["error", {}]]) {
    assert.ok(log.append(type, fields), type);
  }
  const seqs = readNewEvents(paths.events, 0).events.map(({ event }) => event.seq);
  assert.deepEqual(seqs, seqs.map((_, index) => index + 1), "a dropped event takes no seq: no gaps");
});

test("inbox: messages are written whole, listed oldest first, and nothing half-written or foreign is listed", async (t) => {
  const paths = runDirectory(t);
  assert.deepEqual(sessionPendingMessages(paths), []);
  const ids = [];
  for (const text of ["one", "two", "three"]) {
    ids.push(writeInboxMessage(paths, { kind: "send", text, mode: "auto" }).id);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(path.join(paths.inbox, `${ids[0]}.tmp-1`), "{");
  fs.writeFileSync(path.join(paths.inbox, "notes.txt"), "x");
  fs.writeFileSync(path.join(paths.inbox, "bad name.json"), "{}");
  fs.mkdirSync(paths.inboxDone, { recursive: true });
  const listed = sessionPendingMessages(paths);
  assert.deepEqual(listed.map((entry) => entry.id), ids);
  assert.deepEqual(listed.map((entry) => entry.message.text), ["one", "two", "three"]);
  assert.deepEqual([listed[0].message.kind, listed[0].message.mode], ["send", "auto"]);
  assert.ok(Date.parse(listed[0].message.createdAt));
  assert.match(ids[0], /^[a-z0-9][a-z0-9-]{7,63}$/);
  // a message the supervisor cannot read is still listed (it is acknowledged as invalid)
  fs.writeFileSync(path.join(paths.inbox, "zzzzzzzzz-00000000.json"), "not json");
  assert.equal(sessionPendingMessages(paths).at(-1).message, null);
});
