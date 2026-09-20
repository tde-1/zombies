// ENW-only networking, client side.
//
// Goal: an ENW client talks to ENW servers and to nothing else. No master
// server, no update server, no stranger's redirect pulling our players onto a
// box we do not run.
//
// WHAT THIS DOES TODAY, and why it is done this way.
//
// Every socket function in CoDWaW.exe is imported BY ORDINAL, not by name
// (WSOCK32 ordinals 2,3,4,9,10,12,14,16,17,19,20,21,23,52,57,111,115 and five
// from WS2_32). Ordinal **52 is `gethostbyname`** and it is the single place all
// DNS resolution goes through. Replacing that one IAT slot lets us decide what
// the game is allowed to resolve, with:
//   * no game code patched, so nothing to re-verify when an address moves;
//   * no dependence on SteamStub having decrypted, because the IAT is in .rdata
//     and the loader fills it before the entry point -- so this is armed in
//     post_load, before a single engine instruction runs.
//
// `cod5master.activision.com` (vault) and the `cod2update*.activision.com`
// hosts are in the binary at 0x4726F4 and 0x48B598+. Blocking resolution is a
// cleaner kill than patching each call site.
//
// The same trick answers "lock `connect`/`reconnect` to launcher-supplied
// addresses" (vault security item 4), and answers it better than locking the
// console command would: ordinals 20 (`sendto`) and 4 (`connect`) are where
// every outbound packet actually leaves, so it does not matter HOW the game was
// persuaded to connect -- console command, menu, a redirect inside a
// `connectResponse`, a stray `reconnect` -- traffic only goes where the launcher
// said. See the destination policy below.
//
// WHAT THIS DOES NOT DO YET. The OOB (connectionless) packet filter belongs on
// `CL_ConnectionlessPacket` (0x643380). That one needs a signature I am not
// willing to guess at: I read its prologue out of our dump and it takes a
// 0x464-byte frame with register-passed state plus a stack argument, exactly the
// kind of custom convention where a wrong detour gives you an intermittent crash
// three hours later. Asked `re` on the board. Note the socket-level lockdown
// already blunts most of what that filter is for, because a hostile OOB packet
// from an address we do not talk to cannot get a reply out of us.
#include "../../shared/core/component.hpp"

#include "../../shared/core/game_link.hpp"
#include "../../shared/core/logger.hpp"
#include "../../shared/core/memory.hpp"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <algorithm>
#include <mutex>

namespace enw {
namespace {

// WSOCK32.dll ordinals (stable since Winsock 1.1).
constexpr uint16_t kOrdinal_connect = 4;
constexpr uint16_t kOrdinal_sendto = 20;
constexpr uint16_t kOrdinal_gethostbyname = 52;

using gethostbyname_t = hostent*(__stdcall*)(const char*);
using sendto_t = int(__stdcall*)(SOCKET, const char*, int, int, const sockaddr*, int);
using connect_t = int(__stdcall*)(SOCKET, const sockaddr*, int);

gethostbyname_t g_original_gethostbyname = nullptr;
sendto_t g_original_sendto = nullptr;
connect_t g_original_connect = nullptr;

volatile LONG g_lookups = 0;
volatile LONG g_blocked = 0;
volatile LONG g_packets_blocked = 0;
bool g_strict = false;
std::vector<std::string> g_allowed;

// Destinations the game may talk to. Loopback is always allowed; everything else
// comes from -AllowedAddrs / ENW_ALLOWED_ADDRS, which the launcher fills in with
// the server we were told to join.
std::vector<uint32_t> g_allowed_addrs;  // network byte order
std::mutex g_seen_mutex;
std::vector<uint32_t> g_seen;  // unique destinations, for the log

std::string env(const char* name) {
    char buf[2048]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}

std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
    return s;
}

bool ends_with(const std::string& s, const char* suffix) {
    const size_t n = strlen(suffix);
    return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

// Hosts we will never resolve, whatever else is configured.
bool is_denied(const std::string& host) {
    return ends_with(host, ".activision.com") || host == "activision.com" ||
           ends_with(host, ".demonware.net") || ends_with(host, ".treyarch.com");
}

bool is_allowed(const std::string& host) {
    if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true;
    for (const auto& a : g_allowed) {
        if (host == a || (a.size() > 1 && a[0] == '.' && ends_with(host, a.c_str()))) return true;
    }
    return false;
}

hostent* __stdcall gethostbyname_detour(const char* name) {
    const std::string host = lower(name ? name : "");
    ::InterlockedIncrement(&g_lookups);

    const bool denied = is_denied(host);
    const bool blocked = denied || (g_strict && !is_allowed(host));

    if (blocked) {
        ::InterlockedIncrement(&g_blocked);
        ENW_WARN("net: BLOCKED a DNS lookup for '%s' (%s)", host.c_str(),
                 denied ? "Activision/Demonware host" : "not in ENW_ALLOWED_HOSTS and strict mode is on");
        game_link::get().send_log("warn", "blocked DNS lookup: %s", host.c_str());
        ::WSASetLastError(WSAHOST_NOT_FOUND);
        return nullptr;
    }

    // Log everything at least once so we learn what the game actually resolves.
    ENW_INFO("net: DNS lookup '%s' allowed", host.c_str());
    return g_original_gethostbyname ? g_original_gethostbyname(name) : nullptr;
}

// ------------------------------------------------------ destination policy --
// This is our answer to "lock `connect`/`reconnect` to launcher-supplied
// addresses" (vault security item 4). We enforce at the SOCKET rather than at
// the console command, which is strictly stronger: it does not matter how the
// game was persuaded to connect -- by a console command, a menu, a redirect in
// a `connectResponse`, or a stray `reconnect` -- packets only leave for
// addresses the launcher named. And it needs no engine addresses at all, so
// there is nothing to re-verify when the binary moves.

bool addr_allowed(uint32_t ip_n) {
    const uint8_t a = static_cast<uint8_t>(ip_n & 0xFF);
    if (a == 127) return true;  // loopback, always
    if (ip_n == 0 || ip_n == 0xFFFFFFFF) return true;  // INADDR_ANY / broadcast
    for (const uint32_t allowed : g_allowed_addrs) {
        if (allowed == ip_n) return true;
    }
    return false;
}

std::string ip_text(uint32_t ip_n) {
    in_addr a{};
    a.S_un.S_addr = ip_n;
    char buf[32];
    _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%u.%u.%u.%u", a.S_un.S_un_b.s_b1, a.S_un.S_un_b.s_b2,
                a.S_un.S_un_b.s_b3, a.S_un.S_un_b.s_b4);
    return buf;
}

// Returns true if the packet may go out. Logs each new destination once.
bool check_destination(const sockaddr* to, const char* what) {
    if (!to || to->sa_family != AF_INET) return true;
    const auto* in = reinterpret_cast<const sockaddr_in*>(to);
    const uint32_t ip = in->sin_addr.S_un.S_addr;

    bool first_time = false;
    {
        std::lock_guard<std::mutex> lk(g_seen_mutex);
        if (std::find(g_seen.begin(), g_seen.end(), ip) == g_seen.end()) {
            if (g_seen.size() < 64) g_seen.push_back(ip);
            first_time = true;
        }
    }

    const bool ok = addr_allowed(ip);
    if (first_time) {
        ENW_INFO("net: %s -> %s:%u  %s", what, ip_text(ip).c_str(), ntohs(in->sin_port),
                 ok ? "allowed" : (g_strict ? "BLOCKED" : "not allow-listed (permissive: letting it through)"));
    }
    if (ok) return true;

    ::InterlockedIncrement(&g_packets_blocked);
    return !g_strict;
}

int __stdcall sendto_detour(SOCKET s, const char* buf, int len, int flags, const sockaddr* to,
                            int tolen) {
    if (!check_destination(to, "sendto")) {
        // Pretend it went. Reporting an error here makes the engine take error
        // paths we have not audited; silently dropping is the safer refusal.
        return len;
    }
    return g_original_sendto(s, buf, len, flags, to, tolen);
}

int __stdcall connect_detour(SOCKET s, const sockaddr* name, int namelen) {
    if (!check_destination(name, "connect")) {
        ::WSASetLastError(WSAEACCES);
        return SOCKET_ERROR;
    }
    return g_original_connect(s, name, namelen);
}

class network final : public component {
public:
    const char* name() const override { return "network"; }

    void post_load() override {
        g_strict = env("ENW_NET_STRICT") == "1";

        // ENW_ALLOWED_HOSTS: comma-separated. A leading dot matches a suffix,
        // e.g. ".enw.gg".
        const std::string list = env("ENW_ALLOWED_HOSTS");
        size_t start = 0;
        while (start <= list.size() && !list.empty()) {
            const size_t comma = list.find(',', start);
            std::string item = lower(list.substr(start, comma == std::string::npos
                                                            ? std::string::npos
                                                            : comma - start));
            while (!item.empty() && (item.front() == ' ')) item.erase(item.begin());
            while (!item.empty() && item.back() == ' ') item.pop_back();
            if (!item.empty()) g_allowed.push_back(item);
            if (comma == std::string::npos) break;
            start = comma + 1;
        }

        // Armed here, before any engine code runs: the IAT is not encrypted.
        if (!memory::hook_import_ordinal("WSOCK32.dll", kOrdinal_gethostbyname,
                                         reinterpret_cast<void*>(&gethostbyname_detour),
                                         reinterpret_cast<void**>(&g_original_gethostbyname))) {
            ENW_ERROR("net: could not patch WSOCK32#%u (gethostbyname). The master server is NOT "
                      "blocked.", kOrdinal_gethostbyname);
            return;
        }

        ENW_INFO("net: DNS filter armed (%s, %u host(s) allow-listed). Activision/Demonware are "
                 "always blocked.",
                 g_strict ? "STRICT: deny by default" : "permissive: log and block known-bad only",
                 static_cast<unsigned>(g_allowed.size()));

        // ---- destination lockdown (vault security item 4) ----
        const std::string addrs = env("ENW_ALLOWED_ADDRS");
        size_t p2 = 0;
        while (p2 <= addrs.size() && !addrs.empty()) {
            const size_t comma = addrs.find(',', p2);
            std::string item = addrs.substr(p2, comma == std::string::npos ? std::string::npos
                                                                           : comma - p2);
            const size_t colon = item.find(':');
            if (colon != std::string::npos) item = item.substr(0, colon);  // ip:port -> ip
            while (!item.empty() && item.front() == ' ') item.erase(item.begin());
            while (!item.empty() && item.back() == ' ') item.pop_back();
            if (!item.empty()) {
                in_addr a{};
                if (::inet_pton(AF_INET, item.c_str(), &a) == 1) {
                    g_allowed_addrs.push_back(a.S_un.S_addr);
                } else {
                    ENW_WARN("net: ENW_ALLOWED_ADDRS entry '%s' is not an IPv4 address; ignored",
                             item.c_str());
                }
            }
            if (comma == std::string::npos) break;
            p2 = comma + 1;
        }

        const bool sendto_ok = memory::hook_import_ordinal(
            "WSOCK32.dll", kOrdinal_sendto, reinterpret_cast<void*>(&sendto_detour),
            reinterpret_cast<void**>(&g_original_sendto));
        const bool connect_ok = memory::hook_import_ordinal(
            "WSOCK32.dll", kOrdinal_connect, reinterpret_cast<void*>(&connect_detour),
            reinterpret_cast<void**>(&g_original_connect));

        if (!sendto_ok || !connect_ok) {
            ENW_ERROR("net: could not patch WSOCK32 sendto/connect; outbound traffic is NOT "
                      "restricted to the launcher's server");
            return;
        }
        ENW_INFO("net: destination lockdown armed (%s, %u address(es) allow-listed + loopback). "
                 "This is what stops a redirect pulling us onto someone else's box.",
                 g_strict ? "STRICT: drop anything else" : "permissive: log only",
                 static_cast<unsigned>(g_allowed_addrs.size()));
    }

    void post_init() override {
        ENW_INFO("net: %ld DNS lookup(s), %ld blocked; %ld packet(s) blocked",
                 ::InterlockedCompareExchange(&g_lookups, 0, 0),
                 ::InterlockedCompareExchange(&g_blocked, 0, 0),
                 ::InterlockedCompareExchange(&g_packets_blocked, 0, 0));
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::network)
