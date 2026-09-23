// overlay_guard: keep Discord's graphics hook out of the game, name every DLL that is
// injected later, and name the module when an exception goes unhandled.
//
// Why (2026-09-23 03:42, B, fear_mc_2 on the box, 0.2.20): the game died the moment he
// pressed Enter in the chat overlay. Enter was a coincidence. The evidence:
//   * Windows Event 1000: faulting module DiscordHook.dll +0x1F7FD, c0000005, 03:42:30;
//     B's own %LOCALAPPDATA%\CrashDumps\CoDWaW.exe.23916.dmp: thread 2240 (the render
//     thread, inside IDirect3DSwapChain9::Present) wrote to address 0x45 at
//     `lock cmpxchg [edx+45h]` with edx = [DiscordHook+0x1093D0] = NULL.
//   * %APPDATA%\discord\logs\discord_hook.log: Discord attached to pid 23916 at
//     03:42:29.378 ("process has been alive for 35980.7 ms"), "Activating graphics
//     capture with flags: 2", "Hooked D3D9" at 03:42:30.426 -- and nothing after. The
//     overlay line text arrived 70 ms before that.
//   * The same crash, same offset, in an agent copy that nobody typed into
//     (waw-nc pid 4000, 03:10:51, fear_mc_2): Discord attached at 03:10:48.6.
// Read out of DiscordHook.dll (Discord app-1.0.9259, hook 1342ee47cf7536): on
// "Activating graphics capture" it runs a once-init that creates a 52,428,872-byte
// (0x3200048) named mapping and maps ALL of it (CreateFileMappingA + MapViewOfFile);
// only on success does it store the object in that global. The capture mode word
// beside it is set either way, and the post-Present path it gates dereferences the
// global with no NULL check. CoDWaW.exe is a 32-bit process without
// LARGE_ADDRESS_AWARE (2 GB; LAA is not possible for this exe), and a big custom map
// leaves no 50 MB hole. So: Discord maps nothing, then faults on the next Present.
// Not ours to fix inside Discord; ours to prevent.
//
// What this does:
//   1. ntdll!LdrLoadDll is detoured; a load of DiscordHook.dll is refused with
//      STATUS_ACCESS_DENIED (Discord logs a failed attach and the game carries on,
//      without Discord's in-game overlay / Go Live game capture / Clips). Opt back in
//      with ENW_ALLOW_DISCORD_HOOK=1.
//   2. Every DLL that loads after the game has started is logged with how long after
//      process start it came and the largest free block of address space at that
//      moment (LdrRegisterDllNotification) -- Medal, RTSS, OBS, Steam's overlay and the
//      next Discord all show up in enw-<pid>.log with the number that decides whether
//      they fit.
//   3. An unhandled exception is logged with its module+offset before the engine's own
//      filter turns it into "Unhandled exception caught" with no address (what B's log
//      showed).
// Off: ENW_OVERLAY_GUARD=0 (all three). Client processes only.
#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "overlay_guard_rules.hpp"

#include <windows.h>
#include <winternl.h>

#include <MinHook.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace enw::client::overlay_guard {
namespace {

constexpr NTSTATUS kStatusAccessDenied = static_cast<NTSTATUS>(0xC0000022L);

using ldr_load_dll_t = NTSTATUS(NTAPI*)(PWSTR path, PULONG flags, PUNICODE_STRING name, PHANDLE handle);
ldr_load_dll_t g_real_ldr_load_dll = nullptr;
void* g_ldr_target = nullptr;

bool g_allow_discord = false;
std::atomic<long> g_refusals{0};
ULONGLONG g_process_start_ms = 0;
std::atomic<bool> g_game_started{false};

// Lines produced where logging is not safe (under the loader lock, or on an injector's
// thread inside LdrLoadDll): queued here and written from the main thread's frame tick.
std::mutex g_q_mu;
std::vector<std::string> g_queue;
std::atomic<bool> g_pending{false};

void enqueue(std::string s) {
    std::lock_guard<std::mutex> lk(g_q_mu);
    if (g_queue.size() < 256) g_queue.push_back(std::move(s));
    g_pending = true;
}

void drain() {
    if (!g_pending.exchange(false)) return;
    std::vector<std::string> q;
    {
        std::lock_guard<std::mutex> lk(g_q_mu);
        q.swap(g_queue);
    }
    for (auto& s : q) ENW_INFO("%s", s.c_str());
}

ULONGLONG since_start_ms() { return ::GetTickCount64() - g_process_start_ms; }

std::string narrow(const wchar_t* w, size_t n) {
    std::string s;
    s.reserve(n);
    for (size_t i = 0; i < n; ++i) s += (w[i] < 0x80) ? static_cast<char>(w[i]) : '?';
    return s;
}

NTSTATUS NTAPI ldr_load_dll_detour(PWSTR path, PULONG flags, PUNICODE_STRING name, PHANDLE handle) {
    if (!g_allow_discord && name && name->Buffer &&
        overlay_rule::refuse_module(name->Buffer, name->Length / sizeof(wchar_t))) {
        const long n = ++g_refusals;
        if (n <= 3) {
            const auto vm = overlay_rule::measure_free();
            char line[768];
            std::snprintf(line, sizeof line,
                          "overlay_guard: REFUSED '%s' (load #%ld, +%llu ms after process start, thread %lu). "
                          "Discord's graphics hook maps a 50 MB view and crashes the game on the next Present "
                          "when that fails (B, fear_mc_2, 2026-09-23 03:42). Largest free address block now "
                          "%.1f MB of %.1f MB free. ENW_ALLOW_DISCORD_HOOK=1 lets it in.",
                          narrow(name->Buffer, name->Length / sizeof(wchar_t)).c_str(), n, since_start_ms(),
                          ::GetCurrentThreadId(), vm.largest / 1048576.0, vm.total / 1048576.0);
            enqueue(line);
        }
        if (handle) *handle = nullptr;
        return kStatusAccessDenied;
    }
    return g_real_ldr_load_dll(path, flags, name, handle);
}

// --- LdrRegisterDllNotification (documented on MSDN, exported by ntdll) ---
struct dll_notification_data {
    ULONG flags;
    PCUNICODE_STRING full_name;
    PCUNICODE_STRING base_name;
    PVOID base;
    ULONG size;
};
using dll_notify_fn = VOID(CALLBACK*)(ULONG reason, const dll_notification_data* data, PVOID ctx);
using ldr_register_t = NTSTATUS(NTAPI*)(ULONG flags, dll_notify_fn fn, PVOID ctx, PVOID* cookie);
using ldr_unregister_t = NTSTATUS(NTAPI*)(PVOID cookie);
PVOID g_cookie = nullptr;

VOID CALLBACK on_dll(ULONG reason, const dll_notification_data* d, PVOID) {
    if (reason != 1 || !d || !d->full_name || !g_game_started) return;  // 1 = loaded
    const auto vm = overlay_rule::measure_free();
    char line[768];
    std::snprintf(line, sizeof line,
                  "overlay_guard: late DLL load +%llu ms: %s at 0x%p (%lu KB); largest free address block "
                  "now %.1f MB of %.1f MB free",
                  since_start_ms(), narrow(d->full_name->Buffer, d->full_name->Length / sizeof(wchar_t)).c_str(),
                  d->base, static_cast<unsigned long>(d->size / 1024), vm.largest / 1048576.0,
                  vm.total / 1048576.0);
    enqueue(line);
}

// --- unhandled exception: name the module before the engine's filter hides it ---
LPTOP_LEVEL_EXCEPTION_FILTER g_prev_filter = nullptr;

std::string describe(uintptr_t addr) {
    char out[MAX_PATH + 64];
    HMODULE mod = nullptr;
    if (::GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                             reinterpret_cast<LPCSTR>(addr), &mod) && mod) {
        char name[MAX_PATH] = {};
        ::GetModuleFileNameA(mod, name, MAX_PATH);
        const char* b = std::strrchr(name, '\\');
        b = b ? b + 1 : name;
        std::snprintf(out, sizeof out, "0x%08X (%s+0x%X)", static_cast<unsigned>(addr), b,
                      static_cast<unsigned>(addr - reinterpret_cast<uintptr_t>(mod)));
    } else {
        std::snprintf(out, sizeof out, "0x%08X (no module)", static_cast<unsigned>(addr));
    }
    return out;
}

LONG WINAPI on_unhandled(EXCEPTION_POINTERS* ep) {
    if (ep && ep->ExceptionRecord) {
        const auto* r = ep->ExceptionRecord;
        const auto vm = overlay_rule::measure_free();
        char extra[96] = "";
        if (r->ExceptionCode == EXCEPTION_ACCESS_VIOLATION && r->NumberParameters >= 2)
            std::snprintf(extra, sizeof extra, " (%s 0x%08X)",
                          r->ExceptionInformation[0] == 0 ? "read of" : r->ExceptionInformation[0] == 1 ? "write to" : "execute at",
                          static_cast<unsigned>(r->ExceptionInformation[1]));
        ENW_ERROR("overlay_guard: UNHANDLED EXCEPTION 0x%08lX%s at %s on thread %lu, +%llu ms; largest free "
                  "address block %.1f MB of %.1f MB free. The engine's filter runs next (\"Unhandled exception "
                  "caught\"); Windows keeps a dump in %%LOCALAPPDATA%%\\CrashDumps when LocalDumps is on.",
                  static_cast<unsigned long>(r->ExceptionCode), extra,
                  describe(reinterpret_cast<uintptr_t>(r->ExceptionAddress)).c_str(), ::GetCurrentThreadId(),
                  since_start_ms(), vm.largest / 1048576.0, vm.total / 1048576.0);
    }
    return g_prev_filter ? g_prev_filter(ep) : EXCEPTION_CONTINUE_SEARCH;
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

bool env_off(const char* n) {
    const char* v = std::getenv(n);
    return v && v[0] == '0' && !v[1];
}

class overlay_guard_component final : public component {
public:
    const char* name() const override { return "overlay_guard"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_load() override {
        if (env_off("ENW_OVERLAY_GUARD")) return;
        FILETIME c{}, e{}, k{}, u{};
        ULONGLONG now = ::GetTickCount64();
        g_process_start_ms = now;
        if (::GetProcessTimes(::GetCurrentProcess(), &c, &e, &k, &u)) {
            FILETIME nowft{};
            ::GetSystemTimeAsFileTime(&nowft);
            const ULONGLONG a = (static_cast<ULONGLONG>(c.dwHighDateTime) << 32) | c.dwLowDateTime;
            const ULONGLONG b = (static_cast<ULONGLONG>(nowft.dwHighDateTime) << 32) | nowft.dwLowDateTime;
            if (b > a) g_process_start_ms = now - (b - a) / 10000;
        }
    }

    void post_unpack() override {
        if (env_off("ENW_OVERLAY_GUARD")) {
            ENW_INFO("overlay_guard: OFF (ENW_OVERLAY_GUARD=0)");
            return;
        }
        g_allow_discord = overlay_rule::allow_from_env(std::getenv("ENW_ALLOW_DISCORD_HOOK"));
        if (g_allow_discord) {
            ENW_INFO("overlay_guard: DiscordHook.dll allowed (ENW_ALLOW_DISCORD_HOOK=1)");
        } else if (HMODULE nt = ::GetModuleHandleW(L"ntdll.dll")) {
            g_ldr_target = reinterpret_cast<void*>(::GetProcAddress(nt, "LdrLoadDll"));
            MH_STATUS s = MH_ERROR_NOT_EXECUTABLE;
            if (g_ldr_target) {
                MH_Initialize();  // idempotent next to hooks::init()
                s = MH_CreateHook(g_ldr_target, reinterpret_cast<void*>(&ldr_load_dll_detour),
                                  reinterpret_cast<void**>(&g_real_ldr_load_dll));
                if (s == MH_OK) s = MH_EnableHook(g_ldr_target);
            }
            if (s == MH_OK) {
                ENW_INFO("overlay_guard: DiscordHook.dll will be refused (ntdll!LdrLoadDll at %p). Discord's "
                         "graphics hook needs a 50 MB mapping this 2 GB process cannot always give and crashes "
                         "on the next Present when it fails. ENW_ALLOW_DISCORD_HOOK=1 allows it.",
                         g_ldr_target);
            } else {
                g_real_ldr_load_dll = nullptr;
                ENW_WARN("overlay_guard: could not detour ntdll!LdrLoadDll (MinHook %d); Discord's hook is NOT "
                         "kept out",
                         static_cast<int>(s));
            }
        }
        if (HMODULE nt = ::GetModuleHandleW(L"ntdll.dll")) {
            auto reg = reinterpret_cast<ldr_register_t>(::GetProcAddress(nt, "LdrRegisterDllNotification"));
            if (reg && reg(0, &on_dll, nullptr, &g_cookie) >= 0)
                ENW_DEBUG("overlay_guard: DLL load notifications on");
        }
    }

    void post_init() override {
        if (env_off("ENW_OVERLAY_GUARD")) return;
        g_game_started = true;
        g_prev_filter = ::SetUnhandledExceptionFilter(&on_unhandled);
        const auto vm = overlay_rule::measure_free();
        ENW_INFO("overlay_guard: unhandled exceptions are named before the engine's filter (previous %p). "
                 "Address space at engine start: largest free block %.1f MB of %.1f MB free.",
                 reinterpret_cast<void*>(g_prev_filter), vm.largest / 1048576.0, vm.total / 1048576.0);
        frame::subscribe("overlay_guard", [](uint64_t n) {
            drain();
            // Once a minute in a session, the address-space number that decides whether an
            // injected overlay (or the next zone) fits.
            static ULONGLONG last = 0;
            const ULONGLONG now = ::GetTickCount64();
            if (n > 1 && now - last >= 60000) {
                last = now;
                const auto v = overlay_rule::measure_free();
                ENW_INFO("overlay_guard: address space +%llu s: largest free block %.1f MB of %.1f MB free; "
                         "DiscordHook loads refused so far: %ld",
                         since_start_ms() / 1000, v.largest / 1048576.0, v.total / 1048576.0,
                         g_refusals.load());
            }
        });
    }

    void pre_destroy() override {
        if (g_cookie) {
            if (HMODULE nt = ::GetModuleHandleW(L"ntdll.dll")) {
                auto unreg = reinterpret_cast<ldr_unregister_t>(::GetProcAddress(nt, "LdrUnregisterDllNotification"));
                if (unreg) unreg(g_cookie);
            }
            g_cookie = nullptr;
        }
        if (g_ldr_target && g_real_ldr_load_dll) MH_DisableHook(g_ldr_target);
    }
};

ENW_REGISTER_COMPONENT(overlay_guard_component)

}  // namespace
}  // namespace enw::client::overlay_guard
