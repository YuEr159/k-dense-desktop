/**
 * What the packaging filter is allowed to drop.
 *
 * Markdown is deliberately never dropped. pi-subagents stores its prompt
 * templates, skill trees and builtin agent definitions as `.md`, and a blanket
 * "markdown is documentation" rule emptied those directories — the build still
 * succeeded, and the damage only showed up at runtime: `/prompts` and `/skills`
 * answered 500, and the notebook, Modal and PDF-annotation bridges quietly
 * stopped extending builtin specialists' tool lists because there was no
 * frontmatter left to read. That cost 9.3 MB uncompressed to avoid.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { omitFromBundle } from "../scripts/bundle-filter.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const server = path.resolve(desktop, "..", "server");

test("keeps every file of the installed pi-subagents package", () => {
  // The real package, not a fixture: this is the one whose resources the app
  // reads at runtime, and the check should fail if the rule ever regains a
  // markdown exemption that catches it.
  const pkg = path.join(server, "node_modules", "pi-subagents");
  if (!fs.existsSync(path.join(pkg, "package.json"))) return; // not installed

  const dropped = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!omitFromBundle(abs)) walk(abs);
        continue;
      }
      // Source maps in the package genuinely are debugger-only; everything
      // else it ships must reach the payload.
      if (/\.map$/.test(entry.name)) continue;
      if (omitFromBundle(abs)) dropped.push(path.relative(pkg, abs));
    }
  };
  walk(pkg);

  assert.deepEqual(dropped, [], "pi-subagents files missing from the payload");
  // Non-vacuous: the package really does ship the resources in question.
  for (const rel of ["prompts", "agents", "skills"]) {
    assert.ok(fs.existsSync(path.join(pkg, rel)), `pi-subagents/${rel} missing from the checkout`);
  }
});

test("never drops markdown, wherever it lives", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kady-filter-"));
  try {
    const pkg = path.join(scratch, "pkg");
    for (const rel of [
      "README.md",
      "CHANGELOG.md",
      "LICENSE.md",
      "docs/guide.md",
      "prompts/review.md",
      "agents/reviewer.md",
      "skills/pi-subagents/SKILL.md",
      "notes.markdown",
    ]) {
      const file = path.join(pkg, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "# content\n");
      assert.equal(omitFromBundle(file), false, `${rel} must survive packaging`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("still drops source maps, test files and __tests__ directories", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kady-filter-"));
  try {
    const pkg = path.join(scratch, "pkg");
    fs.mkdirSync(path.join(pkg, "__tests__"), { recursive: true });
    fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
    for (const rel of ["index.js.map", "src/thing.test.ts", "src/thing.spec.mjs"]) {
      const file = path.join(pkg, rel);
      fs.writeFileSync(file, "x");
      assert.equal(omitFromBundle(file), true, `${rel} should be dropped`);
    }
    assert.equal(omitFromBundle(path.join(pkg, "__tests__")), true);

    // A package's own top-level `test/` is kept: some older packages keep
    // fixtures there that runtime code reads.
    const runtimeFixture = path.join(pkg, "test", "fixture.json");
    fs.mkdirSync(path.dirname(runtimeFixture), { recursive: true });
    fs.writeFileSync(runtimeFixture, "{}");
    assert.equal(omitFromBundle(runtimeFixture), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
