import fs from "node:fs";
import path from "node:path";

import { patchExtractWithDetails, patchShowDetails } from "./nsis-extract-progress.mjs";

/**
 * Two electron-builder templates set up the install section's progress
 * reporting, and neither can be reached from a custom include: `!macro` names
 * cannot be redefined, and the include directory cannot shadow a template the
 * script pulls in by relative path. Both are rewritten in place instead. See
 * `nsis-extract-progress.mjs`; each rewrite is idempotent, so a rebuild in the
 * same checkout is a no-op.
 */
function patchNsisTemplates(logger) {
  const root = path.join(import.meta.dirname, "..", "node_modules", "app-builder-lib", "templates", "nsis");
  const edits = [
    ["installSection.nsh", patchShowDetails, "shows the details pane during install"],
    [path.join("include", "extractAppPackage.nsh"), patchExtractWithDetails, "reports unpack progress"],
  ];
  for (const [relative, patch, what] of edits) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    const { source, changed } = patch(before);
    if (!changed) continue;
    fs.writeFileSync(file, source);
    logger?.info?.(`nsis: ${what} (${relative})`);
  }
}

export default async function beforePack(context) {
  patchNsisTemplates(context.packager?.info?._logger);

  if (context.electronPlatformName !== "darwin") return;
  const architecture = { 1: "x64", 3: "arm64" }[context.arch];
  if (!architecture || architecture !== process.arch) {
    throw new Error("Build each macOS architecture on a matching host; runtime dependencies and uv are architecture-specific.");
  }
  const root = path.resolve(import.meta.dirname, "..");
  const staged = JSON.parse(fs.readFileSync(path.join(root, "build/runtime/build-info.json"), "utf8"));
  if (staged.platform !== "darwin" || staged.arch !== architecture) throw new Error("Runtime payload architecture does not match the installer");
  const uv = fs.readFileSync(path.join(root, "build/externals/uv/.version"), "utf8");
  if (!uv.split("\n")[0].endsWith(` ${architecture}`)) throw new Error("uv architecture does not match the installer");
}
