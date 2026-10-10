// Ownership: which Claude session started a run (state.json `owner`), `status --mine`, and the
// SessionStart hook that tells the session's Bash commands its id.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OWNER_RE, currentOwner } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { ownerLine } from "../plugins/ultracodex/scripts/session-start.mjs";
import { ROOT, announce, frame, runCli, signedHeader } from "./helpers.mjs";
import { readState, sessionHome, startSession } from "./helpers-session.mjs";

const HOOK = path.join(ROOT, "plugins", "ultracodex", "scripts", "session-start.mjs");

test("currentOwner: ULTRACODEX_OWNER first, then CLAUDE_CODE_SESSION_ID; invalid values are ignored", () => {
  assert.deepEqual(currentOwner({ ULTRACODEX_OWNER: "abc-1", CLAUDE_CODE_SESSION_ID: "other" }), { id: "abc-1", source: "ultracodex_owner" });
  assert.deepEqual(currentOwner({ CLAUDE_CODE_SESSION_ID: "5f3a:9.b_c" }), { id: "5f3a:9.b_c", source: "claude_code_session_id" });
  assert.deepEqual(currentOwner({ ULTRACODEX_OWNER: "has space", CLAUDE_CODE_SESSION_ID: "fallback" }), { id: "fallback", source: "claude_code_session_id" });
  assert.deepEqual(currentOwner({ ULTRACODEX_OWNER: "", CLAUDE_CODE_SESSION_ID: "x".repeat(129) }), null);
  assert.equal(currentOwner({}), null);
  assert.ok(OWNER_RE.test("x".repeat(128)) && !OWNER_RE.test("x".repeat(129)) && !OWNER_RE.test("a/b") && !OWNER_RE.test("*"));
});

test("start records the owner and where it came from; status shows it and --mine filters by it", async (t) => {
  const { home, env } = sessionHome(t);
  const withOwner = (extra) => ({ ...env, ...extra });
  const a = await startSession(withOwner({ ULTRACODEX_OWNER: "owner-a", CLAUDE_CODE_SESSION_ID: "ignored" }), home, { task: "a", tier: "light" });
  const b = await startSession(withOwner({ CLAUDE_CODE_SESSION_ID: "sess-b" }), home, { task: "b", tier: "light" });
  const c = await startSession(withOwner({ ULTRACODEX_OWNER: "not valid!" }), home, { task: "c", tier: "light" });
  assert.deepEqual([readState(home, a).owner, readState(home, a).ownerSource], ["owner-a", "ultracodex_owner"]);
  assert.deepEqual([readState(home, b).owner, readState(home, b).ownerSource], ["sess-b", "claude_code_session_id"]);
  assert.deepEqual([readState(home, c).owner, readState(home, c).ownerSource], [null, null], "an invalid value is no owner");

  const all = (await runCli(["status", "--all"], { env })).json.runs;
  assert.deepEqual([all.find((run) => run.runId === a).owner, all.find((run) => run.runId === b).owner], ["owner-a", "sess-b"]);
  assert.equal("owner" in all.find((run) => run.runId === c), false, "no owner, nothing shown");

  const mine = await runCli(["status", "--mine"], { env: withOwner({ ULTRACODEX_OWNER: "owner-a" }) });
  assert.deepEqual(mine.json.runs.map((run) => run.runId), [a]);
  assert.equal(mine.json.mine, true);
  const viaSessionId = await runCli(["status", "--mine"], { env: withOwner({ CLAUDE_CODE_SESSION_ID: "sess-b" }) });
  assert.deepEqual(viaSessionId.json.runs.map((run) => run.runId), [b]);
  const nobody = await runCli(["status", "--mine"], { env });
  assert.equal(nobody.code, 1);
  assert.equal(nobody.json.error.kind, "no_owner", "without an owner --mine refuses rather than list everything");
  assert.equal(nobody.json.runs, undefined);
});

test("the owner is metadata: not in the stored request, the digest or a signed header", async (t) => {
  const { home, env } = sessionHome(t);
  const one = await startSession({ ...env, ULTRACODEX_OWNER: "owner-1" }, home, { task: "same task", tier: "light" });
  const two = await startSession({ ...env, ULTRACODEX_OWNER: "owner-2" }, home, { task: "same task", tier: "light" });
  const request = (runId) => JSON.parse(fs.readFileSync(path.join(home, "runs", runId, "request.json"), "utf8"));
  assert.equal("owner" in request(one), false);
  assert.equal(request(one).requestDigest, request(two).requestDigest, "the digest does not depend on who started the run");

  // a relayed (signed) request starts as before under an owner env ...
  const task = "relayed task";
  const header = signedHeader(home, { tier: "light", kind: "ask", label: "relayed" }, null, task);
  await announce(env, header, null, task);
  const relayed = await runCli(["start", "--framed", "-"], { env: { ...env, ULTRACODEX_OWNER: "owner-3" }, input: frame(header, null, task) });
  assert.equal(relayed.code, 3, relayed.stdout);
  // ... and a header cannot name its owner, even a correctly signed one
  const naming = signedHeader(home, { tier: "light", kind: "ask", label: "naming", owner: "owner-evil" }, null, task, 2);
  await announce(env, naming, null, task);
  const refused = await runCli(["start", "--framed", "-"], { env, input: frame(naming, null, task) });
  assert.equal(refused.code, 1);
  assert.equal(refused.json.error.kind, "invalid_request");
  assert.match(refused.json.error.message, /unknown request fields: owner/);
});

test("the SessionStart hook appends exactly one export line and prints nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-hook-"));
  try {
    const envFile = path.join(dir, "env.sh");
    fs.writeFileSync(envFile, "export KEEP=1\n");
    const run = (input, env = { CLAUDE_ENV_FILE: envFile }) =>
      spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...process.env, CLAUDE_ENV_FILE: "", ...env } });
    const ok = run(JSON.stringify({ session_id: "5f3a-0b:9.c_d", hook_event_name: "SessionStart", source: "startup" }));
    assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, "", ""]);
    assert.equal(fs.readFileSync(envFile, "utf8"), "export KEEP=1\nexport ULTRACODEX_OWNER=5f3a-0b:9.c_d\n", "appended, not overwritten");

    // never fails the session, never writes anything it cannot vouch for
    const before = fs.readFileSync(envFile, "utf8");
    for (const input of ["", "not json", "[]", "null", JSON.stringify({}), JSON.stringify({ session_id: 7 }), JSON.stringify({ session_id: "bad id; rm -rf /" }), JSON.stringify({ session_id: "x".repeat(129) })]) {
      const bad = run(input);
      assert.deepEqual([bad.status, bad.stdout], [0, ""], `input ${input.slice(0, 20)}`);
    }
    assert.equal(fs.readFileSync(envFile, "utf8"), before);
    const noFile = run(JSON.stringify({ session_id: "abc" }), { CLAUDE_ENV_FILE: "" });
    assert.deepEqual([noFile.status, noFile.stdout], [0, ""]);
    const unwritable = run(JSON.stringify({ session_id: "abc" }), { CLAUDE_ENV_FILE: path.join(dir, "no-such-dir", "env.sh") });
    assert.deepEqual([unwritable.status, unwritable.stdout], [0, ""]);

    assert.equal(ownerLine(JSON.stringify({ session_id: "abc" }), {}), null);
    assert.equal(ownerLine(JSON.stringify({ session_id: "abc" }), { CLAUDE_ENV_FILE: "x" }), "export ULTRACODEX_OWNER=abc\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the exported line is what a Bash command sees: the owner of the next run it starts", () => {
  const sh = spawnSync("bash", ["-c", `${ownerLine(JSON.stringify({ session_id: "7c1d:2e.f_g-h" }), { CLAUDE_ENV_FILE: "x" })}printf %s "$ULTRACODEX_OWNER"`], { encoding: "utf8" });
  if (sh.error) return; // no bash on this machine
  assert.equal(sh.stdout, "7c1d:2e.f_g-h");
  assert.equal(currentOwner({ ULTRACODEX_OWNER: sh.stdout })?.id, "7c1d:2e.f_g-h");
});
