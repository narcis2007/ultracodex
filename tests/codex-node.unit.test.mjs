import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11

import {
  FRAME_SCHEMA_MARK,
  FRAME_TASK_MARK,
  MAX_TIMEOUT_SEC,
  PAGED_THRESHOLD,
  PAGE_CHARS,
  POLICY,
  SCHEMA_PRESETS,
  acquireSlots,
  buildCodexArgs,
  checkStrictSchema,
  classifyFailure,
  compactEnvelope,
  computeDeadlineSec,
  decodeFrameText,
  encodeFrameText,
  encodePageText,
  ensureKey,
  fnv1a,
  framedToRaw,
  keyPath,
  makeClock,
  mustEscape,
  normalizeText,
  pageBody,
  pageData,
  parseApiError,
  parseCatalog,
  parseFramed,
  parseProcessTable,
  policyTable,
  readUserWindowsSandbox,
  requestDigest,
  requestMac,
  resolveCodexLauncher,
  resolvePolicy,
  resultBody,
  resultMac,
  schemaHash,
  summarizeEvents,
  validateRequest,
  validateValue,
  windowsDescendants,
} from "../plugins/ultracodex/scripts/codex-node.mjs";

const CATALOG = {
  fetchedAt: new Date().toISOString(),
  models: [
    { slug: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { slug: "gpt-6-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { slug: "gpt-6-luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ],
};

test("normalizeText is stable across line endings, tabs, trailing space and NFC", () => {
  const a = normalizeText("\n\nline one\t\r\nline two   \r\n\n");
  assert.equal(a, "line one\nline two");
  assert.equal(normalizeText("a\tb"), "a    b");
  assert.equal(normalizeText("s\u0326"), normalizeText("\u0219")); // decomposed vs precomposed ș
  assert.equal(normalizeText(a), a);
});

test("fnv1a is deterministic 8-hex and sensitive to one-character changes", () => {
  assert.match(fnv1a("abc"), /^[0-9a-f]{8}$/);
  assert.equal(fnv1a("abc"), fnv1a("abc"));
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
  assert.equal(schemaHash(null), fnv1a("null"));
});

test("checkStrictSchema reports the nested `required` gap that 400s at run start", () => {
  // The exact shape that killed a run on 2026-09-20 (tasks.items.reason_if_not_done).
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string" }, reason_if_not_done: { type: ["string", "null"] } },
        },
      },
    },
  };
  const errors = checkStrictSchema(schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /#\/properties\/tasks\/items: "required" must list every property \(missing: reason_if_not_done\)/);
});

test("checkStrictSchema flags open objects, unknown required names and a non-object root", () => {
  assert.deepEqual(checkStrictSchema({ type: "array" }), ['#: root "type" must be "object"']);
  const errors = checkStrictSchema({
    type: "object",
    required: ["a", "ghost"],
    properties: { a: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } },
  });
  assert.ok(errors.some((line) => line === "#: additionalProperties must be false"));
  assert.ok(errors.some((line) => line.includes("unknown properties (ghost)")));
  assert.ok(errors.some((line) => line === "#/properties/a: additionalProperties must be false"));
});

test("every bundled schema preset passes the strict check", () => {
  for (const [name, schema] of Object.entries(SCHEMA_PRESETS)) {
    assert.deepEqual(checkStrictSchema(schema), [], name);
  }
});

test("validateValue enforces types, enums, required, extras, items and anyOf", () => {
  const schema = SCHEMA_PRESETS.review;
  const good = {
    verdict: "approve",
    summary: "fine",
    findings: [
      {
        id: "f1",
        severity: "low",
        category: "style",
        title: "t",
        file: "a.ts",
        line: null,
        evidence: "e",
        failure_scenario: "s",
        recommendation: "r",
        confidence: 0.5,
      },
    ],
  };
  assert.deepEqual(validateValue(good, schema), []);
  const bad = { ...good, verdict: "maybe", extra: 1, findings: [{ ...good.findings[0], line: "12" }] };
  const errors = validateValue(bad, schema);
  assert.ok(errors.some((line) => line.startsWith("$.verdict")));
  assert.ok(errors.some((line) => line === "$.extra: not allowed"));
  assert.ok(errors.some((line) => line.startsWith("$.findings[0].line")));
  assert.deepEqual(validateValue({ a: null }, { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } }), []);
});

test("policy follows the owner's routing rule", () => {
  assert.equal(POLICY.models.light, "gpt-6-luna");
  assert.equal(POLICY.models.daily, "gpt-6-sol");
  assert.equal(POLICY.models.final, "gpt-6-astra");
  for (const row of policyTable()) {
    if (row.model === "gpt-6-luna") assert.equal(row.effort, "max", "luna is always max");
    if (row.model === "gpt-6-astra") assert.equal(row.effort, "max");
    if (row.model === "gpt-6-sol") assert.equal(row.effort, row.kind === "verify" ? "xhigh" : "max");
    assert.notEqual(row.effort, "ultra", "ultra is never implicit");
  }
  assert.equal(resolvePolicy({ model: "gpt-6-luna", kind: "verify" }).effort, "max", "an explicit luna still defaults to max");
  assert.equal(resolvePolicy({ tier: "final", kind: "review" }).weight, 2);
  assert.equal(computeDeadlineSec("gpt-6-astra", "max", "implement"), 8100);
  assert.equal(computeDeadlineSec("gpt-6-luna", "max", "verify"), 750);
});

test("validateRequest applies defaults and rejects what codex would reject later", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-req-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const request = validateRequest({ task: "check it", cwd, schemaPreset: "verdict", kind: "verify" }, { catalog: CATALOG });
  assert.equal(request.model, "gpt-6-sol");
  assert.equal(request.effort, "xhigh");
  assert.equal(request.hermetic, true);
  assert.equal(request.ephemeral, true);
  assert.equal(request.mode, "exec");
  assert.equal(request.taskHash, fnv1a("check it"));

  const implement = validateRequest({ task: "build it", cwd, sandbox: "workspace-write" }, { catalog: CATALOG });
  assert.equal(implement.kind, "implement");
  assert.equal(implement.effort, "max");
  assert.equal(implement.ephemeral, false, "implementation sessions stay resumable");

  const reject = (raw, kind, pattern) => {
    assert.throws(() => validateRequest({ cwd, ...raw }, { catalog: CATALOG }), (error) => {
      assert.equal(error.kind, kind);
      assert.match(error.message, pattern);
      return true;
    });
  };
  reject({ task: "x", bogus: 1 }, "invalid_request", /unknown request fields: bogus/);
  reject({ task: "x", model: "gpt-6-luna", effort: "ultra" }, "effort", /not supported by gpt-6-luna/);
  reject({ task: "x", model: "gpt-6-nope" }, "model", /not in the local Codex catalog/);
  reject({ task: "x", model: "sol; rm -rf /" }, "invalid_request", /unsupported characters/);
  reject({ task: "" }, "invalid_request", /must not be empty/);
  reject({ task: "x", schema: { type: "object", properties: { a: { type: "string" } } } }, "schema", /strict mode/);
  reject({ task: "x", review: { base: "main" }, resume: { sessionId: "abcdef12" } }, "invalid_request", /mutually exclusive/);
  reject({ task: "x", review: { base: "main", commit: "abc1234" } }, "invalid_request", /exactly one/);
  reject({ task: "x", cwd: path.join(cwd, "missing") }, "invalid_request", /not a directory/);
  reject({ task: "x", timeoutSec: 99999 }, "invalid_request", /timeoutSec/);
});

test("writing tasks are never retried automatically unless declared replay-safe", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-req-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal(validateRequest({ task: "x", cwd, sandbox: "workspace-write" }, { catalog: CATALOG }).maxAttempts, 1);
  assert.equal(validateRequest({ task: "x", cwd, resume: { sessionId: "01a0cec5-503d" } }, { catalog: CATALOG }).maxAttempts, 1);
  assert.equal(validateRequest({ task: "x", cwd }, { catalog: CATALOG }).maxAttempts, 2, "read-only work keeps one transient retry");
  assert.throws(() => validateRequest({ task: "x", cwd, sandbox: "workspace-write", maxAttempts: 2 }, { catalog: CATALOG }), /apply its effects twice/);
  assert.equal(validateRequest({ task: "x", cwd, sandbox: "workspace-write", maxAttempts: 2, replaySafe: true }, { catalog: CATALOG }).maxAttempts, 2);
});

function withHome(t, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-home-"));
  const vars = { ULTRACODEX_HOME: home, ...extraEnv };
  const previous = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("slot leases are fenced by generation: a displaced owner neither renews nor releases the new owner's slot", async (t) => {
  const home = withHome(t, { ULTRACODEX_MAX_CONCURRENT: "1" });
  const lease = await acquireSlots(1, "run-A", () => null);
  const slot = path.join(home, "slots", "slot-0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(slot, "lease-run-A", "owner.json"), "utf8")).runId, "run-A");
  // simulate B reclaiming the slot after A stalled: A's generation is gone, B's is in place
  fs.rmSync(path.join(slot, "lease-run-A"), { recursive: true, force: true });
  fs.mkdirSync(path.join(slot, "lease-run-B"));
  fs.writeFileSync(path.join(slot, "lease-run-B", "owner.json"), JSON.stringify({ runId: "run-B", pid: process.pid, beatAt: Date.now() }));
  lease.touch();
  assert.equal(fs.existsSync(path.join(slot, "lease-run-A")), false, "A must not recreate its lease inside B's slot");
  assert.equal(lease.lost().length, 1, "A notices it was displaced");
  lease.release();
  assert.ok(fs.existsSync(path.join(slot, "lease-run-B", "owner.json")), "A must not release B's slot");
  const stopped = await acquireSlots(1, "run-C", () => "cancelled");
  assert.equal(stopped.stopped, "cancelled", "a cancelled run never waits for or takes a slot");
});

// Staleness is counted in the reclaimer's own polls, so the timing knobs must be set
// before the runner module loads: run the scenario in a child process.
function slotProbe(t, scenario) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-probe-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = spawnSync(process.execPath, [path.join(TESTS_DIR, "fixtures", "slot-probe.mjs"), scenario], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ULTRACODEX_HOME: home, ULTRACODEX_MAX_CONCURRENT: "1", ULTRACODEX_SLOT_POLL_MS: "20", ULTRACODEX_SLOT_STALE_MS: "200" },
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").at(-1));
}

test("a slot whose owner stopped renewing is reclaimed only after a full stale window of polls", (t) => {
  const stale = slotProbe(t, "stale-owner");
  assert.equal(stale.taken, true);
  assert.ok(stale.polls >= 10, `reclaimed after ${stale.polls} polls (stale window = 10)`);
  assert.equal(stale.newOwner, "run-Y");
});

test("a slot whose owner keeps renewing is never reclaimed, and a dead owner's slot is reclaimed at once", (t) => {
  const live = slotProbe(t, "live-owner");
  assert.equal(live.taken, false, "a renewing owner keeps its slot");
  assert.equal(live.stopped, "cancelled");
  const dead = slotProbe(t, "dead-owner");
  assert.equal(dead.taken, true);
  assert.ok(dead.polls <= 2, `a dead PID is reclaimed immediately (took ${dead.polls} polls)`);
});

test("an owner file that cannot be read this instant does not make a live lease look abandoned", (t) => {
  const fresh = slotProbe(t, "partial-fresh");
  assert.equal(fresh.taken, false, "the lease directory is still being renewed");
  const old = slotProbe(t, "partial-old");
  assert.equal(old.taken, true, "a lease nobody renews is debris");
});

test("creation times stay exact: FILETIMEs are far beyond Number precision", () => {
  const [row] = parseProcessTable("4242 1 134346764568274730");
  assert.equal(typeof row.created, "bigint");
  assert.equal(String(row.created), "134346764568274730", "a Number would read 134346764568274740");
  assert.notEqual(String(Number("134346764568274730")), "134346764568274730", "(which is why BigInt)");
  const kids = windowsDescendants(row, parseProcessTable("4243 4242 134346764568274731\n4244 4242 134346764568274729"));
  assert.deepEqual(kids.map((proc) => proc.pid), [4243], "a one-tick difference still decides parenthood");
});

test("an existing key that is not valid is never silently replaced", (t) => {
  const home = withHome(t);
  fs.writeFileSync(path.join(home, "key"), "");
  assert.throws(() => ensureKey(), (error) => error.kind === "key_invalid" && /exists but is not valid/.test(error.message));
  assert.equal(fs.readFileSync(path.join(home, "key"), "utf8"), "", "left for the owner to delete");
});

test("an old empty slot directory is taken by removing it only while empty — never by moving it", async (t) => {
  const home = withHome(t, { ULTRACODEX_MAX_CONCURRENT: "1", ULTRACODEX_SLOT_STALE_MS: "0" });
  const slot = path.join(home, "slots", "slot-0");
  fs.mkdirSync(slot, { recursive: true });
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(slot, old, old);
  const lease = await acquireSlots(1, "run-D", () => null);
  assert.deepEqual(fs.readdirSync(slot), ["lease-run-D"]);
  assert.deepEqual(fs.readdirSync(path.join(home, "slots")).filter((name) => name.includes(".stale-")), [], "nothing was moved aside");
  lease.release();
  assert.equal(fs.existsSync(slot), false, "release removes the emptied slot");
});

test("a double-booked slot is reported as lost, and release takes only its own generation", async (t) => {
  const home = withHome(t, { ULTRACODEX_MAX_CONCURRENT: "1" });
  const lease = await acquireSlots(1, "run-B", () => null);
  const slot = path.join(home, "slots", "slot-0");
  // a second generation beside ours (only a stalled owner given back its lease can do this)
  fs.mkdirSync(path.join(slot, "lease-run-A"));
  fs.writeFileSync(path.join(slot, "lease-run-A", "owner.json"), JSON.stringify({ runId: "run-A", pid: process.pid, beatAt: Date.now() }));
  lease.touch();
  assert.equal(lease.lost().length, 1, "a double-booked slot is reported");
  lease.release();
  assert.deepEqual(fs.readdirSync(slot), ["lease-run-A"], "release takes only its own generation, and leaves the other one's slot in place");
});

test("a claim never lands in an existing slot, whatever the taker's run id", async (t) => {
  const home = withHome(t, { ULTRACODEX_MAX_CONCURRENT: "1" });
  const b = await acquireSlots(1, "run-B", () => null);
  let polls = 0;
  const a = await acquireSlots(1, "run-A", () => (++polls > 3 ? "cancelled" : null));
  assert.equal(a.stopped, "cancelled", "the smaller run id waits like any other taker");
  assert.deepEqual(fs.readdirSync(path.join(home, "slots", "slot-0")), ["lease-run-B"]);
  assert.deepEqual(fs.readdirSync(path.join(home, "slots")).filter((name) => name.startsWith(".claim-")), [], "a claim that did not land is removed");
  b.release();
});

test("two takers of a freed slot never both own it — even when one lands its claim late", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-race-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // an old empty remnant that both takers judge free
  const slot = path.join(home, "slots", "slot-0");
  fs.mkdirSync(slot, { recursive: true });
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(slot, old, old);
  const env = { ...process.env, ULTRACODEX_HOME: home, ULTRACODEX_MAX_CONCURRENT: "1", ULTRACODEX_SLOT_POLL_MS: "20" };
  const taker = (runId, holdMs, extra = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(TESTS_DIR, "fixtures", "slot-race.mjs"), runId, String(holdMs)], { env: { ...env, ...extra } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(`${runId} exited ${code}`))));
    });
  // A (the smaller id) removes the remnant, then lands its claim 1.5 s later; B arrives in between
  const late = taker("run-A", 300, { ULTRACODEX_SLOT_CLAIM_DELAY_MS: "1500" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [a, b] = await Promise.all([late, taker("run-B", 600)]);
  assert.deepEqual(a.overlaps, [], "A never held the slot while B did");
  assert.deepEqual(b.overlaps, [], "B never held the slot while A did");
});

test("stale pre-0.3 debris that is not empty never blocks a slot; unknown content is left alone", async (t) => {
  const home = withHome(t, { ULTRACODEX_MAX_CONCURRENT: "1" });
  const slot = path.join(home, "slots", "slot-0");
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, "owner.json"), "{"); // corrupt
  fs.writeFileSync(path.join(slot, "owner.json.tmp-4242-1"), "");
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(slot, old, old);
  const lease = await acquireSlots(1, "run-E", () => null);
  assert.deepEqual(fs.readdirSync(slot), ["lease-run-E"], "the legacy files went, the slot was taken whole");
  lease.release();
  fs.mkdirSync(slot);
  fs.writeFileSync(path.join(slot, "notes.txt"), "not ours");
  fs.utimesSync(slot, old, old);
  let polls = 0;
  const blocked = await acquireSlots(1, "run-F", () => (++polls > 3 ? "cancelled" : null));
  assert.equal(blocked.stopped, "cancelled");
  assert.deepEqual(fs.readdirSync(slot), ["notes.txt"], "nothing unknown is ever deleted");
});

test("windowsDescendants follows only genuine parent links (created after the parent)", () => {
  const table = parseProcessTable(["", "  100 1 500", "200 100 600", "300 200 700", "400 100 400", "500 400 800", "garbage line", "600 300 650"].join("\r\n"));
  assert.equal(table.length, 6);
  const found = windowsDescendants({ pid: 100, created: 500 }, table).map((proc) => proc.pid);
  // 400 claims parent 100 but predates it (an orphan whose dead parent's PID was reused): not ours, nor its child 500.
  // 600 claims parent 300 but predates it the same way.
  assert.deepEqual(found.sort(), [200, 300]);
  // parent 300 died and its PID now belongs to a younger process (created 900): only the
  // children created before 900 can be 300's.
  const reused = parseProcessTable(["200 100 600", "300 1 900", "700 300 750", "800 300 950"].join("\n"));
  assert.deepEqual(windowsDescendants({ pid: 100, created: 500 }, reused).map((proc) => proc.pid), [200]);
  assert.deepEqual(windowsDescendants({ pid: 300, created: 700 }, reused).map((proc) => proc.pid), [700], "800 belongs to the new holder of PID 300");
});

test("the key is created once and private; results are signed over run, request digest, payload kind and body", (t) => {
  withHome(t);
  const key = ensureKey();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(ensureKey(), key, "the key is stable");
  if (process.platform !== "win32") assert.equal(fs.statSync(keyPath()).mode & 0o077, 0, "not readable by others");
  const digest = createHash("sha256").update("a request", "utf8").digest("hex");
  const expected = createHmac("sha256", Buffer.from(key, "hex")).update(`ucx-result\nR\n${digest}\nresult\n{"a":1}`, "utf8").digest("hex");
  assert.equal(resultMac(key, "R", digest, "result", '{"a":1}'), expected);
  assert.notEqual(resultMac(key, "R", digest, "text", '{"a":1}'), expected, "bound to the payload kind");
  assert.notEqual(resultMac(key, "R", "0".repeat(64), "result", '{"a":1}'), expected, "bound to the request");
  assert.equal(resultBody({ result: { a: 1 } }), '{"a":1}');
  assert.equal(resultBody({ text: "t" }), "t");
});

test("concurrent first use publishes one complete key: no process ever sees an empty or different one", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-keyrace-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const probe = path.join(TESTS_DIR, "fixtures", "key-probe.mjs");
  const children = Array.from({ length: 8 }, () =>
    spawn(process.execPath, [probe], { env: { ...process.env, ULTRACODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"] })
  );
  return Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => resolve({ code, out: out.trim(), err }));
        })
    )
  ).then((results) => {
    for (const r of results) assert.equal(r.code, 0, r.err);
    const keys = new Set(results.map((r) => r.out));
    assert.equal(keys.size, 1, "every process got the same key");
    assert.match([...keys][0], /^[0-9a-f]{64}$/);
    assert.equal(fs.readdirSync(home).filter((name) => name.startsWith("key.tmp")).length, 0, "no temp files left behind");
  });
});

test("large results are paged: a compact envelope plus encoded, hashed pages that rebuild the body exactly", () => {
  const small = { ultracodex: 1, ok: true, state: "done", runId: "R", result: { a: 1 }, resultHash: "x", mac: "m" };
  assert.equal(compactEnvelope(small), small, "small results print whole");
  const bs = String.fromCharCode(0x5c);
  const big = { ...small, result: { text: ("q\"u" + bs + "o C:" + bs + "x ăî " + String.fromCodePoint(0x1f600) + String.fromCharCode(0x2028) + " 100% ").repeat(2000) } };
  const compact = compactEnvelope(big);
  assert.equal(compact.result, undefined);
  assert.equal(compact.mac, "m", "the signature stays on the compact envelope");
  const data = pageData(big);
  assert.equal(compact.paged.enc, "pct");
  assert.equal(compact.paged.pages, Math.ceil(data.length / PAGE_CHARS));
  assert.ok(compact.paged.pages > 1);
  assert.ok(JSON.stringify(compact).length < PAGED_THRESHOLD);
  const pages = Array.from({ length: compact.paged.pages }, (_, i) => data.slice(i * PAGE_CHARS, (i + 1) * PAGE_CHARS));
  assert.deepEqual(compact.paged.hashes, pages.map((page) => fnv1a(page)), "one hash per page");
  assert.equal(decodeFrameText(pages.join("")), pageBody(big));
  assert.deepEqual(JSON.parse(decodeFrameText(pages.join(""))).result, big.result);
  for (const page of pages) {
    assert.equal(JSON.stringify(page), '"' + page + '"', "a page needs no JSON escaping: nothing for a relay to mis-copy");
    assert.ok(JSON.stringify({ ultracodex: 1, runId: "20260923T000000Z-abcdef", page: 1, pages: 9, data: page }).length < 30_000, "a page line fits the Bash output limit");
  }
  assert.equal(encodePageText('say "%22" here'), "say %22%2522%22 here", "a literal %22 survives the round trip");
  assert.equal(decodeFrameText(encodePageText('say "%22" here')), 'say "%22" here');
});

test("readUserWindowsSandbox understands quoted tables, dotted keys and inline tables", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-codexhome-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const read = (toml) => {
    fs.writeFileSync(path.join(home, "config.toml"), toml);
    return readUserWindowsSandbox({ CODEX_HOME: home });
  };
  assert.equal(read('["windows"]\nsandbox = "elevated"\n'), "elevated");
  assert.equal(read('model = "x"\nwindows.sandbox = "elevated"\n'), "elevated");
  assert.equal(read('windows = { sandbox = "unelevated" }\n'), "unelevated");
  assert.equal(read('[windows.extra]\nsandbox = "wrong"\n'), null, "a sub-table is not [windows]");
});

test("a batch of N items scales the default deadline, an explicit timeoutSec is kept", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-req-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const one = validateRequest({ task: "x", cwd, kind: "verify" }, { catalog: CATALOG });
  const five = validateRequest({ task: "x", cwd, kind: "verify", workItems: 5 }, { catalog: CATALOG });
  assert.equal(five.timeoutSec, Math.round(one.timeoutSec * 2));
  const many = validateRequest({ task: "x", cwd, kind: "verify", workItems: 256 }, { catalog: CATALOG });
  assert.equal(many.timeoutSec, Math.min(MAX_TIMEOUT_SEC, one.timeoutSec * 4), "at most x4");
  assert.equal(validateRequest({ task: "x", cwd, workItems: 9, timeoutSec: 600 }, { catalog: CATALOG }).timeoutSec, 600);
  assert.throws(() => validateRequest({ task: "x", cwd, workItems: 0 }, { catalog: CATALOG }), /workItems/);
});

test("the frame encoder round-trips every kind of character and leaves nothing a shell or relay could mangle", () => {
  const specials = [0x00, 0x07, 0x09, 0x0d, 0x1b, 0x25, 0x27, 0x5c, 0x7f, 0x85, 0xa0, 0xad, 0x061c, 0x200b, 0x200e, 0x202e, 0x2028, 0x2029, 0x2066, 0x3000, 0xfe0f, 0xfeff, 0xd800, 0xdfff, 0xe0001, 0xe0100, 0x1f600, 0x10ffff];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let round = 0; round < 200; round += 1) {
    let text = "";
    for (let i = 0; i < 40; i += 1) {
      const pick = next() % 3;
      text += pick === 0 ? String.fromCodePoint(specials[next() % specials.length])
        : pick === 1 ? " plain %5C %u0041 %25 %+ text "
          : String.fromCodePoint(0x20 + (next() % 0x2ff));
    }
    const encoded = encodeFrameText(text);
    // '%' only ever opens one of the escapes; everything else is safe as it stands
    const rest = encoded.replace(/%(25|5C|27|u[0-9A-F]{4}|U[0-9A-F]{6})/g, "");
    assert.equal(rest.includes("%"), false, "a bare % in the encoding");
    for (const char of rest) assert.equal(mustEscape(char), false, `U+${char.codePointAt(0).toString(16)} left unescaped`);
    assert.equal(decodeFrameText(encoded), text);
  }
});

test("without a catalog, ultra is still refused on luna", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-req-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.throws(() => validateRequest({ task: "x", cwd, model: "gpt-6-luna", effort: "ultra" }), /not supported/);
  assert.equal(validateRequest({ task: "x", cwd, model: "gpt-6-astra", effort: "ultra" }).effort, "ultra");
});

test("buildCodexArgs: hermetic read-only exec carries the Windows sandbox and reads stdin", () => {
  const request = {
    mode: "exec",
    task: "t",
    sandbox: "read-only",
    cwd: "C:/repo",
    model: "gpt-6-sol",
    effort: "xhigh",
    ephemeral: true,
    hermetic: true,
    network: false,
    serviceTier: null,
    profile: null,
    addDirs: [],
    images: [],
  };
  const args = buildCodexArgs(request, { lastMessage: "L", schema: "S" }, { platform: "win32", windowsSandbox: "elevated" });
  assert.deepEqual(args, [
    "exec",
    "-s",
    "read-only",
    "-C",
    "C:/repo",
    "--skip-git-repo-check",
    "--json",
    "-o",
    "L",
    "-m",
    "gpt-6-sol",
    "-c",
    'model_reasoning_effort="xhigh"',
    "--output-schema",
    "S",
    "--ephemeral",
    "--ignore-user-config",
    "-c",
    'windows.sandbox="elevated"',
    "-",
  ]);
});

test("buildCodexArgs: workspace-write with network, images first, profile and extra dirs", () => {
  const args = buildCodexArgs(
    {
      mode: "exec",
      task: "t",
      sandbox: "workspace-write",
      cwd: "/repo",
      model: "gpt-6-astra",
      effort: "max",
      ephemeral: false,
      hermetic: false,
      network: true,
      serviceTier: "priority",
      profile: "impl",
      addDirs: ["/cache"],
      images: ["/a.png"],
    },
    { lastMessage: "L", schema: null },
    { platform: "linux" }
  );
  assert.deepEqual(args.slice(0, 3), ["exec", "-i", "/a.png"]);
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(args.includes('service_tier="priority"'));
  assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "impl"]);
  assert.deepEqual(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2), ["--add-dir", "/cache"]);
  assert.ok(!args.includes("--ignore-user-config"));
  assert.ok(!args.includes("--output-schema"));
  assert.equal(args.at(-1), "-");
});

test("buildCodexArgs: review and resume modes use their own flag sets", () => {
  const base = {
    task: "",
    sandbox: "read-only",
    cwd: "/repo",
    model: "gpt-6-sol",
    effort: "max",
    ephemeral: true,
    hermetic: true,
    network: false,
    serviceTier: null,
    profile: "ignored",
    addDirs: ["/x"],
    images: [],
  };
  const review = buildCodexArgs({ ...base, mode: "review", review: { base: "main", commit: null, uncommitted: false, title: "T" } }, { lastMessage: "L", schema: "S" }, { platform: "linux" });
  assert.deepEqual(review.slice(0, 6), ["exec", "review", "--base", "main", "--title", "T"]);
  assert.ok(!review.includes("-s") && !review.includes("-C") && !review.includes("-p") && !review.includes("--add-dir"));
  assert.ok(!review.includes("-"), "no stdin prompt when there are no custom instructions");
  const resume = buildCodexArgs({ ...base, task: "follow up", mode: "resume", resume: { sessionId: "01a0cec5-503d" } }, { lastMessage: "L", schema: null }, { platform: "linux" });
  assert.deepEqual(resume.slice(0, 3), ["exec", "resume", "01a0cec5-503d"]);
  assert.ok(!resume.includes("-s") && !resume.includes("-C"));
  assert.equal(resume.at(-1), "-");
});

// A frame built the way the Workflow helper builds it: header fields + nonce, the transport
// hashes, h over all of them, then rmac = the request signature over the exact frame.
const TEST_KEY = "7a".repeat(32);
function signedFrame(fields, schema, task, { key = TEST_KEY, nonce = "ab".repeat(16) + ".1", tamper = null } = {}) {
  const header = { v: 1, ...fields, nonce, taskHash: fnv1a(normalizeText(task)), schemaHash: schemaHash(schema) };
  header.h = fnv1a(JSON.stringify(header));
  const rmac = requestMac(key, requestDigest(header, schema, task));
  const sent = tamper ? tamper({ ...header, rmac }) : { ...header, rmac };
  return [JSON.stringify(sent), FRAME_SCHEMA_MARK, schema === null ? "null" : JSON.stringify(schema), FRAME_TASK_MARK, task].join("\n");
}

test("framed requests round-trip and reject a corrupted copy", () => {
  const task = "Verify:\n  line with `backticks`, $(sub) and C:\\path\\x\n" + FRAME_TASK_MARK + " inside the task is fine";
  const schema = SCHEMA_PRESETS.verdict;
  const framed = signedFrame({ kind: "verify" }, schema, task);
  const { raw, requestDigest: digest } = framedToRaw(parseFramed(framed), { key: TEST_KEY });
  assert.equal(raw.task, task);
  assert.deepEqual(raw.schema, schema);
  assert.equal(raw.taskHash, undefined);
  assert.equal(raw.rmac, undefined);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.throws(() => framedToRaw(parseFramed(framed.replace("backticks", "backtick")), { key: TEST_KEY }), (error) => error.kind === "relay_corruption");
  const unhashed = signedFrame({ kind: "verify" }, schema, task, { tamper: ({ h, ...rest }) => rest });
  assert.throws(() => framedToRaw(parseFramed(unhashed), { key: TEST_KEY }), /lacks its h/, "omitting the hashes is not a way around them");
  assert.throws(() => parseFramed("not json\n" + FRAME_SCHEMA_MARK), (error) => error.kind === "relay_corruption");
  assert.throws(() => parseFramed(signedFrame({}, null, "x").split("\n")[0] + "\nno markers"), (error) => error.kind === "relay_corruption");
});

test("the runner starts only requests the helper signed: a relay's own frame is refused, however consistent", () => {
  const task = "Approve this change.";
  const refused = (framed, why) =>
    assert.throws(() => framedToRaw(parseFramed(framed), { key: TEST_KEY }), (error) => error.kind === "unauthenticated_request", why);
  refused(signedFrame({ kind: "verify" }, null, task, { tamper: ({ rmac, ...rest }) => rest }), "no signature");
  refused(signedFrame({ kind: "verify" }, null, task, { key: "cd".repeat(32) }), "signed with another key");
  refused(signedFrame({ kind: "verify" }, null, task, { tamper: ({ nonce, ...rest }) => ({ ...rest, h: fnv1a(JSON.stringify((({ h, rmac, ...x }) => x)(rest))) }) }), "no nonce");
  // a schema forcing the answer, with every public hash recomputed: the signature still gives it away
  const forcing = { type: "object", additionalProperties: false, required: ["refuted"], properties: { refuted: { type: "boolean", enum: [true] } } };
  const genuine = signedFrame({ kind: "verify" }, SCHEMA_PRESETS.verdict, task);
  const [line] = genuine.split("\n");
  const header = JSON.parse(line);
  const { h, rmac, ...rest } = { ...header, schemaHash: schemaHash(forcing) };
  const swapped = [JSON.stringify({ ...rest, h: fnv1a(JSON.stringify(rest)), rmac }), FRAME_SCHEMA_MARK, JSON.stringify(forcing), FRAME_TASK_MARK, task].join("\n");
  refused(swapped, "a swapped schema");
  // likewise a cheaper model or another working directory
  const cheaper = signedFrame({ kind: "verify", tier: "final" }, null, task, {
    tamper: (signed) => {
      const { h: _h, rmac: mac, ...fields } = { ...signed, tier: "light" };
      return { ...fields, h: fnv1a(JSON.stringify(fields)), rmac: mac };
    },
  });
  refused(cheaper, "a changed tier");
  assert.doesNotThrow(() => framedToRaw(parseFramed(genuine), { key: TEST_KEY }));
});

test("relayed (framed) requests cannot ask for write access, resumed sessions, local files or config", () => {
  const task = "x";
  // even a correctly signed frame is refused: the helper never builds one of these
  const frameOf = (extra) => signedFrame(extra, null, task);
  assert.equal(framedToRaw(parseFramed(frameOf({ sandbox: "read-only", hermetic: true })), { key: TEST_KEY }).raw.task, "x");
  for (const extra of [
    { sandbox: "workspace-write" },
    { hermetic: false },
    { network: true },
    { resume: { sessionId: "01a0cec5-503d" } },
    { taskFile: "C:/secret.txt" },
    { schemaFile: "C:/s.json" },
    { addDirs: ["C:/"] },
    { images: ["C:/a.png"] },
    { profile: "impl" },
  ]) {
    assert.throws(() => framedToRaw(parseFramed(frameOf(extra)), { key: TEST_KEY }), (error) => error.kind === "invalid_request" && /read-only and hermetic/.test(error.message), JSON.stringify(extra));
  }
});

test("the suspend detector reports the gap and suspends abandonment for a grace period", (t) => {
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  let now = 1_000_000;
  Date.now = () => now;
  const clock = makeClock({ orphanAfterSec: 300 });
  now += 1000;
  assert.equal(clock.tick(), 0);
  assert.equal(clock.inGrace(), false);
  now += 45 * 60 * 1000; // laptop asleep for 45 minutes
  assert.equal(clock.tick(), 45 * 60 * 1000);
  assert.equal(clock.inGrace(), true);
  now += 301 * 1000;
  assert.equal(clock.inGrace(), false);
});

// Event lines captured from codex-cli 0.156.1 on 2026-09-23.
const BAD_MODEL_EVENTS = [
  '{"type":"thread.started","thread_id":"01a0ced9-f0d2-7831-8a38-b770b881fafd"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-6-nonexistent` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-6-nonexistent\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-6-nonexistent\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
].join("\n");

const BAD_SCHEMA_MESSAGE = JSON.stringify(
  {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "invalid_json_schema",
      message:
        "Invalid schema for response_format 'codex_output_schema': In context=('properties', 'tasks', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'reason_if_not_done'.",
      param: "text.format.schema",
    },
    status: 400,
  },
  null,
  2
);

test("summarizeEvents extracts thread id, usage and the failure; warnings stay warnings", () => {
  const summary = summarizeEvents(
    BAD_MODEL_EVENTS +
      '\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'
  );
  assert.equal(summary.threadId, "01a0ced9-f0d2-7831-8a38-b770b881fafd");
  assert.deepEqual(summary.usage, { input_tokens: 15, output_tokens: 3 });
  assert.equal(summary.warnings.length, 1);
  assert.ok(summary.turnFailed);
});

test("classifyFailure maps real Codex errors to stable kinds", () => {
  assert.equal(classifyFailure({ summary: summarizeEvents(BAD_MODEL_EVENTS), exitCode: 1 }).kind, "model");
  const schema = classifyFailure({ summary: { turnFailed: { message: BAD_SCHEMA_MESSAGE }, errors: [] }, exitCode: 1 });
  assert.equal(schema.kind, "schema");
  assert.equal(schema.retryable, false);
  const effort = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", code: "unsupported_value", message: "Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model.", param: "reasoning.effort" },
    status: 400,
  });
  assert.equal(classifyFailure({ summary: { turnFailed: { message: effort }, errors: [] } }).kind, "effort");
  const rate = JSON.stringify({ type: "error", status: 429, error: { message: "Rate limit reached" } });
  assert.deepEqual(
    [classifyFailure({ summary: { turnFailed: { message: rate }, errors: [] } }).kind, classifyFailure({ summary: { turnFailed: { message: rate }, errors: [] } }).retryable],
    ["rate_limit", true]
  );
  const usage = JSON.stringify({ type: "error", status: 429, error: { message: "You've hit your usage limit. Try again later." } });
  assert.equal(classifyFailure({ summary: { turnFailed: { message: usage }, errors: [] } }).kind, "usage_limit");
  assert.equal(classifyFailure({ summary: { errors: ["stream disconnected before completion"] } }).kind, "network");
  assert.equal(classifyFailure({ summary: { errors: ['{"status":503,"error":{"message":"overloaded"}}'] } }).kind, "server");
  assert.equal(classifyFailure({ timedOut: true }).kind, "timeout");
  assert.equal(classifyFailure({ cancelled: true }).kind, "cancelled");
  assert.equal(classifyFailure({ abandoned: true }).kind, "abandoned");
  assert.equal(classifyFailure({ summary: { errors: [] }, exitCode: 0, emptyOutput: true }).kind, "empty_output");
});

test("MCP OAuth noise on stderr never decides the classification", () => {
  const stderr = [
    "2026-09-23T14:57:15.974211Z ERROR codex_rmcp_client::oauth::refresh_transaction: error=failed to refresh OAuth tokens for server rezalto: OAuth refresh token was rejected: invalid_grant",
    "2026-09-23T14:57:16.241072Z ERROR codex_rmcp_client::oauth::refresh_transaction: error=failed to refresh OAuth tokens for server atlassian",
  ].join("\n");
  const failure = classifyFailure({ summary: { errors: [] }, stderr, exitCode: 1 });
  assert.notEqual(failure.kind, "auth");
  assert.equal(failure.kind, "execution");
});

test("parseApiError reads pretty-printed and plain messages", () => {
  assert.equal(parseApiError(BAD_SCHEMA_MESSAGE).code, "invalid_json_schema");
  assert.equal(parseApiError("HTTP 502 Bad Gateway").status, 502);
});

test("parseCatalog keeps slug, efforts and visibility", () => {
  const models = parseCatalog(
    JSON.stringify({ models: [{ slug: "gpt-6-luna", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }] })
  );
  assert.deepEqual(models[0].efforts, ["low", "max"]);
  assert.equal(models[0].visibility, "list");
});

test("readUserWindowsSandbox reads only the [windows] table", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-codexhome-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "config.toml"), '[other]\nsandbox = "wrong"\n\n[windows]\nsandbox = "elevated"\n');
  assert.equal(readUserWindowsSandbox({ CODEX_HOME: home }), "elevated");
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-6-astra"\n');
  assert.equal(readUserWindowsSandbox({ CODEX_HOME: home }), null);
});

test("resolveCodexLauncher prefers the native binary behind an npm install", (t) => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-npm-"));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const targets = {
    "win32-x64": ["x86_64-pc-windows-msvc", "codex-win32-x64", "codex.exe"],
    "win32-arm64": ["aarch64-pc-windows-msvc", "codex-win32-arm64", "codex.exe"],
    "darwin-x64": ["x86_64-apple-darwin", "codex-darwin-x64", "codex"],
    "darwin-arm64": ["aarch64-apple-darwin", "codex-darwin-arm64", "codex"],
    "linux-x64": ["x86_64-unknown-linux-musl", "codex-linux-x64", "codex"],
    "linux-arm64": ["aarch64-unknown-linux-musl", "codex-linux-arm64", "codex"],
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) return t.skip("platform without a Codex build");
  const root = path.join(prefix, "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "codex.js"), "// shim\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.0.0" }));
  const platformRoot = path.join(root, "node_modules", "@openai", target[1]);
  fs.mkdirSync(path.join(platformRoot, "vendor", target[0], "bin"), { recursive: true });
  fs.writeFileSync(path.join(platformRoot, "package.json"), JSON.stringify({ name: `@openai/${target[1]}`, version: "0.0.0" }));
  const exe = path.join(platformRoot, "vendor", target[0], "bin", target[2]);
  fs.writeFileSync(exe, "");
  const launcher = resolveCodexLauncher({ env: { PATH: prefix, APPDATA: "" } });
  assert.equal(fs.realpathSync(launcher.command), fs.realpathSync(exe));
  assert.equal(launcher.env.CODEX_MANAGED_BY_NPM, "1");
  assert.match(launcher.source, /npm-native$/);
  const explicit = resolveCodexLauncher({ env: {}, explicitPath: path.join(root, "bin", "codex.js") });
  assert.equal(fs.realpathSync(explicit.command), fs.realpathSync(exe));
});
