/**
 * Wiring for the shell-timeout guard's child side: reference the vendored
 * `kady-bash-timeout` Pi package from `sandbox/.pi/settings.json` so
 * pi-subagents' background children load it (the lead session ignores it — the
 * package self-gates on PI_SUBAGENT_CHILD and the lead runs bash-timeout.ts
 * instead). Same shape as guard-bridge.ts / notebook-bridge.ts.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectPaths } from "../projects.ts";

export function kadyBashTimeoutPackageDir(): string {
  return path.resolve(import.meta.dirname, "..", "..", "pi-packages", "kady-bash-timeout");
}

function isBashTimeoutSource(entry: unknown): entry is string {
  return typeof entry === "string" && /[/\\]kady-bash-timeout$/.test(entry.replace(/[/\\]+$/, ""));
}

/** Add (or repair) the packages entry; a malformed settings file is left alone. */
export function seedBashTimeoutPackage(paths: ProjectPaths): boolean {
  const dir = path.join(paths.sandbox, ".pi");
  const settingsPath = path.join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const pkgDir = kadyBashTimeoutPackageDir();
  const packages = Array.isArray(settings.packages) ? [...(settings.packages as unknown[])] : [];
  const kept = packages.filter((p) => !isBashTimeoutSource(p) || p === pkgDir);
  if (kept.includes(pkgDir) && kept.length === packages.length) return false;
  if (!kept.includes(pkgDir)) kept.push(pkgDir);
  settings.packages = kept;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return true;
}
