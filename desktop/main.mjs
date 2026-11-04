/**
 * Stage-0 desktop shell for K-Dense BYOK.
 *
 * Reuses the existing launch contract instead of reimplementing it: the
 * backend runs through tsx and the frontend through `next start`, both bound
 * to the ports the current web build was compiled against (3000/8000).
 *
 * The window points at the local frontend origin. Everything else — SSE
 * streaming, file previews, the Office iframe — keeps working because the
 * renderer is a real Chromium page talking to the same origins the browser
 * build expects.
 */
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  BACKEND_URL,
  UI_URL,
  packagedArtifacts,
  setFatalHandler,
  setServiceLogSink,
  startServices,
  stopServices,
} from "./service-manager.mjs";
import { checkRuntime } from "./preflight.mjs";
import { runtimeEnvironment } from "./runtime-env.mjs";
import { appName, currentLanguage, setLanguageFromLocale, t } from "./shell-i18n.mjs";
import { captureConsole, logPath, logsDirectory, logServiceLine, openLog, write as logLine } from "./shell-log.mjs";
import { fallbackLocale, readPageLocale } from "./page-locale.mjs";
import { pollUntilReady } from "./startup-readiness.mjs";
import { restoreWindowState as restoreSavedWindowState, windowStateToSave } from "./window-state.mjs";

const isDev = !app.isPackaged;

// The product name feeds every dialog, menu item and notification below, so it
// is resolved once. `app.getLocale()` reports the system language, which is the
// only signal available before the page loads.
app.setName("Kady");
if (process.env.KADY_DESKTOP_USER_DATA) {
  const userData = path.resolve(process.env.KADY_DESKTOP_USER_DATA);
  fs.mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

/** Keep one window; re-focusing the dock/taskbar icon should not spawn more. */
let mainWindow = null;
let tray = null;
let quitting = false;
/** Pending debounced write of the window rectangle (see scheduleWindowStateSave). */
let windowStateTimer = null;
/** Set once startServices() has been called; services outlive any one window. */
let servicesStarted = false;

/**
 * Writable state lives outside the install directory: a packaged app under
 * Program Files cannot write its own `.env`, and projects must survive an
 * upgrade. Electron gives us the right per-user location per platform.
 */
function dataRoot() {
  return process.env.KADY_DATA_ROOT ? path.resolve(process.env.KADY_DATA_ROOT) : path.join(app.getPath("userData"), "data");
}

/**
 * Shell preferences, kept beside the backend's own settings rather than in
 * Electron's userData root so `%APPDATA%/Kady/data` stays the one directory a
 * user has to back up.
 */
function shellSettingsPath() {
  return path.join(dataRoot(), "shell.json");
}

function readShellSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(shellSettingsPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * The window rectangle to reopen with, or null to use the default.
 *
 * Restoring a saved rectangle is only safe if a display still shows part of
 * it: a laptop undocked from a 4K monitor would otherwise reopen a window
 * entirely off-screen, which reads as "the app opened nothing". Intersection
 * with the display's work area is the test, not containment — a window
 * deliberately hanging off an edge should survive.
 *
 * Minimized and maximized are handled separately: `getNormalBounds()` gives
 * the restore size, so a maximized window comes back maximized at the same
 * size it would un-maximize to.
 */
function restoreWindowState() {
  return restoreSavedWindowState(
    readShellSettings().windowState,
    screen.getAllDisplays().map((display) => display.workArea),
  );
}

/** Remember the rectangle and maximized state for the next launch. */
function saveWindowState(window) {
  if (!window || window.isDestroyed()) return;
  try {
    const next = windowStateToSave({
      normalBounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    });
    if (next) writeShellSetting("windowState", next);
  } catch {
    // Losing the saved rectangle is cosmetic; never fail a close over it.
  }
}

/**
 * `saveWindowState` on a trailing edge.
 *
 * Every resize and move fires while the user is still dragging — on Windows a
 * resize fires per pixel. Writing `shell.json` each time would rewrite the
 * whole file dozens of times a second from the event loop that is also
 * compositing the drag. Half a second after the last event is soon enough for
 * a crash to lose at most the final adjustment.
 */
function scheduleWindowStateSave(window) {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    saveWindowState(window);
  }, 500);
  windowStateTimer.unref?.();
}

/**
 * What closing the window does.
 *
 * `tray` destroys the window and keeps the process alive, which drops a
 * ~750 MB resident app to roughly 300 MB (the renderer is 274 MB of that). It
 * is the default because background work — Modal jobs, schedules — should not
 * stop just because the window was dismissed. `quit` is the classic behaviour
 * and stays available for users who dislike a resident process.
 *
 * The file is also served over /settings/shell (server/src/shell-settings.ts),
 * which is how the Settings UI writes it. Keep the two readers agreeing on the
 * field name and the "tray" default.
 */
function closeAction() {
  const value = readShellSettings().closeAction;
  return value === "quit" ? "quit" : "tray";
}

/** Whether a finished turn should raise a desktop notification. */
function notifySettings() {
  const s = readShellSettings();
  return {
    enabled: s.notifyOnRunComplete === true,
    // Default on: a notification for the chat already on screen is noise.
    onlyWhenUnfocused: s.notifyOnlyWhenUnfocused !== false,
  };
}

/**
 * Watch for turns finishing and tell the user when the app is in the
 * background.
 *
 * The backend already reports which sessions have a run in flight
 * (`/runtime-status`), so completion is the transition from "something
 * running" to "nothing running" — no backend change, and it covers runs this
 * window did not start (scheduled runs, runs in another tab).
 *
 * Polled rather than pushed: there is no renderer-side notification bridge
 * here on purpose (the page is an unmodified sandboxed web app), and this is a
 * 5-second check against a local server, not a network call.
 */
function startRunWatcher() {
  let previous = null;
  let previousSessions = [];
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`${BACKEND_URL}/runtime-status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const body = await res.json();
      const running = Array.isArray(body?.sessions) ? body.sessions : [];
      const count = typeof body?.runningSessions === "number" ? body.runningSessions : running.length;
      // Which chats finished, not just how many. The names are already in the
      // response; dropping them is what made the notification say only
      // "Chat finished" while three tabs were open.
      const finished = previousSessions.filter((s) => !running.some((r) => r.id === s.id));

      if (previous !== null && previous > 0 && count === 0) {
        const { enabled, onlyWhenUnfocused } = notifySettings();
        const focused = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
        signalAttention(focused);
        if (enabled && (!onlyWhenUnfocused || !focused)) {
          raiseRunCompleteNotification(finished.length > 0 ? finished : previousSessions);
        }
      }
      previous = count;
      previousSessions = running;
    } catch {
      // The backend may still be starting or momentarily busy; the next tick
      // retries. Resetting `previous` would make the next completion look like
      // the first observation and get skipped.
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 5000);
  timer.unref?.();
  return timer;
}

/**
 * A taskbar/Dock hint that does not need permission and does not interrupt.
 *
 * `setBadgeCount` is Linux and macOS only — Windows has no badge API at all,
 * so a background completion there is a flashing taskbar button. Both clear
 * themselves when the window is focused, which is the moment the hint has
 * done its job.
 */
function signalAttention(focused) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (focused) {
    try { mainWindow.flashFrame(false); } catch { /* not supported */ }
    try { app.setBadgeCount(0); } catch { /* not supported */ }
    return;
  }
  if (process.platform === "win32") {
    try { mainWindow.flashFrame(true); } catch { /* not supported */ }
  } else {
    // A dot with no number: the point is "look at the app", not a count.
    try { app.setBadgeCount(1); } catch { /* no permission or not supported */ }
  }
}

/** One notification per completion, naming the chats that finished. */
function raiseRunCompleteNotification(finished) {
  if (!Notification.isSupported()) return;
  const name = appName();
  const named = (finished ?? []).map((s) => s?.name).filter(Boolean);
  const count = finished?.length ?? 0;

  let title;
  let body;
  if (count > 1) {
    title = t("notify.many", { count });
    body = named.length > 0
      ? t("notify.bodyManyNamed", { names: summariseNames(named) })
      : t("notify.bodyMany", { app: name });
  } else if (count === 1 && named.length === 1) {
    title = t("notify.oneNamed", { name: named[0] });
    body = t("notify.bodyOneNamed", { name: named[0] });
  } else {
    title = t("notify.one");
    body = t("notify.bodyOne", { app: name });
  }

  const notification = new Notification({ title, body, silent: false });
  // Clicking the balloon should land in the app, not dismiss and do nothing.
  notification.on("click", () => void reopenWindow());
  notification.show();
  logLine("shell", `notification: ${title} — ${body}`);
}

/** "a, b and 3 more" — long enough to be useful, short enough to read. */
function summariseNames(names) {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

function writeShellSetting(key, value) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(shellSettingsPath(), "utf8"));
    if (!current || typeof current !== "object") current = {};
  } catch {
    current = {};
  }
  current[key] = value;
  fs.mkdirSync(path.dirname(shellSettingsPath()), { recursive: true });
  fs.writeFileSync(shellSettingsPath(), `${JSON.stringify(current, null, 2)}\n`);
}

/**
 * Where prebuilt artifacts live. A packaged app keeps them under resources/;
 * KADY_RUNTIME_DIR points a checkout at `desktop/build/runtime` for testing
 * the packaged path without building an installer.
 */
function runtimeArtifacts() {
  if (process.env.KADY_RUNTIME_DIR) {
    // KADY_RUNTIME_DIR names the payload itself (…/build/runtime), while
    // packagedArtifacts expects the parent that contains runtime/ and
    // externals/ side by side.
    const dir = path.resolve(process.env.KADY_RUNTIME_DIR);
    const parent = path.dirname(dir);
    const artifacts = packagedArtifacts(parent);
    if (!artifacts) return {};
    const externals = path.join(parent, "externals");
    return fs.existsSync(externals) ? { ...artifacts, externalsDir: externals } : artifacts;
  }
  return packagedArtifacts(process.resourcesPath) ?? {};
}

/**
 * The application menu.
 *
 * The window is a web app: every feature lives in the page, so the default
 * menu's File/Edit/View items are mostly noise. It still has to exist, though,
 * because Chromium routes its editing accelerators (Ctrl+C/V/X/Z/A) and zoom
 * through menu roles — with no menu at all, Ctrl+V stops working in every text
 * field, which this app is full of.
 *
 * So: a complete role-based menu, hidden from the window. Shortcuts keep
 * working; the menu bar does not take a strip off the top of the app. Alt
 * reveals it, the platform convention on Windows and Linux.
 */
function buildApplicationMenu() {
  const name = appName();
  const quitItem = { label: t("menu.quit", { app: name }), accelerator: "CmdOrCtrl+Q", click: () => void quitApp() };
  // The Help menu is not decoration: the startup-failure dialogs send users
  // here for the log file, so an entry that opens it has to exist. Before this
  // it did not, and the log was never written either.
  const helpItem = {
    label: t("menu.help"),
    submenu: [
      // A packaged app has no terminal. Showing the log in its own window is
      // what makes "it hangs" reportable: the user can read the last lines and
      // copy them without hunting for a hidden folder.
      { label: t("menu.viewLog"), click: () => void showLogWindow() },
      { label: t("menu.openLogs"), click: () => void openLogsFolder() },
      { label: t("menu.openData"), click: () => void shell.openPath(dataRoot()) },
      ...(isDev ? [{ type: "separator" }, { role: "toggleDevTools" }] : []),
    ],
  };
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "services" },
        { type: "separator" }, { role: "hide" }, { role: "hideOthers" },
        { role: "unhide" }, { type: "separator" }, quitItem],
    }] : [{ label: t("menu.file"), submenu: [quitItem] }]),
    {
      label: t("menu.edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: t("menu.window"),
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
    helpItem,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Reveal shell.log. Falls back to opening the folder if the file is missing. */
async function openLogsFolder() {
  const file = logPath();
  if (file && fs.existsSync(file)) {
    shell.showItemInFolder(file);
    return;
  }
  const dir = logsDirectory(dataRoot());
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
}

/** The log in its own window, newest lines last, refreshed while it is open. */
let logWindow = null;

async function showLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return;
  }
  logWindow = new BrowserWindow({
    width: 900,
    height: 640,
    title: t("menu.viewLog"),
    backgroundColor: chromeBackground(),
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  logWindow.once("closed", () => {
    logWindow = null;
  });
  await logWindow.loadURL(logDocumentUrl()).catch(() => {});
}

/**
 * A `data:` document with the last chunk of the log baked in.
 *
 * Reloading the window re-reads the file, which is the whole refresh story:
 * the point is to read what happened before a hang, not to tail it live.
 */
function logDocumentUrl() {
  const file = logPath();
  let text = "";
  try {
    if (file && fs.existsSync(file)) {
      const stat = fs.statSync(file);
      // Tail a bounded window: the interesting part of a failed launch is the
      // end, and a 5 MB log would take a moment to hand to the renderer.
      const start = Math.max(0, stat.size - 256 * 1024);
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        text = buffer.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (error) {
    text = `Could not read the log: ${error instanceof Error ? error.message : String(error)}`;
  }
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = `<!doctype html><meta charset="utf-8">
    <title>${t("menu.viewLog")}</title>
    <body style="margin:0;background:${chromeBackground()};color:#a1a1aa;
                 font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace">
      <div style="position:sticky;top:0;padding:8px 12px;background:${chromeBackground()};
                  border-bottom:1px solid #27272a;color:#a1a1aa">
        ${escaped.length === 0 ? t("log.empty") : t("log.hint", { path: file ?? "" })}
      </div>
      <pre style="margin:0;padding:12px;white-space:pre-wrap;word-break:break-all">${escaped}</pre>
    </body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Which language the shell should speak right now.
 *
 * Reads the page's stored choice, falling back to the system locale only when
 * there is none (first launch) — the same order the page's own `readLocale()`
 * uses, so the two agree on a fresh install as well as after a switch.
 */
async function resolveShellLanguage() {
  const stored = await readPageLocale(UI_URL);
  return stored ?? fallbackLocale(app.getLocale());
}

/** Re-read the page's language, then apply it to everything the shell draws. */
let refreshingLanguage = false;
async function refreshShellLanguage() {
  // `refreshShellLanguage` opens a hidden window, and any window's load events
  // would call this again. Cheap guard rather than reasoning about which
  // events the probe can emit.
  if (refreshingLanguage) return;
  refreshingLanguage = true;
  try {
    const next = await resolveShellLanguage();
    if (next === currentLanguage()) return;
    setLanguageFromLocale(next);
    // The menu and tray hold their labels as strings, so they have to be
    // rebuilt rather than re-rendered.
    buildApplicationMenu();
    if (tray) {
      tray.destroy();
      tray = null;
      createTray();
    }
    logLine("shell", `language -> ${next}`);
  } finally {
    refreshingLanguage = false;
  }
}

/**
 * The colour a window should paint before any page has rendered.
 *
 * The page follows the system theme by default, so a fixed dark background
 * showed black edges on every light-mode launch and again on each resize,
 * before the renderer repaints. Tracking `nativeTheme` costs nothing and is
 * the same signal the page's `prefers-color-scheme` resolves from.
 */
function chromeBackground() {
  return nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#ffffff";
}

/** Apply a theme change to an already-open window. */
function applyThemeToWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setBackgroundColor(chromeBackground());
  } catch {
    // Cosmetic only.
  }
}

function createWindow() {
  const saved = restoreWindowState();
  mainWindow = new BrowserWindow({
    // Defaults unless a previous session left a still-visible rectangle.
    width: saved.bounds?.width ?? 1440,
    height: saved.bounds?.height ?? 900,
    ...(saved.bounds ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    minWidth: 960,
    minHeight: 640,
    backgroundColor: chromeBackground(),
    show: false,
    title: appName(),
    // Hidden, not absent: see buildApplicationMenu. `autoHideMenuBar` also lets
    // Alt reveal it for anyone who wants the reload or devtools entries.
    autoHideMenuBar: true,
    // A packaged build reads the exe's own icon; this is what the taskbar and
    // window switch to during development, when there is no exe icon to embed.
    ...(isDev ? { icon: path.join(import.meta.dirname, "resources", "icon.png") } : {}),
    webPreferences: {
      // The renderer is the unmodified web app: no preload bridge, no Node
      // integration, so it keeps the exact security posture it has in a
      // browser tab.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    if (saved.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // The rectangle is remembered on every adjustment, debounced, and once more
  // on close so the last drag is not lost to the trailing-edge timer.
  for (const event of ["resize", "move", "maximize", "unmaximize"]) {
    mainWindow.on(event, () => scheduleWindowStateSave(mainWindow));
  }
  mainWindow.on("close", () => saveWindowState(mainWindow));

  attachFailureHandling(mainWindow);
  attachContextMenu(mainWindow);

  // Switching languages reloads the page (see web/src/lib/i18n/locale.ts),
  // and the shell's menu and tray are drawn outside it. Re-reading after the
  // reload keeps them in step without polling or a change hook the page would
  // have to call.
  mainWindow.webContents.on("did-finish-load", () => {
    void refreshShellLanguage();
  });

  // Chat content, citations and notebook links open in the user's browser.
  // Everything pointing back at the local UI stays inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  return mainWindow;
}

/**
 * What to show when the page itself dies.
 *
 * Without this the window goes white and stays white: a renderer crash, a
 * navigation to a frontend that stopped listening, or an out-of-memory page
 * all look identical to a user — a frozen app with no way forward. The
 * recovery page is a `data:` document for the same reason the splash is: it
 * has to render when nothing else does.
 */
function failurePageHtml(reason) {
  const name = appName();
  const reload = JSON.stringify(UI_URL);
  return `data:text/html;charset=utf-8,` + encodeURIComponent(
    `<!doctype html><meta charset="utf-8">
     <body style="margin:0;height:100vh;display:grid;place-items:center;
                  background:${chromeBackground()};color:#a1a1aa;
                  font:14px/1.6 system-ui,sans-serif">
       <div style="text-align:center;max-width:34rem;padding:0 2rem">
         <div style="font-size:16px;color:${nativeTheme.shouldUseDarkColors ? "#e4e4e7" : "#18181b"};margin-bottom:12px">${t("crash.title")}</div>
         <div style="margin-bottom:10px">${t("crash.body")}</div>
         <div style="margin-bottom:18px;font-size:12px;color:#71717a">${reason ? String(reason).slice(0, 200) : ""}</div>
         <button onclick="location.replace(${reload})"
                 style="padding:8px 16px;border-radius:6px;border:0;cursor:pointer;
                        background:#3f3f46;color:#fafafa;font:inherit">
           ${t("crash.reload")}
         </button>
         <div style="margin-top:18px;font-size:12px;color:#52525b">${t("crash.hint")}</div>
       </div>
     </body>`,
  );
}

/** Recover from a dead renderer, an unresponsive page, or a failed load. */
function attachFailureHandling(window) {
  let showingFailure = false;

  const showFailure = (reason) => {
    if (showingFailure || quitting || window.isDestroyed()) return;
    showingFailure = true;
    logLine("shell", `showing recovery page: ${reason}`);
    window.loadURL(failurePageHtml(reason)).catch(() => {});
    // The page is a data: URL now; a real navigation means the user (or a
    // retry) brought the app back.
    window.webContents.once("did-navigate", () => {
      showingFailure = false;
    });
  };

  window.webContents.on("render-process-gone", (_event, details) => {
    // `clean-exit` and `killed` are not crashes worth a recovery page: the
    // first happens during shutdown, the second when something else is
    // already tearing the process down.
    if (details?.reason && !["clean-exit", "killed"].includes(details.reason)) {
      showFailure(`renderer ${details.reason}`);
    }
  });

  window.on("unresponsive", () => {
    logLine("shell", "window reported unresponsive");
    // Not a navigation: the renderer is alive but stuck. Reloading is the one
    // action that reliably gets a wedged page back.
    showFailure("the interface stopped responding");
  });

  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which every normal navigation past a redirect fires.
    // Only a failed main frame means the app itself did not arrive.
    if (!isMainFrame || code === -3) return;
    // The startup splash is a data: URL and its own polling owns the failure
    // story; this is about the real UI.
    if (!url || url.startsWith("data:")) return;
    showFailure(`${description || "load failed"} (${code})`);
  });
}

/**
 * The editing menu a text field is expected to have.
 *
 * Chromium does not draw a context menu by itself in a BrowserWindow — the
 * application has to. Without this, right-clicking any input in an app built
 * almost entirely out of text fields does nothing.
 */
function attachContextMenu(window) {
  window.webContents.on("context-menu", (_event, params) => {
    const template = [];
    if (params.linkURL) {
      template.push(
        { label: t("context.openLink"), click: () => void shell.openExternal(params.linkURL) },
        { label: t("context.copyLink"), click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      template.push(
        { label: t("context.cut"), role: "cut", enabled: params.editFlags.canCut },
        { label: t("context.copy"), role: "copy", enabled: params.editFlags.canCopy },
        { label: t("context.paste"), role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { label: t("context.selectAll"), role: "selectAll" },
      );
    } else if (params.selectionText) {
      template.push({ label: t("context.copy"), role: "copy" });
    }
    if (template.length === 0 && !isDev) return;
    if (template.length > 0) template.push({ type: "separator" });
    template.push({ label: t("context.inspect"), click: () => window.webContents.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(template).popup({ window });
  });
}

/** Same-origin as the local UI, including the app-opened popups it relies on. */
function isInternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Drive the startup placeholder's two lines while the services come up.
 *
 * The renderer is a `data:` document, so it cannot fetch the loopback API
 * itself (cross-origin, and the backend's request guard rejects the null
 * origin). Polling here and injecting text over `executeJavaScript` keeps the
 * placeholder a plain page with no preload bridge.
 *
 * Stops on its own once the window navigates to the real UI.
 */
function startStatusPolling(window) {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  window.webContents.once("did-start-navigation", (event) => {
    // The placeholder is the first document; anything after it is the app.
    if (!event.isSameDocument) stop();
  });
  window.webContents.once("destroyed", stop);

  const say = (text, hint) => {
    if (stopped || window.isDestroyed()) return;
    window.webContents
      .executeJavaScript(
        `(() => {
           const line = document.getElementById("line");
           const note = document.getElementById("hint");
           if (!line) return false;
           line.textContent = ${JSON.stringify(text)};
           if (note) note.textContent = ${JSON.stringify(hint ?? "")};
           return true;
         })()`,
      )
      .catch(() => {});
  };

  const tick = async () => {
    if (stopped || window.isDestroyed()) return;
    try {
      const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const helpers = body?.setup?.helpers;
      const catalogue = body?.setup?.catalogue;
      if (helpers?.state === "syncing") {
        say(t("splash.python"), t("splash.pythonHint"));
      } else if (helpers?.state === "failed") {
        say(
          t("splash.starting"),
          t("splash.pythonFailed", { detail: helpers.detail ?? "uv sync failed" }),
        );
      } else if (catalogue?.state === "syncing") {
        // A first launch downloads the skill catalogue (460 MB). Saying so is
        // the difference between "slow" and "frozen" on a poor link.
        say(t("splash.skills"), t("splash.skillsHint"));
      } else {
        say(t("splash.starting"), t("splash.loadingUi"));
      }
    } catch {
      // Backend not listening yet: the placeholder already says so.
    }
    if (!stopped) setTimeout(tick, 1500);
  };
  void tick();

  // The frontend usually answers a moment after the backend; without a hint
  // the gap looks like a stall.
  setTimeout(() => {
    say(t("splash.slow"), t("splash.slowHint"));
  }, 20_000);
}

/**
 * The "Starting…" document, kept out of boot() so reopening can reuse it.
 *
 * Built per launch rather than at module load so it picks up the system theme
 * and the resolved language.
 */
function splashHtml() {
  const name = appName();
  const dark = nativeTheme.shouldUseDarkColors;
  return "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<!doctype html><meta charset="utf-8">
       <body style="margin:0;height:100vh;display:grid;place-items:center;
                    background:${chromeBackground()};color:${dark ? "#a1a1aa" : "#52525b"};
                    font:14px/1.6 system-ui,sans-serif">
         <div style="text-align:center;max-width:32rem;padding:0 2rem">
           <div style="font-size:16px;color:${dark ? "#e4e4e7" : "#18181b"};margin-bottom:12px">${name}</div>
           <div id="line">${t("splash.starting")}</div>
           <div id="hint" style="margin-top:10px;font-size:12px;color:${dark ? "#52525b" : "#a1a1aa"}"></div>
       </div>
     </body>`,
    );
}

/**
 * Start the two services once per process. Later windows attach to them; this
 * is what makes closing the window cheap enough to be the default.
 */
async function bootServices() {
  const artifacts = runtimeArtifacts();

  // Fail on a missing shell before any window opens: without one, every agent
  // tool call fails with an error the user cannot act on.
  Object.assign(process.env, runtimeEnvironment(artifacts));
  const { blocking, warnings } = checkRuntime(artifacts);
  mark("preflight done");
  if (blocking.length) {
    logLine("shell", `startup blocked: ${blocking.join(" | ")}`);
    await dialog.showMessageBox({
      type: "error",
      title: t("error.missing.title", { app: appName() }),
      message: t("error.missing.message"),
      detail: blocking.join("\n\n"),
    });
    await quitApp({ force: true });
    return { ok: false, detail: blocking.join("\n\n") };
  }
  if (warnings.length) {
    console.warn(warnings.join("\n"));
  }

  servicesStarted = true;
  const result = await startServices({ dataRoot: dataRoot(), ...artifacts, mark });
  return result;}

/** Open the window. When the services are still coming up this shows the
 *  progress splash; a window opened later goes straight to the app because the
 *  backend is already answering.
 */
async function openWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  }
  // A window reopened after the user switched languages in Settings has to
  // speak the new one. The page has already written the choice by then, and
  // the probe is cheap when the frontend is up.
  if (servicesStarted) await refreshShellLanguage();
  const window = createWindow();
  mark("window created");

  const backendReady = servicesStarted && (await backendAnswers());
  if (backendReady) {
    await window.loadURL(UI_URL);
    mark("ui loaded");
  } else {
    await window.loadURL(splashHtml());
    mark("splash loaded");
    startStatusPolling(window);
    // The splash is a `data:` document with no script of its own, so nothing
    // in it can ever navigate away. Without this the window stayed on
    // "Starting local services…" forever whenever the services needed longer
    // than `backendAnswers()`'s 1.5s probe — a cold start routinely does, since
    // the backend is only listening once Pi has loaded (~35s measured). The
    // poller watches for the same condition and swaps the document once.
    await navigateWhenReady(window);
  }

  if (isDev) window.webContents.openDevTools({ mode: "detach" });
  return window;
}

/**
 * Replace the splash with the app as soon as both services answer.
 *
 * The splash is a `data:` document with no script of its own, so nothing in it
 * can ever navigate away. Without this the window stayed on "Starting local
 * services…" forever whenever the services needed longer than the one 1.5s
 * probe in `openWindow` — a cold start routinely does, because the backend is
 * only listening once Pi has loaded (~35s measured).
 *
 * Stops on its own once the window navigates (for any reason) or is destroyed,
 * and gives up rather than polling forever if the services never come up.
 */
async function navigateWhenReady(window) {
  let left = false;
  window.webContents.once("did-start-navigation", (event) => {
    if (!event.isSameDocument) left = true;
  });
  window.webContents.once("destroyed", () => {
    left = true;
  });

  const ready = await pollUntilReady({
    backendUrl: BACKEND_URL,
    uiUrl: UI_URL,
    stopped: () => left || window.isDestroyed(),
  });
  if (!ready) return;
  if (left || window.isDestroyed()) return;
  await window.loadURL(UI_URL).catch(() => {});
}

/** Cheap reachability probe, used to skip the splash on a warm reopen. */
async function backendAnswers() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Startup stage timer.
 *
 * A slow launch is otherwise unarguable: the log shows the backend listening
 * at some point and the window at another, with no way to tell which stage
 * took the time. Each line reads `boot +1234ms <stage>`, so `grep "boot +"`
 * over shell.log answers "where did those seconds go".
 */
const bootStartedAt = Date.now();
function mark(stage) {
  logLine("shell", `boot +${Date.now() - bootStartedAt}ms ${stage}`);
}

async function boot() {
  // Put the window on screen before the services start. A cold start takes
  // tens of seconds, and a launch that shows nothing for that long reads as
  // "the exe did nothing" — the reported symptom was having to click the tray
  // icon to get a window at all. `openWindow` picks the splash by itself while
  // `servicesStarted` is false, and its own readiness poll swaps in the app, so
  // it is deliberately not awaited here.
  mark("boot start");
  void openWindow()
    .then(() => mark("app window loaded"))
    .catch((error) => {
      logLine("shell", `window failed to open: ${error?.stack ?? error}`);
    });

  const result = await bootServices();
  if (quitting) return;
  if (!result?.ok) {
    logLine("shell", `boot failed: ${result?.detail ?? "unknown"}`);
    await dialog.showMessageBox({
      type: "error",
      title: t("error.start.title", { app: appName() }),
      message: t("error.start.message"),
      detail:
        result?.detail ??
        (isDev
          ? t("error.start.devHint")
          : t("error.start.hint", { ui: UI_URL, backend: BACKEND_URL })),
    });
    app.quit();
    return;
  }

  // The splash is already up and its poller takes the window over; opening a
  // second window here would put a stray one on screen.
}

// A single instance owns the ports; a second launch focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Launching the app again is a request to see it, whether the window is
    // minimized or was closed to the tray.
    void reopenWindow();
  });

  setFatalHandler(() => {
    if (quitting) return;
    void dialog
      .showMessageBox({
        type: "error",
        title: t("error.stopped.title"),
        message: t("error.stopped.message"),
        detail: t("error.stopped.detail", { app: appName() }),
      })
      .then(() => app.quit());
  });

  app.whenReady().then(async () => {
    // The shell speaks whichever language the interface is in. That choice
    // lives in the page's localStorage, so asking the system (as this used to)
    // meant a Chinese splash over an English app whenever the two disagreed.
    // The read is best-effort: a first launch has no stored choice yet, and
    // the system locale is then the same fallback the page itself uses.
    openLog(dataRoot(), {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      locale: app.getLocale(),
      packaged: String(app.isPackaged),
    });
    setLanguageFromLocale(await resolveShellLanguage());
    captureConsole();
    // Each service line goes to the log and to the terminal, exactly once.
    setServiceLogSink((source, text, sink) => logServiceLine(source, text, sink));

    // Windows groups notifications and taskbar entries by AppUserModelID; the
    // installer sets one for the shortcut, and the running process has to
    // agree or the toast is attributed to the wrong app (or dropped).
    if (process.platform === "win32") {
      app.setAppUserModelId("ai.kdense.kady.desktop");
    }
    app.setAboutPanelOptions({
      applicationName: appName(),
      applicationVersion: app.getVersion(),
      version: process.versions.electron ? `Electron ${process.versions.electron}` : "",
      credits: t("about.credits"),
      copyright: "MIT licensed. Based on K-Dense BYOK by K-Dense Inc.",
    });

    // Install the menu before the first window: roles are what give Chromium
    // its Ctrl+C/V and zoom accelerators.
    buildApplicationMenu();
    // The tray exists from the start so a window close lands in a running
    // shell rather than orphaning the process with no way back.
    if (closeAction() === "tray") createTray();
    // The page follows the system theme; the window chrome has to follow it
    // too, or light mode paints dark edges before the renderer catches up.
    nativeTheme.on("updated", applyThemeToWindow);
    await boot();
    // Started after boot: before that there is no backend to ask, and the
    // first observation would be a false "nothing running".
    startRunWatcher();
  }).catch((error) => {
    console.error("boot failed:", error);
    logLine("shell", `boot threw: ${error?.stack ?? error}`);
    app.quit();
  });

  // Closing the window is handled in `window-all-closed`: in tray mode the app
  // keeps running, otherwise it quits (after asking about streaming runs).
  app.on("window-all-closed", () => {
    // The window is already gone by now; this decides whether the process
    // follows it. In tray mode the renderer (~274 MB) is reclaimed but the
    // backend keeps running, so schedules and Modal jobs do not stop.
    if (closeAction() === "quit") {
      void quitApp();
      return;
    }
    // Reaching this branch means the process stays alive, so the tray must
    // exist — including when the user switched from "quit" to "tray" after
    // launch, when the startup path above never created one. Without this the
    // app is running with no window and no way to get it back.
    createTray();
    ensureTrayHint();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void quitApp();
  });

  // macOS: the dock icon brings the window back instead of quitting.
  app.on("activate", () => {
    if (quitting) return;
    void reopenWindow();
  });
}

/**
 * Ask the backend what a quit would interrupt.
 *
 * Only a running turn (streaming, or a run in its model-setup phase) counts.
 * Durable Modal jobs are explicitly restart-recoverable, and a queued async
 * subagent run reattaches on the next launch, so warning about those would
 * teach users to dismiss the dialog without reading it.
 */
async function quitInterruptsWork() {
  try {
    const res = await fetch(`${BACKEND_URL}/runtime-status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.runningSessions === "number" ? body : null;
  } catch {
    // No backend (already stopping, or it never started): nothing to warn about.
    return null;
  }
}

/**
 * Tray icon and menu. Right-click gives the two actions that matter: get the
 * window back, or actually stop the app. Double-click is the platform habit on
 * Windows and costs nothing to support.
 */
function createTray() {
  if (tray) return tray;
  const image = trayImage();
  if (image.isEmpty()) {
    // An invisible tray icon would leave the app running with no way back;
    // better to say so than to hide the problem.
    console.warn(`[tray] no icon found next to ${process.resourcesPath}`);
  }

  tray = new Tray(image);
  const name = appName();
  tray.setToolTip(t("tray.tooltip", { app: name }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("tray.open", { app: name }), click: () => void reopenWindow() },
      { type: "separator" },
      {
        label: t("tray.quit"),
        click: () => void quitApp({ force: true }),
      },
    ]),
  );
  tray.on("double-click", () => void reopenWindow());
  // macOS convention: a left click on a menu-bar item opens its menu, which
  // the context menu above already is. Windows users expect a click to bring
  // the window back, and double-click is the habit there.
  if (process.platform !== "darwin") {
    tray.on("click", () => void reopenWindow());
  }
  return tray;
}

/**
 * The image for the tray, sized and coloured for the platform.
 *
 * macOS menu-bar icons are template images: a monochrome mask that the system
 * recolours for light/dark and inverts on selection. A colour logo shrunk to
 * 16px reads as a smudge there, and cannot adapt. Windows and Linux take the
 * colour icon, which is what their notification areas expect.
 */
function trayImage() {
  const dir = isDev ? path.join(import.meta.dirname, "resources") : process.resourcesPath;
  const candidates =
    process.platform === "darwin"
      ? ["iconTemplate.png", "icon.png"]
      : ["icon.png", "icon.ico"];

  for (const name of candidates) {
    const image = nativeImage.createFromPath(path.join(dir, name));
    if (image.isEmpty()) continue;
    if (process.platform === "darwin") {
      if (name === "iconTemplate.png") image.setTemplateImage(true);
      // The template is authored at 32px for a 16pt slot, so hand it over as
      // is: resizing a template blurs the mask edge the system uses.
      return name === "iconTemplate.png" ? image : image.resize({ width: 16, height: 16 });
    }
    return image.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

/** Bring the window back, recreating it if the user closed it. */
async function reopenWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  try {
    await openWindow();
  } catch (error) {
    console.error("could not reopen the window:", error);
  }
}

/**
 * The one exit path: ask about streaming runs, stop the services, quit.
 *
 * Services must be stopped before `app.quit()` — `before-quit` also runs on
 * paths that never started them (a second instance rejecting the lock), and
 * `stopServices` is idempotent, so calling it twice is harmless.
 *
 * `force` skips the active-run prompt; the tray's Quit item is an explicit
 * instruction and should not bounce back with a dialog.
 */
async function quitApp({ force = false } = {}) {
  if (quitting) return;
  if (!force && !(await confirmQuitWithActiveRuns())) return;
  quitting = true;
  await stopServices();
  app.quit();
}

/**
 * Tell the user the app is still running the first time they close it, or
 * they conclude the close failed and try again. Windows balloons are the
 * platform's own idiom and need no notification permission.
 */
function ensureTrayHint() {
  const s = readShellSettings();
  if (s.trayHintShown) return;
  const trayInstance = createTray();
  const name = appName();

  if (process.platform === "win32" && trayInstance && typeof trayInstance.displayBalloon === "function") {
    trayInstance.displayBalloon({
      title: t("trayHint.title", { app: name }),
      content: t("trayHint.body"),
    });
  } else if (process.platform === "darwin") {
    // `displayBalloon` is Windows-only, so the macOS case used to fall through
    // and still mark itself as shown: the user was told nothing, ever. A
    // notification is the idiomatic equivalent — no tray "balloon" exists on
    // the menu bar — and it names the two ways back (menu bar icon, Dock).
    if (Notification.isSupported()) {
      const hint = new Notification({
        title: t("trayHint.title", { app: name }),
        body: t("trayHint.bodyMac", { app: name }),
        silent: true,
      });
      hint.on("click", () => void reopenWindow());
      hint.show();
    }
  }
  // Only record it once something was actually shown; otherwise the hint is
  // consumed without ever reaching the user.
  writeShellSetting("trayHintShown", true);
}

/** True when the app should quit; false keeps it running. */
async function confirmQuitWithActiveRuns() {
  const status = await quitInterruptsWork();
  if (!status || status.runningSessions === 0) return true;

  const names = status.sessions
    .map((s) => s.name)
    .filter(Boolean)
    .slice(0, 5);
  const detail =
    names.length > 0
      ? t("quit.running.detailNamed", { names: names.join(", ") })
      : t("quit.running.detail");

  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: t("quit.running.title"),
    message:
      status.runningSessions === 1
        ? t("quit.running.one")
        : t("quit.running.many", { count: status.runningSessions }),
    detail,
    buttons: [t("quit.running.keep"), t("quit.running.quit")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}
