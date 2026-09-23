// Unit test for server/components/replay/replay_events_model.hpp -- replay-events-v1 with no
// engine. Same pattern as pause_policy_test.cpp: not under server/components/ (CMake globs
// that into the DLL). Build and run:
//
//     cl /nologo /EHsc /std:c++17 server\tests\replay_events_test.cpp /Fe:build\replay_events_test.exe
//     build\replay_events_test.exe
//
//     g++ -std=c++17 server/tests/replay_events_test.cpp -o /tmp/ret && /tmp/ret
#include "../components/replay/replay_events_model.hpp"

#include <cstdio>
#include <string>
#include <vector>

using namespace enw::replay_ev;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}
static bool has(const std::vector<std::string>& v, const std::string& needle) {
    for (const auto& s : v) if (s.find(needle) != std::string::npos) return true;
    return false;
}
static int count(const std::vector<std::string>& v, const std::string& needle) {
    int n = 0;
    for (const auto& s : v) if (s.find(needle) != std::string::npos) ++n;
    return n;
}
static void dump(const char* tag, const std::vector<std::string>& v) {
    for (const auto& s : v) std::printf("  %s %s\n", tag, s.c_str());
}

static player_in P(int health, int weapon, const char* raw) {
    player_in p;
    p.present = true;
    p.alive = health > 0;
    p.health = health;
    p.weapon = weapon;
    p.weapon_raw = raw;
    p.have_events = true;
    p.have_stats = true;
    return p;
}

static zombie_in Z(int id, int hp, int attacker = -1, part hit = part::unknown) {
    zombie_in z;
    z.id = id;
    z.health = hp;
    z.last_attacker = attacker;
    z.hit = hit;
    return z;
}

// Push an engine event into a player's ring exactly as BG_AddPredictableEventToPlayerstate
// 0x410310 does: events[seq & 3] = ev; seq = (seq + 1) & 0xFF.
static void push_event(player_in& p, int ev) {
    p.events[p.event_seq & 3] = ev;
    p.event_seq = (p.event_seq + 1) & 0xFF;
}

static void test_labels() {
    check(label_weapon("zombie_thompson_upgraded").name == "thompson", "zombie_thompson_upgraded -> thompson");
    check(label_weapon("zombie_thompson_upgraded").pap, "zombie_thompson_upgraded -> pap");
    check(label_weapon("ray_gun").name == "ray_gun" && !label_weapon("ray_gun").pap, "ray_gun stays, no pap");
    check(label_weapon("ray_gun_upgraded").name == "ray_gun", "ray_gun_upgraded -> ray_gun");
    check(label_weapon("ptrs41_zombie").name == "ptrs41", "ptrs41_zombie -> ptrs41");
    check(label_weapon("ptrs41_zombie_upgraded").name == "ptrs41", "ptrs41_zombie_upgraded -> ptrs41");
    check(label_weapon("colt").name == "colt", "colt");
    check(label_weapon("30cal_bipod").name == "30cal_bipod", "30cal_bipod");
    check(label_weapon("zombie_").name == "zombie_", "bare prefix is not stripped to nothing");
    check(part_from_hitloc("head") == part::head && part_from_hitloc("helmet") == part::head &&
              part_from_hitloc("neck") == part::head, "head/helmet/neck are head");
    check(part_from_hitloc("torso_upper") == part::body, "torso is body");
    check(part_from_hitloc("") == part::unknown && part_from_hitloc("none") == part::unknown, "none is unknown");
    check(std::string(powerup_kind("zombie_ammocan")) == "max_ammo", "ammocan");
    check(std::string(powerup_kind("zombie_skull")) == "insta_kill", "skull");
    check(std::string(powerup_kind("zombie_x2_icon")) == "double_points", "x2");
    check(std::string(powerup_kind("zombie_bomb")) == "nuke", "bomb");
    check(std::string(powerup_kind("zombie_carpenter")) == "carpenter", "carpenter");
    check(std::string(powerup_kind("zombie_firesale")) == "fire_sale", "firesale");
    check(std::string(powerup_kind("zombie_pickup_perk")) == "other", "a zombie_pickup_* is other");
    check(powerup_kind("zombie_body") == nullptr && powerup_kind("") == nullptr, "not a power-up");
    check(powerup_is_timed("insta_kill") && powerup_is_timed("double_points") && !powerup_is_timed("nuke"), "timed");
}

static void test_json() {
    const std::string s = line("x").i("a", -3).b("b", true).n("c").f1("d", 1.25f).s("e", "q\"\\\n").done();
    check(s == "{\"t\":\"x\",\"a\":-3,\"b\":true,\"c\":null,\"d\":1.2,\"e\":\"q\\\"\\\\\\u000a\"}" ||
              s == "{\"t\":\"x\",\"a\":-3,\"b\":true,\"c\":null,\"d\":1.3,\"e\":\"q\\\"\\\\\\u000a\"}",
          "json line escapes and formats");
}

static void test_weapon_and_pap() {
    tracker t;
    std::vector<std::string> out;
    frame_in f;
    f.ms = 1000;
    f.players[0] = P(100, 3, "zombie_colt");
    t.step(f, out);
    check(count(out, "\"t\":\"weapon\"") == 1 && has(out, "\"name\":\"colt\",\"pap\":false,\"raw\":\"zombie_colt\""),
          "spawn emits the starting weapon");

    out.clear();
    f.ms = 1050;
    t.step(f, out);
    check(out.empty(), "no switch, nothing");

    out.clear();
    f.ms = 1100;
    f.players[0].weapon = 7;
    f.players[0].weapon_raw = "zombie_thompson";
    t.step(f, out);
    check(count(out, "\"t\":\"weapon\"") == 1 && has(out, "\"name\":\"thompson\""), "switch emits weapon");

    // pack-a-punch: the knuckle crack, then the upgraded gun
    out.clear();
    f.ms = 5000;
    f.players[0].weapon = 40;
    f.players[0].weapon_raw = "zombie_knuckle_crack";
    t.step(f, out);
    check(has(out, "\"t\":\"pap\"") && has(out, "\"state\":\"start\"") && has(out, "\"name\":\"thompson\""),
          "knuckle crack after the thompson is pap start for the thompson");

    out.clear();
    f.ms = 9000;
    f.players[0].weapon = 41;
    f.players[0].weapon_raw = "zombie_thompson_upgraded";
    t.step(f, out);
    check(has(out, "\"pap\":true") && has(out, "\"state\":\"done\""), "the upgraded gun is weapon pap:true + pap done");

    out.clear();
    f.ms = 9500;
    f.players[0].weapon = 7;
    f.players[0].weapon_raw = "zombie_thompson";
    t.step(f, out);
    f.ms = 9600;
    f.players[0].weapon = 41;
    f.players[0].weapon_raw = "zombie_thompson_upgraded";
    t.step(f, out);
    check(count(out, "\"t\":\"weapon\"") == 2 && !has(out, "\"t\":\"pap\""), "switching back to an upgraded gun is not a second pap");

    // weapon 0 ("none", e.g. mid last stand) emits nothing, and the next real weapon is a switch
    out.clear();
    f.players[0].weapon = 0;
    f.players[0].weapon_raw = "";
    t.step(f, out);
    check(out.empty(), "weapon 0 emits nothing");
    f.players[0].weapon = 41;
    f.players[0].weapon_raw = "zombie_thompson_upgraded";
    t.step(f, out);
    check(count(out, "\"t\":\"weapon\"") == 1, "back from none is a switch");

    // an unresolved name (weapon table unbound) emits no weapon event
    tracker t2;
    out.clear();
    frame_in g;
    g.players[1] = P(100, 3, "");
    t2.step(g, out);
    check(!has(out, "\"t\":\"weapon\""), "unresolved weapon name, no weapon event");
}

static void test_fire() {
    tracker t;
    std::vector<std::string> out;
    frame_in f;
    f.ms = 0;
    f.players[0] = P(100, 7, "zombie_mp40");
    f.players[0].event_seq = 250;   // near the 8-bit wrap on purpose
    t.step(f, out);
    check(!has(out, "\"t\":\"fire\""), "first sample is a baseline, never fire");

    out.clear();
    f.ms = 50;
    push_event(f.players[0], kEvFireWeapon);
    push_event(f.players[0], 0x09);   // something else (a footstep-class event)
    push_event(f.players[0], kEvFireWeapon);
    t.step(f, out);
    check(count(out, "\"t\":\"fire\"") == 2 && has(out, "\"name\":\"mp40\""), "two shots in a frame, other events ignored");

    out.clear();
    f.ms = 100;
    push_event(f.players[0], kEvFireWeaponLastShot);   // crosses 255 -> 0
    push_event(f.players[0], kEvFireWeapon);
    push_event(f.players[0], kEvFireWeapon);
    t.step(f, out);
    check(count(out, "\"t\":\"fire\"") == 3, "last shot counts, the 8-bit wrap is handled");

    out.clear();
    f.ms = 150;
    for (int i = 0; i < 6; ++i) push_event(f.players[0], kEvFireWeapon);
    t.step(f, out);
    check(count(out, "\"t\":\"fire\"") == 4, "more than four in one frame: the ring holds four");

    // the cap: 40 per player per second
    tracker c;
    frame_in g;
    g.players[2] = P(100, 9, "zombie_ppsh");
    g.ms = 2000;
    c.step(g, out);
    out.clear();
    for (int fr = 1; fr <= 19; ++fr) {
        g.ms = 2000 + fr * 50;
        for (int i = 0; i < 4; ++i) push_event(g.players[2], kEvFireWeapon);
        c.step(g, out);
    }
    check(count(out, "\"t\":\"fire\"") == 40, "capped at 40 fire events a second");
    check(c.stats().fire_capped == 76 - 40, "the rest are counted as capped");
}

static void test_damage_taken() {
    tracker t;
    std::vector<std::string> out;
    frame_in f;
    f.players[0] = P(100, 3, "zombie_colt");
    f.zombies = {Z(260, 150)};
    t.step(f, out);
    out.clear();
    f.ms = 50;
    f.players[0].health = 60;
    f.players[0].last_attacker = 260;
    t.step(f, out);
    check(has(out, "\"t\":\"damage\",\"ms\":50,\"slot\":0,\"by\":260,\"hp\":60"), "swipe by zombie 260, hp after");

    out.clear();
    f.ms = 100;
    f.players[0].health = 70;   // regen
    t.step(f, out);
    check(!has(out, "\"t\":\"damage\""), "health going up is not damage");

    out.clear();
    f.ms = 150;
    f.players[0].health = 40;
    f.players[0].last_attacker = 0;   // own grenade
    t.step(f, out);
    check(has(out, "\"by\":null,\"hp\":40"), "a non-zombie attacker is by:null");
}

static void test_hits_and_kills() {
    tracker t;
    std::vector<std::string> out;
    frame_in f;
    f.players[0] = P(100, 7, "zombie_mp40");
    f.players[1] = P(100, 3, "zombie_colt");
    f.zombies = {Z(254, 150), Z(255, 150)};
    t.step(f, out);
    check(t.live_ids().size() == 2, "live ids tracked");

    out.clear();
    f.ms = 50;
    f.zombies = {Z(254, 110, 0, part::body), Z(255, 150)};
    t.step(f, out);
    check(has(out, "\"t\":\"hit\",\"ms\":50,\"slot\":0,\"zid\":254,\"part\":\"body\",\"dmg\":40"), "body hit by slot 0");

    out.clear();
    f.ms = 100;
    f.zombies = {Z(254, 10, 1, part::head), Z(255, 150)};
    t.step(f, out);
    check(has(out, "\"slot\":1,\"zid\":254,\"part\":\"head\",\"dmg\":100"), "head hit by slot 1");

    // zombie hurt by a non-player: no hit
    out.clear();
    f.ms = 150;
    f.zombies = {Z(254, 10, 1, part::head), Z(255, 120, 600)};
    t.step(f, out);
    check(!has(out, "\"t\":\"hit\""), "a trap's damage is nobody's hit");

    // kill: 254 leaves the live list; the engine still says slot 1 hit it in the head; the
    // kills/headshots counters move the SAME frame
    out.clear();
    f.ms = 200;
    f.zombies = {Z(255, 120)};
    f.gone = {Z(254, 0, 1, part::head)};
    f.players[1].kills = 1;
    f.players[1].headshots = 1;
    t.step(f, out);
    check(has(out, "\"t\":\"hit\",\"ms\":200,\"slot\":1,\"zid\":254,\"part\":\"head\",\"dmg\":10,\"kill\":true"),
          "lethal headshot, dmg = the health it had left, kill:true");
    f.gone.clear();

    // kill where the engine lost the attacker (actor freed): the counters decide, and the
    // headshot counter moving a frame LATER still makes it a head kill
    out.clear();
    f.ms = 250;
    f.zombies = {};
    f.gone = {Z(255, 0, -1, part::unknown)};
    f.players[0].kills = 1;
    t.step(f, out);
    check(!has(out, "\"t\":\"hit\""), "waits for the headshot counter");
    f.gone.clear();
    out.clear();
    f.ms = 300;
    f.players[0].headshots = 1;
    t.step(f, out);
    check(has(out, "\"t\":\"hit\",\"ms\":250,\"slot\":0,\"zid\":255,\"part\":\"head\",\"dmg\":120,\"kill\":true"),
          "attributed by the kills counter, head from the late headshot counter, stamped at the death");

    // a death nobody's counter claims (nuke / round cleanup) is not a hit
    out.clear();
    f.ms = 350;
    f.zombies = {Z(270, 150)};
    t.step(f, out);
    f.zombies = {};
    f.gone = {Z(270, 0, 0, part::body)};   // slot 0 was the last to hurt it, but no kill credit
    f.ms = 400;
    t.step(f, out);
    f.gone.clear();
    for (int i = 0; i < 4; ++i) { f.ms += 50; t.step(f, out); }
    check(!has(out, "\"zid\":270"), "no kill credit, no kill hit");
    check(t.stats().kill_unattributed == 1, "counted as unattributed");

    // a body kill: attacker known, no headshot ever -> body after the wait
    out.clear();
    f.zombies = {Z(271, 150)};
    t.step(f, out);
    f.zombies = {};
    f.gone = {Z(271, 0, 0, part::unknown)};
    f.players[0].kills = 2;
    f.ms = 1000;
    t.step(f, out);
    f.gone.clear();
    f.ms = 1050; t.step(f, out);
    f.ms = 1100; t.step(f, out);
    check(has(out, "\"ms\":1000,\"slot\":0,\"zid\":271,\"part\":\"body\",\"dmg\":150,\"kill\":true"), "body kill after the wait");
}

static void test_powerups() {
    tracker t;
    std::vector<std::string> out;
    frame_in f;
    f.powerups_valid = true;
    f.players[0] = P(100, 3, "zombie_colt");
    powerup_in scenery;
    scenery.id = 300;
    scenery.kind = "nuke";
    f.powerups = {scenery};
    t.step(f, out);
    check(!has(out, "powerup"), "baseline: a model already on the map is scenery");

    out.clear();
    powerup_in skull;
    skull.id = 400;
    skull.kind = "insta_kill";
    skull.pos[0] = 100; skull.pos[1] = 0; skull.pos[2] = 40;
    f.ms = 5000;
    f.powerups = {scenery, skull};
    t.step(f, out);
    check(has(out, "\"t\":\"powerup\",\"ms\":5000,\"id\":400,\"kind\":\"insta_kill\",\"x\":100.0,\"y\":0.0,\"z\":40.0,\"state\":\"spawn\""),
          "a new skull is a spawn");

    out.clear();
    f.ms = 8000;
    f.players[0].pos[0] = 80;   // standing on it
    f.powerups = {scenery};
    t.step(f, out);
    check(has(out, "\"state\":\"pickup\",\"by\":0,\"until\":38000"), "vanished next to slot 0: pickup, 30 s until");

    out.clear();
    powerup_in ammo;
    ammo.id = 401;
    ammo.kind = "max_ammo";
    ammo.pos[0] = 2000;
    f.ms = 9000;
    f.powerups = {scenery, ammo};
    t.step(f, out);
    f.ms = 35500;
    f.powerups = {scenery};
    t.step(f, out);
    check(has(out, "\"id\":401,\"kind\":\"max_ammo\",\"x\":2000.0,\"y\":0.0,\"z\":0.0,\"state\":\"expire\""),
          "vanished far from everyone: expire, no until");

    out.clear();
    f.powerups = {};
    t.step(f, out);
    check(!has(out, "powerup"), "scenery leaving is not an event");

    tracker off;
    frame_in g;
    g.powerups_valid = false;
    powerup_in x;
    x.id = 5;
    x.kind = "nuke";
    g.powerups = {x};
    out.clear();
    off.step(g, out);
    off.step(g, out);
    check(!has(out, "powerup"), "unbound model table: no powerup events at all");
}

static void test_reconnect() {
    tracker t;
    std::vector<std::string> out;
    frame_in f;
    f.players[3] = P(100, 41, "zombie_mp40_upgraded");
    t.step(f, out);
    check(count(out, "\"state\":\"done\"") == 1, "joining holding an upgraded gun announces it once");
    f.players[3].present = false;
    t.step(f, out);
    f.players[3].present = true;
    out.clear();
    t.step(f, out);
    check(count(out, "\"t\":\"weapon\"") == 1 && !has(out, "\"t\":\"pap\""), "a reconnect re-sends the weapon, not the pap");

    t.reset();
    out.clear();
    t.step(f, out);
    check(count(out, "\"state\":\"done\"") == 1, "a new match forgets");
}

int main() {
    test_labels();
    test_json();
    test_weapon_and_pap();
    test_fire();
    test_damage_taken();
    test_hits_and_kills();
    test_powerups();
    test_reconnect();
    std::printf("replay_events_test: %d passed, %d failed\n", g_pass, g_fail);
    (void)&dump;   // kept for debugging a failing case: dump("out", out)
    return g_fail ? 1 : 0;
}
