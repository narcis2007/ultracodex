// End-to-end tests of usage-limit waiting, orphaned runs and `cancel --orphaned`: real
// start/wait/cancel processes, a detached supervisor, and the fake Codex CLI, which also plays
// `app-server --listen stdio://` for the rate-limit probe. No model quota is spent.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { continuationPrompt } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { announce, eventually, fastEnv, frame, makeHome, runCli, signedHeader, startAndWait, writeRequest } from "./helpers.mjs";

const SECRET_ACCOUNT = "ACCOUNT-ID-MUST-NOT-LEAK";
const SECRET_CREDIT = "CREDIT-ID-MUST-NOT-LEAK";

function saveAccount(home, account) {
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account } }));
}

// One scripted answer of the fake app-server's account/rateLimits/read (see fake-codex.mjs).
// `resetsAt` is unix seconds, like Codex's; `resetsInSec` is relative to the script's first
// probe (the supervisor takes a few seconds to start). The identifiers are there to prove they
// never leak.
function limitAnswer({ allowed, usedPercent = 100, resetsInSec = 3600, resetsAt = resetsInSec }) {
  const codex = {
    limitId: "codex",
    primary: { usedPercent, windowDurationMins: 300, resetsAt },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetsAt + 86_400 },
    credits: { id: SECRET_CREDIT },
    rateLimitReachedType: usedPercent >= 100 ? "rate_limit_reached" : null,
  };
  return {
    resetsAt,
    result: { ordinaryUsageAllowed: allowed, accountId: SECRET_ACCOUNT, rateLimits: codex, rateLimitsByLimitId: { codex }, rateLimitResetCredits: [{ id: SECRET_CREDIT }] },
  };
}

// A home with an account, the scripted probe answers and the logs the fake writes.
function limitHome(t, answers, extraEnv = {}) {
  const home = makeHome(t);
  saveAccount(home, "account-a");
  const rateLimits = path.join(home, "rate-limits.json");
  fs.writeFileSync(rateLimits, JSON.stringify(answers.map(({ resetsAt, ...answer }) => answer)));
  const argvLog = path.join(home, "argv.jsonl");
  const probeLog = path.join(home, "probe.jsonl");
  const promptsLog = path.join(home, "prompts.jsonl");
  const env = fastEnv(home, { FAKE_CODEX_RATE_LIMITS: rateLimits, FAKE_CODEX_PROBE_LOG: probeLog, FAKE_CODEX_ARGV_LOG: argvLog, FAKE_CODEX_PROMPTS_LOG: promptsLog, FAKE_CODEX_STATE: path.join(home, "fake-state"), ...extraEnv });
  return { home, env, argvLog, probeLog, promptsLog };
}

const jsonLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
// the prompts the fake Codex was given, one per attempt (the runner ends the stdin text with a newline)
const promptsOf = (promptsLog) => jsonLines(promptsLog).map((entry) => entry.prompt.replace(/\n$/, ""));
const probeReads = (probeLog) => jsonLines(probeLog).filter((entry) => entry.method === "account/rateLimits/read").length;
const runFile = (home, runId, name) => path.join(home, "runs", runId, name);
const readState = (home, runId) => JSON.parse(fs.readFileSync(runFile(home, runId, "state.json"), "utf8"));
const usageLimited = (home, extra = {}) => ({ task: `implement once\nFAKE_QUOTA_WORK=${path.join(home, "work.txt")}`, ...extra });

async function start(env, home, request) {
  const started = await runCli(["start", "--request", writeRequest(home, request)], { env });
  assert.equal(started.code, 3, started.stdout);
  return started.json.runId;
}

// The state is `limit_wait` once the supervisor has handed the failed attempt over to the wait.
const inLimitWait = (home, runId) => eventually(() => fs.existsSync(runFile(home, runId, "state.json")) && readState(home, runId).state === "limit_wait", { timeoutMs: 30_000, stepMs: 50 });

test("a usage-limited job waits for the reset, then resumes its thread with the sandbox it asked for", async (t) => {
  // blocked until a reset 3 s away, then allowed: the second probe must come right after the
  // reset (the regular cadence is a minute), not from a timer
  const answers = [limitAnswer({ allowed: false, resetsInSec: 3 }), limitAnswer({ allowed: true, usedPercent: 0 })];
  const { home, env, argvLog, probeLog, promptsLog } = limitHome(t, answers, { ULTRACODEX_LIMIT_WAIT_SEC: "120", ULTRACODEX_LIMIT_PROBE_MS: "60000" });
  const { started, final } = await startAndWait(env, usageLimited(home, { sandbox: "workspace-write", timeoutSec: 30 }), { home });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.runId, started.json.runId);
  const provenance = final.provenance;
  assert.equal(provenance.limitResumes, 1);
  assert.equal(provenance.accountHandoffs, undefined, "no account changed");
  assert.equal(provenance.attempts, 2);
  assert.ok(provenance.limitWaitedSec >= 2, `waited ${provenance.limitWaitedSec} s`);
  assert.equal(fs.readFileSync(path.join(home, "work.txt"), "utf8"), "applied once\n");

  // the same thread, resumed — with the writable sandbox restated
  const calls = jsonLines(argvLog);
  assert.equal(calls.length, 2);
  const thread = `01a0fake-0000-7000-8000-${String(calls[0].pid).padStart(12, "0")}`;
  assert.deepEqual(calls[1].argv.slice(0, 3), ["exec", "resume", thread]);
  assert.equal(provenance.threadId, thread);
  assert.ok(calls[1].argv.includes('sandbox_mode="workspace-write"'));
  assert.ok(calls[1].argv.includes("sandbox_workspace_write.network_access=false"));
  // the resume says why the attempt was stopped and repeats the request it was working on
  const prompts = promptsOf(promptsLog);
  assert.equal(prompts[0], usageLimited(home).task, "the first attempt got the task as it is");
  assert.equal(prompts[1], continuationPrompt("reset", usageLimited(home).task));
  assert.match(prompts[1], /the usage limit was reached and has now reset/);

  // two probes (at entry, and right after the reset), both read-only
  assert.equal(probeReads(probeLog), 2);
  assert.deepEqual([...new Set(jsonLines(probeLog).map((entry) => entry.method))], ["initialize", "initialized", "account/rateLimits/read"]);

  // the wait did not use up the deadline: the continuation got the work time the first attempt
  // had left (about 30 s), not 30 s minus the 3 s it waited
  const state = readState(home, started.json.runId);
  const window = Date.parse(state.deadlineAt) - Date.parse(state.attemptStartedAt);
  assert.ok(window > 27_500, `the resumed attempt had ${window} ms`);

  const log = fs.readFileSync(runFile(home, started.json.runId, "supervisor.log"), "utf8");
  assert.match(log, /waiting up to 120 s for the limit to reset or the account to change/);
  assert.match(log, /limit probe: usage blocked \(codex primary 100 %, codex secondary 40 %\); resumesAt \d{4}-\d\d-\d\dT/);
  assert.match(log, /limit probe: usage allowed \(codex primary 0 %/);
  assert.match(log, /usage is available again; resuming the saved thread \(limit resume 1, \d+ s of work time left\)/);

  // nothing from the response but the verdict, the percentages and the reset times
  for (const name of ["supervisor.log", "state.json", "result.json", "request.json"]) {
    assert.doesNotMatch(fs.readFileSync(runFile(home, started.json.runId, name), "utf8"), new RegExp(`${SECRET_ACCOUNT}|${SECRET_CREDIT}`), name);
  }
  assert.doesNotMatch(JSON.stringify(final), new RegExp(`${SECRET_ACCOUNT}|${SECRET_CREDIT}`));
});

test("while a limit wait runs, status and wait show backoff, waitingForLimit and resumesAt; an account switch ends it", async (t) => {
  const blocked = limitAnswer({ allowed: false, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
  const { home, env, argvLog, probeLog, promptsLog } = limitHome(t, [blocked], { ULTRACODEX_LIMIT_WAIT_SEC: "600" });
  const runId = await start(env, home, usageLimited(home));
  assert.ok(await inLimitWait(home, runId), "the run entered the limit wait");
  // a wait that returns at once; resumesAt appears with the first probe
  let waiting = null;
  assert.ok(await eventually(async () => (waiting = (await runCli(["wait", runId, "--max-wait", "0"], { env })).json).resumesAt, { timeoutMs: 20_000, stepMs: 100 }));
  assert.equal(waiting.ok, null);
  assert.equal(waiting.state, "backoff", "an already-loaded Claude relay keeps polling");
  assert.equal(waiting.waitingForAccount, true);
  assert.equal(waiting.waitingForLimit, true);
  assert.equal(waiting.resumesAt, new Date(blocked.resetsAt * 1000).toISOString(), "the reset of the used-up window");
  const untilCap = Date.parse(waiting.limitWaitUntil) - Date.now();
  assert.ok(untilCap > 500_000 && untilCap <= 600_000, `limitWaitUntil is the cap (${untilCap} ms away)`);
  const status = (await runCli(["status", runId], { env })).json.runs[0];
  assert.equal(status.state, "backoff");
  assert.equal(status.waitingForLimit, true);
  assert.equal(status.waitingForAccount, true);
  assert.equal(status.resumesAt, waiting.resumesAt);
  assert.equal(status.limitWaitUntil, waiting.limitWaitUntil);
  assert.equal(status.orphaned, undefined, "somebody is polling");
  assert.equal(probeReads(probeLog) >= 1, true);
  assert.equal(jsonLines(argvLog).length, 1, "no second Codex process while blocked");

  // another account is selected during the wait: the existing handoff path takes over
  saveAccount(home, "account-b");
  const final = await runCli(["wait", runId, "--max-wait", "20"], { env });
  assert.equal(final.json.ok, true, final.stdout);
  assert.equal(final.json.provenance.accountHandoffs, 1);
  assert.equal(final.json.provenance.limitResumes, undefined, "an account change is not a limit resume");
  const calls = jsonLines(argvLog);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].argv.slice(0, 3), ["exec", "resume", final.json.provenance.threadId]);
  const resumePrompt = promptsOf(promptsLog)[1];
  assert.equal(resumePrompt, continuationPrompt("usage_limit", usageLimited(home).task));
  assert.match(resumePrompt, /the usage limit was reached and the ChatGPT account was then switched/);
  const done = (await runCli(["status", runId], { env })).json.runs[0];
  assert.equal(done.waitingForLimit, undefined, "finished runs report no wait");
});

test("a limit wait that reaches its cap ends as usage_limit; limitWaitSec 0 keeps only the short account wait", async (t) => {
  // cap: Codex keeps saying "not allowed"
  {
    const { home, env, argvLog, probeLog } = limitHome(t, [limitAnswer({ allowed: false, resetsInSec: 3600 })], { ULTRACODEX_LIMIT_WAIT_SEC: "600" });
    const { started, final } = await startAndWait(env, usageLimited(home, { limitWaitSec: 2 }), { home });
    assert.equal(final.ok, false);
    assert.equal(final.error.kind, "usage_limit");
    assert.equal(final.provenance.attempts, 1);
    assert.ok(final.provenance.limitWaitedSec >= 2);
    assert.equal(jsonLines(argvLog).length, 1, "never resumed");
    assert.ok(probeReads(probeLog) >= 1);
    assert.match(fs.readFileSync(runFile(home, started.json.runId, "supervisor.log"), "utf8"), /the usage limit did not reset within 2 s; giving up/);
  }
  // 0: the 0.3.7 behaviour — a short wait for another account, no probe at all
  {
    const { home, env, probeLog } = limitHome(t, [limitAnswer({ allowed: true, usedPercent: 0 })], { ULTRACODEX_LIMIT_WAIT_SEC: "600", ULTRACODEX_ACCOUNT_WAIT_MS: "300" });
    const { started, final } = await startAndWait(env, usageLimited(home, { limitWaitSec: 0 }), { home });
    assert.equal(final.error.kind, "usage_limit");
    assert.equal(final.provenance.attempts, 1);
    assert.equal(fs.existsSync(probeLog), false, "no rate-limit probe");
    const log = fs.readFileSync(runFile(home, started.json.runId, "supervisor.log"), "utf8");
    assert.match(log, /waiting for an account change before resuming its thread/);
    assert.doesNotMatch(log, /limit probe/);
  }
});

test("a resume that hits the limit again is spaced out, even though the probe keeps saying allowed", async (t) => {
  // "out of credits": a usage_limit whose verdict says allowed. The first wait resumes at once;
  // the second may resume no earlier than limitProbeMs (2.5 s) after it began.
  const { home, env, argvLog } = limitHome(t, [limitAnswer({ allowed: true, usedPercent: 100, resetsInSec: 1 })],
    { ULTRACODEX_LIMIT_WAIT_SEC: "120", ULTRACODEX_LIMIT_PROBE_MS: "2500", FAKE_CODEX_QUOTA_RESUMES: "1" });
  const runId = await start(env, home, usageLimited(home));
  // while the second wait defers its resume, the run shows the earliest resume time
  let shown = null;
  assert.ok(await eventually(() => {
    const state = readState(home, runId);
    shown = state.state === "limit_wait" && state.attempt === 2 ? state.resumesAt : null;
    return shown;
  }, { timeoutMs: 30_000, stepMs: 25 }), "the second wait publishes its resumesAt");
  const final = await runCli(["wait", runId, "--max-wait", "30"], { env });
  assert.equal(final.json.ok, true, final.stdout);
  assert.equal(final.json.provenance.limitResumes, 2);
  assert.equal(final.json.provenance.attempts, 3);
  assert.equal(jsonLines(argvLog).length, 3);

  const lines = fs.readFileSync(runFile(home, runId, "supervisor.log"), "utf8").split("\n").filter(Boolean);
  const at = (pattern) => {
    const line = lines.find((entry) => pattern.test(entry));
    assert.ok(line, `${pattern} is in the log`);
    return { time: Date.parse(line.slice(0, 24)), line };
  };
  const secondEnded = at(/attempt 2 ended \(usage_limit\)/);
  const secondResume = at(/limit resume 2/);
  const deferral = at(/usage reported allowed, but the previous limit resume failed again; resuming no earlier than /);
  assert.ok(secondResume.time - secondEnded.time >= 2400, `the second resume waited ${secondResume.time - secondEnded.time} ms`);
  const notBefore = /no earlier than (\S+)$/.exec(deferral.line)[1];
  assert.ok(Date.parse(notBefore) - secondEnded.time >= 2400);
  assert.ok(secondResume.time >= Date.parse(notBefore) - 5, "not before the time it announced");
  assert.equal(shown, notBefore, "the state shows that time as resumesAt");
  assert.ok(lines.findIndex((entry) => /limit resume 1/.test(entry)) < lines.findIndex((entry) => /no earlier than/.test(entry)), "the first resume was not deferred");
  assert.equal(lines.filter((entry) => /no earlier than/.test(entry)).length, 1, "one deferral line");
});

test("without a verdict from the probe, the reset time plus a margin resumes the job; with no reset time it keeps waiting", async (t) => {
  const env = { ULTRACODEX_LIMIT_WAIT_SEC: "120", ULTRACODEX_LIMIT_PROBE_MS: "400", ULTRACODEX_LIMIT_RESET_MARGIN_MS: "500" };
  const resumed = [
    ["a null verdict", [limitAnswer({ allowed: null, resetsInSec: 2 })]],
    ["a probe that dies after a blocked answer", [limitAnswer({ allowed: false, resetsInSec: 2 }), { exit: 3 }]],
    ["an error answer after a blocked answer", [limitAnswer({ allowed: false, resetsInSec: 2 }), { error: { code: -32603, message: "internal" } }]],
  ];
  await Promise.all(resumed.map(async ([label, answers]) => {
    const run = limitHome(t, answers, env);
    const { started, final } = await startAndWait(run.env, usageLimited(run.home), { home: run.home });
    assert.equal(final.ok, true, `${label}: ${JSON.stringify(final)}`);
    assert.equal(final.provenance.limitResumes, 1, label);
    assert.ok(final.provenance.limitWaitedSec >= 2, `${label}: not before the reset time (waited ${final.provenance.limitWaitedSec} s)`);
    assert.match(fs.readFileSync(runFile(run.home, started.json.runId, "supervisor.log"), "utf8"), /expected reset time has passed/, label);
  }));
  // no reset time ever learned, no verdict: nothing to go on, so it waits for the cap
  const run = limitHome(t, [{ error: { code: -32603, message: "internal" } }], { ...env, ULTRACODEX_LIMIT_WAIT_SEC: "600" });
  const { final } = await startAndWait(run.env, usageLimited(run.home, { limitWaitSec: 2 }), { home: run.home });
  assert.equal(final.error.kind, "usage_limit");
  assert.equal(jsonLines(run.argvLog).length, 1);
  assert.ok(probeReads(run.probeLog) >= 2, "kept re-probing");
});

test("cancelling during a limit wait stops the run without another Codex process", async (t) => {
  const { home, env, argvLog } = limitHome(t, [limitAnswer({ allowed: false })], { ULTRACODEX_LIMIT_WAIT_SEC: "600" });
  const runId = await start(env, home, usageLimited(home));
  assert.ok(await inLimitWait(home, runId));
  const cancelled = await runCli(["cancel", runId], { env });
  assert.equal(cancelled.json.state, "cancelled");
  assert.equal(jsonLines(argvLog).length, 1);
});

test("an unpolled run keeps going by default, and a later upload of the same signed request gets its result", async (t) => {
  const home = makeHome(t);
  const argvLog = path.join(home, "argv.jsonl");
  const env = fastEnv(home, { FAKE_CODEX_ARGV_LOG: argvLog });
  const task = "slow job\nFAKE_SLEEP_MS=5000";
  // a relayed request may carry onOrphan and limitWaitSec
  const signed = signedHeader(home, { tier: "light", kind: "verify", label: "orphan", orphanAfterSec: 1, onOrphan: "finish", limitWaitSec: 30 }, null, task, 11);
  await announce(env, signed, null, task);
  const input = frame(signed, null, task);
  const first = await runCli(["start", "--framed", "-"], { env, input });
  assert.equal(first.code, 3, first.stdout);
  const runId = first.json.runId;
  // nobody polls: the supervisor records it, status says so, and the run is still alive
  assert.ok(await eventually(() => readState(home, runId).orphanedSince, { timeoutMs: 30_000, stepMs: 100 }), "orphanedSince is recorded");
  const status = (await runCli(["status", runId], { env })).json.runs[0];
  assert.equal(status.orphaned, true);
  assert.equal(status.orphanedSince, readState(home, runId).orphanedSince);
  assert.ok(["queued", "running"].includes(status.state), status.state);
  // ... and it finishes without anyone polling
  assert.ok(await eventually(() => fs.existsSync(runFile(home, runId, "result.json")), { timeoutMs: 30_000, stepMs: 100 }), "the run finished unpolled");
  assert.equal(JSON.parse(fs.readFileSync(runFile(home, runId, "result.json"), "utf8")).state, "done");
  // the resumed workflow uploads the same request again: it joins that run and gets the result
  const second = await runCli(["start", "--framed", "-"], { env, input });
  assert.equal(second.code, 3);
  assert.equal(second.json.runId, runId, "the same run, not a new one");
  const done = await runCli(["wait", runId, "--max-wait", "20"], { env });
  assert.equal(done.json.ok, true);
  assert.equal(done.json.state, "done");
  assert.ok(done.json.mac && done.json.resultHash, "the original, authenticated result");
  assert.equal(jsonLines(argvLog).length, 1, "Codex ran once");
});

test("a poll that finds an unpolled run says so and re-attaches it", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const runId = await start(env, home, { task: "slow job\nFAKE_SLEEP_MS=30000", orphanAfterSec: 3 });
  assert.ok(await eventually(() => readState(home, runId).orphanedSince, { timeoutMs: 30_000, stepMs: 100 }));
  const recorded = readState(home, runId).orphanedSince;
  const found = await runCli(["wait", runId, "--max-wait", "0"], { env });
  assert.equal(found.json.orphaned, true);
  assert.equal(found.json.orphanedSince, recorded);
  const polled = await runCli(["wait", runId, "--max-wait", "0"], { env });
  assert.equal(polled.json.orphaned, undefined, "that poll re-attached it");
  await runCli(["cancel", runId], { env });
});

test("cancel --orphaned cancels only the runs nobody polls", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const slow = "long job\nFAKE_SLEEP_MS=60000";
  const unpolled = await start(env, home, { task: slow, orphanAfterSec: 1, label: "unpolled" });
  const polled = await start(env, home, { task: slow, orphanAfterSec: 3600, label: "polled" });
  const detached = await start(env, home, { task: slow, attached: false, orphanAfterSec: 1, label: "detached" });
  const stateOf = async (runId) => (await runCli(["status", runId], { env })).json.runs[0];
  for (const runId of [unpolled, polled, detached]) {
    assert.ok(await eventually(async () => (await stateOf(runId)).state === "running", { timeoutMs: 30_000, stepMs: 200 }), `${runId} is running`);
  }
  assert.ok(await eventually(async () => (await stateOf(unpolled)).orphaned === true, { timeoutMs: 30_000, stepMs: 200 }));
  assert.equal((await stateOf(polled)).orphaned, undefined);
  assert.equal((await stateOf(detached)).orphaned, undefined, "a detached run has no caller to lose");

  const out = await runCli(["cancel", "--orphaned"], { env });
  assert.equal(out.code, 0, out.stdout);
  assert.equal(out.json.ok, true);
  assert.deepEqual(out.json.cancelled, [{ runId: unpolled, label: "unpolled", state: "cancelled" }]);
  assert.equal((await stateOf(unpolled)).state, "cancelled");
  assert.equal((await stateOf(polled)).state, "running", "a polled run is left alone");
  assert.equal((await stateOf(detached)).state, "running", "so is a detached one");
  // nothing orphaned any more: an empty list
  assert.deepEqual((await runCli(["cancel", "--orphaned"], { env })).json.cancelled, []);
  // the two forms do not mix
  assert.equal((await runCli(["cancel", polled, "--orphaned"], { env })).code, 2);
  assert.equal((await runCli(["cancel"], { env })).code, 2);
  for (const runId of [polled, detached]) assert.equal((await runCli(["cancel", runId], { env })).json.state, "cancelled");
});

test("a long wait keeps refreshing the heartbeat while it blocks", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const runId = await start(env, home, { task: "slow job\nFAKE_SLEEP_MS=4000" });
  const waiter = runCli(["wait", runId, "--max-wait", "590"], { env, timeoutMs: 60_000 });
  const beats = new Set();
  for (const until = Date.now() + 2500; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 100))) {
    beats.add(fs.readFileSync(runFile(home, runId, "heartbeat"), "utf8"));
  }
  assert.ok(beats.size >= 5, `the heartbeat moved ${beats.size} times in 2.5 s: a ten-minute wait never comes near orphanAfterSec`);
  const done = await waiter;
  assert.equal(done.json.state, "done");
});
