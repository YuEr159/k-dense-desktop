/**
 * Assertions that hold on every platform the shell ships to.
 *
 * `desktop/test/` used to run only inside the macOS workflow, which left the
 * primary release platform — Windows — with no shell coverage at all. Worse,
 * the macOS file's POSIX assertions fail on Windows by construction, so it
 * could not simply be added to a Windows job.
 *
 * Everything here avoids platform-specific paths: the helpers are called with
 * an explicit `platform` argument, or with inputs built from `path.sep` where
 * the code under test really is platform-sensitive.
 *
 * Run with `node --test desktop/test/`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { BACKEND_PORT, healthBelongsToLaunch } from "../service-manager.mjs";
import { portHelp, runtimeEnvironment } from "../runtime-env.mjs";
import { t, setLanguageFromLocale, currentLanguage } from "../shell-i18n.mjs";

describe("launch tokens", () => {
  it("accepts a reply carrying this launch's token", () => {
    assert.equal(healthBelongsToLaunch({ launchToken: "abc" }, "abc"), true);
  });

  it("rejects a healthy reply from a program we did not start", () => {
    // The exact shape an impostor on the port returns: healthy, no token.
    assert.equal(healthBelongsToLaunch({ status: "ok" }, "abc"), false);
    // A different launch's token is equally not ours.
    assert.equal(healthBelongsToLaunch({ launchToken: "other" }, "abc"), false);
    // A backend started by hand has no token at all.
    assert.equal(healthBelongsToLaunch(null, "abc"), false);
  });
});

describe("port diagnostics", () => {
  it("names the platform's own tool", () => {
    assert.match(portHelp([8000], "darwin"), /lsof.*8000/);
    assert.doesNotMatch(portHelp([8000], "darwin"), /Task Manager/);
    assert.match(portHelp([8000], "win32"), /netstat.*8000/);
    assert.doesNotMatch(portHelp([8000], "win32"), /lsof/);
  });

  it("covers every port it is given", () => {
    const text = portHelp([3000, 8000], "win32");
    assert.match(text, /:3000/);
    assert.match(text, /:8000/);
  });
});

describe("runtime environment", () => {
  it("leaves a non-macOS environment alone", () => {
    const env = { PATH: path.join("C:", "tools") };
    assert.deepEqual(runtimeEnvironment({ platform: "win32", env }), { PATH: env.PATH });
  });

  it("orders macOS tool directories predictably and deduplicates them", () => {
    // `runtimeEnvironment` builds these with `path.join`, which follows the
    // *host*, not the platform argument — so the expectation is built the same
    // way. Asserting literal POSIX strings here is what made this test unable
    // to run on Windows.
    const externals = "/Applications/Kady.app/Contents/Resources/externals";
    const home = "/Users/test";
    const env = runtimeEnvironment({
      platform: "darwin",
      externalsDir: externals,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    const parts = env.PATH.split(":");
    assert.equal(parts[0], path.join(externals, "bin"));
    for (const dir of [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(home, ".local", "bin"),
      "/usr/bin",
      "/bin",
    ]) {
      assert.ok(parts.includes(dir), `missing ${dir}`);
    }
    assert.equal(env.SHELL, "/bin/bash");
    assert.equal(new Set(parts).size, parts.length, "PATH must not repeat a directory");
  });
});

describe("shell copy", () => {
  it("resolves a key in both languages", () => {
    setLanguageFromLocale("en-US");
    assert.equal(currentLanguage(), "en");
    assert.match(t("tray.quit"), /Quit/);

    setLanguageFromLocale("zh-CN");
    assert.equal(currentLanguage(), "zh");
    assert.match(t("tray.quit"), /退出/);
  });

  it("fills placeholders and leaves unknown ones alone", () => {
    setLanguageFromLocale("en-US");
    assert.equal(t("trayHint.title", { app: "Kady" }), "Kady is still running");
    // An unfilled slot stays visible rather than becoming "undefined".
    assert.match(t("trayHint.title"), /\{app\}/);

    setLanguageFromLocale("zh-CN");
    assert.equal(t("trayHint.title", { app: "Kady" }), "Kady 仍在运行");
  });

  it("falls back to the key for a missing entry instead of throwing", () => {
    setLanguageFromLocale("en-US");
    assert.equal(t("no.such.key"), "no.such.key");
  });

  it("treats a non-Chinese locale as English", () => {
    for (const locale of ["de", "fr-FR", "", undefined]) {
      setLanguageFromLocale(locale);
      assert.equal(currentLanguage(), "en", `locale ${locale}`);
    }
    setLanguageFromLocale("zh-TW");
    assert.equal(currentLanguage(), "zh");
  });
});

describe("eventual start against an occupied port", () => {
  let impostor = null;

  after(async () => {
    if (impostor) await new Promise((resolve) => impostor.close(resolve));
  });

  it("refuses to start and names the port", async () => {
    // If something already owns the port (a dev server, a running Kady) that
    // is exactly the situation under test, so use it. Otherwise stand one up.
    impostor = await new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
      server.once("error", reject);
      server.listen(BACKEND_PORT, "127.0.0.1", () => resolve(server));
    }).catch(() => null);

    const { startServices, stopServices } = await import("../service-manager.mjs");
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kady-port-"));
    try {
      const result = await startServices({ dataRoot });
      assert.equal(result.ok, false);
      assert.ok(result.detail.includes(String(BACKEND_PORT)));
      assert.match(result.detail, process.platform === "win32" ? /netstat/ : /lsof/);
      assert.doesNotMatch(result.detail, /did not become ready/);
    } finally {
      await stopServices();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
