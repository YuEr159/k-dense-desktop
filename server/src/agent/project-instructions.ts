/**
 * The user's own standing instructions for a project, injected at the end of
 * the system prompt on every run (lead and children alike).
 *
 * Kept as plain markdown in `sandbox/.kady/instructions.md` rather than a key
 * inside `sandbox/.pi/settings.json`: that file is read with a JSON parser that
 * returns `{}` for anything malformed, so a read-modify-write there would
 * silently replace the user's Pi settings with an empty object. Prose also has
 * no business being JSON-escaped.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";

/** Section name Pi wraps this in; also the key handlers write. */
export const USER_INSTRUCTIONS_SECTION = "kady_user_instructions";

/**
 * Generous for a few paragraphs of conventions, small enough that it cannot
 * crowd out the real prompt. Enforced by rejection, never truncation: a
 * silently shortened instruction reads as "saved" and then quietly stops
 * applying.
 */
export const MAX_PROJECT_INSTRUCTIONS = 4_000;

export function projectInstructionsPath(paths: Pick<ProjectPaths, "kadyDir">): string {
  return path.join(paths.kadyDir, "instructions.md");
}

/**
 * The stored instructions, or "" when there are none.
 *
 * Never throws: a chat must open even if the file is unreadable. The failure is
 * logged because the alternative is an instruction that silently stops
 * applying with nothing to point at.
 */
export function readProjectInstructions(paths: Pick<ProjectPaths, "kadyDir">): string {
  const file = projectInstructionsPath(paths);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[instructions] could not read ${file}: ${(exc as Error).message}`);
    }
    return "";
  }
}

/** Read-only variant for a process that only knows its sandbox root. */
export function readProjectInstructionsAtSandbox(sandbox: string): string {
  return readProjectInstructions({ kadyDir: path.join(sandbox, ".kady") });
}

/** Returns an error message, or null when the text is acceptable. */
export function validateProjectInstructions(text: unknown): string | null {
  if (typeof text !== "string") return "text must be a string";
  if (text.length > MAX_PROJECT_INSTRUCTIONS) {
    return `text must be at most ${MAX_PROJECT_INSTRUCTIONS} characters (got ${text.length})`;
  }
  // A NUL or a lone surrogate would come back mangled from the file and make
  // the user doubt what they typed.
  if (/[\u0000\uD800-\uDFFF]/.test(text)) return "text contains characters that cannot be stored";
  return null;
}

/**
 * Store the instructions. Throws on failure so the route can report why
 * (unwritable directory, full disk) instead of a message that fits every case.
 */
export function writeProjectInstructions(
  paths: Pick<ProjectPaths, "kadyDir">,
  text: string,
): void {
  const file = projectInstructionsPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}
