// Helpers for the session tests: an isolated home whose sessions are closed when the test ends
// (a supervisor outlives its test otherwise), the fake app-server's logs, and thin wrappers around
// the session commands.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { eventually, fastEnv, makeHome, runCli, writeRequest } from "./helpers.mjs";

export const jsonLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
export const runDir = (home, runId) => path.join(home, "runs", runId);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const readState = (home, runId) => readJson(path.join(runDir(home, runId), "state.json"));
export const sessionEvents = (home, runId) => jsonLines(path.join(runDir(home, runId), "events.jsonl"));
export const hasResult = (home, runId) => fs.existsSync(path.join(runDir(home, runId), "result.json"));

// A session home: the fake app-server logs every spawn and request to `log`. Sessions still alive
// when the test ends are closed before the home is deleted (the hook is registered first, so it
// runs first).
export function sessionHome(t, extra = {}) {
  let homeRef = null;
  let envRef = null;
  t.after(async () => {
    if (!homeRef) return;
    const runs = path.join(homeRef, "runs");
    for (const name of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
      const dir = path.join(runs, name);
      if (!fs.existsSync(path.join(dir, "state.json")) || fs.existsSync(path.join(dir, "result.json"))) continue;
      try {
        await runCli(["close", name, "--force"], { env: envRef, timeoutMs: 40_000 });
      } catch {
        // a deliberately broken session: the home removal below reports what is left
      }
    }
  });
  const home = makeHome(t);
  homeRef = home;
  const log = path.join(home, "session.jsonl");
  const env = fastEnv(home, {
    FAKE_CODEX_SESSION_LOG: log,
    FAKE_CODEX_STATE: path.join(home, "fake-state"),
    ULTRACODEX_ACK_WAIT_MS: "20000",
    ULTRACODEX_CLOSE_WAIT_MS: "20000",
    ULTRACODEX_LOCK_WAIT_MS: "3000",
    ...extra,
  });
  envRef = env;
  return { home, env, log, calls: () => jsonLines(log) };
}

export async function startSession(env, home, request) {
  const started = await runCli(["start", "--request", writeRequest(home, { session: true, ...request })], { env });
  assert.equal(started.code, 3, started.stdout);
  assert.equal(started.json.session, true);
  return started.json.runId;
}

export const wait = (env, runId, maxWait = 30) => runCli(["wait", runId, "--max-wait", String(maxWait)], { env, timeoutMs: (maxWait + 30) * 1000 });
export const send = (env, runId, message, ...rest) => runCli(["send", runId, "--message", message, ...rest], { env });
export const eventsOf = async (env, runId, ...rest) => (await runCli(["events", runId, ...rest], { env })).stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

// the requests the fake app-server received, in order, optionally of one method
export const requests = (calls, method) => calls.filter((entry) => entry.kind === "request" && (!method || entry.method === method));
export const spawns = (calls) => calls.filter((entry) => entry.kind === "spawn");

// waits until the run's state.json says `state`
export const untilState = (home, runId, state, timeoutMs = 30_000) =>
  eventually(() => {
    try {
      return readState(home, runId).state === state;
    } catch {
      return false;
    }
  }, { timeoutMs, stepMs: 50 });

export const untilEvent = (home, runId, predicate, timeoutMs = 30_000) =>
  eventually(() => sessionEvents(home, runId).some(predicate), { timeoutMs, stepMs: 50 });

// `wait` until the session has a turn to show: a pending question returns at once, so keep
// asking (after a short pause) until the question is answered, automatically or otherwise.
export async function settle(env, runId, { rounds = 60 } = {}) {
  let out = null;
  for (let round = 0; round < rounds; round += 1) {
    out = await wait(env, runId, 5);
    if (!(out.code === 3 && out.json?.waitingForAnswer)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return out;
}

// The app-servers that carried a thread — the session's own, as opposed to the short-lived ones the
// runner starts for a rate-limit probe or for archiving (those never see thread/start or resume).
export const serverSpawns = (calls) =>
  spawns(calls).filter((entry) => calls.some((call) => call.kind === "request" && call.pid === entry.pid && ["thread/start", "thread/resume"].includes(call.method)));
