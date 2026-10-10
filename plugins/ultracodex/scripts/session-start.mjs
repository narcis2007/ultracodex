#!/usr/bin/env node
// SessionStart hook: tells the session's later Bash commands which Claude Code session they belong to.
//
// Claude Code gives every command hook the session id on stdin (JSON `session_id`), and a SessionStart
// hook a file in CLAUDE_ENV_FILE whose `export` lines every later Bash command of the session runs
// first. This hook appends `export ULTRACODEX_OWNER=<session_id>` there, which is how the runner
// learns which Claude session started a Codex run (so notifications reach that session only).
//
// Whatever a SessionStart hook prints to stdout becomes context for the model, so this prints
// nothing, and it never fails the session: any problem is a silent exit 0.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const OWNER_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_STDIN = 1024 * 1024;

// The line to append for a hook input (the stdin text) and environment, or null.
export function ownerLine(stdinText, env = process.env) {
  if (!env.CLAUDE_ENV_FILE) return null;
  let input;
  try {
    input = JSON.parse(stdinText);
  } catch {
    return null;
  }
  const id = input && typeof input === "object" ? input.session_id : null;
  return typeof id === "string" && OWNER_RE.test(id) ? `export ULTRACODEX_OWNER=${id}\n` : null;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN) break;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  try {
    // a hook whose stdin never closes must not hold the session start up
    const timer = setTimeout(() => process.exit(0), 5000);
    timer.unref?.();
    const line = ownerLine(await readStdin());
    if (line) fs.appendFileSync(process.env.CLAUDE_ENV_FILE, line);
    clearTimeout(timer);
  } catch {
    // never fail the session
  }
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
