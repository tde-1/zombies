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
// miserable bug to chase. The check is one byte compare every 64 frames, and the
// component logs the first time it has to put it back.
//
// ONLY ON A DEDICATED SERVER. On a listen/solo game the stock rule is the right
// one, and we do not touch it.
//
// ENW_DEDI_NO_JIP=1 leaves it alone.
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"

#include <cstdlib>

namespace enw::dedi {
namespace {

// The dvar_s* that SV_DirectConnect's co-op gate reads.
constexpr uintptr_t kJoinInProgressDvarPtr = 0x339A774;
constexpr uintptr_t kDvarValueOffset = 0x10;   // proven, dedi.md §3
constexpr uintptr_t kDvarNameOffset  = 0x00;

uintptr_t g_dvar = 0;
volatile long g_restored = 0;

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

        // THE POINTER IS NULL AT post_init. Run join9 proved it: this dvar is not
        // registered during Com_Init, it appears later (the party/lobby side owns
        // it). So poll on the frame tick instead of reading once and giving up --
        // which is exactly the mistake that made join9 a wasted run.
        enw::frame::subscribe("dedi_join_in_progress", [](uint64_t n) {
            if ((n & 15u) != 0) return;

            uintptr_t dvar = 0;
            if (!memory::read(enw::at(kJoinInProgressDvarPtr), &dvar) || !dvar) return;

            uint8_t v = 0;
            if (!memory::read(dvar + kDvarValueOffset, &v)) return;
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
