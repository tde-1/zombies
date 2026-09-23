// FPS GUARD -- the client half of the Verified FPS rule (docs/kickstart/verified-rules.md).
//
// Every board we checked caps World at War's frame rate at 250 (ZWR and b2: 20..250,
// unchanged mid-game; Plutonium flags a client above 250 as cheating). The launcher already
// writes `com_maxfps` 30..250 at launch (launcher/src/main/gamecfg.js clampFps), but the
// console can change it a second later. This component does two things, once a second:
//
//   1. REPORT. The effective `com_maxfps` goes into userinfo as `enw_fps` (`setu`), only
//      when it changes. The server reads it (referee.cpp poll_environment), sends
//      `client_dvar` to the host, and the host judges the run (lib/verified.js). The
//      server cannot see a client dvar any other way. Always on, in every client.
//   2. LOCK, only when the launcher asks: ENW_FPS_CAP=<n> in the environment. Uncapped (0)
//      or above the cap is put back to the cap, below 20 to 20 (verified_env.hpp
//      fps_target). The correction goes through the engine's own command buffer, the
//      same `Cbuf_AddText` name_pin.cpp uses, so it is exactly what typing it would do.
//
// This is a belt, not the proof. A modified client can lie in userinfo; what the record
// carries is what the client REPORTED, and a report that moved mid-game costs the run its
// Verified record whether or not the lock put it back.
//
// Reads: the `com_maxfps` dvar_s* at [0x1F96488] and its int at +0x10 -- the same read
// server/components/dedicated/frame_pacing.cpp makes in this same exe, proven there.

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "../../server/components/referee/verified_env.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include <windows.h>

namespace enw::client {
namespace {

constexpr uintptr_t kComMaxfpsDvar = 0x1F96488;   // dvar_s* (frame_pacing.cpp)
constexpr uintptr_t kDvarValue = 0x10;
constexpr uint64_t kIntervalMs = 1000;

// Cbuf_AddText 0x594200, register arguments (text EAX, localClient ECX). The same address
// and the same signature check as name_pin.cpp, copied for the same reason it gives.
constexpr uintptr_t kCbuf_AddText = 0x594200;
constexpr uint8_t kCbufSig[] = {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02};

bool g_cbuf_ok = false;
int g_cap = 0;
int g_reported = -2;      // -2 = nothing sent yet
uint64_t g_last_ms = 0;
uint64_t g_corrections = 0;

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

void cbuf_add_text(const char* text, int local_client) {
    const uintptr_t fn = kCbuf_AddText;
    __asm {
        mov eax, text
        mov ecx, local_client
        mov edx, fn
        call edx
    }
}

bool read_maxfps(int* out) {
    uintptr_t dv = 0;
    if (!memory::read_raw(kComMaxfpsDvar, &dv, sizeof dv) || !dv) return false;
    return memory::read_raw(dv + kDvarValue, out, sizeof *out);
}

void tick() {
    const uint64_t now = ::GetTickCount64();
    if (g_last_ms && now - g_last_ms < kIntervalMs) return;
    g_last_ms = now;

    int v = 0;
    if (!read_maxfps(&v)) return;   // dvars not up yet: try again next second

    const int want = verified::fps_target(v, g_cap);
    if (want >= 0) {
        char cmd[48];
        std::snprintf(cmd, sizeof cmd, "com_maxfps %d\n", want);
        cbuf_add_text(cmd, 0);
        ++g_corrections;
        ENW_WARN("fps_guard: com_maxfps %d is outside the Verified rule (%d..%d) -> set to %d "
                 "(correction #%llu). The server has been told what it was.",
                 v, verified::kFpsMin, g_cap, want, static_cast<unsigned long long>(g_corrections));
    }
    // Report what the engine ran with THIS second, not what we just asked for: the
    // out-of-rule value is the fact the host needs to see.
    if (v != g_reported) {
        char cmd[48];
        std::snprintf(cmd, sizeof cmd, "setu %s %d\n", verified::kClientFpsKey, v < 0 ? 0 : v);
        cbuf_add_text(cmd, 0);
        ENW_INFO("fps_guard: reported com_maxfps %d (runs at %d fps) in userinfo %s", v,
                 verified::effective_fps(v), verified::kClientFpsKey);
        g_reported = v;
    }
}

class fps_guard final : public component {
public:
    const char* name() const override { return "fps_guard"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        uint8_t got[sizeof kCbufSig] = {};
        g_cbuf_ok = memory::read_raw(kCbuf_AddText, got, sizeof got) &&
                    std::memcmp(got, kCbufSig, sizeof got) == 0;
        if (!g_cbuf_ok) {
            ENW_WARN("fps_guard: Cbuf_AddText 0x%08X is not the expected bytes -- OFF. No FPS "
                     "report: a Verified run from this client will say 'unreported'.",
                     static_cast<unsigned>(kCbuf_AddText));
            return;
        }
        char buf[16]{};
        const DWORD n = ::GetEnvironmentVariableA("ENW_FPS_CAP", buf, sizeof buf);
        if (n > 0 && n < sizeof buf) g_cap = std::atoi(buf);
        ENW_INFO("fps_guard: reporting com_maxfps as userinfo %s; lock %s", verified::kClientFpsKey,
                 g_cap > 0 ? "ON (ENW_FPS_CAP)" : "off (ENW_FPS_CAP unset)");
        if (g_cap > 0) ENW_INFO("fps_guard: lock range %d..%d", verified::kFpsMin,
                                g_cap > verified::kFpsMax ? verified::kFpsMax : g_cap);
        // First run at the first frame: a command queued before the engine drains the
        // buffer is lost (name_pin.cpp learned this).
        frame::subscribe("fps_guard", [](uint64_t) { tick(); });
    }
};

ENW_REGISTER_COMPONENT(fps_guard)

}  // namespace
}  // namespace enw::client
