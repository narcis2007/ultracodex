import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FRAME_SCHEMA_MARK,
  FRAME_TASK_MARK,
  POLICY,
  SCHEMA_PRESETS,
  buildCodexArgs,
  checkStrictSchema,
  classifyFailure,
  computeDeadlineSec,
  fnv1a,
  framedToRaw,
  normalizeText,
  parseApiError,
  parseCatalog,
  parseFramed,
  policyTable,
  readUserWindowsSandbox,
  resolveCodexLauncher,
  resolvePolicy,
  schemaHash,
  summarizeEvents,
  validateRequest,
  validateValue,
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

test("framed requests round-trip and reject a corrupted copy", () => {
  const task = "Verify:\n  line with `backticks`, $(sub) and C:\\path\\x\n" + FRAME_TASK_MARK + " inside the task is fine";
  const schema = SCHEMA_PRESETS.verdict;
  const header = { v: 1, kind: "verify", taskHash: fnv1a(normalizeText(task)), schemaHash: schemaHash(schema) };
  const framed = [JSON.stringify(header), FRAME_SCHEMA_MARK, JSON.stringify(schema), FRAME_TASK_MARK, task].join("\n");
  const raw = framedToRaw(parseFramed(framed));
  assert.equal(raw.task, task);
  assert.deepEqual(raw.schema, schema);
  assert.equal(raw.taskHash, undefined);
  assert.throws(() => framedToRaw(parseFramed(framed.replace("backticks", "backtick"))), (error) => error.kind === "relay_corruption");
  assert.throws(() => parseFramed("not json\n" + FRAME_SCHEMA_MARK), (error) => error.kind === "relay_corruption");
  assert.throws(() => parseFramed(JSON.stringify(header) + "\nno markers"), (error) => error.kind === "relay_corruption");
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
