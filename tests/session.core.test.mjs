// Sessions, part 1: the JSON-RPC client, the app-server command line, one turn end to end, the
// event feed, wait / result / status. The Codex CLI is the offline fake (tests/fixtures/fake-codex.mjs),
// which also plays `app-server --listen stdio://`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { JsonRpcClient, buildAppServerArgs, classifySessionError, configuredMcpServers } from "../plugins/ultracodex/scripts/session.mjs";
import { makeHome, runCli } from "./helpers.mjs";
import { eventsOf, jsonLines, readJson, readState, requests, runDir, sessionEvents, sessionHome, spawns, startSession, untilState, wait } from "./helpers-session.mjs";

const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };

test("JsonRpcClient: ids, answers, notifications, server requests, junk and oversized lines", async () => {
  const sent = [];
  const notes = [];
  const client = new JsonRpcClient({
    send: (message) => (sent.push(message), true),
    onNotification: (message) => notes.push(message),
    onServerRequest: async (message) => {
      if (message.method === "boom") throw Object.assign(new Error("nope"), { code: -32000 });
      return { echoed: message.params };
    },
    maxLineChars: 200,
  });
  const first = client.request("a/b", { x: 1 });
  const second = client.request("c/d");
  assert.deepEqual(sent.map((message) => [message.id, message.method, message.jsonrpc]), [[1, "a/b", "2.0"], [2, "c/d", "2.0"]]);
  // a server request whose id collides with ours is a request, not an answer; junk is skipped
  client.feed('{"id":1,"method":"srv/call","params":{"k":2}}\nnot json at all\n[1,2]\n{"method":"note/one","params":{"n":1}}\n{"id":2,"error":{"code":-32600,"message":"bad","data":{"d":1}}}\n');
  await assert.rejects(second, (error) => error.code === -32600 && error.data.d === 1 && /bad/.test(error.message));
  client.feed('{"id":1,"result":{"ok":true}}\n');
  assert.deepEqual(await first, { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 1, result: { echoed: { k: 2 } } }, "the answer to the server request carries the server's id");
  assert.deepEqual(notes.map((message) => message.method), ["note/one"]);
  assert.equal(client.stats.junk, 2);
  // a throwing server-request handler answers with an error instead of throwing into the stream
  client.feed('{"id":"s-9","method":"boom"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: "s-9", error: { code: -32000, message: "nope" } });
  // lines split over chunks, and an oversized line dropped up to its newline
  client.feed('{"method":"split/');
  client.feed('line"}\n');
  client.feed(`{"method":"huge","params":"${"x".repeat(500)}`);
  client.feed(`${"y".repeat(500)}"}\n{"method":"after"}\n`);
  assert.deepEqual(notes.map((message) => message.method), ["note/one", "split/line", "after"]);
  assert.equal(client.stats.oversized, 1);
  // timeouts and closing reject what is pending, and later requests too
  await assert.rejects(client.request("slow", {}, { timeoutMs: 30 }), (error) => error.code === "timeout");
  const pending = client.request("never");
  client.close();
  await assert.rejects(pending, (error) => error.code === "closed");
  await assert.rejects(client.request("late"), (error) => error.code === "closed");
});

test("configuredMcpServers reads bare, quoted and inline spellings and ignores sub-tables", (t) => {
  const home = makeHome(t);
  fs.writeFileSync(
    path.join(home, "config.toml"),
    [
      'model = "x"',
      'mcp_servers.dotted.command = "c"',
      "",
      "[mcp_servers.alpha]",
      'command = "node"',
      "[mcp_servers.alpha.env]",
      'KEY = "v"',
      '[mcp_servers."beta.gamma"]',
      'url = "https://x"',
      "[mcp_servers.'delta']",
      "# [mcp_servers.commented]",
      "[mcp_servers]",
      'inline = { command = "x" }',
      '"quoted inline" = { command = "y" }',
      "[windows]",
      'sandbox = "elevated"',
      "[other]",
      'mcp_servers.not = "a server"',
    ].join("\n")
  );
  assert.deepEqual(configuredMcpServers({ CODEX_HOME: home }).sort(), ["alpha", "beta.gamma", "delta", "dotted", "inline", "quoted inline"]);
  assert.deepEqual(configuredMcpServers({ CODEX_HOME: path.join(home, "missing") }), []);
});

test("buildAppServerArgs: hermetic disables, sandbox settings, service tier", () => {
  const base = { hermetic: true, sandbox: "read-only", network: false, addDirs: [], serviceTier: null };
  const readOnly = buildAppServerArgs(base, { platform: "linux", mcpServers: ["a", "b-c", "d.e"] });
  assert.deepEqual(readOnly.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.deepEqual(readOnly.slice(3, 9), ["--disable", "plugins", "--disable", "apps", "-c", "notify=[]"]);
  assert.ok(readOnly.includes("mcp_servers.a.enabled=false") && readOnly.includes("mcp_servers.b-c.enabled=false"));
  assert.ok(readOnly.includes('mcp_servers."d.e".enabled=false'), "a name that is not a bare key is quoted");
  assert.ok(!readOnly.some((arg) => arg.startsWith("sandbox_workspace_write")), "no write settings for a read-only session");
  assert.ok(!readOnly.some((arg) => arg.startsWith("windows.sandbox")), "no Windows setting off Windows");
  assert.ok(buildAppServerArgs(base, { platform: "win32", windowsSandbox: "elevated" }).includes('windows.sandbox="elevated"'));
  const open = buildAppServerArgs({ ...base, hermetic: false, sandbox: "workspace-write", network: true, addDirs: ["/c/x y"], serviceTier: "priority" }, { platform: "win32", windowsSandbox: "elevated", mcpServers: ["a"] });
  assert.deepEqual(open, ["app-server", "--listen", "stdio://", "-c", "sandbox_workspace_write.network_access=true", "-c", 'sandbox_workspace_write.writable_roots=["/c/x y"]', "-c", 'service_tier="priority"']);
});

test("classifySessionError maps codexErrorInfo onto the runner's failure kinds", () => {
  const kind = (error) => classifySessionError(error).kind;
  assert.equal(kind({ message: "m", codexErrorInfo: "usageLimitExceeded" }), "usage_limit");
  assert.equal(kind({ message: "m", codexErrorInfo: "rateLimitExceeded" }), "rate_limit");
  assert.equal(classifySessionError({ message: "m", codexErrorInfo: "rateLimitExceeded" }).retryable, true);
  assert.equal(kind({ message: "m", codexErrorInfo: "unauthorized" }), "auth");
  assert.equal(kind({ message: "m", codexErrorInfo: "contextWindowExceeded" }), "context");
  assert.equal(kind({ message: "m", codexErrorInfo: "serverOverloaded" }), "server");
  assert.equal(kind({ message: "m", codexErrorInfo: "internalServerError" }), "server");
  assert.equal(kind({ message: "m", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }), "network");
  assert.equal(kind({ message: "m", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }), "network");
  assert.equal(kind({ message: "m", codexErrorInfo: "badRequest" }), "invalid_request");
  assert.equal(kind({ message: "m", codexErrorInfo: "other" }), "execution");
  assert.equal(kind({ message: "m", codexErrorInfo: null }), "execution");
  // the encrypted-reasoning rejection is told by its text, whatever the structured info says
  assert.equal(kind({ message: "The encrypted content could not be verified", codexErrorInfo: "badRequest" }), "encrypted_history");
  // anything else: the existing text classifier
  assert.equal(kind({ message: "You have hit your usage limit", codexErrorInfo: "other" }), "usage_limit");
});

test("a session runs one turn on a private app-server; wait returns the turn's envelope; the session is idle", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "do it\nFAKE_ANSWER=hello", schema: SCHEMA, tier: "light", kind: "ask", effort: "medium" });
  const waited = await wait(env, runId);
  assert.equal(waited.code, 0, waited.stdout);
  const turn = waited.json;
  assert.equal(turn.ok, true);
  assert.equal(turn.state, "done");
  assert.deepEqual(turn.result, { answer: "hello" }, "the schema's JSON, parsed");
  assert.ok(turn.mac && turn.resultHash, "signed like a one-shot run's result");
  assert.equal(turn.runId, runId);
  assert.equal(turn.session.turn, 1);
  assert.equal(turn.session.state, "idle");
  assert.ok(turn.session.idleUntil, "idleUntil is reported");
  const provenance = turn.provenance;
  assert.deepEqual([provenance.model, provenance.effort, provenance.tier, provenance.mode, provenance.sandbox], ["gpt-6-luna", "medium", "light", "exec", "read-only"]);
  assert.match(provenance.threadId, /^01a0fake-/);
  assert.deepEqual(provenance.usage, { input_tokens: 120, cached_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 4 }, "this turn's usage");
  assert.deepEqual(provenance.usageTotal, provenance.usage);
  assert.ok(provenance.durationMs >= 0);

  // the file the envelope came from, and the state
  assert.deepEqual(readJson(path.join(runDir(home, runId), "turns", "1.json")).result, { answer: "hello" });
  assert.equal(fs.existsSync(path.join(runDir(home, runId), "result.json")), false, "an idle session is not finished");
  const state = readState(home, runId);
  assert.deepEqual([state.state, state.session, state.turn, state.turnActive, state.queued, state.question, state.threadId], ["idle", true, 1, false, 0, null, provenance.threadId]);

  // what the runner asked the app-server, exactly
  const log = calls();
  assert.equal(spawns(log).length, 1);
  assert.deepEqual(spawns(log)[0].flags.slice(0, 6), ["--disable", "plugins", "--disable", "apps", "-c", "notify=[]"], "hermetic by default");
  const init = requests(log, "initialize")[0].params;
  assert.equal(init.capabilities.experimentalApi, true);
  assert.equal(init.clientInfo.name, "ultracodex");
  const start = requests(log, "thread/start")[0].params;
  assert.deepEqual([start.model, start.sandbox, start.approvalPolicy, start.ephemeral], ["gpt-6-luna", "read-only", "never", false]);
  assert.equal(start.cwd, process.cwd());
  assert.deepEqual(start.dynamicTools.map((tool) => tool.name), ["ask_orchestrator"]);
  assert.deepEqual(start.dynamicTools[0].inputSchema.required, ["question"]);
  const turnStart = requests(log, "turn/start")[0].params;
  assert.equal(turnStart.threadId, provenance.threadId);
  assert.equal(turnStart.effort, "medium");
  assert.deepEqual(turnStart.outputSchema, SCHEMA);
  assert.deepEqual(turnStart.input, [{ type: "text", text: "do it\nFAKE_ANSWER=hello", text_elements: [] }]);
  assert.deepEqual(requests(log).map((entry) => entry.method).slice(0, 4), ["initialize", "initialized", "thread/start", "mcpServerStatus/list"], "the hermetic check comes before the first turn");

  // status and result
  const status = (await runCli(["status", runId], { env })).json.runs[0];
  assert.deepEqual([status.state, status.session, status.turn, status.turnActive, status.waitingForAnswer, status.ok], ["idle", true, 1, false, false, null]);
  assert.ok(status.idleUntil);
  const latest = await runCli(["result", runId], { env });
  assert.equal(latest.code, 0);
  assert.deepEqual(latest.json.result, { answer: "hello" });
  const byTurn = await runCli(["result", runId, "--turn", "1"], { env });
  assert.deepEqual(byTurn.json.result, { answer: "hello" });
  const missing = await runCli(["result", runId, "--turn", "9"], { env });
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error.kind, "unknown_turn");
});

test("the event feed: compact, ordered, relative paths, no diffs, no reasoning, seq from 1", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "feed me\nFAKE_ANSWER=done", tier: "light" });
  assert.equal((await wait(env, runId)).code, 0);
  const events = sessionEvents(home, runId);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1), "seq is strictly increasing from 1");
  const types = events.map((event) => event.type);
  assert.deepEqual(
    types,
    ["session_started", "turn_started", "message", "command_started", "command", "file_change", "plan", "tool", "tool", "message", "turn_completed", "idle"],
    "one plan only: the second, identical update is skipped"
  );
  const by = (type) => events.filter((event) => event.type === type);
  assert.match(by("session_started")[0].threadId, /^01a0fake-/);
  assert.equal(by("turn_started")[0].reason, "task");
  assert.ok(by("turn_started")[0].turnId);
  assert.deepEqual(by("message").map((event) => event.phase), ["commentary", "final_answer"]);
  assert.equal(by("message")[1].text, "done");
  assert.ok(by("command_started")[0].command.length <= 300);
  const command = by("command")[0];
  assert.deepEqual([command.exitCode, command.status, command.durationMs], [0, "completed", 12]);
  assert.ok(command.command.length <= 300 && command.outputTail.length <= 600 && command.outputTail.endsWith("END"));
  const files = by("file_change")[0];
  assert.equal(files.status, "completed");
  assert.deepEqual(files.changes.map((change) => change.kind), ["add", "update"]);
  assert.equal(files.changes[0].path, "src/fake.txt", "relative to the job's cwd when inside it");
  assert.ok(path.isAbsolute(files.changes[1].path), "absolute when outside it");
  assert.deepEqual(by("plan")[0].steps, [{ step: "read", status: "completed" }, { step: "write", status: "inProgress" }]);
  assert.deepEqual(by("tool").map((event) => event.name), ["docs/search", "web_search"]);
  const completed = by("turn_completed")[0];
  assert.deepEqual([completed.status, completed.ok, completed.usage.input_tokens], ["completed", true, 120]);
  assert.ok(completed.durationMs >= 0);
  assert.ok(Date.parse(by("idle")[0].idleUntil) > Date.now());
  for (const event of events) assert.ok(event.t && Number.isInteger(event.turn));
  const raw = fs.readFileSync(path.join(runDir(home, runId), "events.jsonl"), "utf8");
  assert.doesNotMatch(raw, /SECRET-DIFF-LINE|PRIVATE_REASONING|auth|account/i, "no diffs, reasoning or account data in the feed");

  // `events` prints them as they are (not wrapped), oldest first; --since skips
  const printed = await eventsOf(env, runId);
  assert.deepEqual(printed, events);
  assert.deepEqual((await eventsOf(env, runId, "--since", "10")).map((event) => event.seq), [11, 12]);
  const noWrap = await runCli(["events", runId], { env });
  assert.equal(noWrap.code, 0);
  assert.equal(noWrap.json.ultracodex, undefined, "event lines carry no runner envelope");
});

test("a session that is not one: events, send and friends are rejected", async (t) => {
  const { home, env } = sessionHome(t);
  fs.writeFileSync(path.join(home, "plain.json"), JSON.stringify({ task: "one shot" }));
  const plain = (await runCli(["start", "--request", path.join(home, "plain.json")], { env })).json.runId;
  assert.equal((await wait(env, plain)).json.state, "done");
  for (const args of [["send", plain, "--message", "hi"], ["interrupt", plain], ["answer", plain, "q1", "--text", "a"], ["events", plain], ["close", plain]]) {
    const out = await runCli(args, { env });
    assert.equal(out.code, 1, args.join(" "));
    assert.equal(out.json.outcome, "rejected", args.join(" "));
    assert.equal(out.json.reason, "not_a_session", args.join(" "));
  }
  const unknown = await runCli(["send", "20260101T000000Z-abcdef", "--message", "hi"], { env });
  assert.equal(unknown.json.error.kind, "unknown_run");
  assert.equal((await runCli(["send", plain], { env })).code, 2, "a message is required");
  assert.equal((await runCli(["send", plain, "--message", "a", "--mode", "loud"], { env })).code, 2);
  assert.equal((await runCli(["events", plain, "--since", "x"], { env })).code, 2);
});

test("wait on a session that is still running returns the usual running line with turn details", async (t) => {
  const { home, env } = sessionHome(t);
  const runId = await startSession(env, home, { task: "slow\nFAKE_TURN_MS=3000", tier: "light" });
  assert.ok(await untilState(home, runId, "running"));
  const quick = await runCli(["wait", runId, "--max-wait", "0"], { env });
  assert.equal(quick.code, 3);
  assert.deepEqual([quick.json.state, quick.json.ok, quick.json.session, quick.json.turn, quick.json.turnActive, quick.json.queued], ["running", null, true, 1, true, 0]);
  const state = readState(home, runId);
  assert.equal(state.steerable, true);
  assert.ok(state.deadlineAt && state.attemptStartedAt);
  const done = await wait(env, runId);
  assert.equal(done.json.ok, true);
  assert.equal(jsonLines(path.join(runDir(home, runId), "events.jsonl")).length > 0, true);
});
