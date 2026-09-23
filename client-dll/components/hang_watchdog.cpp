// hang_watchdog: when the game's main thread stops ticking in a map, write down
// where it is stuck, before Windows closes the "not responding" window.
//
// Why (2026-09-23): B's 0.2.18 client hung ~200 ms after its first in-game frame on
// zm_nuked (enw-34580.log; Windows Event 1002 "stopped interacting with Windows").
// Windows keeps no dump (no LocalDumps, an HKLM setting we do not touch), and the
// last log line says only what ran before, not what is blocked. This makes the
// next hang name its culprit.
//
// How: a low-priority thread checks once a second when the shared frame tick last
// ran (frame::subscribe -- ours, not a Com_Frame hook). If it has not ticked for
// 8 s while the client is in a map (clc.state >= 9, [0x305842C]), it:
//   1. suspends the main thread just long enough to walk its stack (StackWalk64,
//      16 frames) and logs each return address -- raw VA when it is in the exe's
//      image (read it against docs/re/t4-sp-map.md), module+offset otherwise;
//   2. resumes it (the watchdog observes; it never tries to "fix" the game);
//   3. writes a minidump (MiniDumpWithIndirectlyReferencedMemory |
//      MiniDumpWithThreadInfo) to <ENW_LOGDIR or %LOCALAPPDATA%\ENWZombies\logs>\
//      hang-<pid>-<yyyymmdd-hhmmss>.dmp.
// Once per session. Off: ENW_HANG_WATCHDOG=0.
#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"

#include <windows.h>
#include <dbghelp.h>
#include <psapi.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

#pragma comment(lib, "dbghelp.lib")

namespace enw::client {
namespace {

constexpr uintptr_t kClcState = 0x305842C;
constexpr DWORD kHangMs = 8000;

std::atomic<ULONGLONG> g_last_tick{0};
std::atomic<DWORD> g_main_tid{0};
std::atomic<bool> g_stop{false};
std::thread g_thread;
bool g_fired = false;

std::string log_dir() {
    char buf[MAX_PATH] = {};
    DWORD n = ::GetEnvironmentVariableA("ENW_LOGDIR", buf, MAX_PATH);
    if (n && n < MAX_PATH) return std::string(buf, n);
    n = ::GetEnvironmentVariableA("LOCALAPPDATA", buf, MAX_PATH);
    std::string d = (n && n < MAX_PATH) ? std::string(buf, n) : std::string(".");
    d += "\\ENWZombies\\logs";
    ::CreateDirectoryA((d.substr(0, d.rfind('\\'))).c_str(), nullptr);
    ::CreateDirectoryA(d.c_str(), nullptr);
    return d;
}

std::string describe(DWORD64 addr) {
    char out[MAX_PATH + 64];
    HMODULE mod = nullptr;
    if (::GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                             reinterpret_cast<LPCSTR>(static_cast<uintptr_t>(addr)), &mod) && mod) {
        char name[MAX_PATH] = {};
        ::GetModuleFileNameA(mod, name, MAX_PATH);
        const char* base = std::strrchr(name, '\\');
        base = base ? base + 1 : name;
        if (mod == ::GetModuleHandleA(nullptr))
            std::snprintf(out, sizeof out, "0x%08llX (CoDWaW.exe)", addr);
        else
            std::snprintf(out, sizeof out, "0x%08llX (%s+0x%llX)", addr, base,
                          addr - reinterpret_cast<uintptr_t>(mod));
    } else {
        std::snprintf(out, sizeof out, "0x%08llX (no module)", addr);
    }
    return out;
}

void walk_main_thread(DWORD tid) {
    HANDLE t = ::OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, tid);
    if (!t) { ENW_ERROR("hang_watchdog: OpenThread(main %lu) failed (%lu)", tid, ::GetLastError()); return; }
    if (::SuspendThread(t) == static_cast<DWORD>(-1)) { ::CloseHandle(t); return; }
    CONTEXT ctx{};
    ctx.ContextFlags = CONTEXT_FULL;
    std::string frames;
    if (::GetThreadContext(t, &ctx)) {
        STACKFRAME64 sf{};
        sf.AddrPC.Offset = ctx.Eip; sf.AddrPC.Mode = AddrModeFlat;
        sf.AddrFrame.Offset = ctx.Ebp; sf.AddrFrame.Mode = AddrModeFlat;
        sf.AddrStack.Offset = ctx.Esp; sf.AddrStack.Mode = AddrModeFlat;
        HANDLE proc = ::GetCurrentProcess();
        static bool sym = false;
        if (!sym) { ::SymInitialize(proc, nullptr, TRUE); sym = true; }
        for (int i = 0; i < 16; ++i) {
            if (!::StackWalk64(IMAGE_FILE_MACHINE_I386, proc, t, &sf, &ctx, nullptr, SymFunctionTableAccess64,
                               SymGetModuleBase64, nullptr) || !sf.AddrPC.Offset)
                break;
            frames += "\n    #" + std::to_string(i) + " " + describe(sf.AddrPC.Offset);
        }
    }
    ::ResumeThread(t);
    ::CloseHandle(t);
    ENW_ERROR("hang_watchdog: the MAIN THREAD (tid %lu) has not ticked for %lu ms in a map. Its stack "
              "(return addresses, innermost first):%s", tid, kHangMs, frames.empty() ? " <walk failed>" : frames.c_str());
}

void write_dump() {
    SYSTEMTIME st;
    ::GetLocalTime(&st);
    char name[64];
    std::snprintf(name, sizeof name, "\\hang-%lu-%04d%02d%02d-%02d%02d%02d.dmp", ::GetCurrentProcessId(), st.wYear,
                  st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    const std::string path = log_dir() + name;
    HANDLE f = ::CreateFileA(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) { ENW_ERROR("hang_watchdog: cannot create %s (%lu)", path.c_str(), ::GetLastError()); return; }
    const BOOL ok = ::MiniDumpWriteDump(::GetCurrentProcess(), ::GetCurrentProcessId(), f,
                                        static_cast<MINIDUMP_TYPE>(MiniDumpWithIndirectlyReferencedMemory |
                                                                   MiniDumpWithThreadInfo),
                                        nullptr, nullptr, nullptr);
    ::CloseHandle(f);
    if (ok) ENW_ERROR("hang_watchdog: wrote %s", path.c_str());
    else ENW_ERROR("hang_watchdog: MiniDumpWriteDump failed (%lu)", ::GetLastError());
}

void watch() {
    ::SetThreadPriority(::GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    while (!g_stop) {
        ::Sleep(1000);
        if (g_fired) continue;
        const ULONGLONG last = g_last_tick.load();
        const DWORD tid = g_main_tid.load();
        if (!last || !tid) continue;
        const int state = *reinterpret_cast<const volatile int*>(kClcState);
        if (state < 9) continue;
        if (::GetTickCount64() - last < kHangMs) continue;
        g_fired = true;
        walk_main_thread(tid);
        write_dump();
    }
}

class hang_watchdog final : public component {
public:
    const char* name() const override { return "hang_watchdog"; }
    bool is_supported() override {
        const char* cmd = ::GetCommandLineA();
        return !(cmd && std::strstr(cmd, "dedicated 1"));
    }
    void post_init() override {
        const char* v = std::getenv("ENW_HANG_WATCHDOG");
        if (v && v[0] == '0' && !v[1]) { ENW_INFO("hang_watchdog: OFF (ENW_HANG_WATCHDOG=0)"); return; }
        // ENW_HANG_TEST=1 (harness only): 20 s into a map the main thread sleeps 12 s
        // once, so the watchdog can be seen to fire.
        static const bool test = [] { const char* t = std::getenv("ENW_HANG_TEST"); return t && t[0] == '1'; }();
        frame::subscribe("hang_watchdog", [](uint64_t) {
            g_main_tid = ::GetCurrentThreadId();
            g_last_tick = ::GetTickCount64();
            static ULONGLONG in_map_since = 0;
            static bool slept = false;
            if (test && !slept && *reinterpret_cast<const volatile int*>(kClcState) >= 9) {
                if (!in_map_since) in_map_since = ::GetTickCount64();
                if (::GetTickCount64() - in_map_since > 20000) {
                    slept = true;
                    ENW_WARN("hang_watchdog: ENW_HANG_TEST -- the main thread now sleeps 12 s");
                    ::Sleep(12000);
                }
            }
        });
        g_thread = std::thread(watch);
        ENW_INFO("hang_watchdog: armed -- a main thread silent for %lu ms in a map gets its stack logged and a "
                 "minidump in %s (once). Off: ENW_HANG_WATCHDOG=0.", kHangMs, log_dir().c_str());
    }
    void pre_destroy() override {
        g_stop = true;
        if (g_thread.joinable()) g_thread.join();
    }
};

ENW_REGISTER_COMPONENT(hang_watchdog)

}  // namespace
}  // namespace enw::client
