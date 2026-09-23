#!/usr/bin/env node
// PreToolUse guard for the ultracodex relay agent.
//
// The relay is a language model that copies untrusted text (task content can come
// from reviewed repositories), so it is confined to exactly two command shapes:
//
//   node "<plugin>/scripts/codex-node.mjs" part (new|ucx-<12 hex>) K N HASH <<'UCX_P…'
//   <encoded lines: no quote, no control characters>
//   UCX_P…
//
//   node "<plugin>/scripts/codex-node.mjs" wait <runId>
//
// Those are allowed without a permission prompt; anything else the relay tries is
// denied. Tool calls from any other agent (including the main conversation) get no
// opinion from this hook. Without arbitrary commands the relay also cannot compute
// the hashes a fabricated result would need to pass the Workflow helper's checks.

import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELAY_TYPES = new Set(["ultracodex:codex-relay", "codex-relay"]);
const RUN_ID = String.raw`\d{8}T\d{6}Z-[0-9a-f]{6}`;
const UPLOAD = String.raw`(?:new|ucx-[0-9a-f]{12})`;

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function runnerPath(pluginRoot) {
  return `${normalizePath(pluginRoot)}/scripts/codex-node.mjs`;
}

// Returns null when the command is one of the two allowed shapes, or the reason it is not.
export function checkRelayCommand(command, pluginRoot) {
  if (typeof command !== "string" || !command.trim()) return "empty command";
  const text = command.replace(/\r\n?/g, "\n").trim();
  const runner = runnerPath(pluginRoot);
  const [first, ...rest] = text.split("\n");
  const prefix = /^node\s+"([^"]+)"\s+(.*)$/.exec(first);
  if (!prefix) return 'the relay may only run: node "<runner>" part … | wait …';
  const samePath = process.platform === "win32" ? normalizePath(prefix[1]).toLowerCase() === runner.toLowerCase() : normalizePath(prefix[1]) === runner;
  if (!samePath) return `the relay may only run the plugin's own runner (${runner})`;
  const args = prefix[2].trim();
  if (new RegExp(`^wait ${RUN_ID}$`).test(args)) return rest.length ? "wait takes no input" : null;
  const part = new RegExp(`^part ${UPLOAD} \\d{1,3} \\d{1,3} [0-9a-f]{8} <<'(UCX_PX*)'$`).exec(args);
  if (!part) return "not an allowed part/wait command";
  const delimiter = part[1];
  const end = rest.indexOf(delimiter);
  if (end < 1) return "the heredoc body is missing or not terminated by its delimiter";
  if (rest.slice(end + 1).some((line) => line.trim() !== "")) return "nothing may follow the heredoc";
  const body = rest.slice(0, end);
  for (const line of body) {
    for (const char of line) {
      const code = char.codePointAt(0);
      if (code === 0x27 || code === 0x5c || code < 0x20 || code === 0x7f) return "the part contains characters an encoded part never has";
    }
  }
  return null;
}

function respond(decision, reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }) + "\n"
  );
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not ours to judge
  }
  if (!RELAY_TYPES.has(String(input?.agent_type ?? ""))) return;
  if (input.tool_name !== "Bash") {
    respond("deny", "the ultracodex relay may only use Bash to run the runner");
    return;
  }
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const problem = checkRelayCommand(input.tool_input?.command, pluginRoot);
  if (problem) respond("deny", `ultracodex relay guard: ${problem}. Use exactly the part/wait commands from your instructions.`);
  else respond("allow", "ultracodex relay: runner part/wait command");
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) await main();
