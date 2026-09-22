# The monitor list, for the parts of the launcher that are plain node.
#
# `play-cli.js --dry-run` and the boot flow have no Electron `screen`, and a dry run
# that cannot say what resolution the game will get is not worth much. This prints one
# pipe-separated line per display:
#
#     \\.\DISPLAY1|0|0|3840|2160|True
#
# SetProcessDPIAware() FIRST is the whole point. Without it a 4K display at 150%
# reports 2560x1440, and `r_mode 2560x1440` is a mode the game does not have. With it,
# Bounds are physical pixels -- which is what `r_mode`, `vid_xpos` and `vid_ypos` want.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name Dpi -Namespace Enw | Out-Null
[void][Enw.Dpi]::SetProcessDPIAware()
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  '{0}|{1}|{2}|{3}|{4}|{5}' -f $s.DeviceName, $s.Bounds.X, $s.Bounds.Y, $s.Bounds.Width, $s.Bounds.Height, $s.Primary
}
