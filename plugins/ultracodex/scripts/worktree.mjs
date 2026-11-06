import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RUNNER_VERSION, RequestError, UsageError, print, rejection, runPowerShell, ucxHome } from "./codex-node.mjs";

export const GIT_SELECTION_ENV = Object.freeze([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
]);

export const GIT_READ_TIMEOUT_MS = 30_000;
export const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;

export function gitEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (GIT_SELECTION_ENV.includes(key.toUpperCase())) delete clean[key];
  }
  clean.GIT_TERMINAL_PROMPT = "0";
  clean.LC_ALL = "C";
  clean.LANGUAGE = "";
  return clean;
}

export function resolveGitExecutable({ env = process.env, platform = process.platform, fileSystem = fs } = {}) {
  const value = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const paths = platform === "win32" ? path.win32 : path.posix;
  const extensions = platform === "win32"
    ? (value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.(?:exe|com)$/i.test(ext)) : [""];
  for (let dir of (value("PATH") ?? "").split(platform === "win32" ? ";" : ":")) {
    if (dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1);
    if (!paths.isAbsolute(dir) || (platform === "win32" && paths.parse(dir).root === "\\")) continue;
    for (const ext of extensions) {
      const candidate = paths.join(dir, `git${ext.toLowerCase()}`);
      try {
        if (!fileSystem.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fileSystem.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
      }
    }
  }
  throw new RequestError("git_not_found", "git was not found in an absolute PATH directory");
}

let gitExecutable;
function cachedGitExecutable(options) {
  return gitExecutable ??= resolveGitExecutable(options);
}

// Git never starts in a checkout: on Windows executable lookup also searches cwd.
export function git(args, { repo, env = process.env, runnerHome = ucxHome(env), timeout = GIT_READ_TIMEOUT_MS,
  discoveryAcrossFileSystem = false, spawn = spawnSync, resolveExecutable = cachedGitExecutable } = {}) {
  if (!path.isAbsolute(repo ?? "")) throw new RequestError("invalid_request", "git requires an absolute repository path");
  const executable = resolveExecutable({ env });
  const clean = gitEnv(env);
  if (discoveryAcrossFileSystem) clean.GIT_DISCOVERY_ACROSS_FILESYSTEM = "1";
  fs.mkdirSync(runnerHome, { recursive: true });
  const out = spawn(executable, ["-c", "safe.bareRepository=explicit", "-C", repo, ...args], {
    cwd: path.resolve(runnerHome), env: clean, shell: false, windowsHide: true,
    encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = out.error?.code === "ETIMEDOUT";
  return { ok: !out.error && !out.signal && out.status === 0, status: out.status ?? null,
    stdout: out.stdout ?? "", stderr: out.stderr ?? "", error: out.error ?? null, timedOut };
}

function invalid(message, code) {
  const error = new RequestError("invalid_request", message);
  if (code) error.code = code;
  throw error;
}

function requireGit(out, action) {
  if (!out.ok) invalid(`${action}: ${out.stderr.trim() || out.error?.message || (out.timedOut ? "git timed out" : `git exited ${out.status}`)}`);
  return out.stdout;
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

function inside(child, parent) {
  const rel = path.relative(pathKey(parent), pathKey(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// An existing link that cannot be resolved is not a missing directory. Neither is
// an inaccessible ancestor or a file in the middle of a proposed directory path.
export function strictCanonicalPath(target, fileSystem = fs) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    let stat;
    try {
      stat = fileSystem.lstatSync(current);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (samePath(parent, current)) throw error;
      tail.unshift(path.basename(current));
      current = parent;
      continue;
    }
    const real = fileSystem.realpathSync.native(current);
    if (tail.length && !fileSystem.statSync(current).isDirectory()) {
      throw Object.assign(new Error(`not a directory: ${current}`), { code: "ENOTDIR" });
    }
    // lstat above deliberately precedes realpath, even for dangling links.
    if (!stat) invalid(`cannot inspect ${current}`);
    return path.resolve(real, ...tail);
  }
}

export function parseWorktrees(text) {
  const entries = [];
  let entry = null;
  for (const field of text.split("\0")) {
    if (field.startsWith("worktree ")) {
      entry = { path: field.slice(9), bare: false };
      entries.push(entry);
    } else if (field === "bare" && entry) entry.bare = true;
  }
  return entries;
}

function worktrees(runGit, repo) {
  const out = runGit(["worktree", "list", "--porcelain", "-z"], { repo });
  if (!out.ok && !out.error && !out.timedOut && out.status === 128 && /cannot use bare repository.*safe\.bareRepository/s.test(out.stderr)) {
    invalid("bare-backed repositories are not supported yet", "unsupported_layout");
  }
  const entries = parseWorktrees(requireGit(out, "cannot list worktrees"));
  if (!entries.length || entries.some((entry) => !path.isAbsolute(entry.path))) invalid("git returned an invalid worktree list");
  return entries;
}

function configValue(runGit, repo, key) {
  const out = runGit(["config", "--get", key], { repo });
  if (out.ok) return out.stdout.trim();
  // --get uses exit 1 for absence. Confirm absence with a successful reader,
  // rather than treating any failed/empty process as a missing setting.
  if (out.status === 1 && !out.error && !out.timedOut && !out.stderr && !out.stdout) {
    const list = requireGit(runGit(["config", "--null", "--list"], { repo }), "cannot read git config");
    if (!list.split("\0").some((item) => item.split("\n", 1)[0].toLowerCase() === key.toLowerCase())) return null;
  }
  requireGit(out, `cannot read ${key}`);
}

function existingAncestor(target, fileSystem) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (!fileSystem.statSync(current).isDirectory()) invalid(`not a directory: ${current}`);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (samePath(parent, current)) throw error;
      current = parent;
    }
  }
}

function containingRepo(runGit, repo, env) {
  const out = runGit(["rev-parse", "--show-toplevel"], {
    repo, env: { ...gitEnv(env), GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" }, discoveryAcrossFileSystem: true,
  });
  if (out.ok) return out.stdout.trim();
  // This is Git's expected negative discovery result, not a transport failure.
  if (out.status === 128 && !out.error && !out.timedOut && /not a git repository/i.test(out.stderr)) return null;
  requireGit(out, `cannot check whether ${repo} is in a git working tree`);
}

function expandLocation(value, repoTop, home) {
  const expanded = /^~(?:[\\/]|$)/.test(value) ? path.join(home, value.slice(1)) : value;
  return path.resolve(repoTop, expanded);
}

function checkDestination(location, entries, { fileSystem = fs, runnerHome }) {
  const lexicalPath = path.resolve(location.path);
  const lexicalRoot = path.resolve(location.root);
  const canonicalPath = strictCanonicalPath(lexicalPath, fileSystem);
  const canonicalRoot = strictCanonicalPath(lexicalRoot, fileSystem);
  const canonicalHome = strictCanonicalPath(runnerHome, fileSystem);
  if (inside(canonicalPath, canonicalHome) || inside(canonicalHome, canonicalPath)) invalid(`worktree path must not overlap the runner home: ${runnerHome}`);
  try {
    fileSystem.lstatSync(lexicalPath);
    invalid(`worktree path already exists: ${lexicalPath}`, "worktree_exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    const checkouts = [path.resolve(entry.path), strictCanonicalPath(entry.path, fileSystem)];
    if ([lexicalPath, lexicalRoot, canonicalPath, canonicalRoot].some((target) => checkouts.some((checkout) => inside(target, checkout)))) {
      invalid(`worktree path and root must be outside every checkout of this repository: ${entry.path}`);
    }
  }
  return { canonicalPath, canonicalRoot };
}

export function validateWorktreeOptions({ repo, slug, root, dir }) {
  if (typeof repo !== "string" || !repo) throw new UsageError("worktree requires --repo <path>");
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(slug) || slug.includes("..") || /(?:\.lock|\.)$/.test(slug)) {
    throw new UsageError("--slug must be 1–63 lowercase letters, digits, dots, underscores or hyphens; no '..', trailing '.' or '.lock'");
  }
  if (root !== undefined && dir !== undefined) throw new UsageError("--root and --dir are mutually exclusive");
  for (const [key, value] of [["root", root], ["dir", dir]]) {
    if (value !== undefined && (typeof value !== "string" || !value)) throw new UsageError(`--${key} requires a path`);
  }
}

export function resolveWorktreeLocation(options) {
  validateWorktreeOptions(options);
  const { repo, slug, dir, root, env = process.env, home = os.homedir(), fileSystem = fs, runnerHome = ucxHome(env) } = options;
  const runGit = options.git ?? ((args, opts) => git(args, { env, runnerHome, ...opts }));
  try {
    const entries = worktrees(runGit, path.resolve(repo));
    if (entries[0].bare) invalid("bare-backed repositories are not supported yet", "unsupported_layout");
    const repoTop = path.resolve(entries[0].path);
    const repoName = path.basename(repoTop);
    // Separate git directories and submodules can list their metadata directory
    // as the first entry. Verify it really is a checkout before using it as one.
    const top = runGit(["rev-parse", "--show-toplevel"], { repo: repoTop });
    requireGit(top, "cannot inspect main checkout");
    if (!top.stdout.trim() || !samePath(strictCanonicalPath(top.stdout.trim(), fileSystem), strictCanonicalPath(repoTop, fileSystem))) {
      invalid("the first worktree entry is not a supported main checkout (bare-backed repositories, separate git directories and submodules are not supported yet)", "unsupported_layout");
    }
    let source;
    let chosenRoot;
    let chosenPath;
    if (dir !== undefined) {
      source = "dir";
      chosenPath = path.resolve(dir);
      chosenRoot = path.dirname(chosenPath);
    } else if (root !== undefined) {
      source = "root";
      chosenRoot = path.resolve(root);
    } else {
      const configured = configValue(runGit, repoTop, "ultracodex.worktreeRoot");
      if (configured !== null) {
        if (!configured) invalid("ultracodex.worktreeRoot must not be empty");
        source = "gitConfig";
        chosenRoot = expandLocation(configured, repoTop, home);
      } else if (env.ULTRACODEX_WORKTREE_ROOT) {
        source = "env";
        chosenRoot = expandLocation(env.ULTRACODEX_WORKTREE_ROOT, repoTop, home);
      } else if (env.ULTRACODEX_WORKTREE_AUTO !== "0" && configValue(runGit, repoTop, "ultracodex.worktreeAuto")?.toLowerCase() !== "false") {
        const canonicalUserHome = strictCanonicalPath(home, fileSystem);
        let level = path.dirname(repoTop);
        for (let depth = 0; depth < 2 && !chosenRoot; depth += 1, level = path.dirname(level)) {
          const canonicalLevel = strictCanonicalPath(level, fileSystem);
          if (samePath(level, path.dirname(level)) || samePath(canonicalLevel, path.parse(canonicalLevel).root) || inside(canonicalUserHome, canonicalLevel)) continue;
          for (const name of ["wt", ".worktrees"]) {
            const candidate = path.join(level, name);
            try {
              if (!fileSystem.statSync(candidate).isDirectory()) continue;
            } catch (error) {
              if (error.code === "ENOENT") continue;
              throw error;
            }
            strictCanonicalPath(candidate, fileSystem);
            if (containingRepo(runGit, candidate, env)) continue;
            source = "auto";
            chosenRoot = candidate;
            break;
          }
        }
      }
    }
    if (!chosenRoot) {
      source = "sibling";
      chosenRoot = path.dirname(repoTop);
    }
    chosenPath ??= path.join(chosenRoot, `${repoName}.codex-${slug}`);
    const { canonicalRoot } = checkDestination({ path: chosenPath, root: chosenRoot }, entries, { fileSystem, runnerHome });
    const hints = [];
    const other = containingRepo(runGit, existingAncestor(chosenRoot, fileSystem), env);
    if (other) hints.push(`The worktree root is inside another git working tree (${other}); tools that walk up may read its configuration.`);
    if (!samePath(chosenRoot, canonicalRoot)) hints.push(`The root resolves to ${canonicalRoot}; Claude Code session history and permission rules may use that real path.`);
    return { path: chosenPath, root: chosenRoot, source, repoTop, repoName, hints };
  } catch (error) {
    if (error instanceof RequestError || error instanceof UsageError) throw error;
    invalid(`cannot safely resolve worktree location: ${error.message}`);
  }
}

const VOLUME_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$target = $env:ULTRACODEX_VOLUME_PATH
while (-not (Test-Path -LiteralPath $target)) {
  $parent = [System.IO.Path]::GetDirectoryName($target.TrimEnd('\'))
  if (-not $parent -or $parent -eq $target) { throw 'No existing ancestor' }
  $target = $parent
}
$volume = Get-Volume -FilePath $target | Select-Object -First 1
if (-not $volume) { throw 'No volume' }
$volumes = @(Get-CimInstance Win32_Volume)
$match = $volumes | Where-Object { $_.DeviceID -eq $volume.Path -or $_.DeviceID -eq $volume.UniqueId } | Select-Object -First 1
$access = if ($match) { $match.Name } elseif ($volume.DriveLetter) { "$($volume.DriveLetter):\" } else { $null }
@{ volume = @{ fileSystem = $volume.FileSystem; label = $volume.FileSystemLabel; driveLetter = [string]$volume.DriveLetter; accessPath = $access }; refs = @($volumes | Where-Object { $_.FileSystem -eq 'ReFS' } | ForEach-Object { @{ accessPath = $_.Name; label = $_.Label } }) } | ConvertTo-Json -Depth 4 -Compress
`;

export function probeVolume(target, { env = process.env, run = runPowerShell } = {}) {
  try {
    const out = run(VOLUME_SCRIPT, { timeout: 10_000, env: { ...env, ULTRACODEX_VOLUME_PATH: target } });
    if (out.error || out.signal || out.status !== 0) return null;
    const result = JSON.parse(out.stdout.trim());
    if (typeof result.volume?.fileSystem !== "string" || !Array.isArray(result.refs)) return null;
    return result;
  } catch {
    return null;
  }
}

export function findMountPath(target, fileSystem = fs) {
  let current = existingAncestor(target, fileSystem);
  let stat = fileSystem.statSync(current);
  for (;;) {
    const parent = path.dirname(current);
    if (samePath(parent, current)) return current;
    const parentStat = fileSystem.statSync(parent);
    if (stat.dev !== parentStat.dev) return current;
    current = parent;
    stat = parentStat;
  }
}

function powerShellQuotedPath(value) {
  const forward = value.replace(/\\/g, "/");
  const normalized = /^(?:[a-z]:)?\/$/i.test(forward) ? forward : forward.replace(/\/+$/, "");
  return normalized.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"');
}

export function volumeInfo(target, { platform = process.platform, noVolumeCheck = false, probe = probeVolume,
  env = process.env, fileSystem = fs, repo } = {}) {
  if (platform !== "win32" || noVolumeCheck) return { volume: null, hints: [] };
  let result;
  try { result = probe(target, { env }); } catch { result = null; }
  if (!result?.volume) return { volume: null, hints: [] };
  const { refs = [] } = result;
  let mountPath = null;
  try { mountPath = findMountPath(target, fileSystem); } catch { /* volume information is advisory */ }
  const volume = { ...result.volume, mountPath };
  const hints = [];
  if (volume.fileSystem?.toLowerCase() !== "refs" && refs.length) {
    const paths = refs.map((item) => item.accessPath).filter(Boolean);
    if (paths.length && repo) {
      const root = /^[a-z]:[\\/]?$/i.test(paths[0]) ? `${paths[0].slice(0, 2)}/wt` : paths[0].replace(/[\\/]+$/, "");
      hints.push(`This location uses ${volume.fileSystem}. ReFS volumes: ${paths.join(", ")}. In PowerShell, set a root with: git -C "${powerShellQuotedPath(repo)}" config ultracodex.worktreeRoot "${powerShellQuotedPath(root)}"`);
    }
  }
  if (mountPath && !samePath(mountPath, path.parse(mountPath).root)) {
    hints.push("Observed with Docker Desktop on Windows: bind mounts from a folder-mounted volume fail. If this task's Docker tests bind-mount files from the worktree, put the worktree on a drive-letter path for this task (`--dir` / `--root`).");
  }
  return { volume, hints };
}

export function worktreePath(options) {
  const location = resolveWorktreeLocation(options);
  const checked = volumeInfo(location.path, { ...options, repo: location.repoTop });
  return { ok: true, path: location.path, source: location.source, root: location.root, repo: location.repoTop,
    volume: checked.volume, hints: [...location.hints, ...checked.hints] };
}

export function addWorktree(options) {
  const location = resolveWorktreeLocation(options);
  const { env = process.env, runnerHome = ucxHome(env), base = "HEAD", branch = `codex/${options.slug}`,
    addTimeoutMs = WORKTREE_ADD_TIMEOUT_MS } = options;
  const runGit = options.git ?? ((args, opts) => git(args, { env, runnerHome, ...opts }));
  const repo = location.repoTop;
  if (typeof base !== "string" || !base || base.startsWith("-")) invalid("--base must name a commit, branch or tag, not an option");
  const baseOid = requireGit(runGit(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { repo }), "invalid base").trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseOid)) invalid("git returned an invalid base object id");
  if (typeof branch !== "string" || !branch || branch.startsWith("-")) invalid("--branch must be a valid branch name and must not start with '-'");
  const validated = requireGit(runGit(["check-ref-format", "--branch", branch], { repo }), "invalid branch").trim();
  if (validated !== branch) invalid("--branch must be a literal branch name");
  const existing = runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { repo });
  if (existing.ok) invalid(`branch already exists: ${branch}`);
  // Confirm a failed rev-parse means absence, using a successful listing.
  const heads = requireGit(runGit(["for-each-ref", "--format=%(refname)", "refs/heads/"], { repo }), "cannot check existing branches");
  if (existing.error || existing.timedOut || existing.status !== 1 || heads.split(/\r?\n/).includes(`refs/heads/${branch}`)) {
    requireGit(existing, "cannot check existing branch");
  }
  checkDestination(location, worktrees(runGit, repo), { fileSystem: options.fileSystem ?? fs, runnerHome });
  const out = runGit(["worktree", "add", "-b", branch, location.path, baseOid], { repo, timeout: addTimeoutMs });
  let created = out.ok;
  let registrationError;
  if (!out.ok) {
    try {
      const canonical = strictCanonicalPath(location.path, options.fileSystem ?? fs);
      created = worktrees(runGit, repo).some((entry) => samePath(strictCanonicalPath(entry.path, options.fileSystem ?? fs), canonical));
    } catch (error) {
      // Unknown registration is reported explicitly; no cleanup is attempted.
      created = null;
      registrationError = error.message;
    }
  }
  const checked = volumeInfo(location.path, { ...options, repo });
  return { ok: out.ok, created, path: location.path, branch, base, baseOid, source: location.source, root: location.root, repo,
    volume: checked.volume, hints: [...location.hints, ...checked.hints],
    ...(!out.ok ? { stderr: out.stderr, error: { kind: "execution", message: out.stderr.trim() || out.error?.message || "git worktree add failed" },
      ...(registrationError ? { registrationError } : {}) } : {}) };
}

export function cmdWorktree(action, options) {
  if (!["path", "add"].includes(action) || options.positionals.length !== 1) throw new UsageError("worktree requires path or add");
  if (action === "path" && (options.base !== undefined || options.branch !== undefined)) throw new UsageError("--base and --branch require worktree add");
  try {
    const result = action === "add" ? addWorktree(options) : worktreePath(options);
    print({ ultracodex: 1, runnerVersion: RUNNER_VERSION, ...result }, options.pretty);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const result = rejection(error.kind ?? "invalid_request", error.message);
    if (error.code) result.error.code = error.code;
    print(result, options.pretty);
    return 1;
  }
}
