import { describe, expect, it } from "vitest";
import { parseThinkingLevel, THINKING_LEVELS } from "../src/agent/thinking.ts";

describe("parseThinkingLevel", () => {
  it("accepts every Pi level", () => {
    // The list's *contents* are checked against Pi's own type in
    // thinking-levels.test.ts. Hard-coding them here as well made this test
    // fail on a Pi upgrade that legitimately added a level ("max" in 1.0)
    // while saying nothing about the parser it claims to cover.
    for (const level of THINKING_LEVELS) {
      expect(parseThinkingLevel(level)).toBe(level);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(parseThinkingLevel("ultra")).toBeUndefined();
    expect(parseThinkingLevel("OFF")).toBeUndefined();
    expect(parseThinkingLevel("")).toBeUndefined();
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    expect(parseThinkingLevel(null)).toBeUndefined();
    expect(parseThinkingLevel(3)).toBeUndefined();
    expect(parseThinkingLevel({ level: "high" })).toBeUndefined();
  });
});
