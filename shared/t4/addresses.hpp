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

        // ---- dvars ----------------------------------------------------------------
        constexpr std::uintptr_t Dvar_FindVar               = 0x5EDE30; // [V] interlocked refcount + hash lookup
        constexpr std::uintptr_t Dvar_RegisterBool          = 0x5EEE20; // [H]
        constexpr std::uintptr_t Com_InitDvars              = 0x59C8B0; // [C] registers com_maxfps, developer_script, dedicated
        constexpr std::uintptr_t Dvar_RegisterEnum          = 0x5EF150; // [V] used to register `dedicated` (0=listen,1=LAN,2=internet)
        constexpr std::uintptr_t Sys_DedicatedConsolePump   = 0x69DAA0; // [C] run each frame by WinMain when com_dedicated != 0

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

        // ---- chat ------------------------------------------------------------------
        constexpr std::uintptr_t G_Say                      = 0x473F10; // [C] EXE_SAY / EXE_SAYTEAM, "%s: " formatter
        constexpr std::uintptr_t ClientCommand              = 0x4388A0; // [C] dispatches "say"/"say_team" -> G_Say

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
