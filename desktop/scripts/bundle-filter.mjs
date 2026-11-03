/**
 * Which files inside a dependency never belong in the packaged payload.
 *
 * The installer's cost is dominated by file count, not bytes: 31k files in
 * `node_modules` and every one of them gets created, written and scanned by
 * antivirus on the user's machine. These classes are the ones a running
 * dependency never reads.
 *
 *  - `.map` — read only by a debugger attached to third-party code.
 *  - Markdown — documentation. Licences are deliberately kept: dropping those
 *    is a licensing problem, not a size optimisation, and several packages
 *    ship `LICENSE.md` with no extensionless copy.
 *  - Test files — `__tests__/` directories and `*.test.*` / `*.spec.*`. A
 *    package's top-level `test/` is *not* dropped even though it usually holds
 *    only tests: a few older packages keep fixtures there that runtime code
 *    reads, and the whole point of this filter is to be safe.
 *
 * The markdown rule has one exception, and getting it wrong is silent:
 * pi-subagents ships its prompt templates, skill trees and builtin agent
 * definitions as `.md` files, and those directories hold *nothing but*
 * markdown. Dropping them leaves the directories empty, which does not fail
 * the build — it fails at runtime, in `seedSubagentResources` and the three
 * bridges that read a builtin's frontmatter to extend its tool allowlist.
 *
 * This lives outside `build-runtime.mjs` so the rules can be exercised without
 * running a build, which that script does on import.
 */
import fs from "node:fs";
import path from "node:path";

export const OMITTED_DOC = /\.(md|markdown)$/i;
export const KEPT_DOC = /^(licen[cs]e|copying|notice|third[-_]?part(y|ies)|authors|contributors)/i;
export const OMITTED_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Dependency directories Kady reads that the package does not declare.
 *
 * `pi-subagents` names `skills` and `prompts` under `pi.*`, but not `agents` —
 * that one is Kady's: `listBuiltinAgents` lists it and the notebook, Modal and
 * PDF-annotation bridges parse each builtin's `tools:` frontmatter to extend it.
 */
export const DEPENDENCY_RESOURCES = {
  "pi-subagents": ["agents", "prompts", "skills"],
};

function isInside(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Absolute directories inside one package whose markdown is content, not docs.
 *
 * Read from the package's own `pi.skills` / `pi.prompts` declarations (Pi's
 * manifest convention) plus the hand-maintained list above.
 */
export function declaredResourceDirs(pkgRoot, pkgName) {
  const dirs = [];
  const add = (rel) => {
    if (typeof rel === "string" && rel) dirs.push(path.resolve(pkgRoot, rel));
  };
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    for (const key of ["skills", "prompts"]) {
      const value = manifest?.pi?.[key];
      for (const entry of Array.isArray(value) ? value : [value]) add(entry);
    }
  } catch {
    // No manifest to read: fall through to Kady's own list.
  }
  for (const rel of DEPENDENCY_RESOURCES[pkgName] ?? []) add(rel);
  return [...new Set(dirs)];
}

export function omitFromBundle(src, resourceDirs = []) {
  const base = path.basename(src);
  const stat = fs.statSync(src, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return base === "__tests__";
  if (base.endsWith(".map")) return true;
  if (OMITTED_DOC.test(base)) {
    if (KEPT_DOC.test(base)) return false;
    return !resourceDirs.some((dir) => isInside(dir, src));
  }
  return OMITTED_TEST_FILE.test(base);
}
