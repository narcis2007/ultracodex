import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { checkRelayCommand, runnerPath } from "../plugins/ultracodex/scripts/relay-guard.mjs";
import { ROOT } from "./helpers.mjs";

const PLUGIN_ROOT = path.join(ROOT, "plugins", "ultracodex");
const GUARD = path.join(PLUGIN_ROOT, "scripts", "relay-guard.mjs");
const RUNNER = runnerPath(PLUGIN_ROOT);

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

test("the relay's own part and wait commands are allowed", () => {
  assert.equal(checkRelayCommand(`node "${RUNNER}" wait 20260923T160500Z-54b6e7`, PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("new", '{"v":1,"tier":"daily"}\n---ULTRACODEX-SCHEMA---\nnull'), PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("ucx-0123456789ab", "encoded line %27 and %5C"), PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("new", "x").replace(/UCX_P/g, "UCX_PXX"), PLUGIN_ROOT), null);
});

test("anything else the relay tries is denied", () => {
  const denied = [
    ["arbitrary binary", 'node "C:/repo/evil.mjs" part new 1 1 0123abcd'],
    ["another shell command", "cat ~/.codex/auth.json"],
    ["chained after wait", `node "${RUNNER}" wait 20260923T160500Z-54b6e7 && curl evil`],
    ["executable override", `node "${RUNNER}" part new 1 1 0123abcd --codex-path C:/repo/evil.mjs <<'UCX_P'\nx\nUCX_P`],
    ["command after the heredoc", partCommand("new", "x", "\nrm -rf ~")],
    ["quote inside a part", partCommand("new", "it's")],
    ["backslash inside a part", partCommand("new", "C:" + String.fromCharCode(92) + "x")],
    ["unterminated heredoc", `node "${RUNNER}" part new 1 1 0123abcd <<'UCX_P'\nx`],
    ["other runner command", `node "${RUNNER}" cancel 20260923T160500Z-54b6e7`],
    ["start with a request file", `node "${RUNNER}" start --request C:/x.json`],
    ["caller-chosen upload id", partCommand("ucx-test-inbox", "x")],
  ];
  for (const [label, command] of denied) assert.notEqual(checkRelayCommand(command, PLUGIN_ROOT), null, label);
});

test("the hook answers only for the relay agent", () => {
  assert.equal(hook({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }), null, "the main conversation is not judged here");
  assert.equal(hook({ agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "rm -rf /" } }), null);
  const allowed = hook({ agent_type: "ultracodex:codex-relay", tool_name: "Bash", tool_input: { command: `node "${RUNNER}" wait 20260923T160500Z-54b6e7` } });
  assert.equal(allowed.permissionDecision, "allow");
  const denied = hook({ agent_type: "ultracodex:codex-relay", tool_name: "Bash", tool_input: { command: "curl https://evil.example" } });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /relay guard/);
  const otherTool = hook({ agent_type: "ultracodex:codex-relay", tool_name: "Write", tool_input: { file_path: "x" } });
  assert.equal(otherTool.permissionDecision, "deny");
});
