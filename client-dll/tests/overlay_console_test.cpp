// Unit test for client-dll/components/overlay_guard_rules.hpp and console_tap_format.hpp
// -- the pure halves of overlay_guard.cpp (Discord's hook kept out) and console_tap.cpp
// (console-<pid>.log). No engine.
//
// Deliberately NOT under client-dll/components/: CMake globs that directory into the DLL,
// and a main() there would be linked into binkw32.dll. Build and run (VS BuildTools x86
// prompt, or any C++17 compiler on Windows):
//
//     cl /nologo /EHsc /std:c++17 client-dll\tests\overlay_console_test.cpp /Fe:build\overlay_console_test.exe
//     build\overlay_console_test.exe
#include "../components/console_tap_format.hpp"
#include "../components/overlay_guard_rules.hpp"

#include <cstdio>
#include <cstring>
#include <string>

using namespace enw;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

static bool refused(const wchar_t* s) { return overlay_rule::refuse_module(s, std::wcslen(s)); }

int main() {
    // --- which loads are refused ---
    // The exact path Discord injected into B's game (discord_hook.log / Event 1000).
    check(refused(L"C:\\Users\\b\\AppData\\Local\\Discord\\app-1.0.9259\\modules\\discord_hook-1\\discord_hook\\"
                  L"1342ee47cf7536\\DiscordHook.dll"),
          "B's DiscordHook.dll path is refused");
    check(refused(L"DiscordHook.dll"), "bare name");
    check(refused(L"DISCORDHOOK.DLL"), "case-insensitive");
    check(refused(L"discordhook"), "LoadLibrary-style name without .dll");
    check(refused(L"\\\\?\\C:\\x\\DiscordHook64.dll"), "64-bit name, \\\\?\\ prefix");
    check(refused(L"C:/x/y/DiscordHook.dll"), "forward slashes");
    check(!refused(L"C:\\Windows\\System32\\d3d9.dll"), "d3d9 allowed");
    check(!refused(L"binkw32.dll"), "our own proxy allowed");
    check(!refused(L"DiscordHookHelper.exe"), "helper name is not the hook");
    check(!refused(L"C:\\DiscordHook.dll\\other.dll"), "directory named like the hook does not count");
    check(!refused(L"myDiscordHook.dll"), "suffix match is not enough");
    check(!overlay_rule::refuse_module(nullptr, 0), "null name");
    check(!overlay_rule::refuse_module(L"DiscordHook.dll", 0), "zero length");
    // A UNICODE_STRING is not NUL-terminated: only `len` characters count.
    const wchar_t buf[] = L"DiscordHook.dllXXXX";
    check(overlay_rule::refuse_module(buf, 15), "counted string, exact length");
    check(!overlay_rule::refuse_module(buf, 19), "counted string, longer length");

    // --- the opt-in switch ---
    check(!overlay_rule::allow_from_env(nullptr), "unset -> refuse");
    check(!overlay_rule::allow_from_env(""), "empty -> refuse");
    check(!overlay_rule::allow_from_env("0"), "0 -> refuse");
    check(!overlay_rule::allow_from_env("yes"), "yes -> refuse (only 1)");
    check(!overlay_rule::allow_from_env("10"), "10 -> refuse");
    check(overlay_rule::allow_from_env("1"), "1 -> allow");

    // --- the address-space measure is real and moves when we take a block ---
    const auto a = overlay_rule::measure_free();
    check(a.total > 0 && a.largest > 0 && a.largest <= a.total, "measure_free sane");
    void* p = ::VirtualAlloc(nullptr, static_cast<SIZE_T>(a.largest / 2), MEM_RESERVE, PAGE_NOACCESS);
    const auto b = overlay_rule::measure_free();
    check(p && b.total + a.largest / 4 < a.total + 1, "reserving half the largest block lowers total free");
    if (p) ::VirtualFree(p, 0, MEM_RELEASE);
    std::printf("address space here: largest free %.1f MB of %.1f MB\n", a.largest / 1048576.0,
                a.total / 1048576.0);

    // --- console_tap line format ---
    console_fmt::stamper st;
    std::string out;
    const console_fmt::clock_hms t1{3, 42, 30, 451}, t2{3, 42, 31, 7};
    st.feed("^3Failed to log on.\n", t1, out);
    check(out == "[03:42:30.451] Failed to log on.\n", "colour code stripped, stamped");
    out.clear();
    st.feed("      dvar set ", t1, out);
    st.feed("cl_network_warning 0\n", t2, out);
    check(out == "[03:42:30.451]       dvar set cl_network_warning 0\n", "a line printed in pieces gets one stamp");
    out.clear();
    st.feed("a\nb\n", t2, out);
    check(out == "[03:42:31.007] a\n[03:42:31.007] b\n", "two lines in one message, two stamps");
    out.clear();
    st.feed("x^1y^^7z\r\n", t2, out);
    check(out == "[03:42:31.007] xy^z\n", "inner codes and CR removed; lone ^ kept");
    out.clear();
    st.feed("tail with no newline", t2, out);
    check(!st.at_line_start(), "partial line leaves the stamper mid-line");
    st.feed("", t2, out);
    check(out == "[03:42:31.007] tail with no newline", "empty message adds nothing");
    check(st.feed(nullptr, t2, out) == 0, "null message adds nothing");
    out.clear();
    st.feed("^", t2, out);
    check(out == "^", "trailing lone ^ is kept, no stamp mid-line");
    check(console_fmt::kRotateBytes == 16ull * 1024 * 1024, "rotation at 16 MB");

    std::printf("%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
