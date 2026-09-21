// Point the client's connect at a real UDP address instead of the in-process loopback.
//
// ---------------------------------------------------------------------------
// Why a two-process join on one box could never work before this
// ---------------------------------------------------------------------------
// `CL_ConnectLocal` 0x641730 is the only way a stock T4 SP client starts a
// connection -- there is no `connect` client command (docs/re/t4-sp-map.md §5),
// and CLL's source confirms no launcher in this scene adds one; Plutonium's
// `connect ip:port` lives inside Plutonium's own binary.
//
// But CL_ConnectLocal takes no address. It hard-codes one:
//
//     006417E7  push 0x86F0D4          ; "localhost"        (68 D4 F0 86 00)
//     006417EC  push 0x48AE3A0         ; clc.servername
//     006417F1  call 007AA9C0          ; strncpy(servername, "localhost", 0xFF)
//     ...
//     00641855  push 0x300FFF8         ; out netadr_s
//     0064187A  call 00679520          ; NET_StringToAdr(name in EAX, out on stack)
//     00641883  call 00642C80          ; CL_SendConnectPacket
//
// and NET_StringToAdr special-cases that exact string, read off the instructions:
//
//     00679531  edi = 0x86F0D4 ("localhost")
//     00679538  ecx = 10 ; repe cmpsb
//     00679541  jne 00679569           ; anything else -> the real parse
//     00679543  zero the 0x18-byte netadr_s
//     00679555  mov dword ptr [ebx], 2 ; netadr.type = 2 = NA_LOOPBACK
//     0067955B  return 1               ; ...and NO ip and NO port are ever written
//
// **NA_LOOPBACK is the engine's IN-PROCESS ring buffer**, which is also what
// direct_connect.cpp's auth guard reads (`cmp [0x300FFF8], 2`). So the connect
// packet never goes near a socket, and a second process on the same machine
// cannot be reached. Measured, run join5: the client called CL_ConnectLocal,
// `clc.state` went to 5 (connecting), the client logged
// `PROFILES: setting server info to 0.0.0.0:0` -- and the server's own counters
// read `SV_PacketEvent=3, SV_DirectConnect=0`, where all three packets were the
// harness's own oob.py probes. Zero packets from the client.
//
// ---------------------------------------------------------------------------
// The fix: one dword
// ---------------------------------------------------------------------------
// Rewrite the `imm32` of that `push` so it points at a string of ours instead.
// NET_StringToAdr then fails the `repe cmpsb`, takes the branch at 0x679569,
// splits on ':' (0x84B668) and resolves a real address and port.
//
// We patch the OPERAND ONLY -- the opcode stays `68`, the instruction stays five
// bytes, nothing is relocated and no calling convention is involved. The five
// bytes are verified before the write and the component refuses otherwise.
//
// The string lives in a static buffer in this DLL for the life of the process.
// It must outlive the patch, so it is a file-scope array and not a std::string.
//
// NOTE the OTHER "localhost" push at 0x641769: that one is a *comparison* on the
// `clc.state >= 6` branch ("are we already connected to localhost?"). A freshly
// launched client is at state 0 and takes the `jl` at 0x641767, so it never runs.
// We deliberately leave it alone -- changing it would alter reconnect behaviour
// we have not tested.
//
// Set ENW_CONNECT_ADDR=<host:port> to arm it. Unset, this component does nothing,
// so a listen/solo client keeps stock behaviour.
//
// Clean room: our own code, from our own dump.

#include "../component.hpp"

#include "../logger.hpp"
#include "../memory.hpp"

#include <cstdlib>
#include <cstring>
#include <windows.h>

namespace enw {
namespace {

// The `push "localhost"` inside CL_ConnectLocal, on the state < 6 connect path.
constexpr uintptr_t kPushSite = 0x6417E7;
const uint8_t kExpected[5] = {0x68, 0xD4, 0xF0, 0x86, 0x00};  // push 0x86F0D4

// ---------------------------------------------------------------------------
// ...and the client state it leaves behind, which skips the challenge handshake
// ---------------------------------------------------------------------------
// With a real address in place, run join7 got the connect packet all the way to
// the server -- SV_DirectConnect fired for the first time -- and the server
// rejected it:
//
//     ERROR: No or bad challenge for address.
//
// CL_SendConnectPacket 0x642C80 is really CL_CheckForResend: it runs per frame
// and dispatches on clc.state:
//
//     00642D00  sub esi, 4
//     00642D03  je 00643104        ; state 4 -> send "getchallenge"
//     00642D09  sub esi, 1
//     00642D0C  je 00642E4C        ; state 5 -> send "connect" + userinfo
//     00642D12  sub esi, 2
//     00642D15  je 00642D31        ; state 7 -> ...
//
// CL_ConnectLocal hard-sets state **5** at 0x64185F, i.e. "I already have a
// challenge, send the connect". That is correct for the in-process loopback it
// was written for -- SV_DirectConnect does not challenge NA_LOOPBACK. Over a real
// socket it is wrong, and the server says so.
//
// Patch that one immediate 5 -> 4. CL_ConnectLocal then leaves the client in
// "connecting", its own call to CL_SendConnectPacket sends `getchallenge`
// instead, SVC_GetChallenge 0x62DB60 answers `challengeResponse`,
// CL_ConnectionlessPacket 0x643380 stores it and moves the state on, and the
// connect that follows carries a challenge the server accepts.
//
//     0064185F  C7 05 2C 84 05 03 | 05 00 00 00    mov dword [0x305842C], 5
//                                   ^^ imm32 at 0x641865
constexpr uintptr_t kStateImm = 0x641865;
constexpr uint32_t  kStateConnecting = 4;   // sends getchallenge
constexpr uint32_t  kStateChallenged = 5;   // sends connect (what stock writes)

// strncpy at 0x6417F1 copies at most 0xFF bytes into clc.servername.
char g_address[128] = {};

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

class connect_address final : public component {
public:
    const char* name() const override { return "connect_address"; }

    void post_unpack() override {
        const char* want = std::getenv("ENW_CONNECT_ADDR");
        if (!want || !*want) return;

        // A dedicated server never calls CL_ConnectLocal, and dedi's
        // local_client.cpp deliberately stubs that call site out. Patching there
        // would be inert but confusing, so do not.
        if (is_dedicated_process()) {
            ENW_INFO("connect_address: dedicated process; leaving CL_ConnectLocal alone");
            return;
        }
        if (std::strlen(want) >= sizeof g_address) {
            ENW_ERROR("connect_address: ENW_CONNECT_ADDR is too long (%zu bytes, max %zu)",
                      std::strlen(want), sizeof g_address - 1);
            return;
        }
        // "localhost" would resolve straight back to NA_LOOPBACK and undo the point.
        if (_stricmp(want, "localhost") == 0) {
            ENW_ERROR("connect_address: ENW_CONNECT_ADDR=localhost resolves to NA_LOOPBACK "
                      "(NET_StringToAdr 0x679520 special-cases that exact string), which is the "
                      "in-process ring buffer. Use 127.0.0.1:<port>.");
            return;
        }
        std::strncpy(g_address, want, sizeof g_address - 1);

        const uintptr_t site = enw::at(kPushSite);
        uint8_t got[5] = {};
        if (!memory::read_raw(site, got, sizeof got) ||
            std::memcmp(got, kExpected, sizeof got) != 0) {
            ENW_ERROR("connect_address: NOT patching 0x%08X. Expected `push 0x86F0D4` "
                      "(68 D4 F0 86 00), found %s",
                      static_cast<unsigned>(kPushSite), memory::hex_dump(site, 8).c_str());
            return;
        }

        const auto ptr = reinterpret_cast<uint32_t>(&g_address[0]);
        if (!memory::write<uint32_t>(site + 1, ptr)) {
            ENW_ERROR("connect_address: could not write the push operand at 0x%08X",
                      static_cast<unsigned>(kPushSite + 1));
            return;
        }

        // ...and make it start from "connecting" so the challenge handshake happens.
        uint32_t state = 0;
        if (!memory::read(enw::at(kStateImm), &state) || state != kStateChallenged) {
            ENW_ERROR("connect_address: the client-state immediate at 0x%08X is %u, expected %u. "
                      "Address patched but the challenge handshake will still be skipped, so the "
                      "server will answer 'No or bad challenge for address.'",
                      static_cast<unsigned>(kStateImm), state, kStateChallenged);
        }
        else if (!memory::write<uint32_t>(enw::at(kStateImm), kStateConnecting)) {
            ENW_ERROR("connect_address: could not write the client-state immediate at 0x%08X",
                      static_cast<unsigned>(kStateImm));
        }
        else {
            ENW_INFO("connect_address: CL_ConnectLocal will leave the client in state %u "
                     "(connecting) instead of %u, so CL_CheckForResend 0x642C80 sends "
                     "'getchallenge' first and the connect that follows carries a challenge.",
                     kStateConnecting, kStateChallenged);
        }

        ENW_INFO("connect_address: CL_ConnectLocal will now connect to '%s' instead of "
                 "\"localhost\" (push operand at 0x%08X -> 0x%08X). NET_StringToAdr only returns "
                 "NA_LOOPBACK for the literal string \"localhost\", so this is what makes a "
                 "second-process join reach a socket at all.",
                 g_address, static_cast<unsigned>(kPushSite + 1), ptr);
    }
};

ENW_REGISTER_COMPONENT(enw::connect_address)

}  // namespace
}  // namespace enw
