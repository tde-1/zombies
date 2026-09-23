// The pure half of ENW's screenshot (screenshot.cpp): the file name, the format setting and the
// key-spam limit. Header-only, no Windows, so tools/tests/screenshot_test.cpp runs it as it is.
//
// Name: "ENW Zombies <map> <yyyy-mm-dd hh-mm-ss>.jpg" (B, 2026-09-24), the shape ReShade's
// default `%AppName% %Date% %Time%` and Steam's per-game folders made familiar. <map> is the
// title the launcher knows (ENW_MAP_TITLE), else the stock map's own name, else the bsp.
#pragma once

#include <cstdio>
#include <string>

namespace enw::client::screenshot_name {

// The stock four, by the names on their loading screens; anything else is the launcher's title or
// the bsp as it is.
inline std::string stock_title(const std::string& bsp) {
    std::string b;
    for (char c : bsp) b.push_back(static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c));
    if (b == "nazi_zombie_prototype") return "Nacht der Untoten";
    if (b == "nazi_zombie_asylum") return "Verruckt";
    if (b == "nazi_zombie_sumpf") return "Shi No Numa";
    if (b == "nazi_zombie_factory") return "Der Riese";
    return {};
}

// Safe as one Windows file-name component: no \ / : * ? " < > | or control characters, runs of
// spaces collapsed, no leading/trailing spaces or dots, at most 64 bytes (cut on a UTF-8 boundary).
// Empty in, empty out.
inline std::string sanitize(const std::string& in) {
    std::string out;
    for (unsigned char c : in) {
        if (c < 0x20 || c == 0x7F || c == '\\' || c == '/' || c == ':' || c == '*' || c == '?' || c == '"' ||
            c == '<' || c == '>' || c == '|' || c == '^')
            c = ' ';
        if (c == ' ' && (out.empty() || out.back() == ' ')) continue;
        out.push_back(static_cast<char>(c));
    }
    while (!out.empty() && (out.back() == ' ' || out.back() == '.')) out.pop_back();
    size_t start = 0;
    while (start < out.size() && (out[start] == ' ' || out[start] == '.')) ++start;
    out.erase(0, start);
    if (out.size() > 64) {
        size_t n = 64;
        while (n > 0 && (static_cast<unsigned char>(out[n]) & 0xC0) == 0x80) --n;   // not mid-character
        out.resize(n);
        while (!out.empty() && (out.back() == ' ' || out.back() == '.')) out.pop_back();
    }
    return out;
}

// The <map> part. `title` (the launcher's, for the map this launch was for) wins while the game is on
// that map; then the stock name; then the bsp; "World at War" when there is no map at all.
inline std::string map_part(const std::string& bsp, const std::string& title, const std::string& launch_bsp) {
    std::string lb, bb;
    for (char c : launch_bsp) lb.push_back(static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c));
    for (char c : bsp) bb.push_back(static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c));
    if (!title.empty() && (lb.empty() || bb.empty() || lb == bb)) {
        const std::string t = sanitize(title);
        if (!t.empty()) return t;
    }
    const std::string s = stock_title(bsp);
    if (!s.empty()) return s;
    const std::string b = sanitize(bsp);
    return b.empty() ? std::string("World at War") : b;
}

enum class format { jpg, png };

// The setting's value (enw_shotformat / ENW_SCREENSHOT_FORMAT): "png" is PNG, anything else JPEG.
inline format parse_format(const std::string& v) {
    std::string s;
    for (char c : v) if (c != ' ' && c != '"' && c != '.') s.push_back(static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c));
    return s == "png" ? format::png : format::jpg;
}
inline const char* ext(format f) { return f == format::png ? "png" : "jpg"; }

// "ENW Zombies Nacht der Untoten 2026-09-24 14-03-22.jpg"; `dup` >= 2 adds " (dup)" before the
// extension, for a second shot in the same second.
inline std::string file_name(const std::string& map, int y, int mo, int d, int h, int mi, int s, format f,
                             int dup = 1) {
    char stamp[48];
    std::snprintf(stamp, sizeof stamp, "%04d-%02d-%02d %02d-%02d-%02d", y, mo, d, h, mi, s);
    std::string n = "ENW Zombies ";
    n += map.empty() ? std::string("World at War") : map;
    n += ' ';
    n += stamp;
    if (dup >= 2) n += " (" + std::to_string(dup) + ")";
    n += '.';
    n += ext(f);
    return n;
}

// One accepted press per `gap_ms`; a held or mashed key is not a burst of 11 MB files.
struct rate_limit {
    unsigned long long last = 0;
    bool have = false;
    bool allow(unsigned long long now_ms, unsigned long long gap_ms = 500) {
        if (have && now_ms - last < gap_ms) return false;
        have = true;
        last = now_ms;
        return true;
    }
};

}  // namespace enw::client::screenshot_name
