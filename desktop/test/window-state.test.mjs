/**
 * The rules behind remembering where the window was.
 *
 * Worth testing without a display because the failure modes are quiet: a
 * window restored onto a monitor that is no longer connected, or a maximized
 * window saved at screen size and then un-maximized to something absurd. Both
 * look like "the app did not open" rather than an error.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { boundsVisibleSomewhere, restoreWindowState, windowStateToSave } from "../window-state.mjs";

const laptop = { x: 0, y: 0, width: 1440, height: 900 };
const external = { x: 1440, y: 0, width: 2560, height: 1440 };
const bounds = { x: 100, y: 100, width: 1200, height: 800 };

describe("boundsVisibleSomewhere", () => {
  it("accepts a window fully inside a display", () => {
    assert.equal(boundsVisibleSomewhere(bounds, [laptop]), true);
  });

  it("accepts a window deliberately hanging off an edge", () => {
    // Half on the laptop, half past its right edge. This is a legitimate
    // choice and must survive.
    assert.equal(boundsVisibleSomewhere({ x: 1200, y: 100, width: 800, height: 600 }, [laptop]), true);
  });

  it("rejects a window entirely on a display that is gone", () => {
    const onExternal = { x: 1500, y: 100, width: 1200, height: 800 };
    assert.equal(boundsVisibleSomewhere(onExternal, [laptop]), false);
    // ...but it is fine once that display is back.
    assert.equal(boundsVisibleSomewhere(onExternal, [laptop, external]), true);
  });

  it("rejects a window pushed wholly off every edge", () => {
    assert.equal(boundsVisibleSomewhere({ x: -5000, y: 0, width: 800, height: 600 }, [laptop]), false);
    assert.equal(boundsVisibleSomewhere({ x: 0, y: 5000, width: 800, height: 600 }, [laptop]), false);
  });

  it("treats a purely touching edge as not visible", () => {
    // A window whose right edge is exactly the display's left edge shows
    // nothing, so restoring it is the same as restoring nothing.
    assert.equal(boundsVisibleSomewhere({ x: -800, y: 100, width: 800, height: 600 }, [laptop]), false);
  });
});

describe("restoreWindowState", () => {
  it("returns usable bounds and the maximized flag", () => {
    assert.deepEqual(restoreWindowState({ bounds, maximized: true }, [laptop]), {
      bounds,
      maximized: true,
    });
  });

  it("defaults maximized to false", () => {
    assert.deepEqual(restoreWindowState({ bounds }, [laptop]), { bounds, maximized: false });
    assert.deepEqual(restoreWindowState({ bounds, maximized: "yes" }, [laptop]), {
      bounds,
      maximized: false,
    });
  });

  it("has no opinion about a missing, malformed or incomplete record", () => {
    for (const saved of [undefined, null, "nope", [], {}, { bounds: null }, { bounds: {} }]) {
      assert.deepEqual(restoreWindowState(saved, [laptop]), {}, `saved=${JSON.stringify(saved)}`);
    }
  });

  it("ignores non-finite coordinates rather than passing them to BrowserWindow", () => {
    for (const bad of [{ x: NaN }, { y: Infinity }, { width: "1200" }, { height: null }]) {
      const saved = { bounds: { ...bounds, ...bad } };
      assert.deepEqual(restoreWindowState(saved, [laptop]), {}, `bad=${JSON.stringify(bad)}`);
    }
  });

  it("drops a rectangle too small to be a real window", () => {
    assert.deepEqual(restoreWindowState({ bounds: { x: 0, y: 0, width: 80, height: 60 } }, [laptop]), {});
    assert.deepEqual(restoreWindowState({ bounds: { x: 0, y: 0, width: 199, height: 900 } }, [laptop]), {});
    assert.notDeepEqual(restoreWindowState({ bounds: { x: 0, y: 0, width: 200, height: 200 } }, [laptop]), {});
  });

  it("drops a rectangle no current display shows", () => {
    const onGone = { x: 5000, y: 0, width: 1200, height: 800 };
    assert.deepEqual(restoreWindowState({ bounds: onGone }, [laptop]), {});
  });
});

describe("windowStateToSave", () => {
  it("keeps the normal bounds and the maximized flag", () => {
    assert.deepEqual(
      windowStateToSave({ normalBounds: bounds, maximized: true, fullScreen: false }),
      { bounds, maximized: true },
    );
  });

  it("refuses to save a fullscreen rectangle", () => {
    // A fullscreen window reports the screen size; restoring it would leave
    // the next launch at a size it cannot un-maximize from sensibly.
    assert.equal(windowStateToSave({ normalBounds: bounds, maximized: false, fullScreen: true }), null);
  });

  it("refuses to save a degenerate rectangle", () => {
    assert.equal(windowStateToSave({ normalBounds: null, maximized: false, fullScreen: false }), null);
    assert.equal(
      windowStateToSave({ normalBounds: { x: 0, y: 0, width: 10, height: 10 }, maximized: false, fullScreen: false }),
      null,
    );
  });
});
