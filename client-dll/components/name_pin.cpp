// NAME PIN — the client-side belt on the ENW name.
//
// B, 2026-09-23: the player's name in World at War is their ENW name and they cannot
// spoof another one.
//
// ── Read this first: this is NOT the lock, and it cannot be ──────────────────────────
//
// This runs inside the player's own process. Anyone who can open a config file, type in
// the console, attach a debugger or simply launch the stock exe by hand is on the other
// side of it. **The lock is server-side**, in
// `server/components/referee/name_lock.cpp`: for a client whose invite token verified,
// the referee overwrites the SERVER's copy of that client's userinfo `name` at connect
// and on every userinfo change, so whatever this process sends is discarded. That is the
// thing that actually stops a spoof, and it holds with this file deleted.
//
// What this file is for is the honest case, and there are two of them:
//
//   1. **Play Local.** There is no server to enforce anything, so `+set name` from the
//      launcher and this pin are the only reason the player is not "Unknown Soldier" —
//      the engine's stock default for the `name` dvar, and the string B is annoyed by.
//   2. **A verified game**, where it keeps the CLIENT's own console and menus agreeing
//      with what the server shows everyone else, rather than letting the two disagree
//      for a frame and look like a bug.
//
// ── How it pins, and the honest gap ──────────────────────────────────────────────────
//
// It re-issues `set name "<ENW name>"` through the engine's own command buffer
// (`Cbuf_AddText`), on a slow timer, from the frame subscriber. That is deliberately the
// dumbest mechanism that works:
//
//   * It never reads `dvar_s`. The dvar flags word is verified (`dvar_s + 0x8`,
//      16-bit — `docs/re/t4-sp-map.md`), but **the offset of a dvar's current string
//      value is NOT**, and neither is a DVAR_ROM/read-only bit for this build. Guessing
//      either to do a compare-and-correct, or to write-protect the dvar, is exactly the
//      "never dereference on a hope" the map forbids. So: no read, no flag edit.
//   * Because it cannot read the value, it cannot tell whether the name drifted. It
//      therefore re-sets unconditionally, and slowly — `kPinIntervalMs` apart — rather
//      than every frame. A `set` to the value it already holds is a no-op in the engine
//      beyond OR-ing the USERINFO bit into `dvar_modifiedFlags` (0x21ACF30), which makes
//      `CL_SetUserInfo` 0x644B20 resend the userinfo blob. Once every few seconds that is
//      a few dozen bytes; every frame it would be real traffic, which is why the interval
//      is not zero.
//
// **UNPROVEN, and written here as such**: that a determined in-game `name` change is
// corrected within `kPinIntervalMs` has not been measured in a real game. What HAS been
// measured is the server-side half, which is the half that matters.
//
// The name comes from the environment (`ENW_PLAYER_NAME`), set by the launcher next to
// the other `ENW_*` launch variables. Absent — a hand-run exe, a dev harness — this
// component does nothing at all and says so once.

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "t4/addresses.hpp"

#include <cstring>
#include <string>

#include <windows.h>

namespace enw::client {
namespace {

// Slow on purpose; see the header comment. Every re-set costs a userinfo resend.
constexpr uint64_t kPinIntervalMs = 3000;

// Cbuf_AddText 0x594200 — REGISTER ARGUMENTS: text in EAX, localClient in ECX, nothing on
// the stack. Copied deliberately rather than shared with the server's `t4_bind.cpp`: that
// file is the referee lane's and links only into the server build. The signature check is
// the same one, for the same reason — a wrong address here would be a call into the middle
// of some other function.
constexpr uintptr_t kCbuf_AddText = 0x594200;
constexpr uint8_t kCbufSig[] = {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02};

std::string g_name;
bool g_cbuf_ok = false;
uint64_t g_last_ms = 0;
uint64_t g_sets = 0;

std::string env_str(const char* key) {
    char buf[256]{};
    const DWORD n = ::GetEnvironmentVariableA(key, buf, sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) return {};
    return std::string(buf, n);
}

// The engine's infostring is backslash-delimited and `set` is parsed as console input, so
// a name carrying a backslash, a quote or a semicolon could split the key/value pairs or
// smuggle a second command. Stripped here, and stripped again by `Info_SetValueForKey`
// server-side (0x5F71F0 drops exactly these three), so the two sides cannot disagree.
std::string sanitise(const std::string& in) {
    std::string out;
    for (char c : in) {
        if (c == '\\' || c == '"' || c == ';' || c == '\n' || c == '\r') continue;
        if (static_cast<unsigned char>(c) < 0x20) continue;
        out.push_back(c);
        if (out.size() >= 31) break;   // client_s.name is 32 bytes including the NUL
    }
    return out;
}

bool cbuf_check() {
    uint8_t got[sizeof kCbufSig] = {};
    if (!memory::read_raw(kCbuf_AddText, got, sizeof got) ||
        std::memcmp(got, kCbufSig, sizeof got) != 0) {
        ENW_WARN("name_pin: Cbuf_AddText 0x%08X is not the expected `push ebp/esi/edi; "
                 "push 0x22990F8` -- the name pin is OFF. The launcher's `+set name` still "
                 "applies at boot; only the re-pin is lost.",
                 static_cast<unsigned>(kCbuf_AddText));
        return false;
    }
    return true;
}

// Inline asm, not a typed pointer: MSVC has no calling convention that puts arguments in
// EAX and ECX, and inventing a prototype for a non-cdecl function is the mistake
// `docs/re/t4-sp-map.md` names by name.
void cbuf_add_text(const char* text, int local_client) {
    const uintptr_t fn = kCbuf_AddText;
    __asm {
        mov eax, text
        mov ecx, local_client
        mov edx, fn
        call edx
    }
}

void pin_now() {
    if (!g_cbuf_ok || g_name.empty()) return;
    std::string line = "set name \"" + g_name + "\"\n";
    cbuf_add_text(line.c_str(), 0);
    ++g_sets;
}

class name_pin final : public component {
public:
    const char* name() const override { return "name_pin"; }

    void post_unpack() override {
        g_name = sanitise(env_str("ENW_PLAYER_NAME"));
        if (g_name.empty()) {
            // Not a warning: this is the normal state for a hand-run exe or a dev harness,
            // and for a player who has not picked an ENW name yet.
            ENW_INFO("name_pin: ENW_PLAYER_NAME is not set -- the name is whatever the "
                     "command line gave it. (The engine's own default is 'Unknown Soldier'.)");
            return;
        }

        g_cbuf_ok = cbuf_check();
        if (!g_cbuf_ok) return;

        // The first pin is at the first frame, not here: `post_unpack` runs long before
        // the command buffer has anything to execute it, and a `set` queued into a buffer
        // the engine has not started draining is simply lost.
        frame::subscribe("name_pin", [](uint64_t) {
            const uint64_t now = ::GetTickCount64();
            if (g_last_ms && now - g_last_ms < kPinIntervalMs) return;
            g_last_ms = now;
            pin_now();
            if (g_sets == 1) {
                ENW_INFO("name_pin: pinned `name` to '%s' (re-set every %llu ms). This is a "
                         "belt -- the lock is the referee's, server-side.",
                         g_name.c_str(), static_cast<unsigned long long>(kPinIntervalMs));
            }
        });
    }
};

ENW_REGISTER_COMPONENT(name_pin)

}  // namespace
}  // namespace enw::client
