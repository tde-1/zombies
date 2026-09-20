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
// WHAT THIS DOES NOT DO YET. The OOB (connectionless) packet filter belongs on
// `CL_ConnectionlessPacket` (0x643380) and the `connect`/`reconnect` lockdown
// needs the command registration path. Both need signatures I am not willing to
// guess at: I read 0x643380's prologue out of our dump and it takes a 0x464-byte
// frame with at least one stack argument and register-passed state, which is
// exactly the kind of custom convention where a wrong detour gives you an
// intermittent crash three hours later. Asked `re` for them on the board.
// Meanwhile the launcher passes `cl_allowDownload 0` and friends, which closes
// the in-game download path without any hooking at all.
#include "../../shared/core/component.hpp"

#include "../../shared/core/game_link.hpp"
#include "../../shared/core/logger.hpp"
#include "../../shared/core/memory.hpp"

#include <winsock2.h>

namespace enw {
namespace {

// WSOCK32.dll ordinals (stable since Winsock 1.1).
constexpr uint16_t kOrdinal_gethostbyname = 52;

using gethostbyname_t = hostent*(__stdcall*)(const char*);
gethostbyname_t g_original_gethostbyname = nullptr;

volatile LONG g_lookups = 0;
volatile LONG g_blocked = 0;
bool g_strict = false;
std::vector<std::string> g_allowed;

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
    }

    void post_init() override {
        ENW_INFO("net: %ld DNS lookup(s), %ld blocked",
                 ::InterlockedCompareExchange(&g_lookups, 0, 0),
                 ::InterlockedCompareExchange(&g_blocked, 0, 0));
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::network)
