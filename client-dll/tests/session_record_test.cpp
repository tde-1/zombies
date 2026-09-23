// Unit test for client-dll/components/session_record_format.hpp -- the pure half of
// session_record.cpp (session-<pid>.json). No engine, no Windows.
//
// Not under client-dll/components/ (CMake globs that into the DLL). Build and run from a
// VS BuildTools x86 prompt:
//
//     cl /nologo /EHsc /std:c++17 /W4 client-dll\tests\session_record_test.cpp /Fe:build\session_record_test.exe
//     build\session_record_test.exe
#include "../components/session_record_format.hpp"

#include <cstdio>
#include <cstring>
#include <string>

using namespace enw::session_fmt;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

static std::string fmt(const fields& f, size_t cap = 16384) {
    std::string b(cap, '\x7f');
    const size_t n = format(f, &b[0], cap);
    if (!n) return std::string();
    check(b[n] == 0, "NUL-terminated");
    b.resize(n);
    return b;
}

static bool has(const std::string& s, const char* k) { return s.find(k) != std::string::npos; }

// A minimal JSON validator (objects, strings with escapes, numbers, null): enough to say the
// output parses, without pulling a library into a one-file test.
struct vparse {
    const char* p;
    bool ws() { while (*p == ' ' || *p == '\n') ++p; return true; }
    bool str() {
        if (*p++ != '"') return false;
        while (*p && *p != '"') {
            const unsigned char c = static_cast<unsigned char>(*p);
            if (c < 0x20 || c >= 0x7F) return false;  // we promise pure ASCII, no raw controls
            if (*p == '\\') {
                ++p;
                if (*p == 'u') {
                    for (int i = 1; i <= 4; ++i)
                        if (!std::strchr("0123456789abcdefABCDEF", p[i]) || !p[i]) return false;
                    p += 5;
                    continue;
                }
                if (!std::strchr("\"\\/bfnrt", *p) || !*p) return false;
            }
            ++p;
        }
        return *p++ == '"';
    }
    bool val() {
        ws();
        if (*p == '"') return str();
        if (*p == '{') return obj();
        if (!std::strncmp(p, "null", 4)) { p += 4; return true; }
        if (*p == '-' || (*p >= '0' && *p <= '9')) {
            ++p;
            while ((*p >= '0' && *p <= '9') || *p == '.') ++p;
            return true;
        }
        return false;
    }
    bool obj() {
        if (*p++ != '{') return false;
        ws();
        if (*p == '}') { ++p; return true; }
        for (;;) {
            ws();
            if (!str()) return false;
            ws();
            if (*p++ != ':') return false;
            if (!val()) return false;
            ws();
            if (*p == ',') { ++p; continue; }
            return *p++ == '}';
        }
    }
};
static bool valid_json(const std::string& s) {
    vparse v{s.c_str()};
    return v.obj() && v.ws() && *v.p == 0;
}

int main() {
    // --- the startup record: everything unknown is null ---
    {
        fields f;
        f.pid = 23916;
        f.build = "enw_t4 Sep 23 2026 12:00:00";
        f.started_at = "2026-09-23T03:41:53.012Z";
        const std::string s = fmt(f);
        check(s == "{\"v\":1,\"pid\":23916,\"build\":\"enw_t4 Sep 23 2026 12:00:00\",\"started_at\":\"2026-09-23T03:41:53.012Z\","
                   "\"ended_at\":null,\"exit\":\"unknown\",\"exception\":null,\"last_error\":null,\"last_map\":null,"
                   "\"frames\":0,\"largest_free_block_mb\":null,\"hang_dump\":null,\"hang_where\":null,\"discord_hook_refused\":0}\n",
              "startup record, byte for byte");
        check(valid_json(s), "startup record parses");
    }
    // --- empty strings are null too (a global char buffer that was never filled) ---
    {
        fields f;
        f.build = "";
        f.last_error = "";
        f.last_map = "";
        f.hang_dump = "";
        const std::string s = fmt(f);
        check(has(s, "\"build\":null") && has(s, "\"last_error\":null") && has(s, "\"last_map\":null") &&
                  has(s, "\"hang_dump\":null"),
              "empty strings -> null");
    }
    // --- B's 03:42 crash, as the record would have been ---
    {
        exception_info ex;
        ex.code = 0xC0000005;
        ex.address = 0x6A21F7FD;
        ex.module = "DiscordHook.dll";
        ex.offset = 0x1F7FD;
        fields f;
        f.pid = 23916;
        f.exit = exit_kind::crash;
        f.exception = &ex;
        f.ended_at = "2026-09-23T03:42:30.426Z";
        f.last_map = "fear_mc_2";
        f.frames = 4312345678ull;  // > 32 bits
        f.largest_free_tenths_mb = 196;
        f.discord_hook_refused = 0;
        const std::string s = fmt(f);
        check(has(s, "\"exit\":\"crash\""), "exit crash");
        check(has(s, "\"exception\":{\"code\":\"0xC0000005\",\"address\":\"0x6A21F7FD\",\"module\":\"DiscordHook.dll\","
                     "\"offset\":\"0x1F7FD\"}"),
              "exception object");
        check(has(s, "\"frames\":4312345678"), "64-bit frame count");
        check(has(s, "\"largest_free_block_mb\":19.6"), "19.6 MB from tenths");
        check(valid_json(s), "crash record parses");
    }
    // --- exception outside any image: module and offset null, address zero-padded ---
    {
        exception_info ex;
        ex.code = 0x80000003;
        ex.address = 0x45;
        fields f;
        f.exception = &ex;
        const std::string s = fmt(f);
        check(has(s, "\"exception\":{\"code\":\"0x80000003\",\"address\":\"0x00000045\",\"module\":null,\"offset\":null}"),
              "no module -> nulls");
        check(valid_json(s), "no-module record parses");
    }
    // --- hang ---
    {
        fields f;
        f.exit = exit_kind::hang;
        f.hang_dump = "C:\\Users\\b\\AppData\\Local\\ENWZombies\\logs\\hang-34580-20260923-021500.dmp";
        const std::string s = fmt(f);
        check(has(s, "\"hang_dump\":\"C:\\\\Users\\\\b\\\\AppData\\\\Local\\\\ENWZombies\\\\logs\\\\hang-34580-20260923-021500.dmp\""),
              "backslashes in a path escaped");
        check(has(s, "\"exit\":\"hang\""), "exit hang");
        check(has(s, "\"hang_where\":null"), "no verdict -> null");
        check(valid_json(s), "hang record parses");
    }
    // --- hang with the watchdog's verdict (lane CL, zombie_town) ---
    {
        fields f;
        f.exit = exit_kind::hang;
        f.hang_where = "main waits on the render lock; holder tid 18204 at 0x6A1B2C3D (d3d9.dll+0x1B2C3D)";
        const std::string s = fmt(f);
        check(has(s, "\"hang_where\":\"main waits on the render lock; holder tid 18204 at 0x6A1B2C3D (d3d9.dll+0x1B2C3D)\""),
              "hang_where written");
        check(valid_json(s), "hang_where record parses");
    }
    // --- escaping of engine error text ---
    {
        fields f;
        f.exit = exit_kind::error;
        f.last_error = "Error: \"bad\" \\ path\nline2\r\t\x01 \x1b end";
        const std::string s = fmt(f);
        check(has(s, "\"last_error\":\"Error: \\\"bad\\\" \\\\ path\\nline2\\r\\t\\u0001 \\u001b end\""),
              "quotes, backslash, newline, CR, tab, control bytes");
        check(valid_json(s), "escaped record parses");
    }
    {
        // Windows-1252 bytes (the engine's own text) and DEL: \u00XX, output pure ASCII.
        fields f;
        f.last_error = "caf\xe9 \x7f \xff";
        const std::string s = fmt(f);
        check(has(s, "\"last_error\":\"caf\\u00e9 \\u007f \\u00ff\""), "high bytes as Latin-1 escapes");
        bool ascii = true;
        for (unsigned char c : s) if (c >= 0x80) ascii = false;
        check(ascii, "pure ASCII output");
        check(valid_json(s), "latin-1 record parses");
    }
    // --- a torn / unterminated buffer is read at most kMaxString bytes ---
    {
        std::string big(kMaxString + 500, 'a');  // std::string is terminated, but only the cap is read
        fields f;
        f.last_error = big.c_str();
        const std::string s = fmt(f);
        const size_t q = s.find("\"last_error\":\"");
        const size_t e = s.find('"', q + 14);
        check(q != std::string::npos && e - (q + 14) == kMaxString, "string capped at kMaxString");
        check(valid_json(s), "capped record parses");
    }
    // --- overflow: 0, never a truncated record handed to WriteFile ---
    {
        fields f;
        f.build = "enw_t4";
        char small[64];
        check(format(f, small, sizeof small) == 0, "overflow returns 0");
        check(small[63] == 0, "overflow still NUL-terminates");
        check(format(f, nullptr, 10) == 0 && format(f, small, 0) == 0, "null / zero buffer");
        const std::string full = fmt(f);
        std::string exact(full.size() + 1, 'x');
        check(format(f, &exact[0], exact.size()) == full.size(), "exactly fits (size + NUL)");
        std::string one_short(full.size(), 'x');
        check(format(f, &one_short[0], one_short.size()) == 0, "one byte short -> 0");
    }
    // --- worst case of the real globals fits the DLL's 16 KB buffer ---
    {
        std::string err(511, '\x01'), path(259, '"'), map(127, '\\'), build(63, '\xff');
        exception_info ex;
        ex.module = "x";
        fields f;
        f.build = build.c_str();
        f.started_at = "2026-09-23T03:41:53.012Z";
        f.ended_at = "2026-09-23T03:41:53.012Z";
        f.exception = &ex;
        f.last_error = err.c_str();
        f.last_map = map.c_str();
        f.hang_dump = path.c_str();
        f.frames = ~0ull;
        f.largest_free_tenths_mb = 0x7FFFFFFF;
        f.discord_hook_refused = 0xFFFFFFFFu;
        const std::string s = fmt(f, 16384);
        check(!s.empty() && s.size() < 16384, "worst case fits 16 KB");
        check(valid_json(s), "worst case parses");
    }
    // --- exit names and ordering ---
    check(!std::strcmp(exit_name(exit_kind::unknown), "unknown") && !std::strcmp(exit_name(exit_kind::quit), "quit") &&
              !std::strcmp(exit_name(exit_kind::error), "error") && !std::strcmp(exit_name(exit_kind::hang), "hang") &&
              !std::strcmp(exit_name(exit_kind::crash), "crash"),
          "exit names");
    check(exit_kind::unknown < exit_kind::quit && exit_kind::quit < exit_kind::error &&
              exit_kind::error < exit_kind::hang && exit_kind::hang < exit_kind::crash,
          "severity order");
    // --- timestamps ---
    {
        char t[25];
        iso_utc(2026, 9, 23, 3, 42, 30, 426, t);
        check(!std::strcmp(t, "2026-09-23T03:42:30.426Z"), "iso_utc");
        iso_utc(2027, 1, 2, 0, 0, 5, 7, t);
        check(!std::strcmp(t, "2027-01-02T00:00:05.007Z"), "iso_utc zero padding");
    }
    // --- which engine errors make a session exit 'error' ---
    check(!is_error_end(nullptr) && !is_error_end(""), "no error text -> not an error end");
    check(!is_error_end("EXE_SERVERDISCONNECTED") && !is_error_end("EXE_SERVER_DISCONNECTED") &&
              !is_error_end("exe_disconnected"),
          "the server closing the game is a normal end");
    check(is_error_end("EXE_TIMEDOUT") && is_error_end("script runtime error") &&
              is_error_end("Lost the connection to the server (it sent nothing while in the map)"),
          "timeouts, script errors, a silent server are error ends");

    std::printf("session_record_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
