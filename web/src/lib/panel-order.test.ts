import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_ORDER,
  handleTarget,
  normalizePanelOrder,
  readPanelOrder,
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

describe("handleTarget", () => {
  it("resizes the fixed-width pane on either side of the preview", () => {
    expect(handleTarget("tree", "preview")).toEqual({ panel: "tree", sign: 1 });
    expect(handleTarget("preview", "tree")).toEqual({ panel: "tree", sign: -1 });
    expect(handleTarget("chat", "preview")).toEqual({ panel: "chat", sign: 1 });
    expect(handleTarget("preview", "chat")).toEqual({ panel: "chat", sign: -1 });
  });

  // Once the preview moves to an end, tree and chat can border each other.
  // Neither is flexible, so the boundary can only swap.
  it("offers no resize when two fixed-width panes meet", () => {
    expect(handleTarget("tree", "chat")).toBeNull();
    expect(handleTarget("chat", "tree")).toBeNull();
  });

  it("offers no resize for a repeated pane or an unknown id", () => {
    expect(handleTarget("tree", "tree")).toBeNull();
    expect(handleTarget("nope" as never, "preview")).toBeNull();
  });
});
