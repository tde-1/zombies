// Read the fatal error the headless server dies on, before it parks.
//
// Probe p37 found the dedicated main thread blocked for ever in
// `win32u!NtUserGetMessage`, with the innermost engine frame at 0x5FE97B inside
// 0x5FE8C0 -- the function `re` labelled `Sys_Error`. So the server is not waiting for
// a client and not pumping an intro movie: it has hit a fatal error and the error
// handler has parked the thread in its own message loop. The error text goes to the
// WinConsole window, which we never see headless, and the console log only shows
// `com_errorTitle Error` with an empty `com_errorMessage`.
//
// This traps both ends of that path and logs what they were told:
//     Com_Error  0x59AC50   void __cdecl (int errParm, const char* fmt, ...)
//     Sys_Error  0x5FE8C0   void __cdecl (const char* fmt, ...)
// plus a return-address chain from the caller's stack, which names the error site.
//
// The stubs are NAKED. At entry ESP points at the return address, so after
// pushfd+pushad (36 bytes) the original frame is at [esp+36]. We copy the return
// address and the first two arguments out, hand them to a plain C logger, restore
// everything and tail-jump to MinHook's trampoline -- so the engine still does
// whatever it was going to do, we just get to read the message first. Signature-
// agnostic in the sense that matters: we never assume the callee's convention, only
// that the caller pushed arguments right to left, which is true for the cdecl
// varargs these are.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "hook.hpp"

#include <cstdlib>
#include <string>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw::dedi {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

// Render a dword as a string if it points at readable printable ASCII.
std::string maybe_string(uint32_t v) {
    const auto* p = reinterpret_cast<const char*>(v);
    if (!v || !memory::is_readable(p, 1)) return {};
    std::string s;
    for (int i = 0; i < 160; ++i) {
        if (!memory::is_readable(p + i, 1)) break;
        const char c = p[i];
        if (c == '\0') return s;
        if (c == '\n' || c == '\r') { s += ' '; continue; }
        // Keep going through odd bytes rather than giving up: colour codes and
        // embedded control characters are normal in this engine's strings, and a
        // readable message with dots in it beats no message at all.
        const auto u = static_cast<unsigned char>(c);
        s += (u < 0x20 || u > 0x7E) ? '.' : c;
    }
    return s;
}

void log_error(const char* who, uintptr_t ret, uint32_t a1, uint32_t a2, uintptr_t caller_esp) {
    const std::string s1 = maybe_string(a1);
    const std::string s2 = maybe_string(a2);
    ENW_ERROR("=== %s TRAPPED ===", who);
    ENW_ERROR("  called from %08X", static_cast<unsigned>(ret));
    ENW_ERROR("  arg1 = %08X %s%s%s", a1, s1.empty() ? "" : "\"", s1.c_str(), s1.empty() ? "" : "\"");
    ENW_ERROR("  arg2 = %08X %s%s%s", a2, s2.empty() ? "" : "\"", s2.c_str(), s2.empty() ? "" : "\"");
    // If a pointer did not render, show the bytes -- the message is the whole point of
    // this component, so never leave with nothing.
    if (s1.empty() && memory::is_readable(reinterpret_cast<const void*>(a1), 32))
        ENW_ERROR("  arg1 bytes: %s", memory::hex_dump(a1, 32).c_str());
    if (s2.empty() && memory::is_readable(reinterpret_cast<const void*>(a2), 32))
        ENW_ERROR("  arg2 bytes: %s", memory::hex_dump(a2, 32).c_str());

    // Any further printf-style arguments, rendered when they look like strings.
    for (int i = 2; i < 8; ++i) {
        uint32_t v = 0;
        if (!memory::read(caller_esp + 4 + i * 4, &v)) break;
        const std::string sv = maybe_string(v);
        if (!sv.empty()) ENW_ERROR("  arg%d = %08X \"%s\"", i + 1, v, sv.c_str());
    }

    // Return-address chain from the caller's stack: names the error site.
    const auto text = memory::text_section();
    std::string chain;
    char buf[16];
    for (uintptr_t p = caller_esp; p < caller_esp + 0x200 && chain.size() < 130; p += 4) {
        uint32_t v = 0;
        if (!memory::read(p, &v)) break;
        if (text.contains(v)) { std::snprintf(buf, sizeof buf, "%08X ", v); chain += buf; }
    }
    ENW_ERROR("  stack .text chain: %s", chain.c_str());
}

void* g_com_error_tramp = nullptr;
void* g_sys_error_tramp = nullptr;

void __cdecl on_com_error(uintptr_t ret, uint32_t a1, uint32_t a2, uintptr_t esp) {
    log_error("Com_Error", ret, a1, a2, esp);
}
void __cdecl on_sys_error(uintptr_t ret, uint32_t a1, uint32_t a2, uintptr_t esp) {
    log_error("Sys_Error", ret, a1, a2, esp);
}

// esp+36 = original esp (pushfd 4 + pushad 32)
#define ENW_ERROR_STUB(name, handler, tramp)      \
    __declspec(naked) void name() {               \
        __asm { pushfd }                          \
        __asm { pushad }                          \
        __asm { lea  eax, [esp + 36] }            \
        __asm { push eax }                        \
        __asm { mov  eax, [esp + 36 + 4 + 8] }    \
        __asm { push eax }                        \
        __asm { mov  eax, [esp + 36 + 8 + 4] }    \
        __asm { push eax }                        \
        __asm { mov  eax, [esp + 36 + 12 + 0] }   \
        __asm { push eax }                        \
        __asm { call handler }                    \
        __asm { add  esp, 16 }                    \
        __asm { popad }                           \
        __asm { popfd }                           \
        __asm { jmp  dword ptr [tramp] }          \
    }

ENW_ERROR_STUB(com_error_stub, on_com_error, g_com_error_tramp)
ENW_ERROR_STUB(sys_error_stub, on_sys_error, g_sys_error_tramp)
#undef ENW_ERROR_STUB

enw::hook g_com_error_hook;
enw::hook g_sys_error_hook;

class error_trap_component final : public component {
public:
    const char* name() const override { return "dedi_error_trap"; }

    void post_init() override {
        install(t4::fn::Com_Error, &com_error_stub, g_com_error_hook, g_com_error_tramp, "Com_Error");
        install(0x5FE8C0,          &sys_error_stub, g_sys_error_hook, g_sys_error_tramp, "Sys_Error");
    }

private:
    static void install(uintptr_t addr, void* stub, enw::hook& h, void*& tramp, const char* label) {
        const uintptr_t live = enw::at(addr);
        if (!memory::looks_like_function(live)) {
            ENW_WARN("dedi_error_trap: %s 0x%08X does not look like a function (%s)",
                     label, static_cast<unsigned>(addr), memory::hex_dump(live, 8).c_str());
            return;
        }
        if (!h.create(live, stub, label) || !h.enable()) {
            ENW_WARN("dedi_error_trap: could not hook %s at 0x%08X", label,
                     static_cast<unsigned>(addr));
            return;
        }
        tramp = h.original<void*>();
        ENW_INFO("dedi_error_trap: %s trapped at 0x%08X", label, static_cast<unsigned>(addr));
    }
};

#else

class error_trap_component final : public component {
public:
    const char* name() const override { return "dedi_error_trap"; }
};

#endif

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::error_trap_component)
