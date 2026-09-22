// Der Berg: the 0x005FFE23 fault is NOT an unregistered dvar. The GSC VM's
// local-variable scratch overflows into it.
//
// ---------------------------------------------------------------------------
// What dedi.md 12.5 asked for, and why it was the wrong question
// ---------------------------------------------------------------------------
// 12.5 measured Der Berg stopping at com_frameTime=5666, 5.6 s in, on an access
// violation in the packet receive:
//
//     005FFE0A  call 0x75A94E                ; WSAGetLastError
//     005FFE0F  cmp eax, 0x2733              ; 10035 WSAEWOULDBLOCK
//     005FFE14  je  0x5FFE1D
//     005FFE1D  mov ecx, [0x3BFD478]         ; a dvar_s*  -- read as NULL in join68
//     005FFE23  cmp byte ptr [ecx + 0x10], 0 ; <- the fault
//
// and concluded "find the dvar and register it". The dvar was found, and it is
// **r_reflectionProbeGenerate**: the image has exactly ONE write to that slot,
//
//     006ED650  push edi
//     006ED651  push 0x89FD08                ; "Generate cube maps for reflection probes."
//     006ED656  push 0                       ; flags
//     006ED658  xor al, al                   ; value = false
//     006ED65A  mov edi, 0x89FD34            ; "r_reflectionProbeGenerate"
//     006ED65F  call 0x5EEE20                ; Dvar_RegisterBool(name@edi, value@al, flags, desc)
//     006ED664  mov [0x3BFD478], eax
//
// and 0x6ED650 is a no-argument cdecl, so this component calls it -- the engine's
// own registrar, the engine's own type, default, flags and description.
//
// **IT DID NOT FIX DER BERG (join69, FAIL).** The three dvars registered, `name OK`,
// value 0 -- and the server still stopped at com_frameTime=5659 with the same fault,
// now reading `ecx=00000FE9` instead of `ecx=00000000`. A garbage pointer, not a
// null one. So the slot is written by something else.
//
// ---------------------------------------------------------------------------
// The write watch, and the answer (join71, join72)
// ---------------------------------------------------------------------------
// Nothing in the image writes 0x3BFD478 except 0x6ED664 -- one `mov [imm32], eax`
// and no indexed form with that base -- so no static search could find the writer.
// A data breakpoint could: ENW_DEDI_WATCH_PROBE_SLOT=1 puts DR0 on the slot and
// reports the store. join72:
//
//     WRITE #1 to [0x03BFD478] -- the store is just before eip=00697B99.
//     ebx=03BFD478 ecx=03BD4700 esi=00000F34 ... slot now 00000F34
//
//     00697B71  imul ecx, ecx, 0x4320        ; sizeof(scrVmPub_t) -- t4-sp-map.md
//     00697B79  lea  ecx, [ecx + 0x3BD4700]  ; &gScrVmPub[inst]
//     00697B86  add  dword ptr [ecx], 4      ; scrVmPub.localVars++   <-- the scratch
//     00697B89  mov  ebx, dword ptr [ecx]
//     00697B90  movzx esi, word ptr [eax + 0x3974700]   ; the variable table, 16-byte rows
//     00697B97  mov  dword ptr [ebx], esi    ; <<< the store, unbounded
//     00697B99  movzx eax, word ptr [eax + 0x3974702]   ; next sibling
//     00697BA5  jne  0x697B86                ; ...and round again
//
// 0x697B60 walks a script object's child variables and pushes each name id into
// `scrVmPub.localVars`. **There is no bound check in that loop.** Der Berg enumerates
// something with about 3,900 children (0xF34 in join72, 0xFE9 in join70 -- it varies
// with the run, which is what a live object count does), the scratch is sized for a
// few dozen, and the overrun walks 0x28D78 bytes past gScrVmPub into .bss -- where
// the very next thing it lands on is the r_reflectionProbeGenerate dvar pointer.
//
// So the order of events is: **a GSC enumeration overflows the VM's local-variable
// scratch -> the overflow overwrites [0x3BFD478] with a count -> the next
// WSAEWOULDBLOCK in the packet receive dereferences that count -> the frame body
// unwinds and the server stops simulating.** The dvar was the victim, never the
// cause, and "register it" could not have worked. 12.5 is retracted in place.
//
// ---------------------------------------------------------------------------
// What this file still does, and what it does not
// ---------------------------------------------------------------------------
// It still registers the three `r_reflectionProbe*` dvars on a dedicated server,
// because the slot really was NULL at post_init in join69 and a NULL there is a
// fault waiting for the first socket error on any map. It is cheap and it closes
// that hole. **It is not the Der Berg fix and must not be described as one.** The
// Der Berg fix is a bound on 0x697B60's push loop or a bigger localVars, and that
// is an engine-limit job (the class of thing T4M exists to raise), not a dvar job.
//
// It also carries the write watch that found this, because the next person to see a
// wild write into .bss should not have to build the instrument again.
//
// ENW_DEDI_NO_REFLECTION_DVARS=1  -- do not register.
// ENW_DEDI_WATCH_PROBE_SLOT=1     -- DR0 write watch on [0x3BFD478], up to 8 reports.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "dedicated.hpp"

#include <cstdlib>
#include <cstdint>
#include <cstring>

#include <windows.h>

namespace enw::dedi {
namespace {

// R_RegisterReflectionProbeDvars, our name for it.
constexpr uintptr_t kRegisterFn = 0x6ED650;

// `push edi / push 0x89FD08 / push 0 / xor al,al` -- the first eight bytes.
constexpr uint8_t kSignature[] = {0x57, 0x68, 0x08, 0xFD, 0x89, 0x00, 0x6A, 0x00};

struct probe_dvar {
    uintptr_t slot;      // where the dvar_s* is stored
    uintptr_t name_str;  // the name string the engine pushes for it
    const char* name;
};

constexpr probe_dvar kDvars[] = {
    {0x3BFD478, 0x89FD34, "r_reflectionProbeGenerate"},       // <- the one 0x5FFE23 reads
    {0x3BF187C, 0x89FD80, "r_reflectionProbeRegenerateAll"},
    {0x3BFD47C, 0x89FDCC, "r_reflectionProbeGenerateExit"},
};

// dvar_s, from dedicated.cpp's measured layout: +0x00 name*, +0x08 flags|type,
// +0x10 current value.
constexpr size_t kDvarName = 0x00;
constexpr size_t kDvarFlags = 0x08;
constexpr size_t kDvarValue = 0x10;

bool g_done = false;
bool g_ok = false;
uint32_t g_last_seen = 0;

uint32_t slot_value(uintptr_t slot) {
    uint32_t v = 0;
    memory::read(enw::at(slot), &v);
    return v;
}

// Does this dvar_s' name pointer really point at the string the engine pushed?
bool name_agrees(uint32_t dvar_ptr, uintptr_t expect_str) {
    if (!dvar_ptr) return false;
    uint32_t name_ptr = 0;
    if (!memory::read(dvar_ptr + kDvarName, &name_ptr)) return false;
    return name_ptr == static_cast<uint32_t>(enw::at(expect_str));
}

void report(const char* when) {
    for (const auto& d : kDvars) {
        const uint32_t p = slot_value(d.slot);
        if (!p) {
            ENW_INFO("dedi_reflection_dvars: %s: [%08X] %-30s = NULL", when,
                     static_cast<unsigned>(d.slot), d.name);
            continue;
        }
        uint16_t flags = 0, type = 0;
        uint8_t value = 0xFF;
        memory::read(p + kDvarFlags, &flags);
        memory::read(p + kDvarFlags + 2, &type);
        memory::read(p + kDvarValue, &value);
        ENW_INFO("dedi_reflection_dvars: %s: [%08X] %-30s = %08X  flags=0x%04X type=0x%04X "
                 "value@+0x10=%u  name%s",
                 when, static_cast<unsigned>(d.slot), d.name, p, flags, type, value,
                 name_agrees(p, d.name_str) ? " OK" : " MISMATCH");
    }
}

void register_once() {
    if (g_done) return;
    g_done = true;

    const uintptr_t fn = enw::at(kRegisterFn);
    uint8_t got[sizeof kSignature] = {};
    if (!memory::read_raw(fn, got, sizeof got) ||
        std::memcmp(got, kSignature, sizeof got) != 0) {
        ENW_ERROR("dedi_reflection_dvars: NOT calling 0x%08X: expected the registrar's "
                  "`push edi / push 0x89FD08 / push 0 / xor al,al` (%s), found %s. "
                  "r_reflectionProbeGenerate stays unregistered and the packet receive "
                  "will keep faulting at 0x005FFE23 -- dedi.md 12.5.",
                  static_cast<unsigned>(kRegisterFn),
                  memory::hex_dump(reinterpret_cast<uintptr_t>(kSignature), sizeof kSignature)
                      .c_str(),
                  memory::hex_dump(fn, sizeof got).c_str());
        return;
    }

    report("before");
    reinterpret_cast<void(__cdecl*)()>(fn)();
    report("after ");

    const uint32_t first = slot_value(kDvars[0].slot);
    uint8_t value = 0xFF;
    if (first) memory::read(first + kDvarValue, &value);

    g_last_seen = first;
    if (first && name_agrees(first, kDvars[0].name_str) && value == 0) {
        g_ok = true;
        ENW_INFO("dedi_reflection_dvars: r_reflectionProbeGenerate is registered "
                 "(dvar_s at %08X, value 0), so the packet receive's socket-error path at "
                 "0x005FFE1D reads a real dvar instead of NULL. NOTE: this is NOT the Der "
                 "Berg fix -- there the slot is later overwritten by a GSC local-variable "
                 "overflow (dedi.md 13.2).",
                 first);
    } else if (!first) {
        ENW_ERROR("dedi_reflection_dvars: 0x%08X returned but [0x%08X] is still NULL. The "
                  "dvar system was probably not up yet; 0x005FFE23 will still fault.",
                  static_cast<unsigned>(kRegisterFn), static_cast<unsigned>(kDvars[0].slot));
    } else if (!name_agrees(first, kDvars[0].name_str)) {
        ENW_ERROR("dedi_reflection_dvars: [0x%08X] = %08X but its name pointer is not "
                  "0x%08X (\"%s\"). We are not looking at the dvar we think we are -- do "
                  "not trust this fix.",
                  static_cast<unsigned>(kDvars[0].slot), first,
                  static_cast<unsigned>(kDvars[0].name_str), kDvars[0].name);
    } else {
        ENW_WARN("dedi_reflection_dvars: r_reflectionProbeGenerate is registered but its "
                 "value byte reads %u, not 0. The engine's own default is false; a value "
                 "of 1 sends the packet receive down the cube-map-bake branch at "
                 "0x0060008C. Registered, but say so if the server behaves oddly.",
                 value);
        g_ok = true;
    }
}

// ---------------------------------------------------------------------------
// The write watch (ENW_DEDI_WATCH_PROBE_SLOT=1)
// ---------------------------------------------------------------------------
// Nothing in the image writes 0x3BFD478 except the registration at 0x6ED664 -- the
// dump has exactly one `mov [0x3BFD478], eax` and no indexed form with that base --
// yet the slot goes from a valid dvar_s* to a small integer five seconds in. So the
// writer is a WILD WRITE from a neighbour, and a static search cannot find it. A
// data breakpoint can: DR0 = the slot, DR7 asking for a 4-byte write watch, and a
// vectored handler that reports the faulting EIP, which is the instruction AFTER
// the store.
//
// Debug registers are per thread, and you cannot reliably set your own. The helper
// thread below suspends the game thread, sets them and resumes it -- the standard
// shape, and it is why this is a diagnostic behind an env var rather than something
// that runs in every game.
//
// THE LOGGING TRAP, paid for in join60 and recorded in dedi.md 12.1: the ENW logger
// goes out through OutputDebugString, so a vectored handler that logs can see its
// own output and recurse. This one only ever acts on EXCEPTION_SINGLE_STEP with our
// own DR6 bit set, carries a re-entrancy guard, and stops after eight reports.
constexpr int kMaxWatchHits = 8;

HANDLE g_game_thread = nullptr;
PVOID g_veh = nullptr;
volatile LONG g_watch_hits = 0;
volatile LONG g_in_handler = 0;

LONG CALLBACK watch_handler(PEXCEPTION_POINTERS info) {
    if (info->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    // Bit 0 of DR6 = the DR0 breakpoint fired. Anything else is not ours.
    if ((info->ContextRecord->Dr6 & 0x1) == 0) return EXCEPTION_CONTINUE_SEARCH;
    info->ContextRecord->Dr6 = 0;

    if (::InterlockedExchange(&g_in_handler, 1) == 0) {
        const LONG n = ::InterlockedIncrement(&g_watch_hits);
        if (n <= kMaxWatchHits) {
            const auto* c = info->ContextRecord;
            ENW_ERROR("dedi_reflection_dvars: WRITE #%ld to [0x%08X] -- the store is the "
                      "instruction just before eip=%08X. eax=%08X ebx=%08X ecx=%08X "
                      "edx=%08X esi=%08X edi=%08X ebp=%08X esp=%08X. slot now %08X. "
                      "%s",
                      n, static_cast<unsigned>(kDvars[0].slot),
                      static_cast<unsigned>(c->Eip), static_cast<unsigned>(c->Eax),
                      static_cast<unsigned>(c->Ebx), static_cast<unsigned>(c->Ecx),
                      static_cast<unsigned>(c->Edx), static_cast<unsigned>(c->Esi),
                      static_cast<unsigned>(c->Edi), static_cast<unsigned>(c->Ebp),
                      static_cast<unsigned>(c->Esp), slot_value(kDvars[0].slot),
                      memory::hex_dump(c->Eip - 16, 24).c_str());
        }
        ::InterlockedExchange(&g_in_handler, 0);
    }
    return EXCEPTION_CONTINUE_EXECUTION;
}

DWORD WINAPI arm_watch(LPVOID) {
    // Give the map load time to be under way; the write lands about five seconds in
    // and arming before the engine has settled only risks catching init noise.
    ::Sleep(1500);
    if (::SuspendThread(g_game_thread) == static_cast<DWORD>(-1)) {
        ENW_ERROR("dedi_reflection_dvars: could not suspend the game thread to arm the "
                  "write watch (%lu).", ::GetLastError());
        return 0;
    }
    CONTEXT ctx{};
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    bool ok = ::GetThreadContext(g_game_thread, &ctx) != FALSE;
    if (ok) {
        ctx.Dr0 = enw::at(kDvars[0].slot);
        // DR7: L0 (bit 0) enables DR0; bits 16-17 = 01 (write), bits 18-19 = 11 (4 bytes).
        ctx.Dr7 = (ctx.Dr7 & ~0xF0000UL) | 0x1UL | (0x1UL << 16) | (0x3UL << 18);
        ctx.Dr6 = 0;
        ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
        ok = ::SetThreadContext(g_game_thread, &ctx) != FALSE;
    }
    ::ResumeThread(g_game_thread);
    ENW_WARN("dedi_reflection_dvars: write watch on [0x%08X] %s. Up to %d writes will be "
             "reported with the faulting eip.",
             static_cast<unsigned>(kDvars[0].slot), ok ? "ARMED" : "FAILED", kMaxWatchHits);
    return 0;
}

void start_watch() {
    if (!::DuplicateHandle(::GetCurrentProcess(), ::GetCurrentThread(), ::GetCurrentProcess(),
                           &g_game_thread, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
        ENW_ERROR("dedi_reflection_dvars: DuplicateHandle for the game thread failed (%lu); "
                  "no write watch.", ::GetLastError());
        return;
    }
    g_veh = ::AddVectoredExceptionHandler(1, watch_handler);
    if (!g_veh) {
        ENW_ERROR("dedi_reflection_dvars: AddVectoredExceptionHandler failed; no write watch.");
        return;
    }
    ::CloseHandle(::CreateThread(nullptr, 0, arm_watch, nullptr, 0, nullptr));
}

class reflection_probe_dvars_component final : public component {
public:
    const char* name() const override { return "dedi_reflection_dvars"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_NO_REFLECTION_DVARS")) {
            ENW_WARN("dedi_reflection_dvars: OFF (ENW_DEDI_NO_REFLECTION_DVARS). "
                     "[0x3BFD478] stays NULL, 0x005FFE23 faults on every WSAEWOULDBLOCK "
                     "and the engine stops simulating. This is the control for dedi.md 12.5.");
            g_done = true;
            return;
        }
        // post_init is the earliest point at which the dvar system is up -- dedicated.cpp
        // established that Dvar_FindVar("dedicated") answers here and does not in
        // post_unpack. Earlier is better than the first frame, because the fault is on
        // the packet-receive path and packets arrive as soon as the socket is open.
        register_once();

        if (std::getenv("ENW_DEDI_WATCH_PROBE_SLOT")) start_watch();

        // Belt and braces, and a watch.
        //
        // join69/join70 are why the watch exists. The three dvars registered
        // correctly (`name OK`, value 0) and Der Berg STILL stopped at
        // com_frameTime=5659 with the same fault at 0x005FFE23 -- but this time with
        // `ecx=00000FE9` instead of `ecx=00000000`. ecx is loaded from [0x3BFD478]
        // one instruction earlier, so the slot does not hold our dvar_s* by the time
        // the packet receive reads it: something writes a small integer over it.
        // A NULL slot and a garbage slot are different bugs and only one of them is
        // "the dvar was never registered", so this reports the transition with the
        // frame it happened on rather than leaving it to be re-derived.
        enw::frame::subscribe("dedi_reflection_dvars", [](uint64_t n) {
            const uint32_t v = slot_value(kDvars[0].slot);
            if (!v) {
                if (!g_last_seen) return;   // still never registered; post_init said so
                ENW_ERROR("dedi_reflection_dvars: [0x%08X] went from %08X to NULL on frame "
                          "%llu.", static_cast<unsigned>(kDvars[0].slot), g_last_seen,
                          static_cast<unsigned long long>(n));
                g_last_seen = 0;
                g_done = false;
                register_once();
                return;
            }
            if (v == g_last_seen) return;
            if (g_last_seen) {
                ENW_ERROR("dedi_reflection_dvars: [0x%08X] CHANGED from %08X to %08X on frame "
                          "%llu (%s). That slot is supposed to hold the "
                          "r_reflectionProbeGenerate dvar_s*; 0x005FFE1D loads it and "
                          "0x005FFE23 dereferences it. Something else owns this memory.",
                          static_cast<unsigned>(kDvars[0].slot), g_last_seen, v,
                          static_cast<unsigned long long>(n),
                          name_agrees(v, kDvars[0].name_str) ? "still names the dvar"
                                                             : "NOT a dvar_s any more");
            }
            g_last_seen = v;
        });
    }
};

ENW_REGISTER_COMPONENT(reflection_probe_dvars_component)

}  // namespace
}  // namespace enw::dedi
