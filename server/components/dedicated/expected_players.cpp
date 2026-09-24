// Round 1 waits for the whole party (dedi.md section 29/30, cloud-brief-parties.md task 1).
//
// `_load.gsc all_players_connected()` starts round 1 when getnumconnectedplayers() ==
// getnumexpectedplayers(). The stock getnumexpectedplayers (0x52E910 [V]) counts PARTY members
// when `onlinegame` ([0x3058348] [V]) or [0x30520E0] [V] is set, and returns 1 with no party. The
// box runs onlinegame 1 and has no party, so round 1 began the moment the FIRST player loaded:
// B's friend on Hijacked (m_10ca7b6b) was still loading, spawned late at the map origin and fell
// under the floor, and the game was scaled for one player.
//
// We replace the builtin with our own answer (expected_players_rules.hpp): the lease's player
// count, sent by the host over the game link as {"t":"expected_players","n":N}, until a 90 s
// deadline; then, or with no lease count, the number of clients with state > 1 (the stock
// non-online branch, which waits for a client that is still loading).
//
// THE PATCH, byte-checked first:
//   0x52E910 [V]  A1 48 83 05 03   mov eax,[0x3058348]   <- the builtin's first 5 bytes
//   0x52E995 [V]  the shared tail: pushes esi as the script return value, needs ebx == 1, and
//                 ends `pop esi; pop ebx; ret` (the builtin pushed ebx, esi at entry).
// We write a 5-byte jmp at 0x52E910 to a naked stub that does what the entry and every path do:
//   push ebx; push esi; call answer; mov esi,eax; mov ebx,1; jmp 0x52E995
// Client array: svs.clients 0x2547090 [V], stride 0x58D30 [V], state at +0 [V] (bots.cpp).
//
// Kill switch: ENW_NO_EXPECTED_PLAYERS=1 (the builtin is left alone).
//
// Clean room: our own code, from our own dump.
#include "../../../shared/core/component.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/memory.hpp"
#include "../referee/t4_bind.hpp"
#include "dedicated.hpp"
#include "expected_players_rules.hpp"

#include <cstdint>
#include <cstdlib>

namespace enw::dedi {
namespace {

constexpr uintptr_t kGetNumExpected = 0x52E910;   // [V] builtin getnumexpectedplayers
constexpr uintptr_t kSharedTail = 0x52E995;       // [V] push esi (return value) ... pop esi; pop ebx; ret
constexpr uint8_t kEntryBytes[5] = {0xA1, 0x48, 0x83, 0x05, 0x03};   // [V] mov eax,[0x3058348]

constexpr uintptr_t kSvsClients = 0x2547090;      // [V] bots.cpp
constexpr uintptr_t kClientStride = 0x58D30;      // [V]
constexpr int kMaxClients = 4;

// All of this is touched on the game thread only: the script VM calls the builtin, the link
// handler is registered with want_game_thread, and notify sinks run inside the notify.
int g_lease_n = 0;
expected::wait_window g_window;
bool g_patched = false;
int g_last_lease = -1, g_last_connecting = -1, g_last_answer = -1;
bool g_last_past_deadline = false;
void* g_tail = nullptr;

int clients_connecting() {
    int n = 0;
    for (int i = 0; i < kMaxClients; ++i) {
        int32_t state = 0;
        if (memory::read(enw::at(kSvsClients) + static_cast<uintptr_t>(i) * kClientStride, &state) && state > 1)
            ++n;
    }
    return n;
}

int __cdecl answer() {
    const uint32_t now = game_link::now_ms();
    const uint32_t since = g_window.on_call(now);
    const int connecting = clients_connecting();
    const int n = expected::expected_players(g_lease_n, connecting, since);
    const bool past = since >= expected::kRound1WaitMs;
    if (n != g_last_answer || g_lease_n != g_last_lease || connecting != g_last_connecting ||
        past != g_last_past_deadline) {
        ENW_INFO("expected_players: lease %d, connecting %d -> %d%s", g_lease_n, connecting, n,
                 past ? (g_window.round_started ? " (round 1 has started)" : " (past the 90 s deadline)") : "");
        g_last_answer = n;
        g_last_lease = g_lease_n;
        g_last_connecting = connecting;
        g_last_past_deadline = past;
    }
    return n;
}

__declspec(naked) void expected_stub() {
    __asm {
        push ebx
        push esi
        call answer
        mov  esi, eax
        mov  ebx, 1
        jmp  dword ptr [g_tail]
    }
}

class expected_players_component final : public component {
public:
    const char* name() const override { return "dedi_expected_players"; }

    void post_load() override {
        // Registered early, so a lease count sent the moment the link comes up is not dropped
        // (unknown `t` values are ignored by the link). Harmless when the patch is off.
        game_link::get().on(
            "expected_players",
            [](const json::value& msg) {
                const int n = static_cast<int>(msg.int_or("n", 0));
                if (n != g_lease_n) ENW_INFO("expected_players: the lease names %d player(s) (was %d)", n, g_lease_n);
                g_lease_n = n < 0 ? 0 : n;
                g_window.on_lease(game_link::now_ms());
            },
            /*want_game_thread=*/true);
    }

    // Not is_supported(): that is asked before post_load too, possibly before the `dedicated`
    // component has read the command line, and the link handler above must always register.
    void post_init() override {
        if (!is_dedicated()) return;
        if (std::getenv("ENW_NO_EXPECTED_PLAYERS")) {
            ENW_WARN("expected_players: OFF (ENW_NO_EXPECTED_PLAYERS): round 1 starts on the first loaded player "
                     "(dedi.md section 29)");
            return;
        }
        const uintptr_t site = enw::at(kGetNumExpected);
        uint8_t have[sizeof kEntryBytes] = {};
        bool ok = memory::read_raw(site, have, sizeof have);
        for (size_t i = 0; ok && i < sizeof kEntryBytes; ++i) ok = have[i] == kEntryBytes[i];
        if (!ok) {
            ENW_ERROR("expected_players: NOT patching: getnumexpectedplayers at 0x%08X is %s, expected "
                      "A1 48 83 05 03. Round 1 will start on the first loaded player.",
                      static_cast<unsigned>(kGetNumExpected), memory::hex_dump(site, 5).c_str());
            return;
        }
        g_tail = reinterpret_cast<void*>(enw::at(kSharedTail));
        if (!memory::write_jmp(site, reinterpret_cast<const void*>(&expected_stub))) {
            ENW_ERROR("expected_players: NOT patched: the jmp write at 0x%08X failed",
                      static_cast<unsigned>(kGetNumExpected));
            return;
        }
        g_patched = true;
        referee::bind();
        referee::on_notify([](const referee::notify_event& ev) {
            if (ev.who == referee::notify_event::owner::level && ev.name == "all_players_connected")
                g_window.on_round_started();
        });
        ENW_INFO("expected_players: armed -- getnumexpectedplayers answers max(1, lease, connecting) for %u s after "
                 "the map loads or a lease arrives, then max(1, connecting) (dedi.md section 30)",
                 expected::kRound1WaitMs / 1000);
    }

    void pre_destroy() override {
        if (g_patched) ENW_INFO("expected_players: last answer %d (lease %d)", g_last_answer, g_lease_n);
    }
};

ENW_REGISTER_COMPONENT(expected_players_component)

}  // namespace
}  // namespace enw::dedi
