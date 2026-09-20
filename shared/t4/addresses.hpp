#pragma once
// ---------------------------------------------------------------------------------------
// ENW Zombies -- Call of Duty: World at War (T4) SP/co-op engine address map.
//
// Target: Steam CoDWaW.exe v1.7, 5,902,336 bytes,
//   SHA-256 732900D158982C33E3121F0B86D22230BE79839BBCBFE3BDFC1238F408A7D64D
//   Steam build 252004. ImageBase 0x400000, no ASLR (DllCharacteristics == 0), so these
//   are absolute VAs that hold every launch.
//
// EVERY constant below was re-verified against our own decrypted dump on 2026-09-20
// (dump codwaw-1.7-a.exe). Method and evidence: docs/re/t4-sp-map.md.
// Confidence: [V] verified on our dump, [H] from T4SP AGPL headers (offset asserts) and
// consistent with our dump, [C] candidate (structurally strong, name inferred).
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
