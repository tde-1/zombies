# SteamStub runtime constraint (for the infrastructure decision)

*re agent, 2026-09-20. Question from the coordinator: what does SteamStub actually require at
runtime — a logged-in Steam client, a running service, an ownership check, an internet
connection? Once at startup or continuously? This decides whether each production WaW box
needs its own Steam account. **We do not remove or bypass the DRM; this only describes the
constraint.***

## What our target uses
`CoDWaW.exe` v1.7 (Steam build 252004) is wrapped with **Steam DRM v2 ("SteamStub")**. On disk
the `.text` section is encrypted (first dword `0x9EF490B8`); a `.bind` stub section
(VA 0x4EBB000, ~344 KB) decrypts it in memory before the real entry point runs. [C, our dump]

## Observed first-hand on this machine [C]
When `dump_image.py` launched `CoDWaW.exe` directly (via `CreateProcessW`), **the stub
re-launched the game through Steam**: our spawned PID exited within ~1 s and a *new*
`CoDWaW.exe` PID appeared, parented under the Steam client. `.text` was decrypted ~0.1 s into
that relaunched process (first dword `0x9EF490B8` → `0x83EC8B55`). So on a machine with Steam
installed, the stub routes startup back through the Steam client. Steam was already running and
logged in during the dump.

## What the documented behaviour says
- The Steam DRM wrapper's job is to **verify game ownership** and to make sure Steamworks
  features work by **launching Steam before launching the game** — i.e. it expects the Steam
  client to be present and starts it if needed. [C, Steamworks docs]
- Valve is explicit that the wrapper "**by itself is not an anti-piracy solution**" and is
  "easily removed by a motivated attacker." [C, Steamworks docs] (We are not doing that.)
- **Offline mode is not the same as "no Steam client."** Steam offline mode removes the
  *internet* requirement, not the *client* requirement — the Steam client still has to be
  running. [C, community/how-to sources]
- **First launch must be online.** A freshly installed Steam game must be run once while the
  account is online so Steam can perform its DRM/ownership check and cache a licence; after
  that, if the title supports it, it can be launched in offline mode with no internet. [C]
- Whether the ownership check is a single startup gate or is re-checked continuously is **not
  documented by Valve.** [U] The wrapper is a startup gate (it decrypts and hands off to the
  OEP); the ongoing "is Steam running" expectation comes from any Steamworks API the game then
  uses, not from the stub re-checking ownership mid-run. For WaW SP/co-op the practical
  behaviour matches a **one-time startup gate** plus "Steam client should stay up."

## Bottom line for production boxes
- A trusted WaW host **needs the Steam client installed, logged into an account that owns
  WaW, and running** (it may be in offline mode after a one-time online activation). It does
  **not** need a continuous internet connection once activated. [C for client-required and
  first-launch-online; U for the exact re-check cadence]
- Therefore **each production box needs a Steam account that owns World at War** (or a shared
  account, subject to Steam's one-concurrent-session and the LAN one-licence-per-host limits
  in vault note 11 §1 — running many concurrent instances on one account/box is the open
  question). This is a licensing/ops constraint, not something to engineer around.
- For the local prototype on B's PC this is already satisfied (B's Steam, logged in).

## Not doing
No DRM removal, no unpacking to a standalone exe, no redistribution of decrypted code. The
`dumps/` image exists only for static RE on this machine and never leaves it.

Sources: [Steam DRM (Steamworks)](https://partner.steamgames.com/doc/features/drm),
[Play Steam games without Steam running](https://www.itechguides.com/how-to-play-steam-games-without-steam-running/),
[Validate ownership offline (Steam Community)](https://steamcommunity.com/discussions/forum/1/3165461141532824928).
