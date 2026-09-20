# Questions for B (re agent)

Append-only. re = reverse-engineering agent.

- **[re, 2026-09-20] Concurrent game instances / Steam account plan.** SteamStub needs the
  Steam client running and logged into an account that owns WaW (offline OK after a one-time
  online activation); see `docs/re/steam-drm.md`. For production this means **each WaW box
  needs a Steam account that owns World at War**. Open: can one account/box run several
  concurrent CoDWaW.exe instances (vault note 11 §1 warns of a one-concurrent-session / LAN
  one-licence-per-host limit)? This drives the box/account math for many-games-per-machine.
  Not blocking the prototype (B's PC is fine).

- **[re, 2026-09-20] `codwaw_lnxded` (Treyarch's free Linux WaW dedicated server, 1.7) —
  may I fetch it?** R12 flags it as a **DRM-free ELF of the same engine build** that we could
  diff against our SteamStub'd Windows exe to name functions much faster (the CoD4x method). It
  is MP-only (`CoDWaWmp` lineage) and I would **not run it** — only read it statically for
  symbols/constants. Need: (a) your OK to download, and (b) a reputable source URL you're happy
  with (the original `codwaw-lnxded-1.7-11182009.tar.bz2`). Clean-room note: it's Activision
  code, so facts/names/offsets only, never pasted into the repo — same rule as the T4SP
  post-2023 parts.

- **[re, 2026-09-20] KisakCOD (GPL-3.0 IW3 reimplementation) for naming only.** I intend to use
  it purely to *locate and understand* the [U] functions (`SV_SendServerCommand`,
  `SV_ClientThink`, `Scr_NotifyNum`, `Cbuf_AddText`…) — names/structs/call-graph, no code
  pasted, our own implementations. Flagging per the clean-room rule; say if you'd rather I not
  clone it at all.

## Does every production game box need its own Steam client and a WaW licence?  (foundation, 00:35)

`CoDWaW.exe` is SteamStub-wrapped: its PE entry point sits in a `.bind` section that asks the local
Steam client to validate ownership of app 10090 and hand back the key that decrypts `.text`. Our DLL
needs only the game files, but the *game* does not run at all without a logged-in Steam client that
owns World at War. Measured on B's box: decryption takes 110-140 ms and is reliable; with no Steam
client the exe would exit within a couple of seconds having decrypted nothing.

That means each game box we lease needs its own Steam install plus an account holding a WaW licence
-- a per-box cost, an account-management problem at scale, and awkward for "spin up an hourly cloud
box on demand". Steam offline mode probably works (the client caches licences) but is untested here.

The only ways round it are worse or off-limits: retail discs are SafeDisc; dumping the decrypted
`.text` and shipping it is redistributing Activision code, which vault rule 7 forbids outright.

**Assumed for now (most reversible):** development continues on B's box with B's Steam client, and
nothing in the design depends on running the game without Steam. Nobody has bought anything.

**What we need from B:** is one Steam account + client per game box acceptable as the production
model, and roughly what does a WaW licence cost at the scale we would need?

## Is vendoring MinHook into the repo OK?  (foundation, 00:20)

`dev-box.md` rule 9 says third-party checkouts live in `ZombiesDev\thirdparty` "unless we vendor a
file under its licence". MinHook is BSD-2-Clause and small (12 files), and it carries the length
disassembler that makes 5-byte detours safe rather than a coin flip.

**Assumed:** vendored at `thirdparty/minhook/` with `LICENSE.txt`, `AUTHORS.txt` and a
`VENDORED-FROM.txt` recording the upstream commit, so the build is self-contained. Easily reversed
-- delete the folder and point CMake at `ZombiesDev\thirdparty\minhook` instead.

---

## referee — two questions for B

### Q-ref-1: `nazi_zombie_ali` advertises a 6-piece amulet quest that does not exist in script.
Its README promises "you have to find 6 piece of amulet to open main door". Having read every GSC in
the map's `.ff`, its `mod.ff` and both its `.iwd` files, **no script mentions an amulet, and there is
no flag, notify or variable for it.** It is hints and geometry. The map *does* have a real, detectable
Buyable Ending (a 20,000-point "GET OUT OF CLINIC" trigger that sets `level.tom_victory`), so the map
badge is covered.

The question is what the platform should say about the *quest*. Options:
1. **Silence** — the map badge is the Buyable Ending, the amulet is never mentioned. Simplest, and
   what the manifest does today.
2. **A staff-reviewable claim** — a player says "I did the amulet run", staff watch the replay and
   tick it. Honest, costs staff time, and there will be a long tail of maps like this.
3. **A tick we cannot verify** — never. An unverifiable tick next to verified ones devalues both.

Recommend 1 now, 2 later if players ask. **Not blocking** — say so whenever.

### Q-ref-2: should our server also emit IW4MAdmin's `LogPrint("GSE;…")` event lines?
Coordinator's ask, answered in `docs/kickstart/referee.md` §6.4. Short version: their format is MIT,
proven on T4, needs no socket, and would make an ENW server readable by an existing admin tool.
Our own NDJSON-over-TCP link is better for replays and records (ordering, backpressure, framing for a
1.2 KB 20 Hz snap). Recommendation is **both**: keep NDJSON as the contract, add
`enw_logprint_events 0|1` (default 0) mirroring the *event* subset as `GSE;…` lines. ~50 lines, free
when off, buys a degraded mode and IW4MAdmin compatibility. It is a protocol addition, so it wants a
yes before it is built. **Not blocking.**

---

## host — three questions for B (2026-09-20)

None of these block anything; the assumption I carried on with is stated each time.

### Q-host-1: are non-VIP players allowed to download their own full replays?
Vault 99 §4.7 says "Players can download their own replays", and §10 says VIP gets the 3D viewer
and keeps replays forever while non-VIP full tracks are kept 90 days. The measured numbers make the
storage question moot (a typical game is 5-9 MB, $1/month stores about 10,000 of them), so this is
purely a product choice. The wrinkle is that a downloadable signed replay is also a downloadable
**dataset of where four people were, at 20 Hz, for an hour** — fine between friends, less fine when
someone downloads a stranger's public game to study their training route.

**Assumed:** every game is recorded and verifiable, everyone can download **their own** games, and
someone else's full tracks need either VIP or that game being public. The signed summary and event
log are public for everyone, always, because that is what makes a record checkable.

### Q-host-2: what happens to a game when the box loses the website?
Today the box keeps playing, keeps refereeing and keeps recording, and the result POST simply fails
and is lost. That is the wrong half to drop: the game is the expensive part and the POST is one
HTTP request.

**Assumed for the prototype:** nothing — the result is lost if the site is down. For the real build
I would spool results and replay pointers to disk and retry until the site takes them, which also
covers the site being redeployed mid-game. Worth confirming you want that (it means a box holds
unreported games, and a reaped cloud box must not be destroyed until its spool is empty).

### Q-host-3: should a box refuse to run at all when it cannot reach the site's invite key?
An invite-token check that cannot run has to fail one way or the other. It currently **fails
closed**: a box that has not fetched the site's public key refuses every join, so a network problem
produces an empty server rather than an open one. The cost is that a site outage at the wrong
moment makes a booted game unjoinable, and players see a server they cannot get into — which is
precisely the failure the CS:GO box skill warns about, in the other direction.

**Assumed:** fail closed, and cache the key on disk so a box that has ever talked to the site keeps
working through an outage. Say if you would rather a box with a *valid lease* admitted the
whitelisted SteamIDs without a token as a fallback.

### Note for referee (not a question for B): one prefix, please
`referee/docs` proposes `GSE;...` for the DLL's `LogPrint` mirror; the host currently writes
`ENWZombie;...` for the same events from the host side. Both are now one configurable string
(`--game-log-prefix`, `lib/gamelog.js`). Pick whichever you have evidence for and say so on the
board and I will default to it — two prefixes for one stream would be the worst outcome.

---

## Coordinator answers (2026-09-20)

- **Q-host-2 (box loses the website): spool and retry — build it.** A box writes results, replay
  pointers and referee summaries to disk and retries until the site accepts them; **a leased box is
  never destroyed while its spool is non-empty**, and the reaper must check that. The game is the
  expensive part; a failed POST must never lose it. (Coordinator decision, matches how ENW's CS boxes
  survive a site redeploy.)
- **Q-host-3 (no invite key reachable): stay fail-closed, cache the key on disk.** A box that has ever
  talked to the site keeps working through an outage; a box that never has refuses everyone. **No
  lease-based fallback that admits players without a token** — an open server is a worse failure than
  an unjoinable one, and the whole point of the tokens is that joining is impossible without us.
  (Coordinator decision.)
- **Game-log prefix: use `GSE;`.** The only reason the mirror exists is to be legible to
  IW4MAdmin-style tooling, so we take their convention rather than inventing `ENWZombie;`. Both the
  DLL mirror and the host writer default to `GSE;`, configurable.
- **Q-host-1 (who may download whose replays): with B.** Carry on with the host agent's assumption —
  everyone may download their own games; someone else's full tracks need VIP or a public game; the
  signed summary and event log are always public so records stay checkable.

## Launcher (2026-09-20, agent: launcher)

**Q-launcher-1 — is a local ownership signal enough for v1?**
The spec says the launcher "validates ... the player owns appid 10090 on their Steam account"
(13 §2). A launcher on the player's PC cannot actually prove that: all it can read is that Steam has
app 10090 registered for the signed-in account (`HKCU\Software\Valve\Steam\Apps\10090\Installed`,
plus an `appmanifest_10090.acf`). A real ownership check needs a Steam Web API key and a site
endpoint (`ISteamUser`/`IPlayerService` against the SteamID from the OpenID login), which is
server-side work and an API key we do not have.
*Assumed for now (most reversible):* treat the local signal as good enough to pick the right
first-run screen, and leave the real check to the site at sign-in. Nothing depends on it yet.

**Q-launcher-2 — where should the map library live?**
Everything the launcher creates currently sits in `%LOCALAPPDATA%\ENWZombies` — the ~8 MB game copy
and the map library. The map library will eventually be tens of GB, and C: is often the small drive.
Two sub-questions: (a) should the map folder be separately configurable with a "move library"
button, like Steam's library folders? (b) should it default to the drive the player's WaW is
installed on rather than C:?
*Assumed for now:* one root under `%LOCALAPPDATA%`, overridable with the `ENW_ROOT` environment
variable. Easy to split later; the manifest already records the folders separately.

**Q-launcher-3 — how does the invite token reach the game? (needs the client-DLL owner, not B)**
The launcher will not put the token on the command line: any process can read another's command
line and it lands in logs and crash dumps. It currently serves the token on a one-shot named pipe
whose name is in `ENW_TOKEN_PIPE`, with `ENW_TOKEN` as an opt-in fallback. **The DLL reads neither
today** and `game-link-v0.md` says the token arrives in userinfo at connect. Proposal is written up
in `docs/kickstart/launcher.md` §3; it needs a yes/no from whoever owns the client side and then a
line in the protocol doc.
