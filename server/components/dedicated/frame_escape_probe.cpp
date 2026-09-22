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
#include <cstring>

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

// ---- 2026-09-22: does an SEH unwind pass through THIS frame? ----------------
// The VEH proved no exception is *raised* except DBG_PRINTEXCEPTION_C, but a VEH
// runs before any SEH frame and says nothing about which frame claims one. A
// filter in our own wrapper is the other half of that measurement: it runs during
// phase 1 for every exception that propagates past us, so if the frame leaves by
// an unwind we see the code and the faulting address from the inside.
//
// The filter returns EXCEPTION_CONTINUE_SEARCH, so behaviour is unchanged --
// unless ENW_DEDI_CATCH_ESCAPE=1, in which case it claims the exception and the
// wrapper returns normally. That is the control: if catching it makes
// com_frameTime advance again, the escape IS an unwind and we have it by the
// throat; if the frame still escapes, it is not.
bool g_catch_escape = false;
std::atomic<uint64_t> g_seh_seen{0}, g_seh_caught{0};

int seh_filter(unsigned long code, ::EXCEPTION_POINTERS* ep) {
    const uint64_t n = g_seh_seen.fetch_add(1, std::memory_order_relaxed);
    if (n < 8 && ep && ep->ExceptionRecord && ep->ContextRecord) {
        ENW_ERROR("dedi_frame_escape: SEH #%llu THROUGH our Com_EventLoop frame: code=%08X "
                  "at %08X eip=%08X esp=%08X flags=%08X",
                  static_cast<unsigned long long>(n + 1), static_cast<unsigned>(code),
                  static_cast<unsigned>(reinterpret_cast<uintptr_t>(
                      ep->ExceptionRecord->ExceptionAddress)),
                  static_cast<unsigned>(ep->ContextRecord->Eip),
                  static_cast<unsigned>(ep->ContextRecord->Esp),
                  static_cast<unsigned>(ep->ExceptionRecord->ExceptionFlags));
    }
    return g_catch_escape ? EXCEPTION_EXECUTE_HANDLER : EXCEPTION_CONTINUE_SEARCH;
}

// __try/__except cannot share a function with anything MSVC wants to unwind, so
// the guarded call lives on its own.
void call_eventloop_guarded() {
    __try {
        reinterpret_cast<void(__cdecl*)()>(g_eventloop_real)();
    } __except (seh_filter(GetExceptionCode(), GetExceptionInformation())) {
        g_seh_caught.fetch_add(1, std::memory_order_relaxed);
    }
}

void __cdecl eventloop_wrapper() {
    unsigned long stack_ptr = 0;
    __asm { mov eax, esp }
    __asm { mov stack_ptr, eax }
    g_last_esp.store(stack_ptr, std::memory_order_relaxed);
    g_el_in.fetch_add(1, std::memory_order_relaxed);
    call_eventloop_guarded();
    g_el_out.fetch_add(1, std::memory_order_relaxed);
}

// ---- and does Sys_GetEvent come back? --------------------------------------
// Com_EventLoop is a `for(;;) { ev = Sys_GetEvent(); switch (ev.type) }` whose only
// exit is event type 0. Wrapping its one `call Sys_GetEvent` at 0x59B647 splits the
// question in two: if in == out here, the escape is in one of the switch arms; if
// in runs away from out, it is inside Sys_GetEvent -- i.e. in the message pump.
constexpr uintptr_t kGetEventCallSite = 0x59B647;   // call 0x5FEC60, inside Com_EventLoop
constexpr uintptr_t kGetEvent         = 0x5FEC60;
volatile long g_ge_in = 0, g_ge_out = 0;
uintptr_t g_getevent_real = 0;

// Sys_GetEvent(dst, 1) is cdecl with two caller-cleaned arguments and hands the
// event back in EAX, so the thunk re-pushes both arguments, calls through, and
// cleans up its own copies. It never touches EAX and only disturbs the flags,
// which are dead across the call site (0x59B64C reads EAX, not EFLAGS).
__declspec(naked) void getevent_wrapper() {
    __asm {
        lock inc dword ptr [g_ge_in]
        push dword ptr [esp + 8]      // arg2
        push dword ptr [esp + 8]      // arg1 (shifted by the first push)
        call dword ptr [g_getevent_real]
        add  esp, 8
        lock inc dword ptr [g_ge_out]
        ret
    }
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

// DBG_PRINTEXCEPTION_C carries the text: ExceptionInformation[0] is the length and
// [1] is the char*. The join59 run counted one of these per escaped frame and never
// looked at what it said -- so read it. If the engine is narrating its own failure
// through OutputDebugString once a frame, the message is the answer.
constexpr DWORD kDbgPrint  = 0x40010006;
constexpr DWORD kDbgPrintW = 0x4001000A;
std::atomic<uint64_t> g_dbgprints{0};
char g_last_dbg[192] = {0};

// OUR OWN LOGGER GOES OUT THROUGH OutputDebugString (run join60: the first log line
// from this handler produced the second, and 28 more in three milliseconds). So the
// handler must not log its way back into itself, and it must not report our own
// lines as if they were the engine's. Both guards are here; without them this probe
// kills the server before it answers.
thread_local bool g_in_note = false;
std::atomic<uint64_t> g_ours{0};

bool looks_like_ours(const char* s) {
    if (s[0] == '[') {
        if (std::strncmp(s, "[enw]", 5) == 0) return true;
        // our timestamp: "[HH:MM:SS.mmm] ["
        if (s[1] >= '0' && s[1] <= '9' && s[3] == ':' && s[6] == ':') return true;
    }
    return false;
}

void note_debug_string(const EXCEPTION_RECORD* r) {
    if (g_in_note) return;
    if (r->NumberParameters < 2) return;
    const auto* p = reinterpret_cast<const char*>(r->ExceptionInformation[1]);
    if (!p || !memory::is_readable(p, 1)) return;
    char buf[192];
    size_t i = 0;
    for (; i + 1 < sizeof buf && memory::is_readable(p + i, 1) && p[i]; ++i) {
        const auto u = static_cast<unsigned char>(p[i]);
        buf[i] = (u < 0x20 || u > 0x7E) ? ((u == 0x0A || u == 0x0D) ? ' ' : '.') : p[i];
    }
    buf[i] = 0;
    if (looks_like_ours(buf)) { g_ours.fetch_add(1, std::memory_order_relaxed); return; }
    const uint64_t n = g_dbgprints.fetch_add(1, std::memory_order_relaxed);
    // Log the first few, then only when the text changes: this fires once a frame.
    if (n < 12 || std::strcmp(buf, g_last_dbg) != 0) {
        g_in_note = true;
        ENW_ERROR("dedi_frame_escape: engine OutputDebugString #%llu: \"%s\"",
                  static_cast<unsigned long long>(n + 1), buf);
        g_in_note = false;
    }
    std::strncpy(g_last_dbg, buf, sizeof g_last_dbg - 1);
}

LONG CALLBACK on_exception(EXCEPTION_POINTERS* info) {
    const uint64_t n = g_exceptions.fetch_add(1, std::memory_order_relaxed);
    if (info && info->ExceptionRecord) {
        const DWORD code = info->ExceptionRecord->ExceptionCode;
        if (code == kDbgPrint || code == kDbgPrintW) {
            if (code == kDbgPrint) note_debug_string(info->ExceptionRecord);
            return EXCEPTION_CONTINUE_SEARCH;
        }
        // Anything that is NOT a debug print is the interesting case, and join57-59
        // never saw one. Log the first 20 of those on their own budget.
        static std::atomic<uint64_t> others{0};
        const uint64_t o = others.fetch_add(1, std::memory_order_relaxed);
        if (o < 6 && info->ContextRecord) {
            // The chain that led to the fault, from the faulting ESP outwards. This is
            // the one thing that names WHICH engine system reaches the bad read.
            const auto* c = info->ContextRecord;
            const auto text = memory::text_section();
            std::string chain;
            char tmp[16];
            for (uintptr_t sp = c->Esp; sp < c->Esp + 0x300 && chain.size() < 260; sp += 4) {
                uint32_t v = 0;
                if (!memory::read(sp, &v)) break;
                if (text.contains(v)) { std::snprintf(tmp, sizeof tmp, "%08X ", v); chain += tmp; }
            }
            g_in_note = true;
            ENW_ERROR("dedi_frame_escape: FAULT #%llu eip=%08X eax=%08X ebx=%08X ecx=%08X "
                      "edx=%08X esi=%08X edi=%08X ebp=%08X  callers: %s",
                      static_cast<unsigned long long>(o + 1), static_cast<unsigned>(c->Eip),
                      static_cast<unsigned>(c->Eax), static_cast<unsigned>(c->Ebx),
                      static_cast<unsigned>(c->Ecx), static_cast<unsigned>(c->Edx),
                      static_cast<unsigned>(c->Esi), static_cast<unsigned>(c->Edi),
                      static_cast<unsigned>(c->Ebp), chain.c_str());
            g_in_note = false;
        }
        if (o < 20)
            ENW_ERROR("dedi_frame_escape: exception #%llu (non-print #%llu) code=%08X at %08X "
                      "eip=%08X esp=%08X flags=%08X",
                      static_cast<unsigned long long>(n + 1),
                      static_cast<unsigned long long>(o + 1), static_cast<unsigned>(code),
                      static_cast<unsigned>(reinterpret_cast<uintptr_t>(
                          info->ExceptionRecord->ExceptionAddress)),
                      static_cast<unsigned>(info->ContextRecord ? info->ContextRecord->Eip : 0),
                      static_cast<unsigned>(info->ContextRecord ? info->ContextRecord->Esp : 0),
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

        g_catch_escape = std::getenv("ENW_DEDI_CATCH_ESCAPE") != nullptr;
        if (g_catch_escape)
            ENW_WARN("dedi_frame_escape: ENW_DEDI_CATCH_ESCAPE=1 -- our __except around "
                     "Com_EventLoop will CLAIM any exception that reaches it. This changes "
                     "behaviour; it is a control, not a fix.");

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

        // Split Com_EventLoop in two: is it Sys_GetEvent that does not come back, or
        // one of the switch arms below it?
        const uintptr_t ge_site = enw::at(kGetEventCallSite);
        if (memory::call_target(ge_site) != enw::at(kGetEvent)) {
            ENW_ERROR("dedi_frame_escape: 0x%08X calls 0x%08X, expected Sys_GetEvent 0x%08X. "
                      "NOT wrapping it.", static_cast<unsigned>(kGetEventCallSite),
                      static_cast<unsigned>(memory::call_target(ge_site)),
                      static_cast<unsigned>(kGetEvent));
        } else {
            g_getevent_real = enw::at(kGetEvent);
            if (memory::retarget_call(ge_site, reinterpret_cast<const void*>(&getevent_wrapper)))
                ENW_INFO("dedi_frame_escape: wrapped Com_EventLoop's own call Sys_GetEvent at "
                         "0x%08X", static_cast<unsigned>(kGetEventCallSite));
            else
                ENW_ERROR("dedi_frame_escape: retarget_call on 0x%08X failed",
                          static_cast<unsigned>(kGetEventCallSite));
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
            // FORENSICS. The escaped frame left its stack behind: everything DEEPER
            // than the wrapper's ESP (lower addresses) is the dead call chain, and it
            // is not overwritten until something goes that deep again. Print the .text
            // return addresses found there, innermost first -- that names the deepest
            // function the frame reached before it left.
            if (in > out) {
                const auto text = memory::text_section();
                const uintptr_t base = g_last_esp.load();
                std::string chain;
                char tmp[24];
                for (uintptr_t p = base; p > base - 0x800 && chain.size() < 300; p -= 4) {
                    uint32_t v = 0;
                    if (!memory::read(p, &v)) break;
                    if (text.contains(v)) {
                        std::snprintf(tmp, sizeof tmp, "%08X ", v);
                        chain += tmp;
                    }
                }
                ENW_WARN("dedi_frame_escape: dead stack below esp=%08X (deepest first): %s",
                         static_cast<unsigned>(base), chain.c_str());
            }
            const char* m0 = vm_error_message(0);
            const char* m1 = vm_error_message(1);
            ENW_WARN("dedi_frame_escape: Com_EventLoop in=%llu out=%llu MISSING=%llu | "
                     "Sys_GetEvent in=%ld out=%ld MISSING=%ld | longjmps=%llu exceptions=%llu "
                     "seh-through=%llu seh-caught=%llu dbg(engine)=%llu dbg(ours)=%llu esp=%08X  "
                     "vm_err[0]=\"%s\" vm_err[1]=\"%s\"",
                     static_cast<unsigned long long>(in), static_cast<unsigned long long>(out),
                     static_cast<unsigned long long>(in - out),
                     g_ge_in, g_ge_out, g_ge_in - g_ge_out,
                     static_cast<unsigned long long>(g_longjmps.load()),
                     static_cast<unsigned long long>(g_exceptions.load()),
                     static_cast<unsigned long long>(g_seh_seen.load()),
                     static_cast<unsigned long long>(g_seh_caught.load()),
                     static_cast<unsigned long long>(g_dbgprints.load()),
                     static_cast<unsigned long long>(g_ours.load()),
                     static_cast<unsigned>(g_last_esp.load()),
                     m0 ? m0 : "(none)", m1 ? m1 : "(none)");
            last_in = in; last_out = out;
        });
    }
};

ENW_REGISTER_COMPONENT(frame_escape_probe)

}  // namespace
}  // namespace enw::dedi
