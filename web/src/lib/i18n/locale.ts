"use client";

/**
 * Locale selection for the runtime translation layer.
 *
 * The choice lives in `localStorage` rather than the backend: it is a
 * per-browser display preference, and the backend has no locale concept — it
 * returns English `detail` strings regardless. A `kady:locale` change event
 * keeps every mounted consumer in sync without a page reload.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

export type Locale = "en" | "zh-CN";

export const LOCALES: { id: Locale; label: string; native: string }[] = [
  { id: "zh-CN", label: "Simplified Chinese", native: "简体中文" },
  { id: "en", label: "English", native: "English" },
];

const STORAGE_KEY = "kady:locale";
const EVENT = "kady:locale";

/**
 * Set just before a language switch reloads the page.
 *
 * The app deliberately starts on the project overview after a refresh. The
 * reload in `writeLocale` is not a refresh the user asked for — it is how the
 * switch takes effect — so it carries this marker to ask the shell to reopen
 * the project it was showing.
 */
const RESTORE_SCREEN_KEY = "kady:locale:restore-screen";

/** Chinese when the browser prefers it, since that is the shipped dictionary. */
export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "zh-CN";
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((lang) => /^zh/i.test(lang)) ? "zh-CN" : "en";
}

export function readLocale(): Locale {
  if (typeof localStorage === "undefined") return detectLocale();
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {
    // Private mode or a blocked storage partition: fall back to the browser.
  }
  return detectLocale();
}

export function writeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
    // Read once and cleared by the shell on the next mount, so it can only
    // ever affect the reload this call is about to trigger.
    localStorage.setItem(RESTORE_SCREEN_KEY, "1");
  } catch {
    // A failed write only means the choice does not survive a reload.
  }
  // The runtime layer rewrites DOM nodes in place, and React owns some of
  // them: a node it is not currently re-rendering would keep the old language
  // until it next updates. Reload so every screen is built from scratch. Chat
  // history, drafts and settings all live server-side or in localStorage, so
  // nothing the user cares about is lost.
  if (typeof location !== "undefined") location.reload();
}

/**
 * Whether the page is loading because the language changed, clearing the
 * marker so exactly one load sees it.
 *
 * Deliberately one-shot: a plain refresh, a new browser tab or a restart all
 * keep the app's normal "start on the overview" behaviour.
 */
export function consumeScreenRestoreRequest(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    if (localStorage.getItem(RESTORE_SCREEN_KEY) !== "1") return false;
    localStorage.removeItem(RESTORE_SCREEN_KEY);
    return true;
  } catch {
    return false;
  }
}


/** Subscribe to the shared locale, with instant updates across components. */
export function useLocale(): [Locale, (next: Locale) => void] {
  const [locale, setLocale] = useState<Locale>(() =>
    typeof window === "undefined" ? "zh-CN" : readLocale(),
  );

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<Locale>).detail;
      setLocale(detail ?? readLocale());
    };
    window.addEventListener(EVENT, onChange);
    // Another tab changed it: adopt that choice so both agree.
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setLocale(readLocale());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const set = useCallback((next: Locale) => {
    writeLocale(next);
    setLocale(next);
  }, []);

  return useMemo(() => [locale, set], [locale, set]);
}
