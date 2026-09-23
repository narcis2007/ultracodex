// Runs one slot-lease scenario with the timing knobs from the environment (they are
// read when the runner module loads) and prints one JSON line with what happened.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { acquireSlots, ucxHome } from "../../plugins/ultracodex/scripts/codex-node.mjs";

const scenario = process.argv[2];
const slot = path.join(ucxHome(), "slots", "slot-0");
const leasePath = path.join(slot, "lease-run-X");
const ownerFile = path.join(leasePath, "owner.json");
fs.mkdirSync(leasePath, { recursive: true });

let pid = process.pid; // alive
if (scenario === "dead-owner") pid = spawnSync(process.execPath, ["-e", ""]).pid; // exited
// written the way the runner renews a lease: a temp file renamed over owner.json
let n = 0;
const write = () => {
  const tmp = `${ownerFile}.tmp-${process.pid}-${(n += 1)}`;
  fs.writeFileSync(tmp, JSON.stringify({ runId: "run-X", pid, beatAt: Date.now() }));
  fs.renameSync(tmp, ownerFile);
};

let renew = null;
const old = new Date(Date.now() - 3_600_000);
if (scenario.startsWith("partial-")) {
  // owner.json unreadable (as during a Windows sharing violation); the slot itself is old
  fs.writeFileSync(ownerFile, "{");
  fs.utimesSync(slot, old, old);
  if (scenario === "partial-old") fs.utimesSync(leasePath, old, old);
  // a live owner keeps renaming files inside its lease directory
  else renew = setInterval(() => {
    const tmp = path.join(leasePath, `beat.tmp-${(n += 1)}`);
    fs.writeFileSync(tmp, "");
    fs.rmSync(tmp);
  }, 10);
} else {
  write();
  if (scenario === "live-owner") renew = setInterval(write, 10);
}

let polls = 0;
const limit = scenario === "live-owner" || scenario === "partial-fresh" ? 40 : 1000; // 40 polls = 4 stale windows
const lease = await acquireSlots(1, "run-Y", () => (++polls > limit ? "cancelled" : null));
if (renew) clearInterval(renew);

const names = fs.existsSync(slot) ? fs.readdirSync(slot) : [];
const taken = !lease.stopped;
const newOwner = names.find((name) => name.startsWith("lease-"))?.slice("lease-".length) ?? null;
lease.release();
process.stdout.write(JSON.stringify({ scenario, taken, stopped: lease.stopped, polls, newOwner }) + "\n");
