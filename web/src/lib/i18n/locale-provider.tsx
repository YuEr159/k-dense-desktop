"use client";

/**
 * Mounts the runtime translation layer.
 *
 * The layering choice is deliberate (see lib/i18n/runtime-translate.ts): the
 * upstream tree is the source of truth and we merge it regularly, so every
 * `t()` wrapped inside a component is a line upstream can also touch. Instead
 * this mounts one observer over the document and rewrites plain text nodes.
 * Nothing below `data-no-translate` is touched.
 *
 * Changing the language reloads the page. Undoing a rewrite node by node was
 * tried first and is subtly wrong: React owns these nodes, so any node it is
 * not currently re-rendering keeps the old language until it next updates —
 * a half-translated screen that looks like a bug. Remounting the tree would be
 * correct but drops every open dialog and chat state. A reload gets both right
 * and costs one page load, on an action a user takes rarely.
 */

import { useEffect } from "react";
import zhCN from "./zh-CN.json";
import { useLocale, type Locale } from "./locale";
import { buildMatcher, translateSubtree, type Dictionary } from "./runtime-translate";

const DICTIONARIES: Partial<Record<Locale, Dictionary>> = {
  "zh-CN": zhCN as Dictionary,
};

/** Elements that never contain translatable UI copy but produce many mutations. */
const IGNORED_ROOTS = new Set(["SCRIPT", "STYLE", "HEAD", "LINK", "META"]);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale] = useLocale();

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;

    const dictionary = DICTIONARIES[locale];
    if (!dictionary) return;

    const matcher = buildMatcher(dictionary);
    const shouldSkip = (node: Node) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (!element) return false;
      return IGNORED_ROOTS.has(element.tagName);
    };

    /** True while this layer is writing, so the observer can ignore itself. */
    let writing = false;
    const apply = (root: Node) => {
      writing = true;
      try {
        for (const { node, text } of translateSubtree(root, matcher, shouldSkip)) {
          node.nodeValue = text;
        }
      } finally {
        writing = false;
      }
    };

    apply(document.body);

    const observer = new MutationObserver((records) => {
      if (writing) return;
      for (const record of records) {
        if (record.type === "characterData") {
          if (record.target.parentElement) apply(record.target.parentElement);
          continue;
        }
        for (const node of record.addedNodes) {
          // Defer: translating inside the callback mutates the DOM React is
          // still assembling, and React would then see its own text changed.
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            queueMicrotask(() => apply(node));
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [locale]);

  return <>{children}</>;
}
