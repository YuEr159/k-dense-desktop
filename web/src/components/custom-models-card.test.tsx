import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lib from "@/lib/custom-models";
import { CustomModelsCard, providersFromDrafts, textToThinkingMap, thinkingMapToText } from "./custom-models-card";

afterEach(() => vi.restoreAllMocks());

const modelRow = (patch: Record<string, unknown> = {}) => ({
  id: "m",
  name: "",
  contextWindow: "",
  maxTokens: "",
  reasoning: true,
  image: false,
  costInput: "0",
  costOutput: "0",
  thinkingMap: "",
  adaptiveThinking: false,
  ...patch,
});

describe("thinking level map text", () => {
  it("round-trips a saved map through the editable text", () => {
    const map = { xhigh: "max", max: "max", off: null } as const;
    const text = thinkingMapToText(map);
    expect(text).toBe("off=null\nxhigh=max\nmax=max");
    expect(textToThinkingMap(text, "m")).toEqual(map);
  });

  it("treats blank text as no map at all", () => {
    expect(textToThinkingMap("", "m")).toBeUndefined();
    expect(textToThinkingMap("\n  \n", "m")).toBeUndefined();
  });

  it("names the offending line rather than silently dropping it", () => {
    expect(textToThinkingMap("xhigh", "Model \"m\"")).toMatch(/not a level=effort pair/);
    expect(textToThinkingMap("turbo=max", "Model \"m\"")).toMatch(/unknown thinking level "turbo"/);
    expect(textToThinkingMap("xhigh=", "Model \"m\"")).toMatch(/has no effort value/);
  });

  it("carries the map into the wire payload", () => {
    const ok = providersFromDrafts([
      {
        id: "gw", name: "", baseUrl: "http://gw", api: "anthropic-messages", apiKey: "",
        models: [modelRow({ thinkingMap: "xhigh=max\nmax=max", adaptiveThinking: true })],
      },
    ]);
    expect(ok).toEqual([
      expect.objectContaining({
        models: [expect.objectContaining({ thinkingLevelMap: { xhigh: "max", max: "max" }, compat: { forceAdaptiveThinking: true } })],
      }),
    ]);
  });

  it("refuses an xhigh/max map that the budget path would clamp away", () => {
    // Pi folds both levels into high unless adaptive thinking is on, so this
    // pairing would save fine and then never reach the server.
    const refused = providersFromDrafts([
      {
        id: "gw", name: "", baseUrl: "http://gw", api: "anthropic-messages", apiKey: "",
        models: [modelRow({ thinkingMap: "xhigh=max" })],
      },
    ]);
    expect(refused).toMatch(/needs "Adaptive thinking"/);

    // The same map on an OpenAI-shaped server has nothing to do with Pi's
    // Anthropic budget path, so it is not refused.
    const otherApi = providersFromDrafts([
      {
        id: "gw", name: "", baseUrl: "http://gw", api: "openai-completions", apiKey: "",
        models: [modelRow({ thinkingMap: "xhigh=max" })],
      },
    ]);
    expect(typeof otherApi).not.toBe("string");
  });
});

describe("providersFromDrafts", () => {
  it("normalizes drafts and reports the first problem", () => {
    const ok = providersFromDrafts([
      {
        id: "HPC-VLLM",
        name: "Lab",
        baseUrl: "http://gpu:8000/v1",
        api: "openai-completions",
        apiKey: "",
        models: [
          { id: "llama", name: "", contextWindow: "128000", maxTokens: "", reasoning: true, image: false, costInput: "0.5", costOutput: "1.5", thinkingMap: "", adaptiveThinking: false },
          { id: "  ", name: "", contextWindow: "", maxTokens: "", reasoning: false, image: false, costInput: "0", costOutput: "0", thinkingMap: "", adaptiveThinking: false },
        ],
      },
    ]);
    expect(ok).toEqual([
      {
        id: "hpc-vllm",
        name: "Lab",
        baseUrl: "http://gpu:8000/v1",
        api: "openai-completions",
        models: [{ id: "llama", reasoning: true, input: ["text"], contextWindow: 128000, cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } }],
      },
    ]);
    expect(providersFromDrafts([{ id: "", name: "", baseUrl: "x", api: "openai-completions", apiKey: "", models: [] }])).toMatch(/needs an id/);
    expect(providersFromDrafts([{ id: "a", name: "", baseUrl: "http://x", api: "openai-completions", apiKey: "", models: [] }])).toMatch(/at least one model/);
  });

  it("keeps a saved key it never saw when the field is left blank", () => {
    const row = { id: "m", name: "", contextWindow: "", maxTokens: "", reasoning: false, image: false, costInput: "0", costOutput: "0", thinkingMap: "", adaptiveThinking: false };
    const kept = providersFromDrafts([{ id: "lab", name: "", baseUrl: "http://x/v1", api: "openai-completions", apiKey: "", savedKeyMask: "sk-l…abcd", models: [row] }]);
    expect(kept).toEqual([expect.objectContaining({ id: "lab", keepApiKey: true })]);
    expect((kept as lib.CustomProvider[])[0].apiKey).toBeUndefined();
    const removed = providersFromDrafts([{ id: "lab", name: "", baseUrl: "http://x/v1", api: "openai-completions", apiKey: "", models: [row] }]);
    expect((removed as lib.CustomProvider[])[0].keepApiKey).toBeUndefined();
  });
});

describe("CustomModelsCard", () => {
  it("lists foreign providers read-only, edits a managed one and saves", async () => {
    vi.spyOn(lib, "getCustomProviders").mockResolvedValue([
      { id: "mine", baseUrl: "http://x/v1", api: "openai-completions", models: [{ id: "m" }], managed: false },
      { id: "hpc-vllm", name: "Lab", baseUrl: "http://gpu:8000/v1", api: "openai-completions", apiKey: "$K", models: [{ id: "llama", cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } }], managed: true },
    ]);
    const save = vi.spyOn(lib, "saveCustomProviders").mockImplementation(async (providers) => ({
      providers: providers.map((p) => ({ ...p, managed: true })),
      configured: { "hpc-vllm": false },
    }));
    render(<CustomModelsCard />);
    expect(await screen.findByText("mine")).toBeInTheDocument();
    const baseUrl = screen.getByLabelText("Server 1 base URL");
    expect(baseUrl).toHaveValue("http://gpu:8000/v1");
    await userEvent.clear(baseUrl);
    await userEvent.type(baseUrl, "http://gpu-2:8000/v1");
    await userEvent.click(screen.getByRole("button", { name: "Save servers" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "hpc-vllm", baseUrl: "http://gpu-2:8000/v1", apiKey: "$K", models: [expect.objectContaining({ id: "llama", cost: expect.objectContaining({ input: 0.5, output: 1.5 }) })] }),
    ]);
    expect(await screen.findByText(/could not resolve credentials for: hpc-vllm/)).toBeInTheDocument();
  });

  it("adds a server and refuses to save an incomplete one", async () => {
    vi.spyOn(lib, "getCustomProviders").mockResolvedValue([]);
    const save = vi.spyOn(lib, "saveCustomProviders");
    render(<CustomModelsCard />);
    await screen.findByText("Custom model servers");
    await userEvent.click(screen.getByRole("button", { name: "Add model server" }));
    await userEvent.click(screen.getByRole("button", { name: "Save servers" }));
    expect(await screen.findByText("Every server needs an id")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});
