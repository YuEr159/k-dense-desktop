import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PROJECT_INSTRUCTIONS,
  USER_INSTRUCTIONS_SECTION,
  readProjectInstructions,
  readProjectInstructionsAtSandbox,
  validateProjectInstructions,
  writeProjectInstructions,
} from "../src/agent/project-instructions.ts";
import { instructionsSection, isSystemInitiated } from "../src/agent/project-instructions-extension.ts";
import { isParentWake, PARENT_WAKE_TEXT } from "../src/agent/subagent-wake.ts";
import type { ProjectPaths } from "../src/projects.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-instr-"));
  cleanup.push(root);
  return { kadyDir: path.join(root, ".kady") } as ProjectPaths;
}

describe("project instructions storage", () => {
  it("reads a missing file as empty instead of throwing", () => {
    expect(readProjectInstructions(project())).toBe("");
  });

  it("round-trips through the file, creating .kady", () => {
    const paths = project();
    writeProjectInstructions(paths, "Use R for statistics.\n");
    expect(readProjectInstructions(paths)).toBe("Use R for statistics.\n");
  });

  it("replaces the previous text rather than appending", () => {
    const paths = project();
    writeProjectInstructions(paths, "first");
    writeProjectInstructions(paths, "second");
    expect(readProjectInstructions(paths)).toBe("second");
  });

  it("finds the file from a sandbox root alone", () => {
    const paths = project();
    writeProjectInstructions(paths, "from the sandbox");
    expect(readProjectInstructionsAtSandbox(path.dirname(paths.kadyDir))).toBe("from the sandbox");
  });

  it("returns the empty string when the file is unreadable", () => {
    const paths = project();
    fs.mkdirSync(paths.kadyDir, { recursive: true });
    // A directory where the file should be: read fails with EISDIR.
    fs.mkdirSync(path.join(paths.kadyDir, "instructions.md"));
    expect(readProjectInstructions(paths)).toBe("");
  });
});

describe("validateProjectInstructions", () => {
  it("accepts empty text and text at the limit", () => {
    expect(validateProjectInstructions("")).toBeNull();
    expect(validateProjectInstructions("x".repeat(MAX_PROJECT_INSTRUCTIONS))).toBeNull();
  });

  // Rejecting rather than truncating: a shortened instruction reads as saved
  // and then quietly stops applying.
  it("rejects text past the limit", () => {
    expect(validateProjectInstructions("x".repeat(MAX_PROJECT_INSTRUCTIONS + 1))).toMatch(/at most/);
  });

  it("rejects non-strings", () => {
    expect(validateProjectInstructions(undefined)).toMatch(/string/);
    expect(validateProjectInstructions(42)).toMatch(/string/);
  });
});

describe("isSystemInitiated", () => {
  it("treats a custom message as system-initiated", () => {
    expect(isSystemInitiated({ type: "before_agent_start", messageType: "custom" } as never)).toBe(true);
  });

  // The parent wake is sent as a plain user message, so messageType alone
  // cannot tell it apart from something the user typed.
  it("recognises the parent wake despite its user message type", () => {
    expect(isSystemInitiated({
      type: "before_agent_start",
      messageType: "user",
      prompt: PARENT_WAKE_TEXT,
    } as never)).toBe(true);
    expect(isParentWake(PARENT_WAKE_TEXT)).toBe(true);
  });

  it("leaves a real user prompt alone", () => {
    expect(isSystemInitiated({
      type: "before_agent_start",
      messageType: "user",
      prompt: "Analyse the third replicate",
    } as never)).toBe(false);
  });
});

describe("instructionsSection", () => {
  const userEvent = {
    type: "before_agent_start",
    messageType: "user",
    prompt: "Analyse the third replicate",
  } as never;
  const customEvent = { type: "before_agent_start", messageType: "custom" } as never;

  it("is null for empty or whitespace-only text", () => {
    expect(instructionsSection(userEvent, "")).toBeNull();
    expect(instructionsSection(userEvent, "   \n\t ")).toBeNull();
  });

  it("carries the user's words verbatim", () => {
    const section = instructionsSection(userEvent, "Use R, never Python.");
    expect(section).toContain("Use R, never Python.");
  });

  // An instruction like "ask me before every edit" would stall an unattended
  // run rather than being followed.
  it("tells an unattended run to use its judgement instead of waiting", () => {
    const attended = instructionsSection(userEvent, "Use R.");
    const unattended = instructionsSection(customEvent, "Use R.");
    expect(attended).not.toBe(unattended);
    expect(unattended).toMatch(/nobody is watching/);
    expect(attended).toMatch(/Follow them/);
  });

  it("names the section Pi will wrap it in", () => {
    expect(USER_INSTRUCTIONS_SECTION).toBe("kady_user_instructions");
  });
});
