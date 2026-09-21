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
#include "scheduler.hpp"
#include "hook.hpp"
#include "frame.hpp"

#include <cstdlib>
#include <thread>

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
    // DVAR_SAVED is proved from the instruction, not from a header: `re` read the gate
    // inside the SetSavedDvar builtin at 0x516B15 as `test word ptr [dvar+8], 0x1000`.
    // Three wrong answers preceded it and all three are worth remembering:
    //   * my bit-0 guess (probe p17: written and read back, GSC still refused);
    //   * T4SP's enum, which calls 0x200 SAVED and 0x1000 CHANGEABLE_RESET -- wrong for
    //     this build, and a reminder that T4SP has been right about struct sizes and
    //     wrong about this enum, so treat its constants as hypotheses;
    //   * my own working mask 0xBDAE, which only worked *because* it happens to contain
    //     0x1000. It also set ~10 other bits, at least one of them cheat-ish, which is
    //     not something to ship on a server that certifies records.
    //
    // The other three below are [inferred] from observed behaviour in probe p16, not
    // read out of an instruction. Do not promote them to fact without the same
    // treatment DVAR_SAVED got.
    DVAR_ARCHIVE  = 0x0001,  // [inferred] com_maxfps is in config.cfg, logfile is not
    DVAR_ROM      = 0x0040,  // [inferred] set on `dedicated`, which prints "read only"
    DVAR_SAVED    = 0x1000,  // [VERIFIED, re] tested at 0x516B15
    DVAR_EXTERNAL = 0x4000,  // [inferred] set on dvars created from the command line
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
    // Round 1 (p16) established the layout and that bit 0 is the config.cfg archive bit.
    {"com_maxfps",              "in config.cfg -> archive bit (0x0001)"},
    {"logfile",                 "not in config.cfg -> archive clear"},
    {"dedicated",               "read only -> ROM 0x0040"},
    {"fs_homepath",             "write protected -> 0x0210"},
    {"con_typewriterColorBase", "created by +set -> external 0x4000"},
    // Round 2 (p18): bit 0 was NOT enough for SetSavedDvar, so "SAVED" is the GAMER
    // PROFILE system, not config.cfg archiving. The engine prints its profile set at
    // startup as `GamerProfile_UpdateProfileFromDvars(0): "mis_01" = ... "r_gamma" = ...`.
    // These are known members of that set, so whatever bit they share and the ones above
    // lack is DVAR_SAVED.
    {"r_gamma",                 "GamerProfile member -> SAVED expected"},
    {"takeCoverWarnings",       "GamerProfile member -> SAVED expected"},
    {"mis_01",                  "GamerProfile member -> SAVED expected"},
    {"cheat_points",            "GamerProfile member -> SAVED expected"},
    {"mis_difficulty",          "GamerProfile member -> SAVED expected"},
};

bool g_is_dedicated = false;
int  g_dedicated_value = 0;

// ---- crash site 1: the renderer bring-up we skip ------------------------------
// Naked so we control the epilogue exactly. WinMain's call site is a plain E8; the
// bytes around it are logged at install time so the assumption is checkable. EAX = 1
// says "renderer is up"; if WinMain tests it the other way this is the byte to flip.
// What this returns matters: if WinMain tests the result and treats our value as a
// failure, it will skip its own loop -- which is one candidate explanation for frames
// never turning even with the bring-up skipped (probe p29). Runtime-settable via
// ENW_DEDI_BRINGUP_RET so trying both costs a probe, not a rebuild.
long g_bringup_ret = 1;
// Counting our own stub is the decisive test for where WinMain actually stops.
// WinMain around the loop (dumped live, probe p31):
//   5FF799  call 5FF4E0        <- retargeted to this stub
//   5FF79E  mov ecx,[22C1BE4] / push ecx / call SetFocus     (returns immediately)
//   5FF7AB  mov esi,[Sleep]
//   5FF7B1  cmp [22C1BF0], ebx        <- LOOP TOP
//   5FF7B7  je 5FF7BD  /  push 5 / call esi   (Sleep(5))
//   5FF7BD  call Com_Frame            <- foundation's tick, reads 0
// Nothing between the stub and the loop can block: SetFocus returns. So if this
// counter stays at 0, WinMain never even reaches 0x5FF799 -- meaning Com_Init
// (which is where `+map` runs, and where our post_init fires) never returns.
volatile long g_bringup_calls = 0;

void __cdecl bringup_count() { ++g_bringup_calls; }

// WinMain, from the live scan (probe p33):
//     5FF77E  call 59D710   Com_Init
//     5FF794  call 594200   <- the only call between Com_Init and the bring-up
//     5FF799  call 5FF4E0   renderer bring-up  (our stub: NEVER HIT)
// So either Com_Init or 0x594200 does not return. Counting entry to 0x594200
// separates them: if this fires, Com_Init returned and 0x594200 is the blocker;
// if it does not, Com_Init is. The stub counts and then tail-jumps to the real
// function, so WinMain still gets whatever it was going to get.
volatile long g_mid_calls = 0;
void* g_mid_target = nullptr;
void __cdecl mid_count() { ++g_mid_calls; }

__declspec(naked) void mid_stub() {
    __asm {
        pushfd
        pushad
        call mid_count
        popad
        popfd
        jmp  dword ptr [g_mid_target]
    }
}

__declspec(naked) void renderer_bringup_stub() {
    __asm {
        pushfd
        pushad
        call bringup_count
        popad
        popfd
        mov eax, dword ptr [g_bringup_ret]
        ret
    }
}

// ---- frame counting ------------------------------------------------------------
// We do NOT hook Com_Frame or SV_Frame ourselves any more. shared/core/frame.hpp owns
// the tick and the rule is that components subscribe: MinHook allows one hook per
// address and the loser only learns from a log line. Probe p29 is exactly that failure
// -- my private SV_Frame hook lost to `referee`'s
// ("MH_CreateHook(00635CC0) failed: already created"), so the SV_Frame=0 it reported
// was meaningless. Subscribing cannot collide.
volatile long long g_frames = 0;

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
        raise_timer_resolution();
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

        if (const char* r = std::getenv("ENW_DEDI_BRINGUP_RET")) {
            g_bringup_ret = std::strtol(r, nullptr, 0);
            ENW_INFO("dedicated: ENW_DEDI_BRINGUP_RET=%ld (renderer stub return value)",
                     g_bringup_ret);
        }
        dump_dvar_layout(find);
        skip_renderer_bringup();
        install_frame_counter();
        start_liveness_monitor();
        // The gamer-profile dvars that let us derive DVAR_SAVED do not exist yet at
        // post_init (probe p18: r_gamma / takeCoverWarnings / mis_01 / cheat_points /
        // mis_difficulty all NOT FOUND), but the engine does print
        // "GamerProfile_UpdateProfileFromDvars(0): ..." later in Com_Init, before
        // "Server Initialization" and so before any GSC runs. So keep retrying on the
        // main thread until they appear; the pump is driven by the engine's own
        // Dvar_FindVar calls, so this costs nothing and lands at a safe point.
        schedule_saved_flag_fix();
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
    // ---- crash site 1 ------------------------------------------------------------
    // `re` (2026-09-20): 0x5FF4E0 is the renderer / D3D bring-up (it calls the D3D
    // wrapper at 0x75A9A2). WinMain calls it at 0x5FF799, BEFORE entering its loop at
    // 0x5FF7B1, and the call is NOT gated by com_dedicated. So in a headless process it
    // both drags a D3D device in and, when it fails, stops WinMain ever reaching the
    // frame loop -- which is why Com_Frame had never been observed to run.
    //
    // We retarget that one call rather than patching the function, because rewriting an
    // existing rel32 cannot corrupt a neighbouring instruction. We refuse to patch
    // unless the site really is an E8 pointing at 0x5FF4E0.
    void skip_renderer_bringup() {
        constexpr uintptr_t kCallSite = 0x5FF799;
        constexpr uintptr_t kTarget   = 0x5FF4E0;

        // Dump the instruction stream from just before the bring-up call to past the
        // loop entry. p29/p30 show the loop body never executes even with the call
        // skipped and with either return value, so this window is where the answer is.
        // Where is Com_Init called from, and is it really before the bring-up call?
        // Our stub at 0x5FF799 is never hit (probe p32), so WinMain stops earlier; this
        // finds every E8 in WinMain and names the ones we care about, which turns
        // "Com_Init probably does not return" into a fact with an address on it.
        ENW_INFO("dedicated: scanning WinMain 0x5FF600..0x5FF7C0 for calls");
        for (uintptr_t a = 0x5FF600; a < 0x5FF7C0; ++a) {
            uint8_t op = 0;
            if (!memory::read(enw::at(a), &op) || op != 0xE8) continue;
            int32_t rel = 0;
            if (!memory::read(enw::at(a) + 1, &rel)) continue;
            const uintptr_t tgt = a + 5 + rel;
            const char* what = "";
            if (tgt == t4::fn::Com_Init)  what = "  <== Com_Init";
            if (tgt == 0x5FF4E0)          what = "  <== renderer bring-up (we retarget this)";
            if (tgt == t4::fn::Com_Frame) what = "  <== Com_Frame";
            ENW_INFO("dedicated:   call at %08X -> %08X%s",
                     static_cast<unsigned>(a), static_cast<unsigned>(tgt), what);
        }
        ENW_INFO("dedicated: WinMain window 0x5FF790..0x5FF7E0 (loop top 0x5FF7B1, "
                 "call Com_Frame 0x5FF7BD):");
        for (uintptr_t a = 0x5FF790; a < 0x5FF7E0; a += 16)
            ENW_INFO("dedicated:   %08X  %s", static_cast<unsigned>(a),
                     memory::hex_dump(enw::at(a), 16).c_str());

        // Instrument the call between Com_Init and the bring-up.
        constexpr uintptr_t kMidSite = 0x5FF794;
        const uintptr_t mid = memory::call_target(enw::at(kMidSite));
        if (mid == enw::at(0x594200)) {
            g_mid_target = reinterpret_cast<void*>(mid);
            if (memory::retarget_call(enw::at(kMidSite), &mid_stub))
                ENW_INFO("dedicated: counting WinMain's call at 0x5FF794 -> 0x594200");
        } else {
            ENW_WARN("dedicated: 0x5FF794 targets 0x%08X, not 0x594200; not counting it",
                     static_cast<unsigned>(mid));
        }

        const uintptr_t actual = memory::call_target(enw::at(kCallSite));
        if (actual != enw::at(kTarget)) {
            ENW_ERROR("dedicated: NOT patching: call at 0x%08X targets 0x%08X, expected 0x%08X",
                      static_cast<unsigned>(kCallSite), static_cast<unsigned>(actual),
                      static_cast<unsigned>(enw::at(kTarget)));
            return;
        }
        if (!memory::retarget_call(enw::at(kCallSite), &renderer_bringup_stub)) {
            ENW_ERROR("dedicated: retarget_call on 0x%08X failed", static_cast<unsigned>(kCallSite));
            return;
        }
        ENW_INFO("dedicated: renderer bring-up 0x%08X skipped (call at 0x%08X retargeted). "
                 "WinMain should now reach its frame loop at 0x5FF7B1.",
                 static_cast<unsigned>(kTarget), static_cast<unsigned>(kCallSite));
    }

    // ---- the frame loop ------------------------------------------------------------
    // Counting Com_Frame is how we prove the loop is running at all, and it is also the
    // measurement everyone else is waiting on (sv_fps 20 => expect ~20 Hz).
    void install_frame_counter() {
        if (!memory::looks_like_function(enw::at(t4::fn::Com_Frame))) {
            ENW_ERROR("dedicated: Com_Frame 0x%08X does not look like a function (%s)",
                      static_cast<unsigned>(t4::fn::Com_Frame),
                      memory::hex_dump(enw::at(t4::fn::Com_Frame), 8).c_str());
            return;
        }
        enw::frame::subscribe("dedicated", [](uint64_t) { ++g_frames; });
        ENW_INFO("dedicated: subscribed to the shared frame tick (installed=%s, subscribers=%zu)",
                 enw::frame::installed() ? "yes" : "NO", enw::frame::subscriber_count());

    }

    static constexpr int kMaxSavedFixAttempts = 200000;
    int  saved_fix_attempts_ = 0;
    bool saved_fix_done_ = false;
    bool saved_fix_gave_up_ = false;

    // Re-arm on the main thread until the gamer-profile dvars exist, then fix the flags
    // once. Bounded: it gives up rather than re-queueing for ever.
    void schedule_saved_flag_fix() {
        scheduler::run_on_main([this] { this->try_saved_flag_fix(); });
    }

    void try_saved_flag_fix() {
        if (saved_fix_done_) return;
        if (++saved_fix_attempts_ > kMaxSavedFixAttempts) {
            if (!saved_fix_gave_up_) {
                saved_fix_gave_up_ = true;
                ENW_ERROR("dedicated: gave up deriving DVAR_SAVED after %d attempts; the "
                          "GamerProfile dvars never appeared. Ask `re` for the flag constant "
                          "that Scr_SetSavedDvar tests.", kMaxSavedFixAttempts);
            }
            return;
        }
        const auto find = reinterpret_cast<Dvar_FindVar_t>(enw::at(t4::fn::Dvar_FindVar));

        // ENW_DEDI_SAVED_MASK lets us bisect the flag without a rebuild: set it to a hex
        // mask of candidate bits and see whether GSC's SetSavedDvar stops complaining.
        // Probe p19 showed the GamerProfile dvars (r_gamma, mis_01, ...) are never
        // registered in dedicated mode -- the engine's profile printout reads its own
        // buffer, not dvars -- so the derivation below cannot fire and the mask is how we
        // find the bit until `re` reads the constant out of the SetSavedDvar builtin.
        if (const char* env = std::getenv("ENW_DEDI_SAVED_MASK")) {
            const auto mask = static_cast<uint16_t>(std::strtoul(env, nullptr, 16));
            if (mask) {
                ENW_INFO("dedicated: ENW_DEDI_SAVED_MASK=0x%04X (forced, bisecting)", mask);
                register_missing_saved_dvars(find, mask);
                saved_fix_done_ = true;
                return;
            }
        }

        register_missing_saved_dvars(find, DVAR_SAVED);
        saved_fix_done_ = true;
    }

    // Work out DVAR_SAVED at runtime instead of hard-coding a guess.
    //
    // The engine tells us its own answer at startup: it prints
    //   GamerProfile_UpdateProfileFromDvars(0): "mis_01" = ... "r_gamma" = ...
    // which is exactly the set SetSavedDvar() operates on. So: AND the flags of dvars we
    // know are in that set, and clear any bit that also appears on a dvar we know is not.
    // Whatever survives is the flag. If that is not a single bit we refuse to write.
    uint16_t derive_saved_flag(Dvar_FindVar_t find, bool quiet = false) {
        static constexpr const char* kProfile[] = {
            "r_gamma", "takeCoverWarnings", "mis_01", "cheat_points", "mis_difficulty"};
        static constexpr const char* kNotProfile[] = {
            "logfile", "dedicated", "fs_homepath", "com_maxfps", "con_typewriterColorBase"};

        uint16_t common = 0xFFFF;
        int seen = 0;
        for (const char* n : kProfile) {
            void* d = find(n);
            if (!d) continue;
            uint16_t f = 0;
            if (!memory::read(reinterpret_cast<uintptr_t>(d) + dvar::off_flags, &f)) continue;
            common &= f;
            ++seen;
        }
        if (seen == 0) {
            if (!quiet)
                ENW_ERROR("dedicated: none of the GamerProfile dvars exist yet; cannot derive "
                          "DVAR_SAVED on this attempt.");
            return 0;
        }

        uint16_t negative = 0;
        for (const char* n : kNotProfile) {
            void* d = find(n);
            if (!d) continue;
            uint16_t f = 0;
            if (!memory::read(reinterpret_cast<uintptr_t>(d) + dvar::off_flags, &f)) continue;
            negative |= f;
        }

        const uint16_t candidate = static_cast<uint16_t>(common & ~negative);
        const bool single = candidate != 0 && (candidate & (candidate - 1)) == 0;
        if (!quiet || single)
        ENW_INFO("dedicated: DVAR_SAVED derivation: %d profile dvars, common=0x%04X, "
                 "negative=0x%04X, candidate=0x%04X (%s)",
                 seen, common, negative, candidate,
                 single ? "single bit - will use it" : "NOT a single bit - refusing to write");
        return single ? candidate : 0;
    }

    void register_missing_saved_dvars(Dvar_FindVar_t find, uint16_t saved_bit) {
        if (saved_bit == 0) {
            ENW_WARN("dedicated: DVAR_SAVED not derived; leaving dvars alone this run");
            return;
        }
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
            if ((flags & saved_bit) == saved_bit) {
                ENW_INFO("dedicated: '%s' already SAVED (flags 0x%04X type 0x%04X)",
                         d.name, flags, type);
                continue;
            }
            const uint16_t want = static_cast<uint16_t>(flags | saved_bit);
            if (!memory::write<uint16_t>(a + dvar::off_flags, want)) {
                ENW_ERROR("dedicated: failed to set DVAR_SAVED on '%s' @ %p", d.name, dv);
                continue;
            }
            uint16_t after = 0;
            memory::read(a + dvar::off_flags, &after);
            ENW_INFO("dedicated: '%s' flags 0x%04X -> 0x%04X (type 0x%04X) %s  [%s]",
                     d.name, flags, after, type,
                     ((after & saved_bit) == saved_bit) ? "SAVED bits set" : "SET FAILED", d.why);
        }
    }

    // 1 ms timer resolution. Hygiene, NOT a fix for anything we have measured.
    //
    // The frame pacing at 0x59DD90 sleeps 1 ms at a time until elapsed >= the target in
    // [esp+0x14], bounded to 0x32 = 50 iterations (`add edi,1 / cmp edi,0x32 /
    // jl 0x59DD90`, ebx = KERNEL32!Sleep). In dedicated mode the target is hard-coded
    // to 1 ms -- the `1000/com_maxfps` computation at 0x59DD37 is SKIPPED when
    // com_dedicated is non-zero (0x59DD2C reads [0x212B2F4] and jumps past it) -- so
    // the loop normally exits after one sleep.
    //
    // This was tried as a cure for the "server stops after 4 frames" bug on the theory
    // that Sleep(1) is really ~15.6 ms at the default quantum, which is the trap iw4x
    // documents in Threading.cpp for exactly this loop shape. **It made no difference:
    // that bug was the local client being dropped by the co-op join gate (see
    // local_client.cpp), nothing to do with sleep resolution.** Kept because it is free
    // and it does make the pacing honest -- a 1 ms target sleeping 15.6 ms would cap a
    // headless server at ~64 Hz whatever else was true.
    //
    // Loaded dynamically so the build needs no winmm link change (other agents share
    // this CMakeLists).
    void raise_timer_resolution() {
        const HMODULE winmm = ::LoadLibraryA("winmm.dll");
        if (!winmm) { ENW_WARN("dedicated: could not load winmm.dll"); return; }
        using timeBeginPeriod_t = unsigned(__stdcall*)(unsigned);
        const auto fn = reinterpret_cast<timeBeginPeriod_t>(
            ::GetProcAddress(winmm, "timeBeginPeriod"));
        if (!fn) { ENW_WARN("dedicated: winmm.dll has no timeBeginPeriod"); return; }
        const unsigned rc = fn(1);
        ENW_INFO("dedicated: timeBeginPeriod(1) -> %u (0 = ok). Hygiene only: the pacing loop at "
                 "0x59DD90 targets 1 ms in dedicated mode, which would be ~15.6 ms at the default "
                 "quantum. It was NOT the cause of the 4-frame stop (see local_client.cpp).", rc);
    }

    // Is the main thread alive at all?
    //
    // p21-p24: the headless server loads the map, runs zombiemode GSC, then sits at
    // EXACTLY 0% CPU and Com_Frame never fires. Flat CPU means a blocking wait, not a
    // spin, so before hunting for the wait we need to know whether the main thread is
    // executing engine code at all. foundation's scheduler pump is driven from a detour
    // on Dvar_FindVar, so a rising pump count means the engine is running and our
    // Com_Frame address is wrong; a frozen pump count means the main thread is parked.
    void start_liveness_monitor() {
        std::thread([] {
            for (int i = 0; i < 600; ++i) {
                ::Sleep(5000);
                const auto s = scheduler::snapshot();
                static uint64_t last = 0;
                const uint64_t n = enw::frame::count();
                ENW_INFO("dedicated: liveness t=%ds  frame::count=%llu (+%llu in 5s = %.1f Hz) "
                         "installed=%s  ours=%lld  mid(0x594200)_hits=%ld  bringup_hits=%ld  pumps=%llu",
                         (i + 1) * 5, static_cast<unsigned long long>(n),
                         static_cast<unsigned long long>(n - last), (n - last) / 5.0,
                         enw::frame::installed() ? "yes" : "NO",
                         static_cast<long long>(g_frames), g_mid_calls, g_bringup_calls,
                         static_cast<unsigned long long>(s.pumps));
                last = n;
            }
        }).detach();
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
