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
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { BACKEND_URL, UI_URL, packagedArtifacts, setFatalHandler, startServices, stopServices } from "./service-manager.mjs";
import { checkRuntime } from "./preflight.mjs";

const isDev = !app.isPackaged;

// Electron derives app.getPath("userData") from the package name, which is
// "kady-desktop" while the product is "Kady". Pin the name so a packaged app
// and a checkout agree on where user data lives.
app.setName("Kady");

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
    show: false,
    title: "K-Dense BYOK",
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
      if (helpers?.state === "syncing") {
        say(
          "Preparing Python previews…",
          "Installing scientific Python packages. This happens once, and can take several minutes.",
        );
      } else if (helpers?.state === "failed") {
        say(
          "Starting local services…",
          `Python previews are unavailable (${helpers.detail ?? "uv sync failed"}). The app still works.`,
        );
      } else {
        say("Starting local services…", "Loading the interface…");
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
    say("Starting the interface…", "The first launch takes longer than later ones.");
  }, 20_000);
}

async function boot() {
  const window = createWindow();
  const artifacts = runtimeArtifacts();

  // Fail on a missing shell before the window opens: without one, every agent
  // tool call fails with an error the user cannot act on.
  const { blocking, warnings } = checkRuntime(artifacts);
  if (blocking.length) {
    await dialog.showMessageBox({
      type: "error",
      title: "K-Dense BYOK cannot start",
      message: "A required component is missing.",
      detail: blocking.join("\n\n"),
    });
    quitting = true;
    app.quit();
    return;
  }
  if (warnings.length) {
    console.warn(warnings.join("\n"));
  }
  // Placeholder while the services come up. The main process polls /health and
  // pushes progress in: the first launch installs ~555 MB of Python wheels, and
  // a screen that never changes reads as a hang.
  await window.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<!doctype html><meta charset="utf-8">
         <body style="margin:0;height:100vh;display:grid;place-items:center;
                      background:#0b0b0c;color:#a1a1aa;
                      font:14px/1.6 system-ui,sans-serif">
           <div style="text-align:center;max-width:32rem;padding:0 2rem">
             <div style="font-size:16px;color:#e4e4e7;margin-bottom:12px">K-Dense BYOK</div>
             <div id="line">Starting local services…</div>
             <div id="hint" style="margin-top:10px;font-size:12px;color:#52525b"></div>
           </div>
         </body>`,
      ),
  );
  startStatusPolling(window);

  const ready = await startServices({
    dataRoot: dataRoot(),
    ...artifacts,
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

  // Closing the window ends the app by default — the services exist to serve
  // it, and an AI assistant left running in the tray is a process nobody
  // remembers. The one exception is work in flight: the backend answers with
  // what would be cut off, and the user decides.
  app.on("window-all-closed", () => {
    void (async () => {
      if (await confirmQuitWithActiveRuns()) {
        quitting = true;
        await stopServices();
        app.quit();
      } else {
        // The user kept the app open; bring the window back rather than
        // leaving a headless process with no way to reach it.
        void boot();
      }
    })();
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
      ? `Still running: ${names.join(", ")}. Closing now ends the response mid-stream.`
      : "A response is still streaming. Closing now ends it mid-stream.";

  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "A response is still running",
    message:
      status.runningSessions === 1
        ? "One chat is still working."
        : `${status.runningSessions} chats are still working.`,
    detail,
    buttons: ["Keep working", "Quit anyway"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}
