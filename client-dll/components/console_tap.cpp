// console_tap: every line the engine prints, in %LOCALAPPDATA%\ENWZombies\logs\console-<pid>.log,
// always, beside enw-<pid>.log.
//
// Why (2026-09-23, next-session.md bug 2): B's reports had no engine evidence. The
// engine's own console.log is the wrong tool for a player's machine:
//   * it needs `+set logfile 1|2`, and `logfile` changes engine behaviour -- it puts
//     the script VM in developer mode (dedi.md s16; script_error_retail.cpp);
//   * it goes to <fs_homepath>\<fs_game>\console.log, i.e. one file PER MAP under
//     %LOCALAPPDATA%\ENWZombies\home\mods\<bsp>\, which is where nobody looked; the
//     "no console.log since 18:07" of mod-compat.md s1 was a search in the wrong folder
//     (B's fear_mc_2 file was rewritten at 03:42:30, the second his game died);
//   * it is truncated at every launch, so a relaunch after a crash wipes the evidence.
// This file is named by process id like the DLL's own log, so a crash, a relaunch and
// the next game each keep their own.
//
// How: a MinHook detour on Com_PrintMessage (0x59A170, cdecl (channel, msg, type)),
// the one function Com_Printf / Com_DPrintf / Com_PrintError all end in. The detour
// writes first and then calls the engine, so the engine behaves exactly as before
// and the line that precedes a crash inside the print path is already on disk.
// Each piece goes to the file with WriteFile (no CRT buffer): once WriteFile returns
// the bytes are in the OS cache and survive the process dying. The detour never calls
// the engine or our logger (our logger mirrors to Com_Printf -> here).
//
// Off: ENW_CONSOLE_TAP=0. Client processes only.
#include "component.hpp"
#include "console_tap_format.hpp"
#include "hook.hpp"
#include "logger.hpp"

#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>

namespace enw::client::console_tap {
namespace {

constexpr uintptr_t kComPrintMessage = 0x59A170;
// push ebp; mov ebp,esp; and esp,-8; push esi; push edi; mov edi,[ebp+0xC]
constexpr uint8_t kSig[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF8, 0x56, 0x57, 0x8B, 0x7D, 0x0C};

using print_message_t = void(__cdecl*)(int channel, const char* msg, int type);

hook g_hook;
std::mutex g_mu;
HANDLE g_file = INVALID_HANDLE_VALUE;
std::string g_path, g_old_path;
unsigned long long g_bytes = 0;
console_fmt::stamper g_stamp;
console_fmt::repeat_filter g_repeat;
std::string g_buf;
unsigned long g_lines_dropped = 0;

std::string log_dir() {
    char buf[MAX_PATH] = {};
    DWORD n = ::GetEnvironmentVariableA("ENW_LOGDIR", buf, MAX_PATH);
    if (n && n < MAX_PATH) return std::string(buf, n);
    n = ::GetEnvironmentVariableA("LOCALAPPDATA", buf, MAX_PATH);
    std::string d = (n && n < MAX_PATH) ? std::string(buf, n) : std::string(".");
    d += "\\ENWZombies";
    ::CreateDirectoryA(d.c_str(), nullptr);
    d += "\\logs";
    ::CreateDirectoryA(d.c_str(), nullptr);
    return d;
}

HANDLE open_fresh(const std::string& path) {
    return ::CreateFileA(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                         CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
}

void write_raw(const char* p, size_t n) {
    if (g_file == INVALID_HANDLE_VALUE || !n) return;
    DWORD w = 0;
    if (!::WriteFile(g_file, p, static_cast<DWORD>(n), &w, nullptr)) ++g_lines_dropped;
    g_bytes += w;
}

void header(const char* what) {
    SYSTEMTIME t;
    ::GetLocalTime(&t);
    char line[256];
    const int n = std::snprintf(line, sizeof line,
                                "=== engine console (Com_PrintMessage tap), pid %lu, %s %04u-%02u-%02u "
                                "%02u:%02u:%02u ===\r\n",
                                static_cast<unsigned long>(::GetCurrentProcessId()), what, t.wYear, t.wMonth,
                                t.wDay, t.wHour, t.wMinute, t.wSecond);
    if (n > 0) write_raw(line, static_cast<size_t>(n));
}

// Under g_mu.
void rotate_if_big() {
    if (g_bytes < console_fmt::kRotateBytes) return;
    ::CloseHandle(g_file);
    ::MoveFileExA(g_path.c_str(), g_old_path.c_str(), MOVEFILE_REPLACE_EXISTING);
    g_file = open_fresh(g_path);
    g_bytes = 0;
    header("continued (the earlier part is console-<pid>.old.log)");
}

void __cdecl print_message_detour(int channel, const char* msg, int type) {
    if (msg) {
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_file != INVALID_HANDLE_VALUE) {
            SYSTEMTIME t;
            ::GetLocalTime(&t);
            const console_fmt::clock_hms now{t.wHour, t.wMinute, t.wSecond, t.wMilliseconds};
            g_buf.clear();
            std::string summary;
            const bool keep = g_repeat.admit(msg, ::GetTickCount64(), summary);
            if (!summary.empty()) {
                if (!g_stamp.at_line_start()) g_stamp.feed("\n", now, g_buf);
                g_stamp.feed(summary.c_str(), now, g_buf);
            }
            if (keep) g_stamp.feed(msg, now, g_buf);
            // CRLF so Notepad shows lines; the engine prints bare \n.
            std::string out;
            out.reserve(g_buf.size() + 8);
            for (char c : g_buf) {
                if (c == '\n') out += '\r';
                out += c;
            }
            write_raw(out.data(), out.size());
            rotate_if_big();
        }
    }
    g_hook.original<print_message_t>()(channel, msg, type);
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

class console_tap_component final : public component {
public:
    const char* name() const override { return "console_tap"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        const char* v = std::getenv("ENW_CONSOLE_TAP");
        if (v && v[0] == '0' && !v[1]) {
            ENW_INFO("console_tap: OFF (ENW_CONSOLE_TAP=0)");
            return;
        }
        if (std::memcmp(reinterpret_cast<const void*>(kComPrintMessage), kSig, sizeof kSig) != 0) {
            ENW_WARN("console_tap: Com_PrintMessage at 0x%08X does not have the expected bytes; "
                     "no console-<pid>.log this session",
                     static_cast<unsigned>(kComPrintMessage));
            return;
        }
        const std::string dir = log_dir();
        char name[64];
        std::snprintf(name, sizeof name, "\\console-%lu.log", static_cast<unsigned long>(::GetCurrentProcessId()));
        g_path = dir + name;
        std::snprintf(name, sizeof name, "\\console-%lu.old.log", static_cast<unsigned long>(::GetCurrentProcessId()));
        g_old_path = dir + name;
        {
            std::lock_guard<std::mutex> lk(g_mu);
            g_file = open_fresh(g_path);
            if (g_file == INVALID_HANDLE_VALUE) {
                ENW_WARN("console_tap: could not create %s (error %lu)", g_path.c_str(), ::GetLastError());
                return;
            }
            header("opened");
        }
        if (!g_hook.create(reinterpret_cast<void*>(kComPrintMessage),
                           reinterpret_cast<void*>(&print_message_detour), "Com_PrintMessage")) {
            std::lock_guard<std::mutex> lk(g_mu);
            ::CloseHandle(g_file);
            g_file = INVALID_HANDLE_VALUE;
            ::DeleteFileA(g_path.c_str());
            ENW_WARN("console_tap: could not hook Com_PrintMessage; no console-<pid>.log this session");
            return;
        }
        ENW_INFO("console_tap: every engine console line goes to %s (always; independent of `logfile`, "
                 "which changes the script VM). Rotates at %llu MB to console-<pid>.old.log. Off: "
                 "ENW_CONSOLE_TAP=0.",
                 g_path.c_str(), console_fmt::kRotateBytes >> 20);
    }

    void pre_destroy() override {
        g_hook.disable();
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_file != INVALID_HANDLE_VALUE) {
            if (g_lines_dropped) {
                char line[96];
                const int n = std::snprintf(line, sizeof line, "=== %lu write(s) failed ===\r\n", g_lines_dropped);
                if (n > 0) write_raw(line, static_cast<size_t>(n));
            }
            header("closed");
            ::CloseHandle(g_file);
            g_file = INVALID_HANDLE_VALUE;
        }
    }
};

ENW_REGISTER_COMPONENT(console_tap_component)

}  // namespace
}  // namespace enw::client::console_tap
