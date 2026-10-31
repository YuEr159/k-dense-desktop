# K-Dense BYOK 桌面版

Electron 壳，把 K-Dense BYOK 的两个本地服务装进一个窗口。

## 两种运行模式

### 1. 源码模式（开发）

```bash
cd desktop && npm start
```

需要仓库已有 `server/node_modules`、`web/node_modules` 和 `web/.next` 构建产物。后端走 `tsx`，前端走 `next start`。

### 2. 打包载荷模式

先把运行时载荷构建出来：

```bash
cd web && npx next build      # 需 next.config.ts 的 output: "standalone"
cd .. && node desktop/scripts/build-runtime.mjs
```

然后让壳使用它：

```bash
cd desktop && KADY_RUNTIME_DIR=./build/runtime npm start
```

打包后的安装包会自动从 `resources/runtime/` 读取同一套结构，无需该变量。

## 它做了什么

1. 用 `ELECTRON_RUN_AS_NODE=1` 以纯 Node 模式启动后端与前端（`electron.exe` 充当 Node 运行时）
2. 轮询 `/health` 与首页，就绪后加载 `http://127.0.0.1:3000`
3. 所有可写状态（`.env`、`projects/`）落到用户数据目录：`%APPDATA%/kady-desktop/data/`
4. 外部链接交给系统浏览器，同源链接留在应用内
5. 窗口关闭即杀掉整个进程树

渲染进程无 preload、无 Node 集成、`sandbox: true`——与浏览器标签页的安全姿态一致。

## 载荷的结构

`desktop/scripts/build-runtime.mjs` 产出：

```
build/runtime/
  server/
    src/**/*.mjs          后端源码，逐文件编译（保留目录结构）
    src/helpers/*.py      科学预览的 Python 解码器（不含 .venv）
    pi-packages/          Pi 扩展包（.ts 原件 + 编译后的 .mjs）
    scripts/              subagent 补丁脚本
    node_modules/         438 个生产依赖（lockfile 判定，排除 dev）
    package.json
  web/                    Next standalone 产物 + .next/static + public
  models.json             模型价格目录
  env-file.mjs            .env 解析器（后端从仓库根引用）
```

**为什么后端不是单文件 bundle**：`server/src` 中有多处 `import.meta.dirname` 相对路径（`../../pi-packages`、`../../node_modules`、`./subagent-host.mjs`、`../helpers`），单文件打包会破坏这些解析。逐文件编译保留目录结构，改动最小。

**为什么还要编译 `web/src/lib`**：后端有 15+ 处直接 import `web/src/lib/*.ts` 的共享逻辑，两者是编译时耦合的。这 11 个被引用的文件及其闭包会一并编译到 `runtime/web/src/lib/`。

**为什么 `pi-packages` 同时保留 `.ts` 和 `.mjs`**：Pi 用自己的 TS 加载器读 `.ts`（`package.json` 的 `pi.extensions`），而后端直接用 Node 路径 import 时需要 `.mjs`。

体积：server 201 MB + web 67.5 MB ≈ **269 MB**。

## 已验证

| 项 | 结果 |
|---|---|
| Next standalone 构建 | 成功，独立运行无需 `node_modules` |
| 后端载荷独立启动 | `/health` 200，`/projects` 200 |
| Electron 端到端（载荷模式） | 窗口正常，UI 200，后端 200 |
| 数据目录迁移 | `.env` 写入 AppData，仓库根保持干净 |
| 关闭清理 | electron 进程 0 残留，端口释放 |
| `ELECTRON_RUN_AS_NODE` 继承 | 孙进程正确以纯 Node 运行，`process.execPath` 三处 spawn 无需改代码 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `KADY_RUNTIME_DIR` | 指定载荷目录，覆盖 `resources/runtime` |
| `KADY_DATA_ROOT` | 后端可写根目录（壳自动注入 `%APPDATA%/kady-desktop/data`） |
| `KADY_MODELS_CATALOGUE` | 模型目录 JSON 路径 |
| `KADY_FRONTEND_PORT` | 后端信任的前端来源端口（CORS） |

## 尚未完成

- **安装包**：`electron-builder` 打包、代码签名、自动更新（阶段 2）
- **外部二进制捆绑**：Git Bash（agent 的 bash 工具硬依赖）、uv、git 仍需用户自备
- **首次启动的 Python 环境**：`uv sync` 在首次运行时构建两个 venv，耗时数分钟
- **技能库**：默认会 `git clone` 约 460 MB
