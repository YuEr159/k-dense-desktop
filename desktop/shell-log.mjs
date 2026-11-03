/**
 * Application log for the shell and the two services it spawns.
 *
 * A packaged app has no terminal, so every `console.log` in this codebase went
 * nowhere: the startup-failure dialogs pointed users at "Help → Open logs" for
 * a menu item that did not exist and a file that was never written. This is
 * that file.
 *
 * Deliberately a plain appender, not a rotating logger: the interesting window
 * is the first thirty seconds of a failed launch, so it keeps a few bounded
 * files and overwrites the oldest. Rotation happens on size, checked as
 * records arrive, which keeps the whole thing synchronous and dependency-free.
 */
import fs from "node:fs";
import path from "node:path";

/** One file per ~5 MB, three kept. A failed boot produces kilobytes. */
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3;

let logDirectory = null;
let currentSize = 0;
let broken = false;

/** `<dataRoot>/logs`, created on first use. */
export function logsDirectory(dataRoot) {
  return path.join(dataRoot, "logs");
}

/**
 * Point the logger at a directory and start a session header.
 *
 * Safe to call once at startup. Failures are swallowed on purpose: a machine
 * where the log cannot be written is still expected to run the app, and
 * throwing here would turn a cosmetic problem into a launch failure.
 */
export function openLog(dataRoot, extra = {}) {
  try {
    logDirectory = logsDirectory(dataRoot);
    fs.mkdirSync(logDirectory, { recursive: true });
    const file = currentFile();
    try {
      currentSize = fs.statSync(file).size;
    } catch {
      currentSize = 0;
    }
    if (currentSize > MAX_BYTES) rotate();
    const details = Object.entries(extra)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    write("shell", `--- session start ${new Date().toISOString()} ${details}`.trim());
  } catch {
    broken = true;
  }
}

export function logPath() {
  return logDirectory ? currentFile() : null;
}

/** Append one line. `source` is "shell", "backend" or "frontend". */
export function write(source, message) {
  if (!logDirectory || broken) return;
  const text = String(message ?? "");
  // A multi-line chunk (a stack trace) keeps its shape but gets one prefix, so
  // the log stays greppable by source without exploding into N records.
  const line = `${new Date().toISOString()} [${source}] ${text}\n`;
  try {
    fs.appendFileSync(currentFile(), line);
    currentSize += Buffer.byteLength(line);
    if (currentSize > MAX_BYTES) rotate();
  } catch {
    // A full disk or a removed directory must not take the app down with it.
    broken = true;
  }
}

function currentFile() {
  return path.join(logDirectory, "shell.log");
}

/**
 * shell.log -> shell.1.log -> shell.2.log, dropping the oldest.
 *
 * Renames rather than rewrites so a reader tailing the file sees a clean
 * break, and so a crash mid-rotation can lose at most the file being moved.
 */
function rotate() {
  try {
    for (let index = KEEP_FILES - 1; index >= 1; index -= 1) {
      const from = index === 1 ? currentFile() : path.join(logDirectory, `shell.${index - 1}.log`);
      const to = path.join(logDirectory, `shell.${index}.log`);
      try {
        fs.renameSync(from, to);
      } catch {
        // Missing source, or the destination exists on a platform that
        // refuses to overwrite. Either way the next file is the one that
        // matters; keep going.
      }
    }
    fs.rmSync(path.join(logDirectory, `shell.${KEEP_FILES}.log`), { force: true });
    currentSize = 0;
  } catch {
    broken = true;
  }
}

/**
 * Mirror `console.*` into the log so nothing written before this change goes
 * silent. Called once from the entry point.
 */
export function captureConsole() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      // A service line was already written by its own sink; writing it again
      // here is what produced every backend line twice in the first cut.
      if (mirrorSuspended > 0) return;
      write("shell", args.map(format).join(" "));
    };
  }
}

let mirrorSuspended = 0;

/**
 * Write a service line exactly once, while still echoing it to the terminal.
 *
 * The console mirror is suspended for the duration of the echo rather than
 * comparing strings: a main-process message that happened to read like a
 * service line must still be logged.
 */
export function logServiceLine(source, text, sink) {
  write(source, text);
  mirrorSuspended += 1;
  try {
    sink(`[${source}] ${text}`);
  } finally {
    mirrorSuspended -= 1;
  }
}

function format(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
