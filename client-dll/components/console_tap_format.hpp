// console_tap_format: the pure half of console_tap.cpp (no engine), unit-tested in
// client-dll/tests/overlay_console_test.cpp.
//
// Turns what the engine hands Com_PrintMessage into the text console-<pid>.log keeps:
// every line starts with a wall-clock stamp (so it lines up with enw-<pid>.log), colour
// codes (^0-^9) are removed, and a message that ends mid-line is continued by the
// next one without a second stamp -- the engine prints many lines in pieces.
#pragma once

#include <cstdio>
#include <string>
#include <vector>

namespace enw::console_fmt {

struct clock_hms {
    unsigned h = 0, m = 0, s = 0, ms = 0;
};

class stamper {
public:
    // Appends the cleaned text of `msg` to `out`. `now` is only read when a new line
    // starts. Returns the number of characters appended.
    size_t feed(const char* msg, const clock_hms& now, std::string& out) {
        if (!msg) return 0;
        const size_t before = out.size();
        for (const char* p = msg; *p; ++p) {
            const char c = *p;
            if (c == '^' && p[1] >= '0' && p[1] <= '9') {  // colour code
                ++p;
                continue;
            }
            if (c == '\r') continue;
            if (at_line_start_) {
                char stamp[24];
                std::snprintf(stamp, sizeof stamp, "[%02u:%02u:%02u.%03u] ", now.h % 100, now.m % 100,
                              now.s % 100, now.ms % 1000);
                out += stamp;
                at_line_start_ = false;
            }
            out += c;
            if (c == '\n') at_line_start_ = true;
        }
        return out.size() - before;
    }

    bool at_line_start() const { return at_line_start_; }

private:
    bool at_line_start_ = true;
};

// Keeps a message the engine repeats every frame from drowning the file. Measured on
// fear_mc_2 (ovg2, 2026-09-23): 12,703 of 48,598 lines in two minutes were "Failed to
// log on." (the Demonware logon retry), and B's own console.log alternates it with a
// mod's "dvar set cl_network_warning 0" -- so this counts per message, not "same as the
// previous line". Each distinct message is written at most kPerWindow times per
// kWindowMs; the rest are counted and summarised when the window rolls over.
class repeat_filter {
public:
    static constexpr unsigned kPerWindow = 5;
    static constexpr unsigned long long kWindowMs = 10000;
    static constexpr size_t kTracked = 64;

    // True when `msg` should be written. `summary` receives "(suppressed ...)" lines
    // for the window that just ended (write them before `msg`).
    bool admit(const char* msg, unsigned long long now_ms, std::string& summary) {
        if (now_ms - window_start_ >= kWindowMs) roll(now_ms, summary);
        for (auto& e : seen_) {
            if (e.text == msg) {
                if (e.count < kPerWindow) { ++e.count; return true; }
                ++e.suppressed;
                return false;
            }
        }
        if (seen_.size() < kTracked) seen_.push_back({msg, 1, 0});
        return true;
    }

private:
    struct entry { std::string text; unsigned count; unsigned long long suppressed; };
    void roll(unsigned long long now_ms, std::string& summary) {
        for (auto& e : seen_) {
            if (!e.suppressed) continue;
            std::string t = e.text;
            while (!t.empty() && (t.back() == '\n' || t.back() == '\r')) t.pop_back();
            if (t.size() > 120) t.resize(120);
            char head[64];
            std::snprintf(head, sizeof head, "(suppressed %llu more in %llus: \"", e.suppressed, kWindowMs / 1000);
            summary += head;
            summary += t;
            summary += "\")\n";
        }
        seen_.clear();
        window_start_ = now_ms;
    }
    std::vector<entry> seen_;
    unsigned long long window_start_ = 0;
};

// When the file passes this size it is renamed to console-<pid>.old.log (replacing an
// older one) and a fresh file is started, so the tail of a long session -- the part a
// crash report needs -- is always kept and the disk use is bounded (2x this).
inline constexpr unsigned long long kRotateBytes = 16ull * 1024 * 1024;

}  // namespace enw::console_fmt
