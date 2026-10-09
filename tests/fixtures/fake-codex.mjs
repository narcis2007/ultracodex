#!/usr/bin/env node
// Offline stand-in for the Codex CLI used by the runner tests. Behaviour is driven
// by FAKE_* directives inside the prompt (read from stdin), so no test ever spends
// model quota. Supports: --version, login status, debug models, exec [review|resume].

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

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
// The runner's rate-limit probe: `app-server --listen stdio://`, JSON-RPC one object per line.
// FAKE_CODEX_RATE_LIMITS names a JSON file with the scripted answers, one per
// account/rateLimits/read (the last repeats): {"result": {...}} | {"error": {...}} |
// {"hang": true} (never answers; leaves when its stdin closes) | {"hang": "ignore-close"}
// (never answers and ignores the close, so only a kill ends it) | {"exit": 3} (dies mid-call).
// A `resetsAt` below a million is an offset in seconds from the first probe of the script (the
// supervisor needs seconds to start, so a test cannot name an absolute time that early).
// FAKE_CODEX_PROBE_LOG gets one line per message received, so a test can see exactly what the
// runner sent and how often.
if (argv[0] === "app-server") {
  if (argv.slice(1).join(" ") !== "--listen stdio://") {
    process.stderr.write(`fake-codex: unsupported app-server invocation: ${argv.join(" ")}\n`);
    process.exit(2);
  }
  const record = (entry) => {
    if (process.env.FAKE_CODEX_PROBE_LOG) fs.appendFileSync(process.env.FAKE_CODEX_PROBE_LOG, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + "\n");
  };
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
  const reply = (id, body) => process.stdout.write(JSON.stringify({ id, ...body }) + "\n");
  let stubborn = false;
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
    if (process.env.FAKE_CODEX_APP_SERVER_NOISE && message.id !== undefined) {
      process.stdout.write(JSON.stringify({ method: "remoteControl/status/changed", params: {} }) + "\n");
      process.stdout.write(JSON.stringify({ id: message.id, method: "fake/serverRequest", params: {} }) + "\n");
    }
    if (message.method === "initialize") reply(message.id, { result: { userAgent: "fake-codex/0.0.0" } });
    else if (message.method === "account/rateLimits/read") {
      const answer = scriptFile ? nextAnswer() : { result: { ordinaryUsageAllowed: null, rateLimits: null } };
      if (answer.hang) {
        stubborn = answer.hang === "ignore-close";
        if (stubborn) setTimeout(() => {}, 120_000); // a failing test never leaks for long
      } else if (answer.exit !== undefined) process.exit(answer.exit);
      else reply(message.id, answer.error ? { error: answer.error } : { result: anchored(answer.result) });
    } else if (message.id !== undefined) reply(message.id, { error: { code: -32601, message: "method not found" } });
  });
  lines.on("close", () => {
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
const directive = (name) => {
  const match = new RegExp(`^FAKE_${name}=(.*)$`, "m").exec(prompt);
  return match ? match[1].trim() : null;
};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const apiFailure = (status, error) => {
  const message = JSON.stringify({ type: "error", status, error });
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
};

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

const sleepMs = Number(directive("SLEEP_MS") ?? 0);
if (sleepMs > 0) setTimeout(finish, sleepMs);
else finish();
