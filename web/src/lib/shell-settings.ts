"use client";

/**
 * Desktop-shell behaviour that the Electron main process acts on. The renderer
 * is a sandboxed page, so these go through the backend (/settings/shell) rather
 * than any local file or preload bridge.
 */

import { apiFetch } from "@/lib/projects";

export type CloseAction = "tray" | "quit";

export interface ShellSettings {
  closeAction: CloseAction;
  /** Raise a desktop notification when a turn finishes. */
  notifyOnRunComplete: boolean;
  /** Only when the window is not focused (the default with it enabled). */
  notifyOnlyWhenUnfocused: boolean;
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = {
  closeAction: "tray",
  notifyOnRunComplete: false,
  notifyOnlyWhenUnfocused: true,
};

/** The shell normalises these on read; mirror the same rule here. */
function normalise(body: Partial<ShellSettings>): ShellSettings {
  return {
    closeAction: body.closeAction === "quit" ? "quit" : "tray",
    notifyOnRunComplete: body.notifyOnRunComplete === true,
    notifyOnlyWhenUnfocused: body.notifyOnlyWhenUnfocused !== false,
  };
}

export async function getShellSettings(): Promise<ShellSettings> {
  const res = await apiFetch("/settings/shell");
  if (!res.ok) throw new Error(`Could not read shell settings (${res.status})`);
  return normalise((await res.json()) as Partial<ShellSettings>);
}

export async function putShellSettings(patch: Partial<ShellSettings>): Promise<ShellSettings> {
  const res = await apiFetch("/settings/shell", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `Could not save shell settings (${res.status})`);
  }
  return normalise((await res.json()) as Partial<ShellSettings>);
}
