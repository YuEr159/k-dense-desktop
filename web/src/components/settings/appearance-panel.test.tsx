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
  // Rows keep a fixed order (Files, Preview, Chat) no matter how the panes are
  // arranged, so the row you clicked never jumps elsewhere in the list.
  it("keeps the row order fixed and reports each pane's position", () => {
    localStorage.setItem("kady:panel-order", JSON.stringify(["chat", "preview", "tree"]));
    render(<AppearancePanel />);
    const items = [...document.querySelectorAll("#panel-order li")].map((li) => li.textContent);
    expect(items[0]).toContain("Files");
    expect(items[1]).toContain("Preview");
    expect(items[2]).toContain("Chat");
    // Chat is first in the layout, so its row says 1 / 3.
    expect(items[2]).toContain("1 / 3");
    expect(items[0]).toContain("3 / 3");
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
  it("shows width sliders only when a host supplies them", () => {
    const { rerender } = render(<AppearancePanel />);
    expect(document.getElementById("panel-widths")).toBeNull();

    const onChange = vi.fn();
    rerender(<AppearancePanel panelWidths={{ tree: 320, chat: 640 }} onPanelWidthChange={onChange} />);
    const card = document.getElementById("panel-widths")!;
    expect(card).not.toBeNull();
    const sliders = [...card.querySelectorAll<HTMLInputElement>("input[type=range]")];
    expect(sliders.map((s) => s.value)).toEqual(["320", "640"]);
    // 1280 is the requested ceiling for both panes.
    expect(sliders.map((s) => s.max)).toEqual(["1280", "1280"]);
  });

  it("reports a slider move through the same clamp the drag uses", () => {
    const onChange = vi.fn();
    render(<AppearancePanel panelWidths={{ tree: 320, chat: 640 }} onPanelWidthChange={onChange} />);
    const [treeSlider] = document.querySelectorAll<HTMLInputElement>("#panel-widths input");
    fireEvent.change(treeSlider, { target: { value: "1280" } });
    expect(onChange).toHaveBeenCalledWith("tree", 1280);
  });

  // Every pane can be collapsed, including the preview, which has no close
  // button in the workspace header.
  it("offers a visibility toggle for each pane", () => {
    const onChange = vi.fn();
    render(
      <AppearancePanel
        panelVisibility={{ tree: true, chat: false, preview: true }}
        onPanelVisibilityChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Hide Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Preview" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show Chat" }));
    expect(onChange).toHaveBeenCalledWith("chat", true);
    fireEvent.click(screen.getByRole("button", { name: "Hide Preview" }));
    expect(onChange).toHaveBeenCalledWith("preview", false);
  });

  it("hides the toggles when no host owns the visibility state", () => {
    render(<AppearancePanel />);
    expect(screen.queryByRole("button", { name: "Hide Files" })).toBeNull();
  });

  // The transcript column belongs to the workspace, so like the widths it only
  // appears where a host passes it down.
  it("reports transcript width through its own clamp", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AppearancePanel />);
    expect(document.getElementById("transcript-width")).toBeNull();

    rerender(<AppearancePanel transcriptWidth={768} onTranscriptWidthChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Chat transcript width" });
    expect(slider).toHaveValue("768");
    expect(slider).toHaveAttribute("max", "1280");

    fireEvent.change(slider, { target: { value: "1280" } });
    expect(onChange).toHaveBeenCalledWith(1280);
  });
});
