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
    uintptr_t name_insn;  // SND_Init's `mov edi, <name>` for this dvar (BF + imm32)
    uintptr_t store_insn; // SND_Init's `mov [<slot>], eax` (A3 + imm32)
};

constexpr dvar_slot kSlots[] = {
    {0x3BE65DC, 0x89C3C0, "snd_errorOnMissing", 0x89C390,
     "Cause a Com_Error if a sound file is missing.", 0x6B487D, 0x6B4887},
    {0x3BE65D8, 0x89C3F0, "snd_reportSndAliasErrors", 0x89C3D4,
     "show missing alias errors.", 0x6B4894, 0x6B48C7},
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
    {0x66C29F, 0x3BE65DC, "playLoopSound, the other table (0x66C230)"},
    {0x5C5289, 0x3BE65D8, "0x5C5180 (12 callers)"},
    {0x63B56D, 0x3BE65D8, "alias index helper 0x63B560 (G_* callers)"},
    {0x64EC2D, 0x3BE65D8, "0x64EBF0: 'mp_player_join'"},
    {0x64ECCD, 0x3BE65D8, "0x64EC90"},
};
constexpr size_t kReaderCount = sizeof kReaders / sizeof kReaders[0];

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
