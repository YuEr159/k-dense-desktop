# K-Dense BYOK 桌面版

Electron 壳，把 K-Dense BYOK 的两个本地服务装进一个窗口。Windows 打包产物自带 bash、git、uv，用户无需安装任何运行时。

## 快速开始

### 运行打包后的应用

```bash
./dist/win-unpacked/Kady.exe
```

### 生成安装包

```bash
cd desktop
npm install
npm run dist
```

产出 `dist/Kady-<version>-x64-Setup.exe`。

> 网络受限时需要镜像（GitHub 直连会超时）：
> ```bash
> cd desktop
> ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
> ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
> npx electron-builder --config electron-builder.json --win
> ```

### 开发模式（源码）

```bash
cd desktop && npm start
```

需要仓库已有 `server/node_modules`、`web/node_modules` 和 `web/.next`（`npx next build`）。

### 用打包载荷测试（不生成安装包）

```bash
node desktop/scripts/build-runtime.mjs
node desktop/scripts/fetch-externals.mjs
cd desktop && KADY_RUNTIME_DIR=./build/runtime npm start
```

## 架构

```
Kady.exe
  ├─ app.asar              壳代码（main.mjs / service-manager.mjs / preflight.mjs）
  └─ resources/
       ├─ runtime/          应用载荷
       │    ├─ server/src/**/*.mjs     后端（逐文件编译，保留目录结构）
       │    ├─ server/node_modules/    438 个生产依赖
       │    ├─ server/pi-packages/     Pi 扩展包
       │    ├─ server/src/helpers/     科学预览的 Python 解码器
       │    ├─ web/                    Next standalone 产物
       │    └─ models.json             模型价格目录
       └─ externals/        捆绑的二进制
            ├─ git/         PortableGit（已裁剪，含 bash.exe + git）
            └─ uv/          uv.exe
```

**运行时数据**（永不随安装包覆盖）：`%APPDATA%/Kady/data/`
- `.env` — 用户保存的 API key
- `projects/` — 项目文件与对话历史

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

PortableGit 完整解压 408 MB，裁剪掉 `mingw64`（GUI 工具链）、`vim`、`perl5`、`mintty` 等后降到 **103 MB**，bash/git/管道/重定向全部验证可用。

### 保持 `KADY_RUNTIME_DIR` escape hatch

虽然是整包更新，但载荷目录可被环境变量覆盖。出问题时可以手工替换载荷热修，不必重新发版。

## 外部依赖补齐

| 组件 | 来源 | 体积 |
|---|---|---|
| PortableGit 2.56（裁剪后） | 清华镜像 | 103 MB |
| uv 0.12.13 | PyPI wheel（含 SHA-256 校验） | 39.6 MB |

两者都固定版本并记录来源。下载脚本优先走 GitHub，失败时自动回落镜像（本机实测 GitHub 直连超时）。

## 已验证

| 项 | 结果 |
|---|---|
| `next build` standalone | 成功，可独立运行 |
| 载荷独立启动 | `/health` 200、`/projects` 200 |
| Electron + 载荷（开发） | 窗口正常，UI 200 |
| **打包后 `Kady.exe`** | 窗口标题正常，`/health` 200，UI 200 |
| 捆绑 bash 执行命令 | `BUNDLED_BASH_OK`、`git 2.54`、`uv 0.12.13`，exit 0 |
| `shellPath` 写入 | 正确指向安装目录的 bash |
| 数据目录 | `%APPDATA%/Kady/data/` |
| `/tmp` 可用 | 临时文件读写正常 |
| 关闭清理 | 进程 0 残留，端口释放 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `KADY_RUNTIME_DIR` | 指定载荷目录（指向 `build/runtime`） |
| `KADY_DATA_ROOT` | 后端可写根目录（壳自动注入） |
| `KADY_MODELS_CATALOGUE` | 模型目录 JSON 路径 |
| `KADY_FRONTEND_PORT` | 后端信任的前端来源端口（CORS） |

## 尚未完成

- **代码签名**：`signExecutable: false`，Windows 会弹 SmartScreen 警告
- **自动更新**：上游 release 无二进制产物，需自建版本端点（参考 DSH Desktop 的做法）
- **首次启动的 Python 环境**：`uv sync` 会构建两个 venv（沙箱 + 预览 helper），耗时数分钟且需联网
- **技能库**：默认 `git clone` 约 460 MB
- **macOS / Linux**：配置已写，未验证；无 `externals` 捆绑（依赖系统 bash）

## 与 DSH Desktop 的对照

DSH Desktop（34k stars，同类产品）的更新做法值得参考：

- 不用 `electron-updater`，自研版本服务 + 固定下载端点
- NSIS 配 `differentialPackage: false`，**无增量更新**，每次全量下载 260–730 MB
- **无磁盘版本化目录、无 A/B 切换、无应用级回滚**
- 捆绑 Node + CPython + pnpm + 350 个固定版本 tarball

本项目的取舍与其一致：整包替换 + 自建版本服务，靠"确定性运行时闭包"换"确定的首次启动"。区别在于本项目保留了 `KADY_RUNTIME_DIR`，多一个热修通道。
