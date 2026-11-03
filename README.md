# K-Dense BYOK 桌面版

**macOS fork:** See [Mac installation and build instructions](desktop/MACOS.md). Apple Silicon and Intel build targets are separate; consult the build report for tested coverage.

[简体中文](README.md) | [English](README.en.md)

把 [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok) 的两个本地服务装进一个 Windows / macOS 桌面应用。安装包自带全部 Node 依赖；Windows 包另外自带 bash 和 git，macOS 包自带 uv 并使用系统 bash 与 Git。

上游项目的说明见 [README.upstream.md](README.upstream.md)。

## 下载安装

**Windows** — 从 [Releases](https://github.com/YuEr159/k-dense-desktop/releases) 下载 `Kady-<version>-x64-Setup.exe` 并运行。首次启动会在 `%APPDATA%/Kady/` 下建数据目录。Windows 会弹 SmartScreen 警告：安装包未做代码签名。

**macOS** — 下载 `Kady-<version>-mac-arm64.dmg`（Apple Silicon）或 `Kady-<version>-mac-x64.dmg`（Intel），拖进「应用程序」。首次启动会在 `~/Library/Application Support/Kady/data/` 下建数据目录。应用是 ad-hoc 签名、未公证，下载副本需要在「系统设置 → 隐私与安全性」里批准一次；Apple Silicon 上系统要求 macOS 12 或更高。

macOS 需要系统已有可用的 Git；缺失时 `xcode-select --install` 安装后重开。已安装与数据迁移的完整说明见 [desktop/MACOS.md](desktop/MACOS.md)。

## 从源码构建

```bash
cd desktop
npm install
npm run dist        # Windows 安装包
npm run dist:mac    # macOS .app + DMG + ZIP（ad-hoc 签名）
```

产出在仓库根的 `dist/`（`directories.output` 是 `../dist`，不是 `desktop/dist`）。macOS 的 ad-hoc 构建显式固定 `identity=-` 和专用 entitlements，不涉及任何签名证书；有 Developer ID 时用 `npm run dist:mac:signed`。

> 网络受限时需要镜像（GitHub 直连会超时）：
> ```bash
> cd desktop
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
> ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
> npx electron-builder --config electron-builder.json --win
> ```

`npm run dist` 包含三步：编译载荷（`build-runtime.mjs`）、下载并裁剪平台二进制（`fetch-externals.mjs`）、electron-builder 打包。

### 开发模式（源码）

```bash
cd desktop && npm start
```

需要仓库已有 `server/node_modules`、`web/node_modules` 和 `web/.next`（`npx next build`，或 `npm run build:web`）。

### 用打包载荷测试（不生成安装包）

```bash
node desktop/scripts/build-runtime.mjs
node desktop/scripts/fetch-externals.mjs
node desktop/scripts/verify-externals.mjs   # 只留捆绑目录的 PATH，验证自足性
cd desktop && KADY_RUNTIME_DIR=./build/runtime npm start
```

### 运行打包后的应用（不安装）

```bash
./dist/win-unpacked/Kady.exe
```

## 架构

```
Kady.exe / Kady.app
  ├─ app.asar              壳代码（main.mjs / service-manager.mjs / preflight.mjs）
  └─ resources/
       ├─ runtime/          应用载荷（两平台相同）
       │    ├─ server/src/**/*.mjs     后端（逐文件编译，保留目录结构）
       │    ├─ server/node_modules/    438 个生产依赖
       │    ├─ server/pi-packages/     Pi 扩展包
       │    ├─ server/src/helpers/     科学预览的 Python 解码器
       │    ├─ web/                    Next standalone 产物
       │    └─ models.json             模型价格目录
       └─ externals/        捆绑的二进制（仅 Windows）
            ├─ git/         PortableGit（已裁剪，含 bash.exe + git）
            └─ uv/          uv.exe
```

macOS 包只捆绑 uv：bash 和 git 用系统的，`externals/git/` 不存在。

**运行时数据**（永不随安装包覆盖）：
- Windows：`%APPDATA%/Kady/data/`
- macOS：`~/Library/Application Support/Kady/data/`

（`KADY_DESKTOP_USER_DATA` 可整体改这个位置。）内容：
- `.env` — 用户保存的 API key
- `projects/` — 项目文件与对话历史
- `python/helpers/` — 科学预览的 Python venv（约 555 MB，首次启动时 `uv sync` 构建）

这个目录在升级时**不会**被覆盖：应用本体位于 `%LOCALAPPDATA%\Programs\Kady` / `/Applications/Kady.app`，是整包替换的，所以 venv 特意放在数据目录，否则每次更新都要重装一遍。

## 关键实现决策

### 后端不打成单文件

`server/src` 中有 4 处 `import.meta.dirname` 相对路径（`../../pi-packages`、`../../node_modules`、`./subagent-host.mjs`、`../helpers`）。单文件 bundle 会破坏这些解析，所以逐文件编译 `.ts → .mjs` 并保留目录结构。

### `web/src/lib` 也要编译

后端有 11 个文件直接从 `web/src/lib/*.ts` import 共享逻辑（`chat-snapshot.ts`、`compaction-bridge.ts` 等），两者是编译时耦合的。构建脚本会解析这个闭包并一并编译到 `runtime/web/src/lib/`。

这些文件内部相互 import 时**不带扩展名**（Next 打包器能解析，Node ESM 不能），构建时会自动补 `.mjs`。

### `pi-packages` 同时保留 `.ts` 和 `.mjs`

- Pi 用自己的 TS 加载器读 `.ts`（`package.json` 的 `pi.extensions`）
- 后端直接用 Node import 时需要 `.mjs`

### 用 `ELECTRON_RUN_AS_NODE` 而非修改代码

后端有 3 处 `spawn(process.execPath, ...)`（MCP 客户端、技能下载）。在 Electron 中 `process.execPath` 是 `electron.exe`，直接 spawn 会启动新窗口而非执行脚本。

设 `ELECTRON_RUN_AS_NODE=1` 后 `electron.exe` 表现为纯 Node 运行时。已验证该变量会被孙进程继承（`piCliEnv`/`skillsCliEnv` 都是 `{...process.env}` 展开），所以**这 3 处无需任何代码改动**。

### bash 通过 Pi 的 `shellPath` 指定

Pi 的 `getShellConfig()` 解析顺序是：`settings.json` 的 `shellPath` → `Program Files\Git` → `PATH`。壳在启动时把捆绑的 bash 路径写进 `<agentDir>/settings.json`，优先级最高，不受用户机器上旧版 Git 影响。

若 `shellPath` 指向的路径已不存在（应用移动位置后），会被自动替换。

### PortableGit 而非 MinGit

**MinGit 不含 `bash.exe`**（只有 `git.exe` 和 `dash.exe`），而 bash 正是 agent 执行命令的核心。必须用 PortableGit。

PortableGit 2.56 完整解压 342 MB。裁剪掉 vim、mintty、man/doc、git-gui/gitk 后约 **299 MB**。

> **`ucrt64/` 和 `mingw64/` 必须保留**：那是 git 本体（`git.exe` 及其链接的 DLL）和 `libexec/git-core/`（`git clone` 等子命令的实现）。早期版本曾把整个 `mingw64/` 当成"GUI 工具链"删掉，结果 `git: command not found`，而且因为本机装了系统 Git 而看不出问题。`scripts/verify-externals.mjs` 用只含捆绑目录的 PATH 验证，专门堵这个洞。

PortableGit 2.56 把工具链从 `mingw64/` 移到了 `ucrt64/`；脚本按存在性探测两者，版本升级不会静默失效。

### 保持 `KADY_RUNTIME_DIR` escape hatch

虽然是整包更新，但载荷目录可被环境变量覆盖。出问题时可以手工替换载荷热修，不必重新发版。

## 关闭窗口时

默认**关闭窗口 = 退到托盘**，进程继续运行。这样后台工作（Modal 任务、计划任务）不会因为关掉窗口就停掉；同时窗口销毁后渲染进程（约 274 MB）被回收，常驻占用从约 750 MB 降到约 300 MB。

托盘图标双击恢复窗口，右键菜单可以重新打开或彻底退出。设置 → 外观 → 系统里可以把「关闭窗口时」改成**退出应用**，那就是经典行为：关闭即结束，有任务在跑时会先问一次。

数据目录和端口在退出时才释放，托盘状态下端口仍被占用——这是有意的，否则下次启动会看到两个后端。

端口选择按平台分开：Windows 用 3000/8000，macOS 用 47822/47821。后者是为了避开 macOS 上动辄被占用的 3000。

两个平台都有一层额外的保护：壳每次启动生成一个随机 token 交给后端，健康检查必须回显它才被认作「我们自己的后端」。否则端口被别的程序占着时，探活会对着别人的服务成功，窗口打开后连着的是另一份数据目录。

## 中文界面

界面默认简体中文（浏览器语言不是中文时默认英文）。切换入口在 **设置 → 外观 → 语言**。

翻译层是**运行时文本替换**，不在组件里包 `t()`：上游仓库是这份代码的事实来源，我们定期合并，每个 `t("...")` 都是一行上游可能同时改动的代码。改成渲染后改写 DOM，我们只拥有一个字典文件，上游合并零冲突；上游改了某句文案，那句退回英文显示，是可见的降级而不是错译。

设计细节、覆盖盲区和加翻译的方法见 [web/docs/i18n.md](web/docs/i18n.md)。

## 首次启动会发生什么

窗口打开后显示进度页，按后端 `/health` 的 `setup.helpers.state` 更新文案。首次启动要装约 555 MB 的 Python 包（科学预览的解码器），耗时几分钟；这期间 UI 已经可用，只是文件预览会报"依赖缺失"，装完自动恢复。

`uv sync` 在后台跑（不是阻塞式），所以后端端口立刻就绪，不会卡住健康检查。

## 外部依赖补齐

| 组件 | 平台 | 来源 | 体积 |
|---|---|---|---|
| PortableGit 2.56.0.4（裁剪后） | Windows | GitHub / 清华镜像 | 299 MB |
| uv 0.12.13 | 两平台 | PyPI wheel（含 SHA-256 校验） | 40 MB |

两者都固定版本并记录来源。下载脚本优先走 GitHub，失败时自动回落镜像（本机实测 GitHub 直连超时）。macOS 只取 uv：bash 和 git 用系统的，`verify-externals.mjs` 在 macOS 上只验证 uv。

## 版本与发布

`desktop/package.json` 的 `version` 决定安装包文件名，也是发版的唯一开关。

发版时打 tag `v<version>` 并推送，`release-desktop.yml` 会并行跑三个 job：Windows 出 `.exe`，macOS 出 arm64 和 x64 两份 `.dmg` + `.zip`，都附加到同一个 Release。

tag 同时支持 `v0.15.0d3` 和归一化后的 `v0.15.0-d3`——electron-builder 用 semver 的 loose 模式把后缀规范成 `-d3`，所以两种拼写都要能匹配上。上游的 `release.yml` 也会在 `v*` tag 上触发，`check` job 比对 `desktop/package.json` 的版本，不匹配就不构建。

macOS 构建在 `macos-15`（arm64）和 `macos-15-intel`（x64）两个 runner 上分别进行，job 里先断言 `process.arch` 与矩阵一致，防止出现「在 Intel 上产出 arm64 载荷」这种装完打不开的情况。构建完成后跑 `codesign --verify --deep --strict` 验证签名。

## 已验证

### Windows

| 项 | 结果 |
|---|---|
| `next build` standalone | 成功，可独立运行 |
| 载荷独立启动 | `/health` 200、`/projects` 200 |
| Electron + 载荷（开发） | 窗口正常，UI 200 |
| **打包后 `Kady.exe`** | 窗口标题正常，`/health` 200，UI 200 |
| 捆绑 bash 执行命令 | `BUNDLED_BASH_OK`、`git 2.56`、`uv 0.12.13`，exit 0 |
| **隔离 PATH 验证** | 10 项全通过：bash / git / uv / 管道 / heredoc / git init / HTTPS clone，`git` 解析在捆绑目录内 |
| **打包版联网** | 在安装目录的 `externals/git` 上重跑隔离验证全过，`git ls-remote` 成功返回远端分支 |
| `shellPath` 写入 | 正确指向安装目录的 bash |
| 数据目录 | `%APPDATA%/Kady/data/` |
| `/tmp` 可用 | 临时文件读写正常 |
| 关闭清理 | 进程 0 残留，端口释放 |

### macOS

| 项 | 结果 |
|---|---|
| arm64 / x64 分别构建 | 两个 runner 各自 `process.arch` 断言通过 |
| `codesign --verify --deep --strict` | ad-hoc 签名校验通过 |
| DMG / ZIP 产出与上传 | 通过 |

macOS 侧**没有**做过与 Windows 表格同等深度的运行时验证：Intel 载荷只在 Intel runner 上构建过，未在真实 Intel Mac 上跑过。具体的构建产物、测试项与限制以随附的构建报告为准（见 [desktop/MACOS.md](desktop/MACOS.md)）。

## 环境变量

| 变量 | 作用 |
|---|---|
| `KADY_RUNTIME_DIR` | 指定载荷目录（指向 `build/runtime`） |
| `KADY_DATA_ROOT` | 后端可写根目录（壳自动注入） |
| `KADY_DESKTOP_USER_DATA` | 覆盖 Electron userData 根（默认 `%APPDATA%/Kady`、`~/Library/Application Support/Kady`） |
| `KADY_MODELS_CATALOGUE` | 模型目录 JSON 路径 |
| `KADY_FRONTEND_PORT` | 后端信任的前端来源端口（CORS） |
| `KADY_PORT` | 后端监听端口 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 出站代理，只在启动时读取，改完需重启 |

## 尚未完成

- **Windows 上的壳测试**：`desktop/test/` 只在 `macos-desktop.yml` 里跑，`tests.yml` 不覆盖 `desktop/`。Windows 是主发布平台，壳代码却零测试覆盖。
- **代码签名**：Windows `signExecutable: false`，会弹 SmartScreen；macOS 是 ad-hoc 签名、未公证，需要用户在「隐私与安全性」里批准一次。两者都不构成「已验证发布者」。
- **自动更新**：没有实现。macOS 的 ad-hoc 签名会直接卡死 Squirrel.Mac 的更新校验，所以真要做得先解决签名。
- **首次启动的 Python 环境**：`uv sync` 会构建两个 venv（沙箱 + 预览 helper），耗时数分钟且需联网
- **技能库的网络依赖**：`skills` CLI 每次同步都重新 `git clone` 上游仓库（460 MB），网络不稳时会报 `SSL/TLS handshake` 或 `invalid index-pack output`。系统 Git 用同样命令也会失败，不是捆绑版的问题。已抓取过的缓存落在 `%TEMP%/kady-desk-skills/`，但 CLI 不复用它
- **Linux**：配置已写，未验证，也未进 CI

## 许可

MIT。基于 [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok)，Copyright K-Dense Inc.
