// Let a client join a dedicated server whose map is already running.
//
// ---------------------------------------------------------------------------
// The last wall
// ---------------------------------------------------------------------------
// Run join8 got the whole handshake through for the first time:
//
//   client   getchallenge  ->  server   SVC_GetChallenge (counter 1 -> 2)
//   client   CHALLENGERESPONSE: Got server licenseid f36072ab308c8331
//   client   connect + userinfo
//   server   SV_DirectConnect = 1
//   client   ERROR: Can not join a game in progress
//
// and the server printed, as it had back when it was refusing its OWN local
// client (see local_client.cpp):
//
//     Client connect ignored because join in progress isn't allowed in COOP
//
// That message is at 0x886F08 and is pushed at 0x62F101, inside SV_DirectConnect
// 0x62E3A0. Exactly one branch reaches it:
//
//     0062EBC4  mov eax, [0x339A774]       ; a dvar_s*
//     0062EBC9  cmp byte ptr [eax+0x10], 0 ; its bool value
//     0062EBCD  je 0062F101                ; ZERO -> refuse, send `error
//                                          ;          EXE_ERR_CANNOTJOININPROGRESS`
//
// **So this is a dvar, not a hard-coded rule.** Non-zero and the connect
// continues to the password check at 0x62EBD3 and on to `connectResponse`. This
// is the engine's own switch and much better than patching a branch.
//
// The dvar's NAME is not derivable statically: all five references to 0x339A774
// read the pointer and none writes it, so it is filled by something other than a
// plain `mov [addr], eax` at registration. We do not need the name -- we have the
// pointer, and dvar_s's layout is already proven (dedi.md §3: name* at +0x00,
// value at +0x10). So we read the name at runtime and LOG it, which is worth more
// than a guess would be, and write the value.
//
// It is re-asserted on the frame tick because the other three readers of this
// dvar (0x654260, 0x654530, 0x65A5A0) are party/lobby code that may well write it
// too, and a value that silently reverts halfway through a session would be a
// miserable bug to chase. The check is one byte compare every frame (2026-09-23), and the
// component logs the first time it has to put it back.
//
// ONLY ON A DEDICATED SERVER. On a listen/solo game the stock rule is the right
// one, and we do not touch it.
//
// ENW_DEDI_NO_JIP=1 leaves it alone.
//
//
// ---------------------------------------------------------------------------
// 2026-09-23: THE GATE MUST NEVER DEPEND ON TIMING (dedi.md §21)
// ---------------------------------------------------------------------------
// B, bridge_zombie on the box: "it said maps cannot be joined mid-game when I
// tried to join at the very start." inst-01's log: map_loaded 01:19:07.020, B's
// SV_DirectConnect 07.086, and this component's "set 0 -> 1 on frame 16" at
// 07.227. The poll below only looked every 16th frame, so a client that was
// already waiting when the map finished loading was refused in the first frames
// and (stock client) gave up for good.
//
// The registration is NOT invisible after all -- t4map missed the store. It is
// in the party dvar block 0x654530 (called from Com_Init via 0x5FB560):
//
//     00654D3C  32 C0            xor al, al            ; default value = false
//     00654D3E  BF 44 E0 88 00   mov edi, "party_joinInProgressAllowed"
//     00654D43  E8 D8 A0 F9 FF   call Dvar_RegisterBool 0x5EEE20
//     00654D48  A3 74 A7 39 03   mov [0x339A774], eax
//
// So now, three layers, all before a single packet can arrive:
//   1. the default: `xor al,al` -> `mov al,1` (B0 01), byte-checked. The dvar
//      exists with value 1 from the instant it is registered in Com_Init.
//   2. the branches: SV_DirectConnect's two reads of the dvar are made
//      unconditional (unless ENW_JOIN_GATE_STOCK=1):
//        0062E9BB  8B 0D 74 A7 39 03 / 80 79 10 00 / 74 6A   reconnect scan
//                  -> EB 0A (jmp 0x62E9C7: "is this a reconnect from the same
//                     address?" is always asked, as it is when the dvar is 1)
//        0062EBC4  A1 74 A7 39 03 / 80 78 10 00 / 0F 84 2E 05 00 00   THE gate
//                  -> EB 0D (jmp 0x62EBD3, the password check)
//      Both skip the pointer load too, so a connect before the dvar exists
//      cannot dereference NULL. ECX / EAX are dead at both targets (the next
//      instructions overwrite them: `lea ecx,[esp+0x20]` at 0x62EA0F after the
//      movq block, and `call 0x5F6DF0` returns into EAX at 0x62EBDF).
//   3. the poll, every frame now instead of every 16th, as the backstop for
//      party code (0x654260, 0x65A5A0) writing it back.
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"

#include <cstdlib>
#include <cstring>

namespace enw::dedi {
namespace {

// The dvar_s* that SV_DirectConnect's co-op gate reads.
constexpr uintptr_t kJoinInProgressDvarPtr = 0x339A774;
constexpr uintptr_t kDvarValueOffset = 0x10;   // proven, dedi.md §3
constexpr uintptr_t kDvarNameOffset  = 0x00;

uintptr_t g_dvar = 0;
volatile long g_restored = 0;
unsigned long g_test_closed_ms = 0;

struct byte_patch {
    uintptr_t at;
    const char* what;
    uint8_t expect[16];
    size_t expect_len;
    uint8_t patch[4];
    size_t patch_len;
};

const byte_patch kDefaultOn = {
    0x654D3C, "party_joinInProgressAllowed registers with default 1 (xor al,al -> mov al,1)",
    {0x32, 0xC0, 0xBF, 0x44, 0xE0, 0x88, 0x00, 0xE8, 0xD8, 0xA0, 0xF9, 0xFF, 0xA3, 0x74, 0xA7, 0x39},
    16, {0xB0, 0x01}, 2};

const byte_patch kGatePatches[] = {
    {0x62E9BB, "SV_DirectConnect reconnect scan reads the dvar -> always scans",
     {0x8B, 0x0D, 0x74, 0xA7, 0x39, 0x03, 0x80, 0x79, 0x10, 0x00, 0x74, 0x6A}, 12,
     {0xEB, 0x0A}, 2},
    {0x62EBC4, "SV_DirectConnect co-op gate -> always open",
     {0xA1, 0x74, 0xA7, 0x39, 0x03, 0x80, 0x78, 0x10, 0x00, 0x0F, 0x84, 0x2E, 0x05, 0x00, 0x00}, 15,
     {0xEB, 0x0D}, 2},
};

bool apply(const byte_patch& p) {
    uint8_t got[16] = {};
    const uintptr_t at = enw::at(p.at);
    if (!memory::read_raw(at, got, p.expect_len) || std::memcmp(got, p.expect, p.expect_len) != 0) {
        ENW_ERROR("dedi_join_in_progress: NOT patching 0x%08X (%s): bytes are %s",
                  static_cast<unsigned>(p.at), p.what, memory::hex_dump(at, p.expect_len).c_str());
        return false;
    }
    if (!memory::write_raw(at, p.patch, p.patch_len)) {
        ENW_ERROR("dedi_join_in_progress: could not write 0x%08X (%s)", static_cast<unsigned>(p.at),
                  p.what);
        return false;
    }
    ENW_INFO("dedi_join_in_progress: patched 0x%08X: %s", static_cast<unsigned>(p.at), p.what);
    return true;
}

bool set_allowed(uintptr_t dvar) {
    return memory::write<uint8_t>(dvar + kDvarValueOffset, 1);
}

class join_in_progress_component final : public component {
public:
    const char* name() const override { return "dedi_join_in_progress"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_NO_JIP")) {
            ENW_WARN("dedi_join_in_progress: ENW_DEDI_NO_JIP set - leaving the co-op gate alone. "
                     "Every connect will be refused with EXE_ERR_CANNOTJOININPROGRESS once the map "
                     "is running.");
            return;
        }

        // TEST ONLY: ENW_JOIN_GATE_TEST_CLOSED_MS=<n> reproduces the pre-2026-09-23 race on
        // purpose -- no patches, and the dvar is HELD at 0 until n ms after the first frame
        // tick -- so the client's retry (client-dll/components/join_retry.cpp) can be proven
        // against a server that says EXE_ERR_CANNOTJOININPROGRESS first and then lets it in.
        if (const char* t = std::getenv("ENW_JOIN_GATE_TEST_CLOSED_MS"); t && *t) {
            g_test_closed_ms = std::strtoul(t, nullptr, 10);
            ENW_WARN("dedi_join_in_progress: TEST MODE (ENW_JOIN_GATE_TEST_CLOSED_MS=%lu): the gate "
                     "is held CLOSED for %lu ms after the first frame, then opened",
                     g_test_closed_ms, g_test_closed_ms);
            enw::frame::subscribe("dedi_join_in_progress", [](uint64_t n) {
                static ULONGLONG t0 = 0;
                static bool opened = false;
                if (!t0) t0 = ::GetTickCount64();
                uintptr_t dvar = 0;
                if (!memory::read(enw::at(kJoinInProgressDvarPtr), &dvar) || !dvar) return;
                const bool open = ::GetTickCount64() - t0 >= g_test_closed_ms;
                memory::write<uint8_t>(dvar + kDvarValueOffset, open ? 1 : 0);
                if (open && !opened) {
                    opened = true;
                    ENW_INFO("dedi_join_in_progress: TEST MODE: gate opened on frame %llu",
                             static_cast<unsigned long long>(n));
                }
            });
            return;
        }

        // join9 found the pointer NULL at post_init; since components moved later
        // (early1, 2026-09-23) it is already registered here. Either way: patch the
        // registration default (covers a later registration) AND set the value now
        // if it exists (covers an earlier one). Nothing waits for a frame.
        uintptr_t early = 0;
        memory::read(enw::at(kJoinInProgressDvarPtr), &early);
        const bool default_on = apply(kDefaultOn);
        if (early) {
            set_allowed(early);
            ENW_INFO("dedi_join_in_progress: the dvar is already registered at post_init (%08X) "
                     "on this build -- set to 1 directly, before any frame", static_cast<unsigned>(early));
        }
        const char* stock = std::getenv("ENW_JOIN_GATE_STOCK");
        int gates = 0;
        if (stock && *stock == '1') {
            ENW_WARN("dedi_join_in_progress: ENW_JOIN_GATE_STOCK=1 - SV_DirectConnect still reads "
                     "the dvar (0x62E9BB, 0x62EBC4); only the registration default and the poll "
                     "keep the gate open.");
        } else {
            for (const auto& p : kGatePatches) gates += apply(p) ? 1 : 0;
        }
        ENW_INFO("dedi_join_in_progress: join gate is timing-independent: default-on %s, %d/2 "
                 "SV_DirectConnect branches unconditional%s, poll every frame",
                 default_on ? "yes" : "NO", gates,
                 stock && *stock == '1' ? " (ENW_JOIN_GATE_STOCK=1)" : "");

        // THE POINTER IS NULL AT post_init. Run join9 proved it: this dvar is not
        // registered during Com_Init, it appears later (the party/lobby side owns
        // it). So poll on the frame tick instead of reading once and giving up --
        // which is exactly the mistake that made join9 a wasted run.
        enw::frame::subscribe("dedi_join_in_progress", [](uint64_t n) {
            uintptr_t dvar = 0;
            if (!memory::read(enw::at(kJoinInProgressDvarPtr), &dvar) || !dvar) return;

            uint8_t v = 0;
            if (!memory::read(dvar + kDvarValueOffset, &v)) return;
            static bool seen = false;
            if (!seen) {
                seen = true;
                ENW_INFO("dedi_join_in_progress: first frame tick with the dvar registered: frame "
                         "%llu, value %u (%s)", static_cast<unsigned long long>(n), v,
                         v ? "open from registration" : "CLOSED - the default patch did not take");
            }
            if (v) return;                       // already allowed, nothing to do

            if (!set_allowed(dvar)) return;

            if (::InterlockedIncrement(&g_restored) == 1) {
                g_dvar = dvar;
                uintptr_t name_ptr = 0;
                const char* dvar_name = "<unreadable>";
                if (memory::read(dvar + kDvarNameOffset, &name_ptr) && name_ptr)
                    dvar_name = reinterpret_cast<const char*>(name_ptr);
                ENW_INFO("dedi_join_in_progress: dvar '%s' @ %08X set 0 -> 1 on frame %llu. "
                         "SV_DirectConnect's gate at 0x62EBC9 will now let a client join a map "
                         "that is already running. (It was NOT registered at post_init, which is "
                         "why this polls.) Further reverts are put back silently.",
                         dvar_name, static_cast<unsigned>(dvar),
                         static_cast<unsigned long long>(n));
            }
        });
        ENW_INFO("dedi_join_in_progress: watching [0x%08X] for the co-op join-in-progress dvar",
                 static_cast<unsigned>(kJoinInProgressDvarPtr));
    }

    void pre_destroy() override {
        if (g_restored)
            ENW_INFO("dedi_join_in_progress: set the dvar %ld time(s) (it reverts and we put it back)",
                     g_restored);
        else
            ENW_WARN("dedi_join_in_progress: the dvar at [0x%08X] never appeared - joins would have "
                     "been refused with EXE_ERR_CANNOTJOININPROGRESS",
                     static_cast<unsigned>(kJoinInProgressDvarPtr));
    }
};

ENW_REGISTER_COMPONENT(join_in_progress_component)

}  // namespace
}  // namespace enw::dedi
