/**
 * How fast the model actually produced output in a session.
 *
 * Deliberately not decode speed: `durationMs` is Pi's monotonic measurement of
 * the whole response, so a slow first token counts against the number. That is
 * the figure a person waiting on the chat feels, and it is the only one the
 * session log records — separating time-to-first-token would mean a new probe
 * on the live path for a number nobody asked to see.
 *
 * The data has been on disk all along. Pi stamps every assistant message with
 * `usage.output` and `durationMs` (see `pi-ai/dist/types.d.ts`), and persists
 * the message verbatim, so this works on every session already in the project
 * rather than only on runs recorded after this shipped.
 */
import { readRows } from "../agent/session-export.ts";

export interface SpeedStats {
  /** Model calls that contributed: assistant messages with output and a duration. */
  calls: number;
  /** Output tokens those calls produced. */
  outputTokens: number;
  /** Wall-clock milliseconds those calls took, summed. */
  durationMs: number;
  /** `outputTokens` over `durationMs` in seconds. `null` when nothing qualified. */
  tokensPerSecond: number | null;
}

export const EMPTY_SPEED: SpeedStats = {
  calls: 0,
  outputTokens: 0,
  durationMs: 0,
  tokensPerSecond: null,
};

/**
 * Sum a session's per-call output rate.
 *
 * A call counts only when it produced output AND recorded a duration. A turn
 * that only issued tool calls has `output: 0`; dividing its duration in would
 * report a session as slower than its tokens were actually emitted. Messages
 * older than the field, or from a provider that reported no usage, are skipped
 * for the same reason — silence is not zero.
 *
 * Summing first and dividing once (rather than averaging per-call rates) keeps
 * a long call from being outweighed by many short ones.
 */
export function summarizeSpeed(
  messages: { role?: string; usage?: { output?: unknown }; durationMs?: unknown }[],
): SpeedStats {
  let calls = 0;
  let outputTokens = 0;
  let durationMs = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const output = message.usage?.output;
    const duration = message.durationMs;
    if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) continue;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) continue;
    calls++;
    outputTokens += output;
    durationMs += duration;
  }
  return {
    calls,
    outputTokens,
    durationMs,
    tokensPerSecond: durationMs > 0 ? outputTokens / (durationMs / 1000) : null,
  };
}

/** Read a session's JSONL file and summarise its output rate. */
export function sessionSpeed(file: string): SpeedStats {
  return summarizeSpeed(readRows(file).map((row) => row.message));
}
