/**
 * Chinese UI translation layer.
 *
 * Design constraint: upstream (`K-Dense-AI/k-dense-byok`) owns this tree, and
 * we merge it regularly. Every `t("...")` we wrap inside a component is a line
 * upstream may also touch, so a source-level i18n framework buys us a merge
 * conflict per translated string per upstream edit to that file.
 *
 * This layer instead rewrites text *at runtime*, after React has rendered. The
 * dictionary is the only file we own, so upstream merges never conflict with
 * it, and a string upstream renamed simply falls back to its English original
 * until someone adds a new entry — a visible, harmless degradation.
 *
 * Scope is deliberately bounded:
 *   - Text nodes and `placeholder` / `title` / `aria-label` attributes only.
 *     `value`, `content`, `href` and the rest are never touched (rewriting an
 *     input value would corrupt user data).
 *   - Code inside `pre`, `code`, `kbd`, `script`, `style` and any element
 *     marked `data-no-translate` is skipped. Scientific output, file paths and
 *     command lines must stay byte-identical.
 *   - Assistant/user chat bubbles are skipped via `data-no-translate` on the
 *     message container: a model that writes "File" in a sentence about a
 *     protein must not have it replaced.
 *
 * Matching is exact-after-normalisation (trimmed, whitespace collapsed), which
 * keeps the dictionary honest — a key that is no longer produced anywhere is
 * dead weight rather than a silent partial match.
 */

/** Locales this layer can render. Only `zh-CN` ships today. */
export type Locale = "en" | "zh-CN";

export const DEFAULT_LOCALE: Locale = "zh-CN";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "PRE",
  "CODE",
  "KBD",
  "SAMP",
  "VAR",
  "TEXTAREA",
]);

const TRANSLATABLE_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"] as const;

/** Elements under which no rewriting happens at all. */
const SKIP_SELECTOR = "[data-no-translate]";

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A dictionary entry. Strings with `{0}`, `{1}`… are interpolated from the
 * rendered node's text via the `pattern` source built at load time.
 */
export type Dictionary = Record<string, string>;

/**
 * Build a matcher for one dictionary. Entries are tried longest-first so
 * `"New project"` wins over `"New"` when both exist.
 *
 * Entries may contain `{n}` placeholders, which match one non-greedy run of
 * any characters. This covers the common React pattern
 * `{count} chats are still working` without any component changes.
 */
export function buildMatcher(dictionary: Dictionary): {
  exact: Map<string, string>;
  patterns: { regex: RegExp; keys: string[]; value: string }[];
} {
  const exact = new Map<string, string>();
  const patterns: { regex: RegExp; keys: string[]; value: string }[] = [];

  for (const [key, value] of Object.entries(dictionary)) {
    const source = normalise(key);
    if (!source) continue;
    if (/\{\d+\}/.test(source)) {
      const keys: string[] = [];
      // `{n}` matches one non-greedy run. The regex is anchored, so a template
      // only ever matches the complete rendered string — a partial match would
      // rewrite a fragment of a sentence.
      const escaped = source
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\{\s*(\d+)\s*\\\}/g, (_, n: string) => {
          keys.push(`{${n}}`);
          return "(.+?)";
        });
      patterns.push({
        regex: new RegExp(`^${escaped}$`),
        keys,
        value,
      });
    } else {
      exact.set(source, value);
    }
  }

  patterns.sort((a, b) => b.regex.source.length - a.regex.source.length);
  return { exact, patterns };
}

/**
 * Translate one string, returning the input unchanged when nothing matches.
 *
 * A `pattern` entry substitutes its captures into `{0}`, `{1}`… in the
 * translation, so word order in Chinese need not mirror English.
 */
export function translateText(
  matcher: ReturnType<typeof buildMatcher>,
  text: string,
): string {
  const normalised = normalise(text);
  if (!normalised) return text;

  const exact = matcher.exact.get(normalised);
  if (exact !== undefined) {
    // Preserve the original surrounding whitespace: React renders it, and
    // dropping it can collapse inline spacing between sibling spans.
    return text.replace(normalised, exact);
  }

  for (const entry of matcher.patterns) {
    const match = entry.regex.exec(normalised);
    if (!match) continue;
    const filled = entry.value.replace(/\{(\d+)\}/g, (whole, n: string) => {
      const index = entry.keys.indexOf(`{${n}}`);
      return index >= 0 ? (match[index + 1] ?? whole) : whole;
    });
    return text.replace(normalised, filled);
  }
  return text;
}

/**
 * Walk a subtree and collect the text rewrites it would make (attributes are
 * rewritten in place).
 *
 * Returning the plan lets the caller remember each node's original text, so a
 * switch back to English can restore it without a page reload, and keeps the
 * text half pure enough to unit test.
 *
 * The TreeWalker's filter does the skipping: `FILTER_REJECT` drops an element
 * and its whole subtree. The root itself is still collected when its tag skips
 * children, because a text field's own `placeholder` is exactly the kind of
 * copy this layer exists to localise.
 */
export function translateSubtree(
  root: Node,
  matcher: ReturnType<typeof buildMatcher>,
  shouldSkip: (node: Node) => boolean,
): { node: Text; text: string }[] {
  if (shouldSkip(root)) return [];

  // A node added inside an already-skipped region arrives with the marker on
  // an ancestor, not on itself, so the ancestor chain has to be checked.
  const anchor = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : root.parentElement;
  if (anchor?.closest(SKIP_SELECTOR)) return [];

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
        const element = node as Element;
        if (SKIP_TAGS.has(element.tagName)) return NodeFilter.FILTER_REJECT;
        if (element.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  const textNodes: Text[] = [];
  const elements: Element[] = [];
  // The root is a legitimate translation target even when its tag is skipped
  // for children — see the doc comment.
  if (root.nodeType === Node.ELEMENT_NODE) elements.push(root as Element);

  let node: Node | null = walker.currentNode;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE && node !== root) elements.push(node as Element);
    else if (node.nodeType === Node.TEXT_NODE) textNodes.push(node as Text);
    node = walker.nextNode();
  }

  /**
   * Text nodes that were merged into their element's single replacement.
   * Handled per-element below; matching them individually would only ever see
   * fragments.
   */
  const merged = new Set<Text>();
  const plan: { node: Text; text: string }[] = [];

  for (const element of elements) {
    // React renders `{price} in / {qty} out per 1M tok` as several sibling
    // text nodes — one per interpolation — so no single node ever holds the
    // sentence a `{0}` template describes. When an element's visible content is
    // entirely text, try the whole string and replace the run in place.
    //
    // Inline markup is flattened for the *match* but preserved on replacement:
    // `keys from your <kbd>.env</kbd> file and run on your machine` must match
    // as one sentence, and the `<kbd>` must survive so the filename keeps its
    // styling.
    const parts = [...element.childNodes];
    if (parts.length < 2) continue;

    const inline = flattenInline(element);
    if (!inline) continue;

    const translated = translateText(matcher, inline.text);
    if (translated === inline.text) continue;

    const rebuilt = rebuildPreservingInline(element, inline, translated);
    if (rebuilt) continue;

    // No inline markup: collapse the pure-text run into one node. React
    // re-renders from its own model on the next update, restoring the parts.
    if (!inline.hasMarkup) {
      for (const child of parts) merged.add(child as Text);
      element.textContent = translated;
    }
  }

  for (const textNode of textNodes) {
    if (merged.has(textNode)) continue;
    const original = textNode.nodeValue ?? "";
    const translated = translateText(matcher, original);
    if (translated !== original) plan.push({ node: textNode, text: translated });
  }

  for (const element of elements) {
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const translated = translateText(matcher, value);
      if (translated !== value) element.setAttribute(attribute, translated);
    }
  }

  return plan;
}

/** Tags that read as part of the surrounding sentence, not as a block break. */
const INLINE_TAGS = new Set(["KBD", "CODE", "STRONG", "EM", "B", "I", "U", "S", "SPAN", "A", "MARK", "SMALL", "SUP", "SUB"]);

/**
 * Flatten an element's inline content into one string for matching.
 *
 * Returns `null` when the element contains anything that is not text or inline
 * markup — a block child (`<div>`, `<ul>`) is a different sentence, and joining
 * across it would match one sentence against two.
 *
 * Each inline element is recorded so a replacement can put it back. The
 * dictionary key carries a `{n}` where each inline element sat, which lets the
 * translation move them (Chinese word order often puts the filename first).
 */
function flattenInline(element: Element): {
  text: string;
  hasMarkup: boolean;
  inline: { index: number; node: Element; text: string }[];
} | null {
  const inline: { index: number; node: Element; text: string }[] = [];
  let text = "";

  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue ?? "";
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    if (!INLINE_TAGS.has(el.tagName)) return false;
    // Skip what the layer must not read through, e.g. a `<code>` holding a
    // command: it is still part of the sentence visually, so keep it as
    // placeholder text rather than refusing the whole element.
    if (SKIP_TAGS.has(el.tagName) || el.matches(SKIP_SELECTOR)) {
      text += `{${inline.length}}`;
      inline.push({ index: inline.length, node: el, text: el.textContent ?? "" });
      return true;
    }
    text += `{${inline.length}}`;
    inline.push({ index: inline.length, node: el, text: el.textContent ?? "" });
    return true;
  };

  for (const child of element.childNodes) {
    if (!visit(child)) return null;
  }
  return { text, hasMarkup: inline.length > 0, inline };
}

/**
 * Write a translation back, re-inserting the inline elements where the
 * translation's `{n}` placeholders put them.
 *
 * Returns true when it handled the element. Anything the translation mentions
 * that no longer has a source element is dropped rather than left as a raw
 * `{0}` on screen.
 */
function rebuildPreservingInline(
  element: Element,
  flattened: {
    text: string;
    hasMarkup: boolean;
    inline: { index: number; node: Element; text: string }[];
  },
  translated: string,
): boolean {
  if (!flattened.hasMarkup) return false;

  const nodes: Node[] = [];
  let cursor = 0;
  const pattern = /\{(\d+)\}/g;
  let match: RegExpExecArray | null = pattern.exec(translated);
  while (match) {
    if (match.index > cursor) {
      nodes.push(document.createTextNode(translated.slice(cursor, match.index)));
    }
    const source = flattened.inline.find((entry) => entry.index === Number(match![1]));
    if (source) nodes.push(source.node);
    cursor = match.index + match[0].length;
    match = pattern.exec(translated);
  }
  if (cursor < translated.length) {
    nodes.push(document.createTextNode(translated.slice(cursor)));
  }

  element.replaceChildren(...nodes);
  return true;
}

/** Match the browser's language preference against what we ship. */
export function detectLocaleFromNavigator(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((lang) => /^zh/i.test(lang)) ? "zh-CN" : DEFAULT_LOCALE;
}
