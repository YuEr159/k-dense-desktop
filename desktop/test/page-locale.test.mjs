/**
 * Which language the shell should speak.
 *
 * The rule that matters: the interface's own choice wins over the operating
 * system's. Everything user-visible outside the page — the splash, menus, the
 * tray, dialogs, notifications — used to read `app.getLocale()`, so someone
 * running an English interface on a Chinese system saw a Chinese splash over
 * an English app.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fallbackLocale, normaliseLocale } from "../page-locale.mjs";

test("a stored choice is accepted only in the two forms the page writes", () => {
  assert.equal(normaliseLocale("zh-CN"), "zh-CN");
  assert.equal(normaliseLocale("en"), "en");
});

test("anything else reads as 'no choice yet' rather than a bad language", () => {
  // The probe returns whatever the page stored, including null on a first
  // launch and a stale value from an older build. Treating those as a choice
  // would leave the shell stuck in a language the app no longer speaks.
  for (const value of [null, undefined, "", "zh", "zh-CN ", "EN", "en-US", 0, false, {}]) {
    assert.equal(normaliseLocale(value), null, `value=${JSON.stringify(value)}`);
  }
});

test("the system locale is the fallback, matched the way the page matches it", () => {
  // Same rule as `detectLocale()` in web/src/lib/i18n/locale.ts: a `zh`
  // prefix means Chinese.
  for (const locale of ["zh-CN", "zh-TW", "zh", "zh-Hans-CN"]) {
    assert.equal(fallbackLocale(locale), "zh-CN", `locale=${locale}`);
  }
  for (const locale of ["en-US", "de", "fr-FR", "ja-JP", "", null, undefined]) {
    assert.equal(fallbackLocale(locale), "en", `locale=${locale}`);
  }
});
