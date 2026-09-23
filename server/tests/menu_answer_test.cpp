// Unit test for server/components/game_mode/menu_answer.hpp -- no engine.
//
//     cl /nologo /EHsc /std:c++17 server\tests\menu_answer_test.cpp /Fe:build\menu_answer_test.exe
//     build\menu_answer_test.exe
#include "../components/game_mode/menu_answer.hpp"

#include <cstdio>

using namespace enw::game_mode;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

int main() {
    // off
    {
        spec s = parse("", "", "");
        check(!s.active() && s.error.empty(), "empty is off, not an error");
    }
    // UGX: the Battlestar case
    {
        spec s = parse("ugxm_vote_host,ugxm_vote_players", "ugxm_vote_host:gg,start", "ugxm_voting_complete");
        check(s.error.empty() && s.active(), "ugx spec parses");
        check(s.hides("ugxm_vote_host") && s.hides("UGXM_VOTE_PLAYERS"), "hides both, case-insensitive");
        check(!s.hides("ugxm_customize_char"), "does not hide an unrelated menu");
        check(s.answers("ugxm_vote_host") && !s.answers("ugxm_vote_players"), "answers only the host menu");
        check(s.responses.size() == 2 && s.responses[0] == "gg" && s.responses[1] == "start", "responses in order");
        check(s.done_notify == "ugxm_voting_complete", "done notify kept");
    }
    // the host's separator is '.', a ',' still parses
    {
        spec s = parse("ugxm_vote_host.ugxm_vote_players", "ugxm_vote_host:ss.start", "ugxm_voting_complete");
        check(s.active() && s.hides("ugxm_vote_players") && s.responses.size() == 2 && s.responses[0] == "ss", "dot separator");
    }
    // the packed single dvar the host sends
    {
        std::string id;
        spec s = parse_packed("gungame:ugxm_vote_host.ugxm_vote_players:ugxm_vote_host:gg.start:ugxm_voting_complete", &id);
        check(s.active() && id == "gungame" && s.responses[0] == "gg" && s.done_notify == "ugxm_voting_complete", "packed, five fields");
        spec f = parse_packed("x:m:m:gg", &id);
        check(f.active() && f.done_notify.empty(), "packed, four fields");
        check(!parse_packed("gungame:m:m", nullptr).active(), "packed, three fields refused");
        check(!parse_packed("gun game:m:m:gg", nullptr).active(), "packed, bad id refused");
        check(!parse_packed("x:m:m:gg:done:extra", nullptr).active(), "packed, six fields refused");
        check(!parse_packed("x:m:other:gg", nullptr).active(), "packed, answering an unhidden menu refused");
        check(!parse_packed("", nullptr).active() && parse_packed("", nullptr).error.empty(), "packed, empty is off");
    }
    // refusals: anything that is not plain tokens refuses the whole thing
    {
        check(!parse("a b", "a b:gg", "").active(), "space refused");
        check(!parse("m;quit", "m:gg", "").active(), "semicolon refused");
        check(!parse("m", "m:gg;quit", "").active(), "semicolon in a response refused");
        check(!parse("m", "m:\"gg\"", "").active(), "quote refused");
        check(!parse("m", "mgg", "").active(), "no colon refused");
        check(!parse("m", "m:", "").active(), "no responses refused");
        check(!parse("m", "", "").active(), "hide without an answer refused (the script would wait forever)");
        check(!parse("", "m:gg", "").active(), "answer without hiding refused");
        check(!parse("other", "m:gg", "").active(), "answering a menu that is not hidden refused");
        check(!parse("m", "m:gg", "bad notify").active(), "bad done notify refused");
        check(!parse("m,,n", "m:gg", "").active(), "empty item refused");
        std::string many = "m";
        for (int i = 0; i < 9; ++i) many += ",x" + std::to_string(i);
        check(!parse(many, "m:gg", "").active(), "more than 8 menus refused");
        std::string lng(64, 'a');
        check(!parse(lng, lng + ":gg", "").active(), "64-char token refused");
        spec r = parse("m", "m:gg;quit", "");
        check(!r.error.empty(), "a refusal says why");
    }
    std::printf("menu_answer_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
