# K-Dense BYOK Desktop

**macOS fork:** See [Mac installation and build instructions](desktop/MACOS.md). Apple Silicon and Intel build targets are separate; consult the build report for tested coverage.

[English](README.en.md) | [简体中文](README.md)

Packages the two local services of [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok) into a single Windows / macOS desktop app. Every Node dependency is bundled; the Windows build also bundles bash and git, while the macOS build bundles uv and uses the system bash and Git.

For the upstream project's own documentation, see [README.upstream.md](README.upstream.md).

## Install

**Windows** — Download `Kady-<version>-x64-Setup.exe` from [Releases](https://github.com/YuEr159/k-dense-desktop/releases) and run it. The first launch creates the data directory under `%APPDATA%/Kady/`. Windows shows a SmartScreen warning: the installer is not code-signed.

**macOS** — Download `Kady-<version>-mac-arm64.dmg` (Apple Silicon) or `Kady-<version>-mac-x64.dmg` (Intel) and drag it into Applications. The first launch creates the data directory under `~/Library/Application Support/Kady/data/`. The app is ad-hoc signed and not notarized, so a downloaded copy needs one approval under System Settings → Privacy & Security; macOS 12 or later is required.

macOS needs a working Git on the system; if startup reports it missing, run `xcode-select --install` and reopen. Installation and data details are in [desktop/MACOS.md](desktop/MACOS.md).

## Build from source

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

`npm run dist` runs three steps: compile the payload (`build-runtime.mjs`), download and trim PortableGit and uv (`fetch-externals.mjs`), then package with electron-builder.

### Development mode (from source)

```bash
cd desktop && npm start
```

Requires `server/node_modules`, `web/node_modules` and `web/.next` to already exist (run `npx next build`).

### Test the packaged payload (no installer)

```bash
node desktop/scripts/build-runtime.mjs
node desktop/scripts/fetch-externals.mjs
node desktop/scripts/verify-externals.mjs   # PATH limited to bundled dirs, checks self-sufficiency
cd desktop && KADY_RUNTIME_DIR=./build/runtime npm start
```

### Run the packaged app (without installing)

```bash
./dist/win-unpacked/Kady.exe
```

## Architecture

```
Kady.exe
  ├─ app.asar              Shell code (main.mjs / service-manager.mjs / preflight.mjs)
  └─ resources/
       ├─ runtime/         Application payload
       │    ├─ server/src/**/*.mjs     Backend (compiled file by file, directory structure kept)
       │    ├─ server/node_modules/    438 production dependencies
       │    ├─ server/pi-packages/     Pi extension packages
       │    ├─ server/src/helpers/     Python decoders for scientific previews
       │    ├─ web/                    Next standalone output
       │    └─ models.json             Model price catalogue
       └─ externals/        Bundled binaries
```

The `version` in `desktop/package.json` determines the installer filename and is the only release switch.

To release, tag `v<version>` and push; `release-desktop.yml` runs three jobs in parallel: Windows produces the `.exe`, macOS produces both arm64 and x64 `.dmg` + `.zip`, all attached to the same Release.

Both `v0.15.0d3` and the normalized `v0.15.0-d3` are accepted: electron-builder rewrites the suffix through semver's loose mode, so either spelling has to match. Upstream's `release.yml` also fires on `v*` tags, so the `check` job compares against `desktop/package.json` and skips the build when it disagrees.

The macOS jobs run on `macos-15` (arm64) and `macos-15-intel` (x64) separately and assert `process.arch` against the matrix first, so an arm64 payload can never be produced on an Intel runner; each finishes with `codesign --verify --deep --strict`.

## Verified

### Windows

| Item | Result |
|---|---|
| `next build` standalone | Succeeds, runs independently |
| Payload starts on its own | `/health` 200, `/projects` 200 |
| Electron + payload (dev) | Window renders, UI 200 |
| **Packaged `Kady.exe`** | Window title correct, `/health` 200, UI 200 |
| Bundled bash runs commands | `BUNDLED_BASH_OK`, `git 2.56`, `uv 0.12.13`, exit 0 |
| **Isolated PATH check** | All 10 pass: bash / git / uv / pipes / heredoc / git init / HTTPS clone; `git` resolves inside the bundled directory |
| **Packaged build with network** | Isolated check re-run against the installed `externals/git`; `git ls-remote` returns remote branches |
| `shellPath` written | Points at the installed bash |
| Data directory | `%APPDATA%/Kady/data/` |
| `/tmp` usable | Temp file read/write works |
| Shutdown cleanup | No residual processes, ports released |

### macOS

| Item | Result |
|---|---|
| arm64 / x64 build separately | Each runner's `process.arch` assertion passes |
| `codesign --verify --deep --strict` | Ad-hoc signature verifies |
| DMG / ZIP produced and uploaded | Yes |

macOS has **not** had the same runtime verification depth as the Windows table: the Intel payload has only been built on an Intel runner, never run on a real Intel Mac. Exact artifacts, tests and limits of a delivered build are in the accompanying build report (see [desktop/MACOS.md](desktop/MACOS.md)).

## Environment variables

| Variable | Purpose |
|---|---|
| `KADY_RUNTIME_DIR` | Points at the payload directory (`build/runtime`) |
| `KADY_DATA_ROOT` | Backend's writable root (injected by the shell) |
| `KADY_DESKTOP_USER_DATA` | Overrides the Electron userData root (`%APPDATA%/Kady`, `~/Library/Application Support/Kady`) |
| `KADY_MODELS_CATALOGUE` | Path to the model catalogue JSON |
| `KADY_FRONTEND_PORT` | Frontend origin port the backend trusts (CORS) |
| `KADY_PORT` | Backend listen port |
| `HTTPS_PROXY` / `HTTP_PROXY` | Outbound proxy, read at startup only — restart after changing |

## Closing the window

By default, **closing the window sends the app to the tray** and the process keeps running. Background work — Modal jobs, scheduled runs — should not stop just because the window was dismissed; destroying the window also reclaims the renderer (~274 MB), dropping the resident footprint from roughly 750 MB to about 300 MB.

Double-click the tray icon to bring the window back; its context menu reopens the app or quits it outright. Settings → Appearance → System switches "on window close" to **Quit**, the classic behaviour: closing ends everything, and if work is in flight it asks first.

The data directory and ports are only released on quit. Under tray mode the ports stay bound — deliberately, or the next launch would find two backends.

Ports differ by platform: 3000/8000 on Windows, 47822/47821 on macOS. The latter avoids the frequently-occupied 3000.

Both platforms get one more guard: the shell mints a random token per launch and hands it to the backend, which must echo it from `/health` before the shell treats it as "our backend". Without that, a readiness probe against an occupied port succeeds against someone else's server, and the window opens onto a different data directory.

## Chinese interface

The interface ships in Simplified Chinese by default (English when the browser language is not Chinese). Switch it under **Settings → Appearance → Language**.

Translation is done by **rewriting text at runtime**, not by wrapping components in `t()`. The upstream repository is the source of truth for this tree and we merge it regularly — every `t("...")` is a line upstream may also touch. Rewriting the DOM after render means the dictionary is the only file we own, upstream merges never conflict, and a string upstream renamed simply falls back to English: a visible degradation rather than a mistranslation.

Design notes, known gaps and how to add a translation are in [web/docs/i18n.md](web/docs/i18n.md).

## Not yet done

- **Shell tests on Windows**: `desktop/test/` only runs in `macos-desktop.yml`; `tests.yml` does not cover `desktop/`. Windows is the primary release platform, yet the shell has no test coverage there.
- **Code signing**: Windows has `signExecutable: false` and shows a SmartScreen warning; macOS is ad-hoc signed and not notarized, so a downloaded copy needs one approval under Privacy & Security. Neither establishes a verified publisher.
- **Auto-update**: not implemented. macOS's ad-hoc signature would fail Squirrel.Mac's update check outright, so signing has to come first.
- **First-launch Python environment**: `uv sync` builds two venvs (sandbox + preview helper); it takes several minutes and needs network
- **Skill library network dependency**: the `skills` CLI re-clones the upstream repo (460 MB) on every sync, and reports `SSL/TLS handshake` or `invalid index-pack output` when the network is unstable. System Git fails the same way with the same command, so this is not the bundled build's fault. Fetched caches land in `%TEMP%/kady-desk-skills/`, but the CLI does not reuse them
- **Linux**: configuration remains unverified and is not in CI.

## License

MIT. Based on [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok), Copyright K-Dense Inc.
