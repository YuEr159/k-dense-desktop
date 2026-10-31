#!/usr/bin/env node
/**
 * Report dictionary gaps against what the running app actually renders.
 *
 * The harvester in `harvest-strings.mjs` reads JSX, which misses three real
 * sources of UI copy: strings assembled with template literals, copy that lives
 * in shared constants outside a `.tsx`, and backend-returned text. Those only
 * show up in a live DOM.
 *
 * Usage: paste the `JS` below into the browser console on each screen worth
 * covering, then feed the collected array to `--from` here.
 *
 *   node scripts/i18n-gaps.mjs --from gaps.json
 *   node scripts/i18n-gaps.mjs --from gaps.json --write
 *
 * `--write` appends the missing keys with empty values to zh-CN.skeleton.json
 * so the next translation pass sees them.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DICT = path.join(ROOT, "src", "lib", "i18n", "zh-CN.json");
const SKELETON = path.join(ROOT, "src", "lib", "i18n", "zh-CN.skeleton.json");

const args = process.argv.slice(2);
const fromIndex = args.indexOf("--from");
const write = args.includes("--write");
if (fromIndex === -1) {
  console.error("usage: node scripts/i18n-gaps.mjs --from <gaps.json> [--write]");
  process.exit(1);
}

const collected = JSON.parse(fs.readFileSync(path.resolve(args[fromIndex + 1]), "utf8"));
const strings = Array.isArray(collected) ? collected : collected.strings ?? [];

const dictionary = JSON.parse(fs.readFileSync(DICT, "utf8"));
const normalise = (text) => text.replace(/\s+/g, " ").trim();

const missing = [...new Set(strings.map(normalise))]
  .filter((text) => text.length > 1 && /[A-Za-z]/.test(text))
  .filter((text) => !(text in dictionary));

console.log(`collected: ${strings.length}   unique: ${new Set(strings).size}   missing: ${missing.length}`);
console.log(missing.join("\n"));

if (write && missing.length) {
  const skeleton = JSON.parse(fs.readFileSync(SKELETON, "utf8"));
  for (const key of missing) {
    if (!(key in skeleton.strings)) skeleton.strings[key] = "";
  }
  const sorted = Object.fromEntries(
    Object.entries(skeleton.strings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  skeleton.strings = sorted;
  fs.writeFileSync(SKELETON, `${JSON.stringify(skeleton, null, 2)}\n`);
  console.log(`\nappended ${missing.length} keys to ${path.relative(ROOT, SKELETON)}`);
}
