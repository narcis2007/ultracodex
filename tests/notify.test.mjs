// notify: the watcher behind Claude Code's Monitor tool, the plugin monitor and the MCP server's
// channel — one compact line per actionable event of one owner's sessions, a cursor so nothing is
// missed or repeated between watchers, a singleton lock for the plugin monitor.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { newRunId } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { ALL_OWNERS, Watcher, channelMessage } from "../plugins/ultracodex/scripts/notify.mjs";
import { RUNNER, eventually, makeHome, runCli } from "./helpers.mjs";
import { readState, sessionHome, settle, startSession, untilEvent } from "./helpers-session.mjs";

const hash = (owner) => createHash("sha256").update(owner).digest("hex").slice(0, 16);
const cursorFile = (home, owner, namespace = "") => path.join(home, "notify", `${namespace ? `${namespace}-` : ""}${hash(owner)}.json`);
const lockFile = (home, owner) => path.join(home, "notify", `${hash(owner)}.lock`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// `notify ...` to completion (give it --max-wait)
async function notify(env, args) {
  const out = await runCli(["notify", ...args], { env, timeoutMs: 60_000 });
  return { code: out.code, stderr: out.stderr, lines: out.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) };
}

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
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  t.after(() => child.kill());
  return {
    child,
    lines,
    exited,
    stop: () => child.kill(),
    until: (predicate, timeoutMs = 30_000) => eventually(() => lines.some(predicate), { timeoutMs, stepMs: 50 }),
  };
}

const ASK = (question, answer) => `decide\nASK: ${question}\nFAKE_ANSWER=${answer}`;

test("the owner's questions and finished turns arrive once each; other owners and quiet events stay silent", async (t) => {
  const { home, env } = sessionHome(t);
  const a = { ...env, ULTRACODEX_OWNER: "owner-a" };
  const b = { ...env, ULTRACODEX_OWNER: "owner-b" };
  const watch = watchProcess(t, a, ["--max-wait", "90"]);
  assert.ok(await eventually(() => fs.existsSync(cursorFile(home, "owner-a"))), "the watcher is up (its cursor file exists)");
  // sessions that appear after the watcher started are picked up from their first event
  const mine = await startSession(a, home, { task: ASK("which database?", "picked"), tier: "light", label: "db choice" });
  const theirs = await startSession(b, home, { task: ASK("which colour?", "red"), tier: "light" });
  assert.ok(await watch.until((line) => line.codex === "question" && line.runId === mine));
  const question = watch.lines.find((line) => line.codex === "question");
  assert.deepEqual(
    { ...question, hint: undefined },
    { codex: "question", runId: mine, label: "db choice", turn: 1, questionId: "call-1", question: "which database?", hint: undefined }
  );
  assert.match(question.hint, /codex_answer/);
  assert.ok(question.hint.includes(`answer ${mine} call-1 --text`));

  assert.equal((await runCli(["answer", mine, "call-1", "--text", "pg"], { env })).json.outcome, "answered");
  assert.ok(await untilEvent(home, theirs, (event) => event.type === "question"));
  assert.equal((await runCli(["answer", theirs, "call-1", "--text", "blue"], { env })).json.outcome, "answered");
  assert.ok(await watch.until((line) => line.codex === "turn_done"));
  assert.deepEqual(watch.lines.filter((line) => line.codex === "turn_done"), [{ codex: "turn_done", runId: mine, label: "db choice", turn: 1, ok: true, summary: "picked answered: pg" }]);
  assert.equal((await settle(env, theirs)).json.text, "red answered: blue");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(watch.lines.map((line) => [line.codex, line.runId]), [["question", mine], ["turn_done", mine]], "nothing for the other owner, nothing for messages, commands, answers or idle");
  assert.deepEqual(readJson(cursorFile(home, "owner-a"))[mine], sessionLastSeq(home, mine, "turn_completed"), "the cursor sits at the last line printed");
});

const sessionLastSeq = (home, runId, type) =>
  fs.readFileSync(path.join(home, "runs", runId, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === type).at(-1).seq;

test("a re-armed watcher resumes from its cursor, repeats nothing, loses nothing, and re-reports a question still waiting", async (t) => {
  const { home, env } = sessionHome(t);
  const a = { ...env, ULTRACODEX_OWNER: "owner-a" };
  const run = await startSession(a, home, { task: ASK("which?", "done"), tier: "light" });
  assert.ok(await untilEvent(home, run, (event) => event.type === "question"));
  const heartbeat = fs.readFileSync(path.join(home, "runs", run, "heartbeat"), "utf8");

  const first = await notify(a, ["--max-wait", "1"]);
  assert.equal(first.code, 0);
  assert.deepEqual(first.lines.map((line) => [line.codex, line.runId, line.questionId]), [["question", run, "call-1"]], "the pending question is printed at startup");
  const again = await notify(a, ["--max-wait", "1"]);
  assert.deepEqual(again.lines.map((line) => line.codex), ["question"], "and printed again by a re-armed watcher: nobody answered it yet");
  assert.equal(fs.readFileSync(path.join(home, "runs", run, "heartbeat"), "utf8"), heartbeat, "a notifier is no poller: it writes no heartbeat");
  assert.deepEqual(Object.keys(readJson(cursorFile(home, "owner-a"))), [run]);

  await runCli(["answer", run, "call-1", "--text", "pg"], { env });
  assert.equal((await settle(env, run)).json.text, "done answered: pg");
  const afterAnswer = await notify(a, ["--max-wait", "1"]);
  assert.deepEqual(afterAnswer.lines.map((line) => [line.codex, line.turn, line.summary]), [["turn_done", 1, "done answered: pg"]], "history before the cursor is not replayed; the turn that ended since is");
  assert.deepEqual((await notify(a, ["--max-wait", "1"])).lines, [], "and nothing twice");

  // a follow-up finishes while no watcher runs: the next one reports exactly that turn
  assert.equal((await runCli(["send", run, "--message", "second\nFAKE_ANSWER=two"], { env })).json.outcome, "started");
  assert.equal((await settle(env, run)).json.text, "two");
  assert.deepEqual((await notify(a, ["--max-wait", "1"])).lines.map((line) => [line.turn, line.summary]), [[2, "two"]]);

  // --from now ignores what the cursor holds: nothing that already happened
  assert.equal((await runCli(["send", run, "--message", "third\nFAKE_ANSWER=three"], { env })).json.outcome, "started");
  assert.equal((await settle(env, run)).json.text, "three");
  assert.deepEqual((await notify(a, ["--from", "now", "--max-wait", "1"])).lines, []);
  assert.deepEqual((await notify(a, ["--max-wait", "1"])).lines, [], "and it moved the cursor with it");
});

test("a run the cursor does not know begins at its end: history is not replayed", async (t) => {
  const { home, env } = sessionHome(t);
  const a = { ...env, ULTRACODEX_OWNER: "owner-a" };
  const run = await startSession(a, home, { task: "plain\nFAKE_ANSWER=one", tier: "light" });
  assert.equal((await settle(env, run)).json.text, "one");
  assert.ok(readState(home, run).turn === 1);
  assert.deepEqual((await notify(a, ["--max-wait", "1"])).lines, []);
});

test("without an owner notify says so and exits 1; --all, --owner and the option checks", async (t) => {
  const { home, env } = sessionHome(t);
  const none = await runCli(["notify", "--max-wait", "1"], { env });
  assert.equal(none.code, 1);
  assert.equal(none.stdout.trim(), JSON.stringify({ codex: "notify_unavailable", reason: "no owner (start the watcher from a Claude Code Bash command, or pass --owner/--all)" }));
  assert.equal((await runCli(["notify", "--owner", "owner-a", "--max-wait", "1"], { env })).code, 0, "--owner names it explicitly");
  assert.equal((await runCli(["notify", "--all", "--max-wait", "1"], { env })).code, 0);
  assert.equal((await runCli(["notify", "--owner", "bad owner", "--max-wait", "1"], { env })).code, 2);
  assert.equal((await runCli(["notify", "--all", "--owner", "owner-a"], { env })).code, 2);
  assert.equal((await runCli(["notify", "--forever", "--max-wait", "5", "--owner", "owner-a"], { env })).code, 2);
  assert.equal((await runCli(["notify", "--from", "yesterday", "--owner", "owner-a"], { env })).code, 2);
  // --all sees every owner's sessions
  const run = await startSession({ ...env, ULTRACODEX_OWNER: "owner-z" }, home, { task: ASK("any?", "ok"), tier: "light" });
  assert.ok(await untilEvent(home, run, (event) => event.type === "question"));
  assert.deepEqual((await notify(env, ["--all", "--max-wait", "1"])).lines.map((line) => line.runId), [run]);
  assert.deepEqual((await notify(env, ["--owner", "owner-a", "--max-wait", "1"])).lines, []);
  assert.ok(fs.existsSync(cursorFile(home, ALL_OWNERS)), "--all has a cursor of its own");
});

test("--max-wait ends the watcher quietly; --forever keeps one watcher per owner and a stale lock is taken over", async (t) => {
  const { home, env } = sessionHome(t);
  const a = { ...env, ULTRACODEX_OWNER: "owner-a" };
  const started = Date.now();
  const timed = await notify(a, ["--max-wait", "2"]);
  assert.deepEqual([timed.code, timed.lines, Date.now() - started >= 1800], [0, [], true]);

  const first = watchProcess(t, a, ["--forever"]);
  assert.ok(await eventually(() => fs.existsSync(lockFile(home, "owner-a"))));
  assert.equal(readJson(lockFile(home, "owner-a")).pid, first.child.pid);
  const second = await runCli(["notify", "--forever"], { env: a, timeoutMs: 20_000 });
  assert.deepEqual([second.code, second.stdout], [0, ""], "a second --forever watcher of the same owner leaves at once, silently");
  assert.equal(first.child.exitCode, null, "the first goes on");
  const other = watchProcess(t, { ...env, ULTRACODEX_OWNER: "owner-b" }, ["--forever"]);
  assert.ok(await eventually(() => fs.existsSync(lockFile(home, "owner-b"))), "another owner has its own lock");
  other.stop();

  // the first goes away; whatever it left behind is judged by its pid
  first.stop();
  await first.exited;
  const third = watchProcess(t, a, ["--forever"]);
  assert.ok(await eventually(() => fs.existsSync(lockFile(home, "owner-a")) && readJson(lockFile(home, "owner-a")).pid === third.child.pid), "a lock whose process is gone is taken over");
  assert.equal(third.child.exitCode, null);
  third.stop();
  await third.exited;
});

// ── classification, on hand-made run directories ──

let runCounter = 0;
function fakeRun(home, { owner = "owner-a", label = "job", state = {} } = {}) {
  runCounter += 1;
  const runId = newRunId(new Date(Date.UTC(2026, 9, 10, 12, 0, runCounter)));
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "running", runId, session: true, owner, label, turn: 1, ...state }));
  return { runId, dir, seq: 0 };
}

function addEvents(run, events, { complete = true } = {}) {
  const lines = events.map(([type, fields = {}]) => {
    run.seq += 1;
    return JSON.stringify({ seq: run.seq, t: "2026-10-10T12:00:00.000Z", turn: fields.turn ?? 1, type, ...fields });
  });
  fs.appendFileSync(path.join(run.dir, "events.jsonl"), lines.join("\n") + (complete ? "\n" : ""));
}

const writeTurn = (run, n, envelope) => fs.writeFileSync(path.join(run.dir, "turns", `${n}.json`), JSON.stringify(envelope));

// the watcher reads the home from the environment of this process
function useHome(t, home) {
  const previous = process.env.ULTRACODEX_HOME;
  process.env.ULTRACODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ULTRACODEX_HOME;
    else process.env.ULTRACODEX_HOME = previous;
  });
}

test("only actionable events become lines, with the fields the Monitor and the channel rely on", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const run = fakeRun(home);
  const watcher = new Watcher({ owner: "owner-a" });
  assert.deepEqual(watcher.init(), []);
  writeTurn(run, 1, { ok: true, text: "all   done\n\nand tested" });
  addEvents(run, [
    ["session_started", { threadId: "t" }],
    ["turn_started", { turnId: "x", reason: "task" }],
    ["message", { phase: "commentary", text: "hello" }],
    ["command_started", { command: "ls" }],
    ["command", { command: "ls", exitCode: 0 }],
    ["file_change", { changes: [] }],
    ["plan", { steps: [] }],
    ["tool", { name: "web_search" }],
    ["steer", { text: "left", outcome: "steered" }],
    ["followup", { text: "more" }],
    ["interrupt"],
    ["idle", { idleUntil: "x" }],
    ["dormant"],
    ["closed"],
    ["answer", { id: "other", auto: false }],
    ["question", { id: "call-9", question: "which   one?\n(a or b)" }],
    ["turn_completed", { status: "completed", ok: true, durationMs: 5, usage: null }],
    ["limit_wait", { resumesAt: null }],
    ["limit_wait", { resumesAt: "2026-10-10T13:00:00.000Z" }],
    ["resumed", { reason: "limit_reset" }],
    ["resumed", { reason: "revive" }],
    ["resumed", { reason: "account_change" }],
    ["account_switch", { status: "pending" }],
    ["turn_completed", { turn: 1, status: "interrupted", ok: false, kind: "account_switch" }], // the part handed over to a new account: no line
    ["error", { kind: "execution", message: "transient", willRetry: true }],
    ["error", { kind: "usage_limit", message: "the limit   was hit", willRetry: false }],
    ["hermetic_violation", { servers: ["github", "slack"] }],
    ["hermetic_violation", { servers: [] }],
    ["cancelled", {}],
  ]);
  const base = { runId: run.runId, label: "job" };
  assert.deepEqual(
    watcher.tick().map(({ out: { hint, ...line } }) => (hint === undefined ? line : { ...line, hint: "<hint>" })),
    [
      { codex: "question", ...base, turn: 1, questionId: "call-9", question: "which one? (a or b)", hint: "<hint>" },
      { codex: "turn_done", ...base, turn: 1, ok: true, summary: "all done and tested" },
      { codex: "limit_wait", ...base, resumesAt: "2026-10-10T13:00:00.000Z" },
      { codex: "resumed", ...base, reason: "limit_reset" },
      { codex: "resumed", ...base, reason: "account_change" },
      { codex: "error", ...base, kind: "usage_limit", message: "the limit was hit" },
      { codex: "error", ...base, kind: "hermetic_violation", message: "a hermetic session found MCP servers with tools: github, slack" },
      { codex: "error", ...base, kind: "hermetic_violation", message: "the hermetic check could not be completed" },
      { codex: "ended", ...base, state: "cancelled" },
    ]
  );
  assert.deepEqual(watcher.tick(), [], "each event once");
});

test("a question answered before the watcher looked is no news; the end of a failed session is reported after its error", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const run = fakeRun(home);
  const file = cursorFile(home, "owner-a");
  const watcher = new Watcher({ owner: "owner-a", cursorFile: file });
  watcher.init();
  addEvents(run, [["question", { id: "call-1", question: "q?" }], ["answer", { id: "call-1", auto: true }]]);
  assert.deepEqual(watcher.tick(), []);

  addEvents(run, [["error", { kind: "execution", message: "boom", willRetry: false }]]);
  fs.writeFileSync(path.join(run.dir, "result.json"), JSON.stringify({ ok: false, state: "failed", error: { kind: "execution" } }));
  const items = watcher.tick();
  assert.deepEqual(items.map((item) => item.out), [
    { codex: "error", runId: run.runId, label: "job", kind: "execution", message: "boom" },
    { codex: "ended", runId: run.runId, label: "job", state: "failed", kind: "execution" },
  ]);
  for (const item of items) watcher.commit(item);
  assert.deepEqual(readJson(file), { [run.runId]: 3, ended: { [run.runId]: true } });
  assert.deepEqual(watcher.tick(), [], "a finished and drained run is no longer watched");

  // a second watcher of the cursor does not repeat them
  const other = new Watcher({ owner: "owner-a", cursorFile: file });
  assert.deepEqual(other.init(), []);
  assert.deepEqual(other.tick(), []);
  // an item another watcher delivered meanwhile is skipped by this one
  const late = fakeRun(home);
  const slow = new Watcher({ owner: "owner-a", cursorFile: file });
  slow.init();
  slow.scan();
  addEvents(late, [["error", { kind: "execution", message: "x", willRetry: false }]]);
  const pending = slow.tick();
  new Watcher({ owner: "owner-a", cursorFile: file }).commit({ runId: late.runId, seq: 1 });
  assert.equal(slow.covered(pending[0]), true);
});

test("a turn's summary: the text, a schema result's status and summary, else its JSON; a failed turn says why", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const run = fakeRun(home);
  const watcher = new Watcher({ owner: "owner-a" });
  watcher.init();
  writeTurn(run, 1, { ok: true, result: { status: "complete", summary: "did it", tasks: [] } });
  writeTurn(run, 2, { ok: true, result: { verdict: "approve", summary: "looks fine", findings: [] } });
  writeTurn(run, 3, { ok: true, result: { score: 7, rationale: "x".repeat(900) } });
  writeTurn(run, 4, { ok: false, error: { kind: "timeout", message: "the turn ran out of time" } });
  writeTurn(run, 5, { ok: true, text: "y".repeat(900) });
  addEvents(run, [
    ["turn_completed", { turn: 1, status: "completed", ok: true }],
    ["turn_completed", { turn: 2, status: "completed", ok: true }],
    ["turn_completed", { turn: 3, status: "completed", ok: true }],
    ["turn_completed", { turn: 4, status: "failed", ok: false, kind: "timeout" }],
    ["turn_completed", { turn: 5, status: "completed", ok: true }],
    ["turn_completed", { turn: 6, status: "failed", ok: false, kind: "interrupted" }],
  ]);
  const lines = watcher.tick().map((item) => item.out);
  assert.equal(lines[0].summary, "complete: did it");
  assert.equal(lines[1].summary, "looks fine");
  assert.match(lines[2].summary, /^\{"score":7,"rationale":"x+\.\.\.$/);
  assert.equal(lines[2].summary.length, 400);
  assert.deepEqual([lines[3].ok, lines[3].kind, lines[3].summary], [false, "timeout", "the turn ran out of time"]);
  assert.equal(lines[4].summary.length, 400);
  assert.deepEqual([lines[5].kind, lines[5].summary], ["interrupted", ""], "no envelope, no summary");
});

test("the watcher copes with a half-written line, a damaged one, a shorter file, a removed run and sessions it does not own", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const run = fakeRun(home);
  const foreign = fakeRun(home, { owner: "owner-b" });
  const oneShot = fakeRun(home, { state: { session: false } });
  const watcher = new Watcher({ owner: "owner-a" });
  watcher.init();
  addEvents(foreign, [["question", { id: "x", question: "not yours" }]]);
  addEvents(oneShot, [["question", { id: "x", question: "not a session" }]]);
  // a line the supervisor is still writing is read once it is complete
  const events = path.join(run.dir, "events.jsonl");
  const line = (seq, extra) => JSON.stringify({ seq, t: "t", turn: 1, ...extra });
  fs.writeFileSync(events, `${line(1, { type: "question", id: "a", question: "q1" })}\n${line(2, { type: "question", id: "b", question: "q2" }).slice(0, 25)}`);
  assert.deepEqual(watcher.tick().map((item) => item.out.questionId), ["a"]);
  fs.appendFileSync(events, `${line(2, { type: "question", id: "b", question: "q2" }).slice(25)}\nthis is not json\n${line(3, { type: "question", id: "c", question: "q3" })}\n`);
  assert.deepEqual(watcher.tick().map((item) => item.out.questionId), ["b", "c"]);
  // a file that came back shorter does not stall the watcher
  fs.writeFileSync(events, `${line(4, { type: "question", id: "d", question: "q4" })}\n`);
  assert.deepEqual(watcher.tick().map((item) => item.out.questionId), ["d"]);
  // a run directory that is gc'ed in the middle of watching
  fs.rmSync(run.dir, { recursive: true, force: true });
  assert.deepEqual(watcher.tick(), []);
  assert.equal(watcher.tracked.size, 0);
  // ... and a session born later is found by the next scan, from its first event
  const born = fakeRun(home);
  addEvents(born, [["turn_started", { reason: "task" }], ["question", { id: "n", question: "fresh" }]]);
  watcher.scan();
  assert.deepEqual(watcher.tick().map((item) => [item.out.runId, item.out.questionId]), [[born.runId, "n"]]);
});

test("the cursor file is named by the owner's hash and a gc'ed run drops out of it", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const keep = fakeRun(home);
  const gone = fakeRun(home);
  addEvents(keep, [["idle"]]);
  addEvents(gone, [["idle"]]);
  const file = cursorFile(home, "owner-a");
  const watcher = new Watcher({ owner: "owner-a", cursorFile: file });
  watcher.init();
  assert.deepEqual(readJson(file), { [keep.runId]: 1, [gone.runId]: 1 });
  fs.rmSync(gone.dir, { recursive: true, force: true });
  addEvents(keep, [["error", { kind: "execution", message: "x", willRetry: false }]]);
  for (const item of watcher.tick()) watcher.commit(item);
  assert.deepEqual(readJson(file), { [keep.runId]: 2 });
});

test("channelMessage: one paragraph, identifier-only meta keys with string values", () => {
  const question = channelMessage({ codex: "question", runId: "20261010T120000Z-abc123", label: "Implement: Foo/bar", turn: 2, questionId: "call-4", question: "which db?", hint: "x" });
  assert.match(question.content, /^Codex session Implement: Foo\/bar \(20261010T120000Z-abc123\) asks: which db\? - answer with codex_answer\(/);
  assert.deepEqual(question.meta, { run_id: "20261010T120000Z-abc123", event: "question", turn: "2", question_id: "call-4", label_slug: "implement-foo-bar" });
  const done = channelMessage({ codex: "turn_done", runId: "20261010T120000Z-abc123", label: null, turn: 3, ok: true, summary: "shipped" });
  assert.match(done.content, /finished turn 3 \(ok\): shipped - read it with codex_result or continue with codex_send/);
  assert.deepEqual(done.meta, { run_id: "20261010T120000Z-abc123", event: "turn_done", turn: "3" });
  for (const message of [question, done, channelMessage({ codex: "ended", runId: "r", state: "failed", kind: "execution" }), channelMessage({ codex: "limit_wait", runId: "r", label: "x", resumesAt: null })]) {
    assert.ok(!message.content.includes("\n"));
    for (const [key, value] of Object.entries(message.meta)) assert.ok(/^[A-Za-z0-9_]+$/.test(key) && typeof value === "string", key);
  }
});

test("startup skips an ended session the cursor has caught up with, and still reports what it has not seen", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const done = fakeRun(home);
  const failed = fakeRun(home);
  const behind = fakeRun(home);
  addEvents(done, [["idle"], ["closed"]]);
  addEvents(failed, [["error", { kind: "execution", message: "x", willRetry: false }]]);
  addEvents(behind, [["idle"], ["cancelled"]]);
  fs.writeFileSync(path.join(done.dir, "result.json"), JSON.stringify({ ok: true, state: "closed" }));
  fs.writeFileSync(path.join(failed.dir, "result.json"), JSON.stringify({ ok: false, state: "failed", error: { kind: "execution" } }));
  fs.writeFileSync(path.join(behind.dir, "result.json"), JSON.stringify({ ok: false, state: "cancelled" }));
  const file = cursorFile(home, "owner-a");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [done.runId]: 2, [failed.runId]: 1, [behind.runId]: 1 }));
  const watcher = new Watcher({ owner: "owner-a", cursorFile: file });
  assert.deepEqual(watcher.init(), []);
  assert.deepEqual([...watcher.tracked.keys()], [failed.runId, behind.runId], "the caught-up closed session costs nothing");
  assert.deepEqual(watcher.tick().map((item) => [item.out.codex, item.out.runId, item.out.state]), [
    ["ended", failed.runId, "failed"],
    ["ended", behind.runId, "cancelled"],
  ]);
});

test("a usage-limit wait is one line: the first event that knows when usage is back, or null once the wait has lasted a while", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const run = fakeRun(home);
  const watcher = new Watcher({ owner: "owner-a", limitNullMs: 400 });
  watcher.init();
  const base = { runId: run.runId, label: "job" };
  const lines = () => watcher.tick().map((item) => item.out);
  const now = () => new Date().toISOString();

  // the supervisor announces the wait at once (no time yet), then again when a probe learns one
  addEvents(run, [["limit_wait", { resumesAt: null, t: now() }]]);
  assert.deepEqual(lines(), [], "no time yet: not reported");
  addEvents(run, [["limit_wait", { resumesAt: "2026-10-10T13:00:00.000Z", t: now() }]]);
  assert.deepEqual(lines(), [{ codex: "limit_wait", ...base, resumesAt: "2026-10-10T13:00:00.000Z" }], "the first event with a time is the line");
  addEvents(run, [["limit_wait", { resumesAt: "2026-10-10T13:05:00.000Z", t: now() }]]);
  assert.deepEqual(lines(), [], "a revised time is the same wait");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(lines(), []);

  // the time comes in the same batch as the announcement: one line, never the null one
  addEvents(run, [["resumed", { reason: "limit_reset" }]]);
  assert.deepEqual(lines().map((line) => line.codex), ["resumed"]);
  addEvents(run, [["turn_started", { reason: "continuation" }], ["limit_wait", { resumesAt: null, t: "2026-01-01T00:00:00.000Z" }], ["limit_wait", { resumesAt: "2026-10-11T00:00:00.000Z", t: now() }]]);
  assert.deepEqual(lines(), [{ codex: "limit_wait", ...base, resumesAt: "2026-10-11T00:00:00.000Z" }], "a new wait is reported again");

  // a wait that never learns a time is reported with null after a while, once
  addEvents(run, [["resumed", { reason: "account_change" }], ["limit_wait", { resumesAt: null, t: now() }]]);
  assert.deepEqual(lines().map((line) => line.codex), ["resumed"], "not yet");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(lines(), [{ codex: "limit_wait", ...base, resumesAt: null }]);
  assert.deepEqual(lines(), [], "once");
  addEvents(run, [["limit_wait", { resumesAt: "2026-10-11T01:00:00.000Z", t: now() }]]);
  assert.deepEqual(lines(), [], "a time that turns up late changes nothing: the wait was reported");

  // a wait that ends before it was due is not reported at all (its end is)
  addEvents(run, [["resumed", { reason: "account_change" }], ["limit_wait", { resumesAt: null, t: now() }]]);
  assert.deepEqual(lines().map((line) => line.codex), ["resumed"]);
  addEvents(run, [["resumed", { reason: "account_change" }]]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(lines().map((line) => line.codex), ["resumed"], "the null line never comes for a wait that is over");
  assert.deepEqual(lines(), []);

  // a wait already old when the watcher reads it, with nothing after it, is reported at once
  addEvents(run, [["limit_wait", { resumesAt: null, t: "2026-01-01T00:00:00.000Z" }]]);
  assert.deepEqual(lines(), [{ codex: "limit_wait", ...base, resumesAt: null }]);
});

// ── review findings ──

test("a re-armed watcher does not report the same usage-limit wait again; the next wait is reported", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const run = fakeRun(home);
  const file = cursorFile(home, "owner-a");
  const now = () => new Date().toISOString();
  // an earlier watcher delivers whatever its tick finds, the way watchLoop does
  const deliver = (watcher) => {
    const items = watcher.tick();
    for (const item of items) watcher.commit(item);
    return items.map((item) => [item.out.codex, item.out.resumesAt ?? item.out.reason ?? null]);
  };
  const first = new Watcher({ owner: "owner-a", cursorFile: file });
  first.init();
  addEvents(run, [["limit_wait", { resumesAt: null, t: now() }], ["limit_wait", { resumesAt: "2026-10-10T13:00:00.000Z", t: now() }]]);
  assert.deepEqual(deliver(first), [["limit_wait", "2026-10-10T13:00:00.000Z"]]);
  assert.equal(readJson(file).limit[run.runId], 2, "the cursor remembers which event reported the wait");

  // the Monitor watcher ended and is armed again: the probe's revised estimate is the same wait
  const second = new Watcher({ owner: "owner-a", cursorFile: file });
  assert.deepEqual(second.init(), []);
  addEvents(run, [["limit_wait", { resumesAt: "2026-10-10T13:05:00.000Z", t: now() }]]);
  assert.deepEqual(deliver(second), [], "still the same wait");
  addEvents(run, [["resumed", { reason: "limit_reset" }]]);
  assert.deepEqual(deliver(second), [["resumed", "limit_reset"]]);

  // armed again after that wait ended (the cursor covers its end): a new wait is news
  const third = new Watcher({ owner: "owner-a", cursorFile: file });
  assert.deepEqual(third.init(), []);
  addEvents(run, [["turn_started", { reason: "continuation" }], ["limit_wait", { resumesAt: "2026-10-11T00:00:00.000Z", t: now() }]]);
  assert.deepEqual(deliver(third), [["limit_wait", "2026-10-11T00:00:00.000Z"]]);
  addEvents(run, [["limit_wait", { resumesAt: "2026-10-11T00:05:00.000Z", t: now() }]]);
  const fourth = new Watcher({ owner: "owner-a", cursorFile: file });
  fourth.init();
  assert.deepEqual(deliver(fourth), [], "and that one is the same wait too, for whoever comes next");
});

test("a wait that was reported with no time stays reported across a re-armed watcher", async (t) => {
  const home = makeHome(t);
  useHome(t, home);
  const run = fakeRun(home);
  const file = cursorFile(home, "owner-a");
  const deliver = (watcher) => {
    const items = watcher.tick();
    for (const item of items) watcher.commit(item);
    return items.map((item) => [item.out.codex, item.out.resumesAt ?? null]);
  };
  const first = new Watcher({ owner: "owner-a", cursorFile: file, limitNullMs: 400 });
  first.init();
  addEvents(run, [["limit_wait", { resumesAt: null, t: "2026-01-01T00:00:00.000Z" }]]);
  assert.deepEqual(deliver(first), [["limit_wait", null]], "a wait that has gone on without a time is reported once");
  const second = new Watcher({ owner: "owner-a", cursorFile: file });
  second.init();
  addEvents(run, [["limit_wait", { resumesAt: "2026-10-10T13:00:00.000Z", t: new Date().toISOString() }]]);
  assert.deepEqual(deliver(second), [], "its time turning up later is not a second report");
});
