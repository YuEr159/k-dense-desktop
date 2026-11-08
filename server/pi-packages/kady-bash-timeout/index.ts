/**
 * kady-bash-timeout — the same shell-command ceiling the lead session gets from
 * `server/src/agent/bash-timeout.ts`, for CHILD pi processes (background
 * specialists). A child has no chat UI and no Stop button, so a command that
 * never returns keeps it — and whoever is waiting on it — blocked.
 *
 * The lead runs its own copy in-process; this one self-gates on
 * PI_SUBAGENT_CHILD so the lead never registers the hook twice.
 *
 * Kept in sync with `DEFAULT_BASH_TIMEOUT_SEC` in bash-timeout.ts by hand: the
 * package is loaded by a separate process that cannot import from src/.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASH_TIMEOUT_SEC = 30 * 60;

const SHELL_TOOLS = new Set(["bash", "powershell"]);

export default function (pi: ExtensionAPI): void {
  if (!process.env.PI_SUBAGENT_CHILD) return;
  registerBashTimeout(pi);
}

export function registerBashTimeout(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return undefined;
    const input = event.input as { timeout?: unknown };
    if (input.timeout !== undefined) return undefined;
    input.timeout = DEFAULT_BASH_TIMEOUT_SEC;
    return undefined;
  });
}
