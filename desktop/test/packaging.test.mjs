/**
 * The packaging config is validated by electron-builder, but only at the very
 * end of a multi-minute build — and a `--dir` run exits 0 even when the
 * download it needed failed, so a broken config can look like a successful
 * build with a stale output directory. Checking the schema here catches a
 * typo in seconds instead of after a full package.
 *
 * This exists because a `platform` key was added to an `extraResources` entry
 * (which only accepts `from` / `to` / `filter`) and the mistake only surfaced
 * when a real build refused to start.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const desktop = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(desktop, "electron-builder.json"), "utf8"));

function schema() {
  try {
    return createRequire(path.join(desktop, "package.json"))("app-builder-lib/scheme.json");
  } catch {
    return null; // Not installed (a job that runs only the shell's own tests).
  }
}

/** `extraResources` entries accept exactly these keys. */
const FILE_SET_KEYS = ["filter", "from", "to"];

function assertFileSets(entries, label) {
  for (const [index, entry] of (entries ?? []).entries()) {
    const unknown = Object.keys(entry).filter((key) => !FILE_SET_KEYS.includes(key));
    assert.deepEqual(unknown, [], `${label}[${index}] has unsupported key(s): ${unknown.join(", ")}`);
    assert.ok(entry.from, `${label}[${index}] is missing "from"`);
    assert.ok(entry.to, `${label}[${index}] is missing "to"`);
  }
}

test("every extraResources entry uses only the supported keys", () => {
  assertFileSets(config.extraResources, "extraResources");
  for (const platform of ["win", "mac", "linux"]) {
    if (config[platform]?.extraResources) {
      assertFileSets(config[platform].extraResources, `${platform}.extraResources`);
    }
  }
});

test("the schema agrees with the key list this test enforces", () => {
  const s = schema();
  if (!s) return; // electron-builder not installed here.
  const allowed = Object.keys(s.definitions.FileSet.properties);
  assert.deepEqual(
    [...allowed].sort(),
    [...FILE_SET_KEYS].sort(),
    "electron-builder changed the FileSet schema; update FILE_SET_KEYS",
  );
});

test("the shell's own modules are all packaged", () => {
  const files = config.files ?? [];
  // `files` is what lands in app.asar. A module the entry point imports but
  // that is missing here fails only in a packaged build, where the developer
  // running it may not be the one who can read a stack trace.
  for (const module of ["main.mjs", "service-manager.mjs", "preflight.mjs", "runtime-env.mjs"]) {
    assert.ok(files.includes(module), `${module} is imported but not in "files"`);
  }
  // The modules this pass added, by name: a rename that misses this list is
  // exactly the mistake worth catching.
  for (const module of ["shell-i18n.mjs", "shell-log.mjs", "page-locale.mjs", "window-state.mjs"]) {
    assert.ok(files.includes(module), `${module} is imported but not in "files"`);
  }
});

test("every module in the packaged list exists on disk", () => {
  for (const file of config.files ?? []) {
    assert.ok(fs.existsSync(path.join(desktop, file)), `packaged file missing: ${file}`);
  }
});

test("the macOS template icon is shipped only on macOS", () => {
  const root = config.extraResources ?? [];
  const inRoot = root.some((entry) => (entry.filter ?? []).some((f) => f.includes("iconTemplate")));
  assert.equal(inRoot, false, "the macOS template icon must not be copied into Windows/Linux builds");

  const mac = config.mac?.extraResources ?? [];
  const shipped = mac.some((entry) => (entry.filter ?? []).some((f) => f.includes("iconTemplate")));
  assert.equal(shipped, true, "macOS builds need iconTemplate.png for the menu-bar icon");
});
