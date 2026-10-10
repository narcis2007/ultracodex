// The MCP server: the protocol (hand-written JSON-RPC over stdio), the tools end to end against the
// fake Codex, and the channel that pushes questions and finished turns into the session.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { newRunId } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { ROOT, eventually, fastEnv, makeHome, runCli } from "./helpers.mjs";
import { requests, sessionEvents, sessionHome, startSession, untilEvent } from "./helpers-session.mjs";

const SERVER = path.join(ROOT, "plugins", "ultracodex", "scripts", "mcp-server.mjs");
const hash = (owner) => createHash("sha256").update(owner).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOOL_NAMES = ["codex_start", "codex_sessions", "codex_send", "codex_interrupt", "codex_answer", "codex_events", "codex_wait", "codex_result", "codex_close"];

// A server over stdio: requests resolve with the response, everything without an id is kept as a
// notification.
function startServer(t, env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const waiting = new Map();
  const messages = [];
  let stderr = "";
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const message = JSON.parse(line); // every line the server writes is protocol
      messages.push(message);
      if (message.id !== undefined && message.id !== null && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  t.after(() => child.kill());
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const server = {
    child,
    exited,
    stderr: () => stderr,
    messages,
    notifications: () => messages.filter((message) => message.id === undefined && message.method),
    channel: () => messages.filter((message) => message.method === "notifications/claude/channel").map((message) => message.params),
    raw: (text) => child.stdin.write(text),
    notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    request: (method, params, { timeoutMs = 90_000 } = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} ${JSON.stringify(params)}\n${stderr}`)), timeoutMs);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      }),
    // a tool's text as JSON (or the response when it is an error)
    call: async (name, args = {}) => {
      const response = await server.request("tools/call", { name, arguments: args });
      assert.ok(response.result, JSON.stringify(response));
      const text = response.result.content[0].text;
      let json = null;
      try {
        json = JSON.parse(text.trim().split("\n").at(-1));
      } catch {
        json = null;
      }
      return { isError: Boolean(response.result.isError), text, json };
    },
    initialize: async (protocolVersion = "2025-06-18") => {
      const response = await server.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } });
      server.notify("notifications/initialized");
      return response.result;
    },
  };
  return server;
}

const ASK = (question, answer) => `decide\nASK: ${question}\nFAKE_ANSWER=${answer}`;

test("initialize: the client's revision is echoed when known, else 2025-06-18; the channel capability and instructions are declared", async (t) => {
  const { env } = sessionHome(t);
  const server = startServer(t, env);
  const modern = await server.request("initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } });
  assert.equal(modern.jsonrpc, "2.0");
  assert.equal(modern.result.protocolVersion, "2025-06-18", "the newer revision cannot carry channel messages");
  assert.deepEqual(modern.result.capabilities, { tools: {}, experimental: { "claude/channel": {} } });
  assert.equal(modern.result.serverInfo.name, "ultracodex");
  assert.match(modern.result.instructions, /codex_start/);
  assert.match(modern.result.instructions, /channel/);
  assert.ok(modern.result.instructions.length < 1500, "short");
  for (const known of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    assert.equal((await server.request("initialize", { protocolVersion: known })).result.protocolVersion, known);
  }
  assert.equal((await server.request("initialize", {})).result.protocolVersion, "2025-06-18");
  assert.equal((await server.request("initialize", { protocolVersion: 7 })).result.protocolVersion, "2025-06-18");
});

test("tools/list: nine tools with strict schemas", async (t) => {
  const { env } = sessionHome(t);
  const server = startServer(t, env);
  await server.initialize();
  const { tools } = (await server.request("tools/list")).result;
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  const strict = (schema, at) => {
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false, `${at} is closed`);
      for (const [key, value] of Object.entries(schema.properties ?? {})) strict(value, `${at}.${key}`);
    }
    if (schema.type === "array") strict(schema.items, `${at}[]`);
  };
  for (const tool of tools) {
    assert.ok(tool.description.length > 60 && tool.description.length < 1800, `${tool.name} has a description of a sensible size`);
    assert.equal(tool.inputSchema.type, "object");
    strict(tool.inputSchema, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
  assert.deepEqual(byName.codex_start.required, ["cwd"]);
  assert.deepEqual(byName.codex_send.required, ["runId", "message"]);
  assert.deepEqual(byName.codex_answer.required, ["runId", "questionId", "answer"]);
  assert.deepEqual(byName.codex_wait.properties.waitSec, { type: "integer", minimum: 1, maximum: 600, description: "default 300" });
  assert.equal(byName.codex_events.properties.waitSec.maximum, 300);
  assert.deepEqual(byName.codex_send.properties.mode.enum, ["auto", "steer", "queue"]);
  assert.match(tools.find((tool) => tool.name === "codex_start").description, /codex-implement skill/);
  assert.match(tools.find((tool) => tool.name === "codex_send").description, /step boundary/);
  assert.match(tools.find((tool) => tool.name === "codex_answer").description, /blocked/);
  assert.match(tools.find((tool) => tool.name === "codex_send").description, /dormant/);
  assert.match(tools.find((tool) => tool.name === "codex_close").description, /dormant/);
});

test("protocol edges: ping, unknown methods and tools, bad arguments, malformed lines, notifications, stdin closing", async (t) => {
  const { env } = sessionHome(t);
  const server = startServer(t, env);
  await server.initialize();
  assert.deepEqual((await server.request("ping")).result, {});
  const unknown = await server.request("resources/list");
  assert.deepEqual([unknown.error.code, unknown.result], [-32601, undefined]);
  server.notify("notifications/something-new", { x: 1 }); // ignored, no answer
  server.raw("this is not json\n");
  server.raw('{"jsonrpc":"2.0"}\n'); // neither request nor notification
  server.raw("\n   \n");
  server.raw('[{"jsonrpc":"2.0","id":901,"method":"ping"},{"jsonrpc":"2.0","id":902,"method":"nope"}]\n'); // a batch
  await eventually(() => server.messages.some((message) => message.id === 902));
  assert.deepEqual(server.messages.find((message) => message.id === 901).result, {});
  assert.equal(server.messages.find((message) => message.id === 902).error.code, -32601);
  const parse = server.messages.find((message) => message.error?.code === -32700);
  assert.equal(parse.id, null, "a line that is not JSON is answered, and the server lives on");
  assert.deepEqual((await server.request("ping")).result, {});

  const tool = await server.request("tools/call", { name: "codex_nothing", arguments: {} });
  assert.equal(tool.error.code, -32602);
  for (const [name, args, message] of [
    ["codex_send", {}, /runId is required/],
    ["codex_send", { runId: "nope", message: "x" }, /runId has the wrong form/],
    ["codex_send", { runId: "20261010T120000Z-abc123", message: "x", mode: "shout" }, /mode must be one of/],
    ["codex_wait", { runId: "20261010T120000Z-abc123", waitSec: 601 }, /at most 600/],
    ["codex_events", { runId: "20261010T120000Z-abc123", waitSec: 301 }, /at most 300/],
    ["codex_events", { runId: "20261010T120000Z-abc123", extra: 1 }, /not a known argument/],
    ["codex_close", { runId: "20261010T120000Z-abc123", force: "yes" }, /must be a boolean/],
  ]) {
    const out = await server.call(name, args);
    assert.equal(out.isError, true, name);
    assert.match(out.text, message);
  }
  assert.deepEqual(server.notifications(), [], "no channel traffic without sessions");
  assert.equal(server.stderr(), "", "nothing but protocol on stdout, nothing alarming on stderr");

  server.child.stdin.end();
  assert.equal(await server.exited, 0, "stdin closing ends the server");
});

test("a whole session through the tools: start, wait for its question, answer, follow up, read, close", async (t) => {
  const { home, env, calls } = sessionHome(t, { ULTRACODEX_OWNER: "owner-mcp" });
  const server = startServer(t, env);
  await server.initialize();

  const neither = await server.call("codex_start", { cwd: home });
  assert.equal(neither.isError, true);
  assert.match(neither.text, /exactly one of task and taskFile/);
  const both = await server.call("codex_start", { cwd: home, task: "a", taskFile: path.join(home, "x.md") });
  assert.match(both.text, /exactly one of task and taskFile/);
  assert.match((await server.call("codex_start", { cwd: "relative/dir", task: "a" })).text, /cwd must be an absolute path/);
  assert.match((await server.call("codex_start", { cwd: home, taskFile: "brief.md" })).text, /taskFile must be an absolute path/);
  const missingFile = await server.call("codex_start", { cwd: home, taskFile: path.join(home, "no-such-brief.md") });
  assert.equal(missingFile.isError, false, "a refusal by the runner is an answer");
  assert.equal(missingFile.json.state, "rejected");
  assert.equal(fs.existsSync(path.join(home, "runs")), false, "nothing was started");

  const brief = path.join(home, "brief.md");
  fs.writeFileSync(brief, ASK("which database?", "picked"));
  const started = await server.call("codex_start", { cwd: home, taskFile: brief, tier: "light", label: "e2e", effort: "medium", sandbox: "read-only" });
  assert.equal(started.isError, false, started.text);
  assert.deepEqual([started.json.session, started.json.label, started.json.tier], [true, "e2e", "light"]);
  assert.deepEqual([started.json.owner, started.json.ownerSource], ["owner-mcp", "ultracodex_owner"], "the owner id comes back with the run id");
  const runId = started.json.runId;
  assert.deepEqual(fs.readdirSync(path.join(home, "runs")), [runId]);
  const state = JSON.parse(fs.readFileSync(path.join(home, "runs", runId, "state.json"), "utf8"));
  assert.deepEqual([state.owner, state.ownerSource, state.session, state.attached], ["owner-mcp", "ultracodex_owner", true, false], "the server's owner, a session, never attached");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "runs", runId, "request.json"), "utf8")).effort, "medium");

  const listed = await server.call("codex_sessions");
  assert.deepEqual([listed.json.owner, listed.json.ownerSource, listed.json.all], ["owner-mcp", "ultracodex_owner", false]);
  assert.deepEqual(listed.json.sessions.map((entry) => [entry.runId, entry.label, entry.owner]), [[runId, "e2e", "mine"]]);

  // wait returns early with the question
  const waiting = await server.call("codex_wait", { runId, waitSec: 20 });
  assert.equal(waiting.isError, false);
  assert.deepEqual([waiting.json.waitingForAnswer, waiting.json.question], [true, { id: "call-1", question: "which database?" }]);
  const feed = await server.call("codex_events", { runId });
  assert.deepEqual([feed.json.truncated, feed.json.events.some((event) => event.type === "question"), feed.json.lastSeq], [false, true, feed.json.events.at(-1).seq]);
  assert.equal((await server.call("codex_sessions")).json.sessions[0].question.id, "call-1");

  const wrong = await server.call("codex_answer", { runId, questionId: "nope", answer: "x" });
  assert.deepEqual([wrong.isError, wrong.json.outcome], [false, "no_such_question"]);
  const answered = await server.call("codex_answer", { runId, questionId: "call-1", answer: "post'gres \"quoted\"\nand a second line" });
  assert.deepEqual([answered.json.ok, answered.json.outcome], [true, "answered"]);
  const first = await server.call("codex_wait", { runId, waitSec: 30 });
  assert.deepEqual([first.json.ok, first.json.session.turn], [true, 1]);
  assert.equal(first.json.text, "picked answered: post'gres \"quoted\"\nand a second line");

  // a follow-up with a long message travels intact
  const long = `third\nFAKE_ANSWER=long ok\n${"a line with 'quotes', \"double\" ones, a \\ backslash and %20 in it\n".repeat(400)}`;
  assert.ok(long.length > 20_000);
  const sent = await server.call("codex_send", { runId, message: "second\nFAKE_ANSWER=two", mode: "auto" });
  assert.deepEqual([sent.json.ok, sent.json.outcome, sent.json.turn], [true, "started", 2]);
  assert.equal((await server.call("codex_wait", { runId, waitSec: 30 })).json.text, "two");
  assert.equal((await server.call("codex_send", { runId, message: long })).json.outcome, "started");
  assert.equal((await server.call("codex_wait", { runId, waitSec: 30 })).json.text, "long ok");
  const starts = requests(calls(), "turn/start");
  assert.equal(starts.at(-1).params.input[0].text, long, "not a character lost in the temp file hop");

  const turn1 = await server.call("codex_result", { runId, turn: 1 });
  assert.equal(turn1.json.text.startsWith("picked answered"), true);
  assert.equal((await server.call("codex_result", { runId })).json.text, "long ok");
  assert.equal((await server.call("codex_result", { runId, turn: 9 })).json.error.kind, "unknown_turn");

  // nothing to steer or interrupt while idle: answers, not errors
  const steer = await server.call("codex_send", { runId, message: "too late", mode: "steer" });
  assert.deepEqual([steer.isError, steer.json.outcome, steer.json.reason], [false, "rejected", "no_active_turn"]);
  const interrupt = await server.call("codex_interrupt", { runId });
  assert.deepEqual([interrupt.isError, interrupt.json.outcome], [false, "no_active_turn"]);

  const closed = await server.call("codex_close", { runId });
  assert.deepEqual([closed.isError, closed.json.ok, closed.json.outcome], [false, true, "closed"]);
  const after = await server.call("codex_send", { runId, message: "anyone?" });
  assert.deepEqual([after.isError, after.json.outcome, after.json.reason], [false, "rejected", "session_ended"]);
  assert.equal((await server.call("codex_sessions")).json.sessions[0].state, "closed");
  const unknownRun = await server.call("codex_wait", { runId: "20200101T000000Z-000000", waitSec: 1 });
  assert.deepEqual([unknownRun.isError, unknownRun.json.error.kind], [false, "unknown_run"]);
});

test("a steer through the tool lands in the running turn; interrupt and force-close act on it", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_OWNER: "owner-mcp" });
  const server = startServer(t, env);
  await server.initialize();
  const steered = await server.call("codex_start", { cwd: home, task: "long job\nFAKE_WAIT_STEER=1", tier: "light" });
  assert.equal(steered.isError, false, steered.text);
  const runId = steered.json.runId;
  assert.ok(await untilEvent(home, runId, (event) => event.type === "command"));
  const ack = await server.call("codex_send", { runId, message: "go left, not right" });
  assert.deepEqual([ack.json.outcome, ack.json.turn], ["steered", 1]);
  const done = await server.call("codex_wait", { runId, waitSec: 30 });
  assert.match(done.json.text, /steered: \["go left, not right"\]/);

  const endless = await server.call("codex_start", { cwd: home, task: "endless\nFAKE_TURN_MS=60000", tier: "light" });
  const endlessId = endless.json.runId;
  assert.ok(await untilEvent(home, endlessId, (event) => event.type === "command"));
  const refused = await server.call("codex_close", { runId: endlessId });
  assert.deepEqual([refused.isError, refused.json.outcome, refused.json.reason], [false, "rejected", "turn_active"]);
  const interrupted = await server.call("codex_interrupt", { runId: endlessId });
  assert.equal(interrupted.json.outcome, "interrupted");
  assert.equal((await server.call("codex_close", { runId: endlessId, force: true, archive: false })).json.outcome, "closed");
});

test("codex_sessions: owner-filtered unless all; the owner source is reported", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_OWNER: "" });
  const instance = startServer(t, env); // nothing names its owner: a private id for this server instance
  await instance.initialize();
  const mine = await instance.call("codex_start", { cwd: home, task: "plain\nFAKE_ANSWER=one", tier: "light" });
  const theirs = await startSession({ ...env, ULTRACODEX_OWNER: "someone-else" }, home, { task: "plain\nFAKE_ANSWER=two", tier: "light" });
  const unowned = await startSession(env, home, { task: "plain\nFAKE_ANSWER=three", tier: "light" });
  const listed = await instance.call("codex_sessions");
  assert.equal(listed.json.ownerSource, "instance");
  assert.match(listed.json.owner, /^mcp-[0-9a-f]{16}$/);
  assert.deepEqual(listed.json.sessions.map((entry) => entry.runId), [mine.json.runId]);
  const everything = await instance.call("codex_sessions", { all: true });
  assert.deepEqual(
    Object.fromEntries(everything.json.sessions.map((entry) => [entry.runId, entry.owner])),
    { [mine.json.runId]: "mine", [theirs]: "other", [unowned]: "none" }
  );

  const viaSessionId = startServer(t, { ...env, CLAUDE_CODE_SESSION_ID: "claude-session-1" });
  await viaSessionId.initialize();
  const reported = (await viaSessionId.call("codex_sessions")).json;
  assert.deepEqual([reported.owner, reported.ownerSource], ["claude-session-1", "claude_code_session_id"]);
  const preferred = startServer(t, { ...env, CLAUDE_CODE_SESSION_ID: "claude-session-1", ULTRACODEX_OWNER: "from-the-hook" });
  await preferred.initialize();
  assert.deepEqual([(await preferred.call("codex_sessions")).json.owner, (await preferred.call("codex_sessions")).json.ownerSource], ["from-the-hook", "ultracodex_owner"]);
});

// ── codex_events on hand-made runs ──

function fakeRun(home, count, { text = "x", owner = "owner-mcp" } = {}) {
  const runId = newRunId(new Date(Date.UTC(2026, 9, 10, 12, 0, 0) + Math.floor(Math.random() * 1e6)));
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "idle", runId, session: true, owner, turn: 1 }));
  const lines = [];
  for (let seq = 1; seq <= count; seq += 1) lines.push(JSON.stringify({ seq, t: "t", turn: 1, type: "message", phase: "commentary", text }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
  return { runId, dir };
}

test("codex_events pages at 200 events (and at a size budget) and says where to continue", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const server = startServer(t, env);
  await server.initialize();
  const { runId } = fakeRun(home, 450);
  const page = async (since) => (await server.call("codex_events", since === undefined ? { runId } : { runId, since })).json;
  const first = await page();
  assert.deepEqual([first.events.length, first.truncated, first.lastSeq, first.events[0].seq], [200, true, 200, 1]);
  const second = await page(first.lastSeq);
  assert.deepEqual([second.events.length, second.truncated, second.lastSeq, second.events[0].seq], [200, true, 400, 201]);
  const third = await page(second.lastSeq);
  assert.deepEqual([third.events.length, third.truncated, third.lastSeq], [50, false, 450]);
  const none = await page(450);
  assert.deepEqual([none.events, none.truncated, none.lastSeq, none.state], [[], false, 450, "idle"]);

  const big = fakeRun(home, 100, { text: "y".repeat(3900) });
  const bounded = (await server.call("codex_events", { runId: big.runId })).json;
  assert.ok(bounded.truncated && bounded.events.length < 100 && bounded.events.length >= 10, `a size budget, not only a count: ${bounded.events.length}`);
  assert.equal(bounded.lastSeq, bounded.events.at(-1).seq);
  const rest = (await server.call("codex_events", { runId: big.runId, since: bounded.lastSeq })).json;
  assert.equal(rest.events[0].seq, bounded.lastSeq + 1, "paging loses nothing");
  const one = fakeRun(home, 0);
  assert.equal((await server.call("codex_events", { runId: one.runId })).json.lastSeq, 0);
  assert.equal((await server.call("codex_events", { runId: "20200101T000000Z-000000" })).json.error.kind, "unknown_run");
  const oneShot = fakeRun(home, 1);
  fs.writeFileSync(path.join(oneShot.dir, "state.json"), JSON.stringify({ state: "done", runId: oneShot.runId }));
  assert.equal((await server.call("codex_events", { runId: oneShot.runId })).json.error.kind, "not_a_session");
});

test("codex_events waitSec returns when a new event arrives, or when the time is up", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home);
  const server = startServer(t, env);
  await server.initialize();
  const run = fakeRun(home, 3);
  const quiet = Date.now();
  const empty = (await server.call("codex_events", { runId: run.runId, since: 3, waitSec: 1 })).json;
  assert.deepEqual([empty.events, empty.lastSeq], [[], 3]);
  assert.ok(Date.now() - quiet >= 900, "it waited");

  const started = Date.now();
  const waiting = server.call("codex_events", { runId: run.runId, since: 3, waitSec: 20 });
  await sleep(700);
  fs.appendFileSync(path.join(run.dir, "events.jsonl"), `${JSON.stringify({ seq: 4, t: "t", turn: 1, type: "question", id: "q", question: "now?" })}\n`);
  const woken = (await waiting).json;
  assert.deepEqual(woken.events.map((event) => event.seq), [4]);
  assert.ok(Date.now() - started < 10_000, "it returned when the event came, not at the deadline");
  // a session that ended answers at once
  fs.writeFileSync(path.join(run.dir, "result.json"), JSON.stringify({ ok: true, state: "closed" }));
  const ended = Date.now();
  assert.deepEqual((await server.call("codex_events", { runId: run.runId, since: 4, waitSec: 30 })).json.events, []);
  assert.ok(Date.now() - ended < 5000);
});

// ── the channel ──

const identifier = /^[A-Za-z0-9_]+$/;

test("the channel pushes a pending question once, only after initialized; then the finished turn; nothing for other owners", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_OWNER: "owner-ch" });
  const mine = await startSession(env, home, { task: ASK("which database?", "picked"), tier: "light", label: "Implement: DB choice" });
  const theirs = await startSession({ ...env, ULTRACODEX_OWNER: "owner-other" }, home, { task: ASK("which colour?", "red"), tier: "light" });
  assert.ok(await untilEvent(home, mine, (event) => event.type === "question"));
  assert.ok(await untilEvent(home, theirs, (event) => event.type === "question"));

  const server = startServer(t, env);
  await server.request("initialize", { protocolVersion: "2025-06-18" });
  await sleep(1500);
  assert.deepEqual(server.channel(), [], "nothing before the client said initialized");
  server.notify("notifications/initialized");
  assert.ok(await eventually(() => server.channel().length >= 1, { timeoutMs: 20_000 }));
  await sleep(1200);
  const [question] = server.channel();
  assert.equal(server.channel().length, 1, "once: not again by the next poll");
  assert.equal(server.notifications().length, 1);
  assert.match(question.content, new RegExp(`^Codex session Implement: DB choice \\(${mine}\\) asks: which database\\? - answer with codex_answer\\(`));
  assert.deepEqual(question.meta, { run_id: mine, event: "question", turn: "1", question_id: "call-1", label_slug: "implement-db-choice" });
  for (const [key, value] of Object.entries(question.meta)) assert.ok(identifier.test(key) && typeof value === "string", key);
  assert.equal(typeof question.content, "string");

  // answered through the tool, the turn ends and says so
  assert.equal((await server.call("codex_answer", { runId: mine, questionId: "call-1", answer: "pg" })).json.outcome, "answered");
  assert.ok(await eventually(() => server.channel().length >= 2, { timeoutMs: 20_000 }));
  const done = server.channel()[1];
  assert.equal(done.meta.event, "turn_done");
  assert.deepEqual([done.meta.run_id, done.meta.turn], [mine, "1"]);
  assert.match(done.content, /finished turn 1 \(ok\): picked answered: pg - read it with codex_result or continue with codex_send/);
  await sleep(1000);
  assert.equal(server.channel().length, 2, "no third message; none about the other owner's session");
  assert.ok(server.channel().every((message) => message.meta.run_id === mine));
  assert.ok(fs.existsSync(path.join(home, "notify", `channel-${hash("owner-ch")}.json`)), "its own cursor namespace");
  assert.ok(!fs.existsSync(path.join(home, "notify", `${hash("owner-ch")}.json`)), "a Monitor watcher's cursor is not shared");
  await runCli(["close", theirs, "--force"], { env });
});

test("a session started through the tools reaches the channel when nothing names the owner (the instance owner)", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_OWNER: "" });
  const server = startServer(t, env);
  await server.initialize();
  const foreign = await startSession({ ...env, ULTRACODEX_OWNER: "stranger" }, home, { task: ASK("not for you?", "x"), tier: "light" });
  const started = await server.call("codex_start", { cwd: home, task: ASK("which one?", "chosen"), tier: "light" });
  const runId = started.json.runId;
  assert.ok(await eventually(() => server.channel().some((message) => message.meta.run_id === runId), { timeoutMs: 20_000 }));
  assert.equal(server.channel()[0].meta.event, "question");
  assert.equal(server.channel().filter((message) => message.meta.run_id === foreign).length, 0);
  assert.equal(fs.existsSync(path.join(home, "notify")) ? fs.readdirSync(path.join(home, "notify")).length : 0, 0, "an instance owner leaves no cursor behind");
  await runCli(["close", foreign, "--force"], { env });
});

test("ULTRACODEX_CHANNEL=0 turns the push off; the tools still work", async (t) => {
  const { home, env } = sessionHome(t, { ULTRACODEX_OWNER: "owner-ch", ULTRACODEX_CHANNEL: "0" });
  const run = await startSession(env, home, { task: ASK("which?", "x"), tier: "light" });
  assert.ok(await untilEvent(home, run, (event) => event.type === "question"));
  const server = startServer(t, env);
  await server.initialize();
  await sleep(2000);
  assert.deepEqual(server.notifications(), []);
  assert.equal((await server.call("codex_wait", { runId: run, waitSec: 10 })).json.waitingForAnswer, true);
  assert.equal(sessionEvents(home, run).filter((event) => event.type === "question").length, 1);
});

test("the channel reports a usage-limit wait once, not once per event", async (t) => {
  const home = makeHome(t);
  const env = fastEnv(home, { ULTRACODEX_OWNER: "owner-ch", ULTRACODEX_NOTIFY_LIMIT_NULL_MS: "3000" }); // far longer than the gap below, however loaded the machine
  const run = fakeRun(home, 0, { owner: "owner-ch" });
  const server = startServer(t, env);
  await server.initialize();
  // the watcher is up (its cursor file exists) and has this run at its end
  assert.ok(await eventually(() => fs.existsSync(path.join(home, "notify", `channel-${hash("owner-ch")}.json`)), { timeoutMs: 15_000 }));
  const events = path.join(run.dir, "events.jsonl");
  let seq = 0;
  const add = (type, fields = {}) => fs.appendFileSync(events, `${JSON.stringify({ seq: (seq += 1), t: new Date().toISOString(), turn: 1, type, ...fields })}\n`);
  // announced at once with no time, then with one: a single message
  add("limit_wait", { resumesAt: null });
  await sleep(200);
  add("limit_wait", { resumesAt: "2026-10-10T13:00:00.000Z" });
  assert.ok(await eventually(() => server.channel().length >= 1, { timeoutMs: 15_000 }));
  add("limit_wait", { resumesAt: "2026-10-10T13:05:00.000Z" });
  await sleep(1500);
  assert.deepEqual(server.channel().map((message) => message.meta.event), ["limit_wait"]);
  assert.match(server.channel()[0].content, /hit a usage limit and waits \(usage should be back at 2026-10-10T13:00:00\.000Z\)/);
  // the next wait never learns a time: one message without one, after a while
  add("resumed", { reason: "limit_reset" });
  add("limit_wait", { resumesAt: null });
  assert.ok(await eventually(() => server.channel().length >= 3, { timeoutMs: 15_000 }));
  await sleep(1500);
  assert.deepEqual(server.channel().map((message) => message.meta.event), ["limit_wait", "resumed", "limit_wait"]);
  assert.ok(!/usage should be back/.test(server.channel()[2].content));
});
