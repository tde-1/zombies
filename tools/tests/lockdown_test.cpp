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
        check(c.v == console::verb::refused, "two values are refused");
        c = console::parse("set cg_fov");
        check(c.v == console::verb::refused, "`set` without a value is refused with its usage");
        check(console::parse("help").v == console::verb::help && console::parse("?").v == console::verb::help, "help and ?");
        check(console::parse("clear").v == console::verb::clear, "clear");
        check(console::parse("cvarlist snd").v == console::verb::list && console::parse("cvarlist snd").name == "snd", "cvarlist <prefix> lists");
        check(console::parse("reset cg_fov").v == console::verb::reset, "reset <setting>");
        check(console::parse("").v == console::verb::none && console::parse("   ").v == console::verb::none, "an empty line does nothing");
        c = console::parse("quit");
        check(c.v == console::verb::get && c.name == "quit", "`quit` is only a name (and resolves to nothing below): the console runs no command");
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
        check(console::refusal_for("sv_cheats") == "sv_cheats is locked.", "a forbidden dvar is 'locked'");
        check(console::refusal_for("r_fullbright").find("not available") != std::string::npos, "anything else is 'not available here'");
        const auto* bindrow = s.find("bind:+activate");
        check(bindrow && console::resolve(s, bindrow->command) == nullptr, "a bind row is not a console setting (binds stay in Settings)");
    }

    std::printf("console: values\n");
    {
        const auto* fov = console::resolve(s, "cg_fov");
        std::string n, e;
        check(fov && console::validate(*fov, "90", &n, &e) && n == "90", "fov 90 is fine");
        check(fov && console::validate(*fov, "120", &n, &e) && n == "120", "fov 120, the records cap, is fine");
        check(fov && !console::validate(*fov, "121", &n, &e) && e.find("65 to 120") != std::string::npos, "fov 121 is refused, with the range", e);
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
