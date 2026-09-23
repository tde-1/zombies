// Soak tooling for the dedicated server (dedi.md §23): a TEST-ONLY god mode, and a
// read-only script-variable pool probe.
//
// ---------------------------------------------------------------------------
// 1. dev god  (ENW_DEV_KNOBS=1 AND ENW_DEV_GOD=1 in the game process, both, or nothing)
// ---------------------------------------------------------------------------
// A soak needs a client that stays alive for an hour with nobody at the keyboard. The
// engine's own `god` is a CLIENT command (read from the dump, 2026-09-23):
//
//   0x4F4420  Cmd_God(ent in eax)
//     call 0x4F39A0            CheatsOk: [0x18E8710]->current (sv_cheats) must be set,
//                              and ent->health (+0x1C8) > 0
//     xor  [esi+0x1B4], 1      ent->flags ^= FL_GODMODE
//     ... "GAME_GODMODE_ON" / "GAME_GODMODE_OFF" to that client
//
// and G_Damage (0x4F2B50) tests the same bit and jumps past the damage:
//
//   0x4F2EB3  test byte ptr [esi+0x1B4], 1 ; jne 0x4F345E
//
// So a host `exec god` cannot work (the server console has no entity to toggle), and
// the stock route needs sv_cheats 1 plus the client typing `god` after every spawn.
// This sets the bit itself, on every player entity, every 15 frames -- exactly what
// the engine's own command does, without sv_cheats and without a client knob. It is
// held rather than toggled so a respawn (which rebuilds the entity) gets it back.
//
// It never runs in a Verified game: nothing that launches one sets ENW_DEV_KNOBS (the
// same switch the referee's `exec` refuses without, referee.md §10.5), and the referee
// reports `enw_dev_knobs 1` on the link so the host's Verified judge fails the run if
// it ever did (verified.js SERVER_RULES). ENW_DEV_GOD alone does nothing but say so.
//
// THE END OF A SOAK: a file `enw_dev_god.off` next to CoDWaW.exe (the working
// directory; checked once a second, like pause.cpp's operator trigger) releases god
// mode and CLEARS the bit, so the idle player is eaten and the game ends the way a
// real game does -- end_game -> game_over -> match_end -> the host's disposition.
// Deleting the file arms it again.
//
// ---------------------------------------------------------------------------
// 2. varpool probe  (on in every dedicated game; ENW_NO_VARPOOL_PROBE=1 turns it off)
// ---------------------------------------------------------------------------
// Once a minute: how many child / parent script variables are in use, both free-list
// heads, scrVmPub.localVars and the [0x3BFD478] slot the localVars overflow lands on
// (dedi.md §13.2, §18.6). Read-only, ~90,000 dword reads a minute. A script-variable
// leak in a long game (the "exceeded maximum number of script variables" error that
// ends it) shows as `child` climbing across rounds; the layout is tools/dev/varpool.py's.
//
// Clean room: our own code, from our own dump.
#include "component.hpp"
#include "dedicated.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace enw::dedi {
namespace {

// ---- addresses (all [V]; see the header and tools/dev/varpool.py) ---------------------
constexpr uintptr_t kSvsClients = 0x2547090;     // svs.clients[0]
constexpr uintptr_t kClientStride = 0x58D30;
constexpr uintptr_t kClientGentity = 0x11544;    // client_s.gentity
constexpr uintptr_t kClientName = 0x11548;       // client_s.name
constexpr uintptr_t kGEntities = 0x176C6F0;
constexpr uintptr_t kGentityStride = 0x378;
constexpr uintptr_t kGentClient = 0x180;         // gentity_s.client
constexpr uintptr_t kGentFlags = 0x1B4;          // gentity_s.flags (Cmd_God's xor)
constexpr uintptr_t kGentHealth = 0x1C8;         // gentity_s.health (CheatsOk's test)
constexpr uint32_t kFlGodmode = 0x1;
constexpr int kMaxClients = 4;

constexpr uintptr_t kChildVars = 0x3974700;      // gScrVarGlob.childVariables, 16-byte rows
constexpr uint32_t kNumChild = 65536;
constexpr uintptr_t kParentVars = 0x3914700;     // gScrVarGlob.parentVariables
constexpr uint32_t kNumParent = 24576;
constexpr uintptr_t kLocalVars = 0x3BD4700;      // gScrVmPub[0] first dword
constexpr uintptr_t kOverflowSlot = 0x3BFD478;   // what the localVars overflow hits first
constexpr uintptr_t kComFrameTime = 0x1F9648C;   // com_frameTime (frame_pacing.cpp)

bool env_is(const char* name, const char* want) {
    const char* v = std::getenv(name);
    return v && std::strcmp(v, want) == 0;
}

template <typename T>
bool peek(uintptr_t vault, T* out) {
    return memory::read(enw::at(vault), out);
}

// ------------------------------------------------------------------ dev god --
struct god_state {
    bool on[kMaxClients] = {};
    uint64_t sets = 0;      // times we had to set the bit (spawns, respawns)
};
god_state g_god;

void release_god() {
    for (int slot = 0; slot < kMaxClients; ++slot) {
        const uintptr_t ent = kGEntities + static_cast<uintptr_t>(slot) * kGentityStride;
        uint32_t flags = 0;
        if (peek(ent + kGentFlags, &flags) && (flags & kFlGodmode)) {
            memory::write(enw::at(ent + kGentFlags), flags & ~kFlGodmode);
            ENW_WARN("dev_god: slot %d godmode OFF (enw_dev_god.off present)", slot);
        }
        g_god.on[slot] = false;
    }
}

void hold_god() {
    for (int slot = 0; slot < kMaxClients; ++slot) {
        const uintptr_t c = kSvsClients + static_cast<uintptr_t>(slot) * kClientStride;
        uint32_t gent = 0;
        char name0 = 0;
        const bool in_game = peek(c + kClientGentity, &gent) && gent != 0 &&
                             peek(c + kClientName, &name0) && name0 != 0;
        const uintptr_t ent = kGEntities + static_cast<uintptr_t>(slot) * kGentityStride;
        uint32_t gclient = 0;
        int32_t health = 0;
        uint32_t flags = 0;
        const bool alive = in_game && gent == enw::at(ent) &&
                           peek(ent + kGentClient, &gclient) && gclient != 0 &&
                           peek(ent + kGentHealth, &health) && health > 0 &&
                           peek(ent + kGentFlags, &flags);
        if (!alive) {
            if (g_god.on[slot]) {
                ENW_INFO("dev_god: slot %d left the world (or died); will re-apply on spawn", slot);
                g_god.on[slot] = false;
            }
            continue;
        }
        if ((flags & kFlGodmode) == 0) {
            memory::write(enw::at(ent + kGentFlags), flags | kFlGodmode);
            ++g_god.sets;
            if (!g_god.on[slot]) {
                ENW_WARN("dev_god: slot %d godmode ON (gentity %08X flags %08X -> %08X, health %d). "
                         "TEST ONLY: this game can never be a record.",
                         slot, static_cast<unsigned>(ent), static_cast<unsigned>(flags),
                         static_cast<unsigned>(flags | kFlGodmode), health);
            }
        }
        g_god.on[slot] = true;
    }
}

// ------------------------------------------------------------- varpool probe --
struct pool_count {
    uint32_t used = 0;
    uint16_t free_head = 0;
    bool ok = false;
};

pool_count count_pool(uintptr_t base, uint32_t rows, uintptr_t head_off) {
    pool_count r;
    const auto* p = reinterpret_cast<const uint8_t*>(enw::at(base));
    if (!memory::is_readable(p, static_cast<size_t>(rows) * 16)) return r;
    std::memcpy(&r.free_head, p + head_off, sizeof r.free_head);
    for (uint32_t i = 1; i < rows; ++i) {
        uint32_t w;
        std::memcpy(&w, p + static_cast<size_t>(i) * 16 + 8, sizeof w);
        if (w != 0) ++r.used;
    }
    r.ok = true;
    return r;
}

struct pool_trend {
    uint32_t child_first = 0, child_max = 0;
    uint32_t parent_first = 0, parent_max = 0;
    uint32_t samples = 0;
};
pool_trend g_trend;

void probe_pools(uint64_t frame) {
    const pool_count child = count_pool(kChildVars, kNumChild, 4);
    const pool_count parent = count_pool(kParentVars, kNumParent, 0x14);
    uint32_t local_vars = 0, slot = 0;
    int32_t ft = 0;
    peek(kLocalVars, &local_vars);
    peek(kOverflowSlot, &slot);
    peek(kComFrameTime, &ft);
    if (!child.ok || !parent.ok) {
        ENW_WARN("varpool: the script variable pools are not readable (child %d parent %d)",
                 child.ok, parent.ok);
        return;
    }
    if (g_trend.samples++ == 0) {
        g_trend.child_first = child.used;
        g_trend.parent_first = parent.used;
    }
    if (child.used > g_trend.child_max) g_trend.child_max = child.used;
    if (parent.used > g_trend.parent_max) g_trend.parent_max = parent.used;
    ENW_INFO("varpool: child %u/%u (free-head %u, first %u, max %u) | parent %u/%u (free-head %u, "
             "first %u, max %u) | localVars %08X | [0x3BFD478] %08X | com_frameTime %d | frame %llu",
             child.used, kNumChild, child.free_head, g_trend.child_first, g_trend.child_max,
             parent.used, kNumParent, parent.free_head, g_trend.parent_first, g_trend.parent_max,
             static_cast<unsigned>(local_vars), static_cast<unsigned>(slot), ft,
             static_cast<unsigned long long>(frame));
    // A zero head alone is not proof (the parent head's meaning is inferred from one
    // function); a zero head on a nearly full pool is.
    if ((child.free_head == 0 && child.used > kNumChild * 9 / 10) ||
        (parent.free_head == 0 && parent.used > kNumParent * 9 / 10)) {
        ENW_ERROR("varpool: a free list is EMPTY (child head %u, parent head %u): the next "
                  "allocation raises \"exceeded maximum number of script variables\"",
                  child.free_head, parent.free_head);
    }
}

class soak_component final : public component {
public:
    const char* name() const override { return "dedi_soak"; }
    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        const bool knobs = env_is("ENW_DEV_KNOBS", "1");
        const bool god_asked = env_is("ENW_DEV_GOD", "1");
        god_ = knobs && god_asked;
        if (god_asked && !knobs) {
            ENW_WARN("dev_god: ENW_DEV_GOD=1 without ENW_DEV_KNOBS=1 -- refused, this game is stock");
        }
        if (god_) {
            ENW_WARN("dev_god: ARMED (ENW_DEV_KNOBS=1, ENW_DEV_GOD=1): every player entity gets "
                     "FL_GODMODE (gentity+0x1B4 bit 0) while alive. TEST ONLY, never Verified.");
        }
        probe_ = !env_is("ENW_NO_VARPOOL_PROBE", "1");
        if (!god_ && !probe_) return;
        enw::frame::subscribe("dedi_soak", [this](uint64_t n) {
            if (god_) {
                const DWORD now = ::GetTickCount();
                if (now - last_trigger_check_ >= 1000) {
                    last_trigger_check_ = now;
                    const bool off = ::GetFileAttributesA("enw_dev_god.off") != INVALID_FILE_ATTRIBUTES;
                    if (off != released_) {
                        released_ = off;
                        ENW_WARN("dev_god: trigger file enw_dev_god.off %s -> god mode %s", off ? "PRESENT" : "gone",
                                 off ? "RELEASED (the players can die; this is how a soak ends)" : "held again");
                        if (off) release_god();
                    }
                }
                if (!released_ && (n % 15) == 0) hold_god();
            }
            if (probe_) {
                const DWORD now = ::GetTickCount();
                if (last_probe_ == 0 || now - last_probe_ >= 60000) {
                    last_probe_ = now ? now : 1;
                    probe_pools(n);
                }
            }
        });
        ENW_INFO("dedi_soak: armed (dev god %s, varpool probe %s)", god_ ? "ON" : "off",
                 probe_ ? "every 60 s" : "off");
    }

private:
    bool god_ = false;
    bool probe_ = false;
    DWORD last_probe_ = 0;
    DWORD last_trigger_check_ = 0;
    bool released_ = false;
};

ENW_REGISTER_COMPONENT(soak_component)

}  // namespace
}  // namespace enw::dedi
