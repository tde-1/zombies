// A dedicated server loads the map's `<bsp>_load` zone, as a hosted game does (dedi.md §23.4).
//
// ---------------------------------------------------------------------------
// What the engine does, read from SV_SpawnServer 0x631F20
// ---------------------------------------------------------------------------
//
//     00631FB1  mov  ecx, [0x1F552FC]      ; useFastFile
//     00631FBA  cmp  byte [ecx+0x10], 0
//     00631FBD  je   0x632038              ; no fastfiles -> skip
//     00631FBF  mov  edx, [0x212B2F4]      ; com_dedicated
//     00631FC5  cmp  dword [edx+0x10], 0
//     00631FC8  jne  0x632038              ; DEDICATED -> skip           <-- here
//     00631FCA  cmp  byte [esp+0x13], 0
//     00631FCE  jne  0x632038              ; a map_restart -> skip
//     ...                                   ; (usermaps search path, FS bookkeeping)
//     0063202F  mov  eax, esi               ; the map name
//     00632031  call 0x59DFE0              ; sprintf "%s_load", DB_LoadXAssets(alloc 0x20, free 0x160)
//     00632036  jmp  0x63203B
//     00632038  mov  esi, [ebp+8]
//     0063203B  call 0x5AA020              ; both paths continue here
//
// So the engine itself leaves `<bsp>_load.ff` out on a dedicated server -- it is the
// loading-screen zone, and a dedicated server has no screen. It is NOT our renderer
// bypass at 0x5FF4E0. Stock maps keep only the loading screen there. Some custom maps
// keep real game assets in it: ray_chirstmas_map has all 14 of its zombie models in
// `ray_chirstmas_map_load.ff`, so on our server its zombies had no models.
//
// ---------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------
// Retarget the one `call 0x5AA020` at 0x63203B, which both paths reach, to a stub that
// calls 0x59DFE0 with the map name first -- only when the jne above took us here
// (com_dedicated set), fastfiles are on, and it is not a map_restart (the same three
// conditions, read from the same places). Nothing else on the listen path is taken:
// its search-path and FS bookkeeping stay skipped, exactly as they are today. Every
// address is checked before anything is written. ENW_DEDI_NO_LOAD_ZONE=1 leaves the
// engine alone.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace enw::dedi {
namespace {

constexpr uintptr_t kDedicatedJne  = 0x631FC8;   // jne 0x632038 (75 6E)
constexpr uintptr_t kLoadZoneCall  = 0x632031;   // call 0x59DFE0 (the listen path's)
constexpr uintptr_t kContinueCall  = 0x63203B;   // call 0x5AA020 (both paths)
constexpr uintptr_t kLoadZone      = 0x59DFE0;
constexpr uintptr_t kContinue      = 0x5AA020;
constexpr uintptr_t kUseFastFile   = 0x1F552FC;  // dvar_s*, bool at +0x10
constexpr uintptr_t kComDedicated  = 0x212B2F4;  // dvar_s*, int at +0x10

uintptr_t g_continue = 0;
std::atomic<uint32_t> g_loaded{0};

void call_load_zone(const char* map) {
    const uintptr_t fn = g_continue ? enw::at(kLoadZone) : 0;
    if (!fn) return;
    __asm {
        mov eax, map
        mov ecx, fn
        call ecx
    }
}

void __cdecl on_spawn(const char* map, uint32_t restart) {
    if (restart & 0xFF) return;
    uintptr_t dv = 0;
    uint8_t fast = 0;
    int32_t dedicated = 0;
    if (!memory::read(enw::at(kUseFastFile), &dv) || !dv || !memory::read(dv + 0x10, &fast) || !fast)
        return;
    if (!memory::read(enw::at(kComDedicated), &dv) || !dv || !memory::read(dv + 0x10, &dedicated) ||
        !dedicated)
        return;   // not dedicated: the engine already loaded it at 0x632031
    if (!map || !memory::is_readable(map, 1)) return;
    // [RS] A MAP_RESTART MUST NOT LOAD IT AGAIN. The restart byte above does not catch it:
    // every `map_restart` a player's Restart game (or the host's `end`) issues reached here and
    // loaded `<bsp>_load` a second time (rs7, Nacht: "(#2)", "(#3)" at each restart). For a
    // stock map that zone is a loading screen and nothing broke; bridge_zombie keeps real
    // assets in it, and every restart there faulted at 0x5AA0BD right after the reload
    // (rs8: 4 escaped frames, 4 of 4 restarts; the client never re-entered, no round started).
    // The engine's own listen path skips the zone on a restart (0x631FCE), so the zone is
    // still loaded: a process only ever serves one map, so the same map again IS a restart.
    static char last[64] = {};
    if (last[0] && _stricmp(last, map) == 0) {
        static std::atomic<uint32_t> skipped{0};
        const uint32_t k = skipped.fetch_add(1) + 1;
        if (k <= 3)
            ENW_INFO("dedi_load_zone: %s_load is already loaded in this process -- a map_restart; not "
                     "loading it again (#%u)", map, k);
        return;
    }
    strncpy_s(last, map, _TRUNCATE);
    call_load_zone(map);
    const uint32_t n = g_loaded.fetch_add(1) + 1;
    ENW_INFO("dedi_load_zone: loaded %s_load for the dedicated server (#%u) -- a hosted game "
             "always does; custom maps may keep real assets there (dedi.md §23.4)", map, n);
}

// At the call: [esp] is the return address, so SV_SpawnServer's [esp+0x13] (the restart
// byte tested at 0x631FCA) is [esp+0x17]; after pushad it is [esp+0x37]. esi holds the
// map name on both paths (0x632038 / 0x631FDA).
__declspec(naked) void spawn_stub() {
    __asm {
        pushad
        movzx eax, byte ptr [esp + 0x37]
        push eax
        push esi
        call on_spawn
        add esp, 8
        popad
        jmp dword ptr [g_continue]
    }
}

class load_zone_component final : public component {
public:
    const char* name() const override { return "dedi_load_zone"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_NO_LOAD_ZONE")) {
            ENW_INFO("dedi_load_zone: off (ENW_DEDI_NO_LOAD_ZONE) -- <bsp>_load.ff is not loaded "
                     "on this dedicated server, as in stock");
            return;
        }
        uint8_t jne[2] = {};
        const bool jne_ok = memory::read_raw(enw::at(kDedicatedJne), jne, 2) && jne[0] == 0x75 &&
                            jne[1] == 0x6E;
        const bool zone_ok = memory::call_target(enw::at(kLoadZoneCall)) == enw::at(kLoadZone);
        const bool cont_ok = memory::call_target(enw::at(kContinueCall)) == enw::at(kContinue);
        if (!jne_ok || !zone_ok || !cont_ok) {
            ENW_ERROR("dedi_load_zone: NOT patching -- expected jne 75 6E at 0x%08X (%s), call "
                      "0x59DFE0 at 0x%08X (%s), call 0x5AA020 at 0x%08X (%s)",
                      static_cast<unsigned>(kDedicatedJne), jne_ok ? "ok" : "no",
                      static_cast<unsigned>(kLoadZoneCall), zone_ok ? "ok" : "no",
                      static_cast<unsigned>(kContinueCall), cont_ok ? "ok" : "no");
            return;
        }
        g_continue = enw::at(kContinue);
        if (!memory::retarget_call(enw::at(kContinueCall), reinterpret_cast<const void*>(&spawn_stub))) {
            g_continue = 0;
            ENW_ERROR("dedi_load_zone: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(kContinueCall));
            return;
        }
        ENW_INFO("dedi_load_zone: SV_SpawnServer's call 0x5AA020 at 0x%08X now loads <bsp>_load "
                 "first on a dedicated server (not on a map_restart)",
                 static_cast<unsigned>(kContinueCall));
    }
};

ENW_REGISTER_COMPONENT(load_zone_component)

}  // namespace
}  // namespace enw::dedi
