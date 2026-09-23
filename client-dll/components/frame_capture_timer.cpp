// frame_capture_timer: timed back-buffer captures once the client is in the map.
//
// OFF unless ENW_FRAME_CAPTURE_AT is set (e.g. "8,20,40"): seconds after clc.state
// first reaches 10 (CA_ACTIVE -- in the map, drawing the world). Each entry asks
// frame_capture.cpp for one frame named cap_<sec>s; that instrument also needs
// ENW_FRAME_CAPTURE=1 and writes to ENW_FRAME_CAPTURE_DIR.
//
// Why (mod-compat.md, 2026-09-23): B saw a custom map's first-person weapon drawn as
// stretched polygons across the screen. The only acceptable evidence for "fixed" is a
// picture of the viewmodel from an off-screen dev client, and the chat self-test is the
// only thing that asked for frames until now. No hooks, no patches: it rides the
// frame tick and reads one dword.
//
// ENW_FRAME_CAPTURE_CMDS="3:togglemenu|12:weapnext" (optional) queues console commands at
// the same clock, through Cbuf_AddText 0x594200 (verified by chat_overlay.cpp's byte
// check). A dev client parked off-screen with ENW_TEST_NO_ACTIVATE has no player to shut
// a menu a map opens at spawn; this is that player. Each capture also logs keyCatchers.
#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"

#include <windows.h>

#include <cstdlib>
#include <string>
#include <vector>

namespace enw::client {
namespace frame_capture { bool request(const char* name); }  // frame_capture.cpp

namespace {

constexpr uintptr_t kClcState = 0x305842C;  // [V] t4-sp-map.md §9
constexpr int kActive = 10;                 // chat_overlay logs "clc.state 10" in game
constexpr uintptr_t kKeyCatchers = 0x3058424;  // chat_overlay.cpp
constexpr uintptr_t kCbufAddText = 0x594200;   // eax text, ecx localClient (chat_overlay.cpp)

struct timed_cmd { int at; std::string text; };
std::vector<timed_cmd> g_cmds;
size_t g_next_cmd = 0;

void cbuf_add_text(const char* text) {
    const uintptr_t fn = enw::at(kCbufAddText);
    __asm {
        mov eax, text
        xor ecx, ecx
        mov edx, fn
        call edx
    }
}

std::vector<int> g_at;     // seconds after active, ascending
size_t g_next = 0;
ULONGLONG g_active_at = 0;

class frame_capture_timer final : public component {
public:
    const char* name() const override { return "frame_capture_timer"; }
    void post_load() override {
        const char* s = std::getenv("ENW_FRAME_CAPTURE_AT");
        if (!s || !s[0]) return;
        std::string cur;
        for (const char* p = s;; ++p) {
            if (*p >= '0' && *p <= '9') { cur += *p; continue; }
            if (!cur.empty()) g_at.push_back(std::atoi(cur.c_str()));
            cur.clear();
            if (!*p) break;
        }
        if (!g_at.empty()) ENW_INFO("frame_capture_timer: %zu capture(s) armed, first at +%d s in map", g_at.size(), g_at[0]);
        if (const char* c = std::getenv("ENW_FRAME_CAPTURE_CMDS"); c && c[0]) {
            std::string all(c);
            size_t pos = 0;
            while (pos <= all.size()) {
                size_t bar = all.find('|', pos);
                std::string item = all.substr(pos, bar == std::string::npos ? std::string::npos : bar - pos);
                size_t colon = item.find(':');
                if (colon != std::string::npos) g_cmds.push_back({std::atoi(item.c_str()), item.substr(colon + 1) + "\n"});
                if (bar == std::string::npos) break;
                pos = bar + 1;
            }
            ENW_INFO("frame_capture_timer: %zu timed command(s) armed", g_cmds.size());
        }
    }
    void post_init() override {
        if (g_at.empty() && g_cmds.empty()) return;
        frame::subscribe("frame_capture_timer", [](uint64_t) {
            if (g_next >= g_at.size() && g_next_cmd >= g_cmds.size()) return;
            const int st = *reinterpret_cast<const volatile int*>(enw::at(kClcState));
            if (!g_active_at) {
                if (st != kActive) return;
                g_active_at = ::GetTickCount64();
                ENW_INFO("frame_capture_timer: clc.state reached %d; captures count from now", kActive);
            }
            const ULONGLONG el = ::GetTickCount64() - g_active_at;
            if (g_next_cmd < g_cmds.size() && el >= static_cast<ULONGLONG>(g_cmds[g_next_cmd].at) * 1000ULL) {
                ENW_INFO("frame_capture_timer: +%d s running '%s' (keyCatchers 0x%X)", g_cmds[g_next_cmd].at,
                         g_cmds[g_next_cmd].text.c_str(), *reinterpret_cast<const volatile int*>(enw::at(kKeyCatchers)));
                cbuf_add_text(g_cmds[g_next_cmd].text.c_str());
                ++g_next_cmd;
            }
            if (g_next >= g_at.size()) return;
            if (el < static_cast<ULONGLONG>(g_at[g_next]) * 1000ULL) return;
            char nm[32];
            wsprintfA(nm, "cap_%ds", g_at[g_next]);
            ENW_INFO("frame_capture_timer: requesting '%s' (clc.state %d, keyCatchers 0x%X)", nm, st,
                     *reinterpret_cast<const volatile int*>(enw::at(kKeyCatchers)));
            frame_capture::request(nm);
            ++g_next;
        });
    }
};

ENW_REGISTER_COMPONENT(frame_capture_timer)

}  // namespace
}  // namespace enw::client
