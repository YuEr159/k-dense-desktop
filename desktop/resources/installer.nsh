# Installer behaviour Kady overrides from electron-builder's defaults.
#
# Included by electron-builder's NSIS template, so each macro below runs at a
# hook the template already defines.
#
# Keep the comments ASCII-only. makensis reads this with -INPUTCHARSET UTF8
# but still rejects some punctuation (em dashes, curly quotes) on comment
# lines, and the error it reports points at the line rather than the
# character. String literals are fine.
#
# The file must be saved as UTF-8 *with* a BOM: NSIS 3.0.4.1 reports
# "Bad text encoding" for a BOM-less file whose comments contain non-ASCII.

# --- Install for the current user only, with no mode page ----------------
#
# The mode page offers "all users", which cannot be honoured without
# elevation. Its controls are laid out for 280 units of width; when Windows
# draws the elevation shield beside the "all users" radio button that budget
# is no longer enough and the label runs past the edge of the page.
#
# Choosing "all users" also restarts the installer in an elevated inner
# process, and that process re-enters the mode page's pre callback, which
# aborts the page outright (`UAC_IsInnerInstance` + `UAC_IsAdmin`). From the
# directory page, Back then asks for a page that immediately aborts again,
# which is the button press that looks like it does nothing.
#
# Pinning the mode to the current user removes the page, and with it both
# problems: nothing needs elevation, and the directory page becomes the first
# page so Back is disabled rather than dead. This is the layout the rest of
# the app already assumes -- the install directory is under LocalAppData and
# the app never asks for administrator rights at runtime.
#
# The macro name is lowercase `customInstallmode`; the template's
# `!ifmacrodef` is case sensitive, and the included macro is spelled
# `customInstallMode`.
!macro customInstallmode
  StrCpy $isForceCurrentInstall "1"
!macroend

# --- Say what the install is doing during the long phase ----------------
#
# `before-pack.mjs` keeps the details pane open through the whole install
# (`SetDetailsPrint both` where the template had `none`) and switches the
# unpack to the plugin's `ExtractWithDetails`, which prints
# "12% (34 / 280 MB)" while it works. This hook adds the line that follows the
# unpack, so the pane does not fall silent between the last file and the
# finish button.
#
# The silent guard matters: `SetDetailsPrint` addresses the installer window,
# and a silent install has none. The template guards its own call the same
# way, and `before-pack.mjs` leaves that guard in place. The check here is
# spelled with a plain `IfSilent` jump rather than LogicLib's
# `${IfNot} ${Silent}` because this file is pulled in ahead of the template's
# own includes, so whether LogicLib has been included yet is not something to
# rely on.
!macro customInstall
  IfSilent +2
  SetDetailsPrint both
  DetailPrint "应用文件已解压，正在完成安装…"
!macroend
