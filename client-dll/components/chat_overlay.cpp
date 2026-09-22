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

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cctype>
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
bool g_focus = true;           // the input line has the keyboard
int g_tab = CH_GLOBAL;
std::string g_input;
size_t g_caret = 0;
int g_scroll = 0;              // lines scrolled up from the bottom
std::deque<chat_line> g_lines;
int g_unread[3] = {};
me_info g_me;
std::string g_dm_sid, g_dm_name;
int g_open_vk = 'T';
bool g_eat_char = false;
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
rect g_tab_rect[3] = {};
rect g_input_rect = {};
rect g_hist_rect = {};
rect g_close_rect = {};
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

void add_local(int ch, const std::string& text, bool system = true) {
    chat_line l;
    l.ch = ch; l.local = true; l.system = system; l.text = text; l.arrived = ::GetTickCount();
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

void report_ui_state() {
    if (!g_notify_pause || !g_bound) return;
    const char* want = g_open ? "typing" : esc_menu_open() ? "paused" : "clear";
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

void open_overlay(const char* why) {
    if (g_open) return;
    g_open = true;
    g_focus = true;
    g_scroll = 0;
    g_unread[g_tab] = 0;
    ++g_opens;
    release_engine_keys();
    input_gate::set_captured(true);
    clip_for_overlay(true);
    report_ui_state();
    ENW_INFO("chat_overlay: OPEN (%s) tab=%d -- keyboard and mouse are the overlay's%s", why, g_tab,
             g_we_clipped ? "; pointer kept on the game's monitor" : "");
}

void close_overlay(const char* why) {
    if (!g_open) return;
    g_open = false;
    clip_for_overlay(false);
    input_gate::set_captured(false);
    report_ui_state();
    ENW_INFO("chat_overlay: CLOSED (%s)", why);
}

void send_input() {
    std::string text = g_input;
    while (!text.empty() && text.back() == ' ') text.pop_back();
    size_t s = 0;
    while (s < text.size() && text[s] == ' ') ++s;
    text = text.substr(s);
    g_input.clear();
    g_caret = 0;
    if (text.empty()) return;
    if (g_tab == CH_DM && g_dm_sid.empty()) {
        add_local(CH_DM, "^3Pick someone to message first (click a name on the right).");
        return;
    }
    if (g_tab == CH_PARTY && !g_me.party_id) {
        add_local(CH_PARTY, "^3You are not in a party.");
        return;
    }
    if (g_bearer.empty()) {
        add_local(g_tab, "^1Not sent: chat is offline (start the game from the ENW launcher).");
        return;
    }
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_outbox.push_back({g_tab, g_tab == CH_DM ? g_dm_sid : std::string(), text});
    }
    g_out_cv.notify_one();
    ++g_sent;
    ENW_INFO("chat_overlay: queued a %s line (%zu chars)",
             g_tab == CH_PARTY ? "party" : g_tab == CH_DM ? "DM" : "global", text.size());
}

// ------------------------------------------------------------------- input
bool is_mouse_msg(UINT m) {
    return (m >= WM_MOUSEFIRST && m <= WM_MOUSELAST);
}

void to_virtual(int cx, int cy, float* vx, float* vy) {
    // Client pixels -> backbuffer pixels (they differ if the window was resized)
    // -> the 640x480 virtual space through the same ScreenPlacement we draw with.
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

void on_click(int cx, int cy) {
    float x, y;
    to_virtual(cx, cy, &x, &y);
    if (g_close_rect.hit(x, y)) { close_overlay("clicked X"); return; }
    for (int t = 0; t < 3; ++t)
        if (g_tab_rect[t].hit(x, y)) {
            g_tab = t; g_scroll = 0; g_unread[t] = 0; g_focus = true;
            return;
        }
    for (const auto& cr : g_contact_rects)
        if (cr.first.hit(x, y)) {
            g_dm_sid = cr.second.sid; g_dm_name = cr.second.name; g_scroll = 0; g_focus = true;
            return;
        }
    if (g_input_rect.hit(x, y)) { g_focus = true; return; }
    g_focus = false;  // clicked the history or elsewhere: T now toggles the overlay shut
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

    if (!g_open) {
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
    if (is_mouse_msg(msg)) {
        g_mouse_x = static_cast<short>(LOWORD(lp));
        g_mouse_y = static_cast<short>(HIWORD(lp));
        g_mouse_in = true;
        if (msg == WM_MOUSEWHEEL) {
            // wheel lParam is SCREEN coordinates
            POINT p = {static_cast<short>(LOWORD(lp)), static_cast<short>(HIWORD(lp))};
            if (HWND h = input_gate::window()) ::ScreenToClient(h, &p);
            g_mouse_x = p.x; g_mouse_y = p.y;
            const int d = GET_WHEEL_DELTA_WPARAM(wp);
            g_scroll = (std::max)(0, g_scroll + (d > 0 ? 3 : -3));
        } else if (msg == WM_LBUTTONDOWN) {
            on_click(g_mouse_x, g_mouse_y);
        }
        return true;
    }
    switch (msg) {
    case WM_SETCURSOR:
        // Our cursor is the engine's (drawn in the frame); hide the OS one over
        // the client area so there are never two.
        if (LOWORD(lp) == HTCLIENT) { ::SetCursor(nullptr); *result = TRUE; return true; }
        return false;
    case WM_MOUSELEAVE:
        g_mouse_in = false;
        return false;
    case WM_KEYDOWN: {
        const int vk = static_cast<int>(wp);
        const bool ctrl = (::GetKeyState(VK_CONTROL) & 0x8000) != 0;
        switch (vk) {
        case VK_ESCAPE: close_overlay("Esc"); break;
        case VK_RETURN:
            if (!g_focus) { g_focus = true; break; }
            send_input();
            close_overlay("Enter");
            break;
        case VK_TAB:
            g_tab = (g_tab + ((::GetKeyState(VK_SHIFT) & 0x8000) ? 2 : 1)) % 3;
            g_scroll = 0; g_unread[g_tab] = 0;
            break;
        case VK_BACK:
            if (g_caret > 0) { g_input.erase(g_caret - 1, 1); --g_caret; }
            break;
        case VK_DELETE:
            if (g_caret < g_input.size()) g_input.erase(g_caret, 1);
            break;
        case VK_LEFT: if (g_caret > 0) --g_caret; break;
        case VK_RIGHT: if (g_caret < g_input.size()) ++g_caret; break;
        case VK_HOME: g_caret = 0; break;
        case VK_END: g_caret = g_input.size(); break;
        case VK_PRIOR: g_scroll += 8; break;
        case VK_NEXT: g_scroll = (std::max)(0, g_scroll - 8); break;
        case 'V':
            if (ctrl && ::OpenClipboard(nullptr)) {
                if (HANDLE h = ::GetClipboardData(CF_TEXT)) {
                    if (const char* s = static_cast<const char*>(::GlobalLock(h))) {
                        std::string paste = sanitise(s, 150);
                        for (char& c : paste) if (c == '\t') c = ' ';
                        const size_t room = 150 > g_input.size() ? 150 - g_input.size() : 0;
                        paste.resize((std::min)(paste.size(), room));
                        g_input.insert(g_caret, paste);
                        g_caret += paste.size();
                        ::GlobalUnlock(h);
                    }
                }
                ::CloseClipboard();
                g_eat_char = true;  // the WM_CHAR 0x16 that follows
            }
            break;
        default:
            break;
        }
        return true;
    }
    case WM_CHAR: {
        const unsigned char c = static_cast<unsigned char>(wp);
        if (g_eat_char) { g_eat_char = false; if (c < 0x20 || c == 't' || c == 'T') return true; }
        if (c < 0x20 || c == 0x7F) return true;       // Enter, Esc, Tab, Backspace: handled on keydown
        if (!g_focus) {
            if (std::tolower(c) == std::tolower(g_open_vk)) close_overlay("T (toggle)");
            else { g_focus = true; }
            if (!g_open) return true;
            if (!g_focus) return true;
        }
        if (g_input.size() < 150) { g_input.insert(g_caret, 1, static_cast<char>(c)); ++g_caret; }
        return true;
    }
    case WM_KEYUP:
        return false;  // to the engine, deliberately (see the header)
    case WM_SYSKEYDOWN: case WM_SYSKEYUP: case WM_SYSCHAR:
        // Alt+Tab / Alt+F4 must still work; the engine must not act on Alt+Enter.
        *result = ::DefWindowProcA(input_gate::window(), msg, wp, lp);
        return true;
    case WM_ACTIVATE:
        // Alt-tab while typing: give the pointer back to the desktop at once, and
        // take it again only if the player comes back to an open overlay.
        if (LOWORD(wp) == WA_INACTIVE) { g_mouse_in = false; clip_for_overlay(false); }
        else clip_for_overlay(true);
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
constexpr float kLH = 14.f;    // line step, virtual units
constexpr float kAsc = 13.f;   // baseline to the top of the line box
float g_xscale = 1.0f;               // scale*48/pixelHeight, the per-font factor
const void* g_scr = nullptr;
placement g_pl{};

void* pick_font(const placement& p) {
    // CG_DrawChat 0x436977..0x4369DD, verbatim in logic: real text scale against
    // the UI's font thresholds.
    const float real = p.sy * g_text_scale;
    const uintptr_t small = rd<uintptr_t>(kDvarUiSmallFont);
    if (small && rd<float>(small + kDvarValue) >= real) return rd<void*>(kFontSmall);
    const uintptr_t xbig = rd<uintptr_t>(kDvarUiExtraBigFont);
    if (xbig && real >= rd<float>(xbig + kDvarValue)) return rd<void*>(kFontExtraBig);
    const uintptr_t big = rd<uintptr_t>(kDvarUiBigFont);
    if (big && real >= rd<float>(big + kDvarValue)) return rd<void*>(kFontBig);
    return rd<void*>(kFontNormal);
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

bool visible_in_tab(const chat_line& l, int tab) {
    if (l.ch != tab) return false;
    if (tab == CH_DM && !g_dm_sid.empty() && !l.local) return l.peer_sid == g_dm_sid;
    return true;
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
        if (!g_dm_sid.empty()) {  // keep the DM target's name fresh
            for (const auto& c : g_me.contacts) if (c.sid == g_dm_sid) g_dm_name = c.name;
        }
    }
    for (auto& l : in) {
        if (!l.local) {
            bool dup = false;
            for (auto it = g_lines.rbegin(); it != g_lines.rend() && !dup; ++it)
                dup = !it->local && it->id == l.id && ((it->ch == CH_GLOBAL) == (l.ch == CH_GLOBAL));
            if (dup) continue;
        }
        if (l.ch == CH_DM && !l.mine && g_dm_sid.empty()) { g_dm_sid = l.peer_sid; g_dm_name = l.peer_name; }
        if (!(g_open && g_tab == l.ch)) ++g_unread[l.ch];
        g_lines.push_back(std::move(l));
    }
    while (g_lines.size() > 400) g_lines.pop_front();
}

const float kWhite[4] = {1, 1, 1, 1};
const float kDim[4] = {0.75f, 0.75f, 0.75f, 1};

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

void draw_panel(int lc) {
    const uintptr_t pos = rd<uintptr_t>(kDvarHudChatPos);
    const float cx = pos ? rd<float>(pos + kDvarValue) : 5.f;
    const float cy = pos ? rd<float>(pos + kDvarValue + 4) : 200.f;
    const int rows = 10;
    const float W = 340.f;
    const float x0 = cx - 3.f;
    const float top = cy - kLH * rows - 20.f;       // tab strip
    const float bottom = cy + 26.f;                  // below the input line
    const float bg[4] = {0, 0, 0, 0.62f};
    const float strip[4] = {0.18f, 0.18f, 0.18f, 0.85f};
    const float hl[4] = {0.93f, 0.82f, 0.45f, 1};   // WaW's parchment gold
    box(x0, top, W, bottom - top, bg);
    box(x0, top, W, 18.f, strip);

    // tabs
    const char* names[3] = {"Global", "Party", "DMs"};
    float tx = x0 + 6.f;
    for (int t = 0; t < 3; ++t) {
        char label[48];
        if (g_unread[t] && t != g_tab) std::snprintf(label, sizeof label, "%s (%d)", names[t], g_unread[t]);
        else std::snprintf(label, sizeof label, "%s", names[t]);
        const float w = text_w(label) + 12.f;
        g_tab_rect[t] = {tx - 4.f, top, w, 18.f};
        if (t == g_tab) box(tx - 4.f, top + 16.f, w, 2.f, hl);
        text(tx, top + 15.f, label, t == g_tab ? kWhite : kDim);
        tx += w + 4.f;
    }
    // status + close
    {
        std::string st;
        bool ok;
        { std::lock_guard<std::mutex> lk(g_mu); st = g_net_status; ok = g_net_ok; }
        g_net_ok_cached = ok;
        const std::string s = ok ? std::string("^2online") : std::string("^1offline");
        const float sw = text_w(s.c_str());
        g_close_rect = {x0 + W - 16.f, top, 16.f, 18.f};
        text(x0 + W - 22.f - sw, top + 15.f, s.c_str(), kDim);
        text(x0 + W - 12.f, top + 15.f, "x", kWhite);
    }

    // DM contact column
    float hist_w = W - 12.f;
    g_contact_rects.clear();
    if (g_tab == CH_DM) {
        const float colw = 100.f;
        hist_w -= colw + 6.f;
        const float colx = x0 + W - colw - 4.f;
        const float colbg[4] = {1, 1, 1, 0.06f};
        box(colx, top + 20.f, colw, kLH * rows + 2.f, colbg);
        float y = top + 36.f;
        if (g_me.contacts.empty()) text(colx + 3.f, y, "^3No friends yet", kDim);
        for (const auto& c : g_me.contacts) {
            if (y > cy) break;
            const rect r{colx, y - kAsc, colw, kLH};
            if (c.sid == g_dm_sid) { const float sel[4] = {0.93f, 0.82f, 0.45f, 0.25f}; box(r.x, r.y, r.w, r.h, sel); }
            std::string n = (c.party ? "^2" : "^7") + c.name;
            text(colx + 3.f, y, n.c_str(), kWhite);
            g_contact_rects.push_back({r, c});
            y += kLH;
        }
    }

    // history, bottom-anchored on the WaW chat line
    g_hist_rect = {x0, top + 18.f, hist_w, cy - top - 18.f};
    std::vector<const std::string*> vis;
    for (auto it = g_lines.rbegin(); it != g_lines.rend() && static_cast<int>(vis.size()) < rows + g_scroll + 40; ++it) {
        if (!visible_in_tab(*it, g_tab)) continue;
        const auto& w = wrap(*it, hist_w - 6.f);
        for (auto r = w.rbegin(); r != w.rend(); ++r) vis.push_back(&*r);
    }
    if (g_scroll > static_cast<int>(vis.size()) - rows) g_scroll = (std::max)(0, static_cast<int>(vis.size()) - rows);
    for (int i = 0; i < rows; ++i) {
        const size_t k = static_cast<size_t>(g_scroll + i);
        if (k >= vis.size()) break;
        text(cx, cy - 1.f - kLH * i, vis[k]->c_str(), kWhite);
    }
    if (!g_net_ok_cached && static_cast<int>(vis.size()) < rows - 1) {
        std::string st;
        { std::lock_guard<std::mutex> lk(g_mu); st = g_net_status; }
        text(cx, top + 34.f, ("^1" + st).c_str(), kDim);
    }
    if (vis.empty()) {
        const char* hint = g_tab == CH_PARTY ? (g_me.party_id ? "^3No party messages yet" : "^3You are not in a party")
                         : g_tab == CH_DM ? (g_dm_sid.empty() ? "^3Pick a name on the right" : "^3No messages yet")
                         : "^3No messages yet";
        text(cx, cy - 1.f, hint, kDim);
    }

    // the input line: WaW's "Say:" box
    const float iy = cy + 20.f;
    const float ibg[4] = {1, 1, 1, g_focus ? 0.10f : 0.04f};
    g_input_rect = {x0 + 2.f, iy - 15.f, W - 4.f, 18.f};
    box(g_input_rect.x, g_input_rect.y, g_input_rect.w, g_input_rect.h, ibg);
    std::string prefix = g_tab == CH_PARTY ? "^2Party: " : g_tab == CH_DM
        ? (g_dm_name.empty() ? std::string("^6To: ") : "^6To " + g_dm_name + ": ") : std::string("^7Say: ");
    text(cx, iy, prefix.c_str(), kWhite);
    const float px = cx + text_w(prefix.c_str());
    // show the tail if the line is wider than the box
    std::string shown = g_input;
    size_t caret = g_caret;
    const float room = W - 12.f - (px - cx);
    while (!shown.empty() && text_w(shown.c_str()) > room && caret > 0) { shown.erase(0, 1); --caret; }
    // No colour codes typed into the input line may restyle it.
    std::string safe;
    for (char c : shown) { if (c == '^') safe += "^^7"; else safe.push_back(c); }
    std::string before = shown.substr(0, caret);
    std::string before_safe;
    for (char c : before) { if (c == '^') before_safe += "^^7"; else before_safe.push_back(c); }
    text(px, iy, ("^7" + safe).c_str(), kWhite);
    if (g_focus && ((::GetTickCount() / 500) & 1) == 0) {
        const float cxp = px + text_w(before_safe.c_str());
        box(cxp, iy - 13.f, 1.5f, 14.f, kWhite);
    }

    // WaW's own cursor, drawn by the engine so it exists in every window mode
    if (g_mouse_in && g_mouse_x >= 0) {
        float vx, vy;
        to_virtual(g_mouse_x, g_mouse_y, &vx, &vy);
        void* cur = rd<void*>(kUiCursor);
        if (cur) {
            reinterpret_cast<stretch_pic_t>(kRStretchPic)(
                vx * g_pl.sx + g_pl.ox, vy * g_pl.sy + g_pl.oy, 32.f * g_pl.sx, 32.f * g_pl.sy,
                0, 0, 1, 1, kWhite, cur);
        } else {
            box(vx, vy, 3.f, 3.f, kWhite);
        }
    }
    (void)lc;
}

// ------------------------------------------------------------------ selftest
// ENW_CHAT_SELFTEST=1: demo lines, then (ENW_CHAT_SELFTEST=2) a scripted session
// posted into the game's own message queue -- the same path a real keypress
// takes (the pump's TranslateMessage makes the WM_CHARs) -- with the engine's own
// `screenshotJPEG` after each step. Nothing here moves the real cursor.
struct step { DWORD at; int kind; int a; int b; const char* s; };
enum { S_DEMO, S_SHOT, S_KEY, S_TYPE, S_CLICK_TAB, S_CLICK_CONTACT, S_MOVE, S_DONE };
const step kScript[] = {
    {3000, S_DEMO, 0, 0, nullptr},             // only when there is no site to talk to
    {6000, S_SHOT, 0, 0, "notify"},
    {8000, S_KEY, 'T', 0, nullptr},
    {9000, S_MOVE, 0, 0, nullptr},
    {10500, S_SHOT, 0, 0, "open"},
    {11000, S_TYPE, 0, 0, "hello from inside the game"},
    {13000, S_SHOT, 0, 0, "typed"},
    {13500, S_CLICK_TAB, CH_PARTY, 0, nullptr},
    {14500, S_SHOT, 0, 0, "party"},
    {15000, S_CLICK_TAB, CH_DM, 0, nullptr},
    {15500, S_CLICK_CONTACT, 0, 0, nullptr},
    {16500, S_SHOT, 0, 0, "dm"},
    {17000, S_CLICK_TAB, CH_GLOBAL, 0, nullptr},
    {17500, S_KEY, VK_RETURN, 0, nullptr},     // send on Global, and close
    {19000, S_SHOT, 0, 0, "sent"},
    {20000, S_KEY, 'T', 0, nullptr},           // party line
    {20500, S_KEY, VK_TAB, 0, nullptr},
    {21000, S_TYPE, 0, 0, "party line from the game"},
    {22500, S_KEY, VK_RETURN, 0, nullptr},
    {23500, S_KEY, 'T', 0, nullptr},           // DM line
    {24000, S_CLICK_TAB, CH_DM, 0, nullptr},
    {24500, S_CLICK_CONTACT, 0, 0, nullptr},
    {25000, S_TYPE, 0, 0, "dm from the game"},
    {26500, S_KEY, VK_RETURN, 0, nullptr},
    {27500, S_KEY, 'T', 0, nullptr},
    {28000, S_CLICK_TAB, CH_DM, 0, nullptr},
    {29500, S_SHOT, 0, 0, "dm-sent"},
    {30000, S_KEY, VK_ESCAPE, 0, nullptr},
    {32000, S_KEY, VK_ESCAPE, 0, nullptr},     // the game's own Esc menu: enw_ui paused
    {34000, S_SHOT, 0, 0, "escmenu"},
    {35000, S_KEY, VK_ESCAPE, 0, nullptr},
    {37000, S_SHOT, 0, 0, "closed"},
    {38000, S_DONE, 0, 0, nullptr},
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

void click_virtual(float vx, float vy) {
    HWND h = input_gate::window();
    if (!h) return;
    RECT rc{};
    ::GetClientRect(h, &rc);
    const int dw = rd<int>(kVidDisplayW), dh = rd<int>(kVidDisplayH);
    float bx = vx * g_pl.sx + g_pl.ox, by = vy * g_pl.sy + g_pl.oy;
    if (dw > 0 && dh > 0 && rc.right > 0) { bx = bx * rc.right / dw; by = by * rc.bottom / dh; }
    const LPARAM lp = MAKELPARAM(static_cast<int>(bx), static_cast<int>(by));
    ::PostMessageA(h, WM_MOUSEMOVE, 0, lp);
    ::PostMessageA(h, WM_LBUTTONDOWN, MK_LBUTTON, lp);
    ::PostMessageA(h, WM_LBUTTONUP, 0, lp);
}

void inject_demo() {
    if (!g_bearer.empty()) return;  // a real site is attached: its lines are the test
    auto mk = [](int ch, const char* from, const char* text, bool sys, const char* peer = "") {
        chat_line l;
        l.ch = ch; l.local = false; l.id = -1 - static_cast<long long>(g_lines.size());
        l.system = sys; l.from = from; l.text = text; l.arrived = ::GetTickCount();
        l.peer_sid = peer; l.peer_name = from; l.from_sid = peer;
        return l;
    };
    g_lines.push_back(mk(CH_GLOBAL, "", "mule_kicker just went down on round 30 on Verruckt", true));
    g_lines.push_back(mk(CH_GLOBAL, "deadshot", "anyone up for Der Riese after this?", false));
    g_lines.push_back(mk(CH_GLOBAL, "quickrevive", "gl on 30, you have the ray gun at least", false));
    g_lines.push_back(mk(CH_PARTY, "juggernog", "box is by the power switch", false));
    g_lines.push_back(mk(CH_DM, "staminup", "ready when you are", false, "76561198000000009"));
    if (g_me.contacts.empty()) g_me.contacts.push_back({"76561198000000009", "staminup", false});
    g_unread[CH_PARTY]++; g_unread[CH_DM]++;
    ENW_INFO("chat_overlay: selftest injected 5 demo lines");
}

void selftest_tick() {
    if (!g_selftest || !g_first_draw || g_step >= sizeof kScript / sizeof kScript[0]) return;
    const DWORD t = ::GetTickCount() - g_first_draw;
    const step& s = kScript[g_step];
    if (t < s.at) return;
    ++g_step;
    const bool scripted = g_selftest_mode >= 2;
    switch (s.kind) {
    case S_DEMO: inject_demo(); break;
    case S_SHOT: {
        // Our own back-buffer capture (frame_capture.cpp) works off-screen and in
        // exclusive fullscreen; the engine's screenshotJPEG is only the fallback.
        if (!frame_capture::request(s.s)) cbuf_add_text("screenshotJPEG\n");
        ENW_INFO("chat_overlay: selftest screenshot '%s' at +%lu ms (open=%d tab=%d input='%s')",
                 s.s, t, g_open ? 1 : 0, g_tab, g_input.c_str());
        break;
    }
    case S_KEY: if (scripted) post_key(s.a); break;
    case S_MOVE:
        if (scripted) {
            HWND h = input_gate::window();
            if (h) { RECT rc{}; ::GetClientRect(h, &rc);
                ::PostMessageA(h, WM_MOUSEMOVE, 0, MAKELPARAM(rc.right / 3, rc.bottom / 3)); }
        }
        break;
    case S_TYPE:
        // WM_CHAR, as the pump's TranslateMessage makes it. Posting WM_KEYDOWNs and
        // relying on TranslateMessage works only while the window has had keyboard
        // focus (the thread's key state is empty otherwise) -- a harness artefact,
        // not a player one: real keys always arrive with focus.
        if (scripted) {
            HWND h = input_gate::window();
            for (const char* p = s.s; h && *p; ++p)
                ::PostMessageA(h, WM_CHAR, static_cast<unsigned char>(*p), 1);
        }
        break;
    case S_CLICK_TAB:
        if (scripted) { const rect& r = g_tab_rect[s.a]; click_virtual(r.x + r.w / 2, r.y + r.h / 2); }
        break;
    case S_CLICK_CONTACT:
        if (scripted && !g_contact_rects.empty()) {
            const rect& r = g_contact_rects.front().first; click_virtual(r.x + r.w / 2, r.y + r.h / 2); }
        break;
    case S_DONE:
        ENW_INFO("chat_overlay: selftest done: draws=%ld opens=%ld sent=%ld open=%d lines=%zu "
                 "window activations seen: %ld on / %ld off",
                 g_draws, g_opens, g_sent, g_open ? 1 : 0, g_lines.size(), g_act_on, g_act_off);
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
        const char* fname = rd<const char*>(reinterpret_cast<uintptr_t>(g_font));
        ENW_INFO("chat_overlay: FIRST DRAW from inside CG_Draw2D. scrPlaceView[%d] scale %.3f x "
                 "%.3f, origin (%.1f, %.1f); display %dx%d; font '%s' (%d px) -> x-scale %.4f",
                 lc, g_pl.sx, g_pl.sy, g_pl.ox, g_pl.oy, rd<int>(kVidDisplayW),
                 rd<int>(kVidDisplayH), fname && !::IsBadStringPtrA(fname, 64) ? fname : "?", ph,
                 g_xscale);
    }
    if (g_open) draw_panel(lc);
    else draw_notify();
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
            if (g_open) { g_open = false; clip_for_overlay(false); input_gate::set_captured(false); }
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
}  // namespace enw::client
