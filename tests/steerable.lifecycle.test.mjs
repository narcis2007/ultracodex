// Steerable workflow nodes (0.6.0), part 5: the corners — a writing node, a node whose supervisor is gone, a
// second check that fails after the thread started, and the feed of a node that ended.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { eventually, pidAlive, runCli } from "./helpers.mjs";
import { hasResult, readJson, readState, requests, runDir, send, sessionEvents, sessionHome, spawns, untilEvent, wait } from "./helpers-session.mjs";
import { startNode } from "./helpers-steerable.mjs";

test("a direct writing node: the app-server is started with the write settings, the thread with the write sandbox, and a failure is not retried unless replay-safe", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-work-")); // a writable job may not lie inside the runner's home
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const runId = await startNode(env, home, { task: "edit\nFAKE_ANSWER=edited", tier: "light", sandbox: "workspace-write", network: true, cwd: work, addDirs: [work] });
  const final = await wait(env, runId);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.provenance.sandbox, final.json.kind, final.json.provenance.backend], ["workspace-write", "implement", "session"]);
  const flags = spawns(calls())[0].flags;
  assert.ok(flags.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(flags.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([work])}`));
  const start = requests(calls(), "thread/start")[0].params;
  assert.deepEqual([start.sandbox, start.cwd, start.approvalsReviewer], ["workspace-write", work, "user"]);
  // a transient failure of a writing task is not replayed
  const second = await startNode(env, home, { task: "edit again\nFAKE_FAIL_FIRST=1", tier: "light", sandbox: "workspace-write", cwd: work });
  const failed = await wait(env, second, 40);
  assert.deepEqual([failed.json.ok, failed.json.error.kind, failed.json.provenance.attempts], [false, "server", 1]);
});

test("a node whose supervisor died is lost like any run — never revived; cancel ends it with a one-shot envelope", async (t) => {
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_LOST_AFTER_MS: "1500" });
  const runId = await startNode(env, home, { task: "long\nFAKE_TURN_MS=60000", tier: "light", label: "lost node" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const supervisorPid = readState(home, runId).supervisorPid;
  process.kill(supervisorPid); // the supervisor of this very test run
  assert.ok(await eventually(() => !pidAlive(supervisorPid) && !pidAlive(spawns(calls())[0].pid)));
  const lost = await runCli(["wait", runId, "--max-wait", "20"], { env });
  assert.deepEqual([lost.code, lost.json.state, lost.json.error.kind], [1, "lost", "supervisor_lost"], lost.stdout);
  assert.match(lost.json.error.message, /a steerable job is never revived/);
  assert.doesNotMatch(lost.json.error.message, /`send` revives/);
  // nothing revives it: a message is refused and no supervisor starts
  const ack = await send(env, runId, "carry on");
  assert.deepEqual([ack.code, ack.json.outcome, ack.json.reason], [1, "rejected", "no_active_turn"], ack.stdout);
  assert.equal(requests(calls(), "turn/start").length, 1);
  assert.equal((await runCli(["interrupt", runId], { env })).json.outcome, "no_active_turn");
  assert.equal((await runCli(["status", runId], { env })).json.runs[0].supervisorAlive, false);
  // cancel ends what nobody supervises: the run's own state, in a one-shot run's envelope
  const cancelled = await runCli(["cancel", runId], { env });
  assert.deepEqual([cancelled.json.ok, cancelled.json.state, cancelled.json.error.kind], [false, "cancelled", "cancelled"], cancelled.stdout);
  assert.equal(cancelled.json.session, undefined);
  assert.equal(cancelled.json.provenance.backend, "session");
  assert.equal(hasResult(home, runId), true);
  assert.equal((await send(env, runId, "late")).json.reason, "session_ended");
});

test("close of a node whose supervisor is gone is acknowledged and ends it as cancelled", async (t) => {
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_LOST_AFTER_MS: "1500" });
  const runId = await startNode(env, home, { task: "long\nFAKE_TURN_MS=60000", tier: "light" });
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const supervisorPid = readState(home, runId).supervisorPid;
  process.kill(supervisorPid);
  assert.ok(await eventually(() => !pidAlive(supervisorPid) && !pidAlive(spawns(calls())[0].pid)));
  const closed = await runCli(["close", runId], { env });
  assert.deepEqual([closed.code, closed.json.outcome], [0, "closed"], closed.stdout);
  assert.equal(readJson(path.join(runDir(home, runId), "result.json")).state, "cancelled");
});

test("events --follow of a node ends when the job does; the feed has no idle or dormant", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startNode(env, home, { task: "feed\nFAKE_TURN_MS=1500\nFAKE_ANSWER=done", tier: "light" });
  const followed = await runCli(["events", runId, "--follow", "--max-wait", "30"], { env });
  const lines = followed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const end = lines.at(-1);
  assert.deepEqual([followed.code, end.type, end.reason, end.state], [0, "follow_end", "ended", "done"], followed.stdout);
  assert.deepEqual(lines.filter((line) => line.seq).map((line) => line.type).filter((type) => ["idle", "dormant", "closed"].includes(type)), []);
  assert.equal(lines.some((line) => line.type === "turn_completed" && line.ok === true), true, "the whole feed arrived before the end");
  // the feed of an ended node is still readable
  assert.equal((await runCli(["events", runId], { env })).code, 0);
});

test("an MCP server that reports tools after the thread started: the node runs on exec; the app-server is gone", async (t) => {
  const { home, env, calls } = sessionHome(t, { FAKE_CODEX_MCP_SERVERS: JSON.stringify({ rogue: { tools: 2, sticky: true } }) });
  env.FAKE_CODEX_ARGV_LOG = path.join(home, "argv.jsonl");
  const runId = await startNode(env, home, { task: "rogue\nFAKE_OUTPUT=from exec", tier: "light" });
  const final = await wait(env, runId, 40);
  assert.equal(final.code, 0, final.stdout);
  assert.deepEqual([final.json.text, final.json.provenance.backend], ["from exec", "exec"]);
  assert.equal(requests(calls(), "thread/start").length, 1, "the thread was started: this is the second check");
  assert.equal(requests(calls(), "turn/start").length, 0);
  const events = sessionEvents(home, runId);
  assert.deepEqual(events.find((event) => event.type === "hermetic_violation").servers, ["rogue"]);
  assert.equal(events.find((event) => event.type === "backend_fallback").kind, "hermetic_violation");
  assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)));
});
