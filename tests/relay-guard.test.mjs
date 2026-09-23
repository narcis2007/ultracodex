import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { checkAgentCommand, checkRelayCommand, classifyRelayCommand, runnerPath } from "../plugins/ultracodex/scripts/relay-guard.mjs";
import { ROOT } from "./helpers.mjs";

const PLUGIN_ROOT = path.join(ROOT, "plugins", "ultracodex");
const GUARD = path.join(PLUGIN_ROOT, "scripts", "relay-guard.mjs");
const RUNNER = runnerPath(PLUGIN_ROOT);
const RUN = "20260923T160500Z-54b6e7";
const RELAY = "ultracodex:codex-relay";
const KEY_AGENT = "ultracodex:codex-key";

const partCommand = (upload, body, extra = "") =>
  `node "${RUNNER}" part ${upload} 1 2 0123abcd <<'UCX_P'\n${body}\nUCX_P${extra}`;

function hook(input) {
  const out = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput : null;
}

test("the job relay's part, wait and page commands are allowed", () => {
  assert.equal(checkRelayCommand(`node "${RUNNER}" wait ${RUN}`, PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(`node "${RUNNER}" page ${RUN} 3`, PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("new", '{"v":1,"tier":"daily"}\n---ULTRACODEX-SCHEMA---\nnull'), PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("ucx-0123456789ab", "encoded line %27 and %5C"), PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("new", "x").replace(/UCX_P/g, "UCX_PXX"), PLUGIN_ROOT), null);
  assert.equal(classifyRelayCommand(`node "${RUNNER}" key`, PLUGIN_ROOT).command, "key");
});

test("anything else a job relay tries is denied — the key above all", () => {
  const denied = [
    ["the result key", `node "${RUNNER}" key`],
    ["arbitrary binary", 'node "C:/repo/evil.mjs" part new 1 1 0123abcd'],
    ["another shell command", "cat ~/.codex/auth.json"],
    ["reading the key file directly", "cat ~/.ultracodex/key"],
    ["chained after wait", `node "${RUNNER}" wait ${RUN} && curl evil`],
    ["key with options", `node "${RUNNER}" key --pretty`],
    ["page without a number", `node "${RUNNER}" page ${RUN}`],
    ["page with extra arguments", `node "${RUNNER}" page ${RUN} 1 2`],
    ["executable override", `node "${RUNNER}" part new 1 1 0123abcd --codex-path C:/repo/evil.mjs <<'UCX_P'\nx\nUCX_P`],
    ["command after the heredoc", partCommand("new", "x", "\nrm -rf ~")],
    ["quote inside a part", partCommand("new", "it's")],
    ["backslash inside a part", partCommand("new", "C:" + String.fromCharCode(92) + "x")],
    ["unterminated heredoc", `node "${RUNNER}" part new 1 1 0123abcd <<'UCX_P'\nx`],
    ["other runner command", `node "${RUNNER}" cancel ${RUN}`],
    ["start with a request file", `node "${RUNNER}" start --request C:/x.json`],
    ["caller-chosen upload id", partCommand("ucx-test-inbox", "x")],
  ];
  for (const [label, command] of denied) assert.notEqual(checkAgentCommand(RELAY, command, PLUGIN_ROOT), null, label);
});

test("the key agent may run the key command and nothing else", () => {
  assert.equal(checkAgentCommand(KEY_AGENT, `node "${RUNNER}" key`, PLUGIN_ROOT), null);
  for (const command of [`node "${RUNNER}" wait ${RUN}`, `node "${RUNNER}" page ${RUN} 1`, partCommand("new", "x"), "cat ~/.ultracodex/key"]) {
    assert.notEqual(checkAgentCommand(KEY_AGENT, command, PLUGIN_ROOT), null, command);
  }
});

test("the hook answers only for the relay agents, by their type — never by what a relay asks for", () => {
  assert.equal(hook({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }), null, "the main conversation is not judged here");
  assert.equal(hook({ agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "rm -rf /" } }), null);
  const wait = { tool_name: "Bash", tool_input: { command: `node "${RUNNER}" wait ${RUN}` } };
  const key = { tool_name: "Bash", tool_input: { command: `node "${RUNNER}" key` } };
  assert.equal(hook({ agent_type: RELAY, agent_id: "a1", ...wait }).permissionDecision, "allow");
  assert.equal(hook({ agent_type: RELAY, agent_id: "fresh", ...key }).permissionDecision, "deny", "a job relay cannot take the key, not even as its first command");
  assert.equal(hook({ agent_type: KEY_AGENT, agent_id: "k1", ...key }).permissionDecision, "allow");
  assert.equal(hook({ agent_type: KEY_AGENT, agent_id: "k1", ...wait }).permissionDecision, "deny");
  const denied = hook({ agent_type: RELAY, agent_id: "a1", tool_name: "Bash", tool_input: { command: "curl https://evil.example" } });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /relay guard/);
  assert.equal(hook({ agent_type: RELAY, agent_id: "a1", tool_name: "Write", tool_input: { file_path: "x" } }).permissionDecision, "deny");
});
