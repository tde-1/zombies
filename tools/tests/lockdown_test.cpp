// Unit tests for the lockdown lane (esc-menu.md §10): the ENW console's model
// (client-dll/components/console_model.hpp) against the REAL embedded settings schema, and
// the main-menu lockdown's state machine (menu_lockdown_model.hpp).
//
//   build\<name>\RelWithDebInfo\lockdown_test.exe     exit code = failures
#include "console_model.hpp"
#include "menu_lockdown_model.hpp"

#include <cstdio>
#include <string>

namespace {

const unsigned char kSchema[] = {
#include "enw_settings_schema.inc"
    0};

int g_pass = 0, g_fail = 0;

void check(bool ok, const char* what, const std::string& detail = {}) {
    if (ok) { ++g_pass; std::printf("  ok   %s\n", what); }
    else { ++g_fail; std::printf("  FAIL %s %s\n", what, detail.c_str()); }
}

}  // namespace

using namespace enw;

int main() {
    const std::string_view text(reinterpret_cast<const char*>(kSchema), sizeof kSchema - 1);
    settings::schema s;
    std::string err;
    check(settings::load(text, &s, &err), "the embedded schema loads", err);

    std::printf("console: parse\n");
    {
        auto c = console::parse("cg_fov 90");
        check(c.v == console::verb::set && c.name == "cg_fov" && c.value == "90", "`cg_fov 90` is a set");
        c = console::parse("  /sensitivity  ");
        check(c.v == console::verb::get && c.name == "sensitivity", "`/sensitivity` (leading slash, spaces) is a get");
        c = console::parse("seta cg_fov \"100\"");
        check(c.v == console::verb::set && c.name == "cg_fov" && c.value == "100", "`seta cg_fov \"100\"` is a set, quotes stripped");
        c = console::parse("cg_fov 90; sv_cheats 1");
        check(c.v == console::verb::refused, "a `;` is refused: one setting at a time, nothing chained to the engine");
        c = console::parse("cg_fov 90 100");
        check(c.v == console::verb::set && c.value == "90 100", "several words are one value (and validate refuses it for fov)");
        c = console::parse("set cg_fov");
        check(c.v == console::verb::refused, "`set` without a value is refused with its usage");
        check(console::parse("help").v == console::verb::help && console::parse("?").v == console::verb::help, "help and ?");
        check(console::parse("clear").v == console::verb::clear, "clear");
        check(console::parse("cvarlist snd").v == console::verb::list && console::parse("cvarlist snd").name == "snd", "cvarlist <prefix> lists");
        check(console::parse("reset cg_fov").v == console::verb::reset, "reset <setting>");
        check(console::parse("").v == console::verb::none && console::parse("   ").v == console::verb::none, "an empty line does nothing");
        // [C1] B: `/quit` must work, with or without the slash; quick commands too.
        for (const char* q : {"quit", "/quit", "\\quit", "QUIT", "exit", "/exit", "  /quit  "})
            check(console::parse(q).v == console::verb::quit, (std::string("quit: ") + q).c_str());
        check(console::parse("quit now").v == console::verb::refused, "quit takes nothing after it");
        for (const char* d : {"disconnect", "/disconnect", "dc", "leave"})
            check(console::parse(d).v == console::verb::disconnect, (std::string("disconnect: ") + d).c_str());
        for (const char* r : {"restart", "/restart", "map_restart", "fast_restart"})
            check(console::parse(r).v == console::verb::restart, (std::string("restart: ") + r).c_str());
        check(console::parse("/clear").v == console::verb::clear && console::parse("cls").v == console::verb::clear, "clear, cls");
        check(console::parse("apply").v == console::verb::apply && console::parse("vid_restart").v == console::verb::apply, "apply, vid_restart");
        c = console::parse("help fov");
        check(c.v == console::verb::help && c.name == "fov", "help <name>");
        c = console::parse("bind g use");
        check(c.v == console::verb::bind && c.name == "g" && c.value == "use", "bind g use");
        c = console::parse("bind MOUSE4 \"+actionslot 3\"");
        check(c.v == console::verb::bind && c.value == "+actionslot 3", "bind with a quoted action");
        c = console::parse("bind mouse4 +actionslot 3");
        check(c.v == console::verb::bind && c.value == "+actionslot 3", "bind with an unquoted two-word action");
        c = console::parse("bind f");
        check(c.v == console::verb::bind && c.name == "f" && c.value.empty(), "bind <key> alone shows it");
        check(console::parse("bind").v == console::verb::refused, "bind with nothing: usage");
        c = console::parse("unbind f");
        check(c.v == console::verb::unbind && c.name == "f", "unbind f");
        check(console::parse("unbind").v == console::verb::refused, "unbind with nothing: usage");
        check(console::parse("binds").v == console::verb::binds && console::parse("list").v == console::verb::list, "binds, list");
        c = console::parse("fov \"90\"");
        check(c.v == console::verb::set && c.value == "90", "a quoted value");
        c = console::parse("/fov 90");
        check(c.v == console::verb::set && c.name == "fov" && c.value == "90", "a slashed setting");
        c = console::parse("aspect wide 16:9");
        check(c.v == console::verb::set && c.value == "wide 16:9", "a two-word value without quotes");
    }

    std::printf("console: what may be set\n");
    {
        const auto* fov = console::resolve(s, "cg_fov");
        check(fov && fov->id == "fov", "cg_fov resolves to the catalogue's field of view");
        check(console::resolve(s, "FOV") == fov, "the catalogue id works too, any case");
        const auto* sens = console::resolve(s, "sensitivity");
        check(sens && sens->dvar == "sensitivity", "sensitivity resolves");
        for (const char* bad : {"sv_cheats", "developer", "timescale", "cg_fovscale", "con_external", "monkeytoy", "ai_corpseCount",
                                "g_speed", "player_sprintUnlimited", "quit", "exec", "bind", "vstr", "connect", "name", "enw_token",
                                "logfile", "fs_game", "god", "noclip", "give", "map"})
            check(console::resolve(s, bad) == nullptr, (std::string("not a console setting: ") + bad).c_str());
        check(console::refusal_for("sv_cheats") == "sv_cheats: locked", "a forbidden dvar is 'locked'", console::refusal_for("sv_cheats"));
        check(console::refusal_for("r_fullbright").find("unknown") != std::string::npos, "anything else is 'unknown'");
        const auto* bindrow = s.find("bind:+activate");
        check(bindrow && console::resolve(s, bindrow->command) == nullptr, "a bind row is not a console setting (binds stay in Settings)");
    }

    std::printf("console: values\n");
    {
        const auto* fov = console::resolve(s, "cg_fov");
        std::string n, e;
        check(fov && console::validate(*fov, "90", &n, &e) && n == "90", "fov 90 is fine");
        check(fov && console::validate(*fov, "120", &n, &e) && n == "120", "fov 120, the records cap, is fine");
        check(fov && !console::validate(*fov, "121", &n, &e) && e == "fov: 65-120", "fov 121 is refused, with the range", e);
        check(fov && !console::validate(*fov, "abc", &n, &e), "fov abc is refused");
        check(fov && console::validate(*fov, "90.4", &n, &e) && n == "90", "fov 90.4 snaps to the slider's step");
        const auto* sens = console::resolve(s, "sensitivity");
        check(sens && console::validate(*sens, "30", &n, &e) && !console::validate(*sens, "31", &n, &e), "sensitivity 1..30");
        const auto* fps = console::resolve(s, "com_maxfps");
        check(fps && !console::validate(*fps, "333", &n, &e), "com_maxfps 333 is refused (not a catalogue value; records: <= 250)", e);
        check(fps && console::validate(*fps, "250", &n, &e) && n == "250", "com_maxfps 250 is a catalogue value");
        const auto* showfps = console::resolve(s, "cg_drawFPS");
        check(showfps != nullptr, "cg_drawFPS resolves");
        if (showfps && showfps->k == settings::kind::toggle)
            check(console::validate(*showfps, "on", &n, &e) && n == showfps->values[1], "a toggle takes on/off");
        else if (showfps)
            check(showfps->labels.empty() || console::validate(*showfps, showfps->labels.back(), &n, &e), "a list takes its label");
    }

    std::printf("console: aliases (C1, esc-menu.md 11)\n");
    {
        // The table: every id is a real console setting, and no name means two things.
        std::vector<std::string> taken;
        bool ids_ok = true, unique = true;
        std::string bad;
        auto take = [&](const std::string& n) {
            if (std::find(taken.begin(), taken.end(), n) != taken.end()) { unique = false; bad += n + " "; }
            taken.push_back(n);
        };
        for (const auto& b : console::builtins()) { take(b.name); for (const char* a : b.aka) take(a); }
        for (const auto& a : console::aliases()) {
            const auto* it = s.find(a.id);
            if (!it || !console::console_item(*it)) { ids_ok = false; bad += a.id; }
            take(a.name);
            for (const char* x : a.aka) take(x);
        }
        check(ids_ok, "every alias names a real catalogue setting", bad);
        check(unique, "no command or alias name is taken twice", bad);
        size_t covered = 0, settable = 0;
        for (const auto& it : s.items) {
            if (!console::console_item(it)) continue;
            ++settable;
            bool has = false;
            for (const auto& a : console::aliases()) has = has || it.id == a.id;
            if (has) ++covered;
        }
        check(covered == settable, "every console setting has a short name", std::to_string(covered) + "/" + std::to_string(settable));
        for (const auto& b : console::builtins())
            check(console::resolve(s, b.name) == nullptr, (std::string("a command is never a setting: ") + b.name).c_str());

        // B's own examples, 2026-09-23.
        struct ex { const char* line; const char* id; const char* norm; };
        const ex kB[] = {
            {"anisotropic 16", "r_texFilterAnisoMin", "16"}, {"aniso 16", "r_texFilterAnisoMin", "16"},
            {"r_texFilterAnisoMin 16", "r_texFilterAnisoMin", "16"}, {"fov 90", "fov", "90"}, {"sens 3", "sensitivity", "3"},
            {"fps 250", "maxFps", "250"}, {"shadows off", "sm_enable", "0"}, {"specular on", "r_specular", "1"},
            {"glow off", "r_glow_allowed", "0"}, {"dof off", "r_dof_enable", "0"}, {"aa 4", "r_aaSamples", "4"},
            {"aa 2x", "r_aaSamples", "2"}, {"aa off", "r_aaSamples", "1"}, {"vsync off", "vsync", "0"},
            {"brightness 1.2", "r_gamma", "1.2"}, {"volume 0.5", "snd_menu_master", "0.5"}, {"music 0", "snd_menu_music", "0"},
            {"invert on", "ui_mousePitch", "1"}, {"rawinput on", "rawMouse", "1"}, {"discord off", "discordPresence", "0"},
            {"/fov 90", "fov", "90"}, {"seta cg_fov \"100\"", "fov", "100"}, {"shadows 1", "sm_enable", "1"},
            {"shadows true", "sm_enable", "1"}, {"shadows false", "sm_enable", "0"}, {"shadows 0", "sm_enable", "0"},
            {"showfps on", "showFps", "Simple"}, {"showfps 0", "showFps", "Off"}, {"refresh 144", "r_displayRefresh", "144 Hz"},
            {"aspect 16:9", "r_aspectRatio", "wide 16:9"}, {"aspect wide 16:9", "r_aspectRatio", "wide 16:9"},
            {"texdetail extra", "r_picmip", "0"}, {"mipmaps trilinear", "r_texFilterMipMode", "Force Trilinear"},
            {"discordoverlay off", "discordOverlay", "refuse"}, {"mature reduced", "cg_mature", "0"},
        };
        for (const auto& x : kB) {
            const auto c = console::parse(x.line);
            const auto* it = c.v == console::verb::set ? console::resolve(s, c.name) : nullptr;
            std::string n, e;
            const bool ok = it && it->id == x.id && console::validate(*it, c.value, &n, &e) && n == x.norm;
            check(ok, x.line, it ? it->id + " -> '" + n + "' " + e : "did not resolve");
        }
        struct bad_ex { const char* line; const char* err; };
        const bad_ex kBad[] = {{"volume 1.5", "volume: 0-1"}, {"brightness 4", "brightness: 0.5-3"}, {"fps 333", "fps: 60, 85, 125, 250"},
                               {"shadows maybe", "shadows: on/off"}, {"sens 0", "sens: 1-30"}, {"aa 8", "aa: off, 2x, 4x"}};
        for (const auto& x : kBad) {
            const auto c = console::parse(x.line);
            const auto* it = console::resolve(s, c.name);
            std::string n, e;
            check(it && !console::validate(*it, c.value, &n, &e) && e == x.err, x.line, e);
        }
        const auto* fovi = console::resolve(s, "fov");
        check(fovi && console::short_name(*fovi) == "fov" && console::other_names(*fovi).size() == 2, "fov also answers to fieldofview and cg_fov");
        const auto* mode = console::resolve(s, "displaymode");
        std::string n, e;
        check(mode && mode->k == settings::kind::info && !console::validate(*mode, "fullscreen", &n, &e) && e == "displaymode: set in the launcher",
              "display mode reads, but is the launcher's to set", e);
    }

    std::printf("console: keys and actions\n");
    {
        check(console::normalize_key("g") == "G" && console::normalize_key("mouse4") == "MOUSE4" && console::normalize_key("Space") == "SPACE",
              "key names, any case");
        check(console::normalize_key("up") == "UPARROW" && console::normalize_key("pagedown") == "PGDN" && console::normalize_key("m5") == "MOUSE5",
              "key synonyms");
        check(console::normalize_key("escape").empty() && console::normalize_key("`").empty() && console::normalize_key("F13").empty() &&
              console::normalize_key("g;quit").empty(), "Esc, the console key and junk are not keys");
        auto act = [&](const char* a) { const auto* it = console::resolve_action(s, a); return it ? it->command : std::string("-"); };
        check(act("use") == "+activate" && act("+activate") == "+activate" && act("activate") == "+activate", "use / +activate / activate");
        check(act("reload") == "+reload" && act("reload weapon") == "+reload", "reload, by name or label");
        check(act("ads") == "+speed_throw" && act("jump") == "+gostand" && act("melee") == "+melee" && act("sprint") == "+sprint", "ads, jump, melee, sprint");
        check(act("+actionslot 3") == "+actionslot 3" && act("inventory") == "+actionslot 3", "a two-word action");
        check(act("quit") == "-" && act("exec autoexec") == "-" && act("say hi") == "-", "an action is only a Controls action");
        // [SS] the screenshot action is ENW's; WaW's screenshotJPEG cannot be bound or typed here.
        check(act("screenshot") == "enw_screenshot" && act("enw_screenshot") == "enw_screenshot", "screenshot -> enw_screenshot");
        check(act("screenshotjpeg") == "-" && act("screenshotJPEG") == "-" && act("+screenshotjpeg") == "-", "screenshotJPEG is not an action: bind f12 screenshotJPEG is refused");
        {
            const auto c = console::parse("screenshotJPEG");
            check(c.v == console::verb::get && !console::resolve(s, c.name) && console::refusal_for(c.name) == "screenshotJPEG: press F12 (bind <key> screenshot)",
                  "typing screenshotJPEG runs nothing: it is not a setting, and the line says why", console::refusal_for(c.name));
            check(!console::resolve(s, "screenshot") || console::resolve(s, "screenshot")->k != settings::kind::bind, "`screenshot` typed alone is never the engine command");
        }
        std::vector<std::pair<std::string, std::string>> table = {{"F", "+activate"}, {"G", "+activate"}, {"R", "+reload"}};
        check(settings::command_of(table, "G") == "+activate" && settings::command_of(table, "Q").empty(), "command_of");
        const auto u = settings::unbind_commands(&table, "G");
        check(u.size() == 1 && u[0] == "unbind G" && settings::keys_of(table, "+activate").size() == 1, "unbind one key: the other stays");
    }

    std::printf("console: Tab completion (C1)\n");
    {
        auto tab = [&](const char* l) { return console::complete_line(s, l); };
        check(tab("shad").line == "shadow" && tab("shad").matches.size() == 2, "shad -> shadow (shadow, shadows)", tab("shad").line);
        check(tab("glo").line == "glow ", "glo -> glow", tab("glo").line);
        check(tab("/qu").line == "/quit " || tab("/qu").matches.size() > 1, "/qu completes, slash kept", tab("/qu").line);
        check(tab("/qui").line == "/quit ", "/qui -> /quit", tab("/qui").line);
        check(tab("disc").matches.size() >= 3, "disc -> discord, discordoverlay, disconnect", std::to_string(tab("disc").matches.size()));
        check(tab("shadows of").line == "shadows off ", "a toggle's values: on / off", tab("shadows of").line);
        check(tab("shadows ").matches.size() == 2, "shadows <Tab> lists on, off");
        check(tab("aa ").matches.size() == 3, "aa <Tab> lists off, 2x, 4x", std::to_string(tab("aa ").matches.size()));
        check(tab("bind mouse").matches.size() == 5, "bind mouse<Tab>: mouse1..5", std::to_string(tab("bind mouse").matches.size()));
        check(tab("bind g us").line == "bind g use ", "bind g us -> use", tab("bind g us").line);
        check(tab("unbind mwheelu").line == "unbind mwheelup ", "unbind: key names", tab("unbind mwheelu").line);
        check(tab("help sen").line == "help sens ", "help: settings by short name", tab("help sen").line);
        check(tab("reset aniso").line == "reset aniso ", "reset: settings", tab("reset aniso").line);
        check(tab("seta cg_f").line == "seta cg_f" || tab("seta cg_f").matches.empty(), "set <Tab> offers short names, not dvars");
        check(tab("fov ").matches.empty(), "a slider has no value list");
        check(tab("zzz").line == "zzz" && tab("zzz").matches.empty(), "no match: unchanged");
        check(tab("r_texfilteraniso").line == "r_texFilterAnisoMin ", "dvars complete too", tab("r_texfilteraniso").line);
    }

    std::printf("console: completion\n");
    {
        std::vector<std::string> names = {"cg_fov", "cg_drawFPS", "cg_drawCrosshair", "sensitivity", "snd_menu_master"};
        std::vector<std::string> m;
        check(console::complete(names, "sens", &m) == "sensitivity" && m.size() == 1, "sens -> sensitivity");
        check(console::complete(names, "cg_d", &m) == "cg_draw" && m.size() == 2, "cg_d -> cg_draw (two matches)");
        check(console::complete(names, "zz", &m) == "zz" && m.empty(), "no match leaves the prefix");
    }

    std::printf("lockdown: the state machine\n");
    {
        lockdown::tracker t;
        uint64_t now = 1000;
        bool any = false;
        for (int i = 0; i < 100; ++i, now += 50) any |= t.feed(now, 2) != lockdown::step::none;
        check(!any, "the boot's own main menu frames (before any connect) never trigger");
        for (int s2 : {4, 5, 7, 6, 9, 10}) { t.feed(now, s2); now += 50; }
        check(t.session && t.reached_map, "a join is a session");
        // A map change: low states for a frame or two, then back in.
        t.feed(now, 2); now += 100; t.feed(now, 2); now += 100;
        auto st = t.feed(now, 5);
        check(st == lockdown::step::none && !t.shown, "a brief dip through the menu state (a map change) does not trigger");
        for (int s2 : {7, 9, 10}) { t.feed(now, s2); now += 50; }
        // The server goes away: the menu for good.
        lockdown::step got = lockdown::step::none;
        uint64_t shown_at = 0;
        for (int i = 0; i < 40 && got == lockdown::step::none; ++i, now += 50) {
            got = t.feed(now, 2);
            if (got == lockdown::step::show) shown_at = now;
        }
        check(got == lockdown::step::show, "the menu for 1.5 s after a session -> our screen");
        lockdown::step q = lockdown::step::none;
        uint64_t quit_at = 0;
        for (int i = 0; i < 200 && q == lockdown::step::none; ++i, now += 50) {
            q = t.feed(now, 2);
            if (q == lockdown::step::quit) quit_at = now;
        }
        check(q == lockdown::step::quit && quit_at - shown_at >= 4000 && quit_at - shown_at < 4100, "then quit after 4 s of reading it");
        check(t.feed(now + 10000, 2) == lockdown::step::none, "and only once");
        lockdown::tracker t2;
        t2.feed(1, 4); t2.feed(2, 5);
        auto g2 = lockdown::step::none;
        for (uint64_t ms = 3; ms < 3000 && g2 == lockdown::step::none; ms += 50) g2 = t2.feed(ms, 0);
        check(g2 == lockdown::step::show && !t2.reached_map, "a join that never got in, then dropped to the menu, is covered too");
        // l12b: the server killed after a game over; the client stays at clc.state 10 forever.
        lockdown::tracker t3;
        for (int s3 : {4, 5, 7, 9, 10}) t3.feed(100, s3, 0);
        check(t3.feed(200, 10, 19999) == lockdown::step::none, "19.9 s of server silence in a map: still playing");
        check(t3.feed(300, 10, 20000) == lockdown::step::show && t3.lost, "20 s of silence in a map: the session has ended (lost)");
        check(t3.feed(4300, 10, 24000) == lockdown::step::quit, "...then quit after the screen");
        lockdown::tracker t4;
        t4.feed(1, 5, 0);
        check(t4.feed(2, 5, 60000) == lockdown::step::none, "silence while still connecting is join_retry's, not ours");
    }

    std::printf("start menu: a game never starts paused (esc-menu.md 11.4)\n");
    {
        using act = lockdown::start_menu::act;
        // B's logs (fear_mc_2 on the box): 0x10 up from the first in-map frame and never
        // cleared; the old rule reported `enw_ui paused` at exactly +2.0 s.
        lockdown::start_menu m;
        uint64_t now = 5000;
        check(m.feed(now, false, true) == act::none && !m.inherited, "loading (not in a map): nothing, even with a menu up");
        int closes = 0;
        uint64_t first_close = 0;
        bool paused_ever = false;
        for (int i = 0; i < 40; ++i, now += 50) {   // 2 s in the map, the menu up all along
            if (m.feed(now, true, true) == act::close) { if (!closes) first_close = now; ++closes; }
            paused_ever |= m.counts_as_pause(true);
        }
        check(!paused_ever, "the menu the map starts under never counts as a pause (the 2.0 s `paused` of B's logs)");
        check(closes == 1 && first_close - 5000 >= 1500 && first_close - 5000 < 1600, "it is closed once, 1.5 s into the map",
              std::to_string(closes) + " at +" + std::to_string(first_close - 5000));
        for (int i = 0; i < 100; ++i, now += 50) if (m.feed(now, true, true) == act::close) ++closes;
        check(closes == 3, "a menu that ignores Esc is tried 3 times, 1 s apart, then left alone", std::to_string(closes));
        // It closes; later the player opens a menu of his own: that one is a pause again.
        m.feed(now, true, false); now += 50;
        check(!m.inherited, "once it has closed after the grace window it is forgotten");
        check(m.feed(now, true, true) == act::none && m.counts_as_pause(true), "a menu opened later is the player's: it counts");

        // The load screen holds 0x10 for a frame, clears, then the map opens its menu at +350 ms.
        lockdown::start_menu m2;
        now = 100;
        m2.feed(now, true, true); now += 16;
        m2.feed(now, true, false); now += 334;
        m2.feed(now, true, true);
        check(m2.inherited && !m2.counts_as_pause(true), "a menu opened by the map in its first 1.5 s is the map's too");

        // A clean start: no menu. Esc at +5 s opens the stock menu: counted, never closed by us.
        lockdown::start_menu m3;
        now = 0;
        int c3 = 0;
        for (int i = 0; i < 100; ++i, now += 50) if (m3.feed(now, true, false) == act::close) ++c3;
        for (int i = 0; i < 100; ++i, now += 50) if (m3.feed(now, true, true) == act::close) ++c3;
        check(c3 == 0 && m3.counts_as_pause(true), "a clean start: the player's own menu later is a pause, and never closed");

        // A map restart (the restart request) leaves the map: the next start is judged afresh.
        m.feed(now, false, false);
        check(m.map_since == 0 && m.tries == 0, "leaving the map resets it");
        m.feed(now, true, true);
        check(m.inherited, "the restarted map's start menu is the map's again");
    }

    std::printf("lockdown: what the player reads\n");
    {
        check(lockdown::describe("", true) == "The game has ended.", "no error after a game: it ended");
        check(lockdown::describe("", false) == "Could not join the game.", "no error before a map: could not join");
        check(lockdown::describe("EXE_SERVERDISCONNECTED", true) == "The server closed the game.", "server disconnected");
        check(lockdown::describe("EXE_TIMEDOUT", true) == "Lost the connection to the server.", "timed out");
        check(lockdown::describe("EXE_SERVERISFULL", false) == "The game is full.", "full");
        check(lockdown::describe("script runtime error", true) == "The map hit a script error.", "script error");
        check(lockdown::describe("The ENW server did not let you in within 60 seconds. Press Play again.", false) == "Could not join the game.",
              "join_retry's give-up message");
        check(lockdown::describe("EXE_SOMETHING_NEW", true) == "SOMETHING NEW", "an unknown key is shown, readable");
    }

    std::printf("\nlockdown_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail;
}
