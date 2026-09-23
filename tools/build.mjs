#!/usr/bin/env node
// Generates the shipped copies of the Workflow helper:
//   tools/src/helper.js + tools/src/workflows/*.js  →  plugins/ultracodex/workflows/*.js
//   tools/src/helper.js                            →  workflow-templates.md (between markers)
// Workflow scripts cannot import modules, so every plugin workflow embeds the helper;
// generating them keeps one tested source of truth. `--check` fails on drift.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "tools", "src");
const PLUGIN = path.join(ROOT, "plugins", "ultracodex");
const HELPER_MARK = "/*@@ULTRACODEX_HELPER@@*/";
const DOC = path.join(PLUGIN, "skills", "codex-workflow", "references", "workflow-templates.md");
const DOC_BEGIN = "<!-- BEGIN ULTRACODEX HELPER (generated from tools/src/helper.js) -->";
const DOC_END = "<!-- END ULTRACODEX HELPER -->";

function lf(text) {
  return text.replace(/\r\n?/g, "\n");
}

export function buildOutputs() {
  const helper = lf(fs.readFileSync(path.join(SRC, "helper.js"), "utf8")).trimEnd();
  const outputs = new Map();
  const workflowDir = path.join(SRC, "workflows");
  for (const name of fs.readdirSync(workflowDir).filter((file) => file.endsWith(".js")).sort()) {
    const source = lf(fs.readFileSync(path.join(workflowDir, name), "utf8"));
    if (!source.includes(HELPER_MARK)) throw new Error(`${name}: missing ${HELPER_MARK}`);
    const notice = `// Generated from tools/src/workflows/${name} — edit the source, then \`npm run build\`.`;
    // a replacer function: the helper contains `$'`, which a replacement string would expand
    outputs.set(path.join(PLUGIN, "workflows", name), source.replace(HELPER_MARK, () => `${notice}\n\n${helper}`));
  }
  const doc = lf(fs.readFileSync(DOC, "utf8"));
  const begin = doc.indexOf(DOC_BEGIN);
  const end = doc.indexOf(DOC_END);
  if (begin < 0 || end < begin) throw new Error("workflow-templates.md: helper markers not found");
  const block = `${DOC_BEGIN}\n\n\`\`\`js\n${helper}\n\`\`\`\n\n`;
  outputs.set(DOC, doc.slice(0, begin) + block + doc.slice(end));
  return outputs;
}

function main() {
  const check = process.argv.includes("--check");
  const outputs = buildOutputs();
  const drift = [];
  for (const [file, content] of outputs) {
    const current = fs.existsSync(file) ? lf(fs.readFileSync(file, "utf8")) : null;
    if (current === content) continue;
    if (check) drift.push(path.relative(ROOT, file));
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      process.stdout.write(`wrote ${path.relative(ROOT, file)}\n`);
    }
  }
  if (check && drift.length) {
    process.stderr.write(`generated files are out of date (run npm run build):\n  ${drift.join("\n  ")}\n`);
    process.exitCode = 1;
  } else if (check) {
    process.stdout.write("generated files are up to date\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
