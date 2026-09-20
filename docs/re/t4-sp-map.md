# T4 SP map — verified addresses, function map, evidence

*re agent. Kept current as work proceeds. Target: Steam `CoDWaW.exe` v1.7, SHA-256
`732900D1…A7D64D`. All addresses are absolute VAs (no ASLR); on our dump **VA = 0x400000 +
file offset**. Confidence: [V] verified on our dump, [H] T4SP AGPL header assert consistent
with our dump, [C] candidate (structure strong, name inferred), [U] unknown.*

## Data-integrity note (2026-09-20)
`ZombiesDev\waw-base` was a **corrupt copy**: nine `.iwd` archives (~1.1 GB) had correct file
lengths but zero-filled tails; the engine mounts what it can and silently skips the rest,
surfacing much later as a missing-asset error pointing nowhere near the cause (referee found
and repaired it from the read-only Steam install; B's Steam install is fine). **Our dump was
taken from a process launched from the Steam install, so it is unaffected** (all addresses
above stand). Anything that relied on `waw-base` assets should be re-checked.

## The headless "hang" is a fatal error, not a wait (2026-09-20)
`dedi` suspended the main thread: `EIP = win32u!NtUserGetMessage+0xC` with an identical ESP on
every sample, innermost engine frame **0x5FE97B inside `Sys_Error` 0x5FE8C0**. So the dedicated
server **hits a fatal error and Sys_Error parks the main thread forever** — that is why Com_Init
never returns, no frames run, no packets are handled and no dialog appears (it uses WinConsole).
- **`Sys_Error` = 0x5FE8C0** [V]. Terminal loop **0x5FE960..0x5FE97D**:
  `TranslateMessage([0x7EB300])` → `DispatchMessageA([0x7EB2E4])` → `GetMessageA([0x7EB2CC])` →
  **0x5FE97B `test eax,eax`** → `jne 0x5FE960`. Falls out only on WM_QUIT, then `_exit(0)`
  (0x7AC431). **A WM_NULL nudge cannot break it.**
- **`Com_Error` = 0x59AC50** [V] — 515 callers, calls Sys_Error directly. cdecl
  `void Com_Error(errorParm_t code, const char* fmt, ...)`; in a hook: `code=[esp+4]`,
  `fmt=[esp+8]`, first vararg `[esp+0xC]`, **real error site = return address at `[esp]`**.
  Also hook `Sys_Error` itself — it has many direct callers that bypass Com_Error.
- **0x410830 is NOT a return address** — it lands mid-instruction (inside the 7-byte
  `mov word ptr [edi+0xa0], cx` at 0x41082D); its function 0x4107C0 is renderer/material state
  setup and calls neither error function. Stale stack data — do not chase it. (Same false-positive
  class as my earlier 0x5FF4E0 claim, which I withdraw: stack-scanned return addresses are only
  trustworthy when validated as following a `call`.)

## Behaviour note: the foreground-app check (2026-09-20)
The engine throttles hard when it believes it is not the foreground app — it calls
`GetActiveWindow`/`GetForegroundWindow` through the IAT, and parking windows off-screen (as our
headless/off-screen launches do) makes it decide it is backgrounded. foundation's **65-second
freeze** was this, fixed by replacing those two IAT entries. **Three separate measurements that
night were capped by it**, so treat any timing taken with off-screen windows before that fix as
suspect. This is a behaviour to remember, not an address to hook.

## Runtime cross-checks landed (from the referee/foundation)
- **`gentity_s.currentOrigin = +0x160` confirmed** — the referee **withdrew its DISAGREE**: its
  sliding-window method scores +0x15C/+0x160/+0x164 identically (a 4-byte window over a 3-float
  triple overlaps itself, so it can't discriminate at that granularity), and +0x168 onward is
  angle-shaped — exactly where `currentAngles` (r+0x54 = gentity+0x16C) belongs if origin is at
  0x160. So the measurement is consistent with +0x160. Positions (1,271 snaps) and AFK input
  (5,084 rows) both flow from these offsets in a live capture.
- **Huffman**: foundation's reading strengthened it — the decoder takes **no capacity argument**
  (`int f(int src_len /*EAX*/, const void* src /*ECX*/, void* dst /*[esp+4]*/)`), so no
  in-function patch can bound it; they armed a guard-paged scratch decode. See security-audit.md.
- **Sockets imported by ORDINAL not name** (ordinal 52 = `gethostbyname`); name-based IAT hooks
  miss them. Blocking caught the client hitting `cod5-pc.auth.mmp3.demonware.net` 4×/launch.
- **Server licence check worked out** (see security-audit.md §4): a Demonware getAuthTicket gate
  (0x57C0E0) that Com_Errors `PATCH_SERVER_AUTHFAIL`, **skipped for loopback** — not a blocker
  for the own-client + own-server model.

## Lesson applied to this map
A string cross-reference identifies a *caller*, not necessarily the wanted function; a wrong
`[C]` can pass a smoke test then emit garbage (e.g. the 0x473F10 "G_Say" misID fired 60 Hz).
Where practical, `[V]` here means a second independent check — a caller-count, an argument/
stride shape (e.g. `imul instance, 0x4320` = sizeof scrVmPub_t), or "does it only fire when the
event happens". Remaining `[C]` tags are flagged for the consumer to verify before binding.

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
| `Com_Frame` | 0x59E330 | [V] | **the per-frame function.** Verified via full chain: WinMain(0x5FF600) → Com_Frame(0x59E330) → 0x59DCF0 → 0x6366C0 → 0x636610 → SV_Frame(0x635CC0) → G_RunFrame(0x503AB0) → G_ClientDoPerFrameNotifies(0x503540, verified). Call site in WinMain loop = 0x5FF7BD. `void __cdecl`, main thread. **Hook target for a per-frame tick.** NB: it only fires once the dedicated server passes renderer init (see Sys_RenderInit_preloop below). |
| `SV_Frame` | 0x635CC0 | [V] | server frame; runs the game world each frame. Better tick home for server-only work (round/score) since it doesn't run pre-map |
| `G_RunFrame` | 0x503AB0 | [V] | game-logic frame; calls G_ClientDoPerFrameNotifies |
| `Sys_RenderInit_preloop` | 0x5FF4E0 | [V] | **the renderer/D3D bring-up run BEFORE WinMain's frame loop** (call site 0x5FF799, after Com_Init). NOT gated by com_dedicated → the dedicated server gets stuck here (verified by sampling live dedi server pid 25144: every stack rooted at 0x5FF4E0, never the loop). Calls 0x75A9A2 (D3D). **Skip/stub in dedicated so the frame loop — and Com_Frame — can run.** |
| non-dedicated per-frame call | 0x69DAA0 | [V] | **CORRECTED (was labelled 'dedicated console pump' — inverted).** WinMain's branch at 0x5FF7C7/0x5FF7CB *skips* this call when `com_dedicated != 0`; it runs only when the dvar is null or 0. So it is a **client-side** per-frame call. |
| `Sys_Milliseconds` | 0x603D40 | [V] | wraps `timeGetTime` (IAT 0x7EB39C), caches base |
| `Com_InitDvars` | 0x59C8B0 | [C] | registers `com_maxfps`, `developer_script`, `dedicated` |
| `dedicated` dvar (enum) | reg at 0x59C8B0 via `Dvar_RegisterEnum` 0x5EF150 | [V] | enum {0 "listen server", 1 "dedicated LAN server", 2 "dedicated internet server"}, flags 0x40; ptr → com_dedicated 0x212B2F4. WinMain reads the value each frame (0x5FF7C2); the 0x69DAA0 call is **skipped** when it is non-zero (see the corrected row above). The SP exe does have a dedicated code path, but the headless blocker is the fatal-error park, not this call. |

### Commands / dvars
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `Cmd_FindCommand`/registrar | 0x594DB0 | [V] | 190 `(name, funcptr)` registration sites + console lookups both call it |
| `SV_AddOperatorCommands` | 0x62C9B0 | [C] | registers `killserver`,`clientkick`,`loadgame`,`map`… (giant if-chain over `Cmd_FindCommand`) |
| `Dvar_FindVar` | 0x5EDE30 | [V] | see §1 |
| `Dvar_Register` (internal) | 0x5EEB50 | [V] | shared by all the wrappers below |
| `Dvar_RegisterBool` | 0x5EEE20 | [V] | `cl_voice` etc.; T4SP |
| `Dvar_RegisterInt` | 0x5EEEA0 | [V] | `ui_serverStatusTimeOut` |
| `Dvar_RegisterFloat` | 0x5EEF10 | [V] | `cg_hudGrenadeIconWidth`, `bg_bobMax`, `phys_gravity` |
| `Dvar_RegisterVariant` (generic; NOT a 4-arg string register) | 0x5EED90 | [V] | used by string/color/vec dvars (sv_hostname/net_ip/rate/con_typewriterColorBase). **Prototype (settled from the instructions): `dvar_s* __cdecl Dvar_RegisterVariant(const char* name /*+8*/, int type /*+0xC*/, int flags /*+0x10*/, DvarValue value /*+0x14, 8 bytes*/, DvarLimits domain /*+0x1C, **0x14 = 20 bytes** */)`. It reads `[ebp+0x1C]` (movq, 8) **and** dwords `[ebp+0x24]/[ebp+0x28]/[ebp+0x2C]`, all forwarded to inner register 0x5EEA20 whose push block is exactly 0x2C — so the arg block is `[ebp+8]..[ebp+0x2F]` = **0x28 (40) bytes**, caller-cleaned. DvarLimits is 20 bytes, NOT 8; zero all 20 or the trailing dwords read the caller's frame.** String: type=7, flags per need (USERINFO=0x2), value={defaultStr,0}, domain=0. Calls Dvar_FindVar then inner register 0x5EEA20. (Earlier "Dvar_RegisterString" label was wrong — there is no clean 4-arg string register.) |
| `Dvar_RegisterVec3` | 0x5EEFA0 | [C] | 3-float wrapper (Vec4/Color = 0x5EF040) |
| `Dvar_RegisterEnum` | 0x5EF150 | [V] | used for `dedicated` |
| `SetSavedDvar` | 0x516990 | [V] | errors "the dvar %s does not exist" / requires the SAVED flag. **Flag test at 0x516B15: `test word ptr [dvar+8], 0x1000` — so DVAR_SAVED = 0x1000 (NOT 0x200; T4SP enum is wrong for our build), and dvar flags = 16-bit word at dvar_s+0x8.** `con_typewriterColorBase` crash: registered only in client CG-init 0x4708C0 → absent headless. Fix: pre-register with flags\|=0x1000 |
| `SL_ConvertToString` | inlined | [V] | script-string id → text. Inlined everywhere (GetRefString). **Direct read: `id ? *(char**)0x3702390 + id*0xC + 4 : NULL`** (mt_buffer ptr @0x3702390, MT_NODE_SIZE=12, string at node+4). Confirmed via SetSavedDvar's inlined copy (`mov ecx,[0x3702390]; lea eax,[eax+eax*2]; lea ebp,[ecx+eax*4+4]`). Use for notify names AND gentity classname (+0x1A0). Validate against the referee's once-per-round id = `between_round_over`. |
| Cbuf/Cmd_ExecuteString | — | [U] | console dispatch lives inside/near 0x62C9B0; not individually pinned |
| `Dvar_SetFromStringByName` | — | [U] | not yet pinned; reachable via Cmd handlers, find via Dvar_FindVar callers that also write value |

### Script VM (referee)
| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `Scr_GetMethod` | 0x530630 | [V] | detour site 0x683043; T4SP |
| `Sentient_GetFunction` | 0x5676F0 | [H/V] | jump site 0x682D99 |
| `G_ClientDoPerFrameNotifies` | 0x503540 | [V] | see §1 — per-client notify pump each frame |
| VM `waittill`/`endon` parse | 0x696E6D | [C] | "first parameter of waittill/endon must evaluate to a string" |
| script stack-overflow guard | 0x693E80 / 0x696E6D / 0x6992E0 | [C] | "script stack overflow (too many embedded function calls)" |
| `Scr_NotifyNum` | 0x698CC0 | [V] | **every notify funnels here** (98 callers; called 7× by G_ClientDoPerFrameNotifies). EAX=scriptInstance(0=server); stack args entnum, classnum, stringValue(notify-name strId), paramcount. Confirms via `imul instance,0x4320`(sizeof scrVmPub_t) reading gScrVmPub.top@+0x10/inparamcount@+0x18 |
| `VM_Notify` | 0x698670 | [V] | **deepest chokepoint** (2 callers: Scr_NotifyNum + one). EAX=scriptInstance; stack notifyListOwnerId, stringValue, top. For `level notify(x)`: ownerId == gScrVarPub[0].levelId. **Best hook to see every notify with its name** (resolve stringValue via SL_ConvertToString) |
| `GetVariableValueAddress` | 0x690040 | [V] | EAX=varId, ECX=scriptInstance -> ptr into variable entry `0x3914700 + (inst*0x16000 + id)*0x10` |
| `level.round_number` read | via VM | [V-path] | `level` is a script object; read a field by: `levelId = *(u32*)0x3882BC8`; `id = FindVariable(levelId, nameStrId)`; entry = `gScrVarGlob.variableList[id]` at `0x3974700 + id*0x10` (childVariables); value union @ entry+0x4, type in entry.w bits @ entry+0x8. Referee polls a per-map allow-list at ~1 Hz. Each map ships its own `_zombiemode.gsc` (vault §4). |

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
| usercmd/move handler (SV_UserMove-eq) | 0x630BF0 | [C] | "Invalid command time %i from client" — validates usercmd time; called from SV_ExecuteClientMessage's clc_move dispatch. **AFK path**: read/track usercmd buttons+moves here, or svs.clients[i].lastUsercmd |
| `SV_GameSendServerCommand` | 0x648490 | [V] | game→client reliable cmd; callers G_Say + 3 G_ broadcasters. **chat/warning/24h-cap injection.** ecx=clientNum(-1=all)+stack args (type, string) |
| `SV_SendServerCommand` | 0x6F5F10 | [V] | low-level per-client reliable-cmd queue (11 callers incl. SV_GameSendServerCommand) |
| `SV_ExecuteClientCommand` | 0x4621E0 | [C] | sole caller of ClientCommand 0x4388A0 |
| `SV_DropClient` | — | [C] | `EXE_PLAYERKICKED*` handlers at 0x62C3A7/0x62C410/0x62F250/0x643230; exact drop fn TBD |
| `ClientConnect`/`ClientBegin` | — | [U] | GSC-side connect via `SV_DirectConnect`; the game-side `ClientConnect` not yet isolated |

### Script VM globals (referee — rounds/flags/score/knobs)
- **gScrVarPub** = 0x3882BA8, array[2] stride 0x18048. Server `level` object id **levelId = *(u32*)0x3882BC8** (+0x20). Also time@+0x14, gameId@+0x24.
- **gScrVarGlob** = 0x3914700, array[2] stride 0x160000. Single `variableList` of `VariableValueInternal` (0x10 each): parentVariables[24576] @+0 (0x3914700), childVariables[65536] @+0x60000 (0x3974700). `FindVariable`/`GetVariableValueAddress` return child ids (index already offset into childVariables). Entry layout: hash@0x0 (Variable: id u16, prevSibling u16), u@0x4 (value union / next / ObjectInfo), w@0x8 (bitfield: type:5, status:2, unk:1, name:24), v@0xC, nextSibling@0xE.
- **gScrVmPub** = 0x3BD4700, array[2] stride 0x4320. top@+0x10, inparamcount@+0x18, stack@+0x320.
- Value types: VAR_UNDEFINED 0, VAR_POINTER 1, VAR_STRING 2, VAR_ISTRING 3, VAR_VECTOR 4, VAR_FLOAT 5, VAR_INTEGER 6, VAR_OBJECT 0x11. Value union: int/float/stringValue(strId)/vectorValue(ptr)/pointerValue.
- **String resolution (confirmed):** any script-string id → text via `id ? *(char**)0x3702390 + id*0xC + 4 : NULL` (mt_buffer pointer @0x3702390, node size 12, string at +4). No function call needed (it's inlined engine-wide). This resolves notify names (from VM_Notify's stringValue) and gentity classname (+0x1A0).
- To read `level.<name>`: `levelId = *(u32*)0x3882BC8`; find the child variable named `<name>` under levelId; `GetVariableValueAddress(childId, instance 0)` (0x690040, confirmed) → read union+type.
  - Getting the childId from a name: **`FindVariable(parentId, nameStrId)` is NOT yet address-confirmed** — I would not bind it on a single reference (the 0x473F10 lesson). Two safe options: (a) **sibling-walk** the object's children using the confirmed entry layout (each `VariableValueInternal` is 0x10: hash.id@0, value.u@4, w bitfield@8 with the 24-bit `name` in bits 8–31, nextSibling@0xE) — O(n) over level's fields at 1 Hz is trivial and needs no hash; (b) bind an accessor **candidate** and validate against a known field (e.g. read `level.round_number` and check it increments each round): strongest predecessors of GetVariableValueAddress are **0x699640** and **0x699560** (both take scriptInstance in EDI + a field/name arg and touch gScrVarPub.fieldBuffer@+0x10 → likely `Scr_GetObjectField`/`GetVariableFieldValue`-family). Confirm with the harness before relying on either.

### Chat  — CORRECTED (see also the retraction note)
> **0x473F10 was misidentified as G_Say and 0x4388A0 as ClientCommand** — both off the single
> shared string `"%s: "`. 0x473F10 fires ~60 Hz idle (empty text; caller 0x4388A0 is on the
> frame path), so it is a per-frame HUD/notify formatter, not chat. **T4 co-op has no classic
> `say`→G_Say**: chat is the party/lobby reliable-command system. Client sends via
> `0clientchat %s` (0x655C80) / `0hostchat %s %s` (0x65B630). **Inbound capture (verifiable):**
> hook `SV_GameSendServerCommand` 0x648490 (proven for injection) and filter for the chat
> command token — the server relays player chat through it; fires only on chat and carries the
> text. The raw client-command entry is `SV_ExecuteClientMessage` 0x630F70's clc_clientCommand
> path (command-exec region ~0x638BB0/0x638770, [C] — verify it fires only on a command, not
> 60 Hz, before binding). Do NOT re-bind to 0x473F10.

| Function | Addr | Conf | Evidence |
|---|---|---|---|
| ~~G_Say 0x473F10~~ | — | RETRACTED | fires ~60 Hz idle, empty text — per-frame HUD/notify formatter, not chat |
| ~~ClientCommand 0x4388A0~~ | — | RETRACTED | on the frame path; sole caller of the 0x473F10 formatter |
| `SV_GameSendServerCommand` | 0x648490 | [V] | inbound-chat **capture point** (relay) + injection; see the corrected chat note above |
| `clientchat` sender | 0x655C80 | [V] | `0clientchat %s` |
| `hostchat` sender | 0x65B630 | [V] | `0hostchat %s %s` |

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

### Server globals addressing (referee)
`svs` (serverStatic_s) base = **0x23D5C80**. Key fields (T4SP struct offsets, confirmed by
dump ref density): `svs.initialized` = svs+0x171400 = **0x2547080**; `svs.time` = svs+0x171404
= **0x2547084** (48 refs); `svs.clients` = svs+0x171410 = **0x2547090** (85 refs). Player cap 4.
**svs.clients[i] = 0x2547090 + i*0x58D30** (stride = sizeof(client_s) 0x58D30, i=0..3).
Per-client: userinfo +0x6F0, gentity* +0x11544, name +0x11548, netchanIncoming +0x523F4.
Entities: `g_entities[i]` = 0x176C6F0 + i*0x378 (stride = sizeof(gentity_s)); client* at +0x180.

## 3. How much of the T4 engine we can see
**Effectively all of the code section.** `.text` decrypts cleanly (0x3E9A00 bytes), we
recover 15,692 function entry points and a full call graph, and string/dvar cross-references
name a large fraction directly. DemonWare (`bdLobby`/`bdSocket`/`bdNet`) ships with full source
paths (`C:\cod5\cod\codsrc\DemonWare\…`) — that whole online subsystem is trivially mapped and
is exactly what we want to disable. The **frame path is fully traced** (WinMain → Com_Frame →
… → SV_Frame → G_RunFrame → G_ClientDoPerFrameNotifies), and the connection, message, chat,
dvar-register and server-command paths are all named. Remaining gaps are a few no-string
functions (`Scr_NotifyNum`, `Cbuf_AddText`/`Cmd_ExecuteString`, exact `SV_DropClient`).

## 4. Open threads
- Pin `Scr_NotifyNum`, `Cbuf_AddText`/`Cmd_ExecuteString`, exact `SV_DropClient`. Anchors:
  SV_AddOperatorCommands 0x62C9B0 (console dispatch), the VM at 0x696E6D. KisakCOD structure +
  (if fetched) lnxded symbols will name these quickly.
- Confirm whether `fs_homepath` relocates the `__CoDWaW` marker (affects the safe-mode fix).
- **RE accelerators (B approved 2026-09-20, see `docs/re/lnxded.md`):** KisakCOD cloned to
  `ZombiesDev/thirdparty/KisakCOD` and already in use for naming (IW3 = parent engine, WaW
  reports `iw3.0`). `codwaw_lnxded` deferred (its LinuxGSM tarball is 6.5 GB of assets; pull
  only the ELF when the symbol diff is wanted). Clean room: names/offsets only, nothing pasted.
