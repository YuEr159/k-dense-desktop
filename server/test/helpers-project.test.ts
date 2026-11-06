import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { helperProjectDirectory, HELPERS_DIR } from "../src/helpers-env.ts";
const original = process.env.KADY_HELPERS_PROJECT_DIR;
const originalIndex = process.env.KADY_PYPI_INDEX;
afterEach(() => {
  if (original === undefined) delete process.env.KADY_HELPERS_PROJECT_DIR;
  else process.env.KADY_HELPERS_PROJECT_DIR = original;
  if (originalIndex === undefined) delete process.env.KADY_PYPI_INDEX;
  else process.env.KADY_PYPI_INDEX = originalIndex;
});
it("copies project metadata to writable storage without modifying shipped resources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-helper-project-"));
  try {
    process.env.KADY_HELPERS_PROJECT_DIR = dir;
    expect(helperProjectDirectory(process.env.KADY_PYPI_INDEX ?? null)).toBe(dir);
    for (const name of ["pyproject.toml", "uv.lock"]) {
      expect(fs.readFileSync(path.join(dir, name))).toEqual(fs.readFileSync(path.join(HELPERS_DIR, name)));
    }
    fs.writeFileSync(path.join(dir, "uv.lock"), "stale local lock");
    helperProjectDirectory(process.env.KADY_PYPI_INDEX ?? null);
    expect(fs.readFileSync(path.join(dir, "uv.lock"))).toEqual(fs.readFileSync(path.join(HELPERS_DIR, "uv.lock")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it("source mode retains the existing helper location", () => {
  delete process.env.KADY_HELPERS_PROJECT_DIR;
  expect(helperProjectDirectory(process.env.KADY_PYPI_INDEX ?? null)).toBe(HELPERS_DIR);
});

describe("mirror lock rewrite", () => {
  const withMirror = (index: string | undefined, run: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-helper-mirror-"));
    try {
      process.env.KADY_HELPERS_PROJECT_DIR = dir;
      if (index === undefined) delete process.env.KADY_PYPI_INDEX;
      else process.env.KADY_PYPI_INDEX = index;
      helperProjectDirectory(process.env.KADY_PYPI_INDEX ?? null);
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  // `--frozen` downloads from the lock's absolute URLs, so an index setting
  // alone changes nothing; the hosts in the copied lock have to move too.
  it("points the copied lock at the mirror", () => {
    withMirror("https://pypi.tuna.tsinghua.edu.cn/simple", (dir) => {
      const lock = fs.readFileSync(path.join(dir, "uv.lock"), "utf-8");
      expect(lock).toContain('source = { registry = "https://pypi.tuna.tsinghua.edu.cn/simple" }');
      expect(lock).toContain("https://pypi.tuna.tsinghua.edu.cn/packages/");
      expect(lock).not.toContain("pypi.org");
      expect(lock).not.toContain("files.pythonhosted.org");
    });
  });

  // A mirror must not be able to change *what* is installed, only where it
  // comes from: the digests are what make the rewrite safe.
  it("keeps every version and checksum verbatim", () => {
    const digest = (lock: string) => lock.match(/hash = "sha256:[0-9a-f]+"/g) ?? [];
    const shipped = fs.readFileSync(path.join(HELPERS_DIR, "uv.lock"), "utf-8");
    withMirror("https://pypi.tuna.tsinghua.edu.cn/simple", (dir) => {
      const rewritten = fs.readFileSync(path.join(dir, "uv.lock"), "utf-8");
      expect(digest(rewritten)).toEqual(digest(shipped));
      expect(rewritten.match(/^version = ".*"$/gm)).toEqual(shipped.match(/^version = ".*"$/gm));
    });
  });

  it("leaves the shipped lock untouched and copies verbatim when no mirror is set", () => {
    const shipped = fs.readFileSync(path.join(HELPERS_DIR, "uv.lock"), "utf-8");
    withMirror(undefined, (dir) => {
      expect(fs.readFileSync(path.join(dir, "uv.lock"), "utf-8")).toBe(shipped);
    });
    // The rewrite happens on the copy, never on the signed payload.
    expect(fs.readFileSync(path.join(HELPERS_DIR, "uv.lock"), "utf-8")).toBe(shipped);
  });

  it("ignores a value that is not an http(s) URL", () => {
    withMirror("not a url", (dir) => {
      expect(fs.readFileSync(path.join(dir, "uv.lock"), "utf-8")).toBe(
        fs.readFileSync(path.join(HELPERS_DIR, "uv.lock"), "utf-8"),
      );
    });
  });
});
