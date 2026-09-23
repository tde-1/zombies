// Register the two sound dvars a headless server never registers, so a script that plays a
// sound alias the zones do not have is silent (as on a client) instead of an access violation
// that corrupts the script VM and freezes the server. dedi.md §25; the chain is in
// snd_alias_dvars.hpp.
//
// Evidence: B's fear_mc_2 game m_68e3fe9e, 2026-09-23 13:43:40 UTC, box DLL 04a3ad6d. The
// freeze watchdog's first escaped frame:
//
//     escape fault #1 code=C0000005 eip=004F057E reading 00000010 | eax=00000000
//     callers: 00695598 (VM_Execute's builtin call) ...
//     004F0579  mov eax, [0x3BE65DC]        ; snd_errorOnMissing -- NULL on a dedicated server
//     004F057E  cmp byte ptr [eax+0x10], 0  ; <- faults
//
// in PlayerCmd_playLocalSound, one second after the player's first kill (giveRankXP ->
// updateRankAnnounceHUD -> showNotifyMessage -> playLocalSound "mp_level_up"). Eleven seconds
// later the VM had overrun localVars by 32,168 slots and the watchdog ended the match.
//
// What this does, at post_init (main thread, after Com_Init, before the map loads):
//   for each slot: byte-check SND_Init's own `mov edi, <name>` / `mov [<slot>], eax` and the
//   name string, then call the engine's Dvar_RegisterBool with the engine's own name and
//   description pointers, flags 0, default 0 -- exactly SND_Init's call. Nothing else of
//   SND_Init runs (it would bring up a sound driver).
// Then, once the map is running (com_frameTime has moved 5 s), it logs whether the aliases the
// stock HUD code plays exist in this map's zones, and runs one real engine reader (0x63B560,
// the alias-index helper) on an alias that cannot exist: registered -> it returns 0.
//
// ENW_DEDI_NO_SND_ALIAS_DVARS=1   do not register (the control; §23's freeze comes back).
// ENW_DEDI_SND_ALIAS_TEST=1       run the self-test even if the slot is NULL (under __try: the
//                                 access violation is caught and logged, it is the proof of
//                                 the mechanism, not a crash).
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "scheduler.hpp"
#include "dedicated.hpp"
#include "snd_alias_dvars.hpp"

#include <windows.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace enw::dedi {
namespace {

using namespace enw::snd_alias_dvars;

constexpr uintptr_t kComFrameTime = 0x1F9648C;   // as freeze_watchdog.cpp
constexpr uintptr_t kAliasIndex   = 0x63B560;    // esi = name, [esp+4] used only on a hit
constexpr char kNoSuchAlias[] = "enw_s1_alias_that_no_zone_has";

bool g_switched_off = false;
bool g_force_test = false;
bool g_probed = false;
uint32_t g_first_ft = 0;

uint32_t read_u32(uintptr_t a) {
    uint32_t v = 0;
    memory::read(enw::at(a), &v);
    return v;
}

// Dvar_RegisterBool 0x5EEE20: al = default, edi = name, then [esp] = flags, [esp+4] = desc;
// the caller pops both (SND_Init: two calls, then `add esp, 0x10`). Returns the dvar_s*.
uint32_t call_register_bool(const char* name, const char* desc) {
    const uintptr_t fn = enw::at(kDvarRegisterBool);
    uint32_t out = 0;
    __asm {
        push edi
        push desc
        push 0
        xor eax, eax
        mov edi, name
        call fn
        add esp, 8
        pop edi
        mov out, eax
    }
    return out;
}

// SEH wrappers: no C++ objects with destructors in these.
bool seh_register(const char* name, const char* desc, uint32_t* out) {
    __try {
        *out = call_register_bool(name, desc);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

bool seh_find_alias(const char* name, uint32_t* out) {
    __try {
        *out = reinterpret_cast<uint32_t(__cdecl*)(const char*)>(enw::at(kFindSoundAlias))(name);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

uint32_t call_alias_index(const char* name) {
    const uintptr_t fn = enw::at(kAliasIndex);
    uint32_t out = 0;
    __asm {
        push esi
        mov esi, name
        push 0
        call fn
        add esp, 4
        pop esi
        mov out, eax
    }
    return out;
}

// Returns 0 on no exception, else the exception code.
DWORD seh_alias_index(const char* name, uint32_t* out) {
    __try {
        *out = call_alias_index(name);
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return GetExceptionCode();
    }
}

bool signature_ok(const dvar_slot& s) {
    uint8_t want_name[5], want_store[5], got[5];
    expected_insns(s, want_name, want_store);
    if (!memory::read_raw(enw::at(s.name_insn), got, 5) || std::memcmp(got, want_name, 5) != 0) return false;
    if (!memory::read_raw(enw::at(s.store_insn), got, 5) || std::memcmp(got, want_store, 5) != 0) return false;
    char nm[40] = {};
    const size_t n = std::strlen(s.name_text) + 1;
    if (n > sizeof nm || !memory::read_raw(enw::at(s.name), nm, n)) return false;
    return std::memcmp(nm, s.name_text, n) == 0;
}

void register_all(const char* when) {
    for (const dvar_slot& s : kSlots) {
        const uint32_t before = read_u32(s.slot);
        const bool sig = before == 0 ? signature_ok(s) : true;
        switch (decide(is_dedicated(), g_switched_off, before, sig)) {
        case action::not_dedicated:
        case action::off:
            break;
        case action::already_registered:
            ENW_INFO("dedi_snd_alias_dvars: %s: %s already registered ([0x%08X]=%08X)", when,
                     s.name_text, static_cast<unsigned>(s.slot), before);
            break;
        case action::signature_mismatch:
            ENW_ERROR("dedi_snd_alias_dvars: %s: NOT registering %s: SND_Init's bytes at 0x%08X / "
                      "0x%08X or the name at 0x%08X are not what this build expects. The slot stays "
                      "NULL and a missing sound alias will fault (dedi.md §25).",
                      when, s.name_text, static_cast<unsigned>(s.name_insn),
                      static_cast<unsigned>(s.store_insn), static_cast<unsigned>(s.name));
            break;
        case action::register_it: {
            uint32_t dv = 0;
            const bool ok = seh_register(reinterpret_cast<const char*>(enw::at(s.name)),
                                         reinterpret_cast<const char*>(enw::at(s.desc)), &dv);
            if (ok && dv) memory::write(enw::at(s.slot), dv);  // SND_Init's own store
            const uint32_t after = read_u32(s.slot);
            uint8_t enabled = 0xFF;
            if (after) memory::read(after + 0x10, &enabled);
            if (ok && after) {
                ENW_INFO("dedi_snd_alias_dvars: %s: registered %s -> dvar_s %08X, current.enabled=%u "
                         "([0x%08X] was NULL: SND_Init never runs on a dedicated server). A missing "
                         "alias is now silent, as on a client (dedi.md §25).",
                         when, s.name_text, after, enabled, static_cast<unsigned>(s.slot));
            } else {
                ENW_ERROR("dedi_snd_alias_dvars: %s: Dvar_RegisterBool(%s) %s; [0x%08X]=%08X. A missing "
                          "sound alias will still fault (dedi.md §25).",
                          when, s.name_text, ok ? "returned NULL" : "raised an exception",
                          static_cast<unsigned>(s.slot), after);
            }
            break;
        }
        }
    }
}

void probe() {
    // Which of the aliases the stock HUD code plays does this map have?
    static const char* kAliases[] = {"mp_level_up", "mp_challenge_complete", "mp_player_join"};
    char line[256];
    int n = 0;
    for (const char* a : kAliases) {
        uint32_t p = 0;
        const bool ok = seh_find_alias(a, &p);
        n += std::snprintf(line + n, sizeof line - n, " %s=%s", a,
                           !ok ? "EXCEPTION" : (p ? "present" : "MISSING"));
    }
    ENW_INFO("dedi_snd_alias_dvars: aliases in this map's zones:%s. A MISSING one played by a "
             "script is what faulted before this fix (showNotifyMessage plays mp_level_up on "
             "every rank-up).", line);

    const uint32_t slot = read_u32(kSlots[1].slot);
    if (!slot && !g_force_test) {
        ENW_WARN("dedi_snd_alias_dvars: self-test skipped: [0x%08X] is NULL (set "
                 "ENW_DEDI_SND_ALIAS_TEST=1 to run it anyway and catch the fault).",
                 static_cast<unsigned>(kSlots[1].slot));
        return;
    }
    uint32_t r = 0xFFFFFFFF;
    const DWORD code = seh_alias_index(kNoSuchAlias, &r);
    if (code == 0) {
        ENW_INFO("dedi_snd_alias_dvars: self-test: the engine's alias-index helper 0x%08X on "
                 "'%s' returned %u with no exception ([0x%08X]=%08X). This is the reader that "
                 "faulted.", static_cast<unsigned>(kAliasIndex), kNoSuchAlias, r,
                 static_cast<unsigned>(kSlots[1].slot), slot);
    } else {
        ENW_ERROR("dedi_snd_alias_dvars: self-test: 0x%08X on '%s' raised %08X ([0x%08X]=%08X) "
                  "-- the §25 fault, caught here. Without the fix every missing alias a script "
                  "plays does this inside a frame.", static_cast<unsigned>(kAliasIndex),
                  kNoSuchAlias, static_cast<unsigned>(code), static_cast<unsigned>(kSlots[1].slot), slot);
    }
}

void tick() {
    // Main thread. If post_init could not register (it ran off the main thread, or the dvar
    // system was not up), try again here; cheap when both slots are set.
    if (!g_switched_off && (!read_u32(kSlots[0].slot) || !read_u32(kSlots[1].slot))) register_all("frame");
    if (g_probed) return;
    const uint32_t ft = read_u32(kComFrameTime);
    if (!ft) return;
    if (!g_first_ft) { g_first_ft = ft; return; }
    if (ft - g_first_ft < 5000) return;
    g_probed = true;
    probe();
}

class snd_alias_dvars_component final : public component {
public:
    const char* name() const override { return "dedi_snd_alias_dvars"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        g_force_test = std::getenv("ENW_DEDI_SND_ALIAS_TEST") != nullptr;
        if (std::getenv("ENW_DEDI_NO_SND_ALIAS_DVARS")) {
            g_switched_off = true;
            ENW_WARN("dedi_snd_alias_dvars: OFF (ENW_DEDI_NO_SND_ALIAS_DVARS). snd_errorOnMissing "
                     "and snd_reportSndAliasErrors stay NULL; the first missing sound alias a "
                     "script plays faults inside a frame and corrupts the script VM (dedi.md §23/§25).");
        } else if (scheduler::on_main_thread()) {
            register_all("post_init");
        } else {
            // The dvar system is not ours to touch from another thread: the first frame does it.
            ENW_WARN("dedi_snd_alias_dvars: post_init is off the main thread; registering on the "
                     "first frame instead.");
        }
        enw::frame::subscribe("dedi_snd_alias_dvars", [](uint64_t) { tick(); });
    }
};

ENW_REGISTER_COMPONENT(snd_alias_dvars_component)

}  // namespace
}  // namespace enw::dedi
