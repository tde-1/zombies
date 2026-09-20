#!/usr/bin/env bash
# Drain the remaining link checks, then regenerate the report and the document.
#
# The crawlers keep adding links while the checker runs, and check_links.py picks its
# work list once at startup, so one pass is never enough. This waits for any crawler to
# finish, runs the checker until a pass finds nothing left to do, and regenerates
# docs/kickstart/archive.md at the end. Safe to run twice; everything it calls is
# resumable and every response is cached.
set -u
A="C:/Users/b/Desktop/Zombies/archive"
L="C:/Users/b/ZombiesDev/archive/logs"
PY=python

running() {  # $1 = substring of the command line
  powershell -NoProfile -Command \
    "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object {\$_.CommandLine -like '*$1*'} | Measure-Object).Count" \
    | tr -d '\r\n '
}

echo "waiting for crawlers and any running checker to finish"
while [ "$(running codrepo.py)" != "0" ] || [ "$(running check_links.py)" != "0" ]; do
  sleep 60
done

for pass in 1 2 3 4 5; do
  left=$($PY -c "
import sys; sys.path.insert(0, r'C:\\Users\\b\\Desktop\\Zombies\\archive')
from lib import catalogue
db = catalogue.connect()
print(db.execute('select count(distinct url) from links where verdict is null').fetchone()[0])
")
  echo "pass $pass: $left links unchecked"
  [ "$left" = "0" ] && break
  $PY "$A/check_links.py" --max-hosts 8 >> "$L/linkcheck_final.out" 2>&1
done

$PY "$A/fixups.py" >> "$L/linkcheck_final.out" 2>&1
$PY "$A/export.py"
$PY "$A/report.py" --md > "$L/link-report.md"
$PY "$A/make_doc.py"
echo "FINISHED"
