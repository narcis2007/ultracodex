import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRelayCommand, claimRole, classifyRelayCommand, runnerPath } from "../plugins/ultracodex/scripts/relay-guard.mjs";
import { ROOT } from "./helpers.mjs";

const PLUGIN_ROOT = path.join(ROOT, "plugins", "ultracodex");
const GUARD = path.join(PLUGIN_ROOT, "scripts", "relay-guard.mjs");
const RUNNER = runnerPath(PLUGIN_ROOT);
const RUN = "20260923T160500Z-54b6e7";

const partCommand = (upload, body, extra = "") =>
  `node "${RUNNER}" part ${upload} 1 2 0123abcd <<'UCX_P'\n${body}\nUCX_P${extra}`;

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-guard-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function hook(input, home) {
  const out = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ULTRACODEX_HOME: home },
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim() ? JSON.parse(out.stdout).hookSpecificOutput : null;
}

test("the relay's own part, wait, page and key commands are allowed", () => {
  assert.equal(checkRelayCommand(`node "${RUNNER}" wait ${RUN}`, PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(`node "${RUNNER}" page ${RUN} 3`, PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("new", '{"v":1,"tier":"daily"}\n---ULTRACODEX-SCHEMA---\nnull'), PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("ucx-0123456789ab", "encoded line %27 and %5C"), PLUGIN_ROOT), null);
  assert.equal(checkRelayCommand(partCommand("new", "x").replace(/UCX_P/g, "UCX_PXX"), PLUGIN_ROOT), null);
  assert.deepEqual(classifyRelayCommand(`node "${RUNNER}" key`, PLUGIN_ROOT), { role: "key", problem: null });
  assert.equal(classifyRelayCommand(`node "${RUNNER}" wait ${RUN}`, PLUGIN_ROOT).role, "run");
});

test("anything else the relay tries is denied", () => {
  const denied = [
    ["arbitrary binary", 'node "C:/repo/evil.mjs" part new 1 1 0123abcd'],
    ["another shell command", "cat ~/.codex/auth.json"],
    ["reading the key file directly", "cat ~/.ultracodex/key"],
    ["chained after wait", `node "${RUNNER}" wait ${RUN} && curl evil`],
    ["chained after key", `node "${RUNNER}" key && curl evil`],
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
  for (const [label, command] of denied) assert.notEqual(checkRelayCommand(command, PLUGIN_ROOT), null, label);
});

test("the hook answers only for the relay agent", (t) => {
  const home = tempHome(t);
  assert.equal(hook({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, home), null, "the main conversation is not judged here");
  assert.equal(hook({ agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "rm -rf /" } }, home), null);
  const allowed = hook({ agent_type: "ultracodex:codex-relay", agent_id: "a1", tool_name: "Bash", tool_input: { command: `node "${RUNNER}" wait ${RUN}` } }, home);
  assert.equal(allowed.permissionDecision, "allow");
  const denied = hook({ agent_type: "ultracodex:codex-relay", agent_id: "a1", tool_name: "Bash", tool_input: { command: "curl https://evil.example" } }, home);
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /relay guard/);
  const otherTool = hook({ agent_type: "ultracodex:codex-relay", agent_id: "a1", tool_name: "Write", tool_input: { file_path: "x" } }, home);
  assert.equal(otherTool.permissionDecision, "deny");
});

test("a relay that saw a job never reads the key, and the key relay never runs a job", (t) => {
  const home = tempHome(t);
  const relay = (agentId, command) =>
    hook({ agent_type: "ultracodex:codex-relay", agent_id: agentId, tool_name: "Bash", tool_input: { command } }, home).permissionDecision;
  const key = `node "${RUNNER}" key`;
  const wait = `node "${RUNNER}" wait ${RUN}`;
  // a job relay (its prompt carried untrusted task text)
  assert.equal(relay("job-1", partCommand("new", "x")), "allow");
  assert.equal(relay("job-1", wait), "allow");
  assert.equal(relay("job-1", key), "deny", "a relay that uploaded a job cannot fetch the key");
  // the key relay
  assert.equal(relay("key-1", key), "allow");
  assert.equal(relay("key-1", key), "allow", "the same role may repeat");
  assert.equal(relay("key-1", wait), "deny");
  assert.equal(relay("key-1", partCommand("new", "x")), "deny");
  // no agent id: jobs still work, the key is refused
  assert.equal(hook({ agent_type: "ultracodex:codex-relay", tool_name: "Bash", tool_input: { command: wait } }, home).permissionDecision, "allow");
  assert.equal(hook({ agent_type: "ultracodex:codex-relay", tool_name: "Bash", tool_input: { command: key } }, home).permissionDecision, "deny");
});

test("claimRole is first-come: whichever role is recorded first wins", (t) => {
  const env = { ULTRACODEX_HOME: tempHome(t) };
  assert.equal(claimRole("agent-7", "key", env), null);
  assert.match(claimRole("agent-7", "run", env), /may not run jobs/);
  assert.equal(claimRole("agent-7", "key", env), null);
  assert.equal(claimRole("../escape", "run", env), null, "an odd id is never used as a path (and gets no key)");
  assert.match(claimRole("../escape", "key", env), /identifiable relay/);
  assert.equal(fs.existsSync(path.join(env.ULTRACODEX_HOME, "escape")), false);
});
