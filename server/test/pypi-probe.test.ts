import { afterEach, describe, expect, it, vi } from "vitest";

import { probePypiIndexes, resolvePypiIndex, resetPypiIndexForTests } from "../src/helpers-env.ts";

const originalIndex = process.env.KADY_PYPI_INDEX;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPypiIndexForTests();
  if (originalIndex === undefined) delete process.env.KADY_PYPI_INDEX;
  else process.env.KADY_PYPI_INDEX = originalIndex;
});

/**
 * A fetch stand-in where each URL answers after its own delay.
 *
 * Gaps are tens of milliseconds wide on purpose: `Date.now()` deltas around
 * single-digit milliseconds routinely invert under a loaded test runner, and a
 * flaky ordering assertion is worse than a slightly slower test.
 */
function fakeFetch(delays: Record<string, number | "fail">) {
  return vi.fn(async (url: string) => {
    const spec = delays[url];
    // Anything the test did not name is treated as unreachable, which is what
    // an unknown mirror would be from the test machine.
    if (spec === undefined || spec === "fail") throw new Error("network down");
    await new Promise((resolve) => setTimeout(resolve, spec));
    return new Response(null, { status: 200 });
  });
}

describe("probePypiIndexes", () => {
  it("returns candidates fastest first", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "https://slow/simple": 240, "https://fast/simple": 30, "https://mid/simple": 120 }),
    );
    const ranked = await probePypiIndexes(["https://slow/simple", "https://mid/simple", "https://fast/simple"]);
    expect(ranked.map((r) => r.index)).toEqual([
      "https://fast/simple",
      "https://mid/simple",
      "https://slow/simple",
    ]);
  });

  // A source that cannot answer must drop out of the ranking, not sort last:
  // the caller falls back to declaration order for the ones it never measured.
  it("omits sources that error instead of ranking them", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "https://ok/simple": 40, "https://dead/simple": "fail" }),
    );
    const ranked = await probePypiIndexes(["https://dead/simple", "https://ok/simple"]);
    expect(ranked.map((r) => r.index)).toEqual(["https://ok/simple"]);
  });

  it("omits a source that answers with an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("broken") ? new Response(null, { status: 503 }) : new Response(null, { status: 200 }),
      ),
    );
    const ranked = await probePypiIndexes(["https://broken/simple", "https://fine/simple"]);
    expect(ranked.map((r) => r.index)).toEqual(["https://fine/simple"]);
  });

  it("returns an empty list when nothing answers", async () => {
    vi.stubGlobal("fetch", fakeFetch({ "https://a/simple": "fail", "https://b/simple": "fail" }));
    expect(await probePypiIndexes(["https://a/simple", "https://b/simple"])).toEqual([]);
  });

  it("uses HEAD so the probe costs no body", async () => {
    const spy = fakeFetch({ "https://one/simple": 10 });
    vi.stubGlobal("fetch", spy);
    await probePypiIndexes(["https://one/simple"]);
    expect(spy).toHaveBeenCalledWith("https://one/simple", expect.objectContaining({ method: "HEAD" }));
  });
});

describe("resolvePypiIndex", () => {
  it("keeps an explicit setting rather than measuring over it", async () => {
    process.env.KADY_PYPI_INDEX = "https://configured.example/simple";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await resolvePypiIndex()).toBe("https://configured.example/simple");
    // A setting someone made on purpose should not cost a network round trip.
    expect(spy).not.toHaveBeenCalled();
  });

  it("needs no rewrite when plain PyPI wins the probe", async () => {
    delete process.env.KADY_PYPI_INDEX;
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        "https://pypi.org/simple": 30,
        "https://pypi.tuna.tsinghua.edu.cn/simple": 200,
        "https://mirrors.aliyun.com/pypi/simple": 320,
      }),
    );
    expect(await resolvePypiIndex()).toBeNull();
  });

  it("adopts the fastest mirror when it beats PyPI", async () => {
    delete process.env.KADY_PYPI_INDEX;
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        // The shipped candidate list is what resolvePypiIndex probes, so the
        // test has to name real entries rather than invented hosts.
        "https://pypi.org/simple": 240,
        "https://pypi.tuna.tsinghua.edu.cn/simple": 30,
        "https://mirrors.aliyun.com/pypi/simple": 360,
      }),
    );
    expect(await resolvePypiIndex()).toBe("https://pypi.tuna.tsinghua.edu.cn/simple");
  });

  // The whole point of the fallback: a probe that cannot run must leave the
  // download exactly as it would have been without this feature.
  it("leaves the index unset when every probe fails", async () => {
    delete process.env.KADY_PYPI_INDEX;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await resolvePypiIndex()).toBeNull();
  });

  it("resolves only once per process", async () => {
    delete process.env.KADY_PYPI_INDEX;
    const spy = fakeFetch({ "https://pypi.org/simple": 10 });
    vi.stubGlobal("fetch", spy);
    await resolvePypiIndex();
    const calls = spy.mock.calls.length;
    await resolvePypiIndex();
    expect(spy.mock.calls.length).toBe(calls);
  });
});
