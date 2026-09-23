// The in-game chat overlay: cross-server chat drawn by the game's own renderer.
//
// Plan: docs/kickstart/chat-overlay.md (built 2026-09-22, results in §9 there).
// B's spec, in substance: T toggles an overlay; the mouse leaves the game and can
// click it; it looks like World at War's own chat (same font, similar place);
// tabs Global / Party / DMs; Enter sends, Esc closes; it works and lands in the
// same place in borderless, exclusive fullscreen and windowed; solo verified
// games pause while it is open if "pause when using global chat" is on;
// multiplayer never pauses. Off switch: ENW_CHAT_OVERLAY=0.
//
// ============================================================================
// 1. THE DRAW HOOK, and why it is safe this time (chat-overlay.md §2)
// ============================================================================
// Two independent signals for every function below, as the plan demands.
//
// SIGNAL 1, STATIC (tools/re/t4map.py over the decrypted dump):
//   * The console's own renderer. CL_InitRenderer-equivalent 0x644BE0 registers
//     "white", "console" and "fonts/consoleFont" into cls (0x4DA8F4C/50/54). Every
//     console draw that uses that font builds render command 0xD in the frontend
//     command buffer ([0x3DCB4C4]); the one non-inlined builder of command 0xD
//     with 11 callers is 0x6F5F10 -- R_AddCmdDrawText(text, maxChars, font, x, y,
//     xScale, yScale, rotation, style; ecx = color). THIS IS THE FUNCTION THE
//     WITHDRAWN CHAT INJECTION CALLED AS "SV_SendServerCommand". It never was a
//     server command: it is the text renderer, and calling it from the server
//     frame with a (client, type, string) argument list is what corrupted the
//     command buffer at 0x3DCB4C0 and killed the capture (ac4e884).
//   * UI_DrawText 0x5B5FB0 (55 callers): scales by 48/font->pixelHeight, places
//     via ScrPlace_ApplyRect 0x47A450 (ecx = horzAlign, eax = vertAlign, jump
//     tables 0x47A620 / 0x47A640), rounds, and calls 0x6F5F10. That is the
//     engine's 640x480 virtual-screen text call.
//   * CG_DrawChat 0x436900 -- World at War's own HUD chat, still in the SP exe:
//     it reads cg_hudChatPosition (dvar 0x3466098, default 5,200), cg_chatHeight
//     (0x3466540, default 5) and cg_chatTime (0x3688B34, default 12000 ms), picks
//     its font with the UI's scale thresholds (ui_smallFont 0x20A10A4 etc.) from
//     sharedUiInfo's fonts (0x20A10E8 big, 0x20A10EC small, 0x20A10F8 normal,
//     0x20A10FC extrabig -- registered by name at 0x5D10F5..0x5D11BB) at scale
//     1/3, and draws with UI_DrawText on scrPlaceView (0x957318). We copy its
//     numbers so our lines ARE WaW's chat lines.
//   * CG_Draw2D 0x4388A0 calls CG_DrawChat at 0x438A21. Its caller is
//     CG_DrawActiveFrame 0x4621E0 (`call CG_Draw2D` at 0x4628AB, eax =
//     localClientNum). (0x4388A0 and 0x4621E0 are the two addresses the map
//     once named ClientCommand / SV_ExecuteClientCommand: both retracted, and
//     this is what they actually are.)
//   * R_AddCmdDrawStretchPic 0x6F58E0 (18 callers, plain cdecl, 10 args) and
//     R_TextWidth 0x6E8DA0 (32 callers; eax = text, stack maxChars, font).
//
// SIGNAL 2, BEHAVIOURAL: the thing is drawn and the game is LOOKED AT.
// ENW_CHAT_SELFTEST=1 draws the demo lines and takes the game's own
// `screenshotJPEG` of the frame; those pictures are in docs/kickstart/ui/.
//
// THE SEAM. We retarget the one `call CG_Draw2D` at 0x4628AB (one rel32, as
// frame.cpp does for Com_Frame -- nothing is detoured and no MinHook address is
// taken), call the real CG_Draw2D, then draw. That is inside the client frame,
// on the main thread, in the same render-command window CG_Draw2D itself fills:
// the only time a 2D command may be added. Nothing is ever drawn from any other
// thread or frame, which is exactly the mistake the withdrawn injection made.
//
// RESOLUTION INDEPENDENCE. Every coordinate here is in the engine's 640x480
// virtual space, placed through scrPlaceView (LEFT/TOP alignment: x*sx + minX,
// y*sy + minY, read from the ScreenPlacement the engine itself maintains) -- so
// borderless, exclusive fullscreen and windowed, at any resolution and aspect,
// land in the same place relative to the HUD, because the HUD is placed the
// same way.
//
// ============================================================================
// 2. INPUT (chat-overlay.md §3, amended by B's spec)
// ============================================================================
// Through the ONE subclass mouse_polling owns (input_gate.hpp). Closed: T (or
// ENW_CHAT_KEY) while in a map, with no console/menu up, opens it -- the key is
// swallowed. Open: every WM_KEYDOWN / WM_CHAR is ours. WM_KEYUP is passed to the
// engine on purpose: a key-up for a key the engine thinks is up is a no-op, and
// passing them is what lets a key released while typing reach the engine. On
// open, every key the engine believes is held gets a synthetic key-up so the
// player does not keep walking into a horde while typing. The mouse is CAPTURED
// (input_gate): no motion, no buttons to the game, legacy messages back on; we
// draw WaW's own UI cursor (sharedUiInfo.assets.cursor, 0x20A10D4) at the OS
// cursor position, so the pointer exists in exclusive fullscreen too, and the
// OS cursor is hidden over the window.
//
// ============================================================================
// 3. THE CHANNEL
// ============================================================================
// Straight to the site over WinHTTP, never the engine's net path: long-poll
// GET /api/game-chat/feed, POST /api/game-chat/send, GET /api/game-chat/me,
// with the per-launch bearer the launcher hands over on the token pipe
// (chat_link.hpp). Two worker threads (poll, send); the main thread only ever
// touches a mutex-guarded inbox.
//
// ============================================================================
// 4. PAUSE (the client half of the contract in chat-overlay.md §8)
// ============================================================================
// The client does not decide. It reports, through two USERINFO dvars the engine
// re-sends on change (CL_CheckUserinfo's `userinfo "%s"`, 0x644B76), and the
// SERVER applies B's rule (server/components/pause/pause_policy.hpp):
//     enw_ui    typing  while the overlay is open
//               paused  while the Esc/pause menu is open in a game (menu wins)
//               clear   otherwise
//     enw_pchat 1|0     the account's "pause when using global chat" (default 1)
// Solo: paused on `paused`, or on `typing` with enw_pchat 1. Co-op: typing never
// pauses. Set with the engine's own `setu` through Cbuf_AddText, only on change.
//
// (A first cut sent a new reliable client command, `enwchat`. The stock game
// answers an unknown client command with a visible "Unknown cmd" line on the
// player's HUD -- seen in the first capture -- so it was dropped for the
// userinfo contract the server lane had already written down.)
#include "component.hpp"
#include "frame.hpp"
#include "json.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "chat_link.hpp"
#include "input_gate.hpp"
#include "pause_menu.hpp"   // the Esc menu (pause_menu.cpp): hook points marked [esc-menu]

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "winhttp.lib")

namespace enw::client {
namespace frame_capture { bool request(const char* name); }  // frame_capture.cpp
namespace stock_font { void on_first_map_frame(); void* pick(float real_scale); }  // stock_font.cpp
namespace {

// ------------------------------------------------------------------ addresses
// Local to this lane (name_pin.cpp does the same), each checked at runtime.
constexpr uintptr_t kCallCGDraw2D = 0x4628AB;   // E8 -> 0x4388A0 inside CG_DrawActiveFrame
constexpr uintptr_t kCGDraw2D = 0x4388A0;       // usercall eax = localClientNum
constexpr uintptr_t kUIDrawText = 0x5B5FB0;     // cdecl x9 + ecx horz, eax vert
constexpr uintptr_t kRStretchPic = 0x6F58E0;    // cdecl x10
constexpr uintptr_t kRTextWidth = 0x6E8DA0;     // eax text; stack maxChars, font
constexpr uintptr_t kCbufAddText = 0x594200;    // eax text, ecx localClient

constexpr uintptr_t kScrPlaceView = 0x957318;   // ScreenPlacement[], stride 0x48
constexpr uintptr_t kWhiteMaterial = 0x4DA8F4C;  // cls.whiteMaterial
constexpr uintptr_t kUiCursor = 0x20A10D4;      // sharedUiInfo.assets.cursor
constexpr uintptr_t kFontBig = 0x20A10E8;
constexpr uintptr_t kFontSmall = 0x20A10EC;
constexpr uintptr_t kFontNormal = 0x20A10F8;
constexpr uintptr_t kFontExtraBig = 0x20A10FC;
constexpr uintptr_t kDvarUiSmallFont = 0x20A10A4;
constexpr uintptr_t kDvarUiExtraBigFont = 0x208E8C4;
constexpr uintptr_t kDvarUiBigFont = 0x208C8B4;
constexpr uintptr_t kDvarHudChatPos = 0x3466098;  // vec2 cg_hudChatPosition
constexpr uintptr_t kDvarChatHeight = 0x3466540;  // int  cg_chatHeight
constexpr uintptr_t kDvarChatTime = 0x3688B34;    // int  cg_chatTime
constexpr uintptr_t kClcState = 0x305842C;
constexpr uintptr_t kKeyCatchers = 0x3058424;
constexpr uintptr_t kVidDisplayW = 0x4DA90B8;   // cls.vidConfig.displayWidth
constexpr uintptr_t kVidDisplayH = 0x4DA90BC;
constexpr uintptr_t kDvarValue = 0x10;          // dvar_t current value

struct sig { uintptr_t at; const char* name; std::vector<uint8_t> bytes; };
const sig kSigs[] = {
    {kCGDraw2D, "CG_Draw2D", {0x53, 0x56, 0x57, 0xBE, 0xB8, 0x32, 0x47, 0x03}},
    {kUIDrawText, "UI_DrawText", {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF8, 0x83, 0xEC, 0x0C, 0x8B, 0x55, 0x08}},
    {kRStretchPic, "R_AddCmdDrawStretchPic", {0x53, 0x8B, 0x5C, 0x24, 0x2C, 0x85, 0xDB, 0x55}},
    {kRTextWidth, "R_TextWidth", {0x83, 0xEC, 0x08, 0x53, 0x55, 0x33, 0xED, 0x33, 0xDB}},
    {kCbufAddText, "Cbuf_AddText", {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02}},
};

template <typename T>
T rd(uintptr_t a) { return *reinterpret_cast<volatile T*>(a); }

// ------------------------------------------------------------ engine thunks
uintptr_t g_cg_draw2d = kCGDraw2D;
uintptr_t g_ui_draw_text = kUIDrawText;
uintptr_t g_r_text_width = kRTextWidth;
uintptr_t g_cbuf = kCbufAddText;

// UI_DrawText: nine stack arguments, caller cleans (CG_DrawChat's `add esp,0x24`
// after 0x436C00), with horzAlign in ECX and vertAlign in EAX. No C calling
// convention says that, so a naked thunk makes the call exactly as the engine does.
__declspec(naked) void __cdecl ui_draw_text(const void* /*scrPlace*/, const char* /*text*/,
                                            int /*maxChars*/, void* /*font*/, float /*x*/,
                                            float /*y*/, float /*scale*/, const float* /*color*/,
                                            int /*style*/, int /*horz*/, int /*vert*/) {
    __asm {
        push ebp
        mov ebp, esp
        push dword ptr [ebp + 0x28]   // style
        push dword ptr [ebp + 0x24]   // color
        push dword ptr [ebp + 0x20]   // scale
        push dword ptr [ebp + 0x1C]   // y
        push dword ptr [ebp + 0x18]   // x
        push dword ptr [ebp + 0x14]   // font
        push dword ptr [ebp + 0x10]   // maxChars
        push dword ptr [ebp + 0x0C]   // text
        push dword ptr [ebp + 0x08]   // scrPlace
        mov ecx, [ebp + 0x2C]         // horzAlign
        mov eax, [ebp + 0x30]         // vertAlign
        mov edx, g_ui_draw_text
        call edx
        add esp, 0x24
        pop ebp
        ret
    }
}

// R_TextWidth: text in EAX, then (maxChars, font) on the stack, caller cleans.
__declspec(naked) int __cdecl r_text_width(const char* /*text*/, int /*maxChars*/,
                                           void* /*font*/) {
    __asm {
        mov eax, [esp + 4]
        push dword ptr [esp + 12]     // font
        push dword ptr [esp + 12]     // maxChars (esp moved by 4)
        mov ecx, g_r_text_width
        call ecx
        add esp, 8
        ret
    }
}

void cbuf_add_text(const char* text) {
    const uintptr_t fn = g_cbuf;
    __asm {
        mov eax, text
        xor ecx, ecx
        mov edx, fn
        call edx
    }
}

using stretch_pic_t = void(__cdecl*)(float, float, float, float, float, float, float, float,
                                     const float*, void*);

// --------------------------------------------------------------------- model
enum channel : int { CH_GLOBAL = 0, CH_PARTY = 1, CH_DM = 2 };

struct chat_line {
    int ch = CH_GLOBAL;
    long long id = 0;          // site id within its ring (global / private)
    bool system = false;
    bool mine = false;
    bool local = false;        // a line we made up (errors, status); never from the site
    std::string from;          // display name, sanitised
    std::string from_sid;
    std::string peer_sid;      // DM: the other person
    std::string peer_name;
    std::string text;          // sanitised, Latin-1
    DWORD arrived = 0;         // GetTickCount when it reached us
    // wrap cache
    void* wrap_font = nullptr;
    float wrap_width = 0.f;
    std::vector<std::string> wrapped;
};

struct contact { std::string sid, name; bool party = false; };

struct me_info {
    bool have = false;
    std::string sid, name;
    bool pause_on_chat = true;
    long long party_id = 0;
    std::vector<contact> contacts;
};

// ---- shared with the network threads (g_mu) ----
std::mutex g_mu;
std::vector<chat_line> g_inbox;
me_info g_me_net;
bool g_me_dirty = false;
std::string g_net_status = "offline";
bool g_net_ok = false;

struct outgoing { int ch; std::string to_sid; std::string text; };
std::deque<outgoing> g_outbox;
std::condition_variable g_out_cv;

std::atomic<bool> g_stop{false};
std::thread g_poll_thread, g_send_thread;
HINTERNET g_session = nullptr;

// ---- main thread only ----
bool g_enabled = true;
bool g_bound = false;
bool g_open = false;
bool g_embedded = false;                 // [esc-menu] open as part of the Esc menu
float g_anchor_x = 5.f, g_anchor_y = 200.f;  // [esc-menu] its anchor while embedded

// Tabs (round 2, B: "use tabs properly; a DM tab per conversation"). Global and
// Party are fixed; every DM conversation is its own tab; "+" is the recipient
// picker. Tab / Shift+Tab / Ctrl+Tab cycle them.
enum tab_kind : int { T_GLOBAL = 0, T_PARTY = 1, T_DM = 2, T_NEW = 3 };
struct tab_t { int kind; std::string sid, name; int unread = 0; };
std::vector<tab_t> g_tabs = {{T_GLOBAL, "", "Global"}, {T_PARTY, "", "Party"}, {T_NEW, "", "+"}};
int g_tab = 0;

// The input line: a real text box. g_anchor == g_caret means no selection.
constexpr size_t kMaxInput = 150;
std::string g_input;
size_t g_caret = 0, g_anchor = 0;
size_t g_in_scroll = 0;          // first visible character when the line is wider than the box
bool g_focus_input = true;       // false: the history has the keyboard (Ctrl+A/C act on it)
DWORD g_blink_t = 0;
std::vector<std::string> g_sent_hist;   // Up / Down recall
int g_hist_pos = -1;

// History selection, (row, col) over the active tab's rows, oldest row = 0.
struct hpos { int row = -1; int col = 0; };
hpos g_hsel_a, g_hsel_b;
int g_scroll = 0;                // rows scrolled up from the bottom

// Mouse.
enum drag_kind : int { D_NONE, D_INPUT, D_HIST };
int g_drag = D_NONE;
bool g_drag_moved = false;
int g_down_x = 0, g_down_y = 0;
DWORD g_last_click_t = 0;
int g_last_click_x = -100, g_last_click_y = -100, g_click_count = 0;
std::string g_pending_dm_sid, g_pending_dm_name;   // a name was pressed: opens on release
bool g_ctrl_seen = false, g_shift_seen = false;    // modifiers as the message stream saw them
std::string g_fake_clip;                            // selftest only: never touch B's clipboard
long g_clicks = 0;

std::deque<chat_line> g_lines;
me_info g_me;
std::string g_last_dm_sid, g_last_dm_name;          // for /r
int g_open_vk = 'T';
bool g_eat_char = false;
char g_eat_ctrl_char = 0;      // the letter of a Ctrl+letter just handled
DWORD g_last_draw = 0;
DWORD g_streak_start = 0;      // when CG last started drawing after a gap
int g_mouse_x = -1, g_mouse_y = -1;  // client pixels, from WM_MOUSEMOVE
bool g_mouse_in = false;
bool g_selftest = false;
DWORD g_first_draw = 0;
bool g_notify_pause = true;    // ENW_CHAT_NOTIFY=0: never touch enw_ui / enw_pchat
std::string g_ui_sent;         // last enw_ui we set
int g_pchat_sent = -1;         // last enw_pchat we set
long g_draws = 0, g_opens = 0, g_sent = 0;
bool g_logged_first_draw = false;
std::string g_base, g_bearer;

// Last layout, in virtual units, for hit-testing clicks.
struct rect { float x, y, w, h; bool hit(float px, float py) const {
    return px >= x && px < x + w && py >= y && py < y + h; } };
std::vector<rect> g_tab_rects;
rect g_input_rect = {};
rect g_hist_rect = {};
rect g_close_rect = {};
float g_input_text_x = 0.f;      // where the input text starts, virtual
float g_input_room = 0.f;        // its visible width
float g_hist_x = 0.f, g_hist_base = 0.f;   // history text x, and the baseline of the newest row
int g_hist_rows_vis = 10;
std::vector<std::pair<rect, contact>> g_contact_rects;
bool g_net_ok_cached = false;
float g_place_sx = 1, g_place_sy = 1, g_place_ox = 0, g_place_oy = 0;

// ------------------------------------------------------------------ helpers
bool env_off(const char* k) { const char* v = std::getenv(k); return v && v[0] == '0' && !v[1]; }
bool env_on(const char* k) { const char* v = std::getenv(k); return v && v[0] && !(v[0] == '0' && !v[1]); }

// UTF-8 from the site -> the engine font's Latin-1, dropping colour codes and
// control characters. A player cannot put ^1 in front of their name, and nothing
// from the network can inject a newline or a colour code into our layout.
std::string sanitise(const std::string& in, size_t max_len) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size() && out.size() < max_len;) {
        unsigned char c = static_cast<unsigned char>(in[i]);
        unsigned cp = c;
        size_t n = 1;
        if (c >= 0x80) {
            if ((c & 0xE0) == 0xC0 && i + 1 < in.size()) { cp = ((c & 0x1F) << 6) | (in[i + 1] & 0x3F); n = 2; }
            else if ((c & 0xF0) == 0xE0 && i + 2 < in.size()) { cp = 0xFFFF; n = 3; }
            else if ((c & 0xF8) == 0xF0 && i + 3 < in.size()) { cp = 0xFFFF; n = 4; }
            else { cp = '?'; }
        }
        i += n;
        if (cp < 0x20 || cp == 0x7F) continue;
        if (cp == '^') {  // colour code: drop the caret and the digit after it
            if (i < in.size() && in[i] >= '0' && in[i] <= '9') ++i;
            continue;
        }
        out.push_back(cp <= 0xFF ? static_cast<char>(cp) : '?');
    }
    return out;
}

// Latin-1 typed in the game -> UTF-8 for the site.
std::string to_utf8(const std::string& latin1) {
    std::string out;
    for (unsigned char c : latin1) {
        if (c < 0x80) out.push_back(static_cast<char>(c));
        else { out.push_back(static_cast<char>(0xC0 | (c >> 6))); out.push_back(static_cast<char>(0x80 | (c & 0x3F))); }
    }
    return out;
}

void add_local(int ch, const std::string& text, bool system = true, const std::string& peer = "") {
    chat_line l;
    l.ch = ch; l.local = true; l.system = system; l.text = text; l.arrived = ::GetTickCount();
    l.peer_sid = peer;
    g_lines.push_back(std::move(l));
    while (g_lines.size() > 400) g_lines.pop_front();
}

// ------------------------------------------------------------------- the net
struct url_parts { std::wstring host; INTERNET_PORT port = 0; bool https = false; std::wstring path; };

bool crack(const std::string& base, url_parts* out) {
    std::wstring w(base.begin(), base.end());
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof uc;
    wchar_t host[256]{}, path[512]{};
    uc.lpszHostName = host; uc.dwHostNameLength = 255;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 511;
    if (!::WinHttpCrackUrl(w.c_str(), 0, 0, &uc)) return false;
    out->host = host;
    out->port = uc.nPort;
    out->https = uc.nScheme == INTERNET_SCHEME_HTTPS;
    out->path = path;
    while (!out->path.empty() && out->path.back() == L'/') out->path.pop_back();
    return !out->host.empty();
}

// One request. Returns the HTTP status, or -1 on a transport failure.
int http(const url_parts& u, const wchar_t* method, const std::string& path,
         const std::string& body, std::string* out, DWORD timeout_ms) {
    if (!g_session) return -1;
    HINTERNET c = ::WinHttpConnect(g_session, u.host.c_str(), u.port, 0);
    if (!c) return -1;
    std::wstring wpath = u.path + std::wstring(path.begin(), path.end());
    HINTERNET r = ::WinHttpOpenRequest(c, method, wpath.c_str(), nullptr, WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES,
                                       u.https ? WINHTTP_FLAG_SECURE : 0);
    int status = -1;
    if (r) {
        ::WinHttpSetTimeouts(r, 5000, 5000, 10000, static_cast<int>(timeout_ms));
        std::wstring hdr = L"Authorization: Bearer " +
                           std::wstring(g_bearer.begin(), g_bearer.end()) +
                           L"\r\nAccept: application/json\r\nX-ENW-Game: 1\r\n";
        if (!body.empty()) hdr += L"Content-Type: application/json\r\n";
        const BOOL sent = ::WinHttpSendRequest(
            r, hdr.c_str(), static_cast<DWORD>(-1),
            body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
            static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0);
        if (sent && ::WinHttpReceiveResponse(r, nullptr)) {
            DWORD code = 0, sz = sizeof code;
            ::WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                  WINHTTP_HEADER_NAME_BY_INDEX, &code, &sz, WINHTTP_NO_HEADER_INDEX);
            status = static_cast<int>(code);
            if (out) {
                out->clear();
                for (;;) {
                    DWORD avail = 0;
                    if (!::WinHttpQueryDataAvailable(r, &avail) || avail == 0) break;
                    if (out->size() + avail > (1u << 20)) break;
                    std::string chunk(avail, '\0');
                    DWORD got = 0;
                    if (!::WinHttpReadData(r, &chunk[0], avail, &got) || got == 0) break;
                    out->append(chunk.data(), got);
                }
            }
        }
        ::WinHttpCloseHandle(r);
    }
    ::WinHttpCloseHandle(c);
    return status;
}

chat_line line_from_json(const json::value& v, bool priv, const std::string& my_sid) {
    chat_line l;
    l.id = v.int_or("id", 0);
    const std::string ch = v.str_or("channel", "global");
    l.ch = !priv ? CH_GLOBAL : (ch == "party" ? CH_PARTY : CH_DM);
    l.system = v.str_or("kind") == "system";
    l.from = sanitise(v.str_or("from", "player"), 32);
    l.from_sid = v.str_or("steamid");
    l.text = sanitise(v.str_or("text"), 300);
    l.mine = !my_sid.empty() && l.from_sid == my_sid;
    if (l.ch == CH_DM) {
        if (l.mine) { l.peer_sid = v.str_or("to"); l.peer_name = sanitise(v.str_or("to_name"), 32); }
        else { l.peer_sid = l.from_sid; l.peer_name = l.from; }
    }
    l.arrived = ::GetTickCount();
    return l;
}

void set_status(const std::string& s, bool ok) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (s != g_net_status) ENW_INFO("chat_overlay: link %s", s.c_str());
    g_net_status = s;
    g_net_ok = ok;
}

bool fetch_me(const url_parts& u, std::string* my_sid) {
    std::string body;
    const int st = http(u, L"GET", "/api/game-chat/me", "", &body, 10000);
    json::value v;
    if (st != 200 || !json::parse(body, &v) || v.type != json::kind::object) {
        set_status(st == 401 ? "refused (401): the chat pass expired or was revoked"
                             : "cannot reach the site (" + std::to_string(st) + ")", false);
        return false;
    }
    me_info m;
    m.have = true;
    m.sid = v.str_or("steamid");
    m.name = sanitise(v.str_or("name"), 32);
    m.pause_on_chat = v.bool_or("pause_on_chat", true);
    if (const json::value* p = v.find("party"); p && p->type == json::kind::object) {
        m.party_id = p->int_or("id", 0);
        if (const json::value* mem = p->find("members"); mem && mem->type == json::kind::array)
            for (const auto& x : mem->items) {
                const std::string sid = x.str_or("steamid");
                if (sid.empty() || sid == m.sid) continue;
                m.contacts.push_back({sid, sanitise(x.str_or("name"), 32), true});
            }
    }
    if (const json::value* c = v.find("contacts"); c && c->type == json::kind::array)
        for (const auto& x : c->items) {
            const std::string sid = x.str_or("steamid");
            if (sid.empty() || sid == m.sid) continue;
            bool dup = false;
            for (const auto& e : m.contacts) dup |= e.sid == sid;
            if (!dup) m.contacts.push_back({sid, sanitise(x.str_or("name"), 32), false});
        }
    *my_sid = m.sid;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_me_net = std::move(m);
        g_me_dirty = true;
    }
    return true;
}

void poll_loop(url_parts u) {
    long long gcur = 0, pcur = 0;
    std::string my_sid;
    DWORD last_me = 0;
    int backoff = 1;
    while (!g_stop) {
        if (!last_me || ::GetTickCount() - last_me > 30000) {
            if (fetch_me(u, &my_sid)) last_me = ::GetTickCount();
            else {
                for (int i = 0; i < backoff * 10 && !g_stop; ++i) ::Sleep(100);
                backoff = (std::min)(backoff * 2, 30);
                continue;
            }
        }
        const std::string q = "/api/game-chat/feed?g=" + std::to_string(gcur) +
                              "&p=" + std::to_string(pcur) + "&wait=20";
        std::string body;
        const int st = http(u, L"GET", q, "", &body, 30000);
        if (g_stop) break;
        json::value v;
        if (st != 200 || !json::parse(body, &v) || v.type != json::kind::object) {
            set_status(st == 401 ? "refused (401): the chat pass expired or was revoked"
                                 : "lost the site (" + std::to_string(st) + "), retrying", false);
            if (st == 401) last_me = 0;
            for (int i = 0; i < backoff * 10 && !g_stop; ++i) ::Sleep(100);
            backoff = (std::min)(backoff * 2, 30);
            continue;
        }
        backoff = 1;
        set_status("connected", true);
        std::vector<chat_line> got;
        if (const json::value* a = v.find("global"); a && a->type == json::kind::array)
            for (const auto& x : a->items) got.push_back(line_from_json(x, false, my_sid));
        if (const json::value* a = v.find("private"); a && a->type == json::kind::array)
            for (const auto& x : a->items) got.push_back(line_from_json(x, true, my_sid));
        gcur = (std::max)(gcur, static_cast<long long>(v.int_or("g", gcur)));
        pcur = (std::max)(pcur, static_cast<long long>(v.int_or("p", pcur)));
        if (!got.empty()) {
            std::lock_guard<std::mutex> lk(g_mu);
            for (auto& l : got) g_inbox.push_back(std::move(l));
        }
    }
}

void send_loop(url_parts u) {
    while (!g_stop) {
        outgoing o;
        {
            std::unique_lock<std::mutex> lk(g_mu);
            g_out_cv.wait(lk, [] { return g_stop || !g_outbox.empty(); });
            if (g_stop) return;
            o = g_outbox.front();
            g_outbox.pop_front();
        }
        json::writer w;
        w.str("channel", o.ch == CH_PARTY ? "party" : o.ch == CH_DM ? "dm" : "global");
        if (o.ch == CH_DM) w.str("to", o.to_sid);
        w.str("text", to_utf8(o.text));
        std::string body;
        const int st = http(u, L"POST", "/api/game-chat/send", w.done(), &body, 10000);
        json::value v;
        const bool ok = st == 200 && json::parse(body, &v) && v.type == json::kind::object &&
                        v.bool_or("ok", false);
        std::lock_guard<std::mutex> lk(g_mu);
        if (ok) {
            if (const json::value* line = v.find("line"); line && line->type == json::kind::object) {
                chat_line l = line_from_json(*line, o.ch != CH_GLOBAL, g_me_net.sid);
                l.mine = true;
                g_inbox.push_back(std::move(l));
            }
        } else {
            chat_line l;
            l.ch = o.ch; l.local = true; l.system = true; l.arrived = ::GetTickCount();
            std::string err = v.type == json::kind::object ? v.str_or("error") : std::string();
            l.text = "^1Not sent: " + sanitise(err.empty() ? "the site said " + std::to_string(st) : err, 120);
            g_inbox.push_back(std::move(l));
        }
    }
}

void start_net() {
    if (!auth::chat_credentials(&g_base, &g_bearer)) {
        ENW_INFO("chat_overlay: no chat credentials (no launcher pipe, no ENW_CHAT_BASE/"
                 "ENW_CHAT_BEARER). The overlay works, and says it is offline.");
        set_status("offline: start the game from the ENW launcher to chat", false);
        return;
    }
    url_parts u;
    if (!crack(g_base, &u)) {
        ENW_ERROR("chat_overlay: cannot parse the chat base URL '%s'", g_base.c_str());
        set_status("offline: bad site address", false);
        return;
    }
    g_session = ::WinHttpOpen(L"ENW-Zombies-Game/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!g_session)  // pre-8.1 Windows has no AUTOMATIC_PROXY
        g_session = ::WinHttpOpen(L"ENW-Zombies-Game/1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!g_session) {
        ENW_ERROR("chat_overlay: WinHttpOpen failed (%lu)", ::GetLastError());
        set_status("offline: no HTTP stack", false);
        return;
    }
    ENW_INFO("chat_overlay: talking to %s directly over %s (the engine's net path is not used)",
             g_base.c_str(), u.https ? "HTTPS" : "HTTP");
    set_status("connecting", false);
    g_poll_thread = std::thread(poll_loop, u);
    g_send_thread = std::thread(send_loop, u);
}

void stop_net() {
    g_stop = true;
    g_out_cv.notify_all();
    if (g_session) { ::WinHttpCloseHandle(g_session); g_session = nullptr; }  // aborts the long poll
    if (g_poll_thread.joinable()) g_poll_thread.join();
    if (g_send_thread.joinable()) g_send_thread.join();
}

// --------------------------------------------------------------- the engine
bool in_game() { return g_last_draw && ::GetTickCount() - g_last_draw < 500; }

// The userinfo half of the pause contract. Called every frame from the frame
// tick; does work only when the answer changed.
bool esc_menu_open() {
    // A menu owns the keys (KEYCATCH_UI, 0x10) while we are in a map: that is the
    // Esc/pause menu. "In a map" is the CG draw clock, and only once it has run for
    // 2 s without a gap: the first networked run (chatpause1) showed the load screen
    // still holding 0x10 on the first CG frame, which paused a solo server for 62 ms.
    // The Esc menu keeps CG drawing underneath it, so the clock does not stop.
    const DWORD now = ::GetTickCount();
    const bool in_map = in_game() && g_streak_start && now - g_streak_start > 2000;
    return in_map && (rd<int>(kKeyCatchers) & 0x10) != 0;
}

// ---- the Esc menu on a REMOTE server --------------------------------------
// UI_SetActiveMenu(2) (0x5D6D74) sets cl_paused 1 when it opens "pausedmenu": the
// single-player way of pausing, which assumes the server is in this process. On a
// box it pauses only THIS client -- which then stops sending, so the enw_ui
// `paused` it just set never reaches the server (hold-on run, 01:00: client logged
// enw_ui paused, server logged nothing) and the zombies play on. With no local
// server (sv_running 0) we put cl_paused straight back to 0 through the engine's
// own setter (Dvar_SetIntByName 0x5EF930: EAX value, [esp+4] name): the client
// keeps talking, the server hears `paused` and freezes the game for real, and
// pause_hold keeps the picture still. Resume (0x5B6670) sets 0 itself.
constexpr uintptr_t kDvarSetIntByName = 0x5EF930;
constexpr uint8_t kDvarSetIntSig[] = {0x83, 0xEC, 0x24, 0x53, 0x8B, 0x5C, 0x24, 0x2C, 0x56, 0x57, 0x53, 0x8B, 0xF0};
int g_setint_ok = -1;
long g_unpaused_client = 0;

void dvar_set_int(const char* name, int value) {
    const uintptr_t fn = kDvarSetIntByName;
    __asm {
        push name
        mov eax, value
        mov edx, fn
        call edx
        add esp, 4
    }
}

void keep_remote_client_running() {
    const uintptr_t clp = rd<uintptr_t>(0x1F552C4), svr = rd<uintptr_t>(0x1F552DC);
    if (!clp || !svr) return;
    if (rd<int>(clp + kDvarValue) == 0 || rd<unsigned char>(svr + kDvarValue) != 0) return;
    if (rd<int>(kClcState) != 10) return;
    if (g_setint_ok < 0) {
        uint8_t got[sizeof kDvarSetIntSig] = {};
        g_setint_ok = memory::read_raw(kDvarSetIntByName, got, sizeof got) &&
                      std::memcmp(got, kDvarSetIntSig, sizeof got) == 0;
        if (!g_setint_ok) ENW_WARN("chat_overlay: 0x%08X is not Dvar_SetIntByName here; cl_paused left alone",
                                   static_cast<unsigned>(kDvarSetIntByName));
    }
    if (!g_setint_ok) return;
    dvar_set_int("cl_paused", 0);
    if (++g_unpaused_client <= 5)
        ENW_INFO("chat_overlay: the Esc menu set cl_paused 1 on a client of a REMOTE server; set it back "
                 "to 0 so this client keeps sending (the server pauses the game on enw_ui paused)");
}

void report_ui_state() {
    keep_remote_client_running();
    if (!g_notify_pause || !g_bound) return;
    const char* want = pause_menu::is_open() ? "paused"   // [esc-menu] menu wins
                     : g_open ? "typing" : esc_menu_open() ? "paused" : "clear";
    const int pchat = g_me.have ? (g_me.pause_on_chat ? 1 : 0) : 1;
    if (pchat != g_pchat_sent) {
        g_pchat_sent = pchat;
        cbuf_add_text(pchat ? "setu enw_pchat 1\n" : "setu enw_pchat 0\n");
        ENW_INFO("chat_overlay: userinfo enw_pchat %d (pause when chatting solo)", pchat);
    }
    if (g_ui_sent == want) return;
    g_ui_sent = want;
    char cmd[48];
    std::snprintf(cmd, sizeof cmd, "setu enw_ui %s\n", want);
    cbuf_add_text(cmd);
    ENW_INFO("chat_overlay: userinfo enw_ui %s (clc.state %d, keyCatchers 0x%X)", want,
             rd<int>(kClcState), rd<int>(kKeyCatchers));
}

// Release, in the engine, every key it believes is held -- the physical key-up
// may come while we own the keyboard, and a held W would walk the player on.
void release_engine_keys() {
    // GetAsyncKeyState is the DESKTOP's key state. Only when this window really has
    // the keyboard (the real GetForegroundWindow -- focus_guard hooks only the
    // engine's import) are those keys ours; otherwise they belong to whatever the
    // player is doing elsewhere and the engine never saw them go down.
    if (::GetForegroundWindow() != input_gate::window()) return;
    for (int vk = 0x08; vk <= 0xFE; ++vk) {
        // Alt and F10 are skipped outright: a synthetic WM_SYSKEYUP for either
        // reaches DefWindowProc as a menu-bar keystroke, and that can ACTIVATE the
        // window -- the one thing the overlay must never do.
        if (vk == VK_LBUTTON || vk == VK_RBUTTON || vk == VK_MBUTTON || vk == VK_XBUTTON1 ||
            vk == VK_XBUTTON2 || vk == g_open_vk || vk == VK_MENU || vk == VK_LMENU ||
            vk == VK_RMENU || vk == VK_F10)
            continue;
        if (!(::GetAsyncKeyState(vk) & 0x8000)) continue;
        const UINT sc = ::MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
        bool ext = false;
        switch (vk) {
        case VK_LEFT: case VK_RIGHT: case VK_UP: case VK_DOWN: case VK_INSERT: case VK_DELETE:
        case VK_HOME: case VK_END: case VK_PRIOR: case VK_NEXT: case VK_RCONTROL: case VK_RMENU:
        case VK_DIVIDE: case VK_NUMLOCK: ext = true; break;
        default: break;
        }
        const LPARAM lp = 1 | (static_cast<LPARAM>(sc & 0xFF) << 16) | (ext ? (1 << 24) : 0) |
                          (1 << 30) | (static_cast<LPARAM>(1) << 31);
        input_gate::send_to_engine(WM_KEYUP, static_cast<WPARAM>(vk), lp);
    }
}

// Borderless and exclusive fullscreen: the window IS the monitor, and a pointer
// that wanders onto the next monitor and clicks there takes the focus away (and an
// exclusive-mode game minimises). So while the overlay is open the pointer is kept
// on the game's monitor -- set ONCE on open and released ONCE on close, never per
// frame. A plain window is left unclipped: the desktop is right there.
bool g_we_clipped = false;

void clip_for_overlay(bool on) {
    if (!on) {
        if (g_we_clipped) ::ClipCursor(nullptr);
        g_we_clipped = false;
        return;
    }
    HWND h = input_gate::window();
    RECT c{};
    if (!h || !::GetClientRect(h, &c)) return;
    POINT tl{c.left, c.top}, br{c.right, c.bottom};
    ::ClientToScreen(h, &tl);
    ::ClientToScreen(h, &br);
    MONITORINFO mi{};
    mi.cbSize = sizeof mi;
    if (!::GetMonitorInfoA(::MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mi)) return;
    const RECT& m = mi.rcMonitor;
    const bool covers = tl.x <= m.left && tl.y <= m.top && br.x >= m.right && br.y >= m.bottom;
    if (!covers) return;
    const RECT r{tl.x, tl.y, br.x, br.y};
    g_we_clipped = ::ClipCursor(&r) != FALSE;
}

// ------------------------------------------------ the client side of a pause
// B, 0.2.13 on the box: "when you press T and you're paused, one of the numbers
// in the FPS meter spikes and the zombies twitch once or twice, then it's normal."
//
// What happens (read out of CL_SetCGameTime 0x63C6C0 and CL_AdjustTimeDelta
// 0x63C400): the frozen server keeps SENDING snapshots, all stamped with the same
// serverTime S (svs.time is held). The client's clock is realtime + serverTimeDelta
// and never goes backwards (0x63C76B clamps it to the previous value), so it runs
// on past S -- extrapolating the zombies forward (the twitch) -- while each new
// snapshot pulls the delta down ("<FAST>" above 100 ms). Once the gap passes 1000 ms
// CL_AdjustTimeDelta RESETs: cl.serverTime is written straight back to S (0x63C496),
// the game clock jumps BACKWARDS, and cg_drawFPS's frame-time line spikes.
//
// The fix holds the client's clock while the server is frozen. "Frozen" is read off
// the snapshots: a new snapshot (cl.snap.messageNum moved) carrying the same
// serverTime as the last one. A LIVE server does that too, now and then, for one
// snapshot (measured: 16-63 ms "freezes" in the hold-off run), so it takes two in a
// row -- or one, when this client has just reported enw_ui typing/paused and so
// expects the freeze. Whoever caused it (typing, the Esc menu, a co-op all-in-menu
// pause, the host) the client holds. While it holds, cl.serverTimeDelta is pinned
// every frame so realtime + delta sits just under the clock at detection: the
// clock stands still, nothing extrapolates further, and CL_AdjustTimeDelta only ever
// sees a small gap (no <FAST> pull, no <RESET>). On resume the delta is set once so
// the clock continues from exactly where it stood at the real-time rate, the server
// continues from S with no catch-up, and the engine's slow adjust owns it again.
//
// Addresses (all from 0x63C400 / 0x63C6C0): cl.snap.valid 0x3058530, .serverTime
// 0x3058538, .messageNum 0x305853C (verified at runtime: +1 per snapshot);
// cl.oldServerTime 0x305A620, cl.serverTime 0x305A624, cl.oldFrameServerTime
// 0x305A628, cl.serverTimeDelta 0x305A62C, cl.extrapolatedSnapshot 0x305A634,
// cl.newSnapshots 0x305A638; cls.realtime 0x48AE4E8. Off: ENW_PAUSE_HOLD=0.
constexpr uintptr_t kSnapValid = 0x3058530;
constexpr uintptr_t kSnapServerTime = 0x3058538;
constexpr uintptr_t kSnapMessageNum = 0x305853C;
constexpr uintptr_t kClServerTime = 0x305A624;
constexpr uintptr_t kClServerTimeDelta = 0x305A62C;
constexpr uintptr_t kClsRealtime = 0x48AE4E8;

bool g_hold_enabled = true;
bool g_frozen = false;
int g_last_snap_time = 0, g_last_snap_msg = -1;
int g_frozen_at = 0;             // S
DWORD g_frozen_since = 0;
long g_holds = 0;
// The evidence: cl.serverTime per frame. A backwards step is the RESET jump.
int g_prev_cl_time = 0;
int g_max_step = 0, g_min_step = 0;           // over the current window
int g_resume_max_step = 0, g_resume_min_step = 0;
DWORD g_resume_until = 0;
int g_freeze_max_step = 0, g_freeze_min_step = 0;
int g_ext_past_s = 0;            // how far the clock got past S before the hold caught it
int g_hold_clock = 0;            // cl.serverTime the hold keeps
int g_dup_run = 0;               // consecutive snapshots with an unchanged serverTime

void pause_hold_tick() {
    if (rd<int>(kClcState) != 10 || !rd<int>(kSnapValid)) {
        g_frozen = false;
        g_last_snap_msg = -1;
        g_prev_cl_time = 0;
        return;
    }
    const int st = rd<int>(kSnapServerTime);
    const int mn = rd<int>(kSnapMessageNum);
    const int clt = rd<int>(kClServerTime);
    const int step = g_prev_cl_time ? clt - g_prev_cl_time : 0;
    g_prev_cl_time = clt;
    if (g_frozen) {
        g_freeze_max_step = (std::max)(g_freeze_max_step, step);
        g_freeze_min_step = (std::min)(g_freeze_min_step, step);
    } else if (g_resume_until && ::GetTickCount() < g_resume_until) {
        g_resume_max_step = (std::max)(g_resume_max_step, step);
        g_resume_min_step = (std::min)(g_resume_min_step, step);
    } else if (g_resume_until) {
        ENW_INFO("pause_hold: first 2 s after resume: cl.serverTime per-frame step %d..%d ms "
                 "(a negative step is the clock going backwards)", g_resume_min_step, g_resume_max_step);
        g_resume_until = 0;
    }

    if (mn != g_last_snap_msg) {
        g_dup_run = (g_last_snap_msg >= 0 && st == g_last_snap_time) ? g_dup_run + 1 : 0;
        const bool expected = g_ui_sent == "typing" || g_ui_sent == "paused";
        if (g_dup_run >= (expected ? 1 : 2) && !g_frozen) {
            g_frozen = true;
            g_hold_clock = clt;
            g_frozen_at = st;
            g_frozen_since = ::GetTickCount();
            g_freeze_max_step = g_freeze_min_step = 0;
            g_ext_past_s = clt - st;
            ++g_holds;
            ENW_INFO("pause_hold: the server is FROZEN (snapshot %d carries serverTime %d again). "
                     "Client clock %d (%+d ms past S); %s", mn, st, clt, clt - st,
                     g_hold_enabled ? "holding it" : "NOT holding (ENW_PAUSE_HOLD=0)");
        } else if (st != g_last_snap_time && g_frozen) {
            g_frozen = false;
            if (g_hold_enabled)   // continue from the held clock at the real-time rate
                *reinterpret_cast<volatile int*>(kClServerTimeDelta) = clt - rd<int>(kClsRealtime);
            ENW_INFO("pause_hold: the server RESUMED after %lu ms (serverTime %d -> %d). While frozen "
                     "the client clock stepped %d..%d ms per frame and ended at %d (%+d ms past S)",
                     ::GetTickCount() - g_frozen_since, g_frozen_at, st, g_freeze_min_step,
                     g_freeze_max_step, clt, clt - g_frozen_at);
            g_resume_until = ::GetTickCount() + 2000;
            g_resume_max_step = g_resume_min_step = 0;
        }
        g_last_snap_msg = mn;
        g_last_snap_time = st;
    }
    if (g_frozen && g_hold_enabled) {
        const int realtime = rd<int>(kClsRealtime);
        // 50 ms under the held clock: realtime moves on between this tick and the
        // next CL_SetCGameTime, and the engine's never-backwards clamp (0x63C76B)
        // then keeps the clock exactly at its last value instead of creeping by a frame.
        *reinterpret_cast<volatile int*>(kClServerTimeDelta) = g_hold_clock - 50 - realtime;
    }
}

// --------------------------------------------- the Esc menu, and why it did not
// B: "Escape to pause the game doesn't work." In his box game (enw-38756.log) the
// client never reported enw_ui paused, and the server never logged solo_menu.
// This instrument records, for every Esc the player presses in a map with the
// overlay closed, what the engine's Esc path (CL_KeyEvent 0x4783EB..0x47848A ->
// UI_SetActiveMenu(2) 0x5D6D12 -> "pausedmenu") tests, and what keyCatchers is
// 300 ms later.
constexpr uintptr_t kCinePlaying = 0x3DB3F49, kCineA = 0x3DB3C40, kCineB = 0x3DB3D40;
constexpr uintptr_t kDvarClPaused = 0x1F552C4, kDvarSvRunning = 0x1F552DC;
constexpr uintptr_t kDvarCgCineFull = 0x368EBD4;
DWORD g_esc_check_at = 0;

void log_esc_state(const char* when) {
    const uintptr_t clp = rd<uintptr_t>(kDvarClPaused), svr = rd<uintptr_t>(kDvarSvRunning),
                    cf = rd<uintptr_t>(kDvarCgCineFull);
    ENW_INFO("esc: %s: keyCatchers 0x%X, clc.state %d, cl_paused %d, sv_running %d, cinematic "
             "flags f49=%d c40=%d d40=%d, cg_cinematicFullscreen %d, enw_ui '%s'", when,
             rd<int>(kKeyCatchers), rd<int>(kClcState), clp ? rd<int>(clp + kDvarValue) : -1,
             svr ? rd<unsigned char>(svr + kDvarValue) : -1, rd<unsigned char>(kCinePlaying),
             rd<unsigned char>(kCineA), rd<unsigned char>(kCineB),
             cf ? rd<unsigned char>(cf + kDvarValue) : -1, g_ui_sent.c_str());
}

// ------------------------------------------------------------------- tabs
int find_tab_dm(const std::string& sid) {
    for (size_t i = 0; i < g_tabs.size(); ++i)
        if (g_tabs[i].kind == T_DM && g_tabs[i].sid == sid) return static_cast<int>(i);
    return -1;
}

std::string name_for_sid(const std::string& sid) {
    for (const auto& c : g_me.contacts) if (c.sid == sid) return c.name;
    for (auto it = g_lines.rbegin(); it != g_lines.rend(); ++it) {
        if (it->from_sid == sid && !it->from.empty()) return it->from;
        if (it->peer_sid == sid && !it->peer_name.empty()) return it->peer_name;
    }
    return "player";
}

// A DM tab per conversation, kept just before the "+" picker.
int ensure_dm_tab(const std::string& sid, const std::string& name) {
    int i = find_tab_dm(sid);
    if (i >= 0) {
        if (!name.empty()) g_tabs[static_cast<size_t>(i)].name = name;
        return i;
    }
    tab_t t{T_DM, sid, name.empty() ? name_for_sid(sid) : name};
    g_tabs.insert(g_tabs.end() - 1, t);
    const int at = static_cast<int>(g_tabs.size()) - 2;
    if (g_tab >= at) ++g_tab;   // the picker moved right by one
    return at;
}

void clear_hsel() { g_hsel_a = g_hsel_b = hpos{}; }

void switch_tab(int i, const char* why) {
    if (i < 0 || i >= static_cast<int>(g_tabs.size())) return;
    g_tab = i;
    g_tabs[static_cast<size_t>(i)].unread = 0;
    g_scroll = 0;
    clear_hsel();
    g_focus_input = true;
    ENW_INFO("chat_overlay: tab %d '%s' (%s)", i, g_tabs[static_cast<size_t>(i)].name.c_str(), why);
}

void close_dm_tab(int i) {
    if (i < 0 || i >= static_cast<int>(g_tabs.size()) || g_tabs[static_cast<size_t>(i)].kind != T_DM) return;
    g_tabs.erase(g_tabs.begin() + i);
    if (g_tab >= i && g_tab > 0) --g_tab;
    clear_hsel();
}

const tab_t& cur_tab() { return g_tabs[static_cast<size_t>(g_tab)]; }

// A message line WE made (hints, errors) lands in the tab it is about.
void add_local_here(const std::string& text) {
    const tab_t& t = cur_tab();
    const int ch = t.kind == T_GLOBAL ? CH_GLOBAL : t.kind == T_PARTY ? CH_PARTY : CH_DM;
    add_local(ch, text, true, t.kind == T_DM ? t.sid : std::string());
}

void open_overlay(const char* why) {
    if (g_open) return;
    g_open = true;
    g_focus_input = true;
    g_scroll = 0;
    g_tabs[static_cast<size_t>(g_tab)].unread = 0;
    g_drag = D_NONE;
    g_ctrl_seen = g_shift_seen = false;
    ++g_opens;
    release_engine_keys();
    input_gate::set_captured(true);
    clip_for_overlay(true);
    report_ui_state();
    // Everything a click's coordinates go through, once per open: client rect,
    // back buffer, placement and DPI. This is the line that says whether the
    // pointer and the drawing agree on this machine.
    HWND h = input_gate::window();
    RECT rc{};
    if (h) ::GetClientRect(h, &rc);
    UINT dpi = 0;
    using dpi_fn = UINT(WINAPI*)(HWND);
    if (auto f = reinterpret_cast<dpi_fn>(::GetProcAddress(::GetModuleHandleA("user32.dll"), "GetDpiForWindow")))
        dpi = h ? f(h) : 0;
    ENW_INFO("chat_overlay: OPEN (%s) tab=%d -- keyboard and mouse are the overlay's%s. client %ldx%ld, "
             "back buffer %dx%d, placement %.3fx%.3f +(%.1f,%.1f), window DPI %u",
             why, g_tab, g_we_clipped ? "; pointer kept on the game's monitor" : "", rc.right, rc.bottom,
             rd<int>(kVidDisplayW), rd<int>(kVidDisplayH), g_place_sx, g_place_sy, g_place_ox,
             g_place_oy, dpi);
}

void close_overlay(const char* why) {
    if (!g_open || g_embedded) return;   // [esc-menu] the menu closes it (chat_embed::close)
    g_open = false;
    if (g_drag != D_NONE && ::GetCapture() == input_gate::window()) ::ReleaseCapture();
    g_drag = D_NONE;
    clip_for_overlay(false);
    input_gate::set_captured(false);
    report_ui_state();
    ENW_INFO("chat_overlay: CLOSED (%s)", why);
}

// ----------------------------------------------------------- the input line
bool has_sel() { return g_caret != g_anchor; }
size_t sel_lo() { return (std::min)(g_caret, g_anchor); }
size_t sel_hi() { return (std::max)(g_caret, g_anchor); }

void set_input(const std::string& s) {
    g_input = s.substr(0, kMaxInput);
    g_caret = g_anchor = g_input.size();
    g_in_scroll = 0;
}

void move_caret(size_t p, bool extend) {
    g_caret = (std::min)(p, g_input.size());
    if (!extend) g_anchor = g_caret;
    g_blink_t = ::GetTickCount();
}

void del_sel() {
    if (!has_sel()) return;
    const size_t lo = sel_lo();
    g_input.erase(lo, sel_hi() - lo);
    g_caret = g_anchor = lo;
}

// Latin-1 text from typing or the clipboard: one line, no colour codes, capped.
std::string clean_line(const std::string& in) {
    std::string out;
    bool space = false;
    for (unsigned char c : in) {
        if (c == '\r' || c == '\n' || c == '\t') c = ' ';
        if (c < 0x20 || c == 0x7F || c == '^') continue;
        if (c == ' ' && space) continue;   // collapse the runs a multi-line paste leaves
        space = c == ' ';
        out.push_back(static_cast<char>(c));
    }
    return out;
}

void insert_text(const std::string& raw) {
    del_sel();
    std::string s = clean_line(raw);
    const size_t room = kMaxInput > g_input.size() ? kMaxInput - g_input.size() : 0;
    if (s.size() > room) s.resize(room);
    g_input.insert(g_caret, s);
    move_caret(g_caret + s.size(), false);
}

bool is_word(unsigned char c) { return std::isalnum(c) || c == '_' || c == '\'' || c >= 0xC0; }

size_t word_left(const std::string& s, size_t p) {
    while (p > 0 && !is_word(static_cast<unsigned char>(s[p - 1]))) --p;
    while (p > 0 && is_word(static_cast<unsigned char>(s[p - 1]))) --p;
    return p;
}
size_t word_right(const std::string& s, size_t p) {
    while (p < s.size() && !is_word(static_cast<unsigned char>(s[p]))) ++p;
    while (p < s.size() && is_word(static_cast<unsigned char>(s[p]))) ++p;
    return p;
}
// The word under p: [b, e).
void word_at(const std::string& s, size_t p, size_t* b, size_t* e) {
    if (s.empty()) { *b = *e = 0; return; }
    if (p >= s.size()) p = s.size() - 1;
    const bool w = is_word(static_cast<unsigned char>(s[p]));
    size_t i = p, j = p;
    while (i > 0 && is_word(static_cast<unsigned char>(s[i - 1])) == w) --i;
    while (j < s.size() && is_word(static_cast<unsigned char>(s[j])) == w) ++j;
    *b = i; *e = j;
}

// ------------------------------------------------------------- the clipboard
// CF_UNICODETEXT through the game window, Latin-1 <-> UTF-16 (the engine font is
// Latin-1). The selftest uses a private buffer instead: an agent run must never
// overwrite the clipboard of the person sitting at this PC.
void clip_set(const std::string& latin1) {
    if (latin1.empty()) return;
    if (g_selftest) {
        g_fake_clip = latin1;
        ENW_INFO("chat_overlay: copy (selftest buffer, %zu chars): \"%s\"", latin1.size(), latin1.c_str());
        return;
    }
    if (!::OpenClipboard(input_gate::window())) return;
    ::EmptyClipboard();
    const size_t n = latin1.size();
    if (HGLOBAL g = ::GlobalAlloc(GMEM_MOVEABLE, (n + 1) * sizeof(wchar_t))) {
        if (auto* w = static_cast<wchar_t*>(::GlobalLock(g))) {
            for (size_t i = 0; i < n; ++i) w[i] = static_cast<unsigned char>(latin1[i]);
            w[n] = 0;
            ::GlobalUnlock(g);
            if (!::SetClipboardData(CF_UNICODETEXT, g)) ::GlobalFree(g);
        } else {
            ::GlobalFree(g);
        }
    }
    ::CloseClipboard();
    ENW_INFO("chat_overlay: copied %zu chars to the clipboard", n);
}

std::string clip_get() {
    if (g_selftest) return g_fake_clip;
    std::string out;
    if (!::OpenClipboard(input_gate::window())) return out;
    if (HANDLE h = ::GetClipboardData(CF_UNICODETEXT)) {
        if (const auto* w = static_cast<const wchar_t*>(::GlobalLock(h))) {
            for (size_t i = 0; w[i] && out.size() < 4096; ++i)
                out.push_back(w[i] <= 0xFF ? static_cast<char>(w[i]) : '?');
            ::GlobalUnlock(h);
        }
    } else if (HANDLE a = ::GetClipboardData(CF_TEXT)) {
        if (const char* s = static_cast<const char*>(::GlobalLock(a))) {
            out.assign(s, ::strnlen(s, 4096));
            ::GlobalUnlock(a);
        }
    }
    ::CloseClipboard();
    return out;
}

// ------------------------------------------------------------------ sending
std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && s[b] == ' ') ++b;
    while (e > b && s[e - 1] == ' ') --e;
    return s.substr(b, e - b);
}

bool starts_ci(const std::string& s, const char* p) {
    size_t i = 0;
    for (; p[i]; ++i)
        if (i >= s.size() || std::tolower(static_cast<unsigned char>(s[i])) != std::tolower(static_cast<unsigned char>(p[i])))
            return false;
    return true;
}

// Name -> steam id: friends and party first, then anyone seen in chat.
bool resolve_name(const std::string& name, std::string* sid, std::string* shown) {
    auto eq = [&](const std::string& a) {
        if (a.size() != name.size()) return false;
        for (size_t i = 0; i < a.size(); ++i)
            if (std::tolower(static_cast<unsigned char>(a[i])) != std::tolower(static_cast<unsigned char>(name[i]))) return false;
        return true;
    };
    for (const auto& c : g_me.contacts) if (eq(c.name)) { *sid = c.sid; *shown = c.name; return true; }
    for (auto it = g_lines.rbegin(); it != g_lines.rend(); ++it)
        if (!it->from_sid.empty() && !it->mine && eq(it->from)) { *sid = it->from_sid; *shown = it->from; return true; }
    return false;
}

void queue_line(int ch, const std::string& to_sid, const std::string& text) {
    if (g_bearer.empty()) {
        add_local_here("^1Not sent: chat is offline (start the game from the ENW launcher).");
        return;
    }
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_outbox.push_back({ch, to_sid, text});
    }
    g_out_cv.notify_one();
    ++g_sent;
    ENW_INFO("chat_overlay: queued a %s line (%zu chars)",
             ch == CH_PARTY ? "party" : ch == CH_DM ? "DM" : "global", text.size());
}

// Returns true when the overlay should close (WaW: Enter sends and closes).
bool send_input() {
    const std::string text = trim(g_input);
    set_input("");
    g_hist_pos = -1;
    if (text.empty()) return true;
    g_sent_hist.push_back(text);
    if (g_sent_hist.size() > 30) g_sent_hist.erase(g_sent_hist.begin());

    // /w name text, /msg, /tell, and /r text (reply to the last DM).
    if (starts_ci(text, "/w ") || starts_ci(text, "/msg ") || starts_ci(text, "/tell ") ||
        starts_ci(text, "/r ") || text == "/r") {
        std::string sid, shown, body;
        if (starts_ci(text, "/r")) {
            body = trim(text.substr(2));
            sid = g_last_dm_sid; shown = g_last_dm_name;
            if (sid.empty()) { add_local_here("^3Nobody has messaged you yet."); return false; }
        } else {
            const std::string rest = trim(text.substr(text.find(' ') + 1));
            const size_t sp = rest.find(' ');
            const std::string who = sp == std::string::npos ? rest : rest.substr(0, sp);
            body = sp == std::string::npos ? std::string() : trim(rest.substr(sp + 1));
            if (!resolve_name(who, &sid, &shown)) {
                add_local_here("^3No friend or party member called '" + who + "'.");
                return false;
            }
        }
        switch_tab(ensure_dm_tab(sid, shown), "/w");
        if (body.empty()) return false;   // just opened the conversation
        queue_line(CH_DM, sid, body);
        return true;
    }
    const tab_t& t = cur_tab();
    switch (t.kind) {
    case T_GLOBAL: queue_line(CH_GLOBAL, "", text); return true;
    case T_PARTY:
        if (!g_me.party_id) { add_local_here("^3You are not in a party."); return false; }
        queue_line(CH_PARTY, "", text);
        return true;
    case T_DM: queue_line(CH_DM, t.sid, text); return true;
    default:
        add_local_here("^3Pick someone first: click a name, or type /w name message.");
        set_input(text);
        return false;
    }
}

// ------------------------------------------------------------------- input
constexpr float kLH = 14.f;    // line step, virtual units
constexpr float kAsc = 13.f;   // baseline to the top of the line box
float text_w(const char* s);   // draw section

bool is_mouse_msg(UINT m) { return m >= WM_MOUSEFIRST && m <= WM_MOUSELAST; }

// One visual row of the active tab's history. `plain` is what is on screen,
// `map[k]` the index in `raw` (with its colour codes) of plain char k, so widths
// and hit tests work on exactly what the renderer draws.
struct row_t {
    std::string raw, plain;
    std::vector<size_t> map;       // plain.size() + 1 entries
    size_t line = 0;               // which message, for copy joins
    int name_b = -1, name_e = -1;  // a clickable sender name, plain columns
    std::string name_sid, name;
};
std::vector<row_t> g_rows;         // rebuilt by draw_panel every frame it draws

float row_x(const row_t& r, int col) {
    col = (std::max)(0, (std::min)(col, static_cast<int>(r.plain.size())));
    return text_w(r.raw.substr(0, r.map[static_cast<size_t>(col)]).c_str());
}

int row_col_at(const row_t& r, float x) {
    int best = 0;
    float bd = 1e9f;
    for (int k = 0; k <= static_cast<int>(r.plain.size()); ++k) {
        const float d = std::fabs(row_x(r, k) - x);
        if (d < bd) { bd = d; best = k; }
    }
    return best;
}

// History slot i (0 = newest visible row) for a virtual y; may be <0 or >=rows.
int hist_slot_at(float vy) {
    // row i spans [base_i - kAsc, base_i - kAsc + kLH), base_i = g_hist_base - kLH*i
    return static_cast<int>(std::floor((g_hist_base - kAsc + kLH - vy) / kLH));
}

hpos hist_pos_at(float vx, float vy, int* slot_out = nullptr) {
    hpos p;
    const int n = static_cast<int>(g_rows.size());
    if (!n) return p;
    int slot = hist_slot_at(vy);
    if (slot_out) *slot_out = slot;
    slot = (std::max)(0, (std::min)(slot, g_hist_rows_vis - 1));
    p.row = (std::max)(0, (std::min)(n - 1 - g_scroll - slot, n - 1));
    p.col = row_col_at(g_rows[static_cast<size_t>(p.row)], vx - g_hist_x);
    return p;
}

bool hpos_less(const hpos& a, const hpos& b) { return a.row < b.row || (a.row == b.row && a.col < b.col); }
bool hsel_any() { return g_hsel_a.row >= 0 && (g_hsel_a.row != g_hsel_b.row || g_hsel_a.col != g_hsel_b.col); }

std::string hsel_text() {
    if (!hsel_any() || g_rows.empty()) return {};
    hpos lo = g_hsel_a, hi = g_hsel_b;
    if (hpos_less(hi, lo)) std::swap(lo, hi);
    std::string out;
    for (int r = lo.row; r <= hi.row && r < static_cast<int>(g_rows.size()); ++r) {
        const row_t& row = g_rows[static_cast<size_t>(r)];
        const int b = r == lo.row ? lo.col : 0;
        const int e = r == hi.row ? hi.col : static_cast<int>(row.plain.size());
        if (e > b) out += row.plain.substr(static_cast<size_t>(b), static_cast<size_t>(e - b));
        if (r < hi.row) {
            const bool same_msg = g_rows[static_cast<size_t>(r + 1)].line == row.line;
            out += same_msg ? " " : "\r\n";
        }
    }
    return out;
}

// The input line's column for a virtual x (the box scrolls horizontally).
size_t input_col_at(float vx) {
    const float x = vx - g_input_text_x;
    size_t best = g_in_scroll;
    float bd = 1e9f;
    for (size_t k = g_in_scroll; k <= g_input.size(); ++k) {
        const float w = text_w(g_input.substr(g_in_scroll, k - g_in_scroll).c_str());
        if (w > g_input_room + 8.f) break;
        const float d = std::fabs(w - x);
        if (d < bd) { bd = d; best = k; }
    }
    return best;
}

void to_virtual(int cx, int cy, float* vx, float* vy) {
    // Client pixels -> back-buffer pixels (they differ when the window is not the
    // render size, or when Windows scales a DPI-unaware window) -> the 640x480
    // virtual space through the same ScreenPlacement everything is drawn with.
    HWND h = input_gate::window();
    RECT rc{};
    float bx = static_cast<float>(cx), by = static_cast<float>(cy);
    if (h && ::GetClientRect(h, &rc) && rc.right > 0 && rc.bottom > 0) {
        const int dw = rd<int>(kVidDisplayW), dh = rd<int>(kVidDisplayH);
        if (dw > 0 && dh > 0) {
            bx = cx * static_cast<float>(dw) / static_cast<float>(rc.right);
            by = cy * static_cast<float>(dh) / static_cast<float>(rc.bottom);
        }
    }
    *vx = g_place_sx > 0 ? (bx - g_place_ox) / g_place_sx : bx;
    *vy = g_place_sy > 0 ? (by - g_place_oy) / g_place_sy : by;
}

int tab_at(float x, float y) {
    for (size_t i = 0; i < g_tab_rects.size(); ++i)
        if (g_tab_rects[i].hit(x, y)) return static_cast<int>(i);
    return -1;
}

void begin_drag(int kind) {
    g_drag = kind;
    g_drag_moved = false;
    // Capture only when this window really is foreground (the real
    // GetForegroundWindow -- focus_guard hooks only the engine's import). A
    // background window must never touch the desktop's mouse.
    HWND h = input_gate::window();
    if (h && ::GetForegroundWindow() == h) ::SetCapture(h);
}

void on_press(int cx, int cy, bool shift) {
    float x, y;
    to_virtual(cx, cy, &x, &y);
    const DWORD now = ::GetTickCount();
    if (now - g_last_click_t <= ::GetDoubleClickTime() && std::abs(cx - g_last_click_x) <= 4 &&
        std::abs(cy - g_last_click_y) <= 4)
        ++g_click_count;
    else
        g_click_count = 1;
    g_last_click_t = now; g_last_click_x = cx; g_last_click_y = cy;
    g_down_x = cx; g_down_y = cy;
    ++g_clicks;

    std::string what;
    const int t = tab_at(x, y);
    if (g_close_rect.hit(x, y)) {
        what = "close";
    } else if (t >= 0) {
        what = "tab " + std::to_string(t) + " '" + g_tabs[static_cast<size_t>(t)].name + "'";
    } else {
        for (const auto& cr : g_contact_rects)
            if (cr.first.hit(x, y)) { what = "contact '" + cr.second.name + "'"; break; }
        if (what.empty()) what = g_input_rect.hit(x, y) ? "input" : g_hist_rect.hit(x, y) ? "history" : "nothing";
    }
    RECT rc{};
    if (HWND h = input_gate::window()) ::GetClientRect(h, &rc);
    ENW_INFO("chat_overlay: click #%ld (x%d) at client (%d,%d) of %ldx%ld -> back buffer %dx%d -> "
             "virtual (%.1f,%.1f) -> %s", g_clicks, g_click_count, cx, cy, rc.right, rc.bottom,
             rd<int>(kVidDisplayW), rd<int>(kVidDisplayH), x, y, what.c_str());

    if (what == "close") { close_overlay("clicked x"); return; }
    if (t >= 0) { switch_tab(t, "click"); return; }
    for (const auto& cr : g_contact_rects)
        if (cr.first.hit(x, y)) { switch_tab(ensure_dm_tab(cr.second.sid, cr.second.name), "contact"); return; }

    if (g_input_rect.hit(x, y)) {
        g_focus_input = true;
        clear_hsel();
        const size_t col = input_col_at(x);
        if (g_click_count == 2) {
            size_t b, e;
            word_at(g_input, col, &b, &e);
            g_anchor = b; g_caret = e;
        } else if (g_click_count >= 3) {
            g_anchor = 0; g_caret = g_input.size();
        } else {
            move_caret(col, shift);
        }
        begin_drag(D_INPUT);
        return;
    }
    if (g_hist_rect.hit(x, y) && !g_rows.empty()) {
        g_focus_input = false;
        const hpos p = hist_pos_at(x, y);
        const row_t& row = g_rows[static_cast<size_t>(p.row)];
        if (g_click_count == 2) {
            size_t b, e;
            word_at(row.plain, static_cast<size_t>(p.col), &b, &e);
            g_hsel_a = {p.row, static_cast<int>(b)};
            g_hsel_b = {p.row, static_cast<int>(e)};
        } else if (g_click_count >= 3) {
            g_hsel_a = {p.row, 0};
            g_hsel_b = {p.row, static_cast<int>(row.plain.size())};
        } else {
            if (shift && g_hsel_a.row >= 0) g_hsel_b = p;
            else g_hsel_a = g_hsel_b = p;
            g_pending_dm_sid.clear();
            if (!shift && row.name_b >= 0 && p.col >= row.name_b && p.col <= row.name_e &&
                row_x(row, row.name_b) <= x - g_hist_x && x - g_hist_x <= row_x(row, row.name_e)) {
                g_pending_dm_sid = row.name_sid;
                g_pending_dm_name = row.name;
            }
        }
        begin_drag(D_HIST);
        return;
    }
}

void on_drag(int cx, int cy) {
    if (std::abs(cx - g_down_x) > 3 || std::abs(cy - g_down_y) > 3) g_drag_moved = true;
    float x, y;
    to_virtual(cx, cy, &x, &y);
    if (g_drag == D_INPUT) {
        move_caret(input_col_at(x), true);
    } else if (g_drag == D_HIST && !g_rows.empty()) {
        int slot = 0;
        const hpos p = hist_pos_at(x, y, &slot);
        // Dragging past the top or bottom edge scrolls, one row per move.
        const int maxs = (std::max)(0, static_cast<int>(g_rows.size()) - g_hist_rows_vis);
        if (slot >= g_hist_rows_vis && g_scroll < maxs) ++g_scroll;
        if (slot < 0 && g_scroll > 0) --g_scroll;
        g_hsel_b = p;
    }
}

void on_release() {
    const bool was = g_drag != D_NONE;
    if (was && ::GetCapture() == input_gate::window()) ::ReleaseCapture();
    const int kind = g_drag;
    g_drag = D_NONE;
    if (kind == D_HIST && !g_drag_moved && !g_pending_dm_sid.empty() && g_click_count == 1) {
        const std::string sid = g_pending_dm_sid, name = g_pending_dm_name;
        g_pending_dm_sid.clear();
        clear_hsel();
        if (!sid.empty() && sid != g_me.sid) switch_tab(ensure_dm_tab(sid, name), "clicked a name");
    }
    g_pending_dm_sid.clear();
}

void cycle_tab(bool back) {
    const int n = static_cast<int>(g_tabs.size());
    switch_tab((g_tab + (back ? n - 1 : 1)) % n, back ? "Shift+Tab" : "Tab");
}

bool on_key(int vk) {
    const bool ctrl = (::GetKeyState(VK_CONTROL) & 0x8000) != 0 || g_ctrl_seen;
    const bool shift = (::GetKeyState(VK_SHIFT) & 0x8000) != 0 || g_shift_seen;
    switch (vk) {
    case VK_CONTROL: g_ctrl_seen = true; return true;
    case VK_SHIFT: g_shift_seen = true; return true;
    case VK_ESCAPE: close_overlay("Esc"); return true;
    case VK_RETURN:
        if (trim(g_input).empty() || send_input()) close_overlay("Enter");
        return true;
    case VK_TAB: cycle_tab(shift); return true;
    case VK_LEFT:
        g_focus_input = true;
        if (has_sel() && !shift) move_caret(sel_lo(), false);
        else move_caret(ctrl ? word_left(g_input, g_caret) : (g_caret ? g_caret - 1 : 0), shift);
        return true;
    case VK_RIGHT:
        g_focus_input = true;
        if (has_sel() && !shift) move_caret(sel_hi(), false);
        else move_caret(ctrl ? word_right(g_input, g_caret) : g_caret + 1, shift);
        return true;
    case VK_HOME: g_focus_input = true; move_caret(0, shift); return true;
    case VK_END: g_focus_input = true; move_caret(g_input.size(), shift); return true;
    case VK_BACK:
        g_focus_input = true;
        if (has_sel()) del_sel();
        else if (g_caret > 0) {
            const size_t b = ctrl ? word_left(g_input, g_caret) : g_caret - 1;
            g_input.erase(b, g_caret - b);
            move_caret(b, false);
        }
        return true;
    case VK_DELETE:
        g_focus_input = true;
        if (has_sel()) del_sel();
        else if (g_caret < g_input.size()) {
            const size_t e = ctrl ? word_right(g_input, g_caret) : g_caret + 1;
            g_input.erase(g_caret, e - g_caret);
        }
        return true;
    case VK_UP:
    case VK_DOWN: {
        if (g_sent_hist.empty()) return true;
        const int n = static_cast<int>(g_sent_hist.size());
        if (vk == VK_UP) g_hist_pos = g_hist_pos < 0 ? n - 1 : (std::max)(0, g_hist_pos - 1);
        else g_hist_pos = g_hist_pos < 0 ? -1 : (g_hist_pos + 1 < n ? g_hist_pos + 1 : -1);
        set_input(g_hist_pos < 0 ? std::string() : g_sent_hist[static_cast<size_t>(g_hist_pos)]);
        g_focus_input = true;
        return true;
    }
    case VK_PRIOR: g_scroll += 8; return true;
    case VK_NEXT: g_scroll = (std::max)(0, g_scroll - 8); return true;
    default: break;
    }
    if (!ctrl) return true;
    // A Ctrl+letter normally comes with a control-code WM_CHAR (0x01..0x1A), which
    // is ignored anyway; if the modifier state reached TranslateMessage late, it is
    // the plain letter -- eat that one too, so Ctrl+C never types a "c".
    if (vk >= 'A' && vk <= 'Z') g_eat_ctrl_char = static_cast<char>(vk);
    switch (vk) {
    case 'A':
        if (g_focus_input) { g_anchor = 0; g_caret = g_input.size(); }
        else if (!g_rows.empty()) {
            g_hsel_a = {0, 0};
            g_hsel_b = {static_cast<int>(g_rows.size()) - 1, static_cast<int>(g_rows.back().plain.size())};
        }
        break;
    case 'C':
        if (!g_focus_input && hsel_any()) clip_set(hsel_text());
        else if (has_sel()) clip_set(g_input.substr(sel_lo(), sel_hi() - sel_lo()));
        break;
    case 'X':
        if (has_sel()) { clip_set(g_input.substr(sel_lo(), sel_hi() - sel_lo())); del_sel(); }
        break;
    case 'V':
        g_focus_input = true;
        clear_hsel();
        insert_text(clip_get());
        break;
    default:
        break;
    }
    return true;
}

// Every activation change the window sees, counted -- the evidence for "the overlay
// never flips focus". The overlay itself only ever changes cursor/clip state on open
// and close (input_gate::set_captured) and never calls SetForegroundWindow,
// ShowWindow or SetWindowPos.
long g_act_on = 0, g_act_off = 0;

bool filter(HWND, UINT msg, WPARAM wp, LPARAM lp, LRESULT* result) {
    if (msg == WM_ACTIVATE) {
        const bool on = LOWORD(wp) != WA_INACTIVE;
        if (on) ++g_act_on; else ++g_act_off;
        if (g_selftest && g_act_on + g_act_off <= 40)
            ENW_INFO("chat_overlay: WM_ACTIVATE %s (overlay %s) -- #%ld", on ? "ACTIVE" : "INACTIVE",
                     g_open ? "open" : "closed", g_act_on + g_act_off);
    }
    if (!g_enabled || !g_bound) return false;
    *result = 0;
    if (pause_menu::filter(msg, wp, lp, result)) return true;   // [esc-menu] first

    if (!g_open) {
        if (msg == WM_KEYDOWN && wp == VK_ESCAPE && !(lp & (1 << 30)) && in_game()) {
            log_esc_state("Esc pressed (before the engine sees it)");
            g_esc_check_at = ::GetTickCount() + 300;
            return false;
        }
        if (msg == WM_KEYDOWN && static_cast<int>(wp) == g_open_vk && !(lp & (1 << 30))) {
            // Only in a map, and only when neither the console (0x1) nor a menu
            // (0x10, UI) nor the stock message field (0x20) owns the keys.
            if (!in_game() || (rd<int>(kKeyCatchers) & 0x31)) return false;
            g_eat_char = true;
            open_overlay("key");
            return true;
        }
        if (msg == WM_KEYUP && static_cast<int>(wp) == g_open_vk && g_eat_char) return true;
        if (msg == WM_CHAR && g_eat_char) {
            g_eat_char = false;
            return true;
        }
        return false;
    }

    // ---- open ----
    switch (msg) {
    case WM_MOUSEMOVE:
        g_mouse_x = static_cast<short>(LOWORD(lp));
        g_mouse_y = static_cast<short>(HIWORD(lp));
        g_mouse_in = true;
        if (g_drag != D_NONE) {
            if (wp & MK_LBUTTON) on_drag(g_mouse_x, g_mouse_y);
            else on_release();   // the button came up where we could not see it
        }
        return true;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK:
        g_mouse_x = static_cast<short>(LOWORD(lp));
        g_mouse_y = static_cast<short>(HIWORD(lp));
        g_mouse_in = true;
        on_press(g_mouse_x, g_mouse_y, (wp & MK_SHIFT) != 0 || g_shift_seen);
        return true;
    case WM_LBUTTONUP:
        on_release();
        return true;
    case WM_RBUTTONDOWN:
    case WM_MBUTTONDOWN: {
        // Right or middle click on a DM tab closes that conversation's tab.
        float x, y;
        to_virtual(static_cast<short>(LOWORD(lp)), static_cast<short>(HIWORD(lp)), &x, &y);
        const int t = tab_at(x, y);
        if (t >= 0 && g_tabs[static_cast<size_t>(t)].kind == T_DM) close_dm_tab(t);
        return true;
    }
    case WM_MOUSEWHEEL: {
        const int d = GET_WHEEL_DELTA_WPARAM(wp);
        const int maxs = (std::max)(0, static_cast<int>(g_rows.size()) - g_hist_rows_vis);
        g_scroll = (std::max)(0, (std::min)(maxs, g_scroll + (d > 0 ? 3 : -3)));
        return true;
    }
    default:
        break;
    }
    if (is_mouse_msg(msg)) return true;   // every other button: the overlay's, not the game's

    switch (msg) {
    case WM_SETCURSOR:
        // Our cursor is the engine's (drawn in the frame); hide the OS one over
        // the client area so there are never two.
        if (LOWORD(lp) == HTCLIENT) { ::SetCursor(nullptr); *result = TRUE; return true; }
        return false;
    case WM_MOUSELEAVE:
        g_mouse_in = false;
        return false;
    case WM_KEYDOWN:
        return on_key(static_cast<int>(wp));
    case WM_KEYUP:
        if (wp == VK_CONTROL) g_ctrl_seen = false;
        if (wp == VK_SHIFT) g_shift_seen = false;
        return false;  // to the engine, deliberately (see the header)
    case WM_CHAR: {
        const unsigned char c = static_cast<unsigned char>(wp);
        if (g_eat_char) { g_eat_char = false; if (c < 0x20 || c == 't' || c == 'T') return true; }
        if (g_eat_ctrl_char) {
            const char e = g_eat_ctrl_char;
            g_eat_ctrl_char = 0;
            if (c < 0x20 || std::toupper(c) == static_cast<unsigned char>(e)) return true;
        }
        if (c < 0x20 || c == 0x7F) return true;      // Ctrl+letters, Enter, Esc, Tab, Backspace
        if (!g_focus_input && std::tolower(c) == std::tolower(g_open_vk)) {
            close_overlay("T (toggle)");
            return true;
        }
        g_focus_input = true;
        clear_hsel();
        insert_text(std::string(1, static_cast<char>(c)));
        return true;
    }
    case WM_SYSKEYDOWN: case WM_SYSKEYUP: case WM_SYSCHAR:
        // Alt+Tab / Alt+F4 must still work; the engine must not act on Alt+Enter.
        *result = ::DefWindowProcA(input_gate::window(), msg, wp, lp);
        return true;
    case WM_ACTIVATE:
        // Alt-tab while typing: give the pointer back to the desktop at once, and
        // take it again only if the player comes back to an open overlay.
        if (LOWORD(wp) == WA_INACTIVE) {
            g_mouse_in = false;
            g_ctrl_seen = g_shift_seen = false;
            if (g_drag != D_NONE) on_release();
            clip_for_overlay(false);
        } else {
            clip_for_overlay(true);
        }
        return false;
    default:
        return false;
    }
}

// -------------------------------------------------------------------- draw
struct placement { float sx, sy, ox, oy; };

placement place(int lc) {
    const uintptr_t sp = kScrPlaceView + static_cast<uintptr_t>(lc) * 0x48;
    return {rd<float>(sp + 0x0), rd<float>(sp + 0x4), rd<float>(sp + 0x30), rd<float>(sp + 0x34)};
}

void* g_font = nullptr;
// B, 2026-09-22, after seeing it at 2560x1440: "the font maybe needs to be slightly
// smaller". CG_DrawChat draws at 1/3 ([0x8AF5B0]) with a 16-unit step; one size down is
// 0.28 with a 14-unit step. The font is still chosen by WaW's own UI thresholds, so it
// stays the crispest face for the real pixel size.
float g_text_scale = 0.28f;
float g_xscale = 1.0f;               // scale*48/pixelHeight, the per-font factor
const void* g_scr = nullptr;
placement g_pl{};

void* pick_font(const placement& p) {
    // CG_DrawChat's rule (the real pixel scale against the UI's font thresholds),
    // but ALWAYS World at War's stock font from this install, never a mod's
    // (stock_font.cpp; B, 0.2.17).
    return stock_font::pick(p.sy * g_text_scale);
}

float text_w(const char* s) {
    if (!g_font) return 0.f;
    return static_cast<float>(r_text_width(s, 0x7FFFFFFF, g_font)) * g_xscale;
}

void text(float x, float y, const char* s, const float* color) {
    ui_draw_text(g_scr, s, 0x7FFFFFFF, g_font, x, y, g_text_scale, color, 3 /*shadowed*/, 1, 1);
}

void box(float x, float y, float w, float h, const float* color) {
    void* mat = rd<void*>(kWhiteMaterial);
    if (!mat) return;
    reinterpret_cast<stretch_pic_t>(kRStretchPic)(x * g_pl.sx + g_pl.ox, y * g_pl.sy + g_pl.oy,
                                                  w * g_pl.sx, h * g_pl.sy, 0, 0, 1, 1, color, mat);
}

const char* name_colour(const chat_line& l) {
    if (l.ch == CH_PARTY) return "^2";
    if (l.ch == CH_DM) return "^6";
    return "^5";
}

std::string compose(const chat_line& l) {
    if (l.local || l.system) return l.system && !l.local ? "^3" + l.text : l.text;
    std::string tag;
    if (l.ch == CH_PARTY) tag = "^2[Party] ";
    if (l.ch == CH_DM) tag = l.mine ? "^6[To " + l.peer_name + "] " : "^6[DM] ";
    if (l.ch == CH_DM && l.mine) return tag + "^7" + l.text;
    return tag + name_colour(l) + l.from + "^7: " + l.text;
}

// Word wrap to `width` virtual units, cached per line.
const std::vector<std::string>& wrap(chat_line& l, float width) {
    if (l.wrap_font == g_font && l.wrap_width == width && !l.wrapped.empty()) return l.wrapped;
    l.wrapped.clear();
    l.wrap_font = g_font;
    l.wrap_width = width;
    const std::string full = compose(l);
    std::string cur, colour = "^7";
    size_t i = 0;
    while (i < full.size()) {
        size_t j = full.find(' ', i);
        if (j == std::string::npos) j = full.size();
        std::string word = full.substr(i, j - i);
        std::string trial = cur.empty() ? word : cur + " " + word;
        if (!cur.empty() && text_w(trial.c_str()) > width) {
            l.wrapped.push_back(cur);
            // carry the last colour code onto the continuation
            for (size_t k = 0; k + 1 < cur.size(); ++k)
                if (cur[k] == '^' && cur[k + 1] >= '0' && cur[k + 1] <= '9') colour = cur.substr(k, 2);
            cur = colour + word;
        } else {
            cur = trial;
        }
        i = j + 1;
    }
    if (!cur.empty()) l.wrapped.push_back(cur);
    if (l.wrapped.empty()) l.wrapped.push_back(" ");
    return l.wrapped;
}

bool visible_in_tab(const chat_line& l, const tab_t& t) {
    switch (t.kind) {
    case T_GLOBAL: return l.ch == CH_GLOBAL;
    case T_PARTY: return l.ch == CH_PARTY;
    case T_DM: return l.ch == CH_DM && l.peer_sid == t.sid;
    default: return l.ch == CH_DM && l.peer_sid.empty();   // the picker's own hints
    }
}

void drain_inbox() {
    std::vector<chat_line> in;
    bool me_dirty = false;
    me_info me;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        in.swap(g_inbox);
        if (g_me_dirty) { me = g_me_net; me_dirty = true; g_me_dirty = false; }
    }
    if (me_dirty) {
        const bool first = !g_me.have;
        g_me = std::move(me);
        if (first)
            ENW_INFO("chat_overlay: signed in to chat as '%s'; party %lld; %zu contact(s); pause "
                     "when chatting solo: %s", g_me.name.c_str(), g_me.party_id,
                     g_me.contacts.size(), g_me.pause_on_chat ? "on" : "off");
        for (auto& t : g_tabs)   // keep DM tab names fresh
            if (t.kind == T_DM)
                for (const auto& c : g_me.contacts) if (c.sid == t.sid) t.name = c.name;
    }
    for (auto& l : in) {
        if (!l.local) {
            bool dup = false;
            for (auto it = g_lines.rbegin(); it != g_lines.rend() && !dup; ++it)
                dup = !it->local && it->id == l.id && ((it->ch == CH_GLOBAL) == (l.ch == CH_GLOBAL));
            if (dup) continue;
        }
        int tab = l.ch == CH_GLOBAL ? 0 : l.ch == CH_PARTY ? 1 : -1;
        if (l.ch == CH_DM && !l.peer_sid.empty()) {
            tab = ensure_dm_tab(l.peer_sid, l.peer_name);
            if (!l.mine) { g_last_dm_sid = l.peer_sid; g_last_dm_name = l.peer_name; }
        }
        if (tab >= 0 && !(g_open && g_tab == tab) && !l.mine) ++g_tabs[static_cast<size_t>(tab)].unread;
        g_lines.push_back(std::move(l));
    }
    while (g_lines.size() > 400) g_lines.pop_front();
}

const float kWhite[4] = {1, 1, 1, 1};
const float kDim[4] = {0.75f, 0.75f, 0.75f, 1};

// ENW_CHAT_SELFTEST=4: the stock-font proof card. An OPAQUE block (so the map
// behind it cannot change a pixel) with the same sample in each face the overlay
// can pick, drawn through stock_font::pick, plus one line in the engine's CURRENT
// bigFont for contrast. Captured on a stock map and on a font-replacing mod, the
// top four lines must be pixel-identical and the last must differ.
void draw_font_card() {
    const float black[4] = {0, 0, 0, 1};
    box(20.f, 250.f, 600.f, 150.f, black);
    static const float reals[4] = {0.20f, 0.30f, 0.45f, 0.60f};   // small, normal, big, extraBig
    static const char* labels[4] = {"small", "normal", "big", "extraBig"};
    void* const keep_font = g_font;
    const float keep_xs = g_xscale;
    for (int i = 0; i < 5; ++i) {
        void* f = i < 4 ? stock_font::pick(reals[i]) : *reinterpret_cast<void* const*>(kFontBig);
        if (!f) continue;
        const int ph = rd<int>(reinterpret_cast<uintptr_t>(f) + 4);
        if (ph <= 0 || ph > 256) continue;
        g_font = f;
        g_xscale = g_text_scale * 48.0f / static_cast<float>(ph);
        char line[160];
        std::snprintf(line, sizeof line, "%s: The quick brown fox jumps 0123456789 !?%%&@",
                      i < 4 ? labels[i] : "ENGINE bigFont (a mod's, if it has one)");
        text(26.f, 272.f + 28.f * i, line, kWhite);
    }
    g_font = keep_font;
    g_xscale = keep_xs;
}

void draw_notify() {
    // CG_DrawChat's rules: the newest cg_chatHeight lines younger than
    // cg_chatTime, each with a 16-unit step up from cg_hudChatPosition, a dark
    // box behind each (rgb 0.25, alpha 0.6), alpha ramping out over the last
    // 200 ms (age * 0.005).
    const uintptr_t pos = rd<uintptr_t>(kDvarHudChatPos);
    const float cx = pos ? rd<float>(pos + kDvarValue) : 5.f;
    const float cy = pos ? rd<float>(pos + kDvarValue + 4) : 200.f;
    const uintptr_t hd = rd<uintptr_t>(kDvarChatHeight);
    const uintptr_t td = rd<uintptr_t>(kDvarChatTime);
    int maxl = hd ? rd<int>(hd + kDvarValue) : 5;
    const int life = td ? rd<int>(td + kDvarValue) : 12000;
    if (maxl <= 0) maxl = 5;
    const DWORD now = ::GetTickCount();
    int row = 0;
    for (auto it = g_lines.rbegin(); it != g_lines.rend() && row < maxl; ++it) {
        const int age = static_cast<int>(now - it->arrived);
        if (age > life) break;
        float a = (life - age) * 0.005f;
        if (a > 1.f) a = 1.f;
        const auto& rows = wrap(*it, 300.f);
        // Whole messages only: a wrapped line that does not fit is left out rather
        // than shown as an orphaned tail.
        if (row + static_cast<int>(rows.size()) > maxl) break;
        for (auto r = rows.rbegin(); r != rows.rend() && row < maxl; ++r, ++row) {
            const float y = cy - 1.f - kLH * row;
            const float bg[4] = {0.25f, 0.25f, 0.25f, 0.6f * a};
            box(cx, y - kAsc, text_w(r->c_str()) + 6.f, kLH, bg);
            const float col[4] = {1, 1, 1, a};
            text(cx + 3.f, y, r->c_str(), col);
        }
    }
}

row_t make_row(const std::string& raw, size_t line) {
    row_t r;
    r.raw = raw;
    r.line = line;
    for (size_t i = 0; i < raw.size();) {
        if (raw[i] == '^' && i + 1 < raw.size() && raw[i + 1] >= '0' && raw[i + 1] <= '9') { i += 2; continue; }
        r.map.push_back(i);
        r.plain.push_back(raw[i]);
        ++i;
    }
    r.map.push_back(raw.size());
    return r;
}

// Every row of the active tab, oldest first, wrapped to `width`.
void build_rows(float width) {
    g_rows.clear();
    const tab_t& t = cur_tab();
    size_t idx = 0;
    for (auto& l : g_lines) {
        ++idx;
        if (!visible_in_tab(l, t)) continue;
        const auto& w = wrap(l, width);
        for (size_t k = 0; k < w.size(); ++k) {
            row_t r = make_row(w[k], idx);
            if (k == 0 && !l.system && !l.local && !l.mine && !l.from_sid.empty() && !l.from.empty()) {
                const int tag = l.ch == CH_PARTY ? 8 /* "[Party] " */ : l.ch == CH_DM ? 5 /* "[DM] " */ : 0;
                const int e = tag + static_cast<int>(l.from.size());
                if (e <= static_cast<int>(r.plain.size()) && r.plain.compare(static_cast<size_t>(tag), l.from.size(), l.from) == 0) {
                    r.name_b = tag; r.name_e = e;
                    r.name_sid = l.from_sid; r.name = l.from;
                }
            }
            g_rows.push_back(std::move(r));
        }
    }
    if (g_hsel_a.row >= static_cast<int>(g_rows.size()) || g_hsel_b.row >= static_cast<int>(g_rows.size())) clear_hsel();
}

const float kSel[4] = {0.93f, 0.82f, 0.45f, 0.40f};      // selection: WaW's gold, tinted
const float kGold[4] = {0.93f, 0.82f, 0.45f, 1};

void draw_panel(int lc) {
    const uintptr_t pos = rd<uintptr_t>(kDvarHudChatPos);
    const float cx = g_embedded ? g_anchor_x : pos ? rd<float>(pos + kDvarValue) : 5.f;   // [esc-menu]
    const float cy = g_embedded ? g_anchor_y : pos ? rd<float>(pos + kDvarValue + 4) : 200.f;
    const int rows = 10;
    g_hist_rows_vis = rows;
    const float W = 340.f;
    const float x0 = cx - 3.f;
    const float top = cy - kLH * rows - 20.f;       // tab strip
    const float bottom = cy + 26.f;                  // below the input line
    const float bg[4] = {0, 0, 0, 0.62f};
    const float strip[4] = {0.18f, 0.18f, 0.18f, 0.85f};
    box(x0, top, W, bottom - top, bg);
    box(x0, top, W, 18.f, strip);

    // Where the pointer is, for hover.
    float mx = -1e6f, my = -1e6f;
    if (g_mouse_in && g_mouse_x >= 0) to_virtual(g_mouse_x, g_mouse_y, &mx, &my);

    // ---- tabs: Global, Party, one per DM conversation, and "+"
    g_tab_rects.assign(g_tabs.size(), rect{-1e6f, -1e6f, 0, 0});
    float tx = x0 + 4.f;
    const float tabs_end = x0 + W - 70.f;
    for (size_t i = 0; i < g_tabs.size(); ++i) {
        const tab_t& t = g_tabs[i];
        std::string label = t.kind == T_DM ? t.name.substr(0, 12) : t.name;
        if (t.unread && static_cast<int>(i) != g_tab) label += " (" + std::to_string(t.unread) + ")";
        const float w = text_w(label.c_str()) + 10.f;
        if (tx + w > tabs_end && static_cast<int>(i) != g_tab && t.kind != T_NEW) continue;  // no room: Tab still reaches it
        const rect r{tx, top, w, 18.f};
        g_tab_rects[i] = r;
        const bool active = static_cast<int>(i) == g_tab;
        const bool hover = r.hit(mx, my);
        if (active) {
            const float a[4] = {0.93f, 0.82f, 0.45f, 0.22f};
            box(r.x, r.y, r.w, r.h, a);
            box(r.x, r.y + 16.f, r.w, 2.f, kGold);
        } else if (hover) {
            const float hv[4] = {1, 1, 1, 0.10f};
            box(r.x, r.y, r.w, r.h, hv);
        }
        const std::string col = active ? "^7" : t.kind == T_DM ? "^6" : t.kind == T_PARTY ? "^2" : "^7";
        text(tx + 5.f, top + 14.f, (col + label).c_str(), active || hover ? kWhite : kDim);
        tx += w + 2.f;
    }
    // status + close
    {
        std::string st;
        bool ok;
        { std::lock_guard<std::mutex> lk(g_mu); st = g_net_status; ok = g_net_ok; }
        g_net_ok_cached = ok;
        const std::string s = ok ? std::string("^2online") : std::string("^1offline");
        const float sw = text_w(s.c_str());
        g_close_rect = g_embedded ? rect{-1e6f, -1e6f, 0, 0} : rect{x0 + W - 16.f, top, 16.f, 18.f};   // [esc-menu]
        if (g_close_rect.hit(mx, my)) { const float hv[4] = {1, 1, 1, 0.12f}; box(g_close_rect.x, g_close_rect.y, g_close_rect.w, g_close_rect.h, hv); }
        text(x0 + W - 22.f - sw, top + 14.f, s.c_str(), kDim);
        if (!g_embedded) text(x0 + W - 12.f, top + 14.f, "x", kWhite);
    }

    const float hist_w = W - 12.f;
    g_hist_x = cx;
    g_hist_base = cy - 1.f;
    g_hist_rect = {x0, top + 18.f, W, cy + 3.f - (top + 18.f)};
    g_contact_rects.clear();

    if (cur_tab().kind == T_NEW) {
        // ---- the recipient picker: friends and party, then anyone seen in chat
        std::vector<contact> list = g_me.contacts;
        for (auto it = g_lines.rbegin(); it != g_lines.rend() && list.size() < 20; ++it) {
            if (it->from_sid.empty() || it->mine || it->from_sid == g_me.sid) continue;
            bool dup = false;
            for (const auto& c : list) dup |= c.sid == it->from_sid;
            if (!dup) list.push_back({it->from_sid, it->from, false});
        }
        text(cx, top + 32.f, "^3Message someone: click a name, or type /w name message", kDim);
        float y = top + 48.f;
        for (const auto& c : list) {
            if (y > cy) break;
            const rect r{x0 + 2.f, y - kAsc, W - 4.f, kLH};
            if (r.hit(mx, my)) { const float hv[4] = {1, 1, 1, 0.10f}; box(r.x, r.y, r.w, r.h, hv); }
            text(cx, y, ((c.party ? "^2" : "^7") + c.name + (c.party ? " ^7(party)" : "")).c_str(), kWhite);
            g_contact_rects.push_back({r, c});
            y += kLH;
        }
        if (list.empty()) text(cx, top + 48.f, "^3No friends or party members yet", kDim);
        g_rows.clear();
    } else {
        // ---- history, bottom-anchored on the WaW chat line
        build_rows(hist_w - 6.f);
        const int n = static_cast<int>(g_rows.size());
        const int maxs = (std::max)(0, n - rows);
        if (g_scroll > maxs) g_scroll = maxs;
        hpos lo = g_hsel_a, hi = g_hsel_b;
        if (hpos_less(hi, lo)) std::swap(lo, hi);
        const bool sel = hsel_any();
        for (int i = 0; i < rows; ++i) {
            const int ri = n - 1 - g_scroll - i;
            if (ri < 0) break;
            const row_t& r = g_rows[static_cast<size_t>(ri)];
            const float base = g_hist_base - kLH * i;
            if (my >= base - kAsc && my < base - kAsc + kLH && mx >= x0 && mx < x0 + W) {
                const float hv[4] = {1, 1, 1, 0.05f};   // the row under the pointer
                box(x0 + 1.f, base - kAsc, W - 2.f, kLH, hv);
            }
            if (sel && ri >= lo.row && ri <= hi.row) {
                const int b = ri == lo.row ? lo.col : 0;
                const int e = ri == hi.row ? hi.col : static_cast<int>(r.plain.size());
                if (e > b) {
                    const float xb = row_x(r, b), xe = row_x(r, e);
                    box(cx + xb, base - kAsc, xe - xb + (ri < hi.row ? 3.f : 0.f), kLH, kSel);
                }
            }
            if (r.name_b >= 0) {   // the sender's name is a link to a DM tab
                const float nb = cx + row_x(r, r.name_b), ne = cx + row_x(r, r.name_e);
                if (mx >= nb && mx <= ne && my >= base - kAsc && my < base - kAsc + kLH) {
                    const float hv[4] = {1, 1, 1, 0.12f};
                    box(nb - 1.f, base - kAsc, ne - nb + 2.f, kLH, hv);
                    box(nb, base + 1.f, ne - nb, 1.f, kWhite);
                }
            }
            text(cx, base, r.raw.c_str(), kWhite);
        }
        if (n == 0) {
            const tab_t& t = cur_tab();
            const char* hint = t.kind == T_PARTY ? (g_me.party_id ? "^3No party messages yet" : "^3You are not in a party")
                             : t.kind == T_DM ? "^3No messages yet -- say hello" : "^3No messages yet";
            text(cx, g_hist_base, hint, kDim);
        }
        if (!g_net_ok_cached && n < rows - 1) {
            std::string st;
            { std::lock_guard<std::mutex> lk(g_mu); st = g_net_status; }
            text(cx, top + 32.f, ("^1" + st).c_str(), kDim);
        }
        if (g_scroll > 0) text(x0 + W - 14.f, top + 32.f, "^3^", kWhite);   // there is more below
    }

    // ---- the input line: WaW's "Say:" box, a real text box
    const float iy = cy + 20.f;
    const float ibg[4] = {1, 1, 1, g_focus_input ? 0.10f : 0.04f};
    g_input_rect = {x0 + 2.f, iy - 15.f, W - 4.f, 18.f};
    box(g_input_rect.x, g_input_rect.y, g_input_rect.w, g_input_rect.h, ibg);
    const tab_t& t = cur_tab();
    const std::string prefix = t.kind == T_PARTY ? "^2Party: " : t.kind == T_DM ? "^6To " + t.name + ": "
                             : t.kind == T_NEW ? "^6To: " : "^7Say: ";
    text(cx, iy, prefix.c_str(), kWhite);
    g_input_text_x = cx + text_w(prefix.c_str());
    g_input_room = (x0 + W - 6.f) - g_input_text_x;
    // Keep the caret in view.
    if (g_in_scroll > g_caret) g_in_scroll = g_caret;
    while (g_in_scroll < g_caret && text_w(g_input.substr(g_in_scroll, g_caret - g_in_scroll).c_str()) > g_input_room) ++g_in_scroll;
    while (g_in_scroll > 0 && text_w(g_input.substr(g_in_scroll - 1).c_str()) <= g_input_room) --g_in_scroll;
    std::string shown = g_input.substr(g_in_scroll);
    while (!shown.empty() && text_w(shown.c_str()) > g_input_room) shown.pop_back();
    auto xin = [&](size_t col) {
        col = (std::max)(g_in_scroll, (std::min)(col, g_in_scroll + shown.size()));
        return g_input_text_x + text_w(g_input.substr(g_in_scroll, col - g_in_scroll).c_str());
    };
    if (has_sel()) {
        const float xb = xin(sel_lo()), xe = xin(sel_hi());
        if (xe > xb) box(xb, iy - kAsc, xe - xb, kLH, kSel);
    }
    text(g_input_text_x, iy, ("^7" + shown).c_str(), kWhite);
    if (g_focus_input && (((::GetTickCount() - g_blink_t) / 530) & 1) == 0)
        box(xin(g_caret), iy - 12.f, 1.5f, 13.f, kWhite);

    // WaW's own cursor, drawn by the engine so it exists in every window mode --
    // CENTRED on the pointer, exactly as the UI draws it (0x5B6970: x - 32*0.5,
    // size 32 from [0x84BC9C]). The image's hot spot is its middle; drawing it
    // from its top-left (round 1) put the visible tip 16 units -- 48 px at 1440p --
    // below-right of where a click actually lands, which is why B could move the
    // pointer but never hit a tab.
    if (!g_embedded && g_mouse_in && g_mouse_x >= 0) {   // [esc-menu] the menu draws it, last
        void* cur = rd<void*>(kUiCursor);
        if (cur) {
            reinterpret_cast<stretch_pic_t>(kRStretchPic)(
                (mx - 16.f) * g_pl.sx + g_pl.ox, (my - 16.f) * g_pl.sy + g_pl.oy, 32.f * g_pl.sx,
                32.f * g_pl.sy, 0, 0, 1, 1, kWhite, cur);
        } else {
            box(mx - 1.f, my - 1.f, 3.f, 3.f, kWhite);
        }
    }
    (void)lc;
}

// ------------------------------------------------------------------ selftest
// ENW_CHAT_SELFTEST=1: demo lines, then (ENW_CHAT_SELFTEST=2) a scripted session
// posted into the game's own message queue, with a back-buffer capture after the
// steps that matter. Nothing here moves the real cursor, activates the window or
// touches the Windows clipboard (a private buffer stands in for it).
struct step { DWORD at; int kind; int a; int b; const char* s; };
enum { S_DEMO, S_SHOT, S_KEY, S_KEYMOD, S_TYPE, S_HOVER_TAB, S_CLICK_TAB, S_DBL_INPUT, S_DRAG_HIST,
       S_CLICK_NAME, S_WHEEL, S_CLICK_CONTACT, S_LOG, S_DONE };
const step kScript[] = {
    {3000, S_DEMO, 0, 0, nullptr},             // only when there is no site to talk to
    {6000, S_SHOT, 0, 0, "notify"},
    {8000, S_KEY, 'T', 0, nullptr},
    {9000, S_HOVER_TAB, 1, 0, nullptr},        // the pointer over "Party": the tip must be on it
    {9800, S_SHOT, 0, 0, "hover-party"},
    {10000, S_CLICK_TAB, 1, 0, nullptr},
    {10600, S_SHOT, 0, 0, "party"},
    {11000, S_KEY, VK_TAB, 0, nullptr},        // Party -> next
    {11400, S_KEYMOD, VK_TAB, VK_SHIFT, nullptr},   // and back
    {11800, S_CLICK_TAB, 0, 0, nullptr},       // Global
    {12200, S_TYPE, 0, 0, "hello selection world"},
    {13000, S_KEYMOD, VK_LEFT, VK_SHIFT, "5"}, // select "world"
    {13600, S_SHOT, 0, 0, "shift-select"},
    {14000, S_KEYMOD, 'C', VK_CONTROL, nullptr},
    {14300, S_KEY, VK_END, 0, nullptr},
    {14500, S_KEYMOD, 'V', VK_CONTROL, nullptr},
    {15000, S_LOG, 0, 0, "after paste"},
    {15200, S_SHOT, 0, 0, "pasted"},
    {15600, S_KEYMOD, 'A', VK_CONTROL, nullptr},
    {15800, S_KEY, VK_BACK, 0, nullptr},
    {16000, S_TYPE, 0, 0, "double click me"},
    {16800, S_DBL_INPUT, 7, 0, nullptr},       // double-click inside "click"
    {17300, S_LOG, 0, 0, "after double-click"},
    {17400, S_SHOT, 0, 0, "dblclick-word"},
    {17800, S_KEYMOD, 'A', VK_CONTROL, nullptr},
    {18000, S_KEY, VK_BACK, 0, nullptr},
    {18400, S_DRAG_HIST, 4, 1, nullptr},       // drag from visible row 4 to row 1
    {19000, S_SHOT, 0, 0, "history-drag"},
    {19300, S_KEYMOD, 'C', VK_CONTROL, nullptr},
    {19800, S_WHEEL, 120, 0, nullptr},
    {20300, S_SHOT, 0, 0, "wheel-up"},
    {20600, S_WHEEL, -120, 0, nullptr},
    {21000, S_CLICK_NAME, 0, 0, nullptr},      // a sender's name opens a DM tab
    {21800, S_SHOT, 0, 0, "name-opens-dm"},
    {22200, S_TYPE, 0, 0, "/w staminup hi from a whisper"},
    {23200, S_KEY, VK_RETURN, 0, nullptr},
    {25000, S_KEY, 'T', 0, nullptr},
    {26000, S_SHOT, 0, 0, "dm-tab-after-w"},
    {26400, S_CLICK_TAB, -1, 0, nullptr},      // the "+" picker
    {27000, S_SHOT, 0, 0, "picker"},
    {27400, S_CLICK_CONTACT, 0, 0, nullptr},
    {28000, S_LOG, 0, 0, "after picking a contact"},
    {28400, S_KEY, VK_ESCAPE, 0, nullptr},
    {29000, S_DONE, 0, 0, nullptr},
};
// ENW_CHAT_SELFTEST=3: the pause test. Typing pause (overlay open 5 s), then the
// Esc menu, with captures of cg_drawFPS at each edge.
const step kScript4[] = {
    {6000, S_SHOT, 0, 0, "fontcard"},
    {7000, S_KEY, 'T', 0, nullptr},
    {8500, S_SHOT, 0, 0, "fontcard-overlay"},
    {9000, S_KEY, VK_ESCAPE, 0, nullptr},
    {10000, S_KEY, VK_ESCAPE, 0, nullptr},     // the Esc menu (pause_menu.cpp draws with pick too)
    {11500, S_SHOT, 0, 0, "fontcard-escmenu"},
    {12000, S_KEY, VK_ESCAPE, 0, nullptr},
    {13000, S_DONE, 0, 0, nullptr},
};
const step kScript3[] = {
    {5000, S_SHOT, 0, 0, "p-before"},
    {6000, S_KEY, 'T', 0, nullptr},
    {7500, S_SHOT, 0, 0, "p-typing-1.5s"},
    {11000, S_SHOT, 0, 0, "p-typing-5s"},
    {11500, S_KEY, VK_ESCAPE, 0, nullptr},     // closes the overlay
    {12000, S_SHOT, 0, 0, "p-resumed-0.5s"},
    {14000, S_KEY, VK_ESCAPE, 0, nullptr},     // the game's Esc menu
    {16000, S_SHOT, 0, 0, "p-escmenu"},
    {18000, S_KEY, VK_ESCAPE, 0, nullptr},
    {19000, S_SHOT, 0, 0, "p-after-esc"},
    {21000, S_DONE, 0, 0, nullptr},
};
size_t g_step = 0;
int g_selftest_mode = 0;

void post_key(int vk) {
    HWND h = input_gate::window();
    if (!h) return;
    const UINT sc = ::MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    ::PostMessageA(h, WM_KEYDOWN, vk, 1 | (sc << 16));
    ::PostMessageA(h, WM_KEYUP, vk, 1 | (sc << 16) | (1u << 30) | (1u << 31));
}

void post_down(int vk, bool down) {
    HWND h = input_gate::window();
    if (!h) return;
    const UINT sc = ::MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    ::PostMessageA(h, down ? WM_KEYDOWN : WM_KEYUP, vk,
                   1 | (sc << 16) | (down ? 0u : ((1u << 30) | (1u << 31))));
}

LPARAM client_lp(float vx, float vy) {
    HWND h = input_gate::window();
    RECT rc{};
    if (h) ::GetClientRect(h, &rc);
    const int dw = rd<int>(kVidDisplayW), dh = rd<int>(kVidDisplayH);
    float bx = vx * g_pl.sx + g_pl.ox, by = vy * g_pl.sy + g_pl.oy;
    if (dw > 0 && dh > 0 && rc.right > 0) { bx = bx * rc.right / dw; by = by * rc.bottom / dh; }
    return MAKELPARAM(static_cast<int>(bx), static_cast<int>(by));
}

void post_mouse(UINT msg, WPARAM wp, float vx, float vy) {
    if (HWND h = input_gate::window()) ::PostMessageA(h, msg, wp, client_lp(vx, vy));
}

void click_virtual(float vx, float vy) {
    post_mouse(WM_MOUSEMOVE, 0, vx, vy);
    post_mouse(WM_LBUTTONDOWN, MK_LBUTTON, vx, vy);
    post_mouse(WM_LBUTTONUP, 0, vx, vy);
}

void inject_demo() {
    if (!g_bearer.empty()) return;  // a real site is attached: its lines are the test
    auto mk = [](int ch, const char* from, const char* text, bool sys, const char* peer = "") {
        chat_line l;
        l.ch = ch; l.local = false; l.id = -1 - static_cast<long long>(g_lines.size());
        l.system = sys; l.from = from; l.text = text; l.arrived = ::GetTickCount();
        l.peer_sid = peer; l.peer_name = from; l.from_sid = sys ? "" : (peer[0] ? peer : "76561198000000008");
        return l;
    };
    std::vector<chat_line> demo;
    demo.push_back(mk(CH_GLOBAL, "", "mule_kicker just went down on round 30 on Verruckt", true));
    demo.push_back(mk(CH_GLOBAL, "deadshot", "anyone up for Der Riese after this?", false));
    demo.push_back(mk(CH_GLOBAL, "quickrevive", "gl on 30, you have the ray gun at least", false));
    demo.push_back(mk(CH_PARTY, "juggernog", "box is by the power switch", false));
    demo.push_back(mk(CH_DM, "staminup", "ready when you are", false, "76561198000000009"));
    if (g_me.contacts.empty()) g_me.contacts.push_back({"76561198000000009", "staminup", false});
    {
        std::lock_guard<std::mutex> lk(g_mu);
        for (auto& l : demo) g_inbox.push_back(std::move(l));
    }
    ENW_INFO("chat_overlay: selftest injected 5 demo lines");
}

void selftest_tick() {
    const step* script = g_selftest_mode == 4 ? kScript4 : g_selftest_mode == 3 ? kScript3 : kScript;
    const size_t count = g_selftest_mode == 4 ? sizeof kScript4 / sizeof kScript4[0]
                       : g_selftest_mode == 3 ? sizeof kScript3 / sizeof kScript3[0] : sizeof kScript / sizeof kScript[0];
    if (!g_selftest || !g_first_draw || g_step >= count) return;
    const DWORD t = ::GetTickCount() - g_first_draw;
    const step& s = script[g_step];
    if (t < s.at) return;
    ++g_step;
    const bool scripted = g_selftest_mode >= 2;
    auto tab_idx = [](int a) { return a < 0 ? static_cast<int>(g_tabs.size()) - 1 : a; };
    switch (s.kind) {
    case S_DEMO: inject_demo(); break;
    case S_SHOT: {
        // Our own back-buffer capture (frame_capture.cpp) works off-screen and in
        // exclusive fullscreen; the engine's screenshotJPEG is only the fallback.
        if (!frame_capture::request(s.s)) cbuf_add_text("screenshotJPEG\n");
        ENW_INFO("chat_overlay: selftest screenshot '%s' at +%lu ms (open=%d tab=%d '%s' input='%s' "
                 "caret=%zu sel=%zu..%zu)", s.s, t, g_open ? 1 : 0, g_tab, cur_tab().name.c_str(),
                 g_input.c_str(), g_caret, sel_lo(), sel_hi());
        break;
    }
    case S_LOG:
        ENW_INFO("chat_overlay: selftest %s: tab=%d '%s' input='%s' caret=%zu selection='%s'", s.s,
                 g_tab, cur_tab().name.c_str(), g_input.c_str(), g_caret,
                 g_input.substr(sel_lo(), sel_hi() - sel_lo()).c_str());
        break;
    case S_KEY: if (scripted) post_key(s.a); break;
    case S_KEYMOD:
        if (scripted) {
            const int n = s.s ? std::atoi(s.s) : 1;
            post_down(s.b, true);
            for (int i = 0; i < n; ++i) post_key(s.a);
            post_down(s.b, false);
        }
        break;
    case S_TYPE:
        // WM_CHAR, as the pump's TranslateMessage makes it (a window that has never
        // had the keyboard gets no WM_CHAR from a posted WM_KEYDOWN).
        if (scripted)
            if (HWND h = input_gate::window())
                for (const char* p = s.s; *p; ++p) ::PostMessageA(h, WM_CHAR, static_cast<unsigned char>(*p), 1);
        break;
    case S_HOVER_TAB:
        if (scripted) {
            const rect& r = g_tab_rects[static_cast<size_t>(tab_idx(s.a))];
            post_mouse(WM_MOUSEMOVE, 0, r.x + r.w / 2, r.y + r.h / 2);
        }
        break;
    case S_CLICK_TAB:
        if (scripted) {
            const int i = tab_idx(s.a);
            if (i < static_cast<int>(g_tab_rects.size())) {
                const rect& r = g_tab_rects[static_cast<size_t>(i)];
                click_virtual(r.x + r.w / 2, r.y + r.h / 2);
            }
        }
        break;
    case S_DBL_INPUT:
        if (scripted) {
            const float x = g_input_text_x + text_w(g_input.substr(0, static_cast<size_t>(s.a)).c_str()) + 2.f;
            const float y = g_input_rect.y + g_input_rect.h / 2;
            click_virtual(x, y);
            click_virtual(x, y);
        }
        break;
    case S_DRAG_HIST:
        if (scripted) {
            const float y0 = g_hist_base - kLH * s.a - 6.f, y1 = g_hist_base - kLH * s.b - 6.f;
            post_mouse(WM_MOUSEMOVE, 0, g_hist_x + 20.f, y0);
            post_mouse(WM_LBUTTONDOWN, MK_LBUTTON, g_hist_x + 20.f, y0);
            post_mouse(WM_MOUSEMOVE, MK_LBUTTON, g_hist_x + 80.f, (y0 + y1) / 2);
            post_mouse(WM_MOUSEMOVE, MK_LBUTTON, g_hist_x + 150.f, y1);
            post_mouse(WM_LBUTTONUP, 0, g_hist_x + 150.f, y1);
        }
        break;
    case S_WHEEL:
        if (scripted)
            if (HWND h = input_gate::window()) ::PostMessageA(h, WM_MOUSEWHEEL, MAKEWPARAM(0, s.a), 0);
        break;
    case S_CLICK_NAME:
        if (scripted) {
            const int n = static_cast<int>(g_rows.size());
            for (int i = 0; i < g_hist_rows_vis; ++i) {
                const int ri = n - 1 - g_scroll - i;
                if (ri < 0) break;
                const row_t& r = g_rows[static_cast<size_t>(ri)];
                if (r.name_b < 0) continue;
                const float x = g_hist_x + (row_x(r, r.name_b) + row_x(r, r.name_e)) / 2;
                ENW_INFO("chat_overlay: selftest clicks the name '%s' on visible row %d", r.name.c_str(), i);
                click_virtual(x, g_hist_base - kLH * i - 6.f);
                break;
            }
        }
        break;
    case S_CLICK_CONTACT:
        if (scripted && !g_contact_rects.empty()) {
            const rect& r = g_contact_rects.front().first;
            click_virtual(r.x + 20.f, r.y + r.h / 2);
        }
        break;
    case S_DONE:
        ENW_INFO("chat_overlay: selftest done: draws=%ld opens=%ld sent=%ld clicks=%ld open=%d "
                 "tabs=%zu lines=%zu window activations seen: %ld on / %ld off",
                 g_draws, g_opens, g_sent, g_clicks, g_open ? 1 : 0, g_tabs.size(), g_lines.size(),
                 g_act_on, g_act_off);
        break;
    }
}

// ------------------------------------------------------------ the draw hook
void draw_inner(int lc) {
    const DWORD now = ::GetTickCount();
    if (!g_last_draw || now - g_last_draw > 1000) g_streak_start = now;  // a fresh map / load
    g_last_draw = now;
    if (!g_first_draw) g_first_draw = now;
    ++g_draws;
    drain_inbox();

    g_pl = place(lc);
    g_place_sx = g_pl.sx; g_place_sy = g_pl.sy; g_place_ox = g_pl.ox; g_place_oy = g_pl.oy;
    g_scr = reinterpret_cast<const void*>(kScrPlaceView + static_cast<uintptr_t>(lc) * 0x48);
    g_font = pick_font(g_pl);
    if (!g_font) return;
    const int ph = rd<int>(reinterpret_cast<uintptr_t>(g_font) + 4);   // Font_s::pixelHeight
    if (ph <= 0 || ph > 256) return;
    g_xscale = g_text_scale * 48.0f / static_cast<float>(ph);   // UI_DrawText's own factor

    if (!g_logged_first_draw) {
        g_logged_first_draw = true;
        stock_font::on_first_map_frame();
        const char* fname = rd<const char*>(reinterpret_cast<uintptr_t>(g_font));
        ENW_INFO("chat_overlay: FIRST DRAW from inside CG_Draw2D. scrPlaceView[%d] scale %.3f x "
                 "%.3f, origin (%.1f, %.1f); display %dx%d; font '%s' (%d px) -> x-scale %.4f",
                 lc, g_pl.sx, g_pl.sy, g_pl.ox, g_pl.oy, rd<int>(kVidDisplayW),
                 rd<int>(kVidDisplayH), fname && !::IsBadStringPtrA(fname, 64) ? fname : "?", ph,
                 g_xscale);
    }
    if (pause_menu::draw(lc)) {}   // [esc-menu] the menu draws the panel itself
    else if (g_open) draw_panel(lc);
    else draw_notify();
    if (g_selftest_mode == 4) draw_font_card();
    selftest_tick();
}

long g_faults = 0;
void __cdecl draw_hook(int lc) {
    if (!g_enabled) return;
    __try {
        draw_inner(lc);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        if (++g_faults <= 3)
            ENW_ERROR("chat_overlay: fault 0x%08lX while drawing; %s", GetExceptionCode(),
                      g_faults == 3 ? "disabling the overlay" : "skipping this frame");
        if (g_faults >= 3) {
            g_enabled = false;
            if (g_open) { g_open = false; g_embedded = false; clip_for_overlay(false); input_gate::set_captured(false); }
        }
    }
}

__declspec(naked) void cg_draw2d_thunk() {
    __asm {
        push eax                     // localClientNum, for us
        mov ecx, g_cg_draw2d
        call ecx                     // the real CG_Draw2D; eax is still localClientNum
        call draw_hook               // cdecl, [esp+4] = the pushed localClientNum
        add esp, 4
        ret
    }
}

// ----------------------------------------------------------------- component
bool verify() {
    for (const auto& s : kSigs) {
        std::vector<uint8_t> got(s.bytes.size());
        if (!memory::read_raw(s.at, got.data(), got.size()) || got != s.bytes) {
            ENW_ERROR("chat_overlay: %s at 0x%08X does not match this image (found %s). The "
                      "overlay is OFF; nothing was patched.", s.name, static_cast<unsigned>(s.at),
                      memory::hex_dump(s.at, s.bytes.size()).c_str());
            return false;
        }
    }
    const uintptr_t tgt = memory::call_target(kCallCGDraw2D);
    if (tgt != kCGDraw2D) {
        ENW_ERROR("chat_overlay: 0x%08X does not call CG_Draw2D (calls 0x%08X). OFF.",
                  static_cast<unsigned>(kCallCGDraw2D), static_cast<unsigned>(tgt));
        return false;
    }
    return true;
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

class chat_overlay final : public component {
public:
    const char* name() const override { return "chat_overlay"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        if (env_off("ENW_CHAT_OVERLAY")) {
            g_enabled = false;
            ENW_INFO("chat_overlay: OFF (ENW_CHAT_OVERLAY=0)");
            return;
        }
        if (const char* k = std::getenv("ENW_CHAT_KEY"); k && k[0]) {
            if (!k[1]) g_open_vk = std::toupper(static_cast<unsigned char>(k[0]));
            else g_open_vk = std::atoi(k);
        }
        g_notify_pause = !env_off("ENW_CHAT_NOTIFY");
        g_hold_enabled = !env_off("ENW_PAUSE_HOLD");
        if (const char* st = std::getenv("ENW_CHAT_SELFTEST"); st && st[0] && st[0] != '0') {
            g_selftest = true;
            g_selftest_mode = std::atoi(st);
        }
        if (!verify()) { g_enabled = false; return; }
        if (!memory::retarget_call(kCallCGDraw2D, reinterpret_cast<const void*>(&cg_draw2d_thunk))) {
            ENW_ERROR("chat_overlay: retarget of 0x%08X failed; OFF", static_cast<unsigned>(kCallCGDraw2D));
            g_enabled = false;
            return;
        }
        g_bound = true;
        input_gate::set_filter(&filter);
        ENW_INFO("chat_overlay: bound. CG_DrawActiveFrame's `call CG_Draw2D` (0x%08X) now draws "
                 "the overlay after the HUD, inside the client frame; UI_DrawText 0x%08X, "
                 "R_AddCmdDrawStretchPic 0x%08X, R_TextWidth 0x%08X verified by bytes. Open key "
                 "VK 0x%02X. Pause notify %s. Selftest %d. Off switch: ENW_CHAT_OVERLAY=0.",
                 static_cast<unsigned>(kCallCGDraw2D), static_cast<unsigned>(kUIDrawText),
                 static_cast<unsigned>(kRStretchPic), static_cast<unsigned>(kRTextWidth),
                 g_open_vk, g_notify_pause ? "on" : "off", g_selftest_mode);
    }

    void post_init() override {
        if (!g_enabled) return;
        start_net();
        // The userinfo half of the pause contract runs off the shared frame tick,
        // not the draw hook: the Esc menu can be up while CG draws nothing.
        frame::subscribe("chat_overlay", [](uint64_t n) {
            if (n < 60) return;  // let the command-line execs settle first
            report_ui_state();
            pause_hold_tick();
            if (g_esc_check_at && ::GetTickCount() >= g_esc_check_at) {
                g_esc_check_at = 0;
                log_esc_state("300 ms after Esc");
            }
        });
    }

    void pre_destroy() override {
        if (g_open) { g_open = false; clip_for_overlay(false); input_gate::set_captured(false); }
        input_gate::set_filter(nullptr);
        stop_net();
        if (!g_bearer.empty()) { SecureZeroMemory(&g_bearer[0], g_bearer.size()); g_bearer.clear(); }
        if (g_bound)
            ENW_INFO("chat_overlay: session: %ld frames drawn, opened %ld time(s), %ld line(s) sent; "
                     "window activations %ld on / %ld off",
                     g_draws, g_opens, g_sent, g_act_on, g_act_off);
    }
};

ENW_REGISTER_COMPONENT(chat_overlay)

}  // namespace

// [esc-menu] What the Esc menu (pause_menu.cpp) may call. Declared in pause_menu.hpp.
namespace chat_embed {
void open() {
    if (!g_enabled || !g_bound) return;
    if (g_open && !g_embedded) g_embedded = true;   // T was open: keep it, now embedded
    else if (!g_open) { open_overlay("Esc menu"); g_embedded = true; }
}
void close() {
    if (!g_embedded) return;
    g_embedded = false;
    close_overlay("Esc menu closed");
}
void draw_at(float x, float y) {
    if (!g_open || !g_font) return;
    g_anchor_x = x;
    g_anchor_y = y;
    draw_panel(0);
}
bool in_game() { return ::enw::client::in_game(); }
bool chat_open_alone() { return g_open && !g_embedded; }
}  // namespace chat_embed

}  // namespace enw::client
