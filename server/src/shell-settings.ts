/**
 * Desktop-shell preferences, stored in `<dataRoot>/shell.json`.
 *
 * The Electron main process owns this file and reads it on the quit path, so it
 * deliberately is not part of `kady-settings.json` (which the backend owns and
 * the main process would have to duplicate parsing for). The backend exposes it
 * over /settings/shell purely so the Settings UI can edit it: the renderer is a
 * sandboxed page with no filesystem access.
 *
 * Nothing here is security-sensitive, and the shape stays permissive on read so
 * an older or newer shell that wrote extra keys does not lose them.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./config.ts";

export interface ShellSettings {
  /** What closing the window does. `tray` keeps the process alive. */
  closeAction: "tray" | "quit";
  /** Whether the first-close tray balloon has been shown. */
  trayHintShown?: boolean;
}

const DEFAULTS: ShellSettings = { closeAction: "tray" };

/** The file itself; kept as a function so tests can point KADY_DATA_ROOT at a temp dir. */
function settingsPath(): string {
  return path.join(DATA_ROOT, "shell.json");
}

export function readShellSettings(): ShellSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      ...raw,
      closeAction: raw.closeAction === "quit" ? "quit" : "tray",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Returns the settings after the write, or null when the file is unreadable JSON. */
export function writeShellSettings(patch: Partial<ShellSettings>): ShellSettings | null {
  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath())) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
      if (parsed && typeof parsed === "object") current = parsed as Record<string, unknown>;
      else return null;
    }
  } catch {
    // A malformed file is not overwritten: the shell re-reads it on quit, and
    // silently replacing it would discard whatever the user or a bug put there.
    return null;
  }
  const next = {
    ...current,
    ...(patch.closeAction ? { closeAction: patch.closeAction } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    return null;
  }
  return readShellSettings();
}
