// game_mode: the map's own pre-game choice menu (UGX Mod's gamemode vote on Battlestar
// Galactica and friends) is answered by the SERVER with the mode the party picked on the site,
// and the menu is never sent to any client. docs/kickstart/game-modes.md; the dvars and the
// schedule are in menu_answer.hpp.
//
// Two engine touches, both read off our own dump (tools/re/t4map.py) and byte-checked here
// before anything is armed:
//
//   1. PlayerCmd_OpenMenu 0x4EF840 -- the GSC method `self openMenu(name)`. Method table entry
//      0x83C1CC = {"openmenu", 0x4EF840, 0}. cdecl(scr_entref_t) with one stack argument; it
//      reads the name with Scr_GetConstString(0) (0x699F30: VM stack top [0x3BD4710] - 8*i,
//      VAR_STRING = 2, id -> text at [0x3702390] + id*12 + 4), then
//      SV_GameSendServerCommand(ent, reliable, "%c %i", 't', menuIndex) and Scr_AddBool(1).
//      Our detour reads the same stack slot WITHOUT calling anything, and for a hidden menu
//      returns without calling the original: no 't' command, so no client ever opens it. A
//      builtin that pushes no return value leaves `undefined`, which the script ignores.
//
//   2. The notify the client's click would have caused. ClientDisconnect 0x67C5B0 shows the
//      engine's own sequence for a `menuresponse` notify (0x67C5E8..0x67C617):
//          Scr_AddString  0x69A7E0 (EAX = inst 0, [esp] = text)     x2: response, then menu
//          Scr_NotifyNum  0x698CC0 (EAX = inst 0; entnum, classnum 0, stringValue, 2)
//          stringValue = scr_const.menuresponse, the word at 0x1F33D92 (written at 0x565730
//          from SL_GetString("menuresponse"), read at 0x67C603)
//      guarded by [0x3882B88] != 0 && [0x3882B7C] == 0, which we copy. We run it from the
//      frame tick, at a frame boundary on the main thread -- the same place the engine's own
//      ClientCommand does it from, outside any script execution.
//
// Evidence, on the game link (and so in the host's games_mp.log as `ENWZombie;game_mode;...`):
//   {t:"game_mode", state:"hidden",   menu, ent}          a menu was not sent
//   {t:"game_mode", state:"answered", menu, response, ent}
//   {t:"game_mode", state:"done",     notify}             the map's own "vote over" notify
//   {t:"game_mode", state:"timeout"|"refused"|"lost", ...}
// and in the DLL log, `game_mode:` lines.
//
// Clean room: our own code.

#include "component.hpp"
#include "frame.hpp"
#include "game_link.hpp"
#include "hook.hpp"
#include "json.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "../dedicated/dedicated.hpp"
#include "../referee/t4_bind.hpp"
#include "menu_answer.hpp"

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <string>

namespace enw::game_mode {
namespace {

constexpr uintptr_t kOpenMenu = 0x4EF840;
constexpr uint8_t kOpenMenuSig[] = {0x53, 0x8B, 0x5C, 0x24, 0x08, 0x8B, 0xC3, 0xC1, 0xE8, 0x10};
constexpr uintptr_t kScrAddString = 0x69A7E0;
constexpr uint8_t kScrAddStringSig[] = {0x51, 0x53, 0x8B, 0x5C, 0x24, 0x0C, 0x56, 0x57, 0x8B, 0xF8};
constexpr uintptr_t kScrNotifyNum = 0x698CC0;
constexpr uint8_t kScrNotifyNumSig[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF8, 0x83, 0xEC, 0x0C};
// ClientDisconnect's `movzx eax, word ptr [0x1F33D92]`: proves the const's address in this image.
constexpr uintptr_t kMenuResponseUse = 0x67C603;
constexpr uint8_t kMenuResponseUseSig[] = {0x0F, 0xB7, 0x05, 0x92, 0x3D, 0xF3, 0x01};
constexpr uintptr_t kScrConstMenuResponse = 0x1F33D92;
constexpr uintptr_t kScrActive = 0x3882B88;
constexpr uintptr_t kScrShutdown = 0x3882B7C;
constexpr uintptr_t kVmTop = 0x3BD4710;          // gScrVmPub[0].top
constexpr uintptr_t kVmInParamCount = 0x3BD471C; // what Scr_GetConstString bounds-checks
constexpr uintptr_t kMtBuffer = 0x3702390;
constexpr uintptr_t kGEntities = 0x176C6F0;
constexpr size_t kGEntitySize = 0x378;
constexpr size_t kEntClient = 0x180;
constexpr size_t kClientConnected = 0x20E0;      // == 2 CON_CONNECTED (PlayerCmd_OpenMenu's own test)
constexpr int kMaxClients = 4;

using open_menu_t = void(__cdecl*)(uint32_t entref);
enw::hook g_hook;
open_menu_t g_orig = nullptr;
bool g_bound = false;

spec g_spec;
bool g_spec_read = false;
std::string g_mode_id;

// The answer in flight. Only touched on the main thread (the detour and the frame tick).
struct pending {
    bool armed = false;
    int ent = -1;
    std::string menu;         // exactly as the script passed it
    size_t next = 0;          // next response index
    uint64_t due_ms = 0;
    uint64_t last_sent_ms = 0;
    int round = 0;
} g_p;
std::atomic<bool> g_done{false};
bool g_done_reported = false;
int g_hidden = 0;

uint64_t now_ms() { return GetTickCount64(); }

template <typename T>
bool peek(uintptr_t a, T* out) {
    if (!memory::is_readable(reinterpret_cast<void*>(a), sizeof(T))) return false;
    std::memcpy(out, reinterpret_cast<const void*>(a), sizeof(T));
    return true;
}

bool sig_ok(uintptr_t a, const uint8_t* sig, size_t n) {
    uint8_t got[16] = {};
    if (n > sizeof got || !memory::read_raw(enw::at(a), got, n)) return false;
    return std::memcmp(got, sig, n) == 0;
}

void emit(const char* state, const std::string& menu, const std::string& response, int ent,
          const std::string& note = {}) {
    json::writer w;
    w.str("t", "game_mode").integer("ms", game_link::now_ms()).str("state", state);
    if (!g_mode_id.empty()) w.str("mode", g_mode_id);
    if (!menu.empty()) w.str("menu", menu);
    if (!response.empty()) w.str("response", response);
    if (ent >= 0) w.integer("ent", ent);
    if (!note.empty()) w.str("note", note);
    game_link::get().send(w);
}

std::string dvar_or_empty(const char* name) {
    auto v = enw::referee::dvar_get(name);
    return v ? *v : std::string();
}

// Read once, the first time a script opens any menu (the engine is fully up by then, and the
// host's +set values are in). The dvars live for the process, which is one lease.
const spec& current_spec() {
    if (g_spec_read) return g_spec;
    g_spec_read = true;
    g_mode_id = dvar_or_empty("enw_game_mode");
    if (!plain_token(g_mode_id)) g_mode_id.clear();
    g_spec = parse(dvar_or_empty("enw_menu_hide"), dvar_or_empty("enw_menu_answer"),
                   dvar_or_empty("enw_menu_done"));
    if (!g_spec.error.empty()) {
        ENW_ERROR("game_mode: REFUSED the host's menu answer (%s); the map's own menu will show",
                  g_spec.error.c_str());
        emit("refused", {}, {}, -1, g_spec.error);
    } else if (g_spec.active()) {
        std::string resp;
        for (const auto& r : g_spec.responses) resp += (resp.empty() ? "" : ",") + r;
        ENW_INFO("game_mode: armed -- mode '%s', hide %zu menu(s), answer %s with %s, done notify '%s'",
                 g_mode_id.c_str(), g_spec.hide.size(), g_spec.answer_menu.c_str(), resp.c_str(),
                 g_spec.done_notify.c_str());
    }
    return g_spec;
}

// The string in VM stack slot 0 of the current builtin call, or empty. Reads only.
std::string param0_string() {
    uint32_t top = 0, count = 0;
    if (!peek(enw::at(kVmTop), &top) || !peek(enw::at(kVmInParamCount), &count)) return {};
    if (count < 1 || !top) return {};
    uint32_t u = 0, type = 0;
    if (!peek(top, &u) || !peek(top + 4, &type)) return {};
    if (type != 2 /* VAR_STRING */ || u == 0 || u >= 0x10000) return {};
    uint32_t base = 0;
    if (!peek(enw::at(kMtBuffer), &base) || !base) return {};
    const uintptr_t p = base + u * 12 + 4;
    char buf[kMaxToken + 2] = {};
    for (size_t i = 0; i < sizeof buf - 1; ++i) {
        char c = 0;
        if (!peek(p + i, &c)) return {};
        buf[i] = c;
        if (!c) break;
    }
    buf[sizeof buf - 1] = 0;
    return buf;
}

bool player_connected(int ent) {
    if (ent < 0 || ent >= kMaxClients) return false;
    uint32_t client = 0;
    if (!peek(enw::at(kGEntities) + ent * kGEntitySize + kEntClient, &client) || !client) return false;
    uint32_t state = 0;
    return peek(client + kClientConnected, &state) && state == 2;
}

void __cdecl open_menu_detour(uint32_t entref) {
    const uint16_t entnum = static_cast<uint16_t>(entref & 0xFFFF);
    const uint16_t classnum = static_cast<uint16_t>(entref >> 16);
    if (classnum == 0 && entnum < kMaxClients) {
        const spec& s = current_spec();
        if (s.active()) {
            const std::string menu = param0_string();
            if (!menu.empty() && s.hides(menu)) {
                ++g_hidden;
                ENW_INFO("game_mode: '%s' NOT sent to entity %u (hidden #%d)", menu.c_str(), entnum, g_hidden);
                emit("hidden", menu, {}, entnum);
                if (s.answers(menu)) {
                    g_p = pending{};
                    g_p.armed = true;
                    g_p.ent = entnum;
                    g_p.menu = menu;
                    g_p.due_ms = now_ms() + kFirstMs;
                    g_p.round = 1;
                    g_done = false;
                    g_done_reported = false;
                }
                return;   // no 't' command: the client never opens it
            }
        }
    }
    g_orig(entref);
}

// Scr_AddString(EAX = 0, [esp] = text); caller pops.
void scr_add_string(const char* text) {
    const uintptr_t fn = enw::at(kScrAddString);
    __asm {
        push text
        xor eax, eax
        call fn
        add esp, 4
    }
}

// Scr_NotifyNum(EAX = 0; entnum, classnum, stringValue, paramcount); caller pops.
void scr_notify_num(int ent, unsigned string_value, int params) {
    const uintptr_t fn = enw::at(kScrNotifyNum);
    __asm {
        push params
        push string_value
        push 0
        push ent
        xor eax, eax
        call fn
        add esp, 16
    }
}

bool send_response(int ent, const std::string& menu, const std::string& response) {
    uint32_t active = 0, shutdown = 0;
    uint16_t id = 0;
    if (!peek(enw::at(kScrActive), &active) || !peek(enw::at(kScrShutdown), &shutdown) ||
        !peek(enw::at(kScrConstMenuResponse), &id)) return false;
    if (!active || shutdown || !id) return false;
    if (!player_connected(ent)) return false;
    __try {
        // Params are pushed last-first: waittill("menuresponse", menu, response).
        scr_add_string(response.c_str());
        scr_add_string(menu.c_str());
        scr_notify_num(ent, id, 2);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ENW_ERROR("game_mode: fault 0x%08lX sending '%s' to entity %d", GetExceptionCode(), response.c_str(), ent);
        return false;
    }
    return true;
}

void tick() {
    if (g_done && !g_done_reported) {
        g_done_reported = true;
        ENW_INFO("game_mode: the map's '%s' notify arrived -- mode '%s' is in", g_spec.done_notify.c_str(), g_mode_id.c_str());
        emit("done", g_p.menu, {}, g_p.ent, g_spec.done_notify);
        g_p.armed = false;
        return;
    }
    if (!g_p.armed) return;
    const uint64_t t = now_ms();
    if (t < g_p.due_ms) return;
    if (g_p.next < g_spec.responses.size()) {
        const std::string& r = g_spec.responses[g_p.next];
        if (!send_response(g_p.ent, g_p.menu, r)) {
            ENW_WARN("game_mode: could not send '%s' to entity %d (not connected, or script not up); giving up",
                     r.c_str(), g_p.ent);
            emit("lost", g_p.menu, r, g_p.ent);
            g_p.armed = false;
            return;
        }
        ENW_INFO("game_mode: answered %s -> '%s' as entity %d (round %d)", g_p.menu.c_str(), r.c_str(), g_p.ent, g_p.round);
        emit("answered", g_p.menu, r, g_p.ent);
        ++g_p.next;
        g_p.last_sent_ms = t;
        g_p.due_ms = t + kStepMs;
        return;
    }
    // All sent. Without a done notify there is nothing more to learn.
    if (g_spec.done_notify.empty()) { g_p.armed = false; return; }
    if (t < g_p.last_sent_ms + kDoneWaitMs) return;
    if (g_p.round >= kMaxRounds) {
        ENW_ERROR("game_mode: '%s' never arrived after %d rounds of answers", g_spec.done_notify.c_str(), g_p.round);
        emit("timeout", g_p.menu, {}, g_p.ent, g_spec.done_notify);
        g_p.armed = false;
        return;
    }
    ++g_p.round;
    g_p.next = 0;
    g_p.due_ms = t;
    ENW_WARN("game_mode: '%s' not seen %u ms after the answer -- sending it again (round %d)",
             g_spec.done_notify.c_str(), kDoneWaitMs, g_p.round);
}

class game_mode_component final : public enw::component {
public:
    const char* name() const override { return "game_mode"; }
    bool is_supported() override { return enw::dedi::is_dedicated(); }

    void post_init() override {
        const struct { uintptr_t a; const uint8_t* s; size_t n; const char* what; } checks[] = {
            {kOpenMenu, kOpenMenuSig, sizeof kOpenMenuSig, "PlayerCmd_OpenMenu"},
            {kScrAddString, kScrAddStringSig, sizeof kScrAddStringSig, "Scr_AddString"},
            {kScrNotifyNum, kScrNotifyNumSig, sizeof kScrNotifyNumSig, "Scr_NotifyNum"},
            {kMenuResponseUse, kMenuResponseUseSig, sizeof kMenuResponseUseSig, "scr_const.menuresponse"},
        };
        for (const auto& c : checks) {
            if (!sig_ok(c.a, c.s, c.n)) {
                ENW_WARN("game_mode: %s at %08X does not match (%s) -- OFF, a map's mode menu will show",
                         c.what, static_cast<unsigned>(c.a), memory::hex_dump(enw::at(c.a), 10).c_str());
                return;
            }
        }
        if (!g_hook.create(kOpenMenu, reinterpret_cast<void*>(&open_menu_detour), "game_mode/openmenu") ||
            !g_hook.enable()) {
            ENW_WARN("game_mode: could not hook PlayerCmd_OpenMenu -- OFF");
            return;
        }
        g_orig = g_hook.original<open_menu_t>();
        enw::referee::on_notify([](const enw::referee::notify_event& ev) {
            if (!g_p.armed && g_p.round == 0) return;
            if (!g_spec.done_notify.empty() && ev.name == g_spec.done_notify) g_done = true;
        });
        enw::frame::subscribe("game_mode", [](uint64_t) { tick(); });
        g_bound = true;
        ENW_INFO("game_mode: bound (openMenu %08X). Dormant unless the host sets enw_menu_hide/enw_menu_answer.",
                 static_cast<unsigned>(kOpenMenu));
    }
};

ENW_REGISTER_COMPONENT(game_mode_component)

}  // namespace
}  // namespace enw::game_mode
