// Knobs: change the game's settings at runtime.
//
// The interesting knobs are NOT dvars. Reading the extracted scripts
// (docs/kickstart/referee.md §2.1, §5.5) the zombies economy lives in script
// variables on `level`:
//
//   level.zombie_health                     current per-zombie health
//   level.zombie_move_speed                 set to round_number * 8 each round
//   level.zombie_vars["zombie_health_increase"]          +per round, rounds 2-9
//   level.zombie_vars["zombie_health_increase_percent"]  x per round, round 10+
//   level.zombie_vars["zombie_spawn_delay"]              x0.95 each round, floor 0.08
//   level.zombie_vars["zombie_max_ai"]                   max alive
//   level.zombie_vars["zombie_ai_per_player"]            scales with get_players().size
//   level.zombie_vars["zombie_between_round_time"]
//   level.zombie_treasure_chest_cost                     magic box price
//   level.round_number                                   start round
//
// THE TRAP, and it is the reason this component exists rather than a `set` in
// the host: `ai_calculate_health()` RECOMPUTES level.zombie_health from its own
// previous value at the top of every round. A one-shot write is undone within
// one round. So a health knob is held as a *policy* by this component and
// re-applied on every round change. Same for move speed, which round_think()
// overwrites with `round_number * 8` unconditionally.
//
// Dvars are the easy half (g_speed, player_lastStandBleedoutTime, sv_fps, ...).
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../referee/t4_bind.hpp"

#include <map>
#include <string>

namespace enw {
namespace {

// A knob the engine will fight us over, and how we win.
enum class policy {
    once,        // write it and forget (start round, box cost)
    per_round,   // re-apply after every round change (health, move speed)
};

struct knob_def {
    const char* id;
    const char* level_field;   // level.<field>, or nullptr for a map entry
    const char* map_field;     // level.<map_field>["<key>"]
    const char* map_key;
    policy how;
    bool is_float;
};

const knob_def kKnobs[] = {
    {"zombie_health",        "zombie_health",     nullptr,        nullptr,                          policy::per_round, false},
    {"zombie_speed",         "zombie_move_speed", nullptr,        nullptr,                          policy::per_round, false},
    {"zombie_max_alive",     nullptr,             "zombie_vars",  "zombie_max_ai",                  policy::per_round, false},
    {"zombie_per_player",    nullptr,             "zombie_vars",  "zombie_ai_per_player",           policy::per_round, false},
    {"zombie_spawn_delay",   nullptr,             "zombie_vars",  "zombie_spawn_delay",             policy::per_round, true},
    {"between_round_time",   nullptr,             "zombie_vars",  "zombie_between_round_time",      policy::per_round, true},
    {"health_increase",      nullptr,             "zombie_vars",  "zombie_health_increase",         policy::once,      true},
    {"health_increase_pct",  nullptr,             "zombie_vars",  "zombie_health_increase_percent", policy::once,      true},
    {"box_cost",             "zombie_treasure_chest_cost", nullptr, nullptr,                        policy::once,      false},
    {"start_round",          "round_number",      nullptr,        nullptr,                          policy::once,      false},
};

const knob_def* find_knob(const std::string& id) {
    for (const auto& k : kKnobs) {
        if (id == k.id) return &k;
    }
    return nullptr;
}

class knobs final : public component {
public:
    const char* name() const override { return "knobs"; }

    void post_load() override {
        auto& link = game_link::get();
        link.on("set",
                [this](const json::value& m) {
                    const std::string id = m.str_or("id");
                    const std::string which = m.str_or("dvar");
                    const std::string value = m.str_or("value");
                    apply(id, which, value);
                },
                /*want_game_thread=*/true);
    }

    void post_unpack() override {
        referee::bind();
        // Re-apply the per-round policies just after the round advances.
        referee::on_notify([this](const referee::notify_event& ev) {
            if (ev.name == "between_round_over") reapply();
        });
    }

private:
    void apply(const std::string& id, const std::string& which, const std::string& value) {
        auto reply = [&](bool ok, const char* err) {
            if (!id.empty()) game_link::get().send_reply(id, ok, err ? err : "");
        };

        if (const knob_def* k = find_knob(which)) {
            if (!referee::bound().script_vars) return reply(false, "script vars not bound");
            held_[which] = value;
            const bool ok = write(*k, value);
            ENW_INFO("knobs: %s = %s (%s) -> %s", which.c_str(), value.c_str(),
                     k->how == policy::per_round ? "held per round" : "one shot",
                     ok ? "ok" : "failed");
            return reply(ok, ok ? nullptr : "write failed");
        }

        // Not one of ours: treat it as a plain dvar.
        if (!referee::bound().dvars) return reply(false, "dvars not bound");
        const bool ok = referee::dvar_set(which.c_str(), value.c_str());
        ENW_INFO("knobs: dvar %s = %s -> %s", which.c_str(), value.c_str(), ok ? "ok" : "failed");
        reply(ok, ok ? nullptr : "no such dvar");
    }

    static bool write(const knob_def& k, const std::string& v) {
        if (k.level_field) {
            return k.is_float ? referee::set_level_float(k.level_field, std::strtof(v.c_str(), nullptr))
                              : referee::set_level_int(k.level_field, std::atoi(v.c_str()));
        }
        if (k.map_field && k.map_key) {
            return referee::set_level_map_float(k.map_field, k.map_key, std::strtof(v.c_str(), nullptr));
        }
        return false;
    }

    // Called on every round change: the scripts have just recomputed the values
    // we care about, so put ours back.
    void reapply() {
        for (const auto& [id, value] : held_) {
            const knob_def* k = find_knob(id);
            if (!k || k->how != policy::per_round) continue;
            write(*k, value);
        }
    }

    std::map<std::string, std::string> held_;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::knobs)
