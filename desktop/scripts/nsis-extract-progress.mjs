/**
 * The install section unpacks the whole app through one `Nsis7z::Extract`
 * call, which NSIS counts as a single progress unit: the bar reaches roughly
 * 60% and then holds there for the rest of the install, which is where the
 * wall-clock time goes and why the details pane has nothing to say.
 *
 * Two template edits fix that, both in electron-builder's own templates:
 *
 * 1. `installSection.nsh` opens with `SetDetailsPrint none`, which hides the
 *    details pane the whole time. Switching it to `SetDetailsPrint both` keeps
 *    the bar and the list visible together.
 * 2. `extractAppPackage.nsh` calls `Nsis7z::Extract`, one progress unit for
 *    the entire unpack. The plugin also exports
 *    `ExtractWithDetails "<archive>" "<prompt>"`, which prints
 *    `12% (34 / 280 MB)` as it goes; the prompt keeps one `%s` for the plugin.
 *
 * Neither can be done from a custom include: `!macro` names cannot be
 * redefined, so a same-named macro is a compile error, and the include
 * directory cannot shadow a template the script includes by relative path.
 * The template files are therefore rewritten in place before the build. Both
 * rewrites are idempotent -- a rebuild in the same checkout finds nothing left
 * to change and leaves the files alone.
 */

const EXTRACT_ORIGINAL = 'Nsis7z::Extract "${FILE}"\n  Pop $R0';

/**
 * The details pane is opened for every install that has a window. The
 * template's own `${IfNot} ${Silent}` guard is kept: a silent install has no
 * window to draw the list in, and the guard is the template's own idiom for
 * that.
 */
const DETAILS_ORIGINAL = "${IfNot} ${Silent}\n  SetDetailsPrint none\n${endif}";
const DETAILS_REPLACEMENT = "${IfNot} ${Silent}\n  SetDetailsPrint both\n${endif}";

export const PROMPT = "正在解压应用文件 %s";

export function patchExtractWithDetails(source, prompt = PROMPT) {
  const target = EXTRACT_ORIGINAL;
  if (!source.includes(target)) return { source, changed: false };
  // `%` is the plugin's own format marker, so a second one in the prompt would
  // be read as another conversion and garble the line.
  if ((prompt.match(/%/g) ?? []).length !== 1) {
    throw new Error(`details prompt must contain exactly one %s: ${prompt}`);
  }
  const replacement = `Nsis7z::ExtractWithDetails "\${FILE}" "${prompt}"\n  Pop $R0`;
  return { source: source.replace(target, replacement), changed: true };
}

export function patchShowDetails(source) {
  if (!source.includes(DETAILS_ORIGINAL)) return { source, changed: false };
  return { source: source.replace(DETAILS_ORIGINAL, DETAILS_REPLACEMENT), changed: true };
}
