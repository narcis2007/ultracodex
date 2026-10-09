// Sessions, part 4: ask_orchestrator — Codex asks Claude a question through a client-side tool and
// waits for the answer — and the other requests an app-server may send its client.

import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "./helpers.mjs";
import { readState, requests, sessionEvents, sessionHome, settle, startSession, untilEvent, wait } from "./helpers-session.mjs";

const send = (env, runId, message, ...rest) => runCli(["send", runId, "--message", message, ...rest], { env });
// what the client answered to the fake's tool calls (the fake logs every answer it received)
const toolAnswers = (calls) => calls.filter((entry) => entry.kind === "answer").map((entry) => entry.result ?? entry.error);

test("a question: question event and state, wait and events --follow return early, answer reaches Codex", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "decide\nASK: which database?\nFAKE_ANSWER=picked", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "question"));
  const question = sessionEvents(home, runId).find((event) => event.type === "question");
  assert.deepEqual([question.id, question.question], ["call-1", "which database?"]);
  const state = readState(home, runId);
  assert.deepEqual([state.question.id, state.question.question], ["call-1", "which database?"]);
  assert.ok(Date.parse(state.question.since));
  assert.equal(state.state, "running");

  // wait returns at once with the question (exit 3, still running)
  const waited = await runCli(["wait", runId, "--max-wait", "20"], { env });
  assert.equal(waited.code, 3);
  assert.deepEqual([waited.json.ok, waited.json.state, waited.json.waitingForAnswer, waited.json.question], [null, "running", true, { id: "call-1", question: "which database?" }]);
  const status = (await runCli(["status", runId], { env })).json.runs[0];
  assert.deepEqual([status.state, status.waitingForAnswer], ["running", true]);
  // events --follow ends on it too
  const followed = await runCli(["events", runId, "--follow", "--max-wait", "20"], { env });
  assert.equal(followed.code, 3);
  const end = JSON.parse(followed.stdout.trim().split("\n").at(-1));
  assert.deepEqual([end.type, end.reason, end.state], ["follow_end", "question", "running"]);

  // the wrong id is no question; the right one is answered
  const wrong = await runCli(["answer", runId, "nope", "--text", "x"], { env });
  assert.deepEqual([wrong.code, wrong.json.ok, wrong.json.outcome], [1, false, "no_such_question"]);
  const answered = await runCli(["answer", runId, "call-1", "--text", "postgres"], { env });
  assert.deepEqual([answered.code, answered.json.ok, answered.json.outcome], [0, true, "answered"], answered.stdout);
  const final = await wait(env, runId);
  assert.equal(final.code, 0, final.stdout);
  assert.match(final.json.text, /picked answered: postgres$/);
  assert.deepEqual(toolAnswers(calls()), [{ contentItems: [{ type: "inputText", text: "postgres" }], success: true }]);
  assert.deepEqual(sessionEvents(home, runId).find((event) => event.type === "answer"), { ...sessionEvents(home, runId).find((event) => event.type === "answer"), id: "call-1", auto: false });
  assert.equal(readState(home, runId).question, null);
  // answered once: asking again is no question
  assert.equal((await runCli(["answer", runId, "call-1", "--text", "again"], { env })).json.outcome, "no_such_question");
  // a long answer travels from a file
  assert.equal((await runCli(["answer", runId, "call-1", "--file", "/no/such/file"], { env })).json.error.kind, "invalid_request");
});

test("an unanswered question gets an automatic reply after askTimeoutSec", async (t) => {
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_MIN_ASK_TIMEOUT_SEC: "1" });
  const runId = await startSession(env, home, { task: "ask me nothing\nASK: anyone there?\nFAKE_ANSWER=assumed", tier: "light", askTimeoutSec: 2 });
  const waited = await settle(env, runId); // waits return at once while the question is pending
  assert.equal(waited.code, 0, waited.stdout);
  assert.match(waited.json.text, /assumed answered: No answer from the orchestrator within 2 s\. Proceed with your best judgement and state the assumption you made in your final answer\.$/);
  assert.deepEqual(toolAnswers(calls()).map((answer) => answer.success), [true]);
  const answer = sessionEvents(home, runId).find((event) => event.type === "answer");
  assert.deepEqual([answer.id, answer.auto], ["call-1", true]);
});

test("a steer is allowed while a question is pending; it lands after the tool call returns", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "mixed\nASK: which?\nFAKE_WAIT_STEER=1\nFAKE_ANSWER=ok", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "question"));
  const steered = await send(env, runId, "also do X");
  assert.deepEqual([steered.json.outcome, steered.json.turn], ["steered", 1]);
  assert.equal((await runCli(["answer", runId, "call-1", "--text", "first"], { env })).json.outcome, "answered");
  const final = await wait(env, runId);
  assert.match(final.json.text, /steered: \["also do X"\] answered: first$/);
});

test("interrupt and cancel answer a pending question with success false; the deadline keeps running", async (t) => {
  const { home, env, calls } = sessionHome(t);
  // interrupt
  const one = await startSession(env, home, { task: "q\nASK: left or right?\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, one, (event) => event.type === "question"));
  assert.equal((await runCli(["interrupt", one], { env })).json.outcome, "interrupted");
  const interrupted = await wait(env, one);
  assert.equal(interrupted.json.error.kind, "interrupted", interrupted.stdout);
  assert.deepEqual(toolAnswers(calls())[0].success, false);
  assert.match(toolAnswers(calls())[0].contentItems[0].text, /interrupted/);
  assert.equal(sessionEvents(home, one).find((event) => event.type === "answer").auto, true);
  assert.equal(readState(home, one).question, null);
  // the deadline is not paused by a question
  const two = await startSession(env, home, { task: "q\nASK: anyone?", tier: "light", timeoutSec: 2, askTimeoutSec: 600 });
  const settled = await settle(env, two);
  assert.equal(settled.json.error.kind, "timeout", settled.stdout);
  assert.equal(toolAnswers(calls())[1].success, false);
  // cancel
  const three = await startSession(env, home, { task: "q\nASK: still there?\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, three, (event) => event.type === "question"));
  const cancelled = await runCli(["cancel", three], { env });
  assert.equal(cancelled.json.state, "cancelled", cancelled.stdout);
  assert.equal(toolAnswers(calls())[2].success, false);
});

test("other tools and other server requests are refused: unknown tool, askOrchestrator false, approvals", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const tool = await startSession(env, home, { task: "t\nFAKE_CALL_TOOL=shell_helper", tier: "light" });
  assert.match((await wait(env, tool)).json.text, /answered: unknown tool \(failed\)$/);
  const off = await startSession(env, home, { task: "t\nFAKE_CALL_TOOL=ask_orchestrator", tier: "light", askOrchestrator: false });
  assert.match((await wait(env, off)).json.text, /answered: unknown tool \(failed\)$/);
  assert.equal(requests(calls(), "thread/start")[0].params.dynamicTools[0].name, "ask_orchestrator");
  assert.equal(requests(calls(), "thread/start")[1].params.dynamicTools, undefined, "not registered when askOrchestrator is false");
  const approval = await startSession(env, home, { task: "t\nFAKE_REQUEST=item/commandExecution/requestApproval", tier: "light" });
  const declined = await wait(env, approval);
  assert.equal(declined.json.ok, true);
  assert.match(declined.json.text, /declined: item\/commandExecution\/requestApproval is not supported by this client$/);
  const error = sessionEvents(home, approval).find((event) => event.type === "error");
  assert.deepEqual([error.kind, error.willRetry], ["unexpected_request", false]);
  assert.equal(sessionEvents(home, tool).some((event) => event.type === "question"), false, "an unknown tool is not a question");
});
