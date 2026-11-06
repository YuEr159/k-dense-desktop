import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const CATALOGUE = [
  {
    id: "anthropic/claude-x",
    label: "Claude X",
    provider: "Anthropic",
    tier: "high" as const,
    context_length: 200_000,
    pricing: { prompt: 3, completion: 15 },
    modality: null,
    description: "",
    sourceId: "anthropic",
    sourceLabel: "Anthropic",
  },
  {
    id: "openai/gpt-x",
    label: "GPT X",
    provider: "OpenAI",
    tier: "high" as const,
    context_length: 128_000,
    pricing: { prompt: 2, completion: 10 },
    modality: null,
    description: "",
    sourceId: "openai",
    sourceLabel: "OpenAI",
  },
];

vi.mock("@/lib/use-models", () => ({
  useModels: () => ({
    models: CATALOGUE,
    ollamaAvailable: false,
    ollamaModels: [],
    openaiCompatibleAvailable: false,
    openaiCompatibleModels: [],
    openaiCompatibleConfigured: false,
    refresh: () => {},
  }),
}));

const { ModelPickerList } = await import("@/components/model-selector");

function renderPicker() {
  return render(<ModelPickerList selected={null} onSelect={() => {}} />);
}

const groupButton = (name: RegExp | string) => screen.getByRole("button", { name });

describe("ModelPickerList section folding", () => {
  it("starts with every section open", () => {
    renderPicker();
    expect(groupButton(/anthropic/i)).toHaveAttribute("aria-expanded", "true");
    expect(groupButton(/openai/i)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: /claude x/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /gpt x/i })).toBeInTheDocument();
  });

  it("folds only the section that was clicked", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(groupButton(/anthropic/i));
    expect(groupButton(/anthropic/i)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: /claude x/i })).not.toBeInTheDocument();
    // The other section is untouched.
    expect(groupButton(/openai/i)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: /gpt x/i })).toBeInTheDocument();
  });

  it("unfolds again on a second click", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(groupButton(/anthropic/i));
    await user.click(groupButton(/anthropic/i));
    expect(groupButton(/anthropic/i)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: /claude x/i })).toBeInTheDocument();
  });

  // A match hidden inside a folded section reads as "no results", so typing
  // has to reveal it — that is the whole reason search overrides the fold.
  it("shows folded sections again while searching", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(groupButton(/anthropic/i));
    expect(screen.queryByRole("option", { name: /claude x/i })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/search models/i), "claude");
    expect(screen.getByRole("option", { name: /claude x/i })).toBeInTheDocument();
  });

  it("goes back to folded once the search is cleared", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(groupButton(/anthropic/i));
    const input = screen.getByPlaceholderText(/search models/i);
    await user.type(input, "claude");
    await user.clear(input);
    expect(screen.queryByRole("option", { name: /claude x/i })).not.toBeInTheDocument();
  });

  it("keeps the model count visible while folded", async () => {
    const user = userEvent.setup();
    renderPicker();
    const button = groupButton(/anthropic/i);
    await user.click(button);
    expect(within(button).getByText("1 model")).toBeInTheDocument();
  });
});
