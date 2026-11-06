/**
 * What the launch splash says under its two progress lines.
 *
 * Kept out of main.mjs so it can be tested without Electron — the same reason
 * `startup-readiness.mjs` lives here. Everything in this module is a pure
 * function of the `/health` payload plus a `t` lookup, so a splash that has
 * been sitting on one sentence for three minutes can be reproduced in a test.
 *
 * The copy is not decoration. A first launch installs ~555 MB of wheels and a
 * 460 MB skill catalogue before the app is usable, and the reported failure
 * mode was "it freezes every time": the splash showed the same line from start
 * to finish, which is indistinguishable from a hang.
 */

/** Elapsed seconds since an epoch-ms start, or null when the start is absent. */
export function elapsedSeconds(startedAt, now = Date.now()) {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

/** Byte count as the splash shows it: whole MB above a megabyte, else KB. */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / 1048576;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Host of a package index URL, for naming the mirror in the hint. */
export function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

/**
 * The hint under the Python line: what uv is doing right now.
 *
 * uv prints one `Downloading <name> (<size>)` line per package on a non-TTY,
 * so the counts are real progress rather than an estimate. The index name
 * stays when a probe picked a mirror — it explains why this launch is faster
 * than the last one.
 *
 * Order matters: uv reports downloads first and the install summary last, and
 * the install count is the more precise answer once it exists.
 */
export function pythonHint(helpers, t, now = Date.now()) {
  const elapsed = elapsedSeconds(helpers?.startedAt, now);
  const mirror = helpers?.index
    ? t("splash.pythonMirror", { host: hostOf(helpers.index) ?? helpers.index })
    : null;
  if (elapsed === null) return mirror ?? t("splash.pythonHint");
  if (typeof helpers?.packagesInstalled === "number") {
    return t("splash.pythonInstalled", { count: helpers.packagesInstalled, elapsed });
  }
  if (typeof helpers?.packagesDownloaded === "number" && helpers.packagesDownloaded > 0) {
    const size = formatBytes(helpers.downloadBytes);
    return size
      ? t("splash.pythonPackages", { count: helpers.packagesDownloaded, size, elapsed })
      : t("splash.pythonPackagesNoSize", { count: helpers.packagesDownloaded, elapsed });
  }
  // Nothing counted yet. Saying nothing for the first few seconds is right —
  // uv resolves and builds its plan before the first download line, and
  // "resolving" on a launch that is merely two seconds old reads as a stall.
  if (elapsed >= 3) return t("splash.pythonCompute", { elapsed });
  return mirror ?? t("splash.pythonHint");
}

/**
 * The hint under the skill-library line, by the stage the CLI has reached.
 *
 * The bundled `skills` CLI animates a spinner instead of reporting bytes, so
 * the stages are all it can offer: cloning, then copying the trees into place.
 * Naming them still separates "downloading" from "installing 177 skills".
 */
export function skillsHint(catalogue, t, now = Date.now()) {
  const elapsed = elapsedSeconds(catalogue?.startedAt, now);
  const seconds = elapsed ?? 0;
  if (catalogue?.phase === "installing") {
    return typeof catalogue.discovered === "number"
      ? t("splash.skillsInstalling", { count: catalogue.discovered, elapsed: seconds })
      : t("splash.skillsInstallingUnknown", { elapsed: seconds });
  }
  if (elapsed !== null && elapsed >= 3) return t("splash.skillsCloning", { elapsed: seconds });
  return t("splash.skillsHint");
}
