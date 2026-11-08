/**
 * Default shell timeout: the lead's `tool_call` hook and the child package copy
 * must agree, or a subagent would keep hanging where the lead no longer does.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BASH_TIMEOUT_SEC,
  makeBashTimeoutExtension,
} from "../src/agent/bash-timeout.ts";
import { registerBashTimeout } from "../pi-packages/kady-bash-timeout/index.ts";

type Handler = (event: unknown) => Promise<unknown> | unknown;

function installLead(options?: { defaultTimeoutSec?: number }) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
  makeBashTimeoutExtension(options)(pi as unknown as ExtensionAPI);
  return handlers.get("tool_call")!;
}

const call = (toolName: string, input: Record<string, unknown>) => ({
  type: "tool_call",
  toolCallId: "tc1",
  toolName,
  input,
});

describe("bash timeout hook", () => {
  it("fills in the default when the model gave none", async () => {
    const hook = installLead();
    const input: Record<string, unknown> = { command: "sleep 5" };
    await hook(call("bash", input));
    expect(input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SEC);
  });

  it("keeps a timeout the model chose", async () => {
    const hook = installLead();
    const input = { command: "sleep 5", timeout: 42 };
    await hook(call("bash", input));
    expect(input.timeout).toBe(42);
  });

  it("leaves an invalid timeout for Pi to reject", async () => {
    // Pi raises "Invalid timeout: must be a finite number of seconds" and the
    // model can read it. Quietly substituting a valid one would hide its bug.
    const hook = installLead();
    for (const bad of [0, -1, "soon", null]) {
      const input: Record<string, unknown> = { command: "sleep 5", timeout: bad };
      await hook(call("bash", input));
      expect(input.timeout).toBe(bad);
    }
  });

  it("covers powershell, which shares Pi's bash schema", async () => {
    const hook = installLead();
    const input: Record<string, unknown> = { command: "Start-Sleep 5" };
    await hook(call("powershell", input));
    expect(input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SEC);
  });

  it("touches nothing but shell tools", async () => {
    const hook = installLead();
    for (const toolName of ["read", "write", "edit", "grep", "subagent", "notebook"]) {
      const input: Record<string, unknown> = { path: "a.txt" };
      await hook(call(toolName, input));
      expect(input).toEqual({ path: "a.txt" });
    }
  });

  it("never rewrites the command", async () => {
    const hook = installLead();
    const input: Record<string, unknown> = { command: "rm -rf user_data && echo done" };
    await hook(call("bash", input));
    expect(input.command).toBe("rm -rf user_data && echo done");
  });

  it("honours a custom default", async () => {
    const hook = installLead({ defaultTimeoutSec: 10 });
    const input: Record<string, unknown> = { command: "sleep 5" };
    await hook(call("bash", input));
    expect(input.timeout).toBe(10);
  });
});

describe("child package", () => {
  it("matches the lead's default so both ceilings agree", () => {
    // The package cannot import from src/ (separate process, own loader), so
    // the constant is duplicated by hand. Pin the agreement here.
    const handlers = new Map<string, Handler>();
    const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
    registerBashTimeout(pi as unknown as ExtensionAPI);
    const input: Record<string, unknown> = { command: "sleep 5" };
    handlers.get("tool_call")!(call("bash", input));
    expect(input.timeout).toBe(DEFAULT_BASH_TIMEOUT_SEC);
  });

  it("is referenced from sandbox settings.json for child sessions", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { seedBashTimeoutPackage, kadyBashTimeoutPackageDir } = await import(
      "../src/agent/bash-timeout-bridge.ts"
    );
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kady-bash-timeout-"));
    try {
      const paths = { sandbox } as Parameters<typeof seedBashTimeoutPackage>[0];
      expect(seedBashTimeoutPackage(paths)).toBe(true);
      // Idempotent: a second boot must not rewrite the file.
      expect(seedBashTimeoutPackage(paths)).toBe(false);
      const settings = JSON.parse(
        fs.readFileSync(path.join(sandbox, ".pi", "settings.json"), "utf-8"),
      );
      expect(settings.packages).toContain(kadyBashTimeoutPackageDir());
      expect(fs.existsSync(path.join(kadyBashTimeoutPackageDir(), "index.ts"))).toBe(true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("leaves a malformed settings file alone rather than resetting it", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { seedBashTimeoutPackage } = await import("../src/agent/bash-timeout-bridge.ts");
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kady-bash-timeout-bad-"));
    try {
      fs.mkdirSync(path.join(sandbox, ".pi"), { recursive: true });
      const file = path.join(sandbox, ".pi", "settings.json");
      fs.writeFileSync(file, "{ not json", "utf-8");
      expect(seedBashTimeoutPackage({ sandbox } as Parameters<typeof seedBashTimeoutPackage>[0])).toBe(false);
      expect(fs.readFileSync(file, "utf-8")).toBe("{ not json");
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
