import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeDialogRestoreRequest,
  consumeScreenRestoreRequest,
  writeLocale,
} from "./locale";

/**
 * The language switch reloads the page, so "where the user was" has to survive
 * it through localStorage markers. These tests pin the two properties that
 * matter: a switch sets both, and a plain load consumes neither.
 */
describe("locale reload markers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // `writeLocale` reloads; unresolvable in jsdom, so stub it.
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload: vi.fn(),
    } as unknown as Location);
  });

  it("marks both the screen and the settings dialog on a switch", () => {
    writeLocale("en");
    expect(window.localStorage.getItem("kady:locale")).toBe("en");
    expect(consumeScreenRestoreRequest()).toBe(true);
    expect(consumeDialogRestoreRequest()).toBe("settings");
  });

  it("consumes each marker exactly once", () => {
    writeLocale("zh-CN");
    expect(consumeScreenRestoreRequest()).toBe(true);
    expect(consumeScreenRestoreRequest()).toBe(false);
    expect(consumeDialogRestoreRequest()).toBe("settings");
    expect(consumeDialogRestoreRequest()).toBeNull();
  });

  it("reports nothing on a plain load", () => {
    // A manual refresh, a new tab or a restart must keep the app's normal
    // "start on the overview" behaviour.
    expect(consumeScreenRestoreRequest()).toBe(false);
    expect(consumeDialogRestoreRequest()).toBeNull();
  });
});
