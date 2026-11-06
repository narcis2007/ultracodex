import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RUNNER_VERSION } from "../plugins/ultracodex/scripts/codex-node.mjs";
import {
  GIT_READ_TIMEOUT_MS, GIT_SELECTION_ENV, WORKTREE_ADD_TIMEOUT_MS, addWorktree, findMountPath, git, gitEnv, parseWorktrees, probeVolume,
  resolveGitExecutable, resolveWorktreeLocation, strictCanonicalPath, volumeInfo, worktreePath,
} from "../plugins/ultracodex/scripts/worktree.mjs";
import { makeGitFixture, runCli } from "./helpers.mjs";

const resolve = (fixture, extra = {}) => resolveWorktreeLocation({ ...fixture.options, ...extra });
const mkdir = (target) => { fs.mkdirSync(target, { recursive: true }); return target; };
const failed = (extra = {}) => ({ ok: false, status: 128, stdout: "", stderr: "injected failure", error: null, timedOut: false, ...extra });
const throwsInvalid = (fn, pattern) => assert.throws(fn, (error) => error.kind === "invalid_request" && (!pattern || pattern.test(error.message)));

test("NUL worktree porcelain preserves spaces and newlines and identifies bare entries", () => {
  assert.deepEqual(parseWorktrees("worktree /tmp/repo\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/a b\nc\0bare\0\0"),
    [{ path: "/tmp/repo", bare: false }, { path: "/tmp/a b\nc", bare: true }]);
});

test("resolution falls back to a sibling with no configuration", (t) => {
  const f = makeGitFixture(t);
  const result = resolve(f);
  assert.equal(result.source, "sibling");
  assert.equal(result.root, path.dirname(f.repo));
  assert.equal(result.path, path.join(path.dirname(f.repo), "repo.codex-task"));
  assert.equal(result.repoTop, f.repo);
  assert.equal(result.repoName, "repo");
  assert.deepEqual(result.hints, []);
});

for (const names of [["wt"], [".worktrees"], ["wt", ".worktrees"]]) {
  test(`auto-detects ${names.join(" and ")} with wt first`, (t) => {
    const f = makeGitFixture(t);
    for (const name of names) mkdir(path.join(path.dirname(f.repo), name));
    const result = resolve(f);
    assert.equal(result.source, "auto");
    assert.equal(result.root, path.join(path.dirname(f.repo), names[0]));
  });
}

test("auto searches the grandparent but never the great-grandparent", (t) => {
  const f = makeGitFixture(t, { layout: "family/group/repo" });
  const great = mkdir(path.join(f.temp, "wt"));
  assert.equal(resolve(f).source, "sibling");
  const grand = mkdir(path.join(f.temp, "family", "wt"));
  assert.equal(resolve(f).root, grand);
  assert.notEqual(resolve(f).root, great);
});

test("auto skips home, levels above home and the filesystem root", (t) => {
  const f = makeGitFixture(t, { layout: "family/group/repo" });
  mkdir(path.join(f.temp, "family", "group", "wt"));
  mkdir(path.join(f.temp, "family", "wt"));
  assert.equal(resolve(f, { home: path.join(f.temp, "family", "group") }).source, "sibling");
  assert.equal(resolve(f, { home: f.repo }).source, "sibling");
  const calls = [];
  const root = path.parse(f.repo).root;
  const virtualRepo = path.join(root, "virtual-family", "repo");
  const virtualGit = (args, opts) => {
    calls.push(opts.repo);
    if (args[0] === "worktree") return { ok: true, stdout: `worktree ${virtualRepo}\0HEAD abc\0\0` };
    if (args[0] === "config") return args.includes("--get") ? failed({ status: 1, stderr: "" }) : { ok: true, stdout: "" };
    if (opts.repo === virtualRepo) return { ok: true, stdout: virtualRepo };
    return { ok: true, stdout: virtualRepo };
  };
  const virtualFs = { lstatSync: (target) => {
    if (target.endsWith("repo.codex-task")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isDirectory: () => true };
  }, statSync: () => ({ isDirectory: () => true }), realpathSync: { native: (target) => target } };
  assert.equal(resolve(f, { git: virtualGit, fileSystem: virtualFs, home: f.home }).source, "sibling");
  assert.ok(calls.includes(path.join(root, "virtual-family", "wt")));
  assert.ok(!calls.includes(path.join(root, "wt")));
  assert.ok(!calls.includes(path.join(root, ".worktrees")));
});

test("auto skips a wt repository and continues to .worktrees", (t) => {
  const f = makeGitFixture(t);
  const wt = mkdir(path.join(path.dirname(f.repo), "wt"));
  f.git(["init", "--template="], wt);
  const next = mkdir(path.join(path.dirname(f.repo), ".worktrees"));
  assert.equal(resolve(f).root, next);
});

test("auto skips candidates inside a repository and continues to the grandparent", (t) => {
  const f = makeGitFixture(t, { layout: "family/group/repo" });
  const group = path.dirname(f.repo);
  f.git(["init", "--template="], group);
  mkdir(path.join(group, "wt"));
  mkdir(path.join(group, ".worktrees"));
  const next = mkdir(path.join(f.temp, "family", "wt"));
  assert.equal(resolve(f).root, next);
});

for (const source of ["git", "env"]) {
  test(`auto can be disabled through ${source}`, (t) => {
    const f = makeGitFixture(t);
    mkdir(path.join(path.dirname(f.repo), "wt"));
    if (source === "git") f.git(["config", "ultracodex.worktreeAuto", "false"]);
    else f.options.env = { ...f.env, ULTRACODEX_WORKTREE_AUTO: "0" };
    assert.equal(resolve(f).source, "sibling");
  });
}

test("precedence: dir > root > git config > env > auto > sibling", (t) => {
  const f = makeGitFixture(t);
  assert.equal(resolve(f).source, "sibling");
  mkdir(path.join(path.dirname(f.repo), "wt"));
  assert.equal(resolve(f).source, "auto");
  f.options.env = { ...f.env, ULTRACODEX_WORKTREE_ROOT: path.join(f.temp, "env") };
  assert.equal(resolve(f).source, "env");
  const configured = path.join(f.temp, "config");
  f.git(["config", "ultracodex.worktreeRoot", configured]);
  assert.equal(resolve(f).source, "gitConfig");
  assert.equal(resolve(f, { root: path.join(f.temp, "root") }).source, "root");
  const dir = path.join(f.temp, "exact");
  // root + dir is a usage error; each independently beats the configured root.
  assert.equal(resolve(f, { dir }).source, "dir");
  assert.equal(resolve(f, { dir }).path, dir);
  assert.throws(() => resolve(f, { root: f.temp, dir }), /mutually exclusive/);
});

test("relative config roots and leading ~ resolve against main checkout and home", (t) => {
  const f = makeGitFixture(t);
  f.git(["config", "ultracodex.worktreeRoot", "../relative"]);
  assert.equal(resolve(f).root, path.join(path.dirname(f.repo), "relative"));
  f.git(["config", "ultracodex.worktreeRoot", "~/worktrees"]);
  assert.equal(resolve(f).root, path.join(f.home, "worktrees"));
});

test("global includeIf config is read for the main worktree", (t) => {
  const f = makeGitFixture(t);
  const included = path.join(f.temp, "included.gitconfig");
  const configured = path.join(f.temp, "included-root");
  fs.writeFileSync(included, `[ultracodex]\n\tworktreeRoot = ${configured.replace(/\\/g, "/")}\n`);
  const gitdir = `${f.repo.replace(/\\/g, "/")}/`;
  fs.writeFileSync(f.globalConfig, `[includeIf "gitdir:${gitdir}"]\n\tpath = ${included.replace(/\\/g, "/")}\n`);
  assert.equal(resolve(f).source, "gitConfig");
  assert.equal(resolve(f).root, configured);
});

test("a linked worktree or any path inside it resolves from the main worktree", (t) => {
  const f = makeGitFixture(t);
  const linked = path.join(f.temp, "linked");
  f.git(["worktree", "add", "-b", "linked", linked]);
  const nested = mkdir(path.join(linked, "nested"));
  const result = resolve(f, { repo: nested });
  assert.equal(result.repoTop, f.repo);
  assert.equal(result.repoName, "repo");
  assert.equal(result.path, path.join(path.dirname(f.repo), "repo.codex-task"));
  f.git(["commit", "--allow-empty", "-m", "linked-only"], linked);
  const added = addWorktree({ ...f.options, repo: nested });
  assert.equal(added.baseOid, f.git(["rev-parse", "HEAD"]).stdout.trim());
  assert.notEqual(added.baseOid, f.git(["rev-parse", "HEAD"], linked).stdout.trim());
});

test("rejects a path or root inside any checkout", (t) => {
  const f = makeGitFixture(t);
  const linked = path.join(f.temp, "linked");
  f.git(["worktree", "add", "-b", "linked", linked]);
  throwsInvalid(() => resolve(f, { dir: path.join(f.repo, "nested") }), /outside/);
  throwsInvalid(() => resolve(f, { root: path.join(f.repo, "root") }), /outside/);
  throwsInvalid(() => resolve(f, { dir: path.join(linked, "nested") }), /outside/);
  throwsInvalid(() => resolve(f, { root: path.join(linked, "root") }), /outside/);
});

test("rejects existing targets and overlap in either direction with runner home", (t) => {
  const f = makeGitFixture(t);
  const exists = mkdir(path.join(f.temp, "exists"));
  assert.throws(() => resolve(f, { dir: exists }), (error) => error.kind === "invalid_request" && error.code === "worktree_exists");
  throwsInvalid(() => resolve(f, { dir: path.join(f.runnerHome, "nested") }), /runner home/);
  throwsInvalid(() => resolve(f, { dir: f.temp }), /runner home/);
});

test("rejects invalid slugs and accepts the boundary characters and length", (t) => {
  const f = makeGitFixture(t);
  for (const slug of [undefined, "", "A", "-x", "a..b", "a.lock", "a.", "a/b", "a b", "a".repeat(64)]) {
    assert.throws(() => resolve(f, { slug }), /--slug/);
  }
  for (const slug of ["a", "a._-b", "a".repeat(63)]) assert.ok(resolve(f, { slug }).path);
});

test("bare-backed repositories are refused directly and through a linked worktree, even with --dir", (t) => {
  const f = makeGitFixture(t);
  const bare = mkdir(path.join(f.temp, "bare.git"));
  f.git(["clone", "--bare", "--template=", f.repo, bare]);
  const linked = path.join(f.temp, "bare-linked");
  f.git(["worktree", "add", linked, "main"], bare);
  for (const repo of [bare, linked]) for (const dir of [undefined, path.join(f.temp, "explicit")]) {
    assert.throws(() => resolve(f, { repo, dir }), (error) => error.kind === "invalid_request" && error.code === "unsupported_layout");
  }
});

test("separate git directories and submodules with metadata as the first entry are refused", (t) => {
  const f = makeGitFixture(t);
  const separate = mkdir(path.join(f.temp, "separate"));
  f.git(["init", "--template=", `--separate-git-dir=${path.join(f.temp, "metadata")}`], separate);
  throwsInvalid(() => resolve(f, { repo: separate }));
  f.git(["-c", "protocol.file.allow=always", "submodule", "add", f.repo, "module"]);
  const submodule = path.join(f.repo, "module");
  assert.throws(() => resolve(f, { repo: submodule }), (error) => error.code === "unsupported_layout");
});

test("strict paths reject file ancestors, dangling links and injected access failures", (t) => {
  const f = makeGitFixture(t);
  const file = path.join(f.temp, "file");
  fs.writeFileSync(file, "file");
  throwsInvalid(() => resolve(f, { root: path.join(file, "child") }), /not a directory/);
  const blocked = { ...fs, lstatSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  throwsInvalid(() => resolve(f, { fileSystem: blocked }), /denied/);
  assert.throws(() => strictCanonicalPath(f.temp, blocked), { code: "EACCES" });
  // Inject a dangling link on every platform, including Windows without symlink privilege.
  const dangling = { ...fs, lstatSync: () => ({ isSymbolicLink: () => true }), realpathSync: {
    native: () => { throw Object.assign(new Error("dangling link"), { code: "ENOENT" }); },
  } };
  throwsInvalid(() => resolve(f, { fileSystem: dangling }), /dangling link/);
});

test("junction roots emit a realpath hint and cannot bypass containment", { skip: process.platform !== "win32" }, (t) => {
  const f = makeGitFixture(t);
  const real = mkdir(path.join(f.temp, "real"));
  const link = path.join(f.temp, "link");
  fs.symlinkSync(real, link, "junction");
  assert.match(resolve(f, { root: link }).hints.join("\n"), /real path/);
  const unsafe = path.join(f.temp, "unsafe");
  fs.symlinkSync(f.repo, unsafe, "junction");
  throwsInvalid(() => resolve(f, { root: unsafe }), /outside/);
  fs.rmSync(real, { recursive: true });
  throwsInvalid(() => resolve(f, { root: path.join(link, "child") }));
});

test("symlink roots emit a hint and dangling ancestors fail closed", { skip: process.platform === "win32" }, (t) => {
  const f = makeGitFixture(t);
  const real = mkdir(path.join(f.temp, "real"));
  const link = path.join(f.temp, "link");
  fs.symlinkSync(real, link);
  assert.match(resolve(f, { root: link }).hints.join("\n"), /real path/);
  fs.rmSync(real, { recursive: true });
  throwsInvalid(() => resolve(f, { root: path.join(link, "child") }));
});

test("explicit roots inside another repository produce a hint", (t) => {
  const f = makeGitFixture(t);
  const other = mkdir(path.join(f.temp, "other"));
  f.git(["init", "--template="], other);
  for (const extra of [{ root: path.join(other, "nested") }, { dir: path.join(other, "exact") },
    { env: { ...f.env, ULTRACODEX_WORKTREE_ROOT: other } }]) {
    assert.match(resolve(f, extra).hints.join("\n"), /another git working tree/);
  }
});

test("git helper sanitizes selection variables and uses absolute -C and trusted cwd", (t) => {
  const f = makeGitFixture(t);
  let captured;
  const env = { ...f.env };
  for (const key of GIT_SELECTION_ENV) env[key] = "poison";
  const out = git(["rev-parse", "HEAD"], { repo: f.repo, runnerHome: f.runnerHome, env,
    spawn: (command, args, opts) => { captured = { command, args, opts }; return { status: 0, stdout: "yes", stderr: "" }; } });
  assert.equal(out.ok, true);
  assert.ok(path.isAbsolute(captured.command));
  assert.equal(captured.command, resolveGitExecutable({ env: f.env }));
  assert.deepEqual(captured.args.slice(0, 4), ["-c", "safe.bareRepository=explicit", "-C", f.repo]);
  assert.equal(captured.opts.cwd, f.runnerHome);
  assert.equal(captured.opts.shell, false);
  assert.equal(captured.opts.windowsHide, true);
  assert.equal(captured.opts.timeout, GIT_READ_TIMEOUT_MS);
  assert.equal(captured.opts.env.GIT_TERMINAL_PROMPT, "0");
  for (const key of GIT_SELECTION_ENV) assert.equal(captured.opts.env[key], undefined);
  assert.equal(gitEnv({ git_dir: "poison" }).git_dir, undefined);
  assert.throws(() => git([], { repo: "relative" }), /absolute/);
  for (const result of [{ status: 1 }, { status: null, error: new Error("spawn failed") },
    { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }, { status: 0, signal: "SIGTERM" }]) {
    assert.equal(git([], { repo: f.repo, runnerHome: f.runnerHome, spawn: () => result }).ok, false);
  }
});

test("reader failures never become absent config, an empty worktree list or a clean candidate", (t) => {
  const f = makeGitFixture(t);
  mkdir(path.join(path.dirname(f.repo), "wt"));
  for (const command of ["worktree", "config", "rev-parse"]) {
    const run = (args, opts) => args[0] === command ? failed() : git(args, { ...opts, env: f.env, runnerHome: f.runnerHome });
    throwsInvalid(() => resolve(f, { git: run }));
  }
  throwsInvalid(() => resolve(f, { git: () => ({ ok: true, stdout: "" }) }), /invalid worktree list/);
  const missingThenFailure = (args, opts) => args[0] === "config" ? failed({ status: args.includes("--get") ? 1 : 128, stderr: "" })
    : git(args, { ...opts, env: f.env, runnerHome: f.runnerHome });
  throwsInvalid(() => resolve(f, { git: missingThenFailure }));
});

for (const type of ["branch", "tag", "oid"]) {
  test(`add creates a branch and complete worktree from a ${type} base`, (t) => {
    const f = makeGitFixture(t);
    const oid = f.git(["rev-parse", "HEAD"]).stdout.trim();
    f.git(["branch", "base-branch"]);
    f.git(["tag", "base-tag"]);
    f.git(["commit", "--allow-empty", "-m", "new head"]);
    const base = { branch: "base-branch", tag: "base-tag", oid }[type];
    const result = addWorktree({ ...f.options, base, branch: "custom/task" });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.base, base);
    assert.equal(result.baseOid, oid);
    assert.equal(result.branch, "custom/task");
    assert.equal(f.git(["rev-parse", "HEAD"], result.path).stdout.trim(), oid);
    assert.equal(f.git(["branch", "--show-current"], result.path).stdout.trim(), "custom/task");
    assert.equal(fs.readFileSync(path.join(result.path, "tracked.txt"), "utf8"), "fixture\n");
  });
}

test("option-looking base and branch, invalid refs and existing branches are refused before add", (t) => {
  const f = makeGitFixture(t);
  const calls = [];
  const run = (args, opts) => { calls.push(args); return git(args, { ...opts, env: f.env, runnerHome: f.runnerHome }); };
  for (const extra of [{ base: "--no-checkout" }, { branch: "-x" }, { branch: "bad..name" }, { branch: "main" }, { base: "missing" }]) {
    throwsInvalid(() => addWorktree({ ...f.options, ...extra, git: run }));
  }
  assert.ok(!calls.some((args) => args[0] === "worktree" && args[1] === "add"));
  assert.equal(fs.existsSync(resolve(f).path), false);
});

test("a failed branch existence reader fails closed before add", (t) => {
  const f = makeGitFixture(t);
  const calls = [];
  const run = (args, opts) => {
    calls.push(args);
    return args.includes("--quiet") ? failed({ status: null, error: new Error("spawn failed") }) : git(args, { ...opts, env: f.env, runnerHome: f.runnerHome });
  };
  throwsInvalid(() => addWorktree({ ...f.options, git: run }));
  assert.ok(!calls.some((args) => args[1] === "add"));
});

test("post-checkout failure reports a retained complete worktree and branch", (t) => {
  const f = makeGitFixture(t);
  fs.writeFileSync(path.join(f.hooks, "post-checkout"), "#!/bin/sh\necho fixture-hook-failed >&2\nexit 7\n", { mode: 0o755 });
  const result = addWorktree(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.created, true);
  assert.match(result.stderr, /fixture-hook-failed/);
  assert.equal(fs.existsSync(path.join(result.path, "tracked.txt")), true);
  assert.match(f.git(["worktree", "list", "--porcelain", "-z"]).stdout, /repo.codex-task/);
  assert.equal(f.git(["rev-parse", "refs/heads/codex/task"]).status, 0);
});

test("failed add never deletes a target, including when registration cannot be read", (t) => {
  const f = makeGitFixture(t);
  for (const unreadable of [false, true]) {
    const slug = unreadable ? "unreadable" : "failed";
    let added = false;
    const target = resolve(f, { slug }).path;
    const run = (args, opts) => {
      if (args[0] === "worktree" && args[1] === "add") {
        added = true;
        mkdir(target);
        fs.writeFileSync(path.join(target, "keep.txt"), "keep");
        return failed();
      }
      if (unreadable && added && args[0] === "worktree") return failed();
      return git(args, { ...opts, env: f.env, runnerHome: f.runnerHome });
    };
    const result = addWorktree({ ...f.options, slug, git: run });
    assert.equal(result.ok, false);
    assert.equal(result.created, unreadable ? null : false);
    if (unreadable) assert.match(result.registrationError, /cannot list/);
    assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep");
  }
});

test("inherited GIT_DIR and GIT_WORK_TREE cannot change the repository", (t) => {
  const f = makeGitFixture(t);
  const env = { ...f.env, GIT_DIR: path.join(f.temp, "nonexistent.git"), GIT_WORK_TREE: f.home };
  const result = addWorktree({ ...f.options, env });
  assert.equal(result.ok, true);
  assert.equal(result.repo, f.repo);
  assert.equal(fs.existsSync(path.join(f.home, "tracked.txt")), false);
});

const refs = [{ accessPath: "D:\\wt\\", label: "Fast" }];
const ntfs = { fileSystem: "NTFS", label: "System", driveLetter: "C", accessPath: "C:\\" };
const routeFs = (mount, device = 2) => ({ statSync: (target) => ({
  isDirectory: () => true,
  dev: target === mount || target.startsWith(`${mount}${path.sep}`) ? device : 1,
}) });
const driveRoot = path.parse(path.resolve("target")).root;
const driveFs = { statSync: () => ({ isDirectory: () => true, dev: 2 }) };
test("NTFS with ReFS volumes gives their access paths and an exact PowerShell config line", () => {
  const result = volumeInfo("target", { platform: "win32", repo: "C:\\Main Checkout\\repo", fileSystem: driveFs,
    probe: () => ({ volume: ntfs, refs }) });
  assert.deepEqual(result.volume, { ...ntfs, mountPath: driveRoot });
  assert.equal(result.hints.length, 1);
  assert.ok(result.hints[0].includes('git -C "C:/Main Checkout/repo" config ultracodex.worktreeRoot "D:/wt"'));
  assert.match(result.hints[0], /PowerShell/);
});

test("ReFS at a drive root has no hint; folder-mounted ReFS gives the Docker hint", () => {
  const volume = { ...ntfs, fileSystem: "ReFS", accessPath: "D:\\mount\\" };
  assert.deepEqual(volumeInfo("target", { platform: "win32", fileSystem: driveFs,
    probe: () => ({ volume, refs }) }).hints, []);
  const mount = path.resolve("folder-mount");
  const target = path.join(mount, "worktree");
  const result = volumeInfo(target, { platform: "win32", fileSystem: routeFs(mount), probe: () => ({ volume, refs }) });
  assert.equal(result.volume.mountPath, mount);
  assert.equal(result.hints.length, 1);
  assert.equal(result.hints[0], "Observed with Docker Desktop on Windows: bind mounts from a folder-mounted volume fail. If this task's Docker tests bind-mount files from the worktree, put the worktree on a drive-letter path for this task (`--dir` / `--root`).");
  assert.equal("onDevDrive" in result.volume, false);
});

test("failed or timed-out volume probes stay advisory for path and add", (t) => {
  const f = makeGitFixture(t);
  for (const probe of [() => null, () => { throw new Error("timeout"); }]) {
    const result = worktreePath({ ...f.options, noVolumeCheck: false, platform: "win32", probe });
    assert.equal(result.ok, true);
    assert.equal(result.volume, null);
  }
  const result = addWorktree({ ...f.options, noVolumeCheck: false, platform: "win32", probe: () => null });
  assert.equal(result.ok, true);
  assert.equal(result.volume, null);
});

test("non-Windows and --no-volume-check never invoke the probe", () => {
  const probe = () => assert.fail("probe must not run");
  assert.deepEqual(volumeInfo("target", { platform: "linux", probe }), { volume: null, hints: [] });
  assert.deepEqual(volumeInfo("target", { platform: "win32", noVolumeCheck: true, probe }), { volume: null, hints: [] });
});

test("probe passes paths only through env, uses 10 seconds and tolerates process/JSON failures", () => {
  const target = "C:\\path with 'quotes'\\$special";
  const result = probeVolume(target, { env: { MARK: "yes" }, run: (script, opts) => {
    assert.ok(!script.includes(target));
    assert.equal(opts.env.ULTRACODEX_VOLUME_PATH, target);
    assert.equal(opts.env.MARK, "yes");
    assert.equal(opts.timeout, 10_000);
    assert.match(script, /Get-Volume -FilePath/);
    assert.match(script, /Get-CimInstance Win32_Volume/);
    return { status: 0, stdout: JSON.stringify({ volume: ntfs, refs }) };
  } });
  assert.deepEqual(result, { volume: ntfs, refs });
  for (const out of [{ status: 1 }, { status: null, error: { code: "ETIMEDOUT" } }, { status: 0, stdout: "bad json" }, { status: 0, stdout: "{}" }]) {
    assert.equal(probeVolume(target, { run: () => out }), null);
  }
});

test("real Windows volume probe is advisory even when CIM or storage access is denied", { skip: process.platform !== "win32" }, () => {
  const result = probeVolume(os.tmpdir());
  assert.ok(result === null || (typeof result.volume.fileSystem === "string" && Array.isArray(result.refs)));
});

test("CLI dispatch, JSON envelopes, usage errors and exit codes", async (t) => {
  const f = makeGitFixture(t);
  const common = ["--repo", f.repo, "--slug", "cli", "--no-volume-check"];
  const location = await runCli(["worktree", "path", ...common], { env: f.env });
  assert.equal(location.code, 0, location.stdout);
  assert.equal(location.stdout.trim().split("\n").length, 1);
  assert.equal(location.json.ultracodex, 1);
  assert.equal(location.json.runnerVersion, RUNNER_VERSION);
  assert.equal(location.json.ok, true);
  assert.equal(location.json.source, "sibling");
  assert.equal(location.json.repo, f.repo);
  assert.equal(location.json.volume, null);
  assert.deepEqual(location.json.hints, []);
  assert.equal(fs.existsSync(location.json.path), false);
  const created = await runCli(["worktree", "add", ...common, "--pretty"], { env: f.env });
  assert.equal(created.code, 0, created.stdout);
  for (const key of ["created", "path", "branch", "base", "baseOid", "source", "root", "repo", "volume", "hints"]) assert.ok(key in created.json, key);
  assert.equal(created.json.created, true);
  assert.equal(created.json.branch, "codex/cli");
  assert.equal(created.json.base, "HEAD");
  const duplicate = await runCli(["worktree", "path", ...common], { env: f.env });
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.json.error.kind, "invalid_request");
  assert.equal(duplicate.json.error.code, "worktree_exists");
  for (const args of [["worktree"], ["worktree", "remove", ...common], ["worktree", "path"],
    ["worktree", "path", "--repo", f.repo, "--slug", "BAD"], ["worktree", "path", ...common, "--root", f.temp, "--dir", f.temp],
    ["worktree", "path", ...common, "--base", "HEAD"], ["worktree", "path", ...common, "extra"], ["worktree", "path", ...common, "--dir"]]) {
    const out = await runCli(args, { env: f.env });
    assert.equal(out.code, 2, out.stdout);
    assert.equal(out.json.error.kind, "usage");
  }
  for (const extra of [["--base", "--no-checkout"], ["--branch", "-x"], ["--branch", "main"]]) {
    const out = await runCli(["worktree", "add", "--repo", f.repo, "--slug", "invalid", "--no-volume-check", ...extra], { env: f.env });
    assert.equal(out.code, extra[1] === "main" ? 1 : 2, out.stdout);
    assert.equal(out.json.ok, false);
  }
  const help = await runCli(["help"], { env: f.env });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /worktree path --repo/);
  assert.match(help.stdout, /worktree add --repo/);
  const old = await runCli(["policy", "--repo", f.repo], { env: f.env });
  assert.equal(old.code, 2, "new flags do not change other commands");
});

test("canonical paths discard trailing separators without changing filesystem roots", (t) => {
  const f = makeGitFixture(t);
  const root = mkdir(path.join(f.temp, "root"));
  const fileSystem = { ...fs, realpathSync: { native: (target) => `${fs.realpathSync.native(target)}${path.sep}` } };
  assert.equal(strictCanonicalPath(root, fileSystem), fs.realpathSync.native(root));
  const fsRoot = path.parse(root).root;
  assert.equal(strictCanonicalPath(fsRoot, fileSystem), fs.realpathSync.native(fsRoot));
  assert.deepEqual(resolve(f, { root, fileSystem }).hints, []);
});

test("case-only canonical differences do not change checkout identity or emit a hint", { skip: process.platform !== "win32" }, (t) => {
  const f = makeGitFixture(t);
  const root = mkdir(path.join(f.temp, "root"));
  const fileSystem = { ...fs, realpathSync: { native: (target) => fs.realpathSync.native(target).toUpperCase() } };
  assert.deepEqual(resolve(f, { root, fileSystem }).hints, []);
  const run = (args, opts) => args[0] === "rev-parse" && args[1] === "--show-toplevel" && !opts.discoveryAcrossFileSystem
    ? { ok: true, stdout: f.repo.toUpperCase() } : git(args, { env: f.env, runnerHome: f.runnerHome, ...opts });
  assert.deepEqual(resolve(f, { root, git: run }).hints, []);
});

test("a link inside a checkout pointing outside cannot be used as the root or path", (t) => {
  const f = makeGitFixture(t);
  const outside = mkdir(path.join(f.temp, "outside"));
  const link = path.join(f.repo, "outside-link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  throwsInvalid(() => resolve(f, { root: link }), /outside every checkout/);
  throwsInvalid(() => resolve(f, { dir: path.join(link, "exact") }), /outside every checkout/);
});

test("worktree valued flags refuse flags as values without creating a destination", async (t) => {
  const f = makeGitFixture(t);
  for (const flag of ["--repo", "--slug", "--base", "--branch", "--root", "--dir"]) {
    for (const value of ["--no-volume-check", "--unknown", "--pretty", "-x", "-"]) {
      const out = await runCli(["worktree", "add", "--repo", f.repo, "--slug", "missing-value", flag, value], { env: f.env });
      assert.equal(out.code, 2, out.stdout);
      assert.equal(out.json.error.message, `${flag} requires a value`);
    }
  }
  assert.equal(fs.existsSync(resolve(f, { slug: "missing-value" }).path), false);
});

test("a dangling auto candidate is skipped but a dangling explicit destination is refused", (t) => {
  const f = makeGitFixture(t);
  const wt = path.join(path.dirname(f.repo), "wt");
  fs.symlinkSync(path.join(f.temp, "missing"), wt, process.platform === "win32" ? "junction" : "dir");
  const next = mkdir(path.join(path.dirname(f.repo), ".worktrees"));
  assert.equal(resolve(f).root, next);
  throwsInvalid(() => resolve(f, { root: wt }));
  const blocked = { ...fs, statSync: (target) => {
    if (target === wt) throw Object.assign(new Error("candidate denied"), { code: "EACCES" });
    return fs.statSync(target);
  } };
  throwsInvalid(() => resolve(f, { fileSystem: blocked }), /candidate denied/);
});

test("add uses a ten-minute timeout with an injectable override; readers keep thirty seconds", (t) => {
  const f = makeGitFixture(t);
  for (const timeout of [undefined, 1234]) {
    const run = (args, opts) => {
      if (args[0] === "worktree" && args[1] === "add") {
        assert.equal(opts.timeout, timeout ?? WORKTREE_ADD_TIMEOUT_MS);
        assert.equal(WORKTREE_ADD_TIMEOUT_MS, 600_000);
        return { ok: true };
      }
      assert.equal(opts.timeout, undefined);
      return git(args, { env: f.env, runnerHome: f.runnerHome, ...opts });
    };
    assert.equal(addWorktree({ ...f.options, git: run, addTimeoutMs: timeout }).ok, true);
  }
  let observed;
  git(["rev-parse", "HEAD"], { repo: f.repo, env: f.env, runnerHome: f.runnerHome,
    spawn: (command, args, opts) => { observed = opts.timeout; return { status: 0 }; } });
  assert.equal(observed, 30_000);
});

test("mount detection starts at the deepest existing ancestor and follows the route's device boundary", () => {
  const mount = path.resolve("volume-mount");
  const target = path.join(mount, "existing", "future");
  const fileSystem = routeFs(mount);
  const stat = fileSystem.statSync;
  fileSystem.statSync = (dir) => {
    if (dir === target) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return stat(dir);
  };
  assert.equal(findMountPath(target, fileSystem), mount);
  assert.equal(findMountPath(target, driveFs), driveRoot);
});

test("failed main-checkout discovery preserves git errors instead of misreporting a layout", (t) => {
  const f = makeGitFixture(t);
  const run = (args, opts) => args[0] === "rev-parse" ? failed({ stderr: "fatal: dubious ownership; configure safe.directory" })
    : git(args, { env: f.env, runnerHome: f.runnerHome, ...opts });
  assert.throws(() => resolve(f, { git: run }), (error) => error.code !== "unsupported_layout" && /safe.directory/.test(error.message));
  const noTop = (args, opts) => args[0] === "rev-parse" ? { ok: true, stdout: "" }
    : git(args, { env: f.env, runnerHome: f.runnerHome, ...opts });
  assert.throws(() => resolve(f, { git: noTop }), (error) => error.code === "unsupported_layout");
});

test("inherited Git locales cannot change discovery and config decisions", (t) => {
  const f = makeGitFixture(t);
  const env = { ...f.env, LANG: "fr_FR.UTF-8", LC_ALL: "fr_FR.UTF-8", LANGUAGE: "fr" };
  assert.equal(gitEnv(env).LC_ALL, "C");
  assert.equal(gitEnv(env).LANGUAGE, "");
  assert.equal(resolve(f, { env }).source, "sibling");
  const wt = mkdir(path.join(path.dirname(f.repo), "wt"));
  assert.equal(resolve(f, { env }).root, wt);
});

test("containment discovery crosses filesystem boundaries only for those reader calls", (t) => {
  const f = makeGitFixture(t);
  const wt = mkdir(path.join(path.dirname(f.repo), "wt"));
  let calls = 0;
  const run = (args, opts) => {
    if (args[0] === "rev-parse" && opts.discoveryAcrossFileSystem) {
      calls += 1;
      assert.equal(opts.env.GIT_DISCOVERY_ACROSS_FILESYSTEM, "1");
      git(args, { ...opts, runnerHome: f.runnerHome, spawn: (command, gitArgs, spawnOptions) => {
        assert.equal(spawnOptions.env.GIT_DISCOVERY_ACROSS_FILESYSTEM, "1");
        return { status: 0 };
      } });
    }
    return git(args, { env: f.env, runnerHome: f.runnerHome, ...opts });
  };
  assert.equal(resolve(f, { git: run }).root, wt);
  assert.equal(calls, 2, "auto filtering and the final root hint both use cross-filesystem discovery");
  assert.equal(gitEnv({ GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" }).GIT_DISCOVERY_ACROSS_FILESYSTEM, undefined);
});

test("auto uses the canonical home boundary when home is a junction or symlink", (t) => {
  const f = makeGitFixture(t);
  const family = path.dirname(f.repo);
  mkdir(path.join(family, "wt"));
  const homeLink = path.join(f.temp, "home-link");
  fs.symlinkSync(family, homeLink, process.platform === "win32" ? "junction" : "dir");
  assert.equal(resolve(f, { home: homeLink }).source, "sibling");
});

test("PowerShell config hints use forward slashes, safe quoting and a child of a drive root", () => {
  for (const [accessPath, expected] of [["D:\\My Path\\", "D:/My Path"], ["D:\\", "D:/wt"]]) {
    const result = volumeInfo("target", { platform: "win32", fileSystem: driveFs, repo: "C:\\Main Path\\repo\\",
      probe: () => ({ volume: ntfs, refs: [{ accessPath }] }) });
    assert.ok(result.hints[0].includes(`git -C "C:/Main Path/repo" config ultracodex.worktreeRoot "${expected}"`));
    assert.ok(!result.hints[0].includes('\\"'));
  }
  const result = volumeInfo("target", { platform: "win32", fileSystem: driveFs, repo: 'C:\\a$`"b',
    probe: () => ({ volume: ntfs, refs: [{ accessPath: 'D:\\a$`"b\\' }] }) });
  assert.ok(result.hints[0].includes('"D:/a`$```"b"'));
});

test("git lookup skips empty, dot and relative PATH entries containing fake git", (t) => {
  const f = makeGitFixture(t);
  const relative = mkdir(path.join(f.runnerHome, "relative"));
  const trusted = mkdir(path.join(f.temp, "bin"));
  const name = process.platform === "win32" ? "git.exe" : "git";
  for (const dir of [f.runnerHome, relative, trusted]) fs.writeFileSync(path.join(dir, name), "fake git", { mode: 0o755 });
  const env = { ...f.env, PATH: ["", ".", "relative", trusted].join(path.delimiter) };
  // Windows environment keys are case-insensitive; remove a possible inherited Path.
  for (const key of Object.keys(env)) if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
  const resolved = resolveGitExecutable({ env });
  assert.equal(resolved, path.join(trusted, name));
  let command;
  git(["rev-parse", "HEAD"], { repo: f.repo, env, runnerHome: f.runnerHome, resolveExecutable: resolveGitExecutable,
    spawn: (executable) => { command = executable; return { status: 0 }; } });
  assert.equal(command, resolved);
  assert.throws(() => resolveGitExecutable({ env: { PATH: ["", ".", "relative"].join(path.delimiter) } }),
    (error) => error.kind === "git_not_found");
});

test("Windows git lookup skips batch shims and uses exe/com in PATHEXT order", () => {
  const searched = [];
  const files = new Set(["C:\\shims\\git.cmd", "C:\\shims\\git.bat", "D:\\bin\\git.exe", "D:\\bin\\git.com"]);
  const fileSystem = { statSync: (candidate) => {
    searched.push(candidate);
    return { isFile: () => files.has(candidate) };
  } };
  const env = { Path: ";.;relative;C:relative;\\root-relative;C:\\shims;D:\\bin", PATHEXT: ".CMD;.BAT;.EXE;.COM" };
  assert.equal(resolveGitExecutable({ env, platform: "win32", fileSystem }), "D:\\bin\\git.exe");
  assert.deepEqual(searched, ["C:\\shims\\git.exe", "C:\\shims\\git.com", "D:\\bin\\git.exe"]);
  assert.equal(resolveGitExecutable({ env: { ...env, PATHEXT: ".COM;.EXE" }, platform: "win32", fileSystem }), "D:\\bin\\git.com");
  assert.throws(() => resolveGitExecutable({ env: { ...env, Path: "C:\\shims" }, platform: "win32", fileSystem }),
    (error) => error.kind === "git_not_found");
  assert.throws(() => resolveGitExecutable({ env: { ...env, PATHEXT: ".CMD;.BAT" }, platform: "win32", fileSystem }),
    (error) => error.kind === "git_not_found");
});

test("sibling fallback inside another checkout warns without refusing", (t) => {
  const f = makeGitFixture(t);
  f.git(["init", "--template="], path.dirname(f.repo));
  const result = resolve(f);
  assert.equal(result.source, "sibling");
  assert.match(result.hints.join("\n"), /inside another git working tree/);
});

test("add refuses a destination contained in a newly listed checkout before invoking add", (t) => {
  const f = makeGitFixture(t);
  const root = mkdir(path.join(f.temp, "destination-root"));
  let lists = 0;
  let added = false;
  const run = (args, opts) => {
    if (args[0] === "worktree" && args[1] === "add") { added = true; return { ok: true }; }
    const out = git(args, { env: f.env, runnerHome: f.runnerHome, ...opts });
    if (args[0] === "worktree" && args[1] === "list" && ++lists === 2) {
      return { ...out, stdout: `${out.stdout}worktree ${root}\0HEAD abc\0branch refs/heads/new\0\0` };
    }
    return out;
  };
  throwsInvalid(() => addWorktree({ ...f.options, root, git: run }), /outside every checkout/);
  assert.equal(lists, 2);
  assert.equal(added, false);
});

test("add refuses an occupied destination discovered during the final recheck", (t) => {
  const f = makeGitFixture(t);
  const target = resolve(f).path;
  let lists = 0;
  let added = false;
  const run = (args, opts) => {
    if (args[0] === "worktree" && args[1] === "add") { added = true; return { ok: true }; }
    if (args[0] === "worktree" && args[1] === "list" && ++lists === 2) mkdir(target);
    return git(args, { env: f.env, runnerHome: f.runnerHome, ...opts });
  };
  assert.throws(() => addWorktree({ ...f.options, git: run }), (error) => error.code === "worktree_exists");
  assert.equal(added, false);
});

test("GIT_CONFIG cannot hide local worktree configuration; normal config sources are preserved", (t) => {
  const f = makeGitFixture(t);
  mkdir(path.join(path.dirname(f.repo), "wt"));
  f.git(["config", "ultracodex.worktreeAuto", "false"]);
  const empty = path.join(f.temp, "empty.gitconfig");
  fs.writeFileSync(empty, "");
  const env = { ...f.env, GIT_CONFIG: empty };
  assert.equal(resolve(f, { env }).source, "sibling");
  assert.equal(gitEnv(env).GIT_CONFIG, undefined);
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
    assert.equal(gitEnv(env)[key], env[key]);
  }
});
