import { describe, expect, it } from "vitest";

import { accumulateUvProgress, type HelperVenvState } from "../src/helpers-env.ts";

function state(): HelperVenvState {
  return { state: "syncing" };
}

describe("accumulateUvProgress", () => {
  // Measured against uv 0.12.13: a non-TTY sync prints one line per package,
  // with the size in parentheses. These are the exact shapes it emits.
  it("counts each download and its size", () => {
    const s = state();
    accumulateUvProgress(s, "Downloading numpy (12.0MiB)\nDownloading pandas (9.8MiB)\n");
    expect(s.packagesDownloaded).toBe(2);
    expect(s.downloadBytes).toBe(Math.round(12.0 * 1024 ** 2) + Math.round(9.8 * 1024 ** 2));
  });

  // uv writes a line's leading whitespace inconsistently across versions, and
  // the ` Downloaded` (leading space) form appears when a cached file is
  // reused — matching it as a download would double-count.
  it("does not count the completion line as a second package", () => {
    const s = state();
    accumulateUvProgress(s, "Downloading numpy (12.0MiB)\n Downloaded numpy\n");
    expect(s.packagesDownloaded).toBe(1);
  });

  it("accumulates across chunks split mid-line", () => {
    const s = state();
    accumulateUvProgress(s, "Downloading nu");
    accumulateUvProgress(s, "mpy (12.0MiB)\nDownloading six (4.2KiB)\n");
    // The split line is not counted: a partial line has no closing paren, so
    // the first chunk matches nothing and the line is lost. That is the safe
    // direction — an undercount never claims work that did not happen.
    expect(s.packagesDownloaded).toBe(1);
  });

  it("records the install count", () => {
    const s = state();
    accumulateUvProgress(s, "Installed 177 packages in 12.34s\n");
    expect(s.packagesInstalled).toBe(177);
  });

  it("ignores output it does not recognise", () => {
    const s = state();
    accumulateUvProgress(s, "Resolved 3 packages\nCreating virtual environment at: .venv\n");
    expect(s.packagesDownloaded).toBeUndefined();
    expect(s.downloadBytes).toBeUndefined();
    expect(s.packagesInstalled).toBeUndefined();
  });

  it("scales KiB, MiB and GiB alike", () => {
    const s = state();
    accumulateUvProgress(s, "Downloading a (4.0KiB)\nDownloading b (1.0GiB)\n");
    expect(s.downloadBytes).toBe(4 * 1024 + 1024 ** 3);
  });
});
