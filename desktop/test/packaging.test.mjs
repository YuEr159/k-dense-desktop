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
  //
  // Discovered, not listed: a hand-maintained list is exactly what let a new
  // module ship missing — the list still passed while the import broke at
  // runtime. Every sibling `.mjs` the shell imports is covered automatically.
  const shellModules = fs
    .readdirSync(desktop)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  assert.ok(shellModules.includes("main.mjs"), "scan found no entry point");
  for (const module of shellModules) {
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

// `build-runtime` copies `web/.next/standalone`; it does not build it. A dist
// script without `build:web` therefore packages whatever the last frontend
// build left behind — which is how a Windows installer once shipped a three-day
// old UI while every source change looked present. CI missed it because
// release-desktop.yml runs `next build` as its own step.
test("every dist script builds the frontend first", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).scripts ?? {};
  const distScripts = Object.entries(scripts).filter(([name]) => name === "dist" || name.startsWith("dist:"));
  assert.ok(distScripts.length > 0, "found no dist scripts to check");
  for (const [name, command] of distScripts) {
    const web = command.indexOf("build:web");
    const runtime = command.indexOf("build:runtime");
    assert.ok(web !== -1, `${name} never builds the frontend`);
    // Order matters: copying the standalone output before it exists packages
    // the previous build, so `build:web` has to come first.
    assert.ok(runtime === -1 || web < runtime, `${name} copies the runtime before building the frontend`);
  }
});
