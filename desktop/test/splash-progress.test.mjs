import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { elapsedSeconds, formatBytes, hostOf, pythonHint, skillsHint } from "../splash-progress.mjs";

/**
 * The real table, so a missing key shows up as the key name rather than as a
 * silently blank hint — which is how this module would fail in production.
 */
const COPY = {
  "splash.pythonHint": "installing python packages",
  "splash.pythonMirror": "from {host}",
  "splash.pythonPackages": "{count} packages, {size}, {elapsed}s",
  "splash.pythonPackagesNoSize": "{count} packages, {elapsed}s",
  "splash.pythonInstalled": "installing {count} packages, {elapsed}s",
  "splash.pythonCompute": "resolving, {elapsed}s",
  "splash.skillsHint": "downloading the skill library",
  "splash.skillsCloning": "fetching, {elapsed}s",
  "splash.skillsInstalling": "{count} skills, {elapsed}s",
  "splash.skillsInstallingUnknown": "copying, {elapsed}s",
};
const t = (key, vars = {}) =>
  (COPY[key] ?? key).replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );

const NOW = 1_000_000;

describe("formatBytes", () => {
  it("uses whole MB above a megabyte", () => {
    assert.equal(formatBytes(12.5 * 1024 ** 2), "12.5 MB");
  });

  it("uses KB below one", () => {
    assert.equal(formatBytes(4096), "4 KB");
    // Never "0 KB": a package that downloaded something did not download
    // nothing.
    assert.equal(formatBytes(10), "1 KB");
  });

  it("returns null for counts it cannot show", () => {
    assert.equal(formatBytes(0), null);
    assert.equal(formatBytes(-1), null);
    assert.equal(formatBytes(Number.NaN), null);
    assert.equal(formatBytes(undefined), null);
  });
});

describe("hostOf", () => {
  it("names the mirror's host", () => {
    assert.equal(hostOf("https://pypi.tuna.tsinghua.edu.cn/simple"), "pypi.tuna.tsinghua.edu.cn");
  });

  it("returns null for a value that is not a URL", () => {
    assert.equal(hostOf("not a url"), null);
  });
});

describe("elapsedSeconds", () => {
  it("counts whole seconds from an epoch", () => {
    assert.equal(elapsedSeconds(NOW - 12_400, NOW), 12);
  });

  // A clock that jumped backwards must not show a negative elapsed time.
  it("never goes negative", () => {
    assert.equal(elapsedSeconds(NOW + 5000, NOW), 0);
  });

  it("returns null without a start", () => {
    assert.equal(elapsedSeconds(undefined, NOW), null);
    assert.equal(elapsedSeconds(Number.NaN, NOW), null);
  });
});

describe("pythonHint", () => {
  it("names the mirror before anything has been counted", () => {
    const hint = pythonHint(
      { state: "syncing", index: "https://pypi.tuna.tsinghua.edu.cn/simple", startedAt: NOW },
      t,
      NOW,
    );
    assert.equal(hint, "from pypi.tuna.tsinghua.edu.cn");
  });

  // The whole point of the feature: a multi-minute install has to show motion.
  it("reports packages and bytes as they arrive", () => {
    const hint = pythonHint(
      { state: "syncing", packagesDownloaded: 7, downloadBytes: 40 * 1024 ** 2, startedAt: NOW - 30_000 },
      t,
      NOW,
    );
    assert.equal(hint, "7 packages, 40.0 MB, 30s");
  });

  it("drops the size when uv reported none", () => {
    const hint = pythonHint({ state: "syncing", packagesDownloaded: 3, startedAt: NOW - 8_000 }, t, NOW);
    assert.equal(hint, "3 packages, 8s");
  });

  it("prefers the install count once uv reports it", () => {
    const hint = pythonHint(
      { state: "syncing", packagesDownloaded: 40, packagesInstalled: 177, startedAt: NOW - 60_000 },
      t,
      NOW,
    );
    assert.equal(hint, "installing 177 packages, 60s");
  });

  // uv resolves before it downloads; saying "resolving" in the first couple of
  // seconds would read as a stall on a launch that is merely starting.
  it("stays quiet about resolving until three seconds have passed", () => {
    assert.equal(pythonHint({ state: "syncing", startedAt: NOW - 1_000 }, t, NOW), "installing python packages");
    assert.equal(pythonHint({ state: "syncing", startedAt: NOW - 4_000 }, t, NOW), "resolving, 4s");
  });
});

describe("skillsHint", () => {
  it("falls back to the generic line while cloning starts", () => {
    assert.equal(
      skillsHint({ state: "syncing", phase: "cloning", startedAt: NOW - 1_000 }, t, NOW),
      "downloading the skill library",
    );
  });

  it("names the cloning stage after a few seconds", () => {
    assert.equal(skillsHint({ state: "syncing", phase: "cloning", startedAt: NOW - 20_000 }, t, NOW), "fetching, 20s");
  });

  // The CLI reports the discovered count before copying; showing it is the
  // only concrete number this path can offer.
  it("shows the discovered skill count while copying", () => {
    assert.equal(
      skillsHint({ state: "syncing", phase: "installing", discovered: 177, startedAt: NOW - 90_000 }, t, NOW),
      "177 skills, 90s",
    );
  });

  it("still says what it is doing without a count", () => {
    assert.equal(
      skillsHint({ state: "syncing", phase: "installing", startedAt: NOW - 5_000 }, t, NOW),
      "copying, 5s",
    );
  });
});
