// Soak bots for the dedicated server (lane S2, dedi.md §26): server-side test clients that
// stand in for players, and a zombie-kill cadence that makes the rounds advance -- with no
// client process anywhere (no second game, no renderer, no PC of B's).
//
// ---------------------------------------------------------------------------
// Gate: ENW_DEV_KNOBS=1 AND (ENW_DEV_BOTS=<n> or a file enw_dev_bots.txt holding <n>)
// ---------------------------------------------------------------------------
// The same switch as the test god mode (soak.cpp) and the referee's `exec`: the host sets
// ENW_DEV_KNOBS only for an agent's Custom dev lease (instances.js devKnobsFor), and the
// referee reports `enw_dev_knobs 1`, so a game with bots can never be a record. Without
// ENW_DEV_KNOBS=1 this component installs NOTHING (not even the call-site retarget).
// enw_dev_bots.txt (next to CoDWaW.exe, re-read every 5 s) raises the count at run time,
// which is how a capacity test goes from 1 to 4 bots in one game.
//
// ---------------------------------------------------------------------------
// 1. The bots: the engine's own test-client path, minus the one function Treyarch cut
// ---------------------------------------------------------------------------
// T4 SP still carries IW3's test-client machinery -- read from our dump, 2026-09-23:
//
//   client_s.bIsTestClient +0x52BFC  read by SV_SendClientGameState 0x62F500 (a test client
//                                    gets zeroed stats and the 0x7F "stats uploaded" marker
//                                    instead of EXE_NEEDSTATS) and SV_AddServerCommand 0x633D30
//   sv_botsPressAttackBtn            registered at 0x6336FC, read by SV_BotUserMove 0x635DF0
//   SV_BotUserMove 0x635DF0          random buttons/angles/moves -> SV_ClientThink 0x630BF0
//   bot frame loop 0x636070          every client with state != 0 and
//                                    netchan.remoteAddress.type == NA_BOT (0) -> SV_BotUserMove;
//                                    called once per SERVER frame by SV_RunFrame at 0x636482
//
// ...but nothing in the image ever SETS bIsTestClient: SV_AddTestClient and its GSC builtin
// `addtestclient` are compiled out (no "bot%d", no connect template, two readers, no writer).
// So this is SV_AddTestClient rebuilt from the engine's own pieces, IW3's shape:
//
//   SV_Cmd_TokenizeString 0x594D50 (ecx = text)
//     "connect \"\\...\\protocol\\62\\challenge\\0\\qport\\<n>\\name\\enwbot<n>\""
//   SV_DirectConnect 0x62E3A0 (netadr_t by value, cdecl, 0x18 bytes)
//     from.type == NA_BOT skips the challenge (0x62E5D0), the Demonware ticket (0x62ED37)
//     and every packet (NET_SendPacket returns at 0x679185 for type 0); ClientConnect
//     0x67BF40 runs the scripts' connect callback; CS_FREE -> CS_CONNECTED
//   SV_Cmd_EndTokenizedString 0x594D80
//   client_s.bIsTestClient = 1
//   SV_SendClientGameState 0x62F500 (cdecl, client_s*)   CS_CONNECTED -> CS_CLIENTLOADING
//   SV_ClientEnterWorld 0x62FC30 (eax = client_s*, [esp+4] = usercmd*) -> CS_ACTIVE,
//     tail-jumps ClientBegin 0x67C160: the scripts spawn the player like any other
//
// After that the engine drives the bot by itself (the loop above). A unique port and qport
// per bot keeps DirectConnect's "reconnect" scans (0x62E527, 0x62E9B6) from matching.
//
// ---------------------------------------------------------------------------
// 2. The kills: G_Damage, from the bot, in the bot's own frame
// ---------------------------------------------------------------------------
// Random input does not clear a round, and aiming would still leave round 30's ~6,000-health
// zombies to a pistol. So once a zombie has been alive for ENW_DEV_BOT_KILL_AGE_MS (default
// 8000, jittered 0.5x-1.5x per zombie, so some reach the bots and hit them), a bot kills it:
//
//   G_Damage 0x4F5D70 (cdecl, 12 args, the call GScr `dodamage` makes at 0x51CBD9):
//     (targ, inflictor = bot, attacker = bot, dir, point, damage, dflags 0,
//      MOD_PISTOL_BULLET (1), weapon -1 (= the bot's current weapon, 0x4F5DBB), hitLoc head (2), 0, 0)
//
// That is the path a real bullet takes (ClientThink -> bullet -> G_Damage), so the zombie's
// damage/death callbacks, the kill points, rank XP (the §25 playLocalSound path), powerup
// drops and the round counter all run as they would for a player. At most
// ENW_DEV_BOT_KILLS_PER_S (default 3) per second. Only living actors whose sentient team is
// axis (1) with takedamage set are touched. ENW_DEV_BOT_KILL=0: bots only, no kills.
//
// Where it runs: the `call 0x636070` at 0x636482 in SV_RunFrame is retargeted to
// bots_server_frame(), which does this work and then calls 0x636070. So adding a bot and
// killing a zombie happen INSIDE the server frame -- under Com_Frame's error handling, at the
// same point the engine thinks for its own bots (whose bullets reach G_Damage from here too)
// -- never from a frame subscriber outside it, where a Com_Error longjmp would land in a
// dead frame. Nothing else in the tree touches 0x636482.
//
// ---------------------------------------------------------------------------
// 3. The measurements (one `dev_bots:` line a minute; soak tooling greps it)
// ---------------------------------------------------------------------------
// server-frame gap (between SV_RunFrame calls; 50 ms at sv_fps 20) p50/p99/max, Com_Frame gap
// p50/p99/max, level.time progress against the wall clock, main-thread CPU %, working set,
// entities in use, actors alive (max over the minute), kills. Read-only apart from the bots
// and the kills.
//
// Clean room: our own code, from our own dump; the shape of SV_AddTestClient is IW3's as
// every CoD4 reimplementation (CoD4x, rotu) documents it -- no code taken.
#include "component.hpp"
#include "dedicated.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>
#include <psapi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#pragma comment(lib, "psapi.lib")

namespace enw::dedi {
namespace {

// ---- addresses ([V] = read off the dump this session; see the header) -----------------
constexpr uintptr_t kBotFrameCallSite = 0x636482;   // SV_RunFrame: call 0x636070
constexpr uintptr_t kBotFrame = 0x636070;
constexpr uintptr_t kTokenize = 0x594D50;           // SV_Cmd_TokenizeString(ecx)
constexpr uintptr_t kEndTokenize = 0x594D80;        // SV_Cmd_EndTokenizedString()
constexpr uintptr_t kDirectConnect = 0x62E3A0;      // SV_DirectConnect(netadr_t)
constexpr uintptr_t kSendGameState = 0x62F500;      // SV_SendClientGameState(client_s*)
constexpr uintptr_t kEnterWorld = 0x62FC30;         // SV_ClientEnterWorld(eax, usercmd*)
constexpr uintptr_t kGDamage = 0x4F5D70;            // G_Damage (12 args, cdecl)

constexpr uintptr_t kSvMaxclientsDvar = 0x23D5C30;  // dvar_s*, int at +0x10
constexpr uintptr_t kSvsClients = 0x2547090;
constexpr uintptr_t kClientStride = 0x58D30;
constexpr uintptr_t kClState = 0x0;                 // clientState: 0 free .. 4 active
constexpr uintptr_t kClLoadState = 0x4;             // top nibble of every client packet's
                                                    // first dword (SV_PacketEvent 0x6356D9);
                                                    // 10 = loaded. getnumconnectedplayers
                                                    // 0x52E9E0 counts state 4 AND this == 10,
                                                    // and _load.gsc waits for that count
constexpr int32_t kLoaded = 10;
constexpr uintptr_t kClAdrType = 0x24;              // netchan.remoteAddress.type
constexpr uintptr_t kClAdrPort = 0x2C;              // netchan.remoteAddress.port (u16)
constexpr uintptr_t kClTestClient = 0x52BFC;        // bIsTestClient
constexpr uintptr_t kClGentity = 0x11544;

constexpr uintptr_t kGEntities = 0x176C6F0;
constexpr uintptr_t kGentStride = 0x378;
constexpr int kMaxGentities = 1024;
constexpr uintptr_t kGentInuse = 0x11D;             // r.inuse (G_Damage 0x4F6554)
constexpr uintptr_t kGentOrigin = 0x160;            // r.currentOrigin (G_Damage 0x4F61FC)
constexpr uintptr_t kGentClient = 0x180;
constexpr uintptr_t kGentActor = 0x184;             // (G_Damage 0x4F5F59)
constexpr uintptr_t kGentSentient = 0x188;          // (G_Damage 0x4F64C2)
constexpr uintptr_t kGentTakedamage = 0x19B;        // (G_Damage 0x4F5D85)
constexpr uintptr_t kGentHealth = 0x1C8;
constexpr uintptr_t kSentientTeam = 0x4;            // sentient_s.eTeam (T4SP asserts)
constexpr int kTeamAxis = 1;
constexpr uintptr_t kLevelTime = 0x18F6DC8;         // level.time (pause.cpp)
constexpr uintptr_t kSvsTime = 0x2547084;           // svs.time (SV_ClientThink 0x630BF1)
constexpr uintptr_t kClientThink = 0x630BF0;        // SV_ClientThink(eax = client_s*, [esp+4] = usercmd*)
constexpr uintptr_t kClDeltaMessage = 0xC;          // SV_BotUserMove 0x636047: = outgoingSequence - 1
constexpr uintptr_t kClOutgoingSeq = 0x14;
constexpr uintptr_t kClMessageAck = 0x110FC;        // snapshotacknowledged 0x527499 reads it
constexpr uintptr_t kPsOrigin = 0x20;               // gclient_s.ps (T4SP asserts)
constexpr uintptr_t kPsDeltaAngles = 0x7C;
constexpr uintptr_t kPsWeapon = 0x104;              // SV_BotUserMove 0x635E3D reads it for cmd.weapon
constexpr uint32_t kButtonAttack = 0x1;             // SV_BotUserMove 0x635E9D (sv_botsPressAttackBtn)

constexpr int kModPistolBullet = 1;                 // "MOD_PISTOL_BULLET" (table at 0x86A5xx)
constexpr int kHitLocHead = 2;                      // none, helmet, head, ... (0x8DC2A4)
constexpr int kMaxClients = 4;

struct netadr_t {
    int32_t type;
    uint8_t ip[4];
    uint16_t port;
    uint8_t rest[14];   // ipx / handle; SV_DirectConnect copies all 0x18 bytes
};
static_assert(sizeof(netadr_t) == 0x18, "netadr_t is 0x18 bytes (SV_DirectConnect copies 3 qwords)");

struct prologue { uintptr_t at; uint8_t len; uint8_t bytes[12]; const char* what; };
const prologue kPrologues[] = {
    {kTokenize, 11, {0xB8, 0x00, 0x02, 0x00, 0x00, 0x2B, 0x05, 0x18, 0x45, 0xF4, 0x01}, "SV_Cmd_TokenizeString"},
    {kEndTokenize, 5, {0xA1, 0x38, 0x29, 0xF5, 0x01}, "SV_Cmd_EndTokenizedString"},
    {kDirectConnect, 6, {0x81, 0xEC, 0x14, 0x07, 0x00, 0x00}, "SV_DirectConnect"},
    {kSendGameState, 12, {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF8, 0x81, 0xEC, 0x7C, 0x01, 0x00, 0x00}, "SV_SendClientGameState"},
    {kEnterWorld, 10, {0x56, 0x8B, 0xF0, 0x57, 0x8D, 0x86, 0x48, 0x15, 0x01, 0x00}, "SV_ClientEnterWorld"},
    {kGDamage, 11, {0x8B, 0x54, 0x24, 0x0C, 0x8B, 0x4C, 0x24, 0x08, 0x83, 0xEC, 0x0C}, "G_Damage"},
    {kBotFrame, 2, {0x51, 0x83}, "bot frame loop"},
    {kClientThink, 7, {0x51, 0x8B, 0x15, 0x84, 0x70, 0x54, 0x02}, "SV_ClientThink"},
};

using direct_connect_t = void(__cdecl*)(netadr_t);
using end_tokenize_t = void(__cdecl*)();
using send_gamestate_t = void(__cdecl*)(uintptr_t);
using g_damage_t = void(__cdecl*)(uintptr_t, uintptr_t, uintptr_t, const float*, const float*, int, int,
                                  int, int, int, int, int);
using bot_frame_t = void(__cdecl*)();

template <typename T>
bool peek(uintptr_t a, T* out) { return memory::read(a, out); }

// client_s fields live in the image's .data, which is read-write: a plain store. memory::write
// would VirtualProtect twice per call, which under Wine is the same page-table scan the read
// fast path avoids (shared/core/memory.cpp) -- 20 times a second per bot here.
template <typename T>
void poke(uintptr_t a, T v) {
    if (memory::is_readable(reinterpret_cast<const void*>(a), sizeof(T))) *reinterpret_cast<volatile T*>(a) = v;
}

int env_int(const char* name, int dflt) {
    const char* v = std::getenv(name);
    if (!v || !*v) return dflt;
    return std::atoi(v);
}

uintptr_t client_at(int slot) { return enw::at(kSvsClients) + static_cast<uintptr_t>(slot) * kClientStride; }
uintptr_t gent_at(int n) { return enw::at(kGEntities) + static_cast<uintptr_t>(n) * kGentStride; }

int read_int_dvar(uintptr_t slot_addr) {
    uintptr_t dv = 0;
    int v = 0;
    if (!peek(enw::at(slot_addr), &dv) || !dv || !peek(dv + 0x10, &v)) return 0;
    return v;
}

// ---------------------------------------------------------------- stats -----------------
struct minute_stats {
    std::vector<float> sv_gap_ms;      // between SV_RunFrame calls
    std::vector<float> com_gap_ms;     // between Com_Frame ends (frame subscriber)
    int max_alive = 0, max_axis = 0, max_inuse = 0;
    uint32_t kills = 0;
    int level_first = -1, level_last = -1;
    DWORD wall_first = 0;
    ULONGLONG cpu_first = 0;
};

float pct(std::vector<float>& v, double p) {
    if (v.empty()) return 0.f;
    const size_t k = static_cast<size_t>(p * (v.size() - 1));
    std::nth_element(v.begin(), v.begin() + k, v.end());
    return v[k];
}
float vmax(const std::vector<float>& v) { return v.empty() ? 0.f : *std::max_element(v.begin(), v.end()); }

ULONGLONG thread_cpu_100ns(HANDLE th) {
    FILETIME c, e, k, u;
    if (!::GetThreadTimes(th, &c, &e, &k, &u)) return 0;
    return (static_cast<ULONGLONG>(k.dwHighDateTime) << 32 | k.dwLowDateTime) +
           (static_cast<ULONGLONG>(u.dwHighDateTime) << 32 | u.dwLowDateTime);
}

// ---------------------------------------------------------------- state -----------------
struct bots_state {
    bool armed = false;
    int wanted = 0;
    bool kill = true;
    int kill_age_ms = 8000;
    int kills_per_s = 3;
    int start_ms = 10000;          // level.time before the first bot (the map settles first)
    uint16_t next_port = 0x5100;   // unique per bot: DirectConnect's reconnect scans compare it
    int next_name = 0;
    int added = 0, failed = 0;
    int last_add_level = -100000;
    DWORD last_file_check = 0;
    int first_seen[kMaxGentities];  // level.time a live axis actor was first seen, -1 none
    double kill_budget = 0;
    int last_level = -1;
    int next_attacker = 0;
    bool random_walk = false;      // ENW_DEV_BOT_RANDOM=1: the engine's own SV_BotUserMove
    uint32_t think_frames = 0;
    uint64_t kills_total = 0;
    LARGE_INTEGER qpf{}, last_sv{}, last_com{};
    HANDLE main_thread = nullptr;
    minute_stats m;
    DWORD minute_start = 0;
    bool faulted = false;
};
bots_state g;
bot_frame_t g_orig_bot_frame = nullptr;

float ms_since(LARGE_INTEGER& last) {
    LARGE_INTEGER now;
    ::QueryPerformanceCounter(&now);
    float d = -1.f;
    if (last.QuadPart && g.qpf.QuadPart)
        d = static_cast<float>((now.QuadPart - last.QuadPart) * 1000.0 / g.qpf.QuadPart);
    last = now;
    return d;
}

bool is_bot_slot(int slot) {
    const uintptr_t c = client_at(slot);
    int32_t state = 0, type = -1, test = 0;
    return peek(c + kClState, &state) && state != 0 && peek(c + kClAdrType, &type) && type == 0 &&
           peek(c + kClTestClient, &test) && test != 0;
}

int bot_count() {
    int n = 0;
    for (int s = 0; s < kMaxClients; ++s) n += is_bot_slot(s) ? 1 : 0;
    return n;
}

// ------------------------------------------------------------ add a bot -----------------
void call_tokenize(const char* text) {
    const uintptr_t fn = enw::at(kTokenize);
    __asm {
        mov ecx, text
        mov eax, fn
        call eax
    }
}

void call_enter_world(uintptr_t client, void* ucmd) {
    const uintptr_t fn = enw::at(kEnterWorld);
    __asm {
        mov edx, ucmd
        push edx
        mov eax, client
        mov ecx, fn
        call ecx
        add esp, 4
    }
}

bool add_bot() {
    const int maxc = std::min(read_int_dvar(kSvMaxclientsDvar), kMaxClients);
    int free_slots = 0;
    for (int s = 0; s < maxc; ++s) {
        int32_t st = 1;
        if (peek(client_at(s) + kClState, &st) && st == 0) ++free_slots;
    }
    if (free_slots == 0) {
        ENW_WARN("dev_bots: no free client slot (sv_maxclients %d, %d bots) -- lease with more "
                 "players to get more bots", maxc, bot_count());
        return false;
    }
    const uint16_t port = g.next_port++;
    const int id = g.next_name++;
    char connect[512];
    std::snprintf(connect, sizeof connect,
                  "connect \"\\cg_predictItems\\1\\cl_punkbuster\\0\\cl_anonymous\\0\\color\\4"
                  "\\head\\default\\model\\multi\\snaps\\20\\rate\\25000\\name\\enwbot%d"
                  "\\protocol\\62\\challenge\\0\\qport\\%u\"",
                  id, static_cast<unsigned>(port));
    netadr_t adr{};
    adr.type = 0;   // NA_BOT
    adr.port = port;
    call_tokenize(connect);
    reinterpret_cast<direct_connect_t>(enw::at(kDirectConnect))(adr);
    reinterpret_cast<end_tokenize_t>(enw::at(kEndTokenize))();

    int slot = -1;
    for (int s = 0; s < kMaxClients; ++s) {
        const uintptr_t c = client_at(s);
        int32_t st = 0, type = -1;
        uint16_t p = 0;
        if (peek(c + kClState, &st) && st == 2 && peek(c + kClAdrType, &type) && type == 0 &&
            peek(c + kClAdrPort, &p) && p == port) {
            slot = s;
            break;
        }
    }
    if (slot < 0) {
        ENW_ERROR("dev_bots: SV_DirectConnect did not seat enwbot%d (port %u) -- see the console "
                  "log for the engine's reason", id, static_cast<unsigned>(port));
        return false;
    }
    const uintptr_t cl = client_at(slot);
    poke(cl + kClTestClient, static_cast<int32_t>(1));
    reinterpret_cast<send_gamestate_t>(enw::at(kSendGameState))(cl);
    alignas(4) uint8_t cmd[0x38] = {};
    call_enter_world(cl, cmd);
    // A bot sends no packets, so nothing ever reports it loaded: say it ourselves, or the
    // scripts' all_players_connected never fires and nobody spawns (measured, run t1).
    poke(cl + kClLoadState, kLoaded);
    int32_t st = 0;
    uintptr_t gent = 0;
    peek(cl + kClState, &st);
    peek(cl + kClGentity, &gent);
    ENW_WARN("dev_bots: enwbot%d seated in slot %d (state %d, gentity %08X). TEST ONLY: a "
             "server-side test client, never a record.", id, slot, st, static_cast<unsigned>(gent));
    return st == 4;
}

// ---------------------------------------------------------------- kills -----------------
uintptr_t pick_attacker() {
    for (int i = 0; i < kMaxClients; ++i) {
        const int s = (g.next_attacker + i) % kMaxClients;
        if (!is_bot_slot(s)) continue;
        const uintptr_t e = gent_at(s);
        uintptr_t gc = 0;
        int32_t hp = 0;
        if (peek(e + kGentClient, &gc) && gc && peek(e + kGentHealth, &hp) && hp > 0) {
            g.next_attacker = s + 1;
            return e;
        }
    }
    return 0;
}

int jittered_age(int n, int first) {
    uint32_t h = static_cast<uint32_t>(n) * 2654435761u ^ static_cast<uint32_t>(first) * 40503u;
    h ^= h >> 13;
    return g.kill_age_ms / 2 + static_cast<int>(h % static_cast<uint32_t>(g.kill_age_ms + 1));
}

void scan_and_kill(int level) {
    int alive = 0, axis = 0, inuse = 0;
    const uintptr_t attacker = g.kill ? pick_attacker() : 0;
    for (int n = kMaxClients; n < kMaxGentities; ++n) {
        const uintptr_t e = gent_at(n);
        uint8_t use = 0;
        if (!peek(e + kGentInuse, &use) || !use) { g.first_seen[n] = -1; continue; }
        ++inuse;
        uintptr_t actor = 0, sent = 0;
        int32_t hp = 0, team = 0;
        uint8_t td = 0;
        if (!peek(e + kGentActor, &actor) || !actor || !peek(e + kGentHealth, &hp) || hp <= 0) {
            g.first_seen[n] = -1;
            continue;
        }
        ++alive;
        if (!peek(e + kGentSentient, &sent) || !sent || !peek(sent + kSentientTeam, &team) ||
            team != kTeamAxis || !peek(e + kGentTakedamage, &td) || !td) {
            g.first_seen[n] = -1;
            continue;
        }
        ++axis;
        if (g.first_seen[n] < 0) g.first_seen[n] = level;
        if (!attacker || g.kill_budget < 1.0) continue;
        if (level - g.first_seen[n] < jittered_age(n, g.first_seen[n])) continue;

        float to[3] = {}, from[3] = {}, dir[3] = {0, 0, -1}, point[3] = {};
        peek(e + kGentOrigin, &to);
        peek(attacker + kGentOrigin, &from);
        const float dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const float len = std::sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 1.f) { dir[0] = dx / len; dir[1] = dy / len; dir[2] = dz / len; }
        point[0] = to[0]; point[1] = to[1]; point[2] = to[2] + 60.f;
        const int dmg = hp > 100000000 ? hp : hp + 1000;
        reinterpret_cast<g_damage_t>(enw::at(kGDamage))(e, attacker, attacker, dir, point, dmg, 0,
                                                        kModPistolBullet, -1, kHitLocHead, 0, 0);
        g.kill_budget -= 1.0;
        int32_t after = 0;
        if (peek(e + kGentHealth, &after) && after <= 0) {
            ++g.kills_total;
            ++g.m.kills;
            g.first_seen[n] = -1;
        }
    }
    g.m.max_alive = std::max(g.m.max_alive, alive);
    g.m.max_axis = std::max(g.m.max_axis, axis);
    g.m.max_inuse = std::max(g.m.max_inuse, inuse);
}

void read_wanted_file() {
    const DWORD now = ::GetTickCount();
    if (g.last_file_check && now - g.last_file_check < 5000) return;
    g.last_file_check = now ? now : 1;
    // The end of a soak (soak.cpp): enw_dev_god.off releases god mode, and the bots must stop
    // killing too, or the zombies never reach them and the game never ends (measured, run t2).
    if (g.kill && ::GetFileAttributesA("enw_dev_god.off") != INVALID_FILE_ATTRIBUTES) {
        g.kill = false;
        ENW_WARN("dev_bots: enw_dev_god.off present -- kills OFF, the zombies can end the game");
    }
    FILE* f = std::fopen("enw_dev_bots.txt", "rb");
    if (!f) return;
    int n = -1;
    if (std::fscanf(f, "%d", &n) == 1 && n >= 0 && n <= kMaxClients && n != g.wanted) {
        ENW_WARN("dev_bots: enw_dev_bots.txt asks for %d bot(s) (was %d)", n, g.wanted);
        g.wanted = n;
    }
    std::fclose(f);
}

void server_frame_work() {
    const float gap = ms_since(g.last_sv);
    if (gap >= 0) g.m.sv_gap_ms.push_back(gap);
    int level = 0;
    peek(enw::at(kLevelTime), &level);
    if (g.m.level_first < 0) g.m.level_first = level;
    g.m.level_last = level;

    // Kill budget: kills_per_s, accrued in level time (a paused or held world accrues none).
    if (g.last_level >= 0 && level > g.last_level)
        g.kill_budget = std::min(g.kill_budget + (level - g.last_level) * g.kills_per_s / 1000.0,
                                 2.0 * g.kills_per_s);
    if (level < g.last_level) {   // map_restart: a new level
        for (int& t : g.first_seen) t = -1;
    }
    g.last_level = level;

    // Keep every bot "loaded": SV_SpawnServer zeroes the field on a map_restart (0x631F93).
    for (int s = 0; s < kMaxClients; ++s) {
        if (!is_bot_slot(s)) continue;
        int32_t ls = 0;
        if (peek(client_at(s) + kClLoadState, &ls) && ls != kLoaded)
            poke(client_at(s) + kClLoadState, kLoaded);
    }
    read_wanted_file();
    if (level >= g.start_ms && bot_count() < g.wanted && level - g.last_add_level >= 1000 &&
        g.failed < 5) {
        g.last_add_level = level;
        if (add_bot()) ++g.added; else ++g.failed;
    }
    scan_and_kill(level);
}

// ------------------------------------------------------------- the bot brain --------------
// The engine's SV_BotUserMove walks at random, and on a zoned map (Der Riese style: ILS, run
// ab-ils-fast) a bot that wanders out of the active zones stops the spawners -- round 1 never
// ended. So by default a bot stands where the scripts spawned it (always inside the start zone),
// turns to the nearest living zombie and fires on alternate server frames: real bullets, real
// hit/impact events, and the zombies come to it as they would to a camping player.
void call_client_think(uintptr_t client, void* ucmd) {
    const uintptr_t fn = enw::at(kClientThink);
    __asm {
        mov edx, ucmd
        push edx
        mov eax, client
        mov ecx, fn
        call ecx
        add esp, 4
    }
}

int16_t angle_short(float deg) { return static_cast<int16_t>(static_cast<int>(deg * 65536.0f / 360.0f) & 0xFFFF); }

void think_bots() {
    ++g.think_frames;
    int32_t svs_time = 0;
    peek(enw::at(kSvsTime), &svs_time);
    for (int s = 0; s < kMaxClients; ++s) {
        if (!is_bot_slot(s)) continue;
        const uintptr_t cl = client_at(s);
        uintptr_t gent = 0, gc = 0;
        if (!peek(cl + kClGentity, &gent) || !gent) continue;
        peek(gent + kGentClient, &gc);
        alignas(4) uint8_t cmd[0x38] = {};
        std::memcpy(cmd + 0, &svs_time, 4);
        if (gc) {
            uint32_t weapon = 0;
            float org[3] = {}, delta[3] = {};
            peek(gc + kPsWeapon, &weapon);
            peek(gc + kPsOrigin, &org);
            peek(gc + kPsDeltaAngles, &delta);
            cmd[0x14] = static_cast<uint8_t>(weapon);
            // nearest living axis actor
            float best = 1e30f, tgt[3] = {};
            for (int n = kMaxClients; n < kMaxGentities; ++n) {
                if (g.first_seen[n] < 0) continue;          // scan_and_kill's live-axis set
                float o[3];
                if (!peek(gent_at(n) + kGentOrigin, &o)) continue;
                const float dx = o[0] - org[0], dy = o[1] - org[1], dz = o[2] - org[2];
                const float d = dx * dx + dy * dy + dz * dz;
                if (d < best) { best = d; tgt[0] = o[0]; tgt[1] = o[1]; tgt[2] = o[2]; }
            }
            if (best < 1e29f) {
                const float dx = tgt[0] - org[0], dy = tgt[1] - org[1];
                const float dz = (tgt[2] + 48.f) - (org[2] + 60.f);
                const float yaw = std::atan2(dy, dx) * 57.29578f;
                const float pitch = -std::atan2(dz, std::sqrt(dx * dx + dy * dy)) * 57.29578f;
                const int16_t p = angle_short(pitch - delta[0]), y = angle_short(yaw - delta[1]);
                int32_t a0 = static_cast<uint16_t>(p), a1 = static_cast<uint16_t>(y);
                std::memcpy(cmd + 0x8, &a0, 4);
                std::memcpy(cmd + 0xC, &a1, 4);
                if (g.kill && best < 1500.f * 1500.f && (g.think_frames & 1)) {
                    const uint32_t b = kButtonAttack;
                    std::memcpy(cmd + 0x4, &b, 4);
                }
            } else {
                // Nothing to shoot: look at the floor. A spawner a player can see does not
                // spawn (the non-forced DoSpawn path), and a bot staring down a corridor at a
                // spawn closet would starve a small map of zombies (dedi.md §27.6).
                const int16_t p = angle_short(80.f - delta[0]);
                int32_t a0 = static_cast<uint16_t>(p);
                std::memcpy(cmd + 0x8, &a0, 4);
            }
        }
        int32_t seq = 0;
        if (peek(cl + kClOutgoingSeq, &seq)) {
            poke(cl + kClDeltaMessage, seq - 1);
            // A bot sends no packets, so it never acknowledges a snapshot. `snapshotacknowledged`
            // 0x5273B0 compares getsnapshotindexarray's outgoingSequence+1 with this field
            // (0x527499), and wait_network_frame() in DLC3/UGX map scripts waits on it: say
            // every snapshot is acknowledged, as a client on a perfect link would.
            poke(cl + kClMessageAck, seq);
        }
        call_client_think(cl, cmd);
    }
}

void __cdecl bots_server_frame() {
    if (!g.faulted) {
        __try {
            server_frame_work();
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            // Our own reads are guarded; this is an engine call (DirectConnect, G_Damage and the
            // scripts under them) faulting. Stop, say so, and let the engine's own bots run.
            g.faulted = true;
            ENW_ERROR("dev_bots: an exception (0x%08X) inside the bot work -- bots and kills are "
                      "OFF for the rest of this game", static_cast<unsigned>(GetExceptionCode()));
        }
    }
    if (g.random_walk || g.faulted) {
        g_orig_bot_frame();
        return;
    }
    __try {
        think_bots();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        g.random_walk = true;
        ENW_ERROR("dev_bots: an exception (0x%08X) in the bot brain -- falling back to the "
                  "engine's random bots", static_cast<unsigned>(GetExceptionCode()));
    }
}

void minute_line() {
    const DWORD now = ::GetTickCount();
    if (g.minute_start == 0) {
        g.minute_start = now;
        g.m.wall_first = now;
        g.m.cpu_first = thread_cpu_100ns(g.main_thread);
        return;
    }
    if (now - g.minute_start < 60000) return;
    const double wall = (now - g.m.wall_first) / 1000.0;
    const ULONGLONG cpu = thread_cpu_100ns(g.main_thread);
    const double cpu_pct = wall > 0 ? (cpu - g.m.cpu_first) / 1e5 / wall : 0;   // % of one core
    PROCESS_MEMORY_COUNTERS pmc{};
    pmc.cb = sizeof pmc;
    ::GetProcessMemoryInfo(::GetCurrentProcess(), &pmc, sizeof pmc);
    const int ldelta = (g.m.level_first >= 0) ? g.m.level_last - g.m.level_first : 0;
    auto late = [](const std::vector<float>& v, float over) {
        return static_cast<int>(std::count_if(v.begin(), v.end(), [over](float x) { return x > over; }));
    };
    const size_t nsv = g.m.sv_gap_ms.size(), ncom = g.m.com_gap_ms.size();
    ENW_INFO("dev_bots: bots %d (wanted %d) | sv-frame n %u p50 %.1f p99 %.1f max %.1f ms, >100ms %d | "
             "com-frame n %u p50 %.1f p99 %.1f max %.1f ms, >50ms %d | level +%d ms / wall %.1f s (%.3f) | "
             "main-thread cpu %.1f%% | ws %u MB | entities %d | actors max %d (axis %d) | kills %u "
             "(total %llu)%s",
             bot_count(), g.wanted, static_cast<unsigned>(nsv), pct(g.m.sv_gap_ms, 0.5),
             pct(g.m.sv_gap_ms, 0.99), vmax(g.m.sv_gap_ms), late(g.m.sv_gap_ms, 100.f),
             static_cast<unsigned>(ncom), pct(g.m.com_gap_ms, 0.5), pct(g.m.com_gap_ms, 0.99),
             vmax(g.m.com_gap_ms), late(g.m.com_gap_ms, 50.f), ldelta, wall,
             wall > 0 ? ldelta / 1000.0 / wall : 0.0, cpu_pct,
             static_cast<unsigned>(pmc.WorkingSetSize >> 20), g.m.max_inuse, g.m.max_alive,
             g.m.max_axis, g.m.kills, static_cast<unsigned long long>(g.kills_total),
             g.faulted ? " | FAULTED (bots off)" : "");
    // Where each bot is and what it stands on: a bot outside every zone volume stops a zoned
    // map's spawners (dedi.md §27.5), so this is the first thing to read when rounds stall.
    for (int s = 0; s < kMaxClients; ++s) {
        if (!is_bot_slot(s)) continue;
        const uintptr_t e = gent_at(s);
        uintptr_t gc = 0;
        float o[3] = {}, mins[3] = {}, maxs[3] = {};
        int32_t hp = 0, ground = -1, pmtype = -1, conn = -1;
        uint8_t linked = 0;
        peek(e + kGentOrigin, &o);
        peek(e + 0x118 + 0x14, &mins);   // r.mins, r.maxs: what IsTouching 0x51BA70 adds to origin
        peek(e + 0x118 + 0x20, &maxs);
        peek(e + 0x118, &linked);
        peek(e + kGentHealth, &hp);
        if (peek(e + kGentClient, &gc) && gc) {
            peek(gc + 0x88, &ground);     // ps.groundEntityNum
            peek(gc + 0x4, &pmtype);      // ps.pm_type
            peek(gc + 0x20E0, &conn);     // sess.connected (getplayers 0x516E46 wants 2)
        }
        ENW_INFO("dev_bots: slot %d at (%.0f %.0f %.0f) mins (%.0f %.0f %.0f) maxs (%.0f %.0f %.0f) "
                 "linked %u ground %d pm_type %d connected %d health %d",
                 s, o[0], o[1], o[2], mins[0], mins[1], mins[2], maxs[0], maxs[1], maxs[2], linked,
                 ground, pmtype, conn, hp);
    }
    g.m = minute_stats{};
    g.minute_start = now;
    g.m.wall_first = now;
    g.m.cpu_first = cpu;
}

bool prologues_ok() {
    for (const auto& p : kPrologues) {
        uint8_t got[12] = {};
        if (!memory::read_raw(enw::at(p.at), got, p.len) || std::memcmp(got, p.bytes, p.len) != 0) {
            ENW_ERROR("dev_bots: %s at 0x%08X is not the expected code (%s) -- NOT arming", p.what,
                      static_cast<unsigned>(p.at), memory::hex_dump(enw::at(p.at), p.len).c_str());
            return false;
        }
    }
    if (memory::call_target(enw::at(kBotFrameCallSite)) != enw::at(kBotFrame)) {
        ENW_ERROR("dev_bots: 0x%08X is not `call 0x636070` -- NOT arming",
                  static_cast<unsigned>(kBotFrameCallSite));
        return false;
    }
    return true;
}

class bots_component final : public component {
public:
    const char* name() const override { return "dedi_bots"; }
    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        const char* knobs = std::getenv("ENW_DEV_KNOBS");
        const bool knobs_on = knobs && std::strcmp(knobs, "1") == 0;
        const int want = env_int("ENW_DEV_BOTS", 0);
        const bool file = ::GetFileAttributesA("enw_dev_bots.txt") != INVALID_FILE_ATTRIBUTES;
        if (!knobs_on) {
            if (want > 0 || file)
                ENW_WARN("dev_bots: bots asked for without ENW_DEV_KNOBS=1 -- refused, this game is stock");
            return;
        }
        // Armed whenever the dev knobs are on, so enw_dev_bots.txt can add bots later; with
        // no bots wanted it only measures (the dev_bots line) and kills nothing.
        for (int& t : g.first_seen) t = -1;
        g.wanted = std::max(0, std::min(want, kMaxClients));
        g.kill = env_int("ENW_DEV_BOT_KILL", 1) != 0;
        g.kill_age_ms = std::max(0, env_int("ENW_DEV_BOT_KILL_AGE_MS", 8000));
        g.kills_per_s = std::max(1, env_int("ENW_DEV_BOT_KILLS_PER_S", 3));
        g.start_ms = std::max(0, env_int("ENW_DEV_BOT_START_MS", 10000));
        g.random_walk = env_int("ENW_DEV_BOT_RANDOM", 0) != 0;
        ::QueryPerformanceFrequency(&g.qpf);
        if (!prologues_ok()) return;
        g_orig_bot_frame = reinterpret_cast<bot_frame_t>(enw::at(kBotFrame));
        if (!memory::retarget_call(enw::at(kBotFrameCallSite), reinterpret_cast<const void*>(&bots_server_frame))) {
            ENW_ERROR("dev_bots: retarget_call at 0x%08X failed -- NOT armed",
                      static_cast<unsigned>(kBotFrameCallSite));
            return;
        }
        g.armed = true;
        enw::frame::subscribe("dedi_bots_stats", [](uint64_t) {
            if (!g.main_thread) {
                ::DuplicateHandle(::GetCurrentProcess(), ::GetCurrentThread(), ::GetCurrentProcess(),
                                  &g.main_thread, THREAD_QUERY_INFORMATION, FALSE, 0);
            }
            const float gap = ms_since(g.last_com);
            if (gap >= 0) g.m.com_gap_ms.push_back(gap);
            minute_line();
        });
        ENW_WARN("dev_bots: ARMED (ENW_DEV_KNOBS=1): %d bot(s) from level.time %d ms, kills %s "
                 "(age %d ms jittered 0.5-1.5x, <= %d/s, axis actors, G_Damage from a bot). "
                 "SV_RunFrame's call 0x636070 at 0x%08X now runs the bot work first. TEST ONLY, "
                 "never Verified.",
                 g.wanted, g.start_ms, g.kill ? "ON" : "off", g.kill_age_ms, g.kills_per_s,
                 static_cast<unsigned>(kBotFrameCallSite));
    }
};

ENW_REGISTER_COMPONENT(bots_component)

}  // namespace
}  // namespace enw::dedi
