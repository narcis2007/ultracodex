#!/usr/bin/env node
// PreToolUse guard for the ultracodex relay agent.
//
// The relay is a language model that copies untrusted text (task content can come
// from reviewed repositories), so it is confined to exactly these command shapes:
//
//   node "<plugin>/scripts/codex-node.mjs" part (new|ucx-<12 hex>) K N HASH <<'UCX_P…'
//   <encoded lines: no quote, no control characters>
//   UCX_P…
//
//   node "<plugin>/scripts/codex-node.mjs" wait <runId>
//   node "<plugin>/scripts/codex-node.mjs" page <runId> <k>
//   node "<plugin>/scripts/codex-node.mjs" key
//
// Those are allowed without a permission prompt; anything else the relay tries is
// denied. Tool calls from any other agent (including the main conversation) get no
// opinion from this hook. Without arbitrary commands the relay also cannot compute
// the hashes a fabricated result would need to pass the Workflow helper's checks.
//
// Roles: `key` prints the secret that signs results, so a relay that reads it may do
// nothing else, and a relay that has uploaded or collected a job (and so has seen
// untrusted text) may never read it. The first command fixes each relay's role.

import fs from "node:fs";
import os from "node:os";
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

// { role: "run" | "key", problem: null } for an allowed command, else { role: null, problem }.
export function classifyRelayCommand(command, pluginRoot) {
  const deny = (problem) => ({ role: null, problem });
  if (typeof command !== "string" || !command.trim()) return deny("empty command");
  const text = command.replace(/\r\n?/g, "\n").trim();
  const runner = runnerPath(pluginRoot);
  const [first, ...rest] = text.split("\n");
  const prefix = /^node\s+"([^"]+)"\s+(.*)$/.exec(first);
  if (!prefix) return deny('the relay may only run: node "<runner>" part … | wait … | page … | key');
  const samePath = process.platform === "win32" ? normalizePath(prefix[1]).toLowerCase() === runner.toLowerCase() : normalizePath(prefix[1]) === runner;
  if (!samePath) return deny(`the relay may only run the plugin's own runner (${runner})`);
  const args = prefix[2].trim();
  if (args === "key") return rest.length ? deny("key takes no input") : { role: "key", problem: null };
  if (new RegExp(`^(?:wait ${RUN_ID}|page ${RUN_ID} \\d{1,3})$`).test(args)) {
    return rest.length ? deny("wait/page take no input") : { role: "run", problem: null };
  }
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
  return { role: "run", problem: null };
}

// Returns null when the command is one of the allowed shapes, or the reason it is not.
export function checkRelayCommand(command, pluginRoot) {
  return classifyRelayCommand(command, pluginRoot).problem;
}

export function rolesDir(env = process.env) {
  return path.join(env.ULTRACODEX_HOME ? path.resolve(env.ULTRACODEX_HOME) : path.join(os.homedir(), ".ultracodex"), "relay-roles");
}

// The first allowed command of a relay fixes its role (atomic exclusive create, so two
// commands sent in parallel cannot both win). Returns null, or why the role is refused.
export function claimRole(agentId, role, env = process.env) {
  const id = String(agentId ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return role === "key" ? "the key is only given to an identifiable relay" : null;
  const dir = rolesDir(env);
  const file = path.join(dir, id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, role, { flag: "wx" });
    return null;
  } catch (error) {
    if (error.code !== "EEXIST") return role === "key" ? `cannot record the relay role (${error.code})` : null;
  }
  let held = "";
  try {
    held = fs.readFileSync(file, "utf8").trim();
  } catch {
    // unreadable: treated as a conflict below
  }
  if (held === role) return null;
  return role === "key"
    ? "a relay that uploads or collects jobs may not read the result key"
    : "the relay that read the result key may not run jobs";
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
  const { role, problem } = classifyRelayCommand(input.tool_input?.command, pluginRoot);
  if (problem) {
    respond("deny", `ultracodex relay guard: ${problem}. Use exactly the part/wait/page/key commands from your instructions.`);
    return;
  }
  const refused = claimRole(input.agent_id, role);
  if (refused) respond("deny", `ultracodex relay guard: ${refused}.`);
  else respond("allow", `ultracodex relay: runner ${role === "key" ? "key" : "part/wait/page"} command`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) await main();
