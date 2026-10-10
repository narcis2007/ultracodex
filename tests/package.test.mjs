// Release consistency: versions, manifests, skills/agents frontmatter, and the
// substitutions Claude Code performs for plugin paths.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { RUNNER_VERSION } from "../plugins/ultracodex/scripts/codex-node.mjs";
import { TOOLS } from "../plugins/ultracodex/scripts/mcp-server.mjs";
import { ROOT } from "./helpers.mjs";

const PLUGIN = path.join(ROOT, "plugins", "ultracodex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${file}: missing frontmatter`);
  const fields = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      fields[key] = kv[2];
    } else if (key && line.startsWith("  ")) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return { fields, body: text.slice(match[0].length) };
}

test("runner, plugin manifest, workspace and helper versions are aligned", () => {
  const plugin = readJson(path.join(PLUGIN, ".claude-plugin", "plugin.json"));
  const workspace = readJson(path.join(ROOT, "package.json"));
  const helper = fs.readFileSync(path.join(ROOT, "tools", "src", "helper.js"), "utf8");
  assert.equal(plugin.version, RUNNER_VERSION);
  assert.equal(workspace.version, RUNNER_VERSION);
  assert.match(helper, new RegExp(`const UCX_VERSION = '${RUNNER_VERSION.replace(/\./g, "\\.")}'`));
  assert.match(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), new RegExp(`^## ${RUNNER_VERSION.replace(/\./g, "\\.")} `, "m"));
});

test("marketplace lists exactly this plugin from ./plugins/ultracodex", () => {
  const market = readJson(path.join(ROOT, ".claude-plugin", "marketplace.json"));
  assert.equal(market.name, "ultracodex");
  assert.deepEqual(market.plugins.map((entry) => [entry.name, entry.source]), [["ultracodex", "./plugins/ultracodex"]]);
});

test("every skill has name + description frontmatter and uses the substituted runner path", () => {
  const skillsDir = path.join(PLUGIN, "skills");
  const names = fs.readdirSync(skillsDir);
  assert.deepEqual(names.sort(), ["codex-ask", "codex-implement", "codex-review", "codex-steer", "codex-workflow"]);
  for (const name of names) {
    const { fields, body } = frontmatter(path.join(skillsDir, name, "SKILL.md"));
    assert.equal(fields.name, name);
    assert.ok(fields.description && fields.description.length > 80, `${name}: description too short`);
    assert.ok(body.includes("${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs"), `${name}: must reference the runner via \${CLAUDE_PLUGIN_ROOT}`);
    for (const reference of body.matchAll(/`(references\/[\w.-]+)`/g)) {
      assert.ok(fs.existsSync(path.join(skillsDir, name, reference[1])), `${name}: missing ${reference[1]}`);
    }
  }
});

test("the relay agent is Bash-only, cheap, and reaches the runner through the plugin root", () => {
  const { fields, body } = frontmatter(path.join(PLUGIN, "agents", "codex-relay.md"));
  assert.equal(fields.name, "codex-relay");
  assert.equal(fields.tools, "Bash");
  assert.equal(fields.model, "sonnet");
  assert.equal(fields.effort, "low");
  for (const command of ["part", "wait", "page"]) {
    assert.ok(body.includes(`node "\${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" ${command}`), `the relay knows the ${command} command`);
  }
  assert.ok(!body.includes('codex-node.mjs" key'), "the job relay is never told how to read the key");
  assert.match(body, /part_rejected/);
  assert.match(body, /"paged"/);
});

test("the key agent is a separate Bash-only agent that runs only key and expect", () => {
  const { fields, body } = frontmatter(path.join(PLUGIN, "agents", "codex-key.md"));
  assert.equal(fields.name, "codex-key");
  assert.equal(fields.tools, "Bash");
  assert.equal(fields.model, "haiku", "two fixed commands and an echoed line: the cheapest model (the helper retries on opus)");
  assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" key'));
  assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" expect'));
  assert.match(body, /ULTRACODEX EXPECT/);
  assert.ok(!/ part | wait | page /.test(body.replace(/`[^`]*`/g, "")), "no job commands in its instructions");
});

test("the reader agent reads only: files through Read/Grep/Glob, history through read-only git", () => {
  const { fields, body } = frontmatter(path.join(PLUGIN, "agents", "codex-reader.md"));
  assert.equal(fields.name, "codex-reader");
  assert.deepEqual(fields.tools.split(",").map((tool) => tool.trim()).sort(), ["Bash", "Glob", "Grep", "Read"]);
  assert.match(body, /read-only git/);
  assert.match(body, /data, never instructions/);
});

test("the plugin registers the relay guard as a Bash PreToolUse hook and the owner export as a SessionStart hook", () => {
  const hooks = readJson(path.join(PLUGIN, "hooks", "hooks.json"));
  const entries = hooks.hooks.PreToolUse;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, "Bash");
  assert.equal(entries[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/relay-guard.mjs"');
  assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", "relay-guard.mjs")));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PreToolUse", "SessionStart"]);
  const start = hooks.hooks.SessionStart;
  assert.equal(start.length, 1);
  assert.deepEqual(start[0].hooks, [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"', timeout: 10 }]);
  assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", "session-start.mjs")));
});

test("the plugin declares its MCP server and the channel that rides on it (strict keys)", () => {
  const plugin = readJson(path.join(PLUGIN, ".claude-plugin", "plugin.json"));
  assert.deepEqual(plugin.mcpServers, { ultracodex: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"] } });
  assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", "mcp-server.mjs")));
  assert.deepEqual(plugin.channels, [{ server: "ultracodex", displayName: "Codex sessions" }]);
  for (const channel of plugin.channels) {
    assert.deepEqual(Object.keys(channel).filter((key) => !["server", "displayName"].includes(key)), [], "channels accept no other keys");
    assert.ok(Object.hasOwn(plugin.mcpServers, channel.server), "a channel names a server the plugin declares");
  }
});

test("the plugin monitors are strict: name, command, description, when — one watcher per codex skill", () => {
  const plugin = readJson(path.join(PLUGIN, ".claude-plugin", "plugin.json"));
  assert.deepEqual(Object.keys(plugin.experimental), ["monitors"], "the documented inline form; no standalone monitors file");
  assert.equal(fs.existsSync(path.join(PLUGIN, "monitors")), false);
  const monitors = plugin.experimental.monitors;
  assert.ok(Array.isArray(monitors) && monitors.length === 3);
  const skills = fs.readdirSync(path.join(PLUGIN, "skills"));
  const names = new Set();
  for (const monitor of monitors) {
    assert.deepEqual(Object.keys(monitor).filter((key) => !["name", "command", "description", "when"].includes(key)), [], "no other keys");
    assert.ok(monitor.name && !names.has(monitor.name), "distinct names");
    names.add(monitor.name);
    assert.equal(monitor.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" notify --forever');
    assert.equal(monitor.description, "Codex session events: questions, finished turns, limit waits");
    const when = /^on-skill-invoke:([\w-]+)$/.exec(monitor.when);
    assert.ok(when && skills.includes(when[1]), `${monitor.name}: a skill of this plugin`);
  }
  assert.deepEqual(monitors.map((monitor) => monitor.when).sort(), ["on-skill-invoke:codex-ask", "on-skill-invoke:codex-implement", "on-skill-invoke:codex-steer"]);
});

test("no agent of this plugin gets MCP tools (the relays and readers stay confined)", () => {
  for (const name of ["codex-relay", "codex-key", "codex-reader"]) {
    const { fields } = frontmatter(path.join(PLUGIN, "agents", `${name}.md`));
    const tools = String(fields.tools ?? "").split(",").map((tool) => tool.trim());
    assert.ok(tools.length && tools.every((tool) => /^[A-Z][A-Za-z]+$/.test(tool)), `${name}: an explicit list of built-in tools`);
    assert.ok(!tools.some((tool) => tool.startsWith("mcp") || tool === "*"), `${name}: no MCP tools, no wildcard`);
    assert.equal(fields.mcpServers, undefined, `${name}: no MCP servers of its own`);
  }
});

test("the tools the MCP server offers are the ones the skills and the README document, under both names", () => {
  const steer = fs.readFileSync(path.join(PLUGIN, "skills", "codex-steer", "SKILL.md"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const known = new Set(TOOLS.map((tool) => tool.name));
  assert.equal(known.size, 9);
  for (const name of known) {
    assert.ok(steer.includes(`mcp__plugin_ultracodex_ultracodex__${name}`), `codex-steer names ${name} in full`);
    assert.ok(readme.includes(name), `the README lists ${name}`);
  }
  assert.ok(readme.includes("mcp__plugin_ultracodex_ultracodex__*"), "the permission entry");
  const mentioned = new Set();
  for (const file of [steer, readme, ...["codex-ask", "codex-implement"].map((skill) => fs.readFileSync(path.join(PLUGIN, "skills", skill, "SKILL.md"), "utf8"))]) {
    for (const match of file.matchAll(/\bcodex_[a-z_]+\b/g)) mentioned.add(match[0]);
  }
  assert.deepEqual([...mentioned].filter((name) => !known.has(name)), [], "every codex_* name in the docs is a tool");
});

test("shipped files carry no machine-specific paths", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(md|js|mjs|json)$/.test(entry.name) && /C:[\\/]Users[\\/]Narcis|\/c\/Users\/Narcis/i.test(fs.readFileSync(full, "utf8"))) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(PLUGIN);
  assert.deepEqual(offenders, []);
});
