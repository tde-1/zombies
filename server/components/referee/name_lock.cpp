// THE NAME LOCK — the server decides what a client is called, and the client cannot argue.
//
// B, 2026-09-23: "When they sign in, their username in World at War is locked to the ENW
// name and they can't spoof another name at all."
//
// ── Why this is the only place the lock can live ──────────────────────────────────────
//
// The launcher passes `+name "<ENW name>"` and the client DLL pins the `name` dvar
// (client-dll/components/name_pin.cpp). Both are BELT. Neither is a lock, and it is worth
// being blunt about why: they run inside the player's own process. Anyone who can edit a
// config, attach a debugger, or simply run the stock exe with a different `+name` defeats
// them, and the server would believe it — `SV_UpdateUserinfo_f` takes whatever string the
// client sends and copies it straight into the server's own copy of that client's
// userinfo. The server has always been the only party in the room that cannot be edited by
// the person being checked, so the lock is here.
//
// ── What the engine actually does with a name (all addresses PROVEN, re, 2026-09-23) ──
//
//   client sends  `userinfo "\name\whatever\rate\25000\..."`
//     -> SV_ExecuteClientCommand 0x6308F0 walks ucmds[] at 0x8D0348
//     -> SV_UpdateUserinfo_f 0x6307E0        I_strncpyz(cl+0x6F0, Cmd_Argv(1), 0x5FF)
//     -> SV_UserinfoChanged 0x630650         cl->name (+0x11548, 32B) = Info_ValueForKey("name")
//     -> ClientUserinfoChanged 0x67BCF0      re-reads cl+0x6F0, ClientCleanName 0x67BC70,
//                                            writes gclient+0x21F0 / +0x215C AND the
//                                            clientinfo record 0x18DD258 + i*0x594, name +0xC
//
// **That last record is what other players see.** `re` looked for a `CS_PLAYERS`
// configstring base and there is none in this SP exe — the per-player scoreboard data goes
// into that in-process array instead, and the client-side reader 0x4E94A0 reads the same
// base and stride. So "the name in the scoreboard" is `0x18DD258 + slot*0x594 + 0xC`, and
// the way to set it correctly is not to poke it but to let `ClientUserinfoChanged` fill it
// from a userinfo we have already corrected. That is exactly what this does.
//
// ── The hook, and why it is this one ──────────────────────────────────────────────────
//
// `SV_UpdateUserinfo_f` 0x6307E0 is the single writer of `cl->userinfo` on the client
// path, it fires ONLY when a client sends `userinfo` (never per frame — that is the
// sanity check below), and it is clean `__cdecl(client_s*)`. `SV_UserinfoChanged` itself
// takes its argument in ESI and `ClientCleanName` in ECX/EDX, so per map rule 4 neither is
// hooked or prototyped; they are reached only through the engine's own call chain.
//
// One MinHook per address, registered through the project's owned-hook rule (README rule
// 9): this component owns 0x6307E0 and nothing else does.
//
// ── The order, which is the whole trick ───────────────────────────────────────────────
//
// We let the ORIGINAL run first. It is a tail-jump into `ClientUserinfoChanged`, so by the
// time it returns the engine has fully applied the client's version — including its rate,
// snaps and voice settings, which we have no business rewriting. Then, if the name it
// applied is not the one this slot is locked to, we put ours back:
//
//   1. Info_SetValueForKey(cl->userinfo, "name", locked)   the server's authoritative copy
//   2. cl->name (+0x11548) = locked                        what SV_UserinfoChanged derived
//   3. ClientUserinfoChanged(slot)                         re-derives gclient + scoreboard
//
// Step 3 re-reads the buffer we just corrected, so every downstream copy is rebuilt by the
// engine's own code from the corrected source. Nothing downstream is poked by hand.
//
// A client that spams `name` therefore gets its own name back for the width of one
// function call, inside one server frame, and is never seen holding it by anybody else.
//
// ── Who is locked ─────────────────────────────────────────────────────────────────────
//
// **Only a slot whose invite token verified.** `referee.cpp` binds the token's `n` to the
// slot at the connect edge; `lock_slot()` is called from there. An untokened client —
// Play Local, `jointest.ps1` with no `-AuthToken`, a dev run — is never locked and keeps
// whatever name the launcher gave it, which is what the coordinator's design says and
// also the only behaviour that keeps a local game usable.

#include "name_lock.hpp"

#include <array>
#include <atomic>
#include <cstring>
#include <mutex>
#include <string>

#include "../../../shared/core/hook.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/memory.hpp"
#include "../../../shared/t4/addresses.hpp"
#include "../../../shared/t4/structs.hpp"

namespace enw::referee::namelock {
namespace {

constexpr int kMaxClients = 4;              // serverStatic_s.clients[4]
constexpr size_t kMaxInfoString = 0x600;    // proven: the 0x5FF strncpyz + explicit NUL
constexpr size_t kClientNameLen = 32;       // client_s.name, +0x11548, I_strncpyz(.., 0x1F)

// ---- the engine, as it is really shaped ---------------------------------------------
//
// Only the two that are genuinely __cdecl are given a prototype. The register-argument
// ones (SV_UserinfoChanged ESI, ClientCleanName ECX/EDX, Info_ValueForKey ECX) are NOT
// declared here and NOT called: everything we need from them happens inside the engine's
// own chain, so there is no naked thunk to get wrong.
using Info_SetValueForKey_t = void(__cdecl*)(char* s, const char* key, const char* value);
using ClientUserinfoChanged_t = void(__cdecl*)(int clientNum);
using SV_UpdateUserinfo_f_t = void(__cdecl*)(void* client);

Info_SetValueForKey_t g_Info_SetValueForKey = nullptr;
ClientUserinfoChanged_t g_ClientUserinfoChanged = nullptr;
SV_UpdateUserinfo_f_t SV_UpdateUserinfo_f_orig = nullptr;
// One MinHook per address, owned by this component (README rule 9).
hook g_hook;

std::mutex g_mutex;
std::array<std::string, kMaxClients> g_locked;   // empty = this slot is not locked
std::atomic<uint64_t> g_enforced{0};             // how many times we put a name back
std::atomic<uint64_t> g_calls{0};                // how many userinfo commands we saw
bool g_bound = false;

uintptr_t client_ptr(int slot) {
    return t4::var::svs + t4::svs_off::clients + static_cast<size_t>(slot) * t4::client_off::stride;
}

// Which slot is this client_s*? The engine computes it with a magic divide; we do the
// same arithmetic in the obvious way, and refuse anything that is not exactly on a stride
// boundary inside the array rather than rounding into a neighbour.
int slot_of(void* client) {
    const uintptr_t base = t4::var::svs + t4::svs_off::clients;
    const uintptr_t p = reinterpret_cast<uintptr_t>(client);
    if (p < base) return -1;
    const uintptr_t d = p - base;
    if (d % t4::client_off::stride != 0) return -1;
    const uintptr_t i = d / t4::client_off::stride;
    return i < kMaxClients ? static_cast<int>(i) : -1;
}

std::string locked_for(int slot) {
    if (slot < 0 || slot >= kMaxClients) return {};
    std::lock_guard<std::mutex> lk(g_mutex);
    return g_locked[static_cast<size_t>(slot)];
}

// Read client_s.name (+0x11548), bounded and NUL-safe.
std::string current_name(int slot) {
    char* p = reinterpret_cast<char*>(client_ptr(slot) + t4::client_off::name);
    if (!memory::is_readable(p, kClientNameLen)) return {};
    size_t n = 0;
    while (n < kClientNameLen && p[n]) ++n;
    return std::string(p, n);
}

/**
 * Put the locked name back, everywhere the engine keeps a copy.
 *
 * Returns true if it had to act. Idempotent, and deliberately does NOTHING when the name
 * already matches: a client that never spoofs pays one string compare per userinfo command
 * and nothing else.
 */
bool enforce(int slot, const std::string& want) {
    if (want.empty()) return false;
    if (current_name(slot) == want) return false;

    char* info = reinterpret_cast<char*>(client_ptr(slot) + t4::client_off::userinfo);
    if (!memory::is_readable(info, kMaxInfoString)) {
        ENW_WARN("namelock: slot %d userinfo at %p is not readable -- NOT enforcing", slot, info);
        return false;
    }

    // 1. The server's authoritative copy. `Info_SetValueForKey` strips '\\', ';' and '"'
    //    from the value itself (proven at 0x5F7247), so a name carrying them cannot
    //    corrupt the infostring even if one ever reached us from the site.
    g_Info_SetValueForKey(info, "name", want.c_str());

    // 2. client_s.name, which SV_UserinfoChanged derived from the string we just replaced.
    //    32 bytes, and the engine's own copy is `I_strncpyz(.., 0x1F)` — same truncation.
    char* nm = reinterpret_cast<char*>(client_ptr(slot) + t4::client_off::name);
    if (memory::is_readable(nm, kClientNameLen)) {
        const size_t n = want.size() < kClientNameLen - 1 ? want.size() : kClientNameLen - 1;
        std::memcpy(nm, want.data(), n);
        nm[n] = '\0';
    }

    // 3. Let the ENGINE rebuild everything downstream from the corrected buffer: the
    //    gclient name fields and, the one that matters, the clientinfo/scoreboard record
    //    at 0x18DD258 + slot*0x594 + 0xC that every other client reads.
    g_ClientUserinfoChanged(slot);

    g_enforced.fetch_add(1, std::memory_order_relaxed);
    return true;
}

void __cdecl SV_UpdateUserinfo_f_hook(void* client) {
    // Let the engine apply the client's version in full first — rate, snaps, cl_voice and
    // everything else are legitimately the client's to set, and re-implementing that
    // parsing here to filter one key would be a far bigger surface than correcting after.
    SV_UpdateUserinfo_f_orig(client);
    g_calls.fetch_add(1, std::memory_order_relaxed);

    const int slot = slot_of(client);
    if (slot < 0) return;
    const std::string want = locked_for(slot);
    if (want.empty()) return;   // untokened / unverified: not ours to rename

    if (enforce(slot, want)) {
        ENW_INFO("namelock: slot %d tried to rename itself; name put back to '%s'", slot, want.c_str());
    }
}

}  // namespace

void lock_slot(int slot, const std::string& name) {
    if (slot < 0 || slot >= kMaxClients || name.empty()) return;
    {
        std::lock_guard<std::mutex> lk(g_mutex);
        g_locked[static_cast<size_t>(slot)] = name;
    }
    if (!g_bound) {
        ENW_WARN("namelock: slot %d locked to '%s' but the hook is NOT bound -- the name is "
                 "advisory only and a client CAN spoof it", slot, name.c_str());
        return;
    }
    // Apply immediately. The connect edge is detected by the referee's per-frame poll, so
    // by the time we get here the engine has already run SV_DirectConnect ->
    // SV_UserinfoChanged with whatever the client connected as.
    if (enforce(slot, name)) {
        ENW_INFO("namelock: slot %d connected as something else; name set to '%s' at the connect edge", slot, name.c_str());
    } else {
        ENW_INFO("namelock: slot %d locked to '%s' (already correct)", slot, name.c_str());
    }
}

void unlock_slot(int slot) {
    if (slot < 0 || slot >= kMaxClients) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    g_locked[static_cast<size_t>(slot)].clear();
}

void reset() {
    std::lock_guard<std::mutex> lk(g_mutex);
    for (auto& s : g_locked) s.clear();
}

// The cheap safety net, called once per server frame from the referee's existing poll.
//
// The hook covers the `userinfo` command, which is how a `name` change reaches the server
// in every path we know of. This exists because "every path we know of" is an argument,
// not a measurement: if some other route ever writes cl->name, this notices within one
// frame. It is a 32-byte compare per connected locked slot and nothing else when nothing
// is wrong.
void tick() {
    if (!g_bound) return;
    for (int i = 0; i < kMaxClients; ++i) {
        const std::string want = locked_for(i);
        if (want.empty()) continue;
        if (current_name(i) == want) continue;
        if (enforce(i, want)) {
            ENW_WARN("namelock: slot %d name drifted OUTSIDE the userinfo path and was put back "
                     "to '%s' -- something other than SV_UpdateUserinfo_f writes cl->name; "
                     "referee.md 14 wants to know about this", i, want.c_str());
        }
    }
}

bool bound() { return g_bound; }

std::string report() {
    return "namelock: " + std::string(g_bound ? "bound" : "NOT BOUND")
         + ", userinfo commands seen " + std::to_string(g_calls.load())
         + ", names put back " + std::to_string(g_enforced.load());
}

bool bind() {
    if (g_bound) return true;

    g_Info_SetValueForKey = reinterpret_cast<Info_SetValueForKey_t>(t4::fn::Info_SetValueForKey);
    g_ClientUserinfoChanged = reinterpret_cast<ClientUserinfoChanged_t>(t4::fn::ClientUserinfoChanged);

    // Never hook on a hope (t4-sp-map.md rule). Both helpers and the hook target must be
    // readable, executable code in this image before any of this is armed.
    for (auto a : { t4::fn::Info_SetValueForKey, t4::fn::ClientUserinfoChanged,
                    t4::fn::SV_UpdateUserinfo_f }) {
        if (!memory::is_readable(reinterpret_cast<void*>(a), 16)) {
            ENW_WARN("namelock: %08X is not readable -- the name lock is OFF and a client CAN spoof",
                     static_cast<unsigned>(a));
            return false;
        }
    }

    if (!g_hook.create(reinterpret_cast<void*>(t4::fn::SV_UpdateUserinfo_f),
                       reinterpret_cast<void*>(&SV_UpdateUserinfo_f_hook), "namelock") ||
        !g_hook.enable()) {
        ENW_WARN("namelock: could not hook SV_UpdateUserinfo_f %08X -- the name lock is OFF",
                 static_cast<unsigned>(t4::fn::SV_UpdateUserinfo_f));
        return false;
    }
    SV_UpdateUserinfo_f_orig = g_hook.original<SV_UpdateUserinfo_f_t>();

    g_bound = true;
    ENW_INFO("namelock: bound SV_UpdateUserinfo_f %08X (Info_SetValueForKey %08X, "
             "ClientUserinfoChanged %08X). A verified client's name is the token's.",
             static_cast<unsigned>(t4::fn::SV_UpdateUserinfo_f),
             static_cast<unsigned>(t4::fn::Info_SetValueForKey),
             static_cast<unsigned>(t4::fn::ClientUserinfoChanged));
    return true;
}

}  // namespace enw::referee::namelock
