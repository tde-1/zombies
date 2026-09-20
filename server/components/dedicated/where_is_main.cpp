// Where is the main thread actually stuck?
//
// Guessing which callee of Com_Init blocks has now cost several probes: `re`'s
// nine-address shortlist (probe p35) all read zero, so the gate is somewhere else
// entirely. Rather than guess again, ask the thread.
//
// Every few seconds this suspends the game's main thread, reads EIP and ESP with
// GetThreadContext, scans the top of its stack for values that land inside the game's
// .text (a crude but very effective return-address chain), resumes it, and logs the
// lot. One run of this names the blocking function outright instead of bisecting
// towards it.
//
// Safety: the suspend is microseconds and read-only -- no writes to the game, no
// patches, and the thread is always resumed, including if reading the context fails.
// It only runs when ENW_DEDI_WHEREIS is set, so it is never on in a normal server.
// Suspending a thread that holds the logger lock would deadlock us, so this thread
// formats into a local buffer first and only logs after the resume.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "scheduler.hpp"

#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

namespace enw::dedi {
namespace {

struct sample {
    uintptr_t eip = 0;
    uintptr_t esp = 0;
    std::vector<uintptr_t> chain;
    bool ok = false;
};

sample probe_main_thread(unsigned long tid) {
    sample s;
    const HANDLE h = ::OpenThread(
        THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, tid);
    if (!h) return s;

    if (::SuspendThread(h) == static_cast<DWORD>(-1)) { ::CloseHandle(h); return s; }

    CONTEXT ctx{};
    ctx.ContextFlags = CONTEXT_CONTROL;
    if (::GetThreadContext(h, &ctx)) {
        s.eip = ctx.Eip;
        s.esp = ctx.Esp;
        s.ok  = true;

        // Crude return-address chain: anything on the top of the stack that points
        // into .text is very likely a return address. Good enough to name callers.
        const auto text = memory::text_section();
        for (uintptr_t p = s.esp; p < s.esp + 0x400 && s.chain.size() < 12; p += 4) {
            uintptr_t v = 0;
            if (!memory::read(p, &v)) break;
            if (text.contains(v)) s.chain.push_back(v);
        }
    }
    ::ResumeThread(h);
    ::CloseHandle(h);
    return s;
}

class where_is_main_component final : public component {
public:
    const char* name() const override { return "dedi_whereis"; }

    void post_init() override {
        if (!std::getenv("ENW_DEDI_WHEREIS")) return;
        const unsigned long tid = scheduler::main_thread_id();
        if (!tid) { ENW_WARN("dedi_whereis: main thread id unknown"); return; }
        ENW_INFO("dedi_whereis: watching main thread %lu", tid);

        std::thread([tid] {
            for (int i = 0; i < 200; ++i) {
                ::Sleep(4000);
                const sample s = probe_main_thread(tid);
                if (!s.ok) { ENW_WARN("dedi_whereis: could not sample thread %lu", tid); continue; }
                std::string chain;
                char buf[32];
                for (const uintptr_t a : s.chain) {
                    std::snprintf(buf, sizeof buf, "%08X ", static_cast<unsigned>(a));
                    chain += buf;
                }
                ENW_INFO("dedi_whereis: t=%ds  EIP=%08X ESP=%08X  stack-text: %s",
                         (i + 1) * 4, static_cast<unsigned>(s.eip),
                         static_cast<unsigned>(s.esp), chain.c_str());
            }
        }).detach();
    }
};

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::where_is_main_component)
