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

// When the file passes this size it is renamed to console-<pid>.old.log (replacing an
// older one) and a fresh file is started, so the tail of a long session -- the part a
// crash report needs -- is always kept and the disk use is bounded (2x this).
inline constexpr unsigned long long kRotateBytes = 16ull * 1024 * 1024;

}  // namespace enw::console_fmt
