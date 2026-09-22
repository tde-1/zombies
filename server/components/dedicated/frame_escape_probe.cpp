// Where does the dedicated frame body leave without returning?
//
// ---------------------------------------------------------------------------
// The measurement that made this necessary (run join55)
// ---------------------------------------------------------------------------
// `dedi_rate_probe` reads three engine counters every 5 s:
//
//   ours                  our Com_Frame tick (the retargeted call in WinMain)
//   Com_Frame-body        [0x1F964BC], incremented at 0x59E4DC -- AFTER the body call
//   frame-body-entered    [0x1F552D4], incremented at 0x59DD72 -- INSIDE the body
//
// Before a client joins all three read 61 Hz. About fifty seconds after the player
// spawns they split:
//
//   ours 5,236 Hz | Com_Frame-body 0.0 Hz | frame-body-entered 5,236 Hz
//   com_frameTime frozen at 54365 for the rest of the run
//
// So every frame still ENTERS the body and none of them RETURN from it. The engine's
// own frame number stops, and `com_frameTime` -- written at 0x59DDC1, a few
// instructions later -- stops with it. Everything after that point in the body,
// including `SV_Frame` at 0x59DEBF, therefore stops running: the server is spinning,
// not simulating. That is what the "5,900 Hz" was.
//
// The only two calls between the counter at 0x59DD72 and the com_frameTime write are
//
//     0x59DD90   call 0x59B630     Com_EventLoop          (dedicated path)
//     0x59DE10   call 0x59B630     Com_EventLoop          (non-dedicated path)
//
// and `longjmp` (0x7AD57C) has exactly three callers in the image: `Com_Error`
// 0x59AC50, `Sys_Error` 0x5FE8C0 -- both already trapped by `error_trap.cpp`, and
// both silent through the whole storm -- and **0x693CF0**, the script VM's error
// path, which longjmps into the per-instance script jmp_buf at 0x3BDCD40 and prints
// nothing on that branch.
//
// This component counts entries and exits so the escape point is a number rather
// than an argument:
//
//   * a wrapper on the dedicated path's `call Com_EventLoop` at 0x59DD90
//     (retargeting one existing E8, nothing relocated, nothing else hooked there);
//   * a wrapper on 0x693CF0 that counts and reads the VM's error message.
//
// Com_EventLoop's return value is dead at both call sites (0x59DD95 immediately does
// `cmp dword ptr [0x4DE7054], 0`), so a `void __cdecl` wrapper is safe here; we do
// not have to know its real signature.
//
// ENW_DEDI_ESCAPE_PROBE=1 turns it on. It is an instrument, not a fix: off by default.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "hook.hpp"
#include "frame.hpp"
#include "dedicated.hpp"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <string>

namespace enw::dedi {
namespace {

constexpr uintptr_t kEventLoopCallSite = 0x59DD90;   // call 0x59B630, dedicated path
constexpr uintptr_t kEventLoop         = 0x59B630;
constexpr uintptr_t kScrError          = 0x693CF0;   // the third longjmp caller
constexpr uintptr_t kScrVarPubStride   = 0x18048;
constexpr uintptr_t kScrErrMsgOff      = 0x3882B7C;  // [instance*stride + this] = char*

std::atomic<uint64_t> g_el_in{0}, g_el_out{0};
uintptr_t g_eventloop_real = 0;

// The wrapper also records the stack pointer it was entered with. If the escaped
// frames were NESTING, esp would march down by one frame each time and the process
// would die of stack exhaustion inside a minute; if esp is identical every time, the
// stack is being reset by something, and the question is what.
std::atomic<uintptr_t> g_last_esp{0};

void __cdecl eventloop_wrapper() {
    unsigned long stack_ptr = 0;
    __asm { mov eax, esp }
    __asm { mov stack_ptr, eax }
    g_last_esp.store(stack_ptr, std::memory_order_relaxed);
    g_el_in.fetch_add(1, std::memory_order_relaxed);
    reinterpret_cast<void(__cdecl*)()>(g_eventloop_real)();
    g_el_out.fetch_add(1, std::memory_order_relaxed);
}

// 0x693CF0 takes the script instance in EAX and nothing on the stack, so we cannot
// wrap it with a C function without a naked stub. We only need the count and the
// message, and both are readable from a frame subscriber, so instead of hooking it
// we read the VM's own error state. Cheap and it cannot unbalance anything.
const char* vm_error_message(int instance) {
    const uintptr_t slot = enw::at(kScrErrMsgOff) + static_cast<uintptr_t>(instance) * kScrVarPubStride;
    uintptr_t p = 0;
    if (!memory::read(slot, &p) || !p) return nullptr;
    if (!memory::is_readable(reinterpret_cast<const void*>(p), 1)) return nullptr;
    return reinterpret_cast<const char*>(p);
}

// ---- who longjmps? ---------------------------------------------------------
// `longjmp` 0x7AD57C has three callers and two of them are already trapped and
// silent, so trapping the function itself names the third. The stack chain from the
// caller's ESP names the site that raised it, which is the thing we actually want.
constexpr uintptr_t kLongjmp = 0x7AD57C;
void* g_longjmp_tramp = nullptr;
std::atomic<uint64_t> g_longjmps{0};

void __cdecl on_longjmp(uintptr_t ret, uint32_t buf, uint32_t value, uintptr_t caller_esp) {
    const uint64_t n = g_longjmps.fetch_add(1, std::memory_order_relaxed);
    if (n >= 6) return;                        // six is plenty; this fires 5,000 a second

    const auto text = memory::text_section();
    std::string chain;
    char tmp[16];
    for (uintptr_t p = caller_esp; p < caller_esp + 0x400 && chain.size() < 200; p += 4) {
        uint32_t v = 0;
        if (!memory::read(p, &v)) break;
        if (text.contains(v)) { std::snprintf(tmp, sizeof tmp, "%08X ", v); chain += tmp; }
    }
    ENW_ERROR("dedi_frame_escape: longjmp #%llu from %08X  buf=%08X value=%d  chain: %s",
              static_cast<unsigned long long>(n + 1), static_cast<unsigned>(ret), buf,
              static_cast<int>(value), chain.c_str());
}

__declspec(naked) void longjmp_stub() {
    __asm { pushfd }
    __asm { pushad }
    __asm { lea  eax, [esp + 36] }
    __asm { push eax }
    __asm { mov  eax, [esp + 36 + 4 + 8] }
    __asm { push eax }
    __asm { mov  eax, [esp + 36 + 8 + 4] }
    __asm { push eax }
    __asm { mov  eax, [esp + 36 + 12 + 0] }
    __asm { push eax }
    __asm { call on_longjmp }
    __asm { add  esp, 16 }
    __asm { popad }
    __asm { popfd }
    __asm { jmp  dword ptr [g_longjmp_tramp] }
}

enw::hook g_longjmp_hook;

// ---- and if it is not longjmp, is it an exception? --------------------------
// join57: longjmp 0x7AD57C is hooked and NEVER CALLED, and Com_EventLoop still goes
// in 5,802 more times than it comes out. The only other way to leave a function
// without returning is an SEH unwind, so watch for one. A vectored handler sees every
// exception in the process before any SEH frame does, and returning
// EXCEPTION_CONTINUE_SEARCH changes nothing about how it is handled.
std::atomic<uint64_t> g_exceptions{0};
void* g_veh = nullptr;

LONG CALLBACK on_exception(EXCEPTION_POINTERS* info) {
    const uint64_t n = g_exceptions.fetch_add(1, std::memory_order_relaxed);
    if (n < 6 && info && info->ExceptionRecord) {
        ENW_ERROR("dedi_frame_escape: exception #%llu code=%08X at %08X flags=%08X",
                  static_cast<unsigned long long>(n + 1),
                  static_cast<unsigned>(info->ExceptionRecord->ExceptionCode),
                  static_cast<unsigned>(reinterpret_cast<uintptr_t>(
                      info->ExceptionRecord->ExceptionAddress)),
                  static_cast<unsigned>(info->ExceptionRecord->ExceptionFlags));
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

class frame_escape_probe final : public component {
public:
    const char* name() const override { return "dedi_frame_escape"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (!std::getenv("ENW_DEDI_ESCAPE_PROBE")) return;

        g_veh = ::AddVectoredExceptionHandler(1, &on_exception);
        ENW_INFO("dedi_frame_escape: vectored exception handler %s",
                 g_veh ? "installed (observe-only, CONTINUE_SEARCH)" : "FAILED to install");

        const uintptr_t site = enw::at(kEventLoopCallSite);
        const uintptr_t target = memory::call_target(site);
        if (target != enw::at(kEventLoop)) {
            ENW_ERROR("dedi_frame_escape: 0x%08X calls 0x%08X, expected Com_EventLoop 0x%08X. "
                      "NOT wrapping. Context: %s",
                      static_cast<unsigned>(kEventLoopCallSite), static_cast<unsigned>(target),
                      static_cast<unsigned>(kEventLoop), memory::hex_dump(site - 8, 20).c_str());
            return;
        }
        g_eventloop_real = target;
        if (!memory::retarget_call(site, reinterpret_cast<const void*>(&eventloop_wrapper))) {
            ENW_ERROR("dedi_frame_escape: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(kEventLoopCallSite));
            return;
        }
        if (g_longjmp_hook.create(reinterpret_cast<void*>(enw::at(kLongjmp)),
                                  reinterpret_cast<void*>(&longjmp_stub), "longjmp") &&
            g_longjmp_hook.enable()) {
            g_longjmp_tramp = g_longjmp_hook.original<void*>();
            ENW_INFO("dedi_frame_escape: longjmp trapped at 0x%08X (first six are logged with a "
                     "stack chain; Com_Error and Sys_Error are the other two callers and "
                     "error_trap.cpp already watches them)", static_cast<unsigned>(kLongjmp));
        } else {
            ENW_ERROR("dedi_frame_escape: could not hook longjmp at 0x%08X",
                      static_cast<unsigned>(kLongjmp));
        }

        ENW_INFO("dedi_frame_escape: wrapped the dedicated path's call Com_EventLoop at 0x%08X. "
                 "If `in` runs away from `out`, Com_EventLoop is where the frame body leaves.",
                 static_cast<unsigned>(kEventLoopCallSite));

        enw::frame::subscribe("dedi_frame_escape", [](uint64_t) {
            static uint32_t tick = 0;
            if ((++tick % 512) != 0) return;
            static uint64_t last_in = 0, last_out = 0;
            const uint64_t in = g_el_in.load(), out = g_el_out.load();
            if (in - out == last_in - last_out) return;     // nothing new to say
            const char* m0 = vm_error_message(0);
            const char* m1 = vm_error_message(1);
            ENW_WARN("dedi_frame_escape: Com_EventLoop in=%llu out=%llu MISSING=%llu  "
                     "longjmps=%llu exceptions=%llu esp=%08X  vm_err[0]=\"%s\" vm_err[1]=\"%s\"",
                     static_cast<unsigned long long>(in), static_cast<unsigned long long>(out),
                     static_cast<unsigned long long>(in - out),
                     static_cast<unsigned long long>(g_longjmps.load()),
                     static_cast<unsigned long long>(g_exceptions.load()),
                     static_cast<unsigned>(g_last_esp.load()),
                     m0 ? m0 : "(none)", m1 ? m1 : "(none)");
            last_in = in; last_out = out;
        });
    }
};

ENW_REGISTER_COMPONENT(frame_escape_probe)

}  // namespace
}  // namespace enw::dedi
