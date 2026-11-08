"use client";

/**
 * How much of the transcript is folded by default.
 *
 * A per-browser display preference, so it lives in `localStorage` rather than
 * a project: how much process detail someone wants to see is a property of the
 * person, not of the work — the same reasoning that keeps the panel order
 * global.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type TranscriptViewMode = "compact" | "standard" | "expanded";

export const TRANSCRIPT_VIEW_MODES: TranscriptViewMode[] = ["compact", "standard", "expanded"];

/** Previewing the first line of reasoning is the pleasant default. */
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptViewMode = "standard";

export const TRANSCRIPT_VIEW_KEY = "kady:transcript-view";
/** Same-tab notification; `storage` only fires in other tabs. */
export const TRANSCRIPT_VIEW_CHANGED_EVENT = "kady:transcript-view-changed";

const MODE_SET = new Set<string>(TRANSCRIPT_VIEW_MODES);

export function normalizeTranscriptView(value: unknown): TranscriptViewMode {
  return typeof value === "string" && MODE_SET.has(value)
    ? (value as TranscriptViewMode)
    : DEFAULT_TRANSCRIPT_VIEW;
}

export function readTranscriptView(
  storage?: Pick<Storage, "getItem">,
): TranscriptViewMode {
  try {
    const raw = storage?.getItem(TRANSCRIPT_VIEW_KEY);
    if (!raw) return DEFAULT_TRANSCRIPT_VIEW;
    return normalizeTranscriptView(JSON.parse(raw));
  } catch {
    return DEFAULT_TRANSCRIPT_VIEW;
  }
}

export function writeTranscriptView(
  storage: Pick<Storage, "setItem"> | undefined,
  mode: TranscriptViewMode,
): void {
  const normalized = normalizeTranscriptView(mode);
  try {
    storage?.setItem(TRANSCRIPT_VIEW_KEY, JSON.stringify(normalized));
  } catch {
    /* private mode / quota: the choice simply is not remembered */
  }
  // Outside the try: a blocked storage write must not also silence the
  // in-session update the caller is about to show.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TRANSCRIPT_VIEW_CHANGED_EVENT, { detail: normalized }));
  }
}

export function useTranscriptView(): TranscriptViewMode {
  const [mode, setMode] = useState<TranscriptViewMode>(() =>
    typeof window === "undefined" ? DEFAULT_TRANSCRIPT_VIEW : readTranscriptView(window.localStorage),
  );

  useEffect(() => {
    const sync = () => setMode(readTranscriptView(window.localStorage));
    const onStorage = (event: StorageEvent) => {
      if (event.key === TRANSCRIPT_VIEW_KEY) sync();
    };
    window.addEventListener(TRANSCRIPT_VIEW_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TRANSCRIPT_VIEW_CHANGED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return mode;
}

/** Set the mode from anywhere; the hook above picks the change up. */
export function setTranscriptView(mode: TranscriptViewMode): void {
  if (typeof window === "undefined") return;
  writeTranscriptView(window.localStorage, mode);
}

/**
 * The tail of the paragraph being written, with markdown bold markers stripped.
 *
 * Shows the *end* rather than the beginning because reasoning grows at the end:
 * the first line is the model clearing its throat ("Let me look at the data"),
 * while the last one is what it is currently working out. Keeping the last
 * `maxChars` means a long paragraph shows its newest words instead of sliding
 * the useful part out of view as the block streams.
 */
export function lastSegmentPreview(text: string, maxChars = 140): string {
  const end = text.trimEnd();
  if (end === "") return "";
  // A blank line starts the current paragraph; everything after it is the part
  // still being written.
  const gap = end.lastIndexOf("\n\n");
  const segment = (gap >= 0 ? end.slice(gap + 2) : end).trim() || end.trim();
  // Markdown line breaks inside one paragraph are visual noise on one line.
  const oneLine = segment.replace(/\s*\n\s*/g, " ").replaceAll("**", "").trim();
  return oneLine.length > maxChars ? `…${oneLine.slice(-maxChars)}` : oneLine;
}

/**
 * Whether a reasoning block starts open under `mode`.
 *
 * Only `expanded` opens them; `compact` and `standard` differ in the preview,
 * not in folding, because the full reasoning is long and rarely what someone
 * scanning the transcript wants first.
 */
export function reasoningStartsOpen(mode: TranscriptViewMode): boolean {
  return mode === "expanded";
}

/** Whether a collapsed reasoning block shows the first line beside its label. */
export function reasoningShowsPreview(mode: TranscriptViewMode): boolean {
  return mode !== "compact";
}
