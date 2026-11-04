/**
 * Reproducible Python environment for the backend's helper CLIs (server/src/helpers/*.py).
 *
 * Mirrors the `syncSandboxVenv` pattern in sandbox-seed.ts, but for the helper
 * scripts the backend itself shells out to (currently anndata_helper.py) rather
 * than the per-project agent sandbox. Keeping these deps in their own
 * uv-managed venv means helper previews no longer depend on system python3
 * happening to have rdkit/gemmi/anndata/etc. installed.
 *
 * The scripts are read-only payload; the venv is not. A packaged install sits
 * under %LOCALAPPDATA%/Programs/Kady and is replaced wholesale on upgrade
 * (`differentialPackage: false`), so a venv kept beside the scripts — which is
 * where `uv sync` would put it by default — would be destroyed every time the
 * user updates. KADY_HELPERS_VENV moves it to the writable data root instead;
 * a source checkout keeps the convenient in-tree location.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findUv, firstRunnable } from "./binaries.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to server/src/helpers (holds the Python CLIs + pyproject.toml). */
export const HELPERS_DIR = path.join(__dirname, "helpers");

/**
 * Where `uv sync` builds the venv. The desktop shell injects KADY_HELPERS_VENV
 * pointing at the data root; without it this stays in-tree, which is what a
 * developer running from a checkout wants and what every existing test assumes.
 */
export const HELPERS_VENV_DIR = path.resolve(
  process.env.KADY_HELPERS_VENV?.trim() || path.join(HELPERS_DIR, ".venv"),
);

/**
 * A PyPI mirror, when the user set `KADY_PYPI_INDEX` (e.g.
 * `https://pypi.tuna.tsinghua.edu.cn/simple`).
 *
 * Worth having because the mirror is not a preference: the first launch
 * installs ~553 MB of wheels, and on a link where the mirror is reachable but
 * files.pythonhosted.org is slow, the same install measured 17m22s against
 * 26s — past this module's own timeout, so the venv simply never finished.
 *
 * `UV_DEFAULT_INDEX` alone would not be enough here: uv.lock records absolute
 * artifact URLs (`files.pythonhosted.org/...`) and `--frozen` downloads from
 * them verbatim, ignoring every index setting. The mirror therefore also
 * rewrites the lock's registry and artifact hosts — versions and sha256
 * digests are kept as they are, so what lands in the venv is still the
 * audited package the lock pinned.
 */
function pypiIndex(): string | null {
  const raw = process.env.KADY_PYPI_INDEX?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Artifact hosts a mirror URL stands in for, given its own host. */
function mirrorHosts(index: string): { registry: string; artifact: string } {
  return { registry: index, artifact: new URL(index).origin };
}

/** Point a lockfile's PyPI URLs at `index`, leaving versions and hashes alone. */
function rewriteLockForMirror(source: string, index: string): string {
  const { registry, artifact } = mirrorHosts(index);
  return source
    .split("https://pypi.org/simple").join(registry)
    .split("https://files.pythonhosted.org").join(artifact);
}

/** uv may update its lock/project files; signed app resources are read-only. */
export function helperProjectDirectory(): string {
  const override = process.env.KADY_HELPERS_PROJECT_DIR?.trim();
  if (!override) return HELPERS_DIR;
  const destination = path.resolve(override);
  if (destination === HELPERS_DIR) return HELPERS_DIR;
  fs.mkdirSync(destination, { recursive: true });
  const index = pypiIndex();
  for (const name of ["pyproject.toml", "uv.lock"]) {
    const source = path.join(HELPERS_DIR, name);
    const target = path.join(destination, name);
    if (name === "uv.lock" && index) {
      fs.writeFileSync(target, rewriteLockForMirror(fs.readFileSync(source, "utf-8"), index), "utf-8");
    } else {
      fs.copyFileSync(source, target);
    }
  }
  return destination;
}

function venvPythonPath(): string {
  return process.platform === "win32"
    ? path.join(HELPERS_VENV_DIR, "Scripts", "python.exe")
    : path.join(HELPERS_VENV_DIR, "bin", "python");
}

/**
 * Progress of the background sync, surfaced on /health so the desktop shell can
 * tell the user what the first launch is doing. `ready` means the interpreter
 * already exists (a warm data root), `idle` that nothing has run yet.
 */
export type HelperVenvState = {
  state: "idle" | "syncing" | "ready" | "failed" | "unavailable";
  /** Present on failure: uv's exit status, or why uv was not found. */
  detail?: string;
};

const helperState: HelperVenvState = {
  state: fs.existsSync(venvPythonPath()) ? "ready" : "idle",
};

/** Live view of the background sync; mutated in place so readers never see a stale copy. */
export function helperVenvState(): HelperVenvState {
  return helperState;
}

/** Interpreter for the Python helper CLIs. Prefers an explicit override, then the
 *  uv-managed helper venv, then a system Python. */
export function helperPython(): string {
  if (process.env.KADY_PYTHON) return process.env.KADY_PYTHON;
  const venvPy = venvPythonPath();
  if (fs.existsSync(venvPy)) return venvPy;
  if (process.platform === "win32") return firstRunnable(["python", "py"]) ?? "python";
  return "python3";
}

/**
 * Child environment for `uv sync`.
 *
 * uv writes the venv to UV_PROJECT_ENVIRONMENT when set, and still reads
 * pyproject.toml and uv.lock from cwd — so the project stays the shipped
 * payload while the environment lands somewhere writable.
 */
function uvSyncEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv =
    HELPERS_VENV_DIR === path.join(HELPERS_DIR, ".venv")
      ? { ...process.env }
      : { ...process.env, UV_PROJECT_ENVIRONMENT: HELPERS_VENV_DIR };
  // `--frozen` takes artifact URLs from the lock, so the index variable only
  // matters for a re-resolve; the lock rewrite above is what actually moves
  // the download. Set it anyway for the case where the lock and the mirror
  // disagree enough that uv re-resolves.
  const index = pypiIndex();
  if (index) env.UV_DEFAULT_INDEX = index;
  return env;
}

/** Best-effort `uv sync` of the helper venv. Returns false when uv is unavailable
 *  or the sync fails; callers treat that as "previews degrade to deps-missing". */
export function syncHelperVenv(): boolean {
  const result = runUvSync();
  return result !== null && result.status === 0;
}

/**
 * `uv sync` without blocking the event loop.
 *
 * The first run installs ~555 MB of wheels (minutes); doing that with
 * spawnSync froze the whole backend, so `/health` never answered and the
 * desktop shell's readiness probe timed out before the app could show its UI.
 * Boot now starts this in the background: the server answers immediately and
 * previews report deps-missing until it finishes.
 *
 * Resolves to the exit status, or null when uv is unavailable.
 */
export function syncHelperVenvAsync(): Promise<number | null> {
  return new Promise((resolve) => {
    const uv = findUv();
    if (!uv) {
      helperState.state = "unavailable";
      resolve(null);
      return;
    }
    helperState.state = "syncing";
    try {
      fs.mkdirSync(path.dirname(HELPERS_VENV_DIR), { recursive: true });
    } catch {
      // A read-only data root still lets the sync fail loudly on its own terms.
    }
    let projectDir: string;
    try { projectDir = helperProjectDirectory(); } catch (error) {
      helperState.state = "failed";
      helperState.detail = String(error);
      resolve(null);
      return;
    }
    const child = spawn(uv, ["sync", "--frozen", "--python", "3.12"], {
      cwd: projectDir,
      stdio: "ignore",
      env: uvSyncEnv(),
    });
    // Long enough for a cold install on a slow link: measured 17m22s against
    // PyPI from a residential connection in China, where the previous 15
    // minutes killed the child mid-download and left no interpreter at all.
    // The mirror path finishes in well under a minute; this ceiling only
    // guards against a hung transfer.
    const timer = setTimeout(() => child.kill(), 45 * 60 * 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      helperState.state = "failed";
      helperState.detail = error.message;
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      // A timed-out kill lands here with a signal rather than a clean status.
      if (code === 0 && fs.existsSync(venvPythonPath())) {
        helperState.state = "ready";
        delete helperState.detail;
      } else {
        helperState.state = "failed";
        helperState.detail = code === null ? "timed out" : `uv exited with status ${code}`;
      }
      resolve(code);
    });
  });
}

function runUvSync() {
  const uv = findUv();
  if (!uv) return null;
  fs.mkdirSync(path.dirname(HELPERS_VENV_DIR), { recursive: true });
  return spawnSync(uv, ["sync", "--frozen", "--python", "3.12"], {
    cwd: helperProjectDirectory(),
    stdio: "ignore",
    // Same ceiling as the async path, for the same reason.
    timeout: 45 * 60 * 1000,
    env: uvSyncEnv(),
  });
}
