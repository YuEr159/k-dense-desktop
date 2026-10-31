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
import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import process from "node:process";

import { UI_URL, packagedArtifacts, setFatalHandler, startServices, stopServices } from "./service-manager.mjs";

const isDev = !app.isPackaged;

/** Keep one window; re-focusing the dock/taskbar icon should not spawn more. */
let mainWindow = null;
let quitting = false;

/**
 * Writable state lives outside the install directory: a packaged app under
 * Program Files cannot write its own `.env`, and projects must survive an
 * upgrade. Electron gives us the right per-user location per platform.
 */
function dataRoot() {
  return path.join(app.getPath("userData"), "data");
}

/**
 * Where prebuilt artifacts live. A packaged app keeps them under resources/;
 * KADY_RUNTIME_DIR points a checkout at `desktop/build/runtime` for testing
 * the packaged path without building an installer.
 */
function runtimeArtifacts() {
  if (process.env.KADY_RUNTIME_DIR) {
    const dir = path.resolve(process.env.KADY_RUNTIME_DIR);
    return packagedArtifactsFrom(dir) ?? {};
  }
  return packagedArtifacts(process.resourcesPath) ?? {};
}

function packagedArtifactsFrom(dir) {
  // Same layout as resources/runtime, rooted at an explicit directory.
  return packagedArtifacts(dir);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
    show: false,
    title: "K-Dense BYOK",
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

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
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

async function boot() {
  const window = createWindow();

  // Show a lightweight placeholder while the services come up; the first
  // `next start` can take a few seconds even with a warm build.
  await window.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<!doctype html><meta charset="utf-8">
         <body style="margin:0;height:100vh;display:grid;place-items:center;
                      background:#0b0b0c;color:#a1a1aa;
                      font:14px/1.6 system-ui,sans-serif">
           <div style="text-align:center">
             <div style="font-size:16px;color:#e4e4e7;margin-bottom:8px">K-Dense BYOK</div>
             <div>Starting local services…</div>
           </div>
         </body>`,
      ),
  );

  const ready = await startServices({
    dataRoot: dataRoot(),
    ...runtimeArtifacts(),
  });
  if (quitting) return;

  if (!ready) {
    await dialog.showMessageBox({
      type: "error",
      title: "K-Dense BYOK could not start",
      message: "The local services did not become ready.",
      detail: isDev
        ? "Check the terminal output for the failing service. If dependencies are missing, " +
          "run `npm install` in server/ and web/, then try again."
        : "Check that no other program is using ports 3000 or 8000, then restart the app.",
    });
    app.quit();
    return;
  }

  await window.loadURL(UI_URL);
  if (isDev) window.webContents.openDevTools({ mode: "detach" });
}

// A single instance owns the ports; a second launch focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  setFatalHandler(() => {
    if (quitting) return;
    void dialog
      .showMessageBox({
        type: "error",
        title: "A Kady service stopped",
        message: "The app has to close because one of its local services exited.",
        detail: "Restart K-Dense BYOK to try again. The terminal output has the details.",
      })
      .then(() => app.quit());
  });

  app.whenReady().then(boot).catch((error) => {
    console.error("boot failed:", error);
    app.quit();
  });

  // Closing the window ends the app: the services exist to serve it.
  app.on("window-all-closed", () => {
    quitting = true;
    void stopServices().finally(() => app.quit());
  });

  app.on("before-quit", () => {
    quitting = true;
    void stopServices();
  });

  // macOS: clicking the dock icon after the window closed has nothing to
  // restore, so quitting above is the documented stage-0 behaviour.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !quitting) void boot();
  });
}
