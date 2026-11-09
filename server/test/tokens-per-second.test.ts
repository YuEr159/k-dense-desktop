/**
 * Output-rate summary: the number the cost pill's hover card shows.
 *
 * Because it divides by the whole response's duration (not time-to-first-token),
 * a call that thought for a long time before emitting anything reads as slow.
 * That is intended — see the module comment in tokens-per-second.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMPTY_SPEED, sessionSpeed, summarizeSpeed } from "../src/cost/tokens-per-second.ts";

const assistant = (output: number, durationMs: number) => ({
  role: "assistant",
  usage: { output },
  durationMs,
});

describe("summarizeSpeed", () => {
  it("sums tokens and duration, then divides once", () => {
    const stats = summarizeSpeed([assistant(100, 1_000), assistant(300, 1_000)]);
    expect(stats.calls).toBe(2);
    expect(stats.outputTokens).toBe(400);
    expect(stats.durationMs).toBe(2_000);
    expect(stats.tokensPerSecond).toBe(200);
  });

  it("weights by duration, not by call count", () => {
    // Averaging per-call rates would give (100 + 10) / 2 = 55; summing first
    // gives the honest 110, so one long call is not drowned out by a short one.
    const stats = summarizeSpeed([assistant(1_000, 10_000), assistant(1, 100)]);
    expect(stats.tokensPerSecond).toBeCloseTo(1_001 / 10.1, 5);
  });

  it("skips calls that produced no output", () => {
    // A turn that only issues tool calls has output 0. Counting its duration
    // would report the session as slower than its tokens were emitted.
    const stats = summarizeSpeed([assistant(0, 5_000), assistant(200, 1_000)]);
    expect(stats.calls).toBe(1);
    expect(stats.outputTokens).toBe(200);
    expect(stats.tokensPerSecond).toBe(200);
  });

  it("skips calls without a usable duration", () => {
    const stats = summarizeSpeed([
      { role: "assistant", usage: { output: 50 } },
      { role: "assistant", usage: { output: 50 }, durationMs: 0 },
      { role: "assistant", usage: { output: 50 }, durationMs: Number.NaN },
      assistant(200, 1_000),
    ]);
    expect(stats.calls).toBe(1);
    expect(stats.tokensPerSecond).toBe(200);
  });

  it("ignores non-assistant roles", () => {
    const stats = summarizeSpeed([
      { role: "user", usage: { output: 999 }, durationMs: 1_000 },
      { role: "toolResult", usage: { output: 999 }, durationMs: 1_000 },
      assistant(100, 1_000),
    ]);
    expect(stats.calls).toBe(1);
    expect(stats.outputTokens).toBe(100);
  });

  it("reports null rather than 0 when nothing qualified", () => {
    // 0 would read as "very slow"; null lets the UI hide the row entirely.
    expect(summarizeSpeed([]).tokensPerSecond).toBeNull();
    expect(summarizeSpeed([assistant(0, 1_000)]).tokensPerSecond).toBeNull();
    expect(summarizeSpeed([assistant(0, 1_000)])).toMatchObject({ calls: 0, outputTokens: 0 });
  });

  it("has an EMPTY_SPEED constant matching an empty summary", () => {
    expect(EMPTY_SPEED).toEqual(summarizeSpeed([]));
  });
});

describe("sessionSpeed", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-speed-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads assistant rows out of a session JSONL", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        { type: "message", message: assistant(120, 1_000) },
        { type: "message", message: { role: "toolResult", toolCallId: "t1", content: [] } },
        { type: "message", message: assistant(0, 9_000) },
        { type: "message", message: { role: "assistant", usage: { output: 80 } } },
        { type: "message", message: assistant(280, 2_000) },
        "not json at all",
      ]
        .map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
        .join("\n") + "\n",
      "utf-8",
    );

    const stats = sessionSpeed(file);
    expect(stats.calls).toBe(2);
    expect(stats.outputTokens).toBe(400);
    expect(stats.durationMs).toBe(3_000);
    expect(stats.tokensPerSecond).toBeCloseTo(133.33, 1);
  });

  it("returns the empty summary for a session with no assistant rows", () => {
    const file = path.join(dir, "empty.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "message", message: { role: "user", content: [] } }) + "\n",
      "utf-8",
    );
    expect(sessionSpeed(file)).toEqual(EMPTY_SPEED);
  });
});
