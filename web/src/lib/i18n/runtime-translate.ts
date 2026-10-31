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
    const parts = [...element.childNodes];
    if (parts.length < 2) continue;
    if (parts.some((child) => child.nodeType !== Node.TEXT_NODE)) continue;

    const whole = parts.map((child) => child.nodeValue ?? "").join("");
    const translated = translateText(matcher, whole);
    if (translated === whole) continue;

    // Collapse the run into a single node. React re-renders the element from
    // its own model on the next update, which restores the separate nodes.
    for (const child of parts) merged.add(child as Text);
    element.textContent = translated;
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

/** Match the browser's language preference against what we ship. */
export function detectLocaleFromNavigator(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((lang) => /^zh/i.test(lang)) ? "zh-CN" : DEFAULT_LOCALE;
}
