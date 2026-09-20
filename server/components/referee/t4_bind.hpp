// Late-bound access to the game state the referee needs.
//
// WHY THIS FILE EXISTS AND WHY IT IS HERE AND NOT IN shared/t4/:
// the `re` agent owns shared/t4/ and has not published addresses.hpp yet. Rather
// than block, the referee/replay/chat/afk/knobs/pause components are written
// against this narrow interface. When shared/t4/addresses.hpp lands, the bodies
// in t4_bind.cpp get three lines each and this header keeps its shape.
//
// THE RULE EVERY ACCESSOR FOLLOWS: if the address is not bound, return a
// not-available result. Never dereference on a hope. A referee that silently
// reports nothing is recoverable; one that faults the game mid-round is not.
#pragma once
#include "../../../shared/core/enw.hpp"

#include <functional>
#include <optional>

namespace enw::referee {

// ---------------------------------------------------------------- binding --

struct binding_report {
    bool notify_hook = false;   // we can see script notifies
    bool script_vars = false;   // we can read/write level.* and player.*
    bool entities = false;      // g_entities / gentity_s
    bool clients = false;       // svs.clients / client_s (name, usercmd)
    bool server_cmd = false;    // SV_SendServerCommand
    bool chat_capture = false;  // G_Say hook (what a player types)
    bool dvars = false;         // Dvar_FindVar / set
    bool frame_hook = false;    // a per-server-frame callback

    bool any() const {
        return notify_hook || script_vars || entities || clients || server_cmd || dvars ||
               frame_hook || chat_capture;
    }
    std::string describe() const;
};

// Called once from post_unpack(). Idempotent. Binds whatever it can and logs the rest.
const binding_report& bind();
const binding_report& bound();

// --------------------------------------------------------------- notifies --

// Everything the notify hook can tell us about one notify.
struct notify_event {
    enum class owner { level, player, entity, unknown };
    owner who = owner::unknown;
    int slot = -1;        // player slot, when who == player
    int entnum = -1;      // entity number, when who == entity
    std::string name;     // the notify string ("between_round_over", a flag name, "trigger", ...)
    uint32_t game_ms = 0;
};

// Register a sink. Called on the GAME thread, inside the notify, so it must be
// cheap and must not re-enter script.
using notify_sink = std::function<void(const notify_event&)>;
void on_notify(notify_sink sink);

// ------------------------------------------------------------ chat capture --

// Called on the game thread from inside G_Say, BEFORE the engine echoes the line,
// so a host that wants to suppress a message has the chance to.
// slot is the speaker's entity/client number, or -1 if it could not be resolved.
using chat_sink = std::function<void(int slot, const std::string& text, bool team)>;
void on_chat(chat_sink sink);

// ---------------------------------------------------------- frame callback --

// Called once per server frame on the game thread. Used by the sampler, the
// score poller and game_link::pump().
using frame_sink = std::function<void(uint32_t game_ms)>;
void on_frame(frame_sink sink);

// --------------------------------------------------------- script variables --

// level.<field> / level.<field>[<key>] and <player>.<field>.
// All return nullopt when script_vars is not bound or the field is undefined.
std::optional<int> level_int(const char* field);
std::optional<float> level_float(const char* field);
std::optional<bool> level_bool(const char* field);
std::optional<int> level_map_int(const char* field, const char* key);   // level.zombie_vars["x"]
std::optional<float> level_map_float(const char* field, const char* key);

bool set_level_int(const char* field, int value);
bool set_level_float(const char* field, float value);
bool set_level_map_float(const char* field, const char* key, float value);

std::optional<int> player_int(int slot, const char* field);
std::optional<float> player_float(int slot, const char* field);
bool player_field_defined(int slot, const char* field);   // e.g. "revivetrigger"
bool set_player_int(int slot, const char* field, int value);

// Whether level.flag[<name>] is currently true. nullopt = cannot tell.
std::optional<bool> level_flag(const char* name);

// ----------------------------------------------------------------- clients --

struct client_view {
    bool active = false;
    std::string name;
    std::string xuid;       // steamid/xuid as a string, empty if unknown
    std::string userinfo;   // raw, for the connect-token check
};
int max_clients();
std::optional<client_view> client(int slot);

// Last usercmd for a client, for AFK scoring.
struct usercmd_view {
    int32_t server_time = 0;
    int32_t buttons = 0;
    int16_t view_pitch = 0;   // packed angles as the engine stores them
    int16_t view_yaw = 0;
    int8_t forwardmove = 0;
    int8_t rightmove = 0;
    uint8_t weapon = 0;
};
std::optional<usercmd_view> last_usercmd(int slot);

// ---------------------------------------------------------------- entities --

struct ent_view {
    int entnum = 0;
    float origin[3] = {0, 0, 0};
    float angles[3] = {0, 0, 0};
    int health = 0;
    bool alive = false;
    const char* classname = "";
};
std::optional<ent_view> player_ent(int slot);

// Live AI entities that are zombies. `max` caps the copy; returns how many were written.
size_t zombie_ents(ent_view* out, size_t max);

// Script fields on an arbitrary entity, for the trigger identification in
// referee/manifests (targetname, script_noteworthy, zombie_cost, script_flag).
std::optional<std::string> ent_string_field(int entnum, const char* field);
std::optional<int> ent_int_field(int entnum, const char* field);

// ------------------------------------------------------------------ output --

// A chat line to everyone (slot < 0) or one client. Returns false if unbound.
bool server_say(int slot, const std::string& text);
// Run a console command on the server.
bool console_command(const std::string& cmd);

// ------------------------------------------------------------------- dvars --
std::optional<std::string> dvar_get(const char* name);
bool dvar_set(const char* name, const char* value);

}  // namespace enw::referee
