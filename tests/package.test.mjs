// Release consistency: versions, manifests, skills/agents frontmatter, and the
// substitutions Claude Code performs for plugin paths.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { RUNNER_VERSION } from "../plugins/ultracodex/scripts/codex-node.mjs";
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
  assert.deepEqual(names.sort(), ["codex-ask", "codex-implement", "codex-review", "codex-workflow"]);
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

test("the key agent is a separate Bash-only agent that runs only the key command", () => {
  const { fields, body } = frontmatter(path.join(PLUGIN, "agents", "codex-key.md"));
  assert.equal(fields.name, "codex-key");
  assert.equal(fields.tools, "Bash");
  assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" key'));
  assert.ok(!/ part | wait | page /.test(body.replace(/`[^`]*`/g, "")), "no job commands in its instructions");
});

test("the plugin registers the relay guard as a Bash PreToolUse hook", () => {
  const hooks = readJson(path.join(PLUGIN, "hooks", "hooks.json"));
  const entries = hooks.hooks.PreToolUse;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, "Bash");
  assert.equal(entries[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/relay-guard.mjs"');
  assert.ok(fs.existsSync(path.join(PLUGIN, "scripts", "relay-guard.mjs")));
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
