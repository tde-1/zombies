// Send game packets as plain UDP instead of through Demonware's socket router.
//
// ---------------------------------------------------------------------------
// The wall this removes
// ---------------------------------------------------------------------------
// Run join6: with connect_address.cpp pointing CL_ConnectLocal at a real address,
// the client finally produced real connect packets -- and the engine threw them
// away itself, about once a second, without ever touching a socket:
//
//     Error: DROPPING 340 byte packet because we're still connecting to the
//            remote address (addrHandle=0, socketRouter=1)
//     Error: Sys_SendPacket: NO ERROR
//
// That message is at 0x86F5B8 and is printed from **0x57ED5C**, inside the
// Demonware send wrapper 0x57EC90 (`bdSocketRouter::sendTo`'s caller):
//
//     0057ECB9  lea ecx, [eax*4 + 0x48886F8]   ; the bdAddrHandle table, stride 0x24, 0x68 entries
//     0057ECC5  call 005805E0                  ; fetch the handle for this peer -> esi
//     0057ECD0  call 0057E2F0 / 0078A430       ; the socket router -> edi
//     0057ECE4  je 0057ED5C                    ; !esi -> DROP
//     0057ECE8  je 0057ED5C                    ; !edi -> DROP
//
// `addrHandle=0` means **there is no bdAddrHandle for the destination**. One is
// only created by a Demonware-level "connect" to that peer, which needs a live
// Demonware session, for a service that has not existed for years. There is no
// amount of retrying that gets one.
//
// ---------------------------------------------------------------------------
// The lever: Sys_SendPacket already has a raw path
// ---------------------------------------------------------------------------
// 0x6000B0 is `Sys_SendPacket(data /*EAX*/, len /*[ebp+8]*/, netadr_s by value
// /*[ebp+0xC]..[ebp+0x23]*/, useDemonware /*[ebp+0x24]*/)`:
//
//     006000C0  switch (to.type):  3,4 -> socket [0x22BEBD0];  5,6 -> socket [0x22BD9EC]
//                                  else Com_Error("Sys_SendPacket: bad address type")
//     00600105  cmp byte ptr [ebp+0x24], 0
//     00600109  je 0060013F                    ; ZERO -> THE RAW PATH
//     0060010B..00600132  copy the netadr, call 0057EC90   ; the Demonware path (drops)
//     0060013F  call 005FFCD0                  ; NetadrToSockadr
//     006001B2  push 0x10 / &sockaddr / 0 / data / len
//     006001C0  push esi ; call sendto         ; a plain Winsock sendto
//
// So the engine can already send raw UDP -- that is how the server's
// `statusResponse` reached our oob.py probe. The Demonware branch is chosen by
// one byte of one argument, forwarded straight from NET_SendPacket's `bl`.
//
// **The patch is two bytes**: make the conditional jump at 0x600109
// unconditional, so every packet takes the raw path.
//
//     00600109  74 34   je  0060013F    ->    EB 34   jmp 0060013F
//
// Nothing is relocated, no argument is reinterpreted, and the branch target is
// unchanged -- we only remove the condition. Both bytes are verified first.
//
// WHAT THIS DOES NOT DO. It does not touch SteamStub (steamstub.cpp waits for
// that, never modifies it) and it is not a copy-protection bypass. It routes our
// own traffic between our own processes over a normal socket instead of through a
// dead online service's relay. It is the same class of change as
// direct_connect.cpp, and the reason Plutonium's T4 client cannot be "the stock
// exe plus a DLL" -- they had to do this inside their own binary.
//
// CAVEATS, both untested and both worth watching:
//   * netadr types 5 and 6 use the OTHER socket ([0x22BD9EC]) and may be genuinely
//     Demonware-routed address kinds. We only ever produce type 4 (NA_IP) via
//     connect_address.cpp, but if something else in the engine sends to a 5/6
//     address it will now go raw and may simply fail. Watch for
//     `Sys_SendPacket: bad address type`.
//   * the raw path has a second branch at 0x60014B: when `[0x46E50A8] != 0` AND
//     the address is type 4, it prepends a 10-byte header `{0,0,0,1, ip, port}`
//     from 0x22BDA40 and sends `len + 10`. If the two sides disagree about that
//     header the packets will arrive and be rejected as malformed rather than not
//     arrive at all -- a different symptom, so it is distinguishable.
//
// ENW_RAW_SOCKETS=1 arms it. It is OPT-IN, not default, because it changes how
// every packet in the process is sent.
//
// Clean room: our own code, from our own dump and our own logs.

#include "../component.hpp"

#include "../logger.hpp"
#include "../memory.hpp"

#include <cstdlib>

namespace enw {
namespace {

// The `je` that picks the raw path in Sys_SendPacket.
constexpr uintptr_t kBranchSite = 0x600109;
const uint8_t kExpected[2] = {0x74, 0x34};   // je  0x60013F
const uint8_t kPatch[2]    = {0xEB, 0x34};   // jmp 0x60013F

class raw_sockets final : public component {
public:
    const char* name() const override { return "raw_sockets"; }

    void post_unpack() override {
        const char* on = std::getenv("ENW_RAW_SOCKETS");
        if (!on || *on == '0') return;

        const uintptr_t site = enw::at(kBranchSite);
        uint8_t got[2] = {};
        if (!memory::read_raw(site, got, sizeof got) ||
            got[0] != kExpected[0] || got[1] != kExpected[1]) {
            ENW_ERROR("raw_sockets: NOT patching 0x%08X. Expected `je +0x34` (74 34), found "
                      "%02X %02X. Context: %s",
                      static_cast<unsigned>(kBranchSite), got[0], got[1],
                      memory::hex_dump(site - 4, 16).c_str());
            return;
        }
        if (!memory::write_raw(site, kPatch, sizeof kPatch)) {
            ENW_ERROR("raw_sockets: could not write to 0x%08X",
                      static_cast<unsigned>(kBranchSite));
            return;
        }
        ENW_INFO("raw_sockets: every packet now goes out as plain UDP (`je` -> `jmp` at 0x%08X, "
                 "so Sys_SendPacket always takes the sendto path at 0x60013F). The Demonware "
                 "bdSocketRouter branch that was dropping every connect packet with "
                 "'addrHandle=0' is no longer reachable.",
                 static_cast<unsigned>(kBranchSite));
    }
};

ENW_REGISTER_COMPONENT(enw::raw_sockets)

}  // namespace
}  // namespace enw
