#!/bin/bash
# botrun.sh -- a soak game with server-side bots on the BOX, outside the host agent (lane S2,
# dedi.md §26). For proving a DLL that is NOT the box DLL yet: it runs in the test copy
# waw-tinst-01 (never waw-inst-*), with its own DLL, its own ports, its own homepath.
#
#   botrun.sh <tag> <map> <minutes> [bots] [dll]      (run as root; the game runs as waw)
#   env: SLOTS (sv_maxclients, 4), PORT (28966), LOBBY (3077), EXTRA_ENV ("K=V K=V"),
#        FLOOR_MB (refuse under this MemAvailable, 850), COPY (tinst-01)
#
# A REAL PLAYER ALWAYS WINS: a guard follows the host agent's journal and kills THIS game (our
# own pid, nothing else) the moment the site leases anything, and whenever MemAvailable falls
# under 250 MB. It refuses to start if a verified non-fake player was admitted in the last
# 15 minutes or MemAvailable is under FLOOR_MB (every production slot idle).
#
# Output: /home/waw/zdev-test/s2/<tag>/{samples.csv,enw.log,console.log,run.txt}
set -u
TAG=$1; MAP=$2; MIN=$3; BOTS=${4:-1}; DLL=${5:-}
SLOTS=${SLOTS:-4}; COPY=${COPY:-tinst-01}
GAMEDIR=/home/waw/pfx/drive_c/zdev/waw-$COPY
HOMEWIN="C:\\zdev\\homes\\$COPY"
HOMEDIR=/home/waw/pfx/drive_c/zdev/homes/$COPY
OUT=/home/waw/zdev-test/s2/$TAG
PORT=${PORT:-28966}; LOBBY=${LOBBY:-3077}; FLOOR_MB=${FLOOR_MB:-850}
mkdir -p "$OUT"; chown -R waw:waw /home/waw/zdev-test/s2
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT/run.txt"; }

# ---- is anyone playing? (rule 13) -------------------------------------------------------------
live=$(journalctl -u enw-host-agent --since '-15 min' --no-pager | grep -E 'auth slot .* ALLOW' | grep -v 7656119800000000 | tail -1)
if [ -n "$live" ]; then say "REFUSED: a verified player was admitted in the last 15 min: $live"; exit 3; fi
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "$avail" -lt "$FLOOR_MB" ]; then say "REFUSED: MemAvailable $avail MB < $FLOOR_MB"; exit 3; fi
if pgrep -f "^CoDWaW.exe .*homes.$COPY" >/dev/null; then say "REFUSED: a game already runs in $COPY"; exit 3; fi

# ---- the copy ---------------------------------------------------------------------------------
if [ -n "$DLL" ]; then install -o waw -g waw -m 755 "$DLL" "$GAMEDIR/binkw32.dll"; fi
rm -f "$GAMEDIR/enw_dev_god.off"
echo "$BOTS" > "$GAMEDIR/enw_dev_bots.txt"; chown waw:waw "$GAMEDIR/enw_dev_bots.txt"
say "dll $(sha256sum "$GAMEDIR/binkw32.dll" | cut -c1-16) map $MAP ${MIN}min bots $BOTS slots $SLOTS port $PORT copy $COPY MemAvailable ${avail}MB extra '${EXTRA_ENV:-}'"
case "$MAP" in nazi_zombie_prototype|nazi_zombie_asylum|nazi_zombie_sumpf|nazi_zombie_factory) FSG=();; *) FSG=(+set fs_game "mods/$MAP");; esac

cd "$GAMEDIR"
# shellcheck disable=SC2086
runuser -u waw -- env WINEPREFIX=/home/waw/pfx DISPLAY=:99 WINEDEBUG=-all SteamAppId=10090 SteamGameId=10090 \
  ENW_RAW_SOCKETS=1 ENW_DEDI_SUPPRESS_MAPSUMMARY=1 ENW_LOBBY_PORT=$LOBBY ENW_NO_PAUSE=1 ENW_DEDI_WATCH_PROBE_SLOT=1 \
  ENW_HOST=127.0.0.1:38799 ENW_INSTANCE="s2-$TAG" ENW_ROLE=server ENW_MATCH="s2-$TAG" ENW_PORT=$PORT \
  ENW_DEV_KNOBS=1 ENW_DEV_GOD=1 ENW_DEV_BOTS=$BOTS ${EXTRA_ENV:-} \
  /opt/wine-stable/bin/wine CoDWaW.exe +set fs_homepath "$HOMEWIN" +set r_fullscreen 0 +set r_mode 800x600 \
  +set vid_xpos -4000 +set vid_ypos -4000 +set com_introPlayed 1 +set com_startupIntroPlayed 1 \
  +set sys_configureGHz 1 +set ui_autoContinue 1 +set cl_allowDownload 0 +set developer 0 +set con_minicon 1 \
  +set com_maxfps 60 "${FSG[@]}" +set dedicated 1 +set zombiemode 1 +set logfile 2 +set s_volume 0 +set snd_volume 0 \
  +set con_typewriterColorBase 1.0 1.0 1.0 +set hud_drawhud 1 +set ui_campaign american \
  +set sv_maxclients "$SLOTS" +set net_port "$PORT" +map "$MAP" >"$OUT/wine.out" 2>&1 &
PID=""
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; PID=$(pgrep -f "^CoDWaW.exe .*homes.$COPY" | head -1); [ -n "$PID" ] && break; done
if [ -z "$PID" ]; then say "no game process"; exit 4; fi
say "game pid $PID"

# ---- the guard: a real player always wins ----------------------------------------------------
# Polls the journal every 2 s (not `journalctl -f`, whose reader outlives the game) and exits
# with the game, so a stale guard can never kill a recycled pid.
(
  last=$(date +%s)
  while kill -0 "$PID" 2>/dev/null; do
    sleep 2
    now=$(date +%s)
    hit=$(journalctl -u enw-host-agent --since "@$last" --no-pager -o cat 2>/dev/null | grep -E 'assignment changed: leased|RAM guard' | head -1)
    last=$now
    if [ -n "$hit" ]; then
      echo "[$(date -u +%H:%M:%S)] GUARD: the host is booting a lease -> killing our game $PID: $hit" >> "$OUT/run.txt"
      kill -9 "$PID" 2>/dev/null; exit 0
    fi
  done
) &
GUARD=$!
( while kill -0 "$PID" 2>/dev/null; do
    m=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
    if [ "$m" -lt 250 ]; then echo "[$(date -u +%H:%M:%S)] GUARD: MemAvailable $m MB -> killing our game $PID" >> "$OUT/run.txt"; kill -9 "$PID"; fi
    sleep 5
  done ) &
MEMG=$!

# ---- samples ----------------------------------------------------------------------------------
echo "utc,t_s,cpu_cores,rss_mb,mem_avail_mb,load1,bots,sv_p50,sv_p99,sv_max,sv_late100,com_p50,com_p99,com_max,com_late50,level_ratio,mt_cpu_pct,ws_mb,entities,actors_max,axis_max,kills_min,kills_total,body_hz,child_vars,round,escapes" > "$OUT/samples.csv"
t0=$(date +%s); prev=$(awk '{print $14+$15}' /proc/$PID/stat 2>/dev/null || echo 0); LOG=""
end_at=$((t0 + MIN*60))
fld() { echo "$db" | grep -oE "$1" | head -1 | grep -oE '[0-9]+(\.[0-9]+)?' | tail -1; }
while kill -0 "$PID" 2>/dev/null; do
  sleep 60
  kill -0 "$PID" 2>/dev/null || break
  now=$(date +%s); t=$((now - t0))
  cur=$(awk '{print $14+$15}' /proc/$PID/stat); cpu=$(awk -v a="$prev" -v b="$cur" 'BEGIN{printf "%.3f", (b-a)/100/60}'); prev=$cur
  rss=$(awk '/VmRSS/{print int($2/1024)}' /proc/$PID/status); mem=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  load=$(cut -d' ' -f1 /proc/loadavg)
  [ -z "$LOG" ] && LOG=$(ls -t "$GAMEDIR"/enw-*.log 2>/dev/null | head -1)
  db=$(grep 'dev_bots: bots' "$LOG" | tail -1)
  row="$(fld 'bots [0-9]+'),$(fld 'sv-frame n [0-9]+ p50 [0-9.]+'),$(fld 'sv-frame n [0-9]+ p50 [0-9.]+ p99 [0-9.]+'),$(fld 'sv-frame n [0-9]+ p50 [0-9.]+ p99 [0-9.]+ max [0-9.]+'),$(fld '>100ms [0-9]+')"
  row="$row,$(fld 'com-frame n [0-9]+ p50 [0-9.]+'),$(fld 'com-frame n [0-9]+ p50 [0-9.]+ p99 [0-9.]+'),$(fld 'com-frame n [0-9]+ p50 [0-9.]+ p99 [0-9.]+ max [0-9.]+'),$(fld '>50ms [0-9]+')"
  row="$row,$(fld '\(([0-9.]+)\) \|'),$(fld 'main-thread cpu [0-9.]+'),$(fld 'ws [0-9]+'),$(fld 'entities [0-9]+'),$(fld 'actors max [0-9]+'),$(fld 'axis [0-9]+'),$(fld '\| kills [0-9]+'),$(fld 'total [0-9]+')"
  hz=$(grep dedi_rate_probe "$LOG" | tail -1 | grep -oE 'Com_Frame-body [0-9.]+' | awk '{print $2}')
  child=$(grep 'varpool: child' "$LOG" | tail -1 | grep -oE 'child [0-9]+' | awk '{print $2}')
  round=$(grep 'referee: ROUND' "$LOG" | tail -1 | grep -oE 'ROUND [0-9]+' | awk '{print $2}')
  esc=$(grep -c 'ESCAPED frame' "$LOG")
  echo "$(date -u +%H:%M:%S),$t,$cpu,$rss,$mem,$load,$row,$hz,$child,$round,$esc" >> "$OUT/samples.csv"
  if grep -q 'FREEZE' "$LOG"; then say "t=${t}s the log has a FREEZE line"; fi
  if [ "$now" -ge "$end_at" ]; then
    say "t=${t}s time up: releasing god (enw_dev_god.off); the game should end itself"
    runuser -u waw -- touch "$GAMEDIR/enw_dev_god.off"
    for i in $(seq 1 24); do sleep 10; kill -0 "$PID" 2>/dev/null || break; grep -qE 'referee: .*(game over|GAME OVER|game_over)' "$LOG" && break; done
    say "ending: $(grep -E 'referee: .*(game over|GAME OVER|game_over)' "$LOG" | tail -1 | cut -c1-200)"
    kill "$PID" 2>/dev/null; sleep 5; kill -9 "$PID" 2>/dev/null
    break
  fi
done
kill "$GUARD" "$MEMG" 2>/dev/null
say "game gone at t=$(( $(date +%s) - t0 ))s; last round $(grep 'referee: ROUND' "$LOG" | tail -1 | grep -oE 'ROUND [0-9]+')"
[ -n "$LOG" ] && cp "$LOG" "$OUT/enw.log"
CL=$(find "$HOMEDIR" -name console.log -newer "$OUT/wine.out" 2>/dev/null | head -1); [ -n "$CL" ] && cp "$CL" "$OUT/console.log"
rm -f "$GAMEDIR/enw_dev_god.off" "$GAMEDIR/enw_dev_bots.txt"
grep -E 'FREEZE|ESCAPED|escape fault|dev_bots: (enwbot|an exception|ARMED|SV_DirectConnect|no free)|referee: ROUND|dev_god: slot' "$OUT/enw.log" | cut -c1-240 | head -80 >> "$OUT/run.txt"
say "done"
