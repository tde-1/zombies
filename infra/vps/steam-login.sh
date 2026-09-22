#!/usr/bin/env bash
# /home/waw/steam-login.sh -- B runs this, interactively, to log Steam in ONCE.
# No agent runs it and no agent has ever run it. It takes no password argument
# on purpose (see below).
#
#   On your PC:   ssh -L 5900:localhost:5900 zombies-dev
#   On the box:   sudo -iu waw /home/waw/steam-login.sh <steam-username>
#   On your PC:   point any VNC viewer at localhost:5900
#
# You will see Steam's real window. Type the password there, and the Steam Guard
# code when it asks. After that the credentials are cached in the prefix and
# Steam starts logged in; you never need the VNC again unless Steam logs out.
#
# Why VNC and not `-login user password`:
#   * Steam still parses `-login <user> <password>`, but a password on a command
#     line lands in the process list, in bash history and in this box's logs.
#   * It does not survive Steam Guard. Unless the box is already an authorised
#     device, Steam asks for a code in a window, and there is no window to
#     answer in without a display you can see.
#   * Modern Steam draws its login UI in steamwebhelper (CEF). When that fails
#     under Wine the client looks alive and simply never logs in, with nothing
#     in the log to say why. Seeing the window is the difference between
#     debugging that in a minute and debugging it for an hour.
# So: `-login <username>` only, and you type the secret into the window.
#
# VNC is bound to 127.0.0.1 and the firewall does not open 5900. The SSH tunnel
# above is the only way in, which is deliberate -- an open unauthenticated VNC
# on a public IP would be a gift to the internet.
set -euo pipefail

USER_ARG="${1:-}"
export WINEPREFIX=/home/waw/pfx
export WINEARCH=win32
export WINEDEBUG=-all
export DISPLAY=:99
STEAM_DIR="$WINEPREFIX/drive_c/Program Files/Steam"

cleanup() { wineserver -k 2>/dev/null || true; pkill -u "$(id -un)" x11vnc 2>/dev/null || true; pkill -u "$(id -un)" Xvfb 2>/dev/null || true; }
trap cleanup EXIT

pkill -u "$(id -un)" Xvfb 2>/dev/null || true
pkill -u "$(id -un)" x11vnc 2>/dev/null || true
sleep 1

echo ">>> Xvfb on :99 (1280x800)"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 2

if command -v x11vnc >/dev/null; then
  echo ">>> x11vnc on 127.0.0.1:5900 -- tunnel with: ssh -L 5900:localhost:5900 zombies-dev"
  x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw -quiet >/tmp/x11vnc.log 2>&1 &
  sleep 1
else
  echo "!!! x11vnc not installed: apt-get install -y x11vnc"
fi

cd "$STEAM_DIR"
if [ -n "$USER_ARG" ]; then
  echo ">>> launching Steam with -login $USER_ARG (password goes in the window, not here)"
  wine Steam.exe -login "$USER_ARG"
else
  echo ">>> launching Steam with no -login; use the window"
  wine Steam.exe
fi

echo ">>> Steam exited. Shutting the display down."
