import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROMPT, patchExtractWithDetails, patchShowDetails } from "../scripts/nsis-extract-progress.mjs";

/** The shape electron-builder 26 ships, trimmed to the call site. */
const TEMPLATE = `!macro extractUsing7za FILE
  Push $OUTDIR
  Nsis7z::Extract "\${FILE}"
  Pop $R0
  SetOutPath $R0
!macroend
`;

describe("patchExtractWithDetails", () => {
  it("swaps the single-shot call for the progress-reporting one", () => {
    const { source, changed } = patchExtractWithDetails(TEMPLATE);
    assert.equal(changed, true);
    assert.match(source, /Nsis7z::ExtractWithDetails "\$\{FILE\}" "正在解压应用文件 %s"/);
    // The pop still consumes the plugin's return value; dropping it would
    // leave the stack unbalanced for the SetOutPath that follows.
    assert.match(source, /ExtractWithDetails[^\n]*\n  Pop \$R0/);
    assert.doesNotMatch(source, /Nsis7z::Extract "\$\{FILE\}"\n/);
  });

  // beforePack runs for every target and arch, and a rebuild reuses the same
  // node_modules -- a second pass must not nest another prompt into the first.
  it("is idempotent", () => {
    const once = patchExtractWithDetails(TEMPLATE).source;
    const twice = patchExtractWithDetails(once);
    assert.equal(twice.changed, false);
    assert.equal(twice.source, once);
  });

  it("leaves a template that does not match alone", () => {
    const other = '!macro x\n  Nsis7z::Extract "$PLUGINSDIR\\a.7z"\n!macroend\n';
    const { source, changed } = patchExtractWithDetails(other);
    assert.equal(changed, false);
    assert.equal(source, other);
  });

  // The prompt goes into a sprintf format string; a stray % would be read as
  // another conversion and print garbage instead of the byte counts.
  it("refuses a prompt with the wrong number of conversions", () => {
    assert.throws(() => patchExtractWithDetails(TEMPLATE, "解压中"), /exactly one %s/);
    assert.throws(() => patchExtractWithDetails(TEMPLATE, "%s of %s"), /exactly one %s/);
  });

  it("carries a caller-supplied prompt through", () => {
    const { source } = patchExtractWithDetails(TEMPLATE, "unpacking %s");
    assert.match(source, /ExtractWithDetails "\$\{FILE\}" "unpacking %s"/);
  });

  it("ships a prompt the plugin can actually fill in", () => {
    assert.equal((PROMPT.match(/%/g) ?? []).length, 1);
  });
});

/** installSection.nsh, trimmed to the guard that silences the details pane. */
const INSTALL_SECTION = `InitPluginsDir

\${IfNot} \${Silent}
  SetDetailsPrint none
\${endif}

StrCpy $appExe "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}"
`;

describe("patchShowDetails", () => {
  // ExtractWithDetails can only be seen if the pane it prints into is open;
  // the template turns it off before the section body runs.
  it("keeps the details list instead of silencing it", () => {
    const { source, changed } = patchShowDetails(INSTALL_SECTION);
    assert.equal(changed, true);
    assert.match(source, /SetDetailsPrint both/);
    assert.doesNotMatch(source, /SetDetailsPrint none/);
  });

  // A silent install has no window to draw the list in; the template's own
  // guard is what keeps the call out of that path.
  it("keeps the silent guard around it", () => {
    const { source } = patchShowDetails(INSTALL_SECTION);
    assert.match(source, /\$\{IfNot\} \$\{Silent\}\n  SetDetailsPrint both\n\$\{endif\}/);
  });

  it("is idempotent", () => {
    const once = patchShowDetails(INSTALL_SECTION).source;
    const twice = patchShowDetails(once);
    assert.equal(twice.changed, false);
    assert.equal(twice.source, once);
  });

  it("leaves a template that does not match alone", () => {
    const other = 'Section "s"\n  SetDetailsPrint none\nSectionEnd\n';
    const { source, changed } = patchShowDetails(other);
    assert.equal(changed, false);
    assert.equal(source, other);
  });
});
