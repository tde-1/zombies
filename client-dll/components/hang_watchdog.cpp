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
//   1. suspends the main thread just long enough to read its stack and logs each
//      return address -- raw VA when it is in the exe's image (read it against
//      docs/re/t4-sp-map.md), module+offset otherwise;
//   2. reads the engine's RENDER LOCK (below) and, when another thread holds it, logs
//      that thread's stack too -- that is the thread the main thread is waiting for;
//   3. lists every thread's instruction pointer (module+offset), one line;
//   4. writes a minidump to <ENW_LOGDIR or %LOCALAPPDATA%\ENWZombies\logs>\
//      hang-<pid>-<yyyymmdd-hhmmss>.dmp, excluding any thread whose context cannot be
//      read and carrying on past unreadable memory (see write_dump).
// Once per session. Off: ENW_HANG_WATCHDOG=0.
//
// 2026-09-23, lane CL (B's zombie_town hang, enw-32100.log, client.md §13): the main
// thread's stack ended in 0x70E340 -> EnterCriticalSection(0x2298EA0), called from
// 0x479370 (the screen update, Com_Frame body +0x2D0). That is the engine's recursive
// render lock: 0x70E340 takes CS 0x2298EA0 and records the owner's thread id at
// [0x46E56A0] (count [0x46E569C]); 0x70E3A0 releases it. In a WER dump of a healthy
// frame (CoDWaW.exe.23916.dmp) the owner is the RENDER thread (the one inside
// IDirect3DSwapChain9::Present). So a main thread parked there is waiting for the render
// thread -- which the old watchdog never looked at, and its dump failed (0x8007001F), so
// the one hang B has had on this build named nothing but the waiter.
//
// Nothing here takes the loader lock (a hang can be a loader-lock deadlock): no
// GetModuleHandleEx / GetModuleFileName / SymInitialize / StackWalk64 on the hot path.
// Module names come from VirtualQuery + GetMappedFileNameA (system calls), and stacks are
// read by scanning for call-preceded return addresses under SEH.
#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "session_record.hpp"

#include <windows.h>
#include <dbghelp.h>
#include <psapi.h>
#include <tlhelp32.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "psapi.lib")

namespace enw::client {
namespace {

constexpr uintptr_t kClcState = 0x305842C;
constexpr DWORD kHangMs = 8000;

// The engine's render lock (0x70E340 acquire / 0x70E3A0 release), see the header.
constexpr uintptr_t kRenderLockCs = 0x2298EA0;     // CRITICAL_SECTION
constexpr uintptr_t kRenderLockOwner = 0x46E56A0;  // owner thread id (0 = free)
constexpr uintptr_t kRenderLockCount = 0x46E569C;  // recursion count

std::atomic<ULONGLONG> g_last_tick{0};
std::atomic<DWORD> g_main_tid{0};
std::atomic<bool> g_stop{false};
std::thread g_thread;
bool g_fired = false;
uintptr_t g_exe_base = 0;

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

bool read_u32(uintptr_t a, uint32_t& out) {
    __try {
        out = *reinterpret_cast<const volatile uint32_t*>(a);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

bool read_bytes(uintptr_t a, uint8_t* out, size_t n) {
    __try {
        for (size_t i = 0; i < n; ++i) out[i] = reinterpret_cast<const volatile uint8_t*>(a)[i];
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

// The image `addr` is in: its base and file name, without the loader lock.
bool image_of(uintptr_t addr, uintptr_t& base, char (&name)[64]) {
    MEMORY_BASIC_INFORMATION mbi{};
    if (!::VirtualQuery(reinterpret_cast<const void*>(addr), &mbi, sizeof mbi) || mbi.Type != MEM_IMAGE ||
        !mbi.AllocationBase)
        return false;
    base = reinterpret_cast<uintptr_t>(mbi.AllocationBase);
    char path[MAX_PATH] = {};
    name[0] = '?';
    name[1] = 0;
    if (::GetMappedFileNameA(::GetCurrentProcess(), mbi.AllocationBase, path, MAX_PATH)) {
        const char* b = std::strrchr(path, '\\');
        b = b ? b + 1 : path;
        std::snprintf(name, sizeof name, "%s", b);
    }
    return true;
}

bool is_executable(uintptr_t addr) {
    MEMORY_BASIC_INFORMATION mbi{};
    if (!::VirtualQuery(reinterpret_cast<const void*>(addr), &mbi, sizeof mbi)) return false;
    if (mbi.Type != MEM_IMAGE || mbi.State != MEM_COMMIT) return false;
    const DWORD p = mbi.Protect & 0xFF;
    return p == PAGE_EXECUTE || p == PAGE_EXECUTE_READ || p == PAGE_EXECUTE_READWRITE || p == PAGE_EXECUTE_WRITECOPY;
}

std::string describe(uintptr_t addr) {
    char out[128];
    uintptr_t base = 0;
    char name[64];
    if (!image_of(addr, base, name)) {
        std::snprintf(out, sizeof out, "0x%08X (no module)", static_cast<unsigned>(addr));
    } else if (base == g_exe_base) {
        std::snprintf(out, sizeof out, "0x%08X (CoDWaW.exe)", static_cast<unsigned>(addr));
    } else {
        // binkw32.dll+... is OUR DLL (loaded under the proxy's name); the real Bink is binkw32_org.dll.
        std::snprintf(out, sizeof out, "0x%08X (%s+0x%X)", static_cast<unsigned>(addr), name,
                      static_cast<unsigned>(addr - base));
    }
    return out;
}

// A dword on the stack is a return address when it points into executable image code
// right after a call instruction (e8 rel32; ff /2 in its register, [reg], [reg+d8],
// [reg+d32] and [disp32] forms).
bool is_return_address(uintptr_t v) {
    if (v < 0x10000 || !is_executable(v)) return false;
    uint8_t b[7] = {};
    if (!read_bytes(v - 7, b, sizeof b)) return false;
    if (b[2] == 0xE8) return true;                                           // call rel32
    if (b[5] == 0xFF && (b[6] & 0xF8) == 0xD0) return true;                  // call reg
    if (b[5] == 0xFF && (b[6] & 0xC7) == 0x10 && (b[6] & 7) != 4 && (b[6] & 7) != 5) return true;  // call [reg]
    if (b[4] == 0xFF && (b[5] & 0xC7) == 0x50) return true;                  // call [reg+d8]
    if (b[4] == 0xFF && b[5] == 0x54) return true;                           // call [sib+d8]
    if (b[1] == 0xFF && (b[2] & 0xC7) == 0x90) return true;                  // call [reg+d32]
    if (b[1] == 0xFF && b[2] == 0x15) return true;                           // call [disp32]
    if (b[0] == 0xFF && b[1] == 0x94) return true;                           // call [sib+d32]
    return false;
}

struct thread_view {
    DWORD tid = 0;
    bool ok = false;     // context read
    uintptr_t eip = 0;
    // eip first, then return addresses found on the stack. A fixed array: nothing may
    // allocate while another thread is suspended (it may hold the heap lock).
    uintptr_t frames[32] = {};
    size_t n = 0;
};

// Suspend, read the context and scan up to 16 KB of stack, resume. The scan runs while
// the thread is suspended so the stack is coherent; it touches only memory (SEH-guarded)
// and VirtualQuery, so it cannot deadlock against the suspended thread.
thread_view look_at(DWORD tid, size_t max_frames) {
    thread_view v;
    if (max_frames > 32) max_frames = 32;
    v.tid = tid;
    HANDLE t = ::OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, tid);
    if (!t) return v;
    if (::SuspendThread(t) == static_cast<DWORD>(-1)) {
        ::CloseHandle(t);
        return v;
    }
    CONTEXT ctx{};
    ctx.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
    if (::GetThreadContext(t, &ctx)) {
        v.ok = true;
        v.eip = ctx.Eip;
        v.frames[v.n++] = ctx.Eip;
        MEMORY_BASIC_INFORMATION mbi{};
        uintptr_t end = ctx.Esp + 0x4000;
        if (::VirtualQuery(reinterpret_cast<const void*>(ctx.Esp), &mbi, sizeof mbi)) {
            const uintptr_t region_end = reinterpret_cast<uintptr_t>(mbi.BaseAddress) + mbi.RegionSize;
            if (region_end < end) end = region_end;
        }
        for (uintptr_t p = ctx.Esp; p + 4 <= end && v.n < max_frames; p += 4) {
            uint32_t val = 0;
            if (!read_u32(p, val)) break;
            if (is_return_address(val)) v.frames[v.n++] = val;
        }
    }
    ::ResumeThread(t);
    ::CloseHandle(t);
    return v;
}

std::string frames_text(const thread_view& v) {
    std::string s;
    for (size_t i = 0; i < v.n; ++i) s += "\n    #" + std::to_string(i) + " " + describe(v.frames[i]);
    return s;
}

// Our own threads. NtGetNextThread first: it walks this process's threads by handle and
// needs no snapshot -- in the zombie_town hang CreateToolhelp32Snapshot failed along with
// MiniDumpWriteDump (0x80070008). Toolhelp is the fallback.
using next_thread_t = LONG(NTAPI*)(HANDLE, HANDLE, ACCESS_MASK, ULONG, ULONG, PHANDLE);
next_thread_t g_next_thread = nullptr;  // resolved at post_init (GetModuleHandle takes the loader lock)

std::vector<DWORD> threads_of_this_process() {
    std::vector<DWORD> out;
    if (const auto next = g_next_thread) {
        HANDLE cur = nullptr;
        for (int guard = 0; guard < 1024; ++guard) {
            HANDLE nh = nullptr;
            if (next(::GetCurrentProcess(), cur, THREAD_QUERY_LIMITED_INFORMATION, 0, 0, &nh) < 0 || !nh) break;
            if (cur) ::CloseHandle(cur);
            cur = nh;
            if (const DWORD tid = ::GetThreadId(nh)) out.push_back(tid);
        }
        if (cur) ::CloseHandle(cur);
        if (!out.empty()) return out;
    }
    const DWORD pid = ::GetCurrentProcessId();
    HANDLE snap = ::CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) {
        ENW_WARN("hang_watchdog: no thread list (NtGetNextThread and Toolhelp both failed, %lu)", ::GetLastError());
        return out;
    }
    THREADENTRY32 te{};
    te.dwSize = sizeof te;
    if (::Thread32First(snap, &te)) {
        do {
            if (te.th32OwnerProcessID == pid) out.push_back(te.th32ThreadID);
            te.dwSize = sizeof te;
        } while (::Thread32Next(snap, &te));
    }
    ::CloseHandle(snap);
    return out;
}

struct render_lock_state {
    uint32_t owner_tid = 0, count = 0, cs_owner = 0;
    int32_t cs_lock_count = 0, cs_recursion = 0;
    bool read = false;
};

render_lock_state read_render_lock() {
    render_lock_state s;
    uint32_t lc = 0, rec = 0;
    s.read = read_u32(kRenderLockOwner, s.owner_tid) && read_u32(kRenderLockCount, s.count) &&
             read_u32(kRenderLockCs + 4, lc) && read_u32(kRenderLockCs + 8, rec) &&
             read_u32(kRenderLockCs + 12, s.cs_owner);
    s.cs_lock_count = static_cast<int32_t>(lc);
    s.cs_recursion = static_cast<int32_t>(rec);
    return s;
}

// What the hang was, in one line, for session-<pid>.json and the telemetry summary.
std::string g_where;

void report(DWORD main_tid, std::vector<DWORD>& unreadable) {
    const DWORD self = ::GetCurrentThreadId();
    const thread_view main = look_at(main_tid, 20);
    ENW_ERROR("hang_watchdog: the MAIN THREAD (tid %lu) has not ticked for %lu ms in a map. Its stack "
              "(eip, then return addresses found on the stack, innermost first):%s",
              main_tid, kHangMs, main.ok ? frames_text(main).c_str() : " <context unreadable>");

    const render_lock_state rl = read_render_lock();
    // RTL_CRITICAL_SECTION.LockCount: -1 free; otherwise -1 - (waiters << 2) - (bit0 clear = held).
    const int waiters = rl.cs_lock_count < -1 ? ((-1 - rl.cs_lock_count) >> 2) : 0;
    const DWORD holder = rl.cs_owner ? rl.cs_owner : rl.owner_tid;
    if (!rl.read) {
        ENW_WARN("hang_watchdog: could not read the render lock (0x%08X)", static_cast<unsigned>(kRenderLockCs));
    } else if (!holder) {
        ENW_ERROR("hang_watchdog: the render lock (CS 0x%08X, 0x70E340) is FREE -- the main thread is not waiting "
                  "for the render thread", static_cast<unsigned>(kRenderLockCs));
        g_where = "main thread stuck; render lock free; main at " + (main.ok ? describe(main.eip) : std::string("?"));
    } else {
        const thread_view h = look_at(holder, 24);
        ENW_ERROR("hang_watchdog: the render lock (CS 0x%08X, taken by 0x70E340) is HELD by tid %lu (engine owner "
                  "field %lu, count %lu, recursion %d, %d thread(s) waiting)%s. Its stack:%s",
                  static_cast<unsigned>(kRenderLockCs), holder, static_cast<unsigned long>(rl.owner_tid),
                  static_cast<unsigned long>(rl.count), rl.cs_recursion, waiters,
                  holder == main_tid ? " -- the MAIN thread itself" : " -- the thread the main thread waits for",
                  h.ok ? frames_text(h).c_str() : " <context unreadable>");
        // The first frame outside ntdll/kernelbase/kernel32 names where the holder is parked.
        std::string at = "?";
        for (size_t i = 0; i < h.n; ++i) {
            const std::string d = describe(h.frames[i]);
            if (d.find("ntdll") == std::string::npos && d.find("KERNELBASE") == std::string::npos &&
                d.find("kernelbase") == std::string::npos && d.find("KERNEL32") == std::string::npos &&
                d.find("kernel32") == std::string::npos) {
                at = d;
                break;
            }
        }
        g_where = "main waits on the render lock; holder tid " + std::to_string(holder) + " at " + at;
    }

    // Every thread, one line: where each one is right now.
    std::string all;
    for (DWORD tid : threads_of_this_process()) {
        if (tid == self) continue;
        const thread_view v = look_at(tid, 1);
        if (!v.ok) {
            unreadable.push_back(tid);
            all += "\n    tid " + std::to_string(tid) + " <context unreadable>";
            continue;
        }
        all += "\n    tid " + std::to_string(tid) + (tid == main_tid ? " (main) " : tid == holder ? " (render lock) " : " ") +
               describe(v.eip);
    }
    ENW_ERROR("hang_watchdog: every thread's instruction pointer:%s", all.c_str());
}

// MiniDumpWriteDump on our own process failed in B's hang (0x8007001F) and in the Discord
// crash (0x8007001F, WER held the faulting thread). Two things make it fail: a thread
// whose context cannot be read, and memory that cannot be read (GPU-mapped regions that
// MiniDumpWithIndirectlyReferencedMemory follows pointers into). So: threads we could not
// read above are left out, a read failure is skipped instead of fatal, and if the full
// dump still fails a plain one (stacks + thread info) is tried.
std::vector<DWORD>* g_exclude = nullptr;

BOOL CALLBACK dump_callback(PVOID, PMINIDUMP_CALLBACK_INPUT in, PMINIDUMP_CALLBACK_OUTPUT out) {
    if (!in || !out) return TRUE;
    switch (in->CallbackType) {
        case IncludeThreadCallback:
            if (g_exclude)
                for (DWORD t : *g_exclude)
                    if (t == in->IncludeThread.ThreadId) return FALSE;
            return TRUE;
        case ReadMemoryFailureCallback:
            out->Status = S_OK;  // skip the unreadable range, keep going
            return TRUE;
        case CancelCallback:
            out->Cancel = FALSE;
            out->CheckCancel = FALSE;
            return TRUE;
        default:
            return TRUE;
    }
}

void write_dump(std::vector<DWORD>& unreadable) {
    SYSTEMTIME st;
    ::GetLocalTime(&st);
    char name[64];
    std::snprintf(name, sizeof name, "\\hang-%lu-%04d%02d%02d-%02d%02d%02d.dmp", ::GetCurrentProcessId(), st.wYear,
                  st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    const std::string path = log_dir() + name;
    HANDLE f = ::CreateFileA(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) {
        const DWORD e = ::GetLastError();
        session_record::write_hang(nullptr, g_where.c_str());
        ENW_ERROR("hang_watchdog: cannot create %s (%lu)", path.c_str(), e);
        return;
    }
    g_exclude = &unreadable;
    MINIDUMP_CALLBACK_INFORMATION cb{};
    cb.CallbackRoutine = dump_callback;
    const MINIDUMP_TYPE kinds[2] = {
        static_cast<MINIDUMP_TYPE>(MiniDumpWithIndirectlyReferencedMemory | MiniDumpWithThreadInfo),
        static_cast<MINIDUMP_TYPE>(MiniDumpNormal | MiniDumpWithThreadInfo),
    };
    BOOL ok = FALSE;
    DWORD errs[2] = {0, 0};
    int used = -1;
    for (int i = 0; i < 2 && !ok; ++i) {
        ::SetFilePointer(f, 0, nullptr, FILE_BEGIN);
        ::SetEndOfFile(f);
        ok = ::MiniDumpWriteDump(::GetCurrentProcess(), ::GetCurrentProcessId(), f, kinds[i], nullptr, nullptr, &cb);
        if (ok) used = i;
        else errs[i] = ::GetLastError();
    }
    g_exclude = nullptr;
    ::CloseHandle(f);
    if (!ok) ::DeleteFileA(path.c_str());  // an empty .dmp only confuses a reader
    session_record::write_hang(ok ? path.c_str() : nullptr, g_where.c_str());  // session-<pid>.json: exit 'hang'
    if (ok)
        ENW_ERROR("hang_watchdog: wrote %s (%s%s; %zu unreadable thread(s) left out)", path.c_str(),
                  used == 0 ? "full" : "plain", used == 1 ? ", the full dump failed" : "", unreadable.size());
    else
        ENW_ERROR("hang_watchdog: MiniDumpWriteDump failed (full 0x%08lX, plain 0x%08lX)", errs[0], errs[1]);
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
        std::vector<DWORD> unreadable;
        report(tid, unreadable);
        write_dump(unreadable);
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
        g_exe_base = reinterpret_cast<uintptr_t>(::GetModuleHandleA(nullptr));
        g_next_thread = reinterpret_cast<next_thread_t>(::GetProcAddress(::GetModuleHandleA("ntdll.dll"), "NtGetNextThread"));
        // ENW_HANG_TEST=1 (harness only): 20 s into a map the main thread sleeps 12 s
        // once, so the watchdog can be seen to fire. ENW_HANG_TEST=2: the same, but a
        // second thread holds the RENDER LOCK (0x70E340) for 12 s and the main thread
        // runs into it at its next screen update -- the shape of B's zombie_town hang,
        // so the lock-holder report can be seen to name the right thread.
        static const int test = [] { const char* t = std::getenv("ENW_HANG_TEST"); return t ? std::atoi(t) : 0; }();
        frame::subscribe("hang_watchdog", [](uint64_t) {
            g_main_tid = ::GetCurrentThreadId();
            g_last_tick = ::GetTickCount64();
            static ULONGLONG in_map_since = 0;
            static bool slept = false;
            if (test && !slept && *reinterpret_cast<const volatile int*>(kClcState) >= 9) {
                if (!in_map_since) in_map_since = ::GetTickCount64();
                if (::GetTickCount64() - in_map_since > 20000) {
                    slept = true;
                    if (test == 2) {
                        ENW_WARN("hang_watchdog: ENW_HANG_TEST=2 -- a test thread takes the render lock for 12 s");
                        std::thread([] {
                            reinterpret_cast<int(__cdecl*)()>(0x70E340)();
                            ::Sleep(12000);
                            reinterpret_cast<int(__cdecl*)()>(0x70E3A0)();
                        }).detach();
                        ::Sleep(200);  // let it take the lock before this frame's screen update
                    } else {
                        ENW_WARN("hang_watchdog: ENW_HANG_TEST -- the main thread now sleeps 12 s");
                        ::Sleep(12000);
                    }
                }
            }
        });
        g_thread = std::thread(watch);
        ENW_INFO("hang_watchdog: armed -- a main thread silent for %lu ms in a map gets its stack, the render "
                 "lock's holder and every thread logged, and a minidump in %s (once). Off: ENW_HANG_WATCHDOG=0.",
                 kHangMs, log_dir().c_str());
    }
    void pre_destroy() override {
        g_stop = true;
        if (g_thread.joinable()) g_thread.join();
    }
};

ENW_REGISTER_COMPONENT(hang_watchdog)

}  // namespace
}  // namespace enw::client
