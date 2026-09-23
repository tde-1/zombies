// Unit tests for client-dll/components/settings_model.hpp against the REAL embedded
// schema (the same bytes enw_t4.dll carries). esc-menu.md §9.
//
//   build\<name>\RelWithDebInfo\settings_model_test.exe     exit code = failures
#include "settings_model.hpp"

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

std::string join(const std::vector<std::string>& v) {
    std::string o;
    for (const auto& s : v) o += (o.empty() ? "" : " | ") + s;
    return o;
}

}  // namespace

using namespace enw::settings;

int main() {
    const std::string_view text(reinterpret_cast<const char*>(kSchema), sizeof kSchema - 1);
    schema s;
    std::string err;
    const bool loaded = load(text, &s, &err);
    check(loaded, "the embedded schema loads", err);
    if (!loaded) return 1;
    check(err.empty(), "no item of the real schema is dropped", err);
    check(s.tabs.size() == 5, "five tabs, the site's (display graphics audio controls game)", std::to_string(s.tabs.size()));
    check(s.items.size() >= 70, "every catalogue item that is placed and allowed is here", std::to_string(s.items.size()));
    check(s.excluded == 2, "two excluded: ai_corpseCount (gameplay) and monkeytoy (mod-owned)", std::to_string(s.excluded));
    bool none_forbidden = true;
    for (const auto& it : s.items) if (!it.dvar.empty() && forbidden_dvar(it.dvar)) none_forbidden = false;
    check(none_forbidden, "no item writes a forbidden dvar");
    check(!s.find("monkeytoy") && !s.find("ai_corpseCount"), "monkeytoy and ai_corpseCount are absent");

    const item* sens = s.find("sensitivity");
    const item* fov = s.find("fov");
    const item* fps = s.find("maxFps");
    const item* inv = s.find("ui_mousePitch");
    const item* mat = s.find("cg_mature");
    const item* res = s.find("resolution");
    const item* aspect = s.find("r_aspectRatio");
    const item* raw = s.find("rawMouse");
    const item* showfps = s.find("showFps");
    const item* gamma = s.find("r_gamma");
    const item* mode = s.find("mode");
    check(sens && sens->k == kind::slider && sens->min == 1 && sens->max == 30 && sens->dvar == "sensitivity", "sensitivity: slider 1..30 on `sensitivity`");
    check(fov && fov->dvar == "cg_fov" && fov->max == 120, "fov: cg_fov, capped at 120 (records rule)");
    check(fps && fps->dvar == "com_maxfps" && !fps->verified, "max fps: com_maxfps, hidden in a Verified game");
    check(aspect && aspect->a == apply::vid_restart, "aspect ratio needs a vid_restart");
    check(raw && raw->dvar == "enw_rawmouse" && raw->a == apply::next_launch, "raw input: enw_rawmouse, next launch");
    check(showfps && showfps->values.size() == 2 && showfps->values[1] == "Simple", "show fps writes cg_drawFPS Simple/Off");
    check(mode && mode->k == kind::info, "display mode is read-only in game");
    if (!sens || !fov || !fps || !inv || !mat || !res || !aspect || !raw || !showfps || !gamma || !mode) {
        std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
        return 1;
    }

    // ---- visibility
    context c;
    std::string why;
    check(visibility(*fps, c, &why) == shown::editable, "Play Local / dev: max fps is editable");
    c.restricted = true;
    check(visibility(*fps, c, &why) == shown::hidden, "Verified: max fps hidden", why);
    check(visibility(*aspect, c, &why) == shown::hidden, "Verified: a vid_restart setting is hidden");
    check(visibility(*sens, c, &why) == shown::editable, "Verified: sensitivity stays");
    check(visibility(*fov, c, &why) == shown::editable, "Verified: FOV stays (the slider cannot pass 120)");
    size_t verified_n = 0;
    for (const auto& it : s.items) if (visibility(it, c, nullptr) != shown::hidden) ++verified_n;
    check(verified_n > 40 && verified_n < s.items.size(), "Verified shows a harmless subset", std::to_string(verified_n));
    c = {};
    c.mod_owned = {"cg_fov"};
    check(visibility(*fov, c, &why) == shown::readonly && why == "set by this map", "a mod-owned dvar is read-only", why);
    c = {};
    c.borderless = true;
    check(visibility(*res, c, &why) == shown::readonly, "borderless: resolution is read-only");
    c = {};
    c.listen_server = true;
    visibility(*aspect, c, &why);
    check(why == "applies next launch", "Play Local: vid_restart items apply next launch", why);

    // ---- console text
    check(join(set_commands(*sens, "7.5")) == "seta sensitivity \"7.5\"", "sensitivity 7.5", join(set_commands(*sens, "7.5")));
    check(join(set_commands(*inv, "1")) == "seta ui_mousePitch \"1\" | seta m_pitch \"-0.022\"", "invert writes m_pitch as the menu's uiScript does", join(set_commands(*inv, "1")));
    check(join(set_commands(*inv, "0")) == "seta ui_mousePitch \"0\" | seta m_pitch \"0.022\"", "un-invert");
    check(join(set_commands(*mat, "1")) == "seta cg_mature \"1\" | seta cg_blood \"1\"", "mature: cg_blood with it");
    check(join(set_commands(*aspect, "wide 16:9")) == "seta r_aspectRatio \"wide 16:9\"", "a value with a space is one quoted token");
    check(join(set_commands(*sens, "5; quit\n")) == "seta sensitivity \"5 quit\"", "no ';' or newline reaches the console", join(set_commands(*sens, "5; quit\n")));
    check(join(set_commands(*sens, "5\" ; quit")) == "seta sensitivity \"5  quit\"", "no quote escapes the token", join(set_commands(*sens, "5\" ; quit")));
    check(set_commands(*mode, "fullscreen").empty(), "a read-only item writes nothing");

    // A forged schema cannot smuggle a forbidden dvar in.
    {
        schema f;
        std::string e;
        const char* forged =
            R"({"v":1,"tabs":[{"id":"t","label":"T"}],"groups":[{"tab":"t","id":"g","label":"g","items":["a","b","c"]}],)"
            R"("items":[{"id":"a","kind":"toggle","dvar":"monkeytoy","values":["0","1"],"apply":"live"},)"
            R"({"id":"b","kind":"toggle","dvar":"r_glow_allowed","values":["0","1"],"apply":"live","also":{"1":[["sv_cheats","1"]]}},)"
            R"({"id":"c","kind":"slider","dvar":"sensitivity","min":1,"max":30,"step":0.1,"apply":"live"}]})";
        const bool ok = load(forged, &f, &e);
        check(ok && f.items.size() == 1 && f.items[0].id == "c", "a schema item writing monkeytoy / sv_cheats is dropped at load", e);
        check(forbidden_dvar("SV_CHEATS") && forbidden_dvar("developer") && forbidden_dvar("con_external") && forbidden_dvar("g_speed"),
              "forbidden: sv_cheats, developer, con_external, gameplay prefixes");
        check(!forbidden_dvar("cg_fov") && !forbidden_dvar("sensitivity") && !forbidden_dvar("snd_menu_master"), "not forbidden: ours");
    }

    // ---- values
    check(slider_value(*sens, 0.5) == "15.5", "sensitivity at half = 15.5", slider_value(*sens, 0.5));
    check(slider_value(*fov, 1.0) == "120" && slider_value(*fov, 7.0) == "120", "fov clamps at 120");
    check(slider_value(*fov, -1.0) == "65", "fov clamps at 65");
    check(slider_value(*gamma, 0.3) == "1.25", "brightness snaps to 0.05 steps", slider_value(*gamma, 0.3));
    check(slider_step(*sens, "5", +1) == "5.1" && slider_step(*sens, "30", +1) == "30", "a slider step, clamped");
    check(std::fabs(slider_frac(*fov, "92.5") - 0.5) < 1e-9, "fov 92.5 is the middle");
    check(cycle(*fps, "250", +1) == "60" && cycle(*fps, "60", -1) == "250", "a list wraps both ways");
    check(cycle(*fps, "144", +1) == "60", "a value not in the list steps to the first");
    check(cycle(*showfps, "Off", +1) == "Simple" && display_value(*showfps, "Simple") == "on", "show fps toggles Off <-> Simple");
    check(display_value(*aspect, "wide 16:9") == "16:9", "aspect shows the site's short word", display_value(*aspect, "wide 16:9"));
    check(display_value(*sens, "7.500000") == "7.5", "the engine's 7.500000 shows as 7.5", display_value(*sens, "7.500000"));
    check(same_value("80", "80.000000") && same_value("Wide 16:9", "wide 16:9") && !same_value("1", "0"), "same_value is numeric and case-blind");

    // ---- binds
    const char* cfg =
        "unbindall\r\nbind TAB \"+scores\"\r\nbind F \"+activate\"\r\nbind W \"+forward\"\r\nbind UPARROW \"+forward\"\r\n"
        "seta sensitivity \"5\"\r\nseta r_aspectRatio \"wide 16:9\"\r\ncon_hidechannel *\r\n";
    auto table = parse_binds(cfg);
    check(table.size() == 4 && table[1].first == "F" && table[1].second == "+activate", "parse_binds reads bind lines in order");
    check(keys_of(table, "+forward").size() == 2, "Forward has two keys");
    auto setas = parse_setas(cfg);
    check(setas["sensitivity"] == "5" && setas["r_aspectratio"] == "wide 16:9", "parse_setas reads seta lines (lower-case names)");
    const auto c0 = bind_commands(&table, "+activate", "G");
    check(join(c0) == "bind G \"+activate\"" && keys_of(table, "+activate").size() == 2, "a second key is added", join(c0));
    auto t2 = parse_binds(cfg);
    const auto c1 = bind_commands(&t2, "+forward", "I");
    check(join(c1) == "unbind W | unbind UPARROW | bind I \"+forward\"", "with two keys both are released, as WaW's menu does", join(c1));
    check(keys_of(t2, "+forward") == std::vector<std::string>{"I"}, "Forward is now I only");
    const auto c2 = bind_commands(&t2, "+scores", "I");
    check(join(c2) == "bind I \"+scores\"" && keys_of(t2, "+forward").empty(), "taking a key frees it from the other command", join(c2));
    const auto c3 = bind_commands(&t2, "+scores", "");
    check(join(c3) == "unbind TAB | unbind I" && keys_of(t2, "+scores").empty(), "an empty key clears the command", join(c3));
    check(key_name_for_vk('G') == "G" && key_name_for_vk(0x70) == "F1" && key_name_for_vk(0x20) == "SPACE" &&
              key_name_for_vk(0x1B).empty() && key_name_for_vk(0xC0).empty(),
          "key names: letters, F-keys, SPACE; Esc and the console key are never bindable");

    std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail;
}
