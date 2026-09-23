// A dedicated server answers "how high is the water here?" the way a solo game does
// (lane G2, dedi.md section 27).
//
// ---------------------------------------------------------------------------
// The bug B played into on 2026-09-23 (nacht_reimagined "floating", Nuketown down on spawn)
// ---------------------------------------------------------------------------
// Player movement asks for the water surface under a point (0x46DA70, called from the pmove
// code; also script `getwaterheight`, missiles, physics). That starts at 0x6F3F70:
//
//     006F3F77  mov eax,[0x42B721C]          ; r_gfxopt_water_simulation
//     006F3F7C  cmp byte [eax+0x10],0        ; off -> 0x6F45B0: the map's own static
//     006F3F81  je  0x6F3FE8                 ;   water grid, -32768 (0x8AF860) = no water
//     006F3F83  cmp byte [0x4DDAF54],0
//     006F3F8C  ... 0x6F2330                 ; point inside the 256x256 sim window?
//     006F3FB4  call 0x6F3E00                ; sample the wave buffers
//     006F3FB9  mov edx,[0x4DD8BD0]          ; + the sim window's BASE HEIGHT grid (int16)
//
// The sim window (0x4DD8BD0 and the wave buffers) is the RENDERER's: it is scrolled round the
// local viewer and filled from the static grid by renderer code (0x6F23C0) that a headless
// server never runs. `watersim_pool.cpp` makes the engine allocate the buffers so the server
// stops faulting on them -- but they stay ZERO, so every point inside the window reads
// "water surface at z = 0". A map whose floor is below 0 is then under water on the server:
//
//   * nacht_reimagined (floor z -87): the player swims at the surface, origin ~-50, never on
//     the ground (solo_parity: `ground none`, vel z +-3 for the whole game). The client, whose
//     renderer filled the grid correctly, predicts walking on the floor: B's "not touching the
//     floor, missing a bunch of inputs, floating".
//   * zm_nuked (floor z ~-390): the player spawns 390 units under water and drowns
//     (`player_swimDamage` every tick: 100 -> 75 -> 39 in 150 ms, `damage by: null`) -- B's
//     "downed the instant I spawned".
//   * stock Nacht (floor ~0), bridge_zombie (170), battlestar (16) are above the phantom
//     surface, which is why they looked fine.
// A solo (listen) game on the same spawn falls to the floor at -87.6 with full health.
//
// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------
// Turn the renderer's water simulation off in the dedicated server's process, for every map:
// r_gfxopt_water_simulation 0 (it is the Options menu's "water simulation" switch; the dvar is
// registered on the dedi by R_RegisterDvars). The server then takes the engine's own non-sim
// path, 0x6F45B0: the map's static water grid, "no water" where the map has none. Clients are
// untouched (their renderer owns the sim and fills it correctly). Held every second, because a
// config exec or a `set` could turn it back on. ENW_DEDI_WATER_SIM=1 leaves the engine alone
// (the control arm).
//
// Clean room: our own code, from our own dump.
#include "component.hpp"
#include "dedicated.hpp"
#include "frame.hpp"
#include "game.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <cstdint>
#include <cstdlib>

namespace enw::dedi {
namespace {

constexpr uintptr_t kWaterSimSlot = 0x42B721C;   // dvar_s* r_gfxopt_water_simulation
constexpr uintptr_t kGateSite = 0x6F3F77;        // A1 1C 72 2B 04 80 78 10 00 57 74 65

uintptr_t g_dvar = 0;
uint64_t g_reasserts = 0;

bool gate_bytes_ok() {
    static const uint8_t want[] = {0xA1, 0x1C, 0x72, 0x2B, 0x04, 0x80, 0x78, 0x10, 0x00, 0x57, 0x74, 0x65};
    uint8_t have[sizeof want] = {};
    if (!memory::read_raw(enw::at(kGateSite), have, sizeof have)) return false;
    for (size_t i = 0; i < sizeof want; ++i) if (have[i] != want[i]) return false;
    return true;
}

// Returns the dvar's current value (0/1), or -1 when it cannot be read.
int force_off(const char* when) {
    if (!g_dvar) return -1;
    uint8_t cur = 0, lat = 0;
    if (!memory::read(g_dvar + 0x10, &cur)) return -1;
    memory::read(g_dvar + 0x20, &lat);
    if (cur == 0 && lat == 0) return 0;
    const uint8_t zero = 0;
    memory::write(g_dvar + 0x10, zero);
    memory::write(g_dvar + 0x20, zero);
    ++g_reasserts;
    ENW_INFO("dedi_water_sim_off: %s: r_gfxopt_water_simulation %u -> 0 (latched %u -> 0). The server now reads the "
             "map's static water grid (0x6F45B0) instead of the renderer's unfilled sim window, whose zero "
             "base heights put a water surface at z=0 over every map (dedi.md section 27).",
             when, cur, lat);
    return cur;
}

class water_sim_off_component final : public component {
public:
    const char* name() const override { return "dedi_water_sim_off"; }
    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_WATER_SIM")) {
            ENW_WARN("dedi_water_sim_off: OFF (ENW_DEDI_WATER_SIM set): the server keeps the renderer's water "
                     "simulation, whose base heights are all zero on a dedicated server -- a map below z=0 is "
                     "under water here (the control arm, dedi.md section 27)");
            return;
        }
        if (!gate_bytes_ok()) {
            ENW_ERROR("dedi_water_sim_off: NOT applied: the water-height gate at 0x%08X is not what this build "
                      "expects (%s). A map below z=0 may be under water on this server.",
                      static_cast<unsigned>(kGateSite), memory::hex_dump(enw::at(kGateSite), 12).c_str());
            return;
        }
        uint32_t slot = 0;
        memory::read(enw::at(kWaterSimSlot), &slot);
        const auto found = reinterpret_cast<uintptr_t>(game::find_dvar("r_gfxopt_water_simulation"));
        if (!slot || slot != found) {
            ENW_ERROR("dedi_water_sim_off: NOT applied: [0x%08X]=%08X but Dvar_FindVar(r_gfxopt_water_simulation)="
                      "%08X", static_cast<unsigned>(kWaterSimSlot), slot, static_cast<unsigned>(found));
            return;
        }
        g_dvar = slot;
        force_off("post_init");
        enw::frame::subscribe("dedi_water_sim_off", [this](uint64_t) {
            const DWORD now = ::GetTickCount();
            if (now - last_ < 1000) return;
            last_ = now;
            force_off("held");
        });
    }

    void pre_destroy() override {
        if (g_dvar) ENW_INFO("dedi_water_sim_off: water simulation forced off %llu time(s) this process",
                             static_cast<unsigned long long>(g_reasserts));
    }

private:
    DWORD last_ = 0;
};

ENW_REGISTER_COMPONENT(water_sim_off_component)

}  // namespace

// For solo_parity's self-check: -1 unknown, else the current value.
int water_sim_value() {
    if (!g_dvar) {
        const auto d = reinterpret_cast<uintptr_t>(game::find_dvar("r_gfxopt_water_simulation"));
        if (!d) return -1;
        uint8_t v = 0;
        return memory::read(d + 0x10, &v) ? v : -1;
    }
    uint8_t v = 0;
    return memory::read(g_dvar + 0x10, &v) ? v : -1;
}

}  // namespace enw::dedi
