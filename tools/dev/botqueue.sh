#!/bin/bash
# botqueue.sh <queue-file> [dll] -- run botrun.sh for each line of a queue, one at a time (lane S2).
# Line: <tag> <map> <minutes> <bots> [K=V ...]   ('#' comments). A refused start (a player live,
# RAM short) waits 2 min and retries; a run the guard killed is re-queued once with tag suffix -r.
# Results: /home/waw/zdev-test/s2/queue.log (one line per run: tag, map, t, last round, result).
set -u
Q=$1; DLL=${2:-}
D=/home/waw/zdev-test/s2
LOGQ=$D/queue.log
while read -r tag map min bots rest; do
  [ -z "${tag:-}" ] && continue; case "$tag" in \#*) continue;; esac
  for attempt in 1 2; do
    t=$tag; [ "$attempt" = 2 ] && t="$tag-r"
    while true; do
      EXTRA_ENV="$rest" "$D/botrun.sh" "$t" "$map" "$min" "$bots" "$DLL" > "$D/$t.out" 2>&1
      rc=$?
      [ "$rc" = 3 ] && { sleep 120; continue; }
      break
    done
    R=$D/$t/run.txt
    last=$(grep -oE 'last round ROUND [0-9]+' "$R" | grep -oE '[0-9]+$')
    dur=$(grep -oE 'game gone at t=[0-9]+' "$R" | grep -oE '[0-9]+$')
    esc=$(grep -c 'ESCAPED' "$D/$t/enw.log" 2>/dev/null)
    frz=$(grep -c 'FREEZE' "$D/$t/enw.log" 2>/dev/null)
    guard=$(grep -c 'GUARD:' "$R")
    fault=$(grep -m1 'escape fault #1' "$D/$t/enw.log" 2>/dev/null | grep -oE 'eip=[0-9A-F]+')
    res=pass; [ "${frz:-0}" != 0 ] && res=FREEZE; [ "${esc:-0}" != 0 ] && [ "$res" = pass ] && res=escaped
    [ "$guard" != 0 ] && res=guard-killed
    echo "$(date -u +%FT%TZ) $t $map ${dur:-?}s round ${last:-?} $res esc=${esc:-0} ${fault:-}" >> "$LOGQ"
    [ "$res" = guard-killed ] || break
  done
done < "$Q"
echo "$(date -u +%FT%TZ) queue $Q done" >> "$LOGQ"
