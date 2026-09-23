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
#include "verified_env.hpp"

#include <atomic>

#include "../../../shared/core/hook.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/memory.hpp"
#include "../../../shared/core/scheduler.hpp"
#include "../../../shared/t4/addresses.hpp"
#include "../../../shared/t4/structs.hpp"

#include <cmath>
#include <cstring>
#include <mutex>

namespace enw::referee {

void dispatch_notify(const notify_event& ev);
void dispatch_frame(uint32_t ms);
void bind_combat();   // replay-events-v1 reads, defined at the bottom of this file

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

// -------------------------------------------------------- script strings --
// `re` 2026-09-20: SL_ConvertToString is inlined everywhere, so there is no
// function to call -- read the table. From the inlined copy inside SetSavedDvar:
//     name = id ? *(char**)0x3702390 + id*0xC + 4 : NULL
// (mt_buffer pointer at 0x3702390, node size 12, text at node+4).
constexpr uintptr_t kScrStringTablePtr = 0x3702390;
constexpr unsigned kMaxScrStringId = 0x10000;   // sanity bound on a script-string id

const char* sl_string(unsigned id) {
    if (id == 0 || id > kMaxScrStringId) return nullptr;
    const uintptr_t pp = at(kScrStringTablePtr);
    if (!memory::is_readable(reinterpret_cast<void*>(pp), sizeof(void*))) return nullptr;
    char* buf = *reinterpret_cast<char**>(pp);
    if (!buf) return nullptr;
    char* node = buf + static_cast<size_t>(id) * 0xC + 4;
    if (!memory::is_readable(node, 2)) return nullptr;
    return node;
}

// A bounded, printable copy. The table is engine data, but an out-of-range id
// would walk us into arbitrary memory, so never trust it past the first NUL or
// past a sane length, and reject anything that is not text.
std::string sl_string_safe(unsigned id, size_t max = 96) {
    const char* p = sl_string(id);
    if (!p) return {};
    if (!memory::is_readable(const_cast<char*>(p), max)) max = 32;
    if (!memory::is_readable(const_cast<char*>(p), max)) return {};
    std::string out;
    for (size_t i = 0; i < max; ++i) {
        const unsigned char c = static_cast<unsigned char>(p[i]);
        if (c == 0) break;
        if (c < 0x20 || c > 0x7E) return {};   // not a script string
        out.push_back(static_cast<char>(c));
    }
    return out;
}

// ------------------------------------------------- level.* enumeration ----
//
// Goal (coordinator 02:20): read level.round_number directly, and dump every
// level.* name once per game so we learn what each map exposes.
//
// I do NOT know the exact bit layout of the variable entry, and after the G_Say
// incident I am not going to chase pointers through a struct I am guessing at.
// So this is written as a HYPOTHESIS TEST that is read-only and self-validating:
//
//   * childVariables is a hash table: FindVariable(parent, name) hashes to a slot
//     and chains by nextSibling. If that is right, then for a child of `level`
//     living in slot i, some simple hash of (name, levelId) must equal i.
//   * the entry is 0x10 bytes with a 24-bit name field at +8, but which bits is
//     unknown -- so try four plausible extractions.
//   * a correct guess yields NAMES THAT ARE REAL SCRIPT IDENTIFIERS
//     ("round_number", "zombie_health", ...). A wrong one yields garbage, which
//     the printable check rejects. The count of hash-consistent, printable names
//     is the score, and the log shows the samples so a human can judge too.
//
// Nothing here writes, dereferences a chased pointer, or is trusted unless it
// scores. If no extraction scores, we say so and level.* stays unavailable.
constexpr size_t kChildVarsOffset = 0x60000;
constexpr uint32_t kChildVarsCount = 0x10000;   // (0x160000-0x60000)/0x10
constexpr size_t kVarEntrySize = 0x10;

bool g_levelvars_done = false;
int g_levelvars_extraction = -1;   // which name-bit extraction won, or -1

uint32_t extract_name(uint32_t w, int mode) {
    switch (mode) {
        case 0: return w & 0xFFFFFFu;
        case 1: return (w >> 8) & 0xFFFFFFu;
        case 2: return w & 0xFFFFu;
        default: return (w >> 16) & 0xFFFFu;
    }
}

void dump_level_vars(uint32_t levelId) {
    if (g_levelvars_done || levelId == 0) return;
    g_levelvars_done = true;
    // 65,536 entries x 4 extractions, each with an is_readable() VirtualQuery, run
    // on the game thread from inside a notify handler. It already told us what it
    // had to (all four extractions score zero), so it is opt-in now rather than
    // something every capture pays for: set ENW_LEVELVARS=1 to re-run it.
    char buf[8]{};
    if (!::GetEnvironmentVariableA("ENW_LEVELVARS", buf, sizeof(buf)) || buf[0] != '1') {
        ENW_INFO("referee/levelvars: skipped (set ENW_LEVELVARS=1 to run the probe); "
                 "all four extractions scored 0 when last run - level.* stays unavailable");
        return;
    }

    const uintptr_t child_base = at(t4::var::gScrVarGlob) + kChildVarsOffset;
    if (!memory::is_readable(reinterpret_cast<void*>(child_base), 0x1000)) {
        ENW_WARN("referee/levelvars: childVariables at %08X not readable; level.* unavailable",
                 static_cast<unsigned>(child_base));
        return;
    }

    int best_mode = -1, best_hits = 0;
    std::string best_sample;
    for (int mode = 0; mode < 4; ++mode) {
        int hits = 0;
        std::string sample;
        for (uint32_t i = 0; i < kChildVarsCount; ++i) {
            const uintptr_t e = child_base + static_cast<size_t>(i) * kVarEntrySize;
            uint32_t w = 0;
            if (!peek(e + 8, &w)) continue;
            const uint32_t name = extract_name(w, mode);
            if (name == 0 || name > kMaxScrStringId) continue;
            // The hash identity we are testing: slot == (name + (parent << 8)) mod size.
            if (((name + (levelId << 8)) & (kChildVarsCount - 1)) != i) continue;
            const std::string n = sl_string_safe(name, 48);
            if (n.size() < 3) continue;
            ++hits;
            if (sample.size() < 240) { sample += n; sample += ' '; }
        }
        ENW_INFO("referee/levelvars: extraction %d -> %d hash-consistent printable names", mode, hits);
        if (hits > best_hits) { best_hits = hits; best_mode = mode; best_sample = sample; }
    }

    if (best_hits < 5) {
        ENW_WARN("referee/levelvars: no extraction scored (best %d). The entry layout or the hash "
                 "is not what I assumed -- level.* stays UNAVAILABLE rather than guessed. "
                 "re: childVars base %08X, levelId %08X, entry 0x10 bytes, name field at +8.",
                 best_hits, static_cast<unsigned>(child_base), levelId);
        return;
    }
    g_levelvars_extraction = best_mode;
    ENW_INFO("referee/levelvars: WINNER extraction %d with %d names. level.* = %s", best_mode,
             best_hits, best_sample.c_str());
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
constexpr int kMaxPasses = 400;      // then stop burning syscalls forever
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
    // This ran every frame over 128 entities x 26 candidates, each guarded by an
    // is_readable() VirtualQuery -- roughly 3,300 syscalls per frame, 200k/second.
    // It is a diagnostic, not a feature (the sampler uses re's +0x160), and after
    // three runs it has been shown to be non-deterministic and not trustworthy as
    // a cross-check, so it is bounded hard and off unless asked for.
    if (g_passes > kMaxPasses) return;

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
        // A 4-byte sliding window over a 3-float triple OVERLAPS ITSELF, so the
        // true origin and its two neighbours all score the same max-spread. First
        // run reported +0x15C purely because the tie-break took the lowest offset.
        // Discriminate properly: for a real origin the THIRD component is Z, which
        // is much flatter than X and Y in any playable map, whereas a window shifted
        // by one float has a large value in that slot.
        int winner = -1;
        float winner_spread = 0.0f, winner_score = -1.0f;
        int alive_n = 0;
        for (int i = 0; i < g_cand_count; ++i) {
            if (!g_cand_valid[i] || g_cand_hits[i] < kNeedHits) continue;
            ++alive_n;
            const float r0 = g_cand_hi[i][0] - g_cand_lo[i][0];
            const float r1 = g_cand_hi[i][1] - g_cand_lo[i][1];
            const float r2 = g_cand_hi[i][2] - g_cand_lo[i][2];
            const float xy = r0 > r1 ? r0 : r1;
            if (xy <= kMinOriginSpread) continue;
            if (r2 >= 0.6f * xy) continue;            // third slot is not a Z
            const float score = (r0 < r1 ? r0 : r1);  // both horizontals should be wide
            if (score > winner_score) {
                winner_score = score;
                winner_spread = spread(i);
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
                // Also say whether re's offset was among the tied candidates at all:
                // "my method cannot discriminate" and "my method disagrees" are very
                // different claims and only one of them is worth their time.
                bool in_tie_set = false;
                for (int i = 0; i < g_cand_count; ++i) {
                    if (g_cand_valid[i] && g_cand_hits[i] >= kNeedHits &&
                        g_cand_off[i] == t4::gentity_off::currentOrigin) {
                        in_tie_set = true;
                    }
                }
                const bool agrees = g_origin_off == static_cast<int>(t4::gentity_off::currentOrigin);
                if (!agrees && in_tie_set) {
                    ENW_WARN("referee/bind: NOTE my pick and shared/t4 both survived the motion "
                             "filter -- treat this as 'cannot discriminate', not 'disagree'.");
                }
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
// (the old __fastcall prototype for 0x648490 is gone: that address was a HUD colour
// routine, and `re` recommends a naked thunk over a typed prototype for the real one)

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
uint32_t g_level_id_learned = 0;   // self-calibrated; see below

// MEASURED 02:08: *(u32*)0x3882BC8 reads ZERO throughout a live game, so the
// published levelId global cannot be used to tell a `level notify` from an entity
// one. The thunk itself is fine -- instance is 0/1 as expected, ownerIds are small
// plausible object ids, and stringValues resolve to real names.
//
// So learn it instead of trusting it: several notifies are only ever fired on
// `level` by the stock scripts, so the first time one of those arrives its ownerId
// IS the level object id. Self-calibrating, verifiable in the log, and it does not
// care whether the global is wrong or simply populated somewhere else.
const char* const kLevelOnlyNotifies[] = {
    "all_players_connected", "between_round_over", "end_game", "intermission",
    "zombie_init_done", "scriptgen_done",
};

void __cdecl vm_notify_observe(int instance, int ownerId, int stringValue) {
    ++g_notify_total;
    // `re` 2026-09-20: levelId is PER SCRIPT INSTANCE --
    //   *(u32*)(gScrVarPub + instance*0x18048 + 0x20)
    // A client-mode game runs script on instance 1, so comparing against the
    // server levelId can never match. Read the one belonging to the instance we
    // were actually called on.
    uint32_t levelId = 0;
    if (instance >= 0 && instance <= 1) {
        const uintptr_t p = at(t4::var::gScrVarPub) +
                            static_cast<size_t>(instance) * t4::var::gScrVarPub_stride + 0x20;
        if (memory::is_readable(reinterpret_cast<void*>(p), 4)) {
            levelId = *reinterpret_cast<uint32_t*>(p);
        }
    }
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
    ev.name = sl_string_safe(static_cast<unsigned>(stringValue));
    if (g_notify_logged == 0) {
        const uintptr_t s0 = at(t4::var::gScrVarPub) + 0x20;
        const uintptr_t s1 = at(t4::var::gScrVarPub) + t4::var::gScrVarPub_stride + 0x20;
        ENW_INFO("referee/bind: levelId[server]=0x%08X levelId[client]=0x%08X (per-instance, re 02:10)",
                 memory::is_readable(reinterpret_cast<void*>(s0), 4) ? *reinterpret_cast<uint32_t*>(s0) : 0xDEADu,
                 memory::is_readable(reinterpret_cast<void*>(s1), 4) ? *reinterpret_cast<uint32_t*>(s1) : 0xDEADu);
    }
    if (g_level_id_learned == 0 && !ev.name.empty()) {
        for (const char* n : kLevelOnlyNotifies) {
            if (ev.name == n) {
                g_level_id_learned = static_cast<uint32_t>(ownerId);
                dump_level_vars(static_cast<uint32_t>(ownerId));
                ENW_INFO("referee/bind: learned level object id = 0x%08X from notify '%s' "
                         "(published global 0x3882BC8 reads 0x%08X). re: that global looks wrong.",
                         g_level_id_learned, n, levelId);
                break;
            }
        }
    }
    // Prefer the engine's own value; fall back to the learned one only if it is 0.
    if (levelId && !g_levelvars_done) dump_level_vars(levelId);
    const uint32_t effective_level = levelId ? levelId : g_level_id_learned;
    if (effective_level && static_cast<uint32_t>(ownerId) == effective_level) {
        ev.who = notify_event::owner::level;
        ++g_notify_level;
    } else {
        ev.who = notify_event::owner::unknown;
    }
    ev.owner_id = ownerId;
    dispatch_notify(ev);
}

// NOTE ON THE ASM BELOW, learned the hard way (control run 03:18: core-only survives
// 200 s, with-components dies at ~70 s, so the crash is ours):
// a naked thunk must ALIGN THE STACK before calling into C++. MSVC will happily
// emit SSE (movaps) in the callee or anything it inlines, and movaps on an
// unaligned address is an access violation -- which is exactly the shape of
// "Unhandled exception caught" arriving tens of seconds in, once the right code
// path happens to be taken. pushad+pushfd+3 pushes leaves esp at entry-48, so
// alignment depends on the caller. Fix: frame it and `and esp, -16`.
__declspec(naked) void vm_notify_detour() {
    __asm {
        pushad
        pushfd
        // stack now: flags(4) + regs(32) + retaddr(4) then args
        mov  ecx, [esp + 0x28]      // arg0 notifyListOwnerId
        mov  edx, [esp + 0x2C]      // arg1 stringValue
        push ebp
        mov  ebp, esp
        and  esp, -16               // align for anything SSE in the callee
        push edx
        push ecx
        push eax                    // scriptInstance, passed to us in EAX
        call vm_notify_observe
        mov  esp, ebp
        pop  ebp
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
// CORRECTED PATH (`re`, 2026-09-20): T4 co-op has no classic say -> G_Say at all;
// chat rides the party/lobby reliable-command system. My first attempt hooked
// 0x473F10 as G_Say and it fired 60x/second in an idle game with empty text --
// retracted. The verifiable route is the function we already use for injection,
// SV_GameSendServerCommand, filtered for the chat token: the server relays player
// chat through it, so it only fires on chat and carries the text.
//
// SANITY CHECK THIS THE SAME WAY: it must stay SILENT in an idle game. The DLL
// logs its capture count, so a non-zero count with nobody typing means wrong again.
// G_Say(gentity_s* ent, gentity_s* target, int mode, const char* chatText) --
// the "%s: " formatter both `say` and `say_team` land in. Hooking here rather
// than ClientCommand gets us the text as a plain argument instead of needing
// Cmd_Argv, which is not published.
chat_sink g_chat_sink;
uint64_t g_chat_captured = 0;
uintptr_t g_sv_game_send = 0;     // 0x5A9350, resolved in bind()
bool g_inject_enabled = false;

int entnum_of(void* ent) {
    const uintptr_t base = at(t4::var::g_entities);
    const uintptr_t p = reinterpret_cast<uintptr_t>(ent);
    if (p < base) return -1;
    const uintptr_t off = p - base;
    if (off % t4::gentity_off::stride) return -1;
    const int n = static_cast<int>(off / t4::gentity_off::stride);
    return n >= 0 && n < 1024 ? n : -1;
}

// ---------------------------------------------------------- chat injection --
// SV_GameSendServerCommand = 0x5A9350 (`re`, verified from its own instructions):
//   clientNum = FIRST STACK ARG   (mov eax,[esp+8] after one push ecx)
//   edx       = text
//   ecx       = svscmd type
//   -1 is genuinely the broadcast sentinel (explicit `cmp eax,-1 / jne` first branch)
//
// `re` has NOT verified stack cleanup and recommends a naked thunk that fixes the
// stack itself rather than a typed prototype. Two convention guesses have already
// cost a crash and a boot failure, so: we set the registers, make the call, and
// restore esp from our own frame pointer afterwards regardless of what the callee
// did with it.
//
// SAFETY, and it decides where this may be called from: the function dereferences
// the sv_maxclients dvar pointer and indexes svs.clients, so it is unsafe before
// dvars exist or before the server is running, and it must run on the main thread
// at a frame boundary -- NEVER from the game-link socket thread. Broadcast (-1)
// skips the client indexing and is the safer path.
__declspec(naked) void call_sv_game_send(int /*clientNum*/, const char* /*text*/, int /*type*/) {
    __asm {
        push ebp
        mov  ebp, esp
        sub  esp, 16
        mov  [ebp-4], ebx
        mov  [ebp-8], esi
        mov  [ebp-12], edi
        mov  eax, [ebp+8]           // clientNum
        mov  edx, [ebp+12]          // text
        mov  ecx, [ebp+16]          // svscmd type
        push eax                    // clientNum is the first STACK argument
        mov  eax, g_sv_game_send
        call eax
        mov  esp, ebp               // restore whatever the callee did to the stack
        sub  esp, 16
        mov  ebx, [ebp-4]
        mov  esi, [ebp-8]
        mov  edi, [ebp-12]
        mov  esp, ebp
        pop  ebp
        ret
    }
}

// ------------------------------------------------- native client fields --
//
// referee.md §16 (2026-09-23). The co-op scoreboard counters are NOT script variables,
// which is why `player_int("score")` returning nullopt (scriptvars=no) zeroed every real
// game's score, kills, downs and revives since the first box game. They are gclient_s
// fields that the engine exposes to GSC through a native field table, so `self.score`
// in a script is a plain int store into the gclient.
//
// Every number below was read off our decrypted dump and is re-checked in THIS process
// at bind time (verify_client_fields); nothing is read unless all of it holds.
//
//   client field table 0x83C568, entries of 0x18: {const char* name; int ofs; int type;
//     int mask; setter; getter}, NUL-name terminated at 0x83C730 (19 entries).  [V]
//     - walked by GScr_AddFieldsForClient 0x4ED1B0 (`mov edi,0x83C568 ... add edi,0x18`)
//     - indexed by Scr_SetClientField 0x4ED200 (`lea eax,[eax*8+0x83C568]` on idx*3)
//   the six entries we read, all type 0 (int), no mask:
//     score 0x20BC (setter 0x4ECEB0), kills 0x20C0, assists 0x20C4, downs 0x20C8,
//     revives 0x20CC, headshots 0x20D0.
//   second signal for the offsets, independent of the table:
//     0x4ECF25  89 B7 BC 20 00 00      mov [edi+0x20BC],esi   the score setter's store
//     0x67CC1C  8B B4 28 D0 20 00 00   mov esi,[eax+ebp+0x20D0] the co-op scoreboard
//               builder pushes 0x20D0/0x20CC/0x20C8/0x20C4/0x20C0 into " %x %x %x ..."
//   gclient_s stride 0x2348: the same builder's `add ebp,0x2348` at 0x67CCB4, and the
//     score setter divides (gclient - level.clients) by it (magic 0x74187D2B, sar 0xC).
//   level.clients = *(gclient_s**)0x18F5D88 (level_locals_t+0; the setter's `mov ebx,[0x18F5D88]`).
namespace cf {
constexpr uintptr_t kTable = 0x83C568;
constexpr size_t kEntry = 0x18;
constexpr int kMaxEntries = 32;
constexpr uintptr_t kScoreStoreSite = 0x4ECF25;
constexpr uintptr_t kScoreboardSite = 0x67CC1C;
constexpr uintptr_t kStrideSite = 0x67CCB4;
constexpr size_t kGclientStride = 0x2348;
constexpr size_t kScore = 0x20BC;   // the six ints are contiguous, in this order
struct raw_stats {
    int32_t score, kills, assists, downs, revives, headshots;
};
static_assert(sizeof(raw_stats) == 24, "raw_stats");
}  // namespace cf

bool bytes_at(uintptr_t vault_va, const uint8_t* want, size_t n) {
    const uintptr_t p = at(vault_va);
    if (!memory::is_readable(reinterpret_cast<void*>(p), n)) return false;
    return std::memcmp(reinterpret_cast<const void*>(p), want, n) == 0;
}

// Re-read the field table and both code sites out of the running image. Returns false
// and says which check failed on anything but an exact match, so a different exe
// build reads nothing rather than reading the wrong ints.
bool verify_client_fields() {
    struct want { const char* name; int32_t ofs; bool seen; };
    want w[] = {{"score", 0x20BC, false},   {"kills", 0x20C0, false},
                {"assists", 0x20C4, false}, {"downs", 0x20C8, false},
                {"revives", 0x20CC, false}, {"headshots", 0x20D0, false}};
    for (int i = 0; i < cf::kMaxEntries; ++i) {
        uint32_t e[3]{};
        if (!peek(at(cf::kTable + i * cf::kEntry), &e)) {
            ENW_WARN("referee/bind: client field table unreadable at entry %d", i);
            return false;
        }
        if (e[0] == 0) break;
        const std::string nm = peek_string(at(e[0]), 32);
        for (auto& x : w) {
            if (nm != x.name) continue;
            if (static_cast<int32_t>(e[1]) != x.ofs || e[2] != 0) {
                ENW_WARN("referee/bind: client field '%s' is ofs=%X type=%u, expected ofs=%X "
                         "type=0 -- a different exe? native stats OFF",
                         x.name, e[1], e[2], static_cast<unsigned>(x.ofs));
                return false;
            }
            x.seen = true;
        }
    }
    for (const auto& x : w) {
        if (!x.seen) {
            ENW_WARN("referee/bind: client field '%s' not in the table at %08X -- native stats OFF",
                     x.name, static_cast<unsigned>(cf::kTable));
            return false;
        }
    }
    static const uint8_t store[] = {0x89, 0xB7, 0xBC, 0x20, 0x00, 0x00};
    static const uint8_t board[] = {0x8B, 0xB4, 0x28, 0xD0, 0x20, 0x00, 0x00};
    static const uint8_t stride[] = {0x81, 0xC5, 0x48, 0x23, 0x00, 0x00};
    if (!bytes_at(cf::kScoreStoreSite, store, sizeof(store)) ||
        !bytes_at(cf::kScoreboardSite, board, sizeof(board)) ||
        !bytes_at(cf::kStrideSite, stride, sizeof(stride))) {
        ENW_WARN("referee/bind: the score-store / scoreboard / stride code sites do not match "
                 "-- native stats OFF");
        return false;
    }
    return true;
}

// The player's gclient_s, cross-checked two ways: g_entities[slot].client (what
// player_ent reads) must equal level.clients + slot * 0x2348. A disagreement means a
// slot in transition or a wrong assumption, and either way nothing is read.
uintptr_t gclient_for(int slot) {
    uintptr_t via_ent = 0, clients = 0;
    if (!peek(gentity_at(slot) + t4::gentity_off::client, &via_ent) || via_ent == 0) return 0;
    if (!peek(at(t4::var::level), &clients) || clients == 0) return 0;
    if (via_ent != clients + static_cast<size_t>(slot) * cf::kGclientStride) {
        static bool said = false;
        if (!said) {
            said = true;
            ENW_WARN("referee: slot %d gentity->client %08X != level.clients %08X + slot*0x2348 "
                     "-- native stats not read for it", slot, static_cast<unsigned>(via_ent),
                     static_cast<unsigned>(clients));
        }
        return 0;
    }
    return via_ent;
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
    add("clientfields", client_fields);
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

    // --- native client fields: score/kills/assists/downs/revives/headshots (§16) ---
    g_report.client_fields = g_report.entities && verify_client_fields();
    ENW_INFO("referee/bind: native client fields (score kills assists downs revives headshots "
             "at gclient+0x20BC..0x20D0) %s",
             g_report.client_fields ? "VERIFIED against the field table and two code sites"
                                    : "NOT bound");

    // --- chat out: the REAL SV_GameSendServerCommand (0x5A9350) ---
    // Off unless asked for. The previous binding pointed at a HUD colour routine and
    // corrupted a ring buffer, so this one does not get switched on by default and
    // its acceptance test is TEXT VISIBLY APPEARING IN THE GAME, not a call returning.
    const uintptr_t svgs = at(t4::fn::SV_GameSendServerCommand);
    if (memory::is_readable(reinterpret_cast<void*>(svgs), 16)) {
        g_sv_game_send = svgs;
        char buf[8]{};
        g_inject_enabled = ::GetEnvironmentVariableA("ENW_CHAT_INJECT", buf, sizeof(buf)) &&
                           buf[0] == '1';
        g_report.server_cmd = g_inject_enabled;
        ENW_INFO("referee/bind: chat injection target %08X %s", static_cast<unsigned>(svgs),
                 g_inject_enabled ? "ENABLED (ENW_CHAT_INJECT=1)"
                                  : "present but DISABLED (set ENW_CHAT_INJECT=1 to test)");
    }

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

    // --- chat in: NO VERIFIED PATH. ---
    // 0x648490 is NOT a server-command function -- `re` re-read the instructions and
    // it is a HUD/debug coloured-text routine (resolves an RGBA via 0x47A450, then
    // 0x6F5F10 strlen's into a ring buffer at 0x3DCB4C0). My capture hook sat on it
    // and my injection called it, which is what corrupted that buffer and killed the
    // game about a minute later. Both are gone. T4 co-op chat rides the party/lobby
    // reliable-command system and no capture site is verified yet, so capture stays
    // OFF rather than hooked to the next plausible-looking address.
    g_report.chat_capture = false;

    // --- old chat note ---
    // MEASURED 2026-09-20 01:34: hooking 0x473F10 as
    // G_Say(ent, target, mode, text) fires ~60 times a second in an idle game with
    // an empty text pointer and an unresolvable entity -- so it is NOT G_Say, or
    // not that signature. G_Say is only called when someone types. The hook was
    // producing a flood of empty `chat` events (130 KB in the first 40 s of a
    // capture, drowning everything else), which is exactly the "silently wrong"
    // failure we are trying to avoid, so it is off until `re` re-checks the site.
    // `re`: 0x473F10 was derived from the "%s: " formatter string; that string is
    // probably shared with something on the frame path.

    bind_combat();

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

uint64_t chat_capture_count() { return g_chat_captured; }

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
// The native scoreboard fields answer; any other player field is a script variable and
// still does not.
std::optional<int> player_int(int slot, const char* field) {
    if (!field) return std::nullopt;
    const auto s = player_stats(slot);
    if (!s) return std::nullopt;
    if (std::strcmp(field, "score") == 0) return s->score;
    if (std::strcmp(field, "kills") == 0) return s->kills;
    if (std::strcmp(field, "assists") == 0) return s->assists;
    if (std::strcmp(field, "downs") == 0) return s->downs;
    if (std::strcmp(field, "revives") == 0) return s->revives;
    if (std::strcmp(field, "headshots") == 0) return s->headshots;
    return std::nullopt;
}

std::optional<client_stats> player_stats(int slot) {
    if (!g_report.client_fields || slot < 0 || slot >= kMaxClients) return std::nullopt;
    const uintptr_t gc = gclient_for(slot);
    if (!gc) return std::nullopt;
    cf::raw_stats r{};
    if (!peek(gc + cf::kScore, &r)) return std::nullopt;
    // Counters, so never negative, and a score of a billion is not a zombies game. A value
    // outside that is a slot mid-reset or a wrong read, and a wrong number in a result is
    // worse than a missing one.
    const int32_t* v = &r.score;
    for (int i = 0; i < 6; ++i) {
        if (v[i] < 0 || v[i] > 100000000) return std::nullopt;
    }
    client_stats s;
    s.score = r.score;
    s.kills = r.kills;
    s.assists = r.assists;
    s.downs = r.downs;
    s.revives = r.revives;
    s.headshots = r.headshots;
    return s;
}
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
    if (!g_report.entities || !out || max == 0) return 0;
    size_t n = 0;
    // Entities 0..3 are the players. T4 AI classnames are actor_* (the zombie
    // spawner on the stock maps is actor_axis_zombie_*), so classname is the
    // discriminator now that script strings resolve.
    for (int e = kMaxClients; e < 1024 && n < max; ++e) {
        const uintptr_t ent = gentity_at(e);
        uint16_t cls = 0;
        if (!peek(ent + t4::gentity_off::classname, &cls) || cls == 0) continue;
        const char* name = sl_string(cls);
        if (!name || !memory::is_readable(const_cast<char*>(name), 6)) continue;
        if (std::strncmp(name, "actor", 5) != 0) continue;
        int health = 0;
        if (!peek(ent + t4::gentity_off::health, &health) || health <= 0) continue;
        ent_view v;
        v.entnum = e;
        if (!peek(ent + t4::gentity_off::currentOrigin, &v.origin)) continue;
        peek(ent + t4::gentity_off::currentOrigin + 12, &v.angles);
        v.health = health;
        v.alive = true;
        out[n++] = v;
    }
    return n;
}

size_t classname_ents(const char* prefix, ent_view* out, size_t max) {
    if (!g_report.entities || !out || max == 0 || !prefix) return 0;
    const size_t plen = std::strlen(prefix);
    size_t n = 0;
    for (int e = kMaxClients; e < 1024 && n < max; ++e) {
        const uintptr_t ent = gentity_at(e);
        uint16_t cls = 0;
        if (!peek(ent + t4::gentity_off::classname, &cls) || cls == 0) continue;
        const char* name = sl_string(cls);
        if (!name || !memory::is_readable(const_cast<char*>(name), plen + 1)) continue;
        if (std::strncmp(name, prefix, plen) != 0) continue;
        ent_view v;
        v.entnum = e;
        if (!peek(ent + t4::gentity_off::currentOrigin, &v.origin)) continue;
        peek(ent + t4::gentity_off::currentOrigin + 12, &v.angles);
        peek(ent + t4::gentity_off::health, &v.health);
        v.alive = true;
        v.classname = name;
        out[n++] = v;
    }
    return n;
}

void classname_census(void (*fn)(const char* classname, int entnum)) {
    if (!g_report.entities || !fn) return;
    static uint16_t seen[256];
    static size_t nseen = 0;
    for (int e = kMaxClients; e < 1024; ++e) {
        uint16_t cls = 0;
        if (!peek(gentity_at(e) + t4::gentity_off::classname, &cls) || cls == 0) continue;
        bool old = false;
        for (size_t i = 0; i < nseen; ++i) if (seen[i] == cls) { old = true; break; }
        if (old) continue;
        if (nseen < sizeof(seen) / sizeof(seen[0])) seen[nseen++] = cls;
        else return;   // a full census table is the end of the census, not an overflow
        const char* name = sl_string(cls);
        if (!name || !memory::is_readable(const_cast<char*>(name), 2)) continue;
        fn(name, e);
    }
}

std::optional<std::string> ent_string_field(int entnum, const char* field) {
    if (!g_report.entities || entnum < 0 || entnum >= 1024) return std::nullopt;
    size_t off = 0;
    if (!std::strcmp(field, "classname")) off = t4::gentity_off::classname;
    else if (!std::strcmp(field, "targetname")) off = t4::gentity_off::targetname;
    else return std::nullopt;   // script-side fields need the variable system
    uint16_t id = 0;
    if (!peek(gentity_at(entnum) + off, &id) || id == 0) return std::nullopt;
    std::string s = sl_string_safe(id);
    if (s.empty()) return std::nullopt;
    return s;
}

std::optional<int> ent_int_field(int entnum, const char* field) {
    if (!g_report.entities || entnum < 0 || entnum >= 1024) return std::nullopt;
    if (!std::strcmp(field, "health")) {
        int h = 0;
        if (!peek(gentity_at(entnum) + t4::gentity_off::health, &h)) return std::nullopt;
        return h;
    }
    return std::nullopt;   // zombie_cost etc. are script fields
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
bool server_say(int slot, const std::string& text) {
    if (!g_inject_enabled || !g_sv_game_send) return false;

    // MUST be on the game thread at a frame boundary: the callee dereferences the
    // sv_maxclients dvar pointer and indexes svs.clients. Coming from the game-link
    // socket thread would be a use of engine state from the wrong thread, which is
    // how the last two crashes started. Queue it instead.
    if (!scheduler::on_main_thread()) {
        const int s = slot;
        const std::string t = text;
        scheduler::run_on_main([s, t] { server_say(s, t); });
        return true;
    }

    // And not before the server exists. svs.clients is only meaningful once a map
    // is running; broadcast (-1) skips the indexing entirely, so prefer it.
    if (!g_report.entities) return false;

    const std::string cmd = "c \"" + text + "\"";
    call_sv_game_send(slot < 0 ? -1 : slot, cmd.c_str(), 0);
    ENW_INFO("referee: injected chat (slot %d): %s", slot, text.c_str());
    return true;
}

// --------------------------------------------------------- console commands --
//
// `console_command()` used to be `return false;` with the note "Cbuf_AddText is not
// in shared/t4 yet". That mattered more than it looked: `map_restart` is the only
// thing the referee can do when the host answers `match_end` with `end`, and it has
// never once been issued. Every "referee: host asked to end the game -> map_restart"
// line ever logged was a lie by omission.
//
// **Cbuf_AddText = 0x594200**, and this is a non-cdecl, register-argument function,
// so it is stated the way docs/re/t4-sp-map.md asks for. TWO independent signals:
//
//   prologue (0x594200)        push ebp / push esi / push edi
//                              push 0x22990F8 ; call [0x7EB138] EnterCriticalSection
//                              mov esi, eax   <- argument 1: const char* text
//                              mov edi, ecx   <- argument 2: int localClient
//   a call site (0x636157)     add esp, 8 / xor ecx, ecx / call 0x594200
//                              i.e. ecx is set to 0 immediately before the call, and
//                              nothing is pushed for it.
//
// It takes NOTHING on the stack (it pushes and pops three registers and `ret`s with
// no immediate), so a wrong guess here cannot unbalance the caller -- which is the
// specific risk that made dedi refuse to stub 0x605500 and friends.
//
// It must run on the GAME THREAD: it enters the command buffer's critical section
// and appends to a per-local-client ring at 0x1F529BC + n*0x30. Off-thread it would
// be safe against corruption but would still execute engine work from the socket
// thread, so it is queued like server_say().
//
// `re`: this belongs in shared/t4/addresses.hpp as t4::fn::Cbuf_AddText with the
// convention written down. It is here only because that file is yours.
constexpr uintptr_t kCbuf_AddText = 0x594200;

// `push ebp / push esi / push edi / push 0x22990F8` -- the first eight bytes.
constexpr uint8_t kCbufSig[] = {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02};

bool g_cbuf_checked = false;
bool g_cbuf_ok = false;

bool cbuf_available() {
    if (g_cbuf_checked) return g_cbuf_ok;
    g_cbuf_checked = true;
    const uintptr_t fn = at(kCbuf_AddText);
    uint8_t got[sizeof kCbufSig] = {};
    if (!memory::read_raw(fn, got, sizeof got) ||
        std::memcmp(got, kCbufSig, sizeof got) != 0) {
        ENW_ERROR("referee/bind: Cbuf_AddText 0x%08X does not start with the expected "
                  "`push ebp/esi/edi; push 0x22990F8` (%s). Console commands stay "
                  "unavailable; `end` cannot map_restart.",
                  static_cast<unsigned>(kCbuf_AddText), memory::hex_dump(fn, sizeof got).c_str());
        return false;
    }
    g_cbuf_ok = true;
    ENW_INFO("referee/bind: Cbuf_AddText bound at 0x%08X (text in eax, localClient in ecx, "
             "nothing on the stack).", static_cast<unsigned>(kCbuf_AddText));
    return true;
}

// The call itself. Inline asm rather than a typed pointer because MSVC has no
// calling convention that puts arguments in eax and ecx, and inventing a prototype
// for a non-cdecl function is the mistake docs/re/t4-sp-map.md names by name.
// Nothing is pushed and nothing has to be cleaned; edx is caller-saved.
void cbuf_add_text(const char* text, int local_client) {
    const uintptr_t fn = at(kCbuf_AddText);
    __asm {
        mov eax, text
        mov ecx, local_client
        mov edx, fn
        call edx
    }
}

bool console_command(const std::string& cmd) {
    if (cmd.empty()) return false;
    if (!cbuf_available()) return false;

    if (!scheduler::on_main_thread()) {
        const std::string c = cmd;
        scheduler::run_on_main([c] { console_command(c); });
        return true;
    }
    // Cbuf_AddText appends text to be tokenised as console input, so it needs its own
    // terminator. Without the newline the command sits in the buffer until something
    // else happens to add one.
    std::string line = cmd;
    if (line.back() != '\n') line.push_back('\n');
    cbuf_add_text(line.c_str(), 0);
    ENW_INFO("referee: console command queued: %s", cmd.c_str());
    return true;
}

namespace {
std::atomic<int> g_current_round{0};
std::atomic<bool> g_recording{true};
}  // namespace

void set_current_round(int n) { g_current_round.store(n, std::memory_order_relaxed); }
int current_round() { return g_current_round.load(std::memory_order_relaxed); }

void set_recording(bool on) { g_recording.store(on, std::memory_order_relaxed); }
bool recording() { return g_recording.load(std::memory_order_relaxed); }

// dvar_get: READ ONLY, bound 2026-09-23 for the Verified environment report
// (verified_env.hpp, docs/kickstart/verified-rules.md). Everything it relies on is already
// proven elsewhere in this DLL, not guessed here:
//   * Dvar_FindVar 0x5EDE30 [V], called by dedicated.cpp and net_probe.cpp on this server;
//     it returns null (not a fault) before Com_Init has registered the dvars.
//   * dvar_s: type uint16 at +0x0A, current value (16 bytes) at +0x10 -- measured in
//     dedicated.cpp (com_maxfps +0x10 = 85, fs_homepath +0x10 = char*), and net_probe.cpp
//     reads sv_maxRate the same way.
// Types other than int/enum/string are formatted per the CoD4 order those three match, and
// an unknown type comes back raw ("?typeN:...") rather than as a guess.
// dvar_set stays unbound: the referee reports the environment, it does not change it.
std::optional<std::string> dvar_get(const char* name) {
    if (!name || !*name) return std::nullopt;
    static const bool ok = memory::looks_like_function(at(t4::fn::Dvar_FindVar));
    if (!ok) return std::nullopt;
    using find_t = void*(__cdecl*)(const char*);
    void* d = reinterpret_cast<find_t>(at(t4::fn::Dvar_FindVar))(name);
    if (!d) return std::nullopt;
    const auto a = reinterpret_cast<uintptr_t>(d);
    uint16_t type = 0;
    uint8_t raw[16] = {};
    if (!peek(a + 0x0A, &type)) return std::nullopt;
    if (!memory::is_readable(reinterpret_cast<void*>(a + 0x10), sizeof raw)) return std::nullopt;
    std::memcpy(raw, reinterpret_cast<const void*>(a + 0x10), sizeof raw);
    std::string s;
    if (type == verified::T_STRING) {
        uint32_t p = 0;
        std::memcpy(&p, raw, 4);
        if (p) s = peek_string(p, 256);
    }
    return verified::format_value(type, raw, s);
}
bool dvar_set(const char*, const char*) { return false; }

// ---------------------------------------------------------------------------
// replay-events-v1 reads (lane R1, 2026-09-23). docs/protocol/replay-events-v1.md section 5.
//
// Offsets are T4SP-Server-Plugin `main` src/game/structs.hpp (playerState_s, gentity_s,
// sentient_s, actor_s) and every one is ALSO read off an instruction in our own dump, which
// is what bind_combat() re-checks in the running image before anything is read:
//
//   weapons  getcurrentweapon 0x4ED890 (method table 0x83C034):
//              0x4ED906  8B B6 04 01 00 00      mov esi,[esi+0x104]        ps.weapon
//              0x4ED910  8B 14 B5 70 67 8F 00   mov edx,[esi*4+0x8F6770]   bg_weaponDefs[w]
//              then `mov eax,[edx]` -> Scr_AddString: szInternalName is WeaponDef+0
//            getcurrentweaponclipammo 0x4ED960:
//              0x4ED9F4  8B 88 FC 03 00 00      mov ecx,[eax+0x3FC]        def->iClipIndex
//              0x4ED9FA  8B 94 8E FC 05 00 00   mov edx,[esi+ecx*4+0x5FC]  ps.ammoclip[]
//            getweaponammostock 0x4F0B40:
//              0x4F0C29  8B 88 F4 03 00 00      mov ecx,[eax+0x3F4]        def->iAmmoIndex
//              0x4F0C2F  8B 84 8A 7C 01 00 00   mov eax,[edx+ecx*4+0x17C]  ps.ammo[]
//   events   BG_AddPredictableEventToPlayerstate 0x410310 (eax = ps, cl = event):
//              8B 90 D0 00 00 00 0F B6 C9 83 E2 03 89 8C 90 D4 00 00 00
//              = events[eventSequence & 3] = ev; ... eventSequence = (seq + 1) & 0xFF
//            the weapon-fire site 0x420C8A: B9 1D 00 00 00 75 05 B9 1C 00 00 00
//              = ecx = lastShot ? 0x1D : 0x1C, then the no-parm add-event 0x412BF0
//   attacker G_Damage 0x4F5D70 (takedamage +0x19B test first; world ent 0x184A000 = ent 1022):
//              0x4F6511  8B 85 88 01 00 00 85 C0 74 03 89 70 2C
//              = if (targ->sentient) targ->sentient->lastAttacker = attacker
//   hitloc   Actor_Pain 0x4B6870: 0x4B6882 8B 9E 84 01 00 00 (ebx = self->actor),
//              0x4B697D 66 89 83 68 0D 00 00 (actor->damageHitLoc = SL(hitLocName[loc]));
//              Actor_Die 0x4B6AA0 stores the same field at 0x4B6BAD.
//   ads      PlayerCmd_PlayerADS 0x4EEE00 (method table entry 0x83C160, name "playerads"):
//              0x4EEE69  8B 96 80 01 00 00      mov edx,[esi+0x180]        ent->client
//              0x4EEE6F  D9 82 10 01 00 00      fld dword [edx+0x110]      ps.fWeaponPosFrac
//              then Scr_AddFloat -- exactly what the script's playerADS() returns (lane RV)
//   models   G_SetModel 0x54AE60: 0x54AE78 66 89 86 98 01 00 00 (ent->model = G_ModelIndex)
//            G_ModelIndex 0x54A480: 0x54A4B0 0F B7 0C 75 42 0F 35 02 -- compares the name's
//              script string with word[0x2350F40 + i*2], i = 1..0x1FF, i.e. the model
//              configstrings are script strings (SV_SetConfigstring(0x58E + i, name) follows).
// ---------------------------------------------------------------------------
namespace {
combat_binding g_combat;

constexpr uintptr_t kWeaponDefs = 0x8F6770;
constexpr size_t kMaxWeapons = 128;          // ps.ammo[128] / ps.ammoclip[128]
constexpr size_t kPsWeapon = 0x104;
constexpr size_t kPsAmmo = 0x17C;
constexpr size_t kPsAmmoClip = 0x5FC;
constexpr size_t kDefAmmoIndex = 0x3F4;
constexpr size_t kDefClipIndex = 0x3FC;
constexpr size_t kPsWeaponPosFrac = 0x110;  // T4SP playerState_s.fWeaponPosFrac, asserted 0x110
constexpr size_t kPsEventSeq = 0xD0;
constexpr size_t kPsEvents = 0xD4;
constexpr size_t kEntActor = 0x184;
constexpr size_t kEntSentient = 0x188;
constexpr size_t kEntModel = 0x198;
constexpr size_t kSentientLastAttacker = 0x2C;
constexpr size_t kActorHitLoc = 0xD68;
constexpr uintptr_t kModelNames = 0x2350F40;   // uint16 script-string id per model index
constexpr int kMaxModels = 0x200;

struct code_sig { uintptr_t va; std::vector<uint8_t> bytes; };

bool sigs_match(const char* group, std::initializer_list<code_sig> sigs) {
    for (const auto& s : sigs) {
        if (!bytes_at(s.va, s.bytes.data(), s.bytes.size())) {
            ENW_WARN("referee/bind: replay-events '%s' OFF -- the code at %08X is not what lane R1 "
                     "read off the dump (%s). A different exe? Nothing in this group is read.",
                     group, static_cast<unsigned>(s.va), memory::hex_dump(at(s.va), s.bytes.size()).c_str());
            return false;
        }
    }
    return true;
}

// Weapon names by index, per match (the defs are loaded with the map).
std::string g_weapon_names[kMaxWeapons];
bool g_weapon_named[kMaxWeapons] = {};
// Model names by model index, per match; empty + resolved = not a name we could read.
std::string g_model_names[kMaxModels];
bool g_model_resolved[kMaxModels] = {};
uint16_t g_script_model_cls = 0;   // the script-string id of "script_model", learned per match
uint8_t g_cls_not_model[0x10000] = {};

uintptr_t weapon_def(int w) {
    if (w <= 0 || static_cast<size_t>(w) >= kMaxWeapons) return 0;
    uintptr_t def = 0;
    if (!peek(at(kWeaponDefs) + static_cast<size_t>(w) * 4, &def) || def == 0) return 0;
    return def;
}

const std::string& weapon_name(int w) {
    static const std::string none;
    if (w <= 0 || static_cast<size_t>(w) >= kMaxWeapons) return none;
    if (!g_weapon_named[w]) {
        g_weapon_named[w] = true;
        uintptr_t def = weapon_def(w), name = 0;
        if (def && peek(def, &name) && name) {
            std::string s = peek_string(name, 64);
            bool ok = !s.empty();
            for (char c : s) if (static_cast<unsigned char>(c) < 0x21 || static_cast<unsigned char>(c) > 0x7E) ok = false;
            if (ok) g_weapon_names[w] = s;
        }
    }
    return g_weapon_names[w];
}

int entnum_of_ptr(uintptr_t p) {
    if (!p) return -1;
    return entnum_of(reinterpret_cast<void*>(p));
}

int last_attacker_of(uintptr_t ent) {
    if (!g_combat.attacker) return -1;
    uintptr_t sent = 0, att = 0;
    if (!peek(ent + kEntSentient, &sent) || !sent) return -1;
    if (!peek(sent + kSentientLastAttacker, &att) || !att) return -1;
    return entnum_of_ptr(att);
}

const std::string& model_name(int idx) {
    static const std::string none;
    if (idx <= 0 || idx >= kMaxModels) return none;
    if (!g_model_resolved[idx]) {
        uint16_t id = 0;
        if (peek(at(kModelNames) + static_cast<size_t>(idx) * 2, &id) && id) {
            g_model_names[idx] = sl_string_safe(id, 64);
            // A slot not yet filled reads 0 and stays unresolved, so a model precached later
            // in the match is still picked up the first time an entity uses it.
            g_model_resolved[idx] = true;
        }
    }
    return g_model_names[idx];
}
}  // namespace

std::string combat_binding::describe() const {
    std::string s;
    auto add = [&s](const char* n, bool v) {
        if (!s.empty()) s += ' ';
        s += n;
        s += v ? "=yes" : "=no";
    };
    add("weapons", weapons);
    add("events", events);
    add("attacker", attacker);
    add("hitloc", hitloc);
    add("models", models);
    add("ads", ads);
    return s;
}

const combat_binding& combat_bound() { return g_combat; }

void bind_combat() {
    if (!g_report.entities) {
        ENW_WARN("referee/bind: replay-events reads OFF (entities not bound)");
        return;
    }
    g_combat.weapons = sigs_match("weapons", {
        {0x4ED906, {0x8B, 0xB6, 0x04, 0x01, 0x00, 0x00}},
        {0x4ED910, {0x8B, 0x14, 0xB5, 0x70, 0x67, 0x8F, 0x00}},
        {0x4ED9F4, {0x8B, 0x88, 0xFC, 0x03, 0x00, 0x00}},
        {0x4ED9FA, {0x8B, 0x94, 0x8E, 0xFC, 0x05, 0x00, 0x00}},
        {0x4F0C29, {0x8B, 0x88, 0xF4, 0x03, 0x00, 0x00}},
        {0x4F0C2F, {0x8B, 0x84, 0x8A, 0x7C, 0x01, 0x00, 0x00}},
    });
    g_combat.events = sigs_match("events", {
        {0x410310, {0x8B, 0x90, 0xD0, 0x00, 0x00, 0x00, 0x0F, 0xB6, 0xC9, 0x83, 0xE2, 0x03,
                    0x89, 0x8C, 0x90, 0xD4, 0x00, 0x00, 0x00}},
        {0x420C8A, {0xB9, 0x1D, 0x00, 0x00, 0x00, 0x75, 0x05, 0xB9, 0x1C, 0x00, 0x00, 0x00}},
    });
    g_combat.attacker = sigs_match("attacker", {
        {0x4F6511, {0x8B, 0x85, 0x88, 0x01, 0x00, 0x00, 0x85, 0xC0, 0x74, 0x03, 0x89, 0x70, 0x2C}},
    });
    g_combat.hitloc = sigs_match("hitloc", {
        {0x4B6882, {0x8B, 0x9E, 0x84, 0x01, 0x00, 0x00}},
        {0x4B697D, {0x66, 0x89, 0x83, 0x68, 0x0D, 0x00, 0x00}},
    });
    g_combat.models = sigs_match("models", {
        {0x54AE78, {0x66, 0x89, 0x86, 0x98, 0x01, 0x00, 0x00}},
        {0x54A4B0, {0x0F, 0xB7, 0x0C, 0x75, 0x42, 0x0F, 0x35, 0x02}},
    });
    g_combat.ads = sigs_match("ads", {
        {0x4EEE69, {0x8B, 0x96, 0x80, 0x01, 0x00, 0x00, 0xD9, 0x82, 0x10, 0x01, 0x00, 0x00}},
    });
    ENW_INFO("referee/bind: replay-events reads: %s", g_combat.describe().c_str());
}

void combat_new_match() {
    for (size_t i = 0; i < kMaxWeapons; ++i) { g_weapon_named[i] = false; g_weapon_names[i].clear(); }
    for (int i = 0; i < kMaxModels; ++i) { g_model_resolved[i] = false; g_model_names[i].clear(); }
    g_script_model_cls = 0;
    std::memset(g_cls_not_model, 0, sizeof g_cls_not_model);
}

std::optional<player_combat> player_combat_state(int slot) {
    if (slot < 0 || slot >= kMaxClients) return std::nullopt;
    if (!g_combat.weapons && !g_combat.events && !g_combat.attacker && !g_combat.ads) return std::nullopt;
    const uintptr_t gc = gclient_for(slot);
    if (!gc) return std::nullopt;
    player_combat pc;
    if (g_combat.weapons) {
        uint32_t w = 0;
        if (peek(gc + kPsWeapon, &w) && w < kMaxWeapons) {
            pc.weapon = static_cast<int>(w);
            pc.weapon_raw = weapon_name(pc.weapon);
            if (const uintptr_t def = weapon_def(pc.weapon)) {
                int32_t ci = -1, ai = -1, clip = 0, ammo = 0;
                if (peek(def + kDefClipIndex, &ci) && peek(def + kDefAmmoIndex, &ai) &&
                    ci >= 0 && ci < static_cast<int32_t>(kMaxWeapons) && ai >= 0 && ai < static_cast<int32_t>(kMaxWeapons) &&
                    peek(gc + kPsAmmoClip + static_cast<size_t>(ci) * 4, &clip) &&
                    peek(gc + kPsAmmo + static_cast<size_t>(ai) * 4, &ammo) &&
                    clip >= 0 && clip < 100000 && ammo >= 0 && ammo < 100000) {
                    pc.have_ammo = true;
                    pc.clip = clip;
                    pc.ammo = ammo;
                }
            }
        }
    }
    if (g_combat.events) {
        struct { int32_t seq; int32_t ev[4]; } raw{};
        if (peek(gc + kPsEventSeq, &raw)) {
            pc.have_events = true;
            pc.event_seq = raw.seq & 0xFF;
            for (int i = 0; i < 4; ++i) pc.events[i] = raw.ev[i];
        }
    }
    if (g_combat.ads) {
        float f = 0.0f;
        if (peek(gc + kPsWeaponPosFrac, &f)) { pc.have_ads = true; pc.ads = f; }
    }
    pc.last_attacker = last_attacker_of(gentity_at(slot));
    return pc;
}

ent_damage_view ent_damage(int entnum) {
    ent_damage_view v;
    if (!g_report.entities || entnum < 0 || entnum >= 1024) return v;
    const uintptr_t ent = gentity_at(entnum);
    peek(ent + t4::gentity_off::health, &v.health);
    v.last_attacker = last_attacker_of(ent);
    if (g_combat.hitloc) {
        uintptr_t actor = 0;
        uint16_t id = 0;
        if (peek(ent + kEntActor, &actor) && actor && peek(actor + kActorHitLoc, &id) && id)
            v.hitloc = sl_string_safe(id, 32);
    }
    return v;
}

size_t model_ents(bool (*want)(const char* model), model_ent_view* out, size_t max) {
    if (!g_combat.models || !g_report.entities || !want || !out || max == 0) return 0;
    // One readability check for the whole static entity array instead of one per field:
    // this runs every server frame.
    const uintptr_t base = gentity_at(0);
    if (!memory::is_readable(reinterpret_cast<void*>(base), 1024 * t4::gentity_off::stride)) return 0;
    size_t n = 0;
    for (int e = kMaxClients; e < 1024 && n < max; ++e) {
        const uintptr_t ent = base + static_cast<size_t>(e) * t4::gentity_off::stride;
        const uint16_t cls = *reinterpret_cast<const uint16_t*>(ent + t4::gentity_off::classname);
        if (cls == 0) continue;
        if (g_script_model_cls == 0) {
            // Learn the id once; remember every id that is NOT it, so a map with no
            // script_model at all does not resolve 1,000 strings a frame.
            if (g_cls_not_model[cls]) continue;
            if (sl_string_safe(cls, 16) != "script_model") { g_cls_not_model[cls] = 1; continue; }
            g_script_model_cls = cls;
        } else if (cls != g_script_model_cls) {
            continue;
        }
        const uint16_t mi = *reinterpret_cast<const uint16_t*>(ent + kEntModel);
        const std::string& m = model_name(mi);
        if (m.empty() || !want(m.c_str())) continue;
        model_ent_view v;
        v.entnum = e;
        std::memcpy(v.origin, reinterpret_cast<const void*>(ent + t4::gentity_off::currentOrigin), sizeof v.origin);
        v.model = m.c_str();
        out[n++] = v;
    }
    return n;
}

}  // namespace enw::referee
