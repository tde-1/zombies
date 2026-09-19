// Late binding to T4. See t4_bind.hpp for why this exists.
//
// BOUND TODAY: the per-frame callback, via Com_Frame (0x59E330, [V] in
// shared/t4/addresses.hpp). That is enough for every component to tick.
//
// NOT BOUND, and why: every read of game state needs something `re` has not
// published yet. Each accessor below therefore returns "unavailable" and the
// components degrade to reporting nothing, rather than dereferencing an address
// from the vault on a hope and faulting the game mid-round.
//
// WHAT IS STILL MISSING, in the order it unblocks work:
//   1. Scr_NotifyNum (or the VM notify opcode target) -- the one hook the whole
//      referee rests on; every GSC flag_set() is a level notify (referee.md 2.8)
//   2. script variable access: gScrVarPub/gScrVarGlob, FindVariable, the
//      canonical string table, and the object id of `level`. Unblocks
//      round_number, intermission, score, downs, and every knob.
//   3. serverStatic_s: the offset of the clients[] array inside svs (0x23D5C80).
//      We have client_s size 0x58D30, .name 0x11548, .userinfo 0x6F0, .gentity
//      0x11544, but not where the array starts.
//   4. gentity_s field offsets for origin / angles / health (we have size 0x378
//      and .client 0x180 / .r 0x118 only).
//   5. SV_SendServerCommand (chat injection) and the dvar_s value/flags layout
//      (dvar reads and writes; `dedi` is probing this now).
//   6. Scr_LoadScript / Scr_ExecThread (the co-loaded GSC of referee.md 3.3).
// G_Say 0x473F10 and ClientCommand 0x4388A0 are published [C] and are the chat
// capture site, but both are [C] not [V] and the signature is unverified, so
// chat capture waits for one confirmation rather than guessing a calling
// convention inside the damage path.
#include "t4_bind.hpp"

#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/scheduler.hpp"

#include <mutex>

namespace enw::referee {

void dispatch_notify(const notify_event& ev);
void dispatch_frame(uint32_t ms);

namespace {

binding_report g_report;
bool g_bound = false;
std::mutex g_sinks_mutex;
std::vector<notify_sink> g_notify_sinks;
std::vector<frame_sink> g_frame_sinks;

}  // namespace

std::string binding_report::describe() const {
    std::string s;
    auto add = [&s](const char* n, bool v) {
        if (!s.empty()) s += ' ';
        s += n;
        s += v ? "=yes" : "=no";
    };
    add("notify", notify_hook);
    add("scriptvars", script_vars);
    add("entities", entities);
    add("clients", clients);
    add("servercmd", server_cmd);
    add("dvars", dvars);
    add("frame", frame_hook);
    return s;
}

namespace {

// FRAME SOURCE. Measured 2026-09-20 (board 00:40): Com_Frame 0x59E330 is NEVER
// CALLED, despite being tagged [V] "called once per WinMain loop iter" in
// shared/t4/addresses.hpp. A MinHook detour on it was created and enabled, logged
// nothing across two 50-75 s dedicated runs, and a read-back 20 s in showed our
// jmp still in place -- so it is not a SteamStub re-encrypt, the function is just
// not on the path. foundation's main_thread pump hit the same wall the same hour
// (0 pump calls on Com_Frame vs 96 in 0.3 s on Dvar_FindVar).
//
// So we do NOT hook a frame function ourselves. We ride whatever pump
// shared/core::scheduler has by re-queueing: each run dispatches one tick and
// queues the next. That way there is exactly one detour in the DLL for this, it
// is foundation's, and when they expose a real on_frame() callback this becomes
// three lines. If their pump is dead, we tick zero times and report nothing --
// which is the correct behaviour, not a crash.
// The pump we ride is driven by Dvar_FindVar, which the engine calls many times
// per frame (measured: ~9,000 ticks/s if we dispatch on every pump item). So the
// tick is rate-limited to the server frame rate rather than the pump rate: the
// replay sampler's "20 Hz players, 10 Hz zombies" has to mean wall-clock Hz, not
// "however often the engine happened to look up a dvar".
bool g_ticking = false;
uint32_t g_last_tick_ms = 0;
constexpr uint32_t kTickIntervalMs = 50;   // sv_fps 20

void queue_tick() {
    if (!g_ticking) return;
    scheduler::run_on_main([] {
        const uint32_t now = static_cast<uint32_t>(::GetTickCount());
        if (now - g_last_tick_ms >= kTickIntervalMs) {
            g_last_tick_ms = now;
            dispatch_frame(now);
        }
        queue_tick();
    });
}

}  // namespace

const binding_report& bind() {
    if (g_bound) return g_report;
    g_bound = true;

    // The only capability we can honestly bind today: a tick, riding the core
    // scheduler's main-thread pump (see the frame-source note above).
    g_ticking = true;
    g_report.frame_hook = true;
    queue_tick();

    // BIND: verify the remaining addresses here and flip the matching flags.

    ENW_INFO("referee/bind: %s", g_report.describe().c_str());
    if (!g_report.script_vars && !g_report.notify_hook) {
        ENW_WARN(
            "referee/bind: no script-VM access and no notify hook yet, so the referee "
            "ticks but reports nothing. Needs Scr_NotifyNum + gScrVarPub from shared/t4.");
    }
    return g_report;
}

const binding_report& bound() { return g_report; }

void on_notify(notify_sink sink) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    g_notify_sinks.push_back(std::move(sink));
}

void on_frame(frame_sink sink) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    g_frame_sinks.push_back(std::move(sink));
}

// Called by the (future) notify detour and frame detour. Kept here so the
// detours stay three lines each.
void dispatch_notify(const notify_event& ev) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    for (auto& s : g_notify_sinks) s(ev);
}
void dispatch_frame(uint32_t ms) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    for (auto& s : g_frame_sinks) s(ms);
}

// ---------------------------------------------------------------------------
// Accessors. Every one of these is "unavailable" until bind() succeeds.
// ---------------------------------------------------------------------------

std::optional<int> level_int(const char*) { return std::nullopt; }
std::optional<float> level_float(const char*) { return std::nullopt; }
std::optional<bool> level_bool(const char*) { return std::nullopt; }
std::optional<int> level_map_int(const char*, const char*) { return std::nullopt; }
std::optional<float> level_map_float(const char*, const char*) { return std::nullopt; }
bool set_level_int(const char*, int) { return false; }
bool set_level_float(const char*, float) { return false; }
bool set_level_map_float(const char*, const char*, float) { return false; }

std::optional<int> player_int(int, const char*) { return std::nullopt; }
std::optional<float> player_float(int, const char*) { return std::nullopt; }
bool player_field_defined(int, const char*) { return false; }
bool set_player_int(int, const char*, int) { return false; }
std::optional<bool> level_flag(const char*) { return std::nullopt; }

int max_clients() { return g_report.clients ? 4 : 0; }
std::optional<client_view> client(int) { return std::nullopt; }
std::optional<usercmd_view> last_usercmd(int) { return std::nullopt; }

std::optional<ent_view> player_ent(int) { return std::nullopt; }
size_t zombie_ents(ent_view*, size_t) { return 0; }
std::optional<std::string> ent_string_field(int, const char*) { return std::nullopt; }
std::optional<int> ent_int_field(int, const char*) { return std::nullopt; }

bool server_say(int, const std::string&) { return false; }
bool console_command(const std::string&) { return false; }

std::optional<std::string> dvar_get(const char*) { return std::nullopt; }
bool dvar_set(const char*, const char*) { return false; }

}  // namespace enw::referee
