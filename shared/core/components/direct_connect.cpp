// Direct connect: letting our client reach our own servers.
//
// THE PROBLEM, and why `127.0.0.1` is not the easy case people assume.
//
// Before sending `connect`, the client calls Demonware's getAuthTicket
// (0x57C0E0) and `Com_Error`s `PATCH_SERVER_AUTHFAIL` if it fails. `re` found
// the call is skipped for loopback, which is true -- but the guard at 0x642E4C
// is narrower than "it's on my machine". Read from our own dump:
//
//     mov  eax, [0x300FFF8]     ; netadr.type
//     cmp  eax, 2               ; NA_LOOPBACK
//     je   skip
//     test eax, eax             ; NA_BOT (0)
//     je   skip
//
// NA_LOOPBACK is the engine's IN-PROCESS loopback -- a listen server talking to
// its own client. **A second process on the same box is NA_IP (4), even at
// 127.0.0.1**, so a two-instance test on one machine takes the auth path in full
// and dies on a Demonware service that has been gone for years. With ENW-only
// networking on, our own DNS block makes it fail faster. Either way the symptom
// is a connect that never completes, which looks exactly like a networking bug
// and is not one.
//
// THE FIX, one site, five bytes. At 0x642E77:
//
//     E8 64 92 F3 FF    call 0x57C0E0        ->    B0 01        mov al, 1
//                                                  90 90 90     nop nop nop
//
// The two arguments are pushed before the call and cleaned by the `add esp, 8`
// after it, so replacing only the call keeps the stack balanced. The result is
// read as `test al, al; jne ok`, so a non-zero `al` takes the success path and
// skips the Com_Error. Nothing else in the function changes.
//
// THIS IS NOT DRM. SteamStub is the copy protection and we never touch it --
// we wait for it (see steamstub.cpp). This is the online-services auth ticket
// for joining a game server, for a service that no longer exists, on servers we
// run ourselves. It is the "direct-connect patch" of vault 99 §5.1.
//
// Lives in shared/core rather than client-dll on purpose: the join test uses a
// core-only build, and a dedicated server never executes CL_SendConnectPacket,
// so the patch is inert there.
//
// ENW_DIRECT_CONNECT=0 disables it.
#include "../component.hpp"

#include "../game_link.hpp"
#include "../logger.hpp"
#include "../memory.hpp"

#include "t4/addresses.hpp"

namespace enw {
namespace {

// The `call getAuthTicket` inside CL_SendConnectPacket.
constexpr uintptr_t kAuthCallSite = 0x642E77;

const uint8_t kExpected[5] = {0xE8, 0x64, 0x92, 0xF3, 0xFF};
const uint8_t kPatch[5] = {0xB0, 0x01, 0x90, 0x90, 0x90};  // mov al,1 ; nop x3

bool g_patched = false;

class direct_connect final : public component {
public:
    const char* name() const override { return "direct_connect"; }

    void post_unpack() override {
        char opt[8]{};
        ::GetEnvironmentVariableA("ENW_DIRECT_CONNECT", opt, sizeof(opt));
        if (opt[0] == '0') {
            ENW_INFO("direct_connect: disabled by ENW_DIRECT_CONNECT=0; a non-loopback connect "
                     "will Com_Error with PATCH_SERVER_AUTHFAIL");
            return;
        }

        const uintptr_t site = at(kAuthCallSite);

        // Refuse unless the site is byte-for-byte what we expect AND the call
        // really goes to getAuthTicket. Two independent checks, because writing
        // five bytes into the wrong place inside the connect path would be a
        // miserable thing to debug.
        uint8_t actual[5]{};
        if (!memory::read_raw(site, actual, sizeof(actual))) {
            ENW_ERROR("direct_connect: %08X is not readable; not patching",
                      static_cast<unsigned>(site));
            return;
        }
        if (memcmp(actual, kExpected, sizeof(actual)) != 0) {
            ENW_ERROR("direct_connect: %08X is %s, expected E8 64 92 F3 FF. The address map has "
                      "moved or somebody else patched it. NOT patching.",
                      static_cast<unsigned>(site), memory::hex_dump(site, 5).c_str());
            return;
        }
        const uintptr_t target = memory::call_target(site);
        if (target != at(t4::fn::DW_GetAuthTicket)) {
            ENW_ERROR("direct_connect: the call at %08X goes to %08X, not getAuthTicket %08X. "
                      "NOT patching.",
                      static_cast<unsigned>(site), static_cast<unsigned>(target),
                      static_cast<unsigned>(at(t4::fn::DW_GetAuthTicket)));
            return;
        }

        if (!memory::write_raw(site, kPatch, sizeof(kPatch))) {
            ENW_ERROR("direct_connect: could not write the patch at %08X",
                      static_cast<unsigned>(site));
            return;
        }
        g_patched = true;
        ENW_INFO("direct_connect: getAuthTicket short-circuited at %08X (call -> mov al,1). "
                 "A connect to a non-loopback address (including 127.0.0.1 from another "
                 "process) will no longer Com_Error PATCH_SERVER_AUTHFAIL.",
                 static_cast<unsigned>(site));
    }

    void post_init() override {
        if (!g_patched) return;
        game_link::get().send_log("info", "direct connect enabled (getAuthTicket bypassed)");
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::direct_connect)
