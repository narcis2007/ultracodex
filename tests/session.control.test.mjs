// Sessions, part 2: steer, follow-up, queue and interrupt — the messages Claude sends to a
// running session — and the answers it gets.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runCli } from "./helpers.mjs";
import { eventsOf, readState, requests, runDir, sessionEvents, sessionHome, startSession, untilEvent, untilState, wait } from "./helpers-session.mjs";

const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
const send = (env, runId, message, ...rest) => runCli(["send", runId, "--message", message, ...rest], { env });

test("send while a turn runs steers it: turn/steer with the active turn id, acknowledged as steered, reflected in the answer", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "long job\nFAKE_WAIT_STEER=1", schema: SCHEMA, tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"), "the turn is running");
  const ack = await send(env, runId, "go left, not right");
  assert.equal(ack.code, 0, ack.stdout);
  assert.deepEqual([ack.json.ok, ack.json.outcome, ack.json.turn, ack.json.runId], [true, "steered", 1, runId]);
  const final = await wait(env, runId);
  assert.equal(final.code, 0, final.stdout);
  assert.match(final.json.result.answer, /steered: \["go left, not right"\]/, "the steer reached Codex and changed its answer");
  const steer = requests(calls(), "turn/steer")[0].params;
  const turnId = requests(calls(), "turn/start").length && sessionEvents(home, runId).find((event) => event.type === "turn_started").turnId;
  assert.equal(steer.expectedTurnId, turnId);
  assert.equal(steer.threadId, final.json.provenance.threadId);
  assert.deepEqual(steer.input, [{ type: "text", text: "go left, not right", text_elements: [] }]);
  assert.equal(requests(calls(), "turn/start").length, 1, "a steer is not a new turn");
  const events = sessionEvents(home, runId);
  assert.deepEqual(events.find((event) => event.type === "steer"), { ...events.find((event) => event.type === "steer"), text: "go left, not right", outcome: "steered" });
  // the inbox message moved to done, and its acknowledgement is in the outbox
  const files = (dir) => fs.readdirSync(path.join(runDir(home, runId), dir));
  assert.equal(files("inbox").filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(files(path.join("inbox", "done")).length, 1);
  assert.equal(files("outbox").length, 1);
});

test("send when idle starts a new turn on the same thread with the same effort and schema; wait returns that turn", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "first\nFAKE_ANSWER=one", schema: SCHEMA, tier: "light", effort: "medium" });
  const first = await wait(env, runId);
  assert.equal(first.json.result.answer, "one");
  const ack = await send(env, runId, "second\nFAKE_ANSWER=two");
  assert.deepEqual([ack.code, ack.json.ok, ack.json.outcome, ack.json.turn], [0, true, "started", 2]);
  const second = await wait(env, runId);
  assert.equal(second.code, 0, second.stdout);
  assert.equal(second.json.result.answer, "two");
  assert.equal(second.json.session.turn, 2);
  assert.equal(second.json.provenance.threadId, first.json.provenance.threadId, "no new thread");
  assert.deepEqual(second.json.provenance.usage, first.json.provenance.usage, "usage is per turn");
  assert.equal(second.json.provenance.usageTotal.input_tokens, 240, "the total covers the whole session");
  const starts = requests(calls(), "turn/start");
  assert.equal(starts.length, 2);
  assert.deepEqual([starts[1].params.effort, starts[1].params.outputSchema, starts[1].params.threadId], ["medium", SCHEMA, first.json.provenance.threadId]);
  assert.deepEqual(starts[1].params.input, [{ type: "text", text: "second\nFAKE_ANSWER=two", text_elements: [] }], "a follow-up's input is the message as it is");
  assert.equal(requests(calls(), "thread/start").length, 1);
  const events = sessionEvents(home, runId);
  const followup = events.findIndex((event) => event.type === "followup");
  assert.ok(followup > 0 && events[followup + 1].type === "turn_started" && events[followup + 1].reason === "followup");
  assert.deepEqual((await runCli(["result", runId, "--turn", "1"], { env })).json.result, { answer: "one" });
  // seq keeps counting across turns
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
});

test("send --mode queue during a turn starts after it; --mode steer when idle is rejected", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "long\nFAKE_TURN_MS=2500\nFAKE_ANSWER=first", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const queued = await send(env, runId, "next\nFAKE_ANSWER=second", "--mode", "queue");
  assert.deepEqual([queued.code, queued.json.ok, queued.json.outcome, queued.json.turn], [0, true, "queued", 2]);
  assert.equal(readState(home, runId).queued, 1);
  assert.equal(requests(calls(), "turn/steer").length, 0, "queue never steers");
  assert.equal(requests(calls(), "turn/start").length, 1, "and does not start a turn while one runs");
  const second = await wait(env, runId);
  assert.equal(second.json.text, "second", "wait returns the queued turn, not the first");
  assert.equal(second.json.session.turn, 2);
  assert.equal((await runCli(["result", runId, "--turn", "1"], { env })).json.text, "first");
  assert.deepEqual(readState(home, runId).queued, 0);
  // idle: steer has nothing to steer
  const rejected = await send(env, runId, "too late", "--mode", "steer");
  assert.deepEqual([rejected.code, rejected.json.ok, rejected.json.outcome, rejected.json.reason], [1, false, "rejected", "no_active_turn"]);
  assert.equal(requests(calls(), "turn/start").length, 2, "nothing was started for the rejected message");
  // an empty message is a usage error, an all-blank one is rejected by the supervisor
  assert.equal((await runCli(["send", runId, "--message", "  "], { env })).code, 2);
});

test("a turn that cannot be steered queues the message (auto) or rejects it (steer)", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "review-like\nFAKE_NOT_STEERABLE=1\nFAKE_TURN_MS=2500\nFAKE_ANSWER=first", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const strict = await send(env, runId, "steer please", "--mode", "steer");
  assert.deepEqual([strict.json.outcome, strict.json.reason], ["rejected", "not_steerable"]);
  assert.equal(readState(home, runId).steerable, false, "known not steerable until the turn ends");
  const auto = await send(env, runId, "then this\nFAKE_ANSWER=second");
  assert.deepEqual([auto.json.outcome, auto.json.turn], ["queued", 2]);
  const steers = sessionEvents(home, runId).filter((event) => event.type === "steer");
  assert.deepEqual(steers.map((event) => event.outcome), ["not_steerable"], "only the first attempt reached Codex");
  assert.equal((await wait(env, runId)).json.text, "second");
});

test("interrupt ends the turn as interrupted (ok false, not retryable); the session is idle and takes a follow-up", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "endless\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const ack = await runCli(["interrupt", runId], { env });
  assert.deepEqual([ack.code, ack.json.ok, ack.json.outcome, ack.json.turn], [0, true, "interrupted", 1]);
  const waited = await wait(env, runId);
  assert.equal(waited.code, 1);
  assert.deepEqual([waited.json.ok, waited.json.state, waited.json.error.kind, waited.json.error.retryable], [false, "interrupted", "interrupted", false]);
  assert.equal(waited.json.session.state, "idle");
  assert.equal(requests(calls(), "turn/interrupt")[0].params.threadId, waited.json.provenance.threadId);
  const types = sessionEvents(home, runId).map((event) => event.type);
  assert.ok(types.indexOf("interrupt") < types.indexOf("turn_completed"));
  assert.equal(sessionEvents(home, runId).find((event) => event.type === "turn_completed").status, "interrupted");
  // nothing to interrupt now
  const again = await runCli(["interrupt", runId], { env });
  assert.deepEqual([again.code, again.json.ok, again.json.outcome], [1, false, "no_active_turn"]);
  // and the session still works
  assert.equal((await send(env, runId, "carry on\nFAKE_ANSWER=back")).json.outcome, "started");
  assert.equal((await wait(env, runId)).json.text, "back");
});

test("an unacknowledged send reports pending (exit 3) and is still processed", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_ACK_WAIT_MS: "0" });
  const runId = await startSession(env, home, { task: "hold\nFAKE_TURN_MS=1500\nFAKE_ANSWER=one", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const pending = await send(env, runId, "later\nFAKE_ANSWER=two", "--mode", "queue");
  assert.deepEqual([pending.code, pending.json.ok, pending.json.outcome], [3, null, "pending"]);
  assert.equal((await wait(env, runId)).json.text, "two", "the message was processed anyway");
});

test("events --follow prints new events and ends on idle; it is a poll", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "watch me\nFAKE_TURN_MS=1200\nFAKE_ANSWER=x", tier: "light" });
  const followed = await runCli(["events", runId, "--follow", "--max-wait", "30"], { env });
  assert.equal(followed.code, 0, followed.stdout);
  const lines = followed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const end = lines.at(-1);
  assert.deepEqual([end.type, end.reason, end.state], ["follow_end", "idle", "idle"]);
  assert.equal(end.lastSeq, lines.at(-2).seq);
  assert.deepEqual(lines.slice(0, -1).map((event) => event.type).slice(0, 2), ["session_started", "turn_started"]);
  assert.equal(lines.slice(0, -1).at(-1).type, "idle", "everything up to the idle event was printed");
  // a second follow from where it ended: the session is idle already, so it ends at once
  const again = await runCli(["events", runId, "--follow", "--since", String(end.lastSeq)], { env });
  assert.equal(again.code, 0);
  assert.deepEqual(again.stdout.trim().split("\n").map((line) => JSON.parse(line)).map((event) => [event.type, event.reason]), [["follow_end", "idle"]]);
  // while a turn runs, --max-wait ends the follow with exit 3
  await send(env, runId, "again\nFAKE_TURN_MS=5000");
  const short = await runCli(["events", runId, "--follow", "--since", String(end.lastSeq), "--max-wait", "1"], { env });
  assert.equal(short.code, 3);
  const last = JSON.parse(short.stdout.trim().split("\n").at(-1));
  assert.deepEqual([last.reason, last.state], ["max_wait", "running"]);
  assert.ok(await untilState(home, runId, "idle"));
  assert.ok((await eventsOf(env, runId)).length > end.lastSeq);
});

test("events reads a feed larger than one read (several megabytes) completely, in order", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "big\nFAKE_ANSWER=x", tier: "light" });
  assert.equal((await wait(env, runId)).code, 0);
  const file = path.join(runDir(home, runId), "events.jsonl");
  const have = sessionEvents(home, runId).length;
  const filler = "y".repeat(160);
  const lines = [];
  for (let seq = have + 1; seq <= have + 30_000; seq += 1) lines.push(JSON.stringify({ seq, t: "2026-10-09T00:00:00.000Z", turn: 1, type: "message", phase: "commentary", text: filler }));
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
  assert.ok(fs.statSync(file).size > 5 * 1024 * 1024, "more than one 4 MB read");
  const plain = await runCli(["events", runId, "--since", String(have - 1)], { env, timeoutMs: 120_000 });
  const seqs = plain.stdout.trim().split("\n").map((line) => JSON.parse(line).seq);
  assert.equal(seqs.length, 30_001);
  assert.deepEqual([seqs[0], seqs.at(-1)], [have, have + 30_000]);
  const followed = await runCli(["events", runId, "--follow", "--since", String(have + 29_990), "--max-wait", "30"], { env, timeoutMs: 120_000 });
  const out = followed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([out.length, out.at(-1).type, out.at(-1).lastSeq], [11, "follow_end", have + 30_000]);
});
