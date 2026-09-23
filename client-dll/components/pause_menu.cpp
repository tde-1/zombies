// The ENW Esc menu: World at War's pause menu replaced, in a box (dedicated) game.
//
// docs/kickstart/esc-menu.md is the design and the results. B's ask, in his words:
// "Replace the escape menu with our custom menu: a Resume button, a Restart game button
// that tells the dedicated server to restart the game, an Exit game button, the chat, and
// invites from your friends and friends online with what maps they're on."
//
// ============================================================================
// WHERE IT HOOKS -- nowhere of its own
// ============================================================================
// Every engine seam this needs already belongs to the chat overlay (chat_overlay.cpp):
//   * DRAW: the overlay retargets CG_DrawActiveFrame's `call CG_Draw2D` (0x4628AB) and, in
//     its draw hook, calls pause_menu::draw() first. Same frame, same thread, same
//     render-command window as the HUD. The engine calls it uses (UI_DrawText 0x5B5FB0,
//     R_AddCmdDrawStretchPic 0x6F58E0, R_TextWidth 0x6E8DA0, Cbuf_AddText 0x594200) are
//     byte-checked by the overlay before it binds; this file is only ever called once the
//     overlay is bound, so it never runs against an image that failed that check.
//   * INPUT: input_gate.hpp allows ONE filter and it is the overlay's; the overlay calls
//     pause_menu::filter() before anything else it does. Esc is taken in the game window's
//     WndProc BEFORE the engine's (0x606BE0) ever sees the WM_KEYDOWN, so the engine's own
//     menu stack never opens: there is nothing to close and nothing drawn under ours.
//   * CHAT: the menu embeds the overlay's own panel through chat_embed (pause_menu.hpp):
//     one panel, one input line, one network link. Nothing of the panel is copied here.
//
// ============================================================================
// WHEN IT OPENS
// ============================================================================
// Esc, in a map (CG drew in the last 500 ms), with no console (keyCatchers 0x1), no engine
// menu (0x10) and no stock "Say:" field (0x20), when the chat is not open on its own (Esc
// is the chat's then: it closes the chat), and ONLY in a box game: the client's server
// address (clc.serverAddress.type, 0x300FFF8) is not NA_LOOPBACK (2). A Play Local game
// is its own listen server on loopback and keeps World at War's menu (B's brief: "leave
// the stock menu alone"); ENW_ESC_MENU=all takes it there too, ENW_ESC_MENU=0 turns it off.
// Esc again, or Resume, closes it.
//
// ============================================================================
// THE PAUSE CONTRACT (chat-overlay.md §8)
// ============================================================================
// While it is open the overlay reports `enw_ui paused` (report_ui_state: menu wins), which
// is exactly what the stock Esc menu reported: a solo game freezes, co-op freezes only when
// every player is in a menu. Closing it reports `clear`.
//
// ============================================================================
// RESTART -- the client half (the server half: server/components/dedicated/restart_request.cpp)
// ============================================================================
// A USERINFO key, not a client command: `setu enw_req restart.<n>`. The stock game answers
// an unknown client command with a visible "Unknown cmd" line (chat-overlay.md §9.5), and
// userinfo is the channel the pause contract already proved arrives mid-game. The server
// acts on a CHANGE of the value, per slot, so a stale value never restarts anything.
// Two clicks (the second within 4 s) so a stray click cannot throw away a run.
//
// ============================================================================
// EXIT -- quit on purpose, which is not a crash (B, 2026-09-23)
// ============================================================================
// "When you exit the game through the escape menu it needs to close the game AND cancel the
// server, so the launcher doesn't keep booting you back into the game. If the game crashes
// or you Alt+F4, it should be resumable from the server card." So Exit game first tells the
// site this player QUIT (POST /api/party/quit {match_id}, the chat pass, 2 s cap -- the
// contract is esc-menu.md §"quit vs crash"; the site lane owns the route), then
// `disconnect` and `quit`. A crash or Alt+F4 sends nothing, and that absence is the signal.
//
// ============================================================================
// FRIENDS -- the rail's online block, in the game
// ============================================================================
// GET /api/game-chat/menu/state every 10 s while the menu is open (and once when it opens),
// over the chat's own site and pass (chat_link.hpp): online friends with where they are,
// an Invite per row, invites addressed to me with Accept. Accept = the site's party join;
// the LAUNCHER takes the player there once this game has exited (its party watcher only
// follows when no game is running), and the menu says exactly that.
#include "component.hpp"
#include "frame.hpp"
#include "json.hpp"
#include "logger.hpp"

#include "chat_link.hpp"
#include "input_gate.hpp"
#include "pause_menu.hpp"
#include "settings_tab.hpp"   // [settings] the Settings tab (esc-menu.md §9)
#include "menu_lockdown.hpp"        // [console] the main-menu lockdown (esc-menu.md §10.1)
#include "restricted_console.hpp"   // [console] the ENW console (esc-menu.md §10.2)
#include "menu_lockdown_model.hpp"  // [C1] the menu a map starts under (esc-menu.md §11.4)

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
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

namespace enw::auth { const std::string& token(); }            // auth_token.cpp
namespace enw::client {
namespace frame_capture { bool request(const char* name); }    // frame_capture.cpp
namespace stock_font { void* pick(float real_scale); }          // stock_font.cpp
namespace {

// ------------------------------------------------------------------ addresses
// The overlay's (chat_overlay.cpp §1), byte-checked there before anything here can run.
constexpr uintptr_t kUIDrawText = 0x5B5FB0;
constexpr uintptr_t kRStretchPic = 0x6F58E0;
constexpr uintptr_t kRTextWidth = 0x6E8DA0;
constexpr uintptr_t kCbufAddText = 0x594200;
constexpr uintptr_t kScrPlaceView = 0x957318;
constexpr uintptr_t kWhiteMaterial = 0x4DA8F4C;
constexpr uintptr_t kUiCursor = 0x20A10D4;
constexpr uintptr_t kFontBig = 0x20A10E8;
constexpr uintptr_t kFontSmall = 0x20A10EC;
constexpr uintptr_t kFontNormal = 0x20A10F8;
constexpr uintptr_t kFontExtraBig = 0x20A10FC;
constexpr uintptr_t kDvarUiSmallFont = 0x20A10A4;
constexpr uintptr_t kDvarUiExtraBigFont = 0x208E8C4;
constexpr uintptr_t kDvarUiBigFont = 0x208C8B4;
constexpr uintptr_t kClcState = 0x305842C;
constexpr uintptr_t kKeyCatchers = 0x3058424;
constexpr uintptr_t kServerAddrType = 0x300FFF8;   // clc.serverAddress.type (t4-sp-map.md)
constexpr uintptr_t kVidDisplayW = 0x4DA90B8;
constexpr uintptr_t kVidDisplayH = 0x4DA90BC;
constexpr uintptr_t kDvarValue = 0x10;
constexpr int kNaLoopback = 2;

template <typename T>
T rd(uintptr_t a) { return *reinterpret_cast<volatile T*>(a); }

uintptr_t g_ui_draw_text = kUIDrawText;
uintptr_t g_r_text_width = kRTextWidth;
uintptr_t g_cbuf = kCbufAddText;

// UI_DrawText: nine stack arguments, caller cleans, horzAlign in ECX, vertAlign in EAX.
// The same thunk the overlay uses (chat_overlay.cpp explains the convention).
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

bool env_is(const char* k, const char* v) { const char* e = std::getenv(k); return e && !std::strcmp(e, v); }

// ------------------------------------------------------------- the net (site)
struct url_parts { std::wstring host; INTERNET_PORT port = 0; bool https = false; std::wstring path; };

HINTERNET g_session = nullptr;
std::string g_bearer;
url_parts g_url;
bool g_have_site = false;

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

int http(const wchar_t* method, const std::string& path, const std::string& body, std::string* out,
         DWORD timeout_ms) {
    if (!g_session) return -1;
    HINTERNET c = ::WinHttpConnect(g_session, g_url.host.c_str(), g_url.port, 0);
    if (!c) return -1;
    std::wstring wpath = g_url.path + std::wstring(path.begin(), path.end());
    HINTERNET r = ::WinHttpOpenRequest(c, method, wpath.c_str(), nullptr, WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES,
                                       g_url.https ? WINHTTP_FLAG_SECURE : 0);
    int status = -1;
    if (r) {
        const int t = static_cast<int>(timeout_ms);
        ::WinHttpSetTimeouts(r, t, t, t, t);
        std::wstring hdr = L"Authorization: Bearer " + std::wstring(g_bearer.begin(), g_bearer.end()) +
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

// Names and map titles come from the site; the engine's text renderer treats '^' as a
// colour code, so it is taken out, and anything outside printable Latin-1 goes.
std::string clean(const std::string& in, size_t max_len) {
    std::string o;
    for (size_t i = 0; i < in.size() && o.size() < max_len; ++i) {
        unsigned char c = static_cast<unsigned char>(in[i]);
        if (c == '^') continue;
        if (c >= 0x80) {   // UTF-8 -> Latin-1 where it fits, else '?'
            if ((c & 0xE0) == 0xC0 && i + 1 < in.size()) {
                const unsigned cp = ((c & 0x1F) << 6) | (static_cast<unsigned char>(in[i + 1]) & 0x3F);
                o.push_back(cp < 0x100 ? static_cast<char>(cp) : '?');
                ++i;
            } else {
                o.push_back('?');
                while (i + 1 < in.size() && (static_cast<unsigned char>(in[i + 1]) & 0xC0) == 0x80) ++i;
            }
            continue;
        }
        if (c < 0x20) continue;
        o.push_back(static_cast<char>(c));
    }
    return o;
}

// ------------------------------------------------------------------- model
struct friend_row {
    std::string sid, name, where, where_kind, held;
    bool can_invite = false;
    long long invite_id = 0;   // they sit in a lobby that invited me
};
struct invite_row { long long id = 0; std::string from, map_title; };

struct site_state {
    bool have = false;
    std::string scope = "friends";
    bool approved = false;
    std::vector<friend_row> friends;
    std::vector<invite_row> invites;
    int party_members = 0;
    std::string party_map;
};

enum act_kind { A_INVITE, A_ACCEPT, A_DECLINE, A_QUIT };
struct action { int kind; std::string sid, name; long long id = 0; };

std::mutex g_mu;                       // guards everything below until "main thread only"
std::condition_variable g_cv;
site_state g_site_net;
bool g_site_dirty = false;
std::string g_net_note = "offline";
bool g_net_ok = false;
std::deque<action> g_actions;
std::vector<std::string> g_results;    // one line per finished action, for the status line
bool g_refresh = false;
std::atomic<bool> g_stop{false};
std::atomic<bool> g_menu_open_net{false};
std::atomic<int> g_quit_state{0};      // 0 none, 1 posting, 2 done (either way)
std::thread g_thread;

// ---- main thread only ----
bool g_enabled = true;
bool g_all_games = false;              // ENW_ESC_MENU=all: Play Local too
bool g_open = false;
bool g_eat_esc_char = false;
DWORD g_last_draw = 0;
DWORD g_opened_at = 0;
site_state g_site;
std::string g_status;                  // the friends panel's last line
DWORD g_status_t = 0;
long g_opens = 0, g_clicks = 0;
int g_req_seq = 0;
std::string g_notice;                  // drawn on the HUD for a few seconds after the menu closes
DWORD g_notice_t = 0;
DWORD g_quit_t = 0;                    // when the quit step started
int g_quit_step = 0;                   // 0 idle, 1 waiting for the site, 2 disconnect sent, 3 quit sent
bool g_quit_final = true;              // [C1] false: the console's `disconnect` (the lockdown's end screen quits)
::enw::lockdown::start_menu g_start;   // [C1] the menu the map started under (esc-menu.md §11.4)
bool g_start_close = true;             // [C1] ENW_MAP_START_MENU=keep leaves it up (it still never pauses)
bool g_selftest = false;
int g_selftest_mode = 0;
DWORD g_first_draw = 0;

// [settings] B_SETTINGS is drawn second (kOrder); the enum keeps the old numbers.
enum button : int { B_RESUME = 0, B_RESTART = 1, B_EXIT = 2, B_SETTINGS = 3, B_COUNT = 4 };
constexpr int kOrder[B_COUNT] = {B_RESUME, B_SETTINGS, B_RESTART, B_EXIT};
int g_view = 0;                        // [settings] 0 friends + chat, 1 the Settings tab
int g_confirm = -1;                    // a button waiting for its second click
DWORD g_confirm_t = 0;

struct rect { float x, y, w, h; bool hit(float px, float py) const {
    return px >= x && px < x + w && py >= y && py < y + h; } };
rect g_btn[B_COUNT] = {};
struct row_hit { rect r; int kind; size_t index; };   // kind: 0 invite a friend, 1 accept, 2 decline
std::vector<row_hit> g_row_hits;

int g_mouse_x = -1, g_mouse_y = -1;     // client pixels
bool g_mouse_in = false;

// Placement, per draw.
struct placement { float sx, sy, ox, oy; };
placement g_pl{1, 1, 0, 0};
const void* g_scr = nullptr;
float g_vw = 640.f;                     // virtual width of this back buffer (wider than 640 on 16:9)

void set_status(const std::string& s) { g_status = s; g_status_t = ::GetTickCount(); }

// --------------------------------------------------------------- net thread
void parse_state(const std::string& body, site_state* s) {
    json::value v;
    if (!json::parse(body, &v) || v.type != json::kind::object) return;
    s->have = true;
    s->scope = v.str_or("scope", "friends");
    s->approved = v.bool_or("approved", false);
    if (const json::value* a = v.find("friends"); a && a->type == json::kind::array)
        for (const auto& x : a->items) {
            friend_row f;
            f.sid = x.str_or("steam_id");
            f.name = clean(x.str_or("name", "player"), 24);
            f.where = clean(x.str_or("where", "Online"), 48);
            f.where_kind = x.str_or("where_kind", "online");
            f.held = x.str_or("held");
            f.can_invite = x.bool_or("can_invite", false);
            f.invite_id = x.int_or("invite_id", 0);
            if (!f.sid.empty()) s->friends.push_back(std::move(f));
        }
    if (const json::value* a = v.find("invites"); a && a->type == json::kind::array)
        for (const auto& x : a->items) {
            invite_row i;
            i.id = x.int_or("id", 0);
            i.from = clean(x.str_or("from", "player"), 24);
            i.map_title = clean(x.str_or("map_title", ""), 40);
            if (i.id) s->invites.push_back(std::move(i));
        }
    if (const json::value* p = v.find("party"); p && p->type == json::kind::object) {
        s->party_members = static_cast<int>(p->int_or("members", 0));
        s->party_map = clean(p->str_or("map_title", ""), 40);
    }
}

void fetch_state() {
    std::string body;
    const int st = http(L"GET", "/api/game-chat/menu/state", "", &body, 8000);
    site_state s;
    if (st == 200) parse_state(body, &s);
    std::lock_guard<std::mutex> lk(g_mu);
    if (s.have) {
        g_site_net = std::move(s);
        g_site_dirty = true;
        g_net_ok = true;
        g_net_note = "online";
    } else {
        g_net_ok = false;
        g_net_note = st == 401 ? "the chat pass expired or was revoked"
                   : st == 404 ? "this site has no in-game menu yet"
                               : "cannot reach the site (" + std::to_string(st) + ")";
    }
}

std::string reason_of(int st, const std::string& body) {
    json::value v;
    if (json::parse(body, &v) && v.type == json::kind::object) {
        const std::string e = v.str_or("error");
        if (!e.empty()) return clean(e, 60);
    }
    return "the site said " + std::to_string(st);
}

// The match this game is: the invite token's `m`. Read, never logged.
std::string match_id_from_token() {
    const std::string& t = auth::token();
    const size_t dot = t.find('.');
    if (t.empty() || dot == std::string::npos) return {};
    std::string body;
    unsigned buf = 0; int bits = 0;
    for (size_t i = 0; i < dot; ++i) {
        const char c = t[i];
        int v = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26
              : c >= '0' && c <= '9' ? c - '0' + 52 : c == '-' ? 62 : c == '_' ? 63 : -1;
        if (v < 0) return {};
        buf = (buf << 6) | static_cast<unsigned>(v);
        bits += 6;
        if (bits >= 8) { bits -= 8; body.push_back(static_cast<char>((buf >> bits) & 0xFF)); }
    }
    json::value v;
    if (!json::parse(body, &v) || v.type != json::kind::object) return {};
    return v.str_or("m");
}

void do_action(const action& a) {
    std::string body, out;
    json::writer w;
    int st = -1;
    std::string line;
    switch (a.kind) {
    case A_INVITE:
        w.str("steam_id", a.sid);
        st = http(L"POST", "/api/game-chat/menu/invite", w.done(), &out, 8000);
        line = st == 200 ? "^2Invited " + a.name : "^1Invite failed: " + reason_of(st, out);
        break;
    case A_ACCEPT:
        w.integer("invite_id", a.id);
        st = http(L"POST", "/api/game-chat/menu/accept", w.done(), &out, 8000);
        line = st == 200 ? "^2Accepted " + a.name + "'s invite. Exit the game and the launcher takes you there."
                         : "^1Accept failed: " + reason_of(st, out);
        break;
    case A_DECLINE:
        w.integer("invite_id", a.id);
        st = http(L"POST", "/api/game-chat/menu/decline", w.done(), &out, 8000);
        line = st == 200 ? "Declined " + a.name + "'s invite" : "^1Decline failed: " + reason_of(st, out);
        break;
    case A_QUIT: {
        // B: quitting on purpose cancels the server (solo) or leaves the party (co-op);
        // a crash sends nothing. Two seconds, then we go whatever the answer.
        const std::string m = match_id_from_token();
        if (!m.empty()) w.str("match_id", m);
        w.str("reason", "esc_menu_exit");
        st = http(L"POST", "/api/party/quit", w.done(), &out, 2000);
        ENW_INFO("pause_menu: POST /api/party/quit -> %d%s (%s)", st, st >= 200 && st < 300 ? " (the site knows this was on purpose)" : "",
                 m.empty() ? "no match id: no invite token" : "with this game's match id");
        g_quit_state = 2;
        return;
    }
    }
    ENW_INFO("pause_menu: action %d -> HTTP %d", a.kind, st);
    std::lock_guard<std::mutex> lk(g_mu);
    g_results.push_back(line);
    g_refresh = true;
}

void net_loop() {
    DWORD last = 0;
    while (!g_stop) {
        action a;
        bool have_action = false, refresh = false;
        {
            std::unique_lock<std::mutex> lk(g_mu);
            g_cv.wait_for(lk, std::chrono::milliseconds(500),
                          [] { return g_stop || !g_actions.empty() || g_refresh; });
            if (g_stop) return;
            if (!g_actions.empty()) { a = g_actions.front(); g_actions.pop_front(); have_action = true; }
            refresh = g_refresh;
            g_refresh = false;
        }
        if (have_action) { do_action(a); continue; }
        const DWORD now = ::GetTickCount();
        // Every 10 s while the menu is up; nothing at all while it is not.
        if (refresh || (g_menu_open_net && (!last || now - last >= 10000))) {
            last = now;
            fetch_state();
        }
    }
}

void queue(action a) {
    if (!g_have_site && a.kind != A_QUIT) { set_status("^1Offline: start the game from the ENW launcher"); return; }
    std::lock_guard<std::mutex> lk(g_mu);
    g_actions.push_back(std::move(a));
    g_cv.notify_all();
}

void start_net() {
    std::string base;
    if (!auth::chat_credentials(&base, &g_bearer) || !crack(base, &g_url)) {
        ENW_INFO("pause_menu: no site credentials: the menu works; friends and invites say offline");
        std::lock_guard<std::mutex> lk(g_mu);
        g_net_note = "offline: start the game from the ENW launcher";
        return;
    }
    g_session = ::WinHttpOpen(L"ENW-Zombies-Game/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!g_session)
        g_session = ::WinHttpOpen(L"ENW-Zombies-Game/1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!g_session) return;
    g_have_site = true;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_net_note = "connecting";
    }
    g_thread = std::thread(net_loop);
    ENW_INFO("pause_menu: friends and invites from %s (the chat's site and pass)", base.c_str());
}

void stop_net() {
    g_stop = true;
    g_cv.notify_all();
    if (g_session) { ::WinHttpCloseHandle(g_session); g_session = nullptr; }
    if (g_thread.joinable()) g_thread.join();
    if (!g_bearer.empty()) { SecureZeroMemory(&g_bearer[0], g_bearer.size()); g_bearer.clear(); }
}

// ------------------------------------------------------------ open / close
bool box_game() {
    // Play Local is its own listen server: the client talks to it over NA_LOOPBACK. A box
    // (or the local dedicated test server) is a real address.
    return g_all_games || rd<int>(kServerAddrType) != kNaLoopback;
}

void open_menu(const char* why) {
    if (g_open) return;
    g_open = true;
    g_opened_at = ::GetTickCount();
    g_confirm = -1;
    ++g_opens;
    g_menu_open_net = true;
    chat_embed::open();
    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_refresh = true;
        g_cv.notify_all();
    }
    ENW_INFO("pause_menu: OPEN (%s) -- the stock pause menu never saw the key; enw_ui paused "
             "(clc.state %d, keyCatchers 0x%X, server address type %d)", why, rd<int>(kClcState),
             rd<int>(kKeyCatchers), rd<int>(kServerAddrType));
    if (g_view == 1) settings_tab::on_show();   // [settings]
}

void close_menu(const char* why) {
    if (!g_open) return;
    g_open = false;
    g_confirm = -1;
    settings_tab::on_hide();   // [settings] ends a capture or a drag (a drag is applied)
    g_view = 0;
    g_menu_open_net = false;
    chat_embed::close();
    ENW_INFO("pause_menu: CLOSED (%s) after %lu ms; enw_ui clear", why, ::GetTickCount() - g_opened_at);
}

void request_restart() {
    ++g_req_seq;
    char cmd[64];
    std::snprintf(cmd, sizeof cmd, "setu enw_req restart.%d\n", g_req_seq);
    cbuf(cmd);
    ENW_INFO("pause_menu: RESTART requested: userinfo enw_req restart.%d (the server acts on the "
             "change; server/components/dedicated/restart_request.cpp)", g_req_seq);
    close_menu("Restart game");
    g_notice = "^3Restart requested";
    g_notice_t = ::GetTickCount();
}

void begin_exit() {
    if (g_quit_step) return;
    g_quit_step = 1;
    g_quit_t = ::GetTickCount();
    set_status("Leaving the game...");
    if (g_have_site) {
        g_quit_state = 1;
        queue({A_QUIT, "", "", 0});
    } else {
        g_quit_state = 2;
    }
    ENW_INFO("pause_menu: EXIT game: telling the site this is a quit on purpose, then disconnect + quit");
}

// Driven from the frame tick: site answered (or 2.5 s passed) -> disconnect -> quit.
void exit_tick() {
    if (!g_quit_step) return;
    const DWORD now = ::GetTickCount();
    if (g_quit_step == 1 && (g_quit_state == 2 || now - g_quit_t > 2500)) {
        g_quit_step = 2;
        g_quit_t = now;
        close_menu("Exit game");
        cbuf("disconnect\n");
        ENW_INFO("pause_menu: disconnect sent");
    } else if (g_quit_step == 2 && now - g_quit_t > 400) {
        g_quit_step = 3;
        if (!g_quit_final) { ENW_INFO("pause_menu: disconnect only (console); the end screen takes it from here"); return; }
        ENW_INFO("pause_menu: quit");
        cbuf("quit\n");
    }
}

void click_button(int b) {
    const DWORD now = ::GetTickCount();
    if (b == B_RESUME) { close_menu("Resume"); return; }
    if (b == B_SETTINGS) {   // [settings]
        if (!settings_tab::available()) { set_status("^1Settings are not available in this build"); return; }
        g_view = g_view == 1 ? 0 : 1;
        g_confirm = -1;
        if (g_view == 1) settings_tab::on_show();
        else settings_tab::on_hide();
        ENW_INFO("pause_menu: view -> %s", g_view == 1 ? "Settings" : "friends and chat");
        return;
    }
    if (g_confirm == b && now - g_confirm_t <= 4000) {
        g_confirm = -1;
        if (b == B_RESTART) request_restart();
        else begin_exit();
        return;
    }
    g_confirm = b;
    g_confirm_t = now;
}

// ------------------------------------------------------------------- input
void to_virtual(int cx, int cy, float* vx, float* vy) {
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
    *vx = g_pl.sx > 0 ? (bx - g_pl.ox) / g_pl.sx : bx;
    *vy = g_pl.sy > 0 ? (by - g_pl.oy) / g_pl.sy : by;
}

bool on_click(int cx, int cy) {
    float x, y;
    to_virtual(cx, cy, &x, &y);
    ++g_clicks;
    if (g_view == 1 && settings_tab::capturing()) {   // [settings] the click IS the key (MOUSE1)
        settings_tab::mouse_down(x, y, 0);
        return true;
    }
    for (int b = 0; b < B_COUNT; ++b)
        if (g_btn[b].hit(x, y)) {
            ENW_INFO("pause_menu: click #%ld at client (%d,%d) -> virtual (%.1f,%.1f) -> button %s%s",
                     g_clicks, cx, cy, x, y, b == B_RESUME ? "Resume" : b == B_RESTART ? "Restart game"
                                             : b == B_SETTINGS ? "Settings" : "Exit game",
                     g_confirm == b ? " (confirmed)" : "");
            click_button(b);
            return true;
        }
    if (g_view == 1) {   // [settings] every other click in the Settings view is the tab's
        ENW_INFO("pause_menu: click #%ld at client (%d,%d) -> virtual (%.1f,%.1f) -> Settings tab", g_clicks, cx, cy, x, y);
        settings_tab::mouse_down(x, y, 0);
        return true;
    }
    for (const auto& h : g_row_hits) {
        if (!h.r.hit(x, y)) continue;
        if (h.kind == 0 && h.index < g_site.friends.size()) {
            const friend_row& f = g_site.friends[h.index];
            ENW_INFO("pause_menu: click #%ld -> virtual (%.1f,%.1f) -> %s '%s'", g_clicks, x, y,
                     f.invite_id ? "Accept (their lobby invited me)" : "Invite", f.name.c_str());
            if (f.invite_id) queue({A_ACCEPT, f.sid, f.name, f.invite_id});
            else queue({A_INVITE, f.sid, f.name, 0});
            set_status(f.invite_id ? "Accepting " + f.name + "'s invite..." : "Inviting " + f.name + "...");
        } else if ((h.kind == 1 || h.kind == 2) && h.index < g_site.invites.size()) {
            const invite_row& i = g_site.invites[h.index];
            ENW_INFO("pause_menu: click #%ld -> virtual (%.1f,%.1f) -> %s invite %lld from '%s'", g_clicks,
                     x, y, h.kind == 1 ? "Accept" : "Decline", i.id, i.from.c_str());
            queue({h.kind == 1 ? A_ACCEPT : A_DECLINE, "", i.from, i.id});
            set_status(h.kind == 1 ? "Accepting..." : "Declining...");
        }
        return true;
    }
    return false;   // not ours: the chat panel's, or nothing
}

}  // namespace

// ------------------------------------------------------------ public: input
namespace pause_menu {

bool is_open() { return g_open; }

bool filter(UINT msg, WPARAM wp, LPARAM lp, LRESULT* result) {
    if (!g_enabled) return false;
    *result = 0;
    if (menu_lockdown::swallow_input(msg)) return true;   // [console] our end screen: the main menu under it gets nothing
    {   // [console] the ENW console first: the console key never reaches the engine (esc-menu.md §10.2)
        const bool can_open = !g_open && !g_quit_step && chat_embed::in_game() && !chat_embed::chat_open_alone() &&
                              !(rd<int>(kKeyCatchers) & 0x30) && rd<int>(kClcState) >= 9;
        if (restricted_console::filter(msg, wp, lp, result, can_open)) return true;
    }
    if (msg == WM_CHAR && g_eat_esc_char && wp == 0x1B) { g_eat_esc_char = false; return true; }

    if (!g_open) {
        if (msg != WM_KEYDOWN || wp != VK_ESCAPE || (lp & (1 << 30))) return false;
        if (g_quit_step) return true;                       // leaving: nothing more to open
        if (!chat_embed::in_game() || chat_embed::chat_open_alone()) return false;
        if (rd<int>(kKeyCatchers) & 0x31) return false;     // console, an engine menu, "Say:"
        if (rd<int>(kClcState) < 9) return false;           // not in a map on a server yet
        if (!box_game()) return false;                      // Play Local keeps WaW's menu
        g_eat_esc_char = true;
        open_menu("Esc");
        return true;
    }

    // [settings] The Settings view owns the keyboard and every click and wheel notch in it:
    // the chat panel is not drawn there, so its input line must not type unseen.
    if (g_view == 1) {
        float vx = 0, vy = 0;
        switch (msg) {
        case WM_KEYDOWN:
            if (wp == VK_ESCAPE) {
                if (!(lp & (1 << 30))) {
                    g_eat_esc_char = true;
                    if (settings_tab::capturing()) settings_tab::key_down(wp, lp);   // cancels the capture
                    else { g_view = 0; settings_tab::on_hide(); ENW_INFO("pause_menu: Esc -> back from Settings"); }
                }
                return true;
            }
            settings_tab::key_down(wp, lp);
            return true;
        case WM_CHAR:
            return true;
        case WM_RBUTTONDOWN:
        case WM_MBUTTONDOWN:
        case WM_XBUTTONDOWN: {
            g_mouse_x = static_cast<short>(LOWORD(lp));
            g_mouse_y = static_cast<short>(HIWORD(lp));
            to_virtual(g_mouse_x, g_mouse_y, &vx, &vy);
            const int b = msg == WM_RBUTTONDOWN ? 1 : msg == WM_MBUTTONDOWN ? 2 : (HIWORD(wp) == XBUTTON1 ? 3 : 4);
            settings_tab::mouse_down(vx, vy, b);
            return true;
        }
        case WM_LBUTTONUP:
            to_virtual(static_cast<short>(LOWORD(lp)), static_cast<short>(HIWORD(lp)), &vx, &vy);
            settings_tab::mouse_up(vx, vy);
            return true;
        case WM_RBUTTONUP:
        case WM_MBUTTONUP:
        case WM_XBUTTONUP:
            return true;
        case WM_MOUSEMOVE:
            g_mouse_x = static_cast<short>(LOWORD(lp));
            g_mouse_y = static_cast<short>(HIWORD(lp));
            g_mouse_in = true;
            to_virtual(g_mouse_x, g_mouse_y, &vx, &vy);
            settings_tab::mouse_move(vx, vy);
            return true;
        case WM_MOUSEWHEEL:
            to_virtual(g_mouse_x, g_mouse_y, &vx, &vy);
            settings_tab::wheel(vx, vy, GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA);
            return true;
        default:
            break;   // WM_LBUTTONDOWN below: the left column's buttons first
        }
    }

    switch (msg) {
    case WM_KEYDOWN:
        if (wp == VK_ESCAPE) {
            if (!(lp & (1 << 30))) { g_eat_esc_char = true; close_menu("Esc"); }
            return true;
        }
        return false;   // typing: the chat's input line
    case WM_MOUSEMOVE:
        g_mouse_x = static_cast<short>(LOWORD(lp));
        g_mouse_y = static_cast<short>(HIWORD(lp));
        g_mouse_in = true;
        return false;   // the chat tracks it too (hover, drags)
    case WM_MOUSELEAVE:
        g_mouse_in = false;
        return false;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK:
        g_mouse_x = static_cast<short>(LOWORD(lp));
        g_mouse_y = static_cast<short>(HIWORD(lp));
        g_mouse_in = true;
        return on_click(g_mouse_x, g_mouse_y);
    default:
        return false;
    }
}

}  // namespace pause_menu

namespace {

// -------------------------------------------------------------------- draw
struct font_pick { void* font; float xs; };

font_pick font_for(float scale) {
    // CG_DrawChat's rule (chat_overlay.cpp pick_font): the real pixel scale against the
    // UI's own thresholds, so each size gets the crispest face World at War has for it.
    // Always the STOCK World at War font, never a mod's (stock_font.cpp, B 0.2.17).
    void* f = stock_font::pick(g_pl.sy * scale);
    if (!f) return {nullptr, 0.f};
    const int ph = rd<int>(reinterpret_cast<uintptr_t>(f) + 4);
    if (ph <= 0 || ph > 256) return {nullptr, 0.f};
    return {f, scale * 48.0f / static_cast<float>(ph)};
}

float tw(const std::string& s, float scale) {
    const font_pick fp = font_for(scale);
    if (!fp.font) return 0.f;
    return static_cast<float>(r_text_width(s.c_str(), 0x7FFFFFFF, fp.font)) * fp.xs;
}

void txt(float x, float y, const std::string& s, const float* col, float scale) {
    const font_pick fp = font_for(scale);
    if (!fp.font) return;
    ui_draw_text(g_scr, s.c_str(), 0x7FFFFFFF, fp.font, x, y, scale, col, 3 /*shadowed*/, 1, 1);
}

void box(float x, float y, float w, float h, const float* col) {
    void* mat = rd<void*>(kWhiteMaterial);
    if (!mat) return;
    reinterpret_cast<stretch_pic_t>(kRStretchPic)(x * g_pl.sx + g_pl.ox, y * g_pl.sy + g_pl.oy,
                                                  w * g_pl.sx, h * g_pl.sy, 0, 0, 1, 1, col, mat);
}

// The chat overlay's palette, so the two read as one thing.
const float kWhite[4] = {1, 1, 1, 1};
const float kDim[4] = {0.75f, 0.75f, 0.75f, 1};
const float kFaint[4] = {0.55f, 0.55f, 0.55f, 1};
const float kGold[4] = {0.93f, 0.82f, 0.45f, 1};
const float kGoldFill[4] = {0.93f, 0.82f, 0.45f, 0.22f};
const float kPanel[4] = {0, 0, 0, 0.62f};
const float kStrip[4] = {0.18f, 0.18f, 0.18f, 0.85f};
const float kHover[4] = {1, 1, 1, 0.10f};

// A small framed button: WaW's gold on hover.
void small_button(const rect& r, const char* label, bool hover, const float* text_col) {
    const float edge[4] = {0.93f, 0.82f, 0.45f, hover ? 0.9f : 0.45f};
    box(r.x, r.y, r.w, r.h, hover ? kGoldFill : kHover);
    box(r.x, r.y + r.h - 1.f, r.w, 1.f, edge);
    const float s = 0.24f;
    txt(r.x + (r.w - tw(label, s)) / 2.f, r.y + r.h - 3.5f, label, hover ? kWhite : text_col, s);
}

void draw_menu(float mx, float my) {
    // The whole screen dims, the way World at War's own in-game menu darkens the world.
    const float dim[4] = {0, 0, 0, 0.55f};
    box(0, 0, g_vw, 480.f, dim);

    // ---- left column: title and the three buttons
    const float x0 = 36.f;
    txt(x0, 50.f, "^3ENW ZOMBIES", kWhite, 0.28f);
    txt(x0, 84.f, "PAUSED", kWhite, 0.62f);
    box(x0, 92.f, 210.f, 1.f, kGold);
    std::string sub;
    if (g_site.party_members > 1) sub = "Co-op: the game pauses when everyone is in the menu";
    else if (!g_site.party_map.empty()) sub = g_site.party_map;
    if (!sub.empty()) txt(x0, 106.f, sub, kDim, 0.24f);

    const char* labels[B_COUNT] = {"Resume", "Restart game", "Exit game", "Settings"};
    const char* confirm[B_COUNT] = {"", "Click again to restart", "Click again to exit", ""};
    if (g_confirm >= 0 && ::GetTickCount() - g_confirm_t > 4000) g_confirm = -1;
    for (int k = 0; k < B_COUNT; ++k) {
        const int b = kOrder[k];
        const float y = 126.f + 28.f * k;   // [settings] 28 (was 30): four buttons clear the chat panel (top 256)
        g_btn[b] = {x0, y, 210.f, 24.f};
        const bool hover = g_btn[b].hit(mx, my);
        const bool conf = g_confirm == b;
        const bool active = b == B_SETTINGS && g_view == 1;   // [settings]
        if (hover || conf || active) {
            box(x0, y, 210.f, 24.f, kGoldFill);
            box(x0, y, 3.f, 24.f, kGold);
        }
        const std::string label = conf ? std::string("^3") + confirm[b] : labels[b];
        txt(x0 + 12.f, y + 18.f, label, hover || conf || active ? kWhite : kDim, 0.40f);
    }
    const float hint_y = 126.f + 28.f * static_cast<float>(B_COUNT) + 10.f;
    if (g_quit_step) txt(x0, hint_y, "^3Leaving the game...", kWhite, 0.26f);
    else txt(x0, hint_y, g_view == 1 ? "Esc  back" : "Esc  resume", kFaint, 0.24f);

    // [settings] The Settings view takes the whole right side; the chat and the friends
    // panel come back with Esc or the Settings button.
    if (g_view == 1) {
        const float sx = x0 + 210.f + 24.f;
        settings_tab::draw(sx, 36.f, (std::max)(200.f, g_vw - 36.f - sx), 480.f - 18.f - 36.f, mx, my);
        if (g_mouse_in && g_mouse_x >= 0) {
            if (void* cur = rd<void*>(kUiCursor)) {
                reinterpret_cast<stretch_pic_t>(kRStretchPic)(
                    (mx - 16.f) * g_pl.sx + g_pl.ox, (my - 16.f) * g_pl.sy + g_pl.oy, 32.f * g_pl.sx,
                    32.f * g_pl.sy, 0, 0, 1, 1, kWhite, cur);
            }
        }
        return;
    }

    // ---- bottom left: the chat overlay's own panel, anchored in the menu
    chat_embed::draw_at(x0 + 3.f, 480.f - 44.f);

    // ---- right: friends online and invites
    site_state& s = g_site;
    std::string note;
    bool ok;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        note = g_net_note;
        ok = g_net_ok;
    }
    // Right-aligned on a wide screen; on 4:3 (vw 640) it takes what the chat panel leaves.
    const float px = (std::max)(x0 + 340.f + 10.f, g_vw - 36.f - 250.f);
    const float W = (std::min)(250.f, g_vw - px - 6.f);
    const float top = 36.f, bottom = 480.f - 18.f;
    box(px, top, W, bottom - top, kPanel);
    box(px, top, W, 18.f, kStrip);
    g_row_hits.clear();
    const int online = static_cast<int>(s.friends.size());
    const std::string head = (s.scope == "online" ? "ONLINE" : "FRIENDS ONLINE") +
                             (s.have ? "  ^7" + std::to_string(online) : std::string());
    txt(px + 6.f, top + 14.f, head, kWhite, 0.28f);
    {
        const std::string st = ok ? "^2online" : "^1offline";
        txt(px + W - 6.f - tw(st, 0.24f), top + 13.f, st, kDim, 0.24f);
    }
    float y = top + 24.f;

    // Invites to me first: they are the thing to act on.
    if (!s.invites.empty()) {
        txt(px + 6.f, y + 10.f, "^3INVITES", kWhite, 0.24f);
        y += 14.f;
        for (size_t i = 0; i < s.invites.size() && y < bottom - 60.f; ++i) {
            const invite_row& iv = s.invites[i];
            const rect row{px + 2.f, y, W - 4.f, 26.f};
            if (row.hit(mx, my)) box(row.x, row.y, row.w, row.h, kHover);
            txt(px + 8.f, y + 11.f, iv.from, kWhite, 0.28f);
            txt(px + 8.f, y + 22.f, iv.map_title.empty() ? "invites you to their party" : iv.map_title, kDim, 0.22f);
            const rect acc{px + W - 72.f, y + 5.f, 48.f, 16.f};
            const rect dec{px + W - 20.f, y + 5.f, 16.f, 16.f};
            small_button(acc, "Accept", acc.hit(mx, my), kGold);
            small_button(dec, "x", dec.hit(mx, my), kDim);
            g_row_hits.push_back({acc, 1, i});
            g_row_hits.push_back({dec, 2, i});
            y += 28.f;
        }
        box(px + 4.f, y + 2.f, W - 8.f, 1.f, kStrip);
        y += 6.f;
    }

    if (!s.have) {
        txt(px + 8.f, y + 12.f, ok ? std::string("Loading...") : "^1" + note, kDim, 0.24f);
    } else if (s.friends.empty()) {
        txt(px + 8.f, y + 12.f, s.scope == "online" ? "Nobody else is online" : "No friends online", kDim, 0.26f);
    }
    for (size_t i = 0; i < s.friends.size() && y < bottom - 44.f; ++i) {
        const friend_row& f = s.friends[i];
        const rect row{px + 2.f, y, W - 4.f, 26.f};
        if (row.hit(mx, my)) box(row.x, row.y, row.w, row.h, kHover);
        // Where they are, as a coloured pip: red in a game, gold in a lobby, green online.
        const float in_game_c[4] = {0.85f, 0.30f, 0.25f, 1}, lobby_c[4] = {0.93f, 0.82f, 0.45f, 1},
                    online_c[4] = {0.35f, 0.80f, 0.35f, 1};
        box(px + 8.f, y + 5.f, 4.f, 4.f, f.where_kind == "game" ? in_game_c : f.where_kind == "lobby" ? lobby_c : online_c);
        txt(px + 17.f, y + 11.f, f.name, kWhite, 0.28f);
        txt(px + 17.f, y + 22.f, f.where, kDim, 0.22f);
        if (f.invite_id) {
            const rect b{px + W - 58.f, y + 5.f, 52.f, 16.f};
            small_button(b, "Accept", b.hit(mx, my), kGold);
            g_row_hits.push_back({b, 0, i});
        } else if (f.can_invite) {
            const rect b{px + W - 58.f, y + 5.f, 52.f, 16.f};
            small_button(b, "Invite", b.hit(mx, my), kDim);
            g_row_hits.push_back({b, 0, i});
        } else {
            const std::string tag = f.held == "member" ? "IN PARTY" : "INVITED";
            txt(px + W - 8.f - tw(tag, 0.22f), y + 16.f, tag, kFaint, 0.22f);
        }
        y += 28.f;
    }

    // The last thing that happened, for eight seconds.
    if (!g_status.empty() && ::GetTickCount() - g_status_t < 10000) {
        // Word-wrapped to the panel, at most three lines, bottom-anchored. A colour code at
        // the start of the message carries onto its continuation lines.
        std::vector<std::string> lines;
        std::string cur, colour = g_status.size() > 1 && g_status[0] == '^' ? g_status.substr(0, 2) : "";
        size_t i = 0;
        while (i < g_status.size()) {
            size_t j = g_status.find(' ', i);
            if (j == std::string::npos) j = g_status.size();
            const std::string word = g_status.substr(i, j - i);
            const std::string trial = cur.empty() ? word : cur + " " + word;
            if (!cur.empty() && tw(trial, 0.22f) > W - 12.f) { lines.push_back(cur); cur = colour + word; }
            else cur = trial;
            i = j + 1;
        }
        if (!cur.empty()) lines.push_back(cur);
        if (lines.size() > 3) lines.resize(3);
        const float sb[4] = {0.18f, 0.18f, 0.18f, 0.85f};
        box(px, bottom - 4.f - 10.f * lines.size() - 2.f, W, 10.f * lines.size() + 6.f, sb);
        for (size_t k = 0; k < lines.size(); ++k)
            txt(px + 6.f, bottom - 6.f - 10.f * static_cast<float>(lines.size() - 1 - k), lines[k], kWhite, 0.22f);
    }

    // ---- WaW's own cursor, last, CENTRED on the pointer (chat-overlay.md §10.1).
    if (g_mouse_in && g_mouse_x >= 0) {
        if (void* cur = rd<void*>(kUiCursor)) {
            reinterpret_cast<stretch_pic_t>(kRStretchPic)(
                (mx - 16.f) * g_pl.sx + g_pl.ox, (my - 16.f) * g_pl.sy + g_pl.oy, 32.f * g_pl.sx,
                32.f * g_pl.sy, 0, 0, 1, 1, kWhite, cur);
        }
    }
}

void drain() {
    std::vector<std::string> res;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_site_dirty) { g_site = g_site_net; g_site_dirty = false; }
        res.swap(g_results);
    }
    for (auto& r : res) set_status(r);
}

// ---------------------------------------------------------------- selftest
// ENW_ESC_MENU_SELFTEST=1: Esc is posted into the game's own queue, the pointer is moved
// onto each thing that matters and the back buffer is captured (frame_capture.cpp). =2
// also clicks Restart twice (a real request to the server). =3 clicks Exit game twice (the
// quit call, disconnect, quit: the process ends). Nothing activates the window or moves the
// real cursor.
struct step { DWORD at; int kind; int a; const char* s; };
enum { S_ESC, S_SHOT, S_HOVER_BTN, S_HOVER_FRIEND, S_CLICK_FRIEND, S_CLICK_ACCEPT, S_CLICK_BTN, S_TYPE, S_LOG, S_DONE };
const step kScript[] = {
    {7000, S_ESC, 0, nullptr},
    {8500, S_SHOT, 0, "esc-menu-open"},
    {9000, S_HOVER_BTN, B_RESUME, nullptr},
    {9600, S_SHOT, 0, "esc-menu-hover-resume"},
    {10000, S_HOVER_FRIEND, 0, nullptr},
    {10600, S_SHOT, 0, "esc-menu-hover-invite"},
    {11000, S_CLICK_FRIEND, 0, nullptr},
    {12400, S_SHOT, 0, "esc-menu-invited"},
    {12600, S_CLICK_ACCEPT, 0, nullptr},
    {13300, S_SHOT, 0, "esc-menu-accepted"},
    {13400, S_TYPE, 0, "gl everyone"},
    {14000, S_SHOT, 0, "esc-menu-chat-typed"},
    {14400, S_CLICK_BTN, B_RESTART, nullptr},
    {14900, S_SHOT, 0, "esc-menu-confirm-restart"},
    {15600, S_ESC, 0, nullptr},
    {16400, S_SHOT, 0, "esc-menu-resumed"},
    {17000, S_ESC, 0, nullptr},
    {18000, S_LOG, 0, "reopened"},
    {18200, S_CLICK_BTN, B_RESTART, "2"},   // mode 2 only: a real restart request
    {18600, S_CLICK_BTN, B_RESTART, "2"},
    {19200, S_SHOT, 0, "esc-menu-after-restart"},
    {22000, S_ESC, 0, "close-if-open"},
    {30000, S_SHOT, 0, "esc-menu-back-in-map"},   // mode 2: the map came back after the restart
    {30500, S_DONE, 0, nullptr},
};
// ENW_ESC_MENU_SELFTEST=3: Exit game, for real -- the quit call, disconnect, quit.
const step kExitScript[] = {
    {7000, S_ESC, 0, nullptr},
    {8000, S_SHOT, 0, "esc-menu-exit-open"},
    {8500, S_CLICK_BTN, B_EXIT, nullptr},
    {9000, S_SHOT, 0, "esc-menu-confirm-exit"},
    {9300, S_CLICK_BTN, B_EXIT, nullptr},
    {9450, S_SHOT, 0, "esc-menu-leaving"},
};
size_t g_step = 0;

LPARAM client_lp(float vx, float vy) {
    HWND h = input_gate::window();
    RECT rc{};
    if (h) ::GetClientRect(h, &rc);
    const int dw = rd<int>(kVidDisplayW), dh = rd<int>(kVidDisplayH);
    float bx = vx * g_pl.sx + g_pl.ox, by = vy * g_pl.sy + g_pl.oy;
    if (dw > 0 && dh > 0 && rc.right > 0) { bx = bx * rc.right / dw; by = by * rc.bottom / dh; }
    return MAKELPARAM(static_cast<int>(bx), static_cast<int>(by));
}

void post(UINT msg, WPARAM wp, LPARAM lp) { if (HWND h = input_gate::window()) ::PostMessageA(h, msg, wp, lp); }

void post_esc() {
    const UINT sc = ::MapVirtualKeyA(VK_ESCAPE, MAPVK_VK_TO_VSC);
    post(WM_KEYDOWN, VK_ESCAPE, 1 | (sc << 16));
    post(WM_KEYUP, VK_ESCAPE, 1 | (sc << 16) | (1u << 30) | (1u << 31));
}

// [settings] ENW_ESC_MENU_SELFTEST=5: the Settings tab, driven by posted clicks and keys
// on the controls it drew (settings_tab::control_point), with captures. In a box game the
// Apply step runs a real vid_restart and the rest checks the menu and Esc come back.
struct sstep { DWORD at; const char* op; const char* a; const char* b; float f; };
const sstep kSettingsScript[] = {
    {7000, "esc", nullptr, nullptr, 0},
    {8000, "btn", "settings", nullptr, 0},
    {8800, "shot", "settings-display", nullptr, 0},
    {9000, "values", "before", nullptr, 0},
    {9300, "slider", "fov", nullptr, 0.5455f},
    {9900, "click", "showFps", "0", 0},
    {10400, "click", "r_aspectRatio", "2", 0},
    {10900, "set", "r_aspectRatio", "wide 16:9", 0},
    {11400, "tab", "controls", nullptr, 0},
    {12000, "shot", "settings-controls", nullptr, 0},
    {12200, "slider", "sensitivity", nullptr, 0.2f},
    {12800, "click", "bind:+activate", "0", 0},
    {13200, "key", "G", nullptr, 0x47},
    {13800, "shot", "settings-controls-changed", nullptr, 0},
    {14000, "tab", "display", nullptr, 0},
    {14600, "shot", "settings-display-changed", nullptr, 0},
    {14800, "values", "after the changes", nullptr, 0},
    {15400, "apply", nullptr, nullptr, 0},
    {16000, "log", "after Apply", nullptr, 0},
    {24000, "values", "after vid_restart", nullptr, 0},
    {24200, "shot", "settings-after-restart", nullptr, 0},
    {24600, "esc", nullptr, nullptr, 0},
    {25200, "esc", nullptr, nullptr, 0},
    {26000, "esc", nullptr, nullptr, 0},
    {26800, "shot", "esc-menu-reopened-after-restart", nullptr, 0},
    {27000, "btn", "settings", nullptr, 0},
    {27600, "restrict", "1", nullptr, 0},
    {28200, "shot", "settings-verified-view", nullptr, 0},
    {28400, "restrict", "-1", nullptr, 0},
    {28600, "esc", nullptr, nullptr, 0},
    {29000, "esc", nullptr, nullptr, 0},
    {29500, "values", "final", nullptr, 0},
    {30000, "done", nullptr, nullptr, 0},
};

// =6: after a kill and a fresh launch, only read: are the values still what =5 set?
const sstep kSettingsReadScript[] = {
    {7000, "esc", nullptr, nullptr, 0},
    {8000, "btn", "settings", nullptr, 0},
    {8800, "values", "after a kill and a fresh launch", nullptr, 0},
    {9000, "shot", "settings-after-relaunch", nullptr, 0},
    {9400, "tab", "controls", nullptr, 0},
    {10000, "shot", "settings-controls-after-relaunch", nullptr, 0},
    {10400, "esc", nullptr, nullptr, 0},
    {10800, "esc", nullptr, nullptr, 0},
    {11200, "done", nullptr, nullptr, 0},
};

void settings_click(float vx, float vy, bool up = true) {
    post(WM_MOUSEMOVE, 0, client_lp(vx, vy));
    post(WM_LBUTTONDOWN, MK_LBUTTON, client_lp(vx, vy));
    if (up) post(WM_LBUTTONUP, 0, client_lp(vx, vy));
}

void settings_selftest_tick() {
    const bool read_only = g_selftest_mode == 6;
    const sstep* script = read_only ? kSettingsReadScript : kSettingsScript;
    const size_t n = read_only ? sizeof kSettingsReadScript / sizeof kSettingsReadScript[0]
                               : sizeof kSettingsScript / sizeof kSettingsScript[0];
    if (!g_first_draw || g_step >= n) return;
    const DWORD t = ::GetTickCount() - g_first_draw;
    const sstep& s = script[g_step];
    if (t < s.at) return;
    ++g_step;
    const std::string op = s.op;
    float vx = 0, vy = 0;
    if (op == "esc") post_esc();
    else if (op == "btn") settings_click(g_btn[B_SETTINGS].x + 100.f, g_btn[B_SETTINGS].y + 12.f);
    else if (op == "shot") {
        frame_capture::request(s.a);
        ENW_INFO("pause_menu: selftest capture '%s' at +%lu ms (open=%d, view=%d)", s.a, t, g_open ? 1 : 0, g_view);
    } else if (op == "values") settings_tab::log_values(s.a);
    else if (op == "tab") {
        if (settings_tab::control_point(std::string("tab:") + s.a, 0, 0, &vx, &vy)) settings_click(vx, vy);
        else ENW_INFO("pause_menu: selftest: tab '%s' is not on screen", s.a);
    } else if (op == "slider") {
        if (settings_tab::control_point(s.a, 3, s.f, &vx, &vy)) settings_click(vx, vy);
        else ENW_INFO("pause_menu: selftest: slider '%s' is not on screen", s.a);
    } else if (op == "click") {
        if (settings_tab::control_point(s.a, std::atoi(s.b), 0, &vx, &vy)) settings_click(vx, vy);
        else ENW_INFO("pause_menu: selftest: control '%s' is not on screen", s.a);
    } else if (op == "set") {
        ENW_INFO("pause_menu: selftest: set %s = '%s' -> %d", s.a, s.b, settings_tab::set_by_id(s.a, s.b) ? 1 : 0);
    } else if (op == "key") {
        const UINT vk = static_cast<UINT>(s.f);
        const UINT sc = ::MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
        post(WM_KEYDOWN, vk, 1 | (sc << 16));
        post(WM_KEYUP, vk, 1 | (sc << 16) | (1u << 30) | (1u << 31));
    } else if (op == "apply") {
        if (settings_tab::control_point("apply", 0, 0, &vx, &vy)) settings_click(vx, vy);
        else ENW_INFO("pause_menu: selftest: no Apply button on screen (Play Local, or nothing pending)");
    } else if (op == "restrict") {
        settings_tab::set_restricted_override(std::atoi(s.a));
        ENW_INFO("pause_menu: selftest: restricted override %s", s.a);
    } else if (op == "log") {
        ENW_INFO("pause_menu: selftest %s: open=%d view=%d input gate %s window 0x%p", s.a, g_open ? 1 : 0, g_view,
                 input_gate::installed() ? "installed" : "NOT installed", static_cast<void*>(input_gate::window()));
    } else if (op == "done") {
        ENW_INFO("pause_menu: selftest done (settings): opens=%ld clicks=%ld open=%d input gate %s", g_opens, g_clicks,
                 g_open ? 1 : 0, input_gate::installed() ? "installed" : "NOT installed");
    }
}

void selftest_tick() {
    if (g_selftest && (g_selftest_mode == 5 || g_selftest_mode == 6)) { settings_selftest_tick(); return; }   // [settings]
    const bool exit_run = g_selftest_mode == 3;
    const step* script = exit_run ? kExitScript : kScript;
    const size_t n = exit_run ? sizeof kExitScript / sizeof kExitScript[0] : sizeof kScript / sizeof kScript[0];
    if (!g_selftest || !g_first_draw || g_step >= n) return;
    const DWORD t = ::GetTickCount() - g_first_draw;
    const step& s = script[g_step];
    if (t < s.at) return;
    ++g_step;
    auto center = [](const rect& r) { return client_lp(r.x + r.w / 2, r.y + r.h / 2); };
    switch (s.kind) {
    case S_ESC:
        if (s.s && !std::strcmp(s.s, "close-if-open") && !g_open) break;
        post_esc();
        break;
    case S_SHOT:
        frame_capture::request(s.s);
        ENW_INFO("pause_menu: selftest capture '%s' at +%lu ms (open=%d, friends=%zu, invites=%zu, confirm=%d)",
                 s.s, t, g_open ? 1 : 0, g_site.friends.size(), g_site.invites.size(), g_confirm);
        break;
    case S_HOVER_BTN:
        post(WM_MOUSEMOVE, 0, center(g_btn[s.a]));
        break;
    case S_HOVER_FRIEND:
    case S_CLICK_FRIEND:
    case S_CLICK_ACCEPT: {
        // A friend's Invite button (not a row whose lobby invited us), or the first Accept.
        const row_hit* h = nullptr;
        for (const auto& r : g_row_hits) {
            const bool want = s.kind == S_CLICK_ACCEPT
                                  ? r.kind == 1
                                  : r.kind == 0 && r.index < g_site.friends.size() && !g_site.friends[r.index].invite_id;
            if (want) { h = &r; break; }
        }
        if (!h) { ENW_INFO("pause_menu: selftest: no friend row to %s", s.kind == S_CLICK_FRIEND ? "click" : "hover"); break; }
        post(WM_MOUSEMOVE, 0, center(h->r));
        if (s.kind != S_HOVER_FRIEND) {
            post(WM_LBUTTONDOWN, MK_LBUTTON, center(h->r));
            post(WM_LBUTTONUP, 0, center(h->r));
        }
        break;
    }
    case S_CLICK_BTN:
        if (s.s && !std::strcmp(s.s, "2") && g_selftest_mode < 2) break;
        post(WM_MOUSEMOVE, 0, center(g_btn[s.a]));
        post(WM_LBUTTONDOWN, MK_LBUTTON, center(g_btn[s.a]));
        post(WM_LBUTTONUP, 0, center(g_btn[s.a]));
        break;
    case S_TYPE:
        for (const char* p = s.s; *p; ++p) post(WM_CHAR, static_cast<unsigned char>(*p), 1);
        break;
    case S_LOG:
        ENW_INFO("pause_menu: selftest %s: open=%d", s.s, g_open ? 1 : 0);
        break;
    case S_DONE:
        ENW_INFO("pause_menu: selftest done: opens=%ld clicks=%ld restart requests=%d open=%d",
                 g_opens, g_clicks, g_req_seq, g_open ? 1 : 0);
        break;
    }
}

// [C1] The menu a map starts under (esc-menu.md §11.4). Fed every frame; in a box game a
// start menu still up 1.5 s into the map is closed with the player's own key (Esc, straight
// to the engine's WndProc: the stock way a menu closes, so its onClose script runs), and it
// never counts as a pause either way.
void start_menu_tick() {
    const bool in_map = rd<int>(kClcState) >= 10;
    const int kc = rd<int>(kKeyCatchers);
    const bool was = g_start.inherited;
    const auto act = g_start.feed(::GetTickCount64(), in_map, (kc & 0x10) != 0);
    if (!was && g_start.inherited)
        ENW_INFO("pause_menu: the map started under an engine menu (keyCatchers 0x%X, %llu ms into the map): the map's, "
                 "not a pause -- enw_ui stays clear%s", kc, ::GetTickCount64() - g_start.map_since,
                 g_start_close && box_game() ? "; closing it at 1.5 s" : "");
    if (act != ::enw::lockdown::start_menu::act::close) return;
    if (!g_start_close || !box_game() || g_open || restricted_console::is_open() || g_quit_step) return;
    if (!(rd<int>(kKeyCatchers) & 0x10)) return;   // gone this very frame: an Esc now would open the pause menu
    ENW_INFO("pause_menu: CLOSING the map's start menu (try %d, keyCatchers 0x%X, %llu ms into the map) with Esc to the "
             "engine, as the player's own Esc did", g_start.tries, rd<int>(kKeyCatchers), ::GetTickCount64() - g_start.map_since);
    const LPARAM sc = static_cast<LPARAM>(::MapVirtualKeyA(VK_ESCAPE, MAPVK_VK_TO_VSC)) << 16;
    input_gate::send_to_engine(WM_KEYDOWN, VK_ESCAPE, 1 | sc);
    input_gate::send_to_engine(WM_KEYUP, VK_ESCAPE, 1 | sc | (1 << 30) | (static_cast<LPARAM>(1) << 31));
}

}  // namespace

namespace pause_menu {

bool map_start_menu() { return g_start.inherited && (rd<int>(kKeyCatchers) & 0x10) != 0; }

bool request_exit(bool then_quit) {
    if (!g_enabled || g_quit_step) return false;
    g_quit_final = then_quit;
    close_menu(then_quit ? "console quit" : "console disconnect");
    begin_exit();
    return true;
}

bool request_restart_game() {
    if (!g_enabled || !box_game() || rd<int>(kClcState) < 10) return false;
    request_restart();
    return true;
}

bool draw(int lc) {
    if (!g_enabled) return false;
    const DWORD now = ::GetTickCount();
    g_last_draw = now;
    if (!g_first_draw) g_first_draw = now;
    const uintptr_t sp = kScrPlaceView + static_cast<uintptr_t>(lc) * 0x48;
    g_pl = {rd<float>(sp + 0x0), rd<float>(sp + 0x4), rd<float>(sp + 0x30), rd<float>(sp + 0x34)};
    g_scr = reinterpret_cast<const void*>(sp);
    const int dw = rd<int>(kVidDisplayW);
    g_vw = g_pl.sx > 0 && dw > 0 ? (dw - g_pl.ox) / g_pl.sx : 640.f;
    drain();
    selftest_tick();
    restricted_console::draw(g_vw);                    // [console] no-op while closed (it keeps its clock)
    if (restricted_console::is_open()) return true;   // [console] the overlay draws nothing under it
    if (!g_open) {
        if (!g_notice.empty() && now - g_notice_t < 5000) {
            txt((g_vw - tw(g_notice, 0.4f)) / 2.f, 120.f, g_notice, kWhite, 0.4f);
        }
        return false;
    }
    float mx = -1e6f, my = -1e6f;
    if (g_mouse_in && g_mouse_x >= 0) to_virtual(g_mouse_x, g_mouse_y, &mx, &my);
    draw_menu(mx, my);
    return true;
}

}  // namespace pause_menu

namespace {

class pause_menu_component final : public component {
public:
    const char* name() const override { return "pause_menu"; }
    bool is_supported() override {
        const char* cmd = ::GetCommandLineA();
        return !(cmd && std::strstr(cmd, "dedicated 1"));
    }

    void post_unpack() override {
        if (env_is("ENW_ESC_MENU", "0") || env_is("ENW_CHAT_OVERLAY", "0")) {
            g_enabled = false;
            ENW_INFO("pause_menu: OFF (%s)", env_is("ENW_ESC_MENU", "0") ? "ENW_ESC_MENU=0"
                                                                         : "the chat overlay is off, and it carries the menu");
            return;
        }
        g_all_games = env_is("ENW_ESC_MENU", "all");
        g_start_close = !env_is("ENW_MAP_START_MENU", "keep");   // [C1]
        if (const char* st = std::getenv("ENW_ESC_MENU_SELFTEST"); st && st[0] && st[0] != '0') {
            g_selftest = true;
            g_selftest_mode = std::atoi(st);
        }
        ENW_INFO("pause_menu: armed through the chat overlay's draw hook and input filter. Esc in a "
                 "%s opens ENW's menu instead of World at War's. ENW_ESC_MENU=0 off.%s",
                 g_all_games ? "map (ENW_ESC_MENU=all: Play Local too)" : "box game",
                 g_selftest ? " SELFTEST." : "");
    }

    void post_init() override {
        if (!g_enabled) return;
        start_net();
        settings_tab::init({&txt, &tw, &box});   // [settings] the stock-font drawing calls above
        restricted_console::init({&txt, &tw, &box});   // [console] the same calls
        frame::subscribe("pause_menu", [](uint64_t) {
            exit_tick();
            settings_tab::frame_tick();   // [settings] write-through checks, bind flush
            // The map went away under an open menu (disconnect, a load, the overlay turning
            // itself off after faults): close it, so `enw_ui` cannot stay `paused`.
            // [settings] Not while the Settings tab's vid_restart runs: the menu stays open
            // across it, so the game stays paused and the menu is back with the picture.
            if (g_open && ::GetTickCount() - g_last_draw > 1000 && !settings_tab::restart_in_progress())
                close_menu("no map drawn for 1 s");
            start_menu_tick();   // [C1] esc-menu.md §11.4
        });
    }

    void pre_destroy() override {
        if (g_open) close_menu("shutdown");
        stop_net();
        if (g_opens || g_clicks)
            ENW_INFO("pause_menu: session: opened %ld time(s), %ld click(s), %d restart request(s)",
                     g_opens, g_clicks, g_req_seq);
    }
};

ENW_REGISTER_COMPONENT(pause_menu_component)

}  // namespace
}  // namespace enw::client
