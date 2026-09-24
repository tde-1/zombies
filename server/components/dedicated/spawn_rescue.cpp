// Late-spawn rescue (dedi.md section 29/30, cloud-brief-parties.md task 1.4).
//
// A player who spawns AFTER round 1 started -- a mid-game joiner, which is by design once a
// party member can join the leader's running game -- is put where the map's script puts late
// spawns. On a map with no usable fallback spawn that is the map origin: Hijacked put B's friend
// at (0, 0, -4) on nothing, they fell to z -272 under the floor, and zombies could not reach them.
//
// TRIGGER (per player, watched for 3 s after a spawn that comes after round 1 started):
//   spawn x,y == 0,0, or on nothing at spawn (and still, 500 ms later), or more than 128 units
//   below the spawn point.
// ACTION: move them to a spot a living teammate stood on (on the world) at least 1 s ago and at
// least 40 units from every player now (a breadcrumb ring per player), and zero their velocity.
// The choices are expected_players_rules.hpp (enw::rescue), unit-tested.
//
// Reads are solo_parity.cpp's (same addresses, same meaning): g_entities 0x176C6F0 stride 0x378,
// gentity.client +0x180, gentity.health +0x1C8, playerState pm_type +0x4, origin +0x20, velocity
// +0x2C, groundEntityNum +0x88 (1022 world, 1023 nothing).
// THE WRITE is new and [unverified]: playerState.origin (+0x20) and .velocity (+0x2C). Reading
// them is proven (solo_parity logged Hijacked's (0,0,-4) spawn and the fall to -272); that the
// server's next pmove starts from a written ps.origin, and that the client accepts the jump
// without a teleport bit in eFlags, is not. The local session proves it (two clients, Hijacked).
//
// Kill switch: ENW_NO_SPAWN_RESCUE=1.
//
// Clean room: our own code.
#include "../../../shared/core/component.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/memory.hpp"
#include "../referee/t4_bind.hpp"
#include "dedicated.hpp"
#include "expected_players_rules.hpp"

#include <cstdint>
#include <cstdlib>

namespace enw::dedi {
namespace {

constexpr uintptr_t kGEntities = 0x176C6F0;     // as solo_parity.cpp
constexpr uintptr_t kGentityStride = 0x378;
constexpr size_t kGentClient = 0x180;
constexpr size_t kGentHealth = 0x1C8;
constexpr size_t kPsPmType = 0x4;
constexpr size_t kPsOrigin = 0x20;              // read [V by use]; WRITE [unverified]
constexpr size_t kPsVelocity = 0x2C;            // read [V by use]; WRITE [unverified]
constexpr size_t kPsGroundEnt = 0x88;
constexpr int kWorld = 1022;
constexpr int kNone = 1023;
constexpr int kMaxClients = 4;

rescue::crumb_ring g_rings[kMaxClients];
rescue::spawn_watch g_watch[kMaxClients];
bool g_spawned[kMaxClients] = {};
bool g_round_started = false;
uint64_t g_rescues = 0;

template <typename T>
bool peek(uintptr_t addr, T* out) { return memory::read(enw::at(addr), out); }

struct pview {
    bool present = false, alive = false;
    uint32_t gc = 0;
    int pm_type = 0, ground = kNone;
    rescue::vec3 at;
};

pview read_player(int slot) {
    pview v;
    const uintptr_t ent = kGEntities + static_cast<uintptr_t>(slot) * kGentityStride;
    int32_t health = 0;
    if (!peek(ent + kGentClient, &v.gc) || !v.gc || !peek(ent + kGentHealth, &health)) return v;
    v.present = true;
    v.alive = health > 0;
    float o[3] = {0, 0, 0};
    memory::read(v.gc + kPsPmType, &v.pm_type);
    memory::read(v.gc + kPsOrigin, &o);
    memory::read(v.gc + kPsGroundEnt, &v.ground);
    v.at = {o[0], o[1], o[2]};
    return v;
}

void on_frame(uint32_t ms) {
    pview p[kMaxClients];
    for (int s = 0; s < kMaxClients; ++s) p[s] = read_player(s);

    for (int s = 0; s < kMaxClients; ++s) {
        if (!p[s].present) {
            g_spawned[s] = false;
            g_watch[s] = {};
            g_rings[s].clear();
            continue;
        }
        const bool live = p[s].alive && p[s].pm_type == 0;   // PM_NORMAL: not spectating, not dead
        if (live && !g_spawned[s]) {
            g_spawned[s] = true;
            g_watch[s].start(p[s].at, ms, g_round_started, p[s].ground == kNone);
            if (g_round_started)
                ENW_INFO("spawn_rescue: slot %d spawned after round 1 at (%.1f %.1f %.1f) on %s; watching 3 s", s,
                         p[s].at.x, p[s].at.y, p[s].at.z, p[s].ground == kNone ? "nothing" : "something");
        } else if (!live) {
            g_spawned[s] = false;
        }
        g_rings[s].offer(p[s].at, ms, live, p[s].ground == kWorld);
    }

    for (int s = 0; s < kMaxClients; ++s) {
        if (!g_spawned[s]) continue;
        const rescue::why w = rescue::needs_rescue(g_watch[s], p[s].at, p[s].ground == kNone, ms);
        if (w == rescue::why::none) continue;
        g_watch[s].rescued = true;   // one attempt per spawn, found or not
        bool alive[kMaxClients], present[kMaxClients];
        rescue::vec3 now_at[kMaxClients];
        for (int q = 0; q < kMaxClients; ++q) {
            alive[q] = p[q].alive && g_spawned[q];
            present[q] = p[q].present;
            now_at[q] = p[q].at;
        }
        rescue::vec3 to;
        if (!rescue::pick_spot(g_rings, alive, kMaxClients, static_cast<size_t>(s), now_at, present, ms, &to)) {
            ENW_WARN("spawn_rescue: slot %d %s at (%.1f %.1f %.1f) and NO teammate spot to move them to", s,
                     rescue::why_name(w), p[s].at.x, p[s].at.y, p[s].at.z);
            game_link::get().send_log("warn", "spawn_rescue: slot %d %s, no teammate spot", s, rescue::why_name(w));
            continue;
        }
        const float org[3] = {to.x, to.y, to.z};
        const float zero[3] = {0, 0, 0};
        const bool ok = memory::write(p[s].gc + kPsOrigin, org) && memory::write(p[s].gc + kPsVelocity, zero);
        ++g_rescues;
        ENW_INFO("spawn_rescue: slot %d %s at (%.1f %.1f %.1f) -> moved to a teammate's spot (%.1f %.1f %.1f)%s", s,
                 rescue::why_name(w), p[s].at.x, p[s].at.y, p[s].at.z, to.x, to.y, to.z,
                 ok ? "" : " -- WRITE FAILED");
        game_link::get().send_log("info", "spawn_rescue: slot %d %s -> moved to (%.0f %.0f %.0f)", s,
                                  rescue::why_name(w), to.x, to.y, to.z);
    }
}

class spawn_rescue_component final : public component {
public:
    const char* name() const override { return "dedi_spawn_rescue"; }

    void post_unpack() override {
        if (!is_dedicated()) return;
        if (std::getenv("ENW_NO_SPAWN_RESCUE")) {
            ENW_WARN("spawn_rescue: OFF (ENW_NO_SPAWN_RESCUE): a late spawn at the map origin stays there");
            return;
        }
        referee::bind();
        referee::on_notify([](const referee::notify_event& ev) {
            if (ev.who == referee::notify_event::owner::level && ev.name == "all_players_connected") {
                g_round_started = true;
                ENW_INFO("spawn_rescue: round 1 started; later spawns are watched");
            }
        });
        referee::on_frame([](uint32_t ms) { on_frame(ms); });
        ENW_INFO("spawn_rescue: armed -- a spawn after round 1 at the origin, on nothing or falling 128+ units in "
                 "3 s is moved to where a living teammate stood (dedi.md section 30)");
    }

    void pre_destroy() override {
        if (g_rescues) ENW_INFO("spawn_rescue: %llu rescue(s) this process", static_cast<unsigned long long>(g_rescues));
    }
};

ENW_REGISTER_COMPONENT(spawn_rescue_component)

}  // namespace
}  // namespace enw::dedi
