import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSandboxRoot } from "../src/agent/sandbox-root.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-root-"));
  cleanup.push(root);
  const sandbox = path.join(root, "projects", "abc", "sandbox");
  fs.mkdirSync(path.join(sandbox, "user_data", "deep"), { recursive: true });
  return { root, sandbox };
}

describe("resolveSandboxRoot", () => {
  it("finds the sandbox itself", () => {
    const { sandbox } = project();
    expect(resolveSandboxRoot(sandbox)).toBe(sandbox);
  });

  it("finds it from a nested working directory", () => {
    const { sandbox } = project();
    expect(resolveSandboxRoot(path.join(sandbox, "user_data", "deep"))).toBe(sandbox);
  });

  // The old inline loop walked to the filesystem root and returned it, turning
  // every lookup into a read of a path that cannot exist.
  it("returns null when there is no sandbox ancestor", () => {
    const { root } = project();
    expect(resolveSandboxRoot(root)).toBeNull();
  });

  it("returns null at the filesystem root", () => {
    expect(resolveSandboxRoot(path.parse(os.tmpdir()).root)).toBeNull();
  });
});
