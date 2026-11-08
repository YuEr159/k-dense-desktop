import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ContextUsageIndicator } from "./context-usage-indicator";

describe("ContextUsageIndicator", () => {
  it("shows Pi context utilization accessibly", () => {
    render(
      <TooltipProvider>
        <ContextUsageIndicator
          usage={{ tokens: 42_000, contextWindow: 200_000, percent: 21 }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("21%");
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Model context 21.0 percent, 42,000 of 200,000 usable tokens",
    );
  });

  // The compaction trigger, not the raw window, is what the reader budgets
  // against: at 150K of a 200K window that compacts at 120K, the gauge is at
  // 125%, not 75%.
  it("measures against the compaction trigger when one is known", () => {
    render(
      <TooltipProvider>
        <ContextUsageIndicator
          usage={{ tokens: 150_000, contextWindow: 200_000, percent: 75, compactAt: 120_000 }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("125%");
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Model context 125.0 percent, 150,000 of 120,000 usable tokens",
    );
  });

  it("shows the unmeasured state and hides without usage", () => {
    const { rerender } = render(
      <TooltipProvider>
        <ContextUsageIndicator
          usage={{ tokens: null, contextWindow: 200_000, percent: null }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("?%");
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Model context usage awaiting provider measurement, 200,000 token usable window",
    );

    rerender(
      <TooltipProvider>
        <ContextUsageIndicator usage={null} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("ContextUsageIndicator compact action", () => {
  const usage = { tokens: 150_000, contextWindow: 200_000, percent: 75 };

  it("renders no action without onCompact", () => {
    render(
      <TooltipProvider>
        <ContextUsageIndicator usage={usage} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("button", { name: "Compact context now" })).toBeNull();
  });

  it("calls onCompact and disables while streaming", () => {
    const onCompact = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <ContextUsageIndicator usage={usage} onCompact={onCompact} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compact context now" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    rerender(
      <TooltipProvider>
        <ContextUsageIndicator usage={usage} onCompact={onCompact} compactDisabled />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Compact context now" })).toBeDisabled();
  });
});
