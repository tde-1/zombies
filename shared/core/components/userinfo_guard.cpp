// Sanitising player names and userinfo (vault security item 7).
//
// A connecting client controls its own `name` and its whole `userinfo` string,
// and both get copied into `client_s` and then used all over the engine: console
// prints, the scoreboard, the game log, server commands, and -- the dangerous
// one -- as fields in `\key\value\` info strings that other code re-parses. The
// classic Q3-lineage bugs here are a name containing a quote or a backslash
// (which injects a key into an info string), a control character or a newline
// (which forges a line in the game log, and IW4MAdmin-style parsers read that
// log), and a `%` (which reaches a printf-family format somewhere eventually).
//
// WHY IT IS DONE ON THE FRAME TICK, and not in SV_DirectConnect. We do not have
// a verified signature for SV_DirectConnect (0x62E3A0) and I am not guessing at
// one on the connect path. We DO have, all verified: `svs` (0x23D5C80),
// `svs.clients` (+0x171410), the client stride (0x58D30), `client_s.userinfo`
// (+0x6F0) and `client_s.name` (+0x11548). So we sweep the client slots from the
// per-frame tick and fix anything hostile in place. A name is therefore hostile
// for at most one frame, during which nothing has yet printed it -- the connect
// print happens later in the same frame path -- and this needs no new addresses.
// When `re` lands SV_DirectConnect we should move the same check earlier; the
// sanitiser itself will not change.
//
// SAFETY RULE: we only ever SHORTEN or REPLACE BYTES IN PLACE. Never grow.
// We do not know the exact capacity of either buffer, so nothing here can
// overflow one even if an offset is wrong -- the worst case is that we scribble
// a few harmless characters over a string that was not what we thought it was.
#include "../component.hpp"

#include "../frame.hpp"
#include "../game_link.hpp"
#include "../logger.hpp"
#include "../memory.hpp"

#include "t4/addresses.hpp"
#include "t4/structs.hpp"

namespace enw {
namespace {

// T4 keeps 4 client slots (vault: every snapshot array is [4]).
constexpr int kMaxClients = 4;
constexpr size_t kMaxNameLen = 32;      // MAX_NAME_LENGTH in this lineage
constexpr size_t kMaxUserinfoLen = 1024;  // MAX_INFO_STRING; we only ever truncate below it

volatile LONG g_name_fixes = 0;
volatile LONG g_userinfo_fixes = 0;
bool g_armed = false;

bool server_up() {
    const uintptr_t svs = at(t4::var::svs);
    if (!memory::is_readable(reinterpret_cast<void*>(svs + t4::svs_off::initialized), 4)) return false;
    int initialized = 0;
    if (!memory::read(svs + t4::svs_off::initialized, &initialized)) return false;
    return initialized != 0;
}

uintptr_t client_slot(int i) {
    return at(t4::var::svs) + t4::svs_off::clients + static_cast<size_t>(i) * t4::client_off::stride;
}

// True if the byte is safe to keep in a name or an info value.
bool byte_ok(unsigned char c) {
    if (c < 0x20 || c == 0x7F) return false;  // control chars, incl. \r \n \t
    switch (c) {
        case '"':   // closes a quoted argument
        case '\\':  // separates keys in an info string -- the injection character
        case ';':   // separates console commands
        case '%':   // printf family
            return false;
        default:
            return true;
    }
}

// Replace unsafe bytes in place and truncate to `cap`. Returns how many bytes
// were changed or removed. Never writes past the terminator it found.
int scrub(char* s, size_t cap) {
    if (!s) return 0;
    int changed = 0;
    size_t i = 0;
    for (; i < cap && s[i]; ++i) {
        if (!byte_ok(static_cast<unsigned char>(s[i]))) {
            s[i] = '_';
            ++changed;
        }
    }
    if (i == cap && s[i] != '\0') {
        // Overlong: cut it. We are shortening, so this is always in bounds.
        s[cap - 1] = '\0';
        ++changed;
    }
    return changed;
}

// A name that is empty, or nothing but colour codes and spaces, is unusable on a
// scoreboard and is a classic impersonation trick. Give it something printable.
bool name_is_blank(const char* s) {
    for (size_t i = 0; s[i]; ++i) {
        if (s[i] == '^' && s[i + 1]) { ++i; continue; }  // skip ^N colour code
        if (s[i] != ' ') return false;
    }
    return true;
}

void sweep(uint64_t) {
    if (!g_armed || !server_up()) return;

    for (int i = 0; i < kMaxClients; ++i) {
        const uintptr_t base = client_slot(i);

        auto* name = reinterpret_cast<char*>(base + t4::client_off::name);
        if (memory::is_readable(name, kMaxNameLen)) {
            const int fixed = scrub(name, kMaxNameLen);
            if (fixed) {
                ::InterlockedAdd(&g_name_fixes, fixed);
                ENW_WARN("userinfo_guard: sanitised %d byte(s) in slot %d's name -> '%s'", fixed, i,
                         name);
                game_link::get().send_log("warn", "sanitised player name in slot %d", i);
            }
            if (name[0] && name_is_blank(name)) {
                _snprintf_s(name, kMaxNameLen, _TRUNCATE, "unnamed%d", i);
                ::InterlockedIncrement(&g_name_fixes);
                ENW_WARN("userinfo_guard: slot %d had a blank/colour-only name; renamed", i);
            }
        }

        auto* info = reinterpret_cast<char*>(base + t4::client_off::userinfo);
        if (memory::is_readable(info, kMaxUserinfoLen)) {
            // The userinfo string is \key\value\key\value..., so backslashes are
            // structural here and must NOT be scrubbed. Only the genuinely
            // dangerous bytes go: control characters and quotes.
            int fixed = 0;
            for (size_t k = 0; k < kMaxUserinfoLen && info[k]; ++k) {
                const auto c = static_cast<unsigned char>(info[k]);
                if (c < 0x20 || c == 0x7F || c == '"') {
                    info[k] = '_';
                    ++fixed;
                }
            }
            if (fixed) {
                ::InterlockedAdd(&g_userinfo_fixes, fixed);
                ENW_WARN("userinfo_guard: sanitised %d byte(s) in slot %d's userinfo", fixed, i);
            }
        }
    }
}

class userinfo_guard final : public component {
public:
    const char* name() const override { return "userinfo_guard"; }

    void post_unpack() override {
        // Only meaningful where there are clients, but it costs a handful of
        // byte comparisons per frame and running it everywhere is one less
        // conditional to get wrong.
        if (!memory::is_readable(reinterpret_cast<void*>(at(t4::var::svs)), 4)) {
            ENW_ERROR("userinfo_guard: svs at %08X is not readable; names and userinfo are NOT "
                      "sanitised",
                      static_cast<unsigned>(at(t4::var::svs)));
            return;
        }
        g_armed = true;
        frame::subscribe("userinfo_guard", &sweep);
        ENW_INFO("userinfo_guard: armed on %d client slots (svs %08X, stride %X)", kMaxClients,
                 static_cast<unsigned>(at(t4::var::svs)),
                 static_cast<unsigned>(t4::client_off::stride));
    }

    void pre_destroy() override {
        const LONG n = ::InterlockedCompareExchange(&g_name_fixes, 0, 0);
        const LONG u = ::InterlockedCompareExchange(&g_userinfo_fixes, 0, 0);
        if (n || u) {
            ENW_INFO("userinfo_guard: %ld name byte(s) and %ld userinfo byte(s) sanitised", n, u);
        }
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::userinfo_guard)
