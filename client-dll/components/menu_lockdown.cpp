// The main-menu lockdown: an ENW game never shows World at War's main menu. esc-menu.md §10.1.
//
// B, 2026-09-23: "players must never reach WaW's stock main menu". The boot already skips it
// (boot_direct.cpp, client.md §10). This is the other end: when a session ends -- the box
// tore the instance down after a game over, a timeout, a kick, a Com_Error drop, the Esc
// menu's Exit, or the stock pause menu's Quit in Play Local -- the engine falls back to its
// main menu (clc.state 2). From the first frame of that fall-back our own screen covers the
// whole picture; after 1.5 s at the menu (a map change passes through the same state for a
// frame or two) it says why, counts down four seconds and sends `quit`. The launcher, which
// is our menu, is back in front; its follow gate (followgate.js) does not boot the player
// straight back in, and a live game stays resumable from the server card.
//
// THE SILENT SERVER. Measured (l12b): a server killed after a game over sends no disconnect,
// and this engine never times the client out -- 60 s at clc.state 10 on the black game-over
// scoreboard with cl_timeout 10. So a map with no in-band datagram from the server for 20 s
// (net_probe_client's recvfrom tap; ENW_LOCKDOWN_SILENCE_S, 0 = off) is a session that has
// ended too: "Lost the connection to the server.", then the same countdown and quit.
//
// WHERE IT DRAWS. After SCR_DrawScreenField (0x478DC0), the call that draws the main menu,
// the console and the connect screen: join_retry.cpp owns that call site (README hard rule
// 9) and calls draw_over() after the engine and after its own waiting line. So what we draw
// is on top of everything the engine drew. UI_DrawText / R_TextWidth are byte-checked there
// before the seam is bound; R_AddCmdDrawStretchPic is checked here. Placement scrPlaceFull
// (0x957360), the one the engine's connect screen uses; WaW's stock font (stock_font.cpp).
//
// ARMED only for a game the ENW launcher (or the dev harness, which does the same) started:
// ENW_LOCALAPPDATA is set. A plain World at War started from Steam is left alone. Developer
// switch ENW_MAIN_MENU=1: the stock behaviour (nothing covered, nothing quit).
#include "component.hpp"
#include "frame.hpp"
#include "game.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "menu_lockdown.hpp"
#include "menu_lockdown_model.hpp"
#include "notice_board.hpp"
#include "session_record.hpp"

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace enw::client {
namespace stock_font { void* pick(float real_scale); }   // stock_font.cpp
namespace frame_capture { bool request(const char* name); }   // frame_capture.cpp
namespace net_probe_client_api { ULONGLONG last_inband_tick(); }   // net_probe_client.cpp
namespace menu_lockdown {
namespace {

constexpr uintptr_t kClcState = 0x305842C;
constexpr uintptr_t kUIDrawText = 0x5B5FB0;    // byte-checked by join_retry before the seam binds
constexpr uintptr_t kRTextWidth = 0x6E8DA0;    // ditto
constexpr uintptr_t kRStretchPic = 0x6F58E0;
constexpr uint8_t kStretchSig[] = {0x53, 0x8B, 0x5C, 0x24, 0x2C, 0x85, 0xDB, 0x55};   // chat_overlay.cpp's check
constexpr uintptr_t kCbufAddText = 0x594200;
constexpr uint8_t kCbufSig[] = {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02};
constexpr uintptr_t kScrPlaceFull = 0x957360;
constexpr uintptr_t kWhiteMaterial = 0x4DA8F4C;
constexpr uintptr_t kVidDisplayW = 0x4DA90B8;
constexpr uintptr_t kVidDisplayH = 0x4DA90BC;

template <typename T>
T rd(uintptr_t a) { return *reinterpret_cast<volatile T*>(a); }

bool g_armed = false;
bool g_draw_ok = false;
bool g_cbuf_ok = false;
::enw::lockdown::tracker g_t;
int g_last_state = -1;
std::string g_reason;
std::string g_notice;
long g_faults = 0;
long g_covered_frames = 0;
bool g_captured = false;

uintptr_t g_ui_draw_text = kUIDrawText;
uintptr_t g_r_text_width = kRTextWidth;

__declspec(naked) void __cdecl ui_draw_text(const void*, const char*, int, void*, float, float,
                                            float, const float*, int, int, int) {
    __asm {
        push ebp
        mov ebp, esp
        push dword ptr [ebp + 0x28]
        push dword ptr [ebp + 0x24]
        push dword ptr [ebp + 0x20]
        push dword ptr [ebp + 0x1C]
        push dword ptr [ebp + 0x18]
        push dword ptr [ebp + 0x14]
        push dword ptr [ebp + 0x10]
        push dword ptr [ebp + 0x0C]
        push dword ptr [ebp + 0x08]
        mov ecx, [ebp + 0x2C]
        mov eax, [ebp + 0x30]
        mov edx, g_ui_draw_text
        call edx
        add esp, 0x24
        pop ebp
        ret
    }
}

__declspec(naked) int __cdecl r_text_width(const char*, int, void*) {
    __asm {
        mov eax, [esp + 4]
        push dword ptr [esp + 12]
        push dword ptr [esp + 12]
        mov ecx, g_r_text_width
        call ecx
        add esp, 8
        ret
    }
}

void cbuf(const char* text) {
    const uintptr_t fn = kCbufAddText;
    __asm {
        mov eax, text
        xor ecx, ecx
        mov edx, fn
        call edx
    }
}

using stretch_pic_t = void(__cdecl*)(float, float, float, float, float, float, float, float, const float*, void*);

bool bytes_at(uintptr_t at, const uint8_t* want, size_t n) {
    uint8_t got[16] = {};
    return n <= sizeof got && memory::read_raw(at, got, n) && std::memcmp(got, want, n) == 0;
}

bool copy_error_message(char* buf, int n) {
    __try {
        const auto* d = reinterpret_cast<const uint8_t*>(game::find_dvar("com_errorMessage"));
        if (!d) return false;
        const char* s = *reinterpret_cast<const char* const*>(d + 0x10);
        if (!s) return false;
        int i = 0;
        for (; i < n - 1 && s[i]; ++i) buf[i] = s[i];
        buf[i] = 0;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

std::string error_message() {
    char buf[160] = {};
    return copy_error_message(buf, sizeof buf) ? std::string(buf) : std::string();
}

void centred(const char* s, float y, float scale, const float* color) {
    const float sy = rd<float>(kScrPlaceFull + 0x4);
    void* font = stock_font::pick(sy * scale);
    if (!font) return;
    const int ph = rd<int>(reinterpret_cast<uintptr_t>(font) + 4);
    if (ph <= 0 || ph > 256) return;
    const float w = static_cast<float>(r_text_width(s, 0x7FFFFFFF, font)) * scale * 48.0f / static_cast<float>(ph);
    ui_draw_text(reinterpret_cast<const void*>(kScrPlaceFull), s, 0x7FFFFFFF, font, 320.0f - w * 0.5f, y, scale, color,
                 3 /*shadowed*/, 0, 0);
}

void draw_inner() {
    // The whole picture, in real pixels: nothing of the menu shows at any size or aspect.
    static const float black[4] = {0.f, 0.f, 0.f, 1.f};
    void* mat = rd<void*>(kWhiteMaterial);
    const int w = rd<int>(kVidDisplayW), h = rd<int>(kVidDisplayH);
    if (!mat || w <= 0 || h <= 0) return;
    reinterpret_cast<stretch_pic_t>(kRStretchPic)(0.f, 0.f, static_cast<float>(w), static_cast<float>(h), 0, 0, 1, 1, black, mat);
    if (++g_covered_frames == 2) frame_capture::request("lockdown-cover");   // a no-op unless ENW_FRAME_CAPTURE=1
    if (!g_t.shown) return;   // the first 1.5 s: black only (a map change may still come back)
    if (!g_captured && ::GetTickCount64() - g_t.shown_at > 1200) { g_captured = true; frame_capture::request("lockdown-screen"); }
    static const float white[4] = {1.f, 1.f, 1.f, 1.f};
    static const float grey[4] = {0.7f, 0.7f, 0.7f, 1.f};
    const ULONGLONG now = ::GetTickCount64();
    const int left = static_cast<int>((g_t.show_ms - (std::min)(static_cast<ULONGLONG>(g_t.show_ms), now - g_t.shown_at) + 999) / 1000);
    char line[96];
    std::snprintf(line, sizeof line, "Back to the launcher in %d", left > 0 ? left : 0);
    static const float gold[4] = {0.93f, 0.82f, 0.45f, 1.f};
    centred(g_reason.c_str(), 218.f, 0.42f, white);
    if (!g_notice.empty()) centred(g_notice.c_str(), 244.f, 0.32f, gold);   // "Your record has been uploaded."
    centred(line, g_notice.empty() ? 244.f : 268.f, 0.3f, grey);
}

void tick(uint64_t) {
    const int s = rd<int>(kClcState);
    if (s != g_last_state) {
        if (g_t.session || s >= 4) ENW_INFO("lockdown: clc.state %d -> %d", g_last_state, s);
        g_last_state = s;
    }
    const ULONGLONG now = ::GetTickCount64();
    const ULONGLONG last = net_probe_client_api::last_inband_tick();   // 0: never measured
    const ::enw::lockdown::step st = g_t.feed(now, s, last && now > last ? now - last : 0);
    if (st == ::enw::lockdown::step::show && g_t.lost)
        ENW_INFO("lockdown: the server has sent nothing for %llu ms while in the map (clc.state %d) -- the engine "
                 "never times this out, so the session is over", now - last, s);
    if (st == ::enw::lockdown::step::show) {
        const std::string err = error_message();
        g_reason = g_t.lost ? std::string("Lost the connection to the server.") : ::enw::lockdown::describe(err, g_t.reached_map);
        // session-<pid>.json: the error this session ended on (exit 'error' unless it is the
        // server closing the game, or empty -- session_record_format.hpp is_error_end).
        session_record::note_error(g_t.lost ? "Lost the connection to the server (it sent nothing while in the map)"
                                            : err.c_str());
        g_notice = notice_board::latest(10 * 60 * 1000);   // the site's newest word to this player, if recent
        if (!g_notice.empty()) ENW_INFO("lockdown: the end screen repeats the site's notice: '%s'", g_notice.c_str());
        if (g_t.lost)
            ENW_INFO("lockdown: END SCREEN (server silent); the player reads '%s'; quit in %u ms", g_reason.c_str(), g_t.show_ms);
        else
            ENW_INFO("lockdown: the game fell back to World at War's main menu (clc.state %d for %u ms after a session; "
                     "com_errorMessage '%s'). Covered from its first frame (%ld frame(s) so far); the player reads '%s'; "
                     "quit in %u ms", s, g_t.debounce_ms, err.c_str(), g_covered_frames, g_reason.c_str(), g_t.show_ms);
    } else if (st == ::enw::lockdown::step::quit) {
        ENW_INFO("lockdown: quit -- the launcher is the menu (%ld covered frame(s); the stock main menu was never shown)",
                 g_covered_frames);
        if (g_cbuf_ok) cbuf("quit\n");
        else ::ExitProcess(0);   // no engine quit available: never leave the player at the stock menu
    }
}

bool covering() { return g_armed && (g_t.shown || (g_t.session && g_t.low_since != 0)); }

}  // namespace

void draw_over() {
    if (!covering() || !g_draw_ok || g_faults >= 3) return;
    __try {
        draw_inner();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        if (++g_faults <= 3) ENW_ERROR("lockdown: fault 0x%08lX while drawing the cover", GetExceptionCode());
    }
}

bool swallow_input(UINT msg) {
    if (!g_armed || !g_t.shown) return false;
    switch (msg) {
    case WM_KEYDOWN: case WM_KEYUP: case WM_CHAR: case WM_SYSKEYDOWN: case WM_SYSKEYUP:
    case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_LBUTTONDBLCLK: case WM_RBUTTONDOWN: case WM_RBUTTONUP:
    case WM_MBUTTONDOWN: case WM_MBUTTONUP: case WM_XBUTTONDOWN: case WM_XBUTTONUP: case WM_MOUSEWHEEL:
        return true;
    default:
        return false;
    }
}

namespace {

class menu_lockdown_component final : public component {
public:
    const char* name() const override { return "menu_lockdown"; }
    bool is_supported() override {
        const char* cmd = ::GetCommandLineA();
        return !(cmd && std::strstr(cmd, "dedicated 1"));
    }
    void post_unpack() override {
        const char* lad = std::getenv("ENW_LOCALAPPDATA");
        if (!lad || !*lad) {
            ENW_INFO("lockdown: not an ENW launch (no ENW_LOCALAPPDATA): World at War's main menu is left alone");
            return;
        }
        const char* mm = std::getenv("ENW_MAIN_MENU");
        if (mm && mm[0] == '1') {
            ENW_WARN("lockdown: ENW_MAIN_MENU=1 -- the stock main menu is allowed (developer switch)");
            return;
        }
        g_armed = true;
        g_draw_ok = bytes_at(kRStretchPic, kStretchSig, sizeof kStretchSig);
        g_cbuf_ok = bytes_at(kCbufAddText, kCbufSig, sizeof kCbufSig);
        if (const char* d = std::getenv("ENW_LOCKDOWN_SILENCE_S"); d && *d) {   // 0 = off
            const long v = std::strtol(d, nullptr, 10);
            if (v == 0 || (v >= 5 && v <= 600)) g_t.silence_ms = static_cast<uint32_t>(v) * 1000;
        }
        if (const char* d = std::getenv("ENW_LOCKDOWN_SHOW_MS"); d && *d) {
            const long v = std::strtol(d, nullptr, 10);
            if (v >= 500 && v <= 60000) g_t.show_ms = static_cast<uint32_t>(v);
        }
        ENW_INFO("lockdown: armed. When a session falls back to the main menu it is covered from the first frame, "
                 "the player is told why, and the game quits after %u ms (cover %s, quit via %s). ENW_MAIN_MENU=1 off.",
                 g_t.show_ms, g_draw_ok ? "on" : "OFF: R_AddCmdDrawStretchPic did not match",
                 g_cbuf_ok ? "Cbuf_AddText" : "ExitProcess");
    }
    void post_init() override {
        if (!g_armed) return;
        frame::subscribe("menu_lockdown", tick);
    }
};

ENW_REGISTER_COMPONENT(menu_lockdown_component)

}  // namespace
}  // namespace menu_lockdown
}  // namespace enw::client
