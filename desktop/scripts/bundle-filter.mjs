/**
 * Which files inside a dependency never belong in the packaged payload.
 *
 * The installer's cost is dominated by file count, not bytes: 31k files in
 * `node_modules` and every one of them gets created, written and scanned by
 * antivirus on the user's machine. These classes are the ones a running
 * dependency never reads.
 *
 *  - `.map` — read only by a debugger attached to third-party code.
 *  - Test files — `__tests__/` directories and `*.test.*` / `*.spec.*`. A
 *    package's top-level `test/` is *not* dropped even though it usually holds
 *    only tests: a few older packages keep fixtures there that runtime code
 *    reads, and the whole point of this filter is to be safe.
 *
 * **Markdown is kept.** It is not documentation by default: pi-subagents ships
 * its prompt templates, skill trees and builtin agent definitions as `.md`, and
 * a blanket "markdown is docs" rule emptied those directories — a build that
 * still succeeded, and a runtime that then answered 500 from `/prompts` and
 * `/skills`, with the notebook, Modal and PDF-annotation bridges silently
 * failing to extend builtin specialists' tool allowlists. Keeping every `.md`
 * costs 9.3 MB uncompressed (1,037 files) and removes that whole class of
 * silent breakage, including a future release that stores resources somewhere
 * nobody here enumerated.
 *
 * This lives outside `build-runtime.mjs` so the rules can be exercised without
 * running a build, which that script does on import.
 */
import fs from "node:fs";
import path from "node:path";

export const OMITTED_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export function omitFromBundle(src) {
  const base = path.basename(src);
  const stat = fs.statSync(src, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return base === "__tests__";
  if (base.endsWith(".map")) return true;
  return OMITTED_TEST_FILE.test(base);
}
