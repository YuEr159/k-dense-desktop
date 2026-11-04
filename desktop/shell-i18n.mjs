/**
 * Shell copy, in the two languages the app ships.
 *
 * The page translates itself at runtime; the shell used to be the one place
 * the two met — a Chinese interface wrapped in English dialogs, menus and
 * notifications. This table covers only text the shell renders itself, so it
 * stays small.
 *
 * The language follows `app.getLocale()`, which reports the *system* language
 * rather than the page's own setting. That is the right source here: these
 * strings appear before the page has loaded, and in the tray, where the page's
 * choice is not available.
 */

const COPY = {
  en: {
    "app.name": "K-Dense BYOK",
    "menu.about": "About {app}",
    "menu.file": "File",
    "menu.edit": "Edit",
    "menu.view": "View",
    "menu.window": "Window",
    "menu.help": "Help",
    "menu.quit": "Quit {app}",
    "menu.openLogs": "Open logs folder",
    "menu.viewLog": "View log",
    "log.empty": "The log is empty — nothing has been written yet.",
    "log.hint": "Newest lines last. {path}",
    "menu.openData": "Open data folder",

    "tray.open": "Open {app}",
    "tray.quit": "Quit",
    "tray.tooltip": "{app} — click to open",

    "trayHint.title": "{app} is still running",
    "trayHint.body": "Right-click the tray icon to reopen the window or quit.",
    "trayHint.bodyMac": "Click the menu bar icon, or the Dock icon, to reopen the window. Use {app} → Quit to stop it.",

    "notify.one": "Chat finished",
    "notify.oneNamed": "{name} finished",
    "notify.many": "{count} chats finished",
    "notify.bodyOne": "Your reply is ready — open {app} to read it.",
    "notify.bodyOneNamed": "Your reply in {name} is ready.",
    "notify.bodyMany": "Your runs are done — open {app} to read the replies.",
    "notify.bodyManyNamed": "Finished: {names}",

    "splash.starting": "Starting local services…",
    "splash.loadingUi": "Loading the interface…",
    "splash.python": "Preparing Python previews…",
    "splash.pythonHint": "Installing scientific Python packages. This happens once, and can take several minutes.",
    "splash.pythonFailed": "Python previews are unavailable ({detail}). The app still works.",
    "splash.skills": "Downloading the skill library…",
    "splash.skillsHint": "About 460 MB, once. Later projects copy from it locally.",
    "splash.skillsFailed": "The skill library could not be downloaded. Settings → Skills retries.",
    "splash.slow": "Starting the interface…",
    "splash.slowHint": "The first launch takes longer than later ones.",

    "error.missing.title": "{app} cannot start",
    "error.missing.message": "A required component is missing.",
    "error.start.title": "{app} could not start",
    "error.start.message": "The local services did not become ready.",
    "error.start.devHint": "Check the terminal output for the failing service. If dependencies are missing, run `npm install` in server/ and web/, then try again.",
    "error.start.hint": "Check that no other program is using {ui} or {backend}, then restart the app.",
    "error.stopped.title": "A Kady service stopped",
    "error.stopped.message": "The app has to close because one of its local services exited.",
    "error.stopped.detail": "Restart {app} to try again. The details are in Help → Open logs folder.",

    "crash.title": "The interface stopped",
    "crash.body": "Kady's window hit a problem and has to reload. Your chats and files are safe — they live on disk, not in the window.",
    "crash.reload": "Reload the interface",
    "crash.hint": "If this keeps happening, open Help → Open logs folder and include the log in a bug report.",

    "quit.running.title": "A response is still running",
    "quit.running.one": "One chat is still working.",
    "quit.running.many": "{count} chats are still working.",
    "quit.running.detailNamed": "Still running: {names}. Closing now ends the response mid-stream.",
    "quit.running.detail": "A response is still streaming. Closing now ends it mid-stream.",
    "quit.running.keep": "Keep working",
    "quit.running.quit": "Quit anyway",

    "context.cut": "Cut",
    "context.copy": "Copy",
    "context.paste": "Paste",
    "context.selectAll": "Select all",
    "context.openLink": "Open link in browser",
    "context.copyLink": "Copy link address",
    "context.inspect": "Inspect element",

    "about.credits": "Local AI research assistant. Based on K-Dense BYOK by K-Dense Inc., MIT licensed.",
  },
  zh: {
    "app.name": "K-Dense BYOK",
    "menu.about": "关于 {app}",
    "menu.file": "文件",
    "menu.edit": "编辑",
    "menu.view": "视图",
    "menu.window": "窗口",
    "menu.help": "帮助",
    "menu.quit": "退出 {app}",
    "menu.openLogs": "打开日志文件夹",
    "menu.viewLog": "查看日志",
    "log.empty": "日志为空——还没有写入任何内容。",
    "log.hint": "最新内容在最后。{path}",
    "menu.openData": "打开数据文件夹",

    "tray.open": "打开 {app}",
    "tray.quit": "退出",
    "tray.tooltip": "{app} — 点击打开",

    "trayHint.title": "{app} 仍在运行",
    "trayHint.body": "右键点击托盘图标可以重新打开窗口或退出。",
    "trayHint.bodyMac": "点击菜单栏图标或 Dock 图标即可重新打开窗口。要彻底停止请用 {app} → 退出。",

    "notify.one": "对话已完成",
    "notify.oneNamed": "{name} 已完成",
    "notify.many": "{count} 个对话已完成",
    "notify.bodyOne": "回复已就绪 — 打开 {app} 查看。",
    "notify.bodyOneNamed": "{name} 的回复已就绪。",
    "notify.bodyMany": "所有任务已完成 — 打开 {app} 查看回复。",
    "notify.bodyManyNamed": "已完成：{names}",

    "splash.starting": "正在启动本地服务…",
    "splash.loadingUi": "正在加载界面…",
    "splash.python": "正在准备 Python 预览环境…",
    "splash.pythonHint": "正在安装科学计算所需的 Python 包。只需一次，可能需要几分钟。",
    "splash.pythonFailed": "Python 预览不可用（{detail}）。应用其余功能正常。",
    "splash.skills": "正在下载技能库…",
    "splash.skillsHint": "约 460 MB，只需一次。之后新建项目从本地复制。",
    "splash.skillsFailed": "技能库下载失败。可在 设置 → 技能 重试。",
    "splash.slow": "正在启动界面…",
    "splash.slowHint": "首次启动比之后几次要慢。",

    "error.missing.title": "{app} 无法启动",
    "error.missing.message": "缺少必需的组件。",
    "error.start.title": "{app} 未能启动",
    "error.start.message": "本地服务未能在预期时间内就绪。",
    "error.start.devHint": "检查终端里失败服务的输出。若依赖缺失，在 server/ 和 web/ 下执行 `npm install` 后重试。",
    "error.start.hint": "确认没有其他程序占用 {ui} 或 {backend}，然后重启应用。",
    "error.stopped.title": "Kady 的服务已停止",
    "error.stopped.message": "本地服务之一退出，应用必须关闭。",
    "error.stopped.detail": "重启 {app} 可重试。详情见「帮助 → 打开日志文件夹」。",

    "crash.title": "界面已停止",
    "crash.body": "Kady 的窗口遇到问题，需要重新加载。对话和文件都安全 — 它们保存在磁盘上，不在窗口里。",
    "crash.reload": "重新加载界面",
    "crash.hint": "如果反复出现，请打开「帮助 → 打开日志文件夹」，把日志附在问题反馈里。",

    "quit.running.title": "仍有回复在生成",
    "quit.running.one": "有一个对话仍在工作。",
    "quit.running.many": "有 {count} 个对话仍在工作。",
    "quit.running.detailNamed": "仍在运行：{names}。现在关闭会中断正在生成的回复。",
    "quit.running.detail": "仍有回复在流式生成。现在关闭会中断它。",
    "quit.running.keep": "继续工作",
    "quit.running.quit": "仍然退出",

    "context.cut": "剪切",
    "context.copy": "复制",
    "context.paste": "粘贴",
    "context.selectAll": "全选",
    "context.openLink": "在浏览器中打开链接",
    "context.copyLink": "复制链接地址",
    "context.inspect": "检查元素",

    "about.credits": "本地 AI 研究助手。基于 K-Dense Inc. 的 K-Dense BYOK，MIT 许可。",
  },
};

/** Set once, right after `app.whenReady()`. Chinese only for a zh-* locale. */
let language = "en";

export function setLanguageFromLocale(locale) {
  language = typeof locale === "string" && locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function currentLanguage() {
  return language;
}

/**
 * Look up a key and fill `{placeholders}`.
 *
 * A missing key returns the key itself rather than throwing: a typo in a
 * dialog is a cosmetic bug, and turning it into a crash at startup would be a
 * far worse trade. The `{app}` and `{count}`-style placeholders are plain
 * string substitution — no plural machinery, because the two languages here
 * do not share plural rules and the counts involved are small.
 */
export function t(key, vars = {}) {
  const table = COPY[language] ?? COPY.en;
  const template = table[key] ?? COPY.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** The product name, so callers do not repeat it in every `t()` call. */
export function appName() {
  return t("app.name");
}
