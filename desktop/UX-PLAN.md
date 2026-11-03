# 桌面端体验改造计划

范围约束：**只改 `desktop/`，不动 `server/` 和 `web/` 内核。**

这条约束决定了下面每条的形态。凡需要改后端或前端才能实现的，单列在「需要破约束」一节，不作为本计划主体。

每条的「佐证」都是可打开核对的位置。外部依据标注了来源。

**状态：A1–A12 已全部实施。** 实测记录见文末。

---

## A. 确凿缺陷（已全部修复）

### A1. 错误信息指向一个不存在的菜单项

启动失败时对话框说：`The backend's own message is in the application log (Help → Open logs).`

- `buildApplicationMenu` 里没有 Help 菜单（`desktop/main.mjs:210`）
- 壳**从不写日志文件**：两个文件里没有任何 `appendFileSync` / `createWriteStream`，子进程输出只走 `console.log`，打包后没有终端可看

用户遇到启动失败时，唯一的诊断线索指向空处。

**做法**：写滚动日志到 `<dataRoot>/logs/shell.log`（保留最近 3 个文件，每个上限 5 MB），把子进程 stdout/stderr 一并写入；菜单加真正的 `Help → Open logs`（`shell.showItemInFolder`）和 `Help → Open data folder`。约 80 行。

### A2. 浅色主题下窗口露黑边

`backgroundColor: "#0b0b0c"`（`main.mjs:259`），启动画面 `background:#0b0b0c`（`main.mjs:393`）。前端主题 `defaultTheme="system"`（`web/src/app/layout.tsx:37`），浅色下背景是 `oklch(1 0 0)` 纯白（`web/src/app/globals.css:78`）。

Electron 官方文档明确：`backgroundColor` 的作用就是减少加载阶段露出的不匹配底色；即使使用 `show: false` + `ready-to-show`，也建议设置。

**做法**：用 `nativeTheme.shouldUseDarkColors` 选初始背景色，监听 `nativeTheme.on("updated")` 调 `win.setBackgroundColor()`。启动画面的 CSS 同步。约 20 行。

### A3. 通知不说是哪个会话

`raiseRunCompleteNotification(finishedCount)`（`main.mjs:149-162`）只说 "Chat finished" / "N chats finished"。

但 `/runtime-status` 已返回 `sessions: [{ id, name }]`（`server/src/api/sessions.ts:185-193`），`quitInterruptsWork` 也已经在读 `s.name`（`main.mjs:668`）。`startRunWatcher` 只保留了 count，名字被丢弃。

**做法**：`startRunWatcher` 保留上一轮的 `sessions` 数组，完成时把名字交给通知；单个会话用名字作标题，多个用「N 个会话已完成」并把前几个名字放进正文。约 25 行。

### A4. 从 `quit` 切回 `tray` 后托盘不再出现

`createTray()` 只在 `app.whenReady` 按当时的 `closeAction()` 调一次（`main.mjs:517`）。

用户把设置从「退出」改回「退到托盘」后，托盘图标不存在；下次关窗走 tray 分支，进程活着但**没有任何可见入口**，只能用任务管理器结束。

**做法**：`window-all-closed` 的 tray 分支无条件确保托盘存在。约 5 行。

### A5. 托盘提示在 macOS 上是空操作却消费了标记

`ensureTrayHint` 只在 `win32` 弹 balloon，但**无条件**写 `trayHintShown: true`（`main.mjs:650-661`）。Electron 文档确认 balloon 相关方法和事件均为 Windows 专属。

macOS 用户第一次关窗后不知道应用还在跑，提示标记却已被消费。

**做法**：macOS 用 `Notification`（首次关窗时一次性提示「Kady 仍在运行，点击 Dock 图标或菜单栏图标可重新打开」），同样只在首次。约 15 行。

### A6. 窗口大小和位置不记忆

`createWindow` 固定 `1440x900`（`main.mjs:255-256`），`shell.json` 没有 `windowBounds` 字段（`server/src/shell-settings.ts` 的 `ShellSettings` 只有 4 个键）。

**做法**：`close` 时存 `getNormalBounds()`（用 normal 而非当前 bounds，否则最大化状态下存的是全屏尺寸），启动时校验目标矩形是否仍与任一显示器相交再应用。约 45 行。

### A7. 渲染进程崩溃 / 页面加载失败无处理

`main.mjs` 里 `render-process-gone`、`unresponsive`、`did-fail-load` 一个都没有监听；`web/src/app/` 下也没有 `error.tsx`。

用户看到白屏，没有提示，只能强杀。

**做法**：监听这三个事件，崩溃时 `loadURL` 到一张内置的「界面已崩溃，点此重新加载」页（`data:` URL，和启动画面同一种做法）。约 40 行。

### A8. 文本输入框没有右键菜单

没有 `context-menu` 监听。对一个满是文本框的应用，用户只能靠快捷键复制粘贴。

**做法**：监听 `context-menu`，按 `params.isEditable` / `params.selectionText` / `params.linkURL` 构造菜单（剪切/复制/粘贴/全选，链接上给「在浏览器中打开」）。约 40 行。

### A9. 缺少常规平台集成

| 缺口 | 影响 | 依据 |
|---|---|---|
| 没有 `app.setAppUserModelId()` | Windows 上通知归属可能不正确 | Electron 文档：Toast 需要 AppUserModelID |
| 没有 `setAboutPanelOptions()` | macOS「关于 Kady」是空白 | 文档：macOS 未设置则用 plist，本项目 plist 里没有 |
| 没有 `setBadgeCount()` | 后台完成时无 Dock 角标 | 文档：**仅 Linux/macOS**，Windows 无此 API |

Windows 的后台完成提示改用 `mainWindow.flashFrame(true)`（用户聚焦时 `false`）。

约 30 行。注意 `setBadgeCount` 在 macOS 上要求应用有通知权限。

### A10. 托盘图标在 macOS 上不合规

`resources/icon.png` 是 1024×1024 彩色图，硬 `resize` 到 16px（`main.mjs:596`）。Electron 文档：macOS 菜单栏应使用 **Template Image**，文件名须以 `Template` 结尾，`@2x` 同名，否则 macOS 不会做颜色反转。

**做法**：`make-icon.mjs` 额外产出一张单色 `iconTemplate.png` + `iconTemplate@2x.png`，macOS 分支用它。约 30 行。

### A11. 壳全英文，界面默认中文

`main.mjs` 和 `service-manager.mjs` 里中文字符串数为 **0**，而前端界面默认简体中文（浏览器语言非中文时为英文）。

**做法**：壳内一张最小对照表（约 25 条），按 `app.getLocale()` 选。约 70 行。

### A12. `desktop/` 在 Windows 上没有测试覆盖

`tests.yml` 完全不涉及 `desktop/`；`macos-desktop.yml` 在 macOS 上跑 `npm test`。而 Windows 是主发布平台。

且 `test/macos.test.mjs` 的 POSIX 路径断言在 Windows 上必然失败（实测：`path.join` 产出 `\\Applications\\...`），这个测试文件本身就把 Windows 排除了。

**做法**：把平台无关的用例拆到 `test/platform-agnostic.test.mjs`（token 校验、软链展开、端口诊断文案），在 `tests.yml` 加 Windows job 跑它们；macOS 专属断言留在原文件。约 1 小时，主要是验证。

---

## B. 需要破约束才能做的（需你决定）

| 条目 | 要改哪 | 为什么壳做不到 | 价值 |
|---|---|---|---|
| **通知/托盘点击跳到对应会话** | `web/` 支持 `?session=<id>` 深链接 | 页面内部路由壳控制不了 | 高 |
| **文件下载统一管理**（保存对话框、下载完成提示） | `web/` 改走壳提供的保存流程 | 沙箱页面无文件系统访问；`will-download` 只能改目录，不能替页面决定 | 中 |
| **崩溃后恢复对话状态** | `web/` 的 error boundary + 会话恢复 | 页面内部状态壳拿不到 | 中 |
| **自动更新** | `desktop/` 可以自己做（`electron-updater` 未安装，需加依赖） | 见下 | 高但受阻 |

### 关于自动更新

**Windows**：NSIS 无签名可以自动更新，代价是每次升级都要过一次 SmartScreen。

**macOS**：当前是 **ad-hoc 签名**。Squirrel.Mac 的更新流程要求新包与当前包的签名身份一致，ad-hoc 签名没有 Team ID，无法满足这个前提。**结论：在拿到 Developer ID 证书并完成公证之前，macOS 自动更新做不了。** 这不是配置问题，是签名机制本身的前提。

因此建议：
- 短期：壳内加「检查更新」，比对 `desktop/package.json` 版本与 GitHub Release，有新版就打开 Release 页让用户手动下载。壳可独立完成，约 60 行。
- 长期：拿到 Developer ID 后再上 `electron-updater`。

> 说明：这一条是基于签名机制前提的推理，不是官方文档原文确认——electron-builder 的文档站本次访问超时，`electron-updater` 也未安装到本地可供查证。落地前应先用 dev 证书实测一次。

---

## C. 记录备查，不在本次范围

**版本比较对 `d` 后缀失效**（内核问题）：`web/src/lib/version.ts` 的 `compareSemver` 用 `v.split(".").map(Number)`，`"0.15.0d3"` → `[0, 15, NaN]`，`NaN` 与任何数比较均为 false。

不过 `NEXT_PUBLIC_APP_VERSION` 读的是 `server/package.json`（`web/next.config.ts:10`）而非 `desktop/package.json`，所以实际比的是上游版本，语义自洽。不修也不影响桌面版。

---

## 建议的实施顺序

以下顺序在实施时被采用，A1–A12 全部完成：

**第一批（半天，纯收益、零风险）**
A2 主题背景色 → A3 通知带名字 → A4 托盘补建 → A5 macOS 提示 → A9 平台集成

**第二批（半天，诊断能力）**
A1 日志 + Help 菜单 → A7 崩溃处理 → A8 右键菜单

**第三批（半天，打磨）**
A6 窗口记忆 → A10 模板图标 → A11 壳内中文化

**第四批（一天，工程）**
A12 Windows 测试覆盖

---

## 实测记录

### 真实启动（打包载荷）

用 `KADY_RUNTIME_DIR=./build/runtime` 启动壳，端口临时改到空闲端口以避开本机正在跑的开发实例：

| 检查项 | 结果 |
|---|---|
| `shell.log` 生成 | 通过，625 B → 35 行，含会话头（版本/平台/架构/locale/packaged） |
| 后端与前端的输出进日志 | 通过，两个服务的 stdout/stderr 都带 `[backend]` / `[frontend]` 前缀落盘 |
| 日志不重复写 | 通过（首版重复，已修，见下） |
| 窗口状态落盘 | 通过，`shell.json` 写入 `windowState.bounds` + `maximized` |
| 端口冲突诊断 | 通过，日志完整记录占用端口与 `netstat` 指引 |
| 中文 locale 生效 | 通过，`locale=zh-CN` → 壳文案走中文表 |
| 退出清理 | 通过，超时终止后无残留进程 |

### 过程里发现并修掉的两个问题

1. **日志每行写两遍**：子进程输出先由 sink 写入，`captureConsole` 又把它镜像了一次。改为 sink 独占两个目的地，并用一个计数哨兵在回显期间挂起镜像。修复后同一行只出现一次（实测 `grep -c` 为 1）。
2. **模板图标是全黑方块**：品牌 PNG 是**完全不透明**的灰度图（alpha 恒为 255），按 alpha 取形状会得到实心方块。改为按亮度反相当 alpha，并加了 `test/icon.test.mjs` 钉住「有真实形状」这个性质（alpha 0→255，均值 93.5）。

### 测试

`cd desktop && npm test` — **36 项，31 通过，5 跳过（平台限定），0 失败**。

新增：
- `test/platform-agnostic.test.mjs` — 端口诊断、token 校验、运行时环境、壳文案
- `test/window-state.test.mjs` — 窗口矩形恢复的全部边界（离屏、退化尺寸、非法坐标、fullscreen）
- `test/icon.test.mjs` — 模板图标不是空白也不是实心块

`test/macos.test.mjs` 的 POSIX 断言改为 `skip: process.platform !== "darwin"`，它的可移植部分移到了 `platform-agnostic.test.mjs`。

### CI

`tests.yml` 新增 `desktop` job，在 **ubuntu 和 windows** 上跑壳测试。在此之前 `desktop/test/` 只在 `macos-desktop.yml` 里跑，Windows —— 主发布平台 —— 零覆盖。

---

## 外部依据来源

- [Electron Tray API](https://www.electronjs.org/docs/latest/api/tray) — 平台事件差异、macOS Template Image 要求
- [Electron Notifications 教程](https://www.electronjs.org/docs/latest/tutorial/notifications) — AppUserModelID 必要条件、macOS 需代码签名
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) — backgroundColor 的作用、ready-to-show 时序、flashFrame/showInactive/moveTop
- [Electron nativeTheme](https://www.electronjs.org/docs/latest/api/native-theme) — shouldUseDarkColors、themeSource、updated 事件
- [Electron app](https://www.electronjs.org/docs/latest/api/app) — setAppUserModelId（仅 Windows）、setAboutPanelOptions、setBadgeCount（仅 Linux/macOS）
