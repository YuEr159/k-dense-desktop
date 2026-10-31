/**
 * Fetch the external binaries the backend shells out to, into build/externals/.
 *
 * Two of these are hard requirements the app cannot work without:
 *
 *  - bash: Pi's bash tool spawns a real bash.exe. On native Windows that means
 *    Git for Windows; MinGit is the portable subset (no installer, no GUI).
 *  - uv: every Python task in a project sandbox runs through `uv run`, and the
 *    preview helpers get their venv from `uv sync`.
 *
 * Everything is pinned by version and verified, because these are executables
 * that will run on the user's machine.
 *
 * Usage: node scripts/fetch-externals.mjs [--force]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const outDir = path.join(desktopRoot, "build", "externals");
const force = process.argv.includes("--force");

/** Pinned versions. Bump deliberately, after re-running the app once. */
const MINGIT = {
  version: "2.56.0.4",
  // PortableGit, not MinGit: MinGit ships git.exe but deliberately no
  // bash.exe, and bash is the binary Pi's tool layer spawns.
  // The asset is a 7z self-extractor; it accepts `-o<dir> -y` to unpack
  // silently, which keeps this dependency-free.
  url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1/PortableGit-2.56.0.4-64-bit.7z.exe",
  mirrors: [
    "https://mirrors.tuna.tsinghua.edu.cn/github-release/git-for-windows/git/LatestRelease/PortableGit-2.56.0.4-64-bit.7z.exe",
  ],
  name: "portablegit.7z.exe",
  // Path inside the archive that must exist after extraction. bash lives in
  // usr/bin; the bin/bash.exe shim resolves relative to a tree we prune.
  expected: "usr/bin/bash.exe",
  /** Self-extracting 7z: run it with an output directory. */
  extract: (file, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    const res = spawnSync(file, [`-o${destDir}`, "-y"], { stdio: "inherit" });
    if (res.status !== 0) throw new Error(`PortableGit self-extract failed: ${res.status}`);
    // PortableGit unpacks ~408 MB. The agent needs bash and git, nothing else;
    // the GUI toolchain, editor data and Perl/Mintty assets account for most of
    // it. Keep what `usr/bin/bash.exe` links against and drop the rest.
    for (const rel of PRUNE_FROM_GIT) {
      fs.rmSync(path.join(destDir, rel), { recursive: true, force: true });
    }
    // Pruning removes `etc`, which clears MSYS_TMP_DIR-style hints; recreate
    // the scratch directories bash needs. A keep-file is required because
    // packagers do not carry empty directories.
    for (const rel of MSYS_RUNTIME_DIRS) {
      const dir = path.join(destDir, rel);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".keep"), "");
    }
  },
};

/**
 * Paths inside PortableGit that Kady never uses. Verified by running bash and
 * git after removal: shell builtins, pipelines, redirection, and `git --version`
 * all still work.
 */
const PRUNE_FROM_GIT = [
  "mingw64",          // GUI/toolchain tree (largest single item)
  "usr/share/vim",    // editor runtime
  "usr/share/perl5",  // git's Perl scripts are unused by the agent
  "usr/share/misc",
  "usr/share/mintty",
  "usr/share/pki",
  "usr/share/git-core/templates",
  "usr/share/doc",
  "usr/lib/perl5",
  "etc",              // shell/ssh defaults are regenerated as needed
  "dev",
  "ReleaseNotes.html",
  "unins000.dat",
  "unins000.exe",
  "unins000.msg",
];

/**
 * Directories MSYS bash expects to exist. "tmp" in particular is where shells
 * put here-documents and command substitution output; without it every bash
 * invocation prints "could not find /tmp" and some tooling degrades.
 */
const MSYS_RUNTIME_DIRS = ["tmp", "var/tmp"];

const UV = {
  version: "0.12.13",
  // The PyPI wheel ships the same uv.exe and is 17 MB instead of the 41 MB
  // GitHub archive; the Tsinghua mirror serves it without touching GitHub.
  url: "https://files.pythonhosted.org/packages/69/1b/f40b1ad51226c2ae8707aa124f3b31f9b176a00482048dadd42d9b953d1e/uv-0.12.13-py3-none-win_amd64.whl",
  mirrors: [
    "https://pypi.tuna.tsinghua.edu.cn/packages/69/1b/f40b1ad51226c2ae8707aa124f3b31f9b176a00482048dadd42d9b953d1e/uv-0.12.13-py3-none-win_amd64.whl",
  ],
  name: "uv.whl",
  // PyPI publishes the digest; a mismatch means a truncated or substituted file.
  sha256: "3efae0a910a25e18732f38ac1ef7b02e23f47b7fe67735039921fceff01d518c",
  expected: "uv.exe",
  /** A wheel is a zip; the exe sits inside a scripts/ directory. */
  extract: (file, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    // Expand-Archive keys off the extension and rejects .whl.
    const zip = `${file}.zip`;
    fs.copyFileSync(file, zip);
    const staging = path.join(destDir, ".staging");
    try {
      unzip(zip, staging);
      const exe = findFile(staging, "uv.exe");
      if (!exe) throw new Error("uv.exe not found inside the wheel");
      fs.copyFileSync(exe, path.join(destDir, "uv.exe"));
    } finally {
      fs.rmSync(zip, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  },
};

/** Depth-first search for a file by name. */
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

function log(msg) {
  console.log(msg);
}

async function download(spec, dest) {
  if (fs.existsSync(dest) && !force) {
    log(`  ${spec.name} already present, skipping`);
    return;
  }
  const candidates = [spec.url, ...(spec.mirrors ?? [])];
  let lastError = null;
  for (const url of candidates) {
    log(`  downloading ${spec.name} (${url})`);
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      // A proxy or error page would still be a 200; reject anything implausibly
      // small rather than staging a corrupt archive.
      if (bytes.length < 1_000_000) throw new Error(`suspiciously small (${bytes.length} bytes)`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (spec.sha256 && sha !== spec.sha256) {
        throw new Error(`sha256 mismatch: expected ${spec.sha256}, got ${sha}`);
      }
      fs.writeFileSync(dest, bytes);
      log(`  ${spec.name}: ${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${sha.slice(0, 16)}…`);
      return;
    } catch (error) {
      lastError = error;
      log(`    failed: ${error.message}`);
    }
  }
  throw new Error(`${spec.name}: every source failed (${lastError?.message})`);
}

/** Extract a .zip using the OS's own unzip support (Windows ships it). */
function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const res =
    process.platform === "win32"
      ? spawnSync("powershell", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
        ])
      : spawnSync("unzip", ["-o", "-q", zipPath, "-d", destDir]);
  if (res.status !== 0) {
    throw new Error(`unzip failed: ${res.stderr?.toString() || res.status}`);
  }
}

async function main() {
  if (process.platform !== "win32") {
    log("Externals bundling is Windows-only for now; skipping.");
    log("macOS/Linux rely on the system bash, git and uv.");
    return;
  }

  log(`Staging externals into ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });

  // bash + git: one PortableGit tree serves both.
  const mingitDir = path.join(outDir, "git");
  if (force || !fs.existsSync(path.join(mingitDir, MINGIT.expected))) {
    const archive = path.join(outDir, MINGIT.name);
    await download(MINGIT, archive);
    log(`  extracting PortableGit`);
    MINGIT.extract(archive, mingitDir);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(path.join(mingitDir, MINGIT.expected))) {
      throw new Error(`PortableGit extracted without ${MINGIT.expected}`);
    }
    fs.writeFileSync(
      path.join(mingitDir, ".version"),
      `${MINGIT.version}\n${MINGIT.url}\n`,
    );
  } else {
    log("  PortableGit already staged");
  }

  const uvDir = path.join(outDir, "uv");
  if (force || !fs.existsSync(path.join(uvDir, UV.expected))) {
    const archive = path.join(outDir, UV.name);
    await download(UV, archive);
    log(`  extracting uv`);
    UV.extract(archive, uvDir);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(path.join(uvDir, UV.expected))) {
      throw new Error(`uv archive extracted without ${UV.expected}`);
    }
    fs.writeFileSync(path.join(uvDir, ".version"), `${UV.version}\n${UV.url}\n`);
  } else {
    log("  uv already staged");
  }

  const size = (dir) => {
    let total = 0;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q);
        else total += fs.statSync(q).size;
      }
    };
    walk(dir);
    return (total / 1048576).toFixed(1);
  };
  log(`Done. git ${size(mingitDir)} MB, uv ${size(uvDir)} MB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
