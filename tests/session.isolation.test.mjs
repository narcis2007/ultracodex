// Verified isolation of a hermetic app-server (0.6.0). `codex app-server` has no --ignore-user-config, so
// before any thread starts the driver asks it `config/read` and judges, from the effective config and the
// origin of every key, whether anything of the user's (or a project's) configuration is left that could change
// what the model sees or can do. isolationViolations is the pure judgement; the rest is how the driver
// acts on it (the fake app-server answers config/read, see FAKE_CODEX_CONFIG_READ in fake-codex.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import { isolationViolations } from "../plugins/ultracodex/scripts/session.mjs";
import { eventually, pidAlive, runCli } from "./helpers.mjs";
import { hasResult, requests, sessionEvents, sessionHome, spawns, startSession, wait } from "./helpers-session.mjs";

const flags = { name: { type: "sessionFlags" }, version: "v" };
const user = { name: { type: "user", file: "C:\\u\\.codex\\config.toml" }, version: "v" };
const project = { name: { type: "project", dotCodexFolder: "C:\\work\\.codex" }, version: "v" };
const layer = (type) => ({ name: { type }, version: "v" });
const readOnly = { sandbox: "read-only" };
const writable = { sandbox: "workspace-write" };

// A real owner's config as the app-server reports it for a hermetic spawn: user-origin settings of every
// harmless kind, the flags' own keys as sessionFlags, and an enabled-false MCP server whose other keys are the user's.
function ownerLike() {
  const config = {
    approval_policy: "on-request",
    approvals_reviewer: "auto_review",
    model: "owner-model",
    model_reasoning_effort: "xhigh",
    service_tier: "default",
    sandbox_mode: "workspace-write",
    notify: [],
    features: { plugins: false, apps: false },
    windows: { sandbox: "elevated" },
    mcp_servers: { docs: { command: "node", args: ["x.js"], enabled: false }, "beta.gamma": { url: "https://x", enabled: false } },
    plugins: { "a@market": { enabled: true } },
  };
  const origins = {
    approval_policy: user, approvals_reviewer: user, model: user, model_reasoning_effort: user, service_tier: flags, sandbox_mode: user,
    notify: flags, "notify.0": user, "notify.1": user,
    "features.plugins": flags, "features.apps": flags,
    "windows.sandbox": user,
    "plugins.a@market.enabled": user,
    "mcp_servers.docs.command": user, "mcp_servers.docs.args.0": user, "mcp_servers.docs.enabled": flags,
    "mcp_servers.beta.gamma.url": user, "mcp_servers.beta.gamma.enabled": flags,
    "projects.C:\\work\\repo.trust_level": user, "tui.theme": user, "tui.notifications": user, "desktop.sidebar": user,
    "notice.hide_full_access_warning": user, "marketplaces.main.source": user, "profiles.fast.model": user,
    "history.persistence": user, "analytics.enabled": user, "feedback.enabled": user,
    file_opener: user, check_for_update_on_startup: user, disable_paste_burst: user, hide_agent_reasoning: user, suppress_unstable_features_warning: user,
    "sandbox_workspace_write.exclude_slash_tmp": user,
    // layers that apply to exec as well
    "model_providers.corp.name": layer("system"), "hooks.pre": layer("enterpriseManaged"), web_search: layer("packagedDefaults"), tools: layer("mdm"),
    "otel.exporter": layer("legacyManagedConfigTomlFromFile"), "shell_environment_policy.inherit": layer("legacyManagedConfigTomlFromMdm"),
  };
  return { config, origins };
}
const judged = (mutate, request = readOnly) => {
  const read = ownerLike();
  mutate(read);
  return isolationViolations(read, { request });
};

test("isolationViolations: an owner-like config — inert, neutralized, driver-owned, carried — is isolated", () => {
  assert.deepEqual(isolationViolations(ownerLike(), { request: readOnly }), { ok: true, keys: [] });
  // the same with nothing but session flags and defaults
  assert.deepEqual(isolationViolations({ config: {}, origins: { model: layer("packagedDefaults"), notify: flags } }, { request: readOnly }), { ok: true, keys: [] });
  // an empty origins map is a clean config
  assert.deepEqual(isolationViolations({ config: {}, origins: {} }, { request: readOnly }), { ok: true, keys: [] });
});

test("isolationViolations: each setting that would change what the model sees or can do is a violation, named without its value", () => {
  const cases = [
    ["developer_instructions", (read) => ((read.config.developer_instructions = "SECRET-VALUE"), (read.origins.developer_instructions = user))],
    ["instructions", (read) => ((read.config.instructions = "SECRET-VALUE"), (read.origins.instructions = user))],
    ["model_instructions_file", (read) => (read.origins.model_instructions_file = user)],
    ["model_provider", (read) => ((read.config.model_provider = "SECRET-VALUE"), (read.origins.model_provider = user))],
    ["model_providers.corp.base_url", (read) => (read.origins["model_providers.corp.base_url"] = user)],
    ["profile", (read) => ((read.config.profile = "SECRET-VALUE"), (read.origins.profile = user))],
    ["shell_environment_policy.inherit", (read) => ((read.config.shell_environment_policy = { inherit: "all" }), (read.origins["shell_environment_policy.inherit"] = user))],
    ["features.memories", (read) => ((read.config.features.memories = true), (read.origins["features.memories"] = user))],
    ["features.js_repl", (read) => (read.origins["features.js_repl"] = project)],
    ["hooks.pre_tool_use", (read) => (read.origins["hooks.pre_tool_use"] = user)],
    ["tools.web_search", (read) => (read.origins["tools.web_search"] = user)],
    ["web_search", (read) => (read.origins.web_search = user)],
    ["model_verbosity", (read) => (read.origins.model_verbosity = user)],
    ["model_reasoning_summary", (read) => (read.origins.model_reasoning_summary = user)],
    ["otel.exporter", (read) => (read.origins["otel.exporter"] = user)],
    ["skills.config", (read) => (read.origins["skills.config"] = user)],
    ["compact_prompt", (read) => (read.origins.compact_prompt = project)],
    ["model_context_window", (read) => (read.origins.model_context_window = user)],
  ];
  for (const [key, mutate] of cases) {
    const verdict = judged(mutate);
    assert.equal(verdict.ok, false, key);
    assert.deepEqual(verdict.keys, [key], key);
    assert.doesNotMatch(JSON.stringify(verdict), /SECRET-VALUE/, "values are never reported");
  }
  // a setting from a project layer is judged like the user's own, whatever its name
  assert.deepEqual(judged((read) => (read.origins.web_search = project)).keys, ["web_search"]);
  assert.equal(judged((read) => (read.origins.tui_like_but_not = project)).ok, false, "only the listed prefixes are inert");
  assert.equal(judged((read) => (read.origins["tuix.theme"] = user)).ok, false, "a prefix is a table, not a spelling");
});

test("isolationViolations: MCP servers, plugins, apps and notify are neutralized only by their effective value", () => {
  // a server that is NOT disabled: its command is the user's
  assert.deepEqual(judged((read) => { read.config.mcp_servers.live = { command: "node" }; read.origins["mcp_servers.live.command"] = user; }).keys, ["mcp_servers.live.command"]);
  assert.deepEqual(judged((read) => { read.config.mcp_servers.live = { command: "node", enabled: true }; read.origins["mcp_servers.live.command"] = user; read.origins["mcp_servers.live.enabled"] = user; }).keys, ["mcp_servers.live.command", "mcp_servers.live.enabled"]);
  // a project layer that enables a server and wins
  assert.deepEqual(judged((read) => { read.config.mcp_servers.docs.enabled = true; read.origins["mcp_servers.docs.enabled"] = project; }).keys, ["mcp_servers.docs.args.0", "mcp_servers.docs.command", "mcp_servers.docs.enabled"], "the project layer enabled it: the user's command and args now run");
  // a key of a server the effective config does not even have cannot be proven harmless
  assert.deepEqual(judged((read) => { read.origins["mcp_servers.ghost.command"] = user; }).keys, ["mcp_servers.ghost.command"]);
  // a server name that contains dots: the longest effective name decides
  assert.equal(judged((read) => { read.origins["mcp_servers.beta.gamma.command"] = user; }).ok, true);
  assert.equal(judged((read) => { read.config.mcp_servers["beta.gamma"].enabled = true; read.origins["mcp_servers.beta.gamma.command"] = user; }).ok, false);
  // the table itself
  assert.equal(judged((read) => { read.origins.mcp_servers = user; }).ok, true, "every server is disabled");
  assert.equal(judged((read) => { read.origins.mcp_servers = user; read.config.mcp_servers.live = { command: "x" }; }).ok, false);
  // plugins and apps: only while the feature is off
  assert.deepEqual(judged((read) => { delete read.config.features.plugins; }).keys, ["plugins.a@market.enabled"]);
  assert.deepEqual(judged((read) => { read.config.features.plugins = true; }).keys, ["plugins.a@market.enabled"]);
  assert.deepEqual(judged((read) => { read.origins["apps.github.enabled"] = user; }).keys, []);
  assert.deepEqual(judged((read) => { read.origins["apps.github.enabled"] = user; read.config.features.apps = true; }).keys, ["apps.github.enabled"]);
  // notify: the effective hook list decides, not the (stale) origins of its elements
  assert.equal(judged((read) => { read.config.notify = ["hook.exe"]; read.origins.notify = user; }).ok, false);
  assert.deepEqual(judged((read) => { read.config.notify = ["hook.exe"]; read.origins.notify = user; }).keys, ["notify", "notify.0", "notify.1"]);
  assert.equal(judged((read) => { delete read.config.notify; }).ok, true, "absent is empty");
});

test("isolationViolations: the sandbox_workspace_write keys are ours only for a workspace-write request, and only the two passed with -c", () => {
  const extra = (read) => (read.origins["sandbox_workspace_write.exclude_slash_tmp"] = user);
  assert.equal(judged(extra, readOnly).ok, true, "inert for a read-only sandbox");
  assert.deepEqual(judged(extra, writable).keys, ["sandbox_workspace_write.exclude_slash_tmp"]);
  const owned = (read) => {
    read.origins["sandbox_workspace_write.network_access"] = user;
    read.origins["sandbox_workspace_write.writable_roots"] = user;
    read.origins["sandbox_workspace_write.writable_roots.0"] = user;
    delete read.origins["sandbox_workspace_write.exclude_slash_tmp"];
  };
  assert.equal(judged(owned, writable).ok, true, "overridden by the flags");
  assert.deepEqual(judged((read) => { owned(read); read.origins["sandbox_workspace_write.exclude_tmpdir_env_var"] = user; }, writable).keys, ["sandbox_workspace_write.exclude_tmpdir_env_var"]);
  const unknown = ownerLike();
  unknown.origins["sandbox_workspace_write.exclude_slash_tmp"] = user;
  assert.deepEqual(isolationViolations(unknown).keys, ["sandbox_workspace_write.exclude_slash_tmp"], "a request that is not provably read-only is judged as a writing one");
  assert.equal(judged((read) => { read.origins.windows = user; }).ok, false, "only windows.sandbox is carried on purpose");
  assert.equal(judged((read) => { read.origins["windows.sandbox_private_desktop"] = user; }).ok, false);
});

test("isolationViolations: an origin it cannot read, or none at all, is unverifiable — never ok", () => {
  const unverifiable = { ok: false, keys: ["<unverifiable>"] };
  for (const read of [undefined, null, {}, { config: {} }, { config: {}, origins: null }, { config: {}, origins: "nope" }, { config: {}, origins: [] }, "text", 7]) {
    assert.deepEqual(isolationViolations(read, { request: readOnly }), unverifiable, JSON.stringify(read));
  }
  assert.deepEqual(judged((read) => { read.origins.mystery = {}; }).keys, ["mystery"], "an origin without a layer type cannot be judged");
  assert.deepEqual(judged((read) => { read.origins.mystery = { name: "user" }; }).keys, ["mystery"]);
  assert.deepEqual(judged((read) => { read.origins.mystery = null; }).keys, ["mystery"]);
});

test("isolationViolations: keys are deduplicated, sorted, and kept to about 20", () => {
  const many = { config: {}, origins: {} };
  for (let index = 30; index >= 1; index -= 1) many.origins[`zz.key${String(index).padStart(2, "0")}`] = user;
  const verdict = isolationViolations(many, { request: readOnly });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.keys.length, 20);
  assert.deepEqual(verdict.keys, [...verdict.keys].sort());
  assert.equal(verdict.keys[0], "zz.key01");
  assert.equal(verdict.more, 10);
  const small = isolationViolations({ config: {}, origins: { b: user, a: project } }, { request: readOnly });
  assert.deepEqual(small, { ok: false, keys: ["a", "b"] });
});

// ── the driver ──

const READ = "config/read";

test("a hermetic session asks config/read before it starts a thread; an owner-like config passes", async (t) => {
  const { home, env, calls } = sessionHome(t, { FAKE_CODEX_CONFIG_READ: "owner" });
  const runId = await startSession(env, home, { task: "owner\nFAKE_ANSWER=fine", tier: "light" });
  const out = await wait(env, runId);
  assert.equal(out.code, 0, out.stdout);
  const methods = requests(calls()).map((entry) => entry.method);
  assert.ok(methods.indexOf(READ) > methods.indexOf("initialized") && methods.indexOf(READ) < methods.indexOf("thread/start"), methods.join());
  assert.deepEqual(requests(calls(), READ)[0].params, { cwd: process.cwd(), includeLayers: false });
  assert.equal(requests(calls(), READ).length, 1);
});

test("a leak from the user's config: hermetic_violation naming the keys, no thread, the app-server stopped", async (t) => {
  for (const [mode, keys] of [
    ["leak:developer_instructions", ["developer_instructions"]],
    ["leak:model_provider,shell_environment_policy.inherit", ["model_provider", "shell_environment_policy.inherit"]],
    ["leak-project:web_search", ["web_search"]],
  ]) {
    const { home, env, calls } = sessionHome(t, { FAKE_CODEX_CONFIG_READ: mode });
    const runId = await startSession(env, home, { task: "must not run", tier: "light" });
    const out = await wait(env, runId);
    assert.equal(out.code, 1, out.stdout);
    assert.deepEqual([out.json.ok, out.json.state, out.json.error.kind, out.json.error.retryable], [false, "failed", "hermetic_violation", false], mode);
    for (const key of keys) assert.ok(out.json.error.message.includes(key), `${mode}: the message names ${key}`);
    assert.doesNotMatch(out.stdout, /leaked-value-must-not-print/, "never a value");
    assert.equal(requests(calls(), "thread/start").length, 0, "no thread was started");
    assert.equal(requests(calls(), "turn/start").length, 0);
    assert.equal(requests(calls(), "mcpServerStatus/list").length, 0, "the first check failed already");
    const event = sessionEvents(home, runId).find((entry) => entry.type === "hermetic_violation");
    assert.deepEqual(event.keys, keys, mode);
    assert.equal(hasResult(home, runId), true, "the session ended for good");
    assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), "the app-server was stopped");
    assert.equal((await runCli(["send", runId, "--message", "x"], { env })).json.reason, "session_ended");
  }
});

test("a config/read that cannot run — an error, a missing or malformed origins, a timeout — fails closed", async (t) => {
  for (const [mode, extra, why] of [
    ["error", {}, /config\/read failed: method not found/],
    ["missing", {}, /returned no readable origins/],
    ["malformed", {}, /returned no readable origins/],
    ["hang", { ULTRACODEX_CONFIG_READ_TIMEOUT_MS: "600" }, /did not answer within 600 ms/],
  ]) {
    const { home, env, calls } = sessionHome(t, { FAKE_CODEX_CONFIG_READ: mode, ...extra });
    const runId = await startSession(env, home, { task: "must not run", tier: "light" });
    const out = await wait(env, runId, 40);
    assert.equal(out.code, 1, `${mode}: ${out.stdout}`);
    assert.equal(out.json.error.kind, "hermetic_violation", mode);
    assert.match(out.json.error.message, /could not verify/, mode);
    assert.match(out.json.error.message, why, mode);
    assert.equal(requests(calls(), "thread/start").length, 0, mode);
    assert.deepEqual(sessionEvents(home, runId).find((entry) => entry.type === "hermetic_violation").keys, ["<unverifiable>"], mode);
    assert.ok(await eventually(() => !pidAlive(spawns(calls())[0].pid)), `${mode}: the app-server was stopped`);
  }
});

test("a session that is not hermetic is not checked", async (t) => {
  const { home, env, calls } = sessionHome(t, { FAKE_CODEX_CONFIG_READ: "leak:developer_instructions" });
  const runId = await startSession(env, home, { task: "open\nFAKE_ANSWER=ok", tier: "light", hermetic: false });
  const out = await wait(env, runId);
  assert.equal(out.code, 0, out.stdout);
  assert.equal(requests(calls(), READ).length, 0);
  const start = requests(calls(), "thread/start")[0].params;
  assert.equal(start.approvalsReviewer, undefined, "the user's own approvals reviewer applies as it is");
});

test("thread/start and thread/resume state the approvals reviewer; a revive is checked again, before the thread is resumed", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "a\nFAKE_ANSWER=a", tier: "light", idleTtlSec: 0, serviceTier: "priority" });
  assert.equal((await wait(env, runId)).code, 0);
  await eventually(() => sessionEvents(home, runId).some((event) => event.type === "dormant"));
  assert.equal(requests(calls(), "thread/start")[0].params.approvalsReviewer, "user");
  assert.equal(requests(calls(), "thread/start")[0].params.serviceTier, "priority");
  assert.ok(spawns(calls())[0].flags.includes('service_tier="priority"'));
  // the config changed meanwhile: a developer_instructions key in the user's file
  env.FAKE_CODEX_CONFIG_READ = "leak:developer_instructions";
  const ack = await runCli(["send", runId, "--message", "b\nFAKE_ANSWER=b"], { env });
  assert.equal(ack.json.outcome, "started");
  const out = await wait(env, runId);
  assert.equal(out.json.error.kind, "hermetic_violation", out.stdout);
  assert.equal(requests(calls(), READ).length, 2);
  assert.equal(requests(calls(), "thread/resume").length, 0, "the thread was not resumed on an app-server that is not isolated");
  assert.equal(requests(calls(), "turn/start").length, 1, "the second turn never started");
});

test("a revive with a clean config resumes the thread with the approvals reviewer stated", async (t) => {
  const { home, env, calls } = sessionHome(t);
  const runId = await startSession(env, home, { task: "a\nFAKE_ANSWER=a", tier: "light", idleTtlSec: 0 });
  assert.equal((await wait(env, runId)).code, 0);
  await eventually(() => sessionEvents(home, runId).some((event) => event.type === "dormant"));
  const ack = await runCli(["send", runId, "--message", "b\nFAKE_ANSWER=b"], { env });
  assert.equal(ack.json.outcome, "started");
  assert.equal((await wait(env, runId)).json.ok, true);
  const resume = requests(calls(), "thread/resume")[0];
  assert.deepEqual([resume.params.approvalsReviewer, resume.params.approvalPolicy, resume.params.sandbox], ["user", "never", "read-only"]);
  const onResumeServer = requests(calls()).filter((entry) => entry.pid === resume.pid).map((entry) => entry.method);
  assert.deepEqual(onResumeServer.slice(0, 4), ["initialize", "initialized", READ, "thread/resume"]);
});
