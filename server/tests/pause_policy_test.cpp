// Unit test for server/components/pause/pause_policy.hpp -- the pause rule with no engine.
//
// Deliberately NOT under server/components/: CMake globs that directory into the DLL, and a
// main() there would be linked into binkw32.dll. Build and run (VS BuildTools x86 prompt, or
// any C++17 compiler):
//
//     cl /nologo /EHsc /std:c++17 server\tests\pause_policy_test.cpp /Fe:build\pause_policy_test.exe
//     build\pause_policy_test.exe
//
//     g++ -std=c++17 server/tests/pause_policy_test.cpp -o /tmp/ppt && /tmp/ppt
#include "../components/pause/pause_policy.hpp"

#include <cstdio>
#include <string>

using namespace enw::pause_rule;

// Userinfo strings are written with '/' here and turned into the real separator.
static std::string I(const char* s) {
    std::string r(s);
    for (auto& ch : r) if (ch == '/') ch = kSep;
    return r;
}

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s%c", what, 10);
}

static client_report c(const char* ui, bool pchat = true) {
    client_report r;
    r.connected = true;
    r.ui = parse_ui(ui);
    r.pause_on_chat = pchat;
    return r;
}
static client_report gone() { return client_report{}; }

int main() {
    // --- the userinfo parser -------------------------------------------------------------
    const std::string ui = I("/name/mule/rate/25000/enw_ui/paused/enw_pchat/0");
    check(info_value(ui, "enw_ui") == "paused", "info_value finds enw_ui");
    check(info_value(ui, "enw_pchat") == "0", "info_value finds the LAST key");
    check(info_value(ui, "name") == "mule", "info_value finds the FIRST key");
    check(info_value(ui, "enw") == "", "a key prefix is not a match");
    check(info_value(I("/name/enw_ui/x/typing"), "enw_ui") == "", "a VALUE equal to the key is not a key");
    check(info_value("", "enw_ui") == "", "empty userinfo");
    check(info_value(I("name/a/enw_ui/typing"), "enw_ui") == "typing", "no leading backslash");

    auto r = from_userinfo(true, I("/name/a"));
    check(r.ui == ui_state::clear && r.pause_on_chat, "absent keys: clear, and pause-on-chat defaults ON");
    r = from_userinfo(true, I("/enw_ui/PAUSED"));
    check(r.ui == ui_state::clear, "values are exact, lower case");
    r = from_userinfo(false, I("/enw_ui/paused"));
    check(!r.connected && r.ui == ui_state::clear, "a disconnected slot is clear whatever it last said");

    // --- solo ----------------------------------------------------------------------------
    {
        client_report a[4] = {c("paused"), gone(), gone(), gone()};
        check(decide(false, a, 4) == reason::solo_menu, "solo Esc menu pauses");
    }
    {
        client_report a[4] = {gone(), gone(), c("typing"), gone()};
        check(decide(false, a, 4) == reason::solo_chat, "solo typing pauses when the setting is on (any slot)");
    }
    {
        client_report a[4] = {c("typing", false), gone(), gone(), gone()};
        check(decide(false, a, 4) == reason::none, "solo typing does NOT pause with the setting off");
    }
    {
        client_report a[4] = {c("paused", false), gone(), gone(), gone()};
        check(decide(false, a, 4) == reason::solo_menu, "the chat setting does not affect the Esc menu");
    }
    {
        client_report a[4] = {c("clear"), gone(), gone(), gone()};
        check(decide(false, a, 4) == reason::none, "solo, nothing open: running");
    }

    // --- multiplayer ---------------------------------------------------------------------
    {
        client_report a[4] = {c("paused"), c("clear"), gone(), gone()};
        check(decide(false, a, 4) == reason::none, "one of two in the menu: running");
    }
    {
        client_report a[4] = {c("paused"), c("paused"), gone(), gone()};
        check(decide(false, a, 4) == reason::all_menu, "both in the menu: paused");
    }
    {
        client_report a[4] = {c("typing"), c("typing"), c("typing"), c("typing")};
        check(decide(false, a, 4) == reason::none, "four people typing NEVER pauses");
    }
    {
        client_report a[4] = {c("paused"), c("paused"), c("typing"), gone()};
        check(decide(false, a, 4) == reason::none, "two in the menu and one typing: running");
    }
    {
        client_report a[4] = {c("paused"), c("paused"), c("paused"), c("paused")};
        check(decide(false, a, 4) == reason::all_menu, "all four in the menu: paused");
    }

    // --- disconnects count as unpaused ----------------------------------------------------
    {
        // Both paused, then one leaves: the one left is alone and in the menu -> a SOLO pause
        // (still paused, and it now follows the solo rule).
        client_report a[4] = {c("paused"), gone(), gone(), gone()};
        check(decide(false, a, 4) == reason::solo_menu, "last one standing in the menu stays paused (solo rule)");
    }
    {
        client_report a[4] = {gone(), gone(), gone(), gone()};
        check(decide(false, a, 4) == reason::none, "nobody connected: not paused by the UI");
    }
    {
        // A second player joining a solo chat pause releases it: typing never pauses co-op.
        client_report a[4] = {c("typing"), c("clear"), gone(), gone()};
        check(decide(false, a, 4) == reason::none, "a joiner releases a solo chat pause");
    }

    // --- the host hold -------------------------------------------------------------------
    {
        client_report a[4] = {gone(), gone(), gone(), gone()};
        check(decide(true, a, 4) == reason::host, "a host hold pauses an empty game (crash grace)");
    }
    {
        client_report a[4] = {c("clear"), c("clear"), gone(), gone()};
        check(decide(true, a, 4) == reason::host, "the UI cannot release a host hold");
    }

    // --- ENW_PAUSE_HOST_ONLY (2026-09-24): the disconnect pause without the Esc pause ------
    {
        client_report a[4] = {c("paused"), gone(), gone(), gone()};
        check(decide(false, a, 4, false) == reason::none, "host-only: a solo Esc menu does not pause");
        check(decide(true, a, 4, false) == reason::host, "host-only: the host's drop hold still pauses");
        client_report b[4] = {c("paused"), c("paused"), gone(), gone()};
        check(decide(false, b, 4, false) == reason::none, "host-only: everyone in the menu does not pause");
        check(decide(false, b, 4) == reason::all_menu, "the default is unchanged");
    }

    // --- the write guards (2026-09-23) ---------------------------------------------------
    check(plausible_svs_time(25750, 25700), "svs.time one frame past frozen: write");
    check(plausible_svs_time(25700, 25700), "svs.time already frozen: write (no-op)");
    check(!plausible_svs_time(25699, 25700), "svs.time behind frozen: refuse");
    check(!plausible_svs_time(0x021C1DF0, 25700), "a pointer is not a time");
    check(!plausible_svs_time(25750, 0), "no frozen time yet: refuse");
    check(plausible_next_snapshot(25750, 25700), "nextSnapshotTime a frame ahead: pull down");
    check(plausible_next_snapshot(26700, 25700), "inactive-client +1000: pull down");
    check(!plausible_next_snapshot(25699, 25700), "already due: leave it");
    check(!plausible_next_snapshot(0x5FAD, 25700), "a string id near a time is still out of range");
    check(!plausible_next_snapshot(-1, 25700), "-1 (unpure client) left alone");
    check(client_slots(4, 4) == 4 && client_slots(1, 4) == 1 && client_slots(18, 4) == 4, "slots clamp to sv_maxclients and the array");
    check(client_slots(0, 4) == 0 && client_slots(-3, 4) == 0, "no maxclients: touch nothing");

    std::printf("pause_policy_test: %d passed, %d failed%c", g_pass, g_fail, 10);
    return g_fail ? 1 : 0;
}
