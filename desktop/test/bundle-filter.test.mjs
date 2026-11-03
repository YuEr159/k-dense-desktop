/**
 * What the packaging filter is allowed to drop.
 *
 * The failure this guards against is silent: pi-subagents stores its prompt
 * templates, skill trees and builtin agent definitions as `.md`, and those
 * directories contain nothing else. A blanket "markdown is documentation" rule
 * empties them, the build still succeeds, and the damage only shows up at
 * runtime — `/prompts` and `/skills` answer 500, and the notebook, Modal and
 * PDF-annotation bridges quietly stop extending builtin specialists' tool
 * lists because there is no frontmatter left to read.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  DEPENDENCY_RESOURCES,
  declaredResourceDirs,
  omitFromBundle,
} from "../scripts/bundle-filter.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const server = path.resolve(desktop, "..", "server");

function packageDir(name) {
  // Not `require.resolve`: pi-subagents' `exports` map does not expose
  // `./package.json`, so resolution throws even when the package is installed.
  const candidate = path.join(server, "node_modules", ...name.split("/"));
  return fs.existsSync(path.join(candidate, "package.json")) ? candidate : null;
}

test("markdown is documentation unless a package declares it as content", () => {
  const scratch = fs.mkdtempSync(path.join(desktop, ".tmp-filter-"));
  try {
    const pkg = path.join(scratch, "pkg");
    fs.mkdirSync(path.join(pkg, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "docs"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ pi: { prompts: ["./prompts"] } }));
    const prompt = path.join(pkg, "prompts", "review.md");
    fs.writeFileSync(prompt, "# review");
    const doc = path.join(pkg, "docs", "guide.md");
    fs.writeFileSync(doc, "# guide");

    const dirs = declaredResourceDirs(pkg, "pkg");
    assert.equal(omitFromBundle(prompt, dirs), false, "a declared prompt template is content");
    assert.equal(omitFromBundle(doc, dirs), true, "undeclared markdown is still dropped");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("licences survive even inside a declared resource directory", () => {
  const scratch = fs.mkdtempSync(path.join(desktop, ".tmp-filter-"));
  try {
    const pkg = path.join(scratch, "pkg");
    fs.mkdirSync(path.join(pkg, "skills"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ pi: { skills: "./skills" } }));
    const licence = path.join(pkg, "skills", "LICENSE.md");
    fs.writeFileSync(licence, "MIT");
    assert.equal(omitFromBundle(licence, declaredResourceDirs(pkg, "pkg")), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("Kady's own list covers the directory pi-subagents does not declare", () => {
  // `agents/` is absent from the package's `pi` field: it is Kady that reads
  // those files, through `listBuiltinAgents` and the three tool bridges.
  assert.ok(DEPENDENCY_RESOURCES["pi-subagents"].includes("agents"));
});

test("the installed pi-subagents keeps its prompts, skills and builtin agents", { skip: !packageDir("pi-subagents") }, () => {
  // The real package, not a fixture. This is the regression that shipped: an
  // empty `prompts/` made `seedSubagentResources` throw ENOENT into the
  // `/prompts` and `/skills` routes.
  const dir = packageDir("pi-subagents");
  const dirs = declaredResourceDirs(dir, "pi-subagents");

  const kept = (rel) => {
    const full = path.join(dir, rel);
    assert.ok(fs.existsSync(full), `fixture assumption broken: ${rel} is missing from the installed package`);
    return !omitFromBundle(full, dirs);
  };

  const sample = {
    "prompts": ["council.md", "review-loop.md"],
    "agents": ["reviewer.md", "researcher.md"],
    "skills": ["pi-subagents/SKILL.md", "pi-subagents/references/prompting-and-roles.md"],
  };
  for (const [kind, files] of Object.entries(sample)) {
    for (const file of files) assert.ok(kept(`${kind}/${file}`), `${kind}/${file} would be dropped from the payload`);
  }

  // Documentation outside those directories is still trimmed.
  for (const rel of ["README.md", "CHANGELOG.md", "docs/agents.md"]) {
    if (!fs.existsSync(path.join(dir, rel))) continue;
    assert.equal(omitFromBundle(path.join(dir, rel), dirs), true, `${rel} should still be dropped`);
  }
});

test("a nested copy of a package is judged by its own manifest", () => {
  // `defuddle/node_modules/linkedom` is a different package from `linkedom`
  // at the top level; resource directories must be resolved per package root,
  // which is why the build passes `from` with each package's own key.
  const scratch = fs.mkdtempSync(path.join(desktop, ".tmp-filter-"));
  try {
    const outer = path.join(scratch, "outer");
    const inner = path.join(outer, "node_modules", "inner");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(outer, "package.json"), "{}");
    fs.writeFileSync(path.join(inner, "package.json"), JSON.stringify({ pi: { skills: "./skills" } }));
    fs.mkdirSync(path.join(inner, "skills"));
    const skill = path.join(inner, "skills", "SKILL.md");
    fs.writeFileSync(skill, "# skill");

    // The outer package declares nothing, so the same file judged as part of
    // the outer tree is plain markdown.
    assert.equal(omitFromBundle(skill, declaredResourceDirs(outer, "outer")), true);
    assert.equal(omitFromBundle(skill, declaredResourceDirs(inner, "inner")), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
