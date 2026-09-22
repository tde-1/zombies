// Where a dedicated server's Demonware (lobby) socket goes, and a log of every bind.
//
// WHY. Every headless instance opens TWO UDP sockets: its game port (`net_port`, 28960+)
// and a Demonware "game socket" that has always shown up on 3074, then 3075 for a second
// instance (vps.md §15). The box's third instance parked in Com_Init with neither socket
// open, and the reading at the time was "the lobby fallback is two ports wide". It is not.
//
// THE CALL GRAPH (decrypted 1.7 image, tools/re/t4map.py; docs/re/t4-sp-map.md §10):
//   0x78BF70  bdNetStartParams::bdNetStartParams -- `mov word [esi+2], 0x0C02` at
//             0x78BF9C: the requested game port is the constant 3074 (bytes
//             66 C7 46 02 02 0C, imm16 at 0x78BFA0). Called by 0x57E5D0 (the game's
//             Demonware bring-up) and 0x78ADB0.
//   0x78AF70  bdNetImpl::start(params) -> 0x78A1E0 findFreePort(addr) -> the real bind
//             through the socket's vtable; logs "Requested port %u, using port %u"
//             (bdLog, silent in retail).
//   0x78A1E0  bdNetImpl::findFreePort: for (i = 0; i < 100; ++i) { create a socket,
//             bind(port + i), close it; success -> return that port }. So the stock
//             fallback is ONE HUNDRED ports wide (3074..3173), not two.
//   0x777F70  bdSocket::bind -> htons (WSOCK32 #9, IAT 0x7EB3CC) -> bind (WSOCK32 #2,
//             IAT 0x7EB3E8); WSAEACCES / WSAEADDRINUSE / WSAEADDRNOTAVAIL -> -4.
//   0x600350 / 0x600B80  NET_IPSocket / the IPX socket, through the thunk 0x75A98A
//             (`jmp [0x7EB3E8]`) -- the same IAT slot, so one hook sees every bind.
//
// WHAT THIS DOES (dedicated only: the command line must carry `dedicated 1|2`):
//   1. Hooks WSOCK32 #2 (bind) through the import table, like no_msgbox hooks
//      MessageBoxA, and LOGS every AF_INET bind: the port asked for and what came back.
//      Behaviour is unchanged; this is the second, behavioural signal behind the reading
//      above, and it stays on because a bind that fails on a box is otherwise silent.
//   2. With ENW_LOBBY_PORT=<n> in the environment, rewrites the constant 3074 in the
//      params constructor to n (a two-byte patch, checked against the exact expected
//      instruction first). The engine then probes n, n+1, ... n+99 itself, so an
//      occupied port still falls forward exactly as stock does, and the engine KNOWS its
//      real port (a bind-time rewrite would leave it believing it had 3074).
//      The host agent sets n = 3074 + the instance's slot, so each instance asks for its
//      own port and two instances booting together never race for the same one.
// Unset ENW_LOBBY_PORT = stock behaviour (plus the log). ENW_NO_BIND_LOG=1 silences 1.
//
// Clean room: our own code.

#include "component.hpp"
#include "enw.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

namespace enw::dedi {
namespace {

constexpr uintptr_t kParamsPortStore = 0x78BF9C;          // mov word ptr [esi+2], 0x0C02
constexpr uint8_t kParamsPortBytes[6] = {0x66, 0xC7, 0x46, 0x02, 0x02, 0x0C};
constexpr uint16_t kStockLobbyPort = 3074;
constexpr uint16_t kProbeWidth = 100;                     // findFreePort 0x78A1E0: cmp edi, 0x64

constexpr uint16_t kWsockBindOrdinal = 2;                 // WSOCK32 #2 = bind (IAT 0x7EB3E8)

// sockaddr_in without dragging winsock2.h in after windows.h.
struct sockaddr_in4 {
    uint16_t family;
    uint16_t port_be;
    uint8_t addr[4];
};
constexpr uint16_t kAfInet = 2;

using bind_t = int(__stdcall*)(uintptr_t, const void*, int);
bind_t g_orig_bind = nullptr;
uint16_t g_lobby_base = kStockLobbyPort;                  // where the engine starts probing
bool g_log_binds = true;
bool g_dedicated = false;
volatile LONG g_binds = 0;

std::string env(const char* name) {
    char buf[64]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}

bool cmdline_dedicated() {
    const char* cmd = ::GetCommandLineA();
    if (!cmd) return false;
    const char* p = cmd;
    while ((p = std::strstr(p, "dedicated")) != nullptr) {
        p += 9;
        while (*p == ' ' || *p == '\t' || *p == '"') ++p;
        if (*p == '1' || *p == '2') return true;
    }
    return false;
}

uint16_t swap16(uint16_t v) { return static_cast<uint16_t>((v >> 8) | (v << 8)); }

int __stdcall bind_hook(uintptr_t s, const void* name, int namelen) {
    const int r = g_orig_bind(s, name, namelen);
    if (!g_log_binds || !name || namelen < static_cast<int>(sizeof(sockaddr_in4))) return r;
    const DWORD err = r == 0 ? 0 : ::GetLastError();     // WSAGetLastError == GetLastError
    const auto* a = static_cast<const sockaddr_in4*>(name);
    if (a->family != kAfInet) {
        ::SetLastError(err);
        return r;
    }
    const uint16_t port = swap16(a->port_be);
    const bool lobby = port >= g_lobby_base && port < g_lobby_base + kProbeWidth;
    const LONG n = ::InterlockedIncrement(&g_binds);
    if (r == 0) {
        ENW_INFO("lobby_port: bind #%ld %u.%u.%u.%u:%u ok%s", n, a->addr[0], a->addr[1],
                 a->addr[2], a->addr[3], port,
                 lobby ? (port == g_lobby_base ? " (lobby socket, the port asked for)"
                                               : " (lobby socket, fell forward)")
                       : "");
    } else {
        ENW_WARN("lobby_port: bind #%ld %u.%u.%u.%u:%u FAILED (WSA %lu)%s", n, a->addr[0],
                 a->addr[1], a->addr[2], a->addr[3], port, err,
                 lobby ? " (lobby socket; the engine tries the next port)" : "");
    }
    ::SetLastError(err);
    return r;
}

class lobby_port final : public component {
public:
    const char* name() const override { return "lobby_port"; }

    void post_load() override {
        if (!cmdline_dedicated()) {
            ENW_DEBUG("lobby_port: not a dedicated server; left alone");
            return;
        }
        g_dedicated = true;
        if (env("ENW_NO_BIND_LOG") == "1") {
            g_log_binds = false;
            return;
        }
        if (!memory::hook_import_ordinal("WSOCK32.dll", kWsockBindOrdinal,
                                         reinterpret_cast<void*>(&bind_hook),
                                         reinterpret_cast<void**>(&g_orig_bind))) {
            ENW_WARN("lobby_port: could not hook WSOCK32#2 (bind); binds are not logged");
            return;
        }
        ENW_INFO("lobby_port: bind log armed (WSOCK32#2)");
    }

    // The port constant lives in .text, which SteamStub still has encrypted in post_load
    // (measured on the box: the site read FF 24 F8 3A 98 4F there). post_unpack runs once
    // it is decrypted and well before Com_Init builds the Demonware params.
    void post_unpack() override {
        if (!g_dedicated) return;
        const std::string want = env("ENW_LOBBY_PORT");
        if (!want.empty()) {
            char* end = nullptr;
            const unsigned long v = std::strtoul(want.c_str(), &end, 10);
            if (!end || *end || v < 1024 || v > 65535u - kProbeWidth) {
                ENW_ERROR("lobby_port: ENW_LOBBY_PORT='%s' is not a port in 1024..%u; stock 3074",
                          want.c_str(), 65535u - kProbeWidth);
            } else {
                uint8_t cur[6]{};
                const uintptr_t site = at(kParamsPortStore);
                if (!memory::read_raw(site, cur, sizeof(cur)) ||
                    std::memcmp(cur, kParamsPortBytes, sizeof(cur)) != 0) {
                    ENW_ERROR("lobby_port: 0x%X is not `mov word [esi+2], 0x0C02` (%s); NOT "
                              "patched, the lobby socket stays on 3074+",
                              static_cast<unsigned>(kParamsPortStore),
                              memory::hex_dump(site, sizeof(cur)).c_str());
                } else {
                    const uint16_t port = static_cast<uint16_t>(v);
                    if (!memory::write(site + 4, port)) {
                        ENW_ERROR("lobby_port: could not write the port at 0x%X; stock 3074",
                                  static_cast<unsigned>(kParamsPortStore + 4));
                    } else {
                        g_lobby_base = port;
                        ENW_INFO("lobby_port: Demonware game socket asks for %u (ENW_LOBBY_PORT; "
                                 "stock 3074), the engine probes %u..%u itself",
                                 port, port, port + kProbeWidth - 1);
                    }
                }
            }
        } else {
            ENW_INFO("lobby_port: ENW_LOBBY_PORT unset; stock lobby port 3074 (probes 3074..3173)");
        }
    }
};

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::lobby_port)
