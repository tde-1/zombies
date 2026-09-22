#!/usr/bin/env bash
# zombies-dev, pass 6: Node 24, the host agent, and the systemd units that bring the
# whole box back after a reboot.
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
#
# NO SECRET ON THE COMMAND LINE. The agent reads ENW_BOX / ENW_SECRET / ENW_SITE from the
# environment (host.js cfg), and systemd loads them from /root/enw-host.env, which is
# 0600 root:root. A command line is readable by every process on the box.
cat > /home/waw/run-host.sh <<'RUN'
#!/bin/bash
# The host agent on the Linux box. --wine replaces tools/dev/launch.ps1 with a direct
# `wine CoDWaW.exe`; {id} in either path gives each instance its own game copy and
# homepath, which is what lets more than one run (docs/kickstart/vps.md §15).
#
# --max-instances 2 is a MEASURED ceiling, not a guess: the party/lobby layer binds UDP
# 3074 with a single fallback to 3075, and a third instance binds no socket at all and
# parks inside Com_Init (vps.md §15).
cd /home/waw/enw/infra/host-agent
export ZOMBIES_DEV=/home/waw/zdev-host
exec /opt/node24/bin/node host.js \
  --game --wine \
  --wine-game-dir '/home/waw/pfx/drive_c/zdev/waw-{id}' \
  --wine-homepath 'C:\zdev\homes\{id}' \
  --base-port 28960 --max-instances 2 --dash off "$@"
RUN
chmod +x /home/waw/run-host.sh
chown waw:waw /home/waw/run-host.sh

banner "wait-for-the-rig, used by the unit's ExecStartPre"
# Works whether Xvfb and Steam were started by their units or by hand, which is the point:
# the box is half hand-built and the agent must not care who got there first.
cat > /usr/local/bin/enw-wait-rig <<'WAIT'
#!/bin/bash
for i in $(seq 1 120); do
  if pgrep -u waw -f 'Xvfb :99' >/dev/null && pgrep -u waw -f 'Steam.exe' >/dev/null; then
    # Steam reaching a CM takes longer than Steam existing. SteamStub asks the client to
    # validate app 10090, so a too-early game start is a game that exits(0) silently.
    sleep 10
    echo "rig ready after ${i}s: Xvfb :99 and the Steam client are up"
    exit 0
  fi
  sleep 1
done
echo "rig NOT ready after 120s (Xvfb :99 / Steam.exe)" >&2
exit 1
WAIT
chmod +x /usr/local/bin/enw-wait-rig

banner "systemd units"
cat > /etc/systemd/system/enw-xvfb.service <<'U'
[Unit]
Description=ENW Zombies — headless X display :99 for Wine
After=network.target

[Service]
User=waw
Group=waw
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -nolisten tcp
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
U

cat > /etc/systemd/system/enw-x11vnc.service <<'U'
[Unit]
Description=ENW Zombies — x11vnc on 127.0.0.1:5900 (SSH tunnel only)
After=enw-xvfb.service
Requires=enw-xvfb.service

[Service]
User=waw
Group=waw
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw -quiet
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
U

cat > /etc/systemd/system/enw-novnc.service <<'U'
[Unit]
Description=ENW Zombies — noVNC/websockify on 127.0.0.1:6080
After=enw-x11vnc.service
Requires=enw-x11vnc.service

[Service]
User=waw
Group=waw
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ 127.0.0.1:6080 127.0.0.1:5900
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
U

# Steam re-execs itself and OUTLIVES the wine process that started it (vps.md §5). A
# plain Type=simple unit would see its main process exit, call that a failure and start a
# SECOND Steam. So the ExecStart waits for the client to actually go away.
cat > /home/waw/run-steam.sh <<'STEAM'
#!/bin/bash
export WINEPREFIX=/home/waw/pfx WINEARCH=win32 WINEDEBUG=-all DISPLAY=:99
cd "$WINEPREFIX/drive_c/Program Files/Steam" || exit 1
# No -login and no password: "remember me" is on and the credentials are cached in the
# prefix. Nothing on this box, in this repo or in this unit has ever held one.
wine Steam.exe -silent >/tmp/steam-run.log 2>&1 &
sleep 20
while pgrep -u waw -f 'Steam.exe' >/dev/null; do sleep 15; done
echo "the Steam client has gone away" >&2
exit 1
STEAM
chmod +x /home/waw/run-steam.sh
chown waw:waw /home/waw/run-steam.sh

cat > /etc/systemd/system/enw-steam.service <<'U'
[Unit]
Description=ENW Zombies — Windows Steam client under Wine (SteamStub needs it)
After=enw-xvfb.service network-online.target
Requires=enw-xvfb.service

[Service]
User=waw
Group=waw
ExecStart=/home/waw/run-steam.sh
Restart=always
RestartSec=30
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
U

cat > /etc/systemd/system/enw-host-agent.service <<'U'
[Unit]
Description=ENW Zombies — host agent (Wine), polls https://zombies.enw.gg
After=enw-steam.service network-online.target
Wants=enw-steam.service

[Service]
User=waw
Group=waw
# Read as ROOT by the service manager before it drops to User=waw, so the file stays
# 0600 root:root and the secret never reaches a command line or another user's /proc.
EnvironmentFile=/root/enw-host.env
Environment=ENW_SITE=https://zombies.enw.gg
ExecStartPre=/usr/local/bin/enw-wait-rig
ExecStart=/home/waw/run-host.sh
Restart=on-failure
RestartSec=15
# The agent spools results to disk when the site is down, so a restart loses nothing.
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
U

systemctl daemon-reload
# ENABLE all of them so a reboot rebuilds the box; only START the agent, because Xvfb,
# x11vnc, websockify and Steam are already running by hand and a second copy of any of
# them is worse than none (kickstart: do not kill them).
systemctl enable enw-xvfb.service enw-x11vnc.service enw-novnc.service enw-steam.service enw-host-agent.service
for u in enw-xvfb enw-x11vnc enw-novnc enw-steam; do
  if systemctl is-active --quiet "$u"; then echo "$u: already active"; else echo "$u: enabled, NOT started (a hand-started one is live)"; fi
done

banner "start the host agent"
systemctl restart enw-host-agent.service
sleep 25
systemctl --no-pager --full status enw-host-agent.service | head -20
echo
journalctl -u enw-host-agent.service -n 25 --no-pager | sed -e 's/[A-Fa-f0-9]\{32,\}/<redacted>/g'

banner "done"
cat <<'MSG'
Units: enw-xvfb, enw-x11vnc, enw-novnc, enw-steam, enw-host-agent (all enabled).
Only enw-host-agent was started; the rest are already running by hand and will take over
on the next reboot.

    systemctl status enw-host-agent
    journalctl -u enw-host-agent -f

The secret lives ONLY in /root/enw-host.env (0600 root:root). It is not in this script,
not in the unit, not in the process list, and cannot be read back out of the site's API.
MSG
