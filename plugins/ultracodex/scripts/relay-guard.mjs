#!/usr/bin/env node
// PreToolUse guard for the ultracodex relay agents.
//
// The job relay is a language model that copies untrusted text (task content can come
// from reviewed repositories), so it is confined to exactly these command shapes:
//
//   node "<plugin>/scripts/codex-node.mjs" part (new|ucx-<12 hex>) K N HASH <<'UCX_P…'
//   <encoded lines: no quote, no control characters>
//   UCX_P…
//
//   node "<plugin>/scripts/codex-node.mjs" wait <runId>
//   node "<plugin>/scripts/codex-node.mjs" page <runId> <k>
//
// The key agent — a separate agent type whose prompt carries no task text — may run
// only `node "<plugin>/scripts/codex-node.mjs" key`. Which agent may do what is decided by
// the agent type the Workflow helper chose, never by the model: a job relay can never read
// the key, whatever its prompt tells it.
//
// Those commands are allowed without a permission prompt; anything else these agents try
// is denied. Tool calls from any other agent (including the main conversation) get no
// opinion from this hook.

import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELAY_TYPES = new Set(["ultracodex:codex-relay", "codex-relay"]);
const KEY_TYPES = new Set(["ultracodex:codex-key", "codex-key"]);
const RUN_ID = String.raw`\d{8}T\d{6}Z-[0-9a-f]{6}`;
const UPLOAD = String.raw`(?:new|ucx-[0-9a-f]{12})`;

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function runnerPath(pluginRoot) {
  return `${normalizePath(pluginRoot)}/scripts/codex-node.mjs`;
}

// { command: "part" | "wait" | "page" | "key", problem: null } for an allowed shape,
// else { command: null, problem }.
export function classifyRelayCommand(command, pluginRoot) {
  const deny = (problem) => ({ command: null, problem });
  if (typeof command !== "string" || !command.trim()) return deny("empty command");
  const text = command.replace(/\r\n?/g, "\n").trim();
  const runner = runnerPath(pluginRoot);
  const [first, ...rest] = text.split("\n");
  const prefix = /^node\s+"([^"]+)"\s+(.*)$/.exec(first);
  if (!prefix) return deny('the relay may only run: node "<runner>" part … | wait … | page … | key');
  const samePath = process.platform === "win32" ? normalizePath(prefix[1]).toLowerCase() === runner.toLowerCase() : normalizePath(prefix[1]) === runner;
  if (!samePath) return deny(`the relay may only run the plugin's own runner (${runner})`);
  const args = prefix[2].trim();
  if (args === "key") return rest.length ? deny("key takes no input") : { command: "key", problem: null };
  if (new RegExp(`^wait ${RUN_ID}$`).test(args)) return rest.length ? deny("wait takes no input") : { command: "wait", problem: null };
  if (new RegExp(`^page ${RUN_ID} \\d{1,3}$`).test(args)) return rest.length ? deny("page takes no input") : { command: "page", problem: null };
  const part = new RegExp(`^part ${UPLOAD} \\d{1,3} \\d{1,3} [0-9a-f]{8} <<'(UCX_PX*)'$`).exec(args);
  if (!part) return deny("not an allowed part/wait/page/key command");
  const delimiter = part[1];
  const end = rest.indexOf(delimiter);
  if (end < 1) return deny("the heredoc body is missing or not terminated by its delimiter");
  if (rest.slice(end + 1).some((line) => line.trim() !== "")) return deny("nothing may follow the heredoc");
  const body = rest.slice(0, end);
  for (const line of body) {
    for (const char of line) {
      const code = char.codePointAt(0);
      if (code === 0x27 || code === 0x5c || code < 0x20 || code === 0x7f) return deny("the part contains characters an encoded part never has");
    }
  }
  return { command: "part", problem: null };
}

// Returns null when `agentType` may run `command`, or the reason it may not.
export function checkAgentCommand(agentType, command, pluginRoot) {
  const { command: kind, problem } = classifyRelayCommand(command, pluginRoot);
  if (problem) return problem;
  if (KEY_TYPES.has(agentType)) return kind === "key" ? null : "the key agent may only run the key command";
  return kind === "key" ? "a job relay may never read the result key" : null;
}

// Compatibility: the job relay's view.
export function checkRelayCommand(command, pluginRoot) {
  return checkAgentCommand("ultracodex:codex-relay", command, pluginRoot);
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
  const agentType = String(input?.agent_type ?? "");
  if (!RELAY_TYPES.has(agentType) && !KEY_TYPES.has(agentType)) return;
  if (input.tool_name !== "Bash") {
    respond("deny", "the ultracodex relay agents may only use Bash to run the runner");
    return;
  }
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const problem = checkAgentCommand(agentType, input.tool_input?.command, pluginRoot);
  if (problem) respond("deny", `ultracodex relay guard: ${problem}. Use exactly the commands from your instructions.`);
  else respond("allow", "ultracodex relay: runner command");
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) await main();
