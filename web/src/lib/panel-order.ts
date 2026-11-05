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
 * The fixed-width pane a boundary handle should resize, if any.
 *
 * Two panes meet at a handle: whichever is fixed-width can be resized, and the
 * sign says which way the pointer moves to widen it. `preview` is the only
 * flexible pane, so a boundary between `tree` and `chat` has nothing to resize
 * — it can only swap.
 */
export function handleTarget(
  left: PanelId,
  right: PanelId,
): { panel: "tree" | "chat"; sign: 1 | -1 } | null {
  if (left === right) return null;
  if (!PANEL_ORDER_SET.has(left) || !PANEL_ORDER_SET.has(right)) return null;
  // The boundary must have the flexible pane on exactly one side; two
  // fixed-width panes meeting leave nothing to redistribute.
  if (left === "preview" && right !== "preview") return { panel: right as "tree" | "chat", sign: -1 };
  if (right === "preview" && left !== "preview") return { panel: left as "tree" | "chat", sign: 1 };
  return null;
}

export const DEFAULT_TREE_WIDTH = 320;
export const DEFAULT_CHAT_WIDTH = 640;
export const PANEL_WIDTH_RANGE = {
  tree: { min: 150, max: 480, fallback: DEFAULT_TREE_WIDTH },
  chat: { min: 280, max: 720, fallback: DEFAULT_CHAT_WIDTH },
} as const;

/** The drag handler and the settings field must clamp to the same bounds. */
export function clampPanelWidth(panel: "tree" | "chat", value: number): number {
  const { min, max, fallback } = PANEL_WIDTH_RANGE[panel];
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.max(min, Math.min(max, value)));
}

export type PanelOrderUpdater = PanelId[] | ((current: PanelId[]) => PanelId[]);

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
