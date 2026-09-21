// Keep the engine's own local client out of a dedicated server.
//
// ---------------------------------------------------------------------------
// What this fixes, and how it was found (2026-09-21)
// ---------------------------------------------------------------------------
// The headless server booted, loaded `nazi_zombie_prototype`, ran zombiemode GSC
// and then STOPPED after 4 frames. The blocker was recorded in dedi.md as "a
// bounded Sleep(1) pacing loop at 0x59DD90"; that was wrong, and this file is the
// retraction as well as the fix.
//
// A validated stack walk (ENW_DEDI_WHEREIS=1, run r02, 19 identical samples over
// 76 s) puts the main thread at:
//
//     EIP = ntdll!NtWaitForSingleObject+0xC   ESP = 000EEDC4   (byte-identical
//     on every sample -- a real wait, not a grind and not a sleep)
//     validated return chain: 005A3363 <- 0059A764 <- ...
//
//   * 0x5A3320 is the asset-database sync: it prints "Database: Assets Sync
//     Started", then `do { 0x5FDBF0(); } while (WaitForSingleObject([0x1FF51C4],
//     500) != WAIT_OBJECT_0);` -- 0x5A3363 is the return address inside that
//     do/while. It waits for ever if the event is never signalled. THAT is the
//     outer loop; the Sleep loop at 0x59DD90 is bounded to 50 and was never the
//     problem.
//   * 0x59A6F0 is the error/shutdown path, which Com_Frame enters at 0x59E505
//     when [0x1F964B4] != 0, and which calls 0x5A3320 at 0x59A75F.
//
// The console log says why we got onto the error path at all:
//
//     Client connect ignored because join in progress isn't allowed in COOP
//     [enw] === Com_Error TRAPPED === called from 00643D55
//             arg1 = 1 (ERR_DROP)  arg2 = "%s"  arg3 = "EXE_ERR_CANNOTJOININPROGRESS"
//     ERROR: Can not join a game in progress
//     ----- Server Shutdown -----   sv_running 0
//     ... Creating Direct3D device... / Loading fastfile ui ...
//     Error: Exceeded limit of 1 'snddriverglobals' assets.
//
// So the full chain is: the SP engine connects its OWN local client after the map
// comes up -> co-op rules refuse a join-in-progress -> the server sends the client
// an `error` OOB packet -> CL_ConnectionlessPacket turns it into Com_Error(ERR_DROP)
// at 0x643D50 -> server shutdown -> the engine falls back into CLIENT init (D3D, the
// `ui` fastfile) -> the sound-driver singleton is already taken -> a second
// Com_Error -> the error path calls the asset-database sync -> it waits for ever.
//
// That is milestone 1 and milestone 4 of dedicated.hpp's own list in one bug.
//
// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------
// Do not connect the local client in dedicated mode. There is exactly one call
// site on the map-load path:
//
//     00632192  cmp byte ptr [esp+0x13], 0
//     00632197  jne 0063222B
//     0063219D  mov edx, [ebp+0x10]
//     006321A0  push edx
//     006321A1  push edi                 ; arg1 = map name
//     006321A2  call 00641730            ; CL_ConnectLocal   <-- we retarget this
//     006321A7  add esp, 8               ; THE CALLER CLEANS -> cdecl
//
// `add esp,8` immediately after the call is the proof that a bare `ret` stub is
// safe: we are not guessing a calling convention, we are reading the caller's own
// stack cleanup. That check is enforced at install time -- if those three bytes
// are not `83 C4 08` we refuse to patch rather than corrupt a stack, which is the
// mistake that cost the previous session a boot (dedi.md §4, "two failed fixes").
//
// This is deliberately the client-side half rather than relaxing the server's
// co-op join gate: a dedicated server wants ZERO local clients, so that slot 0 is
// free for a real one and so _zombiemode.gsc's get_players() does not size rounds
// for a player who is not there.
//
// ENW_DEDI_KEEP_LOCAL_CLIENT=1 turns it off, for bisecting.
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"
#include "t4/addresses.hpp"

#include <cstdlib>

namespace enw::dedi {
namespace {

// CL_ConnectLocal (docs/re/t4-sp-map.md §5): 0x641730, cdecl, two dwords, arg1 is
// the map name. Call site on the map-load path inside 0x631F20.
constexpr uintptr_t kConnectLocal     = 0x641730;
constexpr uintptr_t kConnectLocalSite = 0x6321A2;
constexpr uint8_t   kCallerCleanup[3] = {0x83, 0xC4, 0x08};  // add esp, 8

volatile long g_refused = 0;

void __cdecl refuse_count() { ++g_refused; }

// Naked, so the epilogue is exactly one `ret` and nothing the compiler decides to
// add. The caller pops the two arguments itself (verified above), so returning
// without touching esp is correct. EAX is left as the counter call left it; the
// call site ignores the return value (0x6321A7 is `add esp,8`, not a test).
__declspec(naked) void connect_local_stub() {
    __asm {
        pushfd
        pushad
        call refuse_count
        popad
        popfd
        ret
    }
}

class local_client_component final : public component {
public:
    const char* name() const override { return "dedi_local_client"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_KEEP_LOCAL_CLIENT")) {
            ENW_WARN("dedi_local_client: ENW_DEDI_KEEP_LOCAL_CLIENT set - the local client will "
                     "connect, the co-op join gate will drop it, and the server will shut down "
                     "and hang in the asset-database sync. Diagnostic use only.");
            return;
        }

        const uintptr_t site = enw::at(kConnectLocalSite);

        // Check 1: the call really targets CL_ConnectLocal.
        const uintptr_t target = memory::call_target(site);
        if (target != enw::at(kConnectLocal)) {
            ENW_ERROR("dedi_local_client: NOT patching. Call at 0x%08X targets 0x%08X, expected "
                      "0x%08X (CL_ConnectLocal). Bytes: %s",
                      static_cast<unsigned>(kConnectLocalSite), static_cast<unsigned>(target),
                      static_cast<unsigned>(enw::at(kConnectLocal)),
                      memory::hex_dump(site, 12).c_str());
            return;
        }

        // Check 2: the caller cleans the stack. This is what makes a bare `ret`
        // stub safe, and it is a fact we read rather than a convention we assume.
        uint8_t after[3] = {};
        if (!memory::read_raw(site + 5, after, sizeof after) ||
            after[0] != kCallerCleanup[0] || after[1] != kCallerCleanup[1] ||
            after[2] != kCallerCleanup[2]) {
            ENW_ERROR("dedi_local_client: NOT patching. Expected `add esp,8` at 0x%08X so a plain "
                      "`ret` stub is safe; found %02X %02X %02X. Refusing to guess a calling "
                      "convention (dedi.md: that mistake already cost us a boot).",
                      static_cast<unsigned>(kConnectLocalSite + 5), after[0], after[1], after[2]);
            return;
        }

        ENW_INFO("dedi_local_client: call site 0x%08X bytes before patch: %s",
                 static_cast<unsigned>(kConnectLocalSite), memory::hex_dump(site, 8).c_str());

        if (!memory::retarget_call(site, &connect_local_stub)) {
            ENW_ERROR("dedi_local_client: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(kConnectLocalSite));
            return;
        }

        ENW_INFO("dedi_local_client: local client 0 will NOT connect (call at 0x%08X -> "
                 "CL_ConnectLocal 0x%08X retargeted to a counting `ret`). Slot 0 stays free "
                 "for a real client, and the co-op 'join in progress' drop that shut the "
                 "server down cannot happen.",
                 static_cast<unsigned>(kConnectLocalSite), static_cast<unsigned>(kConnectLocal));
    }

    void pre_destroy() override {
        if (g_refused)
            ENW_INFO("dedi_local_client: refused %ld local-client connect(s)", g_refused);
    }
};

ENW_REGISTER_COMPONENT(local_client_component)

}  // namespace
}  // namespace enw::dedi
