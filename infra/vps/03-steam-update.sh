#!/usr/bin/env bash
# zombies-dev, pass 3: run the Windows Steam client once, headless, so it
# self-updates, then stop it. NO LOGIN HAPPENS HERE and no password is handled.
#
#     ssh -o BatchMode=yes zombies-dev 'bash -s' < infra/vps/03-steam-update.sh
#
# Xvfb is started by hand rather than through xvfb-run: Steam re-execs itself
# and outlives the wine process that launched it, so xvfb-run pulls the display
# out from under it ("X connection to :99 broken") the moment wine returns.
set -euo pipefail

sudo -iu waw bash <<'WAW'
set -uo pipefail
export WINEPREFIX=/home/waw/pfx
export WINEARCH=win32
export WINEDEBUG=-all
export DISPLAY=:99

pkill -u waw Xvfb 2>/dev/null || true
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB=$!
sleep 3
echo ">>> Xvfb pid $XVFB"

cd "$WINEPREFIX/drive_c/Program Files/Steam"
echo ">>> launching Steam (no credentials on this command line)"
wine Steam.exe -no-browser -noreactlogin >/tmp/steam-run.log 2>&1 &
sleep 120

echo ">>> processes after 120 s"
pgrep -a -u waw -f 'steam|wine' | head -20 || echo "(none)"

echo ">>> did it update? package dir:"
ls -la "$WINEPREFIX/drive_c/Program Files/Steam/package" 2>/dev/null | head -15 || echo "(no package dir)"
echo ">>> steam dir:"
ls "$WINEPREFIX/drive_c/Program Files/Steam" | head -30
echo ">>> steam.cfg / logs:"
ls "$WINEPREFIX/drive_c/Program Files/Steam/logs" 2>/dev/null | head -20 || echo "(no logs dir)"
echo ">>> tail of the wine stdout log:"
tail -40 /tmp/steam-run.log || true
echo ">>> tail of Steam's own bootstrap log:"
tail -30 "$WINEPREFIX/drive_c/Program Files/Steam/logs/bootstrap_log.txt" 2>/dev/null || echo "(no bootstrap_log.txt)"

echo ">>> stopping Steam"
wineserver -k || true
sleep 2
kill $XVFB 2>/dev/null || true
pgrep -a -u waw -f 'steam|wine|Xvfb' || echo "(all stopped)"
WAW
echo ">>> pass 3 done"
