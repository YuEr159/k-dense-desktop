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
/** Accept only an http(s) URL; anything else means "no mirror". */
function validIndex(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function pypiIndex(): string | null {
  return validIndex(process.env.KADY_PYPI_INDEX);
}

/**
 * The index actually used for this launch: the user's choice, or the fastest
 * candidate when they have not made one.
 *
 * Resolved once per process. The lookup has to happen before
 * `helperProjectDirectory()` writes the rewritten lock, because that copy is
 * what `--frozen` downloads from — so this is awaited at the top of the sync,
 * not read lazily at the point of use.
 *
 * An explicit `KADY_PYPI_INDEX` always wins: a setting someone took the
 * trouble to make should not be overridden by a two-second measurement.
 */
let resolvedIndex: Promise<string | null> | null = null;

export function resolvePypiIndex(): Promise<string | null> {
  if (resolvedIndex) return resolvedIndex;
  resolvedIndex = (async () => {
    const configured = pypiIndex();
    if (configured) return configured;
    const probes = await probePypiIndexes();
    // Empty means every probe failed; leaving the index unset then is the
    // safe answer — uv falls back to PyPI itself, which is what a build
    // without this feature would have done anyway.
    const best = probes[0];
    if (!best) return null;
    // PyPI itself needs no rewrite: the lock already points there.
    if (best.index.startsWith("https://pypi.org/simple")) return null;
    return validIndex(best.index);
  })();
  return resolvedIndex;
}

/** Test seam: forget the memoised choice. */
export function resetPypiIndexForTests(): void {
  resolvedIndex = null;
}

/** Artifact hosts a mirror URL stands in for, given its own host. */
function mirrorHosts(index: string): { registry: string; artifact: string } {
  return { registry: index, artifact: new URL(index).origin };
}

/**
 * Indexes worth measuring, in the order they are tried when probing fails.
 *
 * PyPI itself is first: where it is fast it is also the most complete. The
 * rest are the mirrors that carry the scientific wheels this project needs,
 * and they matter exactly where files.pythonhosted.org is slow.
 */
export const PYPI_CANDIDATES = [
  "https://pypi.org/simple",
  "https://pypi.tuna.tsinghua.edu.cn/simple",
  "https://mirrors.aliyun.com/pypi/simple",
] as const;

/** How long one index gets to produce its first byte. */
export const PYPI_PROBE_TIMEOUT_MS = 2500;

/** Delay before giving up on a probe; kept short so startup is never held up. */
export type PypiProbe = { index: string; ms: number };

/**
 * Time-to-first-byte for each candidate index, fastest first.
 *
 * Measuring the whole index page would be honest about throughput but costs
 * seconds and megabytes; the first byte already separates "reachable" from
 * "not", which is what decides between a 26-second and a 17-minute install.
 *
 * Anything that fails or times out is absent from the result rather than
 * ranked last: a caller that gets an empty list falls back to trying in
 * declaration order, so a broken probe can never make a working download
 * impossible.
 */
export async function probePypiIndexes(
  candidates: readonly string[] = PYPI_CANDIDATES,
  timeoutMs = PYPI_PROBE_TIMEOUT_MS,
): Promise<PypiProbe[]> {
  const measure = async (index: string): Promise<PypiProbe | null> => {
    const started = Date.now();
    try {
      const res = await fetch(index, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return { index, ms: Date.now() - started };
    } catch {
      return null;
    }
  };
  const results = await Promise.all(candidates.map(measure));
  return results
    .filter((r): r is PypiProbe => r !== null)
    .sort((a, b) => a.ms - b.ms);
}

/** Point a lockfile's PyPI URLs at `index`, leaving versions and hashes alone. */
function rewriteLockForMirror(source: string, index: string): string {
  const { registry, artifact } = mirrorHosts(index);
  return source
    .split("https://pypi.org/simple").join(registry)
    .split("https://files.pythonhosted.org").join(artifact);
}

/**
 * uv may update its lock/project files; signed app resources are read-only.
 *
 * `index` is the already-resolved mirror (see `resolvePypiIndex`); passing it
 * in rather than reading the environment here keeps the async probe out of a
 * function the sync path calls synchronously, and keeps the resumed copy and
 * `UV_DEFAULT_INDEX` describing the same host.
 */
export function helperProjectDirectory(index: string | null = pypiIndex()): string {
  const override = process.env.KADY_HELPERS_PROJECT_DIR?.trim();
  if (!override) return HELPERS_DIR;
  const destination = path.resolve(override);
  if (destination === HELPERS_DIR) return HELPERS_DIR;
  fs.mkdirSync(destination, { recursive: true });
  // Validate here rather than trusting the caller: this function is public and
  // a bad string would otherwise reach `new URL` inside the rewrite.
  const mirror = validIndex(index);
  for (const name of ["pyproject.toml", "uv.lock"]) {
    const source = path.join(HELPERS_DIR, name);
    const target = path.join(destination, name);
    if (name === "uv.lock" && mirror) {
      fs.writeFileSync(target, rewriteLockForMirror(fs.readFileSync(source, "utf-8"), mirror), "utf-8");
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
  /**
   * Where the packages are being fetched from, when that is not plain PyPI.
   * Surfaced so a slow first launch has a visible explanation instead of
   * looking stuck.
   */
  index?: string;
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
function uvSyncEnv(index: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv =
    HELPERS_VENV_DIR === path.join(HELPERS_DIR, ".venv")
      ? { ...process.env }
      : { ...process.env, UV_PROJECT_ENVIRONMENT: HELPERS_VENV_DIR };
  // `--frozen` takes artifact URLs from the lock, so the index variable only
  // matters for a re-resolve; the lock rewrite above is what actually moves
  // the download. Set it anyway for the case where the lock and the mirror
  // disagree enough that uv re-resolves — and pass the same index the lock
  // was rewritten with, so the two never name different hosts.
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
export async function syncHelperVenvAsync(): Promise<number | null> {
  const uv = findUv();
  if (!uv) {
    helperState.state = "unavailable";
    return null;
  }
  helperState.state = "syncing";
  try {
    fs.mkdirSync(path.dirname(HELPERS_VENV_DIR), { recursive: true });
  } catch {
    // A read-only data root still lets the sync fail loudly on its own terms.
  }
  let projectDir: string;
  let index: string | null;
  try {
    // The probe has to finish before the lock is copied: `--frozen`
    // downloads from whatever hosts that copy names.
    index = await resolvePypiIndex();
    projectDir = helperProjectDirectory(index);
  } catch (error) {
    helperState.state = "failed";
    helperState.detail = String(error);
    return null;
  }
  if (index) helperState.index = index;
  return new Promise((resolve) => {
    const child = spawn(uv, ["sync", "--frozen", "--python", "3.12"], {
      cwd: projectDir,
      stdio: "ignore",
      env: uvSyncEnv(index),
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

/**
 * Synchronous variant, used by the prep script and by callers that cannot
 * await.
 *
 * The index here is the synchronously readable one — an explicit
 * `KADY_PYPI_INDEX`, or nothing. Probing would mean blocking the thread for
 * up to `PYPI_PROBE_TIMEOUT_MS`, which is the opposite of what the background
 * path exists to avoid; a caller that wants the measurement uses
 * `syncHelperVenvAsync`.
 */
function runUvSync() {
  const uv = findUv();
  if (!uv) return null;
  const index = pypiIndex();
  fs.mkdirSync(path.dirname(HELPERS_VENV_DIR), { recursive: true });
  return spawnSync(uv, ["sync", "--frozen", "--python", "3.12"], {
    cwd: helperProjectDirectory(index),
    stdio: "ignore",
    // Same ceiling as the async path, for the same reason.
    timeout: 45 * 60 * 1000,
    env: uvSyncEnv(index),
  });
}
