// The ENW console, and World at War's stock console locked away. esc-menu.md §10.2.
//
// B, 2026-09-23: "players must never reach WaW's stock console; our own restricted console
// (sensitivity, FOV, harmless dvars only)".
//
// ============================================================================
// 1. THE STOCK CONSOLE NEVER OPENS -- two independent locks
// ============================================================================
//   * THE KEY. The engine's console key is the key under Esc, by SCAN CODE (IW3's
//     CL_KeyEvent / CL_IsConsoleKey; the WndProc 0x606BE0 maps lParam's scan code 0x29 to
//     K_CONSOLE whatever the keyboard layout -- on B's UK layout it is the `/¬ key, not
//     VK_OEM_3). pause_menu::filter calls filter() below first, which runs in the game
//     window's WndProc through the input gate BEFORE the engine's, and consumes that key's
//     WM_KEYDOWN / WM_KEYUP / WM_CHAR always. The engine never sees it.
//   * THE CATCHER. Any other way in (Backspace+Home, CL_KeyEvent's other console path; a
//     `toggleconsole` bind in a hand-edited config; an engine error that opens it) ends in the
//     same place: Con_ToggleConsole (IW3 cl_console.cpp, KisakCOD) is `keyCatchers ^= 1` plus a
//     field clear, and the console is drawn only while keyCatchers (0x3058424) bit 0x1 is set
//     (Con_DrawConsole checks Key_IsCatcherActive). So a frame subscriber clears bit 0x1
//     whenever it is set, logs it, and the console is gone the frame it appeared.
//   Off switch, for a developer only: ENW_STOCK_CONSOLE=1 (both locks off).
//
// ============================================================================
// 2. OURS
// ============================================================================
// The same key opens ours, in a map, when no menu and no chat is open. One line of input,
// the last lines of output, WaW's stock font (pause_menu's drawing calls). What a line can do
// is console_model.hpp: read or set any setting of the in-game catalogue by short name,
// alias, dvar or id (`fov 90`, `aniso 16`, `shadows off`), `list`, `help [name]`, `reset`,
// `binds`, `bind`, `unbind`, `apply`, `restart`, `disconnect`, `quit`, `clear` (esc-menu.md
// §11). A set goes through settings_tab::console_set: the same visibility (Verified game,
// mod-owned, forbidden) and the same `seta` + write-through as a click in Esc > Settings; a
// bind through the tab's own bind path; quit / disconnect / restart through the Esc menu's.
// Nothing typed here is ever handed to the engine as text.
//
// Selftest: ENW_CONSOLE_SELFTEST=1 drives it with posted keys in a map, captures it, then
// knocks the engine's own console open past our filter to prove the catcher.
#include "component.hpp"
#include "frame.hpp"
#include "game.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "console_model.hpp"
#include "input_gate.hpp"
#include "pause_menu.hpp"   // [C1] quit / disconnect / restart take the Esc menu's own paths
#include "restricted_console.hpp"
#include "settings_tab.hpp"

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

namespace enw::client {
namespace frame_capture { bool request(const char* name); }   // frame_capture.cpp
namespace restricted_console {
namespace {

constexpr uintptr_t kKeyCatchers = 0x3058424;   // clientUIActives[0].keyCatchers; 0x1 console
constexpr UINT kConsoleScan = 0x29;

template <typename T>
T rd(uintptr_t a) { return *reinterpret_cast<volatile T*>(a); }

settings_tab::draw_api g_api{};
bool g_inited = false;
bool g_locked = true;          // ENW_STOCK_CONSOLE=1 turns both locks off
bool g_open = false;
bool g_eat_char = false;       // the WM_CHAR that follows a key we handled
std::string g_input;
size_t g_caret = 0;
std::deque<std::string> g_out;
int g_scroll = 0;
std::vector<std::string> g_hist;
int g_hist_pos = -1;
DWORD g_last_draw = 0, g_opened_at = 0, g_blink = 0;
long g_opens = 0, g_commands = 0, g_key_eaten = 0, g_catcher_closed = 0;

// selftest
int g_selftest = 0;
DWORD g_first_map = 0;
unsigned g_st_done = 0;   // bit per plan step

bool is_console_key(LPARAM lp) { return ((lp >> 16) & 0xFF) == kConsoleScan && !(lp & (1 << 24)); }

void out(const std::string& s) {
    g_out.push_back(s);
    while (g_out.size() > 200) g_out.pop_front();
    g_scroll = 0;
}

// The keys the engine believes are held go up, so the player does not keep walking while
// typing (chat_overlay.cpp release_engine_keys, the same rules).
void release_engine_keys() {
    if (::GetForegroundWindow() != input_gate::window()) return;
    for (int vk = 0x08; vk <= 0xFE; ++vk) {
        if (vk == VK_LBUTTON || vk == VK_RBUTTON || vk == VK_MBUTTON || vk == VK_XBUTTON1 ||
            vk == VK_XBUTTON2 || vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU || vk == VK_F10)
            continue;
        if (!(::GetAsyncKeyState(vk) & 0x8000)) continue;
        const UINT sc = ::MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
        if (sc == kConsoleScan) continue;
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

void open_console(const char* why) {
    if (g_open) return;
    g_open = true;
    g_opened_at = ::GetTickCount();
    g_blink = g_opened_at;
    ++g_opens;
    g_hist_pos = -1;
    release_engine_keys();
    if (g_out.empty()) out("^3ENW^7 console  --  help");
    ENW_INFO("console: OPEN (%s) -- ours; World at War's console never saw the key", why);
}

void close_console(const char* why) {
    if (!g_open) return;
    g_open = false;
    ENW_INFO("console: CLOSED (%s) after %lu ms", why, ::GetTickCount() - g_opened_at);
}

// [RS] `restart` acts at once (B, 2026-09-23: "if you type restart in console, it shouldn't
// ask you to confirm since it's in console"). Typing a whole word is the confirmation; the
// Esc menu's button keeps its two clicks. A second `restart` within 5 s of one that went
// out is absorbed here (spam never becomes a second request); the server and the host
// have their own guards on top (restart_request.cpp, infra/host-agent/lib/restart.js).
DWORD g_restart_sent = 0;

void execute(const std::string& line) {
    namespace con = ::enw::console;
    const std::string t = con::trim(line);
    if (t.empty()) return;
    out("^5> ^7" + t);
    if (g_hist.empty() || g_hist.back() != t) g_hist.push_back(t);
    if (g_hist.size() > 50) g_hist.erase(g_hist.begin());
    ++g_commands;
    const con::command c = con::parse(t);
    std::string reply;
    auto lines = [&](const std::vector<std::string>& rows, const char* none) {
        if (rows.empty()) out(none);
        for (const auto& r : rows) out(r);
        reply = std::to_string(rows.size()) + " row(s)";
    };
    switch (c.v) {
    case con::verb::none: return;
    case con::verb::help:
        if (!c.name.empty()) {
            if (const con::builtin* b = con::find_builtin(c.name)) {
                std::string also;
                for (const char* a : b->aka) also += (also.empty() ? "" : ", ") + std::string(a);
                out(std::string("^3") + b->usage + "^7 -- " + b->what);
                if (!also.empty()) out("  also: " + also);
                reply = std::string("help ") + b->name;
            } else {
                const auto rows = settings_tab::console_help(c.name);
                for (const auto& r : rows) out(r);
                reply = rows.empty() ? std::string("?") : rows[0];
            }
            break;
        }
        out("^3<setting> [value]^7  fov 90, sens 3, shadows off, aa 4, volume 0.5");
        out("^3list^7 [filter]  ^3help^7 <name>  ^3reset^7 <setting>  ^3apply^7");
        out("^3binds  bind^7 <key> <action>  ^3unbind^7 <key>");
        out("^3restart  disconnect  quit  clear^7   Tab completes, Up/Down history");
        reply = "help";
        break;
    case con::verb::list: lines(settings_tab::console_list(c.name), "no match"); break;
    case con::verb::binds: lines(settings_tab::console_binds(c.name), "no match"); break;
    case con::verb::clear:
        g_out.clear();
        reply = "cleared";
        break;
    case con::verb::get: reply = settings_tab::console_get(c.name); out(reply); break;
    case con::verb::set: reply = settings_tab::console_set(c.name, c.value); out(reply); break;
    case con::verb::reset: reply = settings_tab::console_reset(c.name); out(reply); break;
    case con::verb::bind: reply = settings_tab::console_bind(c.name, c.value); out(reply); break;
    case con::verb::unbind: reply = settings_tab::console_unbind(c.name); out(reply); break;
    case con::verb::apply: reply = settings_tab::console_apply(); out(reply); break;
    case con::verb::restart:
        if (g_restart_sent && ::GetTickCount() - g_restart_sent < 5000) {
            reply = "restarting";   // already asked: spam is absorbed here
            out(reply);
            close_console("restart");
            break;
        }
        if (pause_menu::request_restart_game()) {
            g_restart_sent = ::GetTickCount();
            reply = "restarting";
            out(reply);
            close_console("restart");
        } else {
            reply = "restart: not in a game";
            out("^1" + reply);
        }
        break;
    case con::verb::disconnect:
    case con::verb::quit: {
        const bool q = c.v == con::verb::quit;
        if (pause_menu::request_exit(q)) { reply = q ? "quitting" : "leaving"; out(reply); close_console(q ? "quit" : "disconnect"); }
        else { reply = "already leaving"; out(reply); }
        break;
    }
    case con::verb::refused: reply = c.why; out("^1" + reply); break;
    }
    ENW_INFO("console: '%s' -> %s", t.c_str(), reply.c_str());
}

void complete_input() {
    const auto* s = settings_tab::console_schema();
    if (!s) return;
    const auto r = ::enw::console::complete_line(*s, g_input.substr(0, g_caret));
    if (r.matches.size() > 1) {
        std::string l;
        size_t shown = 0;
        for (const auto& m : r.matches) {
            if (++shown > 16) { l += "  ..."; break; }
            l += (l.empty() ? "" : "  ") + m;
        }
        out("^7" + l);
    }
    const std::string tail = g_input.substr(g_caret);
    g_input = r.line + tail;
    g_caret = r.line.size();
    if (g_input.size() > 120) { g_input.resize(120); g_caret = (std::min)(g_caret, g_input.size()); }
}

void paste() {
    if (!::OpenClipboard(nullptr)) return;
    if (HANDLE h = ::GetClipboardData(CF_TEXT)) {
        if (const char* s = static_cast<const char*>(::GlobalLock(h))) {
            std::string t;
            for (const char* p = s; *p && *p != '\r' && *p != '\n' && t.size() < 120; ++p)
                if (static_cast<unsigned char>(*p) >= 0x20) t.push_back(*p);
            ::GlobalUnlock(h);
            g_input.insert(g_caret, t);
            g_caret += t.size();
            if (g_input.size() > 120) { g_input.resize(120); g_caret = (std::min)(g_caret, g_input.size()); }
        }
    }
    ::CloseClipboard();
}

bool key_down(WPARAM vk, LPARAM lp) {
    g_blink = ::GetTickCount();
    if (is_console_key(lp) || vk == VK_ESCAPE) {
        if (!(lp & (1 << 30))) { g_eat_char = true; close_console(vk == VK_ESCAPE ? "Esc" : "console key"); }
        return true;
    }
    const bool ctrl = (::GetKeyState(VK_CONTROL) & 0x8000) != 0;
    switch (vk) {
    case VK_RETURN: {
        g_eat_char = true;
        const std::string line = g_input;
        g_input.clear();
        g_caret = 0;
        g_hist_pos = -1;
        execute(line);
        return true;
    }
    case VK_BACK:
        g_eat_char = true;
        if (g_caret > 0) { g_input.erase(g_caret - 1, 1); --g_caret; }
        return true;
    case VK_DELETE:
        if (g_caret < g_input.size()) g_input.erase(g_caret, 1);
        return true;
    case VK_LEFT: if (g_caret > 0) --g_caret; return true;
    case VK_RIGHT: if (g_caret < g_input.size()) ++g_caret; return true;
    case VK_HOME: g_caret = 0; return true;
    case VK_END: g_caret = g_input.size(); return true;
    case VK_UP:
    case VK_DOWN:
        if (g_hist.empty()) return true;
        if (vk == VK_UP) g_hist_pos = g_hist_pos < 0 ? static_cast<int>(g_hist.size()) - 1 : (std::max)(0, g_hist_pos - 1);
        else g_hist_pos = g_hist_pos < 0 ? -1 : g_hist_pos + 1;
        if (g_hist_pos >= static_cast<int>(g_hist.size())) g_hist_pos = -1;
        g_input = g_hist_pos < 0 ? std::string() : g_hist[static_cast<size_t>(g_hist_pos)];
        g_caret = g_input.size();
        return true;
    case VK_TAB: g_eat_char = true; complete_input(); return true;
    case VK_PRIOR: g_scroll = (std::min)(g_scroll + 4, (std::max)(0, static_cast<int>(g_out.size()) - 1)); return true;
    case VK_NEXT: g_scroll = (std::max)(0, g_scroll - 4); return true;
    default:
        if (ctrl && vk == 'V') { g_eat_char = true; paste(); }
        return true;   // the character (if any) arrives as WM_CHAR
    }
}

void on_char(WPARAM ch) {
    if (g_eat_char) { g_eat_char = false; return; }
    const unsigned c = static_cast<unsigned>(ch);
    if (c < 0x20 || c == 0x7F || c > 0xFF) return;
    if (g_input.size() >= 120) return;
    g_input.insert(g_caret, 1, static_cast<char>(c));
    ++g_caret;
}

// ------------------------------------------------------------ FOV --
// MEASURED (l12a, 12:09:04): on a server, `seta cg_fov "100"` from our console answered
// "cg_fov is cheat protected." -- cg_fov carries DVAR_CHEAT (flags 0x80, IW3's
// Dvar_SetVariant refuses an EXTERNAL set of a cheat dvar while sv_cheats is 0), so neither
// this console nor the Settings tab's FOV row could change it mid-game; only the launcher's
// command line (before the connect) ever did. B asked for FOV here, and the records rules
// allow any FOV up to 120 (verified-rules.md §2.2; T4M and Plutonium unlock cg_fov the same
// way). So cg_fov's cheat bit is cleared -- cg_fov only, never cg_fovScale -- and, because a
// hand-edited bind could now set it too, anything above 120 is put back to 120.
constexpr uintptr_t kCbufAddText = 0x594200;
constexpr uint8_t kCbufSig[] = {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02};
constexpr float kFovCap = 120.f;
uint8_t* g_fov = nullptr;
bool g_fov_logged = false;
int g_cbuf_ok = -1;
DWORD g_fov_fix_t = 0;
long g_fov_fixes = 0;

void cbuf(const char* text) {
    const uintptr_t fn = kCbufAddText;
    __asm {
        mov eax, text
        xor ecx, ecx
        mov edx, fn
        call edx
    }
}

// 0 nothing, 1 unlocked now, 2 over the cap. SEH only: no C++ objects in here.
int fov_probe(uint16_t* flags_before, uint8_t* type, float* value) {
    __try {
        *flags_before = *reinterpret_cast<volatile uint16_t*>(g_fov + 8);
        *type = *reinterpret_cast<volatile uint8_t*>(g_fov + 0xA);
        *value = *type == 1 ? *reinterpret_cast<volatile float*>(g_fov + 0x10) : 0.f;
        int r = 0;
        if (*flags_before & 0x80) {
            *reinterpret_cast<volatile uint16_t*>(g_fov + 8) = static_cast<uint16_t>(*flags_before & ~0x80);
            r = 1;
        }
        if (*type == 1 && *value > kFovCap + 0.01f) r |= 2;
        return r;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}

void fov_tick() {
    if (!g_fov) {
        g_fov = reinterpret_cast<uint8_t*>(game::find_dvar("cg_fov"));
        if (!g_fov) return;
    }
    uint16_t fl = 0;
    uint8_t ty = 0;
    float v = 0;
    const int r = fov_probe(&fl, &ty, &v);
    if (!g_fov_logged) {
        g_fov_logged = true;
        ENW_INFO("console: cg_fov flags 0x%X type %u value %.1f%s", fl, ty, v,
                 (r & 1) ? " -- DVAR_CHEAT (0x80) cleared, so the ENW console and Esc > Settings can change it mid-game "
                           "(capped at 120)" : "");
    } else if (r & 1) {
        ENW_INFO("console: cg_fov was cheat-protected again (flags 0x%X); cleared", fl);
    }
    if (g_cbuf_ok < 0) {
        uint8_t got[sizeof kCbufSig] = {};
        g_cbuf_ok = memory::read_raw(kCbufAddText, got, sizeof got) && std::memcmp(got, kCbufSig, sizeof got) == 0;
    }
    if ((r & 2) && ::GetTickCount() - g_fov_fix_t > 500) {
        if (g_cbuf_ok == 1) {
            g_fov_fix_t = ::GetTickCount();
            cbuf("set cg_fov 120\n");
            if (++g_fov_fixes <= 5)
                ENW_WARN("console: cg_fov was %.1f, above the records cap of 120 -- set back to 120", v);
        }
    }
}

// ------------------------------------------------------------ the catcher --
void tick(uint64_t) {
    fov_tick();
    if (g_open && ::GetTickCount() - g_last_draw > 1000) close_console("no map drawn for 1 s");
    if (!g_locked) return;
    __try {
        const int kc = rd<int>(kKeyCatchers);
        if (kc & 1) {
            *reinterpret_cast<volatile int*>(kKeyCatchers) = kc & ~1;
            ++g_catcher_closed;
            if (g_catcher_closed <= 5 || g_catcher_closed % 50 == 0)
                ENW_WARN("console: World at War's console was opened (keyCatchers 0x%X) -- closed it the same frame "
                         "(#%ld). The ENW console is the key under Esc.", kc, g_catcher_closed);
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

// ------------------------------------------------------------- selftest --
void post(UINT msg, WPARAM wp, LPARAM lp) { if (HWND h = input_gate::window()) ::PostMessageA(h, msg, wp, lp); }
LPARAM key_lp(UINT sc, bool up) { return 1 | (static_cast<LPARAM>(sc) << 16) | (up ? (3u << 30) : 0); }
void post_key(WPARAM vk, UINT sc) { post(WM_KEYDOWN, vk, key_lp(sc, false)); post(WM_KEYUP, vk, key_lp(sc, true)); }
// Key down/up only: the game's own TranslateMessage makes the WM_CHAR from the posted key down
// (l12a: posting a WM_CHAR as well typed a stray ' into the line).
void post_console_key() { post(WM_KEYDOWN, VK_OEM_3, key_lp(kConsoleScan, false)); post(WM_KEYUP, VK_OEM_3, key_lp(kConsoleScan, true)); }
void post_line(const char* s) {
    for (const char* p = s; *p; ++p) post(WM_CHAR, static_cast<unsigned char>(*p), 1);
    post(WM_KEYDOWN, VK_RETURN, key_lp(0x1C, false));
    post(WM_CHAR, '\r', key_lp(0x1C, false));
    post(WM_KEYUP, VK_RETURN, key_lp(0x1C, true));
}

// [RS] Proof hook (esc-menu.md §12): ENW_CONSOLE_RESTART_FILE=<path>. When the file appears
// it is deleted, and the console is opened and `restart` typed into it as a player would --
// N times, 400 ms apart, when the file says N (restart spam). The harness drops the file at
// the moment it wants (live, while downed, during the end_game sequence). Test runs only.
std::string g_rf_path;
DWORD g_rf_next = 0;
int g_rf_left = 0;
bool g_rf_key_sent = false;
DWORD g_rf_poll = 0;

void restart_file_tick() {
    if (g_rf_path.empty()) return;
    const DWORD now = ::GetTickCount();
    if (g_rf_left > 0) {
        if (now < g_rf_next) return;
        if (!g_rf_key_sent) {
            if (!g_open) post_console_key();
            g_rf_key_sent = true;
            g_rf_next = now + 200;
            return;
        }
        ENW_INFO("console: RESTART FILE: typing `restart` (%d left)", g_rf_left - 1);
        post_line("restart");
        g_rf_key_sent = false;
        g_rf_next = now + 400;
        --g_rf_left;
        return;
    }
    if (now - g_rf_poll < 100) return;
    g_rf_poll = now;
    FILE* f = nullptr;
    if (fopen_s(&f, g_rf_path.c_str(), "rb") != 0 || !f) return;
    char buf[16] = {};
    fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    ::DeleteFileA(g_rf_path.c_str());
    g_rf_left = std::max(1, std::min(10, std::atoi(buf)));
    g_rf_next = now;
    g_rf_key_sent = false;
    ENW_INFO("console: RESTART FILE seen: %d `restart` line(s) to type", g_rf_left);
}

void selftest_tick() {
    if (!g_selftest || !g_first_map) return;
    const DWORD t = ::GetTickCount() - g_first_map;
    struct st { DWORD at; int step; };
    static const st kPlan[] = {{8000, 1}, {9000, 2}, {9600, 3}, {10200, 4}, {10800, 5}, {11400, 6}, {12000, 7},
                               {12600, 8}, {13200, 9}, {14500, 10}, {15500, 11}, {16500, 12}, {18500, 13}, {19500, 14},
                               {13800, 15}, {17500, 16},
                               // [C1] reopen; aliases, a bind, a filter, a capture; =2: `/quit` for real
                               {20000, 19}, {20600, 17}, {21200, 18}, {21800, 20}, {22400, 21}, {23500, 22}};
    for (const auto& p : kPlan) {
        if ((g_st_done & (1u << p.step)) || t < p.at) continue;
        g_st_done |= 1u << p.step;
        ENW_INFO("console: SELFTEST step %d at +%lu ms", p.step, t);
        switch (p.step) {
        case 1: post_console_key(); break;                     // the key under Esc -> ours opens
        case 2: post_line("sensitivity 7"); break;
        case 3: post_line("cg_fov 100"); break;
        case 4: post_line("fov 130"); break;                   // out of range
        case 5: post_line("sv_cheats 1"); break;               // forbidden
        case 6: post_line("developer 1"); break;               // forbidden
        case 7: post_line("shadows off"); break;               // [C1] an alias; editable in a Verified game now
        case 8: post_line("cg_fov 90; sv_cheats 1"); break;    // chaining
        case 9: post_line("cg_fov"); break;
        case 15: post_line("com_maxfps 125"); break;          // Verified: not a console setting in a Verified game
        case 16:                                               // a hand-edited bind: the FOV cap must hold
            if (g_cbuf_ok == 1) { ENW_INFO("console: SELFTEST: `set cg_fov 150` straight into the command buffer"); cbuf("set cg_fov 150\n"); }
            break;
        case 19: post_console_key(); break;
        case 17: post_line("aa 4"); break;                     // vid_restart item: "-- apply"
        case 18: post_line("bind mouse4 use"); break;
        case 20: post_line("list sh"); break;
        case 21: frame_capture::request("console-c1"); break;
        case 22:
            if (g_selftest >= 2) { ENW_INFO("console: SELFTEST: /quit for real (=2)"); post_line("/quit"); }
            break;
        case 10: frame_capture::request("console-open"); break;
        case 11: post_key(VK_ESCAPE, 0x01); break;             // closes ours
        case 12:
            // Past our filter, straight to the engine's WndProc: World at War's own console
            // key. The engine opens its console; the catcher must close it the same frame.
            ENW_INFO("console: SELFTEST: sending the console key straight to the ENGINE (bypassing the filter); "
                     "keyCatchers before 0x%X", rd<int>(kKeyCatchers));
            input_gate::send_to_engine(WM_KEYDOWN, VK_OEM_3, key_lp(kConsoleScan, false));
            input_gate::send_to_engine(WM_KEYUP, VK_OEM_3, key_lp(kConsoleScan, true));
            break;
        case 13: frame_capture::request("console-after-engine-key"); break;
        case 14:
            ENW_INFO("console: SELFTEST done: %ld open(s), %ld command(s), %ld console key(s) kept from the engine, "
                     "%ld stock-console open(s) closed; fov now '%s', sensitivity '%s'; keyCatchers 0x%X",
                     g_opens, g_commands, g_key_eaten, g_catcher_closed, settings_tab::value_of("fov").c_str(),
                     settings_tab::value_of("sensitivity").c_str(), rd<int>(kKeyCatchers));
            break;
        default: break;
        }
    }
}

}  // namespace

// ------------------------------------------------------------------ public
void init(const settings_tab::draw_api& api) {
    g_api = api;
    g_inited = true;
}

bool is_open() { return g_open; }

bool filter(UINT msg, WPARAM wp, LPARAM lp, LRESULT* result, bool can_open) {
    if (!g_locked || !g_inited) return false;
    *result = 0;
    const bool ckey = (msg == WM_KEYDOWN || msg == WM_KEYUP || msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP) && is_console_key(lp);
    if (!g_open) {
        if (ckey) {
            ++g_key_eaten;
            if (msg == WM_KEYDOWN && !(lp & (1 << 30))) {
                g_eat_char = true;
                if (can_open) open_console("console key");
                else ENW_INFO("console: the console key was kept from the engine (not in a map, or a menu/chat is open)");
            }
            return true;
        }
        if (msg == WM_KEYDOWN) g_eat_char = false;   // a new key: the char we were waiting for never came
        if (msg == WM_CHAR && g_eat_char) { g_eat_char = false; return true; }
        return false;
    }
    switch (msg) {
    case WM_KEYDOWN: return key_down(wp, lp);
    case WM_CHAR: on_char(wp); return true;
    case WM_KEYUP: return ckey;   // other key-ups reach the engine: a key released while typing is released
    default: return false;        // the mouse is the game's
    }
}

void draw(float vw) {
    const DWORD now = ::GetTickCount();
    g_last_draw = now;
    if (g_selftest && !g_first_map) g_first_map = now;
    if (!g_open || !g_api.txt) return;
    static const float bg[4] = {0.f, 0.f, 0.f, 0.82f};
    static const float edge[4] = {0.93f, 0.82f, 0.45f, 0.9f};
    static const float white[4] = {1, 1, 1, 1};
    static const float dim[4] = {0.62f, 0.62f, 0.62f, 1};
    const float h = 150.f, lh = 12.f, sc = 0.22f;
    g_api.box(0, 0, vw, h, bg);
    g_api.box(0, h, vw, 1.f, edge);
    const std::string title = "ENW console";
    g_api.txt(vw - g_api.tw(title, 0.2f) - 8.f, 11.f, title, dim, 0.2f);
    // output, newest at the bottom, above the input line
    const int rows = 9;
    int idx = static_cast<int>(g_out.size()) - 1 - g_scroll;
    for (int r = 0; r < rows && idx >= 0; ++r, --idx) {
        const float y = h - 24.f - lh * static_cast<float>(r);
        g_api.txt(8.f, y, g_out[static_cast<size_t>(idx)], white, sc);
    }
    if (g_scroll > 0) g_api.txt(vw - 20.f, h - 26.f, "^3v", white, sc);
    // input
    const float iy = h - 6.f;
    const std::string prompt = "^3>^7 ";
    g_api.txt(8.f, iy, prompt + g_input, white, sc);
    if (((now - g_blink) / 500) % 2 == 0) {
        const float cx = 8.f + g_api.tw(prompt, sc) + g_api.tw(g_input.substr(0, g_caret), sc);
        g_api.box(cx, iy - 9.f, 1.f, 10.f, white);
    }
}

// ---------------------------------------------------------------- component
namespace {

class console_lock final : public component {
public:
    const char* name() const override { return "console_lock"; }
    bool is_supported() override {
        const char* cmd = ::GetCommandLineA();
        return !(cmd && std::strstr(cmd, "dedicated 1"));
    }
    void post_unpack() override {
        const char* e = std::getenv("ENW_STOCK_CONSOLE");
        if (e && e[0] == '1') {
            g_locked = false;
            ENW_WARN("console: ENW_STOCK_CONSOLE=1 -- World at War's console is NOT locked (developer switch)");
            return;
        }
        if (const char* st = std::getenv("ENW_CONSOLE_SELFTEST"); st && st[0] && st[0] != '0') g_selftest = std::atoi(st);
        if (const char* rf = std::getenv("ENW_CONSOLE_RESTART_FILE"); rf && rf[0]) {   // [RS]
            g_rf_path = rf;
            ENW_INFO("console: RESTART FILE armed: %s", rf);
        }
        ENW_INFO("console: World at War's console is locked (the key under Esc never reaches the engine; keyCatchers "
                 "0x1 is closed the frame it is set). The ENW console takes the key in a map.%s",
                 g_selftest ? " SELFTEST." : "");
    }
    void post_init() override {
        frame::subscribe("console_lock", [](uint64_t n) {
            tick(n);
            selftest_tick();
            restart_file_tick();   // [RS]
        });
    }
    void pre_destroy() override {
        if (g_opens || g_key_eaten || g_catcher_closed)
            ENW_INFO("console: session: ours opened %ld time(s), %ld command(s); %ld console key(s) kept from the "
                     "engine; the stock console was closed %ld time(s)", g_opens, g_commands, g_key_eaten, g_catcher_closed);
    }
};

ENW_REGISTER_COMPONENT(console_lock)

}  // namespace
}  // namespace restricted_console
}  // namespace enw::client
