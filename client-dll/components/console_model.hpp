// The ENW console's model: what a typed line means, which setting it names, and whether the
// value is one the setting may take. Pure (no engine, no window), so it is unit-tested
// (tools/tests/lockdown_test.cpp, built as lockdown_test). esc-menu.md §10 is the write-up.
//
// B, 2026-09-23: players never reach World at War's stock console; they get our own, which
// can change sensitivity, FOV and harmless dvars only. "Harmless" is not a second list: it is
// the in-game settings catalogue (shared/settings/ingame-settings.json, the Settings tab's
// list), with `settings::forbidden_dvar` refusing the same dvars it refuses there, and in a
// Verified game only the catalogue's `verified` items. A command that is not a setting is
// never passed to the engine: there is no raw path from this console to Cbuf_AddText.
#pragma once

#include "settings_model.hpp"

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

namespace enw::console {

enum class verb { none, help, list, clear, get, set, reset, refused };

struct command {
    verb v = verb::none;
    std::string name;    // the setting as typed (dvar or catalogue id)
    std::string value;   // set: the value, quotes stripped
    std::string why;     // refused: what to tell the player
};

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

// A typed line -> a command. Nothing here touches the engine; `refused` carries the reason.
inline command parse(std::string_view line) {
    command c;
    std::string t = trim(line);
    while (!t.empty() && (t[0] == '/' || t[0] == '\\')) t.erase(0, 1);   // "/cg_fov 90", as players type it
    if (t.empty()) return c;
    for (char ch : t) {
        const unsigned char u = static_cast<unsigned char>(ch);
        if (ch == ';' || u < 0x20) { c.v = verb::refused; c.why = "One setting at a time."; return c; }
    }
    auto tok = split_ws(t);
    if (tok.empty()) return c;
    const std::string head = settings::lower(tok[0]);
    if (head == "help" || head == "?") { c.v = verb::help; return c; }
    if (head == "list" || head == "cvarlist" || head == "dvarlist" || head == "cmdlist") {
        c.v = verb::list;
        if (tok.size() > 1) c.name = tok[1];
        return c;
    }
    if (head == "clear" || head == "cls") { c.v = verb::clear; return c; }
    if (head == "reset") {
        if (tok.size() != 2) { c.v = verb::refused; c.why = "Usage: reset <setting>"; return c; }
        c.v = verb::reset;
        c.name = tok[1];
        return c;
    }
    size_t at = 0;
    if (head == "set" || head == "seta" || head == "sets") {
        if (tok.size() < 3) { c.v = verb::refused; c.why = "Usage: " + head + " <setting> <value>"; return c; }
        at = 1;
    }
    c.name = tok[at];
    if (tok.size() == at + 1) { c.v = verb::get; return c; }
    if (tok.size() > at + 2) { c.v = verb::refused; c.why = "One value only."; return c; }
    c.v = verb::set;
    c.value = tok[at + 1];
    return c;
}

// The catalogue item a name means: its dvar, or its catalogue id ("fov", "sensitivity").
// Binds and read-only info rows are not console settings.
inline const settings::item* resolve(const settings::schema& s, std::string_view name) {
    const std::string n = settings::lower(name);
    if (n.empty()) return nullptr;
    for (const auto& it : s.items)
        if (it.k != settings::kind::bind && it.k != settings::kind::info && !it.dvar.empty() && settings::lower(it.dvar) == n)
            return &it;
    for (const auto& it : s.items)
        if (it.k != settings::kind::bind && it.k != settings::kind::info && !it.dvar.empty() && settings::lower(it.id) == n)
            return &it;
    return nullptr;
}

// What values a setting takes, for the player.
inline std::string range_text(const settings::item& it) {
    switch (it.k) {
    case settings::kind::slider:
        return settings::fmt_number(it.min, settings::decimals_of(it.step)) + " to " +
               settings::fmt_number(it.max, settings::decimals_of(it.step));
    case settings::kind::toggle:
        return "0 or 1";
    case settings::kind::select: {
        if (it.free_values) return "a value";
        std::string o;
        for (const auto& v : it.values) o += (o.empty() ? "" : ", ") + (v.empty() ? std::string("\"\"") : v);
        return o;
    }
    default:
        return {};
    }
}

// Is `value` one this setting may take? On true, `norm` is what to write (a toggle's
// on/off made its own value, a slider snapped to its step, a list label made its value).
inline bool validate(const settings::item& it, const std::string& value, std::string* norm, std::string* err) {
    const std::string v = trim(value);
    switch (it.k) {
    case settings::kind::toggle: {
        if (it.values.size() != 2) break;
        const std::string l = settings::lower(v);
        int idx = settings::same_value(v, it.values[0]) ? 0 : settings::same_value(v, it.values[1]) ? 1 : -1;
        if (idx < 0 && (l == "on" || l == "true" || l == "yes")) idx = 1;
        if (idx < 0 && (l == "off" || l == "false" || l == "no")) idx = 0;
        if (idx < 0) break;
        *norm = it.values[static_cast<size_t>(idx)];
        return true;
    }
    case settings::kind::select: {
        for (size_t i = 0; i < it.values.size(); ++i)
            if (settings::same_value(v, it.values[i]) ||
                (i < it.labels.size() && settings::lower(it.labels[i]) == settings::lower(v))) {
                *norm = it.values[i];
                return true;
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
        if (err) *err = it.label + " is not set from the console.";
        return false;
    }
    if (err) *err = it.label + " takes " + range_text(it) + ".";
    return false;
}

// Tab completion over the names the console accepts: the unique completion, or the longest
// common prefix of every match (and the matches, for the player to read).
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

// Why a name is not a console setting, for the one line the player reads.
inline std::string refusal_for(std::string_view name) {
    if (settings::forbidden_dvar(name)) return std::string(name) + " is locked.";
    return std::string(name) + " is not available here. Type help.";
}

}  // namespace enw::console
