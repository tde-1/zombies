#pragma once
// ---------------------------------------------------------------------------------------
// ENW Zombies -- Call of Duty: World at War (T4) SP/co-op engine address map.
//
// Target: Steam CoDWaW.exe v1.7, 5,902,336 bytes,
//   SHA-256 732900D158982C33E3121F0B86D22230BE79839BBCBFE3BDFC1238F408A7D64D
//   Steam build 252004. ImageBase 0x400000, no ASLR (DllCharacteristics == 0), so these
//   are absolute VAs that hold every launch.
//
// ---------------------------------------------------------------------------------------
// READ THIS BEFORE USING ANY CONSTANT HERE.  Full evidence: docs/re/t4-sp-map.md
//
//   [V] = verified from an instruction on our own dump (an operand, stride, branch or call
//         site was read). Safe to act on.
//   [H] = from T4SP / KisakCOD headers, consistent with our dump but NOT individually proven
//         here. Usually fine for struct sizes/offsets; verify before patching.
//   [C] = candidate: structure fits, name inferred from ONE signal. DO NOT act on without a
//         second check.
//
// Two rules this project learned the hard way:
//  1. A single string cross-reference is a hypothesis, not an identification. Two labels in
//     here were wrong for exactly that reason (see the WITHDRAWN list below and in the map).
//  2. Where a calling convention is unproven this file SAYS SO and recommends a naked thunk.
//     Guessing one cost a crash and a boot failure. Do not invent a prototype from an address.
//
// T4SP's ENUMS ARE WRONG FOR THIS BUILD, though its struct SIZES have been right:
//     DVAR_SAVED    = 0x1000  (T4SP says 0x200)  - proven: test word[dvar+8],0x1000 @0x516B15
//     DVAR_USERINFO = 0x0002  (verified independently @0x644B64)
//     dvar flags are a 16-bit word at dvar_s + 0x8.
// Sizes that DID hold and were re-confirmed from code strides: scrVmPub_t 0x4320,
// scrVarPub_t 0x18048, client_s 0x58D30, gentity_s 0x378.
//
// WITHDRAWN — kept named so they are not rediscovered; do not use:
//   0x473F10 "G_Say"            -> per-frame HUD/notify formatter (fired 60 Hz idle)
//   0x4388A0 "ClientCommand"    -> on the frame path; identified only via 0x473F10
//   0x648490 / 0x6F5F10         -> HUD/debug COLOURED-TEXT pair, not server commands
//                                  (real pair: SV_GameSendServerCommand 0x5A9350 / 0x633FA0)
//   0x69DAA0 "dedicated pump"   -> INVERTED; it runs only when com_dedicated == 0
//   0x5FF4E0 "dedicated stuck"  -> from an unvalidated stack scan; never even reached
//   COM_PlayIntroMovies shortlist (9 addrs) -> all nine counting stubs read zero
//   variable-table layout       -> disproved by the referee; level object id is 4
// ---------------------------------------------------------------------------------------
//
// This is our own file: plain constants + comments, no copied Activision code.
// ---------------------------------------------------------------------------------------

#include <cstdint>
#include <cstddef>

namespace t4
{
    constexpr std::uintptr_t image_base = 0x400000;

    // ---- core / console -------------------------------------------------------------
    namespace fn
    {
        // [V] print to the game console. void(con_channel_e, const char* fmt, ...)
        constexpr std::uintptr_t Com_Printf                 = 0x59A2C0;
        constexpr std::uintptr_t Com_PrintMessage           = 0x59A170; // [H]
        constexpr std::uintptr_t Com_Error                  = 0x59AC50; // [V] (Com_Error(errParm, fmt,...))
        constexpr std::uintptr_t Sys_Error                  = 0x5FE8C0; // [H]
        constexpr std::uintptr_t Com_Init                   = 0x59D710; // [V] SEH-wrapped, 1 caller (WinMain)
        constexpr std::uintptr_t Com_Frame                  = 0x59E330; // [V] called once per WinMain loop iter
        constexpr std::uintptr_t WinMain                    = 0x5FF600; // [V] calls Com_Init, the frame loop, dedicated console pump
        constexpr std::uintptr_t Sys_Milliseconds           = 0x603D40; // [V] wraps timeGetTime (WINMM)
        constexpr std::uintptr_t va                         = 0x5F6D80; // [H]
        // Frame chain (verified via call graph down to G_ClientDoPerFrameNotifies):
        //   WinMain -> Com_Frame -> 0x59DCF0 -> 0x6366C0 -> 0x636610 -> SV_Frame ->
        //   G_RunFrame -> G_ClientDoPerFrameNotifies
        constexpr std::uintptr_t Com_Frame_callsite         = 0x5FF7BD; // [V] `call Com_Frame` in WinMain's loop
        constexpr std::uintptr_t SV_Frame                   = 0x635CC0; // [V] server frame (runs game world); referee tick home
        constexpr std::uintptr_t G_RunFrame                 = 0x503AB0; // [V] game logic frame
        // The renderer/D3D init that runs BEFORE WinMain's frame loop and is NOT gated by
        // com_dedicated -> blocks the dedicated server from ever ticking. Skip/stub in dedi.
        constexpr std::uintptr_t Sys_RenderInit_preloop     = 0x5FF4E0; // [V] WinMain call site 0x5FF799; calls 0x75A9A2 (D3D)

        // ---- win32 input / mouse (client lane, 2026-09-22) -------------------------
        // The whole block below is [V] from our own dump. T4 has NO DirectInput at all
        // (no dinput8 import, no CLSID_DirectInput8 / GUID_SysMouse bytes anywhere in
        // the image) -- the mouse is plain Win32: GetCursorPos + SetCursorPos
        // recentering once per frame, buttons from window messages.
        constexpr std::uintptr_t IN_Init                    = 0x5FA820; // [V] registers `in_mouse` then tail-jmps IN_StartupMouse
        constexpr std::uintptr_t IN_StartupMouse            = 0x5FA7D0; // [V] prints "Mouse control not active." when in_mouse==0
        constexpr std::uintptr_t IN_DeactivateMouse         = 0x5FA5B0; // [V] ShowCursor loop
        constexpr std::uintptr_t IN_MouseEvent              = 0x5FA5F0; // [V] button bitmask differ -> Sys_QueEvent(K_MOUSE1+i = 0xC8+i). ONE caller: 0x607124, inside the game WndProc. CORRECTED 2026-09-23: the old note said the caller was 0x606B60 -- that is only where t4map.py puts the function START; 0x606B60 itself is the VK->engine-key mapper.
        constexpr std::uintptr_t IN_Frame                   = 0x5FA850; // [V] "ClickToContinue", focus check, calls IN_MouseMove
        constexpr std::uintptr_t IN_MouseMove               = 0x5FA6D0; // [V] void(void); GetCursorPos -> delta -> ScreenToClient -> CL_MouseEvent -> recenter
        constexpr std::uintptr_t IN_MouseMove_callsite      = 0x5FA8E4; // [V] the ONE `call IN_MouseMove`, inside IN_Frame
        constexpr std::uintptr_t IN_RecenterMouse           = 0x5FA510; // [V] void(void); GetWindowRect -> SetCursorPos(centre); stores centre at 0x229A0C0/0x229A0BC
        constexpr std::uintptr_t IN_ClampCursorToWindow     = 0x5FA660; // [V] esi = POINT*; clamps into the window rect via SetCursorPos
        // CL_MouseEvent: returns 1 = "in-game, please recentre", 0 = "free cursor".
        //   edx = client x, ecx = client y, [esp+4] = dx, [esp+8] = dy, CALLER cleans 8.
        //   Register args are NOT expressible in a C prototype -- use a naked thunk.
        constexpr std::uintptr_t CL_MouseEvent              = 0x63D9A0; // [V] sole caller IN_MouseMove; accumulates dx/dy into 0x307D650/0x307D658
        // CORRECTED 2026-09-22, and the correction is kept because the first value
        // LOOKED right: 0x606B60 calls IN_MouseEvent, IN_RecenterMouse and
        // DefWindowProcA, so it reads exactly like a WndProc. It is not one -- it is a
        // message HELPER the real proc calls. The class registration settles it:
        //   005FF47A  mov [esp+0x10], 0x606BE0   ; WNDCLASSEX.lpfnWndProc (cbSize @ +8)
        //   005FF4B1  mov [esp+0x2C], 0x883150   ; lpszClassName = "CoD-WaW"
        //   005FF4B9  call [RegisterClassExA]
        // and 0x606BE0 has the proc shape: hwnd@[ebp+8], msg@[ebp+0xC], wParam@[ebp+0x10],
        // lParam@[ebp+0x14]. Two independent signals, as the map's rule 2 requires.
        constexpr std::uintptr_t WndProc_game               = 0x606BE0; // [V] lpfnWndProc of the "CoD-WaW" class
        constexpr std::uintptr_t WndProc_game_msg_helper    = 0x606B60; // [V] NOT the proc, and CORRECTED 2026-09-23: it does not route mouse buttons either. It is the KEYBOARD mapper -- VK/scancode -> engine key, with the extended-key table at 0x8D1640 and MapVirtualKeyA. Mouse buttons go through 0x6070F7.
        constexpr std::uintptr_t Sys_RegisterGameWindowClass= 0x5FF450; // [V] RegisterClassExA("CoD-WaW"); Com_Error EXE_ERR_COULDNT_REGISTER_WINDOW on failure
        constexpr std::uintptr_t WndProc_winconsole         = 0x605210; // [V] proc of the "Call of Duty WinConsole" class; only handles WM 5..0x14
        constexpr std::uintptr_t Sys_CreateConsoleWindow    = 0x605500; // [V] RegisterClassA + CreateWindowExA for "Call of Duty WinConsole" -- NOT the game window
        constexpr std::uintptr_t Sys_QueEvent               = 0x5FEB30; // [V] 256-entry ring (mask 0xFF, stride 0x18); overflow prints "Sys_QueEvent: overflow"
        constexpr std::uintptr_t Sys_GetEvent               = 0x5FEC60; // [V] drains the ring; when empty pumps PeekMessageA/GetMessageA/TranslateMessage/DispatchMessageA until the queue is empty
        constexpr std::uintptr_t Com_EventLoop              = 0x5FEDE0; // [C] calls Sys_GetEvent until evType == 0

        // ---- dvars ----------------------------------------------------------------
        constexpr std::uintptr_t Dvar_FindVar               = 0x5EDE30; // [V] interlocked refcount + hash lookup
        constexpr std::uintptr_t Dvar_RegisterBool          = 0x5EEE20; // [H]
        constexpr std::uintptr_t Com_InitDvars              = 0x59C8B0; // [C] registers com_maxfps, developer_script, dedicated
        constexpr std::uintptr_t Dvar_RegisterEnum          = 0x5EF150; // [V] used to register `dedicated` (0=listen,1=LAN,2=internet)
        // CORRECTED: this is a NON-dedicated (client) per-frame call. WinMain's branch
        // (0x5FF7C7/0x5FF7CB) *skips* it when com_dedicated != 0. Not a dedicated console pump.
        constexpr std::uintptr_t CL_FramePump_nonDedicated  = 0x69DAA0; // [V] runs only when com_dedicated == 0

        // ---- fatal error path (why a headless server appears to hang) ---------------
        // Com_Error is declared above (0x59AC50): cdecl void(errorParm_t code, const char* fmt,
        // ...). 515 callers; calls Sys_Error. Hook args: code=[esp+4], fmt=[esp+8],
        // first vararg=[esp+0xC], REAL error site = return address at [esp].
        constexpr std::uintptr_t Sys_Error_park             = 0x5FE8C0; // [V] void(const char* fmt, ...); parks the main thread in a
        // terminal TranslateMessage/DispatchMessageA/GetMessageA loop at 0x5FE960..0x5FE97D
        // (0x5FE97B = the `test eax,eax` after GetMessageA). Exits only on WM_QUIT -> _exit(0)
        // at 0x7AC431 — which is why a WM_NULL nudge does nothing.

        // ---- commands -------------------------------------------------------------
        // 0x594DB0 is the name-keyed command routine: 190 (name, funcptr) registration
        // sites AND the console-dispatch lookups both call it. T4SP labels it
        // Cmd_FindCommand; on our build it also serves as the registrar entry.
        constexpr std::uintptr_t Cmd_FindCommand            = 0x594DB0; // [V]
        constexpr std::uintptr_t SV_AddOperatorCommands     = 0x62C9B0; // [C] registers killserver/clientkick/loadgame/map...

        // ---- script VM (referee needs these) --------------------------------------
        constexpr std::uintptr_t Scr_GetMethod_detour       = 0x683043; // [V] call site (detour target is 0x530630)
        constexpr std::uintptr_t Scr_GetFunction_jump       = 0x682D99; // [V] call site (target 0x5676F0 Sentient_GetFunction)
        constexpr std::uintptr_t Scr_GetMethod              = 0x530630; // [V] T4SP Scr_GetMethod
        constexpr std::uintptr_t Sentient_GetFunction       = 0x5676F0; // [H]
        constexpr std::uintptr_t G_ClientDoPerFrameNotifies = 0x503540; // [V] per-client per-frame notify pump
        constexpr std::uintptr_t VM_waittill_endon_parse    = 0x696E6D; // [C] "first parameter of waittill/endon..."

        // ---- server: connection / message path ------------------------------------
        constexpr std::uintptr_t SV_ConnectionlessPacket    = 0x634E90; // [V] OOB dispatcher (getstatus/getinfo/getchallenge/connect/stats/disconnect)
        constexpr std::uintptr_t SV_PacketEvent             = 0x635540; // [V] top-level packet handler; tail-jumps to SV_ExecuteClientMessage
        constexpr std::uintptr_t SV_DirectConnect           = 0x62E3A0; // [V] "protocol"/"challenge"/"qport"/"password"/"connectResponse %s"
        constexpr std::uintptr_t SVC_GetChallenge           = 0x62DB60; // [V] emits "challengeResponse %i %s"
        constexpr std::uintptr_t SV_ExecuteClientMessage    = 0x630F70; // [V] reached by tail-jmp from SV_PacketEvent; runs the decompress
        constexpr std::uintptr_t SV_SpawnServer             = 0x62B3E0; // [C] devmap/'thereisacow'/.svg; loads maps/%s.d3dbsp
        constexpr std::uintptr_t SV_LoadMapBsp              = 0x62B260; // [V] sole ref to "maps/%s.d3dbsp"
        constexpr std::uintptr_t SV_Map_f                   = 0x62C530; // [C] map command handler; calls SV_SpawnServer
        constexpr std::uintptr_t MSG_ReadBitsCompress       = 0x6751D0; // [V] Huffman/method dispatch decode; SEE security-audit.md
        constexpr std::uintptr_t MSG_ReadBitsCompress_sym   = 0x5A2970; // [V] per-symbol Huffman bit reader (inner loop)
        constexpr std::uintptr_t CL_ParseServerMessage      = 0x64D1A0; // [V] client counterpart; bounds compressed size to 0x20000

        // ---- chat / server commands ------------------------------------------------
        // RETRACTED (was wrong): 0x473F10 is NOT G_Say and 0x4388A0 is NOT ClientCommand —
        // both were single-string guesses off the shared "%s: " formatter. 0x473F10 is a
        // per-frame HUD/notify formatter (fires ~60 Hz idle with empty text), called only by
        // 0x4388A0 which is itself on the frame path. T4 co-op chat is the party/lobby
        // reliable-command system (`clientchat`/`hostchat`), not classic say->G_Say.
        // RETRACTED: 0x648490 / 0x6F5F10 are NOT server-command functions — they are a
        // HUD/debug COLOURED-TEXT pair (0x648490 resolves an RGBA via 0x47A450 and passes four
        // floats; 0x6F5F10 strlen's text into a debug ring buffer at 0x3DCB4C0). Calling them
        // as a chat sender corrupts that buffer. Do not use.
        constexpr std::uintptr_t HudDebugText_colour        = 0x648490; // [V] NOT a server command
        constexpr std::uintptr_t HudDebugText_append        = 0x6F5F10; // [V] NOT a server command
        // The real pair, verified from instructions:
        //   SV_GameSendServerCommand(clientNum @ [esp+4]; edx = text; ecx = svscmd type)
        //   clientNum == -1 is a genuine broadcast (explicit first branch).
        //   Validates 0 <= clientNum < sv_maxclients ([0x23D5C30]->current.integer) and indexes
        //   svs.clients[clientNum] = 0x2547090 + clientNum*0x58D30. Forwards to 0x633FA0 with
        //   the client pointer in EAX (0 for broadcast).
        //   UNSAFE before dvars/server are up; call at a frame boundary on the main thread.
        //   Stack cleanup NOT verified — use a naked thunk, not a typed prototype.
        // ---- the userinfo / name path (re, 2026-09-23, for the referee's name lock) ---
        //
        // The chain, proven end to end: a client's `userinfo` command is dispatched off
        // ucmds[] at 0x8D0348 (the `userinfo` slot is 0x8D034C) by SV_ExecuteClientCommand
        // 0x6308F0, which walks the table in 8-byte strides and calls entry->fn(client).
        //
        // NOTE, and it matters: the map's older `SV_ExecuteClientCommand = 0x4621E0 [C]`
        // is NOT this function. 0x6308F0 is the one that dispatches ucmds[], proven by the
        // table walk. The [C] guess is withdrawn.
        constexpr std::uintptr_t ucmds                      = 0x8D0348; // [V] {const char* name; void(*fn)(client_s*);}[], NUL-terminated 0x8D03A0
        constexpr std::uintptr_t SV_ExecuteClientCommand2    = 0x6308F0; // [V] walks ucmds[]; replaces the withdrawn 0x4621E0 [C]
        // void __cdecl(client_s*). I_strncpyz(cl+0x6F0, Cmd_Argv(1), 0x5FF), then
        // SV_UserinfoChanged, then a TAIL-JMP into ClientUserinfoChanged(clientNum).
        // The single writer of cl->userinfo on the client path, and the hook point for
        // the name lock — it fires only on a real userinfo command, never per frame.
        constexpr std::uintptr_t SV_UpdateUserinfo_f        = 0x6307E0; // [V] ucmds["userinfo"]
        // **REGISTER ARGS — client_s* in ESI, never loaded from the stack.** Do NOT give
        // this a typed prototype (map rule 4). Listed because it is the function that
        // derives cl->name (+0x11548) from the infostring; we reach it only through the
        // engine's own chain. Callers: SV_DirectConnect 0x62F047 and SV_UpdateUserinfo_f.
        constexpr std::uintptr_t SV_UserinfoChanged         = 0x630650; // [V] __usercall(ESI = client_s*)
        // void __cdecl(int clientNum). Re-reads svs.clients[i].userinfo, cleans the name,
        // and writes the clientinfo/scoreboard record at clientinfo + i*0x594 + 0xC.
        constexpr std::uintptr_t ClientUserinfoChanged      = 0x67BCF0; // [V]
        // **REGISTER ARGS — ECX = src, EDX = dst, no stack args.** Sole ref to
        // "UnnamedPlayer". Not called by us; here so nobody prototypes it as cdecl.
        constexpr std::uintptr_t ClientCleanName            = 0x67BC70; // [V] __usercall

        // The Info_* infostring helpers, each proven by its own error string (note: every
        // Com_Error/Com_Printf literal in this build is 0x15-prefixed and pushed as VA-1,
        // which is why `t4map.py sxref` finds nothing for them).
        //
        // Info_SetValueForKey is plain __cdecl(char* s, const char* key, const char* value),
        // proven from the frame arithmetic, and SILENTLY STRIPS '\\', ';' and '"' from the
        // value rather than erroring — which is what makes it safe to hand it a name.
        constexpr std::uintptr_t Info_SetValueForKey        = 0x5F71F0; // [V] cdecl(s, key, value); MAX_INFO_STRING 0x600
        constexpr std::uintptr_t Info_SetValueForKey_Big    = 0x5F73E0; // [V]
        constexpr std::uintptr_t Info_RemoveKey             = 0x5F6FA0; // [V]
        constexpr std::uintptr_t Info_RemoveKey_Big         = 0x5F70B0; // [V]
        // **REGISTER ARG — infostring in ECX, key at [esp+4]; returns a ROTATING static
        // buffer, so copy the result out immediately.** Not prototyped as __thiscall.
        constexpr std::uintptr_t Info_ValueForKey           = 0x5F6DF0; // [V] __usercall(ECX = info, [esp+4] = key)
        constexpr std::uintptr_t I_strncpyz                 = 0x7AA9C0; // [V] cdecl(dst, src, size)

        constexpr std::uintptr_t SV_GameSendServerCommand   = 0x5A9350; // [V]
        constexpr std::uintptr_t SV_SendServerCommand       = 0x633FA0; // [V] client ptr in EAX
        constexpr std::uintptr_t clientchat_send            = 0x655C80; // [V] sends "0clientchat %s" (client->server chat transport)
        constexpr std::uintptr_t hostchat_send              = 0x65B630; // [V] sends "0hostchat %s %s"

        // ---- connect / licence (foundation) ----------------------------------------
        constexpr std::uintptr_t CL_SendConnectPacket       = 0x642C80; // [V] builds `connect` infostring (protocol/challenge/qport/bdTicket/invited); calls Demonware getAuthTicket
        constexpr std::uintptr_t DW_GetAuthTicket           = 0x57C0E0; // [V] Demonware auth; failure -> Com_Error "PATCH_SERVER_AUTHFAIL". Skipped for NA_LOOPBACK/NA_BOT. Short-circuit for own-client remote connect.
        constexpr std::uintptr_t CL_SetUserInfo             = 0x644B20; // [V] resends userinfo when dvar_modifiedFlags & USERINFO(0x2)
        constexpr std::uintptr_t set_cmd_dispatch           = 0x5A00E0; // [V] handles set/setu/sets/seta console commands
        constexpr std::uintptr_t dvar_modifiedFlags         = 0x21ACF30;// [V] byte/word OR'd with a changed dvar's flags; USERINFO bit (0x2) gates userinfo resend
        constexpr std::uintptr_t serverLicenseId            = 0x3051608;// [V] 64-bit; parsed from challengeResponse, echoed in connect. Client does NOT validate the id.

        // ---- script VM (referee: rounds, EE flags, score, knobs) -------------------
        constexpr std::uintptr_t Scr_NotifyNum          = 0x698CC0; // [V] every notify funnels here. EAX=scriptInstance(0=server); stack: entnum, classnum, stringValue(notify-name strId), paramcount. 98 callers.
        constexpr std::uintptr_t VM_Notify              = 0x698670; // [V] deepest chokepoint (2 callers). EAX=scriptInstance; stack: notifyListOwnerId, stringValue, top. `level notify(x)`: ownerId==gScrVarPub[0].levelId. BEST notify hook.
        constexpr std::uintptr_t GetVariableValueAddress= 0x690040; // [V] EAX=varId, ECX=scriptInstance -> ptr into variable entry
        constexpr std::uintptr_t SetSavedDvar_builtin   = 0x516990; // [V] GSC builtin; flag test `test word[dvar+8],0x1000` at 0x516B15
        // FindVariable(parentId, nameStrId): NOT address-confirmed. Candidates 0x699640 /
        // 0x699560 (likely Scr_GetObjectField-family) — validate vs level.round_number before
        // binding. Or sibling-walk the child list (entry 0x10; name in w-bitfield @+0x8).

        // ---- renderer / sound / OS gates (dedi needs to stub) ----------------------
        constexpr std::uintptr_t D3D9_CreateDevice_wrap     = 0x75A9A8; // [V] wraps Direct3DCreate9 (IAT 0x7EB46C)
        constexpr std::uintptr_t Sys_ImproperQuitDialog     = 0x5FF320; // [V] "run in safe mode" MessageBox (WIN_IMPROPER_QUIT_*)
        constexpr std::uintptr_t Sys_WriteQuitMarker        = 0x5FF1A0; // [C] creates the __CoDWaW marker
        constexpr std::uintptr_t Sys_DirectXInitFailBox     = 0x5FE690; // [V] WIN_DIRECTX_INIT_* MessageBox
        constexpr std::uintptr_t Sys_OutOfMemBox            = 0x5FE760; // [V] WIN_OUT_OF_MEM_*
        constexpr std::uintptr_t g_mem_init                 = 0x5F5480; // [V] main heap reserve (see mem sites below)
    }

    // ---- globals ------------------------------------------------------------------------
    namespace var
    {
        constexpr std::uintptr_t svs                = 0x23D5C80; // [V] serverStatic_s
        constexpr std::uintptr_t g_entities         = 0x176C6F0; // [V] 494 refs, base of the entity array
        constexpr std::uintptr_t level              = 0x18F5D88; // [V] level_locals_t (dense refs at +0,+4,+C,+18,+1C)
        constexpr std::uintptr_t com_dedicated      = 0x212B2F4; // [V] dvar_s* (read in WinMain loop & many SV funcs)
        constexpr std::uintptr_t cmd_functions      = 0x1F416F4; // [H] head of the command list
        constexpr std::uintptr_t fs_game            = 0x2122B00; // [H] dvar_s*
        constexpr std::uintptr_t msg_decompress_pool= 0x212B2F8; // [V] SV_ExecuteClientMessage decode dst pool (0x20000-window ring)
        constexpr std::uintptr_t cl_decompress_buf  = 0x4E337C0; // [V] CL_ParseServerMessage decode dst, exactly 0x20000 bytes

        // ---- win32 input / mouse globals (client lane, all [V]) ---------------------
        constexpr std::uintptr_t g_wv_hwnd          = 0x22C1BE4; // [V] the game HWND (compared with GetForegroundWindow in IN_Frame/IN_MouseMove)
        constexpr std::uintptr_t g_wv_sysMsgTime    = 0x22C1BF8; // [V] written from MSG.time in the pump at 0x5FED22
        constexpr std::uintptr_t in_mouse_dvar      = 0x229A0B8; // [V] dvar_s* for `in_mouse`
        constexpr std::uintptr_t s_wmv_mouseActive  = 0x229A0D4; // [V] byte
        constexpr std::uintptr_t s_wmv_mouseInited  = 0x229A0D5; // [V] byte, set by IN_StartupMouse
        constexpr std::uintptr_t s_wmv_oldPos_x     = 0x229A0CC; // [V] last GetCursorPos x
        constexpr std::uintptr_t s_wmv_oldPos_y     = 0x229A0D0; // [V] last GetCursorPos y
        constexpr std::uintptr_t s_wmv_centre_x     = 0x229A0C0; // [V] window centre x, written by IN_RecenterMouse
        constexpr std::uintptr_t s_wmv_centre_y     = 0x229A0BC; // [V] window centre y, written by IN_RecenterMouse

        // ---- the button path, read instruction by instruction 2026-09-23 ------------
        // THE ONE FACT THAT DECIDES THE WHOLE DESIGN OF THE MOUSE FIX:
        // the game WndProc's SECOND dispatch (0x60704E) is
        //     lea eax,[edi-0x200]; cmp eax,0x18; ja default
        //     movzx ecx,[eax+0x607204]; jmp [ecx*4+0x6071F4]
        // and that table sends WM_MOUSEMOVE (0x200) and EVERY WM_?BUTTON?DOWN/UP
        // (0x201,0x202,0x204,0x205,0x207,0x208,0x20B,0x20C) to the SAME handler,
        // 0x6070F7, which does nothing but translate wParam's MK_ bits:
        //     MK_LBUTTON->1  MK_RBUTTON->2  MK_MBUTTON->4  MK_XBUTTON1->8  MK_XBUTTON2->0x10
        // and call IN_MouseEvent with that byte and nothing else.
        // The DBLCLK messages and WM_MOUSEHWHEEL go to the default case; WM_MOUSEWHEEL
        // (0x20A) has its own handler at 0x60706B.
        //
        // So THE ENGINE NEVER LOOKS AT THE MESSAGE ID. A mouse button edge exists for
        // T4 if and only if the MK_ mask of some mouse message differs from the mask of
        // the previous one. Two consequences we rely on:
        //   * a duplicated WM_LBUTTONDOWN cannot double a click (same mask, no edge);
        //   * a WM_MOUSEMOVE carrying a stale or premature mask CAN invent or destroy
        //     one, because it is the same input to the same differ.
        constexpr std::uintptr_t WndProc_mouse_case = 0x6070F7; // [V] wParam MK_ mask -> IN_MouseEvent, shared by MOUSEMOVE and all buttons
        constexpr std::uintptr_t s_wmv_oldButtonState= 0x229A0C8; // [V] the differ's memory. Written ONLY at 0x5FA648, inside IN_MouseEvent. Nothing else in the image clears it.
        constexpr std::uintptr_t g_wv_activeApp     = 0x229A0C4; // [V] IN_Frame 0x5FA8A0: if zero it tail-jmps IN_DeactivateMouse and IN_MouseMove IS NEVER CALLED. Written only by the WM_ACTIVATE handler 0x606AA0 and by WM_MOVE at 0x606E18.
        constexpr std::uintptr_t g_wv_recenterMouse = 0x22C1BF4; // [V] stock IN_MouseMove stores CL_MouseEvent's return here (0x5FA755). DEAD STORE -- xref says nothing in the image reads it, so our replacement not writing it costs nothing. Checked, because it looked like a bug.

        // ---- the engine event ring (Sys_QueEvent 0x5FEB30), read-only ---------------
        // Read instruction by instruction so the input trace can count what the engine
        // ACTUALLY queued without hooking anything (kickstart rule 9: hooks are owned).
        //   index  = head & 0xFF                      (0x5FEB4D)
        //   slot   = 0x22BBF48 + (index * 0x18)       (0x5FEB58: lea esi,[eax+eax*2]; lea esi,[esi*8+base])
        //   overflow when head - tail >= 0x100        (0x5FEB52) -> "Sys_QueEvent: overflow"
        // Fields, from the stores at 0x5FEBCA..0x5FEBE5:
        //   +0x00 time   +0x04 type   +0x08 value   +0x0C value2   +0x10 ptrLength   +0x14 ptr
        // A mouse button is type 1 (SE_KEY), value = 0xC8 + n (K_MOUSE1..K_MOUSE5),
        // value2 = down. Queued from IN_MouseEvent's loop at 0x5FA638.
        constexpr std::uintptr_t sys_event_ring     = 0x22BBF48; // [V]
        constexpr std::uintptr_t sys_event_head     = 0x22BBA34; // [V] monotonic, never masked
        constexpr std::uintptr_t sys_event_tail     = 0x22BD9B0; // [V]
        constexpr std::uintptr_t sys_event_stride   = 0x18;      // [V]
        constexpr std::uintptr_t sys_event_count    = 0x100;     // [V]
        constexpr std::uintptr_t K_MOUSE1           = 0xC8;      // [V] IN_MouseEvent: lea eax,[esi+0xC8]

        // ---- script VM globals (referee) --------------------------------------------
        // Arrays indexed by scriptInstance (0=server, 1=client).
        constexpr std::uintptr_t gScrVarPub         = 0x3882BA8; // [V] scrVarPub_t[2], stride 0x18048
        constexpr std::uintptr_t gScrVarPub_stride  = 0x18048;
        constexpr std::uintptr_t levelId_server     = 0x3882BC8; // [V] gScrVarPub[0].levelId (+0x20) = the `level` script object id
        constexpr std::uintptr_t gScrVarGlob        = 0x3914700; // [V] scrVarGlob_t[2] (variableList), stride 0x160000; parentVars@+0, childVars@+0x60000
        constexpr std::uintptr_t gScrVarGlob_stride = 0x160000;
        constexpr std::uintptr_t gScrVmPub          = 0x3BD4700; // [V] scrVmPub_t[2], stride 0x4320; top@+0x10, inparamcount@+0x18, stack@+0x320
        constexpr std::uintptr_t gScrVmPub_stride   = 0x4320;
        constexpr std::uintptr_t mt_buffer_ptr      = 0x3702390; // [V] *(char**) — memory-tree base. SL_ConvertToString(id)= id? *(char**)0x3702390 + id*0xC + 4 : 0
    }

    // dvar_s flags are a 16-bit word at dvar_s + 0x8 (verified in SetSavedDvar).
    namespace dvar_flag
    {
        constexpr std::uint16_t SAVED    = 0x1000; // [V] SetSavedDvar test @0x516B15 (NOT the T4SP-enum 0x200)
        constexpr std::uint16_t USERINFO = 0x0002; // [V] userinfo-resend gate @0x644B64 on dvar_modifiedFlags(0x21ACF30)
        // Other bits NOT re-verified — do NOT trust T4SP's flag enum without an instruction check.
    }

    // ---- memory reserve patch sites (T4M-Enhanced facts; re-implement, don't copy) ------
    // At these sites the stock exe pushes/writes 0x12C00000 (300 MB). T4M-E rewrites them to
    // 0x19600000 (422 MB) to raise the main allocator so big custom maps load.
    namespace mem
    {
        constexpr std::uintptr_t reserve_site_1 = 0x5F5491; // [V] `push 0x12C00000` (arg to VirtualAlloc)
        constexpr std::uintptr_t reserve_site_2 = 0x5F54CB; // [V] `mov [0x224FAEC], 0x12C00000`
        constexpr std::uintptr_t reserve_site_3 = 0x5F54D5; // [V] `mov [0x224FBF0], 0x12C00000`
        constexpr std::uint32_t  stock_value    = 0x12C00000;
        constexpr std::uint32_t  t4me_value     = 0x19600000;
        // NOTE: vault note 11 lists 0x5F5492/0x5F54D1/0x5F54DB. Those land mid-instruction on
        // our dump; the true operand starts are the three above. See docs/re/t4-sp-map.md.
    }

    // ---- struct sizes / offsets (from T4SP AGPL headers, consistent with our dump) -------
    namespace off
    {
        constexpr std::size_t gentity_s_size        = 0x378;  // [H]
        constexpr std::size_t gentity_s_client      = 0x180;  // [H]
        constexpr std::size_t gentity_s_r           = 0x118;  // [H] entityShared_t
        constexpr std::size_t client_s_size         = 0x58D30;// [H]
        constexpr std::size_t client_s_userinfo     = 0x6F0;  // [H]
        constexpr std::size_t client_s_gentity      = 0x11544;// [H]
        constexpr std::size_t client_s_name         = 0x11548;// [H]
        constexpr std::size_t client_s_netchanIn    = 0x523F4;// [H] incoming netchan reassembly buffer
        constexpr std::size_t client_s_netchanOut   = 0x323F4;// [H]
        constexpr std::size_t usercmd_s_size        = 0x38;   // [H]
        constexpr std::size_t netadr_s_size         = 0x18;   // [H]
        constexpr std::size_t decompress_window     = 0x20000;// [V] both decode buffers are 0x20000
    }
}
