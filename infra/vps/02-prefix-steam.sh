#!/usr/bin/env bash
# zombies-dev, pass 2: a 32-bit Wine prefix for the waw user, with the Windows
# Steam client installed into it. It does NOT log in and never handles a password.
#
#     ssh -o BatchMode=yes zombies-dev 'bash -s' < infra/vps/02-prefix-steam.sh
#
# Why 32-bit: CoDWaW's dedicated exe is a 32-bit Windows binary, and a win64
# prefix cannot run one without WoW64 quirks we would rather not debug. The
# prefix is built once and is cheap to throw away: rm -rf /home/waw/pfx.
set -euo pipefail
banner() { echo; echo ">>> $*"; }

banner "running as waw"
sudo -iu waw bash <<'WAW'
set -euo pipefail
export WINEPREFIX=/home/waw/pfx
export WINEARCH=win32
export WINEDEBUG=-all          # the prefix build is noisy and none of it matters
export DISPLAY=

echo ">>> wineboot (creates the prefix if it is not there)"
xvfb-run -a wineboot --init
wineserver -w
echo "prefix arch:"; grep -a '#arch' "$WINEPREFIX/system.reg" || true
ls -d "$WINEPREFIX/drive_c/windows/syswow64" 2>/dev/null \
  && echo "WARNING: syswow64 present -- this prefix is NOT pure win32" \
  || echo "no syswow64: prefix is 32-bit"

echo ">>> fetch SteamSetup.exe"
cd /home/waw
[ -f SteamSetup.exe ] || curl -fsSLO https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe
ls -l SteamSetup.exe; sha256sum SteamSetup.exe

echo ">>> silent install"
xvfb-run -a wine SteamSetup.exe /S || echo "installer exit $?"
wineserver -w
find "$WINEPREFIX/drive_c" -maxdepth 4 -iname 'steam.exe' -print
WAW
banner "pass 2 done"
