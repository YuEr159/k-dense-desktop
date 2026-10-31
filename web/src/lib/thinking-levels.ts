/**
 * Pi's reasoning levels (`ThinkingLevel` in @earendil-works/pi-agent-core).
 *
 * One list for the whole frontend: the selector renders it, agent frontmatter
 * validates against it, and workspace persistence restores from it. Keep it in
 * step with the backend's `server/src/agent/thinking.ts` and with Pi itself —
 * a level the SDK accepts but this list omits is silently dropped on reload.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVEL_IDS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";
