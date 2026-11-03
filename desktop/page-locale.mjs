/**
 * Which language the shell should speak.
 *
 * The page keeps its language in `localStorage["kady:locale"]`, and that
 * choice — not the operating system's — is what the user actually sees. A
 * shell reading `app.getLocale()` therefore disagreed with the interface
 * whenever someone picked English on a Chinese system, or the reverse: a
 * Chinese splash over an English app.
 *
 * A renderer's localStorage belongs to its origin, so the main process cannot
 * read it directly. The two honest options were a copy of the choice in
 * `shell.json` (two sources that can drift) or asking the renderer that
 * already owns it. This is the second: a hidden window on the same origin
 * runs one expression and goes away.
 *
 * The load is offline-capable on purpose. `data:` and `about:blank` give a
 * window a usable localStorage without a network round trip, and the origin
 * the UI uses is only needed for persistence across launches — so the probe
 * can answer before the backend has finished starting.
 *
 * The `electron` import is deferred to the two functions that need it. ESM
 * resolves every static import before running anything, so a top-level import
 * here would make this module unloadable outside Electron — and the decision
 * this file encodes (what counts as a stored choice, what the fallback is) is
 * exactly the part worth testing without a display.
 */
const STORAGE_KEY = "kady:locale";
const PROBE_TIMEOUT_MS = 4000;

/** The two values the page's `Locale` type allows. */
export function normaliseLocale(value) {
  return value === "en" || value === "zh-CN" ? value : null;
}

/**
 * Read the page's language choice.
 *
 * @param {string} origin  the UI origin whose localStorage holds it
 * @returns {Promise<"en"|"zh-CN"|null>} null when there is no stored choice yet
 */
export async function readPageLocale(origin) {
  const { BrowserWindow } = await import("electron");
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      // Same isolation posture as the real window; this only evaluates a
      // string, but nothing about it needs to be weaker.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No `partition`: the real window uses the default session, and a
      // window with its own partition would see an empty localStorage.
    },
  });

  try {
    // Loading the origin itself is what binds the window to that origin's
    // storage. It fails while the frontend is still starting, and that is
    // fine: the expression below still runs, and reports "no choice yet".
    await Promise.race([
      probe.loadURL(origin).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS)),
    ]);
    const value = await probe.webContents.executeJavaScript(
      `(() => { try { return localStorage.getItem(${JSON.stringify(STORAGE_KEY)}); }
                catch { return null; } })()`,
      true,
    );
    return normaliseLocale(value);
  } catch {
    return null;
  } finally {
    if (!probe.isDestroyed()) probe.destroy();
  }
}

/**
 * The language to use before the page has been consulted.
 *
 * Only reached on the very first launch, or when the probe could not run.
 * `app.getLocale()` is the best signal available then — it is the system
 * language, which is also what the page's own `detectLocale()` falls back to.
 */
/**
 * The language to use before the page has been consulted.
 *
 * Only reached on the very first launch, or when the probe could not run.
 * `app.getLocale()` is the best signal available then — the system language,
 * which is also what the page's own `detectLocale()` falls back to.
 *
 * @param {string} systemLocale  `app.getLocale()`, passed in so this stays
 *   testable without Electron
 */
export function fallbackLocale(systemLocale) {
  return /^zh/i.test(systemLocale ?? "") ? "zh-CN" : "en";
}
