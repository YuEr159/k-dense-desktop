/**
 * A default timeout for shell commands.
 *
 * Pi's bash tool ships with **no** default timeout: `timeout` is optional and
 * the schema says so. That is right for an interactive TUI, where a person can
 * press Escape, but wrong for Kady: a chat turn blocks on the tool, so one
 * call that never returns — `urllib.request.urlopen` with no timeout is the
 * real case that prompted this — hangs the whole run until the user notices a
 * spinner that looks identical to a fast call.
 *
 * A `tool_call` hook can mutate `event.input` in place, which Pi documents as
 * the supported way to patch arguments before execution, and later handlers see
 * the mutation. Pi's own enforcement then applies: the process tree is killed
 * and the model gets `Command timed out after N seconds`, which it can act on.
 *
 * Deliberately narrow:
 *   - only fills in a MISSING timeout; a value the model chose always wins,
 *     because it knows a training run is meant to take an hour;
 *   - never rewrites the command, so the raw-data guard and everything else
 *     that inspects it sees exactly what the model wrote.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Thirty minutes, matching the three defaults pi-subagents uses for its own
 * long-running work (`DEFAULT_*_TIMEOUT_MS` in runs/background/async-execution,
 * auto-drain and subagent-wait). Lower would kill legitimate builds and model
 * fits; higher buys nothing, since a command still running after half an hour
 * is far more likely wedged than busy.
 */
export const DEFAULT_BASH_TIMEOUT_SEC = 30 * 60;

/** Tools that run a shell command and accept Pi's `timeout` argument. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export function makeBashTimeoutExtension(
  options: { defaultTimeoutSec?: number } = {},
): ExtensionFactory {
  const defaultTimeoutSec = options.defaultTimeoutSec ?? DEFAULT_BASH_TIMEOUT_SEC;
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (!SHELL_TOOLS.has(event.toolName)) return undefined;
      const input = event.input as { timeout?: unknown };
      // Any value the model supplied is left alone, including a bad one: Pi
      // rejects an invalid timeout with an error the model can read, and
      // silently replacing it would hide its own mistake from it.
      if (input.timeout !== undefined) return undefined;
      input.timeout = defaultTimeoutSec;
      return undefined;
    });
  };
}
