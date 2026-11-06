"use client";

/**
 * Left-to-right order of the workspace's three panes.
 *
 * A per-browser display preference, so it lives in `localStorage` rather than
 * a project's workspace snapshot: switching projects should not move the panes
 * around under the user. Widths stay per-project in `workspace-persistence.ts`
 * because those really do belong to each layout.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type PanelId = "tree" | "preview" | "chat";

export const PANEL_IDS: PanelId[] = ["tree", "preview", "chat"];
export const DEFAULT_PANEL_ORDER: PanelId[] = ["tree", "preview", "chat"];
export const PANEL_ORDER_KEY = "kady:panel-order";
/** Same-tab notification; `storage` only fires in other tabs. */
export const PANEL_ORDER_CHANGED_EVENT = "kady:panel-order-changed";

const PANEL_ORDER_SET = new Set<string>(PANEL_IDS);

/**
 * Always a complete permutation of the three panes.
 *
 * Stored values are user-editable and may predate a pane, carry duplicates or
 * unknown ids. Anything unusable falls back to the default rather than leaving
 * the layout short a pane.
 */
export function normalizePanelOrder(value: unknown): PanelId[] {
  if (!Array.isArray(value)) return [...DEFAULT_PANEL_ORDER];
  const seen = new Set<PanelId>();
  const order: PanelId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !PANEL_ORDER_SET.has(item)) continue;
    const id = item as PanelId;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of DEFAULT_PANEL_ORDER) {
    if (!seen.has(id)) order.push(id);
  }
  return order;
}

export function readPanelOrder(storage?: Pick<Storage, "getItem">): PanelId[] {
  try {
    const raw = storage?.getItem(PANEL_ORDER_KEY);
    if (!raw) return [...DEFAULT_PANEL_ORDER];
    return normalizePanelOrder(JSON.parse(raw));
  } catch {
    return [...DEFAULT_PANEL_ORDER];
  }
}

export function writePanelOrder(
  storage: Pick<Storage, "setItem"> | undefined,
  order: PanelId[],
): void {
  const normalized = normalizePanelOrder(order);
  try {
    storage?.setItem(PANEL_ORDER_KEY, JSON.stringify(normalized));
  } catch {
    /* private mode / quota: the order simply is not remembered */
  }
  // Outside the try: a blocked storage write must not also silence the
  // in-session update the caller is about to show.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PANEL_ORDER_CHANGED_EVENT, { detail: normalized }));
  }
}

/**
 * What a boundary handle does with a drag.
 *
 * `single` means only one side of the boundary has a fixed width — the other
 * is the flexible preview, so dragging just resizes that one pane.
 *
 * `pair` means both sides are fixed width, which happens when the preview sits
 * at an end and `tree` borders `chat`. There is no slack to hand out there:
 * the drag has to move width from one pane to the other, keeping their sum.
 */
export type HandleTarget =
  | { kind: "single"; panel: "tree" | "chat"; sign: 1 | -1 }
  | { kind: "pair"; left: "tree" | "chat"; right: "tree" | "chat" };

/**
 * Resize comes first. Swap is a small target at the ends of the same divider,
 * so it never takes the drag band away — see `ResizeHandle`.
 */
export function handleTarget(left: PanelId, right: PanelId): HandleTarget | null {
  if (left === right) return null;
  if (!PANEL_ORDER_SET.has(left) || !PANEL_ORDER_SET.has(right)) return null;
  if (left === "preview") {
    return { kind: "single", panel: right as "tree" | "chat", sign: -1 };
  }
  if (right === "preview") {
    return { kind: "single", panel: left as "tree" | "chat", sign: 1 };
  }
  // tree | chat, with the preview at an end.
  return { kind: "pair", left: left as "tree" | "chat", right: right as "tree" | "chat" };
}

export const DEFAULT_TREE_WIDTH = 320;
export const DEFAULT_CHAT_WIDTH = 640;
/** Both panes may grow as wide as the whole three-column layout allows. */
export const MAX_PANEL_WIDTH = 1280;
export const PANEL_WIDTH_RANGE = {
  tree: { min: 150, max: MAX_PANEL_WIDTH, fallback: DEFAULT_TREE_WIDTH },
  chat: { min: 280, max: MAX_PANEL_WIDTH, fallback: DEFAULT_CHAT_WIDTH },
} as const;

/**
 * The drag handler and the settings field must clamp to the same bounds.
 *
 * `available` is the width of the whole column area. A pane wider than what is
 * left after its neighbour and a workable preview would push the preview to
 * nothing, so the ceiling is the smaller of the configured max and the space
 * actually on offer.
 */
export function clampPanelWidth(
  panel: "tree" | "chat",
  value: number,
  available = Number.POSITIVE_INFINITY,
): number {
  const { min, max, fallback } = PANEL_WIDTH_RANGE[panel];
  if (!Number.isFinite(value)) return fallback;
  const ceiling = Number.isFinite(available)
    ? Math.min(max, Math.max(min, available - MIN_PREVIEW_WIDTH))
    : max;
  return Math.round(Math.max(min, Math.min(ceiling, value)));
}

/** Room the preview keeps no matter how far the side panes are dragged. */
export const MIN_PREVIEW_WIDTH = 200;

/** Width of one divider between two panes; they eat into the column area too. */
export const PANEL_HANDLE_WIDTH = 8;

/**
 * Shift width across a boundary whose two sides are both fixed width.
 *
 * Their sum is what the layout already gave them, so this moves width from one
 * pane to the other instead of changing the total: the preview keeps the space
 * it had. The split honours each pane's own min and max, and falls back to the
 * minimums when the total itself cannot be divided legally — a window so narrow
 * that even both floors overflow it.
 */
export function splitPairWidths(
  left: "tree" | "chat",
  right: "tree" | "chat",
  wanted: number,
  total: number,
): { left: number; right: number } {
  const l = PANEL_WIDTH_RANGE[left];
  const r = PANEL_WIDTH_RANGE[right];
  const lower = Math.max(l.min, total - r.max);
  const upper = Math.min(l.max, total - r.min);
  if (lower > upper) {
    return { left: l.min, right: Math.max(r.min, Math.round(total - l.min)) };
  }
  const leftWidth = Math.round(Math.max(lower, Math.min(upper, wanted)));
  return { left: leftWidth, right: Math.round(total - leftWidth) };
}

export type PanelOrderUpdater = PanelId[] | ((current: PanelId[]) => PanelId[]);

/**
 * Shrink the side panes to fit a narrower column area, keeping the preview's
 * floor. Growing is left alone: a window that got wider should not silently
 * change widths the user picked.
 *
 * Without this, widths saved on a wide window follow the user onto a narrow one
 * and squeeze the preview to a sliver — the layout looks broken even though
 * every pane is within its own range.
 */
export function fitPanelWidths(
  widths: { tree: number; chat: number },
  open: { tree: boolean; chat: boolean; preview: boolean },
  available: number,
): { tree: number; chat: number } {
  if (!Number.isFinite(available) || available <= 0) return widths;
  const openIds = (["tree", "chat"] as const).filter((id) => open[id]);
  if (openIds.length === 0) return widths;
  // The dividers are flex children like the panes, so they take their share of
  // the row before the preview can claim anything. With the preview collapsed
  // there is no floor to protect and one fewer divider.
  const handles = open.preview ? openIds.length : Math.max(0, openIds.length - 1);
  const previewFloor = open.preview ? MIN_PREVIEW_WIDTH : 0;
  const budget = available - previewFloor - PANEL_HANDLE_WIDTH * handles;
  const used = openIds.reduce((sum, id) => sum + widths[id], 0);
  if (used <= budget) return widths;

  const floorOf = (id: "tree" | "chat") => PANEL_WIDTH_RANGE[id].min;
  let floors = 0;
  for (const id of openIds) floors += floorOf(id);
  // Even the floors do not fit. Falling back to the floors is still the least
  // bad answer: keeping the stored widths would squeeze the preview away
  // entirely, and a pane below its own minimum is unusable.
  if (floors > budget) {
    const next = { ...widths };
    for (const id of openIds) next[id] = floorOf(id);
    return next;
  }

  // Take the excess proportionally from the slack above each pane's floor, so
  // a pane already at its minimum is not asked to give up more it does not
  // have.
  const slack = used - floors;
  const excess = used - budget;
  const ratio = slack > 0 ? Math.min(1, excess / slack) : 0;
  const next = { ...widths };
  for (const id of openIds) {
    const floor = floorOf(id);
    next[id] = Math.round(widths[id] - (widths[id] - floor) * ratio);
  }
  return next;
}
export function usePanelOrder(): [PanelId[], (next: PanelOrderUpdater) => void] {
  const [order, setOrder] = useState<PanelId[]>(() =>
    typeof window === "undefined" ? [...DEFAULT_PANEL_ORDER] : readPanelOrder(window.localStorage),
  );
  // The state is the render source of truth; `orderRef` lets the setter read
  // the current value without putting the write back inside the updater,
  // which React may run twice (StrictMode) — a swap applied twice returns the
  // original order.
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => {
    const sync = () => {
      const stored = readPanelOrder(window.localStorage);
      orderRef.current = stored;
      setOrder(stored);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PANEL_ORDER_KEY) sync();
    };
    window.addEventListener(PANEL_ORDER_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PANEL_ORDER_CHANGED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const set = useCallback((next: PanelOrderUpdater) => {
    const resolved = normalizePanelOrder(
      typeof next === "function" ? next(orderRef.current) : next,
    );
    writePanelOrder(window.localStorage, resolved);
    orderRef.current = resolved;
    setOrder(resolved);
  }, []);

  return useMemo(() => [order, set], [order, set]);
}
