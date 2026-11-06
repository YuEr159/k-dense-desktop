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

const groupButton = (name: RegExp) => screen.getByRole("button", { name });

describe("ModelPickerList section folding", () => {
  it("opens only the section holding the current pick", () => {
    render(<ModelPickerList selected={CATALOGUE[0]} onSelect={() => {}} />);
    expect(groupButton(/anthropic/i)).toHaveAttribute("aria-expanded", "true");
    expect(groupButton(/openai/i)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("option", { name: /claude x/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /gpt x/i })).not.toBeInTheDocument();
  });

  // No pick means no section to privilege; a fully folded list would hide
  // every option behind a click.
  it("opens everything when nothing is selected", () => {
    render(<ModelPickerList selected={null} onSelect={() => {}} />);
    expect(groupButton(/anthropic/i)).toHaveAttribute("aria-expanded", "true");
    expect(groupButton(/openai/i)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: /gpt x/i })).toBeInTheDocument();
  });

  it("expands a folded section on click", async () => {
    const user = userEvent.setup();
    render(<ModelPickerList selected={CATALOGUE[0]} onSelect={() => {}} />);
    await user.click(groupButton(/openai/i));
    expect(groupButton(/openai/i)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: /gpt x/i })).toBeInTheDocument();
  });

  // The selected section opens by default, not by rule: the user can still
  // fold it, and their answer outranks the default on later renders.
  it("lets the selected section be folded by hand", async () => {
    const user = userEvent.setup();
    render(<ModelPickerList selected={CATALOGUE[0]} onSelect={() => {}} />);
    await user.click(groupButton(/anthropic/i));
    expect(groupButton(/anthropic/i)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option", { name: /claude x/i })).not.toBeInTheDocument();
  });

  // A match hidden inside a folded section reads as "no results", so typing
  // has to reveal it — that is the whole reason search overrides the fold.
  it("shows folded sections again while searching", async () => {
    const user = userEvent.setup();
    render(<ModelPickerList selected={CATALOGUE[0]} onSelect={() => {}} />);
    expect(screen.queryByRole("option", { name: /gpt x/i })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/search models/i), "gpt");
    expect(screen.getByRole("option", { name: /gpt x/i })).toBeInTheDocument();
  });

  it("goes back to the folded default once the search is cleared", async () => {
    const user = userEvent.setup();
    render(<ModelPickerList selected={CATALOGUE[0]} onSelect={() => {}} />);
    const input = screen.getByPlaceholderText(/search models/i);
    await user.type(input, "gpt");
    await user.clear(input);
    expect(screen.queryByRole("option", { name: /gpt x/i })).not.toBeInTheDocument();
  });

  it("keeps the model count visible while folded", () => {
    render(<ModelPickerList selected={CATALOGUE[0]} onSelect={() => {}} />);
    expect(within(groupButton(/openai/i)).getByText("1 model")).toBeInTheDocument();
  });
});
