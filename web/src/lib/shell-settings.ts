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
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = { closeAction: "tray" };

export async function getShellSettings(): Promise<ShellSettings> {
  const res = await apiFetch("/settings/shell");
  if (!res.ok) throw new Error(`Could not read shell settings (${res.status})`);
  const body = (await res.json()) as Partial<ShellSettings>;
  return { closeAction: body.closeAction === "quit" ? "quit" : "tray" };
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
  const body = (await res.json()) as Partial<ShellSettings>;
  return { closeAction: body.closeAction === "quit" ? "quit" : "tray" };
}
