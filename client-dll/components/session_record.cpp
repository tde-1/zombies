// session_record: a small session-<pid>.json beside enw-<pid>.log, so the launcher can
// flag a session (crash / hang / error / quit) without parsing a 50 MB log.
//
// T1 "telemetry" (2026-09-23). The decision it works under: nothing new in the game's
// frame path, the DLL's logging stays as it is, only what is cheap. So this component
// has NO frame subscriber and NO hook. It keeps a few plain globals that other
// components fill in where the number is already computed, and writes the file at four
// moments that are already rare:
//   1. startup (post_load), once, exit "unknown" -- a hard kill still leaves this;
//   2. clean shutdown (pre_destroy, i.e. DLL_PROCESS_DETACH from ExitProcess: `quit`,
//      our Esc menu's Exit, the lockdown's quit, Alt+F4), exit "quit", or "error" when
//      the session ended on an engine error (menu_lockdown's end screen);
//   3. overlay_guard's unhandled-exception filter, first thing, exit "crash"
//      (write_crash: no heap, no CRT formatting, no locks, one CreateFileA/WriteFile/
//      CloseHandle from a static buffer);
//   4. hang_watchdog, after its minidump, exit "hang" with the dump's path.
// A record is only ever rewritten with an equal or worse exit (unknown < quit < error <
// hang < crash), and a crash record is never rewritten.
//
// Same directory as the logger's enw-<pid>.log (log::file_path(): ENW_LOGDIR, which the
// launcher sets to %LOCALAPPDATA%\ENWZombies\logs; else beside the DLL). Client only.
// Off: ENW_SESSION_RECORD=0.
#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "session_record.hpp"
#include "session_record_format.hpp"

#include <windows.h>

#include <cstdlib>
#include <cstring>
#include <string>

namespace enw::client::session_record {
namespace {

using session_fmt::exit_kind;

volatile LONG g_enabled = 0;
volatile LONG g_rank = 0;          // exit_kind as an int
volatile LONG g_crash_once = 0;
volatile LONG g_busy = 0;          // the non-crash writer's try-lock (never taken by the crash path)
volatile LONG g_largest_tenths = -1;
volatile LONG g_refused = 0;
volatile LONG g_error_end = 0;

// Fixed buffers; the last byte of each is never written, so a reader racing a writer is
// still bounded by a NUL.
char g_path[MAX_PATH];
char g_build[64];
char g_started[25];
char g_map[128];
char g_error[512];
char g_hang_dump[MAX_PATH];
char g_exe_name[64];
uintptr_t g_exe_base = 0;

char g_buf[16384];        // normal writes, under g_busy
char g_crash_buf[16384];  // the crash write only

void copy_bounded(char* dst, size_t cap, const char* src) {
    size_t i = 0;
    if (src)
        for (; i + 1 < cap && src[i]; ++i) dst[i] = src[i];
    dst[i] = 0;
}

void now_iso(char (&out)[25]) {
    SYSTEMTIME t;
    ::GetSystemTime(&t);
    session_fmt::iso_utc(t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, out);
}

session_fmt::fields base_fields(exit_kind exit, const char* ended_at) {
    session_fmt::fields f;
    f.pid = ::GetCurrentProcessId();
    f.build = g_build;
    f.started_at = g_started;
    f.ended_at = ended_at;
    f.exit = exit;
    f.last_error = g_error;
    f.last_map = g_map;
    f.frames = frame::count();
    f.largest_free_tenths_mb = g_largest_tenths;
    f.hang_dump = g_hang_dump;
    f.discord_hook_refused = static_cast<uint32_t>(g_refused);
    return f;
}

bool write_file(const char* buf, size_t n) {
    const HANDLE h = ::CreateFileA(g_path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                   nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD w = 0;
    const BOOL ok = ::WriteFile(h, buf, static_cast<DWORD>(n), &w, nullptr);
    ::CloseHandle(h);
    return ok && w == n;
}

// Raise the recorded exit to at least `want`; returns the exit to write, or unknown if a
// crash is already on disk (nothing may replace it).
exit_kind raise_to(exit_kind want) {
    for (;;) {
        const LONG cur = g_rank;
        if (cur == static_cast<LONG>(exit_kind::crash)) return exit_kind::unknown;
        const LONG next = cur > static_cast<LONG>(want) ? cur : static_cast<LONG>(want);
        if (::InterlockedCompareExchange(&g_rank, next, cur) == cur) return static_cast<exit_kind>(next);
    }
}

// Not the crash path: may wait briefly for another writer.
bool write_normal(exit_kind want, bool ended) {
    if (!g_enabled) return false;
    int spins = 0;
    while (::InterlockedCompareExchange(&g_busy, 1, 0) != 0) {
        if (++spins > 200) return false;
        ::Sleep(1);
    }
    bool ok = false;
    const exit_kind exit = want == exit_kind::unknown ? exit_kind::unknown : raise_to(want);
    if (want == exit_kind::unknown || exit != exit_kind::unknown) {
        char ended_at[25];
        if (ended) now_iso(ended_at);
        const auto f = base_fields(exit, ended ? ended_at : nullptr);
        const size_t n = session_fmt::format(f, g_buf, sizeof g_buf);
        ok = n && write_file(g_buf, n);
    }
    ::InterlockedExchange(&g_busy, 0);
    return ok;
}

// The export-directory name of the image `addr` is in, by reading its PE headers --
// VirtualQuery is a system call and the rest is memory reads, so no loader lock (which
// GetModuleHandleEx / GetModuleFileName take, and the crashing thread may hold).
bool image_of(uintptr_t addr, char (&name)[64], uint32_t& offset) {
    MEMORY_BASIC_INFORMATION mbi;
    if (!::VirtualQuery(reinterpret_cast<const void*>(addr), &mbi, sizeof mbi) || mbi.Type != MEM_IMAGE ||
        !mbi.AllocationBase)
        return false;
    const auto base = reinterpret_cast<uintptr_t>(mbi.AllocationBase);
    offset = static_cast<uint32_t>(addr - base);
    name[0] = '?';
    name[1] = 0;
    if (base == g_exe_base) {
        copy_bounded(name, sizeof name, g_exe_name);
        return true;
    }
    __try {
        const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
        if (dos->e_magic != IMAGE_DOS_SIGNATURE) return true;
        const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS32*>(base + dos->e_lfanew);
        if (nt->Signature != IMAGE_NT_SIGNATURE) return true;
        const auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
        if (!dir.VirtualAddress || !dir.Size) return true;
        const auto* ex = reinterpret_cast<const IMAGE_EXPORT_DIRECTORY*>(base + dir.VirtualAddress);
        if (!ex->Name) return true;
        const char* s = reinterpret_cast<const char*>(base + ex->Name);
        size_t i = 0;
        for (; i + 1 < sizeof name && s[i]; ++i) name[i] = s[i];
        name[i] = 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        name[0] = '?';
        name[1] = 0;
    }
    return true;
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

class session_record_component final : public component {
public:
    const char* name() const override { return "session_record"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_load() override {
        const char* v = std::getenv("ENW_SESSION_RECORD");
        if (v && v[0] == '0' && !v[1]) {
            ENW_INFO("session_record: OFF (ENW_SESSION_RECORD=0)");
            return;
        }
        std::string dir = log::file_path();
        const auto slash = dir.find_last_of("\\/");
        if (dir.empty() || slash == std::string::npos) {
            ENW_WARN("session_record: the logger has no file, so no session-<pid>.json this session");
            return;
        }
        dir.resize(slash);
        const std::string path = dir + "\\session-" + std::to_string(::GetCurrentProcessId()) + ".json";
        if (path.size() >= sizeof g_path) return;
        copy_bounded(g_path, sizeof g_path, path.c_str());
        copy_bounded(g_build, sizeof g_build, "enw_t4 " __DATE__ " " __TIME__);
        copy_bounded(g_map, sizeof g_map, std::getenv("ENW_CLIENT_CONNECT"));  // the launcher's join map
        now_iso(g_started);

        g_exe_base = reinterpret_cast<uintptr_t>(::GetModuleHandleW(nullptr));
        char exe[MAX_PATH] = {};
        ::GetModuleFileNameA(nullptr, exe, MAX_PATH);
        const char* b = std::strrchr(exe, '\\');
        copy_bounded(g_exe_name, sizeof g_exe_name, b ? b + 1 : exe);

        ::InterlockedExchange(&g_enabled, 1);
        const bool ok = write_normal(exit_kind::unknown, false);
        ENW_INFO("session_record: %s %s (exit 'unknown' until a quit, hang or crash rewrites it). Off: "
                 "ENW_SESSION_RECORD=0.",
                 ok ? "wrote" : "could NOT write", g_path);
    }

    void pre_destroy() override {
        if (!g_enabled) return;
        write_normal(g_error_end ? exit_kind::error : exit_kind::quit, true);
    }
};

ENW_REGISTER_COMPONENT(session_record_component)

}  // namespace

void note_largest_free(uint64_t bytes) {
    const uint64_t tenths = bytes * 10 / 1048576;
    ::InterlockedExchange(&g_largest_tenths, static_cast<LONG>(tenths > 0x7FFFFFFF ? 0x7FFFFFFF : tenths));
}

void note_discord_refused(long count) { ::InterlockedExchange(&g_refused, count); }

void note_error(const char* text) {
    if (!text || !*text) return;
    copy_bounded(g_error, sizeof g_error, text);
    ::InterlockedExchange(&g_error_end, session_fmt::is_error_end(text) ? 1 : 0);
}

void write_hang(const char* dump_path) {
    if (!g_enabled) return;
    copy_bounded(g_hang_dump, sizeof g_hang_dump, dump_path);
    write_normal(exit_kind::hang, true);
}

void write_crash(const _EXCEPTION_POINTERS* ep) {
    if (!g_enabled || ::InterlockedExchange(&g_crash_once, 1) != 0) return;
    ::InterlockedExchange(&g_rank, static_cast<LONG>(exit_kind::crash));
    session_fmt::exception_info ex;
    char mod[64] = {};
    if (ep && ep->ExceptionRecord) {
        ex.code = static_cast<uint32_t>(ep->ExceptionRecord->ExceptionCode);
        ex.address = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ep->ExceptionRecord->ExceptionAddress));
        uint32_t off = 0;
        if (image_of(ex.address, mod, off)) {
            ex.module = mod;
            ex.offset = off;
        }
    }
    char ended_at[25];
    now_iso(ended_at);
    auto f = base_fields(exit_kind::crash, ended_at);
    f.exception = &ex;
    const size_t n = session_fmt::format(f, g_crash_buf, sizeof g_crash_buf);
    if (n) write_file(g_crash_buf, n);
}

}  // namespace enw::client::session_record
