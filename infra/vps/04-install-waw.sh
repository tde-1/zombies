#!/usr/bin/env bash
# zombies-dev, pass 4: install Call of Duty: World at War (app 10090) into the
# Windows Steam client that is already running, logged in, under Xvfb :99.
#
#     ssh -o BatchMode=yes zombies-dev 'bash -s' < infra/vps/04-install-waw.sh
#
# Idempotent: if appmanifest_10090.acf already says StateFlags 4 (fully
# installed) it prints the manifest and exits 0 without touching anything.
#
# NO CREDENTIALS. This script assumes the client is already logged in (that is
# B's job, infra/vps/steam-login.sh + the VNC tunnel in docs/kickstart/vps.md
# section 5) and never handles a password, a Guard code or a token.
#
# Requires: Xvfb :99 up and Steam.exe running as user waw. It drives the
# client's own Install dialog, because `steam://install/<id>` only queues the
# download after that dialog's Install button is pressed.
set -uo pipefail

STEAM="/home/waw/pfx/drive_c/Program Files/Steam"
APPS="$STEAM/steamapps"
ACF="$APPS/appmanifest_10090.acf"
banner() { echo; echo ">>> $*"; }

state() { [ -f "$ACF" ] && grep -o '"StateFlags"[^0-9]*[0-9]*' "$ACF" | grep -o '[0-9]*$' || echo none; }

banner "current state"
echo "StateFlags = $(state)"
df -h / | tail -1

if [ "$(state)" = "4" ]; then
  banner "already installed - nothing to do"
  grep -E 'name|StateFlags|SizeOnDisk|buildid|LastOwner' "$ACF"
  exit 0
fi

if ! pgrep -u waw -f 'Steam.exe' >/dev/null; then
  echo "ERROR: the Steam client is not running as waw. Start it first (steam-login.sh)." >&2
  exit 1
fi

if [ "$(state)" = "none" ]; then
  banner "asking the running client to install app 10090"
  # The URL reaches the client that is already running; a second Steam.exe just
  # forwards the argument and exits.
  sudo -iu waw bash -c 'cd "/home/waw/pfx/drive_c/Program Files/Steam" \
    && WINEPREFIX=/home/waw/pfx DISPLAY=:99 wine Steam.exe steam://install/10090 >/dev/null 2>&1 &'
  sleep 12

  # The Install dialog is centred on the 1280x800 root window. Plain `xdotool
  # click` only hovers in this CEF build: the button needs an explicit
  # mousemove / mousedown / mouseup with pauses between them.
  banner "pressing Install in the dialog"
  X="sudo -u waw DISPLAY=:99 xdotool"
  $X mousemove 575 583; sleep 0.4; $X mousedown 1; sleep 0.15; $X mouseup 1
  sleep 10
fi

# --------------------------------------------------------------- wait for it --
banner "waiting for the download (up to 60 min)"
start=$(date +%s)
for _ in $(seq 1 120); do
  sf=$(state)
  now=$(date +%s)
  printf 't=%4ss StateFlags=%-6s downloading=%sMB common=%sMB free=%sMB\n' \
    $((now - start)) "$sf" \
    "$(du -sm "$APPS/downloading" 2>/dev/null | cut -f1)" \
    "$(du -sm "$APPS/common" 2>/dev/null | cut -f1)" \
    "$(df -m / | awk 'NR==2{print $4}')"
  [ "$sf" = "4" ] && { echo "INSTALL COMPLETE after $((now - start))s"; break; }
  # Disk is the tight dimension on a cx23 (docs/kickstart/vps.md section 6).
  [ "$(df -m / | awk 'NR==2{print $4}')" -lt 1500 ] && {
    echo "ABORT: under 1.5 GB free. Clear the Steam download cache before retrying." >&2; exit 2; }
  sleep 30
done

banner "result"
grep -E 'name|StateFlags|SizeOnDisk|buildid|LastOwner|BytesToDownload' "$ACF"
du -sh "$APPS/common/Call of Duty World at War" 2>/dev/null
df -h / | tail -1
[ "$(state)" = "4" ]
