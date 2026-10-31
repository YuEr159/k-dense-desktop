/**
 * Service manager for the desktop shell.
 *
 * Two modes:
 *  - dev: run the checkout directly (tsx for the backend, `next start` for the
 *    frontend), same as stage 0.
 *  - packaged: run the prebuilt artifacts shipped inside the app — a compiled
 *    backend bundle and the Next standalone server — with all writable state
 *    redirected to the per-user data directory.
 *
 * `ELECTRON_RUN_AS_NODE=1` makes electron.exe behave as a plain Node runtime.
 * It is set for our children *and* inherited by theirs, which is what keeps the
 * backend's own `spawn(process.execPath, ...)` calls (pi mcp, skills CLI)
 * working without patching them.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const BACKEND_PORT = 8000;
export const FRONTEND_PORT = 3000;
export const UI_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const children = new Set();
let shuttingDown = false;
let fatalHandler = null;

/** Repo root: the desktop/ directory sits directly under it. */
export const repoRoot = path.resolve(import.meta.dirname, "..");

export function setFatalHandler(handler) {
  fatalHandler = handler;
}

function nodeEnv(extra = {}) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ...extra,
  };
}

function spawnService(label, file, args, cwd, env) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd,
    env: nodeEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);

  const forward = (stream, sink) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => sink(chunk.trimEnd()));
  };
  forward(child.stdout, (line) => console.log(`[${label}] ${line}`));
  forward(child.stderr, (line) => console.error(`[${label}] ${line}`));

  child.once("error", (err) => {
    console.error(`[${label}] failed to start: ${err.message}`);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`[${label}] exited (code=${code} signal=${signal})`);
      fatalHandler?.();
    }
  });
  return child;
}

/**
 * Environment shared by both services. `dataRoot` is where every writable
 * path lands: `.env` with saved API keys and `projects/` with user data.
 *
 * `externalsDir` holds the binaries we ship (MinGit's bash + git, uv). They go
 * on PATH ahead of anything the user has, and Pi is told explicitly which bash
 * to use -- a missing bash.exe breaks every agent tool call, so this must not
 * depend on the user's PATH.
 */
function commonEnv(dataRoot, modelsCatalogue, externalsDir) {
  const env = {
    KADY_DATA_ROOT: dataRoot,
    KADY_PORT: String(BACKEND_PORT),
    KADY_FRONTEND_PORT: String(FRONTEND_PORT),
    // The helper venv is ~555 MB of Python packages built by `uv sync`. Left in
    // the payload (uv's default, beside pyproject.toml) an upgrade would wipe
    // it: NSIS replaces the install directory wholesale. Keep it in the data
    // root, which survives upgrades and is already the user's writable area.
    KADY_HELPERS_VENV: path.join(dataRoot, "python", "helpers"),
  };
  if (modelsCatalogue) env.KADY_MODELS_CATALOGUE = modelsCatalogue;

  if (externalsDir) {
    const gitRoot = path.join(externalsDir, "git");
    // PortableGit 2.56 ships the toolchain as ucrt64/; older archives use
    // mingw64/. Both put the real git.exe there and a shim under cmd/.
    const mingw = ["ucrt64", "mingw64"].find((name) =>
      fs.existsSync(path.join(gitRoot, name, "bin", "git.exe")),
    );
    const gitBin = path.join(gitRoot, "cmd");
    const gitUsrBin = path.join(gitRoot, "usr", "bin");
    const uvBin = path.join(externalsDir, "uv");
    // The MinGW bin carries the DLLs git.exe links; cmd/ and usr/bin carry the
    // shims and bash. All three go on PATH ahead of the user's own tools.
    const mingwBin = mingw ? path.join(gitRoot, mingw, "bin") : null;
    const parts = [gitBin, gitUsrBin, mingwBin, uvBin].filter((p) => p && fs.existsSync(p));
    if (parts.length) {
      env.PATH = [...parts, process.env.PATH ?? ""].join(path.delimiter);
      // Kady looks for uv on PATH first, then ~/.local/bin; putting the bundled
      // copy on PATH is enough, but this makes the intent explicit.
      const uvExe = path.join(uvBin, "uv.exe");
      if (fs.existsSync(uvExe)) env.UV = uvExe;
    }
    // Pi resolves bash as: settings.shellPath, then Program Files\Git, then
    // PATH (see getShellConfig in pi-coding-agent). Writing shellPath into the
    // shared agent settings is what makes the bundled bash win over an old
    // system Git -- a wrong bash here breaks every agent tool call.
    const bashExe = path.join(externalsDir, "git", "usr", "bin", "bash.exe");
    if (fs.existsSync(bashExe)) configureShellPath(env, bashExe);
  }
  return env;
}

/**
 * Point Pi at a specific bash via its own settings file. Existing user
 * settings are preserved: the key is only added when absent, and an
 * unparseable file is left untouched.
 *
 * Kady's backend resolves its agent directory in env.ts from
 * PI_CODING_AGENT_DIR / KADY_PI_AGENT_DIR, defaulting to ~/.kady/pi-agent.
 * The same resolution is repeated here so the settings land where the backend
 * will look for them.
 */
function configureShellPath(env, bashExe) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  let configured =
    env.PI_CODING_AGENT_DIR?.trim() ||
    env.KADY_PI_AGENT_DIR?.trim() ||
    path.join(home, ".kady", "pi-agent");
  // Expand a leading ~ the way Kady's env.ts does.
  if (configured === "~") configured = home;
  else if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    configured = path.join(home, configured.slice(2));
  }
  const agentDir = path.resolve(configured);
  const settingsPath = path.join(agentDir, "settings.json");
  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return;
      settings = parsed;
      if (settings.shellPath === bashExe) return; // already ours
      // Keep a shellPath the user chose -- unless it points somewhere that no
      // longer exists, which is what a moved/reinstalled app leaves behind.
      if (typeof settings.shellPath === "string" && settings.shellPath.trim()) {
        if (fs.existsSync(settings.shellPath)) return;
        console.log(`[shell] replacing stale shellPath: ${settings.shellPath}`);
      }
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ ...settings, shellPath: bashExe }, null, 2) + "\n",
    );
    console.log(`[shell] pinned bash for the agent: ${bashExe}`);
  } catch (error) {
    // Never block startup on this: Pi falls back to its own discovery.
    console.warn(`[shell] could not record shellPath: ${error.message}`);
  }
}

/**
 * Packaged builds read prebuilt artifacts from resources/runtime/. A source
 * checkout has none, so `startServices` falls back to tsx + `next start`.
 */
export function packagedArtifacts(resourcesPath) {
  const runtime = path.join(resourcesPath, "runtime");
  const backendEntry = path.join(runtime, "server", "src", "index.mjs");
  const standaloneDir = path.join(runtime, "web");
  if (!fs.existsSync(backendEntry) || !fs.existsSync(path.join(standaloneDir, "server.js"))) {
    return null;
  }
  return {
    backendBundle: backendEntry,
    standaloneDir,
    modelsCatalogue: path.join(runtime, "models.json"),
    externalsDir: path.join(resourcesPath, "externals"),
  };
}

/** Source checkout: run TypeScript through tsx exactly like the repo does. */
function startBackendFromSource(env) {
  return spawnService(
    "backend",
    path.join(repoRoot, "server", "node_modules", "tsx", "dist", "cli.mjs"),
    [path.join(repoRoot, "server", "src", "index.ts")],
    path.join(repoRoot, "server"),
    env,
  );
}

/** Packaged: the compiled tree staged by scripts/build-runtime.mjs. */
function startBackendFromBundle(bundlePath, env) {
  // index.mjs sits in src/, and the runtime resolves ../../pi-packages,
  // ../../node_modules, and ../../env-file.mjs from there.
  return spawnService("backend", bundlePath, [], path.dirname(bundlePath), env);
}

function startFrontendFromSource(env) {
  return spawnService(
    "frontend",
    path.join(repoRoot, "web", "node_modules", "next", "dist", "bin", "next"),
    ["start", "-p", String(FRONTEND_PORT), "-H", "127.0.0.1"],
    path.join(repoRoot, "web"),
    env,
  );
}

/** Packaged: Next standalone's own server.js, no node_modules needed. */
function startFrontendFromStandalone(standaloneDir, env) {
  return spawnService(
    "frontend",
    path.join(standaloneDir, "server.js"),
    [],
    standaloneDir,
    env,
  );
}

async function waitFor(url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.error(`[${label}] did not answer ${url} within ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot  writable state directory
 * @param {string} [options.externalsDir]  bundled bash/git/uv (packaged)
 * @param {string} [options.backendBundle]  compiled backend entry (packaged)
 * @param {string} [options.standaloneDir]  Next standalone dir (packaged)
 * @param {string} [options.modelsCatalogue]  models.json path (packaged)
 */
export async function startServices({
  dataRoot,
  externalsDir,
  backendBundle,
  standaloneDir,
  modelsCatalogue,
}) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const env = commonEnv(dataRoot, modelsCatalogue, externalsDir);

  if (backendBundle && standaloneDir) {
    startBackendFromBundle(backendBundle, env);
    startFrontendFromStandalone(standaloneDir, env);
  } else {
    startBackendFromSource(env);
    startFrontendFromSource(env);
  }

  const backendUp = await waitFor(`${BACKEND_URL}/health`, "backend", 120_000);
  const frontendUp = await waitFor(`${UI_URL}/`, "frontend", 180_000);
  return backendUp && frontendUp;
}

export async function stopServices() {
  if (shuttingDown) return;
  shuttingDown = true;

  const alive = [...children];
  for (const child of alive) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* already gone */
    }
  }
  const done = Promise.all(
    alive.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once("exit", r)))),
  );
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  children.clear();
}
