// The Settings tab of the ENW Esc menu. esc-menu.md §9 is the design and the proof.
//
// B, 2026-09-23: the Esc menu needs a SETTINGS tab carrying every setting the ENW client
// offers plus World at War's own video / audio / control settings, all through our menu,
// and it must sync perfectly.
//
// ============================================================================
// ONE LIST
// ============================================================================
// What is drawn is shared/settings/ingame-settings.json, embedded at build time
// (CMakeLists.txt) and generated from the site's own catalogue
// (web/client/src/data/wawSettings.js, whose INGAME table says what the game may do with
// each item) and its layout (settingsLayout.js): the same tabs, groups, names and values
// as /settings. The model (settings_model.hpp) is pure and unit-tested.
//
// ============================================================================
// THE SYNC PATH -- no new channel
// ============================================================================
//   1. A change is the engine's own console command, `seta <dvar> "<v>"` (or `bind`),
//      through Cbuf_AddText 0x594200: applied on the next frame exactly as the stock menu
//      or the console would apply it.
//   2. WRITE-THROUGH, BY THE ENGINE ITSELF: Com_Frame (0x59DCF0) calls
//      Com_WriteConfiguration (0x59D8F0) at the top of every frame; when
//      dvar_modifiedFlags (0x21ACF30) has the archive bit it rewrites
//      players\profiles\<profile>\config.cfg under the redirected LocalAppData
//      (enw_localappdata.cpp) -- the profile players\active.txt names. `seta` archives.
//      A bind sets no dvar, so the archive bit is raised by hand two frames later
//      (after the bind has executed). A crash a second later loses nothing. This file
//      re-reads config.cfg after every change and logs when the line landed.
//   3. The launcher's existing round trip (client.md §8, launcher/src/main/wawcfg.js
//      readBackAccount) reads that file after the game exits -- crash or quit -- and saves
//      the difference to the account, which /settings shows. A read-back the launcher
//      missed is caught up at the next launch (launch.js) before the account is merged
//      into the config again.
//
// ============================================================================
// WHAT IS NEVER TOUCHED
// ============================================================================
// Mod-owned dvars (monkeytoy, con_external, sv_cheats), developer, cheats and gameplay
// dvars: refused by settings::forbidden_dvar whatever the schema says. A dvar the running
// map sets itself (its .enw-installed.json modDvars.owned, launcher modcompat.js) is shown
// read-only. In a Verified game (the invite token is present) every item is shown and only
// the records rule's own (com_maxfps, catalogue `verified: false`) is locked (§11.3).
//
// ============================================================================
// VIDEO SETTINGS THAT NEED vid_restart
// ============================================================================
// As WaW's own Graphics menu: the value is set (the engine latches it; dvar_s + 0x20) and
// an Apply button runs `vid_restart`. The engine refuses it while a listen server runs
// (CL_Vid_Restart_f 0x6420F0: "Listen server cannot video restart."), so in Play Local the
// latched value applies at the next launch. A restart destroys the window and the D3D
// device: mouse_polling re-subclasses the new window (the input gate), stock_font finds
// its font again on the new device, frame_capture follows the swap chain's own device,
// and the menu stays open (pause_menu does not close it while a restart is in progress),
// so the game stays paused through it and the menu is back when the picture is.
#include "game.hpp"
#include "json.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "console_model.hpp"   // [console] the ENW console sets settings through this tab's path
#include "input_gate.hpp"
#include "settings_model.hpp"
#include "settings_tab.hpp"

#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace enw::auth { const std::string& token(); }   // auth_token.cpp
namespace enw::client::stock_font { void before_vid_restart(); }

namespace enw::client::settings_tab {
namespace {

const unsigned char kSchemaBytes[] = {
#include "enw_settings_schema.inc"
    0};

constexpr uintptr_t kCbufAddText = 0x594200;       // EAX text, ECX local client (byte-checked by the overlay)
constexpr uintptr_t kValueToString = 0x5ECAB0;     // Dvar_ValueToString: ECX dvar, 16-byte DvarValue by value
constexpr uint8_t kVtsSig[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xC0, 0x0F, 0xB6, 0x41, 0x0A, 0x83, 0xF8, 0x08};
constexpr uintptr_t kDvarModifiedFlags = 0x21ACF30;
constexpr uintptr_t kDvarSvRunning = 0x1F552DC;    // dvar_s* sv_running (CL_Vid_Restart_f's check)
constexpr uintptr_t kDvarProfile = 0x1F55284;      // dvar_s* whose string Com_WriteConfiguration writes under
constexpr uintptr_t kDvarFsGame = 0x2122B00;       // dvar_s* fs_game (addresses.hpp)
constexpr uintptr_t kDxDevice = 0x3BF3B08;
constexpr uintptr_t kGameHwnd = 0x22C1BE4;
constexpr size_t kCurrent = 0x10, kLatched = 0x20;

draw_api g_api{};
settings::schema g_s;
bool g_ok = false;
bool g_vts_ok = false;
size_t g_tab = 0;
float g_scroll[16] = {};
std::vector<std::pair<std::string, std::string>> g_binds;
bool g_binds_loaded = false;   // [C1] the console binds without the tab ever having been shown
bool g_restart_console = false;   // [C1] the running vid_restart came from the console's `apply`
settings::context g_ctx;
int g_restricted_override = -1;
std::string g_capture_id;
std::string g_drag_id;
std::string g_drag_value;
float g_drag_x = 0, g_drag_w = 1;
struct hit { float x, y, w, h; std::string id; int part; };   // part: 0 control, 1 prev, 2 next, 3 slider, 4 bind, 5 tab, 6 apply
std::vector<hit> g_hits;
float g_px = 0, g_py = 0, g_pw = 0, g_ph = 0;
std::string g_status;
DWORD g_status_t = 0;
std::string g_hover_note;
struct check { std::string id, dvar, want, key, cmd; DWORD t0; bool engine_logged; };
std::vector<check> g_checks;
DWORD g_last_check = 0;
int g_bind_flush = 0;
std::vector<std::string> g_pending;   // ids changed that wait for Apply
bool g_restart = false;
DWORD g_restart_t = 0;
bool g_restart_gap = false;
uint32_t g_restart_dev = 0, g_restart_hwnd = 0;
DWORD g_last_draw = 0;
long g_changes = 0;

template <typename T>
T rd(uintptr_t a) { return *reinterpret_cast<volatile T*>(a); }

uintptr_t g_vts_fn = kValueToString;   // a variable: the naked thunk loads it from memory

void cbuf(const char* text) {
    const uintptr_t fn = kCbufAddText;
    __asm {
        mov eax, text
        xor ecx, ecx
        mov edx, fn
        call edx
    }
}

__declspec(naked) const char* __cdecl vts(const void* /*dvar*/, const void* /*value16*/) {
    __asm {
        push esi
        mov esi, [esp + 0x0C]
        mov ecx, [esp + 0x08]
        sub esp, 0x10
        mov eax, [esi]
        mov [esp], eax
        mov eax, [esi + 4]
        mov [esp + 4], eax
        mov eax, [esi + 8]
        mov [esp + 8], eax
        mov eax, [esi + 0x0C]
        mov [esp + 0x0C], eax
        mov eax, g_vts_fn
        call eax
        add esp, 0x10
        pop esi
        ret
    }
}

const char* vts_seh(const void* d, size_t off) {
    __try {
        return vts(d, static_cast<const char*>(d) + off);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
}

struct dval { bool found = false; std::string cur, lat; };

dval read_dvar(const std::string& name) {
    dval v;
    if (name.empty() || !g_vts_ok) return v;
    const void* d = game::find_dvar(name.c_str());
    if (!d) return v;
    const char* c = vts_seh(d, kCurrent);
    const char* l = vts_seh(d, kLatched);
    if (!c) return v;
    v.found = true;
    v.cur = c;
    v.lat = l ? l : c;
    return v;
}

bool copy_dvar_string(uintptr_t ptr_addr, char* buf, int n) {
    __try {
        const uintptr_t d = rd<uintptr_t>(ptr_addr);
        if (!d) return false;
        const char* s = rd<const char*>(d + kCurrent);
        if (!s) return false;
        int i = 0;
        for (; i < n - 1 && s[i]; ++i) buf[i] = s[i];
        buf[i] = 0;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

std::string dvar_string_at(uintptr_t ptr_addr) {
    char buf[128] = {};
    return copy_dvar_string(ptr_addr, buf, sizeof buf) ? std::string(buf) : std::string();
}

void raise_archive_flag() {
    __try {
        *reinterpret_cast<volatile uint8_t*>(kDvarModifiedFlags) |= 1;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

bool dvar_bool_at(uintptr_t ptr_addr) {
    __try {
        const uintptr_t d = rd<uintptr_t>(ptr_addr);
        return d && rd<unsigned char>(d + kCurrent) != 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

std::string env(const char* k) { const char* v = std::getenv(k); return v ? v : ""; }

std::string read_file(const std::string& path, size_t cap = 1u << 20) {
    HANDLE f = ::CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             nullptr, OPEN_EXISTING, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return {};
    std::string out;
    char buf[8192];
    DWORD got = 0;
    while (out.size() < cap && ::ReadFile(f, buf, sizeof buf, &got, nullptr) && got) out.append(buf, got);
    ::CloseHandle(f);
    return out;
}

// <redirected LocalAppData>\Activision\CoDWaW -- the folder the engine's profile lives in
// (enw_localappdata.cpp hands the engine ENW_LOCALAPPDATA). Read only, never written here.
std::string engine_root() {
    std::string base = env("ENW_LOCALAPPDATA");
    if (base.empty()) base = env("LOCALAPPDATA");
    return base.empty() ? std::string() : base + "\\Activision\\CoDWaW";
}

std::string profile_name() {
    std::string p = dvar_string_at(kDvarProfile);
    if (p.empty() || p.find_first_of("\\/:") != std::string::npos) {
        p = read_file(engine_root() + "\\players\\profiles\\active.txt", 256);
        while (!p.empty() && (p.back() == '\r' || p.back() == '\n' || p.back() == ' ')) p.pop_back();
    }
    return p;
}

std::string config_path() {
    const std::string root = engine_root(), prof = profile_name();
    if (root.empty() || prof.empty()) return {};
    return root + "\\players\\profiles\\" + prof + "\\config.cfg";
}

// The dvars the running map sets itself (the launcher caches them in the map folder's
// .enw-installed.json, launcher/src/main/modcompat.js): shown read-only here.
std::vector<std::string> mod_owned() {
    std::vector<std::string> out;
    std::string fg = dvar_string_at(kDvarFsGame);
    if (fg.rfind("mods/", 0) != 0 && fg.rfind("mods\\", 0) != 0) return out;
    const std::string name = fg.substr(5);
    if (name.empty() || name.find_first_of("\\/:") != std::string::npos) return out;
    const dval home = read_dvar("fs_homepath");
    const std::string dirs[] = {engine_root().empty() ? std::string() : engine_root() + "\\mods\\" + name,
                                home.found && !home.cur.empty() ? home.cur + "\\mods\\" + name : std::string()};
    for (const std::string& dir : dirs) {
        if (dir.empty()) continue;
        const std::string text = read_file(dir + "\\.enw-installed.json");
        json::value v;
        if (text.empty() || !json::parse(text, &v)) continue;
        const json::value* md = v.find("modDvars");
        const json::value* owned = md ? md->find("owned") : nullptr;
        if (owned && owned->type == json::kind::array)
            for (const auto& e : owned->items) out.push_back(settings::lower(e.s));
        break;
    }
    return out;
}

void set_status(const std::string& s) { g_status = s; g_status_t = ::GetTickCount(); }

bool window_is_borderless() {
    HWND h = input_gate::window();
    if (!h) return false;
    const LONG st = ::GetWindowLongA(h, GWL_STYLE);
    const dval fs = read_dvar("r_fullscreen");
    return !(fs.found && fs.cur == "1") && !(st & WS_CAPTION);
}

void refresh_context() {
    g_ctx.restricted = g_restricted_override >= 0 ? g_restricted_override == 1
                     : (!auth::token().empty() || env("ENW_SETTINGS_RESTRICTED") == "1");
    g_ctx.listen_server = dvar_bool_at(kDvarSvRunning);
    g_ctx.borderless = window_is_borderless();
    g_ctx.mod_owned = mod_owned();
}

void load_binds() {
    const std::string path = config_path();
    g_binds = settings::parse_binds(read_file(path));
    g_binds_loaded = true;
    ENW_INFO("settings: %zu binds read from %s", g_binds.size(), path.empty() ? "(no profile path)" : path.c_str());
}

// The value a row shows / starts from.
std::string current_of(const settings::item& it, bool* pending = nullptr) {
    if (pending) *pending = false;
    if (it.k == settings::kind::bind) {
        const auto keys = settings::keys_of(g_binds, it.command);
        std::string o;
        for (const auto& k : keys) o += (o.empty() ? "" : ", ") + k;
        return o.empty() ? "unbound" : o;
    }
    if (it.id == "mode") {
        const dval fs = read_dvar("r_fullscreen");
        if (fs.found && fs.cur == "1") return "fullscreen";
        return window_is_borderless() ? "borderless" : "windowed";
    }
    if (it.id == "display") {
        const dval m = read_dvar("r_monitor");
        return m.found ? (m.cur == "0" ? "primary" : "monitor " + m.cur) : "primary";
    }
    const dval v = read_dvar(it.dvar);
    if (!v.found) {
        if (it.id == "rawMouse") return env("ENW_RAW_MOUSE") == "0" ? "0" : "1";
        return it.enw_def.empty() ? it.def : it.enw_def;
    }
    if (!settings::same_value(v.cur, v.lat)) {
        if (pending) *pending = true;
        return v.lat;   // what it will be after Apply (and what config.cfg carries)
    }
    return v.cur;
}

const char* apply_name(settings::apply a) {
    switch (a) {
    case settings::apply::live: return "live";
    case settings::apply::vid_restart: return "vid_restart";
    case settings::apply::next_launch: return "next launch";
    default: return "site";
    }
}

bool apply_value(const settings::item& it, const std::string& value, const char* how) {
    std::string why;
    const auto vis = settings::visibility(it, g_ctx, &why);
    if (vis != settings::shown::editable) {
        set_status("^1" + it.label + ": " + why);
        ENW_INFO("settings: REFUSED %s -> '%s' (%s)", it.id.c_str(), value.c_str(), why.c_str());
        return false;
    }
    const auto cmds = settings::set_commands(it, value);
    if (cmds.empty()) return false;
    const std::string old = current_of(it);
    std::string joined;
    for (const auto& c : cmds) {
        cbuf((c + "\n").c_str());
        joined += (joined.empty() ? "" : "; ") + c;
    }
    ++g_changes;
    ENW_INFO("settings: %s (%s) '%s' -> '%s' [%s] via %s: %s", it.id.c_str(), it.dvar.c_str(), old.c_str(),
             value.c_str(), apply_name(it.a), how, joined.c_str());
    g_checks.push_back({it.id, it.dvar, value, "", "", ::GetTickCount(), false});
    const std::string shown = settings::display_value(it, value);
    if (it.a == settings::apply::vid_restart) {
        if (g_ctx.listen_server) {
            set_status(it.label + ": " + shown + " -- applies next launch (a local game cannot restart the video)");
        } else {
            if (std::find(g_pending.begin(), g_pending.end(), it.id) == g_pending.end()) g_pending.push_back(it.id);
            set_status(it.label + ": " + shown + " -- press Apply to restart the video");
        }
    } else if (it.a == settings::apply::next_launch) {
        set_status(it.label + ": " + shown + " -- applies next launch");
    } else {
        set_status(it.label + ": " + shown);
    }
    return true;
}

bool apply_bind(const settings::item& it, const std::string& key, const char* how) {
    std::string why;
    if (settings::visibility(it, g_ctx, &why) != settings::shown::editable) return false;
    const auto before = current_of(it);
    const auto cmds = settings::bind_commands(&g_binds, it.command, key);
    std::string joined;
    for (const auto& c : cmds) {
        cbuf((c + "\n").c_str());
        joined += (joined.empty() ? "" : "; ") + c;
    }
    ++g_changes;
    g_bind_flush = 2;   // raise the archive bit after the bind has run, so config.cfg is rewritten
    ENW_INFO("settings: bind %s '%s' -> '%s' via %s: %s", it.command.c_str(), before.c_str(), current_of(it).c_str(),
             how, joined.empty() ? "(nothing to do)" : joined.c_str());
    if (!key.empty()) g_checks.push_back({it.id, "", "", key, it.command, ::GetTickCount(), true});
    set_status(it.label + ": " + current_of(it));
    return true;
}

const settings::item* item_by_id(const std::string& id) { return g_s.find(id); }

// ------------------------------------------------------------------ drawing
const float kWhite[4] = {1, 1, 1, 1};
const float kDim[4] = {0.75f, 0.75f, 0.75f, 1};
const float kFaint[4] = {0.55f, 0.55f, 0.55f, 1};
const float kGold[4] = {0.93f, 0.82f, 0.45f, 1};
const float kGoldFill[4] = {0.93f, 0.82f, 0.45f, 0.22f};
const float kPanel[4] = {0, 0, 0, 0.62f};
const float kStrip[4] = {0.18f, 0.18f, 0.18f, 0.85f};
const float kHover[4] = {1, 1, 1, 0.10f};
const float kTrack[4] = {1, 1, 1, 0.25f};

void txt(float x, float y, const std::string& s, const float* c, float sc) { if (g_api.txt) g_api.txt(x, y, s, c, sc); }
float tw(const std::string& s, float sc) { return g_api.tw ? g_api.tw(s, sc) : 0.f; }
void box(float x, float y, float w, float h, const float* c) { if (g_api.box) g_api.box(x, y, w, h, c); }
bool in(float px, float py, float x, float y, float w, float h) { return px >= x && px < x + w && py >= y && py < y + h; }

// Text that fits: cut with "..." to width.
std::string fit(const std::string& s, float width, float sc) {
    if (tw(s, sc) <= width) return s;
    std::string o = s;
    while (!o.empty() && tw(o + "...", sc) > width) o.pop_back();
    return o + "...";
}

struct row { int kind; size_t index; std::string label; };   // kind 0 heading, 1 item

std::vector<row> rows_for_tab() {
    std::vector<row> out;
    if (g_tab >= g_s.tabs.size()) return out;
    const std::string& t = g_s.tabs[g_tab].id;
    for (const auto& g : g_s.groups) {
        if (g.tab != t) continue;
        std::vector<row> items;
        for (size_t idx : g.items)
            if (settings::visibility(g_s.items[idx], g_ctx, nullptr) != settings::shown::hidden)
                items.push_back({1, idx, {}});
        if (items.empty()) continue;
        out.push_back({0, 0, g.label});
        out.insert(out.end(), items.begin(), items.end());
    }
    return out;
}

void draw_row(const settings::item& it, float x, float y, float w, float mx, float my) {
    const float rh = 15.f;
    std::string why;
    const auto vis = settings::visibility(it, g_ctx, &why);
    const bool hover = in(mx, my, x, y, w, rh);
    if (hover) {
        box(x, y, w, rh, kHover);
        g_hover_note = it.hint.empty() ? why : (why.empty() ? it.hint : it.hint + " -- " + why);
    }
    const float cw = (std::min)(132.f, w * 0.45f);
    const float cx = x + w - 6.f - cw;
    txt(x + 8.f, y + 11.f, fit(it.label, cx - x - 14.f, 0.24f), vis == settings::shown::editable ? kWhite : kDim, 0.24f);
    bool pending = false;
    std::string cur = current_of(it, &pending);
    if (g_drag_id == it.id) cur = g_drag_value;
    const std::string shown = settings::display_value(it, cur);

    if (vis == settings::shown::readonly || it.k == settings::kind::info) {
        const std::string s = fit(shown + (why.empty() ? "" : "  (" + why + ")"), cw, 0.22f);
        txt(x + w - 6.f - tw(s, 0.22f), y + 11.f, s, kFaint, 0.22f);
        return;
    }
    const std::string mark = pending || std::find(g_pending.begin(), g_pending.end(), it.id) != g_pending.end() ? "^3*" : "";
    switch (it.k) {
    case settings::kind::toggle: {
        const bool on = settings::index_of_value(it, cur) == 1;
        const bool h = in(mx, my, cx, y + 2.f, cw, 11.f);
        box(cx, y + 2.f, cw, 11.f, h ? kGoldFill : kHover);
        if (on) box(cx, y + 12.f, cw, 1.f, kGold);
        const std::string s = shown + mark;
        txt(cx + (cw - tw(s, 0.22f)) / 2.f, y + 11.f, s, on ? kGold : kDim, 0.22f);
        g_hits.push_back({cx, y + 2.f, cw, 11.f, it.id, 0});
        break;
    }
    case settings::kind::select: {
        const bool hl = in(mx, my, cx, y + 2.f, 14.f, 11.f), hr = in(mx, my, cx + cw - 14.f, y + 2.f, 14.f, 11.f);
        box(cx, y + 2.f, cw, 11.f, kHover);
        if (hl) box(cx, y + 2.f, 14.f, 11.f, kGoldFill);
        if (hr) box(cx + cw - 14.f, y + 2.f, 14.f, 11.f, kGoldFill);
        txt(cx + 4.f, y + 11.f, "<", hl ? kWhite : kDim, 0.22f);
        txt(cx + cw - 10.f, y + 11.f, ">", hr ? kWhite : kDim, 0.22f);
        const std::string s = fit(shown, cw - 30.f, 0.22f) + mark;
        txt(cx + (cw - tw(s, 0.22f)) / 2.f, y + 11.f, s, kWhite, 0.22f);
        g_hits.push_back({cx, y + 2.f, 14.f, 11.f, it.id, 1});
        g_hits.push_back({cx + cw - 14.f, y + 2.f, 14.f, 11.f, it.id, 2});
        g_hits.push_back({cx + 14.f, y + 2.f, cw - 28.f, 11.f, it.id, 2});
        break;
    }
    case settings::kind::slider: {
        const float bw = cw - 36.f;
        const float frac = static_cast<float>(settings::slider_frac(it, cur));
        const bool h = in(mx, my, cx, y + 1.f, bw, 13.f) || g_drag_id == it.id;
        box(cx, y + 7.f, bw, 2.f, kTrack);
        box(cx, y + 7.f, bw * frac, 2.f, kGold);
        box(cx + bw * frac - 1.5f, y + 3.f, 3.f, 10.f, h ? kWhite : kGold);
        const std::string s = shown + mark;
        txt(x + w - 6.f - tw(s, 0.22f), y + 11.f, s, h ? kWhite : kDim, 0.22f);
        g_hits.push_back({cx, y + 1.f, bw, 13.f, it.id, 3});
        break;
    }
    case settings::kind::bind: {
        const bool cap = g_capture_id == it.id;
        const bool h = in(mx, my, cx, y + 2.f, cw, 11.f);
        box(cx, y + 2.f, cw, 11.f, cap ? kGoldFill : h ? kGoldFill : kHover);
        const std::string s = cap ? std::string("^3press a key") : fit(cur, cw - 8.f, 0.22f);
        txt(cx + (cw - tw(s, 0.22f)) / 2.f, y + 11.f, s, cur == "unbound" && !cap ? kFaint : kWhite, 0.22f);
        g_hits.push_back({cx, y + 2.f, cw, 11.f, it.id, 4});
        break;
    }
    default:
        break;
    }
}

}  // namespace

// ------------------------------------------------------------------ public
void init(const draw_api& api) {
    g_api = api;
    uint8_t head[sizeof kVtsSig] = {};
    g_vts_ok = memory::read_raw(enw::at(kValueToString), head, sizeof head) && std::memcmp(head, kVtsSig, sizeof head) == 0;
    if (!g_vts_ok)
        ENW_WARN("settings: 0x%08X is not Dvar_ValueToString on this image; the tab shows defaults, not live values",
                 static_cast<unsigned>(kValueToString));
    std::string err;
    const std::string_view text(reinterpret_cast<const char*>(kSchemaBytes), sizeof kSchemaBytes - 1);
    g_ok = settings::load(text, &g_s, &err);
    if (!g_ok) {
        ENW_ERROR("settings: the embedded schema did not load (%s); the Settings tab is off", err.c_str());
        return;
    }
    size_t verified = 0, restart = 0;
    for (const auto& it : g_s.items) {
        if (it.verified) ++verified;
        if (it.a == settings::apply::vid_restart) ++restart;
    }
    ENW_INFO("settings: schema loaded from the site's catalogue (shared/settings/ingame-settings.json, %zu bytes): "
             "%zu items in %zu groups on %zu tabs, %zu excluded; %zu harmless in a Verified game, %zu need "
             "vid_restart%s%s", text.size(), g_s.items.size(), g_s.groups.size(), g_s.tabs.size(), g_s.excluded, verified,
             restart, err.empty() ? "" : "; ", err.c_str());
}

bool available() { return g_ok; }

void on_show() {
    if (!g_ok) return;
    refresh_context();
    load_binds();
    ENW_INFO("settings: tab shown (restricted=%d listen_server=%d borderless=%d mod_owned=%zu, profile config %s)",
             g_ctx.restricted ? 1 : 0, g_ctx.listen_server ? 1 : 0, g_ctx.borderless ? 1 : 0, g_ctx.mod_owned.size(),
             config_path().c_str());
}

void on_hide() {
    g_capture_id.clear();
    if (!g_drag_id.empty()) {
        if (const auto* it = item_by_id(g_drag_id)) {
            if (!settings::same_value(g_drag_value, current_of(*it))) apply_value(*it, g_drag_value, "slider (menu closed)");
        }
        g_drag_id.clear();
    }
}

void draw(float x, float y, float w, float h, float mx, float my) {
    if (!g_ok) return;
    const DWORD now = ::GetTickCount();
    if (g_restart) {
        if (g_last_draw && now - g_last_draw > 300) g_restart_gap = true;
        const uint32_t dev = rd<uint32_t>(kDxDevice), hw = rd<uint32_t>(kGameHwnd);
        if (g_restart_gap || dev != g_restart_dev || hw != g_restart_hwnd) {
            g_restart = false;
            ENW_INFO("settings: vid_restart DONE: the menu is drawn again %lu ms after Apply (window 0x%08X -> 0x%08X, "
                     "device 0x%08X -> 0x%08X); the input gate is %s", now - g_restart_t, g_restart_hwnd, hw, g_restart_dev,
                     dev, input_gate::installed() ? "installed" : "NOT installed");
            refresh_context();
            set_status("Video restarted");
        }
    }
    g_last_draw = now;
    g_px = x; g_py = y; g_pw = w; g_ph = h;
    g_hits.clear();
    g_hover_note.clear();
    box(x, y, w, h, kPanel);
    box(x, y, w, 18.f, kStrip);

    // Tabs: the site's.
    const size_t nt = g_s.tabs.size();
    const float tw_each = (w - 4.f) / static_cast<float>(nt ? nt : 1);
    for (size_t i = 0; i < nt; ++i) {
        const float tx = x + 2.f + tw_each * static_cast<float>(i);
        const bool active = i == g_tab, hov = in(mx, my, tx, y, tw_each, 18.f);
        if (active) { box(tx, y, tw_each, 18.f, kGoldFill); box(tx, y + 17.f, tw_each, 1.f, kGold); }
        else if (hov) box(tx, y, tw_each, 18.f, kHover);
        const std::string& l = g_s.tabs[i].label;
        txt(tx + (tw_each - tw(l, 0.24f)) / 2.f, y + 13.f, l, active || hov ? kWhite : kDim, 0.24f);
        g_hits.push_back({tx, y, tw_each, 18.f, "tab:" + g_s.tabs[i].id, 5});
    }

    // The list.
    const float top = y + 22.f, foot = 16.f, bottom = y + h - foot - 2.f;
    const auto rows = rows_for_tab();
    float total = 0;
    for (const auto& r : rows) total += r.kind == 0 ? 15.f : 15.f;
    float& sc = g_scroll[g_tab < 16 ? g_tab : 0];
    sc = (std::max)(0.f, (std::min)(sc, (std::max)(0.f, total - (bottom - top))));
    float ry = top - sc;
    for (const auto& r : rows) {
        const float rh = 15.f;
        if (ry >= top - 0.5f && ry + rh <= bottom + 0.5f) {
            if (r.kind == 0) {
                txt(x + 6.f, ry + 11.f, r.label, kGold, 0.22f);
                box(x + 6.f + tw(r.label, 0.22f) + 4.f, ry + 8.f, w - 16.f - tw(r.label, 0.22f), 1.f, kStrip);
            } else {
                draw_row(g_s.items[r.index], x + 2.f, ry, w - 4.f, mx, my);
            }
        }
        ry += rh;
    }
    if (sc > 0.5f) txt(x + w - 12.f, top + 8.f, "^", kDim, 0.22f);
    if (sc + (bottom - top) < total - 0.5f) txt(x + w - 12.f, bottom, "v", kDim, 0.22f);

    // The foot: Apply when a video setting waits for it, else the last thing / a hint.
    const float fy = y + h - foot;
    box(x, fy, w, foot, kStrip);
    float text_w = w - 12.f;
    if (!g_pending.empty() && !g_ctx.listen_server) {   // [C1] Verified games too (esc-menu.md §11.3)
        const std::string l = g_restart ? "Restarting..." : "Apply (restart video)";
        const float bw = tw(l, 0.24f) + 14.f;
        const float bx = x + w - bw - 3.f;
        const bool hov = in(mx, my, bx, fy + 2.f, bw, foot - 4.f);
        box(bx, fy + 2.f, bw, foot - 4.f, hov ? kGoldFill : kHover);
        box(bx, fy + foot - 3.f, bw, 1.f, kGold);
        txt(bx + 7.f, fy + 12.f, l, hov ? kWhite : kGold, 0.24f);
        g_hits.push_back({bx, fy + 2.f, bw, foot - 4.f, "apply", 6});
        text_w = bw > 0 ? w - bw - 14.f : text_w;
    }
    std::string foot_text;
    if (!g_capture_id.empty()) foot_text = "^3Press a key or mouse button.  Esc cancels, Delete clears.";
    else if (!g_hover_note.empty()) foot_text = g_hover_note;
    else if (!g_status.empty() && now - g_status_t < 8000) foot_text = g_status;
    else if (g_ctx.restricted) foot_text = "Verified game: max fps is locked; everything else is yours";
    else foot_text = "Saved as you change them. The site's /settings shows the same.";
    txt(x + 6.f, fy + 12.f, fit(foot_text, text_w, 0.22f), kDim, 0.22f);
}

bool mouse_down(float vx, float vy, int button) {
    if (!g_ok) return false;
    if (!g_capture_id.empty()) {
        static const char* const kMouse[] = {"MOUSE1", "MOUSE2", "MOUSE3", "MOUSE4", "MOUSE5"};
        if (const auto* it = item_by_id(g_capture_id); it && button >= 0 && button < 5) apply_bind(*it, kMouse[button], "capture (mouse)");
        g_capture_id.clear();
        return true;
    }
    if (!in(vx, vy, g_px, g_py, g_pw, g_ph)) return false;
    for (const auto& h : g_hits) {
        if (!in(vx, vy, h.x, h.y, h.w, h.h)) continue;
        if (h.part == 5) {
            for (size_t i = 0; i < g_s.tabs.size(); ++i)
                if ("tab:" + g_s.tabs[i].id == h.id) { g_tab = i; ENW_INFO("settings: tab '%s'", g_s.tabs[i].id.c_str()); }
            return true;
        }
        if (h.part == 6) { if (button == 0) apply_restart(); return true; }
        const auto* it = item_by_id(h.id);
        if (!it) return true;
        const std::string cur = current_of(*it);
        switch (h.part) {
        case 0: apply_value(*it, settings::cycle(*it, cur, button == 1 ? -1 : +1), "click"); break;
        case 1: apply_value(*it, settings::cycle(*it, cur, -1), "click <"); break;
        case 2: apply_value(*it, settings::cycle(*it, cur, button == 1 ? -1 : +1), "click >"); break;
        case 3:
            if (button == 0) {
                g_drag_id = it->id;
                g_drag_x = h.x;
                g_drag_w = h.w;
                g_drag_value = settings::slider_value(*it, (vx - h.x) / (h.w > 0 ? h.w : 1));
            } else {
                apply_value(*it, settings::slider_step(*it, cur, button == 1 ? -1 : +1), "click (step)");
            }
            break;
        case 4:
            if (button == 0) { g_capture_id = it->id; ENW_INFO("settings: waiting for a key for %s", it->command.c_str()); }
            else if (button == 1) apply_bind(*it, "", "right-click (clear)");
            break;
        default: break;
        }
        return true;
    }
    return true;   // inside the panel: never the chat's
}

bool mouse_up(float, float) {
    if (g_drag_id.empty()) return false;
    const auto* it = item_by_id(g_drag_id);
    const std::string v = g_drag_value;
    g_drag_id.clear();
    if (it && !settings::same_value(v, current_of(*it))) apply_value(*it, v, "slider");
    return true;
}

void mouse_move(float vx, float) {
    if (g_drag_id.empty()) return;
    if (const auto* it = item_by_id(g_drag_id)) g_drag_value = settings::slider_value(*it, (vx - g_drag_x) / (g_drag_w > 0 ? g_drag_w : 1));
}

bool wheel(float vx, float vy, int notches) {
    if (!g_ok) return false;
    if (!g_capture_id.empty()) {
        if (const auto* it = item_by_id(g_capture_id)) apply_bind(*it, notches > 0 ? "MWHEELUP" : "MWHEELDOWN", "capture (wheel)");
        g_capture_id.clear();
        return true;
    }
    if (!in(vx, vy, g_px, g_py, g_pw, g_ph)) return false;
    g_scroll[g_tab < 16 ? g_tab : 0] -= 30.f * static_cast<float>(notches);
    return true;
}

bool key_down(WPARAM vk, LPARAM) {
    if (!g_ok) return false;
    if (!g_capture_id.empty()) {
        const auto* it = item_by_id(g_capture_id);
        if (vk == VK_ESCAPE) { set_status("Cancelled"); }
        else if (vk == VK_DELETE || vk == VK_BACK) { if (it) apply_bind(*it, "", "Delete (clear)"); }
        else {
            const std::string name = settings::key_name_for_vk(static_cast<unsigned>(vk));
            if (name.empty()) { set_status("^1That key cannot be bound here"); return true; }
            if (it) apply_bind(*it, name, "capture (key)");
        }
        g_capture_id.clear();
        return true;
    }
    float& sc = g_scroll[g_tab < 16 ? g_tab : 0];
    if (vk == VK_PRIOR || vk == VK_UP) sc -= vk == VK_PRIOR ? 150.f : 15.f;
    else if (vk == VK_NEXT || vk == VK_DOWN) sc += vk == VK_NEXT ? 150.f : 15.f;
    else if (vk == VK_TAB || vk == VK_RIGHT) g_tab = g_s.tabs.empty() ? 0 : (g_tab + 1) % g_s.tabs.size();
    else if (vk == VK_LEFT) g_tab = g_s.tabs.empty() ? 0 : (g_tab + g_s.tabs.size() - 1) % g_s.tabs.size();
    return true;   // the Settings view eats typing: the hidden chat line must not get it
}

bool capturing() { return !g_capture_id.empty(); }

void frame_tick() {
    if (!g_ok) return;
    if (g_bind_flush > 0 && --g_bind_flush == 0) raise_archive_flag();
    const DWORD now = ::GetTickCount();
    // [C1] The console's `apply` restarts the video with the tab not drawn: end the restart
    // here when the device or the window has changed (draw() does the same while it is up).
    // Only a console restart: the menu's own stays open across it until draw() sees it end.
    if (g_restart && g_restart_console && (rd<uint32_t>(kDxDevice) != g_restart_dev || rd<uint32_t>(kGameHwnd) != g_restart_hwnd ||
                                           now - g_restart_t > 30000)) {
        g_restart = false;
        g_restart_console = false;
        ENW_INFO("settings: vid_restart DONE (frame tick) %lu ms after apply; the input gate is %s", now - g_restart_t,
                 input_gate::installed() ? "installed" : "NOT installed");
        refresh_context();
        set_status("Video restarted");
    }
    if (g_checks.empty() || now - g_last_check < 200) return;
    g_last_check = now;
    const std::string path = config_path();
    const std::string text = read_file(path);
    const auto setas = settings::parse_setas(text);
    const auto binds = settings::parse_binds(text);
    for (auto it = g_checks.begin(); it != g_checks.end();) {
        const DWORD age = now - it->t0;
        if (!it->engine_logged && age >= 150 && !it->dvar.empty()) {
            const dval v = read_dvar(it->dvar);
            ENW_INFO("settings: engine: %s is '%s' (latched '%s') %lu ms after the change", it->dvar.c_str(),
                     v.found ? v.cur.c_str() : "?", v.found ? v.lat.c_str() : "?", age);
            it->engine_logged = true;
        }
        bool landed = false;
        if (!it->dvar.empty()) {
            auto f = setas.find(settings::lower(it->dvar));
            landed = f != setas.end() && settings::same_value(f->second, it->want);
        } else {
            for (const auto& [k, c] : binds) if (k == it->key && settings::lower(c) == settings::lower(it->cmd)) landed = true;
        }
        if (landed) {
            if (!it->dvar.empty())
                ENW_INFO("settings: WRITE-THROUGH: %s has seta %s \"%s\" %lu ms after the change", path.c_str(),
                         it->dvar.c_str(), it->want.c_str(), age);
            else
                ENW_INFO("settings: WRITE-THROUGH: %s has bind %s \"%s\" %lu ms after the change", path.c_str(),
                         it->key.c_str(), it->cmd.c_str(), age);
            it = g_checks.erase(it);
            continue;
        }
        if (age > 6000) {
            ENW_WARN("settings: %s %s was NOT in %s 6 s after the change", it->dvar.empty() ? "bind" : it->dvar.c_str(),
                     it->dvar.empty() ? it->key.c_str() : it->want.c_str(), path.c_str());
            it = g_checks.erase(it);
            continue;
        }
        ++it;
    }
}

bool restart_in_progress() { return g_restart && ::GetTickCount() - g_restart_t < 30000; }

bool apply_restart() {
    if (g_pending.empty() || g_ctx.listen_server || g_restart) return false;   // [C1] Verified too
    std::string ids;
    for (const auto& p : g_pending) ids += (ids.empty() ? "" : ", ") + p;
    g_restart_dev = rd<uint32_t>(kDxDevice);
    g_restart_hwnd = rd<uint32_t>(kGameHwnd);
    ENW_INFO("settings: APPLY: vid_restart for %s (window 0x%08X, device 0x%08X); the menu stays open across it",
             ids.c_str(), g_restart_hwnd, g_restart_dev);
    stock_font::before_vid_restart();
    g_restart = true;
    g_restart_console = false;   // [C1] console_apply sets it after this returns
    g_restart_gap = false;
    g_restart_t = ::GetTickCount();
    g_pending.clear();
    cbuf("vid_restart\n");
    set_status("Restarting the video...");
    return true;
}

bool set_by_id(const std::string& id, const std::string& value) {
    const auto* it = item_by_id(id);
    if (!it) return false;
    if (it->k == settings::kind::bind) return apply_bind(*it, value, "selftest");
    return apply_value(*it, value, "selftest");
}

bool show_tab(const std::string& tab_id) {
    for (size_t i = 0; i < g_s.tabs.size(); ++i) if (g_s.tabs[i].id == tab_id) { g_tab = i; return true; }
    return false;
}

bool control_point(const std::string& id, int part, float frac, float* vx, float* vy) {
    for (const auto& h : g_hits) {
        if (h.id != id) continue;
        if (part == 3) {
            if (h.part != 3) continue;
            *vx = h.x + h.w * frac;
            *vy = h.y + h.h / 2;
            return true;
        }
        if ((part == 1 || part == 2) && h.part != part) continue;
        *vx = h.x + h.w / 2;
        *vy = h.y + h.h / 2;
        return true;
    }
    return false;
}

std::string value_of(const std::string& id) {
    const auto* it = item_by_id(id);
    return it ? current_of(*it) : std::string();
}

void log_values(const char* why) {
    if (!g_ok) return;
    std::string o;
    for (const char* id : {"sensitivity", "fov", "r_aspectRatio", "showFps", "ui_mousePitch", "maxFps", "snd_menu_master", "rawMouse", "bind:+activate"}) {
        const auto* it = item_by_id(id);
        if (!it) continue;
        bool pend = false;
        const std::string v = current_of(*it, &pend);
        o += std::string(o.empty() ? "" : ", ") + id + "=" + v + (pend ? " (latched, needs vid_restart)" : "");
    }
    ENW_INFO("settings: values %s: %s", why, o.c_str());
}

void set_restricted_override(int v) {
    g_restricted_override = v;
    refresh_context();
}

// ------------------------------------------------------------ [console] public
// The ENW console's settings and binds (restricted_console.cpp, esc-menu.md §11). Nothing
// here reaches the engine but apply_value / apply_bind above, `unbind <key>` with a key
// from the model's list, and apply_restart: the console has no other way to write. Replies
// are one short line in the console's voice: "fov 90", "aa 4x -- apply", "fps: locked in a
// Verified game".
namespace {

void ensure_binds() {
    if (g_binds_loaded) return;
    load_binds();
    g_binds_loaded = true;
}

const settings::item* console_item(const std::string& name, std::string* reply) {
    if (!g_ok) { *reply = "settings unavailable in this build"; return nullptr; }
    const settings::item* it = ::enw::console::resolve(g_s, name);
    if (!it) { *reply = ::enw::console::refusal_for(name); return nullptr; }
    refresh_context();
    return it;
}

std::string shown_value(const settings::item& it) {
    bool pend = false;
    const std::string cur = current_of(it, &pend);
    std::string o = settings::display_value(it, cur);
    if (o.empty()) o = "\"\"";
    if (pend) o += " (after apply)";
    return o;
}

std::string after_note(const settings::item& it) {
    if (it.a == settings::apply::vid_restart) return g_ctx.listen_server ? " -- next launch" : " -- apply";
    if (it.a == settings::apply::next_launch) return " -- next launch";
    return {};
}

std::string keys_text(const settings::item& it) {
    const auto keys = settings::keys_of(g_binds, it.command);
    std::string o;
    for (const auto& k : keys) o += (o.empty() ? "" : ", ") + k;
    return o.empty() ? "unbound" : o;
}

}  // namespace

const settings::schema* console_schema() { return g_ok ? &g_s : nullptr; }

std::string console_get(const std::string& name) {
    std::string reply;
    const auto* it = console_item(name, &reply);
    if (!it) return reply;
    std::string why;
    const auto vis = settings::visibility(*it, g_ctx, &why);
    const std::string sn = ::enw::console::short_name(*it);
    if (vis != settings::shown::editable && !why.empty()) return sn + " " + shown_value(*it) + "  (" + why + ")";
    return sn + " " + shown_value(*it) + "  (" + ::enw::console::range_text(*it) + ")";
}

std::string console_set(const std::string& name, const std::string& value) {
    std::string reply;
    const auto* it = console_item(name, &reply);
    if (!it) {
        ENW_INFO("console: REFUSED %s '%s': %s", name.c_str(), value.c_str(), reply.c_str());
        return reply;
    }
    const std::string sn = ::enw::console::short_name(*it);
    std::string why;
    if (settings::visibility(*it, g_ctx, &why) != settings::shown::editable) {
        ENW_INFO("console: REFUSED %s '%s': %s", it->dvar.c_str(), value.c_str(), why.c_str());
        return sn + ": " + why;
    }
    std::string v = value;
    if (settings::lower(v) == "default") v = it->enw_def.empty() ? it->def : it->enw_def;
    std::string norm, err;
    if (!::enw::console::validate(*it, v, &norm, &err)) {
        ENW_INFO("console: REFUSED %s '%s': %s", it->dvar.c_str(), value.c_str(), err.c_str());
        return err;
    }
    if (!apply_value(*it, norm, "console")) return sn + ": not set";
    return sn + " " + settings::display_value(*it, norm) + after_note(*it);
}

std::string console_reset(const std::string& name) {
    std::string reply;
    const auto* it = console_item(name, &reply);
    if (!it) return reply;
    const std::string def = it->enw_def.empty() ? it->def : it->enw_def;
    if (def.empty()) return ::enw::console::short_name(*it) + ": no default (the game picks it)";
    return console_set(it->dvar, def);
}

std::vector<std::string> console_help(const std::string& name) {
    std::vector<std::string> out;
    std::string reply;
    const auto* it = console_item(name, &reply);
    if (!it) { out.push_back(reply); return out; }
    std::string why;
    const auto vis = settings::visibility(*it, g_ctx, &why);
    const std::string sn = ::enw::console::short_name(*it);
    std::string l = sn + " -- " + settings::lower(it->label) + ", " + ::enw::console::range_text(*it) + ", now " + shown_value(*it);
    if (it->a == settings::apply::vid_restart) l += ", needs apply";
    if (it->a == settings::apply::next_launch) l += ", next launch";
    if (vis != settings::shown::editable && !why.empty()) l += " (" + why + ")";
    out.push_back(l);
    std::string also;
    for (const auto& n : ::enw::console::other_names(*it)) also += (also.empty() ? "" : ", ") + n;
    if (!also.empty()) out.push_back("  also: " + also);
    return out;
}

std::vector<std::string> console_list(const std::string& filter) {
    std::vector<std::string> out;
    if (!g_ok) return out;
    refresh_context();
    const std::string f = settings::lower(filter);
    for (const auto& it : g_s.items) {
        if (!::enw::console::console_item(it)) continue;
        if (!f.empty()) {
            bool hit = ::enw::console::short_name(it).rfind(f, 0) == 0 || settings::lower(it.dvar).rfind(f, 0) == 0 ||
                       settings::lower(it.label).find(f) != std::string::npos;
            for (const auto& n : ::enw::console::other_names(it)) hit = hit || settings::lower(n).rfind(f, 0) == 0;
            if (!hit) continue;
        }
        std::string why;
        const auto vis = settings::visibility(it, g_ctx, &why);
        out.push_back(::enw::console::short_name(it) + " " + shown_value(it) +
                      (vis != settings::shown::editable && !why.empty() ? "  (" + why + ")" : std::string()));
    }
    return out;
}

std::vector<std::string> console_binds(const std::string& filter) {
    std::vector<std::string> out;
    if (!g_ok) return out;
    ensure_binds();
    const std::string f = settings::lower(filter);
    for (const auto& it : g_s.items) {
        if (it.k != settings::kind::bind) continue;
        const std::string an = ::enw::console::action_name(it);
        if (!f.empty() && an.rfind(f, 0) != 0 && settings::lower(it.label).find(f) == std::string::npos &&
            settings::lower(it.command).find(f) == std::string::npos)
            continue;
        out.push_back(an + " " + keys_text(it));
    }
    return out;
}

std::string console_bind(const std::string& key, const std::string& action) {
    if (!g_ok) return "settings unavailable in this build";
    refresh_context();
    ensure_binds();
    const std::string k = ::enw::console::normalize_key(key);
    if (k.empty()) return key + ": not a key";
    if (::enw::console::trim(action).empty()) {
        const std::string cmd = settings::command_of(g_binds, k);
        if (cmd.empty()) return k + " is free";
        for (const auto& it : g_s.items)
            if (it.k == settings::kind::bind && settings::lower(it.command) == settings::lower(cmd))
                return k + " -> " + ::enw::console::action_name(it);
        return k + " -> " + cmd;
    }
    const settings::item* it = ::enw::console::resolve_action(g_s, action);
    if (!it) return action + ": unknown action -- binds";
    std::string why;
    if (settings::visibility(*it, g_ctx, &why) != settings::shown::editable) return ::enw::console::action_name(*it) + ": " + why;
    if (!apply_bind(*it, k, "console")) return ::enw::console::action_name(*it) + ": not bound";
    return ::enw::console::action_name(*it) + " " + keys_text(*it);
}

std::string console_unbind(const std::string& key) {
    if (!g_ok) return "settings unavailable in this build";
    ensure_binds();
    const std::string k = ::enw::console::normalize_key(key);
    if (k.empty()) return key + ": not a key";
    const std::string had = settings::command_of(g_binds, k);
    const auto cmds = settings::unbind_commands(&g_binds, k);
    for (const auto& c : cmds) cbuf((c + "\n").c_str());
    ++g_changes;
    g_bind_flush = 2;   // raise the archive bit after the unbind has run, so config.cfg is rewritten
    ENW_INFO("settings: unbind %s (held '%s') via console", k.c_str(), had.c_str());
    return k + " free";
}

std::string console_apply() {
    if (!g_ok) return "settings unavailable in this build";
    refresh_context();
    if (g_ctx.listen_server) return "apply: a local game applies video next launch";
    if (g_restart) return "apply: already restarting";
    if (g_pending.empty()) return "apply: nothing pending";
    if (!apply_restart()) return "apply: refused";
    g_restart_console = true;
    return "restarting video";
}

}  // namespace enw::client::settings_tab
