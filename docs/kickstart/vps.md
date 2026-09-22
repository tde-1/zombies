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

- ~~**No Steam login, no Steam account touched, no game installed.** That is B's, deliberately.~~
  **Superseded 2026-09-22 03:00 (§9):** B logged the client in on a throwaway account and WaW is
  now installed. No password, Guard code or token has ever been on this box or in this repo, and
  that part has not changed.
- ~~**WaW has never run on this box.**~~ **Superseded (§10): it has.** It boots, decrypts under
  SteamStub, loads a zombies map, and then shuts itself down without answering on the wire.
  Whether the dedicated exe *works* under Wine is therefore still open, and §10 says precisely
  what is in the way.
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

---

## 9. WaW is installed on the box (2026-09-22 03:00)

**Observation.** The account the client is logged in as **owns app 10090** and the game installs
headlessly with no tricks.

| | |
|---|---|
| Ownership | the client's own Install dialog opened for "Call of Duty: World at War, 9.38 GB". Steam opens the *store page* for an app you do not own, so the dialog is the proof. `appmanifest_10090.acf` then wrote `"LastOwner" "76561198028405776"` |
| Download | **6,660,922,368 bytes**, `BytesDownloaded == BytesToDownload` |
| On disk | **8,350,249,680 bytes**, `StateFlags 4`, `buildid 252004` |
| Time | **150 s** from pressing Install to `StateFlags 4` (~44 MB/s from `cache*-iev-giga.steamcontent.com`) |
| Free afterwards | 21 GB of 38 GB |

`infra/vps/04-install-waw.sh` does it and is idempotent (`StateFlags 4` -> exit 0, touch nothing).

**Nothing was bought, and no password, Guard code or token was handled, logged or written down.**

### The two install traps

1. **`steam://install/10090` only opens the dialog.** It does not queue anything. The Install
   button has to be pressed, and in this CEF build `xdotool click` merely hovers: it needs
   `mousemove; sleep 0.4; mousedown 1; sleep 0.15; mouseup 1`. At 1280x800 the button is at
   **(575, 583)**.
2. **The download came in GERMAN, and German WaW has no `nazi_zombie_prototype`.** Base depot
   10091 is shared, but the localised depot the box got is **10097 (German)** where B's PC has
   **10092 (English)**. The German build ships `zone/German/` only, with `nazi_zombie_asylum` and
   `nazi_zombie_sumpf` and **no `nazi_zombie_prototype` and no `nazi_zombie_factory`** - the
   censored German release. `+map nazi_zombie_prototype` therefore fails with
   `Error: Can't find map "nazi_zombie_prototype". A mod is required for custom maps`, which reads
   like a mod problem and is not one. The `UserConfig` block in the manifest says
   `"language" "english"` and is **not** what Steam used; it followed the account's own language.
   Fixing it means setting the app's language in the client's game Properties and re-downloading
   depot 10092 (4.19 GB), which is **not done** - it was not the blocker (§10) and it changes a
   setting on B's throwaway account, so it is left for B.

The Steam client's red banner **"Steam no longer supports running on 32-bit Windows"** is cosmetic
so far: in the win32 prefix the client logged in, browsed the library, queued and completed a 6.7 GB
download. **No reason to move to a win64 prefix was found.**

## 10. The headless server under Wine: it boots, and it will not answer

> **SUPERSEDED 2026-09-22 05:10 by §13 — with B's ENGLISH copy on the box the server boots AND
> ANSWERS** (`oob.py` from B's PC, exit 0). Everything below is a true account of the box running
> its *own* German install, and the measurements are kept because they are what identified the
> edition difference. Read §13 for what the box does now.

**Verdict: no.** Our dedicated build runs on the box, loads a zombies map, and then shuts itself
down. `tools/dev/oob.py` from B's PC against the public address is the gate and it **fails**:

```
> python tools\dev\oob.py 28960 --host 2.28.235.236 --allow-remote --timeout 3.0
getstatus      NO REPLY
getinfo        NO REPLY
getchallenge   NO REPLY
OOB EXIT CODE = 1
```

### What *did* work, and it is most of the rig

* **SteamStub decrypts under Wine.** This was the open question and the answer is yes:
  `steamstub: decrypted after 869 ms (252 polls); 0x401000 = 55 8B EC 83 E4 F8 ...`, with the Steam
  client running and `SteamAppId`/`SteamGameId` in the environment, in the **win32** prefix. There
  is no `STILL ENCRYPTED` anywhere in any run.
* The proxy DLL loads (`binkw32.dll`), all 36 components register, and the IAT-based ones
  (focus guard, DNS filter, destination lockdown, `no_winconsole`, the non-blocking message pump)
  arm normally - they do not depend on engine addresses.
* The engine boots, opens **`0.0.0.0:28960`** (confirmed with `ss -ulnp`; it also takes 3074),
  reaches `------ Server Initialization ------`, `Server: nazi_zombie_asylum`,
  `dvar set sv_running 1`, loads the map fastfiles and runs the zombiemode GSC
  (`dvar set g_spawnai 1`).
* Idle cost, measured on the cx23 after it fell back to the menu: **RSS 362 MB, 10 threads, 6.31 s
  of CPU in 563 s of wall clock (1.1 % of one core)**. No frame rate: see below.

### Why it will not answer: our address map is not portable between Steam copies

**This is the finding of the session, and it is bigger than this box.**

Every engine patch we have is a hardcoded VA verified against **B's** `CoDWaW.exe`. On the box every
single one of them refused to apply:

```
game: Com_Printf   @ 0059A2C0 *** SUSPECT ***  bytes: 09 80 7F 01 00 74 03 83 C7 02 ...
frame: 005FF7BD is not a call instruction (44 35 88 00 ...) - no per-frame tick
raw_sockets: NOT patching 0x00600109. Expected `je +0x34` (74 34), found C0 C3
hooks: SV_Frame: 00635CC0 does not look like code. Refusing to hook.
hooks: MSG_ReadBitsCompress: 006751D0 does not look like code. Refusing to hook.
huffman: THE SERVER IS UNPROTECTED against CVE-2018-10718-class overflow
direct_connect: 00642E77 is 16 8D 4C 24 14, expected E8 64 92 F3 FF
```

The two executables are the **same game** and the **same Steam build** - `buildid 252004`,
`Build 1263 JADAMS2 350073 CL(Thu Oct 29 15:43:55 2009)`, both 5,902,336 bytes - and they are
**different binaries**: sha256 `732900D1...` (B) vs `53c48cce...` (box), differing on 5,135,285 of
5,902,336 bytes on disk.

That much was expected - SteamStub encrypts with a per-copy key. The part that matters is that the
**decrypted** images differ too. `/proc/<pid>/mem` of the live Wine process was dumped (the PE is
mapped at 0x400000 like any other process, so no Windows tooling is needed) and compared with
`ZombiesDev\dumps\codwaw-1.7-a.exe`:

* `.text[0]` is byte-identical on both, so the decryption is real and complete;
* but only **10.9 %** of `.text` matches at the same offset, and **0 of 1001** 4 KB pages match;
* the first 64 bytes are the *same instructions* with **different absolute data pointers**
  (`mov ...,0x008AF1D8` on the box where B has `0x008AF218`);
* matching each function by its prologue gives a small, **piecewise-constant** shift:

| function | B's VA | delta on the box |
|---|---|---|
| `SV_ConnectionlessPacket` | 0x634E90 | **-0x2D0** |
| `SV_Frame` | 0x635CC0 | **-0x2D0** |
| `CL_ConnectLocal` | 0x641730 | **-0x2D0** |
| `MSG_ReadBitsCompress` | 0x6751D0 | **-0x300** |
| `VM_Notify` | 0x698670 | **-0x300** |

> **Retracted 2026-09-23 05:40 by the coordinator — the conclusion below is wrong, the measurements are right.**
> The box's exe differs because it is the **German low-violence edition**, not a per-account link. The account's
> store country is Germany (store account page), so Steam licenses it depots 10091 + **10097 (German)** and refuses
> the English 10092: `download_depot 10090 10092 3607600095703252129` in the client console → *"Depot download
> failed: missing license for depot"*. B's PC has 10091 + 10092. The German build is a separate binary (hence the
> shifted functions and the different data pointers) and its zone has no `nazi_zombie_prototype`. Signature
> scanning would not give us the English maps either. **The way forward is a non-German Steam account on the box**
> (or a store-country change, which Steam only allows with a payment method from the new country) — B's call.

~~So: **Steam hands each account a differently-linked executable of the identical build.**~~ Same code,
relocated by a few hundred bytes in bands. A hardcoded address map is therefore a property of *one
copy of the game*, not of "WaW 1.7", and **`docs/re/t4-sp-map.md` is B's-exe-specific**.

*Inference, not observation*: this is what Steam's Custom Executable Generation does. Nothing was
done to confirm the mechanism by name - the measurement above is the evidence, and it is enough to
act on.

**The consequence for the product**: any box that is not B's needs its addresses found by
**signature scanning** rather than read from a table. The deltas are small and the prologues are
intact, which is exactly the easy case for a scanner. That is a `re` / `foundation` job and it is
the single thing standing between this box and a working game host.

### And the exact way it dies, which is a patch we already have

With no patches applied the engine behaves as it did before any of them existed:

```
SetSavedDvar can only be called on dvars with the SAVED flag set
ERROR: script runtime error
----- Server Shutdown -----
      dvar set sv_running 0
```

That is `dedi.md` §4 site 2 / p07 - the zombiemode GSC calls `SetSavedDvar` on
`con_typewriterColorBase` / `hud_drawhud` / `ui_campaign`, and our DLL's job is to put `DVAR_SAVED`
on them. Address-based, so it did not run. The server shuts down, the engine re-enters client init,
calls `Direct3DCreate9` and sits in the menu - which is why `ss` shows **43,200 bytes stuck in the
socket's Recv-Q**: the probes arrive and nothing drains them.

`local_client.cpp`, `frame_pacing.cpp`, `raw_sockets.cpp` and `error_trap.cpp` are all in the same
boat, so there is no frame rate to report: `frame_dispatch: no per-frame tick`.

### The launch line that got that far

```bash
cd /home/waw/pfx/drive_c/zdev/waw-vps1
WINEPREFIX=/home/waw/pfx DISPLAY=:99 WINEDEBUG=-all \
SteamAppId=10090 SteamGameId=10090 \
ENW_DEDI_SUPPRESS_MAPSUMMARY=1 ENW_RAW_SOCKETS=1 ENW_ROLE=server ENW_INSTANCE=vps1 \
wine CoDWaW.exe \
  +set fs_homepath 'C:\zdev\homes\vps1' \
  +set logfile 2 +set r_fullscreen 0 +set r_mode 800x600 \
  +set vid_xpos -4000 +set vid_ypos -4000 \
  +set s_volume 0 +set snd_volume 0 +set snd_menu_master 0 \
  +set com_introPlayed 1 +set com_startupIntroPlayed 1 \
  +set sys_configureGHz 1 +set ui_autoContinue 1 +set cl_allowDownload 0 \
  +set developer 0 +set con_minicon 1 \
  +set dedicated 1 +set zombiemode 1 +set com_maxfps 60 \
  +set con_typewriterColorBase '1.0 1.0 1.0' +set hud_drawhud 1 +set ui_campaign american \
  +set sv_maxclients 4 +set net_port 28960 \
  +map nazi_zombie_asylum
```

`infra/vps/05-run-dedi.sh` is that, plus the dev copy and the readiness probe. It is idempotent and
takes `NAME`, `MAP`, `PORT`, `MAXFPS`, `SECONDS_TO_RUN`, `REBUILD` and `DLL` from the environment.

**The dev copy honours rule 1**: top-level *files* are real copies (so `binkw32.dll` can be
replaced - `rm` then copy, never a write in place), top-level *directories* are symlinks into the
Steam install. That is the Linux spelling of `new-copy.ps1`'s `mklink /J`. Nothing is ever written
into `steamapps/common/Call of Duty World at War`.

## 11. Three traps this box cost us, none of them Wine's fault

1. **A headless box has no player profile, and the engine will not load a map without one.** The
   first three runs read like a dedicated-mode failure - `Getting Direct3D 9 interface...`,
   `Direct3D 9 failed to initialize`, and a modal **"Error during initialization: Unhandled
   exception caught"**. The actual line, 130 lines earlier and easy to miss, is:

   ```
   Can't load a map without a player profile selected.
   ```

   `+map` is refused, the engine falls through to **client** init, and *that* is what wants D3D.
   The fix is two files in the prefix, and `05-run-dedi.sh` writes them:
   `.../AppData/Local/Activision/CoDWaW/players/profiles/active.txt` holding the profile name, and
   `.../players/profiles/<name>/config.cfg`. B's PC has never shown this because B's profile
   (`anna-jpg`) has existed since long before any of this.

2. **i386 Mesa was missing, so Wine had no D3D9 at all.** `libgl1-mesa-dri` was installed for
   `amd64` only; the game is 32-bit. `apt install libgl1-mesa-dri:i386 libglx-mesa0:i386
   libgl1:i386` gives `llvmpipe` on `:99` and D3D9 then initialises for real (*"DirectX returned a
   frame buffer that is 24-bit color with 8-bit alpha"*). A **dedicated** server does not need it -
   but without it the diagnostic above is a hard failure instead of a log line, so install it.

3. **`pgrep -f` matches the `bash -c` wrapper as well as the game.** Every CPU/RSS number in the
   first two runs was the 2 MB shell, not the 362 MB server. Use `pgrep -x CoDWaW.exe` for
   sampling, and `pgrep -f zdev` (our own path, which is in argv as `C:\zdev\homes\<name>`) for
   killing our own PIDs and nothing else.

## 12. What this lane still has NOT done

> **Four of these five were closed the same night; kept with their corrections beside them.**

- ~~**The server has never answered on the wire from this box.**~~ **It does — §13**, exit 0 from
  B's PC, on `nazi_zombie_prototype`, at 60 Hz.
- ~~**The host agent is not on the box**~~ **It is — §14**, under Linux, launching through Wine,
  linking to the DLL and signing a replay. ~~**The box is still NOT registered with the live
  site**~~ — **registered 05:14, §16**: B lifted rule 7 for that one row, the database was backed
  up first, and `capabilities.play` is now `true`. What is still not done is a **real lease**,
  which needs a logged-in session at the site and is B's to start.
- ~~**Instances-per-box is unmeasured.**~~ ~~**It is two — §15**, and the limit is the lobby layer's
  UDP 3074/3075 pair, not CPU, RAM or disk.~~ **It is three (2026-09-23, `dedi.md` §19)**: the lobby
  socket probes 100 ports, and RAM is the next limit (~300 MB left with three up).
- ~~**The German depot is still installed.**~~ **Uninstalled** through the client; the box now runs
  off B's English tree at `/home/waw/waw-en`. §13.
- Steam offline mode, and whether SteamStub tolerates several simultaneous decryptions, are both
  still untested.

---

## 13. It works. B's English copy on the box, and the server answers (2026-09-22 04:40)

**Verdict: yes.** With B's own English game tree on the box, our headless dedicated server boots
under Wine, loads `nazi_zombie_prototype`, holds 60 Hz, and answers `getstatus` **from B's PC
against the public address**:

```
> python tools\dev\oob.py 28960 --host 2.28.235.236 --allow-remote --timeout 3.0
getstatus      ANSWERED  674 bytes: statusResponse | … \mapname\nazi_zombie_prototype\
                                     \sv_maxclients\4\protocol\62\sv_hostname\CoDWaWHost…
getchallenge   ANSWERED  44 bytes: challengeResponse 365449751 glDasy645zI=
OOB EXIT CODE = 0
```

§10's verdict is superseded. §10's *measurements* stand, and so does its retraction (§10's own
box): the German edition is a different binary, and that was the whole problem.

### The one fact that decides it: SteamStub validates the APP, not the depot

**Observation.** B's `CoDWaW.exe` (sha256 `732900d1…`) decrypts on the box under the box's own
German Steam login, in **676–715 ms**:

```
steamstub: image base 00400000, .text 00401000+3E99FF, first dword 9EF490B8, .bind present
steamstub: decrypted after 676 ms (234 polls); 0x401000 = 55 8B EC 83 E4 F8 D9 45 08 …
game: Com_Printf    @ 0059A2C0 LOOKS OK  bytes: B8 00 10 00 00 E8 46 5C 21 00 8B 8C 24 08 10 00
game: Dvar_FindVar  @ 005EDE30 LOOKS OK  bytes: 56 57 B8 3C CF 1A 02 B9 01 00 00 00 F0 0F C1 08
```

`LOOKS OK`, not `SUSPECT` — B's address map applies byte for byte. So a box needs a Steam client
logged in to an account that **owns app 10090**; it does not need that account to be licensed for
the depot the game files came from. Every patch we own then applies:

```
frame: tick installed by retargeting the call at 005FF7BD
raw_sockets: every packet now goes out as plain UDP (`je` -> `jmp` at 0x00600109)
dedicated: Dvar_FindVar("dedicated")=021B19C0  com_dedicated=021B19C0  (agree)
```

**That was worth testing before the 8 GB transfer finished**, and it was: the top-level files land
first in a `tar` stream, so `CoDWaW.exe` was on the box 90 seconds in. A 20-line probe directory
(the exe, the stock `binkw32_org.dll`, our DLL as `binkw32.dll`, `steam_appid.txt`) answers the
only question that matters — does it decrypt — without `main/` or `zone/` existing at all. Do that
first next time.

### The transfer

`C:\Users\b\ZombiesDev\waw-base` (B's copy, **never the Steam folder**) to `/home/waw/waw-en`, one
ssh session, one `tar` stream, no compression (`.iwd` is zip and `.ff` is zlib, so gzip buys
nothing and costs CPU on a 2-vCPU box):

```bash
cd /c/Users/b/ZombiesDev/waw-base
tar -cf - --exclude=./CoDWaWmp.exe --exclude=./DirectX --exclude=./Docs \
          --exclude=./installers --exclude=./pb . \
  | ssh -o BatchMode=yes zombies-dev 'mkdir -p /home/waw/waw-en && tar -xf - -C /home/waw/waw-en \
      && chown -R waw:waw /home/waw/waw-en'
```

| | |
|---|---|
| Size | **8,238 MB**, 195 files |
| Time | **22 m 59 s** |
| Rate | **6.0 MB/s (≈48 Mbit/s)** — B's uplink, not the box |
| Disk after | **21 GB free of 38** |

`CoDWaWmp.exe` is excluded on purpose (kickstart rule 2 — a file that cannot be run is the
cheapest way to honour it). `DirectX`, `Docs`, `installers` and `pb` are 84 MB of installer junk a
dedicated server never opens. **`main/video` was NOT excluded**, even though it is 1.4 GB and a
headless server should never play a Bink: `dedi.md` §9.1 is what an incomplete copy costs, and an
extra four minutes is cheaper than one wrong diagnosis.

Before sending, all 35 `.iwd`s in `waw-base` were opened as zips locally: **35 ok, 0 bad**,
including `iw_13.iwd`, which `dedi.md` §9.1 recorded as damaged in *both* Steam and the copy. The
`referee` lane's repair took; the source tree is good.

The German install was removed first, through the client (`steam://uninstall/10090`, then its
Uninstall button at (502, 490)), which took it from `Fully Installed` to
`AppID 10090 finished uninstall (No Error)` and freed 8.35 GB. Steam simply marks it not installed;
nothing re-downloads.

### The launch line that answers

```bash
cd /home/waw/pfx/drive_c/zdev/waw-vps1
WINEPREFIX=/home/waw/pfx DISPLAY=:99 WINEDEBUG=-all \
SteamAppId=10090 SteamGameId=10090 \
ENW_DEDI_SUPPRESS_MAPSUMMARY=1 ENW_RAW_SOCKETS=1 ENW_ROLE=server ENW_INSTANCE=vps1 \
wine CoDWaW.exe \
  +set fs_homepath 'C:\zdev\homes\vps1' \
  +set logfile 2 +set r_fullscreen 0 +set r_mode 800x600 \
  +set vid_xpos -4000 +set vid_ypos -4000 \
  +set s_volume 0 +set snd_volume 0 +set snd_menu_master 0 \
  +set com_introPlayed 1 +set com_startupIntroPlayed 1 \
  +set sys_configureGHz 1 +set ui_autoContinue 1 +set cl_allowDownload 0 \
  +set developer 0 +set con_minicon 1 \
  +set dedicated 1 +set zombiemode 1 +set com_maxfps 60 \
  +set con_typewriterColorBase '1.0 1.0 1.0' +set hud_drawhud 1 +set ui_campaign american \
  +set sv_maxclients 4 +set net_port 28960 \
  +map nazi_zombie_prototype
```

`infra/vps/05-run-dedi.sh` is that plus the dev copy, the player profile and the readiness probe:

```bash
ssh -o BatchMode=yes zombies-dev 'GAME=/home/waw/waw-en REBUILD=1 NAME=vps1 \
  MAP=nazi_zombie_prototype PORT=28960 SECONDS_TO_RUN=120 bash -s' < infra/vps/05-run-dedi.sh
```

### The numbers, one instance, no players

| | |
|---|---|
| Boot to answering | **10 s** |
| Frame rate | **60.0–60.8 Hz**, flat for 605 s (`com_maxfps 60` honoured) |
| `SV_Frame` | 20.1 fps — `sv_fps` exactly |
| RSS | **301 MB** (361 MB peak during the map load) |
| CPU | **0.30 of one core**, steady-state, sampled from `/proc/<pid>/stat` over 30 s |
| Threads | 11 |

**That is 6× B's PC** (`host.md` §10.3: 0.050 of a core) for the same work. A cx23's shared vCPU is
a *"Intel Xeon (Skylake, IBRS, no TSX)"* against B's 9800X3D, plus Wine's syscall translation. It
is a real cost and it is still only a third of one of the two cores.

## 14. The host agent runs on the box, under Linux, launching through Wine

`infra/host-agent/` now has a **`--wine`** mode. It is off by default and changes nothing on
Windows; `node test/run-all.js` is **41 passed, 0 failed** with and without it.

```bash
# on the box, as waw
cd /home/waw/enw/infra/host-agent
ZOMBIES_DEV=/home/waw/zdev-host /opt/node24/bin/node host.js \
  --box zombies-dev --boot 1 --game --wine \
  --wine-game-dir '/home/waw/pfx/drive_c/zdev/waw-{id}' \
  --wine-homepath 'C:\zdev\homes\{id}' \
  --map nazi_zombie_prototype --base-port 28960 --dash off
```

```
info host/inst/inst-01  wine: /home/waw/pfx/drive_c/zdev/waw-vps1 -> fs_homepath C:\zdev\homes\vps1
info host/inst/inst-01  start game port 28960 -> CoDWaW.exe
info host                instance inst-01 linked (pid 2764, Sep 20 2026 00:58:12)
info host/inst-01        map_loaded nazi_zombie_prototype -> manifest "Nacht der Untoten" (read)
info host/inst-01        recording -> /home/waw/zdev-host/replays/m_662ac3c0.enwr (fingerprint bee9057f5a57a2bf)
```

and `oob.py getstatus` from B's PC against that instance exits **0**. So: lease → launch → game
link → map manifest → signed replay, all of it on Linux, against a real game.

What `--wine` changes, and only for `kind === 'game'`: `wine CoDWaW.exe` is spawned directly
instead of `powershell -Command launch.ps1`, so **the child is the game** — no launcher wrapper, no
`PID <n>` line to adopt, and no `ZombiesDev\locks\game.lock` to take or release, because none of
those exist on Linux. The agent sets `SteamAppId`/`SteamGameId`, `WINEPREFIX` and `DISPLAY` itself,
since `launch.ps1` is not there to do it. Everything else — the argument list, `gameEnv()`,
sampling, stop-by-PID — is the shared code path on purpose.

**Node 24 is required and Ubuntu 24.04 ships 18.** `/opt/node24` from the official tarball
(`infra/vps/06-node-host-agent.sh`), left beside the distro's `node` rather than replacing it.

**One bug of mine worth the line**: the first run still went down the `launch.ps1` path and failed
with `launch script not found`. I had added `wine` to `InstanceManager`'s constructor *signature*
and never assigned `this.wine = wine` in the body, so it was `undefined` on the manager while the
config was right all the way in. The failure named the wrong thing, as they do.

### NOT done: the box is not registered with the live site

`--site https://zombies.enw.gg` needs a **per-box shared secret**, and the only place a box row and
its `match_key` can come from is `boxes.create()` against the live site's SQLite at
`web/data/zombies.db`. The live database currently holds exactly one box:

```
{ "id": 1, "name": "box-a", "region": "dev", "note": "B's PC — the host agent's default dev box",
  "polls": 0, "last_state": null }
```

Writing to `web/data` is the one thing this lane is told not to do, so **it was not done**. It is
one command for whoever owns the site, and then the box is online with no further work:

```js
// in web/, against the live data dir
require('./server/lib/boxes').create({ name: 'zombies-dev', matchKey: <a fresh random secret>,
  region: 'nbg1', note: 'Hetzner cx23, Wine', maxInstances: 2 })
```

then on the box add `--site https://zombies.enw.gg --secret <that secret> --box zombies-dev`. The
site is pull-only (`host.md` §1), so no inbound rule is needed and the Hetzner firewall does not
change.

## 15. Instances per box: **two**, and the limit is not CPU, RAM or disk

> **CORRECTED 2026-09-23 (`dedi.md` §19): the ceiling is now three, and the port pair was
> never the limit.** The Demonware socket's `findFreePort` (`0x78A1E0`) tries **100** ports
> up from 3074, not two. Three servers ran together on 28960/28962/28964 with lobby ports
> 3074/3075/3076, all answering from outside, ~304 MB RSS and ~0.33 core each, MemAvailable
> ~300 MB left. `run-host.sh` says `--max-instances 3`, and each instance gets
> `ENW_LOBBY_PORT=3074+slot`. What parked inst-03/04 below was most likely the "Set Optimal
> Settings?" MessageBox (`dedi.md` §17). That is inference: nobody looked for a window. **Four
> needs about 300 MB more**, so Steam without its CEF, or a bigger box (rule 8). The table and
> "Why two" below are kept as measured, and their conclusion is withdrawn.

Four per-instance game copies (`waw-inst-01…04`, each 8 MB of real files with `main/` and `zone/`
symlinked into `waw-en`), each with its own `fs_homepath`, started **one at a time**, each waited
on until it answered:

| instance | udp | answered | frame rate | RSS | CPU (30 s sample) | `oob.py` from B's PC |
|---|---|---|---|---|---|---|
| inst-01 | 28960 | **5 s** | 60.6 Hz | 301 MB | **0.281 core** | **exit 0** |
| inst-02 | 28962 | **5 s** | 60.3 Hz | 301 MB | **0.286 core** | **exit 0** |
| inst-03 | 28964 | never | — | 156 MB | 0.003 core | exit 1 |
| inst-04 | 28966 | never | — | 44 MB | 0.036 core | exit 1 |

**Two instances: 0.57 of one core of two, 602 MB of RAM, 21 GB of disk spare.** Neither of the
other two ever wrote a `console.log`, reached `frame::count > 0`, or bound a socket
(`dedicated: liveness t=565s frame::count=0 … bringup_hits=0`). They are parked inside `Com_Init`,
not killed: **there is no OOM anywhere in `dmesg`**.

### Why two, exactly

`ss -ulnp`, per PID:

```
pid 34782  inst-01   0.0.0.0:28960   0.0.0.0:3074
pid 34811  inst-02   0.0.0.0:28962   0.0.0.0:3075
pid 34838  inst-03   (nothing)
pid 34897  inst-04   (nothing)
```

The party/lobby layer binds **UDP 3074 with no dvar to change it** and falls back to **3075** —
that is `dedi.md` §1, and `host.md` §10.5 already measured A on 3074 and B on 3075 and correctly
concluded they do not collide. **Nobody had tried a third.** There is no 3076: the third instance
has nowhere to put its lobby socket and parks in `Com_Init` before it opens *any* socket,
including its game port.

*Inference, not observation*: that the fallback stops at 3075 is what the port table shows and what
"the third one binds nothing at all" is consistent with. It has not been read off an instruction.
Somebody should find the bind site and see whether the range is two wide or whether 3076 was busy
for another reason — if it is a two-entry table, a one-byte patch is worth more than a bigger box.

**Starting them simultaneously is worse**: `--boot 4` in one tick got *one* instance to a loaded
map and left three at 44 MB. Sequential, waiting for each to answer, got two. So the host agent
should start instances one at a time and gate on the wire, exactly as `jointest.ps1` does.

### The next ceiling after the port pair is Steam, not the game

`ps` across the 9 Steam processes: **2,324 MB of the box's 3,819 MB**, most of it steamwebhelper's
CEF. The two servers together are 602 MB. If the 3074/3075 limit were lifted tomorrow, RAM would
bite at roughly four instances, and the cheapest fix is a Steam client with no browser rather than
a bigger box. **Untested** — restarting Steam risks the login, and the login is B's.

### Firewall

UDP **28960** was widened to **28960–28970**, and 3074–3075 to **3074–3079**, so each instance is
reachable from outside (`POST /v1/firewalls/11659901/actions/set_rules`). Rules only; **no change
to the bill**, and §1 still holds.

## 16. The box is registered, runs as a service, and survives a reboot (2026-09-22 05:30)

**`capabilities.play` is `true`.** The launcher's Play button is on because of this box.

```
capabilities.play (boxes.list().some(b => b.online)) = true
  {"id":3,"name":"zombies-dev","online":true,"last_state":"idle","region":"nbg1",
   "max_instances":2,"key":{"pinned":"1cbc9958b50941ed","pinned_at":1790054154676}}
```

```
info host  site invite key b74d9a7c9874d877 loaded — token checks advisory
info host  host agent up: box=zombies-dev link=127.0.0.1:38700 key=1cbc9958b50941ed
info host/site  assignment changed: idle   (nonce idle)
info host  replay key 1cbc9958b50941ed is PINNED at the site — replays from this box are record-grade
```

**That value was computed with the site's own `boxes.list()`, not read from the HTTP route**, because `GET /api/launcher/hello` sits behind the closed-beta gate (`401 ENW Zombies is in closed beta. Ask B for the password.`) and entering a password is not something an agent does. `/api/gs/*` is exempt from the gate by design — which is why the box itself polls fine. `middleware/gate.js` is the list.

### The box secret

Created with **`web/tools/register-box.js`**, a CLI twin of `POST /api/admin/boxes` — that route exists and is the right way when a human is at a browser, but it needs an admin **session**, which is exactly the credential an agent must not hold.

The database was **copied to `web/data/backup-20260922T051411Z/` before the write**, which is the convention already in that folder. One row inserted, nothing else touched. `web/data` is otherwise still off-limits to this lane; B lifted rule 7 for this write and only this write.

The tool **never prints the secret** — not to stdout, not to a log, not into this repo. It writes 32 random bytes to a `--out` file at mode 0600, which was moved to **`/root/enw-host.env` (0600 root:root)** on the box and deleted locally. It is not in the unit file, not in `/home/waw/run-host.sh`, not on any command line, and `boxes.list()` deliberately omits `match_key` so it cannot come back out of the API. The tool **refuses** to re-create an existing box rather than minting a second secret and orphaning the first.

### The units

`infra/vps/06-host-agent.sh` installs five, all **enabled** so a reboot rebuilds the box (Steam's auto-login is on, so it comes back by itself):

| unit | what |
|---|---|
| `enw-xvfb` | `Xvfb :99`, the display everything else needs |
| `enw-x11vnc` | x11vnc on 127.0.0.1:5900, tunnel-only, unchanged from §5 |
| `enw-novnc` | websockify on 127.0.0.1:6080 |
| `enw-steam` | the Windows Steam client under Wine — SteamStub needs it |
| **`enw-host-agent`** | the host agent, `--wine --site https://zombies.enw.gg` |

Only `enw-host-agent` was **started**: the other four were already running by hand and a second copy of any of them is worse than none.

Three details that are not decoration:

* **`EnvironmentFile=/root/enw-host.env`.** systemd reads it as root *before* dropping to `User=waw`, so the file stays 0600 root:root and the secret never reaches a command line or another user's `/proc`. `ENW_SITE` is a plain `Environment=` line because a URL is not a secret.
* **`ExecStartPre=/usr/local/bin/enw-wait-rig`** waits for `Xvfb :99` *and* `Steam.exe`, whoever started them, then sleeps 10 s more — SteamStub asks the client to validate app 10090, and a game started before the client is ready exits(0) in silence.
* **`enw-steam` cannot be a plain `Type=simple` unit.** Steam re-execs itself and outlives the `wine` process that launched it (§5), so systemd would see the main process exit, call it a failure and start a *second* Steam. `/home/waw/run-steam.sh` launches it and then waits until the client actually goes away.

`Restart=on-failure`, `RestartSec=15`, `KillSignal=SIGINT`, logs in the journal:

```
systemctl status enw-host-agent
journalctl -u enw-host-agent -f
```

### A signed replay, from a real game, on the box

The site half of lease → boot → replay → result cannot be driven from here: a lease is created by `POST /api/admin/lease` or by a party, and both need a logged-in session. **The box's half was proved instead, and it is signed:**

```
info host/inst-01  map_loaded nazi_zombie_prototype -> manifest "Nacht der Untoten" (read)
info host/inst-01  recording -> …/m_e455d4ba.enwr (fingerprint aff989212886acff)
info host/inst-01  replay closed: 3.4 KiB in 2 chunks, 20 events, 0.11 MB/game-hour
```

```
  match         m_e455d4ba  Nacht der Untoten  (custom)
  recorded by   box box-a, instance inst-01, Sep 20 2026 00:58:12
  exe sha256    732900d158982c33e3121f0b86d22230be79839bbcbfe3bdfc1238f408a7d64d
  content       2 chunks, 20 events, 1m45s of game time
  signed by     94a38260ca0835fa
  VALID — every chunk hashes to its index entry, the chain is intact, and the
          footer signature checks out.
```

The `exe sha256` in that footer is **B's `CoDWaW.exe`**, recorded by a game running under Wine on Hetzner. It says `box box-a` because that one-shot was run by hand without the env file; a leased game carries `zombies-dev`.

**What is left for a real end-to-end**: B leases a game from the site (a party, or `POST /api/admin/lease` with `box: "zombies-dev"`) and the box takes it — nothing further needs to be installed. No synthetic game was pushed into the live boards, because that is XP and records on the real site and it is well past the one write that was authorised.

### A trap that cost a run, and a fix in the host agent

**`kill -9` on a game leaves `__CoDWaW` behind, and the next launch hangs with nothing in any log.** The marker is 4 bytes holding the previous PID; a stale one makes the engine put up "Run In Safe Mode?" *before* it opens `console.log`. The symptom is a `CoDWaW.exe` sitting at ~50 MB, no `console.log` at all, and our own DLL reporting `game: engine never came up within 120000 ms`.

`05-run-dedi.sh` already deleted it; the host agent's Wine path did not, and now does — **unconditionally**, which is right here and wrong on Windows. `launch.ps1` deletes it only when the PID inside is dead and refuses when it is live, because on Windows that marker is a real single-instance interlock. On this box it is not: each instance has its own lobby port (`dedi.md` §19; the "3074/3075 pair" of §15 was never an interlock), every instance has its own copy and homepath, and the marker is one shared file in one prefix that instance two would always find live. The code says so at the site of the deletion.

After the fix, the same run reaches `map_loaded` in **6 seconds** and logs `PER-FRAME TICK IS LIVE`.

### Capped at two

`max_instances` is **2** in the box row and `--max-instances 2` in `/home/waw/run-host.sh`. Both are the measured ceiling from §15, not a guess. **2026-09-23: `run-host.sh` is now `--max-instances 3`, measured (`dedi.md` §19). The box row still says 2, and the site leases one game per box anyway.**

## 17. The watersim fix on the box: the frame body returns, under load (2026-09-22 07:55)

`dedi`'s `5606cfd` (`watersim_pool.cpp` + `no_save_reload.cpp`) was rebuilt from HEAD `b8b553a`
and deployed to every game copy on the box.

**The DLL on the box** — `binkw32.dll` in `zdev/waw-{vps1,inst-01…04,stock,probe}` and
`/home/waw/waw-en/enw_t4.dll`, all identical:

```
sha256  25524244dddc24635e8590ef8ce180916559ecbbdcd876b8479ca4c6a90f52f4
size    1,535,488 bytes
[INFO ] enw_t4 build Sep 22 2026 07:38:34
```

Both new components arm on the box, first try:

```
dedi_no_save_reload: SV_LoadGame's "Unable to find save." ERR_DROP at 0x0062C10D now returns
                     instead of dropping the server. Dedicated only.
dedi_watersim_pool: before: guard=0 [04DD0A10]=00000000 [04DD4AF0]=00000000 [04DD8BD0]=00000000 …
dedi_watersim_pool: after : guard=1 [04DD0A10]=0C4B0020 [04DD4AF0]=0C5C0020 [04DD8BD0]=0908F138 …
```

### The fifth gate, under a 300-second getstatus storm from B's PC

```
storm: sent=2145 answered=2145 unanswered=0 over 300s, worst RTT 83 ms
```

and on the box, throughout that storm:

```
dedi_rate_probe: com_maxfps=60 target=16ms | ours 59.7 Hz | Com_Frame-body 59.7 Hz |
                 frame-body-entered 59.7 Hz | com_frameTime=726097 … delta=0 | outer-pace 38627
dedi_rate_probe: … | Com_Frame-body 59.2 Hz | frame-body-entered 59.2 Hz | com_frameTime=731099 …
dedi_rate_probe: … | Com_Frame-body 59.5 Hz | frame-body-entered 59.5 Hz | com_frameTime=736108 …
dedicated: liveness t=735s frame::count=44112 (+298 in 5s = 59.6 Hz)
```

**`frame-body-entered` and `Com_Frame-body` are equal at every sample.** Every frame that enters
the body also returns from it — which is exactly what `5606cfd` fixed, now observed on Wine on
Hetzner and not only on B's PC. 12 m 20 s uptime, 312 MB, 20.7 % of one core with the storm
running.

**One thing for `dedi` to look at, and it is about the harness, not the fix.** The in-line
`delta` field reads **0** on every line, while `com_frameTime` on those same three lines goes
726097 → 731099 → 736108: **+5002 and +5009 ms per 5-second window**, which is real time passing.
`jointest-proof.ps1`'s fifth gate reads `delta`, so as written **it would FAIL this server**, which
is demonstrably simulating. Either `delta` is not "how far com_frameTime moved in the last window"
or it is computed from a sample taken at the same instant as the reference. *Observation, not a
diagnosis* — I have not read the code that produces the field.

### A real client join from B's PC: NOT done, and why

**The `dedi` lane held `game.lock` for the whole window** — `join69`, then a run of map boots
(`map05`: `nazi_zombie_test1`, `sanatorium`). `deploy.ps1` refused correctly (`CoDWaW is running
(pid 14860). Close it before deploying.`) and nothing of theirs was touched. Kickstart rule 3 says
wait, so this waited.

The client half is ready when the lock is: `tools/dev/jointest.ps1` has **no remote-client path**
— it launches both halves locally — so the harness for this is
`infra/vps/join-remote.ps1`, which is jointest's client half with the address pointed at the box.
**It is not `+connect`**: that is not a client command in this exe, it is the *server*-side
out-of-band name. `ENW_CLIENT_CONNECT=<map>` arms `connect_local.cpp`, and
`ENW_CONNECT_ADDR=2.28.235.236:28960` makes `connect_address.cpp` rewrite the operand
`CL_ConnectLocal` would otherwise resolve to `NA_LOOPBACK`. `ENW_RAW_SOCKETS=1` on both halves.

So: **the server is proved to simulate under load from off-box; a player has not yet been on it.**

### CORRECTION, 08:06 — the client join DID happen, and all five gates pass

The paragraph above ("A real client join from B's PC: NOT done") is **kept as written and
superseded**: the `dedi` lane's lock freed a few minutes later, `infra/vps/join-remote.ps1` took it
on the second attempt, and **a real player on B's PC spawned into the server on the Hetzner box,
over the internet.**

```
Going from CS_FREE to CS_CONNECTED for  (num 0 guid 0)
join_probe: slot 0 CS_CONNECTED  name="anna-jpg" …
dprint[15] Going from CS_CONNECTED to CS_CLIENTLOADING for %s
dprint[15] Going from CS_CLIENTLOADING to CS_ACTIVE for %s
join_probe: *** slot 0 ENTERED THE WORLD (CS_CLIENTLOADING -> CS_ACTIVE). Milestone (d).
referee: ROUND 1 (all_players_connected)
```

**The five gates of `jointest-proof.ps1`, over a 300-second watch:**

| # | gate | result |
|---|---|---|
| 1 | client reached `CS_ACTIVE` and the referee logged `ROUND 1` | **PASS** — both above, 2 s apart |
| 2 | every `getstatus` in the window answered | **PASS** — 83/83 from B's PC over 252 s, plus 2145/2145 in the earlier storm |
| 3 | `frame::count` still advancing at the end | **PASS** — `frame::count=95489 (+304 in 5s = 60.8 Hz)` |
| 4 | `com_frameTime` advancing | **PASS** — 1587588 → 1592590, **+5002 ms per 5 s window** |
| 5 | the frame body still returning | **PASS** — `Com_Frame-body 61.0–61.1 Hz`, `frame-body-entered` equal to it |

`SV_PacketEvent` went 2161 → **11457** across the join: real gameplay traffic at ~62 packets/s,
not the out-of-band path. `dedi_no_autosave` fired once at the spawn, as designed.

**The server survived the player, and survived them leaving.** Before `5606cfd` the frame loop
stopped about ten seconds after a spawn. Here it ran the full 300 s with the player in the world
and was still at **60.9 Hz, 97,624 frames, 314 MB, 20.8 % of one core** after the client was
killed — 27 minutes of uptime, still answering `getstatus` from B's PC.

The client was stopped by PID and **`game.lock` was released**; the `dedi` lane's runs were never
touched, and its lock was waited for twice rather than pushed past.

**Gate 4 is the one to read carefully.** It passes on `com_frameTime` advancing between probe
lines. The in-line `delta` field still reads `0` on every line — see the note above; that is a
harness question for `dedi`, and it is the only reason this had to be read off two lines instead
of one.

### A trap that cost three restarts: `build\dedi` is the dedi lane's build directory

`build.ps1 -Name dedi` writes to `build\dedi`, and the `dedi` agent was rebuilding into it at the
same time. Three consecutive deploys shipped three different DLLs — `dd1141f5…`, `ba226bdb…`,
`882a2da9…` — none of which was the build whose hash had just been printed, and the one that
landed still logged `enw_t4 build Sep 20`. dev-box rule 11 (never a shared build dir) is about
exactly this, and `-Name dedi` **is** another lane's dir. **Build into `build\vps`.**

Second half of the same trap: `05-run-dedi.sh` defaults `DLL=/tmp/enw_t4.dll` and copies it over
`binkw32.dll` on every run, so a stale `/tmp` silently undoes a fresh deploy. Pass `DLL=`
explicitly — `DLL=/tmp/enw_t4_vps.dll` — and check the `enw_t4 build <date>` line in the log
rather than trusting the copy.

## 18. Game over, end to end, on the box (2026-09-22 08:45)

`a9f5d92`'s game-over path was synced to the box and **a real game on Hetzner, with a player from
B's PC, reached game over, signed its replay, posted a result to the live site, and left the
instance warm.**

```
host/inst-01  game live: nazi_zombie_prototype (custom) cap 24.0h
host/inst-01  game over: stop_intermission notify, round 1, 1m
host/inst-01  match_end: the game process says it is idle (server_alive=true) at round 1
host/inst-01  replay closed: 30.8 KiB in 7 chunks, 1812 events, 10.1x, 0.27 MB/game-hour
host/inst-01  SUMMARY nazi_zombie_prototype round 1 finish=none 1m20s flags=[result_mismatch] eligible=true
host/inst-01  disposition: REUSE — game 1 of 5 on this instance
host/inst-01  the game accepted `end`; waiting for the map to come back
host/inst-01  map_loaded nazi_zombie_prototype -> manifest "Nacht der Untoten" (read)
host          instance inst-01 is WARM: nazi_zombie_prototype loaded, no match, 1 game(s) played
              — ready for the next lease
```

**The replay is real and record-grade**, `tools/verify.js` on the box:

```
match       m_5de3842b  Nacht der Untoten  (custom)
recorded by box zombies-dev, instance inst-01
exe sha256  732900d158982c33e3121f0b86d22230be79839bbcbfe3bdfc1238f408a7d64d
content     7 chunks, 1812 events, 6m39s of game time
compression 310.6 KiB -> 30.8 KiB (10.1x)
signed by   1cbc9958b50941ed
VALID — every chunk hashes to its index entry, the chain is intact, and the footer
        signature checks out.
```

**And the site took it.** Two rows, on the live database, from a game this box actually ran:

```
games   { id: 2, match_id: "m_5de3842b", box: "zombies-dev", mode: "custom",
          rounds: 1, duration_ms: 80992, flags: ["result_mismatch"], ended_at: … }
replays { id: 2, match_id: "m_5de3842b", box: "zombies-dev", game_id: 2,
          chunks: 7, events: 1812, ratio: 10.1, key_id: "1cbc9958b50941ed",
          key_pinned: 1, tier: "full" }
```

`postResult` logs only on failure, so the absence of a warning is the evidence that it went; the
rows are the proof.

### Two things this turned up

1. **`game_players` is 0 and the summary carries `result_mismatch`.** The host's own words:
   `the game counted 1 thing(s) we never saw on the link: slot0: in the game's result, never seen
   on the link`. The player really was in the world — §17's join proved `CS_ACTIVE` and `ROUND 1`
   — but no per-player event reached the link, so the result has a round count and a duration and
   **nobody in it**. Every board that needs a player is still empty for this game. That is a
   `referee`/`host` question, not a box one, and it is the last thing between this and a game that
   scores.
2. **`enw_t4 build <date>` lies after an incremental build.** The instance logged
   `linked (pid 1012, Sep 22 2026 07:38:34)` — the *previous* build's `__DATE__`/`__TIME__` —
   while the DLL on disk was the new one. MSBuild only recompiles changed translation units, and
   the one holding those macros was not among them. **Verify with the sha256, never the build
   string.** §17's deploy traps plus this one mean the version of a DLL on the box is a hash
   question, full stop.

### What was actually synced, and a correction to the brief

The brief said "`infra/host-agent/` only, Node, no build". **The DLL half had also moved**:
`b8b553a..HEAD` touches `server/components/referee/referee.cpp` (+192),
`referee/t4_bind.{cpp,hpp}`, `replay.cpp` and `dedicated/reflection_probe_dvars.cpp` — and
`match_end`, which the new host path waits up to 500 ms for, is emitted by *that* half. So the DLL
was rebuilt from HEAD into `build\vps` and shipped with the agent in the same session:

```
sha256  b979c00c5d2dfe152b81370fecefa5fbf76fd280c806d041cb640639cbc7eaf0   (1,535,488 bytes)
```

in every `zdev/waw-*` copy. `match_end` then arrived on the first game, which is the evidence the
two halves are in step.

`node test/run-all.js` on B's PC: **41 passed, 0 failed** with the `--wine` branch in place.

### How the game was run, and why it is not a lease

The box has no way to lease a game to itself: a lease comes from a party or from
`POST /api/admin/lease`, both of which need a logged-in session. The game was booted with
`--boot 1` on a **site-connected** agent, started as a transient unit so the secret stayed in
systemd's hands and off every command line:

```bash
systemd-run --unit=enw-oneshot-game --uid=waw --gid=waw \
  -p EnvironmentFile=/root/enw-host.env -p Environment=ENW_SITE=https://zombies.enw.gg \
  -p Restart=no -p KillSignal=SIGINT \
  /home/waw/run-host.sh --boot 1 --map nazi_zombie_prototype
```

So the result row is from a **real game on the real box against the real site**, reached without a
party. A leased game is still B's to start, and the box is back on `enw-host-agent`, idle.

## 19. Identity on the box: a forged token is refused, and a real one cannot be faked (2026-09-22 15:20)

`bd3bd59` (referee: token parsed at connect) and `9506d04` (host: identity on the result) were
rebuilt from HEAD into `build\vps` and shipped to the box with `infra/host-agent/` in one session.

```
DLL sha256  318dfd609f45a07b831275025a03e81844c0f41413dae70a06eb9589f2c27bec   (1,570,816 bytes)
```

in every `zdev/waw-*` copy. `node test/run-all.js` on B's PC: **46 passed, 0 failed**. After the
restart: `play: true`, box `zombies-dev` **idle**, 0 instances, replay key still pinned.

### The bug this found, and it was live on the box for the whole evening

**A box whose site comes from the environment does not enforce invite tokens.** `host.js` computes

```js
requireToken: a['require-token'] != null ? a['require-token'] !== 'false' : !!a.site,
```

— `a.site`, the **`--site` argument**. But `cfg.site` itself is `a.site || process.env.ENW_SITE`,
and a systemd unit must pass the site through the environment, because that is how the secret
beside it stays off every command line (§16). So the box polled the live site, pinned its replay
key, and logged:

```
site invite key b74d9a7c9874d877 loaded — token checks advisory
```

**`advisory`, not `ENFORCED`** — every join since §16 would have been seated with no token at all.
`host.md` §10.2's transcript says `ENFORCED` because that run passed `--site` on the command line.

Fixed here by passing `--require-token true` explicitly in `/home/waw/run-host.sh`
(`infra/vps/06-host-agent.sh` writes it, with the reason at the line), and the box now logs
`token checks ENFORCED`. **The real fix belongs in `host.js`** — `requireToken` should be computed
from `cfg.site`, not from `a.site` — and is the host lane's to make. Until it is, any box
configured by environment is open.

### The run: a forged token, refused, on the live box

**A valid token could not be minted, and deliberately was not.** The box verifies against the
**live** site's public invite key, so only a token the live site signed for a real lease can pass;
minting one would mean using the live site's private key for a lease that does not exist. The
brief forbade that and so does this lane. `tools/dev/authhost.mjs` mints against a scratch
`ZM_KEY_DIR`, never `web/keys` — which is exactly what makes it a **forgery** from the live box's
point of view.

So the proof is the refusal path, end to end, against a game on the box with tokens enforced
(match `m_1dcb3335`):

```
referee: identity gate armed, match=m_1dcb3335
referee: player_connect slot 0 name='anna-jpg' steamid=76561198999999999 identity=claimed
host/inst-01  auth slot 0 anna-jpg 76561198999999999: DENY (bad_signature) -> identity refused
referee: slot 0 REFUSED (bad_signature) -- its roster row carries no steamid and nothing
         may be awarded to it. referee.md 13.
referee: console command queued: clientkick 0
referee: clientkick 0 (bad_signature) queued
referee: player_disconnect slot 0 ('anna-jpg')
```

**129 ms** from `player_connect` to `REFUSED`, and **38 ms** more to the player being gone. Both
lines of defence held: the roster row carries no steamid whatever happens next, and the kick
landed as well. The `sid` in the log is the forged `…999999999` — `--forge` rewrites the payload
and keeps the original signature, so the edit is what fails, not the token's shape.

*(The steamid is an invented `76561198000000042` / `…999999999`, per the standing rule that test
data never carries a real person's id.)*

### What is left

**A `verified` identity has never been seen on this box.** That needs a token the live site minted
for a real lease, which needs a party — B's to start. Everything under it is proved: the gate arms
with the right match id, a bad signature is caught, the row is stripped, and the player is kicked.

- 2026-09-22 19:30 — dedi DLL `680ac0ae…1e34` (no_msgbox + player_down + script_error_retail)
  staged at `/tmp/enw_t4_msgbox.dll`, **not yet deployed** (live lease on inst-03). Box copies
  still `318dfd60…`. Deploy only when the journal's last line is `assignment changed: idle` and no
  `CoDWaW` runs: `rm` + `cp` to `binkw32.dll` in every `zdev/waw-*` copy, verify sha256, restart
  `enw-host-agent`. See dedi.md §17.

### 2026-09-22 19:30 — deployed and proven on the box

Installed `680ac0ae…` (build Sep 22 2026 19:27:41) into all seven game copies while the box was
idle, restarted the host agent, then two fake-ID leases 30 s apart (retire-then-boot path). **Both
instances raised "Set Optimal Settings?" / "Your computer appears to have changed…" at boot** — so
the prompt is on every boot on this box, not only beside a retiring instance; before tonight only
the host agent's timing decided whether anyone noticed. `no_msgbox` answered it in ~2 s on both,
`map_loaded` came 6 s after link each time. The host agent's Escape belt stays as a second layer.
Oddity: the journal's `linked (… Sep 20 2026 00:58:12)` build string is stale while the DLL log
says Sep 22 — the hello's `dll_build` is not the build macro the log uses; cosmetic, unfixed.
