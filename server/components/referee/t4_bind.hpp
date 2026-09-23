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
    // The co-op scoreboard counters are NATIVE gclient_s fields, not script variables
    // (referee.md §16): `player.score`, `.kills`, `.downs`, `.revives`, `.headshots`,
    // `.assists` all resolve through the client field table at 0x83C568 to plain ints
    // at gclient + 0x20BC..0x20D0. True only when bind() has re-read that table and
    // the two code sites that prove the offsets out of THIS process's image.
    bool client_fields = false;

    bool any() const {
        return notify_hook || script_vars || entities || clients || server_cmd || dvars ||
               frame_hook || chat_capture || client_fields;
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
    std::string name;     // resolved notify string, EMPTY until SL_ConvertToString is bound
    int name_id = -1;     // the raw script-string id; always set
    int owner_id = 0;     // notifyListOwnerId, for correlating non-level notifies
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
// How many lines the capture hook has reported. MUST stay 0 in an idle game.
uint64_t chat_capture_count();

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

// ------------------------------------------------ native client fields --
//
// The six counters the game's own Tab scoreboard shows, read straight out of the
// player's gclient_s (referee.md §16). They are what the scripts write when they do
// `self.score += n` (_zombiemode_score.gsc), `attacker.kills++` / `.headshots++`
// (_gameskill.gsc auto_adjust_enemy_died, threaded on every spawned AI by
// _spawner.gsc), `self.downs++` (_laststand.gsc) and `reviver.revives++`
// (_laststand.gsc revive_success) -- the engine resolves those names to native
// fields, so no script-variable access is needed to read them.
//
// `player_int(slot, "score"|"kills"|"assists"|"downs"|"revives"|"headshots")` answers
// from here too; every other field name is still a script variable and still nullopt.
struct client_stats {
    int score = 0;
    int kills = 0;
    int assists = 0;
    int downs = 0;
    int revives = 0;
    int headshots = 0;
};
std::optional<client_stats> player_stats(int slot);

// ----------------------------------------------------------------- clients --

struct client_view {
    bool active = false;
    std::string name;
    std::string xuid;       // steamid/xuid as a string, empty if unknown
    std::string userinfo;   // raw, for the connect-token check
    // A server-side test client (dedicated/bots.cpp, dev knobs only). Reported with
    // active=false so the referee, the replay and AFK never treat a soak bot as a player:
    // no roster row, no auth, no kick.
    bool bot = false;
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
// `angles` is filled (currentOrigin + 12, the same read player_ent makes) -- replay.md 8.4.
size_t zombie_ents(ent_view* out, size_t max);

// Non-player, non-actor entities whose classname starts with `prefix` ("grenade"),
// health not required. For the replay's grenade track (replay.md 8.6).
size_t classname_ents(const char* prefix, ent_view* out, size_t max);

// Calls `fn(classname)` once per DISTINCT classname seen on a non-player entity this
// process, the first time it is seen. A census, so the first real game tells us what a
// T4 thrown grenade is actually called instead of us guessing.
void classname_census(void (*fn)(const char* classname, int entnum));

// Script fields on an arbitrary entity, for the trigger identification in
// referee/manifests (targetname, script_noteworthy, zombie_cost, script_flag).
std::optional<std::string> ent_string_field(int entnum, const char* field);
std::optional<int> ent_int_field(int entnum, const char* field);

// ------------------------------------------------ replay-events-v1 reads --
//
// What the 3D viewer needs beyond positions: the gun in each player's hands, its ammo, the
// shots, who hit which zombie where, who hit the player, and the power-up models. All of it
// is plain memory read once per server frame; there is NO new hook. Every offset is proven
// out of THIS process's image at bind time (the instruction bytes that use it), one flag per
// group, and a group whose bytes do not match reads nothing. Addresses and sources:
// docs/protocol/replay-events-v1.md section 5.
struct combat_binding {
    bool weapons = false;   // ps.weapon +0x104, bg_weaponDefs 0x8F6770, clip/stock indices
    bool events = false;    // ps.eventSequence +0xD0, ps.events[4] +0xD4, EV_FIRE_WEAPON 0x1C/0x1D
    bool attacker = false;  // gentity.sentient +0x188 -> sentient.lastAttacker +0x2C (G_Damage)
    bool hitloc = false;    // gentity.actor +0x184 -> actor.damageHitLoc +0xD68 (script string)
    bool models = false;    // gentity.model +0x198 -> model configstring script string 0x2350F40
    std::string describe() const;
};
const combat_binding& combat_bound();

struct player_combat {
    int weapon = 0;              // ps.weapon, 0 = none
    std::string weapon_raw;      // engine name ("zombie_thompson_upgraded"), empty = unresolved
    bool have_ammo = false;
    int clip = 0;                // ammoclip[def->iClipIndex] -- what getcurrentweaponclipammo returns
    int ammo = 0;                // ammo[def->iAmmoIndex] -- getweaponammostock
    bool have_events = false;
    int event_seq = 0;
    int events[4] = {0, 0, 0, 0};
    int last_attacker = -1;      // entity number, -1 none / unbound
};
std::optional<player_combat> player_combat_state(int slot);

// What can still be read about an entity (a live zombie, or one that just left the live
// list): the last attacker G_Damage recorded and the actor's last hit location name.
struct ent_damage_view {
    int health = 0;
    int last_attacker = -1;
    std::string hitloc;          // "head", "helmet", "torso_upper", ... empty = unknown
};
ent_damage_view ent_damage(int entnum);

// Entities of classname script_model whose model name `want` accepts, with the model name.
// The model-index -> name cache is per match: call combat_new_match() when a match starts.
struct model_ent_view {
    int entnum = 0;
    float origin[3] = {0, 0, 0};
    const char* model = "";      // points into the engine's script-string table; copy it
};
size_t model_ents(bool (*want)(const char* model), model_ent_view* out, size_t max);
void combat_new_match();

// ------------------------------------------------------------------ output --

// A chat line to everyone (slot < 0) or one client. Returns false if unbound.
bool server_say(int slot, const std::string& text);
// Run a console command on the server.
bool console_command(const std::string& cmd);

// ------------------------------------------------------- the current round --
// The referee counts rounds off the `between_round_over` notify (referee.cpp). The
// replay sampler needs the same number to stamp on every `snap` so a chunk is
// self-describing (replay.md section 3, gap 3), and the two components cannot see each
// other's state. This is the one shared cell rather than a second counter that could
// disagree with the first.
void set_current_round(int n);
int current_round();

// ------------------------------------------------------- is a match running --
// Set false by the referee on game over and true again when a new match starts
// (map_restart). The replay sampler reads it and stops producing `snap` messages,
// because a dedicated server lives THROUGH game over (no_save_reload.cpp) and would
// otherwise keep recording the intermission and the empty map into the replay file
// the host has already closed. Same one-shared-cell reasoning as current_round():
// the two components cannot see each other's state.
void set_recording(bool on);
bool recording();

// ------------------------------------------------------------------- dvars --
std::optional<std::string> dvar_get(const char* name);
bool dvar_set(const char* name, const char* value);

}  // namespace enw::referee
