// Shared helpers for the runner tests: an isolated ULTRACODEX_HOME per test, the
// fake Codex CLI on ULTRACODEX_CODEX_PATH, and fast timing knobs.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNNER = path.join(ROOT, "plugins", "ultracodex", "scripts", "codex-node.mjs");
export const FAKE_CODEX = path.join(ROOT, "tests", "fixtures", "fake-codex.mjs");

export function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-test-"));
  // a supervisor (or its job helper) may still be exiting when a test ends: retry briefly
  t.after(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (error) {
      const left = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          left.push(path.relative(home, full));
          if (entry.isDirectory()) walk(full);
        }
      };
      try {
        walk(home);
      } catch {
        // partially gone
      }
      error.message += ` — still present: ${left.join(", ") || "(only the directory itself)"}`;
      throw error;
    }
  });
  return home;
}

export function fastEnv(home, extra = {}) {
  return {
    ...process.env,
    ULTRACODEX_HOME: home,
    ULTRACODEX_CODEX_PATH: FAKE_CODEX,
    ULTRACODEX_POLL_MS: "100",
    ULTRACODEX_ALIVE_MS: "200",
    ULTRACODEX_LOST_AFTER_MS: "20000",
    ULTRACODEX_BACKOFF_MS: "100",
    ULTRACODEX_SLOT_POLL_MS: "100",
    ULTRACODEX_SLOT_STALE_MS: "20000",
    ULTRACODEX_KILL_GRACE_MS: "300",
    ULTRACODEX_MIN_ORPHAN_SEC: "1",
    ULTRACODEX_MIN_TIMEOUT_SEC: "1",
    ...extra,
  };
}

// Runs the runner CLI; resolves { code, stdout, stderr, json } where json is the
// last JSON line printed.
export function runCli(args, { env, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runner timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      for (let index = lines.length - 1; index >= 0 && json === null; index -= 1) {
        try {
          json = JSON.parse(lines[index]);
        } catch {
          // keep scanning
        }
      }
      if (json === null) {
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
      }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(input ?? "");
  });
}

export function writeRequest(home, request) {
  const file = path.join(home, `request-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(request));
  return file;
}

// start + wait until a terminal envelope (or the loop limit) is reached.
export async function startAndWait(env, request, { home, maxRounds = 60 } = {}) {
  const started = await runCli(["start", "--request", writeRequest(home, request)], { env });
  if (!started.json?.runId) return { started, final: started.json };
  let final = null;
  for (let round = 0; round < maxRounds; round += 1) {
    const waited = await runCli(["wait", started.json.runId, "--max-wait", "5"], { env });
    final = waited.json;
    if (final && final.state !== "running" && final.state !== "queued" && final.state !== "backoff") break;
  }
  return { started, final };
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function eventually(check, { timeoutMs = 10_000, stepMs = 100 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
