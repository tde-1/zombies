// Stage C: headless dedicated server. See dedicated.hpp for why this file is much
// smaller than iw4x-client's Dedicated.cpp or h1-mod's dedicated.cpp.
//
// Measured on the stock Steam CoDWaW.exe 1.7.1263 (docs/kickstart/dedi.md):
//   +set dedicated 1 +set zombiemode 1 +map nazi_zombie_prototype
//     -> no Direct3D, no game window, 'ui' fastfile never loaded, r_loadForRenderer 0
//     -> "------ Server Initialization ------ / Server: nazi_zombie_prototype"
//     -> sv_running 1, sv_maxclients 4, the 76.85 MB map fastfile and its col_map load
//     -> then ONE GSC line kills it:
//          SetSavedDvar can only be called on dvars with the SAVED flag set
//          maps/_load.gsc:3767  SetSavedDvar("con_typewriterColorBase", "1.0 1.0 1.0")
//        because that dvar is registered by the *client* console code, which never runs.
//        `+set` and `seta` both fail: they create the dvar without the SAVED flag.
//     -> script runtime error -> Com_Error -> "----- Server Shutdown -----"
//        -> the engine falls back into client init -> a D3D9 device, a window, and a
//           second code_post_gfx load -> "Exceeded limit of 1 'snddriverglobals' assets".
//
// Job list, in the order the probes say it blocks us:
//   1. register every client-side dvar stock GSC pokes, WITH DVAR_SAVED, before the
//      first SV_SpawnServer. Blocked on Dvar_RegisterVec3/String from `re`.
//   2. stop the client/renderer re-entry after a server shutdown, so a script error or
//      a map change cannot drag a D3D device into a headless process.
//      t4::fn::WinMain is the frame loop that re-enters it; t4::fn::D3D9_CreateDevice_wrap
//      is the last line of defence.
//   3. pace the frame loop with a sleep and prove the idle cost.
//   4. keep local client 0 out of the game (the host must not take a player slot:
//      _zombiemode.gsc sizes rounds off get_players()).
//
// Clean room: patterns from iw4x-client / h1-mod / CoD4x_Server (GPL/AGPL). No T4M code,
// no decompiled Activision code.

#include "dedicated.hpp"

#include "logger.hpp"
#include "memory.hpp"

#include <cstdlib>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw::dedi {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

// ---------------------------------------------------------------------------
// dvar_s layout, derived from a live headless boot (probe p16, 2026-09-20).
// Not guessed and not copied from anywhere: six dvars whose properties we already
// knew from the engine's own console output were dumped and compared.
//
//   +0x00  const char* name          (verified: the slot that points back at the name)
//   +0x04  const char* description
//   +0x08  uint16 flags | uint16 type
//   +0x10  current value  (16 bytes: int / float / char* / vec)
//   +0x20  latched value  (same shape)
//
// Evidence for the split at +0x08, low half flags / high half type:
//   com_maxfps              0x0005'0001   int,    in config.cfg  -> SAVED set
//   logfile                 0x0005'0000   int,    never archived -> SAVED clear
//   dedicated               0x0006'0060   enum,   "dedicated is read only"
//   fs_homepath             0x0007'0210   string, "fs_homepath is write protected"
//   con_typewriterColorBase 0x0007'4000   string, created by our own +set (external)
// and the values confirm it: com_maxfps +0x10 = 0x55 (85), logfile +0x10 = 2,
// dedicated +0x10 = 1, fs_homepath +0x10 = a char* to the path we passed.
//
// So DVAR_SAVED is bit 0 -- exactly the bit that differs between com_maxfps and
// logfile, which is the pair we chose for that purpose.
namespace dvar {
constexpr size_t off_name  = 0x00;
constexpr size_t off_desc  = 0x04;
constexpr size_t off_flags = 0x08;   // uint16
constexpr size_t off_type  = 0x0A;   // uint16
constexpr size_t off_value = 0x10;
}  // namespace dvar

enum dvar_flags : uint16_t {
    DVAR_SAVED    = 0x0001,  // [V] what SetSavedDvar() insists on
    DVAR_ROM      = 0x0040,  // [C] set on `dedicated`
    DVAR_EXTERNAL = 0x4000,  // [C] set on dvars created from the command line
};

enum dvar_type : uint16_t {
    DVAR_TYPE_INT    = 0x0005,  // [C] com_maxfps, logfile
    DVAR_TYPE_ENUM   = 0x0006,  // [C] dedicated
    DVAR_TYPE_STRING = 0x0007,  // [C] fs_homepath, and anything made by +set
};

using Dvar_FindVar_t = void*(__cdecl*)(const char* name);

// Client-side dvars that stock zombies GSC calls SetSavedDvar() on.
// Only the first is confirmed fatal by experiment; the others come from the same code
// (`referee` extracted maps/_load.gsc: 12 SetSavedDvar call sites) and are cheap to
// pre-register once we can.
struct wanted_dvar {
    const char* name;
    const char* value;
    const char* why;
};
constexpr wanted_dvar kWantedDvars[] = {
    {"con_typewriterColorBase", "1.0 1.0 1.0", "maps/_load.gsc:3767 SetObjectiveTextColors - CONFIRMED fatal"},
    {"hud_drawhud",             "1",           "maps/_load.gsc:2351"},
    {"ui_campaign",             "american",    "maps/_load.gsc:344"},
};

// Learning dvar_s's layout at runtime instead of guessing it.
//
// We do not need Dvar_Register* to fix crash site 2 if we can find the flags field:
// `+set con_typewriterColorBase "1 1 1"` already creates the dvar (probe p07), it just
// lacks DVAR_SAVED. Setting one bit on an existing dvar_s is far less invasive than
// calling a registration function whose signature we have not verified.
//
// To find the field we dump dvars whose flags we can infer from observed behaviour:
//   com_maxfps       - written to profiles/<p>/config.cfg  => HAS the saved/archive flag
//   sensitivity      - likewise                            => HAS it
//   logfile          - never in config.cfg                 => does NOT have it
//   dedicated        - "dedicated is read only"            => ROM
//   fs_homepath      - "fs_homepath is write protected"    => write-protected
//   con_typewriterColorBase - created by our own +set      => external, no flags
// The bit that is set in the first group and clear in the others is DVAR_SAVED.
struct layout_probe { const char* name; const char* expect; };
constexpr layout_probe kLayoutProbes[] = {
    {"com_maxfps",              "in config.cfg -> SAVED expected"},
    {"sensitivity",             "in config.cfg -> SAVED expected"},
    {"logfile",                 "not in config.cfg -> no SAVED"},
    {"dedicated",               "read only -> ROM"},
    {"fs_homepath",             "write protected"},
    {"con_typewriterColorBase", "created by +set -> external, no flags"},
};

bool g_is_dedicated = false;
int  g_dedicated_value = 0;

// Read the engine's `dedicated` dvar without knowing dvar_s's layout: com_dedicated is a
// pointer to it, so a non-null pointer plus a matching command line is enough for now.
bool detect_dedicated_from_command_line(int* value_out) {
    const char* cmd = ::GetCommandLineA();
    if (!cmd) return false;
    const char* p = std::strstr(cmd, "dedicated");
    if (!p) return false;
    p += std::strlen("dedicated");
    while (*p == ' ' || *p == '\t' || *p == '"') ++p;
    const int v = std::atoi(p);
    if (value_out) *value_out = v;
    return v != 0;
}

class dedicated_component final : public component {
public:
    const char* name() const override { return "dedicated"; }

    void post_load() override {
        // No game memory here: the image may still be SteamStub-encrypted.
        int v = 0;
        if (detect_dedicated_from_command_line(&v)) {
            g_is_dedicated = true;
            g_dedicated_value = v;
            ENW_INFO("dedicated: command line asks for dedicated %d", v);
        } else {
            ENW_INFO("dedicated: not a dedicated server; component will idle");
        }
    }

    // post_unpack is too early: measured on 2026-09-20, Dvar_FindVar("dedicated") returns
    // null there because Com_Init has not registered the dvars yet. Everything that reads
    // or registers a dvar has to be in post_init.
    void post_init() override {
        if (!g_is_dedicated) return;

        if (!memory::looks_like_function(enw::at(t4::fn::Dvar_FindVar))) {
            ENW_ERROR("dedicated: Dvar_FindVar 0x%08X does not look like a function (%s); "
                      "refusing to touch the engine",
                      static_cast<unsigned>(t4::fn::Dvar_FindVar),
                      memory::hex_dump(enw::at(t4::fn::Dvar_FindVar), 8).c_str());
            return;
        }
        const auto find = reinterpret_cast<Dvar_FindVar_t>(enw::at(t4::fn::Dvar_FindVar));

        // Confirm the engine agrees it is dedicated before we change anything.
        void* dedicated_dvar = find("dedicated");
        void* com_dedicated  = *reinterpret_cast<void**>(enw::at(t4::var::com_dedicated));
        ENW_INFO("dedicated: Dvar_FindVar(\"dedicated\")=%p  com_dedicated=%p  %s",
                 dedicated_dvar, com_dedicated,
                 (dedicated_dvar && dedicated_dvar == com_dedicated) ? "(agree)" : "(MISMATCH - stop)");
        if (!dedicated_dvar || dedicated_dvar != com_dedicated) return;

        dump_dvar_layout(find);
        register_missing_saved_dvars(find);
        report_pending_work();
    }

private:
    // Diagnostic: dump the head of several dvar_s so we can read off the name/flags/type
    // offsets. Read-only. Also prints, for each 4-byte slot, whether it looks like a
    // pointer to this dvar's own name -- that pins the name field immediately.
    void dump_dvar_layout(Dvar_FindVar_t find) {
        for (const auto& probe : kLayoutProbes) {
            void* d = find(probe.name);
            if (!d) { ENW_WARN("dedicated: layout probe '%s' NOT FOUND", probe.name); continue; }
            const auto a = reinterpret_cast<uintptr_t>(d);
            if (!memory::is_readable(d, 48)) {
                ENW_WARN("dedicated: dvar_s('%s') @ %p unreadable", probe.name, d);
                continue;
            }
            ENW_INFO("dedicated: dvar_s('%s') @ %p  [%s]", probe.name, d, probe.expect);
            for (int i = 0; i < 48; i += 16)
                ENW_INFO("dedicated:   +%02X  %s", i, memory::hex_dump(a + i, 16).c_str());
            // Which slot holds a char* equal to the dvar's own name?
            for (int i = 0; i < 48; i += 4) {
                uintptr_t slot = 0;
                if (!memory::read(a + i, &slot)) continue;
                const auto* s = reinterpret_cast<const char*>(slot);
                if (slot && memory::is_readable(s, 2) &&
                    std::strncmp(s, probe.name, std::strlen(probe.name)) == 0 &&
                    s[std::strlen(probe.name)] == '\0') {
                    ENW_INFO("dedicated:   name* at +%02X", i);
                }
            }
        }
    }

    // Step 1: the thing actually blocking a headless map load.
    //
    // We do NOT call a registration function. `+set <name> <value>` on the command line
    // already creates the dvar (probe p07) -- it just comes out as DVAR_EXTERNAL with no
    // SAVED bit, which is precisely what GSC's SetSavedDvar() refuses. So we set one bit
    // on a dvar the engine itself created. That is a two-byte write and needs no verified
    // function signature, which is why it is the right first move rather than guessing at
    // Dvar_RegisterVec3.
    //
    // The launcher must pass `+set <name> <value>` for each of these; if one is missing we
    // say so loudly rather than inventing it.
    void register_missing_saved_dvars(Dvar_FindVar_t find) {
        for (const auto& d : kWantedDvars) {
            void* dv = find(d.name);
            if (!dv) {
                ENW_ERROR("dedicated: '%s' ABSENT (%s). Launch with `+set %s \"%s\"` so the engine "
                          "creates it and we can flag it.", d.name, d.why, d.name, d.value);
                continue;
            }
            const auto a = reinterpret_cast<uintptr_t>(dv);
            uint16_t flags = 0, type = 0;
            if (!memory::read(a + dvar::off_flags, &flags) ||
                !memory::read(a + dvar::off_type, &type)) {
                ENW_ERROR("dedicated: could not read dvar_s('%s') @ %p", d.name, dv);
                continue;
            }
            if (flags & DVAR_SAVED) {
                ENW_INFO("dedicated: '%s' already SAVED (flags 0x%04X type 0x%04X)",
                         d.name, flags, type);
                continue;
            }
            const uint16_t want = static_cast<uint16_t>(flags | DVAR_SAVED);
            if (!memory::write<uint16_t>(a + dvar::off_flags, want)) {
                ENW_ERROR("dedicated: failed to set DVAR_SAVED on '%s' @ %p", d.name, dv);
                continue;
            }
            uint16_t after = 0;
            memory::read(a + dvar::off_flags, &after);
            ENW_INFO("dedicated: '%s' flags 0x%04X -> 0x%04X (type 0x%04X) %s  [%s]",
                     d.name, flags, after, type,
                     (after & DVAR_SAVED) ? "SAVED set" : "SET FAILED", d.why);
        }
    }

    void report_pending_work() {
        ENW_INFO("dedicated: value=%d. The engine already gives us: no D3D, no game window, "
                 "no 'ui' fastfile, r_loadForRenderer=0, sv_fps=20, sv_maxclients=4, "
                 "a UDP socket on net_port.", g_dedicated_value);
        ENW_WARN("dedicated: TODO stop the client-init re-entry after a server shutdown. "
                 "Frame loop is WinMain 0x%08X -> Com_Frame 0x%08X; the observable symptom is "
                 "Direct3DCreate9 via 0x%08X followed by a second code_post_gfx load.",
                 static_cast<unsigned>(t4::fn::WinMain),
                 static_cast<unsigned>(t4::fn::Com_Frame),
                 static_cast<unsigned>(t4::fn::D3D9_CreateDevice_wrap));
        ENW_WARN("dedicated: TODO sleep-based frame pacing; no T4 R_SyncGpu equivalent mapped yet. "
                 "Sys_Milliseconds is 0x%08X.", static_cast<unsigned>(t4::fn::Sys_Milliseconds));
        ENW_WARN("dedicated: TODO keep local client 0 out of the game (svs 0x%08X).",
                 static_cast<unsigned>(t4::var::svs));
    }
};

#else  // !ENW_HAVE_T4_ADDRESSES

// shared/t4/addresses.hpp has not landed yet. Stay out of the way but stay in the build.
bool g_is_dedicated = false;
int  g_dedicated_value = 0;

class dedicated_component final : public component {
public:
    const char* name() const override { return "dedicated"; }
    void post_load() override {
        ENW_WARN("dedicated: shared/t4/addresses.hpp missing; component disabled");
    }
};

#endif

}  // namespace

bool is_dedicated() { return g_is_dedicated; }
int  dedicated_value() { return g_dedicated_value; }

}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::dedicated_component)
