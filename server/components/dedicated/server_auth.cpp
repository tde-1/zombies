// The server half of the Demonware auth short-circuit.
//
// ---------------------------------------------------------------------------
// Why the client half alone was not enough
// ---------------------------------------------------------------------------
// shared/core/components/direct_connect.cpp already neutralises the CLIENT side:
// `CL_SendConnectPacket` calls Demonware's getAuthTicket 0x57C0E0 and Com_Errors
// PATCH_SERVER_AUTHFAIL if it fails, so we replace that one call with
// `mov al,1; nop x3` at 0x642E77.
//
// The client therefore sends a connect with no real ticket -- and `SV_DirectConnect`
// validates one. Run join10, with the co-op join gate finally open:
//
//   client   getchallenge            -> server  SVC_GetChallenge
//   client   CHALLENGERESPONSE: Got server licenseid f36072ab308c8331
//   client   connect + userinfo      -> server  SV_DirectConnect = 1
//   client   ERROR: No or bad challenge for address.
//
// Note what the challenge response actually carries: a **licence id**. This is not
// the plain Quake challenge number, it is Demonware's server-licence exchange. The
// check that fails is in SV_DirectConnect 0x62E3A0:
//
//     0062ED8A  lea ecx, [esi+0x58D28]     ; the last 0x18 bytes of client_s
//     0062ED91  lea edx, [esi+0x58D18]     ;   (sizeof client_s = 0x58D30)
//     0062ED98  lea ebp, [esi+0x58D20]
//     0062EDA5  push ebp / push eax / push edx / push ecx
//     0062EDA7  call 00582740              ; the Demonware ticket/licence validator
//     0062EDAC  add esp, 0x10              ; THE CALLER CLEANS
//     0062EDAF  test al, al
//     0062EDB1  jne 0062EE0A               ; non-zero -> accept and carry on
//     0062EDE5  mov eax, 0x886DA4          ; "error\nEXE_BAD_CHALLENGE" -> reject
//
// 0x582740 is squarely in the Demonware block (its only caller is SV_DirectConnect,
// and it opens with a 0x1EC-byte frame and two 0x80-byte buffer clears -- key and
// signature scratch).
//
// ---------------------------------------------------------------------------
// The fix: the same five bytes, on the other side
// ---------------------------------------------------------------------------
//     0062EDA7   E8 94 39 F5 FF   call 0x582740   ->   B0 01      mov al, 1
//                                                      90 90 90   nop x3
//
// The four arguments are pushed before the call and cleaned by the `add esp,0x10`
// after it, so replacing only the call leaves the stack balanced -- exactly the
// property direct_connect.cpp relies on, and it is read here rather than assumed:
// the component verifies both the call target and that `83 C4 10` follows.
//
// THIS IS NOT DRM. SteamStub is the copy protection and steamstub.cpp only ever
// waits for it. This is an online-services licence check, for a service that has
// not existed for years, on a server we run ourselves for our own clients. It is
// the exact mirror of a patch that is already in the tree and already reviewed.
//
// DEDICATED ONLY, and that matters: on a listen/solo game none of this runs, and
// we do not want a general "any ticket is fine" in a client build.
//
// ENW_DEDI_KEEP_AUTH=1 leaves it alone, so the rejection can be reproduced.
//
// UNVERIFIED AS OF WRITING: there is a SECOND `EXE_BAD_CHALLENGE` raise in the same
// function, at 0x62E75D, reached from an earlier path. If a connect still fails
// after this, that is the next place to look -- and the two are distinguishable
// because only this one is preceded by the 0x582740 call.
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"

#include <cstdlib>

namespace enw::dedi {
namespace {

// The `call 0x582740` inside SV_DirectConnect.
constexpr uintptr_t kAuthCallSite = 0x62EDA7;
constexpr uintptr_t kAuthTarget   = 0x582740;
const uint8_t kCleanup[3] = {0x83, 0xC4, 0x10};          // add esp, 0x10
const uint8_t kPatch[5]   = {0xB0, 0x01, 0x90, 0x90, 0x90};  // mov al,1 ; nop x3

class server_auth_component final : public component {
public:
    const char* name() const override { return "dedi_server_auth"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_KEEP_AUTH")) {
            ENW_WARN("dedi_server_auth: ENW_DEDI_KEEP_AUTH set - leaving SV_DirectConnect's "
                     "Demonware ticket check alone. Connects will be refused with "
                     "EXE_BAD_CHALLENGE.");
            return;
        }

        const uintptr_t site = enw::at(kAuthCallSite);

        const uintptr_t target = memory::call_target(site);
        if (target != enw::at(kAuthTarget)) {
            ENW_ERROR("dedi_server_auth: NOT patching. Call at 0x%08X targets 0x%08X, expected "
                      "0x%08X. Bytes: %s",
                      static_cast<unsigned>(kAuthCallSite), static_cast<unsigned>(target),
                      static_cast<unsigned>(enw::at(kAuthTarget)),
                      memory::hex_dump(site, 12).c_str());
            return;
        }

        // The caller must clean its own four arguments, or a five-byte replacement
        // unbalances the stack. Read it, do not assume it.
        uint8_t after[3] = {};
        if (!memory::read_raw(site + 5, after, sizeof after) ||
            after[0] != kCleanup[0] || after[1] != kCleanup[1] || after[2] != kCleanup[2]) {
            ENW_ERROR("dedi_server_auth: NOT patching. Expected `add esp,0x10` at 0x%08X so a "
                      "five-byte replacement is stack-neutral; found %02X %02X %02X.",
                      static_cast<unsigned>(kAuthCallSite + 5), after[0], after[1], after[2]);
            return;
        }

        if (!memory::write_raw(site, kPatch, sizeof kPatch)) {
            ENW_ERROR("dedi_server_auth: could not write to 0x%08X",
                      static_cast<unsigned>(kAuthCallSite));
            return;
        }

        ENW_INFO("dedi_server_auth: SV_DirectConnect's Demonware ticket check at 0x%08X "
                 "short-circuited (call 0x%08X -> mov al,1; nop x3). The `test al,al / jne` at "
                 "0x62EDAF now always takes the accept path, so a client whose getAuthTicket we "
                 "already stubbed is no longer rejected with EXE_BAD_CHALLENGE.",
                 static_cast<unsigned>(kAuthCallSite), static_cast<unsigned>(kAuthTarget));
    }
};

ENW_REGISTER_COMPONENT(server_auth_component)

}  // namespace
}  // namespace enw::dedi
