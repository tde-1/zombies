#!/usr/bin/env bash
# zombies-dev, pass 6: Node 24 and the host agent on the box.
#
#     ssh -o BatchMode=yes zombies-dev 'bash -s' < infra/vps/06-node-host-agent.sh
#
# Then push the agent itself from B's PC (one ssh session, and it is only ~500 KB):
#
#     tar -cf - infra/host-agent referee/manifests \
#       | ssh -o BatchMode=yes zombies-dev 'tar -xf - -C /home/waw/enw && chown -R waw:waw /home/waw/enw'
#
# Ubuntu 24.04 ships Node 18 and the host agent needs 24 (zstd in node:zlib, Ed25519,
# node:sqlite). This installs the official tarball into /opt/node24 and leaves the
# distro's /usr/bin/node alone, so nothing else on the box changes.
#
# Idempotent: re-running with a v24 already in place prints the version and exits 0.
set -uo pipefail
banner() { echo; echo ">>> $*"; }

if [ -x /opt/node24/bin/node ] && /opt/node24/bin/node -v | grep -q '^v2[4-9]'; then
  banner "already installed: $(/opt/node24/bin/node -v)"
else
  banner "installing the newest Node 24"
  cd /tmp
  V=$(curl -fsSL https://nodejs.org/dist/index.json \
      | python3 -c 'import json,sys;print([r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v24.")][0])')
  echo "version $V"
  curl -fsSL -o node.tar.xz "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
  mkdir -p /opt/node24
  tar -xJf node.tar.xz -C /opt/node24 --strip-components=1
  rm -f node.tar.xz
  ln -sfn /opt/node24/bin/node /usr/local/bin/node24
  /opt/node24/bin/node -v
fi

banner "the agent's data directories (ZOMBIES_DEV, Linux side)"
sudo -u waw mkdir -p /home/waw/zdev-host/logs /home/waw/zdev-host/replays /home/waw/zdev-host/keys
sudo -u waw mkdir -p /home/waw/enw
ls -ld /home/waw/zdev-host /home/waw/enw

banner "a runner, so the quoting lives in a file and not in an ssh command line"
# Backslashes in a Windows path do not survive `ssh … bash -c '…'`; they do survive a
# heredoc into a script. That cost a run.
cat > /home/waw/run-host.sh <<'RUN'
#!/bin/bash
# The host agent on the Linux box. --wine replaces tools/dev/launch.ps1 with a direct
# `wine CoDWaW.exe`; {id} in either path gives each instance its own game copy and
# homepath, which is what lets more than one run (docs/kickstart/vps.md §15).
cd /home/waw/enw/infra/host-agent
export ZOMBIES_DEV=/home/waw/zdev-host
exec /opt/node24/bin/node host.js \
  --box zombies-dev --game --wine \
  --wine-game-dir '/home/waw/pfx/drive_c/zdev/waw-{id}' \
  --wine-homepath 'C:\zdev\homes\{id}' \
  --map nazi_zombie_prototype --base-port 28960 --dash off "$@"
RUN
chmod +x /home/waw/run-host.sh
chown waw:waw /home/waw/run-host.sh

banner "done"
cat <<'MSG'
Start it with, for example:

    sudo -iu waw bash -c 'setsid nohup /home/waw/run-host.sh --boot 1 >/tmp/host-agent.out 2>&1 &'

The box is NOT registered with the live site: that needs a per-box secret created with
boxes.create() against web/data/zombies.db, which the vps lane does not write to. Once it
exists, add:  --site https://zombies.enw.gg --secret <secret>

Two instances is the ceiling (vps.md §15) and they must be started ONE AT A TIME.
MSG
