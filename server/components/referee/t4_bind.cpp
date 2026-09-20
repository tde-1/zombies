// Late binding to T4. See t4_bind.hpp for why this exists.
//
// BOUND (2026-09-20, after `re` published the server-side sites):
//   frame    SV_Frame 0x635CC0 -- the server frame, which is where the referee and
//            the replay sampler belong. Com_Frame 0x59E330 is the global tick, but
//            in dedicated mode the engine never reaches WinMain's loop (the renderer
//            bring-up at 0x5FF4E0 runs first and is not gated by com_dedicated), so
//            SV_Frame is both the more correct home and the one that actually fires.
//   clients  svs.clients[i] at 0x2547090 + i*0x58D30; name +0x11548, userinfo +0x6F0,
//            gentity +0x11544.
//   entities g_entities[i] at 0x176C6F0 + i*0x378. The origin/angles offsets inside
//            entityShared_t are NOT published, so rather than guess we find them at
//            runtime and prove them -- see find_origin_offset().
//   servercmd SV_GameSendServerCommand 0x648490 (ecx = clientNum, -1 = broadcast).
//
// STILL MISSING, and it is the same two things as before:
//   1. Scr_NotifyNum / the VM notify opcode -- every GSC flag_set() is a level notify
//      (referee.md 2.8), so this is what turns flags and easter eggs on.
//   2. Script variable access (gScrVarPub, FindVariable, the canonical string table,
//      the `level` object id) -- level.round_number, level.intermission, player.score,
//      player.downs, and every knob.
//   Without those the referee can report positions, players and chat, but not rounds.
//
// THE RULE EVERY ACCESSOR STILL FOLLOWS: if it is not bound and proven, return
// nothing. Never dereference on a hope.
#include "t4_bind.hpp"

#include "../../../shared/core/hook.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/memory.hpp"
#include "../../../shared/t4/addresses.hpp"
#include "../../../shared/t4/structs.hpp"

#include <cmath>
#include <cstring>
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

constexpr int kMaxClients = 4;   // serverStatic_s.clients[4]

uintptr_t svs_base() { return at(t4::var::svs); }
uintptr_t client_at(int i) {
    return svs_base() + t4::svs_off::clients + static_cast<size_t>(i) * t4::client_off::stride;
}
uintptr_t gentity_at(int i) {
    return at(t4::var::g_entities) + static_cast<size_t>(i) * t4::gentity_off::stride;
}

template <typename T>
bool peek(uintptr_t addr, T* out) {
    if (!memory::is_readable(reinterpret_cast<void*>(addr), sizeof(T))) return false;
    std::memcpy(out, reinterpret_cast<const void*>(addr), sizeof(T));
    return true;
}

std::string peek_string(uintptr_t addr, size_t max) {
    if (!memory::is_readable(reinterpret_cast<void*>(addr), max)) return {};
    const char* p = reinterpret_cast<const char*>(addr);
    size_t n = 0;
    while (n < max && p[n]) ++n;
    return std::string(p, n);
}

// ------------------------------------------------------- origin discovery --
//
// gentity_s.r (entityShared_t) is at +0x118 and gentity_s.client at +0x180, so
// currentOrigin is somewhere in that 0x68-byte window -- but the exact offset is
// not in anything `re` has published and not in the T4SP headers we are allowed
// to use. Guessing it would mean reading three arbitrary floats every frame and
// calling them a position.
//
// Instead: scan the window for a triple of finite floats inside the worldspace
// bounds, remember the candidates, and on a later frame keep only the ones that
// actually CHANGED while the player moved. A position is the thing that moves.
// The winner is logged once, so the offset becomes a measured fact `re` can fold
// into shared/t4 rather than a constant someone has to trust.
constexpr size_t kScanBegin = t4::gentity_off::r;        // 0x118
constexpr size_t kScanEnd = t4::gentity_off::client;     // 0x180
constexpr float kWorldMax = 131072.0f;                   // T4 worldspace half-extent

int g_origin_off = -1;          // resolved offset into gentity_s, or -1
bool g_origin_logged = false;
float g_cand_prev[64][3]{};
bool g_cand_valid[64]{};
int g_cand_count = 0;
size_t g_cand_off[64]{};

bool plausible(const float v[3]) {
    for (int i = 0; i < 3; ++i) {
        if (!std::isfinite(v[i]) || v[i] > kWorldMax || v[i] < -kWorldMax) return false;
    }
    // All-zero is the uninitialised case, not a position.
    return !(v[0] == 0.0f && v[1] == 0.0f && v[2] == 0.0f);
}

// Scan across MANY entities, not just the local player. An unattended capture has
// a player standing still at spawn, so "the triple that moved" would never resolve
// off one entity. Zombies walk constantly, so summing motion over the whole entity
// array finds the origin within a couple of seconds of the first round starting.
constexpr int kEntScan = 128;        // entities to sample per pass
constexpr int kNeedHits = 24;        // motion observations before a candidate counts
constexpr int kNeedPasses = 120;     // ~6 s at 20 Hz before we judge by spread
constexpr float kMinOriginSpread = 800.0f;  // angles never exceed 720; a map does

int g_cand_hits[64]{};
int g_passes = 0;
float g_cand_lo[64][3];
float g_cand_hi[64][3];
bool g_range_init[64]{};

// Widest observed extent of any component of this candidate, across every entity
// and every pass. currentAngles can only ever span 720; a real map spans thousands.
float spread(int i) {
    if (!g_range_init[i]) return 0.0f;
    float best = 0.0f;
    for (int k = 0; k < 3; ++k) {
        const float d = g_cand_hi[i][k] - g_cand_lo[i][k];
        if (d > best) best = d;
    }
    return best;
}

void find_origin_offset() {
    if (g_origin_off >= 0) return;

    // Pass 0: EVERY 4-byte offset in the window is a candidate.
    //
    // The first version seeded candidates only where the player's entity already
    // held a plausible float triple, and that silently excluded the right answer:
    // at the instant gclient first becomes non-null the player has not spawned, so
    // currentOrigin is still (0,0,0), `plausible` rejected it, and +0x160 was never
    // reconsidered (measured 01:44 -- it kept only +0x118 and +0x11C, with zero
    // motion hits). Seeding unconditionally costs 26 candidates instead of 2 and
    // removes the dependency on WHEN the first sample happens.
    if (g_cand_count == 0) {
        for (size_t o = kScanBegin; o + 12 <= kScanEnd && g_cand_count < 64; o += 4) {
            g_cand_off[g_cand_count] = o;
            g_cand_valid[g_cand_count] = true;
            ++g_cand_count;
        }
        return;
    }

    // Later passes: for every candidate offset, count how many entities showed a
    // sane amount of movement since last pass. A bounding box does not move on its
    // own; a counter aliased as a float jumps absurdly; a position walks.
    ++g_passes;
    static float prev[64][kEntScan][3];
    static bool prev_ok[64][kEntScan];

    for (int i = 0; i < g_cand_count; ++i) {
        if (!g_cand_valid[i]) continue;
        for (int e = 0; e < kEntScan; ++e) {
            float v[3];
            if (!peek(gentity_at(e) + g_cand_off[i], &v) || !plausible(v)) {
                prev_ok[i][e] = false;
                continue;
            }
            if (prev_ok[i][e]) {
                const float d = std::fabs(v[0] - prev[i][e][0]) + std::fabs(v[1] - prev[i][e][1]) +
                                std::fabs(v[2] - prev[i][e][2]);
                if (d > 0.01f && d < 500.0f) {
                    ++g_cand_hits[i];
                } else if (d >= 500.0f) {
                    // Absurd jump: not a position. Disqualify the offset outright.
                    g_cand_valid[i] = false;
                    break;
                }
            }
            if (!g_range_init[i]) {
                std::memcpy(g_cand_lo[i], v, sizeof(v));
                std::memcpy(g_cand_hi[i], v, sizeof(v));
                g_range_init[i] = true;
            } else {
                for (int k = 0; k < 3; ++k) {
                    if (v[k] < g_cand_lo[i][k]) g_cand_lo[i][k] = v[k];
                    if (v[k] > g_cand_hi[i][k]) g_cand_hi[i][k] = v[k];
                }
            }
            std::memcpy(prev[i][e], v, sizeof(v));
            prev_ok[i][e] = true;
        }
    }

    // MEASURED 2026-09-20 01:35: motion alone narrows 64 candidates to exactly 2 and
    // then stalls, because entityShared_t holds currentOrigin AND currentAngles and
    // both move. They are trivially separable by RANGE: angles live in +-360, an
    // origin roams thousands of units across a map. So once motion has done its
    // job, pick by spread and log both so `re` can check the pair, not just the winner.
    if (g_passes >= kNeedPasses) {
        int winner = -1;
        float winner_spread = 0.0f;
        int alive_n = 0;
        for (int i = 0; i < g_cand_count; ++i) {
            if (!g_cand_valid[i] || g_cand_hits[i] < kNeedHits) continue;
            ++alive_n;
            const float sp = spread(i);
            if (sp > winner_spread) {
                winner_spread = sp;
                winner = i;
            }
        }
        if (winner >= 0 && winner_spread > kMinOriginSpread) {
            g_origin_off = static_cast<int>(g_cand_off[winner]);
            if (!g_origin_logged) {
                g_origin_logged = true;
                for (int i = 0; i < g_cand_count; ++i) {
                    if (!g_cand_valid[i] || g_cand_hits[i] < kNeedHits) continue;
                    ENW_INFO("referee/bind:   candidate +0x%X (r+0x%X) spread %.0f hits %d%s",
                             static_cast<unsigned>(g_cand_off[i]),
                             static_cast<unsigned>(g_cand_off[i] - t4::gentity_off::r), spread(i),
                             g_cand_hits[i], i == winner ? "   <== ORIGIN" : "   (angles?)");
                }
                const bool agrees = g_origin_off == static_cast<int>(t4::gentity_off::currentOrigin);
                ENW_INFO("referee/bind: CROSS-CHECK gentity_s currentOrigin: runtime motion+spread "
                         "says +0x%X, shared/t4 says +0x%X -> %s  (%d moving candidates, spread "
                         "%.0f units, %d entities, %d passes)",
                         g_origin_off, static_cast<unsigned>(t4::gentity_off::currentOrigin),
                         agrees ? "AGREE" : "*** DISAGREE - re please look ***", alive_n,
                         winner_spread, kEntScan, g_passes);
            }
        } else if (g_passes == kNeedPasses) {
            ENW_WARN("referee/bind: origin unresolved after %d passes; %d candidates moved but none "
                     "had a spread over %.0f units. Positions stay unavailable rather than guessed.",
                     g_passes, alive_n, kMinOriginSpread);
            for (int i = 0; i < g_cand_count; ++i) {
                if (!g_cand_valid[i]) continue;
                ENW_WARN("referee/bind:   cand +0x%X hits %d spread %.1f",
                         static_cast<unsigned>(g_cand_off[i]), g_cand_hits[i], spread(i));
            }
        }
    }
}

// ------------------------------------------------------------ frame hooks --
enw::hook g_sv_frame_hook;
using SV_Frame_t = void(__cdecl*)();

void __cdecl sv_frame_detour() {
    g_sv_frame_hook.original<SV_Frame_t>()();
    // After the server frame: the world is in a consistent post-think state.
    dispatch_frame(game_link::now_ms());
}

// ------------------------------------------------------------- server cmd --
// SV_GameSendServerCommand(clientNum in ecx, int type, const char* text).
// clientNum -1 broadcasts. __fastcall gives us ecx; edx is unused by the callee
// so passing a dummy is safe.
using SV_GameSendServerCommand_t = void(__fastcall*)(int clientNum, int edx, int type,
                                                     const char* text);

// ---------------------------------------------------------------- notifies --
// VM_Notify(EAX = scriptInstance; stack: notifyListOwnerId, stringValue, top).
// `re` 2026-09-20: the deepest chokepoint, 2 callers, sees every notify with its
// name id. A `level notify(x)` is ownerId == *(u32*)levelId_server.
//
// EAX is an argument, so this needs a naked thunk: MSVC has no calling convention
// that puts a parameter in EAX. The thunk captures EAX, forwards the three stack
// args to a normal cdecl handler, and then jumps to the trampoline with the stack
// exactly as the engine left it.
enw::hook g_vm_notify_hook;
void* g_vm_notify_trampoline = nullptr;

uint64_t g_notify_total = 0;
uint64_t g_notify_level = 0;

int g_notify_logged = 0;

void __cdecl vm_notify_observe(int instance, int ownerId, int stringValue) {
    ++g_notify_total;
    const uint32_t levelId = *reinterpret_cast<uint32_t*>(at(t4::var::levelId_server));
    // MEASURED 01:53: the hook fires (10,119 notifies in one minute) but NOTHING
    // matched ownerId == levelId, so one of three assumptions is wrong: the stack
    // offsets in the thunk, EAX being the script instance, or levelId_server being
    // the right global. Dump the raw tuples so `re` can see which, rather than me
    // guessing at it.
    if (g_notify_logged < 24) {
        ++g_notify_logged;
        ENW_INFO("referee/notify[%d]: instance=%d ownerId=0x%08X stringValue=0x%08X levelId=0x%08X",
                 g_notify_logged, instance, static_cast<unsigned>(ownerId),
                 static_cast<unsigned>(stringValue), levelId);
    }
    notify_event ev;
    ev.game_ms = game_link::now_ms();
    ev.name_id = stringValue;
    if (instance == 0 && static_cast<uint32_t>(ownerId) == levelId) {
        ev.who = notify_event::owner::level;
        ++g_notify_level;
    } else {
        ev.who = notify_event::owner::unknown;
    }
    ev.owner_id = ownerId;
    dispatch_notify(ev);
}

__declspec(naked) void vm_notify_detour() {
    __asm {
        pushad
        pushfd
        // stack now: flags(4) + regs(32) + retaddr(4) then args
        mov  ecx, [esp + 0x28]      // arg0 notifyListOwnerId
        mov  edx, [esp + 0x2C]      // arg1 stringValue
        push edx
        push ecx
        push eax                    // scriptInstance, passed to us in EAX
        call vm_notify_observe
        add  esp, 12
        popfd
        popad
        cmp  dword ptr [g_vm_notify_trampoline], 0
        je   no_trampoline
        jmp  [g_vm_notify_trampoline]
no_trampoline:
        ret
    }
}

// ------------------------------------------------------------ chat capture --
// G_Say(gentity_s* ent, gentity_s* target, int mode, const char* chatText) --
// the "%s: " formatter both `say` and `say_team` land in. Hooking here rather
// than ClientCommand gets us the text as a plain argument instead of needing
// Cmd_Argv, which is not published.
enw::hook g_say_hook;
using G_Say_t = void(__cdecl*)(void* ent, void* target, int mode, const char* text);
chat_sink g_chat_sink;

int entnum_of(void* ent) {
    const uintptr_t base = at(t4::var::g_entities);
    const uintptr_t p = reinterpret_cast<uintptr_t>(ent);
    if (p < base) return -1;
    const uintptr_t off = p - base;
    if (off % t4::gentity_off::stride) return -1;
    const int n = static_cast<int>(off / t4::gentity_off::stride);
    return n >= 0 && n < 1024 ? n : -1;
}

void __cdecl g_say_detour(void* ent, void* target, int mode, const char* text) {
    if (g_chat_sink && text) {
        // mode: EXE_SAY vs EXE_SAYTEAM. The enum value is not published, so report
        // the raw mode alongside a best-guess bool rather than pretend to know.
        g_chat_sink(entnum_of(ent), text, mode != 0);
    }
    g_say_hook.original<G_Say_t>()(ent, target, mode, text);
}

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
    add("chatin", chat_capture);
    add("dvars", dvars);
    add("frame", frame_hook);
    return s;
}

const binding_report& bind() {
    if (g_bound) return g_report;
    g_bound = true;

    // --- frame: SV_Frame, the server tick ---
    const uintptr_t sv_frame = at(t4::fn::SV_Frame);
    if (memory::is_readable(reinterpret_cast<void*>(sv_frame), 16) &&
        g_sv_frame_hook.create(sv_frame, reinterpret_cast<void*>(&sv_frame_detour), "SV_Frame") &&
        g_sv_frame_hook.enable()) {
        g_report.frame_hook = true;
    } else {
        ENW_WARN("referee/bind: could not hook SV_Frame at %08X", static_cast<unsigned>(sv_frame));
    }

    // --- clients / entities: globals, so "bound" means "readable" ---
    g_report.clients = memory::is_readable(reinterpret_cast<void*>(client_at(0)), 0x100);
    g_report.entities =
        memory::is_readable(reinterpret_cast<void*>(at(t4::var::g_entities)), t4::gentity_off::stride);

    // --- chat out ---
    g_report.server_cmd =
        memory::is_readable(reinterpret_cast<void*>(at(t4::fn::SV_GameSendServerCommand)), 16);

    // --- notifies: VM_Notify, the chokepoint every flag_set() passes through ---
    const uintptr_t vm_notify = at(t4::fn::VM_Notify);
    // ORDER MATTERS: store the trampoline BEFORE enabling. enable() makes the
    // detour live immediately, and the naked thunk ends in `jmp [trampoline]` --
    // a notify firing in the gap would jump through a null pointer.
    if (memory::is_readable(reinterpret_cast<void*>(vm_notify), 16) &&
        g_vm_notify_hook.create(vm_notify, reinterpret_cast<void*>(&vm_notify_detour), "VM_Notify")) {
        g_vm_notify_trampoline = g_vm_notify_hook.original<void*>();
    }
    if (g_vm_notify_trampoline && g_vm_notify_hook.enable()) {
        g_report.notify_hook = true;
    } else {
        ENW_WARN("referee/bind: could not hook VM_Notify at %08X", static_cast<unsigned>(vm_notify));
    }

    // --- chat in: DISABLED, the address is wrong ---
    // MEASURED 2026-09-20 01:34: hooking 0x473F10 as
    // G_Say(ent, target, mode, text) fires ~60 times a second in an idle game with
    // an empty text pointer and an unresolvable entity -- so it is NOT G_Say, or
    // not that signature. G_Say is only called when someone types. The hook was
    // producing a flood of empty `chat` events (130 KB in the first 40 s of a
    // capture, drowning everything else), which is exactly the "silently wrong"
    // failure we are trying to avoid, so it is off until `re` re-checks the site.
    // `re`: 0x473F10 was derived from the "%s: " formatter string; that string is
    // probably shared with something on the frame path.
    g_report.chat_capture = false;

    ENW_INFO("referee/bind: %s", g_report.describe().c_str());
    if (!g_report.script_vars && !g_report.notify_hook) {
        ENW_WARN("referee/bind: no script-VM access and no notify hook yet, so rounds, flags and "
                 "score stay dark. Needs Scr_NotifyNum + gScrVarPub from shared/t4.");
    }
    return g_report;
}

const binding_report& bound() { return g_report; }

void on_notify(notify_sink sink) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    g_notify_sinks.push_back(std::move(sink));
}

void on_chat(chat_sink sink) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    g_chat_sink = std::move(sink);
}

void on_frame(frame_sink sink) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    g_frame_sinks.push_back(std::move(sink));
}

void dispatch_notify(const notify_event& ev) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    for (auto& s : g_notify_sinks) s(ev);
}
void dispatch_frame(uint32_t ms) {
    std::lock_guard<std::mutex> lk(g_sinks_mutex);
    for (auto& s : g_frame_sinks) s(ms);
}

// ---------------------------------------------------------------------------
// Script variables: still unavailable. See the file header.
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

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
int max_clients() { return g_report.clients ? kMaxClients : 0; }

std::optional<client_view> client(int slot) {
    if (!g_report.clients || slot < 0 || slot >= kMaxClients) return std::nullopt;
    const uintptr_t c = client_at(slot);
    uintptr_t gent = 0;
    if (!peek(c + t4::client_off::gentity, &gent)) return std::nullopt;

    client_view v;
    v.name = peek_string(c + t4::client_off::name, 32);
    v.userinfo = peek_string(c + t4::client_off::userinfo, 1024);
    // A slot with a gentity and a name is in the game. The connection-state enum
    // offset is not published, so this is the honest test rather than a guessed one.
    v.active = gent != 0 && !v.name.empty();
    if (!v.userinfo.empty()) {
        // userinfo is \key\value\...; pull the steam/xuid key if it is there.
        for (const char* k : {"\\xuid\\", "\\steamid\\", "\\guid\\"}) {
            const size_t p = v.userinfo.find(k);
            if (p == std::string::npos) continue;
            const size_t s = p + std::strlen(k);
            const size_t e = v.userinfo.find('\\', s);
            v.xuid = v.userinfo.substr(s, e == std::string::npos ? std::string::npos : e - s);
            break;
        }
    }
    return v;
}

std::optional<usercmd_view> last_usercmd(int slot) {
    if (!g_report.clients || slot < 0 || slot >= kMaxClients) return std::nullopt;
    t4::usercmd_s cmd{};
    if (!peek(client_at(slot) + t4::client_extra_off::lastUsercmd, &cmd)) return std::nullopt;
    usercmd_view v;
    v.server_time = cmd.serverTime;
    v.buttons = static_cast<int32_t>(cmd.buttons);
    // usercmd_s.angles is int[3] (packed), pitch then yaw.
    v.view_pitch = static_cast<int16_t>(cmd.angles[0] & 0xFFFF);
    v.view_yaw = static_cast<int16_t>(cmd.angles[1] & 0xFFFF);
    v.forwardmove = cmd.forward;
    v.rightmove = cmd.right;
    v.weapon = static_cast<uint8_t>(cmd.weapon);
    return v;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
std::optional<ent_view> player_ent(int slot) {
    if (!g_report.entities || slot < 0 || slot >= kMaxClients) return std::nullopt;
    const uintptr_t ent = gentity_at(slot);

    // The first MAX_CLIENTS entities are the players.
    uintptr_t gclient = 0;
    if (!peek(ent + t4::gentity_off::client, &gclient) || gclient == 0) return std::nullopt;

    // `re` published gentity_s.currentOrigin = +0x160 (2026-09-20). We use it, and
    // keep the runtime discovery running purely as an independent cross-check --
    // agreement between a static offset and a measurement neither derived from the
    // other is the strongest confirmation available, and a disagreement is louder.
    find_origin_offset();

    ent_view v;
    v.entnum = slot;
    if (!peek(ent + t4::gentity_off::currentOrigin, &v.origin)) return std::nullopt;
    peek(ent + t4::gentity_off::currentOrigin + 12, &v.angles);
    peek(ent + t4::gentity_off::health, &v.health);
    v.alive = v.health > 0;
    return v;
}

size_t zombie_ents(ent_view* out, size_t max) {
    // Needs the entity's classname/type and health offsets to tell a zombie from a
    // door. Neither is published, and a replay full of mislabelled entities is
    // worse than one with none.
    (void)out;
    (void)max;
    return 0;
}

std::optional<std::string> ent_string_field(int, const char*) { return std::nullopt; }
std::optional<int> ent_int_field(int, const char*) { return std::nullopt; }

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
bool server_say(int slot, const std::string& text) {
    if (!g_report.server_cmd) return false;
    auto fn = reinterpret_cast<SV_GameSendServerCommand_t>(at(t4::fn::SV_GameSendServerCommand));
    // The engine's own chat print is the `c` server command; type 0 is the normal
    // reliable queue.
    const std::string cmd = "c \"" + text + "\"";
    fn(slot < 0 ? -1 : slot, 0, 0, cmd.c_str());
    return true;
}

bool console_command(const std::string&) {
    // Cbuf_AddText is not in shared/t4 yet.
    return false;
}

std::optional<std::string> dvar_get(const char*) { return std::nullopt; }
bool dvar_set(const char*, const char*) { return false; }

}  // namespace enw::referee
