# T4 SP map — verified addresses, function map, evidence

*re agent. Kept current as work proceeds. Target: Steam `CoDWaW.exe` v1.7, SHA-256
`732900D1…A7D64D`. All addresses are absolute VAs (no ASLR); on our dump **VA = 0x400000 +
file offset**. Confidence: [V] verified on our dump, [H] T4SP AGPL header assert consistent
with our dump, [C] candidate (structure strong, name inferred), [U] unknown.*

## How the evidence was produced
- **Dump**: `tools/re/dump_image.py` attaches/launches the game, waits for SteamStub to
  decrypt `.text` (first dword `0x9EF490B8` → real code), `ReadProcessMemory`s the whole image,
  and rewrites section raw offsets to equal virtual ones. Output
  `C:\Users\b\ZombiesDev\dumps\codwaw-1.7-a.exe` (78,712,832 B) + `.json` manifest. **Never
  committed, never leaves `dumps\`.**
- **Static tooling**: `tools/re/t4map.py` (our code, capstone+pefile). Byte-scan of `.text`
  finds 62,615 rel32 call/jmp targets → 15,692 function entry points; a full capstone operand
  pass records every string/global/call reference per function (`sum`, `sxref`, `xref`, `dis`,
  `imports`). Index cached in `dumps\cache\` (not the repo).
- **Ghidra** 12.1.3 headless (`tools/re/run_ghidra.sh` + `GhidraExport.java`, Java 21 at
  `C:\Program Files\Zulu\zulu-21`) auto-analyses the dump and exports a function list to
  `dumps\cache\ghidra-funcs.json` as a cross-check. Project lives in `ZombiesDev`, never the
  repo. (Note: Ghidra 12 needs PyGhidra for `.py` scripts, so the export is a Java GhidraScript.)
- **Cross-reference**: JezuzLizard/T4SP-Server-Plugin (`main` headers `structs.hpp`/
  `symbols.hpp`) at `C:\Users\b\ZombiesDev\thirdparty`. Facts only; no Activision code copied.

## 0. Ghidra cross-check (independent confirmation)
Ghidra 12.1.3 auto-analysis of the same dump found **11,925 functions** and **independently
agrees with every anchor in this doc**: Com_Printf 0x59A2C0, Dvar_FindVar 0x5EDE30, Com_Init
0x59D710, Com_Frame 0x59E330, Sys_Milliseconds 0x603D40, G_ClientDoPerFrameNotifies 0x503540,
WinMain 0x5FF600, Sys_ImproperQuitDialog 0x5FF320, SV_PacketEvent 0x635540,
SV_ConnectionlessPacket 0x634E90, SV_DirectConnect 0x62E3A0, **SV_ExecuteClientMessage 0x630F70**
(size 0x26D, its own function — confirms the boundary correction), **MSG_ReadBitsCompress
0x6751D0** (size 0xBC, 2 callers), CL_ParseServerMessage 0x64D1A0, CL_ConnectionlessPacket
0x643380, G_Say 0x473F10 all land on Ghidra function starts with matching caller counts. Ghidra
auto-labels 0x75A9A8 as the `Direct3DCreate9` thunk. Export: `dumps\cache\ghidra-funcs.json`
(not committed). Where our capstone scan and Ghidra differ it's only in aggressive-vs-conservative
entry detection, never on a named anchor.

## 1. Vault note 11 §2 — verification result

| Symbol / global | Vault addr | Result | How checked |
|---|---|---|---|
| `Com_Printf` | 0x59A2C0 | **VERIFIED** [V] | entry point, 1809 callers, `mov eax,0x1000; call Com_vsnprintf` prologue |
| `Dvar_FindVar` | 0x5EDE30 | **VERIFIED** [V] | entry, 342 callers, interlocked refcount + hash-table lookup prologue |
| `Com_Init` | 0x59D710 | **VERIFIED** [V] | entry, 1 caller (WinMain 0x5FF600), SEH `__try` prologue (`fs:[0x2c]`) |
| `Scr_GetMethod` (detour site) | 0x683043 | **VERIFIED** [V] | site is `call 0x530630` (T4SP Scr_GetMethod), matches "detour site" role |
| `Scr_GetFunction` (jump site) | 0x682D99 | **VERIFIED** [V] | site is `call 0x5676F0` (Sentient_GetFunction), matches "jump site" role |
| `G_ClientDoPerFrameNotifies` | 0x503540 | **VERIFIED** [V] | entry, 1 caller; per-client `[edi+0x180]`/`[esi+0x104]` notify loop |
| `svs` (serverStatic) | 0x23D5C80 | **VERIFIED** [V] | referenced as serverStatic base; SV funcs index `svs.clients` via +0x171410 |
| `g_entities` | 0x176C6F0 | **VERIFIED** [V] | 494 refs to base; entity stride 0x378 |
| `level` (level_locals) | 0x18F5D88 | **VERIFIED** [V] | dense field refs at +0/+4/+C/+18/+1C (typical level_locals hot fields) |
| `com_dedicated` dvar ptr | 0x212B2F4 | **VERIFIED** [V] | read in WinMain loop (`mov eax,[0x212b2f4]; cmp [eax+0x10]`) and SV funcs |
| `g_mem` size sites | 0x5F5492 / 0x5F54D1 / 0x5F54DB | **CORRECTED** [V] | region right, exact operand starts are **0x5F5491 / 0x5F54CB / 0x5F54D5**; stock value **0x12C00000**, T4M-E writes **0x19600000**. Vault's byte offsets land mid-instruction on our dump. |
| `gentity_s` size | 0x378 | **VERIFIED** [H] | T4SP `ASSERT_STRUCT_SIZE(gentity_s,0x378)`; entity refs on our dump use stride 0x378 |
| `client_s.userinfo` | 0x6F0 | **VERIFIED** [H] | T4SP `ASSERT_STRUCT_OFFSET(client_s,userinfo,0x6F0)`; SV connect path reads `svs.clients[i]+0x6F0` |

Also confirmed as entry points at the T4SP addresses: `Sentient_GetFunction` 0x5676F0,
`Cmd_FindCommand` 0x594DB0, `Dvar_RegisterBool` 0x5EEE20, `Sys_Milliseconds` 0x603D40,
`Sys_Error` 0x5FE8C0, `va` 0x5F6D80, `FS_FOpenFileRead` 0x5DBD20, `Hunk_UserAlloc` 0x5E47B0.

**Nothing in the vault §2 list was wrong** except the three `g_mem` byte offsets (off by a few
bytes — they point into the right instructions but not at the operand). Use the corrected
`shared/t4/addresses.hpp::mem` values.

## 2. Function map (the deliverable the others need)

### Core / lifecycle
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `WinMain` | 0x5FF600 | [V] | calls Com_Init; remote-desktop/`allowdupe`/`+set com_introPlayed 1` strings; the frame loop |
| `Com_Init` | 0x59D710 | [V] | see §1 |
| `Com_Frame` | 0x59E330 | [V] | called once per WinMain loop iteration; body = table of profiled subsystem updates via helper 0x59E1D0 |
| dedicated console pump | 0x69DAA0 | [C] | called after Com_Frame only when `com_dedicated` set |
| `Sys_Milliseconds` | 0x603D40 | [V] | wraps `timeGetTime` (IAT 0x7EB39C), caches base |
| `Com_InitDvars` | 0x59C8B0 | [C] | registers `com_maxfps`, `developer_script`, `dedicated` |
| `dedicated` dvar (enum) | reg at 0x59C8B0 via `Dvar_RegisterEnum` 0x5EF150 | [V] | enum {0 "listen server", 1 "dedicated LAN server", 2 "dedicated internet server"}, flags 0x40; ptr → com_dedicated 0x212B2F4. WinMain reads value each frame (0x5FF7C2) and calls the dedicated console pump 0x69DAA0 when non-zero — **the SP exe has a real dedicated path** |

### Commands / dvars
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `Cmd_FindCommand`/registrar | 0x594DB0 | [V] | 190 `(name, funcptr)` registration sites + console lookups both call it |
| `SV_AddOperatorCommands` | 0x62C9B0 | [C] | registers `killserver`,`clientkick`,`loadgame`,`map`… (giant if-chain over `Cmd_FindCommand`) |
| `Dvar_FindVar` | 0x5EDE30 | [V] | see §1 |
| `Dvar_RegisterBool` | 0x5EEE20 | [H] | T4SP; confirmed entry |
| Cbuf/Cmd_ExecuteString | — | [U] | not yet pinned; the console dispatch lives inside/near 0x62C9B0 |
| `Dvar_SetFromStringByName` | — | [U] | not yet pinned; reachable via Cmd handlers, find via Dvar_FindVar callers that also write value |

### Script VM (referee)
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `Scr_GetMethod` | 0x530630 | [V] | detour site 0x683043; T4SP |
| `Sentient_GetFunction` | 0x5676F0 | [H/V] | jump site 0x682D99 |
| `G_ClientDoPerFrameNotifies` | 0x503540 | [V] | see §1 — per-client notify pump each frame |
| VM `waittill`/`endon` parse | 0x696E6D | [C] | "first parameter of waittill/endon must evaluate to a string" |
| script stack-overflow guard | 0x693E80 / 0x696E6D / 0x6992E0 | [C] | "script stack overflow (too many embedded function calls)" |
| `level.round_number` read | (script var) | [U] | **not an engine symbol** — it's a GSC field resolved at runtime via the script string table + variable lookup. Referee should hook `G_ClientDoPerFrameNotifies`/a notify, or read the level struct object's field via the VM's FindVariable path (T4SP `gScrVarPub`); each map ships its own `_zombiemode.gsc` so read the map's copy (vault §4). |
| `Scr_NotifyNum`/notify plumbing | — | [U] | T4SP lists `Scr_NotifyNum`; not yet located on our dump. G_ClientDoPerFrameNotifies is the confirmed per-frame notify entry to hook. |

### Server: connection & message path
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `SV_PacketEvent` | 0x635540 | [V] | 1 caller (0x59B4F0 net event); dispatches connectionless vs connected; tail-jmp to SV_ExecuteClientMessage |
| `SV_ConnectionlessPacket` | 0x634E90 | [V] | dispatch chain over getstatus/getinfo/getchallenge/connect/stats/disconnect |
| `SV_DirectConnect` | 0x62E3A0 | [V] | `protocol`/`challenge`/`qport`/`password`/`systemlink`/`bdTicket`/`connectResponse %s` |
| `SVC_GetChallenge` | 0x62DB60 | [V] | `challengeResponse %i %s` |
| `SV_ExecuteClientMessage` | 0x630F70 | [V] | reached by tail-jmp from SV_PacketEvent; sets decode dst pool, calls MSG_ReadBitsCompress |
| `MSG_ReadBitsCompress` | 0x6751D0 | [V] | method dispatch + Huffman loop (0x675230), inner symbol reader 0x5A2970 |
| `CL_ParseServerMessage` | 0x64D1A0 | [V] | "Compressed msg overflow in CL_ParseServerMessage"; bounds to 0x20000 |
| `CL_ConnectionlessPacket` | 0x643380 | [V] | challengeResponse/connectResponse/infoResponse/statusResponse/getserversResponse/echo/print/disconnect |
| `SV_SpawnServer` | 0x62B3E0 | [C] | refs `.svg` (savegame), `thereisacow` (cheat/devmap key), `devmap`; calls the `maps/%s.d3dbsp` loader 0x62B260; called by the map command handler 0x62C530 |
| map-file loader (`maps/%s.d3dbsp`) | 0x62B260 | [V] | sole ref to `maps/%s.d3dbsp`; 1 caller (SV_SpawnServer) |
| `SV_DropClient` | — | [C] | `EXE_PLAYERKICKED*` handlers at 0x62C3A7/0x62C410/0x62F250/0x643230; exact drop fn TBD |
| `ClientConnect`/`ClientBegin` | — | [U] | GSC-side connect via `SV_DirectConnect`; the game-side `ClientConnect` not yet isolated |
| `SV_ClientThink`/usercmd | — | [U] | usercmd_s size 0x38 known (T4SP); the move-parse fn not yet isolated |
| `SV_SendServerCommand`/`SV_GameSendServerCommand` | — | [U] | needed for chat injection; not yet pinned — find via reliable-command buffer writers |

### Chat
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `G_Say` | 0x473F10 | [C] | `EXE_SAY`/`EXE_SAYTEAM`, `"%s: "` formatter |
| `ClientCommand` | 0x4388A0 | [C] | sole caller of G_Say; dispatches `say`/`say_team` |

### Renderer / sound / OS gates (dedi: what to stub)
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| D3D9 device create wrapper | 0x75A9A8 | [V] | wraps `Direct3DCreate9` (IAT 0x7EB46C); callers 0x5FE490 (probe), 0x6D62A0 (R_Init) |
| lost-device reinit | 0x6D6CB0 | [V] | "Couldn't reinitialize after a lost Direct3D device" |
| Sound: `binkw32`/`MSS` (Miles) | — | [C] | sound uses `binkw32.dll` (`_BinkOpenDirectSound@4` IAT 0x7EB448); DirectSound path |
| DirectX-init-failed dialog | 0x5FE690 | [V] | `WIN_DIRECTX_INIT_TITLE/BODY` MessageBox |

### OS / startup gates & traps
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| **improper-quit / "safe mode" prompt** | 0x5FF320 | [V] | `WIN_IMPROPER_QUIT_TITLE/BODY`; checks marker file `%LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW` |
| create quit marker | 0x5FF1A0 | [C] | writes the `__CoDWaW` marker at startup (site 0x5FF306) |
| out-of-memory dialog | 0x5FE760 | [V] | `WIN_OUT_OF_MEM_TITLE/BODY` |
| remote-desktop / dup-instance | 0x5FF600 (WinMain) | [V] | "can not be run over a remote desktop", `allowdupe` |
| SP/MP relaunch selector | 0x644F40 | [C] | references both `CoDWaW.exe` and `CoDWaWmp.exe` |
| named mutex (`CoDWaWHost`) | ~0x632B10 region | [C] | `CreateMutexA` + `CoDWaWHost` string; LAN-host/dup detection (not a hard single-instance lock) |

**Safe-mode trap fix (already on the board):** delete
`%LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW` before launch, or NOP the `call 0x5FF320` in
WinMain (site 0x5FF698). With `fs_homepath` set, check whether the marker relocates.

### Memory
`g_mem` main reserve at `g_mem_init` **0x5F5480**: `push 0x12C00000` (0x5F5491) then writes
0x12C00000 to 0x224FAEC (0x5F54CB) and 0x224FBF0 (0x5F54D5). T4M-E raises all three to
0x19600000. Re-implement in our DLL (facts only).

## 3. How much of the T4 engine we can see
**Effectively all of the code section.** `.text` decrypts cleanly (0x3E9A00 bytes), we
recover 15,692 function entry points and a full call graph, and string/dvar cross-references
name a large fraction directly. DemonWare (`bdLobby`/`bdSocket`/`bdNet`) ships with full source
paths (`C:\cod5\cod\codsrc\DemonWare\…`) — that whole online subsystem is trivially mapped and
is exactly what we want to disable. The gaps are functions with no distinctive strings (parts
of the script VM notify plumbing, `SV_SendServerCommand`, the usercmd/move path); those need
call-graph tracing from the anchors above, and the Ghidra export will help name them.

## 4. Open threads
- Pin `SV_SendServerCommand`/`SV_GameSendServerCommand` (chat inject), `SV_DropClient`,
  `SV_ClientThink`/usercmd parse, `Scr_NotifyNum`, `Cbuf_AddText`/`Cmd_ExecuteString`,
  `SV_SpawnServer`/map-load. Anchors: SV_PacketEvent 0x635540, SV_AddOperatorCommands 0x62C9B0,
  G_ClientDoPerFrameNotifies 0x503540.
- Confirm whether `fs_homepath` relocates the `__CoDWaW` marker (affects the safe-mode fix).
- Fold in Ghidra's `ghidra-funcs.json` names once analysis finishes.
- **Accelerators flagged in vault R12 (pending B's OK, see `questions.md`):**
  - `codwaw_lnxded` — Treyarch's DRM-free Linux WaW dedi ELF (same 1.7 engine build). If it
    carries symbols/distinctive constants, diff it against our exe to name the [U] functions
    fast (the CoD4x method). MP-only, do **not** run it; static read only.
  - KisakCOD (GPL-3.0 IW3 reimplementation) — labelled map of the parent engine (WaW server
    reports engine `iw3.0`, confirming the IW3 fork). Use to locate/understand names, structs,
    call graphs only; nothing pasted into the repo (same clean-room rule as post-2023 T4SP).
