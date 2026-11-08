import fs from "node:fs";
import path from "node:path";
import { createMcpExtension, createCodemodeExtension, createToolSearchExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";
import { registerChildGuard } from "../kady-guard/index.ts";
import { registerChildNotebook } from "../kady-notebook/index.ts";
import { registerChildModal } from "../kady-modal/index.ts";
import { registerChildPdfAnnotations } from "../kady-pdf-annotations/index.ts";
import { CHILD_OPERATING_GUIDANCE, setSubagentPromptSection, userInstructionsPreamble } from "../../src/agent/subagent-prompts.ts";
import { USER_INSTRUCTIONS_SECTION, readProjectInstructionsAtSandbox } from "../../src/agent/project-instructions.ts";
import { resolveSandboxRoot } from "../../src/agent/sandbox-root.ts";

export default function (pi: ExtensionAPI) {
  // A required runtime section reaches existing/custom personas, including
  // replace-mode agents and children with project context/skills disabled.
  pi.on("before_agent_start", (event, ctx) => {
    setSubagentPromptSection(event, "kady_specialist", CHILD_OPERATING_GUIDANCE);
    // The user's own instructions reach the lead through the setting this
    // process cannot see; reading the same file the lead wrote is the only
    // route. Skipped, never guessed, when the sandbox is not above this cwd.
    const root = resolveSandboxRoot(ctx.cwd);
    if (!root) return;
    const text = readProjectInstructionsAtSandbox(root).trim();
    if (text === "") return;
    // A child is always started by someone else, so the run never has a person
    // in front of it.
    setSubagentPromptSection(
      event,
      USER_INSTRUCTIONS_SECTION,
      `${userInstructionsPreamble(true)}\n\n${text}`,
    );
  });
  // Required extensions also load in foreground children, where the process
  // env is not a reliable identity. This file is never installed in the lead.
  if (!process.env.PI_SUBAGENT_CHILD) {
    registerChildGuard(pi);
    registerChildNotebook(pi);
    registerChildModal(pi);
    registerChildPdfAnnotations(pi);
  }
  createCodemodeExtension()(pi);
  createToolSearchExtension()(pi);
  createMcpExtension()(pi);
  let dispose: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    const root = resolveSandboxRoot(ctx.cwd);
    const jobsDir = root ? path.join(root, ".kady", "modal", "jobs") : null;
    dispose = registerBackgroundWorkProvider({
      name: `kady-modal-child:${sessionId}`,
      listActiveWork(context) {
        if (context?.sessionId !== sessionId || !jobsDir || !fs.existsSync(jobsDir)) return [];
        return fs.readdirSync(jobsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap(({ name: id }) => {
          const filePath = path.join(jobsDir, id, "job.json");
          if (!fs.existsSync(filePath)) return [];
          const job = JSON.parse(fs.readFileSync(filePath, "utf8"));
          return job.owner?.subagentSessionFile === file && !["succeeded", "failed", "cancelled", "lost"].includes(job.state)
            ? [{ id: `modal:${job.id}`, sessionId }] : [];
        });
      },
    });
    pi.events.emit("subagent:acknowledge-extension", { id: "kady-child-runtime" });
  });
  pi.on("session_shutdown", () => dispose?.());
}
