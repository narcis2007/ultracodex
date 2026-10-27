#!/usr/bin/env node
// Offline stand-in for the Codex CLI used by the runner tests. Behaviour is driven
// by FAKE_* directives inside the prompt (read from stdin), so no test ever spends
// model quota. Supports: --version, login status, debug models, exec [review|resume], and
// `app-server --listen stdio://` (the rate-limit probe and steerable sessions; see below).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);

// A continuation after the system stopped a turn (see continuationPrompt) repeats the interrupted request
// between <<< and >>>: its FAKE_ lines and ASK: belong to that request, not to the turn that continues it.
const withoutRequest = (text) => (text.startsWith("SYSTEM NOTICE") ? text.replace(/<<<[\s\S]*>>>/, "") : text);

const CATALOG = {
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "fake astra",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
      context_window: 272000,
    },
    {
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1-Sol",
      description: "fake sol",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
      context_window: 272000,
    },
    {
      slug: "gpt-6.1-terra",
      display_name: "GPT-6.1-Terra",
      description: "fake terra",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
      context_window: 500000,
    },
    {
      slug: "gpt-6-luna",
      display_name: "GPT-6-Luna",
      description: "fake luna",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
      context_window: 272000,
    },
  ],
};

if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write(process.env.FAKE_CODEX_LOGGED_OUT ? "Not logged in\n" : "Logged in using ChatGPT\n");
  process.exit(process.env.FAKE_CODEX_LOGGED_OUT ? 1 : 0);
}
if (argv[0] === "debug" && argv[1] === "models") {
  process.stdout.write(JSON.stringify(CATALOG) + "\n");
  process.exit(0);
}
// `app-server --listen stdio://` (+ flags), JSON-RPC one object per line. Two jobs:
//
// 1. The runner's rate-limit probe: initialize, initialized, account/rateLimits/read.
//    FAKE_CODEX_RATE_LIMITS names a JSON file with the scripted answers, one per
//    account/rateLimits/read (the last repeats): {"result": {...}} | {"error": {...}} |
//    {"hang": true} (never answers; leaves when its stdin closes) | {"hang": "ignore-close"}
//    (never answers and ignores the close, so only a kill ends it) | {"exit": 3} (dies mid-call).
//    A `resetsAt` below a million is an offset in seconds from the first probe of the script (the
//    supervisor needs seconds to start, so a test cannot name an absolute time that early).
//    FAKE_CODEX_PROBE_LOG gets one line per message received, so a test can see exactly what the
//    runner sent and how often.
//
// 2. A steerable session (thread/start, thread/resume, turn/start, turn/steer, turn/interrupt,
//    thread/archive, mcpServerStatus/list, the client-side tool call item/tool/call). A turn is
//    scripted by directive lines in its input text (like the exec fake's FAKE_* lines):
//      FAKE_TURN_MS=n        the turn runs n ms (default FAKE_CODEX_TURN_MS, else 0)
//      FAKE_WAIT_STEER=1     the turn ends 100 ms after its first steer (or after 20 s)
//      FAKE_ANSWER=text      the final answer (else "fake answer", or a schema example)
//      ASK: question         the turn calls ask_orchestrator and puts the answer in its final message
//      FAKE_USAGE_LIMIT=n    the first n turns carrying this directive (counted per task, over all processes)
//                            fail with usageLimitExceeded; FAKE_CODEX_USAGE_LIMITS=n does it for the first n
//                            turns of any kind, continuations included
//      FAKE_CRASH=1          the app-server dies (exit 9) in the middle of the turn
//      FAKE_HANG=1           the turn never ends and ignores turn/interrupt
//      FAKE_IGNORE_INTERRUPT=1   turn/interrupt is acknowledged but the turn goes on
//      FAKE_NOT_STEERABLE=1  turn/steer fails with activeTurnNotSteerable
//      FAKE_QUOTA_WORK=file  appends "applied once" to file (an effect that must not be replayed)
//      FAKE_CALL_TOOL=name   the turn calls that client-side tool (arguments {question: "q"}) and reports the reply
//      FAKE_REQUEST=method   the turn sends the client that server request (an approval, say), expecting an error back
//      FAKE_COMMAND_MS=n     the turn holds a command in flight for n ms ("held fake command": item/started, then item/completed)
//    Environment: FAKE_CODEX_SESSION_LOG (one JSON line per spawn / request / answer, with params),
//    FAKE_CODEX_MCP_SERVERS ({"name": tools} or {"name": {"tools": n, "sticky": true}}: a server
//    reports `tools` tools unless the app-server was started with mcp_servers.<name>.enabled=false;
//    a sticky one ignores that), FAKE_CODEX_ENCRYPTED_RESUME=1 (a turn on a thread resumed after an
//    account change fails with the encrypted-content rejection), FAKE_CODEX_ACCOUNT_AFTER_FAILURE
//    (the account written to auth.json when a turn fails with the usage limit), FAKE_CODEX_MCP_ERROR=1
//    (mcpServerStatus/list fails), FAKE_CODEX_MCP_PAGES=1 (one server per page, with nextCursor),
//    FAKE_CODEX_RESUME_FAILS=1 (thread/resume fails), FAKE_CODEX_RESUME_MS=n (thread/resume answers after n ms: a wide
//    window for what happens during an account handoff), FAKE_CODEX_TURN_MS=n (the default length of every turn). Each thread writes a Codex-style rollout file
//    under $CODEX_HOME/sessions (visible messages and tool output) for the checkpoint fallback.
//    config/read (the runner's isolation check of a hermetic app-server): FAKE_CODEX_CONFIG_READ =
//      (unset) | clean   the effective config and origins of exactly the flags this app-server was started with,
//                        all `sessionFlags` — a user config that contributes nothing
//      owner             clean + the keys a real owner's config.toml contributes (driver-owned, inert, neutralized)
//      leak:<key>[,<key>]          clean + those keys with origin `user` (value "leaked-value-must-not-print")
//      leak-project:<key>[,<key>]  the same with origin `project`
//      missing | malformed         a result without usable `origins`
//      error             a JSON-RPC "method not found" (an older Codex)      hang   never answers
//      <path>            that JSON file's content, verbatim, as the result
//    FAKE_CODEX_APP_SERVER_EXIT=n makes the app-server exit with code n before it answers anything. FAKE_CODEX_CONFIG_READ_MS=n
//    answers config/read after n ms. FAKE_CANCEL_BEFORE_COMPLETE=1 (a turn directive) writes the cancel file of every
//    unfinished run under $ULTRACODEX_HOME in the instant before the turn completes.
//    FAKE_FAIL_FIRST=n (a turn directive; counted per task in ${FAKE_CODEX_STATE}.fail-*) fails the first n turns of that
//    task with FAKE_FAIL_KIND (default serverOverloaded; any codexErrorInfo name, e.g. badRequest);
//    FAKE_FAIL_EXIT=1 makes the app-server exit 100 ms after such a failure. FAKE_CODEX_FAIL_TURNS=n (with FAKE_FAIL_KIND)
//    fails the first n turns of any kind, a retry's or a continuation's included.
if (argv[0] === "app-server") {
  if (argv[1] !== "--listen" || argv[2] !== "stdio://") {
    process.stderr.write(`fake-codex: unsupported app-server invocation: ${argv.join(" ")}\n`);
    process.exit(2);
  }
  const flags = argv.slice(3);
  const record = (entry) => {
    if (process.env.FAKE_CODEX_PROBE_LOG) fs.appendFileSync(process.env.FAKE_CODEX_PROBE_LOG, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + "\n");
  };
  const slog = (entry) => {
    if (process.env.FAKE_CODEX_SESSION_LOG) fs.appendFileSync(process.env.FAKE_CODEX_SESSION_LOG, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + "\n");
  };
  slog({ kind: "spawn", flags, cwd: process.cwd() });
  if (process.env.FAKE_CODEX_APP_SERVER_EXIT) process.exit(Number(process.env.FAKE_CODEX_APP_SERVER_EXIT));
  const scriptFile = process.env.FAKE_CODEX_RATE_LIMITS;
  const nextAnswer = () => {
    const entries = JSON.parse(fs.readFileSync(scriptFile, "utf8"));
    const counter = `${scriptFile}.count`;
    const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    fs.writeFileSync(counter, String(seen + 1));
    return entries[Math.min(seen, entries.length - 1)];
  };
  const anchored = (value) => {
    if (Array.isArray(value)) return value.map(anchored);
    if (!value || typeof value !== "object") return value;
    const anchorFile = `${scriptFile}.anchor`;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "resetsAt" && typeof child === "number" && child < 1_000_000) {
        if (!fs.existsSync(anchorFile)) fs.writeFileSync(anchorFile, String(Date.now()));
        out[key] = Number(fs.readFileSync(anchorFile, "utf8")) / 1000 + child;
      } else out[key] = anchored(child);
    }
    return out;
  };
  const write = (body) => process.stdout.write(JSON.stringify(body) + "\n");
  const reply = (id, body) => write({ id, ...body });
  const notify = (method, params) => write({ method, params });
  let stubborn = false;
  let experimental = false;

  // ── session state ──
  const threadsDir = path.join(process.env.CODEX_HOME || os.tmpdir(), "fake-threads");
  let thread = null; // { id, sandbox, model, cwd, turns, usage, askTool, accountChanged }
  let turn = null; // the active turn
  let serverRequests = 0;
  const awaiting = new Map(); // id of a request we sent -> resolve
  const saveThread = () => {
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, `${thread.id}.json`), JSON.stringify({ ...thread, lastPid: process.pid }));
  };
  const rollout = (row) => {
    if (!thread) return;
    const dir = path.join(process.env.CODEX_HOME || os.tmpdir(), "sessions", "2026", "10", "09");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `rollout-2026-10-09T00-00-00-${thread.id}.jsonl`), JSON.stringify(row) + "\n");
  };
  const textOf = (input) => (Array.isArray(input) ? input.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n") : "");
  const lineDirective = (text, name) => {
    const match = new RegExp(`^FAKE_${name}=(.*)$`, "m").exec(withoutRequest(text));
    return match ? match[1].trim() : null;
  };
  const rpcError = (id, code, message, data) => reply(id, { error: { code, message, ...(data ? { data } : {}) } });
  const turnObject = (active, status, error = null) => ({ id: active.id, items: [], status, error, startedAt: active.startedAt, completedAt: status === "inProgress" ? null : Math.floor(Date.now() / 1000), durationMs: Date.now() - active.startedMs });
  const item = (extra) => ({ id: `item-${++itemCounter}`, ...extra });
  let itemCounter = 0;
  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const exampleFor = (schema) => {
    if (!schema || typeof schema !== "object") return null;
    if (Array.isArray(schema.enum)) return schema.enum[0];
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes("null")) return null;
    if (types.includes("object") || schema.properties) {
      const value = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) value[key] = exampleFor(child);
      return value;
    }
    if (types.includes("array")) return [];
    if (types.includes("boolean")) return false;
    if (types.includes("integer") || types.includes("number")) return 0;
    return "x";
  };
  // puts `text` into the `answer` property (else the first string one) of a schema example
  const fillText = (example, schema, text) => {
    if (!example || typeof example !== "object" || !schema?.properties) return example;
    const keys = Object.keys(schema.properties);
    const key = keys.includes("answer") ? "answer" : keys.find((name) => schema.properties[name]?.type === "string");
    if (key) example[key] = text;
    return example;
  };

  const sendLimitFailure = (active) => {
    const message = "You have hit your usage limit. Upgrade to Pro or try again later.";
    if (process.env.FAKE_CODEX_ACCOUNT_AFTER_FAILURE && process.env.CODEX_HOME) {
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: process.env.FAKE_CODEX_ACCOUNT_AFTER_FAILURE } }));
    }
    notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } });
    const error = { message, codexErrorInfo: "usageLimitExceeded", additionalDetails: null };
    notify("error", { error, willRetry: false, threadId: thread.id, turnId: active.id });
    notify("turn/completed", { threadId: thread.id, turn: turnObject(active, "failed", error) });
  };

  const runTurn = async (active) => {
    const text = active.text;
    const fakeFile = lineDirective(text, "QUOTA_WORK");
    active.notSteerable = lineDirective(text, "NOT_STEERABLE") === "1";
    active.ignoreInterrupt = lineDirective(text, "HANG") === "1" || lineDirective(text, "IGNORE_INTERRUPT") === "1";
    notify("turn/started", { threadId: thread.id, turn: turnObject(active, "inProgress") });
    // what Codex's rollout file holds of this turn, visible parts only (the checkpoint fallback reads it)
    rollout({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: text.split("\n")[0].slice(0, 60) }] } });
    rollout({ type: "response_item", payload: { type: "reasoning", encrypted_content: "PRIVATE_ENCRYPTED_BLOB", summary: [{ text: "PRIVATE_REASONING_MUST_NOT_BE_COPIED" }] } });
    if (fakeFile) rollout({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "applied once" } });
    if (lineDirective(text, "CRASH") === "1") {
      await sleepMs(150);
      process.exit(9);
    }
    // two ways to script the limit: a directive in the task (counted per task, by its first line)
    // and FAKE_CODEX_USAGE_LIMITS (the first n turns of any kind, continuations included)
    const limits = Number(lineDirective(text, "USAGE_LIMIT") ?? 0);
    const everyTurn = Number(process.env.FAKE_CODEX_USAGE_LIMITS ?? 0);
    if ((limits > 0 || everyTurn > 0) && process.env.FAKE_CODEX_STATE) {
      const counter = `${process.env.FAKE_CODEX_STATE}.limit-${limits > 0 ? text.split("\n")[0].replace(/[^A-Za-z0-9]/g, "_").slice(0, 40) : "turns"}`;
      const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      if (seen < (limits > 0 ? limits : everyTurn)) {
        fs.writeFileSync(counter, String(seen + 1));
        if (fakeFile) fs.appendFileSync(fakeFile, "applied once\n");
        notify("item/started", { threadId: thread.id, turnId: active.id, item: item({ type: "reasoning", summary: [], content: ["PRIVATE_REASONING_MUST_NOT_BE_COPIED"] }) });
        return sendLimitFailure(active);
      }
    }
    // two ways to script a failure, like the usage limit: a directive (the first n turns of that task) and
    // FAKE_CODEX_FAIL_TURNS (the first n turns of any kind, a retry's or a continuation's included)
    const failFirst = Number(lineDirective(text, "FAIL_FIRST") ?? 0);
    const failTurns = Number(process.env.FAKE_CODEX_FAIL_TURNS ?? 0);
    if ((failFirst > 0 || failTurns > 0) && process.env.FAKE_CODEX_STATE) {
      const counter = `${process.env.FAKE_CODEX_STATE}.fail-${failFirst > 0 ? text.split("\n")[0].replace(/[^A-Za-z0-9]/g, "_").slice(0, 40) : "turns"}`;
      const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      if (seen < (failFirst > 0 ? failFirst : failTurns)) {
        fs.writeFileSync(counter, String(seen + 1));
        const info = lineDirective(text, "FAIL_KIND") ?? process.env.FAKE_FAIL_KIND ?? "serverOverloaded";
        const error = { message: `fake failure: ${info}`, codexErrorInfo: info, additionalDetails: null };
        notify("error", { error, willRetry: false, threadId: thread.id, turnId: active.id });
        notify("turn/completed", { threadId: thread.id, turn: turnObject(active, "failed", error) });
        if (lineDirective(text, "FAIL_EXIT") === "1") setTimeout(() => process.exit(7), 100); // the app-server dies after the failure
        return;
      }
    }
    if (process.env.FAKE_CODEX_ENCRYPTED_RESUME === "1" && thread.accountChanged) {
      const error = { message: "The encrypted content could not be verified", codexErrorInfo: "badRequest", additionalDetails: null };
      notify("error", { error, willRetry: false, threadId: thread.id, turnId: active.id });
      return notify("turn/completed", { threadId: thread.id, turn: turnObject(active, "failed", error) });
    }
    if (fakeFile) fs.appendFileSync(fakeFile, "applied once\n");
    const first = text.split("\n")[0].slice(0, 60);
    const base = { threadId: thread.id, turnId: active.id };
    notify("item/completed", { ...base, item: item({ type: "userMessage", content: [{ type: "text", text }] }) });
    notify("item/started", { ...base, item: item({ type: "reasoning", summary: [], content: [] }) });
    notify("item/completed", { ...base, item: item({ type: "reasoning", summary: ["PRIVATE_REASONING_MUST_NOT_BE_COPIED"], content: ["PRIVATE_REASONING_MUST_NOT_BE_COPIED"] }) });
    notify("item/completed", { ...base, item: item({ type: "agentMessage", text: `working on: ${first}`, phase: "commentary", memoryCitation: null }) });
    const command = item({ type: "commandExecution", command: `echo fake ${"x".repeat(400)}`, cwd: thread.cwd, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null });
    notify("item/started", { ...base, item: command });
    notify("item/completed", { ...base, item: { ...command, status: "completed", aggregatedOutput: `${"o".repeat(900)}END`, exitCode: 0, durationMs: 12 } });
    notify("item/completed", {
      ...base,
      item: item({
        type: "fileChange",
        status: "completed",
        changes: [
          { path: path.join(thread.cwd, "src", "fake.txt"), kind: { type: "add" }, diff: "+SECRET-DIFF-LINE" },
          { path: path.join(os.tmpdir(), "outside.txt"), kind: { type: "update", move_path: null }, diff: "+SECRET-DIFF-LINE" },
        ],
      }),
    });
    const plan = [{ step: "read", status: "completed" }, { step: "write", status: "inProgress" }];
    notify("turn/plan/updated", { ...base, explanation: null, plan });
    notify("turn/plan/updated", { ...base, explanation: null, plan });
    const mcpCall = item({ type: "mcpToolCall", server: "docs", tool: "search", status: "inProgress", arguments: {} });
    notify("item/started", { ...base, item: mcpCall });
    notify("item/completed", { ...base, item: { ...mcpCall, status: "completed" } });
    const searchCall = item({ type: "webSearch", query: "fake", action: null });
    notify("item/started", { ...base, item: searchCall });
    notify("item/completed", { ...base, item: searchCall });
    thread.usage.input += 120;
    thread.usage.output += 12;
    thread.usage.reasoning += 4;
    notify("thread/tokenUsage/updated", {
      ...base,
      tokenUsage: {
        total: { totalTokens: thread.usage.input + thread.usage.output, inputTokens: thread.usage.input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: thread.usage.output, reasoningOutputTokens: thread.usage.reasoning },
        last: { totalTokens: 132, inputTokens: 120, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 12, reasoningOutputTokens: 4 },
        modelContextWindow: 272000,
      },
    });

    const requestMethod = lineDirective(text, "REQUEST");
    let declined = null;
    if (requestMethod) {
      const id = `srv-${++serverRequests}`;
      const response = await new Promise((resolve) => {
        awaiting.set(id, resolve);
        write({ id, method: requestMethod, params: { threadId: thread.id, turnId: active.id, itemId: "i1" } });
      });
      declined = response?.error?.message ?? "(accepted)";
    }
    let answered = null;
    const callTool = lineDirective(text, "CALL_TOOL");
    const ask = callTool ? [null, "q"] : /^ASK: (.*)$/m.exec(withoutRequest(text));
    if (ask) {
      const id = `srv-${++serverRequests}`;
      const call = item({ type: "dynamicToolCall", tool: "ask_orchestrator", namespace: null, arguments: { question: ask[1] }, status: "inProgress", contentItems: null, success: null, durationMs: null });
      notify("item/started", { ...base, item: call });
      const response = await new Promise((resolve) => {
        awaiting.set(id, resolve);
        write({ id, method: "item/tool/call", params: { threadId: thread.id, turnId: active.id, callId: `call-${serverRequests}`, namespace: null, tool: callTool ?? "ask_orchestrator", arguments: { question: ask[1] } } });
      });
      answered = response?.result ?? { error: response?.error };
      notify("item/completed", { ...base, item: { ...call, status: "completed", contentItems: answered.contentItems ?? null, success: answered.success ?? false } });
    }
    const heldMs = Number(lineDirective(text, "COMMAND_MS") ?? 0);
    if (heldMs > 0) {
      const held = item({ type: "commandExecution", command: "held fake command", cwd: thread.cwd, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null });
      notify("item/started", { ...base, item: held });
      await sleepMs(heldMs); // a running command is not interrupted: the interrupt, if any, is acted on after it
      notify("item/completed", { ...base, item: { ...held, status: "completed", aggregatedOutput: "held", exitCode: 0, durationMs: heldMs } });
    }
    const hang = lineDirective(text, "HANG") === "1";
    const ignoreInterrupt = active.ignoreInterrupt;
    const duration = Number(lineDirective(text, "TURN_MS") ?? process.env.FAKE_CODEX_TURN_MS ?? 0);
    const waitSteer = lineDirective(text, "WAIT_STEER") === "1";
    const until = Date.now() + (hang ? 120_000 : waitSteer ? 20_000 : duration);
    while (Date.now() < until) {
      if (active.interrupted && !ignoreInterrupt) break;
      if (waitSteer && active.steers.length) {
        await sleepMs(100);
        break;
      }
      await sleepMs(25);
    }
    if (active.interrupted && !ignoreInterrupt) return notify("turn/completed", { threadId: thread.id, turn: turnObject(active, "interrupted") });
    if (hang) return; // killed by the supervisor (or by the test's own cleanup after two minutes)

    let answer = lineDirective(text, "ANSWER") ?? process.env.FAKE_CODEX_OUTPUT ?? "fake answer";
    if (active.steers.length) answer += ` steered: ${JSON.stringify(active.steers)}`;
    if (answered) answer += ` answered: ${answered.contentItems?.[0]?.text ?? JSON.stringify(answered.error)}${answered.success === false ? " (failed)" : ""}`;
    if (declined) answer += ` declined: ${declined}`;
    const body = active.schema ? JSON.stringify(fillText(exampleFor(active.schema), active.schema, answer)) : answer;
    notify("item/completed", { ...base, item: item({ type: "agentMessage", text: body, phase: "final_answer", memoryCitation: null }) });
    rollout({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: body }] } });
    thread.turns += 1;
    saveThread();
    if (lineDirective(text, "CANCEL_BEFORE_COMPLETE") === "1" && process.env.ULTRACODEX_HOME) {
      // the owner cancels the run in the instant before its turn completes: the cancel file of every unfinished run
      const runs = path.join(process.env.ULTRACODEX_HOME, "runs");
      for (const name of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
        if (!fs.existsSync(path.join(runs, name, "result.json"))) fs.writeFileSync(path.join(runs, name, "cancel"), new Date().toISOString());
      }
    }
    notify("turn/completed", { threadId: thread.id, turn: turnObject(active, "completed") });
  };

  const startThread = (id, params, resumed) => {
    thread = { id, sandbox: params.sandbox ?? null, model: params.model ?? null, cwd: params.cwd ?? process.cwd(), turns: 0, usage: { input: 0, output: 0, reasoning: 0 }, askTool: Boolean(params.dynamicTools?.some((tool) => tool.name === "ask_orchestrator")), accountChanged: false };
    if (resumed) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(threadsDir, `${id}.json`), "utf8"));
        thread = { ...thread, ...saved, sandbox: params.sandbox ?? saved.sandbox, model: params.model ?? saved.model, accountChanged: saved.lastPid !== process.pid };
        if (!thread.cwd) thread.cwd = process.cwd();
      } catch {
        // a thread this fake never saw: accepted anyway
      }
    }
    saveThread();
    if (!resumed) rollout({ type: "session_meta", payload: { id } });
  };

  const mcpStatus = () => {
    const servers = JSON.parse(process.env.FAKE_CODEX_MCP_SERVERS ?? "{}");
    return Object.entries(servers).map(([name, spec]) => {
      const config = typeof spec === "number" ? { tools: spec } : spec;
      const disabled = flags.some((flag) => flag === `mcp_servers.${name}.enabled=false` || flag === `mcp_servers.${JSON.stringify(name)}.enabled=false`);
      const count = disabled && !config.sticky ? 0 : config.tools;
      return { name, runtimeStatus: null, tools: Object.fromEntries(Array.from({ length: count }, (_, index) => [`tool${index}`, {}])), toolsError: null, resources: [], resourceTemplates: [], authStatus: "unsupported" };
    });
  };

  // ── config/read ──
  const splitKey = (dotted) => [...dotted.matchAll(/"((?:[^"\\]|\\.)*)"|([^.]+)/g)].map((match) => match[1] ?? match[2]);
  const setPath = (object, segments, value) => {
    let at = object;
    for (const segment of segments.slice(0, -1)) at = at[segment] = at[segment] && typeof at[segment] === "object" ? at[segment] : {};
    at[segments.at(-1)] = value;
  };
  const origin = (type) => ({ name: type === "sessionFlags" ? { type } : { type, file: "C:\\fake\\config.toml" }, version: "sha256:fake" });
  const parseValue = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  // the effective config and origins of exactly the flags this app-server was started with
  const flagConfig = () => {
    const config = {};
    const origins = {};
    const put = (dotted, value, type = "sessionFlags") => {
      setPath(config, splitKey(dotted), value);
      origins[splitKey(dotted).join(".")] = origin(type);
    };
    for (let index = 0; index < flags.length; index += 1) {
      if (flags[index] === "--disable") put(`features.${flags[(index += 1)]}`, false);
      else if (flags[index] === "-c") {
        const setting = flags[(index += 1)];
        const at = setting.indexOf("=");
        put(setting.slice(0, at), parseValue(setting.slice(at + 1)));
      }
    }
    return { config, origins };
  };
  // what a real owner's config.toml contributes on top of the flags (nothing here changes what a node sees)
  const ownerConfig = () => {
    const { config, origins } = flagConfig();
    const user = (dotted, value) => {
      setPath(config, [dotted], value);
      origins[dotted] = origin("user");
    };
    for (const [key, value] of [["approval_policy", "on-request"], ["approvals_reviewer", "auto_review"], ["model", "owner-model"], ["model_reasoning_effort", "xhigh"], ["service_tier", "fast"], ["windows.sandbox", "elevated"]]) {
      setPath(config, splitKey(key), value);
      origins[key] = origin("user");
    }
    origins["notify.0"] = origin("user"); // stale: the effective notify is []
    origins["notify.1"] = origin("user");
    for (const key of ["projects.C:\\work\\repo.trust_level", "tui.theme", "desktop.sidebar", "notice.hide_rate_limit_model_nudge", "marketplaces.main.source", "plugins.fake@market.enabled", "mcp_servers.fake_server.command", "mcp_servers.fake_server.args.0"]) user(key, "owner-value");
    origins["mcp_servers.fake_server.enabled"] = origin("sessionFlags"); // switched off by a flag (the effective value is false)
    setPath(config, ["mcp_servers", "fake_server", "enabled"], false);
    return { config, origins };
  };
  const configRead = (id) => {
    const mode = process.env.FAKE_CODEX_CONFIG_READ ?? "clean";
    if (mode === "error") return rpcError(id, -32601, "method not found");
    if (mode === "hang") return;
    if (mode === "missing") return reply(id, { result: { config: flagConfig().config } });
    if (mode === "malformed") return reply(id, { result: { config: flagConfig().config, origins: "nope" } });
    if (mode === "owner") return reply(id, { result: ownerConfig() });
    const leak = /^leak(-project)?:(.+)$/.exec(mode);
    if (leak) {
      const { config, origins } = flagConfig();
      for (const key of leak[2].split(",")) {
        setPath(config, splitKey(key), "leaked-value-must-not-print");
        origins[key] = origin(leak[1] ? "project" : "user");
      }
      return reply(id, { result: { config, origins } });
    }
    if (mode !== "clean") return reply(id, { result: JSON.parse(fs.readFileSync(mode, "utf8")) });
    return reply(id, { result: flagConfig() });
  };

  const handle = async (message) => {
    if (message.id !== undefined && message.method === undefined) {
      // an answer to a request this fake sent (the ask_orchestrator tool call)
      slog({ kind: "answer", id: message.id, result: message.result ?? null, error: message.error ?? null });
      awaiting.get(message.id)?.(message);
      awaiting.delete(message.id);
      return;
    }
    slog({ kind: "request", method: message.method, id: message.id ?? null, params: message.params ?? null });
    const id = message.id;
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        experimental = params.capabilities?.experimentalApi === true;
        return reply(id, { result: { userAgent: "fake-codex/0.0.0" } });
      case "initialized":
        return;
      case "account/rateLimits/read": {
        const answer = scriptFile ? nextAnswer() : { result: { ordinaryUsageAllowed: null, rateLimits: null } };
        if (answer.hang) {
          stubborn = answer.hang === "ignore-close";
          if (stubborn) setTimeout(() => {}, 120_000); // a failing test never leaks for long
          return;
        }
        if (answer.exit !== undefined) process.exit(answer.exit);
        return reply(id, answer.error ? { error: answer.error } : { result: anchored(answer.result) });
      }
      case "config/read":
        if (Number(process.env.FAKE_CODEX_CONFIG_READ_MS ?? 0) > 0) await sleepMs(Number(process.env.FAKE_CODEX_CONFIG_READ_MS));
        return configRead(id);
      case "thread/start": {
        if (params.dynamicTools && !experimental) return rpcError(id, -32600, "dynamicTools requires capabilities.experimentalApi");
        if (!["read-only", "workspace-write"].includes(params.sandbox) || params.approvalPolicy !== "never") return rpcError(id, -32602, "invalid sandbox/approvalPolicy");
        startThread(`01a0fake-5e55-7000-8000-${randomBytes(6).toString("hex")}`, params, false);
        return reply(id, { result: { thread: { id: thread.id }, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, model: params.model ?? null } });
      }
      case "thread/resume": {
        if (typeof params.threadId !== "string" || !["read-only", "workspace-write"].includes(params.sandbox) || params.approvalPolicy !== "never") return rpcError(id, -32602, "invalid threadId/sandbox/approvalPolicy");
        if (process.env.FAKE_CODEX_RESUME_FAILS === "1") return rpcError(id, -32603, "no rollout found for thread id");
        startThread(params.threadId, params, true);
        if (Number(process.env.FAKE_CODEX_RESUME_MS ?? 0) > 0) await sleepMs(Number(process.env.FAKE_CODEX_RESUME_MS));
        return reply(id, { result: { thread: { id: thread.id }, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, model: params.model ?? thread.model } });
      }
      case "turn/start": {
        if (!thread || params.threadId !== thread.id) return rpcError(id, -32600, "unknown thread");
        const input = params.input;
        if (!Array.isArray(input) || input.some((part) => !["text", "localImage"].includes(part?.type))) return rpcError(id, -32602, "invalid input");
        if (turn) return rpcError(id, -32600, "a turn is already active (turn/start would steer it)");
        turn = { id: `turn-${randomBytes(4).toString("hex")}`, n: 0, text: textOf(input), effort: params.effort ?? null, schema: params.outputSchema ?? null, steers: [], interrupted: false, startedAt: Math.floor(Date.now() / 1000), startedMs: Date.now() };
        turn.n = (thread.started = (thread.started ?? 0) + 1);
        reply(id, { result: { turn: { id: turn.id, status: "inProgress" } } });
        const active = turn;
        runTurn(active).finally(() => {
          if (turn === active) turn = null;
        });
        return;
      }
      case "turn/steer": {
        if (!turn) return rpcError(id, -32600, "no active turn to steer");
        if (params.expectedTurnId !== turn.id) return rpcError(id, -32600, `expected active turn id ${params.expectedTurnId} but found ${turn.id}`);
        if (turn.notSteerable) return rpcError(id, -32600, "cannot steer a review turn", { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } });
        turn.steers.push(textOf(params.input));
        return reply(id, { result: { turnId: turn.id } });
      }
      case "turn/interrupt": {
        if (!turn || params.turnId !== turn.id) return reply(id, { result: {} });
        if (!turn.ignoreInterrupt) turn.interrupted = true;
        return reply(id, { result: {} });
      }
      case "thread/archive":
        return reply(id, { result: {} });
      case "mcpServerStatus/list": {
        if (process.env.FAKE_CODEX_MCP_ERROR === "1") return rpcError(id, -32603, "mcp inventory unavailable");
        const all = mcpStatus();
        if (process.env.FAKE_CODEX_MCP_PAGES === "1") {
          const at = Number(params.cursor ?? 0);
          return reply(id, { result: { data: all.slice(at, at + 1), nextCursor: at + 1 < all.length ? String(at + 1) : null } });
        }
        return reply(id, { result: { data: all, nextCursor: null } });
      }
      default:
        if (id !== undefined) reply(id, { error: { code: -32601, message: "method not found" } });
    }
  };

  const { createInterface } = await import("node:readline");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    record({ method: message.method ?? null, id: message.id ?? null });
    // FAKE_CODEX_APP_SERVER_NOISE: the server's own notifications and requests (ids that collide
    // with the client's) arrive around the answers; a client must take only the answers
    if (process.env.FAKE_CODEX_APP_SERVER_NOISE && message.id !== undefined && message.method !== undefined) {
      process.stdout.write(JSON.stringify({ method: "remoteControl/status/changed", params: {} }) + "\n");
      process.stdout.write(JSON.stringify({ id: message.id, method: "fake/serverRequest", params: {} }) + "\n");
    }
    handle(message).catch((error) => {
      if (message.id !== undefined && message.method !== undefined) reply(message.id, { error: { code: -32603, message: String(error?.message ?? error) } });
    });
  });
  lines.on("close", () => {
    slog({ kind: "exit" });
    if (!stubborn) process.exit(0);
  });
  await new Promise(() => {}); // lives until stdin closes (or a kill)
}
if (argv[0] !== "exec") {
  process.stderr.write(`fake-codex: unsupported invocation: ${argv.join(" ")}\n`);
  process.exit(2);
}

let out = null;
let schemaFile = null;
let fromStdin = false;
let resumeId = null;
const valued = new Set(["-s", "-C", "--add-dir", "-i", "-p", "--base", "--commit", "--title", "-m", "-c", "-o", "--output-schema"]);
for (let index = 1; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "review") continue;
  if (arg === "resume") {
    resumeId = argv[index + 1];
    index += 1;
    continue;
  }
  if (arg === "-o") out = argv[index + 1];
  if (arg === "--output-schema") schemaFile = argv[index + 1];
  if (valued.has(arg)) {
    index += 1;
    continue;
  }
  if (arg === "-") fromStdin = true;
}

if (process.env.FAKE_CODEX_ARGV_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_ARGV_LOG, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }) + "\n");
}

const prompt = fromStdin ? fs.readFileSync(0, "utf8") : "";
if (process.env.FAKE_CODEX_PROMPT_LOG) fs.writeFileSync(process.env.FAKE_CODEX_PROMPT_LOG, prompt);
// FAKE_CODEX_PROMPTS_LOG: every attempt's prompt, in order (a resume's included)
if (process.env.FAKE_CODEX_PROMPTS_LOG) fs.appendFileSync(process.env.FAKE_CODEX_PROMPTS_LOG, JSON.stringify({ resume: resumeId, pid: process.pid, prompt }) + "\n");
const directive = (name) => {
  const match = new RegExp(`^FAKE_${name}=(.*)$`, "m").exec(withoutRequest(prompt));
  return match ? match[1].trim() : null;
};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const apiFailure = (status, error) => {
  const message = JSON.stringify({ type: "error", status, error });
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
};

// FAKE_THREAD_DELAY_MS: Codex takes a while to say which thread this is
const threadDelayMs = Number(directive("THREAD_DELAY_MS") ?? 0);
if (threadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, threadDelayMs));
emit({ type: "thread.started", thread_id: resumeId ?? `01a0fake-0000-7000-8000-${String(process.pid).padStart(12, "0")}` });
emit({ type: "turn.started" });

// A quota failure after observable work; account-switch tests must resume this
// thread rather than run the original task (and its side effects) a second time.
const quotaWork = directive("QUOTA_WORK");
if (resumeId && process.env.FAKE_CODEX_ENCRYPTED_RESUME === "1") {
  apiFailure(400, { code: "invalid_encrypted_content", message: "The encrypted content could not be verified" });
}
// FAKE_CODEX_QUOTA_RESUMES=n: the first n resumes hit the usage limit again (counted in
// ${FAKE_CODEX_STATE}.quota), the way an out-of-credits workspace does however often it is retried.
const quotaResumes = Number(process.env.FAKE_CODEX_QUOTA_RESUMES ?? 0);
if (resumeId && quotaResumes > 0 && process.env.FAKE_CODEX_STATE) {
  const counter = `${process.env.FAKE_CODEX_STATE}.quota`;
  const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  if (seen < quotaResumes) {
    fs.writeFileSync(counter, String(seen + 1));
    apiFailure(429, { code: "usage_limit_reached", message: "You have hit your usage limit" });
  }
}
if (quotaWork && !resumeId) {
  fs.appendFileSync(quotaWork, "applied once\n");
  emit({ type: "item.completed", item: { id: "effect", type: "command_execution", command: "fixture effect", aggregated_output: "applied once", exit_code: 0, status: "completed" } });
  emit({ type: "item.completed", item: { id: "hidden", type: "reasoning", text: "PRIVATE_REASONING_MUST_NOT_BE_COPIED", encrypted_content: "PRIVATE_ENCRYPTED_BLOB" } });
  if (process.env.FAKE_CODEX_ACCOUNT_AFTER_FAILURE) {
    const file = path.join(process.env.CODEX_HOME, "auth.json");
    fs.writeFileSync(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: process.env.FAKE_CODEX_ACCOUNT_AFTER_FAILURE } }));
  }
  apiFailure(429, { code: "usage_limit_reached", message: "You have hit your usage limit" });
}

const failFirst = Number(directive("FAIL_FIRST") ?? 0);
if (failFirst > 0) {
  const counter = process.env.FAKE_CODEX_STATE;
  const seen = counter && fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  if (counter) fs.writeFileSync(counter, String(seen + 1));
  if (seen < failFirst) apiFailure(429, { type: "rate_limit_error", message: "Rate limit reached for requests" });
}

const apiError = directive("API_ERROR");
if (apiError) {
  const parsed = JSON.parse(apiError);
  apiFailure(parsed.status ?? 400, { type: "invalid_request_error", code: parsed.code ?? null, message: parsed.message ?? "bad request", param: parsed.param ?? null });
}

const stderrText = directive("STDERR");
if (stderrText) process.stderr.write(stderrText.replace(/\\n/g, "\n") + "\n");

// Children behave like a native codex.exe's: on Windows they are not in this process's
// own libuv job (which would kill them with it), so only the runner's teardown can stop
// them. They end by themselves after two minutes, so a failing test never leaks for long.
const onWindows = process.platform === "win32";
const LINGER = "setTimeout(() => {}, 120000)";
const pidFile = directive("SPAWN_CHILD");
if (pidFile) {
  const child = spawn(process.execPath, ["-e", LINGER], { stdio: "ignore", detached: onWindows });
  if (onWindows) child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
}

// A shell that starts a background process and exits at once: the survivor's parent is
// gone, the case a snapshot of the tree can never attribute.
const orphanFile = directive("SPAWN_ORPHAN");
if (orphanFile) {
  const shell = `const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(LINGER)}], { stdio: "ignore", detached: true }); require("fs").writeFileSync(${JSON.stringify(orphanFile)}, String(g.pid)); g.unref(); setTimeout(() => process.exit(0), 300);`;
  const intermediate = spawn(process.execPath, ["-e", shell], { stdio: "ignore", detached: onWindows });
  if (onWindows) intermediate.unref();
}

if (directive("IGNORE_TERM") === "1") process.on("SIGTERM", () => {});

function exampleFor(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("null")) return null;
  if (types.includes("object") || schema.properties) {
    const value = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) value[key] = exampleFor(child);
    return value;
  }
  if (types.includes("array")) return [];
  if (types.includes("boolean")) return false;
  if (types.includes("integer") || types.includes("number")) return 0;
  return "x";
}

const finish = () => {
  const exitCode = Number(directive("EXIT") ?? 0);
  if (directive("NO_OUTPUT") !== "1") {
    let text = directive("OUTPUT") ?? process.env.FAKE_CODEX_OUTPUT ?? null;
    if (text === null) text = schemaFile ? JSON.stringify(exampleFor(JSON.parse(fs.readFileSync(schemaFile, "utf8")))) : "fake answer";
    if (out) fs.writeFileSync(out, text);
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
  }
  emit({
    type: "turn.completed",
    usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 4 },
  });
  process.exit(exitCode);
};

// FAKE_STEPS=model:600,command:2000,model:5000 (or FAKE_CODEX_STEPS, for every attempt including a resume,
// whose prompt carries no directives): a model step is time with nothing in flight; command, file, mcp and
// search hold such an item in flight (item.started ... item.completed) for the time given.
const STEP_TYPES = { command: "command_execution", file: "file_change", mcp: "mcp_tool_call", search: "web_search" };
for (const [index, step] of (directive("STEPS") ?? process.env.FAKE_CODEX_STEPS ?? "").split(",").filter(Boolean).entries()) {
  const [kind, ms] = step.split(":");
  const type = STEP_TYPES[kind];
  if (type) emit({ type: "item.started", item: { id: `step-${index}`, type, status: "in_progress" } });
  await new Promise((resolve) => setTimeout(resolve, Number(ms)));
  if (type) emit({ type: "item.completed", item: { id: `step-${index}`, type, status: "completed" } });
}

const sleepMs = Number(directive("SLEEP_MS") ?? 0);
if (sleepMs > 0) setTimeout(finish, sleepMs);
else finish();
