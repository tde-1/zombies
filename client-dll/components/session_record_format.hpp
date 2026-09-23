// session_record_format: the pure half of session_record.cpp (no engine, no Windows
// calls), so it can be unit-tested on its own: client-dll/tests/session_record_test.cpp.
//
// Formats the small `session-<pid>.json` the launcher reads to flag a session without
// parsing a 50 MB log. It is called from the unhandled-exception filter, so:
//   * NO heap, NO CRT formatting (snprintf can touch the CRT's per-thread data and the
//     locale, which may allocate on a thread that never used the CRT), NO locks. Plain
//     loops into a caller-owned buffer.
//   * every string is read at most kMaxString bytes, so a torn or unterminated buffer
//     (another thread writing the error text while we crash) is still bounded;
//   * the output is pure ASCII: engine text is Windows-1252, not UTF-8, so every byte
//     >= 0x80 is written as \u00XX (its Latin-1 code point), controls likewise.
#pragma once

#include <cstddef>
#include <cstdint>

namespace enw::session_fmt {

// Ordered by severity: a record is only ever rewritten with an equal or worse exit.
enum class exit_kind : int { unknown = 0, quit = 1, error = 2, hang = 3, crash = 4 };

inline const char* exit_name(exit_kind k) {
    switch (k) {
        case exit_kind::quit: return "quit";
        case exit_kind::error: return "error";
        case exit_kind::hang: return "hang";
        case exit_kind::crash: return "crash";
        default: return "unknown";
    }
}

struct exception_info {
    uint32_t code = 0;
    uint32_t address = 0;
    const char* module = nullptr;  // base name, or null when the address is in no image
    uint32_t offset = 0;           // address - module base (only when module is set)
};

struct fields {
    uint32_t pid = 0;
    const char* build = nullptr;
    const char* started_at = nullptr;  // ISO 8601 UTC, iso_utc()
    const char* ended_at = nullptr;    // null while the process is alive (the startup record)
    exit_kind exit = exit_kind::unknown;
    const exception_info* exception = nullptr;
    const char* last_error = nullptr;
    const char* last_map = nullptr;
    uint64_t frames = 0;
    int32_t largest_free_tenths_mb = -1;  // -1: not measured (overlay_guard off / not yet)
    const char* hang_dump = nullptr;
    const char* hang_where = nullptr;  // hang_watchdog's verdict, e.g. who holds the render lock
    uint32_t discord_hook_refused = 0;
};

constexpr size_t kMaxString = 1024;

class sink {
public:
    sink(char* buf, size_t cap) : b_(buf), cap_(cap) {}
    void ch(char c) {
        if (n_ + 1 < cap_) b_[n_++] = c;
        else over_ = true;
    }
    void raw(const char* s) {
        for (; *s; ++s) ch(*s);
    }
    void u64(uint64_t v) {
        char t[24];
        int i = 0;
        do { t[i++] = static_cast<char>('0' + v % 10); v /= 10; } while (v);
        while (i) ch(t[--i]);
    }
    // "0x" + at least `digits` upper-case hex digits.
    void hex(uint32_t v, int digits) {
        const char* const d = "0123456789ABCDEF";
        char t[8];
        int i = 0;
        do { t[i++] = d[v & 0xF]; v >>= 4; } while (v);
        while (i < digits && i < 8) t[i++] = '0';
        raw("0x");
        while (i) ch(t[--i]);
    }
    // A JSON string, or null for a null/empty pointer.
    void str(const char* s) {
        if (!s || !*s) { raw("null"); return; }
        const char* const d = "0123456789abcdef";
        ch('"');
        for (size_t i = 0; i < kMaxString && s[i]; ++i) {
            const auto c = static_cast<unsigned char>(s[i]);
            if (c == '"' || c == '\\') { ch('\\'); ch(static_cast<char>(c)); }
            else if (c == '\n') raw("\\n");
            else if (c == '\r') raw("\\r");
            else if (c == '\t') raw("\\t");
            else if (c < 0x20 || c >= 0x7F) { raw("\\u00"); ch(d[c >> 4]); ch(d[c & 0xF]); }
            else ch(static_cast<char>(c));
        }
        ch('"');
    }
    void key(const char* k, bool first = false) {
        if (!first) ch(',');
        ch('"');
        raw(k);
        raw("\":");
    }
    bool overflowed() const { return over_; }
    size_t size() const { return n_; }
    void terminate() { if (cap_) b_[n_ < cap_ ? n_ : cap_ - 1] = 0; }

private:
    char* b_;
    size_t cap_;
    size_t n_ = 0;
    bool over_ = false;
};

// One line of JSON plus "\n", NUL-terminated. Returns the byte count (without the NUL),
// or 0 when it did not fit (the buffer then holds a truncated, invalid prefix -- do not
// write it).
inline size_t format(const fields& f, char* buf, size_t cap) {
    if (!buf || !cap) return 0;
    sink o(buf, cap);
    o.ch('{');
    o.key("v", true); o.u64(1);
    o.key("pid"); o.u64(f.pid);
    o.key("build"); o.str(f.build);
    o.key("started_at"); o.str(f.started_at);
    o.key("ended_at"); o.str(f.ended_at);
    o.key("exit"); o.str(exit_name(f.exit));
    o.key("exception");
    if (f.exception) {
        o.ch('{');
        o.key("code", true); o.ch('"'); o.hex(f.exception->code, 8); o.ch('"');
        o.key("address"); o.ch('"'); o.hex(f.exception->address, 8); o.ch('"');
        o.key("module"); o.str(f.exception->module);
        o.key("offset");
        if (f.exception->module && *f.exception->module) { o.ch('"'); o.hex(f.exception->offset, 1); o.ch('"'); }
        else o.raw("null");
        o.ch('}');
    } else {
        o.raw("null");
    }
    o.key("last_error"); o.str(f.last_error);
    o.key("last_map"); o.str(f.last_map);
    o.key("frames"); o.u64(f.frames);
    o.key("largest_free_block_mb");
    if (f.largest_free_tenths_mb >= 0) {
        o.u64(static_cast<uint32_t>(f.largest_free_tenths_mb) / 10);
        o.ch('.');
        o.u64(static_cast<uint32_t>(f.largest_free_tenths_mb) % 10);
    } else {
        o.raw("null");
    }
    o.key("hang_dump"); o.str(f.hang_dump);
    o.key("hang_where"); o.str(f.hang_where);
    o.key("discord_hook_refused"); o.u64(f.discord_hook_refused);
    o.ch('}');
    o.ch('\n');
    if (o.overflowed()) { o.terminate(); return 0; }
    o.terminate();
    return o.size();
}

inline void two(char*& p, unsigned v) { *p++ = static_cast<char>('0' + v / 10 % 10); *p++ = static_cast<char>('0' + v % 10); }

// "2026-09-23T14:05:11.123Z" into out (needs 25 bytes). From SYSTEMTIME's fields (UTC).
inline void iso_utc(unsigned y, unsigned mo, unsigned d, unsigned h, unsigned mi, unsigned s, unsigned ms,
                    char (&out)[25]) {
    char* p = out;
    two(p, y / 100); two(p, y % 100); *p++ = '-';
    two(p, mo); *p++ = '-'; two(p, d); *p++ = 'T';
    two(p, h); *p++ = ':'; two(p, mi); *p++ = ':'; two(p, s); *p++ = '.';
    *p++ = static_cast<char>('0' + ms / 100 % 10); two(p, ms % 100);
    *p++ = 'Z';
    *p = 0;
}

inline bool contains_ci(const char* s, const char* k) {
    if (!s) return false;
    for (size_t i = 0; i < kMaxString && s[i]; ++i) {
        size_t j = 0;
        for (; k[j] && s[i + j]; ++j) {
            char a = s[i + j], b = k[j];
            if (a >= 'a' && a <= 'z') a = static_cast<char>(a - 32);
            if (a != b) break;
        }
        if (!k[j]) return true;
    }
    return false;
}

// Does the engine error that ended a session (com_errorMessage when the game fell back to
// the menu) make it exit 'error' rather than 'quit'? Empty text is a game that simply
// ended; the server closing the game is how every box game ends. `k` keys are upper case.
inline bool is_error_end(const char* err) {
    if (!err || !*err) return false;
    if (contains_ci(err, "SERVERDISCONNECT") || contains_ci(err, "SERVER_DISCONNECT") ||
        contains_ci(err, "DISCONNECTED"))
        return false;
    return true;
}

}  // namespace enw::session_fmt
