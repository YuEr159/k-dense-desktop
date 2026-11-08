import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePaths } from "../src/projects.ts";
import {
  environmentBytes,
  isRunnerVanishedMessage,
  launchFailuresPath,
  readAsyncRunFacts,
  readLaunchFailures,
  recordLaunchFailure,
  salvageChildSession,
  subagentTempRoot,
} from "../src/agent/subagents-diagnostics.ts";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kady-diag-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function projectPaths() {
  const paths = resolvePaths("diag");
  fs.rmSync(paths.root, { recursive: true, force: true });
  fs.mkdirSync(paths.sandbox, { recursive: true });
  return paths;
}

/** A run directory shaped like pi-subagents' `async-subagent-runs/<runId>`. */
function failingRunDir(runId: string, exitCode: number): string {
  const dir = path.join(subagentTempRoot(), "async-subagent-runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "process-terminal.json"),
    JSON.stringify({
      version: 1,
      state: "unknown",
      runId,
      instances: [{ kind: "runner", exitCode, signal: null, closeObservedAt: 1794066543351 }],
    }),
  );
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId, pid: 57100 }));
  return dir;
}

describe("environmentBytes", () => {
  it("counts name + NUL + value + NUL per variable, like an environment block", () => {
    const { bytes, keys } = environmentBytes({ A: "1", BB: "22" } as NodeJS.ProcessEnv);
    expect(keys).toBe(2);
    // A\0 1\0 BB\0 22\0 = 2 + 2 + 3 + 3 = 10
    expect(bytes).toBe(10);
  });

  it("skips undefined values rather than counting them", () => {
    const env = { A: "1" } as NodeJS.ProcessEnv;
    (env as Record<string, string | undefined>).B = undefined;
    expect(environmentBytes(env)).toEqual({ bytes: 4, keys: 1 });
  });
});

describe("subagentTempRoot", () => {
  it("honours PI_SUBAGENTS_TEMP_ROOT", () => {
    expect(subagentTempRoot({ PI_SUBAGENTS_TEMP_ROOT: scratch } as NodeJS.ProcessEnv)).toBe(
      path.resolve(scratch),
    );
  });

  it("sanitizes the user name the way pi-subagents does", () => {
    // resolveTempScopeId falls back to `user-<sanitized USERNAME>` on Windows.
    const root = subagentTempRoot({ USERNAME: "Yuxiao Lu" } as NodeJS.ProcessEnv);
    if (typeof process.getuid === "function") {
      expect(root).toBe(path.join(os.tmpdir(), `pi-subagents-uid-${process.getuid()}`));
    } else {
      expect(path.basename(root)).toBe("pi-subagents-user-Yuxiao-Lu");
    }
  });
});

describe("readAsyncRunFacts", () => {
  it("reads the exit code, pid and log sizes from the run directory", () => {
    const dir = failingRunDir("run-a", 3221225794);
    fs.writeFileSync(path.join(dir, "runner.stdout.log"), "");
    fs.writeFileSync(path.join(dir, "runner.stderr.log"), "x");

    const facts = readAsyncRunFacts(dir);
    expect(facts.exitCode).toBe(3221225794);
    expect(facts.pid).toBe(57100);
    expect(facts.runnerStdoutBytes).toBe(0);
    expect(facts.runnerStderrBytes).toBe(1);
  });

  it("degrades to zeroes when the launch never wrote its bookkeeping", () => {
    const dir = path.join(scratch, "missing-run");
    fs.mkdirSync(dir, { recursive: true });
    expect(readAsyncRunFacts(dir)).toEqual({ runnerStdoutBytes: 0, runnerStderrBytes: 0 });
  });
});

describe("recordLaunchFailure", () => {
  it("records the exit code and log sizes, and reads them back", () => {
    const paths = projectPaths();
    const asyncDir = failingRunDir("run-b", 3221225794);

    const record = recordLaunchFailure(paths, {
      runId: "run-b",
      durationMs: 192.4,
      asyncDir,
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      note: "runner vanished before writing a result",
    });

    expect(record).toMatchObject({
      runId: "run-b",
      exitCode: 3221225794,
      exitCodeHex: "0xc0000142",
      durationMs: 192,
      envKeys: 1,
      runnerStdoutBytes: 0,
      runnerStderrBytes: 0,
    });
    expect(readLaunchFailures(paths)).toEqual([record]);
    expect(fs.existsSync(launchFailuresPath(paths))).toBe(true);
  });

  it("records a failure whose run directory is gone, with no exit code", () => {
    const paths = projectPaths();
    const record = recordLaunchFailure(paths, {
      runId: "run-gone",
      durationMs: 5,
      asyncDir: path.join(scratch, "nowhere"),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(record).not.toBeNull();
    expect(record!.exitCode).toBeUndefined();
    expect(record!.exitCodeHex).toBeUndefined();
    expect(record!.runnerStdoutBytes).toBe(0);
  });

  it("trims the log to the newest 100 records once it passes 200", () => {
    const paths = projectPaths();
    for (let index = 0; index < 201; index++) {
      recordLaunchFailure(paths, {
        runId: `run-${index}`,
        durationMs: index,
        env: {} as NodeJS.ProcessEnv,
      });
    }
    const records = readLaunchFailures(paths);
    expect(records).toHaveLength(100);
    expect(records[0].runId).toBe("run-101");
    expect(records[99].runId).toBe("run-200");
  });

  it("never throws when the project directory cannot be written", () => {
    const paths = projectPaths();
    // A file where the directory should be: mkdir/write both fail.
    fs.rmSync(paths.kadyDir, { recursive: true, force: true });
    fs.writeFileSync(paths.kadyDir, "not a directory");
    expect(recordLaunchFailure(paths, {
      runId: "run-x",
      durationMs: 1,
      env: {} as NodeJS.ProcessEnv,
    })).toBeNull();
  });
});

describe("isRunnerVanishedMessage", () => {
  it("matches pi-subagents' repair text", () => {
    expect(isRunnerVanishedMessage("Async runner process 52672 exited or disappeared before writing a result.")).toBe(true);
    expect(isRunnerVanishedMessage("exited or disappeared before writing a result")).toBe(true);
  });

  it("does not match other failures", () => {
    expect(isRunnerVanishedMessage("Model returned an error")).toBe(false);
    expect(isRunnerVanishedMessage(undefined)).toBe(false);
    expect(isRunnerVanishedMessage("")).toBe(false);
  });
});

describe("salvageChildSession", () => {
  function writeChild(
    parentFile: string,
    runUuid: string,
    step: string,
    lines: string[],
  ): string {
    const dir = path.join(
      path.dirname(parentFile),
      path.basename(parentFile, ".jsonl"),
      runUuid,
      step,
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
    return file;
  }

  it("returns null without a parent session file", () => {
    expect(salvageChildSession(undefined)).toBeNull();
  });

  it("returns null when there are no child sessions", () => {
    const parent = path.join(scratch, "parent.jsonl");
    fs.writeFileSync(parent, "");
    expect(salvageChildSession(parent)).toBeNull();
  });

  it("picks the newest non-empty child and summarises it", () => {
    const parent = path.join(scratch, "2026-01-01T00-00-00-000Z_parentid.jsonl");
    fs.writeFileSync(parent, "");
    writeChild(parent, "run-a", "run-0", []);
    writeChild(parent, "run-b", "run-0", [
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", arguments: {} },
            { type: "toolCall", name: "read", arguments: {} },
            { type: "toolCall", name: "bash", arguments: {} },
            { type: "text", text: "fetched 28 hits" },
          ],
        },
      }),
    ]);

    const salvaged = salvageChildSession(parent);
    expect(salvaged).not.toBeNull();
    expect(salvaged!.messages).toBe(2);
    expect(salvaged!.toolNames).toEqual(["bash", "read"]);
    expect(salvaged!.lastText).toBe("fetched 28 hits");
    expect(salvaged!.sessionFile).toContain("run-b");
  });

  it("trims a long final text to 300 characters", () => {
    const parent = path.join(scratch, "parent.jsonl");
    fs.writeFileSync(parent, "");
    writeChild(parent, "run-c", "run-0", [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(500) }] },
      }),
    ]);
    const salvaged = salvageChildSession(parent);
    expect(salvaged!.lastText!.length).toBe(301); // 300 + the ellipsis
    expect(salvaged!.lastText!.endsWith("…")).toBe(true);
  });
});
