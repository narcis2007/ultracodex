// Sessions, part 7: what a request may and may not ask for, and who may talk to a session.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { framedToRaw, parseFramed, pathsOverlap, validateRequest, ensureKey } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { classifyRelayCommand, checkAgentCommand } from "../plugins/ultracodex/scripts/relay-guard.mjs";
import { frame, makeHome, signedHeader } from "./helpers.mjs";

const CATALOG = {
  models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"].map((slug) => ({ slug, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] })),
};

// ULTRACODEX_HOME is read when a request is validated
function withHome(t, home) {
  const previous = process.env.ULTRACODEX_HOME;
  process.env.ULTRACODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ULTRACODEX_HOME;
    else process.env.ULTRACODEX_HOME = previous;
  });
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-sec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const request = (extra, cwd) => validateRequest({ task: "x", cwd, ...extra }, { catalog: CATALOG });

test("session fields: defaults, bounds, and the combinations that are refused", (t) => {
  const cwd = scratch(t);
  withHome(t, path.join(cwd, "home"));
  const plain = request({}, cwd);
  assert.deepEqual([plain.session, plain.idleTtlSec, plain.askOrchestrator, plain.askTimeoutSec], [false, null, false, null]);
  const session = request({ session: true }, cwd);
  assert.deepEqual([session.session, session.idleTtlSec, session.askOrchestrator, session.askTimeoutSec], [true, 1200, true, 1800]);
  const tuned = request({ session: true, idleTtlSec: 0, askOrchestrator: false, askTimeoutSec: 60 }, cwd);
  assert.deepEqual([tuned.idleTtlSec, tuned.askOrchestrator, tuned.askTimeoutSec], [0, false, 60]);
  assert.equal(request({ session: true, idleTtlSec: 86_400 }, cwd).idleTtlSec, 86_400);
  for (const bad of [-1, 86_401, 1.5, "60"]) assert.throws(() => request({ session: true, idleTtlSec: bad }, cwd), /idleTtlSec must be an integer from 0 to 86400/, String(bad));
  for (const bad of [59, 86_401, 1.5]) assert.throws(() => request({ session: true, askTimeoutSec: bad }, cwd), /askTimeoutSec must be an integer from 60 to 86400/, String(bad));
  assert.throws(() => request({ session: "yes" }, cwd), /session must be a boolean/);
  // exec and resume are sessions; review and profile are not
  assert.equal(request({ session: true, resume: { sessionId: "01a0cec5-503d" } }, cwd).mode, "resume");
  assert.throws(() => request({ session: true, review: { uncommitted: true } }, cwd), /a session cannot run a review/);
  assert.throws(() => request({ session: true, profile: "impl" }, cwd), /a session cannot use a profile/);
  // the session-only fields mean nothing for a one-shot run: refused rather than ignored
  for (const field of [{ idleTtlSec: 60 }, { askOrchestrator: true }, { askTimeoutSec: 600 }]) {
    assert.throws(() => request(field, cwd), /need session: true/, JSON.stringify(field));
  }
  // timeoutSec is each turn's deadline: nothing changes about its validation
  assert.equal(request({ session: true, timeoutSec: 120 }, cwd).timeoutSec, 120);
});

test("a relayed (framed) request may not be a session", (t) => {
  const home = makeHome(t);
  const key = ensureKey({ ULTRACODEX_HOME: home });
  const framed = (fields) => framedToRaw(parseFramed(frame(signedHeader(home, { tier: "light", kind: "verify", ...fields }, null, "x"), null, "x")), { key });
  assert.ok(framed({}).raw, "the same frame without the field is fine");
  for (const field of [{ session: true }, { idleTtlSec: 60 }, { askOrchestrator: true }, { askTimeoutSec: 120 }]) {
    assert.throws(() => framed(field), /not allowed: .*(session|idleTtlSec|askOrchestrator|askTimeoutSec)/, JSON.stringify(field));
  }
  assert.ok(framed({ session: false }).raw, "an explicit false is the default");
});

test("a writable sandbox may not reach the runner's home (a Codex job must not write its own inbox)", (t) => {
  const base = scratch(t);
  const ucx = path.join(base, "ucx-home");
  fs.mkdirSync(path.join(ucx, "runs"), { recursive: true });
  const other = path.join(base, "work");
  fs.mkdirSync(other);
  withHome(t, ucx);
  const writable = (extra = {}, cwd = other) => request({ sandbox: "workspace-write", ...extra }, cwd);
  assert.equal(writable().sandbox, "workspace-write", "a job elsewhere is fine");
  assert.equal(writable({ addDirs: [other] }).addDirs.length, 1);
  // cwd: the home itself, inside it, above it
  for (const cwd of [ucx, path.join(ucx, "runs"), base, path.dirname(base)]) {
    assert.throws(() => writable({}, cwd), /may not reach the runner's home/, `cwd ${cwd}`);
  }
  // addDirs: the same three
  for (const dir of [ucx, path.join(ucx, "runs"), base]) {
    assert.throws(() => writable({ addDirs: [other, dir] }), /may not reach the runner's home/, `addDirs ${dir}`);
  }
  // sessions and resumes too: every writable request
  assert.throws(() => writable({ session: true }, ucx), /may not reach/);
  assert.throws(() => writable({ resume: { sessionId: "01a0cec5-503d" } }, ucx), /may not reach/);
  // a read-only sandbox cannot write there (measured), so it keeps its freedom
  assert.equal(request({ sandbox: "read-only" }, ucx).cwd, ucx);
  assert.equal(request({}, ucx).sandbox, "read-only");
  // a link into the home does not hide it (a junction on Windows, a symlink elsewhere)
  const link = path.join(base, "link-to-home");
  let linked = true;
  try {
    fs.symlinkSync(ucx, link, "junction");
  } catch {
    linked = false; // no permission to create one: nothing to assert
  }
  if (linked) assert.throws(() => writable({}, link), /may not reach the runner's home/, "a link to the home");
  // a directory that does not exist yet is judged by its nearest existing parent
  assert.equal(pathsOverlap(path.join(ucx, "later", "deeper"), ucx), true);
  assert.equal(pathsOverlap(path.join(base, "elsewhere", "deeper"), ucx), false);
  assert.equal(pathsOverlap(other, ucx), false);
  assert.equal(pathsOverlap(path.join(base, "ucx-home-sibling"), ucx), false, "a shared name prefix is not containment");
});

const PLUGIN = "/plugins/ultracodex";
const RUNNER = `${PLUGIN}/scripts/codex-node.mjs`;
const RUN = "20261009T120000Z-abcdef";

test("the relay guard denies every session command to relays and readers", () => {
  const commands = [
    `send ${RUN} --message "x"`,
    `send ${RUN} --message-file /tmp/m.txt --mode steer`,
    `interrupt ${RUN}`,
    `answer ${RUN} call-1 --text "yes"`,
    `answer ${RUN} call-1 --file /tmp/a.txt`,
    `events ${RUN}`,
    `events ${RUN} --follow --since 3 --max-wait 570`,
    `close ${RUN}`,
    `close ${RUN} --force --archive`,
    `result ${RUN} --turn 1`,
    `status ${RUN}`,
    `supervise ${RUN}`,
  ];
  for (const args of commands) {
    const command = `node "${RUNNER}" ${args}`;
    const verdict = classifyRelayCommand(command, PLUGIN);
    assert.equal(verdict.command, null, args);
    assert.ok(verdict.problem, args);
    // each confined agent type is refused; a reader's Bash is read-only git only
    for (const agent of ["ultracodex:codex-relay", "codex-relay", "ultracodex:codex-key", "ultracodex:codex-reader"]) {
      assert.ok(checkAgentCommand(agent, command, PLUGIN, { cwd: os.tmpdir() }), `${agent}: ${args}`);
    }
  }
  // the relay's own commands are untouched
  for (const ok of [`wait ${RUN}`, `wait ${RUN} --max-wait 570`, `page ${RUN} 2`]) {
    assert.equal(checkAgentCommand("ultracodex:codex-relay", `node "${RUNNER}" ${ok}`, PLUGIN), null, ok);
  }
});
