#!/usr/bin/env node
// PreToolUse guard (Bash) for the ultracodex agents. What an agent may run follows from the
// agent type the Workflow helper chose — never from what the model asks for:
//
//   job relay (ultracodex:codex-relay) — copies untrusted text, so it may run exactly
//     node "<plugin>/scripts/codex-node.mjs" part (new|ucx-<12 hex>) K N HASH <<'UCX_P…'
//     <encoded lines: no quote, no control characters>
//     UCX_P…
//     node "<plugin>/scripts/codex-node.mjs" wait <runId>
//     node "<plugin>/scripts/codex-node.mjs" page <runId> <k>
//
//   key agent (ultracodex:codex-key) — its prompt holds no task text; it may run exactly
//     node "<plugin>/scripts/codex-node.mjs" key
//     node "<plugin>/scripts/codex-node.mjs" expect <64 hex>
//
//   reader (ultracodex:codex-reader) — the Claude stages of the shipped workflows that read
//     reviewed code; its Bash runs only read-only git commands, so it can neither compute a
//     signature nor announce a request, whatever the code it reads tells it.
//
// These commands are allowed without a permission prompt; anything else those agents try is
// denied. Every other subagent is refused the runner's privileged commands (key, expect) and
// otherwise gets no opinion from this hook; the main conversation is never judged here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELAY_TYPES = new Set(["ultracodex:codex-relay", "codex-relay"]);
const KEY_TYPES = new Set(["ultracodex:codex-key", "codex-key"]);
const READER_TYPES = new Set(["ultracodex:codex-reader", "codex-reader"]);
const RUN_ID = String.raw`\d{8}T\d{6}Z-[0-9a-f]{6}`;
const UPLOAD = String.raw`(?:new|ucx-[0-9a-f]{12})`;

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function runnerPath(pluginRoot) {
  return `${normalizePath(pluginRoot)}/scripts/codex-node.mjs`;
}

// { command: "part" | "wait" | "page" | "key" | "expect", problem: null } for an allowed
// shape of the runner's own commands, else { command: null, problem }.
export function classifyRelayCommand(command, pluginRoot) {
  const deny = (problem) => ({ command: null, problem });
  if (typeof command !== "string" || !command.trim()) return deny("empty command");
  const text = command.replace(/\r\n?/g, "\n").trim();
  const runner = runnerPath(pluginRoot);
  const [first, ...rest] = text.split("\n");
  const prefix = /^node\s+"([^"]+)"\s+(.*)$/.exec(first);
  if (!prefix) return deny('the relay may only run: node "<runner>" part … | wait … | page …');
  const samePath = process.platform === "win32" ? normalizePath(prefix[1]).toLowerCase() === runner.toLowerCase() : normalizePath(prefix[1]) === runner;
  if (!samePath) return deny(`the relay may only run the plugin's own runner (${runner})`);
  const args = prefix[2].trim();
  if (args === "key") return rest.length ? deny("key takes no input") : { command: "key", problem: null };
  if (/^expect [0-9a-f]{64}$/.test(args)) return rest.length ? deny("expect takes no input") : { command: "expect", problem: null };
  if (new RegExp(`^wait ${RUN_ID}$`).test(args)) return rest.length ? deny("wait takes no input") : { command: "wait", problem: null };
  if (new RegExp(`^page ${RUN_ID} \\d{1,3}$`).test(args)) return rest.length ? deny("page takes no input") : { command: "page", problem: null };
  const part = new RegExp(`^part ${UPLOAD} \\d{1,3} \\d{1,3} [0-9a-f]{8} <<'(UCX_PX*)'$`).exec(args);
  if (!part) return deny("not an allowed part/wait/page command");
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

// Read-only git for the reader: one command, no shell syntax, no option that runs a program,
// writes a file or reads files outside the repository's objects. The reader's commands run
// as the owner, unsandboxed, so each rule below closes a measured way (git 2.55) to run a
// program through a "read-only" git command.
const GIT_READ = new Set([
  "diff", "log", "show", "status", "blame", "ls-files", "ls-tree", "grep", "rev-parse",
  "merge-base", "cat-file", "describe", "shortlog", "diff-tree", "rev-list", "name-rev",
]);
// Long options (without the dashes) a reader may not use, abbreviated or not: git accepts
// unique prefixes (`git grep --open-files=<cmd>` runs <cmd>).
const GIT_BANNED = ["output", "ext-diff", "no-index", "contents", "open-files-in-pager", "exec", "upload-pack", "config"];

// The words bash would pass to git, or null when the command uses syntax that could make
// them differ from what is checked here: unquoted globs and braces (a file named
// `--output=x` in the reviewed tree would turn `--outp*` into an option), subshells,
// history or comments, or an unterminated quote. `$`, backticks and backslashes are refused
// before this, so quoted text is literal.
export function shellWords(text) {
  const words = [];
  let word = null;
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === " " || char === "\t") {
      // bash separates words on blanks only (a no-break space is part of a word)
      if (word !== null) words.push(word);
      word = null;
    } else if (/[*?[\]{}()!#]/.test(char)) {
      return null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

export function checkReaderCommand(command, { env = process.env, cwd = process.cwd() } = {}) {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) return "empty command";
  if (/[\n\r;&|<>`$\\~]/.test(text)) return "one git command, without pipes, redirections, substitutions, backslashes or ~";
  const words = shellWords(text);
  if (!words) return "quote patterns and paths: no unquoted * ? [ ] { } ( ) ! #, and no unterminated quote";
  if (words[0] !== "git") return "a reader may only run read-only git commands (git [-C <repository root>] <subcommand> …)";
  const at = words[1] === "-C" ? 3 : 1;
  const sub = words[at];
  if (!GIT_READ.has(sub)) return `git ${sub ?? "(nothing)"} is not one of the read-only commands a reader may run`;
  const home = normalizePath(env.ULTRACODEX_HOME ? path.resolve(env.ULTRACODEX_HOME) : path.join(os.homedir(), ".ultracodex")).toLowerCase();
  for (const word of [...words.slice(1, at), ...words.slice(at + 1)]) {
    const lower = normalizePath(word).toLowerCase();
    if (lower.includes(".ultracodex") || lower.includes(home)) return "the runner's home is off limits";
    // Windows authenticates to the host of a network path (//host/share), handing it the
    // owner's NTLM hash — checked before this guard touches any path itself
    if (/(^|[^:])\/\//.test(word)) return "network paths (//host/…) are not allowed for a reader";
    if (word.startsWith("--") && word !== "--") {
      const name = word.slice(2).split("=")[0].toLowerCase();
      const banned = GIT_BANNED.find((option) => option.startsWith(name) || name.startsWith(option));
      if (banned) return `--${banned} (or an abbreviation of it) is not allowed for a reader`;
    } else if (/^-[^-]/.test(word) && word.includes("O")) {
      // short options bundle: `git grep -nO<cmd>` is `-n -O<cmd>`, which runs <cmd> (measured)
      return "-O (open in a pager), alone or bundled, is not allowed for a reader";
    }
  }
  // Which repository git will use. A directory inside the reviewed tree can be an embedded
  // bare repository (HEAD, objects/, refs/, config are ordinary files to commit), and git run
  // there loads that config — whose core.fsmonitor is a program (measured). A tree checked out
  // by git never contains a `.git` of its own, so a `.git` marks a real repository.
  let start = cwd;
  if (at === 3) {
    // No `..`: path.resolve drops `hop/..` as text, but the kernel follows `hop` first — a
    // committed symlink would put git somewhere this check never looked.
    if (words[2].split("/").includes("..")) return "-C may not contain .. (name the directory itself)";
    start = path.resolve(cwd, words[2]);
  }
  if (discoversBareDirectory(start)) {
    return "git would start inside something it takes for a bare repository here, not in a real repository; use git -C <repository root>";
  }
  return null;
}

// git's discovery, upwards from its working directory: at each level `<dir>/.git` first,
// then `<dir>` itself as a bare repository. git walks up the physical path, links resolved
// (measured on Windows too: `git -C <junction to a bare repository's refs/>` picks that
// repository); both it and the path as written are walked, and a bare-looking directory
// found before a `.git` on either walk refuses the command.
function discoversBareDirectory(start) {
  const logical = path.resolve(start);
  let physical = logical;
  try {
    physical = fs.realpathSync.native(logical);
  } catch {
    return false; // no such directory: git refuses to start there
  }
  return walkFindsBare(logical) || (physical !== logical && walkFindsBare(physical));
}

function walkFindsBare(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return false;
    if (["HEAD", "objects", "refs"].every((entry) => fs.existsSync(path.join(dir, entry)))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// Returns null when `agentType` may run `command`, or the reason it may not. For an agent
// type this plugin does not confine, null means "no opinion". `context.cwd` is the agent's
// working directory (the hook input's cwd), against which a reader's `git -C` is resolved.
export function checkAgentCommand(agentType, command, pluginRoot, context = {}) {
  if (READER_TYPES.has(agentType)) return checkReaderCommand(command, context);
  const { command: kind, problem } = classifyRelayCommand(command, pluginRoot);
  if (KEY_TYPES.has(agentType)) return problem ?? (kind === "key" || kind === "expect" ? null : "the key agent may only run key and expect");
  if (RELAY_TYPES.has(agentType)) return problem ?? (kind === "key" || kind === "expect" ? "a job relay may never read the key or announce a request" : null);
  // any other subagent: only the runner's privileged commands are refused
  return invokesPrivileged(command) ? "only the ultracodex key agent may run the runner's key or expect command" : null;
}

function invokesPrivileged(command) {
  return typeof command === "string" && /codex-node\.mjs["']?\s+(key|expect)\b/.test(command);
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
  if (!agentType) return; // the main conversation
  const confined = RELAY_TYPES.has(agentType) || KEY_TYPES.has(agentType) || READER_TYPES.has(agentType);
  if (input.tool_name !== "Bash") {
    // the hook is registered for Bash; other tools of the confined agents are not ours to allow
    if (RELAY_TYPES.has(agentType) || KEY_TYPES.has(agentType)) respond("deny", "the ultracodex relay agents may only use Bash to run the runner");
    return;
  }
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const problem = checkAgentCommand(agentType, input.tool_input?.command, pluginRoot, { cwd });
  if (problem) respond("deny", `ultracodex guard: ${problem}. Use exactly the commands from your instructions.`);
  else if (confined) respond("allow", "ultracodex: a command this agent's type may run");
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) await main();
