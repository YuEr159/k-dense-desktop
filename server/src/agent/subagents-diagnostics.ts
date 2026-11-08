/**
 * Detached-runner launch failures, made visible.
 *
 * A background `subagent` run spawns `pi-subagents`'s runner as a detached Node
 * process. On Windows that spawn sometimes dies at DLL-initialisation time with
 * `0xC0000142` (3221225794) before a single line of JavaScript runs: both
 * runner logs stay at zero bytes and the launch record reads
 * `state: "not-started"`. Nothing in that record says *why*, and the same
 * launch often succeeds on a retry seconds later, so the failure is
 * intermittent and otherwise invisible.
 *
 * This module records the context a later diagnosis needs (env block size,
 * handle count, exit code, log sizes) into the project's own `.kady/` tree.
 * It deliberately does not change launch behaviour: the cause is not yet
 * known, and disabling async execution for everyone would trade a rare
 * failure for a certain one.
 *
 * The async run's own bookkeeping lives in the OS temp directory
 * (`pi-subagents`' retention deletes it after 30 days), so the exit code is
 * read from there once per failure and copied here, where it survives.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ProjectPaths } from "../projects.ts";

/** A single recorded launch failure. */
export interface LaunchFailure {
  at: string;
  /** pi-subagents' async run id (the `subagent:async-complete` payload id). */
  runId: string;
  /** Runner pid, when the launch record named one. */
  pid?: number;
  /** Windows STATUS_* code reinterpreted as unsigned, e.g. 3221225794. */
  exitCode?: number;
  /** Same value as hex, which is how these codes are usually reported. */
  exitCodeHex?: string;
  durationMs: number;
  /** Bytes covered by `process.env` of the backend process that spawned it. */
  envBytes: number;
  envKeys: number;
  handleCount?: number;
  runnerStdoutBytes: number;
  runnerStderrBytes: number;
  note?: string;
}

const MAX_RECORDS = 200;
const KEEP_RECORDS = 100;
const FILE_NAME = "subagent-launch-failures.jsonl";

export function launchFailuresPath(paths: ProjectPaths): string {
  return path.join(paths.kadyDir, FILE_NAME);
}

/**
 * `pi-subagents`' own temp root, recomputed here because the package does not
 * export it: `<tmp>/pi-subagents-<scope>`, where the scope is `uid-<n>` on
 * POSIX and `user-<sanitized USERNAME|USER|LOGNAME>` on Windows (falling back
 * to `home-<sanitized homedir>`, then `shared`). The sanitizer keeps only
 * `[A-Za-z0-9._-]` and collapses every other run to `-`, so "Yuxiao Lu" becomes
 * `Yuxiao-Lu`. Re-check against `shared/types.js` (`resolveTempScopeId`) after a
 * package bump; the async-complete payload's `asyncDir` outranks this.
 */
export function subagentTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const sanitize = (value: string) => {
    const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned || "unknown";
  };
  const getuid = process.getuid?.bind(process);
  if (typeof getuid === "function") return path.join(os.tmpdir(), `pi-subagents-uid-${getuid()}`);
  for (const key of ["USERNAME", "USER", "LOGNAME"]) {
    const value = env[key];
    if (value) return path.join(os.tmpdir(), `pi-subagents-user-${sanitize(value)}`);
  }
  const homedir = env.USERPROFILE ?? env.HOME;
  if (homedir) return path.join(os.tmpdir(), `pi-subagents-home-${sanitize(homedir)}`);
  try {
    const username = os.userInfo().username;
    if (username) return path.join(os.tmpdir(), `pi-subagents-user-${sanitize(username)}`);
  } catch {
    // Fall through to the shared scope, as upstream does.
  }
  return path.join(os.tmpdir(), "pi-subagents-shared");
}

/** Bytes covered by an environment block, the way Windows counts it for CreateProcess. */
export function environmentBytes(env: NodeJS.ProcessEnv = process.env): { bytes: number; keys: number } {
  let bytes = 0;
  let keys = 0;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    keys++;
    bytes += name.length + 1 + value.length + 1;
  }
  return { bytes, keys };
}

interface ProcessTerminalRecord {
  pid?: number;
  instances?: Array<{ exitCode?: number | null; closeObservedAt?: number }>;
}

/** What the run's own bookkeeping still knows about the failed launch. */
export interface AsyncRunFacts {
  exitCode?: number;
  observedAt?: number;
  pid?: number;
  runnerStdoutBytes: number;
  runnerStderrBytes: number;
}

/**
 * Read an async run's own directory (`<tempRoot>/async-subagent-runs/<runId>`).
 * Prefer `asyncDir` from the `subagent:async-complete` payload when it is
 * present: it is the authoritative path, whereas the temp-root guess depends on
 * `pi-subagents`' internal naming staying as it is today.
 */
export function readAsyncRunFacts(asyncDir: string): AsyncRunFacts {
  let exitCode: number | undefined;
  let observedAt: number | undefined;
  let pid: number | undefined;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(asyncDir, "process-terminal.json"), "utf8")) as ProcessTerminalRecord;
    const instance = record.instances?.[0];
    if (typeof instance?.exitCode === "number") exitCode = instance.exitCode;
    if (typeof instance?.closeObservedAt === "number") observedAt = instance.closeObservedAt;
  } catch {
    // Not written when the runner never started.
  }
  try {
    const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as { pid?: number };
    if (typeof status.pid === "number") pid = status.pid;
  } catch {
    // Status file missing: nothing to add.
  }
  const size = (name: string) => {
    try {
      return fs.statSync(path.join(asyncDir, name)).size;
    } catch {
      return 0;
    }
  };
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(pid === undefined ? {} : { pid }),
    runnerStdoutBytes: size("runner.stdout.log"),
    runnerStderrBytes: size("runner.stderr.log"),
  };
}

/**
 * True for the message `pi-subagents` reports when a runner vanished before
 * writing a result. That is the only symptom shared by the 0xC0000142 crashes
 * and an orderly kill, so the record also carries the exit code when one exists.
 */
export function isRunnerVanishedMessage(text: string | undefined): boolean {
  if (!text) return false;
  return /exited or disappeared before writing a result/i.test(text);
}

export interface LaunchFailureInput {
  runId: string;
  durationMs: number;
  note?: string;
  /** The failed run's own directory, from the async-complete payload. */
  asyncDir?: string;
  /** Test seams; production reads them from the process and the run directory. */
  env?: NodeJS.ProcessEnv;
  handleCount?: number;
  tempRoot?: string;
}

/** The run directory the payload named, else the one its id implies. */
function resolveAsyncDir(input: { runId: string; asyncDir?: string; tempRoot?: string }, env: NodeJS.ProcessEnv): string | undefined {
  if (input.asyncDir?.trim()) return input.asyncDir;
  if (input.tempRoot?.trim()) return path.join(input.tempRoot, "async-subagent-runs", input.runId);
  try {
    return path.join(subagentTempRoot(env), "async-subagent-runs", input.runId);
  } catch {
    return undefined;
  }
}

/** Append one failure record, trimming the file when it grows past the cap. */
export function recordLaunchFailure(paths: ProjectPaths, input: LaunchFailureInput): LaunchFailure | null {
  const env = input.env ?? process.env;
  const asyncDir = resolveAsyncDir(input, env);
  const facts: AsyncRunFacts = asyncDir
    ? readAsyncRunFacts(asyncDir)
    : { runnerStdoutBytes: 0, runnerStderrBytes: 0 };
  const { bytes, keys } = environmentBytes(env);
  const record: LaunchFailure = {
    at: new Date().toISOString(),
    runId: input.runId,
    ...(facts.pid !== undefined ? { pid: facts.pid } : {}),
    ...(facts.exitCode !== undefined
      ? { exitCode: facts.exitCode, exitCodeHex: `0x${(facts.exitCode >>> 0).toString(16)}` }
      : {}),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    envBytes: bytes,
    envKeys: keys,
    ...(input.handleCount !== undefined ? { handleCount: input.handleCount } : {}),
    runnerStdoutBytes: facts.runnerStdoutBytes,
    runnerStderrBytes: facts.runnerStderrBytes,
    ...(input.note ? { note: input.note } : {}),
  };
  try {
    fs.mkdirSync(paths.kadyDir, { recursive: true });
    const file = path.join(paths.kadyDir, FILE_NAME);
    const existing = readLaunchFailures(paths);
    const next = [...existing, record];
    const kept = next.length > MAX_RECORDS ? next.slice(-KEEP_RECORDS) : next;
    // Atomic replace of a small file: same `.tmp` + rename convention as
    // guard-policy.ts and project-instructions.ts.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
    return record;
  } catch {
    // Diagnostics must never break a run; a failure here means no record, not a crash.
    return null;
  }
}

/** Every recorded failure, oldest first. Missing or malformed file → []. */
export function readLaunchFailures(paths: ProjectPaths): LaunchFailure[] {
  try {
    const text = fs.readFileSync(path.join(paths.kadyDir, FILE_NAME), "utf8");
    const records: LaunchFailure[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as LaunchFailure);
      } catch {
        // One corrupt line must not hide the rest.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** A child session left on disk by a run the lead was told had failed. */
export interface SalvagedChildSession {
  sessionFile: string;
  messages: number;
  toolNames: string[];
  /** Last assistant text, already trimmed for a one-line summary. */
  lastText?: string;
}

/**
 * pi-subagents writes a child's session into
 * `<parentSessionDir>/<parentBasename>/<runUuid>/run-<n>/session.jsonl`.
 * A run can be reported failed (its runner process vanished) while that file
 * already holds real work — observed once: 284 KB and 24 records, while the
 * lead was told "exited or disappeared before writing a result".
 */
function childSessionRoots(parentSessionFile: string): string[] {
  const dir = path.dirname(parentSessionFile);
  const base = path.basename(parentSessionFile, ".jsonl");
  const root = path.join(dir, base);
  const roots: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runRoot = path.join(root, entry.name);
      let runs: string[] = [];
      try {
        runs = fs.readdirSync(runRoot, { withFileTypes: true })
          .filter((run) => run.isDirectory() && run.name.startsWith("run-"))
          .map((run) => path.join(runRoot, run.name, "session.jsonl"));
      } catch {
        continue;
      }
      roots.push(...runs);
    }
  } catch {
    // No child sessions for this parent yet.
  }
  return roots;
}

/**
 * The newest non-empty child session for a parent session, or null.
 *
 * "Non-empty" means at least one recorded message — a file created by a runner
 * that died before its first turn is not worth pointing the lead at.
 */
export function salvageChildSession(parentSessionFile: string | undefined): SalvagedChildSession | null {
  if (!parentSessionFile) return null;
  let best: { file: string; mtime: number } | undefined;
  for (const file of childSessionRoots(parentSessionFile)) {
    try {
      const stat = fs.statSync(file);
      if (stat.size === 0) continue;
      if (!best || stat.mtimeMs > best.mtime) best = { file, mtime: stat.mtimeMs };
    } catch {
      // Unreadable this pass.
    }
  }
  if (!best) return null;
  let messages = 0;
  const toolNames: string[] = [];
  let lastText: string | undefined;
  try {
    for (const line of fs.readFileSync(best.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record: { type?: string; message?: { role?: string; content?: unknown } };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (record.type !== "message" || !record.message) continue;
      messages++;
      const content = record.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "toolCall" && typeof block.name === "string") {
          if (!toolNames.includes(block.name)) toolNames.push(block.name);
        }
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          lastText = block.text.trim();
        }
      }
    }
  } catch {
    return null;
  }
  if (messages === 0) return null;
  const trimmed = lastText && lastText.length > 300 ? `${lastText.slice(0, 300)}…` : lastText;
  return {
    sessionFile: best.file,
    messages,
    toolNames,
    ...(trimmed ? { lastText: trimmed } : {}),
  };
}
