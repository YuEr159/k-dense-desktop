import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_ORDER,
  PANEL_PRESETS,
  clampPanelWidth,
  clampTranscriptWidth,
  fitPanelWidths,
  handleTarget,
  matchPanelPreset,
  normalizePanelOrder,
  readPanelOrder,
  splitPairWidths,
  writePanelOrder,
} from "./panel-order";

function memoryStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("kady:panel-order", initial);
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    raw: store,
  };
}

describe("normalizePanelOrder", () => {
  it("keeps a valid permutation as written", () => {
    expect(normalizePanelOrder(["chat", "preview", "tree"])).toEqual(["chat", "preview", "tree"]);
  });

  it("drops unknown ids and duplicates", () => {
    expect(normalizePanelOrder(["tree", "sidebar", "tree", "chat"])).toEqual(["tree", "chat", "preview"]);
  });

  it("appends panes the stored value predates", () => {
    expect(normalizePanelOrder(["chat", "tree"])).toEqual(["chat", "tree", "preview"]);
  });

  it("falls back to the default for anything that is not an array", () => {
    expect(normalizePanelOrder(null)).toEqual(DEFAULT_PANEL_ORDER);
    expect(normalizePanelOrder("tree")).toEqual(DEFAULT_PANEL_ORDER);
    expect(normalizePanelOrder({ 0: "tree" })).toEqual(DEFAULT_PANEL_ORDER);
  });

  it("never returns a short list even when everything is unknown", () => {
    expect(normalizePanelOrder(["a", "b"])).toEqual(DEFAULT_PANEL_ORDER);
  });
});

describe("panel order storage", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    writePanelOrder(storage, ["preview", "chat", "tree"]);
    expect(readPanelOrder(storage)).toEqual(["preview", "chat", "tree"]);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(readPanelOrder(memoryStorage())).toEqual(DEFAULT_PANEL_ORDER);
  });

  it("falls back to the default when the stored value is not JSON", () => {
    expect(readPanelOrder(memoryStorage("{not json"))).toEqual(DEFAULT_PANEL_ORDER);
  });

  it("rewrites a stored value that is missing a pane", () => {
    const storage = memoryStorage(JSON.stringify(["chat", "tree"]));
    expect(readPanelOrder(storage)).toEqual(["chat", "tree", "preview"]);
  });

  it("treats a throwing storage as absent", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPanelOrder(storage)).toEqual(DEFAULT_PANEL_ORDER);
    expect(() => writePanelOrder(storage, ["chat", "preview", "tree"])).not.toThrow();
  });
});

describe("matchPanelPreset", () => {
  it("recognises each shipped preset", () => {
    for (const preset of PANEL_PRESETS) {
      expect(matchPanelPreset([...preset.order])).toBe(preset.id);
    }
  });

  it("reports an arrangement the presets do not cover as custom", () => {
    expect(matchPanelPreset(["preview", "chat", "tree"])).toBeNull();
  });

  it("does not match on a prefix", () => {
    expect(matchPanelPreset(["tree", "preview"])).toBeNull();
  });

  // Two presets landing on the same order would make one of them unreachable.
  it("ships no duplicate arrangements", () => {
    const seen = PANEL_PRESETS.map((preset) => preset.order.join("|"));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("covers every pane exactly once per preset", () => {
    for (const preset of PANEL_PRESETS) {
      expect([...preset.order].sort()).toEqual([...DEFAULT_PANEL_ORDER].sort());
    }
  });
});

describe("handleTarget", () => {
  it("resizes the fixed-width pane on either side of the preview", () => {
    expect(handleTarget("tree", "preview")).toEqual({ kind: "single", panel: "tree", sign: 1 });
    expect(handleTarget("preview", "tree")).toEqual({ kind: "single", panel: "tree", sign: -1 });
    expect(handleTarget("chat", "preview")).toEqual({ kind: "single", panel: "chat", sign: 1 });
    expect(handleTarget("preview", "chat")).toEqual({ kind: "single", panel: "chat", sign: -1 });
  });

  // With the preview at an end, tree and chat border each other. Neither is
  // flexible, so the drag splits a fixed total instead of growing one pane.
  it("splits a fixed total when the two fixed-width panes meet", () => {
    expect(handleTarget("tree", "chat")).toEqual({ kind: "pair", left: "tree", right: "chat" });
    expect(handleTarget("chat", "tree")).toEqual({ kind: "pair", left: "chat", right: "tree" });
  });

  it("rejects a repeated pane or an unknown id", () => {
    expect(handleTarget("tree", "tree")).toBeNull();
    expect(handleTarget("nope" as never, "preview")).toBeNull();
  });
});

describe("fitPanelWidths", () => {
  it("leaves widths alone when they already fit", () => {
    expect(fitPanelWidths({ tree: 320, chat: 640 }, { tree: true, chat: true, preview: true }, 1600)).toEqual({
      tree: 320,
      chat: 640,
    });
  });

  it("never grows a pane just because the window got wider", () => {
    expect(fitPanelWidths({ tree: 150, chat: 280 }, { tree: true, chat: true, preview: true }, 3000)).toEqual({
      tree: 150,
      chat: 280,
    });
  });

  // The half-screen case: 960 columns, 320 + 640 would leave the preview
  // nothing, so both side panes give up their share of the excess.
  it("shrinks both panes proportionally when the area is too narrow", () => {
    const fitted = fitPanelWidths({ tree: 320, chat: 640 }, { tree: true, chat: true, preview: true }, 960);
    // Budget is 960 - 200 preview - 2 dividers = 744. Slack over the floors is
    // 170 + 360 = 530, and 216 has to go, so each pane gives up 216/530.
    expect(fitted.tree + fitted.chat).toBe(744);
    expect(fitted.tree).toBe(251);
    expect(fitted.chat).toBe(493);
  });

  it("counts only the dividers that are actually rendered", () => {
    // One pane open means one divider: 700 - 200 - 8 = 492.
    const fitted = fitPanelWidths({ tree: 320, chat: 640 }, { tree: false, chat: true, preview: true }, 700);
    expect(fitted.chat).toBe(492);
    expect(fitted.tree).toBe(320);
  });

  it("leaves the panes at their floors when even those do not fit", () => {
    expect(fitPanelWidths({ tree: 320, chat: 640 }, { tree: true, chat: true, preview: true }, 300)).toEqual({
      tree: 150,
      chat: 280,
    });
  });

  it("passes the widths through while the area is still unknown", () => {
    const widths = { tree: 320, chat: 640 };
    expect(fitPanelWidths(widths, { tree: true, chat: true, preview: true }, Number.POSITIVE_INFINITY)).toBe(widths);
    expect(fitPanelWidths(widths, { tree: true, chat: true, preview: true }, 0)).toBe(widths);
  });

  // With the preview collapsed there is no floor to protect and one fewer
  // divider, so the side panes keep their stored widths on a narrow window.
  it("drops the preview floor and one divider when the preview is hidden", () => {
    const widths = { tree: 320, chat: 640 };
    // 960 - 8 = 952, and 320 + 640 is 960, so a little still has to go.
    const fitted = fitPanelWidths(widths, { tree: true, chat: true, preview: false }, 960);
    expect(fitted.tree + fitted.chat).toBe(952);
    // Much narrower: 700 - 8 = 692.
    const narrow = fitPanelWidths(widths, { tree: true, chat: true, preview: false }, 700);
    expect(narrow.tree + narrow.chat).toBe(692);
  });

  it("counts no divider when a single pane is all that is left", () => {
    const fitted = fitPanelWidths(
      { tree: 320, chat: 640 },
      { tree: false, chat: true, preview: false },
      500,
    );
    expect(fitted.chat).toBe(500);
  });
});

describe("splitPairWidths", () => {
  it("moves width across the boundary and keeps the total", () => {
    expect(splitPairWidths("tree", "chat", 400, 960)).toEqual({ left: 400, right: 560 });
    expect(splitPairWidths("chat", "tree", 700, 960)).toEqual({ left: 700, right: 260 });
  });

  it("stops each pane at its own minimum", () => {
    // Chat's floor is 280, so tree cannot take more than 680 of the 960.
    expect(splitPairWidths("tree", "chat", 900, 960)).toEqual({ left: 680, right: 280 });
    // Tree's floor is 150, so chat cannot take more than 810.
    expect(splitPairWidths("chat", "tree", 940, 960)).toEqual({ left: 810, right: 150 });
  });

  it("falls back to the minimums when the total cannot be split legally", () => {
    // 150 + 280 is already more than 300.
    expect(splitPairWidths("tree", "chat", 200, 300)).toEqual({ left: 150, right: 280 });
  });
});

describe("clampTranscriptWidth", () => {
  it("holds the message column inside its range", () => {
    expect(clampTranscriptWidth(10)).toBe(480);
    expect(clampTranscriptWidth(9999)).toBe(1280);
    expect(clampTranscriptWidth(900)).toBe(900);
  });

  it("falls back for a non-finite value", () => {
    expect(clampTranscriptWidth(Number.NaN)).toBe(768);
  });
});

describe("clampPanelWidth", () => {
  it("clamps to the pane's own range when no room is given", () => {
    expect(clampPanelWidth("tree", 10)).toBe(150);
    expect(clampPanelWidth("tree", 9999)).toBe(1280);
    expect(clampPanelWidth("chat", 10)).toBe(280);
    expect(clampPanelWidth("chat", 9999)).toBe(1280);
  });

  it("leaves room for the preview when the column area is known", () => {
    // 900 wide, the other pane takes 0: 900 - 200 floor = 700.
    expect(clampPanelWidth("tree", 9999, 900)).toBe(700);
    // Never below the pane's own minimum, even in a cramped column.
    expect(clampPanelWidth("tree", 9999, 200)).toBe(150);
  });

  it("falls back to the default for a non-finite value", () => {
    expect(clampPanelWidth("tree", Number.NaN)).toBe(320);
    expect(clampPanelWidth("chat", Number.POSITIVE_INFINITY)).toBe(640);
  });
});
