/**
 * The thinking-level list is hand-maintained in two places (server and web)
 * while Pi owns the real definition. Pi 1.0 added "max" and nothing here
 * noticed, so every level past "xhigh" was silently rejected at the run
 * endpoint. These tests fail when the lists and Pi's type disagree.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { THINKING_LEVELS } from "../src/agent/thinking.ts";

const require = createRequire(import.meta.url);

/** Pi exports no runtime constant for this, so read the type it declares. */
function piThinkingLevels(): string[] {
  const pkg = require.resolve("@earendil-works/pi-agent-core/package.json");
  const typesPath = path.join(path.dirname(pkg), "dist", "types.d.ts");
  const declaration = fs.readFileSync(typesPath, "utf8");
  const match = declaration.match(/export type ThinkingLevel = ([^;]+);/);
  if (!match) throw new Error(`no ThinkingLevel declaration in ${typesPath}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("thinking levels", () => {
  it("covers every level Pi accepts", () => {
    const pi = piThinkingLevels();
    // A level Pi supports but Kady omits is rejected by parseThinkingLevel and
    // the run silently keeps the previous level instead of erroring.
    expect(pi.filter((level) => !THINKING_LEVELS.includes(level as never))).toEqual([]);
  });

  it("invents no level Pi would reject", () => {
    const pi = piThinkingLevels();
    expect(THINKING_LEVELS.filter((level) => !pi.includes(level))).toEqual([]);
  });

  it("matches the frontend list", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "web", "src", "lib", "thinking-levels.ts"),
      "utf8",
    );
    const frontend = [...source.matchAll(/^\s*"([a-z]+)",$/gm)].map((m) => m[1]);
    expect(frontend).toEqual([...THINKING_LEVELS]);
  });
});
