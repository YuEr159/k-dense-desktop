# K-Dense BYOK 桌面版应用开发可行性论证

> 论证对象：<https://github.com/K-Dense-AI/k-dense-byok>（commit `6a55f5c`，`server/package.json` v0.15.0）
> 论证环境：Windows 11 Pro 10.0.26300，Node v24.14.0，npm 11.9.0
> 论证方式：源码静态分析 + 本机实跑验证（非纸面推演）。每项结论标注证据来源。

---

## 一、结论

**可行，属于中等偏上工作量（估计 6–10 人周）。** 推荐分三阶段落地，其中**阶段 0（薄壳 Electron 启动器）风险极低、1–2 天可交付**，因为应用本身就是"本地双服务 + 浏览器 UI"的形态，把它套进桌面窗口不需要改动任何业务代码。

真正的工作量不在窗口外壳，而在**把一个面向开发者的源码仓库安装流程（`npm install` + `uv sync` + `git clone` 460MB 技能库）改造成面向终端用户的安装包**，以及**处理 4 处对外部可执行文件/自身可执行路径的硬依赖**。这些都有明确解法，不存在架构级不可逾越的障碍。

**不建议**选择 Tauri 作为外壳（理由见 §6.2）。

---

## 二、被论证对象的技术形态

### 2.1 架构

`docs/architecture.md` 与 `AGENTS.md` 一致描述为两个本地服务：

| 服务 | 端口 | 技术栈 | 职责 |
|---|---|---|---|
| `web/` | 3000 | Next.js 16.3.7 + React 19.2.3 | 项目工作台、聊天、编辑器、文件预览 |
| `server/` | 8000 | Fastify 5 + Pi Agent SDK | 会话、工具、沙箱文件、计费、远程计算 |

`start.mjs`（668 行）是零依赖的跨平台启动器，负责检查 Node/git/uv → `npm install` → 播种技能 → 拉起两个服务 → 打开浏览器。`start.sh` / `start.cmd` 只是保证 Node 存在的薄封装。

后端内嵌一个 Pi lead agent，通过 SSE 向浏览器推送事件流（[`server/src/api/sessions.ts:135`](../server/src/api/sessions.ts)），沙箱是 `projects/<id>/sandbox/`，agent 的 cwd 指向这里（[`server/src/agent/session-registry.ts:466`](../server/src/agent/session-registry.ts)）。

### 2.2 代码规模

| 指标 | 数值 |
|---|---|
| 总行数（ts/tsx/py/mjs） | 140,838 |
| `.ts` | 471 文件 / 86,705 行 |
| `.tsx` | 203 文件 / 49,055 行 |
| 测试文件 | 266 个（server 135 + web 131） |
| CI | 全部 3 个 job 均覆盖 `windows-latest`（[`.github/workflows/tests.yml`](../.github/workflows/tests.yml)） |

**这一点很关键**：原生 Windows 已经是 CI 的一等公民，不是"顺带支持"。桌面版最怕的平台性暗坑，这个项目已经系统性扫过一遍。

### 2.3 依赖形态（决定打包难度）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 原生 node 模块（node-gyp/prebuild） | **无** | 两个 lockfile 全量扫描，无 `binding.gyp`、无 `.node` 包 |
| `install`/`postinstall` 脚本 | 6 个，均非编译型 | `esbuild`（下载二进制）、`@google/genai`/`protobufjs`（空操作）、`fsevents`（macOS） |
| Pi SDK 是否纯 JS | **是**，纯 ESM + WASM | `pi-coding-agent@1.3.0` 依赖树 120 包，0 个 gyp 包；唯一二进制资产是 `photon_rs.wasm`、`quickjs.wasm` |
| 前端原生依赖 | `@napi-rs/canvas`（由 `pdfjs-dist` 可选引入）、`lightningcss`（构建期） | `web/package-lock.json` |

"无原生模块"这一条大幅降低了跨平台打包的复杂度——不需要为每个目标平台预编译、不需要 electron-rebuild。

---

## 三、实跑验证结果（本机，非推演）

这是本文档最有力的部分：以下四项全部在本机 **实际执行并取得结果**。

### 3.1 前端生产构建：通过

```text
✓ Compiled successfully in 10.7s
✓ Generating static pages (6/6)

Route (app)
┌ ○ /                                  ← 静态预渲染
├ ○ /_not-found
├ ○ /icon.png
├ ƒ /office                            ← 动态（读 searchParams）
└ ƒ /office-assets/[build]/[file]      ← 动态（Route Handler）
```

产物：`.next/static` 23.3 MB，`.next/server` 37.5 MB，BUILD_ID `u2-SRmpJdumDAhZwtVp1d`。

**意义**：这个应用在 Next.js 语义上已经接近纯 SPA——主页面 `/` 标了 `"use client"`（`web/src/app/page.tsx:1`），全仓库没有 `cookies()` / `headers()` / `redirect()` 等 RSC 数据依赖（已全量 grep，零命中），没有 middleware。动态部分只有两个，都可改造（见 §5.3）。

### 3.2 后端在原生 Windows 启动：通过

```bash
KADY_PORT=18001 npx tsx src/index.ts
```

```text
{"level":30,"msg":"kady-server listening on http://127.0.0.1:18001"}
```

`GET /health` → `{"status":"ok"}`，`GET /projects` → 返回默认项目 JSON。**未经过 start.mjs、未依赖 Linux/WSL**。

### 3.3 CORS 端口可配置：通过

应用默认只信任前端端口 3000 的 Origin。实测把 UI 放到 13000：

- 未设 `KADY_FRONTEND_PORT` 时 → `HTTP 403 {"reason":"origin_not_allowed"}`
- 设置 `KADY_FRONTEND_PORT=13000` 后 → `HTTP 200`，`access-control-allow-origin: http://127.0.0.1:13000`

**意义**：桌面版不必死守 3000/8000，可以动态分配空闲端口，只要把同一个值传给两端。这是安全设计（防 DNS rebinding 与本地恶意页面）而非缺陷。

### 3.4 生产模式前端服务：通过

`next start` 起在 13000，首页 `HTTP 200`，26 KB HTML。生产模式不需要 dev server。

### 3.5 直接 `node src/index.ts` 失败——一个真实约束

```text
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
TypeScript parameter property is not supported in strip-only mode
  at server/src/agent/provider-auth.ts:358
```

Node 24 的原生类型剥离不支持"参数属性"语法。全仓库有 **11 处**使用该语法（`server/src/agent/models.ts:389`、`prompts.ts:45`、`provider-auth.ts:358`、`run-pipeline.ts:169`、`api/speech.ts:37` 等）。

**结论**：生产环境仍必须经 `tsx`（内部用 `esbuild`，一个 11.7 MB 的 `esbuild.exe`）或预编译。这直接决定 Electron 打包时的 asar 策略（§5.2）。

---

## 四、逐项风险清单（按处理成本排序）

### ⚠️ R1 · 硬依赖外部可执行文件（最大工作量）

| 依赖 | 用途 | 缺失后果 | 位置 |
|---|---|---|---|
| **Git Bash (`bash.exe`)** | Pi agent 的 bash 工具 | **agent 完全无法执行命令** | Pi SDK `dist/utils/shell.js`（已读源码验证）；`start.mjs` 将 git 设为 Windows 硬性前置 |
| `uv` | 沙箱 Python 环境、预览 helper venv | 所有 Python 任务、科学格式预览失败 | `server/src/binaries.ts:findUv`、`sandbox-seed.ts:317`、`helpers-env.ts:39` |
| `git` | 技能库克隆、技能更新 | 技能目录为空 | `server/src/agent/skills-fetch.ts:334` |
| `python` | 预览 helper 解释器（uv 缺位时兜底） | 预览降级 | `server/src/helpers-env.ts:30` |
| `latexmk` | LaTeX 编译 | 该功能不可用 | `server/src/latex/compile.ts:94` |

`docs/limitations.md` 明确写着："Native Windows requires Git Bash."

**可行性判断**：全部可解，但要为每个依赖决定"捆绑 vs 检测安装"：

- **Git Bash**：可捆绑 MinGit（Git for Windows 的便携版，约 50 MB），并在启动时通过 Pi 的 `settings.json` → `shellPath` 指向捆绑的 `bash.exe`（SDK 已支持该配置项，已读源码确认）。这是必须解决项，否则桌面版核心能力缺失。
- **uv**：官方提供单文件 standalone 二进制（约 30 MB 级别），可直接放进安装目录，`findUv()` 的查找顺序（PATH → `~/.local/bin`）需要增加"进程内捆绑目录"一项。
- **git**：MinGit 已包含，可与 bash 共用。
- **latexmk / TeX**：保持"可选增强"，不做捆绑（TeX 分发动辄数百 MB）。
- **python**：uv 自带 Python 安装能力，可以完全不依赖系统 Python（`uv python install`），需要把预览 helper 的兜底路径改为 uv 管理的解释器。

### ⚠️ R2 · `process.execPath` 假设（4 处，Electron 特有问题）

```ts
// server/src/agent/mcp.ts:477  和  :671
spawn(process.execPath, [piCliPath(), "mcp", ...args], ...)

// server/src/agent/skills-fetch.ts:231
spawn(process.execPath, [cli, ...args], ...)
```

在 Electron 中 `process.execPath` 是 `electron.exe`，直接 spawn 会启动一个 Electron 实例而非 Node 脚本。**三处全部失败**，影响 MCP 连接/登录、技能下载。

**解法（已验证可行方向，未实跑）**：Electron 支持 `ELECTRON_RUN_AS_NODE=1`，使 `electron.exe` 以纯 Node 模式运行并执行指定 JS 文件。在三处 spawn 的 `env` 中注入该变量即可，改动量约 10 行。备选：打包一份独立 `node.exe`（约 100 MB）作为 sidecar，或用 `@electron/utilityProcess`。

### ⚠️ R3 · 首次启动的安装流程不适合终端用户

`start.mjs` 在当前形态下，每次启动都会：

1. `npm install` 后端 + 前端（`start.mjs:588-589`），首次会从 registry 拉 ~1400 个包
2. `npm run prep`（`start.mjs:629`）→ `git clone --depth 1` **460 MB** 的技能库（实测 `K-Dense-AI/scientific-agent-skills` 仓库 size 471,400 KB）
3. `uv sync` 两个 venv（沙箱 ~4 包、helper ~18 包含 `rdkit`/`astropy`/`netCDF4`），首次需下载数百 MB 轮子
4. Office 预览首次打开时从 CDN 下载 **249 MB**（`soffice.wasm` 154.2 MB + `soffice.data` 94.9 MB，`web/src/lib/office-assets.ts`）

另外，正常路径用的是 `next dev` 而非 `next start`（`start.mjs:637-639`）——这是源码运行模式的合理选择（免构建），但桌面版必须换成生产模式。

**可行性判断**：这决定了桌面版是"安装包"还是"开发者工具封装"。必须做三件事：
- 依赖随包分发（`node_modules` 打进安装包，web 875 MB + server 274 MB 未裁剪，Electron 打包后可压到 ~200–300 MB）
- 技能库内置一份基线快照（可取技能子集，或首次运行后台静默下载并显示进度）
- Python 环境预烘焙进安装包（`uv` 的 `--frozen` 环境可在构建机生成后整体分发）

### ⚠️ R4 · 目录布局假设（中等）

- `REPO_ROOT = path.resolve(__dirname, "..", "..")`（`server/src/config.ts:16`）——假定 `server/` 在仓库根下。打包后需改为可注入路径。
- `projects/` 默认在 `REPO_ROOT/projects`（`config.ts:20`），桌面版应移到 `%APPDATA%\Kady\projects`。
- **API key 写入 `REPO_ROOT/.env`**（`server/src/api/credentials.ts:57`）。安装到 `Program Files` 后会因权限失败——这是桌面化必改项，需改到用户数据目录。
- `~/.kady/pi-agent/`（OAuth token）已在用户目录，无需改动。

好在 `KADY_PROJECTS_ROOT`、`KADY_PI_AGENT_DIR`、`KADY_OFFICE_ASSETS_DIR` 都是现成的环境变量，改动集中在"谁是 REPO_ROOT"，不涉及逻辑重构。

### 🔸 R5 · 进程生命周期管理（中等）

现有 `start.mjs` 的进程管理是 POSIX 优先的（`process.kill(-pid)` 进程组、`SIGHUP`、`taskkill /T /F` 兜底，`start.mjs:481-536`），并且会主动 `freePort()` 杀掉占用端口的本仓库遗留进程（通过命令行匹配仓库路径，`start.mjs:398`）。

**桌面版的正确做法不是复用这套逻辑**，而是：
- 在主进程内直接 `import` 后端的 `buildApp()`（`server/src/index.ts:82` 已有现成导出），省掉一层子进程与端口协商
- 或作为 `utilityProcess` 跑，随窗口关闭而终止
- 端口改为 `0`（系统分配）+ 主进程把实际端口通过 preload 注入渲染进程

这比改造 `start.mjs` 更干净。`buildApp()` 已导出是重要利好。

### 🔸 R6 · 打包技术细节（低，但必做）

- `esbuild.exe`（`tsx` 依赖）**不能留在 asar 内**——需要 `asarUnpack`。或彻底不用 `tsx`：用 esbuild 预编译后端为单文件 JS（我已确认无 `import type *` 语法障碍，全仓库 0 处）。
- Next.js 需改为 `output: 'standalone'`（`web/next.config.ts` 加一行）。**未实测**，但 standalone 是 Next 官方支持的部署形态，且此 app 无 RSC 数据依赖，预期顺利。
- `/office-assets/[build]/[file]` Route Handler 在 standalone 下正常工作，但它的 `KADY_OFFICE_ASSETS_DIR` 应指向用户可写目录（默认已是 `~/.kady/office-assets`，无需改动）。
- `/office` 页面用了 `searchParams`（`web/src/app/office/page.tsx:3`），在 `output: 'export'` 静态导出下不可用。若走 standalone（仍跑 Node server），则不是问题。

### 🔹 R7 · OAuth 与浏览器交互（低）

- 订阅登录（ChatGPT / Claude Pro / Copilot 等）走 loopback OAuth 回调，桌面版**不需要改动**——系统浏览器与本地后端仍在同一台机器上。
- MCP 登录同理（`pi mcp login` 打印 URL，等待 loopback 回调，`mcp.ts:656-700`）。
- 外部链接大量使用 `target="_blank"`（≥8 处）。Electron 需要在 `setWindowOpenHandler` 中把这些拦截并交给 `shell.openExternal`，属于常规配置。

### 🔹 R8 · 前端浏览器 API（低）

只用到 `navigator.clipboard`、`localStorage`、`URL.createObjectURL`、`window.open`、`crypto.subtle`。全部在 Electron/Chromium 中原生支持。无 Service Worker、无 IndexedDB 复杂用法。

`window.open` 已在代码中被判空处理（`lab-notebook-view.tsx:374` 有对应测试），Electron 中需放开 `nativeWindowOpen` 或转 `shell.openExternal`。

### 🔹 R9 · 体积与内存（低，但影响体验决策）

| 项 | 体积 |
|---|---|
| `web/node_modules` | 875 MB |
| `server/node_modules` | 274 MB |
| Office 运行时（CDN 下载） | 249 MB |
| 技能库（git clone） | ~460 MB |
| 沙箱 + helper venv | 首次 ~300–500 MB |

Electron 打包后（asar + 依赖裁剪）预期安装包 **250–400 MB**，首次完整使用（含技能库、Office 运行时、Python 环境）后磁盘占用 **1.5–2 GB**。这与 Claude Desktop / 同类 AI 桌面应用同一量级，可接受，但安装包里必须明确告知。

---

## 五、推荐技术方案

### 5.1 阶段划分

| 阶段 | 内容 | 改动量 | 工期估计 | 风险 |
|---|---|---|---|---|
| **0 · 薄壳** | Electron 壳 → 按现有 `start.mjs` 逻辑拉起服务 → `BrowserWindow.loadURL('http://127.0.0.1:3000')`。不改仓库代码（可做成独立 `desktop/` 目录） | ~500 行 | **1–2 天** | 极低 |
| **1 · 生产化** | 内嵌 `buildApp()`、Next standalone、预编译后端、动态端口、`ELECTRON_RUN_AS_NODE` 修 3 处 spawn、配置目录迁移到 `%APPDATA%` | ~2000–3000 行 | **2–3 周** | 中 |
| **2 · 安装包** | 捆绑 MinGit + uv + 预烘焙 venv，技能库基线，首次运行向导（检测/下载/进度），自动更新，代码签名，托盘与单实例 | ~4000–6000 行 | **4–6 周** | 中高 |

**阶段 0 就能验证产品假设**，且几乎零风险——建议先做，再决定是否投入阶段 1/2。

### 5.2 Electron 而非 Tauri

- **Electron 45.2.1 内置 Node 24.22.1**，满足 Pi SDK 的 `engines: node >= 22.19.0` 与 `skills` 包的 `>=22.20.0`。主进程可直接 `import` 后端 ESM 代码，无需 sidecar。
- Tauri 外壳用系统 WebView2（本机已装 156.0.4314.50），但 Rust 侧必须把 Node 后端作为 sidecar 子进程管理并自己做端口协商/健康检查/日志转发——相当于把 R5 的工作量翻倍，且失去"主进程内直接 `buildApp()`"这个最大简化。本机 `cargo` 未安装，还会引入 Rust 工具链这一新构建依赖。
- 体积差异（~150 MB）在这个应用 1.5–2 GB 的总占用面前不构成决策依据。

**结论：Electron。**

### 5.3 前端改造清单（最小集）

1. `web/next.config.ts` 加 `output: "standalone"`（一行）
2. 后端地址从 `NEXT_PUBLIC_ADK_API_URL` 改为运行时注入（渲染进程读 preload 暴露的 `window.kady.apiBase`），否则动态端口无法生效
3. `/office` 页面的 `searchParams` 改为客户端解析 `location.search`（若走 standalone 则可选）
4. 生产环境用 `next start`（或 standalone server），不再用 `next dev`

其余 UI、SSE 流、文件预览、工作区持久化逻辑**不需要改动**。

---

## 六、不可行 / 不推荐的方向

### 6.1 纯静态导出（`output: 'export'`）+ 前端直连后端

不可行。`/office-assets/[build]/[file]` 是 Node runtime 的 Route Handler，负责从 CDN 下载 249 MB Office 运行时并做 SHA-256 校验后缓存（`web/src/app/office-assets/[build]/[file]/route.ts`）；`/office` 页面依赖 `searchParams`。静态导出会同时破坏这两条路径。需要保留一个 Node 进程，这与桌面版"内嵌后端"的形态本来就是一致的。

### 6.2 Tauri 纯前端壳

见 §5.2。技术上不阻塞，但要为"管理 Node 子进程"支付额外成本，收益不足以抵消。

### 6.3 把应用改成纯 Electron 原生 UI

不可行且不必要。140k 行代码里 49k 行是 React 组件，`web/src/components/chat-tab.tsx` 单文件 94 KB。重写等于重做产品。

### 6.4 放弃捆绑，要求用户先装 Node + Git + uv

技术上可行（就是现在的形态），但这不是"桌面版应用"。用户要打开终端、看 `npm install` 输出、处理端口冲突——与桌面应用的预期严重不符。**若接受这个体验，阶段 0 就是终态**，但那本质是"把浏览器包进窗口"，不解决真实问题。

---

## 七、结论与建议

**可行性判定：可行。**

支撑这一判断的三个硬事实：

1. **无原生模块 + 纯 JS/WASM 依赖树** → 跨平台打包不需要 electron-rebuild，这是 Electron 集成中最常见的翻车点，本项目天然规避。
2. **原生 Windows 已是 CI 一等公民，且本机实跑通过**（前端构建 ✓、后端启动 ✓、CORS 可配 ✓、生产模式服务 ✓）→ 平台性风险已被上游系统性扫过。
3. **后端已导出 `buildApp()`，前端近似 SPA 且无 RSC 数据依赖** → 内嵌进 Electron 主进程的改造成本远低于典型 Next.js 应用。

主要工作量集中在三处，且都有明确解法：**外部二进制捆绑（R1）**、**`process.execPath` 适配（R2）**、**首次安装流程产品化（R3）**。这三项合计占阶段 1+2 的绝大部分工期。

**建议的执行顺序**：

1. 先做阶段 0（1–2 天），确认"窗口内跑起来"的体验符合预期
2. 阶段 1 优先解决 R2（4 处 spawn）与 R4（`.env` 写入权限）——这两项不做，装到 `Program Files` 后核心功能直接不可用
3. 阶段 2 的捆绑策略建议从 MinGit + uv 开始（这两个是"不做就不能用"），技能库与 Office 运行时改为首次使用时的后台下载（与现有 CDN 逻辑一致，`office-assets` 已是这个模式）

**需要提前决定的产品问题**（不影响技术可行性，影响工作量）：

- 安装包是否接受 250–400 MB
- 技能库是内置子集还是首次全量下载（460 MB）
- 是否提供"轻量模式"（不捆绑 Python，接受科学预览降级）
- 是否需要 macOS / Linux 同步支持（代码层面已跨平台，主要是打包与代码签名的额外工作）

---

## 附录：本次论证的验证命令

```bash
# 1. 前端生产构建
cd web && npx next build            # → Compiled successfully, exit 0

# 2. 后端原生 Windows 启动
cd server && KADY_PORT=18001 npx tsx src/index.ts
curl http://127.0.0.1:18001/health  # → {"status":"ok"}

# 3. CORS 端口可配置性
curl -i -H "Origin: http://127.0.0.1:13000" http://127.0.0.1:18001/projects
# → 403 origin_not_allowed
KADY_FRONTEND_PORT=13000 npx tsx src/index.ts   # 重启后
# → 200, access-control-allow-origin: http://127.0.0.1:13000

# 4. 生产模式前端
cd web && NEXT_PUBLIC_ADK_API_URL=http://127.0.0.1:18001 npx next start -p 13000
# → HTTP 200, 26074 bytes

# 5. 直接 node 运行后端（预期失败，证明 tsx 必需）
node src/index.ts
# → SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: parameter property
```

**未实测项（文中已逐条标注）**：`output: 'standalone'` 构建、`ELECTRON_RUN_AS_NODE` 修复 3 处 spawn、MinGit/uv 捆绑方案、技能库子集化。
