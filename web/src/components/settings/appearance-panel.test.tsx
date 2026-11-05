import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AppearancePanel } from "./appearance-panel";

// The panel renders three unrelated blocks (theme, shell settings, panes) and
// only the last two are ours; the shell settings fetch is stubbed so the
// assertions do not depend on the backend.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AppearancePanel panel layout", () => {
  it("lists all three panes in the saved order", () => {
    localStorage.setItem("kady:panel-order", JSON.stringify(["chat", "preview", "tree"]));
    render(<AppearancePanel />);
    const items = [...document.querySelectorAll("#panel-order li")].map((li) => li.textContent);
    expect(items[0]).toContain("Chat");
    expect(items[1]).toContain("Preview");
    expect(items[2]).toContain("Files");
  });

  it("moves a pane towards the start and persists the result", () => {
    localStorage.setItem("kady:panel-order", JSON.stringify(["tree", "preview", "chat"]));
    render(<AppearancePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Move Chat left" }));
    expect(JSON.parse(localStorage.getItem("kady:panel-order")!)).toEqual([
      "tree",
      "chat",
      "preview",
    ]);
  });

  it("disables the arrow that would move a pane past the edge", () => {
    localStorage.setItem("kady:panel-order", JSON.stringify(["tree", "preview", "chat"]));
    render(<AppearancePanel />);
    expect(screen.getByRole("button", { name: "Move Files left" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Chat right" })).toBeDisabled();
  });

  // The widths belong to the workspace's per-project state, so the block only
  // exists where a host passes them down.
  it("shows the width fields only when a host supplies them", () => {
    const { rerender } = render(<AppearancePanel />);
    expect(document.getElementById("panel-widths")).toBeNull();

    const onChange = vi.fn();
    rerender(<AppearancePanel panelWidths={{ tree: 320, chat: 640 }} onPanelWidthChange={onChange} />);
    const card = document.getElementById("panel-widths")!;
    expect(card).not.toBeNull();
    expect([...card.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value)).toEqual([
      "320",
      "640",
    ]);
  });

  it("clamps a typed width to the same bounds the drag handle uses", () => {
    const onChange = vi.fn();
    render(<AppearancePanel panelWidths={{ tree: 320, chat: 640 }} onPanelWidthChange={onChange} />);
    const [treeInput] = document.querySelectorAll<HTMLInputElement>("#panel-widths input");
    fireEvent.change(treeInput, { target: { value: "9999" } });
    expect(onChange).toHaveBeenCalledWith("tree", 480);
    fireEvent.change(treeInput, { target: { value: "10" } });
    expect(onChange).toHaveBeenCalledWith("tree", 150);
  });
});
