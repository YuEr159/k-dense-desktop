#!/usr/bin/env node
/**
 * Harvest the human-readable UI strings in the web tree into a JSON skeleton.
 *
 * This is a *discovery* tool, not a build step: it parses each `.tsx` with the
 * TypeScript compiler API and keeps only the places copy actually lives — JSX
 * text nodes, a whitelist of display attributes, and `label` / `title` /
 * `description` keys in object literals. Regex scanning pulls in half the
 * source; the AST does not.
 *
 * **Pure static text only.** A JSX text node that sits beside a `{expression}`
 * is a sentence fragment (`There are {n} files` is three child nodes: "There
 * are ", a value, " files"). React renders them separately, so the runtime
 * translator can only ever see one fragment at a time — and translating
 * "There are " alone produces broken Chinese. Fragments are therefore dropped,
 * both here and at runtime, and those sentences stay English until someone
 * wraps them by hand. That is the right trade: a wrong translation is worse
 * than an untranslated string.
 *
 * Output has empty translations. Fill them in, then `build-dictionary.mjs`
 * strips the empties into the shipped dictionary.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

/**
 * Attributes React renders as visible or assistive text.
 *
 * The first four are DOM attributes. The rest are props of Kady's own
 * components (`<SettingsHeader description=… />`) that end up as text in the
 * DOM just the same — without them, half the settings copy is invisible to
 * this harvester and reaches the user in English.
 */
const DISPLAY_ATTRIBUTES = new Set([
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "description",
  "subtitle",
  "hint",
  "helperText",
  "emptyMessage",
  "tooltip",
]);

/** Object-literal keys that conventionally hold UI copy. */
const COPY_KEYS = new Set([
  "label",
  "title",
  "description",
  "hint",
  "placeholder",
  "detail",
  "subtitle",
  "emptyText",
  "emptyMessage",
  "helperText",
  "tooltip",
  "confirmLabel",
  "cancelLabel",
  // Settings panels map a scope to its one-line note (`appliesTo.immediately`).
  "immediately",
  "live-chats",
  "next-turn",
]);

/**
 * JSX renders these entities as the character, so the DOM contains the decoded
 * form and a key holding `&apos;` would never match. Decode the common ones.
 */
function decodeEntities(text) {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Babel's `cleanJSXElementLiteralChild`, which is what the browser renders. */
function cleanJsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = index;
  });

  let out = "";
  lines.forEach((line, index) => {
    const isFirst = index === 0;
    const isLast = index === lines.length - 1;
    const isLastNonEmpty = index === lastNonEmpty;

    let trimmed = line.replace(/\t/g, " ");
    if (!isFirst) trimmed = trimmed.replace(/^ +/, "");
    if (!isLast) trimmed = trimmed.replace(/ +$/, "");
    if (!trimmed) return;
    if (!isLastNonEmpty) trimmed += " ";
    out += trimmed;
  });
  return out;
}

/** Attributes whose expressions hold styling or wiring, never copy. */
const NON_COPY_ATTRIBUTES = new Set([
  "className",
  "class",
  "style",
  "id",
  "key",
  "ref",
  "href",
  "src",
  "srcSet",
  "type",
  "name",
  "value",
  "defaultValue",
  "onClick",
  "onChange",
  "onKeyDown",
  "onSubmit",
  "variant",
  "size",
  "asChild",
  "role",
  "data-testid",
]);

/**
 * Reject anything structural rather than prose. These run after the AST has
 * narrowed candidates to text positions, so they only catch code that happens
 * to sit in one.
 *
 * `allowBareWord` is set for string literals in *any* expression position
 * inside JSX (`{status === "checking" ? "checking…" : "disconnected"}`), where
 * a lone lowercase word is real copy. Everywhere else a bare lowercase word is
 * far more likely to be a key, an id, or a CSS value.
 */

/** Office/preview font pickers list real font names; those are data. */
const FONT_NAMES = new Set([
  "Arial", "Calibri", "Cambria", "Carlito", "Corsiva", "Garamond", "Georgia",
  "Helvetica", "Palatino", "Tahoma", "Times", "Verdana", "Liberation",
  "Symbol", "Wingdings", "Courier", "Monospace", "Serif", "Sans",
]);

/** KeyboardEvent.key values that appear in switch/case comparisons. */
const KEY_NAMES = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete",
  "Enter", "Escape", "Home", "End", "PageUp", "PageDown", "Tab", "Space",
]);

function looksLikeUiCopy(value, { allowBareWord = false } = {}) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 200) return false;
  if (!/[A-Za-z]/.test(text)) return false;

  // Bare identifiers and dotted paths read as code, not copy.
  if (/^[a-z][A-Za-z0-9]*$/.test(text)) return false;
  if (/^[A-Za-z0-9_$]+(\.[A-Za-z0-9_$]+)+$/.test(text)) return false;

  // URLs, file paths, env vars, template expressions.
  if (/^(https?:|\/|\.\/|#|@|\$\{)/.test(text)) return false;
  if (/\.[a-z]{2,4}\b/i.test(text) && !/\s/.test(text) && text.includes("/")) return false;
  if (/^[A-Z_]{3,}$/.test(text)) return false;
  if (/^(X-|Content-|Access-Control-)/.test(text)) return false;
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(text)) return false;
  if (!allowBareWord && /^[a-z]+$/.test(text)) return false;

  // Command lines and JSON snippets shown as examples must survive verbatim.
  if (/^(--|\$ |npx |npm |pip |uv |git |docker |curl )/.test(text)) return false;
  if (/{.*}/.test(text) && !/\s[a-z]+\s/.test(text)) return false;

  // Things that are data, not copy. These reached the harvester through the
  // JSX-expression path, which sees every string literal in a render
  // expression — including font lists, keystroke names and numeric formatting.
  if (FONT_NAMES.has(text)) return false;
  if (KEY_NAMES.has(text)) return false;
  if (/^[\d.%\s]+(center|left|right|top|bottom)?$/i.test(text)) return false;
  if (/^\d+(\.\d+)?(s|ms|px|%|MB|GB|KiB|MiB|GiB)$/.test(text)) return false;
  if (/^[A-Za-z]$/.test(text)) return false;

  // A fragment that starts with closing punctuation is the tail of a sentence
  // an expression split; it cannot be translated on its own.
  if (/^[),.;:\-–—]/.test(text)) return false;

  return true;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Collect every copy candidate in one file. */
function harvestFile(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];

  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const children = node.children ?? [];
      const hasExpression = children.some(
        (child) => ts.isJsxExpression(child) && child.expression,
      );
      const textChildren = children.filter((child) => ts.isJsxText(child));
      const nonEmpty = textChildren.filter((child) => cleanJsxText(source.slice(child.pos, child.end)).trim());

      // One text child and nothing dynamic: the element's entire visible
      // content is a fixed string, so a replacement cannot break a sentence.
      if (!hasExpression && nonEmpty.length === 1) {
        const child = nonEmpty[0];
        const text = decodeEntities(
          cleanJsxText(source.slice(child.pos, child.end)),
        ).replace(/\s+/g, " ").trim();
        if (text) {
          found.push({
            text,
            line: sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1,
          });
        }
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (DISPLAY_ATTRIBUTES.has(name) && node.initializer && ts.isStringLiteral(node.initializer)) {
        found.push({
          text: decodeEntities(node.initializer.text),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          insideJsx: true,
        });
      }
    } else if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(sf).replace(/^["']|["']$/g, "");
      if (COPY_KEYS.has(key) && ts.isStringLiteralLike(node.initializer)) {
        found.push({
          text: decodeEntities(node.initializer.text),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          insideJsx: true,
        });
      }
    }

    // A literal rendered by a ternary or logical expression
    // (`{ok ? "Done" : "disconnected"}`) is copy too, and the JSX-text path
    // above deliberately skips the whole element because it mixes text and
    // expressions. Collect those literals; they reach the DOM as their own
    // text node, so the runtime layer can replace them individually.
    //
    // Not inside a class/style-ish attribute: `className={cn(active && "bg-muted")}`
    // is the single largest source of false positives here.
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      !(ts.isJsxAttribute(node.parent) && NON_COPY_ATTRIBUTES.has(node.parent.name.getText(sf)))
    ) {
      const collectLiteral = (child) => {
        if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
          found.push({
            text: decodeEntities(child.text),
            line: sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1,
            insideJsx: true,
          });
          return;
        }
        // Stop at nested JSX: its own text is handled above.
        if (ts.isJsxElement(child) || ts.isJsxFragment(child) || ts.isJsxSelfClosingElement(child)) {
          return;
        }
        ts.forEachChild(child, collectLiteral);
      };
      collectLiteral(node.expression);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found.filter((entry) =>
    looksLikeUiCopy(entry.text, { allowBareWord: entry.insideJsx === true }),
  );
}

const files = walk(SRC);
/** @type {Map<string, Set<string>>} */
const byFile = new Map();

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  for (const entry of harvestFile(file, source)) {
    const key = entry.text.replace(/\s+/g, " ").trim();
    if (!byFile.has(rel)) byFile.set(rel, new Set());
    byFile.get(rel).add(key);
  }
}

const all = new Set();
for (const keys of byFile.values()) for (const key of keys) all.add(key);

const skeleton = {
  "$comment":
    "Generated by scripts/harvest-strings.mjs. Keys are the English source text and must stay " +
    "verbatim; values are Simplified Chinese. A key with an empty value is not shipped.",
  strings: Object.fromEntries([...all].sort().map((key) => [key, ""])),
};

const outPath = path.join(ROOT, "src", "lib", "i18n", "zh-CN.skeleton.json");
fs.writeFileSync(outPath, `${JSON.stringify(skeleton, null, 2)}\n`);

const perFile = [...byFile.entries()]
  .map(([file, keys]) => `${String(keys.size).padStart(4)} ${file}`)
  .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));

console.log(`scanned ${files.length} .tsx files`);
console.log(`unique candidates: ${all.size}`);
console.log(`written: ${path.relative(ROOT, outPath)}`);
console.log("\ntop files by candidate count:");
console.log(perFile.slice(0, 20).join("\n"));
