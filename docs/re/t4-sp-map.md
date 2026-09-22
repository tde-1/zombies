# T4 SP map — verified addresses, function map, evidence

*re agent. Target: Steam `CoDWaW.exe` v1.7, SHA-256 `732900D1…A7D64D`. All addresses are
absolute VAs (no ASLR); on our dump **VA = 0x400000 + file offset**.*

## READ THIS FIRST — how to trust an address in this file

**Confidence tags, and what each actually means:**

| Tag | Meaning | Safe to act on? |
|---|---|---|
| **[V]** | **Verified from an instruction on our own dump** — I read the code that proves it (an operand, a stride, a branch, a call site). | Yes. |
| **[H]** | **From T4SP or KisakCOD headers, consistent with our dump but NOT individually proven here.** | Usually — but see the T4SP warning below. Verify before you patch. |
| **[C]** | **Candidate.** Structure fits, name inferred. One signal only. | **No.** Verify first. |
| **[U]** | Unknown / not located. | — |
| **WITHDRAWN** | Was published here, later disproved. **Kept, not deleted**, so nobody rediscovers it. | **No. Do not use.** |

**How to identify a function here — the method that survived this project:**
1. **A single string cross-reference is a hypothesis, not an identification.** It tells you a
   function *mentions* something; it does not tell you the function *is* that thing. Two of my
   wrong calls came from exactly this, and both passed a smoke test before failing loudly.
2. **Require a second, independent signal** before tagging [V]: a caller count, an argument or
   stride shape (e.g. `imul reg, n, 0x4320` = sizeof scrVmPub_t), an instruction-level branch,
   or a behavioural one ("does it fire when nothing is happening?").
3. **Stack-scanned return addresses are not evidence unless validated** — accept one only if the
   bytes immediately before it are a `call`. Un-validated ones land mid-instruction and name the
   wrong function (0x410830, 0x5FF4E0, 0x49414E were all this).
4. **Say plainly when you will not hand over a calling convention.** Several functions here are
   optimised, register-argument, non-cdecl. Guessing one cost a crash and a boot failure. If the
   convention is unproven, say so and recommend a naked thunk instead of a typed prototype.

## T4SP's enums are wrong for our build — its struct SIZES have been right

This bit us three times. **Trust T4SP/KisakCOD for struct sizes and offsets; do NOT trust their
flag/constant enums without reading the instruction that tests the bit.**

| Constant | T4SP says | **True on our build** | Proof |
|---|---|---|---|
| `DVAR_SAVED` | 0x200 | **0x1000** | `test word ptr [dvar+8], 0x1000` in SetSavedDvar @0x516B15 |
| `DVAR_FLAG_USERINFO` | 0x2 | **0x2** (happens to be right — but verified independently) | userinfo-resend gate @0x644B64 on dvar_modifiedFlags 0x21ACF30 |
| dvar flags location | — | **16-bit word at `dvar_s + 0x8`** | same instruction as above |

By contrast T4SP's *sizes* have been reliable and independently confirmed on our dump:
`scrVmPub_t` 0x4320, `scrVarPub_t` 0x18048, `client_s` 0x58D30, `gentity_s` 0x378 — each matched
a stride or `imul` constant we read from code.

## WITHDRAWN identifications — do not reuse these

Kept deliberately so they are not rediscovered as new findings.

| Withdrawn | I claimed | Reality | How it was caught |
|---|---|---|---|
| **0x473F10** | `G_Say` | A per-frame HUD/notify formatter sharing the `"%s: "` literal. | Referee bound chat to it; fired ~60 Hz idle with empty text. |
| **0x4388A0** | `ClientCommand` | On the frame path; the sole caller of the 0x473F10 formatter. | Fell with 0x473F10 (identified only via it). |
| **0x648490 / 0x6F5F10** | `SV_GameSendServerCommand` / `SV_SendServerCommand` | A **HUD/debug coloured-text pair** — 0x648490 resolves an RGBA via 0x47A450 and passes four floats; 0x6F5F10 strlen's text into a ring buffer at 0x3DCB4C0. | Referee's ~68 s crash after chat injection; reading the prologues showed float args. **Real pair: 0x5A9350 / 0x633FA0.** |
| **0x69DAA0 "dedicated console pump"** | Runs when `com_dedicated != 0` | **Inverted** — WinMain's branch at 0x5FF7C7/0x5FF7CB *skips* it when dedicated; it is a client-side per-frame call. | dedi read the branch. |
| **`COM_PlayIntroMovies` shortlist** (0x570B80, 0x42FDE0, 0x5A8B30, 0x6C0BC0, 0x479370, 0x6DC5D0, 0x6449B0, 0x5C9AC0, 0x5D6BD0) | One of these was the Com_Init gate | **None of them.** All nine counting stubs read zero. The gate was a fatal error (`ERR_MAPLOADERRORSUMMARY`), not a hang. | dedi stubbed all nine. |
| **0x5FF4E0 "dedicated server is stuck here"** | Renderer bring-up was the blocker | Came from an **unvalidated stack scan**; the call site is never even reached. | dedi's counting stub: 0 hits. |
| **0x49414E → 0x494120** | The GDI text-park site | 0x49414E is **mid-instruction**; rejected by dedi's call-preceded filter. | Validated walk gave 0x5B0830 instead. |
| **the 0x59DD90 "bounded Sleep(1) pacing loop" stop** | The dedicated server stops inside it, so something outside must re-enter it endlessly | **That stack is a HEALTHY headless server.** `0x59DDDE <- 0x59E4DC <- 0x5FF7C2` is the normal 1 ms pacing sleep and is the *most common* sample in a good run; `0x48DE8C` in that chain is stale stack data. The loop really is bounded to 50 and never stalls. The real stop was `NtWaitForSingleObject` with a **stable ESP** in the asset-database sync, off the error path. | dedi, 2026-09-21: 19 identical samples named 0x5A3320; removing the cause made it run 37,875 frames in 625 s |
| **Variable-table layout** (entry 0x10 with name at +8, slot `(name + parentId<<8) mod 0x10000`, childVariables at +0x60000) | How to read `level.<field>` | **Disproved** — the referee scored zero hash-consistent names across all four bit-extractions. Level object id is **4**, and `gScrVarPub+0x20` reads zero, so that is probably not `levelId` either. | Referee's exhaustive test. |


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

## Second dedicated park: synchronous GDI text draw (2026-09-20)
After the ERR_MAPLOADERRORSUMMARY suppression, Com_Init returns and ~2 frames run, then the main
thread parks in `win32u!NtGdiExtTextOutW` with a **stable ESP** (one synchronous GDI call, not a
message loop). CoDWaW.exe imports **no** ExtTextOut/TextOut/DrawText — its only GDI-text windows:
- **WinConsole** — created 0x605500 ("Call of Duty WinConsole"); edit-control `SendMessageA` at
  0x6056ED/0x605704; text append 0x6057F0 / 0x605870.
- **Splash screen** — 0x603D70 ("cod.bmp" / "CoD Splash Screen"); `SendMessageA` at 0x603EA9.
Both draw via their control's paint → ExtTextOutW. A synchronous append to a hidden/unpumped
window stalls there. **CORRECTED after dedi's validated walk:** the thread is **grinding, not deadlocked** (EIP moves
between `NtUserExtTextOutW` and `NtUserScrollDC`), and the repeated validated frame is
**0x5B0830 -> func 0x5B0810** (0x80 bytes; caller 0x5BF5B0, callee 0x63B630) which is **NOT** the
print path or the console module. 0x60594E -> 0x605870, whose only caller is Sys_Error.
**0x605500 IS the console creator** (RegisterClassA + CreateWindowExA), called **lazily from the
append at 0x605804** — so the window appears on the first print.
**UNSAFE TO STUB: 0x605500 / 0x6057F0 / 0x605870.** They are not no-arg cdecl; a plain-`ret` stub
that mis-cleans the stack corrupts the caller — that is what made Com_Init stop returning when
dedi stubbed them. Verified prototypes are not yet established; do not guess one.
**Safe fix: intercept at the IAT** (the technique that already fixed the foreground-app freeze) —
hook `CreateWindowExA`/`RegisterClassA` and refuse the WinConsole class in dedicated mode. No
engine calling-convention risk, and `logfile 2` already captures output. The referee's reported frame 0x49414E is
**mid-instruction** (inside `movss` at 0x49414A) inside 0x494120 (a client-frame CG draw callback)
— unreliable (0x410830 class); confirm with a validated return-address walk. If the real frame IS
0x494120 it is on the CLIENT render path — suppress dedicated-only, never in the client build.

## The dedicated fatal: ERR_MAPLOADERRORSUMMARY in SV_SpawnServer (2026-09-20)
`dedi`'s Com_Error hook trapped it: **`Com_Error(7, "")` at 0x62B7AD**, return address 0x62B7B2.
- **errorParm_t 7 = `ERR_MAPLOADERRORSUMMARY`** — read independently from T4SP `enums.hpp` and
  KisakCOD `qcommon.h` (both: FATAL 0, DROP 1, SERVERDISCONNECT 2, DISCONNECT 3, SCRIPT 4,
  SCRIPT_DROP 5, LOCALIZATION 6, **MAPLOADERRORSUMMARY 7**).
- **Both 0x62B7B2 and 0x62B4B0 are inside `SV_SpawnServer` 0x62B3E0** — they do not name two
  different steps. Frames below (0x594AF0 / 0x594B40 / 0x594360) are the Cmd_* path, i.e. `+map`
  from the command buffer inside Com_Init. So the summary is raised at the end of the map load.
- **`0x840FF0` is the shared empty-string literal `""`** (hundreds of referents). The
  `CS_VISIONSET_*` names after it are literal-pool adjacency — a red herring, not a table.
- `com_errorMessage` is empty because Com_Error sets it from the empty fmt; the preceding
  `call 0x5EDA40` sets a 1-char flag ("1"/""), not the message. **The accumulated list was empty**,
  so the dedicated path trips the summary check rather than missing a specific asset.
- **Fix:** skip the `call` at **0x62B7AD** in dedicated mode (5-byte NOP or short-circuit the
  guard). Then `Sys_Error`'s park (0x5FE8C0) is never entered, Com_Init returns, and frames start.

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

### 2D drawing and the stock chat HUD — IDENTIFIED 2026-09-22 (client lane, `chat-overlay.md` §9)

**The three retracted "chat" addresses are the chat HUD's DRAW path, and the withdrawn
"SV_SendServerCommand" is the text renderer.** Each row below is backed by a string or a
render-command constant *and* by drawing with it in the running game (pictures in
`docs/kickstart/ui/chat-overlay-*.jpg`). The "real pair 0x5A9350 / 0x633FA0" note above is the
server-command side and is untouched by this.

| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `R_AddCmdDrawText` | 0x6F5F10 | [V] | writes render command id **0xD** into the frontend buffer `[0x3DCB4C4]` (the "ring at 0x3DCB4C0"); args `text, maxChars, font, x, y, xScale, yScale, rotation, style`, **colour in ECX**, caller cleans. 11 callers. Previously bound as SV_SendServerCommand — that is why injecting through it from the server frame corrupted the buffer. |
| text draw in virtual space (a `UI_DrawText` sibling) | 0x648490 | [C] | calls `ScrPlace_ApplyRect` 0x47A450 then `R_AddCmdDrawText` 0x6F5F10 — the "four floats" were the rect, not an RGBA. Callers 0x431C80, 0x439160, 0x439380 and Con_DrawSay 0x473F10. NOT `SV_GameSendServerCommand`. Not bound. |
| `UI_DrawText` | 0x5B5FB0 | [V] | `(scrPlace, text, maxChars, font, x, y, scale, color*, style)` cdecl 9 args + **ECX horzAlign, EAX vertAlign**; `xScale = scale*48/font->pixelHeight` (`[0x8AF250]`=48.0, `Font_s::pixelHeight` +4); 55 callers. |
| `ScrPlace_ApplyRect` | 0x47A450 | [V] | `[esp+4]` scrPlace, `[esp+8]` horz, `[esp+0xC]` vert; EDX &x, EDI &y, ECX &w, ESI &h. LEFT: `x*s[+0]+[+0x30]`; TOP: `y*s[+4]+[+0x34]`; BOTTOM: `+[+0x3C]`. |
| `scrPlaceFullUnsafe` / `scrPlaceFull` / `scrPlaceView[]` | 0x9573A8 / 0x957360 / 0x957318 | [V] | ScreenPlacement, stride 0x48, set up in CL_InitRenderer 0x644BE0 via 0x47A1C0 |
| `R_AddCmdDrawStretchPic` | 0x6F58E0 | [V] | cdecl `(x, y, w, h, s0, t0, s1, t1, color*, material)`; 18 callers |
| `R_TextWidth` | 0x6E8DA0 | [V] | EAX text; stack `(maxChars, font)`; returns font pixels, skips `^N` |
| `R_RegisterFont` / `Material_RegisterHandle` | 0x6E8D80 (ff) / 0x6E9C00 (ff) | [V] | the `useFastFile` ([0x1F552FC]) variants; the loose-file ones are 0x6E8CE0 / 0x6E9B80 |
| `cls.whiteMaterial` / `consoleMaterial` / `consoleFont` | 0x4DA8F4C / 50 / 54 | [V] | CL_InitRenderer 0x644D38..0x644D8D |
| `cls.vidConfig.displayWidth/Height` | 0x4DA90B8 / 0x4DA90BC | [V] | copied from 0x3BED828 (13 dwords) at 0x644C89 |
| sharedUiInfo fonts | 0x20A10E8 big, 0x20A10EC small, 0x20A10F0 console, 0x20A10F4 bold, 0x20A10F8 normal, 0x20A10FC extrabig, 0x20A1100 objective; cursor 0x20A10D4 | [V] | registered by name at 0x5D10C0..0x5D11E4 |
| `CG_DrawActiveFrame` | 0x4621E0 | [V] | `call CG_Draw2D` at **0x4628AB** with EAX = localClientNum (the overlay's seam). Was "SV_ExecuteClientCommand [C]" — withdrawn already, now identified. |
| `CG_Draw2D` | 0x4388A0 | [V] | EAX = localClientNum; calls CG_DrawChat at 0x438A21 and Con_DrawSay at 0x438A7A. Was "ClientCommand" — RETRACTED, now identified. |
| `CG_DrawChat` | 0x436900 | [V] | WaW MP's HUD chat, live in SP: `cg_hudChatPosition` dvar ptr 0x3466098 (default 5,200), `cg_chatHeight` 0x3466540 (5), `cg_chatTime` 0x3688B34 (12000); ring text 0x3467618 (stride 0x97), times 0x3467AD0, head 0x3467AF0 / tail 0x3467AF4; scale 1/3 (`[0x8AF5B0]`), 16-unit step, box rgb 0.25 alpha 0.6. |
| `CG_AddToTeamChat` | 0x459730 | [C] | the only writer of CG_DrawChat's ring. Not bound. |
| `Con_DrawSay` | 0x473F10 | [V] | draws `EXE_SAY`/`EXE_SAYTEAM` + the chat field (0x951B20, stride 0x1128) when keyCatchers (0x3058424) bit 0x20 is set; `cg_hudSayPosition` 0x339B75C (5,180; drawn at y+24). Was "G_Say" — RETRACTED, now identified. |
| `CL_AddReliableCommand` | 0x640FE0 | [V] | cdecl `(const char*)`; reliableSequence 0x3010120, reliableAcknowledge 0x3010124, 128 x 512 at 0x3010128, `EXE_ERR_CLIENT_CMD_OVERFLOW` past 128. An unknown command sent through it makes the stock game print **"Unknown cmd <name>"** on the player's HUD. |
| `dx.d3d9` / `dx.device` | 0x3BF3B04 / 0x3BF3B08 | [V] | Direct3DCreate9 wrapper result stored at 0x6D62C2; CreateDevice (vtable +0x40) at 0x6D605A writes the device. Patching `IDirect3DDevice9::Present` (slot 17) alone never fired; captures started once the implicit swap chain's `Present` (slot 3) was patched as well, so T4 presents through the swap chain. |
| keyCatchers | 0x3058424 | [V] | 0x1 console, 0x10 UI/menu (tested first by CL_MouseEvent), 0x20 stock message field |
| clc.state in a live map | 0x305842C | [V] | reads **10** in game on this build (7 while connecting) |

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

## 5. The join path (superseded by §9 — kept for the reasoning)
`+connect` is **not a client command in the SP exe** — the string `connect` (0x888A28) is pushed
at exactly one site, 0x635253, inside `SV_ConnectionlessPacket`; it is the *server* OOB command
name. Nothing registers a client-side `connect`, so the command line was silently a no-op.

The T4 equivalent of iw4x's `connect_coop` is **function 0x641730** (0x641730..0x641960) [C-strong]:
- pushes **"localhost"** (0x86F0D4), calls **`CL_SendConnectPacket` 0x642C80**, and is called from
  **0x631F20** (the map-load path) and 0x6582A0 — i.e. it is what connects the local client after
  a map comes up in a listen/solo game.
- **Gate [V]:** at 0x64174E, `mov esi,6; cmp dword ptr [0x305842C], esi; jl -> skip` — the client
  state at **`[0x305842C]` must be >= 6** or the connect branch is skipped. It also clears
  `[0x3058424]`/`[0x3058428]` and sets `[0x22BD9EB]=1`. (0x3058xxx is the clientStatic/clc block.)
- **Both call sites pass two stack dwords**: `push edx([ebp+0x10]); push edi` (0x6321A2) and
  `push 0; push edi` (0x65838A).
- **NOT PROVEN: what those two arguments mean, and who cleans the stack.** Do not call it blind.
  Prove the args and cleanup first — the two call sites plus the `jl` gate are the way in.
- Auth is already clear for this test: Demonware `getAuthTicket` 0x57C0E0 is skipped for
  NA_LOOPBACK (guard 0x642E4C), so a loopback join needs no auth patch.

## 6. The frame path, read end to end (dedi, 2026-09-21) — all [V]

Every address here was read off an instruction on our own dump and then confirmed against a live
validated stack walk of a running headless server. This section exists to settle "where can a
dedicated server possibly stall", because the answer turned out to be **nowhere in this path** —
the stall was on the error path (§7).

### `WinMain`'s loop — unconditional, cannot exit

```
005FF77E  call 0059D710             Com_Init
005FF794  call 00594200             command-buffer exec (this is where `+map` runs)
005FF799  call 005FF4E0             renderer bring-up   <- we retarget this
005FF7AB  mov esi, [0x7EB0F0]       esi = KERNEL32!Sleep
005FF7B1: cmp [0x22C1BF0], ebx      LOOP TOP (ebx = 0)
005FF7B7  je 005FF7BD | push 5 / call esi        conditional Sleep(5)
005FF7BD  call 0059E330             Com_Frame    <- shared/core/frame.cpp retargets this
005FF7C2  eax = [0x212B2F4]         com_dedicated
005FF7CB  cmp [eax+0x10], ebx / jne 005FF7D5     dedicated SKIPS the next call
005FF7D0  call 0069DAA0             client-side per-frame
005FF7D5  Dvar_FindVar("onlinegame") ... je 005FF7B1
005FF80B  jmp 005FF7B1
```

**Every path ends at `jmp 0x5FF7B1`.** There is no break out of it. So if frames stop, the answer
is always "`Com_Frame` did not return", never "the outer loop is waiting for something".

### `Com_Frame` 0x59E330 — a wrapper with a `setjmp` guard

```
0059E339..0059E4AB   40x `mov esi,<addr>; call 0059E1D0`    per-frame profile/timer resets
0059E4C1  call 007E1894            _setjmp3(buf, 0)   (writes 'VC20' at buf+0x20 -- MSVC setjmp)
0059E4CB  jne 0059E4E3             the longjmp landing: an ERR_DROP SKIPS the whole body
0059E4CD  call 0070E3A0
0059E4D2  call 0048DE40
0059E4D7  call 0059DCF0            THE FRAME BODY
0059E4DC  add dword [0x1F964BC], 1 com_frameNumber
0059E4E3  push 0x2298D68 / call [0x7EB138]       EnterCriticalSection
0059E4EE  cmp dword [0x1F964B4], 0
0059E4F5  jne 0059E505             THE ERROR BRANCH (see section 7)
0059E502  ret
0059E505  call 0059A6F0 ; LeaveCriticalSection ; call 00644BE0 ; jmp 0059E180
```

- **`com_frameNumber` = 0x1F964BC** [V]. It is incremented *after* the body, so a counter hooked at
  WinMain's call site reads N when the (N+1)th frame is the one that hung. That is exactly why the
  server that hung on its 5th frame reported "4 frames".
- `Com_Error(ERR_DROP)` `longjmp`s back to 0x59E4CB, which is how a frame can silently do nothing.

### `0x59DCF0` — the frame body, and the pacing loop

```
0059DD10  edx = [0x1F96488]        the com_maxfps dvar
0059DD26  [esp+0x14] = 1           minimum frame time = 1 ms
0059DD2A  jle 0059DD4B             com_maxfps <= 0 -> uncapped
0059DD2C  eax = [0x212B2F4] ; cmp dword [eax+0x10], 0
0059DD35  jne 0059DD4B             DEDICATED SKIPS THE 1000/com_maxfps COMPUTATION
0059DD37  eax = 1000 / com_maxfps -> [esp+0x14]
0059DD6C  add [0x1F552D4], 1       a frame counter
0059DD7C  je 0059DDFA              NOT dedicated -> the other pacing path
0059DD7E  ebp = [0x7EB39C] timeGetTime   ebx = [0x7EB0F0] Sleep   edi = 0
0059DD90: call 0059B630            Com_EventLoop
0059DDB1  eax = timeGetTime() - [0x22BEC34]      now, in ms since the engine's base
0059DDC1  [0x1F9648C] = eax        com_frameTime
0059DDD2  esi = now - [0x1F964B8]  lastFrameTime
0059DDD8  jge 0059DDEB             target met, done
0059DDDC  call ebx                 Sleep(1)
0059DDE1  cmp edi, 0x32 / jl 0059DD90            BOUNDED TO 50 ITERATIONS
...
0059DEBF  call 006366C0            the server frame (-> 0x636610 -> SV_Frame 0x635CC0)
0059DED4  jne 0059DFCF             DEDICATED skips ALL the client work below
```

- **`com_frameTime` = 0x1F9648C**, **lastFrameTime = 0x1F964B8**, **timer base = 0x22BEC34** [V].
- **A dedicated server's minimum frame time is hard-coded to 1 ms**: `com_maxfps` is not consulted
  on this path at all. That is why `+set com_maxfps 0` changed nothing when it was tried as a cure
  for the 4-frame stop, and why an unpatched headless server free-runs at ~515 Hz while `SV_Frame`
  does its real work at 20. `server/components/dedicated/frame_pacing.cpp` nops the `jne` at
  **0x59DD35** so the dvar is honoured (measured: 515 Hz at 12.5% of a core -> 61 Hz at 4.9%).
- The sleep loop is genuinely bounded at 50 iterations and **cannot** be where a server hangs.

### The event pump

| Function | Addr | Conf | Evidence |
|---|---|---|---|
| `Com_EventLoop` | 0x59B630 | [V] | 1 caller (0x59DCF0). Loops `Sys_GetEvent` over a 0x20-byte event, `jmp [eax*4 + 0x59B6F0]` switch on type 0..3; handlers 0x4780F0, 0x478850, 0x594200 |
| `Sys_GetEvent` | 0x5FEC60 | [V] | pops a queued event under CS 0x2298E58; else `PeekMessageA` (IAT 0x7EB2EC, PM_NOREMOVE) -> `GetMessageA` (IAT **0x7EB2CC**) -> Translate/Dispatch -> `Sys_ConsoleInput` |
| `Sys_ConsoleInput` | 0x605840 | [V] | 1 caller (Sys_GetEvent). **Pure memory: no GDI, no window, no blocking.** `if (!byte[0x22C1674]) return 0;` then copies the line to +0x200 and returns 0x22C1874. **Safe with the WinConsole refused** -- it is not why anything hangs |
| two-event poll | 0x48DE40 | [V] | called by Com_Frame at 0x59E4D2. `WaitForSingleObject([0x1FF5250], 0)` then `([0x1FF51C4], 0)` (IAT **0x7EB100**); timeout 0, so non-blocking. If the second is signalled it tail-jumps to 0x48E560 |

**`GetMessageA` will block a headless server for seconds at a time.** The `PeekMessage(PM_NOREMOVE)`
guard at 0x5FECE9 races the re-peek at 0x5FED3E, and with an almost-always-empty queue (headless,
console window refused) the thread parks in `GetMessageA` until any message arrives. Measured: seven
`Hitch warning: 5034 msec frame time` in 90 s. Fixed at the IAT in
`server/components/dedicated/nonblocking_pump.cpp`; hitches went 7 -> 1 and the frame rate went from
oscillating 170-500 Hz to flat. **Do not return 0 from a GetMessageA replacement** -- the engine
reads 0 as WM_QUIT at 0x5FED13 and shuts down.

### IAT entries used above (all [V], read from the operands)

| Import | IAT slot |
|---|---|
| `KERNEL32!Sleep` | 0x7EB0F0 |
| `KERNEL32!WaitForSingleObject` | 0x7EB100 |
| `WINMM!timeGetTime` | 0x7EB39C |
| `USER32!PeekMessageA` | 0x7EB2EC |
| `USER32!GetMessageA` | 0x7EB2CC |
| `USER32!TranslateMessage` | 0x7EB300 |
| `USER32!DispatchMessageA` | 0x7EB2E4 |
| `KERNEL32!EnterCriticalSection` / `LeaveCriticalSection` | 0x7EB138 / 0x7EB134 |

---

## 7. The error path, and the only unbounded wait on it (dedi, 2026-09-21)

This is what the dedicated server actually deadlocked in, and it is worth knowing because **any**
`Com_Error` on a headless box ends here.

| Function | Addr | Conf | Evidence |
|---|---|---|---|
| error / shutdown path | 0x59A6F0 | [V] | 2 callers: `Com_Init`+0x21 and `Com_Frame` at 0x59E505 (taken when `[0x1F964B4] != 0`). 0x1010-byte frame, zeroes ~10 globals, calls the DB sync at 0x59A75F |
| **asset-database sync** | 0x5A3320 | [V] | 12 callers. Prints `"Database: Assets Sync Started"` (0x873A4C), then `do { 0x5FDBF0(); } while (WaitForSingleObject([0x1FF51C4], 500) != WAIT_OBJECT_0);`, then `"Database: Assets Sync Finished"` (0x873A6C). **The only unbounded wait on the frame or error path.** A console log that ends on "Started" with no "Finished" means the main thread is here |
| `EXE_ERR_CANNOTJOININPROGRESS` raise | 0x643D50 | [V] | inside `CL_ConnectionlessPacket` 0x643380: `push msg; push "%s"(0x84B86C); push 1 /*ERR_DROP*/; call Com_Error 0x59AC50`. This handles the server's `error` OOB reply |

**The diagnostic rule this cost a day to learn:** a sample in `NtDelayExecution` proves nothing on
its own, because a healthy headless server is asleep most of the time. A sample in
`NtWaitForSingleObject` **with a byte-identical ESP across many samples** is a real deadlock.

---

## 8. `CL_ConnectLocal` 0x641730, read out (dedi, 2026-09-21)

Upgrades section 5 from [C-strong] to [V] on the mechanics, and adds the part that decides whether a
**second-process** join can work at all.

```
00641730  push ebp / mov ebp,esp / and esp,-8    args [ebp+8] = map name, [ebp+0Ch] = byte flag
0064174E  cmp [0x305842C], esi(=6)
00641767  jl 006417D2                            state < 6 TAKES the connect path
00641769  push "localhost"(0x86F0D4) ...         state >= 6: early-out if already on localhost
006417D2: eax = 0x840FF0 ("") ; call 005EF550
006417E7  push "localhost"(0x86F0D4)             THE TARGET ADDRESS, hard-coded (68 D4 F0 86 00)
006417EC  push 0x48AE3A0                         the server-name buffer
006417F1  call 007AA9C0                          strncpy(0x48AE3A0, "localhost", 0xFF)
0064185F  [0x305842C] = 5                        client state = connecting
00641855  push 0x300FFF8                         out netadr_s
0064187A  call 00679520                          name -> netadr (name in EAX, out ptr on the stack)
00641883  call 00642C80                          CL_SendConnectPacket
0064194F  ret                                    plain ret; both call sites `add esp,8` -> cdecl
```

New, and load-bearing for milestone (d):

- **server-name buffer = 0x48AE3A0** [V]; **resolved server address (netadr_s) = 0x300FFF8** [V];
  **client state = 0x305842C** [V] (set to 5 = connecting; the gate compares against 6).
- **The destination is hard-coded to the string `"localhost"`**, pushed as a plain `imm32` at
  **0x6417E7**. The function takes no address argument. If `"localhost"` resolves to `NA_LOOPBACK`
  (the engine's in-process ring buffer) rather than `NA_IP 127.0.0.1`, then **a second process can
  never reach our server through this call** -- and the one-dword fix is to rewrite that `push`
  operand to point at our own string, e.g. `"127.0.0.1:28960"`. **Untested as of writing. Test it
  before believing either answer.**
- `0x679520` is the name-to-netadr resolver [C]; its convention looks like EAX = name with the out
  pointer on the stack. Not proven enough to call, and it does not need to be -- the `push` operand
  is the cheaper and safer lever.

---

## 9. The join path, end to end (dedi, 2026-09-21) — five gates, all [V]

A second `CoDWaW.exe` now reaches `Going from CS_FREE to CS_CONNECTED` on our headless server. Five
things stood in the way, each found by running the test and reading the instruction that produced
the failure.

> **Update 2026-09-22.** These five gates turned out to be the whole of it: with them cleared the
> client walks on to `CS_CLIENTLOADING` and then **`CS_ACTIVE`** with nothing further patched.
> **T4 has no `CS_PRIMED`** — that is Quake 3 / CoD 4, and any note in this file or elsewhere that
> names it is wrong. The middle state is **`CS_CLIENTLOADING`** (value 3). The addresses for the
> rest of the walk — `SV_SendClientGameState` `0x62F500`, `SV_ClientEnterWorld` `0x62FC30`,
> `SV_ExecuteClientMessage`'s low-nibble serverId gate at `0x631008`, and the `client_s` offsets —
> are in `docs/kickstart/dedi.md` §7h, each one read off an instruction. All five addresses below were verified before being patched, and every patch site was
checked for the caller's own stack cleanup rather than a guessed convention.

| # | Gate | Address | What it does | How we pass it |
|---|---|---|---|---|
| 1 | `CL_ConnectLocal`'s hard-coded destination | `push` imm32 at **0x6417E7** | pushes `"localhost"` (0x86F0D4), which `NET_StringToAdr` **0x679520** special-cases to `netadr.type = 2` (**NA_LOOPBACK**, the in-process ring buffer) with no ip and no port | rewrite the imm32 to our own `"127.0.0.1:<port>"`; the resolver then takes the parse branch at 0x679569 and splits on `':'` (0x84B668) |
| 2 | Demonware's `bdSocketRouter` | drop at **0x57ED5C** in **0x57EC90**, selected by `je` at **0x600109** in `Sys_SendPacket` **0x6000B0** | every connected packet is dropped in-process with `addrHandle=0` because there is no `bdAddrHandle` for the peer (table at **0x48886F8**, stride 0x24, 0x68 entries) and one needs a live Demonware session | `74 34` → `EB 34`, so `Sys_SendPacket` always takes its own raw `sendto` path at 0x60013F |
| 3 | the challenge handshake | imm32 at **0x641865** | `CL_ConnectLocal` hard-sets `clc.state` = **5**; `CL_CheckForResend` **0x642C80** dispatches **4 → send `getchallenge`**, **5 → send `connect`**, **7 → …** (`sub esi,4 / je` at 0x642D00) | set the immediate to **4** so the client asks for a challenge first |
| 4 | the co-op join gate | `cmp byte [eax+0x10],0 / je` at **0x62EBC9**, dvar ptr at **0x339A774** | `SV_DirectConnect` refuses with `EXE_ERR_CANNOTJOININPROGRESS` when the dvar is 0. Read twice (0x62E9BB, 0x62EBC4) | set the dvar. **Its name is `party_joinInProgressAllowed`** — recovered at runtime from `dvar_s+0x00`, because all five references *read* 0x339A774 and none writes it. **It is not registered at `post_init`**; poll for it |
| 5 | the Demonware server-licence ticket | `call 0x582740` at **0x62EDA7** | `SV_DirectConnect` validates a ticket from the last 0x18 bytes of `client_s` (+0x58D18/+0x58D20/+0x58D28) and raises `EXE_BAD_CHALLENGE` (0x886DA4) at 0x62EDE5 if it fails. The name misleads: `CHALLENGERESPONSE: Got server licenseid %llx` shows this is the licence exchange, not the Quake challenge number | `mov al,1; nop x3` — stack-neutral because `add esp,0x10` follows at 0x62EDAC. The exact mirror of the existing client-side patch at 0x642E77 |

**A second `EXE_BAD_CHALLENGE` raise at 0x62E75D** on an earlier path in the same function is **not
patched and has not been hit**. Distinguishable: only the one at 0x62EDE5 is preceded by the
0x582740 call.

### Related addresses confirmed along the way

| Symbol | Addr | Conf | Evidence |
|---|---|---|---|
| `NET_StringToAdr` | 0x679520 | [V] | `repe cmpsb` against `"localhost"` then `mov dword [ebx], 2`; name in EAX, out `netadr_s*` on the stack |
| `NET_SendPacket` | 0x6790E0 | [V] | 6 callers; switches on `netadr.type` — 2 → loop packet (0x678FF0), 0/1 → drop, else → `Sys_SendPacket` |
| `Sys_SendPacket` | 0x6000B0 | [V] | 1 caller; type 3/4 → socket `[0x22BEBD0]`, 5/6 → socket `[0x22BD9EC]`, else `Com_Error("Sys_SendPacket: bad address type")` |
| `CL_CheckForResend` (the `CL_SendConnectPacket` label was too narrow) | 0x642C80 | [V] | per-frame; valid states 4/5/7, rate-limited 3,000 ms (100 ms in state 7); sends `getchallenge` (0x888A18) or `connect` |
| `clc.state` | 0x305842C | [V] | written 5 by CL_ConnectLocal, read by CL_CheckForResend's dispatch |
| `clc.servername` | 0x48AE3A0 | [V] | `strncpy(.., "localhost", 0xFF)` at 0x6417F1 |
| `clc.serverAddress` (netadr_s) | 0x300FFF8 | [V] | out param of NET_StringToAdr at 0x641855; also what direct_connect's auth guard reads (`cmp [0x300FFF8], 2`) |
| netadr type enum | — | [V] | **0 NA_BOT, 1 NA_BAD, 2 NA_LOOPBACK**, 3/4 ordinary sockets (4 = NA_IP), 5/6 Demonware-routed |

### Two behaviours worth remembering

- **T4 does not send connected game traffic over a plain socket by default.** It routes it through
  Demonware. That is almost certainly why Plutonium's T4 client is their own binary rather than the
  stock exe plus a DLL, and it is the single biggest engine fact this lane has found.
- **`getstatus` is answered on the raw path** and worked from the very first headless boot, so "the
  server answers on the wire" and "a client can talk to the server" are genuinely different
  questions. Do not use one as evidence for the other.

---

## 4. Open threads
- Pin `Scr_NotifyNum`, `Cbuf_AddText`/`Cmd_ExecuteString`, exact `SV_DropClient`. Anchors:
  SV_AddOperatorCommands 0x62C9B0 (console dispatch), the VM at 0x696E6D. KisakCOD structure +
  (if fetched) lnxded symbols will name these quickly.
- Confirm whether `fs_homepath` relocates the `__CoDWaW` marker (affects the safe-mode fix).
- **RE accelerators (B approved 2026-09-20, see `docs/re/lnxded.md`):** KisakCOD cloned to
  `ZombiesDev/thirdparty/KisakCOD` and already in use for naming (IW3 = parent engine, WaW
  reports `iw3.0`). `codwaw_lnxded` deferred (its LinuxGSM tarball is 6.5 GB of assets; pull
  only the ELF when the symbol diff is wanted). Clean room: names/offsets only, nothing pasted.
