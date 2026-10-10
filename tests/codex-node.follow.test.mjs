// One-shot `codex exec` runs (workflow nodes and direct runs) follow a switch of the managed ChatGPT
// account: while an attempt runs, the supervisor reads its --json stream for the thread id and the
// steps in flight and, when the account changes and no step is in flight, stops the attempt (the
// normal teardown) and resumes its thread on the new account. The "account" is the test identity
// file; the real auth.json is never touched. The fake Codex scripts an attempt with FAKE_STEPS.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  AttemptSwitchWatch,
  MAX_ACCOUNT_HANDOFFS,
  continuationPrompt,
  managedAccountIdentity,
  validateRequest,
} from "../plugins/ultracodex/scripts/codex-node.mjs";
import { announce, eventually, fastEnv, frame, makeHome, pidAlive, runCli, signedHeader, writeRequest } from "./helpers.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

// a home whose managed account is the identity file
function followHome(t, extra = {}) {
  const home = makeHome(t);
  const identity = path.join(home, "identity.txt");
  fs.writeFileSync(identity, "account-a");
  const argvLog = path.join(home, "argv.jsonl");
  const promptsLog = path.join(home, "prompts.jsonl");
  const env = fastEnv(home, {
    ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE: identity,
    ULTRACODEX_ACCOUNT_CHECK_MS: "100",
    FAKE_CODEX_ARGV_LOG: argvLog,
    FAKE_CODEX_PROMPTS_LOG: promptsLog,
    FAKE_CODEX_OUTPUT: "continued",
    ...extra,
  });
  return {
    home,
    env,
    argvLog,
    switchTo: (name) => fs.writeFileSync(identity, name),
    attempt: (runId, n) => path.join(home, "runs", runId, `attempt-${n}`),
    log: (runId) => fs.readFileSync(path.join(home, "runs", runId, "supervisor.log"), "utf8"),
    execCalls: () => jsonLines(argvLog),
    // what each attempt was given on stdin (the runner ends it with a newline)
    prompts: () => jsonLines(promptsLog).map((entry) => entry.prompt.replace(/\n$/, "")),
  };
}

async function start(env, home, request) {
  const started = await runCli(["start", "--request", writeRequest(home, request)], { env });
  assert.equal(started.code, 3, started.stdout);
  return started.json.runId;
}

async function finish(env, runId, rounds = 40) {
  let out = null;
  for (let round = 0; round < rounds; round += 1) {
    out = await runCli(["wait", runId, "--max-wait", "5"], { env });
    if (!["running", "queued", "backoff", "account_wait", "limit_wait"].includes(out.json?.state)) break;
  }
  return out;
}

// the attempt's --json stream has the line (the thread is known, a step has started, ...)
const streamHas = (file, text) => eventually(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(text), { timeoutMs: 30_000, stepMs: 25 });
const threadOf = (file) => JSON.parse(fs.readFileSync(file, "utf8").split("\n").find((line) => line.includes("thread.started"))).thread_id;

test("a switch during a model step: the attempt is stopped and its thread resumed on the new account, with the sandbox restated", async (t) => {
  const { home, env, switchTo, attempt, log, execCalls, prompts } = followHome(t);
  const runId = await start(env, home, { task: "work\nFAKE_STEPS=model:30000", tier: "light", sandbox: "workspace-write", timeoutSec: 120 });
  const first = path.join(attempt(runId, 1), "events.jsonl");
  assert.ok(await streamHas(first, "thread.started"));
  const thread = threadOf(first);
  const switchedAt = Date.now();
  switchTo("account-b");

  const out = await finish(env, runId);
  assert.equal(out.code, 0, out.stdout);
  assert.deepEqual([out.json.ok, out.json.text], [true, "continued"]);
  assert.ok(Date.now() - switchedAt < 20_000, "within seconds");
  assert.equal(out.json.provenance.accountHandoffs, 1);
  assert.equal(out.json.provenance.attempts, 2);
  assert.equal(out.json.provenance.threadId, thread, "the same thread");
  const calls = execCalls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].argv.includes("-s") && !calls[0].argv.includes("resume"));
  const resume = calls[1].argv;
  assert.deepEqual(resume.slice(0, 3), ["exec", "resume", thread]);
  for (const flag of ['sandbox_mode="workspace-write"', "sandbox_workspace_write.network_access=false", "sandbox_workspace_write.writable_roots=[]"]) {
    assert.ok(resume.includes(flag), `the resume restates ${flag}`);
  }
  assert.ok(await eventually(() => !pidAlive(calls[0].pid)), "the first attempt's process is gone");
  const text = log(runId);
  assert.match(text, /attempt 1: the managed account changed; stopping this attempt at the next step boundary/);
  assert.match(text, /stopping codex pid \d+: account_switch/);
  assert.match(text, /resuming the saved thread on the newly selected account \(handoff 1\)/);
  // the resume says the system stopped the attempt, why, that the request is not complete, and repeats it
  const [given, resumed] = prompts();
  assert.equal(given, "work\nFAKE_STEPS=model:30000", "the first attempt got the task as it is");
  assert.equal(resumed, continuationPrompt("switch", "work\nFAKE_STEPS=model:30000"));
  assert.match(resumed, /^SYSTEM NOTICE \(from the ultracodex runner, not the user\): your previous turn was stopped by the system before it was finished \(the ChatGPT account was switched\)\./);
  assert.ok(resumed.includes("<<<\nwork\nFAKE_STEPS=model:30000\n>>>"));
});

test("a switch during a command waits for it: the stream shows the command complete before the attempt is stopped", async (t) => {
  const { home, env, switchTo, attempt, execCalls } = followHome(t);
  const runId = await start(env, home, { task: "work\nFAKE_STEPS=command:3000,model:30000", tier: "light", timeoutSec: 120 });
  const first = path.join(attempt(runId, 1), "events.jsonl");
  assert.ok(await streamHas(first, "item.started"));
  const [firstCall] = execCalls();
  switchTo("account-b");
  await pause(1200);
  assert.equal(fs.existsSync(attempt(runId, 2)), false, "no resume while the command runs");
  assert.ok(pidAlive(firstCall.pid), "the attempt is untouched");
  assert.equal(fs.readFileSync(first, "utf8").includes("item.completed"), false, "the command is still in flight");

  const out = await finish(env, runId);
  assert.deepEqual([out.json.ok, out.json.provenance.accountHandoffs, out.json.provenance.attempts], [true, 1, 2], out.stdout);
  const types = jsonLines(first).map((event) => event.type);
  assert.deepEqual(types.filter((type) => type.startsWith("item.")), ["item.started", "item.completed"], "the command ran to its end before the stop");
});

test("an ephemeral run cannot be resumed: it is not followed and finishes on the old account", async (t) => {
  const { home, env, switchTo, attempt, execCalls } = followHome(t);
  const runId = await start(env, home, { task: "work\nFAKE_STEPS=model:3000\nFAKE_OUTPUT=old", tier: "light", ephemeral: true });
  assert.ok(await streamHas(path.join(attempt(runId, 1), "events.jsonl"), "thread.started"));
  switchTo("account-b");
  const out = await finish(env, runId);
  assert.deepEqual([out.json.ok, out.json.text, out.json.provenance.attempts, out.json.provenance.accountHandoffs], [true, "old", 1, undefined]);
  assert.equal(execCalls().length, 1);
});

test("a switch seen before Codex has said which thread it is is not followed", async (t) => {
  const { home, env, switchTo, log, execCalls } = followHome(t);
  const runId = await start(env, home, { task: "work\nFAKE_THREAD_DELAY_MS=2500\nFAKE_STEPS=model:1500\nFAKE_OUTPUT=old", tier: "light" });
  assert.ok(await eventually(() => execCalls().length === 1, { timeoutMs: 30_000, stepMs: 25 }));
  switchTo("account-b");
  const out = await finish(env, runId);
  assert.deepEqual([out.json.ok, out.json.text, out.json.provenance.attempts], [true, "old", 1], out.stdout);
  assert.match(log(runId), /not followed \(its thread id is not known yet\)/);
});

test("followAccountSwitch false (and the env default) finishes the attempt on the old account", async (t) => {
  for (const [label, extra, request] of [["the request", {}, { followAccountSwitch: false }], ["the env default", { ULTRACODEX_FOLLOW_ACCOUNT_SWITCH: "0" }, {}]]) {
    const { home, env, switchTo, attempt, execCalls } = followHome(t, extra);
    const runId = await start(env, home, { task: "work\nFAKE_STEPS=model:2500\nFAKE_OUTPUT=old", tier: "light", ...request });
    assert.ok(await streamHas(path.join(attempt(runId, 1), "events.jsonl"), "thread.started"), label);
    switchTo("account-b");
    const out = await finish(env, runId);
    assert.deepEqual([out.json.ok, out.json.text, out.json.provenance.attempts], [true, "old", 1], label);
    assert.equal(execCalls().length, 1, label);
  }
});

test("a review run is not followed: resuming an exec review thread is not supported", async (t) => {
  const { home, env, switchTo, attempt, log } = followHome(t, { FAKE_CODEX_STEPS: "model:2500" });
  const runId = await start(env, home, { review: { uncommitted: true }, cwd: home, tier: "light" });
  assert.ok(await streamHas(path.join(attempt(runId, 1), "events.jsonl"), "thread.started"));
  switchTo("account-b");
  const out = await finish(env, runId);
  assert.deepEqual([out.json.ok, out.json.provenance.attempts], [true, 1], out.stdout);
  assert.match(log(runId), /not followed \(review runs are not followed/);
});

test("a stop whose teardown cannot be verified is not resumed: the run ends with a failure that says why", async (t) => {
  const { home, env, switchTo, attempt, log, execCalls } = followHome(t, { ULTRACODEX_TEST_FAULT: "unclean-teardown" });
  const runId = await start(env, home, { task: "work\nFAKE_STEPS=model:30000", tier: "light", timeoutSec: 120 });
  assert.ok(await streamHas(path.join(attempt(runId, 1), "events.jsonl"), "thread.started"));
  switchTo("account-b");
  const out = await finish(env, runId);
  assert.equal(out.code, 1);
  assert.deepEqual([out.json.ok, out.json.state, out.json.error.kind], [false, "failed", "account_switch"]);
  assert.match(out.json.error.message, /could not be verified/);
  assert.equal(execCalls().length, 1, "nothing was resumed");
  assert.match(log(runId), /cannot be resumed \(its process tree was not stopped cleanly\)/);
});

test("the handoff budget is shared: the attempt beyond it is not stopped for a switch", async (t) => {
  const { home, env, switchTo, attempt, log, execCalls } = followHome(t, { FAKE_CODEX_STEPS: "model:2500" });
  const runId = await start(env, home, { task: "go\nFAKE_OUTPUT=done", tier: "light", timeoutSec: 600 });
  for (let handoff = 1; handoff <= MAX_ACCOUNT_HANDOFFS; handoff += 1) {
    assert.ok(await streamHas(path.join(attempt(runId, handoff), "events.jsonl"), "thread.started"), `attempt ${handoff} is running`);
    switchTo(`account-${handoff}`);
    assert.ok(await eventually(() => fs.existsSync(attempt(runId, handoff + 1)), { timeoutMs: 30_000, stepMs: 25 }), `attempt ${handoff + 1} began`);
  }
  assert.ok(await streamHas(path.join(attempt(runId, MAX_ACCOUNT_HANDOFFS + 1), "events.jsonl"), "thread.started"));
  switchTo("account-last");
  const out = await finish(env, runId);
  assert.deepEqual([out.json.ok, out.json.provenance.attempts, out.json.provenance.accountHandoffs], [true, MAX_ACCOUNT_HANDOFFS + 1, MAX_ACCOUNT_HANDOFFS], out.stdout);
  assert.equal(execCalls().length, MAX_ACCOUNT_HANDOFFS + 1);
  assert.match(log(runId), /not followed \(the budget of 8 account handoffs is used up\)/);
});

test("a relayed (framed) request may carry followAccountSwitch", async (t) => {
  const { home, env } = followHome(t);
  const task = "relayed work\nFAKE_OUTPUT=ok";
  const header = signedHeader(home, { tier: "light", kind: "ask", followAccountSwitch: false }, null, task);
  await announce(env, header, null, task);
  const started = await runCli(["start", "--framed", "-"], { env, input: frame(header, null, task) });
  assert.equal(started.code, 3, started.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "runs", started.json.runId, "request.json"), "utf8")).followAccountSwitch, false);
  assert.equal((await finish(env, started.json.runId)).json.state, "done");
});

// ── the pieces ──

// the watch reads the managed account from this process's environment: point it at a file
function useIdentity(t, initial) {
  const home = makeHome(t);
  const identity = path.join(home, "identity.txt");
  fs.writeFileSync(identity, initial);
  const previous = { identity: process.env.ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE, codex: process.env.CODEX_HOME };
  process.env.ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE = identity;
  process.env.CODEX_HOME = home; // an empty identity file falls back to the real login: this home has none
  t.after(() => {
    for (const [name, value] of [["ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE", previous.identity], ["CODEX_HOME", previous.codex]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return { home, identity };
}

// poll() looks at the account at most every accountCheckMs: let every call look
const pollNow = (watch) => {
  watch.nextCheckAt = 0;
  return watch.poll();
};

test("AttemptSwitchWatch: a step is in flight from item.started to item.completed, whatever its kind; thread.started names the thread", (t) => {
  const { home } = useIdentity(t, "account-a");
  const file = path.join(home, "events.jsonl");
  const write = (event) => fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  const watch = new AttemptSwitchWatch({ file, account: "x", followable: () => null, log: () => {} });
  write({ type: "thread.started", thread_id: "thread-1" });
  write({ type: "turn.started" });
  watch.read();
  assert.equal(watch.threadId, "thread-1");
  // every kind of step holds the boundary back until it completes; messages and reasoning are not steps
  const sequence = [
    [{ type: "item.started", item: { id: "c1", type: "command_execution" } }, 1],
    [{ type: "item.started", item: { id: "f1", type: "file_change" } }, 2],
    [{ type: "item.started", item: { id: "m1", type: "mcp_tool_call" } }, 3],
    [{ type: "item.started", item: { id: "w1", type: "web_search" } }, 4],
    [{ type: "item.started", item: { id: "r1", type: "reasoning" } }, 4],
    [{ type: "item.completed", item: { id: "r1", type: "reasoning" } }, 4],
    [{ type: "item.completed", item: { id: "a1", type: "agent_message", text: "x" } }, 4],
    [{ type: "item.completed", item: { id: "never-started", type: "command_execution" } }, 4],
    [{ type: "item.completed", item: { id: "f1", type: "file_change" } }, 3],
    [{ type: "item.completed", item: { id: "c1", type: "command_execution" } }, 2],
    [{ type: "item.completed", item: { id: "w1", type: "web_search" } }, 1],
    [{ type: "item.completed", item: { id: "m1", type: "mcp_tool_call" } }, 0],
  ];
  for (const [event, inFlight] of sequence) {
    write(event);
    watch.read();
    assert.equal(watch.inFlight.size, inFlight, `${event.type} ${event.item.type}`);
  }
  // a half-written last line counts when it is complete
  fs.appendFileSync(file, '{"type":"item.started","item":{"id":"c2","type":"command_exec');
  watch.read();
  assert.equal(watch.inFlight.size, 0);
  fs.appendFileSync(file, 'ution"}}\n');
  watch.read();
  assert.equal(watch.inFlight.size, 1);
});

test("AttemptSwitchWatch: stops only for a real switch with no step in flight; the decision to follow is made when the switch is seen", (t) => {
  const { home, identity } = useIdentity(t, "account-a");
  const file = path.join(home, "events.jsonl");
  const write = (event) => fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  const account = managedAccountIdentity();
  const logged = [];
  let refusal = null;
  const watch = new AttemptSwitchWatch({ file, account, followable: () => refusal, log: (line) => logged.push(line) });
  write({ type: "thread.started", thread_id: "thread-1" });
  assert.equal(pollNow(watch), false, "no switch");
  fs.writeFileSync(identity, "account-a\n"); // the same account
  assert.equal(pollNow(watch), false);
  fs.writeFileSync(identity, "");
  assert.equal(pollNow(watch), false, "an account that cannot be read is not a switch");

  fs.writeFileSync(identity, "account-b");
  write({ type: "item.started", item: { id: "c", type: "command_execution" } });
  assert.equal(pollNow(watch), false, "switched, but a command is in flight");
  assert.match(logged.at(-1), /stopping this attempt at the next step boundary/);
  fs.writeFileSync(identity, "account-a");
  assert.equal(pollNow(watch), false, "undone while waiting: nothing to follow");
  assert.match(logged.at(-1), /back to the one this attempt started on/);
  fs.writeFileSync(identity, "account-b");
  assert.equal(pollNow(watch), false, "still in flight");
  write({ type: "item.completed", item: { id: "c", type: "command_execution" } });
  assert.equal(pollNow(watch), true, "the boundary: now");

  // not followed: the reason is logged once, and the attempt is never stopped
  const refused = new AttemptSwitchWatch({ file, account, followable: () => "the budget is used up", log: (line) => logged.push(line) });
  assert.equal(pollNow(refused), false);
  assert.match(logged.at(-1), /not followed \(the budget is used up\)/);
  assert.equal(pollNow(refused), false, "not asked again");
  // no thread yet: not followed
  const early = new AttemptSwitchWatch({ file: path.join(home, "none.jsonl"), account, followable: () => refusal, log: (line) => logged.push(line) });
  assert.equal(pollNow(early), false);
  assert.match(logged.at(-1), /not followed \(its thread id is not known yet\)/);
  // no account to follow from (an ephemeral run, no managed login): a watch that never fires
  const none = new AttemptSwitchWatch({ file, account: null, followable: () => null, log: () => {} });
  assert.equal(pollNow(none), false);
});

test("the test identity file: its text is the account, trimmed; empty or unreadable falls back to the real login", (t) => {
  const home = makeHome(t);
  const file = path.join(home, "identity.txt");
  const env = (extra = {}) => ({ CODEX_HOME: home, ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE: file, ...extra });
  fs.writeFileSync(file, "  account-a \n");
  const sha = (text) => createHash("sha256").update(`test:${text}`).digest("hex");
  assert.equal(managedAccountIdentity(env()), sha("account-a"));
  fs.writeFileSync(file, "account-b");
  assert.equal(managedAccountIdentity(env()), sha("account-b"));
  assert.notEqual(managedAccountIdentity(env()), sha("account-a"));
  assert.equal(managedAccountIdentity(env({ OPENAI_API_KEY: "sk-x" })), sha("account-b"), "the test file wins over every other source");
  // empty / missing: the real login (none here: null; a real auth.json in this home: its identity)
  fs.writeFileSync(file, "  \n");
  assert.equal(managedAccountIdentity(env()), null);
  fs.rmSync(file);
  assert.equal(managedAccountIdentity(env()), null);
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "real-account" } }));
  const real = managedAccountIdentity(env());
  assert.match(real, /^[0-9a-f]{64}$/);
  assert.notEqual(real, sha("real-account"), "the real identity is not the test one");
  assert.equal(managedAccountIdentity({ CODEX_HOME: home }), real);
  // the file is only ever read
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")).tokens.account_id, "real-account");
});

test("followAccountSwitch: a boolean, true unless the request or ULTRACODEX_FOLLOW_ACCOUNT_SWITCH=0 says otherwise", (t) => {
  const home = makeHome(t);
  const previous = process.env.ULTRACODEX_FOLLOW_ACCOUNT_SWITCH;
  t.after(() => {
    if (previous === undefined) delete process.env.ULTRACODEX_FOLLOW_ACCOUNT_SWITCH;
    else process.env.ULTRACODEX_FOLLOW_ACCOUNT_SWITCH = previous;
  });
  const follows = (raw) => validateRequest({ task: "x", cwd: home, ...raw }).followAccountSwitch;
  delete process.env.ULTRACODEX_FOLLOW_ACCOUNT_SWITCH;
  assert.deepEqual([follows({}), follows({ followAccountSwitch: false }), follows({ followAccountSwitch: true })], [true, false, true]);
  process.env.ULTRACODEX_FOLLOW_ACCOUNT_SWITCH = "0";
  assert.deepEqual([follows({}), follows({ followAccountSwitch: false }), follows({ followAccountSwitch: true })], [false, false, true]);
  process.env.ULTRACODEX_FOLLOW_ACCOUNT_SWITCH = "1";
  assert.equal(follows({}), true);
  assert.throws(() => follows({ followAccountSwitch: "yes" }), /followAccountSwitch must be a boolean/);
});

// ── review findings ──

test("AttemptSwitchWatch drains a backlog larger than one read before it judges the boundary, and never decides with a line unread", (t) => {
  const { home, identity } = useIdentity(t, "account-a");
  const file = path.join(home, "events.jsonl");
  const account = managedAccountIdentity();
  const filler = JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: "x".repeat(1000) } });
  // 5 MiB of finished work, then a command that has started: readNewEvents reads 4 MiB at a time
  const lines = [JSON.stringify({ type: "thread.started", thread_id: "thread-1" })];
  for (let size = 0; size < 5 * 1024 * 1024; size += filler.length + 1) lines.push(filler);
  lines.push(JSON.stringify({ type: "item.started", item: { id: "c", type: "command_execution" } }));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const logged = [];
  const watch = new AttemptSwitchWatch({ file, account, followable: () => null, log: (line) => logged.push(line) });
  fs.writeFileSync(identity, "account-b");
  assert.equal(pollNow(watch), false, "the command at the end of the backlog is in flight: not a boundary");
  assert.equal(watch.inFlight.size, 1);
  assert.equal(watch.threadId, "thread-1");
  fs.appendFileSync(file, `${JSON.stringify({ type: "item.completed", item: { id: "c", type: "command_execution" } })}\n`);
  assert.equal(pollNow(watch), true, "now it is");

  // a line still being written may be an item.started: no decision while bytes are unread
  const partial = path.join(home, "partial.jsonl");
  fs.writeFileSync(partial, `${JSON.stringify({ type: "thread.started", thread_id: "thread-2" })}\n{"type":"item.started","item":{"id":"c2","type":"command_exec`);
  const half = new AttemptSwitchWatch({ file: partial, account, followable: () => null, log: () => {} });
  assert.equal(pollNow(half), false);
  assert.equal(half.unread, true);
  assert.equal(half.inFlight.size, 0, "the half line is not an event yet, and it is why nothing is decided");
  fs.appendFileSync(partial, 'ution"}}\n');
  assert.equal(pollNow(half), false, "complete: the command is in flight");
  fs.appendFileSync(partial, `${JSON.stringify({ type: "item.completed", item: { id: "c2", type: "command_execution" } })}\n`);
  assert.equal(pollNow(half), true);
});

test("AttemptSwitchWatch judges the boundary on fresh facts: an undone switch and a budget that ran out meanwhile are not followed", (t) => {
  const { home, identity } = useIdentity(t, "account-a");
  const file = path.join(home, "events.jsonl");
  const write = (event) => fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  const account = managedAccountIdentity();
  const logged = [];
  let refusal = null;
  const watch = new AttemptSwitchWatch({ file, account, followable: () => refusal, log: (line) => logged.push(line) });
  write({ type: "thread.started", thread_id: "thread-1" });
  write({ type: "item.started", item: { id: "c", type: "command_execution" } });
  fs.writeFileSync(identity, "account-b");
  assert.equal(pollNow(watch), false, "pending behind the command");
  // the account goes back before the next identity check, and the command completes
  fs.writeFileSync(identity, "account-a");
  write({ type: "item.completed", item: { id: "c", type: "command_execution" } });
  assert.equal(watch.poll(), false, "no identity check is due, but the boundary looks again: the switch is undone");
  assert.match(logged.at(-1), /back to the one this attempt started on/);

  // the switch is real again, and the work time runs out while the next command runs
  fs.writeFileSync(identity, "account-b");
  write({ type: "item.started", item: { id: "d", type: "command_execution" } });
  assert.equal(pollNow(watch), false);
  refusal = "too little work time is left";
  write({ type: "item.completed", item: { id: "d", type: "command_execution" } });
  assert.equal(pollNow(watch), false, "not interrupted: the attempt finishes on the old account");
  assert.match(logged.at(-1), /not followed \(too little work time is left\)/);
  assert.equal(pollNow(watch), false, "and it is not asked again");
});

test("a switch that waits behind a command until too little work time is left is not followed: the attempt finishes on the old account", async (t) => {
  const { home, env, switchTo, attempt, log, execCalls } = followHome(t, { ULTRACODEX_MIN_TIMEOUT_SEC: "60" });
  const runId = await start(env, home, { task: "work\nFAKE_STEPS=command:3000,model:1500\nFAKE_OUTPUT=old", tier: "light", timeoutSec: 62 });
  assert.ok(await streamHas(path.join(attempt(runId, 1), "events.jsonl"), "item.started"));
  switchTo("account-b");
  const out = await finish(env, runId);
  assert.deepEqual([out.json.ok, out.json.text, out.json.provenance.attempts], [true, "old", 1], out.stdout);
  assert.equal(execCalls().length, 1);
  assert.match(log(runId), /waiting|next step boundary/);
  assert.match(log(runId), /not followed \(too little work time is left\)/);
});
