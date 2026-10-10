// One claimant of a session's supervisor.lock, for the lock race test: waits until START_AT (so that
// several of them reach the lock together), claims it, holds it for a moment and prints
// {got, stillHeld}: whether it believed it held the lock, and whether it still did after the hold.
import path from "node:path";

import { claimSupervisorLock } from "../../plugins/ultracodex/scripts/session.mjs";

const [dir, startAt] = [process.argv[2], Number(process.argv[3])];
const paths = { lock: path.join(dir, "supervisor.lock"), alive: path.join(dir, "alive") };
while (Date.now() < startAt) {
  // spin: sleeping would let the claimants drift apart
}
const lock = await claimSupervisorLock(paths, { waitMs: 0 });
if (lock) await new Promise((resolve) => setTimeout(resolve, 300));
const stillHeld = lock ? lock.stillHeld() : false;
lock?.release();
console.log(JSON.stringify({ got: Boolean(lock), stillHeld }));
