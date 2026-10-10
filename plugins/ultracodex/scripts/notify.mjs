// ultracodex notify — tells Claude about the events of its Codex sessions that need it, without polling.
//
// One watcher, three consumers: `node codex-node.mjs notify` (stdout lines for Claude Code's Monitor
// tool, or for the plugin monitor), and the MCP server (the same watcher in-process, pushed as channel
// messages). It follows the `events.jsonl` of every *session* run that belongs to one owner (the Claude
// session that started it; see currentOwner in codex-node.mjs) and turns the few events that are
// actionable into one compact item each: a question, a finished turn, a limit wait, a resume after a
// limit or an account change, an error, the end of a session. Everything else (messages, commands, file
// changes, steers, idle ...) is never reported.
//
// Nothing is missed between two watchers and nothing repeats: a per-owner cursor file
// (<home>/notify/<hash>.json, {runId: lastSeq, ended: {runId: true}}) is advanced after each line is
// delivered. A run the cursor does not know starts at its current end (history is not replayed), except
// for a question that is still pending, which is always reported once at startup.
//
// This module imports the runner back (codex-node.mjs imports it too): every name taken from it is
// only ever used inside a function, never at load time.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  OWNER_RE,
  RUNNER_FILE,
  RUN_ID_RE,
  TIMING,
  UsageError,
  currentOwner,
  isPlainObject,
  pidAlive,
  readJsonSafe,
  runPaths,
  sleep,
  ucxHome,
  writeJsonAtomic,
} from "./codex-node.mjs";
import { lastEventSeq, readNewEvents, sessionSupervisorAlive } from "./session.mjs";

export const DEFAULT_NOTIFY_WAIT_SEC = 29 * 60; // fits the Monitor tool's 30-minute cap
export const ALL_OWNERS = "*"; // the owner key of `--all`; no real owner id can contain it
const QUESTION_MAX = 600;
const SUMMARY_MAX = 400;
const ERROR_MAX = 300;
const LOCK_BEAT_MS = 10_000;
const LOCK_STALE_MS = 120_000;

function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

// ─── cursor and lock files ──────────────────────────────────────────────────

const notifyDir = () => path.join(ucxHome(), "notify");
const ownerHash = (owner) => createHash("sha256").update(owner).digest("hex").slice(0, 16);

// namespace: "" for the CLI's watchers (Monitor, plugin monitor), "channel" for the MCP server's push
export const cursorPath = (owner, namespace = "") => path.join(notifyDir(), `${namespace ? `${namespace}-` : ""}${ownerHash(owner)}.json`);
export const lockPath = (owner) => path.join(notifyDir(), `${ownerHash(owner)}.lock`);

function loadCursor(file) {
  const raw = file ? readJsonSafe(file) : null;
  const cursor = { runs: {}, ended: {} };
  if (!isPlainObject(raw)) return cursor;
  for (const [key, value] of Object.entries(raw)) {
    if (RUN_ID_RE.test(key) && Number.isInteger(value) && value >= 0) cursor.runs[key] = value;
  }
  if (isPlainObject(raw.ended)) {
    for (const key of Object.keys(raw.ended)) if (RUN_ID_RE.test(key) && raw.ended[key] === true) cursor.ended[key] = true;
  }
  return cursor;
}

// Best effort: a cursor that cannot be written costs a possible repeat, never an event.
function saveCursor(file, cursor) {
  if (!file) return;
  try {
    const disk = loadCursor(file); // another watcher of the same owner may have moved on
    for (const [runId, seq] of Object.entries(disk.runs)) cursor.runs[runId] = Math.max(cursor.runs[runId] ?? 0, seq);
    Object.assign(cursor.ended, disk.ended);
    const out = {};
    for (const runId of Object.keys(cursor.runs).sort()) {
      if (fs.existsSync(runPaths(runId).dir)) out[runId] = cursor.runs[runId]; // a gc'ed run drops out
    }
    const ended = Object.keys(cursor.ended).filter((runId) => out[runId] !== undefined);
    if (ended.length) out.ended = Object.fromEntries(ended.sort().map((runId) => [runId, true]));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, out);
  } catch {
    // see above
  }
}

// ─── what is actionable ─────────────────────────────────────────────────────

// the summary of a finished turn: its text, a schema result's summary/status, or the failure
function turnSummary(paths, turn) {
  const envelope = Number.isInteger(turn) && turn > 0 ? readJsonSafe(path.join(paths.turns, `${turn}.json`)) : null;
  if (!isPlainObject(envelope)) return "";
  if (envelope.ok !== true) return clip(envelope.error?.message, SUMMARY_MAX);
  if (typeof envelope.text === "string") return clip(envelope.text, SUMMARY_MAX);
  const result = envelope.result;
  if (isPlainObject(result)) {
    const parts = [result.status, result.summary].filter((value) => typeof value === "string" && value.trim());
    if (parts.length) return clip(parts.join(": "), SUMMARY_MAX);
    return clip(JSON.stringify(result), SUMMARY_MAX);
  }
  return "";
}

// A usage-limit wait is one line, not one per event. The supervisor announces it at once (resumesAt
// null) and again when a probe learns when usage is back: the first event that carries a time is the
// line; a wait that never learns one is reported with null once it has lasted notifyLimitNullMs. These
// events end a wait (the next one is a new wait).
const WAIT_ENDS = new Set(["resumed", "turn_started", "cancelled", "closed", "idle", "dormant"]);

// One item ({ out, runId, seq }) for an actionable event, else null. `answered` holds the ids of the
// questions answered in the same batch of events: a question nobody waits on any more is no news.
function itemFor(run, event, answered) {
  const seq = Number.isInteger(event.seq) ? event.seq : null;
  const base = { runId: run.runId, label: run.label };
  const item = (out) => ({ out, runId: run.runId, seq });
  switch (event.type) {
    case "question": {
      const questionId = String(event.id ?? "");
      if (!questionId || answered.has(questionId)) return null;
      return item(questionLine(run, event.turn, questionId, event.question));
    }
    case "turn_completed":
      return item({
        codex: "turn_done",
        ...base,
        turn: event.turn ?? null,
        ok: event.ok === true,
        ...(event.ok === true ? {} : { kind: event.kind ?? "failed" }),
        summary: turnSummary(run.paths, event.turn),
      });
    case "resumed":
      return ["limit_reset", "account_change"].includes(event.reason) ? item({ codex: "resumed", ...base, reason: event.reason }) : null;
    case "error":
      return event.willRetry === true ? null : item({ codex: "error", ...base, kind: event.kind ?? "execution", message: clip(event.message, ERROR_MAX) });
    case "hermetic_violation": {
      const servers = Array.isArray(event.servers) ? event.servers.map(String) : [];
      const message = servers.length ? `a hermetic session found MCP servers with tools: ${servers.join(", ")}` : "the hermetic check could not be completed";
      return item({ codex: "error", ...base, kind: "hermetic_violation", message: clip(message, ERROR_MAX) });
    }
    case "cancelled":
      return { ...item({ codex: "ended", ...base, state: readJsonSafe(run.paths.result)?.state ?? "cancelled" }), ended: true };
    default:
      return null;
  }
}

function questionLine(run, turn, questionId, question) {
  const text = String(question ?? "").replace(/\s+/g, " ").trim();
  return {
    codex: "question",
    runId: run.runId,
    label: run.label,
    turn: turn ?? null,
    questionId,
    question: clip(text, QUESTION_MAX),
    hint: `answer with codex_answer, or: node "${RUNNER_FILE}" answer ${run.runId} ${questionId} --text "..."`,
  };
}

// every complete line from `offset` on (readNewEvents reads in chunks)
function readAll(file, offset) {
  const events = [];
  for (;;) {
    const batch = readNewEvents(file, offset);
    const progressed = batch.offset > offset;
    offset = batch.offset;
    for (const { event } of batch.events) events.push(event);
    if (!progressed) return { events, offset };
  }
}

// ─── the watcher ────────────────────────────────────────────────────────────

export class Watcher {
  // owner: an owner id, or ALL_OWNERS. cursorFile: where progress is kept (null: in memory only).
  // from: "cursor" resumes from it, "now" ignores what it holds.
  constructor({ owner, cursorFile = null, from = "cursor", limitNullMs = null }) {
    this.owner = owner;
    this.cursorFile = cursorFile;
    this.from = from;
    this.cursor = { runs: {}, ended: {} };
    this.tracked = new Map(); // runId -> { run: {runId, label, paths}, offset, seq, endedDone }
    this.known = new Set(); // runs looked at and not ours (or tracked): never read again
    this.printedQuestions = new Set();
    this.limitNullMs = limitNullMs;
    this.lastScan = 0;
    this.started = false;
  }

  matches(state) {
    return state.session === true && (this.owner === ALL_OWNERS || state.owner === this.owner);
  }

  // The items due at startup: the questions still waiting for an answer. Existing runs are positioned
  // from the cursor; the ones it does not know start at their end.
  init() {
    if (this.from === "cursor") this.cursor = loadCursor(this.cursorFile);
    const items = [];
    this.scan(items);
    this.started = true;
    saveCursor(this.cursorFile, this.cursor);
    return items;
  }

  scan(items = null) {
    this.lastScan = Date.now();
    let names = [];
    try {
      names = fs.readdirSync(path.join(ucxHome(), "runs")).filter((name) => RUN_ID_RE.test(name)).sort();
    } catch {
      // no runs yet
    }
    const present = new Set(names);
    for (const runId of [...this.known]) if (!present.has(runId)) this.known.delete(runId);
    let changed = false;
    for (const runId of names) {
      if (this.known.has(runId)) continue;
      const paths = runPaths(runId);
      const state = readJsonSafe(paths.state);
      if (!state) continue; // still being created: look again at the next scan
      this.known.add(runId);
      if (!this.matches(state)) continue;
      changed = this.adopt(runId, paths, state, items) || changed;
    }
    if (changed && this.started) saveCursor(this.cursorFile, this.cursor);
  }

  adopt(runId, paths, state, items) {
    const run = { runId, label: state.label ?? null, paths };
    const result = readJsonSafe(paths.result);
    const finished = result !== null;
    const known = Object.hasOwn(this.cursor.runs, runId);
    const track = { run, offset: 0, seq: this.cursor.runs[runId] ?? 0, endedDone: Boolean(this.cursor.ended[runId]), limit: { pending: null, printed: false } };
    // an ended session the cursor has fully caught up with has nothing left to say
    if (known && finished && lastEventSeq(paths.events) <= track.seq && (track.endedDone || result.state !== "failed")) return false;
    if (!known && !this.started) {
      // History is not replayed: a run the cursor does not know begins at its current end.
      if (finished) return false;
      const { events, offset } = readAll(paths.events, 0);
      track.offset = offset;
      track.seq = events.reduce((max, event) => (Number.isInteger(event.seq) ? Math.max(max, event.seq) : max), 0);
    }
    if (!known) this.cursor.runs[runId] = track.seq;
    this.tracked.set(runId, track);
    // a question that is still waiting is reported once at startup, whatever the cursor says
    const question = state.question;
    if (!this.started && !finished && items && isPlainObject(question) && question.id && sessionSupervisorAlive(paths)) {
      this.printedQuestions.add(`${runId}:${question.id}`);
      items.push({ out: questionLine(run, state.turn, String(question.id), question.question), runId, seq: null });
    }
    return !known;
  }

  // The items that appeared since the last tick (new events of tracked runs, new sessions).
  tick() {
    const items = [];
    if (Date.now() - this.lastScan >= TIMING.notifyRescanMs) this.scan(items);
    for (const [runId, track] of [...this.tracked]) {
      const { run } = track;
      if (!fs.existsSync(run.paths.dir)) {
        this.tracked.delete(runId); // gc'ed
        continue;
      }
      // the result first, the events second: the supervisor writes events before the result
      const result = readJsonSafe(run.paths.result);
      try {
        if (fs.statSync(run.paths.events).size < track.offset) track.offset = 0; // a file that was replaced by a shorter one; `seq` filters what was seen
      } catch {
        // no events yet
      }
      const batch = readAll(run.paths.events, track.offset);
      track.offset = batch.offset;
      const fresh = batch.events.filter((event) => Number.isInteger(event.seq) && event.seq > track.seq);
      const answered = new Set(fresh.filter((event) => event.type === "answer").map((event) => String(event.id)));
      for (const event of fresh) {
        track.seq = Math.max(track.seq, event.seq);
        if (WAIT_ENDS.has(event.type)) track.limit = { pending: null, printed: false };
        if (event.type === "limit_wait") {
          const line = this.limitWait(track, event);
          if (line) items.push(line);
          continue;
        }
        const item = itemFor(run, event, answered);
        if (!item) continue;
        if (item.out.codex === "question" && this.printedQuestions.has(`${runId}:${item.out.questionId}`)) continue;
        if (item.ended) track.endedDone = true;
        items.push(item);
      }
      if (result) {
        // a session that failed says why in an `error` event; this line says it is over
        if (!track.endedDone && result.state === "failed") {
          items.push({ out: { codex: "ended", runId, label: run.label, state: "failed", ...(result.error?.kind ? { kind: result.error.kind } : {}) }, runId, seq: null, ended: true });
        }
        track.endedDone = true;
        this.tracked.delete(runId); // over and drained
      } else {
        const line = this.limitWaitDue(track);
        if (line) items.push(line);
      }
    }
    return items;
  }

  // The line for a limit_wait event, if this is the one that carries the wait's news.
  limitWait(track, event) {
    const { limit, run } = track;
    if (limit.printed) return null; // the same wait
    if (event.resumesAt) {
      limit.printed = true;
      limit.pending = null;
      return { out: { codex: "limit_wait", runId: run.runId, label: run.label, resumesAt: event.resumesAt }, runId: run.runId, seq: event.seq };
    }
    limit.pending ??= event;
    return null;
  }

  // A wait that has lasted long enough without learning when usage is back.
  limitWaitDue(track) {
    const { limit, run } = track;
    if (!limit.pending || limit.printed) return null;
    const since = Date.parse(limit.pending.t);
    if (Date.now() - (Number.isFinite(since) ? since : 0) < (this.limitNullMs ?? TIMING.notifyLimitNullMs)) return null;
    limit.printed = true;
    const seq = limit.pending.seq;
    limit.pending = null;
    return { out: { codex: "limit_wait", runId: run.runId, label: run.label, resumesAt: null }, runId: run.runId, seq };
  }

  // Has another watcher of this owner already delivered this item?
  covered(item) {
    if (!this.cursorFile || this.from !== "cursor") return false;
    const disk = loadCursor(this.cursorFile);
    if (item.ended) return Boolean(disk.ended[item.runId]);
    return item.seq !== null && (disk.runs[item.runId] ?? -1) >= item.seq;
  }

  // Record that an item was delivered (after it was delivered, never before).
  commit(item) {
    if (item.seq !== null) this.cursor.runs[item.runId] = Math.max(this.cursor.runs[item.runId] ?? 0, item.seq);
    if (item.ended) this.cursor.ended[item.runId] = true;
    saveCursor(this.cursorFile, this.cursor);
  }
}

// Runs a watcher until `shouldStop()` says so or `until` (epoch ms, null = for ever), handing each
// item to `emit` (which may be async). `beat`, when given, runs about every LOCK_BEAT_MS (the CLI's
// singleton lock uses it) and may return false to stop.
export async function watchLoop(watcher, { emit, until = null, shouldStop = () => false, beat = null }) {
  const deliver = async (items) => {
    for (const item of items) {
      if (shouldStop()) return;
      if (watcher.covered(item)) continue;
      await emit(item);
      watcher.commit(item);
    }
  };
  await deliver(watcher.init());
  let lastBeat = Date.now();
  for (;;) {
    if (shouldStop()) return;
    await deliver(watcher.tick());
    if (until !== null && Date.now() >= until) return;
    if (beat && Date.now() - lastBeat >= LOCK_BEAT_MS) {
      lastBeat = Date.now();
      if (beat() === false) return;
    }
    await sleep(until === null ? TIMING.pollMs : Math.max(1, Math.min(TIMING.pollMs, until - Date.now())));
  }
}

// ─── the singleton lock of a `--forever` watcher ────────────────────────────

// Held by at most one `--forever` watcher per owner (two plugin-monitor entries may both start one).
// Stale when its process is gone or it has not been refreshed for LOCK_STALE_MS (a recycled pid).
// A watcher that finds the lock taken from under it (a stale judgment that raced) stops by itself.
export function takeNotifyLock(owner) {
  const file = lockPath(owner);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
      return {
        stillHeld() {
          if (readJsonSafe(file)?.pid !== process.pid) return false;
          try {
            const now = new Date();
            fs.utimesSync(file, now, now);
          } catch {
            // refreshed again at the next beat
          }
          return true;
        },
        release() {
          if (readJsonSafe(file)?.pid !== process.pid) return;
          try {
            fs.rmSync(file, { force: true });
          } catch {
            // a stale lock is judged by its pid
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") return null; // cannot lock: better one watcher too many than none
    }
    let stale = false;
    try {
      // a lock that cannot be read yet may be one just created and not yet written
      const held = readJsonSafe(file);
      const age = Date.now() - fs.statSync(file).mtimeMs;
      stale = held && Number.isInteger(held.pid) ? !pidAlive(held.pid) || age > LOCK_STALE_MS : age > 5000;
    } catch {
      stale = true;
    }
    if (!stale) return false;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // another watcher removed it first
    }
  }
  return false;
}

// ─── the command ────────────────────────────────────────────────────────────

// node codex-node.mjs notify [--owner ID | --all] [--max-wait SEC | --forever] [--from now|cursor]
export async function cmdNotify(options) {
  if (options.all && options.owner !== null) throw new UsageError("notify takes --owner or --all, not both");
  if (options.owner !== null && !OWNER_RE.test(options.owner)) throw new UsageError("--owner must be a session id (letters, digits, _ . : -; at most 128 characters)");
  if (options.forever && options.maxWait !== null) throw new UsageError("notify takes --forever or --max-wait, not both");
  const from = options.from ?? "cursor";
  if (!["cursor", "now"].includes(from)) throw new UsageError("--from must be cursor or now");
  const owner = options.all ? ALL_OWNERS : options.owner ?? currentOwner()?.id ?? null;
  if (!owner) {
    process.stdout.write(`${JSON.stringify({ codex: "notify_unavailable", reason: "no owner (start the watcher from a Claude Code Bash command, or pass --owner/--all)" })}\n`);
    return 1;
  }
  let lock = null;
  if (options.forever) {
    lock = takeNotifyLock(owner);
    if (lock === false) return 0; // another watcher of this owner runs: silently leave
  }
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  // the reader of our output went away (a Monitor that ended): leave quietly
  process.stdout.on("error", stop);
  const onSignal = () => {
    lock?.release();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", () => lock?.release());
  const watcher = new Watcher({ owner, cursorFile: cursorPath(owner), from });
  const until = options.forever ? null : Date.now() + (options.maxWait ?? DEFAULT_NOTIFY_WAIT_SEC) * 1000;
  await watchLoop(watcher, {
    emit: (item) => {
      process.stdout.write(`${JSON.stringify(item.out)}\n`);
    },
    until,
    shouldStop: () => stopped,
    beat: lock ? () => lock.stillHeld() : null,
  });
  lock?.release();
  return 0;
}

// ─── the channel's wording ──────────────────────────────────────────────────

const slug = (label) =>
  String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

// { content, meta } of a `notifications/claude/channel` for an item. meta keys are identifiers and
// its values strings (anything else the client silently drops).
export function channelMessage(out) {
  const name = out.label ? `${out.label} (${out.runId})` : out.runId;
  let content;
  switch (out.codex) {
    case "question":
      content = `Codex session ${name} asks: ${out.question} - answer with codex_answer(runId "${out.runId}", questionId "${out.questionId}", answer). Codex is blocked until you do.`;
      break;
    case "turn_done":
      content = out.ok
        ? `Codex session ${name} finished turn ${out.turn} (ok): ${out.summary || "(no summary)"} - read it with codex_result or continue with codex_send.`
        : `Codex session ${name} turn ${out.turn} did not complete (${out.kind}): ${out.summary || "(no detail)"} - see codex_result; codex_send continues the session.`;
      break;
    case "limit_wait":
      content = `Codex session ${name} hit a usage limit and waits${out.resumesAt ? ` (usage should be back at ${out.resumesAt})` : ""}. It continues by itself; nothing to do.`;
      break;
    case "resumed":
      content = `Codex session ${name} resumed after ${out.reason === "account_change" ? "an account change" : "a usage-limit reset"}.`;
      break;
    case "error":
      content = `Codex session ${name} reported an error (${out.kind}): ${out.message}`;
      break;
    case "ended":
      content = `Codex session ${name} ended (${out.state}${out.kind ? `, ${out.kind}` : ""}). It takes no more messages; codex_result has what it produced.`;
      break;
    default:
      content = `Codex session ${name}: ${out.codex}`;
  }
  const meta = { run_id: out.runId, event: out.codex };
  if (out.turn !== undefined && out.turn !== null) meta.turn = String(out.turn);
  if (out.questionId) meta.question_id = String(out.questionId);
  if (slug(out.label)) meta.label_slug = slug(out.label);
  return { content, meta };
}
