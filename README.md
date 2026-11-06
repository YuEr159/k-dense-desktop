# K-Dense BYOK 桌面版

[简体中文](README.md) | [English](README.en.md)

Kady 是一个本地运行的科研助手。你把数据文件放进一个「项目」，用日常的话描述想做什么，它就会读文件、写代码、跑分析、画图，并把做过的事记下来。

整个过程在你的电脑上完成。模型由你自己的账号调用，数据不经过我们。

![Kady 界面](docs/app-screenshot.png)

---

## 它能替你做什么

**分析数据。** 上传一份表格、一组测序结果、一张显微图，描述你想知道什么。Kady 会先检查数据长什么样，再动手。

> 「比较 `counts.csv` 里处理组和对照组的差异，基因是行。先做质控，把分析脚本存下来，最后画图。」

它会先把检查结果给你看，而不是埋头跑完再说。

**看懂各种科研文件。** 表格、PDF、Markdown、Jupyter notebook、序列文件、分子结构、质谱、显微图像都能直接预览。LaTeX 论文可以编译成 PDF，并且能双向跳转——点 PDF 上的字跳到源码，反过来也行。

**写和改文档。** Word、Excel、PowerPoint 可以直接预览；点「在 Office 中编辑」会打开一个编辑页，用的是真正的办公引擎，不是简化版。

**留下可查的记录。** 实验记录本按时间记下假设、方法、观察和结论。文件预览里的「来源」能回答「这张图是哪个脚本、用哪份数据、什么时候生成的」。这句话不是模型自己声称的，是运行过程被记录下来得到的。

**请专家分工。** 可以让多个「专家」并行处理一件事的不同方面——一个查文献，一个跑分析，一个复核结果。你在面板上能看到它们各自在做什么。

**跑长时间的计算。** 需要大算力时可以把任务送到云端，关掉电脑任务也继续跑，回来取结果。

**按计划自动执行。** 比如每天早上重跑一次数据检查，或者每周生成一份汇总。这些会记录花费。

---

## 开始使用

### 安装

**Windows** — 从 [Releases](https://github.com/YuEr159/k-dense-desktop/releases) 下载 `Kady-<version>-x64-Setup.exe` 并运行。首次启动会在 `%APPDATA%/Kady/` 下建数据目录。

Windows 会弹 SmartScreen 警告。安装包没有购买代码签名证书，系统不认识发布者，这是预期行为：点「更多信息」→「仍要运行」。

**macOS** — 下载 `Kady-<version>-mac-arm64.dmg`（Apple Silicon）或 `Kady-<version>-mac-x64.dmg`（Intel），拖进「应用程序」。

应用是 ad-hoc 签名、未公证，第一次打开需要在「系统设置 → 隐私与安全性」里点一次「仍要打开」。Apple Silicon 上系统要求 macOS 12 或更高。

macOS 需要系统已有可用的 Git；缺失时终端执行 `xcode-select --install`，装完重开应用。详见 [desktop/MACOS.md](desktop/MACOS.md)。

### 第一次启动会慢一些

窗口打开后显示进度页，这期间在准备两样东西：

- **技能库**（约 460 MB，一次）—— 一组预先写好的科研工作流程，之后新建项目从本地复制，不再下载
- **Python 环境**（约 555 MB，一次）—— 文件预览需要的解码器

界面在这期间已经可用，只是没装完之前部分文件预览会提示「依赖缺失」，装完自动恢复。这两个下载都只需要一次，之后的启动是几秒。

网络受限时下载可能失败。技能库失败不阻塞使用，可以在 **设置 → 项目 · <名称> → 技能** 里重试。

### 连一个模型

界面打开后，第一件事是 **设置 → 模型 → 提供商** 连上模型。

Kady 自己不提供模型，也不转售模型额度——它用你自己的账号，账单直接由服务商结算。三种方式：

| 方式 | 适合谁 |
|---|---|
| **订阅登录** | 已有 ChatGPT Plus / Claude Pro / GitHub Copilot 等订阅，直接授权，不额外付费 |
| **API 密钥** | 有 OpenRouter、Anthropic、OpenAI 等任意一家的密钥，按用量计费 |
| **本地模型** | 装了 Ollama 或 LM Studio，完全免费、完全离线 |

没有密钥也能先打开看看界面，只是发不出消息。

### 建项目，提问题

1. 新建项目，把数据拖进左侧文件区
2. 在输入框下方选模型和思考强度
3. 描述你的问题——说清数据是什么、想得到什么结果

模型会边做边给你看它在干什么。遇到需要你决定的地方，它会在对话里弹出问题框停下来等你，而不是自己猜。

---

## 界面怎么用

三块区域：左边文件，中间预览和编辑，右边对话。

**调整布局。** 拖动面板之间的分隔线改宽度；分隔线上下两端可以点击，交换两个面板的位置。不想要哪一块，在 **设置 → 工作区 → 外观** 里关掉它。对话正文太宽时，同一处可以设一个最大宽度，消息会居中显示。

**长任务。** 一次运行中你可以随时插话补充要求，或者排队一条稍后再发的消息。任务跑着也可以关掉这个对话页签，它在后台继续。

**花费。** 顶部显示本次和项目的累计花费。可以在 **设置 → 项目 · <名称> → 通用** 里设一个项目上限，超了就停下。订阅方式登录的模型不计入这个数字。

**用中文。** 浏览器语言是中文时界面默认中文，其他情况默认英文。可以随时在 **设置 → 工作区 → 外观 → 语言** 里切换。

**关窗口不退出。** 默认关掉窗口只是收进托盘，后台任务继续跑。托盘图标双击可以叫回来，右键菜单可以真正退出。想改成关窗即退出，在 **设置 → 工作区 → 外观** 里改。

---

## 常见问题

**数据去哪了？** 全部在本机。Windows 在 `%APPDATA%/Kady/data/`，macOS 在 `~/Library/Application Support/Kady/data/`。里面是你的 `.env`（保存的密钥）、`projects/`（文件和对话历史）、和 Python 环境。升级应用不会覆盖这个目录。

**会花多少钱？** 取决于你用哪个模型、跑多少。用订阅登录不额外计费。用 API 密钥时按服务商的价格计费，界面上的数字是估算，最终以服务商账单为准。

**能离线用吗？** 用本地模型（Ollama）可以，但首次的技能库和 Python 环境下载需要联网一次。

**模型答错了怎么办？** 它会展示用了哪个文件、跑了什么代码。文件预览里的「来源」面板能查到每条结论背后的实际执行记录。结论仍然需要你自己复核——它可以出错，只是错误可追溯。

**为什么 Windows 会警告？** 安装包没有代码签名证书。这是个人维护项目的常见情况，不代表程序有问题，但确实意味着系统无法为你验证发布者。

---

## 更多

- [基础用法](docs/basic-usage.md) — 完整的工作流程说明
- [子代理与专家](docs/sub-agents.md) — 并行分工怎么用
- [实验记录本](docs/lab-notebook.md) — 记录、引用与导出
- [文件预览](docs/file-previews.md) — 支持哪些格式
- [云端计算](docs/modal-compute.md) — 大任务怎么送出去
- [模型选择](docs/model-selection.md) — 各家服务的计费规则

遇到问题或想要新功能，在 [Issues](https://github.com/YuEr159/k-dense-desktop/issues) 里提。

---

<details>
<summary><b>面向开发者</b> — 构建、架构与实现细节</summary>

### 从源码构建

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

`npm run dist` 串起六步：构建前端（`build-web.mjs`）、生成图标（`make-icon.mjs`）、编译载荷（`build-runtime.mjs`）、冒烟验证打包后的后端能建会话（`verify-runtime-session.mjs`）、下载并裁剪平台二进制（`fetch-externals.mjs`）、隔离 PATH 验证捆绑二进制（`verify-externals.mjs`），最后交给 electron-builder 打包。

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

### 架构

```
Kady.exe / Kady.app
  ├─ app.asar              壳代码（main.mjs / service-manager.mjs / preflight.mjs）
  └─ resources/
       ├─ runtime/          应用载荷（两平台相同）
       │    ├─ server/src/**/*.mjs     后端（逐文件编译，保留目录结构）
       │    ├─ server/node_modules/    全部生产依赖（含传递依赖）
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

### 关键实现决策

**后端不打成单文件。** `server/src` 中有 7 处 `import.meta.dirname` 相对路径（`../../pi-packages`、`../../node_modules`、`./subagent-host.mjs`、`../helpers`）。单文件 bundle 会破坏这些解析（路径都以本文件的目录为基准），所以逐文件编译 `.ts → .mjs` 并保留目录结构。

**`web/src/lib` 也要编译。** 后端有 28 个文件直接从 `web/src/lib/*.ts` import 共享逻辑（`chat-snapshot.ts`、`compaction-bridge.ts` 等），两者是编译时耦合的。构建脚本会解析这个闭包并一并编译到 `runtime/web/src/lib/`。这些文件内部相互 import 时**不带扩展名**（Next 打包器能解析，Node ESM 不能），构建时会自动补 `.mjs`。

**`pi-packages` 同时保留 `.ts` 和 `.mjs`。** Pi 用自己的 TS 加载器读 `.ts`（`package.json` 的 `pi.extensions`）；后端直接用 Node import 时需要 `.mjs`。

**用 `ELECTRON_RUN_AS_NODE` 而非修改代码。** 后端有 3 处 `spawn(process.execPath, ...)`（MCP 客户端、技能下载）。在 Electron 中 `process.execPath` 是 `electron.exe`，直接 spawn 会启动新窗口而非执行脚本。设 `ELECTRON_RUN_AS_NODE=1` 后 `electron.exe` 表现为纯 Node 运行时。已验证该变量会被孙进程继承（`piCliEnv`/`skillsCliEnv` 都是 `{...process.env}` 展开），所以**这 3 处无需任何代码改动**。

**bash 通过 Pi 的 `shellPath` 指定。** Pi 的 `getShellConfig()` 解析顺序是：`settings.json` 的 `shellPath` → `Program Files\Git` → `PATH`。壳在启动时把捆绑的 bash 路径写进 `<agentDir>/settings.json`，优先级最高，不受用户机器上旧版 Git 影响。若 `shellPath` 指向的路径已不存在（应用移动位置后），会被自动替换。

**PortableGit 而非 MinGit。** **MinGit 不含 `bash.exe`**（只有 `git.exe` 和 `dash.exe`），而 bash 正是 agent 执行命令的核心。必须用 PortableGit。PortableGit 2.56 完整解压 342 MB。裁剪掉 vim、mintty、man/doc、git-gui/gitk 后约 **299 MB**。

> **`ucrt64/` 和 `mingw64/` 必须保留**：那是 git 本体（`git.exe` 及其链接的 DLL）和 `libexec/git-core/`（`git clone` 等子命令的实现）。早期版本曾把整个 `mingw64/` 当成"GUI 工具链"删掉，结果 `git: command not found`，而且因为本机装了系统 Git 而看不出问题。`scripts/verify-externals.mjs` 用只含捆绑目录的 PATH 验证，专门堵这个洞。

PortableGit 2.56 把工具链从 `mingw64/` 移到了 `ucrt64/`；脚本按存在性探测两者，版本升级不会静默失效。

**保持 `KADY_RUNTIME_DIR` escape hatch。** 虽然是整包更新，但载荷目录可被环境变量覆盖。出问题时可以手工替换载荷热修，不必重新发版。

### 关闭窗口时

默认**关闭窗口 = 退到托盘**，进程继续运行。这样后台工作（Modal 任务、计划任务）不会因为关掉窗口就停掉；同时窗口销毁后渲染进程（约 274 MB）被回收，常驻占用从约 750 MB 降到约 300 MB。

托盘图标双击恢复窗口，右键菜单可以重新打开或彻底退出。设置 → 工作区 → 外观 里可以把「关闭窗口时」改成**退出应用**，那就是经典行为：关闭即结束，有任务在跑时会先问一次。

数据目录和端口在退出时才释放，托盘状态下端口仍被占用——这是有意的，否则下次启动会看到两个后端。

端口选择按平台分开：Windows 用 3000/8000，macOS 用 47822/47821。后者是为了避开 macOS 上动辄被占用的 3000。

两个平台都有一层额外的保护：壳每次启动生成一个随机 token 交给后端，健康检查必须回显它才被认作「我们自己的后端」。否则端口被别的程序占着时，探活会对着别人的服务成功，窗口打开后连着的是另一份数据目录。

### 中文界面

界面在浏览器语言为中文时默认简体中文，否则默认英文，可在 **设置 → 工作区 → 外观 → 语言** 切换。

翻译层是**运行时文本替换**，不在组件里包 `t()`：上游仓库是这份代码的事实来源，我们定期合并，每个 `t("...")` 都是一行上游可能同时改动的代码。改成渲染后改写 DOM，我们只拥有一个字典文件，上游合并零冲突；上游改了某句文案，那句退回英文显示，是可见的降级而不是错译。

设计细节、覆盖盲区和加翻译的方法见 [web/docs/i18n.md](web/docs/i18n.md)。

### 首次启动会发生什么

窗口打开后显示进度页，按后端 `/health` 的 `setup.helpers.state` 更新文案。首次启动要装约 555 MB 的 Python 包（科学预览的解码器），耗时几分钟；这期间 UI 已经可用，只是文件预览会报"依赖缺失"，装完自动恢复。

`uv sync` 在后台跑（不是阻塞式），所以后端端口立刻就绪，不会卡住健康检查。

### 外部依赖补齐

| 组件 | 平台 | 来源 | 体积 |
|---|---|---|---|
| PortableGit 2.56.0.4（裁剪后） | Windows | GitHub / 清华镜像 | 299 MB |
| uv 0.12.13 | 两平台 | PyPI wheel（含 SHA-256 校验） | 40 MB |

两者都固定版本并记录来源。下载脚本优先走 GitHub，失败时自动回落镜像（本机实测 GitHub 直连超时）。macOS 只取 uv：bash 和 git 用系统的，`verify-externals.mjs` 在 macOS 上只验证 uv。

### 版本与发布

`desktop/package.json` 的 `version` 决定安装包文件名，也是发版的唯一开关。

发版时打 tag `v<version>` 并推送，`release-desktop.yml` 会并行跑三个 job：Windows 出 `.exe`，macOS 出 arm64 和 x64 两份 `.dmg` + `.zip`，都附加到同一个 Release。

tag 同时支持 `v0.15.0d3` 和归一化后的 `v0.15.0-d3`——electron-builder 用 semver 的 loose 模式把后缀规范成 `-d3`，所以两种拼写都要能匹配上。上游的 `release.yml` 也会在 `v*` tag 上触发，`check` job 比对 `desktop/package.json` 的版本，不匹配就不构建。

macOS 构建在 `macos-15`（arm64）和 `macos-15-intel`（x64）两个 runner 上分别进行，job 里先断言 `process.arch` 与矩阵一致，防止出现「在 Intel 上产出 arm64 载荷」这种装完打不开的情况。构建完成后跑 `codesign --verify --deep --strict` 验证签名。

### 已验证

**Windows**

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

**macOS**

| 项 | 结果 |
|---|---|
| arm64 / x64 分别构建 | 两个 runner 各自 `process.arch` 断言通过 |
| `codesign --verify --deep --strict` | ad-hoc 签名校验通过 |
| DMG / ZIP 产出与上传 | 通过 |

macOS 侧**没有**做过与 Windows 表格同等深度的运行时验证：Intel 载荷只在 Intel runner 上构建过，未在真实 Intel Mac 上跑过。具体的构建产物、测试项与限制以随附的构建报告为准（见 [desktop/MACOS.md](desktop/MACOS.md)）。

### 环境变量

| 变量 | 作用 |
|---|---|
| `KADY_RUNTIME_DIR` | 指定载荷目录（指向 `build/runtime`） |
| `KADY_DATA_ROOT` | 后端可写根目录（壳自动注入） |
| `KADY_DESKTOP_USER_DATA` | 覆盖 Electron userData 根（默认 `%APPDATA%/Kady`、`~/Library/Application Support/Kady`） |
| `KADY_MODELS_CATALOGUE` | 模型目录 JSON 路径 |
| `KADY_FRONTEND_PORT` | 后端信任的前端来源端口（CORS） |
| `KADY_PORT` | 后端监听端口 |
| `KADY_PYPI_INDEX` | `uv sync` 用的包索引（Settings → Services 亦可设）。默认 PyPI |
| `KADY_SKILLS_AUTO_SYNC` | 设为 `0` 关闭启动时和每日的技能目录同步。离线或计费网络下有用 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 出站代理，只在启动时读取，改完需重启 |

### 尚未完成

- **壳测试的覆盖缺口**：`tests.yml` 的 `desktop` job 在 Windows 和 Linux 上跑 9 个测试文件，`desktop/test/` 共 11 个。缺的两个：`lifecycle.test.mjs`（服务启停、进程树终止）只在 macOS workflow 的 `npm test` 里跑，Windows 上它会自己 skip——Windows 的进程树清理走 `taskkill /T /F`，与它断言的 POSIX 行为不同；`macos.test.mjs` 只在 macOS 上跑。`runtime-files.test.mjs` 的一条在 Windows 上 skip，因为它依赖符号链接。
- **代码签名**：Windows 与 macOS 都没有证书，会弹 SmartScreen / 需在「隐私与安全性」里批准一次，两者都不构成「已验证发布者」。配置本身已就绪：electron-builder 没有 `WIN_CSC_LINK` 时自然跳过签名，在 CI 里加上证书变量，下一次构建就会自动签名。不要加 `signExecutable: false`——它是硬开关，会让配了证书也照样不签。
- **自动更新**：没有实现。macOS 的 ad-hoc 签名会直接卡死 Squirrel.Mac 的更新校验，所以真要做得先解决签名。
- **首次启动的 Python 环境**：`uv sync` 会构建两个 venv（沙箱 + 预览 helper），耗时数分钟且需联网。预览 helper 的冷安装实测 553 MB；默认 PyPI 在受限网络下 17 分钟，换区域镜像 26 秒。
- **技能库的网络依赖**：首次需下载 460 MB 的上游技能目录，网络不稳时会报 `SSL/TLS handshake` 或 `invalid index-pack output`——系统 Git 用同样命令也会失败，不是捆绑版的问题。整次下载有 2 分钟总上限（`CATALOGUE_DEADLINE_MS`），并发调用共享同一次下载、暂存树按引用计数清理、`sandbox/init` 只等本地部分、远程播种在后台。暂存目录在 `~/.kady/skills-cache/`（`KADY_SKILLS_CACHE_DIR` 可改），按源名加哈希分子目录；每次同步会先清空再下，不复用旧内容。下载失败不阻塞使用，Settings → Skills 可重试。
- **Linux**：配置已写，未验证，也未进 CI。

### 上游

本仓库是 [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok) 的桌面封装。上游项目的说明见 [README.upstream.md](README.upstream.md)。

</details>

## 许可

MIT。基于 [K-Dense BYOK](https://github.com/K-Dense-AI/k-dense-byok)，Copyright K-Dense Inc.
