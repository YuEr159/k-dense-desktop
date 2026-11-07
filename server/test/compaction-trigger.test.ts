import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  MIN_REPLY_HEADROOM,
  modelOverrideKey,
  readCompactionState,
  readModelOverrides,
  reserveForWindow,
  writeModelReserveTokens,
} from "../src/agent/compaction-settings.ts";
import { LEAD_DEFAULT_TOOLS } from "../src/agent/tools.ts";
import type { ProjectPaths } from "../src/projects.ts";

function sandbox(): { paths: ProjectPaths; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-trigger-"));
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  return { paths: { sandbox: dir } as ProjectPaths, dir };
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tracked() {
  const made = sandbox();
  cleanup.push(made.dir);
  return made;
}

describe("reserveForWindow", () => {
  it("converts a trigger point into the reserve Pi needs", () => {
    expect(reserveForWindow(400_000, 1_050_000)).toBe(650_000);
    // The same trigger keeps its meaning on a smaller model instead of
    // inheriting the reserve computed for a large one.
    expect(reserveForWindow(100_000, 200_000)).toBe(100_000);
  });

  it("leaves reply headroom when the trigger lands past the window", () => {
    // A trigger at 990K on a 200K model cannot be honoured; the latest usable
    // point leaves room for the answer rather than collapsing to zero.
    expect(reserveForWindow(990_000, 200_000)).toBe(MIN_REPLY_HEADROOM);
    expect(reserveForWindow(1_000_000, 1_050_000)).toBe(50_000);
  });

  it("never returns a negative reserve on a window smaller than the headroom", () => {
    expect(reserveForWindow(4_000, 1_000)).toBe(0);
  });
});

describe("writeModelReserveTokens", () => {
  it("writes one model's override and keeps the rest of the file", () => {
    const { paths, dir } = tracked();
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ packages: ["/x"], compaction: { keepRecentTokens: 20_000 } }),
    );

    expect(writeModelReserveTokens(paths, "openrouter/openai/gpt-6-astra", 650_000)).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(dir, ".pi", "settings.json"), "utf-8"));
    expect(written.packages).toEqual(["/x"]);
    expect(written.compaction.keepRecentTokens).toBe(20_000);
    expect(written.compaction.modelOverrides).toEqual({
      "openrouter/openai/gpt-6-astra": { reserveTokens: 650_000 },
    });
  });

  // Launches run on every `subagent` call, so the unchanged path must not
  // rewrite the file: the write is unlocked and two tabs writing different
  // models at once would lose one key.
  it("reports no change when the value is already there", () => {
    const { paths } = tracked();
    writeModelReserveTokens(paths, "p/m", 100_000);
    expect(writeModelReserveTokens(paths, "p/m", 100_000)).toBe(false);
  });

  it("replaces a stale value", () => {
    const { paths } = tracked();
    writeModelReserveTokens(paths, "p/m", 100_000);
    expect(writeModelReserveTokens(paths, "p/m", 200_000)).toBe(true);
    expect(readModelOverrides(paths)["p/m"]).toEqual({ reserveTokens: 200_000 });
  });

  it("keeps other entries and other fields of the same entry", () => {
    const { paths, dir } = tracked();
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({
        compaction: {
          modelOverrides: {
            "a/one": { reserveTokens: 1_000, keepRecentTokens: 30_000 },
            "b/two": { reserveTokens: 2_000 },
          },
        },
      }),
    );
    writeModelReserveTokens(paths, "a/one", 5_000);
    expect(readModelOverrides(paths)).toEqual({
      "a/one": { reserveTokens: 5_000, keepRecentTokens: 30_000 },
      "b/two": { reserveTokens: 2_000 },
    });
  });

  it("refuses to rewrite a malformed file", () => {
    const { paths, dir } = tracked();
    const file = path.join(dir, ".pi", "settings.json");
    fs.writeFileSync(file, "{ not json");
    expect(writeModelReserveTokens(paths, "p/m", 1_000)).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("{ not json");
  });
});

describe("readModelOverrides", () => {
  it("drops entries Pi would throw on", () => {
    const { paths, dir } = tracked();
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({
        compaction: {
          modelOverrides: {
            "good/model": { reserveTokens: 10 },
            "bad/string": "nope",
            "bad/negative": { reserveTokens: -1 },
            "bad/float": { reserveTokens: 1.5 },
          },
        },
      }),
    );
    expect(readModelOverrides(paths)).toEqual({ "good/model": { reserveTokens: 10 } });
  });

  it("returns an empty map when nothing is configured", () => {
    const { paths } = tracked();
    expect(readModelOverrides(paths)).toEqual({});
  });
});

describe("modelOverrideKey", () => {
  // Pi keys overrides as `${provider}/${id}` and splits on the first slash
  // only, so an OpenRouter id keeps its own slash.
  it("keeps a model id that contains a slash whole", () => {
    expect(modelOverrideKey("openrouter", "openai/gpt-6-astra")).toBe("openrouter/openai/gpt-6-astra");
  });
});

// Pi validates lazily inside the per-turn compaction check, so a stored value
// it rejects fails runs while the card still reads a healthy default. These
// cases are what Pi 1.3.0 throws on; the card names them instead of hiding them.
describe("readCompactionState", () => {
  function stored(body: unknown) {
    const made = tracked();
    fs.writeFileSync(
      path.join(made.paths.sandbox, ".pi", "settings.json"),
      JSON.stringify(body),
    );
    return readCompactionState(made.paths);
  }

  it("reports a reserve the schema rejects, still reading a usable default", () => {
    const state = stored({ compaction: { reserveTokens: "not a number" } });
    expect(state.invalid).toEqual(["compaction.reserveTokens"]);
    expect(state.settings.reserveTokens).toBe(16_384);
  });

  it("reports negative and fractional counts", () => {
    expect(stored({ compaction: { reserveTokens: -5 } }).invalid).toEqual([
      "compaction.reserveTokens",
    ]);
    expect(stored({ compaction: { keepRecentTokens: 1.5 } }).invalid).toEqual([
      "compaction.keepRecentTokens",
    ]);
  });

  it("reports malformed model overrides, including a bad field inside one", () => {
    expect(
      stored({ compaction: { modelOverrides: { "a/b": "nope" } } }).invalid,
    ).toEqual(['compaction.modelOverrides["a/b"]']);
    expect(
      stored({ compaction: { modelOverrides: { "a/b": { reserveTokens: "x" } } } }).invalid,
    ).toEqual(['compaction.modelOverrides["a/b"].reserveTokens']);
  });

  // Pi ignores these, so flagging them would send the user chasing a phantom.
  it("stays quiet about keys Pi does not validate", () => {
    const state = stored({
      compaction: { enabled: "yes", autoCompactWindow: "400000" },
    });
    expect(state.invalid).toEqual([]);
  });

  it("is clean on a valid file and on a missing one", () => {
    expect(
      stored({ compaction: { reserveTokens: 32_000, modelOverrides: { "a/b": { reserveTokens: 900 } } } })
        .invalid,
    ).toEqual([]);
    expect(readCompactionState(tracked().paths).invalid).toEqual([]);
  });
});

// The run route pushes the converted reserve in memory instead of writing the
// file, so the two properties this depends on are worth pinning: the override
// reaches Pi's getter, and it does not clobber the tool override the session
// registry installs on the same manager.
describe("applyOverrides for the per-run trigger", () => {
  it("reaches Pi's getter and survives alongside the lead's tool override", () => {
    const made = tracked();
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-agent-"));
    cleanup.push(agentDir);
    const manager = SettingsManager.create(made.paths.sandbox, agentDir);
    manager.applyOverrides({ defaultTools: LEAD_DEFAULT_TOOLS });

    const model = { provider: "openrouter", id: "openai/gpt-6-astra", contextWindow: 1_050_000 };
    const reserve = reserveForWindow(400_000, model.contextWindow);
    // `+grep` expands into the full base set, so the pre-override value is the
    // only stable reference for "the compaction override changed nothing here".
    const toolsBefore = manager.getDefaultTools();
    manager.applyOverrides({ compaction: { reserveTokens: reserve } });

    expect(manager.getCompactionSettings(model as never).reserveTokens).toBe(reserve);
    expect(manager.getDefaultTools()).toEqual(toolsBefore);

    // Nothing was persisted: Pi re-reads the file on reload(), and a write here
    // would leak one run's model-specific number into every child process.
    const settingsFile = path.join(made.paths.sandbox, ".pi", "settings.json");
    const onDisk = fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, "utf-8"))
      : {};
    expect(onDisk.compaction?.reserveTokens).toBeUndefined();
  });
});
