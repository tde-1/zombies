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
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace enw::dedi {
namespace {

// Name the address: which module, and the nearest export below it. Turns
// "EIP=74DB11DC, some system DLL" into "user32.dll!MessageBoxA+0x2c", which is the
// difference between a clue and an answer.
std::string describe(uintptr_t addr) {
    char out[256];
    HMODULE mod = nullptr;
    if (!::GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                              reinterpret_cast<LPCSTR>(addr), &mod) || !mod) {
        std::snprintf(out, sizeof out, "%08X <no module>", static_cast<unsigned>(addr));
        return out;
    }
    char path[MAX_PATH] = {};
    ::GetModuleFileNameA(mod, path, MAX_PATH);
    const char* base = std::strrchr(path, '\\');
    base = base ? base + 1 : path;

    // Nearest export at or below addr, from the module's own export directory.
    const auto m = reinterpret_cast<uintptr_t>(mod);
    const char* best = nullptr;
    uintptr_t   bestAddr = 0;
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(m);
    const auto* nt  = reinterpret_cast<const IMAGE_NT_HEADERS*>(m + dos->e_lfanew);
    const auto  dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    if (dir.VirtualAddress && dir.Size) {
        const auto* ed = reinterpret_cast<const IMAGE_EXPORT_DIRECTORY*>(m + dir.VirtualAddress);
        const auto* names = reinterpret_cast<const uint32_t*>(m + ed->AddressOfNames);
        const auto* ords  = reinterpret_cast<const uint16_t*>(m + ed->AddressOfNameOrdinals);
        const auto* funcs = reinterpret_cast<const uint32_t*>(m + ed->AddressOfFunctions);
        for (uint32_t i = 0; i < ed->NumberOfNames; ++i) {
            const uintptr_t fa = m + funcs[ords[i]];
            if (fa <= addr && fa > bestAddr) { bestAddr = fa; best = reinterpret_cast<const char*>(m + names[i]); }
        }
    }
    if (best) std::snprintf(out, sizeof out, "%08X %s!%s+0x%X", static_cast<unsigned>(addr), base,
                            best, static_cast<unsigned>(addr - bestAddr));
    else      std::snprintf(out, sizeof out, "%08X %s+0x%X", static_cast<unsigned>(addr), base,
                            static_cast<unsigned>(addr - m));
    return out;
}

struct sample {
    uintptr_t eip = 0;
    uintptr_t esp = 0;
    std::vector<uintptr_t> chain;
    bool ok = false;
};

// A value on the stack that merely POINTS into .text is not a return address -- it can
// be a leftover from an earlier, deeper call. A real return address has a `call`
// immediately before it. Checking that is the difference between naming the right
// function and sending someone to chase a mid-instruction address: 0x49414E landed
// inside the `movss` at 0x49414A, and 0x410830 before it was the same mistake.
//
// x86 call encodings we accept:
//   E8 rel32                  -- 5 bytes
//   FF /2 (call r/m32)        -- 2..7 bytes, modrm.reg == 2
bool preceded_by_call(uintptr_t ret) {
    for (int k = 2; k <= 7; ++k) {
        uint8_t op = 0;
        if (!memory::read(ret - k, &op)) continue;
        if (k == 5 && op == 0xE8) return true;
        if (op == 0xFF) {
            uint8_t modrm = 0;
            if (!memory::read(ret - k + 1, &modrm)) continue;
            if (((modrm >> 3) & 7) == 2) return true;
        }
    }
    return false;
}

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
            if (text.contains(v) && preceded_by_call(v)) s.chain.push_back(v);
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
                ENW_INFO("dedi_whereis: t=%ds  EIP=%s  ESP=%08X", (i + 1) * 4,
                         describe(s.eip).c_str(), static_cast<unsigned>(s.esp));
                ENW_INFO("dedi_whereis:        validated return addresses: %s", chain.c_str());
            }
        }).detach();
    }
};

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::where_is_main_component)
