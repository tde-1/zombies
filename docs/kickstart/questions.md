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
