// Prints the key ensureKey() establishes in ULTRACODEX_HOME (run many at once to race it).
import { ensureKey } from "../../plugins/ultracodex/scripts/codex-node.mjs";

process.stdout.write(ensureKey() + "\n");
