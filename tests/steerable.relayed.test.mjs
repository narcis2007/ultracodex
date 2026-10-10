// Steerable workflow nodes (0.6.0), part 4: the relay path. A Workflow node is a relayed request — built and
// signed by the helper, uploaded by a Claude relay that is untrusted — and `steerable` travels in the signed
// header: a relay can neither add it nor drop it without breaking the signature. The helper's own acceptance
// of a node's result (hash, signature, provenance) is exercised against the real runner, with a relay stub that
// does what the relay agent does (the `part` and `wait` commands).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ensureKey, fnv1a, framedToRaw, normalizeText, parseFramed, resultMac, validateRequest } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { ROOT, announce, fastEnv, frame, makeHome, runCli, signedHeader } from "./helpers.mjs";
import { readState, sessionHome, wait } from "./helpers-session.mjs";

const AsyncFunction = (async () => {}).constructor;
const KEY_AGENT = "ultracodex:codex-key";
const RELAY = "ultracodex:codex-relay";

const relayed = (home, fields, task = "x", schema = null) => {
  const key = ensureKey({ ULTRACODEX_HOME: home });
  const signed = signedHeader(home, { tier: "light", kind: "verify", ...fields }, schema, task);
  return { signed, key, load: (header = signed) => framedToRaw(parseFramed(frame(header, schema, task)), { key }) };
};

test("a signed steerable request is accepted; its raw request carries steerable", (t) => {
  const home = makeHome(t);
  const { load } = relayed(home, { steerable: true, label: "node" });
  const { raw } = load();
  assert.equal(raw.steerable, true);
  assert.equal(validateRequest(raw).steerable, true);
  assert.equal(validateRequest(relayed(home, {}).load().raw).steerable, false, "absent: not steerable");
  assert.equal(relayed(home, { steerable: false }).load().raw.steerable, false, "an explicit false is the default");
  assert.throws(() => validateRequest({ ...load().raw, steerable: "yes" }), /steerable must be a boolean/);
});

test("steerable is part of the signed digest: a relay that adds, drops or flips it is refused", (t) => {
  const home = makeHome(t);
  // re-hashes a header's transport hash (a relay can compute that), leaving the signature as it was
  const rehash = (header) => {
    const { h, rmac, ...rest } = header;
    return { ...rest, h: fnv1a(JSON.stringify(rest)), rmac };
  };
  const plain = relayed(home, { label: "node" });
  const steerable = relayed(home, { label: "node", steerable: true }, "x", null);
  // adding it to a request signed without
  assert.throws(() => plain.load(rehash({ ...plain.signed, steerable: true })), (error) => error.kind === "unauthenticated_request", "added, with the transport hash fixed: the signature breaks");
  assert.throws(() => plain.load({ ...plain.signed, steerable: true }), (error) => error.kind === "relay_corruption", "added carelessly: the transport hash breaks");
  // dropping it from a request signed with
  const { steerable: dropped, ...withoutIt } = steerable.signed;
  assert.equal(dropped, true);
  assert.throws(() => steerable.load(rehash(withoutIt)), (error) => error.kind === "unauthenticated_request");
  // flipping it
  assert.throws(() => steerable.load(rehash({ ...steerable.signed, steerable: false })), (error) => error.kind === "unauthenticated_request");
  // the untouched ones stand
  assert.ok(plain.load().raw && steerable.load().raw);
  // and a signed request that is not read-only and hermetic is refused as it always was, steerable or not
  assert.throws(() => relayed(home, { steerable: true, sandbox: "workspace-write" }).load(), /not allowed: sandbox/);
  assert.throws(() => relayed(home, { steerable: true, hermetic: false }).load(), /not allowed: hermetic/);
});

test("a relay still cannot make a request a session: session, idleTtlSec and friends stay refused next to steerable", (t) => {
  const home = makeHome(t);
  for (const field of [{ session: true }, { idleTtlSec: 60 }, { askOrchestrator: true }, { askTimeoutSec: 120 }]) {
    assert.throws(() => relayed(home, { steerable: true, ...field }).load(), /not allowed: .*(session|idleTtlSec|askOrchestrator|askTimeoutSec)/, JSON.stringify(field));
  }
  assert.ok(relayed(home, { steerable: true, session: false }).load().raw, "an explicit false is fine");
});

test("a relayed steerable request runs as a steerable job; its result is signed for exactly that request", async (t) => {
  const { home, env } = sessionHome(t);
  const task = "relayed\nFAKE_ANSWER=from the node";
  const signed = signedHeader(home, { tier: "light", kind: "verify", label: "lens: code", steerable: true, orphanAfterSec: 900 }, null, task, 5);
  await announce(env, signed, null, task);
  const started = await runCli(["start", "--framed", "-"], { env, input: frame(signed, null, task) });
  assert.equal(started.code, 3, started.stdout);
  assert.equal(started.json.steerable, true);
  const runId = started.json.runId;
  const state = readState(home, runId);
  assert.deepEqual([state.singleTurn, state.session, state.label], [true, true, "lens: code"]);
  const final = await wait(env, runId);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(final.json.text, "from the node");
  assert.equal(final.json.provenance.backend, "session");
  const key = ensureKey({ ULTRACODEX_HOME: home });
  const { requestDigest } = framedToRaw(parseFramed(frame(signed, null, task)), { key });
  assert.equal(final.json.mac, resultMac(key, runId, requestDigest, "text", "from the node"), "the digest of the signed header, steerable included");
  // the stored request is the signed one: steerable is part of what was announced
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "runs", runId, "request.json"), "utf8")).steerable, true);
  // a second upload of the same signed request joins the run: still one job
  const again = await runCli(["start", "--framed", "-"], { env, input: frame(signed, null, task) });
  assert.equal(again.json.runId, runId);
});

// ── the helper against the real runner ──

const helperSource = () => fs.readFileSync(path.join(ROOT, "tools", "src", "helper.js"), "utf8");

// What the relay agent does, against the real runner: uploads the START prompt's parts with the `part` command
// and polls with `wait`; the key agent runs `key` and `expect`.
function realAgent(env, seen = []) {
  const lastLine = (out) => out.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const waitFor = async (runId) => {
    let out = null;
    for (let round = 0; round < 40; round += 1) {
      out = await runCli(["wait", runId, "--max-wait", "5"], { env, timeoutMs: 60_000 });
      if (out.json && out.json.ok !== null) break;
    }
    return out.stdout;
  };
  return async (prompt, opts) => {
    seen.push({ prompt: prompt.split("\n")[0], agentType: opts.agentType });
    if (prompt === "ULTRACODEX KEY") return lastLine(await runCli(["key"], { env }));
    if (prompt.startsWith("ULTRACODEX EXPECT")) return lastLine(await runCli(["expect", /DIGEST: ([0-9a-f]{64})/.exec(prompt)[1]], { env }));
    if (prompt.startsWith("ULTRACODEX COLLECT")) return waitFor(/RUN_ID: (\S+)/.exec(prompt)[1]);
    assert.ok(prompt.startsWith("ULTRACODEX START"), prompt.slice(0, 40));
    assert.equal(opts.agentType, RELAY);
    const lines = prompt.split("\n");
    const delimiter = lines.find((line) => line.startsWith("DELIMITER: ")).slice("DELIMITER: ".length);
    const total = Number(lines.find((line) => line.startsWith("PARTS: ")).slice("PARTS: ".length));
    const parts = [];
    let current = null;
    for (const line of lines) {
      const open = new RegExp(`^=====${delimiter} PART (\\d+)/(\\d+) ([0-9a-f]{8}) (\\d+) LINES=====$`).exec(line);
      if (open) {
        current = { hash: open[3], lines: [] };
        continue;
      }
      if (line === `=====${delimiter} END=====`) {
        parts.push(current);
        current = null;
      } else if (current) current.lines.push(line);
    }
    assert.equal(parts.length, total);
    let upload = "new";
    let out = null;
    for (const [index, part] of parts.entries()) {
      out = await runCli(["part", upload, String(index + 1), String(total), part.hash], { env, input: part.lines.join("\n") + "\n" });
      if (upload === "new") upload = out.json.upload;
    }
    if (!out.json?.runId) return out.stdout;
    return waitFor(out.json.runId);
  };
}

async function runHelper(agent, body) {
  const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", `${helperSource()}\n${body}`);
  return fn(agent, (thunks) => Promise.all(thunks.map((thunk) => thunk())), null, () => {}, () => {}, undefined);
}

test("codexNode against the real runner: a steerable node's result passes the helper's hash, signature and provenance checks", async (t) => {
  const { home, env } = sessionHome(t);
  const seen = [];
  const result = await runHelper(realAgent(env, seen), `return codexNode('Is it fine?', { schemaPreset: 'verdict', tier: 'light', kind: 'verify', label: 'lens: code' })`);
  assert.equal(typeof result.refuted, "boolean", JSON.stringify(result));
  const prov = result._codex;
  assert.deepEqual([prov.backend, prov.steers, prov.attempts, prov.model, prov.tier], ["session", 0, 1, "gpt-6-luna", "light"]);
  assert.match(prov.threadId, /^01a0fake-/);
  assert.ok(prov.usage.output_tokens > 0 && prov.runId);
  // the run is the steerable one: the header the helper signed carried the field
  const request = JSON.parse(fs.readFileSync(path.join(home, "runs", prov.runId, "request.json"), "utf8"));
  assert.equal(request.steerable, true);
  assert.equal(readState(home, prov.runId).singleTurn, true);
  assert.ok(seen.some((entry) => entry.agentType === KEY_AGENT));
});

test("codexNode with steerable: false runs on exec, and the result passes the same checks", async (t) => {
  const { home, env } = sessionHome(t);
  const result = await runHelper(realAgent(env), `return codexNode('Is it fine?', { schemaPreset: 'verdict', tier: 'light', kind: 'verify', steerable: false })`);
  assert.equal(typeof result.refuted, "boolean", JSON.stringify(result));
  assert.deepEqual([result._codex.backend, result._codex.steers, result._codex.attempts], ["exec", 0, 1]);
  const request = JSON.parse(fs.readFileSync(path.join(home, "runs", result._codex.runId, "request.json"), "utf8"));
  assert.equal(request.steerable, false, "not in the header: the runner's default");
  assert.equal(readState(home, result._codex.runId).session, undefined);
});

test("codexNode: a node that was steered reports its steers; a batch node passes the option through", async (t) => {
  const { home, env } = sessionHome(t);
  const agent = realAgent(env);
  // steer the node as soon as it runs: the stub relay is busy polling, so a second process plays the owner
  const steerer = (async () => {
    for (let round = 0; round < 200; round += 1) {
      const runs = fs.existsSync(path.join(home, "runs")) ? fs.readdirSync(path.join(home, "runs")) : [];
      for (const runId of runs) {
        const state = readState(home, runId);
        if (state.singleTurn && state.state === "running" && state.label === "steered node") {
          const out = await runCli(["send", runId, "--message", "check the tests too", "--mode", "steer"], { env });
          if (out.json?.outcome === "steered") return out.json;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  })();
  const text = await runHelper(agent, `return codexNode('Say hello\\nFAKE_WAIT_STEER=1\\nFAKE_ANSWER=hello', { tier: 'light', kind: 'ask', label: 'steered node' })`);
  assert.equal((await steerer)?.outcome, "steered");
  assert.equal(typeof text, "string");
  assert.match(text, /^hello steered: \["check the tests too"\]$/);
  const batch = await runHelper(agent, `return codexBatchNode('Check each.', [{ id: 'a' }, { id: 'b' }], { tier: 'light', label: 'batch' })`);
  // the fake answers a batch with no entries: incomplete, not an error — and the node ran steerable like any other
  assert.deepEqual([batch.complete, batch.missing], [false, ["a", "b"]], JSON.stringify(batch));
  assert.deepEqual([batch._codex.backend, batch._codex.steers], ["session", 0]);
});
