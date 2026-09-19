#include "logger.hpp"

#include "game.hpp"
#include "scheduler.hpp"

#include <cstdarg>
#include <mutex>

namespace enw::log {
namespace {

std::mutex g_mutex;
FILE* g_file = nullptr;
std::string g_path;
bool g_to_game_console = false;
bool g_inited = false;

// Stops the console mirror re-entering itself when console_print reports a failure.
thread_local bool tl_mirroring = false;

const char* tag(level lv) {
    switch (lv) {
        case level::trace: return "TRACE";
        case level::debug: return "DEBUG";
        case level::info:  return "INFO ";
        case level::warn:  return "WARN ";
        case level::error: return "ERROR";
    }
    return "?????";
}

std::string this_dll_dir() {
    HMODULE self = nullptr;
    ::GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         reinterpret_cast<LPCSTR>(&this_dll_dir), &self);
    char buf[MAX_PATH]{};
    ::GetModuleFileNameA(self, buf, MAX_PATH);
    std::string p(buf);
    const auto slash = p.find_last_of("\\/");
    return slash == std::string::npos ? std::string(".") : p.substr(0, slash);
}

std::string env(const char* name) {
    char buf[1024]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}

}  // namespace

void init() {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (g_inited) return;
    g_inited = true;

    // ENW_LOGDIR is set by tools\dev\launch.ps1; fall back to next to the DLL so a
    // hand-launched game still leaves evidence.
    std::string dir = env("ENW_LOGDIR");
    if (dir.empty()) dir = this_dll_dir();
    ::CreateDirectoryA(dir.c_str(), nullptr);

    char name[MAX_PATH]{};
    _snprintf_s(name, sizeof(name), _TRUNCATE, "%s\\enw-%lu.log", dir.c_str(),
                static_cast<unsigned long>(::GetCurrentProcessId()));
    g_path = name;

    if (fopen_s(&g_file, name, "w") != 0) g_file = nullptr;

    SYSTEMTIME st{};
    ::GetLocalTime(&st);
    if (g_file) {
        fprintf(g_file,
                "=== enw_t4 log opened %04u-%02u-%02u %02u:%02u:%02u  pid=%lu ===\n",
                st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond,
                static_cast<unsigned long>(::GetCurrentProcessId()));
        fflush(g_file);
    }
}

void shutdown() {
    std::lock_guard<std::mutex> lk(g_mutex);
    if (g_file) {
        fputs("=== enw_t4 log closed ===\n", g_file);
        fclose(g_file);
        g_file = nullptr;
    }
    g_inited = false;
}

void enable_game_console(bool on) {
    std::lock_guard<std::mutex> lk(g_mutex);
    g_to_game_console = on;
}

const std::string& file_path() { return g_path; }

void write(level lv, const char* fmt, ...) {
    char body[2048];
    va_list args;
    va_start(args, fmt);
    const int n = _vsnprintf_s(body, sizeof(body), _TRUNCATE, fmt, args);
    va_end(args);
    if (n < 0) body[sizeof(body) - 1] = '\0';

    SYSTEMTIME st{};
    ::GetLocalTime(&st);

    char line[2176];
    _snprintf_s(line, sizeof(line), _TRUNCATE, "[%02u:%02u:%02u.%03u] [%s] %s\n",
                st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, tag(lv), body);

    bool mirror = false;
    {
        std::lock_guard<std::mutex> lk(g_mutex);
        if (g_file) {
            fputs(line, g_file);
            fflush(g_file);  // a crash must not eat the last line -- that is the line we want
        }
        mirror = g_to_game_console;
    }
    ::OutputDebugStringA(line);

    // MIRRORING HAPPENS OUTSIDE THE LOCK, ON PURPOSE.
    // console_print can fail and log about it. Doing that while still holding
    // g_mutex deadlocks instantly (std::mutex is not recursive) and the symptom
    // is the game hanging with no last log line -- which is exactly how it
    // presented the first time. tl_mirroring stops the same path recursing.
    if (mirror && !tl_mirroring) {
        tl_mirroring = true;
        // Com_Printf works off-thread, but output from the moments right after
        // engine start is only kept when it comes from the game thread, so hand
        // it over when we can. Keep our text out of the format string.
        if (scheduler::on_main_thread()) {
            game::console_print("[enw] %s\n", body);
        } else {
            std::string copy(body);
            scheduler::run_on_main(
                [copy]() { game::console_print("[enw] %s\n", copy.c_str()); });
        }
        tl_mirroring = false;
    }
}

}  // namespace enw::log
