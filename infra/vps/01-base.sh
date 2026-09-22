#!/usr/bin/env bash
# zombies-dev, pass 1: patch, harden sshd, create the waw user, install WineHQ stable.
#
# Run from B's PC, not on the box:
#     ssh -o BatchMode=yes zombies-dev 'bash -s' < infra/vps/01-base.sh
#
# Idempotent: safe to re-run. Every step prints a >>> banner so a truncated log
# still says how far it got.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a          # restart services without the ncurses prompt
banner() { echo; echo ">>> $*"; }

banner "apt update && upgrade"
apt-get update -qq
apt-get upgrade -y -qq

banner "base packages"
apt-get install -y -qq unattended-upgrades fail2ban htop tmux curl xz-utils python3 \
                       ca-certificates wget gnupg

banner "sshd: keys only"
# Ubuntu 24.04 reads /etc/ssh/sshd_config.d/*.conf before the main file, and the
# cloud image drops a 50-cloud-init.conf in there. A file that sorts after it wins.
cat > /etc/ssh/sshd_config.d/99-zombies-dev.conf <<'SSHD'
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
SSHD
sshd -t                            # refuse to restart on a broken config
systemctl restart ssh
sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '

banner "user waw"
id -u waw >/dev/null 2>&1 || useradd -m -d /home/waw -s /bin/bash waw
install -d -o waw -g waw -m 0755 /home/waw

banner "i386 multiarch"
dpkg --add-architecture i386

banner "WineHQ apt repo (noble)"
install -dm755 /etc/apt/keyrings
wget -qO /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key
wget -qNP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/noble/winehq-noble.sources
apt-get update -qq

banner "winehq-stable + tools"
apt-get install -y -qq --install-recommends winehq-stable
apt-get install -y -qq winetricks xvfb cabextract fonts-wine

banner "versions"
wine --version
winetricks --version || true
echo "apt policy winehq-stable:"; apt-cache policy winehq-stable | head -3

banner "pass 1 done"
