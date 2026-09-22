# vps — the Hetzner dev box

The lane owns `infra/vps/` and one rented Linux machine. Its job is to answer a single question
the local dev box cannot: **can a 32-bit Windows CoD:WaW dedicated server run on cheap Linux under
Wine, with a headless Windows Steam client behind it?** Nothing in the shipping product depends on
it yet. It is a test rig.

**It is the only thing in this project that costs money.** Read §1 before you touch it.

---

## 1. The money, and the rule

| | net | gross (VAT 20 %) |
|---|---|---|
| cx23, hourly | €0.0088 | **€0.01056** |
| cx23, monthly | €5.49 | **€6.588** |
| primary IPv4, monthly | €0.50 | **€0.60** |
| **total monthly** | **€5.99** | **€7.188** |

**The rule: `zombies-dev` is the entire Zombies budget.** One server, one firewall, one ssh-key,
one primary IPv4. No second box, no larger type, no volume, no backup (they are +20 %), no
snapshot, no floating IP, no load balancer. Anything that would raise the bill goes back to B
first — kickstart rule 8 still applies to everything except this one box.

Billing is hourly and a deleted server stops costing immediately, so the real exposure while
experimenting is about **€0.012/hour gross**. If the box is idle for a week, delete it (§8) and
rebuild from `infra/vps/` — the scripts are the box.

**Evidence for the prices**: `hcloud server-type describe cx23` and `GET /v1/pricing`, read
2026-09-22 02:33 with this project's own token, so they are this account's real rates and not a
website's. The account's `vat_rate` is 20.

**How the spend was authorised, exactly** — because this is the one place in the repo where that
matters. The brief carried a hard ceiling of €6.00/month and the cheapest type that meets the spec
is €6.588 gross, so the agent stopped without creating anything and asked (`questions.md`).
Approval came back **relayed through the coordinator**, quoting B as "spin it up, that's fine,
just make sure we don't cost any more than that". That is a relay, not something the agent
observed B say. **If B did not say it, this box should be deleted and the €0.012/h stops.**

### Why cx23 and not something else

Requirement was the cheapest x86 shared-vCPU type with ≥2 vCPU, ≥4 GB RAM, ≥40 GB disk.

| type | vCPU | RAM | disk | €/mo gross | verdict |
|---|---|---|---|---|---|
| cpx12 | 1 | 2 GB | 40 GB | 4.788 | fails the spec |
| **cx23** | **2** | **4 GB** | **40 GB** | **6.588** | **chosen** |
| cx33 | 4 | 8 GB | 80 GB | 10.188 | headroom we have not earned |
| cpx22 | 2 | 4 GB | 80 GB | 23.388 | same spec, 3.5× the price |

`cpx21` — the old cheap 3-vCPU type that older notes and blog posts recommend — **no longer
exists**. It has been unavailable in every location since 2025-12-31. Do not go looking for it.

Note the trade: cx23's 40 GB disk is the tight dimension, not CPU or RAM. See §6.

---

## 2. What the box is

| | |
|---|---|
| Name | `zombies-dev` (Hetzner server ID 166888851) |
| Type / location | cx23 — 2 vCPU shared x86, 4 GB RAM, 40 GB local disk — **nbg1** (Nuremberg) |
| Image | `ubuntu-24.04`, kernel 6.8.0-139 |
| IPv4 | **2.28.235.236** (the game is IPv4-only; this is the address that matters) |
| IPv6 | `2a01:4f8:c0c:2dae::1` |
| Labels | `project=enw-zombies`, `purpose=dev` |
| Backups | **disabled** (they cost 20 % more) |
| Created | 2026-09-22 02:35 BST |

Hetzner project `enw-zombies`, which held nothing at all before this and now holds exactly these
three objects: the server, the firewall, the ssh-key. Both primary IPs are `auto delete = yes`, so
they disappear with the server rather than lingering as a charge.

**This box is not `gamebox` (49.12.126.167), `webbox` or `enw-bots`.** Those are B's other
machines, they are in other projects, and no Zombies agent has any business on them.

### Firewall `zombies-dev`

Inbound, everything else denied; outbound unrestricted.

| protocol | port | source | why |
|---|---|---|---|
| TCP | 22 | anywhere | ssh |
| UDP | 28960 | anywhere | the WaW game port |
| UDP | 3074–3075 | anywhere | WaW's secondary port, and the 3075 fallback a second instance takes |
| ICMP | — | anywhere | ping, and it is how we first proved the box was up |

**5900 is deliberately not open.** The VNC route in §5 goes through an SSH tunnel.

---

## 3. How to reach it

`C:\Users\b\.ssh\config` has:

```
Host zombies-dev
    HostName 2.28.235.236
    User root
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

So `ssh zombies-dev` and nothing else. The host key is already in `known_hosts`.

**Batch your remote work.** Hetzner rate-limits and then bans repeated SSH attempts, and the box's
own fail2ban had **banned two scanning IPs within fifteen minutes** of boot — that is how fast the
open internet finds a fresh Hetzner address. Do remote work as
`ssh -o BatchMode=yes zombies-dev 'bash -s' < infra/vps/<script>.sh`, not as a stream of one-line
sshs.

Root logs in by key only: `PasswordAuthentication no`, `PermitRootLogin prohibit-password`,
`KbdInteractiveAuthentication no`, in `/etc/ssh/sshd_config.d/99-zombies-dev.conf`. That path is
not decoration — Ubuntu 24.04's cloud image drops its own `50-cloud-init.conf` into that directory
and the files are read in name order, so a file that sorts *after* it is the one that wins.
Verified by `sshd -T` and by logging in again after the restart.

---

## 4. What is installed

- Patched to 2026-09-22 (`apt upgrade`), with `unattended-upgrades`, `fail2ban`, `htop`, `tmux`,
  `curl`, `xz-utils`, `python3`. `fail2ban`, `unattended-upgrades` and `ssh` all `active`.
- i386 multiarch enabled (`dpkg --print-foreign-architectures` → `i386`).
- **WineHQ stable, `wine-11.0`**, from the official WineHQ apt repo for noble
  (`winehq-stable 11.0.0.0~noble-1`) — not Ubuntu's own `wine` package. Plus `winetricks`
  (20240105), `xvfb`, `cabextract`, `fonts-wine`, and `x11vnc` for §5.
- User `waw` (uid 1000, home `/home/waw`). Everything Wine-related belongs to `waw`, never root.
- A **32-bit** Wine prefix at `/home/waw/pfx`: `#arch=win32` in `system.reg`, and no `syswow64`
  directory, which is the check that actually distinguishes a win32 prefix from a win64 one.
- The Windows Steam client at `/home/waw/pfx/drive_c/Program Files/Steam` (942 MB), updated to
  client build `1769731672`, **not logged in**.
- `/home/waw/steam-login.sh`, for B, §5.

The scripts that produced all of it are in `infra/vps/` and are idempotent: `01-base.sh`,
`02-prefix-steam.sh`, `03-steam-update.sh`. Rebuilding the box from scratch is three `ssh ... bash
-s <` lines plus `hcloud server create`.

---

## 5. Wine and Steam — what actually happened

**Observation, and better than expected.** The Windows Steam client installs and runs headless
under Wine 11 on this box with no tricks — no winetricks overrides, no DLL substitutions, no
`WINEDLLOVERRIDES`.

- `SteamSetup.exe` (sha256 `7d3654531c…0a12bcb`) installed silently with `wine SteamSetup.exe /S`.
- On first run Steam self-updated: a 229 MB download, extracted and installed in about 58 seconds,
  ending `Update complete, launching Steam...`.
- On the second run it verified its install and **connected to a Steam CM**:
  `ConnectionCompleted() (162.254.199.165:27018, WebSocket)`, and
  `Client thinks it can connect via: UDP - yes, TCP - yes, WebSocket:443 - yes`.
- `steam.exe` *and* **`steamwebhelper.exe`** both had live X windows on `:99`. That second one is
  the important one: steamwebhelper is the CEF process that draws the modern login UI, and it is
  the piece that usually dies under Wine.

**No login was attempted and no password was ever on this box.**

**Inference, not observation**: a client that reaches a CM and has a live steamwebhelper is one
that should be able to log in. Nobody has proved that, because proving it needs B's credentials.

**One trap, already paid for.** `xvfb-run wine Steam.exe` does not work: Steam re-execs itself and
outlives the `wine` process, so `xvfb-run` tears the display down underneath it and the logs fill
with `X connection to :99 broken`. Start `Xvfb :99` yourself and leave it running, as
`03-steam-update.sh` and `steam-login.sh` both do. `xvfb-run` is fine for `wineboot` and for the
installer, which do exit when they are done.

### The login procedure, for B

The most reliable headless route is **an SSH-tunnelled VNC and your own eyes on the window**, not
a command line. Three commands:

```
# 1. on your PC — tunnel VNC over ssh
ssh -L 5900:localhost:5900 zombies-dev

# 2. in that session — start the display, x11vnc and Steam
sudo -iu waw /home/waw/steam-login.sh <your-steam-username>

# 3. on your PC — any VNC viewer, no password
#    connect to  localhost:5900
```

Type the password, and the Steam Guard code, into the window you can now see. Steam caches the
credentials in the prefix afterwards, so this is once, not every time.

**Why not just `-login <user> <password>`?** Steam does still parse it, and it is the obvious thing
to reach for, but it is the wrong answer here for three reasons: the password lands in the process
list, the shell history and the journal; it does not survive Steam Guard, which asks in a window
whether you have a display or not; and when the CEF login UI fails under Wine the client stays
alive and simply never logs in, with nothing in any log saying why. Being able to look at the
window turns that from an hour into a minute. `steam-login.sh` therefore takes a username and no
password, on purpose.

x11vnc is bound to `127.0.0.1` and 5900 is closed at the Hetzner firewall, so the tunnel is the
only way in. Keep it that way: an unauthenticated VNC on a public IP is a gift to the scanners
that, as noted above, find this address within minutes.

---

## 6. Headroom

Measured after everything above was installed, with Steam stopped:

```
/dev/sda1   38G   6.2G used   30G avail   18%
Mem: 3819 MB total, 3320 MB available      nproc: 2
```

**30 GB free.** WaW is about 12 GB, so it fits with roughly 18 GB spare — enough for the game and
a dump or two, not enough for two full copies plus a core file. Disk is the dimension that will
run out first on a cx23, and there is no volume to fall back on because a volume costs money. If
it gets tight, delete the prefix's Steam download cache before asking for a bigger box.

---

## 7. What this lane has NOT done

Kept explicit so nobody assumes otherwise:

- **No Steam login, no Steam account touched, no game installed.** That is B's, deliberately.
- **WaW has never run on this box.** Whether the dedicated exe works under Wine is the whole
  question and it is still open. Everything above is only the rig.
- **Nothing here is connected to the rest of the project.** No host agent, no client DLL, no
  referee. The box does not know ENW Zombies exists.

---

## 8. How to delete everything

Three commands, and the bill stops at the next hour:

```
hcloud server delete zombies-dev
hcloud firewall delete zombies-dev
hcloud ssh-key delete b-desktop
```

The two primary IPs are `auto delete = yes` and go with the server; there are no volumes,
snapshots or backups to catch you out. Confirm with `hcloud server list` and
`hcloud primary-ip list` — both should come back empty, which is the state the project was in
before 2026-09-22 02:35.

Then tidy the `Host zombies-dev` block out of `C:\Users\b\.ssh\config`.

`hcloud` itself is **not installed system-wide**: `winget install Hetzner.hcloud` returns "No
package found matching input criteria", so it is the GitHub release zip
(`hetznercloud/cli` v1.68.0, `hcloud-windows-amd64.zip`) unpacked in an agent scratchpad, which
does not survive. Re-download it. The token comes from `infra/hcloud.env`, which is git-ignored
and stays that way:

```bash
set -a; . infra/hcloud.env; set +a     # never echo it, never paste it into a prompt
```
