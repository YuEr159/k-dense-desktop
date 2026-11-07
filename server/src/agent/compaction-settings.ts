/**
 * Per-project context-compaction settings, stored in
 * `sandbox/.pi/settings.json` → `compaction.*`, which is where Pi reads them.
 *
 * Pi itself only understands `reserveTokens` ("keep this many free"), so the
 * user-facing `autoCompactWindow` ("start compacting at this many tokens") is
 * a Kady-layer key. Pi's loader keeps unknown keys verbatim and only validates
 * a value when a getter reads it, so the two coexist in one file and children
 * (separate processes reading the same sandbox) see both.
 *
 * Pi re-reads the file on `SettingsManager.reload()`, which Kady never calls —
 * a saved change reaches a live session because the run route pushes the
 * resolved value through `applyOverrides`, not because Pi noticed the file.
 */
import fs from "node:fs";
import type { ProjectPaths } from "../projects.ts";
import { piSettingsPath, writePiSettings } from "./capability-state.ts";

export interface CompactionSettings {
  enabled: boolean;
  /** Tokens kept free for the model's answer; compaction triggers above `window - reserve`. */
  reserveTokens: number;
  /** Most recent tokens kept verbatim instead of being summarized. */
  keepRecentTokens: number;
  /**
   * Start compacting once the conversation reaches this many tokens, resolved
   * per model at run time. Null leaves the legacy `reserveTokens` semantics.
   */
  autoCompactWindow: number | null;
}

/** Pi's defaults (settings-manager.js). */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  autoCompactWindow: null,
};

export const COMPACTION_BOUNDS = {
  // Pi's own schema has no upper bound; the old 64_000 ceiling made anything
  // below ~986K on a 1M window unreachable.
  reserveTokens: { min: 4_000, max: 1_000_000 },
  keepRecentTokens: { min: 5_000, max: 200_000 },
  // Below this the trigger would land past the window on every model.
  autoCompactWindow: { min: 4_000, max: 1_000_000 },
} as const;

/** Room the trigger must leave behind so the run can still produce an answer. */
export const MIN_REPLY_HEADROOM = 4_000;

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};

/**
 * Parse the settings file for writing. Missing → `{}`; malformed → `null`,
 * because rewriting from an empty object would destroy the user's file.
 */
function loadForWrite(paths: ProjectPaths): Rec | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(piSettingsPath(paths), "utf-8")));
  } catch (exc) {
    return (exc as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

export function readCompactionSettings(paths: ProjectPaths): CompactionSettings {
  return parseCompactionSettings((loadForWrite(paths) ?? {}).compaction);
}

function parseCompactionSettings(value: unknown): CompactionSettings {
  const compaction = asRecord(value);
  const num = (candidate: unknown, fallback: number) =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  const window = compaction.autoCompactWindow;
  return {
    enabled: typeof compaction.enabled === "boolean" ? compaction.enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: num(compaction.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens),
    keepRecentTokens: num(compaction.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
    autoCompactWindow:
      typeof window === "number" && Number.isInteger(window) && window > 0 ? window : null,
  };
}

/** Pi's own rule for a count setting (`nonNegativeSafeInteger` in its schema). */
const isPiCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Stored fields that make Pi's `getCompactionSettings()` throw.
 *
 * Pi validates lazily, inside the per-turn `_checkCompaction`, so one bad value
 * ends the run with a schema message while this module's reader — which falls
 * back to defaults — keeps the settings card looking healthy. Verified against
 * Pi 1.3.0: `enabled` and unknown keys like `autoCompactWindow` are not
 * validated, and `modelOverrides` entries are only inspected when a model is
 * passed, so they are reported here unconditionally.
 */
export function invalidCompactionFields(value: unknown): string[] {
  const compaction = asRecord(value);
  const invalid: string[] = [];
  for (const key of ["reserveTokens", "keepRecentTokens"] as const) {
    if (key in compaction && !isPiCount(compaction[key])) {
      invalid.push(`compaction.${key}`);
    }
  }
  for (const [key, entry] of Object.entries(asRecord(compaction.modelOverrides))) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid.push(`compaction.modelOverrides["${key}"]`);
      continue;
    }
    for (const field of ["reserveTokens", "keepRecentTokens"] as const) {
      if (field in (entry as Rec) && !isPiCount((entry as Rec)[field])) {
        invalid.push(`compaction.modelOverrides["${key}"].${field}`);
      }
    }
  }
  return invalid;
}

/**
 * Settings plus the fields Pi would reject. The route reports `invalid` so the
 * card can name what to fix; every runtime caller keeps using the settings,
 * because refusing to run over a bad number would be worse than the default.
 */
export function readCompactionState(paths: ProjectPaths): {
  settings: CompactionSettings;
  invalid: string[];
} {
  const raw = loadForWrite(paths) ?? {};
  return {
    settings: parseCompactionSettings(raw.compaction),
    invalid: invalidCompactionFields(raw.compaction),
  };
}

/**
 * The `reserveTokens` a given model needs so compaction starts at
 * `autoCompactWindow` tokens.
 *
 * Shared by the lead's per-run `applyOverrides` and the `modelOverrides` that
 * children read from disk; both must agree or the two would compact at
 * different points on the same model.
 *
 * Clamped so the trigger always leaves `MIN_REPLY_HEADROOM` inside the window.
 * A window too small to hold both collapses to that headroom, which is the
 * only value that keeps Pi's arithmetic (`tokens > window - reserve`) sensible.
 */
export function reserveForWindow(autoCompactWindow: number, contextWindow: number): number {
  const latestTrigger = Math.max(MIN_REPLY_HEADROOM, contextWindow - MIN_REPLY_HEADROOM);
  const trigger = Math.min(autoCompactWindow, latestTrigger);
  return Math.max(0, contextWindow - trigger);
}

export type CompactionSettingsPatch = Partial<
  Pick<CompactionSettings, "enabled" | "reserveTokens" | "keepRecentTokens" | "autoCompactWindow">
>;

/** Validate a patch; returns an error message or null. */
export function validateCompactionPatch(patch: unknown): string | null {
  const body = asRecord(patch);
  if ("enabled" in body && typeof body.enabled !== "boolean") return "enabled must be a boolean";
  for (const key of ["reserveTokens", "keepRecentTokens", "autoCompactWindow"] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    // Null clears the trigger and falls back to `reserveTokens`.
    if (key === "autoCompactWindow" && value === null) continue;
    const bounds = COMPACTION_BOUNDS[key];
    if (!Number.isInteger(value) || (value as number) < bounds.min || (value as number) > bounds.max) {
      return `${key} must be an integer between ${bounds.min} and ${bounds.max}, or null`;
    }
  }
  return null;
}

/**
 * Merge a validated patch into `compaction`, preserving every other key
 * (including Pi's `modelOverrides` and any key a newer Pi adds).
 * Returns the resulting settings, or null when the file is malformed (left
 * untouched — the caller reports 409).
 */
export function writeCompactionSettings(
  paths: ProjectPaths,
  patch: CompactionSettingsPatch,
): CompactionSettings | null {
  const settings = loadForWrite(paths);
  if (settings === null) return null;
  const compaction = { ...asRecord(settings.compaction) };
  if (patch.enabled !== undefined) compaction.enabled = patch.enabled;
  if (patch.reserveTokens !== undefined) compaction.reserveTokens = patch.reserveTokens;
  if (patch.keepRecentTokens !== undefined) compaction.keepRecentTokens = patch.keepRecentTokens;
  if (patch.autoCompactWindow !== undefined) {
    if (patch.autoCompactWindow === null) delete compaction.autoCompactWindow;
    else compaction.autoCompactWindow = patch.autoCompactWindow;
  }
  writePiSettings(paths, { ...settings, compaction });
  return readCompactionSettings(paths);
}

// ---------------------------------------------------------------------------
// Per-model overrides (the only lever a child process can see)
// ---------------------------------------------------------------------------

export type ModelOverrides = Record<string, { reserveTokens?: number; keepRecentTokens?: number }>;

/**
 * Read `compaction.modelOverrides` as Pi stores it, keeping only entries whose
 * values are usable numbers. A malformed entry would make Pi throw from
 * `getCompactionSettings` mid-run, so it is dropped rather than passed along.
 */
export function readModelOverrides(paths: ProjectPaths): ModelOverrides {
  const settings = loadForWrite(paths) ?? {};
  const raw = asRecord(asRecord(settings.compaction).modelOverrides);
  const out: ModelOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Rec;
    const next: { reserveTokens?: number; keepRecentTokens?: number } = {};
    for (const field of ["reserveTokens", "keepRecentTokens"] as const) {
      const n = entry[field];
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) next[field] = n;
    }
    if (Object.keys(next).length > 0) out[key] = next;
  }
  return out;
}

/** Key Pi uses for `modelOverrides`: `<provider>/<model id>`, id kept whole. */
export function modelOverrideKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/**
 * Write one model's `reserveTokens` override.
 *
 * Returns `true` only when the file changed. Callers run on every `subagent`
 * tool call, so the unchanged case — the common one — must not touch the disk:
 * `writePiSettings` is atomic but unlocked, and two tabs writing different
 * models at once would lose one key. A lost key costs one child a default
 * trigger, and the next launch rewrites it.
 */
export function writeModelReserveTokens(
  paths: ProjectPaths,
  key: string,
  reserveTokens: number,
): boolean {
  const settings = loadForWrite(paths);
  if (settings === null) return false;
  const compaction = { ...asRecord(settings.compaction) };
  const overrides = { ...asRecord(compaction.modelOverrides) };
  const existing = overrides[key];
  const current = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Rec).reserveTokens
    : undefined;
  if (current === reserveTokens) return false;
  overrides[key] = {
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Rec) : {}),
    reserveTokens,
  };
  compaction.modelOverrides = overrides;
  writePiSettings(paths, { ...settings, compaction });
  return true;
}
