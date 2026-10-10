// Helpers for the steerable-node tests (0.6.0): a steerable job is a one-shot job that the runner drives as
// ONE turn of a session on a private app-server, so it can be steered while it runs. Same fake Codex, same
// session homes as the session tests; these only add what is particular to jobs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { directDigest, ensureKey, normalizeText, resultMac } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { runCli, writeRequest } from "./helpers.mjs";
import { sessionHome, wait } from "./helpers-session.mjs";

export { sessionHome, wait };

// start a steerable job; resolves its run id (the start line already says it is steerable)
export async function startNode(env, home, request) {
  const started = await runCli(["start", "--request", writeRequest(home, { steerable: true, ...request })], { env });
  assert.equal(started.code, 3, started.stdout);
  assert.equal(started.json.steerable, true, started.stdout);
  assert.equal(started.json.session, undefined, "a steerable job is not a session as far as its caller can tell");
  return started.json.runId;
}

// the same request as a plain one-shot job (codex exec), run to its end
export async function runExec(env, home, request) {
  const started = await runCli(["start", "--request", writeRequest(home, request)], { env });
  assert.equal(started.code, 3, started.stdout);
  return (await wait(env, started.json.runId)).json;
}

// the signature a direct run's result carries: kind "text" for a plain answer, "result" for a schema's
export function macOf(home, envelope, task) {
  const key = ensureKey({ ULTRACODEX_HOME: home });
  const text = envelope.result !== undefined;
  return resultMac(key, envelope.runId, directDigest(normalizeText(task)), text ? "result" : "text", text ? JSON.stringify(envelope.result) : envelope.text);
}

// ── limits and account changes (same recipes as the session tests) ──

const SECRET_ACCOUNT = "ACCOUNT-ID-MUST-NOT-LEAK";

export function saveAccount(home, account) {
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account } }));
}

// one scripted answer of the fake's account/rateLimits/read; resetsInSec is relative to the script's first probe
export function limitAnswer({ allowed, usedPercent = 100, resetsInSec = 3600 }) {
  const codex = { limitId: "codex", primary: { usedPercent, windowDurationMins: 300, resetsAt: resetsInSec }, secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetsInSec + 86_400 } };
  return { result: { ordinaryUsageAllowed: allowed, accountId: SECRET_ACCOUNT, rateLimits: codex, rateLimitsByLimitId: { codex } } };
}

export function limitHome(t, answers, extra = {}) {
  const ctx = sessionHome(t, { ULTRACODEX_LIMIT_WAIT_SEC: "120", ULTRACODEX_LIMIT_PROBE_MS: "60000", ...extra });
  saveAccount(ctx.home, "account-a");
  const script = path.join(ctx.home, "rate-limits.json");
  fs.writeFileSync(script, JSON.stringify(answers));
  ctx.env.FAKE_CODEX_RATE_LIMITS = script;
  ctx.env.FAKE_CODEX_PROBE_LOG = path.join(ctx.home, "probe.jsonl");
  return { ...ctx, work: path.join(ctx.home, "work.txt") };
}

// a home whose managed account is the identity file; switchTo() is the owner switching
export function followHome(t, extra = {}) {
  const ctx = sessionHome(t, { ULTRACODEX_ACCOUNT_CHECK_MS: "100", FAKE_CODEX_OUTPUT: "continued", ...extra });
  const identity = path.join(ctx.home, "identity.txt");
  fs.writeFileSync(identity, "account-a");
  ctx.env.ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE = identity;
  return { ...ctx, identity, switchTo: (name) => fs.writeFileSync(identity, name) };
}

export const turnTexts = (calls) => calls.filter((entry) => entry.kind === "request" && entry.method === "turn/start").map((entry) => entry.params.input[0].text);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
