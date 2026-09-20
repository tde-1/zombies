# codwaw_lnxded + KisakCOD — RE reference binaries (B approved 2026-09-20)

Two cross-reference sources approved by B to speed up naming functions in our SteamStub'd
`CoDWaW.exe`. **Clean room stands: facts, names, offsets only — no code from either is pasted
into the repo.** Neither is run.

## KisakCOD — DONE, in use
- GPL-3.0 buildable IW3 (CoD4) reimplementation (from public retail PDB symbols). T4 (WaW) is
  Treyarch's fork of IW3, so this is effectively the parent engine's annotated source.
- Cloned to `C:\Users\b\ZombiesDev\thirdparty\KisakCOD` (`SwagSoftware/KisakCOD`, depth 1).
- Already used to confirm function shapes/names: `MSG_ReadDeltaUsercmd(msg, from, to)`
  (`src/qcommon/msg.cpp`), `SV_ClientThink(usercmd_s*)` (`src/server/sv_client.cpp`),
  `SV_UserMove(client_t*, msg_t*, int delta)` (`src/server_mp/sv_client_mp.cpp`). Used to name,
  never to copy. This covered the immediate need for the remaining [U] functions.

## codwaw_lnxded — approved, deferred (size)
- The canonical DRM-free ELF of the WaW 1.7 engine (MP/dedicated). Vetted source:
  **LinuxGSM's own CDN**, used by the LinuxGSM install script:
  `http://linuxgsm.download/CallOfDutyWorldAtWar/codwaw-lnxded-1.7-full.tar.xz`
  (also mirrored historically on AusGamers and referenced from icculus.org's `cod` list).
- **HEAD check (2026-09-20): Content-Length = 6,526,308,212 bytes (~6.5 GB), `application/x-xz`.**
  That "full" tarball is almost entirely game assets (`main/*.iwd`, `zone/`). The only thing
  useful for RE is the `codwaw_lnxded` ELF (a few MB) and possibly `.so`s.
- **Decision:** not fetching the full 6.5 GB now — disproportionate, and KisakCOD already
  unblocked the current naming work. When the lnxded symbol/struct diff is wanted (it is the
  fastest route to the last ~dozen unnamed functions and to confirming struct offsets against a
  same-engine build), pull only the ELF, e.g. stream-extract without storing the whole archive:
  `curl -sL <url> | tar -xJ --wildcards --no-anchored 'codwaw_lnxded' -O > <dest>` (xz is not
  seekable, so this still streams the archive, but writes only the binary). Keep the ELF in
  `C:\Users\b\ZombiesDev\thirdparty\` (never the repo), read statically only, never run.
- If pursued, record the ELF's sha256 here and whether it retains a symbol table (Linux
  release builds are often stripped; if stripped, KisakCOD remains the better name source).

Sources: [LinuxGSM codwawserver](https://linuxgsm.com/servers/codwawserver/),
[AusGamers v1.7 files](https://www.ausgamers.com/files/download/48744/call-of-duty-world-at-war-dedicated-linux-server-files-v17),
[icculus cod list](http://icculus.org/pipermail/cod/2009-February/012822.html),
[KisakCOD](https://github.com/SwagSoftware/KisakCOD).
