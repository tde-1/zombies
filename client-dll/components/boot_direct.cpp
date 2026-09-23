// boot_direct: launcher Play -> black/loading -> the zombies map (B, 2026-09-23:
// "it first says 'can't connect to online servers' before connecting into the game ...
// not even show the main menu at all and not play the main menu music").
//
// THREE PIECES, docs/kickstart/client.md §10 has the measurements.
//
// 1. THE POPUP. It is the engine's Demonware log-on state machine answering our blocked
//    DNS lookup. The function at 0x5FC870 runs every frame while `dw_active` is set; its
//    state 2 is the auth-server DNS lookup (0x57C320). When that fails (`net: BLOCKED a
//    DNS lookup for cod5-pc.auth.mmp3.demonware.net`) it prints "Failed to log on."
//    (0x882670), clears `dw_popup` and opens the menu **popup_cannot_connect_to_dw**:
//
//        0x5FC951  mov eax, 0x882684          ; "popup_cannot_connect_to_dw"
//        0x5FC956  call 0x5D7FD0              ; open menu by name, name in EAX
//
//    The sibling at 0x5FC9BF opens popup_cannot_connect_to_dw_create_offline_profile the
//    same way, and the `dw_popup` setter 0x5FDB10 opens the "connecting" popups that come
//    before it (popup_connecting_dw, popup_dw_dns_lookup) at 0x5FDB57, name in EDI copied
//    to EAX. 0x5D7FD0 is Menus_FindByName(uiContext 0x208E920, name) + Menus_Open
//    (0x5C5180): `push ecx; push eax; push 0x208E920; call 0x5C0200; ...; pop ecx; ret`,
//    and none of the three callers reads EAX afterwards.
//    We retarget those three rel32s (not a MinHook on 0x5D7FD0: it has other callers and
//    they are none of our business) to a thunk that refuses exactly those four menu names
//    and passes anything else straight through. The log-on machine itself is untouched:
//    it still fails, retries and prints "Failed to log on."; nobody sees it.
//    Off switch: ENW_SHOW_ONLINE_WARNING=1.
//
// 2. THE DIRECT BOOT. connect_local's gate waits for the main menu (its background Bink)
//    plus 750 ms settle and a 2 s floor, because on 2026-09-22 connecting blind at frame
//    300 put a video over the HUD. That video was the map's load Bink, which connect_local
//    now refuses, and the startup intro never opens with our args (client.md §7). So for
//    an armed join we fire as soon as the engine will take it: the first frame tick after
//    post_init with no file video open and clc.state != CA_CINEMATIC. The main menu then
//    exists for exactly one frame (frame 1 built it before our tick), and that frame is
//    painted black at Present (see the cover). ~1.0 s sooner in game (client.md §10c).
//    Belt: snd_menu_master is set to 0 from the first frame until the first in-game frame and
//    then put back to the player's value (see mute_*). Off switch: ENW_DIRECT_BOOT=0
//    (restores the menu gate exactly); ENW_BOOT_MUTE=0 leaves the volume alone.
//
// 3. THE INSTRUMENT. Every clc.state change is logged with ms since process creation,
//    and "FIRST IN-GAME FRAME" when clc.state first reads 10 (CA_ACTIVE on this build,
//    t4-sp-map.md). With ENW_FRAME_CAPTURE=1 + ENW_BOOT_CAPTURE=1 the back buffer is
//    saved every frame for the first 12, then every ~250 ms until 2 s into the game, via
//    frame_capture.cpp -- the pictures in docs/kickstart/ui/boot-*.jpg.
//
// Clean room: our own code; addresses and facts only.

#include "boot_direct.hpp"

#include "component.hpp"
#include "frame.hpp"
#include "game.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>
#include <d3d9.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace enw::client::frame_capture {
bool request(const char* name);
}

namespace enw::client::boot_direct {
namespace {

constexpr uintptr_t kOpenMenuByName = 0x5D7FD0;
// push ecx; push eax; push 0x208E920 (uiContext)
constexpr uint8_t kOpenMenuSig[] = {0x51, 0x50, 0x68, 0x20, 0xE9, 0x08, 0x02};

struct call_site {
    uintptr_t at;
    const char* what;
};
constexpr call_site kSites[] = {
    {0x5FC956, "DW log-on: popup_cannot_connect_to_dw"},
    {0x5FC9BF, "DW log-on: popup_cannot_connect_to_dw_create_offline_profile"},
    {0x5FDB57, "dw_popup setter: popup_connecting_dw / popup_dw_dns_lookup"},
};

// Only these. Anything else opened through the three sites passes.
constexpr const char* kRefused[] = {
    "popup_cannot_connect_to_dw",
    "popup_cannot_connect_to_dw_create_offline_profile",
    "popup_connecting_dw",
    "popup_dw_dns_lookup",
};

constexpr uintptr_t kClcState = 0x305842C;
constexpr int kCaCinematic = 1;
constexpr int kCaActive = 10;

constexpr uintptr_t kCbufAddText = 0x594200;  // EAX text, ECX localClient
constexpr uint8_t kCbufSig[] = {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02};

// dvar_s: flags word at +8 (t4-sp-map.md, SetSavedDvar 0x516B15), current value at +0x10.
// DVAR_ARCHIVE is bit 0: Com_WriteConfiguration's per-dvar writer 0x59FAA0 does
// `test byte ptr [esi+8], 1` before it writes `seta`.
constexpr size_t kDvarFlags = 0x8;
constexpr size_t kDvarCurrent = 0x10;
constexpr uint16_t kDvarArchive = 0x1;

bool g_client = false;
bool g_armed = false;          // ENW_CLIENT_CONNECT set
bool g_direct = true;          // ENW_DIRECT_BOOT != 0
bool g_popups_off = true;      // ENW_SHOW_ONLINE_WARNING != 1
bool g_mute_wanted = true;     // ENW_BOOT_MUTE != 0
bool g_capture = false;        // ENW_BOOT_CAPTURE=1
uint64_t g_min_frame = 1;      // ENW_DIRECT_BOOT_MIN_FRAME (measurement knob)

uintptr_t g_open_real = kOpenMenuByName;
bool g_sites_patched = false;
volatile LONG g_refusals = 0;
volatile LONG g_passed = 0;

ULONGLONG g_proc_start_ms = 0;
ULONGLONG g_post_init_ms = 0;
bool g_connected = false;
ULONGLONG g_connect_ms = 0;
int g_last_state = -1;
bool g_in_game = false;
ULONGLONG g_in_game_ms = 0;
ULONGLONG g_next_capture_ms = 0;
uint64_t g_frames = 0;
uint64_t g_post_init_frame = 0;

ULONGLONG now_ms() {
    FILETIME ft;
    ::GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return u.QuadPart / 10000ULL;
}

ULONGLONG since_start() { return g_proc_start_ms ? now_ms() - g_proc_start_ms : 0; }

bool env_is(const char* key, char c) {
    const char* v = std::getenv(key);
    return v && v[0] == c;
}

int clc_state() { return *reinterpret_cast<const volatile int*>(kClcState); }

// ------------------------------------------------------------------ the popups --

bool __cdecl should_refuse(const char* name) {
    bool refuse = false;
    char copy[64] = {};
    __try {
        if (name) std::strncpy(copy, name, sizeof copy - 1);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        copy[0] = 0;
    }
    if (g_popups_off)
        for (const char* r : kRefused)
            if (_stricmp(copy, r) == 0) refuse = true;
    const LONG n = refuse ? ::InterlockedIncrement(&g_refusals) : ::InterlockedIncrement(&g_passed);
    if (n <= 20)
        ENW_INFO("boot: %s menu '%s' (+%llu ms since process start, #%ld)%s",
                 refuse ? "REFUSED the online-services" : "let through", copy, since_start(),
                 static_cast<long>(n),
                 refuse ? "; ENW_SHOW_ONLINE_WARNING=1 shows it" : "");
    return refuse;
}

// EAX = menu name, ECX preserved by the real function, EAX unused by all three callers.
__declspec(naked) void open_menu_thunk() {
    __asm {
        push ecx
        push edx
        push eax
        call should_refuse
        mov ecx, eax
        pop eax
        pop edx
        test cl, cl
        pop ecx
        jnz refused
        jmp dword ptr [g_open_real]
    refused:
        ret
    }
}

void patch_popups() {
    uint8_t got[sizeof kOpenMenuSig] = {};
    if (!memory::read_raw(kOpenMenuByName, got, sizeof got) ||
        std::memcmp(got, kOpenMenuSig, sizeof got) != 0) {
        ENW_WARN("boot: 0x%08X is not the expected open-menu-by-name (%s); the online-services "
                 "popup is NOT suppressed", static_cast<unsigned>(kOpenMenuByName),
                 memory::hex_dump(kOpenMenuByName, 8).c_str());
        return;
    }
    // All three must be what we expect, or none is touched.
    for (const auto& s : kSites) {
        if (memory::call_target(s.at) != kOpenMenuByName) {
            ENW_WARN("boot: call site 0x%08X (%s) does not call 0x%08X (%s); popup suppression "
                     "OFF", static_cast<unsigned>(s.at), s.what,
                     static_cast<unsigned>(kOpenMenuByName), memory::hex_dump(s.at, 5).c_str());
            return;
        }
    }
    int ok = 0;
    for (const auto& s : kSites)
        if (memory::retarget_call(s.at, reinterpret_cast<const void*>(&open_menu_thunk))) ++ok;
    g_sites_patched = ok == static_cast<int>(sizeof kSites / sizeof kSites[0]);
    ENW_INFO("boot: online-services popups %s (%d of %d call sites into 0x%08X retargeted; "
             "refused: popup_cannot_connect_to_dw[_create_offline_profile], popup_connecting_dw, "
             "popup_dw_dns_lookup). ENW_SHOW_ONLINE_WARNING=1 shows them.",
             !g_popups_off ? "WATCHED, NOT suppressed" : g_sites_patched ? "SUPPRESSED" : "PARTLY suppressed", ok,
             static_cast<int>(sizeof kSites / sizeof kSites[0]),
             static_cast<unsigned>(kOpenMenuByName));
}

// ---------------------------------------------------------------------- the mute --
//
// WHICH DVAR. Not snd_volume: MEASURED (boot-after5), snd_volume is never registered by
// this SP build -- at the first in-game frame it is still the EXTERNAL dvar the command
// line's `+set` created (flags 0x4000, which Dvar_RegisterVariant's inner 0x5EEA20 tests,
// type byte +0xA = 7, string), so nothing reads it. The registered volumes are the
// Options > Sound sliders, registered as floats by the sound init 0x6B47C0 (0x6B4E18
// snd_menu_music, 0x6B4E6A snd_menu_master, both through Dvar_RegisterFloat 0x5EEF10,
// type 1). snd_menu_master is the master, and it is the one every dev harness sets to 0
// to keep test games silent. So the mute is snd_menu_master.
//
// THE ARCHIVE BIT. It is archived: a `set` marks dvar_modifiedFlags bit 0 and the next
// frame's Com_WriteConfiguration (0x59D8F0) writes config.cfg. If the game died while
// muted, the launcher's read-back would save the 0 as the player's setting. So while
// muted we keep the dvar's own archive bit (flags word +8, bit 0 -- the per-dvar writer
// 0x59FAA0 tests exactly that) clear: the writer leaves the line out and the player's
// config keeps its value. The bit goes back once their value is current again, and only
// if we are the ones who cleared it. The value is read by type (1 float, 7 string), so
// an unregistered dvar can never be "restored" to a pointer read as a float (boot-after4
// did exactly that to snd_volume: 7e-37).
//
// WHEN. From the first frame tick, not post_init: post_init runs inside Com_Init, before
// the command line's `+set`s execute, so a value read there is not the player's.

constexpr size_t kDvarType = 0xA;
constexpr uint8_t kDvarFloat = 1;
constexpr uint8_t kDvarString = 7;

bool g_cbuf_ok = false;
void* g_mute_dvar = nullptr;  // snd_menu_master
float g_saved_volume = -1.0f;
bool g_cleared_archive = false;
enum class mute_state { off, muted, restoring, done } g_mute = mute_state::off;
ULONGLONG g_mute_ms = 0;

void cbuf_add_text(const char* text) {
    const uintptr_t fn = kCbufAddText;
    __asm {
        mov eax, text
        xor ecx, ecx
        mov edx, fn
        call edx
    }
}

uint16_t& dvar_flags(void* d) { return *reinterpret_cast<uint16_t*>(static_cast<char*>(d) + kDvarFlags); }
uint8_t dvar_type(void* d) { return *reinterpret_cast<volatile uint8_t*>(static_cast<char*>(d) + kDvarType); }

// The dvar's current value as a number, whichever form it is in. False if unreadable.
bool dvar_number(void* d, float* out) {
    __try {
        const uint8_t t = dvar_type(d);
        char* cur = static_cast<char*>(d) + kDvarCurrent;
        if (t == kDvarFloat) {
            *out = *reinterpret_cast<volatile float*>(cur);
            return true;
        }
        if (t == kDvarString) {
            const char* s = *reinterpret_cast<const char* const*>(cur);
            if (!s) return false;
            char buf[32] = {};
            std::strncpy(buf, s, sizeof buf - 1);
            char* end = nullptr;
            const double v = std::strtod(buf, &end);
            if (end == buf) return false;
            *out = static_cast<float>(v);
            return true;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
    return false;
}

// While muted or restoring: keep the archive bit off whenever it appears (the sound
// system's registration ORs it in part-way through the load).
void hold_archive_off() {
    uint16_t& f = dvar_flags(g_mute_dvar);
    if (f & kDvarArchive) {
        f = static_cast<uint16_t>(f & ~kDvarArchive);
        if (!g_cleared_archive)
            ENW_INFO("boot: snd_menu_master registered as archived (flags now 0x%04X, type %u); "
                     "holding the archive bit off until the restore", f, dvar_type(g_mute_dvar));
        g_cleared_archive = true;
    }
}

void mute_begin() {
    if (!g_mute_wanted || !g_cbuf_ok) return;
    g_mute_dvar = game::find_dvar("snd_menu_master");
    if (!g_mute_dvar) {
        ENW_WARN("boot: snd_menu_master not found; the menu is not muted");
        return;
    }
    float v = -1.0f;
    if (!dvar_number(g_mute_dvar, &v) || !(v >= 0.0f && v <= 1.0f)) {
        ENW_WARN("boot: snd_menu_master (type %u, flags 0x%04X) does not read as a 0..1 number; not "
                 "touching it", dvar_type(g_mute_dvar), dvar_flags(g_mute_dvar));
        g_mute_dvar = nullptr;
        return;
    }
    g_saved_volume = v;
    const uint16_t flags = dvar_flags(g_mute_dvar);
    hold_archive_off();
    cbuf_add_text("set snd_menu_master 0\n");
    g_mute = mute_state::muted;
    g_mute_ms = now_ms();
    ENW_INFO("boot: muted (snd_menu_master %g -> 0; dvar type %u, flags 0x%04X; archive bit held "
             "off so config.cfg never records the 0) until the first in-game frame. "
             "ENW_BOOT_MUTE=0 leaves it alone.", v, dvar_type(g_mute_dvar), flags);
}

void mute_end(const char* why) {
    if (g_mute != mute_state::muted) return;
    char line[64];
    std::snprintf(line, sizeof line, "set snd_menu_master %.6g\n", g_saved_volume);
    cbuf_add_text(line);
    g_mute = mute_state::restoring;
    ENW_INFO("boot: restoring snd_menu_master to %g (%s, muted %llu ms)", g_saved_volume, why,
             now_ms() - g_mute_ms);
}

// Every frame while muted/restoring; once the value is back, the archive bit returns.
void mute_tick() {
    if (!g_mute_dvar || g_mute == mute_state::off || g_mute == mute_state::done) return;
    hold_archive_off();
    if (g_mute != mute_state::restoring) return;
    float v = -1.0f;
    const bool ok = dvar_number(g_mute_dvar, &v);
    if (!ok || v > g_saved_volume + 0.0005f || v < g_saved_volume - 0.0005f) {
        if (now_ms() - g_mute_ms > 90000) {
            ENW_WARN("boot: snd_menu_master still reads %g, not %g; re-issuing", v, g_saved_volume);
            g_mute_ms = now_ms();
            g_mute = mute_state::muted;
            mute_end("retry");
        }
        return;
    }
    if (g_cleared_archive) dvar_flags(g_mute_dvar) |= kDvarArchive;
    g_mute = mute_state::done;
    ENW_INFO("boot: snd_menu_master is %g again (type %u), archive bit %s (flags 0x%04X)", v,
             dvar_type(g_mute_dvar), g_cleared_archive ? "given back" : "never ours to touch",
             dvar_flags(g_mute_dvar));
}

// --------------------------------------------------------------------- the cover --
//
// MEASURED (boot-after1): the connect fires in our tick AFTER frame 1's Com_Frame, and
// that frame had already built the main menu (text over black; its Bink background not
// yet drawn), presented once for ~7 ms before the loading screen. So from the first tick
// until the connect has moved clc.state past 4, the back buffer is painted black at
// Present (ColorFill, then the real Present). Both Present slots, because
// frame_capture.cpp found T4 presents through the swap chain. The slots stay pointed at
// us afterwards (another component may have chained behind us); only the fill stops.
// ENW_BOOT_COVER=0 turns it off.

constexpr uintptr_t kDxDevice = 0x3BF3B08;
using present_t = HRESULT(__stdcall*)(IDirect3DDevice9*, const RECT*, const RECT*, HWND,
                                      const RGNDATA*);
using sc_present_t = HRESULT(__stdcall*)(IDirect3DSwapChain9*, const RECT*, const RECT*, HWND,
                                         const RGNDATA*, DWORD);
present_t g_real_present = nullptr;
sc_present_t g_real_sc_present = nullptr;
IDirect3DDevice9* g_dev = nullptr;
volatile LONG g_cover_on = 0;
volatile LONG g_covered = 0;
bool g_cover_wanted = true;
bool g_cover_installed = false;

void paint_black(IDirect3DDevice9* dev) {
    __try {
        IDirect3DSurface9* bb = nullptr;
        if (SUCCEEDED(dev->GetBackBuffer(0, 0, D3DBACKBUFFER_TYPE_MONO, &bb)) && bb) {
            dev->ColorFill(bb, nullptr, D3DCOLOR_XRGB(0, 0, 0));
            bb->Release();
            ::InterlockedIncrement(&g_covered);
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

HRESULT __stdcall cover_present(IDirect3DDevice9* dev, const RECT* a, const RECT* b, HWND c,
                                const RGNDATA* e) {
    if (g_cover_on) paint_black(dev);
    return g_real_present(dev, a, b, c, e);
}

HRESULT __stdcall cover_sc_present(IDirect3DSwapChain9* sc, const RECT* a, const RECT* b,
                                   HWND c, const RGNDATA* e, DWORD f) {
    if (g_cover_on && g_dev) paint_black(g_dev);
    return g_real_sc_present(sc, a, b, c, e, f);
}

bool swap_slot(void** vtbl, int slot, void* fn, void** old_fn) {
    DWORD old = 0;
    if (!::VirtualProtect(&vtbl[slot], sizeof(void*), PAGE_READWRITE, &old)) return false;
    *old_fn = vtbl[slot];
    vtbl[slot] = fn;
    ::VirtualProtect(&vtbl[slot], sizeof(void*), old, &old);
    return true;
}

void cover_install() {
    if (g_cover_installed || !g_cover_wanted) return;
    g_cover_installed = true;  // one attempt
    auto* dev = *reinterpret_cast<IDirect3DDevice9* volatile*>(kDxDevice);
    if (!dev) {
        ENW_WARN("boot: dx.device is null at the first frame; no black cover");
        return;
    }
    g_dev = dev;
    void** vtbl = *reinterpret_cast<void***>(dev);
    void* old = nullptr;
    const bool d = swap_slot(vtbl, 17, reinterpret_cast<void*>(&cover_present), &old);
    if (d) g_real_present = reinterpret_cast<present_t>(old);
    bool s = false;
    IDirect3DSwapChain9* sc = nullptr;
    if (SUCCEEDED(dev->GetSwapChain(0, &sc)) && sc) {
        void** sv = *reinterpret_cast<void***>(sc);
        s = swap_slot(sv, 3, reinterpret_cast<void*>(&cover_sc_present), &old);
        if (s) g_real_sc_present = reinterpret_cast<sc_present_t>(old);
        sc->Release();
    }
    ::InterlockedExchange(&g_cover_on, 1);
    ENW_INFO("boot: black cover ON at the first frame (device Present %s, swap chain Present "
             "%s); it lifts once the connect is under way. ENW_BOOT_COVER=0 turns it off.",
             d ? "hooked" : "NOT hooked", s ? "hooked" : "NOT hooked");
}

void cover_lift(const char* why) {
    if (!::InterlockedExchange(&g_cover_on, 0)) return;
    ENW_INFO("boot: black cover lifted (%s) after %ld painted frame(s)", why,
             static_cast<long>(g_covered));
}

// ------------------------------------------------------------------ the frame tick --

void tick(uint64_t frame) {
    g_frames = frame;
    const int state = clc_state();
    const ULONGLONG t = since_start();
    if (g_last_state < 0 && g_armed && g_direct) {
        // The capture instrument patches Present first, so our cover runs before it and
        // the saved picture is the painted one -- exactly what reaches the screen.
        if (g_capture) frame_capture::request("boot-first-frame");
        cover_install();
        mute_begin();
    }
    if (g_last_state < 0)
        ENW_INFO("boot: first frame tick after post_init: frame %llu, +%llu ms since process "
                 "start (clc.state=%d)", static_cast<unsigned long long>(frame), t, state);
    if (state != g_last_state) {
        ENW_INFO("boot: clc.state %d -> %d at frame %llu, +%llu ms since process start", g_last_state,
                 state, static_cast<unsigned long long>(frame), t);
        g_last_state = state;
    }
    if (!g_in_game && state == kCaActive) {
        g_in_game = true;
        g_in_game_ms = now_ms();
        ENW_INFO("boot: FIRST IN-GAME FRAME at frame %llu: +%llu ms since process start, "
                 "+%llu ms since post_init, +%llu ms since connect (direct boot %s, popups %s)",
                 static_cast<unsigned long long>(frame), t, now_ms() - g_post_init_ms,
                 g_connect_ms ? now_ms() - g_connect_ms : 0ULL, g_direct && g_armed ? "ON" : "off",
                 g_sites_patched && g_popups_off ? "suppressed" : "shown");
        mute_end("first in-game frame");
    }
    // Never leave the player muted: a join that never arrives gives the sound back.
    if (g_mute == mute_state::muted && now_ms() - g_mute_ms > 60000) mute_end("60 s without a game");
    mute_tick();

    if (g_cover_on && ((g_connected && state >= 5) || state == kCaActive ||
                       now_ms() - g_post_init_ms > 30000))
        cover_lift(state == kCaActive ? "in game" : g_connected ? "connect under way" : "30 s");

    if (g_capture) {
        const ULONGLONG n = now_ms();
        const bool window = !g_in_game || n - g_in_game_ms < 2000;
        // Every frame for the first 12 after post_init (the menu would be there), then 4 Hz.
        const bool early = frame <= g_post_init_frame + 12;
        if (window && (early || n >= g_next_capture_ms)) {
            g_next_capture_ms = n + 250;
            char name[64];
            std::snprintf(name, sizeof name, "boot-%05llu-f%llu-s%d", t,
                          static_cast<unsigned long long>(frame), state);
            frame_capture::request(name);
        }
    }
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

class boot_direct_component final : public component {
public:
    const char* name() const override { return "boot_direct"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_load() override {
        g_client = true;
        FILETIME c{}, e{}, k{}, u{};
        if (::GetProcessTimes(::GetCurrentProcess(), &c, &e, &k, &u)) {
            ULARGE_INTEGER q;
            q.LowPart = c.dwLowDateTime;
            q.HighPart = c.dwHighDateTime;
            g_proc_start_ms = q.QuadPart / 10000ULL;
        }
        const char* m = std::getenv("ENW_CLIENT_CONNECT");
        g_armed = m && *m;
        g_direct = !env_is("ENW_DIRECT_BOOT", '0');
        g_popups_off = !env_is("ENW_SHOW_ONLINE_WARNING", '1');
        g_mute_wanted = !env_is("ENW_BOOT_MUTE", '0');
        g_capture = env_is("ENW_BOOT_CAPTURE", '1');
        g_cover_wanted = !env_is("ENW_BOOT_COVER", '0');
        if (const char* f = std::getenv("ENW_DIRECT_BOOT_MIN_FRAME"); f && *f)
            g_min_frame = static_cast<uint64_t>(std::strtoull(f, nullptr, 10));
        ENW_INFO("boot: +%llu ms since process start at post_load; join %s, direct boot %s, "
                 "online popups %s, mute %s", since_start(), g_armed ? "armed" : "not armed",
                 g_direct ? "on" : "OFF (ENW_DIRECT_BOOT=0)",
                 g_popups_off ? "suppressed" : "SHOWN (ENW_SHOW_ONLINE_WARNING=1)",
                 g_mute_wanted ? "on" : "off");
    }

    // Patched either way: with ENW_SHOW_ONLINE_WARNING=1 the thunk passes every name
    // through and only logs it, which is how the "before" run names the popup it shows.
    void post_unpack() override { patch_popups(); }

    void post_init() override {
        g_post_init_ms = now_ms();
        g_post_init_frame = enw::frame::count();
        uint8_t got[sizeof kCbufSig] = {};
        g_cbuf_ok = memory::read_raw(kCbufAddText, got, sizeof got) &&
                    std::memcmp(got, kCbufSig, sizeof got) == 0;
        ENW_INFO("boot: post_init +%llu ms since process start (Cbuf_AddText %s)", since_start(),
                 g_cbuf_ok ? "ok" : "MISMATCH - no mute");
        enw::frame::subscribe("boot_direct", tick);
        // NOT the mute. post_init runs inside Com_Init, BEFORE the command line's own
        // `+set`s have executed (they are queued at the end of Com_Init and run in the
        // first frame): boot-after3 read snd_volume 0 here while `+set snd_volume 0.003`
        // was still to come, and "restored" the player to 0. The mute starts in the first
        // frame tick, from the value the player actually has.
    }

    void pre_destroy() override {
        // Exiting mid-mute: give the archive bit back if we took it, and put the player's
        // value back directly when the dvar is a registered float, so a clean shutdown's
        // config write carries their value, not our 0.
        if (g_mute_dvar && (g_mute == mute_state::muted || g_mute == mute_state::restoring)) {
            __try {
                if (dvar_type(g_mute_dvar) == kDvarFloat)
                    *reinterpret_cast<float*>(static_cast<char*>(g_mute_dvar) + kDvarCurrent) =
                        g_saved_volume;
                if (g_cleared_archive) dvar_flags(g_mute_dvar) |= kDvarArchive;
            } __except (EXCEPTION_EXECUTE_HANDLER) {
            }
        }
    }
};

}  // namespace

bool enabled() { return g_client && g_armed && g_direct; }

bool fire_now(uint64_t frame, unsigned long long ms_since_post_init, int clc_state_now,
              long file_videos_open) {
    if (!enabled()) return false;
    if (frame < g_post_init_frame + g_min_frame) return false;
    if (file_videos_open != 0 || clc_state_now == kCaCinematic) return false;
    ENW_INFO("boot: DIRECT BOOT firing at frame %llu, +%llu ms after post_init, +%llu ms since "
             "process start (clc.state=%d, no file video open); the main menu is skipped",
             static_cast<unsigned long long>(frame), ms_since_post_init, since_start(),
             clc_state_now);
    return true;
}

void note_connect() {
    g_connected = true;
    g_connect_ms = now_ms();
    ENW_INFO("boot: CL_ConnectLocal returned at +%llu ms since process start", since_start());
}

void lift_cover(const char* why) { cover_lift(why); }

}  // namespace enw::client::boot_direct

ENW_REGISTER_COMPONENT(enw::client::boot_direct::boot_direct_component)
