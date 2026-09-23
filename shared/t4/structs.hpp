#pragma once
// ---------------------------------------------------------------------------------------
// ENW Zombies -- T4 (CoD: World at War) engine structs we are confident about.
//
// PROVENANCE / LICENCE: the layouts below are DERIVED FROM JezuzLizard/T4SP-Server-Plugin,
//   header `src/game/structs.hpp` on branch `main`, which is licensed AGPL-3.0
//   (https://github.com/JezuzLizard/T4SP-Server-Plugin). We reproduce only the small subset
//   the server prototype needs, keeping the field names and offsets. Because this file is a
//   derivative of AGPL-3.0 source, it (and anything statically combined with it in the
//   network-facing server) is distributed under AGPL-3.0 -- consistent with the project
//   decision to open-source the server under AGPL (vault note 11 §3).
//
// Every offset was cross-checked against our own decrypted CoDWaW.exe v1.7 dump on
//   2026-09-20 (see docs/re/t4-sp-map.md); the ones we exercised directly (client_s.userinfo,
//   gentity_s size/client, the netchan buffers) match. Fields we did not need are omitted;
//   consult T4SP's full header for the rest.
//
// x86, 32-bit, MSVC packing. Do NOT reorder -- offsets are load-bearing.
// ---------------------------------------------------------------------------------------

#include <cstdint>
#include <cstddef>

namespace t4
{
    // netadrtype_t (T4SP enums.hpp)
    enum netadrtype_t : std::int32_t
    {
        NA_BOT = 0,
        NA_BAD = 1,
        NA_LOOPBACK = 2,
        NA_BROADCAST = 3,
        NA_IP = 4,
    };

    // netadr_s -- T4SP structs.hpp, size 0x18
    struct netadr_s
    {
        netadrtype_t type;          // 0x0
        std::uint8_t ip[4];         // 0x4 (union netadr_s_ip)
        std::uint16_t port;         // 0x8
        std::uint8_t netnum[4];     // 0xA
        std::uint8_t nodenum[6];    // 0xE
        std::uint32_t routerHandle; // 0x14
    };
    static_assert(sizeof(netadr_s) == 0x18, "netadr_s");

    // usercmd_s -- T4SP structs.hpp, size 0x38. The per-client movement command; the
    // referee AFK detector and any input injection touch serverTime/buttons/angles/moves.
    struct usercmd_s
    {
        std::int32_t serverTime;    // 0x0
        std::uint32_t buttons;      // 0x4 (button_mask)
        std::int32_t angles[3];     // 0x8
        std::int8_t weapon;         // 0x14
        std::int8_t offHandIndex;   // 0x15
        std::int8_t forward;        // 0x16
        std::int8_t right;          // 0x17
        std::int8_t upmove;         // 0x18
        std::int8_t pitchmove;      // 0x19
        std::int8_t yawmove;        // 0x1A
        std::uint8_t _pad1B;        // 0x1B
        std::int16_t wiimoteGunPitch; // 0x1C
        std::int16_t wiimoteGunYaw;   // 0x1E
        std::int16_t gunXOfs;       // 0x20
        std::int16_t gunYOfs;       // 0x22
        std::int16_t gunZOfs;       // 0x24
        std::uint8_t _pad26[2];     // 0x26
        std::int32_t meleeChargeYaw;// 0x28
        std::int8_t meleeChargeDist;// 0x2C
        std::uint8_t _pad2D[3];     // 0x2D
        std::int32_t rollmove;      // 0x30
        std::int8_t selectedLocation[2]; // 0x34
        std::int16_t weapon_buddy;  // 0x36
    };
    static_assert(sizeof(usercmd_s) == 0x38, "usercmd_s");

    // -- Offsets into the large structs (client_s = 0x58D30, gentity_s = 0x378,
    //    serverStatic_s = 0xBD7880). We keep these as named offsets rather than full structs
    //    because only a handful of fields are needed and the full types are huge. Reach into
    //    svs / g_entities / a client_s with these. All from T4SP asserts, matched on our dump.
    namespace client_off
    {
        // [V] as of 2026-09-23 (was [H]): re confirmed it from a SECOND function —
        // ClientUserinfoChanged 0x67BD30 computes `0x2547780 + i*0x58D30`, and
        // 0x2547780 == 0x2547090 + 0x6F0, which re-derives both the clients base and
        // this offset independently of SV_UserinfoChanged's `lea ebp,[esi+0x6F0]`.
        constexpr std::size_t userinfo          = 0x6F0;   // [V] char userinfo[0x600]
        constexpr std::size_t gentity           = 0x11544; // gentity_s*
        constexpr std::size_t name              = 0x11548; // char name[]
        constexpr std::size_t netchanOutBuffer  = 0x323F4;
        constexpr std::size_t netchanInBuffer   = 0x523F4; // incoming reassembly (0x20000)
        constexpr std::size_t stride            = 0x58D30; // sizeof(client_s); svs.clients[i]
    }
    namespace gentity_off
    {
        constexpr std::size_t s             = 0x0;   // entityState_s
        constexpr std::size_t r             = 0x118; // entityShared_t
        constexpr std::size_t client        = 0x180; // gclient_s*
        constexpr std::size_t currentOrigin = 0x160; // float[3]; = r(0x118)+entityShared.currentOrigin(0x48)
        constexpr std::size_t takedamage    = 0x19B; // byte
        constexpr std::size_t classname     = 0x1A0; // uint16 script-string id -> SL_ConvertToString
        constexpr std::size_t targetname    = 0x1A8; // uint16 script-string id
        constexpr std::size_t health        = 0x1C8; // int
        constexpr std::size_t stride        = 0x378; // sizeof(gentity_s); g_entities[i]
    }
    namespace client_extra_off
    {
        constexpr std::size_t lastUsercmd = 0x11108; // usercmd_s (0x38)
        constexpr std::size_t ping        = 0x323E4;
        // [V] 2026-09-23 (S2): read by SV_SendClientGameState 0x62F5A7 and SV_AddServerCommand
        // 0x633D35; written by nothing in the image (SV_AddTestClient is compiled out) --
        // server/components/dedicated/bots.cpp sets it for its soak bots.
        constexpr std::size_t bIsTestClient = 0x52BFC;
    }
    namespace svs_off
    {
        // serverStatic_s (base = t4::var::svs). Player cap is 4; clients[] is a flat array.
        constexpr std::size_t initialized = 0x171400;
        constexpr std::size_t time        = 0x171404;
        constexpr std::size_t clients      = 0x171410; // client_s clients[MAX_CLIENTS]
        constexpr std::size_t challenges   = 0x8F9164;
    }
}
