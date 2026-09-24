// One taker of a slot race (see the slot tests): takes a slot, holds it for HOLD_MS, and
// reports every other holder it saw while it held the slot — a non-empty list means two
// runs owned one slot at once. Timing knobs come from the environment (read at load).
import fs from "node:fs";
import path from "node:path";

import { acquireSlots, ucxHome } from "../../plugins/ultracodex/scripts/codex-node.mjs";

const runId = process.argv[2];
const holdMs = Number(process.argv[3] ?? 300);
const holders = path.join(ucxHome(), "holders");
fs.mkdirSync(holders, { recursive: true });

const lease = await acquireSlots(1, runId, () => null);
const tookAt = Date.now();
fs.writeFileSync(path.join(holders, runId), "");
const overlaps = new Set();
const until = Date.now() + holdMs;
while (Date.now() < until) {
  for (const name of fs.readdirSync(holders)) if (name !== runId) overlaps.add(name);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
fs.rmSync(path.join(holders, runId));
lease.release();
process.stdout.write(JSON.stringify({ runId, tookAt, overlaps: [...overlaps] }) + "\n");
