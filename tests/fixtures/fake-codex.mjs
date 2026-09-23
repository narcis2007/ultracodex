#!/usr/bin/env node
// Offline stand-in for the Codex CLI used by the runner tests. Behaviour is driven
// by FAKE_* directives inside the prompt (read from stdin), so no test ever spends
// model quota. Supports: --version, login status, debug models, exec [review|resume].

import { spawn } from "node:child_process";
import fs from "node:fs";

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
      slug: "gpt-6-sol",
      display_name: "GPT-6-Sol",
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
if (argv[0] !== "exec") {
  process.stderr.write(`fake-codex: unsupported invocation: ${argv.join(" ")}\n`);
  process.exit(2);
}

let out = null;
let schemaFile = null;
let fromStdin = false;
const valued = new Set(["-s", "-C", "--add-dir", "-i", "-p", "--base", "--commit", "--title", "-m", "-c", "-o", "--output-schema"]);
for (let index = 1; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "review") continue;
  if (arg === "resume") {
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

emit({ type: "thread.started", thread_id: `01a0fake-0000-7000-8000-${String(process.pid).padStart(12, "0")}` });
emit({ type: "turn.started" });

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

const pidFile = directive("SPAWN_CHILD");
if (pidFile) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(pidFile, String(child.pid));
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
