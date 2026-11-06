# K-Dense BYOK Desktop

[English](README.en.md) | [简体中文](README.md)

Kady is a research assistant that runs on your own machine. You put your data files into a project, describe what you want in plain language, and it reads the files, writes code, runs the analysis, makes the figures, and keeps a record of what it did.

Everything happens locally. Models are called through your own account, and your data does not pass through us.

![Kady](docs/app-screenshot.png)

---

## What it does for you

**Analyse data.** Upload a table, a set of sequencing results, a micrograph — say what you want to know. Kady inspects the data first, then gets to work.

> "Compare treated and control samples in `counts.csv`; genes are rows. Run QC first, save the analysis script, then plot the results."

It shows you what it found before running off with it.

**Read scientific files.** Tables, PDFs, Markdown, Jupyter notebooks, sequence files, molecular structures, mass spectra and microscopy images preview directly. LaTeX papers compile to PDF with two-way SyncTeX — click a word in the PDF to jump to the source, or the other way round.

**Write and edit documents.** Word, Excel and PowerPoint preview in place; "Edit in Office" opens an editor page backed by a real office engine rather than a cut-down preview.

**Leave a record you can check.** The Lab Notebook keeps hypotheses, methods, observations and conclusions in order. A file's provenance answers "which script made this figure, from which data, and when" — and that answer comes from observed execution, not from the model's own claim.

**Bring in specialists.** Several agents can work on different parts of one task at once — one reads the literature, one runs the analysis, one reviews the result. You can watch each of them work.

**Run long jobs off the machine.** Send heavy compute to the cloud; it keeps running after you close the laptop, and the results are waiting when you return.

**Run on a schedule.** Rerun a data check every morning, or produce a weekly summary. These record their cost.

---

## Getting started

### Install

**Windows** — Download `Kady-<version>-x64-Setup.exe` from [Releases](https://github.com/YuEr159/k-dense-desktop/releases) and run it. The first launch creates a data directory under `%APPDATA%/Kady/`.

Windows shows a SmartScreen warning. The installer has no code-signing certificate, so the system does not recognise the publisher. That is expected: choose More info → Run anyway.

**macOS** — Download `Kady-<version>-mac-arm64.dmg` (Apple Silicon) or `Kady-<version>-mac-x64.dmg` (Intel) and drag it into Applications.

The app is ad-hoc signed and not notarized, so the first launch needs one approval under System Settings → Privacy & Security. Apple Silicon requires macOS 12 or later.

macOS needs a working Git on the system; if it is missing, run `xcode-select --install` and reopen the app. See [desktop/MACOS.md](desktop/MACOS.md) for details.

### The first launch takes a while

A progress screen appears while two things are prepared:

- **The skill library** (about 460 MB, once) — a set of ready-made scientific workflows. Later projects copy from it locally.
- **The Python environment** (about 555 MB, once) — the decoders behind file previews.

The interface is usable during this. Previewing some file types says dependencies are missing until it finishes, then recovers on its own. Both downloads happen once; later launches take seconds.

Downloads can fail on a restricted network. A failed skill library does not block anything — retry from **Settings → Project · <name> → Skills**.

### Connect a model

The first thing to do is connect a model under **Settings → Models → Providers**.

Kady does not sell models or resell quota — it uses your own account, and the provider bills you directly. Three options:

| Option | Who it suits |
|---|---|
| **Subscription sign-in** | You already have ChatGPT Plus, Claude Pro, GitHub Copilot or similar; authorise once, no extra charge |
| **API key** | You have a key from OpenRouter, Anthropic, OpenAI or anyone else; billed per use |
| **Local model** | You run Ollama or LM Studio; free, fully offline |

You can open the app without one to look around; it just cannot send messages.

### Create a project, ask a question

1. Create a project and drag your data into the file panel on the left
2. Choose a model and thinking level below the input box
3. Describe the problem — what the data is, what you want out

The model shows its work as it goes. Where a decision is genuinely yours, it stops and asks in an inline form rather than guessing.

---

## Using the interface

Three areas: files on the left, previews and editors in the middle, chat on the right.

**Adjust the layout.** Drag the divider between panes to resize; click the ends of a divider to swap two panes. Hide any pane from **Settings → Workspace → Appearance**. The same page caps how wide the chat text gets, keeping it centred.

**Long runs.** You can interject mid-run to add a requirement, or queue a message to send afterwards. A run keeps going in the background if you close its tab.

**Cost.** The header shows what this session and the project have spent. Set a project limit under **Settings → Project · <name> → General**; work stops when it is reached. Models reached through a subscription do not count toward it.

**Language.** The interface follows your browser language — Chinese when the browser prefers it, English otherwise — and switches any time under **Settings → Workspace → Appearance → Language**.

**Closing the window does not quit.** By default the window goes to the tray and background work keeps running. Click the tray icon to bring it back; the context menu quits for real. Set it to quit on close under **Settings → Workspace → Appearance**.

---

## Common questions

**Where does my data go?** Nowhere. Windows keeps it in `%APPDATA%/Kady/data/`, macOS in `~/Library/Application Support/Kady/data/`. That holds your `.env` (saved keys), `projects/` (files and chat history) and the Python environment. Upgrading the app does not overwrite it.

**How much will it cost?** It depends on the model and how much you run. Subscription sign-in costs nothing extra. API keys are billed at the provider's rates; the figure in the header is an estimate, and the provider's invoice is the final word.

**Does it work offline?** With a local model (Ollama), yes — apart from the one-time skill-library and Python downloads.

**What if the model gets something wrong?** It shows which files it used and what code it ran. The provenance panel on a file traces every claim back to an actual execution record. You still need to check the conclusions yourself — it can be wrong, but the mistake is traceable.

**Why does Windows warn about the installer?** The installer has no code-signing certificate. That is common for individually maintained projects. It does not mean the program is unsafe, but it does mean the system cannot vouch for the publisher.

---

## More

- [Basic usage](docs/basic-usage.md) — the full workflow
- [Sub-agents and specialists](docs/sub-agents.md) — working in parallel
- [Lab Notebook](docs/lab-notebook.md) — records, citations and export
- [File previews](docs/file-previews.md) — supported formats
- [Cloud compute](docs/modal-compute.md) — sending large jobs elsewhere
- [Model selection](docs/model-selection.md) — how each provider bills

Bugs and feature requests go in [Issues](https://github.com/YuEr159/k-dense-desktop/issues).

---

<details>
<summary><b>For developers</b> — building, architecture and implementation notes</summary>


### Build from source

```bash
cd desktop
npm install
npm run dist        # Windows installer
npm run dist:mac    # macOS .app + DMG + ZIP (ad-hoc signed)
```

Artifacts land in `dist/` at the repository root (`directories.output` is `../dist`, not `desktop/dist`). The ad-hoc macOS build pins `identity=-` and its own entitlements, so no signing certificate is involved; with a Developer ID, use `npm run dist:mac:signed`.

> Behind a restricted network, use mirrors (direct GitHub access times out):
> ```bash
> cd desktop
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
> ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
> npx electron-builder --config electron-builder.json --win
> ```

`npm run dist` chains six steps: build the frontend (`build-web.mjs`), generate the icon (`make-icon.mjs`), compile the payload (`build-runtime.mjs`), smoke-test that the packaged backend can create a session (`verify-runtime-session.mjs`), download and trim PortableGit and uv (`fetch-externals.mjs`), and verify the bundle with only itself on PATH (`verify-externals.mjs`) — then hand off to electron-builder.

### Development mode (from source)

```bash
cd desktop && npm start
```

Requires `server/node_modules`, `web/node_modules` and `web/.next` to already exist (`npx next build`, or `npm run build:web`).

### Test the packaged payload (no installer)

```bash
node desktop/scripts/build-runtime.mjs
node desktop/scripts/fetch-externals.mjs
node desktop/scripts/verify-externals.mjs   # bundle-only PATH: proves self-sufficiency
cd desktop && KADY_RUNTIME_DIR=./build/runtime npm start
```

### Run the packaged app (without installing)

```bash
./dist/win-unpacked/Kady.exe
```

### Architecture

```
Kady.exe / Kady.app
  ├─ app.asar              shell code (main.mjs / service-manager.mjs / preflight.mjs)
  └─ resources/
       ├─ runtime/          the payload (identical on both platforms)
       │    ├─ server/src/**/*.mjs     backend (compiled file by file, tree preserved)
       │    ├─ server/node_modules/    every production dependency, transitive ones included
       │    ├─ server/pi-packages/     Pi extension packages
       │    ├─ server/src/helpers/     Python decoders behind scientific previews
       │    ├─ web/                    Next standalone output
       │    └─ models.json             model price catalogue
       └─ externals/        bundled binaries (Windows only)
            ├─ git/         PortableGit, trimmed (bash.exe + git)
            └─ uv/          uv.exe
```

The macOS build bundles uv only: bash and git come from the system, so `externals/git/` does not exist there.

**Runtime data** (never touched by an upgrade):
- Windows: `%APPDATA%/Kady/data/`
- macOS: `~/Library/Application Support/Kady/data/`

(`KADY_DESKTOP_USER_DATA` moves this wholesale.) Contents:
- `.env` — the user's saved API keys
- `projects/` — project files and chat history
- `python/helpers/` — the Python venv behind previews (~555 MB, built by `uv sync` on first launch)

Upgrades do **not** overwrite it: the app itself lives in `%LOCALAPPDATA%\Programs\Kady` / `/Applications/Kady.app` and is replaced as a whole, which is exactly why the venv sits in the data directory — otherwise every update would rebuild it.

### Implementation decisions worth knowing

**The backend is not bundled into one file.** `server/src` has seven `import.meta.dirname`-relative paths (`../../pi-packages`, `../../node_modules`, `./subagent-host.mjs`, `../helpers`). A single-file bundle breaks every one of them — they all resolve against the file's own directory — so `.ts → .mjs` is compiled file by file with the directory structure preserved.

**`web/src/lib` has to be compiled too.** Twenty-eight backend files import shared logic straight from `web/src/lib/*.ts` (`chat-snapshot.ts`, `compaction-bridge.ts`, …), so the two are coupled at compile time. The build resolves that closure and compiles it into `runtime/web/src/lib/`. Those files import each other **without extensions** (Next's bundler resolves that; Node ESM does not), and the build appends `.mjs` automatically.

**`pi-packages` keeps both `.ts` and `.mjs`.** Pi reads `.ts` through its own loader (`pi.extensions` in `package.json`); the backend needs `.mjs` to `import` directly from Node.

**`ELECTRON_RUN_AS_NODE` instead of code changes.** The backend has three `spawn(process.execPath, …)` sites (MCP client, skill download). Inside Electron `process.execPath` is `electron.exe`, so a bare spawn opens another window instead of running a script. With `ELECTRON_RUN_AS_NODE=1`, `electron.exe` behaves as a plain Node runtime. The variable was verified to survive into grandchildren (`piCliEnv`/`skillsCliEnv` both spread `{...process.env}`), so **none of those three sites needed a change**.

**bash is selected through Pi's `shellPath`.** `getShellConfig()` resolves in this order: `shellPath` in `settings.json` → `Program Files\Git` → `PATH`. On startup the shell writes the bundled bash path into `<agentDir>/settings.json`, where it outranks any older Git on the user's machine. If that path no longer exists (the app moved), it is replaced automatically.

**PortableGit, not MinGit.** **MinGit ships no `bash.exe`** (only `git.exe` and `dash.exe`), and bash is what the agent runs every command through. PortableGit 2.56 unpacks to 342 MB; trimming vim, mintty, man/doc and git-gui/gitk brings it to about **299 MB**.

> **`ucrt64/` and `mingw64/` must stay**: they hold git itself (`git.exe` and the DLLs it links) and `libexec/git-core/` (the subcommands behind `git clone`). An earlier build deleted the whole `mingw64/` tree as a "GUI toolchain", which produced `git: command not found` — invisible on a machine that had system Git installed. `scripts/verify-externals.mjs` runs with a bundle-only PATH specifically to catch this.

PortableGit 2.56 moved the toolchain from `mingw64/` to `ucrt64/`; the script probes for either rather than pinning a name, so a version bump cannot break it silently.

**`KADY_RUNTIME_DIR` stays as an escape hatch.** Even though updates replace the package wholesale, the payload directory can be overridden by an environment variable, so a bad build can be hot-fixed by swapping the payload instead of shipping a new release.

### Closing the window

By default **closing the window means going to the tray**, and the process keeps running. Background work (Modal jobs, schedules) therefore survives the window closing; at the same time the renderer (~274 MB) is reclaimed, dropping idle usage from roughly 750 MB to 300 MB.

Clicking the tray icon restores the window, and the context menu reopens it or quits for real. Set "Closing the window" to **quit** under Settings → Appearance for the classic behaviour: close ends everything, asking once first if a run is active.

The data directory and ports are released only on quit; in the tray state the ports remain bound, deliberately — otherwise the next launch would find a second backend.

Ports are per platform: 3000/8000 on Windows, 47822/47821 on macOS. The latter avoids port 3000, which is routinely taken on macOS.

Both platforms add one more guard: the shell generates a random token per launch and hands it to the backend, and the health check must echo it before the backend counts as ours. Without that, a probe against a port held by some other program would succeed, and the window would open onto someone else's data directory.

### Chinese interface

The interface follows the browser language: Simplified Chinese when the browser prefers it, English otherwise. Switch any time under Settings → Workspace → Appearance → Language.

Translation is **runtime text replacement**, not `t()` calls wrapped around every string. The upstream repository is the source of truth for this code and we merge from it regularly — every `t("...")` would be a line upstream might also be editing. Rewriting the DOM after render means we own a single dictionary file and merges stay conflict-free; when upstream rewords a string, that one line falls back to English, a visible degradation rather than a wrong translation.

Design details, known blind spots and how to add translations: [web/docs/i18n.md](web/docs/i18n.md).

### What the first launch does

The window opens on a progress page that reads `setup.helpers.state` from `/health`. The first launch installs ~555 MB of Python packages (the decoders behind scientific previews), which takes several minutes; the UI is already usable during this, with file previews reporting missing dependencies until it finishes.

`uv sync` runs in the background rather than blocking, so the backend port is ready immediately and the health check does not hang.

### Bundled binaries

| Component | Platform | Source | Size |
|---|---|---|---|
| PortableGit 2.56.0.4 (trimmed) | Windows | GitHub / Tsinghua mirror | 299 MB |
| uv 0.12.13 | both | PyPI wheel (SHA-256 verified) | 40 MB |

Both are pinned by version and record where they came from. The download script tries GitHub first and falls back to a mirror (direct GitHub access timed out on the development machine). macOS takes uv only: bash and git come from the system, and `verify-externals.mjs` checks just uv there.

### Versions and releases

`version` in `desktop/package.json` decides the installer filename and is the single switch for cutting a release.

To release, tag `v<version>` and push; `release-desktop.yml` runs three jobs in parallel — Windows produces the `.exe`, macOS produces arm64 and x64 `.dmg` + `.zip` — all attached to one Release.

A tag may be written `v0.15.0d3` or normalised as `v0.15.0-d3`: electron-builder's loose semver normalises the suffix to `-d3`, so both spellings have to match. Upstream's `release.yml` also fires on `v*` tags; its `check` job compares the version in `desktop/package.json` and skips the build when they disagree.

macOS builds run on `macos-15` (arm64) and `macos-15-intel` (x64) separately, and each job asserts `process.arch` against its matrix entry first — this is what prevents "an arm64 payload built on Intel" from shipping as an app that will not open. After packing, `codesign --verify --deep --strict` confirms the signature.

### Verified

**Windows**

| Item | Result |
|---|---|
| `next build` standalone | succeeds, runs standalone |
| Payload starts on its own | `/health` 200, `/projects` 200 |
| Electron + payload (dev) | window opens, UI 200 |
| **Packaged `Kady.exe`** | window title correct, `/health` 200, UI 200 |
| Bundled bash runs commands | `BUNDLED_BASH_OK`, `git 2.56`, `uv 0.12.13`, exit 0 |
| **Bundle-only PATH check** | 10/10: bash, git, uv, pipes, heredoc, `git init`, HTTPS clone; `git` resolves inside the bundle |
| **Packaged build online** | isolated check re-run against the installed `externals/git`, all pass; `git ls-remote` returns remote branches |
| `shellPath` written | points at the installed bash |
| Data directory | `%APPDATA%/Kady/data/` |
| `/tmp` usable | temp file read/write works |
| Shutdown cleanup | zero leftover processes, ports released |

**macOS**

| Item | Result |
|---|---|
| arm64 / x64 built separately | each runner's `process.arch` assertion passes |
| `codesign --verify --deep --strict` | ad-hoc signature verifies |
| DMG / ZIP produced and uploaded | pass |

macOS has **not** had runtime verification to the depth of the Windows table: the Intel payload has only been built on an Intel runner, never run on a real Intel Mac. For the specific artifacts, checks and limits, consult the build report shipped with the release (see [desktop/MACOS.md](desktop/MACOS.md)).

### Environment variables

| Variable | Purpose |
|---|---|
| `KADY_RUNTIME_DIR` | Payload directory (point it at `build/runtime`) |
| `KADY_DATA_ROOT` | Backend writable root (injected by the shell) |
| `KADY_DESKTOP_USER_DATA` | Override the Electron userData root (default `%APPDATA%/Kady`, `~/Library/Application Support/Kady`) |
| `KADY_MODELS_CATALOGUE` | Path to the model catalogue JSON |
| `KADY_FRONTEND_PORT` | Frontend origin port the backend trusts (CORS) |
| `KADY_PORT` | Backend listen port |
| `KADY_PYPI_INDEX` | Package index for `uv sync` (also settable in Settings → Services). Defaults to PyPI |
| `KADY_SKILLS_AUTO_SYNC` | Set to `0` to skip the launch and daily catalogue sync. Useful offline or on a metered link |
| `HTTPS_PROXY` / `HTTP_PROXY` | Outbound proxy, read once at startup; restart after changing |

### Not yet done

- **Shell test coverage gaps**: the `desktop` job in `tests.yml` runs 9 of the 11 files in `desktop/test/` on Windows and Linux. The two missing: `lifecycle.test.mjs` (service start/stop, process-tree termination) runs only in the macOS workflow's `npm test` — on Windows it skips itself, because Windows kills the tree with `taskkill /T /F` rather than the POSIX behaviour it asserts; `macos.test.mjs` runs on macOS only. One case in `runtime-files.test.mjs` skips on Windows because it depends on symlinks.
- **Code signing**: neither Windows nor macOS has a certificate, so users get SmartScreen / one approval under Privacy & Security; neither constitutes a "verified publisher". The configuration itself is ready: electron-builder skips signing when `WIN_CSC_LINK` is absent, and adding certificate variables in CI makes the next build sign automatically. Do not add `signExecutable: false` — it is a hard switch that would keep the build unsigned even with a certificate configured.
- **Auto-update**: not implemented. macOS's ad-hoc signature would fail Squirrel.Mac's update check outright, so signing has to come first.
- **First-launch Python environment**: `uv sync` builds two venvs (sandbox + preview helper); it takes several minutes and needs network. A cold install of the preview helper measured 553 MB; the default PyPI took 17 minutes on a constrained network versus 26 seconds through a regional mirror.
- **Skill library network dependency**: the first run downloads the 460 MB upstream catalogue, and an unstable link reports `SSL/TLS handshake` or `invalid index-pack output` — system Git fails the same way with the same command, so this is not the bundled build's fault. The whole download has a two-minute ceiling (`CATALOGUE_DEADLINE_MS`); concurrent callers share one download, the staging trees are refcounted, and `sandbox/init` waits only for the local part while remote seeding continues in the background. Staging lives in `~/.kady/skills-cache/` (override with `KADY_SKILLS_CACHE_DIR`), keyed by source and a hash; each sync clears its directory and re-downloads rather than reusing it. A failed download does not block use, and Settings → Skills retries it.
- **Linux**: configuration remains unverified and is not in CI.

### Upstream

This repository packages [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok) for the desktop. The upstream project's own documentation is in [README.upstream.md](README.upstream.md).

</details>

## License

MIT. Based on [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok), Copyright K-Dense Inc.
