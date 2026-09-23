// The dedicated server's freeze watchdog (dedi.md §23).
//
// ---------------------------------------------------------------------------
// Why
// ---------------------------------------------------------------------------
// B's fear_mc_2 game on 2026-09-23 stopped simulating at 4 m 46 s. The process
// stayed up, the outer loop kept pacing at 61.8 Hz, every frame entered the body,
// and every frame faulted at 0x5FFE23 and was unwound by the engine's own
// abortframe before it wrote com_frameTime. No snapshots went out; B's client timed
// out and quit; the host agent, which only hears from the game when something
// happens, went on believing the game was live with a 24-hour cap. The record, the
// replay and B's result were all in limbo until a lease timed out.
//
// The chain (§23.2): one frame escaped through an access violation inside the
// script VM -> the VM was left half-executed -> a later resume walked stale local
// variables through .bss (Scr_AddLocalVars, 33,075 slots into a 2,048-slot stack)
// -> the r_reflectionProbeGenerate pointer at 0x3BFD478 became a name id -> every
// later frame faulted in the packet receive.
//
// ---------------------------------------------------------------------------
// What this does
// ---------------------------------------------------------------------------
//   1. A vectored handler that RECORDS (never logs, never handles) the context of
//      each error-class exception -- eip, the address it touched, registers and the
//      first 48 stack words -- into a small ring. Logging from inside a vectored
//      handler re-enters it through OutputDebugString (§12.1's trap), so the frame
//      subscriber prints the records instead. This is what names the FIRST escaped
//      frame next time, which §23 could not.
//   2. Every outer frame, freeze_watch.hpp's rule over three engine counters:
//        * an ESCAPED frame is logged with the fault that caused it and the state the
//          script VM was left in (rest, or N frames / M locals deep);
//        * the VM leaving rest between frames is logged once per transition, and
//          loudly once if localVars is past the end of its stack.
//   3. FROZEN (com_frameTime still for > 5 s while >= 30 frames were entered):
//        * log FREEZE, the fault records and every other thread's eip and stack;
//        * end the match through the referee exactly as the scripts would --
//          game_over {reason:"server_freeze", flags:["server_freeze"], the result
//          as it stood}, the replay sampler stopped, match_end {server_alive:false}
//          -- so the host signs the replay, posts the result with the flag, and
//          tears the process down rather than reusing it.
//
// It writes nothing to the game. ENW_DEDI_NO_FREEZE_WATCHDOG=1 turns it all off;
// ENW_DEDI_FREEZE_MS=N changes the 5 s line (tests only).
//
// THE ONE EXCEPTION, FOR PROVING IT: ENW_DEDI_FREEZE_TEST=N (seconds) plants §23's
// own value, 0x615B, into [0x3BFD478] N seconds after the watch arms. That is the
// exact state the overrun left, so the next WSAEWOULDBLOCK in the packet receive
// faults at 0x5FFE23 every frame and the server freezes the way B's did. Never set
// it anywhere a real game runs.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "dedicated.hpp"
#include "freeze_watch.hpp"
#include "snd_alias_dvars.hpp"
#include "../referee/game_over.hpp"

#include <windows.h>
#include <tlhelp32.h>
#include <mmsystem.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#pragma comment(lib, "winmm.lib")

namespace enw::dedi {
namespace {

namespace fw = ::enw::freeze_watch;

// The three counters frame_pacing.cpp's rate probe reads (dedi.md §11.1).
constexpr uintptr_t kComFrameTime   = 0x1F9648C;   // written at 0x59DDC1
constexpr uintptr_t kBodyReturned   = 0x1F964BC;   // incremented at 0x59E4DC, straight path only
constexpr uintptr_t kBodyEntered    = 0x1F552D4;   // incremented at 0x59DD72
// scrVmPub[0] (freeze_watch.hpp has the evidence for each field).
constexpr uintptr_t kScrVmPub       = 0x3BD4700;
constexpr uintptr_t kFunctionStart  = 0x3BD4720;   // function_frame_start[32], 0x18 each
constexpr uintptr_t kProbeSlot      = 0x3BFD478;   // the first thing the §23 overrun hits

// ---------------------------------------------------------------- fault ring --
constexpr int kRing = 8;
constexpr int kStackWords = 48;
struct fault_record {
    volatile LONG seq = 0;        // 0 = empty; written last
    DWORD tid = 0;
    DWORD code = 0;
    uint32_t eip = 0, touched = 0, rw = 0;
    uint32_t eax = 0, ebx = 0, ecx = 0, edx = 0, esi = 0, edi = 0, ebp = 0, esp = 0;
    uint32_t n = 0;
    uint32_t words[kStackWords] = {};
};
fault_record g_ring[kRing];
volatile LONG g_fault_seq = 0;
std::atomic<uint64_t> g_faults{0};
void* g_veh = nullptr;

LONG CALLBACK on_exception(EXCEPTION_POINTERS* info) {
    if (!info || !info->ExceptionRecord || !info->ContextRecord) return EXCEPTION_CONTINUE_SEARCH;
    const DWORD code = info->ExceptionRecord->ExceptionCode;
    // Error severity only (0xC...): access violations, illegal instructions, divide by
    // zero, stack overflow. Not debug prints (0x4001...), not the write probe's single
    // step (0x80000004), not C++ throws (0xE06D7363).
    if ((code & 0xF0000000u) != 0xC0000000u) return EXCEPTION_CONTINUE_SEARCH;
    g_faults.fetch_add(1, std::memory_order_relaxed);

    const LONG seq = ::InterlockedIncrement(&g_fault_seq);
    fault_record& r = g_ring[(seq - 1) % kRing];
    r.seq = 0;
    const CONTEXT* c = info->ContextRecord;
    r.tid = ::GetCurrentThreadId();
    r.code = code;
    r.eip = c->Eip;
    r.rw = info->ExceptionRecord->NumberParameters >= 2
               ? static_cast<uint32_t>(info->ExceptionRecord->ExceptionInformation[0]) : 0;
    r.touched = info->ExceptionRecord->NumberParameters >= 2
                    ? static_cast<uint32_t>(info->ExceptionRecord->ExceptionInformation[1]) : 0;
    r.eax = c->Eax; r.ebx = c->Ebx; r.ecx = c->Ecx; r.edx = c->Edx;
    r.esi = c->Esi; r.edi = c->Edi; r.ebp = c->Ebp; r.esp = c->Esp;
    // The faulting thread's own stack: VirtualQuery + memcpy, no allocation, no logging.
    r.n = 0;
    if (memory::read_raw(c->Esp, r.words, sizeof r.words)) r.n = kStackWords;
    r.seq = seq;
    return EXCEPTION_CONTINUE_SEARCH;
}

std::string text_chain(const uint32_t* words, uint32_t n, size_t max_chars = 200) {
    const auto text = memory::text_section();
    std::string out;
    char tmp[16];
    for (uint32_t i = 0; i < n && out.size() < max_chars; ++i) {
        if (text.contains(words[i])) {
            std::snprintf(tmp, sizeof tmp, "%08X ", words[i]);
            out += tmp;
        }
    }
    return out.empty() ? "(none)" : out;
}

void log_fault(const fault_record& r, const char* why) {
    ENW_ERROR("dedi_freeze_watchdog: %s fault #%ld tid %lu code=%08X eip=%08X %s %08X | eax=%08X "
              "ebx=%08X ecx=%08X edx=%08X esi=%08X edi=%08X ebp=%08X esp=%08X | callers: %s",
              why, static_cast<long>(r.seq), static_cast<unsigned long>(r.tid),
              static_cast<unsigned>(r.code), r.eip, r.rw ? "writing" : "reading", r.touched,
              r.eax, r.ebx, r.ecx, r.edx, r.esi, r.edi, r.ebp, r.esp,
              text_chain(r.words, r.n).c_str());
    // A fault we have already identified gets its name (snd_alias_dvars.hpp, crash review L1).
    if (const char* known = enw::snd_alias_dvars::known_fault_name(r.eip))
        ENW_ERROR("dedi_freeze_watchdog: fault #%ld at %08X is KNOWN: %s",
                  static_cast<long>(r.seq), r.eip, known);
}

// Faults recorded since `since`, oldest first, at most `max`. A fault identical to the
// last one printed (same code, eip and address) is counted, not printed: a frozen
// server faults the same way sixty times a second.
uint32_t g_last_sig_eip = 0, g_last_sig_addr = 0, g_last_sig_code = 0;
uint64_t g_repeats = 0;

LONG log_faults_since(LONG since, int max, const char* why) {
    const LONG now = g_fault_seq;
    LONG from = now - kRing + 1;
    if (from <= since) from = since + 1;
    int printed = 0;
    for (LONG s = from; s <= now && printed < max; ++s) {
        const fault_record& r = g_ring[(s - 1) % kRing];
        if (r.seq != s) continue;              // overwritten or half-written
        if (r.eip == g_last_sig_eip && r.touched == g_last_sig_addr && r.code == g_last_sig_code) {
            ++g_repeats;
            continue;
        }
        if (g_repeats) {
            ENW_ERROR("dedi_freeze_watchdog: (%llu more fault(s) identical to the last one printed)",
                      static_cast<unsigned long long>(g_repeats));
            g_repeats = 0;
        }
        log_fault(r, why);
        g_last_sig_eip = r.eip; g_last_sig_addr = r.touched; g_last_sig_code = r.code;
        ++printed;
    }
    return now;
}

// ------------------------------------------------------------------ VM state --
fw::vm_state read_vm() {
    fw::vm_state v;
    const uintptr_t b = enw::at(kScrVmPub);
    memory::read(b + 0x0, &v.local_vars);
    memory::read(b + 0x8, &v.function_count);
    memory::read(b + 0xC, &v.function_frame);
    memory::read(b + 0x10, &v.top);
    return v;
}

std::string describe_vm(const fw::vm_state& v) {
    char buf[320];
    uint32_t slot = 0;
    memory::read(enw::at(kProbeSlot), &slot);
    std::snprintf(buf, sizeof buf,
                  "%s: function_count=%d function_frame=%08X localVars=%08X (%+d slots%s) "
                  "top=%08X | [0x3BFD478]=%08X",
                  fw::vm_at_rest(v) ? "AT REST" : "NOT AT REST", v.function_count,
                  v.function_frame, v.local_vars, fw::local_depth(v),
                  fw::vm_overran(v) ? ", PAST THE END OF localVarsStack" : "", v.top, slot);
    std::string s = buf;
    // The frames an escape left behind: codepos and local-object id of each. The pos
    // is a pointer into script bytecode; the id is the thread's local-variable object.
    const int n = v.function_count > 0 ? (v.function_count < 6 ? v.function_count : 6) : 0;
    for (int i = 0; i < n; ++i) {
        uint32_t pos = 0, local = 0;
        memory::read(enw::at(kFunctionStart) + i * 0x18 + 0x0, &pos);
        memory::read(enw::at(kFunctionStart) + i * 0x18 + 0x4, &local);
        std::snprintf(buf, sizeof buf, " | frame[%d] pos=%08X localId=%u", i, pos, local);
        s += buf;
    }
    return s;
}

// ------------------------------------------------------------- thread stacks --
// Every thread of ours except the caller: eip, esp and the .text return addresses on
// its stack. Nothing allocates while a thread is suspended (it might hold the heap
// lock); the list and the buffers are sized before the first SuspendThread.
struct thread_shot {
    DWORD tid = 0;
    bool ok = false;
    uint32_t eip = 0, esp = 0, ebp = 0;
    uint32_t n = 0;
    uint32_t words[128] = {};
};

void log_thread_stacks() {
    const DWORD pid = ::GetCurrentProcessId();
    const DWORD self = ::GetCurrentThreadId();
    std::vector<DWORD> tids;
    const HANDLE snap = ::CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        THREADENTRY32 te{};
        te.dwSize = sizeof te;
        for (BOOL more = ::Thread32First(snap, &te); more; more = ::Thread32Next(snap, &te)) {
            if (te.th32OwnerProcessID == pid && te.th32ThreadID != self) tids.push_back(te.th32ThreadID);
        }
        ::CloseHandle(snap);
    }
    std::vector<thread_shot> shots(tids.size());
    (void)memory::text_section();   // cached before anything is suspended
    for (size_t i = 0; i < tids.size(); ++i) {
        thread_shot& t = shots[i];
        t.tid = tids[i];
        const HANDLE h = ::OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                      THREAD_QUERY_INFORMATION, FALSE, t.tid);
        if (!h) continue;
        if (::SuspendThread(h) != static_cast<DWORD>(-1)) {
            CONTEXT c{};
            c.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
            if (::GetThreadContext(h, &c)) {
                t.ok = true;
                t.eip = c.Eip; t.esp = c.Esp; t.ebp = c.Ebp;
                for (uint32_t k = 0; k < 128; ++k) {
                    if (!memory::read_raw(c.Esp + k * 4, &t.words[k], 4)) break;
                    t.n = k + 1;
                }
            }
            ::ResumeThread(h);
        }
        ::CloseHandle(h);
    }
    ENW_ERROR("dedi_freeze_watchdog: %zu other thread(s); this one (tid %lu) is the game thread, "
              "and its stack at the fault is the fault record above", shots.size(),
              static_cast<unsigned long>(self));
    for (const auto& t : shots) {
        if (!t.ok) {
            ENW_ERROR("dedi_freeze_watchdog:   thread %lu: could not be sampled",
                      static_cast<unsigned long>(t.tid));
            continue;
        }
        ENW_ERROR("dedi_freeze_watchdog:   thread %lu eip=%08X esp=%08X ebp=%08X codwaw callers: %s",
                  static_cast<unsigned long>(t.tid), t.eip, t.esp, t.ebp,
                  text_chain(t.words, t.n, 160).c_str());
    }
}

// ----------------------------------------------------------------- component --
class freeze_watchdog final : public component {
public:
    const char* name() const override { return "dedi_freeze_watchdog"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_NO_FREEZE_WATCHDOG")) {
            ENW_WARN("dedi_freeze_watchdog: OFF (ENW_DEDI_NO_FREEZE_WATCHDOG). A frozen server "
                     "will sit silent until its lease ends.");
            return;
        }
        uint32_t stall_ms = 5000;
        if (const char* e = std::getenv("ENW_DEDI_FREEZE_MS")) {
            const long v = std::strtol(e, nullptr, 10);
            if (v >= 500 && v <= 600000) stall_ms = static_cast<uint32_t>(v);
        }
        watch_ = fw::watch(stall_ms);
        if (const char* e = std::getenv("ENW_DEDI_FREEZE_TEST")) {
            const long v = std::strtol(e, nullptr, 10);
            if (v > 0 && v < 3600) {
                test_after_ms_ = static_cast<uint32_t>(v) * 1000u;
                ENW_WARN("dedi_freeze_watchdog: ENW_DEDI_FREEZE_TEST=%ld -- will plant 0x615B in "
                         "[0x3BFD478] %ld s after the watch arms, to freeze this server on purpose "
                         "(dedi.md §23). TEST ONLY.", v, v);
            }
        }
        g_veh = ::AddVectoredExceptionHandler(1, &on_exception);
        enw::frame::subscribe("dedi_freeze_watchdog", [this](uint64_t) { tick(); });
        ENW_INFO("dedi_freeze_watchdog: armed. Ends the match with flag server_freeze if "
                 "com_frameTime stands still for %u ms while frames are entered; logs every "
                 "escaped frame with its fault and the script VM's state. Fault recorder %s.",
                 stall_ms, g_veh ? "installed" : "NOT installed");
    }

    void pre_destroy() override {
        if (g_veh) ::RemoveVectoredExceptionHandler(g_veh);
        g_veh = nullptr;
    }

private:
    void tick() {
        fw::sample s;
        s.now_ms = ::timeGetTime();
        memory::read(enw::at(kComFrameTime), &s.frame_time);
        memory::read(enw::at(kBodyEntered), &s.entered);
        memory::read(enw::at(kBodyReturned), &s.body);
        const fw::result r = watch_.feed(s);

        if (test_after_ms_ && watch_.armed()) {
            if (!armed_at_ms_) armed_at_ms_ = s.now_ms;
            if (!test_planted_ && s.now_ms - armed_at_ms_ >= test_after_ms_) {
                test_planted_ = true;
                uint32_t was = 0;
                memory::read(enw::at(kProbeSlot), &was);
                const bool ok = memory::write(enw::at(kProbeSlot), static_cast<uint32_t>(0x615B));
                ENW_WARN("dedi_freeze_watchdog: TEST: [0x3BFD478] %08X -> 0000615B %s at "
                         "com_frameTime %u", was, ok ? "planted" : "NOT written", s.frame_time);
            }
        }

        const fw::vm_state vm = read_vm();
        const bool rest = fw::vm_at_rest(vm);

        if (r.escaped_now) {
            escapes_logged_ += 1;
            // Every one of the first 20, then one in 1,000: a frozen server escapes 60
            // times a second and the first few are the only ones that say anything new.
            if (escapes_logged_ <= 20 || escapes_logged_ % 1000 == 0) {
                ENW_WARN("dedi_freeze_watchdog: ESCAPED frame (%u now, %llu in all): the frame "
                         "body was entered and did not return; com_frameTime %u. Script VM %s",
                         r.escaped_now, static_cast<unsigned long long>(watch_.escaped_total()),
                         s.frame_time, describe_vm(vm).c_str());
                last_fault_seen_ = log_faults_since(last_fault_seen_, 3, "escape");
            }
        }

        if (rest != vm_was_rest_) {
            if (!rest) {
                ENW_WARN("dedi_freeze_watchdog: script VM left REST between frames -- an escaped "
                         "frame abandoned a thread mid-execution (dedi.md §23). %s",
                         describe_vm(vm).c_str());
            } else {
                ENW_INFO("dedi_freeze_watchdog: script VM back at rest");
            }
            vm_was_rest_ = rest;
        }
        if (fw::vm_overran(vm) && !overran_logged_) {
            overran_logged_ = true;
            ENW_ERROR("dedi_freeze_watchdog: localVars is PAST THE END of its 2,048-slot stack -- "
                      ".bss after 0x3BDFE14 has been overwritten (dedi.md §23). %s",
                      describe_vm(vm).c_str());
        }

        if (r.frozen_now) on_freeze(s, r, vm);
        if (watch_.resumed_after_firing() && !resumed_logged_) {
            resumed_logged_ = true;
            ENW_WARN("dedi_freeze_watchdog: com_frameTime moved again (%u) after the freeze was "
                     "declared. The match has already been ended; the process should be torn down.",
                     s.frame_time);
        }
    }

    void on_freeze(const fw::sample& s, const fw::result& r, const fw::vm_state& vm) {
        ENW_ERROR("dedi_freeze_watchdog: FREEZE -- com_frameTime %u has not moved for %u ms while "
                  "%u frames entered the body (%llu escaped in all, %llu faults recorded). The "
                  "server has stopped simulating; ending the match.",
                  s.frame_time, r.stalled_ms, r.stalled_frames,
                  static_cast<unsigned long long>(watch_.escaped_total()),
                  static_cast<unsigned long long>(g_faults.load()));
        ENW_ERROR("dedi_freeze_watchdog: script VM %s", describe_vm(vm).c_str());
        // The fault that kills every frame now, printed even if it was printed before.
        g_last_sig_eip = g_last_sig_addr = g_last_sig_code = 0;
        log_faults_since(0, kRing, "freeze");
        if (g_repeats) {
            ENW_ERROR("dedi_freeze_watchdog: (%llu more fault(s) identical to the last one printed)",
                      static_cast<unsigned long long>(g_repeats));
            g_repeats = 0;
        }
        log_thread_stacks();
        const bool sent = referee::end_game_now("server_freeze", "server_freeze",
                                                /*server_alive=*/false);
        ENW_ERROR("dedi_freeze_watchdog: %s",
                  sent ? "game_over {reason:server_freeze, flags:[server_freeze]} and match_end "
                         "{server_alive:false} sent; the host signs the replay, posts the result "
                         "and tears this process down."
                       : "the referee did not end the match (not armed, or it had already ended). "
                         "Nothing was sent.");
    }

    fw::watch watch_;
    uint64_t escapes_logged_ = 0;
    LONG last_fault_seen_ = 0;
    bool vm_was_rest_ = true;
    bool overran_logged_ = false;
    bool resumed_logged_ = false;
    uint32_t test_after_ms_ = 0;
    uint32_t armed_at_ms_ = 0;
    bool test_planted_ = false;
};

ENW_REGISTER_COMPONENT(freeze_watchdog)

}  // namespace
}  // namespace enw::dedi
