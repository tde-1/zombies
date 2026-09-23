// The ENW console's model: what a typed line means, which setting / command it names, and
// whether the value is one the setting may take. Pure (no engine, no window), so it is
// unit-tested (tools/tests/lockdown_test.cpp, built as lockdown_test). esc-menu.md §10.2 and
// §11 are the write-up.
//
// B, 2026-09-23: players never reach World at War's stock console; they get our own. "What
// can be set" is not a second list: it is the in-game settings catalogue
// (shared/settings/ingame-settings.json, the Settings tab's list), reached by short names
// and aliases (`fov`, `sens`, `aniso`, `shadows` ... -- kAliases below), by dvar, or by
// catalogue id, with `settings::forbidden_dvar` refusing what it refuses there. A handful of
// built-in commands (help, list, binds, bind, unbind, reset, apply, restart, disconnect,
// quit, clear) run OUR code paths. Nothing typed is ever handed to the engine as text: the
// only engine lines the console can cause are the ones settings_model.hpp builds (`seta`
// with a validated value, `bind`/`unbind` with a key from kKeys and a catalogue action),
// `vid_restart`, and the Esc menu's own restart / exit.
#pragma once

#include "settings_model.hpp"

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

namespace enw::console {

enum class verb { none, help, list, clear, get, set, reset, refused, quit, disconnect, restart, bind, unbind, binds, apply };

struct command {
    verb v = verb::none;
    std::string name;    // set/get/reset/help/list: the setting / command / filter as typed; bind/unbind: the key
    std::string value;   // set: the value, quotes stripped; bind: the action
    std::string why;     // refused: what to tell the player
};

// ------------------------------------------------------------------ built-in commands
struct builtin {
    verb v;
    const char* name;
    std::vector<const char*> aka;
    const char* usage;
    const char* what;
};

inline const std::vector<builtin>& builtins() {
    static const std::vector<builtin> k = {
        {verb::help, "help", {"?", "commands", "cmdlist"}, "help [command]", "what a command or setting does"},
        {verb::list, "list", {"ls", "settings", "cvarlist", "dvarlist"}, "list [filter]", "settings and their values"},
        {verb::binds, "binds", {"bindlist", "keys"}, "binds [filter]", "actions and their keys"},
        {verb::bind, "bind", {}, "bind <key> [action]", "bind a key; no action shows it"},
        {verb::unbind, "unbind", {"clearbind"}, "unbind <key>", "free a key"},
        {verb::reset, "reset", {"default"}, "reset <setting>", "back to the default"},
        {verb::apply, "apply", {"vid_restart"}, "apply", "restart the video for pending changes"},
        {verb::restart, "restart", {"map_restart", "fast_restart"}, "restart", "restart the game"},
        {verb::disconnect, "disconnect", {"dc", "leave"}, "disconnect", "leave the game"},
        {verb::quit, "quit", {"exit"}, "quit", "leave the game and close it"},
        {verb::clear, "clear", {"cls"}, "clear", "clear the console"},
    };
    return k;
}

// ------------------------------------------------------------------ setting aliases
// catalogue id -> the short name the console shows, then its other names. The dvar and
// the catalogue id always work too. Unit-tested: every id exists, no name is taken twice.
struct setting_alias {
    const char* id;
    const char* name;
    std::vector<const char*> aka;
};

inline const std::vector<setting_alias>& aliases() {
    static const std::vector<setting_alias> k = {
        // display
        {"fov", "fov", {"fieldofview"}},
        {"r_gamma", "brightness", {"gamma"}},
        {"maxFps", "fps", {"maxfps", "fpscap"}},
        {"vsync", "vsync", {"sync"}},
        {"showFps", "showfps", {"drawfps", "fpscounter"}},
        {"resolution", "resolution", {"res", "vid_mode"}},
        {"r_displayRefresh", "refresh", {"hz", "refreshrate"}},
        {"r_aspectRatio", "aspect", {"aspectratio"}},
        {"mode", "displaymode", {"window"}},
        {"display", "monitor", {}},
        // graphics
        {"r_aaSamples", "aa", {"antialiasing", "msaa"}},
        {"sm_enable", "shadows", {"shadow"}},
        {"r_specular", "specular", {"spec"}},
        {"r_glow_allowed", "glow", {"bloom", "r_glow"}},
        {"r_dof_enable", "dof", {"depthoffield"}},
        {"r_multiGpu", "multigpu", {"sli", "dualgpu"}},
        {"fx_marks", "impacts", {"marks", "bulletimpacts"}},
        {"r_gfxopt_dynamic_foliage", "foliage", {}},
        {"r_gfxopt_water_simulation", "ocean", {"water"}},
        {"r_texFilterAnisoMin", "aniso", {"anisotropic", "anisotropy", "af"}},
        {"r_texFilterMipMode", "mipmaps", {"mip", "mipmap"}},
        {"r_picmip_manual", "texquality", {"texturequality"}},
        {"r_picmip", "texdetail", {"texture", "textures", "texturedetail"}},
        {"r_picmip_bump", "normaldetail", {"bumpdetail", "normalmaps"}},
        {"r_picmip_spec", "specdetail", {"speculardetail"}},
        // audio
        {"snd_menu_master", "volume", {"vol", "master", "mastervolume"}},
        {"snd_menu_music", "music", {"musicvolume"}},
        {"snd_menu_sfx", "sfx", {"effects", "sfxvolume"}},
        {"snd_menu_voice", "voice", {"voicevolume", "dialogue"}},
        {"snd_cinematicVolumeScale", "cinematics", {"cinematicvolume"}},
        {"snd_losOcclusion", "occlusion", {}},
        // controls
        {"sensitivity", "sens", {"mousesens", "m_sens"}},
        {"ui_mousePitch", "invert", {"invertmouse", "mouseinvert"}},
        {"m_filter", "smoothmouse", {"mousesmoothing", "smoothing"}},
        {"cl_freelook", "freelook", {}},
        {"rawMouse", "rawinput", {"raw", "rawmouse", "m_rawinput"}},
        // game
        {"cg_mature", "mature", {"gore", "blood"}},
        {"cg_subtitles", "subtitles", {"subs"}},
        {"hud_enable", "hud", {}},
        {"cg_drawCrosshair", "crosshair", {}},
        // enw
        {"discordPresence", "discord", {"richpresence", "presence"}},
        {"discordOverlay", "discordoverlay", {"overlay"}},
        {"screenshotFormat", "shotformat", {"screenshotformat"}},   // [SS] jpg | png
    };
    return k;
}

inline std::string trim(std::string_view s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t')) --b;
    return std::string(s.substr(a, b - a));
}

inline std::vector<std::string> split_ws(std::string_view s) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
        if (i >= s.size()) break;
        size_t j = i;
        if (s[i] == '"') {   // a quoted token keeps its spaces
            j = s.find('"', i + 1);
            if (j == std::string_view::npos) j = s.size();
            out.emplace_back(s.substr(i + 1, j - i - 1));
            i = j + 1;
            continue;
        }
        while (j < s.size() && s[j] != ' ' && s[j] != '\t') ++j;
        out.emplace_back(s.substr(i, j - i));
        i = j;
    }
    return out;
}

inline std::string join_from(const std::vector<std::string>& t, size_t at) {
    std::string o;
    for (size_t i = at; i < t.size(); ++i) o += (o.empty() ? "" : " ") + t[i];
    return o;
}

inline const builtin* find_builtin(std::string_view word) {
    const std::string w = settings::lower(word);
    for (const auto& b : builtins()) {
        if (w == b.name) return &b;
        for (const char* a : b.aka) if (w == a) return &b;
    }
    return nullptr;
}

// A typed line -> a command. Nothing here touches the engine; `refused` carries the reason.
// A leading `/` or `\` is dropped (players type `/quit`); values may be quoted or not; a
// value of several words (`aspect wide 16:9`) is one value.
inline command parse(std::string_view line) {
    command c;
    std::string t = trim(line);
    while (!t.empty() && (t[0] == '/' || t[0] == '\\')) t.erase(0, 1);
    if (t.empty()) return c;
    for (char ch : t) {
        const unsigned char u = static_cast<unsigned char>(ch);
        if (ch == ';' || u < 0x20) { c.v = verb::refused; c.why = "one command at a time"; return c; }
    }
    auto tok = split_ws(t);
    if (tok.empty()) return c;
    const std::string head = settings::lower(tok[0]);
    if (const builtin* b = find_builtin(head)) {
        c.v = b->v;
        switch (b->v) {
        case verb::help: case verb::list: case verb::binds:
            if (tok.size() > 1) c.name = tok[1];
            return c;
        case verb::reset: case verb::unbind:
            if (tok.size() != 2) { c.v = verb::refused; c.why = std::string("usage: ") + b->usage; return c; }
            c.name = tok[1];
            return c;
        case verb::bind:
            if (tok.size() < 2) { c.v = verb::refused; c.why = std::string("usage: ") + b->usage; return c; }
            c.name = tok[1];
            c.value = join_from(tok, 2);
            return c;
        default:   // clear, apply, restart, disconnect, quit: no arguments
            if (tok.size() > 1) { c.v = verb::refused; c.why = std::string(b->name) + " takes nothing after it"; return c; }
            return c;
        }
    }
    size_t at = 0;
    if (head == "set" || head == "seta" || head == "sets") {
        if (tok.size() < 3) { c.v = verb::refused; c.why = "usage: " + head + " <setting> <value>"; return c; }
        at = 1;
    }
    c.name = tok[at];
    if (tok.size() == at + 1) { c.v = verb::get; return c; }
    c.v = verb::set;
    c.value = join_from(tok, at + 1);
    return c;
}

// ------------------------------------------------------------------ settings by name
inline bool console_item(const settings::item& it) { return it.k != settings::kind::bind && !it.dvar.empty(); }

// The catalogue item a name means: a short name or alias, its dvar, or its catalogue id.
// Binds are not settings (bind / unbind are).
inline const settings::item* resolve(const settings::schema& s, std::string_view name) {
    const std::string n = settings::lower(name);
    if (n.empty()) return nullptr;
    for (const auto& a : aliases()) {
        bool hit = n == a.name;
        for (const char* x : a.aka) hit = hit || n == x;
        if (!hit) continue;
        const settings::item* it = s.find(a.id);
        if (it && console_item(*it)) return it;
    }
    for (const auto& it : s.items) if (console_item(it) && settings::lower(it.dvar) == n) return &it;
    for (const auto& it : s.items) if (console_item(it) && settings::lower(it.id) == n) return &it;
    return nullptr;
}

// The name the console shows for a setting: its short name, else its dvar.
inline std::string short_name(const settings::item& it) {
    for (const auto& a : aliases()) if (it.id == a.id) return a.name;
    return settings::lower(it.dvar);
}

// Every other name a setting answers to (for `help <setting>`).
inline std::vector<std::string> other_names(const settings::item& it) {
    std::vector<std::string> o;
    const std::string sn = short_name(it);
    for (const auto& a : aliases())
        if (it.id == a.id) for (const char* x : a.aka) o.push_back(x);
    const std::string d = settings::lower(it.dvar);
    if (d != sn && std::find(o.begin(), o.end(), d) == o.end()) o.push_back(it.dvar);
    return o;
}

// What values a setting takes, for the player: "65-120", "on/off", "off, 2x, 4x".
inline std::string range_text(const settings::item& it) {
    switch (it.k) {
    case settings::kind::slider:
        return settings::fmt_number(it.min, settings::decimals_of(it.step)) + "-" +
               settings::fmt_number(it.max, settings::decimals_of(it.step));
    case settings::kind::toggle:
        return "on/off";
    case settings::kind::select: {
        if (it.free_values) return "a value";
        std::string o;
        for (size_t i = 0; i < it.values.size(); ++i) {
            std::string w = i < it.labels.size() ? it.labels[i] : it.values[i];
            if (w.empty()) w = "auto";
            o += (o.empty() ? "" : ", ") + w;
        }
        return o;
    }
    default:
        return {};
    }
}

// Is `value` one this setting may take? On true, `norm` is what to write (a toggle's
// on/off/1/0/true/false made its own value, a slider snapped to its step, a list label made
// its value). On false, `err` is "<name>: <range>".
inline bool validate(const settings::item& it, const std::string& value, std::string* norm, std::string* err) {
    const std::string v = trim(value);
    const std::string l = settings::lower(v);
    switch (it.k) {
    case settings::kind::toggle: {
        if (it.values.size() != 2) break;
        int idx = settings::same_value(v, it.values[0]) ? 0 : settings::same_value(v, it.values[1]) ? 1 : -1;
        if (idx < 0 && (l == "on" || l == "true" || l == "yes" || l == "1" || l == "enable" || l == "enabled")) idx = 1;
        if (idx < 0 && (l == "off" || l == "false" || l == "no" || l == "0" || l == "disable" || l == "disabled")) idx = 0;
        if (idx < 0) break;
        *norm = it.values[static_cast<size_t>(idx)];
        return true;
    }
    case settings::kind::select: {
        for (size_t i = 0; i < it.values.size(); ++i) {
            const std::string lab = i < it.labels.size() ? settings::lower(it.labels[i]) : std::string();
            const std::string val = settings::lower(it.values[i]);
            // "60" for "60 Hz", "4" for 4x (its value is "4"), "16:9" for its label.
            const bool hz = val.size() > 3 && val.compare(val.size() - 3, 3, " hz") == 0 && l == val.substr(0, val.size() - 3);
            if (settings::same_value(v, it.values[i]) || (!lab.empty() && lab == l) || hz || (it.values[i].empty() && l == "auto")) {
                *norm = it.values[i];
                return true;
            }
        }
        if (it.free_values && !v.empty() && v.size() <= 32) { *norm = v; return true; }
        break;
    }
    case settings::kind::slider: {
        double d = 0;
        if (!settings::is_number(v, &d)) break;
        if (d < it.min - 1e-9 || d > it.max + 1e-9) break;
        *norm = settings::slider_value(it, it.max > it.min ? (d - it.min) / (it.max - it.min) : 0);
        return true;
    }
    default:
        if (err) *err = short_name(it) + ": set in the launcher";
        return false;
    }
    if (err) *err = short_name(it) + ": " + range_text(it);
    return false;
}

// Why a name is not a console setting, in one short line.
inline std::string refusal_for(std::string_view name) {
    std::string n(name);
    if (settings::forbidden_dvar(name)) return n + ": locked";
    // [SS] the engine's screenshot commands are not ours to run from here (screenshot.cpp redirects them anyway).
    const std::string l = settings::lower(name);
    if (l == "screenshot" || l == "screenshotjpeg" || l == "enw_screenshot") return n + ": press F12 (bind <key> screenshot)";
    return n + ": unknown -- help";
}

// ------------------------------------------------------------------ keys and actions
// The key names a bind may use: the engine's own (what a config.cfg's bind line holds;
// settings::key_name_for_vk makes the same names), plus the mouse. Esc and the console key
// are never bindable here.
inline const std::vector<std::string>& key_names() {
    static const std::vector<std::string> k = [] {
        std::vector<std::string> o;
        for (char c = 'A'; c <= 'Z'; ++c) o.emplace_back(1, c);
        for (char c = '0'; c <= '9'; ++c) o.emplace_back(1, c);
        for (int f = 1; f <= 12; ++f) o.push_back("F" + std::to_string(f));
        for (int d = 0; d <= 9; ++d) o.push_back("KP_" + std::to_string(d));
        for (const char* x : {"SPACE", "SHIFT", "CTRL", "ALT", "TAB", "ENTER", "BACKSPACE", "UPARROW", "DOWNARROW",
                              "LEFTARROW", "RIGHTARROW", "INS", "DEL", "HOME", "END", "PGUP", "PGDN", "PAUSE", "CAPSLOCK",
                              "SEMICOLON", "-", "=", "[", "]", "'", ",", ".", "/", "\\", "MOUSE1", "MOUSE2", "MOUSE3",
                              "MOUSE4", "MOUSE5", "MWHEELUP", "MWHEELDOWN"})
            o.push_back(x);
        return o;
    }();
    return k;
}

// A typed key name -> the engine's name, or "" when it is not a key we bind.
inline std::string normalize_key(std::string_view typed) {
    std::string u(typed);
    for (auto& c : u) if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    static const std::pair<const char*, const char*> kSyn[] = {
        {"UP", "UPARROW"}, {"DOWN", "DOWNARROW"}, {"LEFT", "LEFTARROW"}, {"RIGHT", "RIGHTARROW"},
        {"RETURN", "ENTER"}, {"CONTROL", "CTRL"}, {"LCTRL", "CTRL"}, {"RCTRL", "CTRL"}, {"LSHIFT", "SHIFT"},
        {"RSHIFT", "SHIFT"}, {"INSERT", "INS"}, {"DELETE", "DEL"}, {"PAGEUP", "PGUP"}, {"PAGEDOWN", "PGDN"},
        {"M1", "MOUSE1"}, {"M2", "MOUSE2"}, {"M3", "MOUSE3"}, {"M4", "MOUSE4"}, {"M5", "MOUSE5"},
        {"WHEELUP", "MWHEELUP"}, {"WHEELDOWN", "MWHEELDOWN"}, {"MWHEEL_UP", "MWHEELUP"}, {"MWHEEL_DOWN", "MWHEELDOWN"},
        {";", "SEMICOLON"}, {"CAPS", "CAPSLOCK"},
    };
    for (const auto& [a, b] : kSyn) if (u == a) { u = b; break; }
    for (const auto& k : key_names()) if (k == u) return k;
    return {};
}

// Short names for the Controls actions, on top of each action's command (with or without
// its '+') and its /settings label.
inline const std::vector<std::pair<const char*, const char*>>& action_aliases() {
    static const std::vector<std::pair<const char*, const char*>> k = {
        {"use", "+activate"}, {"fire", "+attack"}, {"shoot", "+attack"}, {"ads", "+speed_throw"}, {"aim", "+speed_throw"},
        {"jump", "+gostand"}, {"grenade", "+frag"}, {"special", "+smoke"}, {"switch", "weapnext"}, {"nextweapon", "weapnext"},
        {"crouch", "+movedown"}, {"back", "+back"}, {"left", "+moveleft"}, {"right", "+moveright"}, {"scoreboard", "+scores"},
        {"inventory", "+actionslot 3"}, {"equipment", "+actionslot 4"}, {"satchel", "+actionslot 2"},
        {"screenshot", "enw_screenshot"},   // [SS] ENW's own; WaW's screenshotJPEG is never an action
    };
    return k;
}

inline std::string squash(std::string_view s) {
    std::string o;
    for (char c : settings::lower(s)) if (c != ' ' && c != '/' && c != '_' && c != '-') o.push_back(c);
    return o;
}

// The catalogue's bind row an action names: "use", "+activate", "activate", "reload weapon".
inline const settings::item* resolve_action(const settings::schema& s, std::string_view action) {
    const std::string a = settings::lower(trim(action));
    if (a.empty()) return nullptr;
    std::string cmd;
    for (const auto& [n, c] : action_aliases()) if (a == n) { cmd = c; break; }
    for (const auto& it : s.items) {
        if (it.k != settings::kind::bind) continue;
        const std::string c = settings::lower(it.command);
        const std::string bare = !c.empty() && c[0] == '+' ? c.substr(1) : c;
        if ((!cmd.empty() && c == cmd) || c == a || bare == a || squash(it.label) == squash(a) || squash(bare) == squash(a))
            return &it;
    }
    return nullptr;
}

// The name the console shows for an action: its alias if it has one, else its command.
inline std::string action_name(const settings::item& it) {
    for (const auto& [n, c] : action_aliases()) if (settings::lower(it.command) == c) return n;
    const std::string c = settings::lower(it.command);
    return !c.empty() && c[0] == '+' ? c.substr(1) : c;
}

// ------------------------------------------------------------------ Tab completion
// The unique completion, or the longest common prefix of every match (and the matches,
// for the player to read).
inline std::string complete(const std::vector<std::string>& names, std::string_view prefix, std::vector<std::string>* matches) {
    const std::string p = settings::lower(prefix);
    std::vector<std::string> m;
    for (const auto& n : names) if (settings::lower(n).rfind(p, 0) == 0) m.push_back(n);
    std::sort(m.begin(), m.end());
    m.erase(std::unique(m.begin(), m.end()), m.end());
    if (matches) *matches = m;
    if (m.empty()) return std::string(prefix);
    if (m.size() == 1) return m[0];
    std::string common = m[0];
    for (const auto& s : m) {
        size_t k = 0;
        while (k < common.size() && k < s.size() && settings::lower(std::string(1, common[k])) == settings::lower(std::string(1, s[k]))) ++k;
        common.resize(k);
    }
    return common.size() >= prefix.size() ? common : std::string(prefix);
}

// Every word the first position takes: commands, their aliases, settings by short name,
// alias and dvar.
inline std::vector<std::string> first_words(const settings::schema& s) {
    std::vector<std::string> o;
    for (const auto& b : builtins()) {
        o.push_back(b.name);
        for (const char* a : b.aka) if (a[0] != '?') o.push_back(a);
    }
    for (const auto& a : aliases()) {
        const settings::item* it = s.find(a.id);
        if (!it || !console_item(*it)) continue;
        o.push_back(a.name);
        for (const char* x : a.aka) o.push_back(x);
    }
    for (const auto& it : s.items) if (console_item(it) && !settings::forbidden_dvar(it.dvar)) o.push_back(it.dvar);
    return o;
}

inline std::vector<std::string> setting_names(const settings::schema& s) {
    std::vector<std::string> o;
    for (const auto& it : s.items) if (console_item(it)) o.push_back(short_name(it));
    return o;
}

// The values a setting's second word takes (on/off for a toggle, a list's one-word labels
// and values); nothing for a slider.
inline std::vector<std::string> value_words(const settings::item& it) {
    std::vector<std::string> o;
    if (it.k == settings::kind::toggle) return {"on", "off"};
    if (it.k != settings::kind::select) return o;
    for (size_t i = 0; i < it.values.size(); ++i) {
        const std::string lab = i < it.labels.size() ? settings::lower(it.labels[i]) : std::string();
        if (!lab.empty() && lab.find(' ') == std::string::npos) o.push_back(lab);
        else if (!it.values[i].empty() && it.values[i].find(' ') == std::string::npos) o.push_back(it.values[i]);
    }
    return o;
}

struct completion {
    std::string line;                   // the input line after Tab
    std::vector<std::string> matches;   // more than one: shown to the player
};

// Tab on a whole input line: completes its LAST word, by position. A leading `/` is kept.
inline completion complete_line(const settings::schema& s, std::string_view line) {
    completion out;
    std::string l(line);
    std::string lead;
    while (!l.empty() && (l[0] == '/' || l[0] == '\\')) { lead.push_back(l[0]); l.erase(0, 1); }
    const bool trailing = !l.empty() && (l.back() == ' ' || l.back() == '\t');
    std::vector<std::string> tok = split_ws(l);
    if (trailing || tok.empty()) tok.push_back("");
    const size_t pos = tok.size() - 1;
    const std::string head = settings::lower(tok[0]);
    std::vector<std::string> cands;
    if (pos == 0) {
        cands = first_words(s);
    } else {
        const builtin* b = find_builtin(head);
        const verb v = b ? b->v : verb::none;
        const bool set_verb = head == "set" || head == "seta" || head == "sets";
        if ((v == verb::bind && pos == 1) || (v == verb::unbind && pos == 1)) {
            cands = key_names();
            for (auto& k : cands) k = settings::lower(k);
        } else if (v == verb::bind && pos == 2) {
            for (const auto& [n, c] : action_aliases()) cands.push_back(n);
            for (const auto& it : s.items)
                if (it.k == settings::kind::bind && it.command.find(' ') == std::string::npos) cands.push_back(action_name(it));
        } else if ((v == verb::help) && pos == 1) {
            for (const auto& bb : builtins()) cands.push_back(bb.name);
            for (const auto& n : setting_names(s)) cands.push_back(n);
        } else if ((v == verb::reset && pos == 1) || (set_verb && pos == 1)) {
            cands = setting_names(s);
        } else if (!b && (pos == 1 || (set_verb && pos == 2))) {
            if (const settings::item* it = resolve(s, set_verb ? tok[1] : tok[0])) cands = value_words(*it);
        }
    }
    const std::string c = complete(cands, tok[pos], &out.matches);
    tok[pos] = c;
    std::string rebuilt = lead;
    for (size_t i = 0; i < tok.size(); ++i) rebuilt += (i ? " " : "") + tok[i];
    if (out.matches.size() == 1) rebuilt += " ";
    out.line = rebuilt;
    return out;
}

}  // namespace enw::console
