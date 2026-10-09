// Sessions, part 6: hermetic app-servers. `codex app-server` has no --ignore-user-config, so the
// runner disables every MCP server the user's config declares and then checks, before the first
// turn, that none of them reports a tool — failing closed when it cannot tell.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { eventually, pidAlive, runCli } from "./helpers.mjs";
import { hasResult, readJson, requests, runDir, sessionEvents, sessionHome, spawns, startSession, untilState, wait } from "./helpers-session.mjs";

const CONFIG = [
  'model = "x"',
  "[mcp_servers.alpha]",
  'command = "node"',
  "[mcp_servers.alpha.env]",
  'KEY = "v"',
  '[mcp_servers."beta.gamma"]',
  'url = "https://example.test"',
  "[windows]",
  'sandbox = "elevated"',
].join("\n");

const withConfig = (home) => fs.writeFileSync(path.join(home, "config.toml"), CONFIG);
const flagsOf = (calls) => spawns(calls)[0].flags;

test("a hermetic session disables every configured MCP server (bare and quoted names, not sub-tables), plugins, apps and notify", async (t) => {
  const { home, env, calls } = sessionHome(t, { FAKE_CODEX_MCP_SERVERS: JSON.stringify({ alpha: 3, "beta.gamma": 2 }) });
  withConfig(home);
  const runId = await startSession(env, home, { task: "hermetic\nFAKE_ANSWER=ok", tier: "light" });
  const out = await wait(env, runId);
  assert.equal(out.code, 0, out.stdout);
  const flags = flagsOf(calls());
  assert.deepEqual(flags.slice(0, 6), ["--disable", "plugins", "--disable", "apps", "-c", "notify=[]"]);
  const disables = flags.filter((flag) => flag.startsWith("mcp_servers."));
  assert.deepEqual(disables.sort(), ['mcp_servers."beta.gamma".enabled=false', "mcp_servers.alpha.enabled=false"]);
  assert.equal(flags.some((flag) => /alpha\.env/.test(flag)), false, "a sub-table is not a server");
  assert.equal(flags.includes('windows.sandbox="elevated"'), process.platform === "win32", "the Windows sandbox choice is carried over on Windows only");
  // the check ran before the first turn, and found everything disabled
  const methods = requests(calls()).map((entry) => entry.method);
  assert.ok(methods.indexOf("mcpServerStatus/list") > methods.indexOf("thread/start") && methods.indexOf("mcpServerStatus/list") < methods.indexOf("turn/start"));
});

test("hermetic: false adds no disables and runs no check", async (t) => {
  const { home, env, calls } = sessionHome(t, { FAKE_CODEX_MCP_SERVERS: JSON.stringify({ alpha: 3 }) });
  withConfig(home);
  const runId = await startSession(env, home, { task: "open\nFAKE_ANSWER=ok", tier: "light", hermetic: false });
  const out = await wait(env, runId);
  assert.equal(out.code, 0, out.stdout);
  assert.deepEqual(flagsOf(calls()), [], "no flags at all (the user's config applies as it is)");
  assert.equal(requests(calls(), "mcpServerStatus/list").length, 0);
  assert.equal(out.json.provenance.hermetic, false);
});

test("a server that still reports tools: hermetic_violation, the app-server stopped, no turn started", async (t) => {
  // "rogue" ignores its disable flag (a sticky server); "docs" is not in the config, so nothing disabled it
  for (const [servers, named] of [
    [{ rogue: { tools: 2, sticky: true } }, ["rogue"]],
    [{ docs: 3, quiet: 0 }, ["docs"]],
  ]) {
    const { home, env, calls } = sessionHome(t, { FAKE_CODEX_MCP_SERVERS: JSON.stringify(servers) });
    fs.writeFileSync(path.join(home, "config.toml"), "[mcp_servers.rogue]\ncommand = \"x\"\n");
    const runId = await startSession(env, home, { task: "must not run", tier: "light" });
    const out = await wait(env, runId);
    assert.equal(out.code, 1, out.stdout);
    assert.deepEqual([out.json.ok, out.json.state, out.json.error.kind], [false, "failed", "hermetic_violation"]);
    for (const name of named) assert.match(out.json.error.message, new RegExp(name));
    assert.equal(requests(calls(), "turn/start").length, 0, "no turn was started");
    assert.deepEqual(sessionEvents(home, runId).find((event) => event.type === "hermetic_violation").servers, named);
    assert.equal(hasResult(home, runId), true, "the session ended for good");
    assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), "the app-server was stopped");
    assert.equal((await runCli(["send", runId, "--message", "x"], { env })).json.reason, "session_ended");
  }
});

test("the check follows nextCursor; a check that cannot run fails closed", async (t) => {
  {
    const { home, env, calls } = sessionHome(t, { FAKE_CODEX_MCP_SERVERS: JSON.stringify({ a: 0, b: { tools: 1, sticky: true } }), FAKE_CODEX_MCP_PAGES: "1" });
    const runId = await startSession(env, home, { task: "x", tier: "light" });
    const out = await wait(env, runId);
    assert.equal(out.json.error.kind, "hermetic_violation");
    assert.match(out.json.error.message, /\bb\b/);
    assert.deepEqual(requests(calls(), "mcpServerStatus/list").map((entry) => entry.params), [{}, { cursor: "1" }]);
  }
  {
    const { home, env, calls } = sessionHome(t, { FAKE_CODEX_MCP_ERROR: "1" });
    const runId = await startSession(env, home, { task: "x", tier: "light" });
    const out = await wait(env, runId);
    assert.equal(out.json.error.kind, "hermetic_violation");
    assert.match(out.json.error.message, /could not verify/);
    assert.equal(requests(calls(), "turn/start").length, 0);
  }
});

test("a revive runs the check again, before its turn; a violation then ends the session", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "a\nFAKE_ANSWER=a", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, runId)).code, 0);
  assert.ok(await untilState(home, runId, "dormant"));
  assert.equal(requests(calls(), "mcpServerStatus/list").length, 1);
  // the config changed meanwhile: a server that cannot be switched off
  env.FAKE_CODEX_MCP_SERVERS = JSON.stringify({ rogue: { tools: 1, sticky: true } });
  const ack = await runCli(["send", runId, "--message", "b\nFAKE_ANSWER=b"], { env });
  assert.equal(ack.json.outcome, "started");
  const out = await wait(env, runId);
  assert.equal(out.json.error.kind, "hermetic_violation", out.stdout);
  assert.equal(requests(calls(), "mcpServerStatus/list").length, 2);
  assert.equal(requests(calls(), "turn/start").length, 1, "the second turn never started");
  assert.equal(readJson(path.join(runDir(home, runId), "result.json")).state, "failed");
});
