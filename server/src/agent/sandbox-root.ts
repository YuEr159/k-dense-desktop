/**
 * Locate the project sandbox from wherever a child process happens to be.
 *
 * A child may `cd` into a subdirectory, so the root is found by walking up to
 * the nearest directory named `sandbox` — with the two defences the modal
 * package learned the hard way: a depth cap, and no symlinked candidate (a
 * linked `sandbox` would point at some other project's data).
 *
 * Returns null when there is no such ancestor. The old loop stopped at the
 * filesystem root and returned `/`, which turned every lookup into a read of a
 * path that does not exist; callers here must skip rather than guess.
 */
import fs from "node:fs";
import path from "node:path";

const MAX_DEPTH = 32;

export function resolveSandboxRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (path.basename(dir) === "sandbox") {
      try {
        const stat = fs.lstatSync(dir);
        if (stat.isDirectory() && !stat.isSymbolicLink()) return dir;
      } catch {
        /* unreadable at this level; keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
