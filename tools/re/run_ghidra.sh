#!/usr/bin/env bash
# Run Ghidra headless auto-analysis on the decrypted dump and export a function map.
# The dump is Activision code: the Ghidra project lives in ZombiesDev (never the repo), and
# only our JSON of addresses/names leaves it. Usage: bash tools/re/run_ghidra.sh [dump.exe]
set -euo pipefail
GHIDRA="C:/Users/b/ZombiesDev/tools/ghidra_12.1.3_PUBLIC"
export JAVA_HOME="C:/Program Files/Zulu/zulu-21"
DUMP="${1:-C:/Users/b/ZombiesDev/dumps/codwaw-1.7-a.exe}"
PROJ="C:/Users/b/ZombiesDev/ghidra-proj"
SCRIPTDIR="C:/Users/b/Desktop/Zombies/tools/re"
mkdir -p "$PROJ" "C:/Users/b/ZombiesDev/dumps/cache"
# -loader PeLoader with image base 0x400000; the dump's raw==virtual layout loads cleanly.
"$GHIDRA/support/analyzeHeadless.bat" "$PROJ" codwaw \
  -import "$DUMP" \
  -scriptPath "$SCRIPTDIR" \
  -postScript GhidraExport.java \
  -deleteProject \
  2>&1
