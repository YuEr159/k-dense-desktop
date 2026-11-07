/**
 * Injects the project's user-authored instructions as the last system-prompt
 * section, so they read as an addition on top of everything Kady already says
 * rather than a replacement for it.
 *
 * Registered after the subagent-control factory: Pi renders sections in object
 * insertion order, and that factory writes `kady_delegation` during the same
 * `before_agent_start`, so going last keeps the user's text at the bottom.
 */
import type { ExtensionFactory, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../projects.ts";
import { USER_INSTRUCTIONS_SECTION, readProjectInstructions } from "./project-instructions.ts";
import { setSubagentPromptSection, userInstructionsPreamble } from "./subagent-prompts.ts";
import { isParentWake } from "./subagent-wake.ts";

/**
 * A run nobody is watching: a scheduled/completion notice arrives as a custom
 * message, and a child waking the lead arrives as a plain user message that is
 * indistinguishable from one the user typed.
 */
export function isSystemInitiated(event: BeforeAgentStartEvent): boolean {
  if (event.messageType === "custom") return true;
  return isParentWake(event.prompt);
}

/** The section text, or null when the project has no instructions. */
export function instructionsSection(event: BeforeAgentStartEvent, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return `${userInstructionsPreamble(isSystemInitiated(event))}\n\n${trimmed}`;
}

export function makeUserInstructionsExtension(paths: ProjectPaths): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const section = instructionsSection(event, readProjectInstructions(paths));
      // An empty project leaves the key absent rather than present-and-blank:
      // a handler registered later must still be able to claim the last slot.
      if (section) setSubagentPromptSection(event, USER_INSTRUCTIONS_SECTION, section);
    });
  };
}
