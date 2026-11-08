import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TRANSCRIPT_VIEW,
  TRANSCRIPT_VIEW_CHANGED_EVENT,
  TRANSCRIPT_VIEW_KEY,
  lastSegmentPreview,
  normalizeTranscriptView,
  readTranscriptView,
  reasoningShowsPreview,
  reasoningStartsOpen,
  writeTranscriptView,
} from "./transcript-view";

function memoryStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(TRANSCRIPT_VIEW_KEY, initial);
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    raw: store,
  };
}

describe("normalizeTranscriptView", () => {
  it("keeps the three known modes", () => {
    expect(normalizeTranscriptView("compact")).toBe("compact");
    expect(normalizeTranscriptView("standard")).toBe("standard");
    expect(normalizeTranscriptView("expanded")).toBe("expanded");
  });

  // A stored value from a future version, or hand-edited, must not leave the
  // transcript in a state no branch handles.
  it("falls back for anything else", () => {
    expect(normalizeTranscriptView("verbose")).toBe(DEFAULT_TRANSCRIPT_VIEW);
    expect(normalizeTranscriptView(null)).toBe(DEFAULT_TRANSCRIPT_VIEW);
    expect(normalizeTranscriptView(3)).toBe(DEFAULT_TRANSCRIPT_VIEW);
  });
});

describe("transcript view storage", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    writeTranscriptView(storage, "expanded");
    expect(readTranscriptView(storage)).toBe("expanded");
  });

  it("falls back when nothing is stored", () => {
    expect(readTranscriptView(memoryStorage())).toBe(DEFAULT_TRANSCRIPT_VIEW);
  });

  it("falls back when the stored value is not JSON", () => {
    expect(readTranscriptView(memoryStorage("expanded"))).toBe(DEFAULT_TRANSCRIPT_VIEW);
  });

  it("falls back for an unknown stored value", () => {
    expect(readTranscriptView(memoryStorage(JSON.stringify("verbose")))).toBe(DEFAULT_TRANSCRIPT_VIEW);
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
    expect(readTranscriptView(storage)).toBe(DEFAULT_TRANSCRIPT_VIEW);
    expect(() => writeTranscriptView(storage, "compact")).not.toThrow();
  });

  // Private mode blocks the write; the in-session change must still reach the
  // components that listen for it.
  it("broadcasts even when the storage write throws", () => {
    const listener = vi.fn();
    window.addEventListener(TRANSCRIPT_VIEW_CHANGED_EVENT, listener);
    try {
      writeTranscriptView(
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        "expanded",
      );
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe("expanded");
    } finally {
      window.removeEventListener(TRANSCRIPT_VIEW_CHANGED_EVENT, listener);
    }
  });
});

describe("lastSegmentPreview", () => {
  it("shows the end of the paragraph being written", () => {
    expect(lastSegmentPreview("Let me look.\n\nNow comparing medians")).toBe(
      "Now comparing medians",
    );
  });

  // Reasoning grows at the end, so the newest words are the interesting ones.
  it("keeps the tail when the segment is longer than the cap", () => {
    const long = "a".repeat(300) + "TAIL";
    expect(lastSegmentPreview(long, 140)).toBe(`…${long.slice(-140)}`);
  });

  it("collapses the blank line between paragraphs to the current one", () => {
    expect(lastSegmentPreview("First para.\n\nSecond\npara.")).toBe("Second para.");
  });

  it("falls back to the whole text when there is no blank line", () => {
    expect(lastSegmentPreview("just one line")).toBe("just one line");
  });

  it("strips markdown bold markers", () => {
    expect(lastSegmentPreview("**Check** the columns")).toBe("Check the columns");
  });

  it("is empty for empty or blank text", () => {
    expect(lastSegmentPreview("")).toBe("");
    expect(lastSegmentPreview("   \n\t\n")).toBe("");
  });

  // A trailing blank line must not make the preview look empty.
  it("ignores trailing whitespace", () => {
    expect(lastSegmentPreview("Working on it.\n\n")).toBe("Working on it.");
  });
});

describe("mode capabilities", () => {
  it("opens reasoning only in expanded", () => {
    expect(reasoningStartsOpen("compact")).toBe(false);
    expect(reasoningStartsOpen("standard")).toBe(false);
    expect(reasoningStartsOpen("expanded")).toBe(true);
  });

  it("previews except in compact", () => {
    expect(reasoningShowsPreview("compact")).toBe(false);
    expect(reasoningShowsPreview("standard")).toBe(true);
    expect(reasoningShowsPreview("expanded")).toBe(true);
  });
});
