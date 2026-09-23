// The two sound dvars a headless server never registers, and the script builtins that read
// them. Pure: no engine, no Windows. snd_alias_dvars.cpp applies it; server/tests/
// snd_alias_dvars_test.cpp checks it (and, when the decrypted dump is on the machine, checks
// every address below against the image).
//
// dedi.md §25. The freeze of §23 (B's fear_mc_2, twice on 2026-09-23) starts here:
//
//   zombie killed -> giveRankXP -> _challenges_coop::updateRankAnnounceHUD
//     notifyData.sound = "mp_level_up"           (a multiplayer alias; SP zones do not have it)
//   -> _hud_message::showNotifyMessage -> self playLocalSound(notifyData.sound)
//   -> PlayerCmd_playLocalSound 0x4F04E0:
//        if (!Com_FindSoundAlias(name) && snd_errorOnMissing->current.enabled) Scr_Error(...)
//                                             ^ [0x3BE65DC], registered ONLY by SND_Init
//   -> SND_Init (0x6B47C0) never runs on a dedicated server, so the pointer is NULL
//   -> 0x4F057E `cmp byte [eax+0x10], 0` reads 0x00000010: access violation
//   -> the engine's abortframe swallows it mid-builtin, the script VM is left with five
//      frames on its stack, and the next resume overruns localVars (§23.2)
//
// A retail client has the dvar (default 0) and silently plays nothing. So the fix is the
// client's own state: register both dvars with the engine's own Dvar_RegisterBool, the same
// name, description, flags and default SND_Init uses. Nothing else in SND_Init is needed:
// it also brings up the sound driver, which a server must not do.
#pragma once

#include <cstddef>
#include <cstdint>

namespace enw::snd_alias_dvars {

constexpr uintptr_t kDvarRegisterBool = 0x5EEE20;  // al = default, edi = name, push desc, push flags
constexpr uintptr_t kFindSoundAlias   = 0x5E5670;  // cdecl const void* (const char* name); cached lookup
constexpr uintptr_t kSndInit          = 0x6B47C0;

struct dvar_slot {
    uintptr_t slot;       // the global dvar_s* SND_Init stores to
    uintptr_t name;       // the engine's own name string (we pass this pointer, not a copy)
    const char* name_text;
    uintptr_t desc;
    const char* desc_text;
    uintptr_t name_insn;  // the registrar's `mov edi, <name>` for this dvar (BF + imm32)
    uintptr_t store_insn; // the registrar's `mov [<slot>], eax` (A3 + imm32)
    uint32_t flags;       // the registrar's own flags (pushed before the name)
    uint8_t engine_default;  // the registrar's `xor al,al` (0) or `mov al,1` (1)
    uint8_t value;        // what WE register: the engine default, except where noted
    const char* registrar;   // the client-only init that never runs on a dedicated server
};

// Lane INT (2026-09-23 evening, dedi.md §26) added the last two after a static scan of every
// Dvar_Register* call site whose registrar a dedicated server never reaches, against every
// unguarded reader reachable from G_RunFrame / the script builtins:
//   r_watersim_debug  read at 0x4E58AE in 0x4E5810 (bullet impact, surface type 0x14 = water)
//                     on the G_RunFrame path -> a bullet that hits water would fault;
//                     registered only by the water-sim registrar 0x6F0D90 <- R_Init.
//   fx_enable         read first thing in 0x4AD6B0 / 0x4AD700 / 0x4B2E20 (effect spawn; reached
//                     from G_RunFrame and physics); registered only by FX init 0x4A4D10 <- CG_Init.
//                     Registered at 0, NOT the client's 1: every reader then returns early
//                     ("effects off"), which is right for a server with no FX system.
constexpr dvar_slot kSlots[] = {
    {0x3BE65DC, 0x89C3C0, "snd_errorOnMissing", 0x89C390,
     "Cause a Com_Error if a sound file is missing.", 0x6B487D, 0x6B4887, 0, 0, 0, "SND_Init"},
    {0x3BE65D8, 0x89C3F0, "snd_reportSndAliasErrors", 0x89C3D4,
     "show missing alias errors.", 0x6B4894, 0x6B48C7, 0, 0, 0, "SND_Init"},
    {0x3BFDEBC, 0x8A00AC, "r_watersim_debug", 0x8A008C,
     "Enables bullet debug markers", 0x6F0DD4, 0x6F0DDE, 0x4408, 0, 0, "R_Init's water-sim registrar"},
    {0x16A2060, 0x853CD8, "fx_enable", 0x853CB8,
     "Toggles all effects processing", 0x4A4D1D, 0x4A4D27, 0x80, 1, 0, "CG_Init's FX registrar"},
};
constexpr size_t kSlotCount = sizeof kSlots / sizeof kSlots[0];

// Every instruction outside the sound system that loads one of those slots, and what it is
// in. All of them sit right after a failed Com_FindSoundAlias and dereference +0x10.
struct reader {
    uintptr_t load;       // `mov reg, [slot]`
    uintptr_t slot;
    const char* where;
};
constexpr reader kReaders[] = {
    {0x4F0579, 0x3BE65DC, "playLocalSound (0x4F04E0) -- the §23/§25 fault, eip 0x4F057E"},
    {0x51BC5A, 0x3BE65DC, "playSound / playSoundAsMaster (0x51BBF0)"},
    {0x51BE61, 0x3BE65DC, "playLoopSound (0x51BDF0)"},
    {0x51C0E9, 0x3BE65DC, "stopSounds (0x51C020)"},
    {0x5227A0, 0x3BE65DC, "musicPlay (0x522710)"},
    {0x5233F8, 0x3BE65DC, "ambientPlay (0x523320)"},
    {0x5E5C20, 0x3BE65DC, "sound alias lookup 0x5E59B0 (found by lane L1)"},
    {0x66C29F, 0x3BE65DC, "playLoopSound, the other table (0x66C230)"},
    {0x5C5289, 0x3BE65D8, "0x5C5180 (12 callers)"},
    {0x63B56D, 0x3BE65D8, "alias index helper 0x63B560 (G_* callers)"},
    {0x64EC2D, 0x3BE65D8, "0x64EBF0: 'mp_player_join'"},
    {0x64ECCD, 0x3BE65D8, "0x64EC90"},
    // lane INT, dedi.md §26 (not sound: no alias involved, the dvar is read on its own)
    {0x4E58AE, 0x3BFDEBC, "bullet impact 0x4E5810, water surface (G_RunFrame path)"},
    {0x4AD6B0, 0x16A2060, "effect spawn 0x4AD6B0 (G_RunFrame / physics path)"},
    {0x4AD701, 0x16A2060, "effect 0x4AD700"},
    {0x4B2E21, 0x16A2060, "effect 0x4B2E20"},
};
constexpr size_t kReaderCount = sizeof kReaders / sizeof kReaders[0];

// The faulting instruction of each reader above, IN THE SAME ORDER (the `cmp byte [reg+0x10]`
// right after the load), as the freeze watchdog logs it: `escape fault #1 ... eip=<this>
// reading 00000010`. B's three 14:00-14:27 UTC freezes (lorkeep, ils, ut_box_map) were
// 0x51BC60 = playSound; the fear_mc_2 ones 0x4F057E. Mirrored in
// web/server/lib/telemetry/rules.js KNOWN_FAULTS.
constexpr uint32_t kReaderFaultEips[] = {
    0x4F057E, 0x51BC60, 0x51BE67, 0x51C0EF, 0x5227A5, 0x5233FE, 0x5E5C26, 0x66C2A5,
    0x5C528F, 0x63B572, 0x64EC32, 0x64ECD2,
    0x4E58B4, 0x4AD6B5, 0x4AD706, 0x4B2E26,
};

// A name for an escape-fault eip we have identified (crash review, lane L1), for the freeze
// watchdog's log line. nullptr when unknown.
inline const char* known_fault_name(uint32_t eip) {
    for (size_t i = 0; i < sizeof kReaderFaultEips / sizeof kReaderFaultEips[0]; ++i) {
        if (eip != kReaderFaultEips[i]) continue;
        switch (kReaders[i].slot) {
        case 0x3BFDEBC:
            return "a NULL r_watersim_debug on a dedicated server: a bullet hit water (dedi.md §26; "
                   "fixed by dedi_snd_alias_dvars -- if this DLL logged `registered`, it is NEW)";
        case 0x16A2060:
            return "a NULL fx_enable on a dedicated server: effect code ran with no FX system "
                   "(dedi.md §26; fixed by dedi_snd_alias_dvars -- if this DLL logged "
                   "`registered`, it is NEW)";
        default:
            return "a NULL sound dvar (snd_errorOnMissing / snd_reportSndAliasErrors) on a "
                   "dedicated server: a sound builtin got an alias the map lacks (dedi.md §25; "
                   "fixed by dedi_snd_alias_dvars -- if this DLL logged `registered`, it is NEW)";
        }
    }
    if (eip == 0x5FFE23)
        return "packet receive read [0x3BFD478] after localVars overran it: a CONSEQUENCE of an "
               "earlier escaped frame, look for fault #1 (dedi.md §23)";
    if (eip == 0x6F3E6A)
        return "water simulation read a NULL buffer (dedi.md §12; fixed by dedi_watersim_pool)";
    return nullptr;
}

// The engine's test at every reader, modelled: `if (!alias && dvar->current.enabled)`.
// A NULL dvar is only touched when the alias is missing -- which is why a server can run for
// minutes (every alias it plays exists) and then die on the first rank-up.
enum class outcome { plays, silent, script_error, access_violation };
inline outcome reader_outcome(bool alias_found, bool dvar_registered, bool dvar_enabled) {
    if (alias_found) return outcome::plays;
    if (!dvar_registered) return outcome::access_violation;
    return dvar_enabled ? outcome::script_error : outcome::silent;
}

enum class action { off, not_dedicated, already_registered, signature_mismatch, register_it };
inline action decide(bool dedicated, bool switched_off, uint32_t slot_value, bool signature_ok) {
    if (!dedicated) return action::not_dedicated;
    if (switched_off) return action::off;
    if (slot_value != 0) return action::already_registered;
    if (!signature_ok) return action::signature_mismatch;
    return action::register_it;
}

// SND_Init's two instructions for a slot, as bytes: `mov edi, <name>` and `mov [<slot>], eax`.
inline void expected_insns(const dvar_slot& s, uint8_t name_insn[5], uint8_t store_insn[5]) {
    name_insn[0] = 0xBF;
    store_insn[0] = 0xA3;
    for (int i = 0; i < 4; ++i) {
        name_insn[1 + i] = static_cast<uint8_t>(s.name >> (8 * i));
        store_insn[1 + i] = static_cast<uint8_t>(s.slot >> (8 * i));
    }
}

// A reader's load: `mov eax|ecx|edx, [slot]` is A1 imm32 (eax) or 8B 0D/15 imm32 (ecx/edx).
// Returns the instruction length, or 0 if the bytes are not a load of `slot`.
inline int reader_load_len(const uint8_t* b, uintptr_t slot) {
    auto imm = [&](int at) {
        return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
               (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
    };
    if (b[0] == 0xA1 && imm(1) == slot) return 5;
    if (b[0] == 0x8B && (b[1] == 0x0D || b[1] == 0x15) && imm(2) == slot) return 6;
    return 0;
}

}  // namespace enw::snd_alias_dvars
