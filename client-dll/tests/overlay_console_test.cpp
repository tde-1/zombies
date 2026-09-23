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
    using overlay_rule::mode;
    check(overlay_rule::parse_mode(nullptr) == mode::automatic, "unset -> auto");
    check(overlay_rule::parse_mode("") == mode::automatic, "empty -> auto");
    check(overlay_rule::parse_mode("auto") == mode::automatic, "auto");
    check(overlay_rule::parse_mode("allow") == mode::allow, "allow");
    check(overlay_rule::parse_mode("ALLOW") == mode::allow, "ALLOW, any case");
    check(overlay_rule::parse_mode("on") == mode::allow, "on (the setting's label) -> allow");
    check(overlay_rule::parse_mode("refuse") == mode::refuse, "refuse");
    check(overlay_rule::parse_mode("Off") == mode::refuse, "Off -> refuse");
    check(overlay_rule::parse_mode("maybe") == mode::automatic, "garbage -> auto");
    check(overlay_rule::parse_mode("allowx") == mode::automatic, "prefix is not a match");

    // --- the threshold: "a 50 MB block", exact ---
    const uint64_t MB = 1024ull * 1024;
    check(overlay_rule::kDiscordMapBytes == 52428872ull, "Discord's mapping, from its code");
    check(overlay_rule::kAutoMinLargestFree == 0x3210000ull, "auto needs 50 MB + 64 KB in one piece");
    check(overlay_rule::kAutoMinLargestFree >= ((overlay_rule::kDiscordMapBytes + 0xFFF) & ~0xFFFull) + 0xF000,
          "threshold covers page rounding plus worst-case 64 KB alignment");
    check(!overlay_rule::allow_discord(mode::automatic, static_cast<uint64_t>(12.3 * MB)),
          "auto, 12.3 MB (ovg4 fear_mc_2 at +65 s) -> refuse");
    check(!overlay_rule::allow_discord(mode::automatic, static_cast<uint64_t>(39.1 * MB)),
          "auto, 39.1 MB (ovg1) -> refuse");
    check(!overlay_rule::allow_discord(mode::automatic, overlay_rule::kDiscordMapBytes),
          "auto, exactly Discord's byte count -> refuse (page/alignment slack)");
    check(!overlay_rule::allow_discord(mode::automatic, 50 * MB), "auto, 50 MiB flat -> refuse (72 bytes short)");
    check(!overlay_rule::allow_discord(mode::automatic, 0x3210000ull - 1), "auto, one byte under -> refuse");
    check(overlay_rule::allow_discord(mode::automatic, 0x3210000ull), "auto, 50.06 MB -> allow");
    check(overlay_rule::allow_discord(mode::automatic, 64 * MB), "auto, 64 MB -> allow");
    check(overlay_rule::allow_discord(mode::automatic, static_cast<uint64_t>(127.6 * MB)),
          "auto, 127.6 MB (fear_mc_2 at +5 s) -> allow");
    check(overlay_rule::allow_discord(mode::allow, 0), "allow, 0 MB -> allow");
    check(overlay_rule::allow_discord(mode::allow, 12 * MB), "allow, below -> allow");
    check(!overlay_rule::allow_discord(mode::refuse, 900 * MB), "refuse, plenty -> refuse");
    check(!overlay_rule::allow_discord(mode::refuse, 0), "refuse, 0 -> refuse");
    check(std::strcmp(overlay_rule::mode_name(mode::automatic), "auto") == 0 &&
              std::strcmp(overlay_rule::mode_name(mode::allow), "allow") == 0 &&
              std::strcmp(overlay_rule::mode_name(mode::refuse), "refuse") == 0,
          "mode names match the env values");

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

    // --- repeat limiter: B's alternating spam ---
    {
        console_fmt::repeat_filter rf;
        std::string sum;
        unsigned kept_a = 0, kept_b = 0, kept_c = 0;
        unsigned long long t = 1000000;
        for (int i = 0; i < 100; ++i, t += 8) {  // 100 frames at 125 fps, 0.8 s
            if (rf.admit("Failed to log on.\n", t, sum)) ++kept_a;
            if (rf.admit("      dvar set cl_network_warning 0\n", t, sum)) ++kept_b;
        }
        if (rf.admit("a new line\n", t, sum)) ++kept_c;
        check(kept_a == 5 && kept_b == 5, "alternating repeats: 5 of each kept per window");
        check(kept_c == 1, "a different message is always kept");
        check(sum.empty(), "no summary before the window ends");
        t += console_fmt::repeat_filter::kWindowMs;
        const bool k = rf.admit("Failed to log on.\n", t, sum);
        check(k, "new window: the message is written again");
        check(sum.find("(suppressed 95 more in 10s: \"Failed to log on.\")\n") != std::string::npos,
              "summary counts the first message");
        check(sum.find("(suppressed 95 more in 10s: \"      dvar set cl_network_warning 0\")\n") != std::string::npos,
              "summary counts the second message");
        check(sum.find("a new line") == std::string::npos, "nothing suppressed, nothing summarised");
        std::string sum2;
        for (int i = 0; i < 200; ++i) rf.admit(("unique " + std::to_string(i) + "\n").c_str(), t, sum2);
        check(rf.admit("unique 199\n", t, sum2), "past the tracking cap, messages are kept, not dropped");
    }

    std::printf("%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
