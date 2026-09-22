#!/usr/bin/env bash
# zombies-dev, pass 5: make a dev copy of the installed WaW and run OUR headless
# dedicated server out of it, under Wine, on the Xvfb display.
#
#     ssh -o BatchMode=yes zombies-dev 'bash -s' < infra/vps/05-run-dedi.sh
#     ssh -o BatchMode=yes zombies-dev 'NAME=vps1 MAP=nazi_zombie_prototype \
#         PORT=28960 SECONDS_TO_RUN=180 bash -s' < infra/vps/05-run-dedi.sh
#
# Expects /tmp/enw_t4.dll to be the build you want (scp it from B's PC:
#     powershell -File tools\dev\build.ps1 -Name dedi
#     scp build\dedi\enw_t4.dll zombies-dev:/tmp/ )
#
# RULE 1 APPLIES HERE TOO: nothing is ever written into
# steamapps/common/Call of Duty World at War. The dev copy real-copies the
# top-level FILES (so binkw32.dll can be replaced) and SYMLINKS the top-level
# directories, which is the Linux spelling of what tools\dev\new-copy.ps1 does
# with mklink /J on B's PC. Never write through those symlinks.
#
# Idempotent: re-running refreshes the DLL and relaunches; the copy is rebuilt
# only if it is missing (REBUILD=1 forces it).
set -uo pipefail

NAME=${NAME:-vps1}
MAP=${MAP:-nazi_zombie_prototype}
PORT=${PORT:-28960}
MAXFPS=${MAXFPS:-60}
SECONDS_TO_RUN=${SECONDS_TO_RUN:-180}
REBUILD=${REBUILD:-0}
DLL=${DLL:-/tmp/enw_t4.dll}

PFX=/home/waw/pfx
# GAME is what the dev copy is made FROM. The default is the box's own Steam
# install; set GAME=/home/waw/waw-en to build the copy from B's English tree
# instead (vps.md section 13 -- the box's Steam account is German, so its own
# install is the low-violence edition with a different address map and no
# nazi_zombie_prototype).
GAME=${GAME:-"$PFX/drive_c/Program Files/Steam/steamapps/common/Call of Duty World at War"}
DEST="$PFX/drive_c/zdev/waw-$NAME"
HOME_U="$PFX/drive_c/zdev/homes/$NAME"
HOME_W="C:\\zdev\\homes\\$NAME"
MARKER="$PFX/drive_c/users/waw/AppData/Local/Activision/CoDWaW/__CoDWaW"

banner() { echo; echo ">>> $*"; }

[ -d "$GAME" ] || { echo "ERROR: WaW is not installed at $GAME (run 04-install-waw.sh)" >&2; exit 1; }
[ -f "$DLL" ]  || { echo "ERROR: no DLL at $DLL" >&2; exit 1; }

# ------------------------------------------------------------- the dev copy --
if [ "$REBUILD" = "1" ] && [ -d "$DEST" ]; then
  banner "REBUILD=1: removing $DEST (symlinks are unlinked, never followed)"
  find "$DEST" -maxdepth 1 -type l -delete
  rm -rf "$DEST"
fi

if [ ! -d "$DEST" ]; then
  banner "building the dev copy at $DEST"
  sudo -u waw mkdir -p "$DEST"
  # top-level files: real copies, because we replace one of them
  find "$GAME" -maxdepth 1 -type f -print0 | sudo -u waw xargs -0 -I{} cp -a {} "$DEST/"
  # top-level directories: symlinks, read-only by convention
  for d in "$GAME"/*/; do
    sudo -u waw ln -sfn "${d%/}" "$DEST/$(basename "$d")"
  done
  # SteamStub: without this (and SteamAppId in the environment) a copied exe
  # exits(0) after ~1.5 s having written nothing, because the stub asks Steam to
  # relaunch app 10090 out of the Steam folder instead.
  echo -n 10090 | sudo -u waw tee "$DEST/steam_appid.txt" >/dev/null
fi

banner "installing enw_t4.dll as the binkw32.dll proxy"
if [ ! -f "$DEST/binkw32_org.dll" ]; then
  sudo -u waw mv "$DEST/binkw32.dll" "$DEST/binkw32_org.dll"
  echo "stashed the stock binkw32.dll -> binkw32_org.dll"
fi
sudo -u waw rm -f "$DEST/binkw32.dll"          # rm, never write in place
sudo -u waw cp -a "$DLL" "$DEST/binkw32.dll"
ls -la "$DEST/binkw32.dll" "$DEST/binkw32_org.dll" "$DEST/CoDWaW.exe"

sudo -u waw mkdir -p "$HOME_U/main"            # or the engine may write no console.log at all
sudo -u waw rm -f "$MARKER"                    # the safe-mode marker, or a modal blocks the boot
sudo -u waw rm -f "$DEST"/enw-*.log
sudo -u waw rm -f "$HOME_U/main/console.log"

# A PLAYER PROFILE, or +map is refused. A fresh box has none, and the engine's
# answer is one line in console.log -- `Can't find map` never appears, it says
# `Can't load a map without a player profile selected.` and then falls through
# to CLIENT init, Direct3DCreate9 and a modal "Error during initialization".
# active.txt holds the profile name; the directory is the profile.
PROF="$PFX/drive_c/users/waw/AppData/Local/Activision/CoDWaW/players/profiles"
sudo -u waw mkdir -p "$PROF/enwdedi"
printf 'enwdedi' | sudo -u waw tee "$PROF/active.txt" >/dev/null
[ -s "$PROF/enwdedi/config.cfg" ] || printf '// created by infra/vps/05-run-dedi.sh\nseta com_introPlayed "1"\nseta com_startupIntroPlayed "1"\n' \
  | sudo -u waw tee "$PROF/enwdedi/config.cfg" >/dev/null

# ------------------------------------------------------------------ launch --
banner "launching the dedicated server: map=$MAP udp/$PORT com_maxfps=$MAXFPS"
# Kill only OUR previous runs. Match on `zdev` (which is in every argv we pass,
# as `C:\zdev\homes\<name>`) -- NOT on `zdev/waw-`, which is only the working
# directory and never appears in argv, and not on the bare exe name, which
# would be somebody else's process.
for p in $(pgrep -u waw -f 'zdev'); do echo "killing our previous run: $p"; kill -9 "$p" 2>/dev/null; done
sleep 3
pgrep -u waw -f 'Xvfb :99' >/dev/null || { echo "ERROR: Xvfb :99 is not running" >&2; exit 1; }
pgrep -u waw -f 'Steam.exe' >/dev/null || echo "WARNING: the Steam client is NOT running; SteamStub will not decrypt"

sudo -iu waw bash -c "cd '$DEST' && \
  WINEPREFIX=$PFX DISPLAY=:99 WINEDEBUG=-all \
  SteamAppId=10090 SteamGameId=10090 \
  ENW_DEDI_SUPPRESS_MAPSUMMARY=1 ENW_RAW_SOCKETS=1 \
  ENW_ROLE=server ENW_INSTANCE=$NAME \
  setsid nohup wine CoDWaW.exe \
    +set fs_homepath '$HOME_W' \
    +set logfile 2 +set r_fullscreen 0 +set r_mode 800x600 \
    +set vid_xpos -4000 +set vid_ypos -4000 \
    +set s_volume 0 +set snd_volume 0 +set snd_menu_master 0 \
    +set com_introPlayed 1 +set com_startupIntroPlayed 1 \
    +set sys_configureGHz 1 +set ui_autoContinue 1 +set cl_allowDownload 0 \
    +set developer 0 +set con_minicon 1 \
    +set dedicated 1 +set zombiemode 1 +set com_maxfps $MAXFPS \
    +set con_typewriterColorBase '1.0 1.0 1.0' +set hud_drawhud 1 +set ui_campaign american \
    +set sv_maxclients 4 +set net_port $PORT \
    +map $MAP >/tmp/dedi-$NAME.out 2>&1 &"

# ------------------------------------------------------- watch, and prove it --
start=$(date +%s)
answered=0
for _ in $(seq 1 $((SECONDS_TO_RUN / 10))); do
  sleep 10
  now=$(date +%s); t=$((now - start))
  # -x on the comm, not -f on the args: -f also matches the `bash -c` wrapper,
  # whose 2 MB RSS is not the server's.
  ps=$(pgrep -u waw -x 'CoDWaW.exe' | head -1)
  if [ -n "$ps" ]; then
    read -r cpu rss <<<"$(ps -o pcpu=,rss= -p "$ps" | tr -s ' ')"
    printf 't=%3ss pid=%s cpu=%s%% rss=%sMB\n' "$t" "$ps" "$cpu" "$((rss / 1024))"
  else
    printf 't=%3ss CoDWaW.exe GONE\n' "$t"
  fi
  if [ "$answered" = 0 ] && python3 /tmp/oob.py "$PORT" --timeout 1.0 >/tmp/oob-$NAME.txt 2>&1; then
    answered=$t; echo "  ANSWERED on udp/$PORT after ${t}s"; cat /tmp/oob-$NAME.txt
  fi
done

banner "our DLL's log"
tail -n 60 "$DEST"/enw-*.log 2>/dev/null || echo "(no enw log)"
banner "the engine's console.log"
tail -n 40 "$HOME_U/main/console.log" 2>/dev/null || echo "(no console.log)"
banner "verdict"
echo "answered_after=${answered}s (0 = never)"
[ "$answered" != 0 ]
