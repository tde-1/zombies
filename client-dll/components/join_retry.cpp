// join_retry: a launcher join that arrives before the server is ready WAITS, it does not die.
//
// B, 2026-09-23, bridge_zombie on the box: "it said maps cannot be joined mid-game when I
// tried to join at the very start." Since 0.2.17 the client connects on its first frame
// (boot_direct.cpp), ~3.4 s after process start. The box had just loaded the map; our
// dedicated server opened its co-op gate 140 ms after the connect arrived; the server
// answered `error\nEXE_ERR_CANNOTJOININPROGRESS`; the stock client turned that into
// Com_Error(ERR_DROP) and went to the menu for good. The server half is fixed in
// server/components/dedicated/join_in_progress.cpp (dedi.md §21). This is the client half:
// a refusal that really means "not ready yet" is never fatal for a launcher join.
//
// WHERE THE REFUSAL BECOMES FATAL (read off the dump, t4-sp-map.md):
//   CL_ConnectionlessPacket 0x643380 handles both `error` and `lobbyerror` OOB replies
//   (the `error` branch jumps back to 0x643D49 at 0x643DF6) and ends in ONE call:
//
//     00643D48  56               push esi            ; the message ("EXE_ERR_...")
//     00643D49  68 6C B8 84 00   push "%s"
//     00643D4E  6A 01            push 1              ; ERR_DROP
//     00643D50  E8 FB 6E F5 FF   call Com_Error 0x59AC50
//     00643D55  83 C4 0C         add esp, 0xC        ; caller cleans -- and if Com_Error
//     00643D58  B0 01            mov al, 1           ;   ever returned, "packet handled"
//
//   We retarget that one rel32 (byte-checked) to a naked thunk with Com_Error's exact
//   stack. For a retryable message it RETURNS (the caller then cleans its 3 args and
//   reports the packet handled); for anything else it JMPs to Com_Error with the stack
//   untouched, so the stock error is exactly the stock error.
//
// THE RETRY is the engine's own: clc.state [0x305842C] back to 4 (CL_CheckForResend
// 0x642C80 sends `getchallenge` in state 4, `connect` in 5), and clc.connectTime
// [0x3010010] = cls.realtime [0x48AE4E8] (it resends when realtime - connectTime >=
// 3000; the frame tick brings that forward to 2000). No second CL_ConnectLocal.
// While the client is still waiting in state 4 with no answer at all (the server
// process is still booting or loading the map -- packets queue in its socket until
// the load ends), the same 3000 ms resend is brought forward to 2000 ms.
//
// RETRYABLE: EXE_ERR_CANNOTJOININPROGRESS, EXE_SERVERISFULL (warm-up, a slot still
// being freed), EXE_BAD_CHALLENGE (a challenge from before the map load),
// EXE_ERR_HOSTALREADYCONNECTED (our own previous attempt still holds a slot).
// Anything else is passed to Com_Error untouched.
//
// THE LINE. "Waiting for the server..." is drawn after SCR_DrawScreenField 0x478DC0 (its
// only caller, `push esi; call 0x478DC0; add esp,4` at 0x479271, is retargeted, byte-
// checked), through UI_DrawText 0x5B5FB0 on scrPlaceFull 0x957360 -- the placement the
// engine's own connect screen 0x5D7D40 uses -- with stock_font::pick (World at War's own
// font whatever the mod; client.md §9c). It shows once the client has been in state 4/5
// for 2.5 s or was refused once, and lifts the boot cover (boot_direct.cpp) so it can be
// seen.
//
// GIVING UP, after ENW_JOIN_RETRY_SECONDS (default 60) from the first connect:
//   * refused: the refusal is passed to Com_Error with our own message instead of the
//     engine's -- the engine's error box then says what happened in plain words;
//   * no answer at all: `disconnect` through Cbuf_AddText and the line reads "Could not
//     reach the server" for 15 s.
//
// Launcher joins only (ENW_CLIENT_CONNECT set, not a dedicated process). Off switch:
// ENW_JOIN_RETRY=0 (nothing is patched).
//
// Clean room: our own code; addresses and facts only.

#include "boot_direct.hpp"
#include "menu_lockdown.hpp"   // [lockdown] drawn through this file's SCR_DrawScreenField seam
#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace enw::client::stock_font {
void* pick(float real_scale);
}

namespace enw::client {
namespace {

constexpr uintptr_t kErrorCallSite = 0x643D50;   // call Com_Error in CL_ConnectionlessPacket
constexpr uintptr_t kComError = 0x59AC50;
constexpr uintptr_t kFieldCallSite = 0x479271;   // call SCR_DrawScreenField
constexpr uintptr_t kDrawScreenField = 0x478DC0;
constexpr uintptr_t kUIDrawText = 0x5B5FB0;      // cdecl x9 + ecx horz, eax vert
constexpr uintptr_t kRTextWidth = 0x6E8DA0;      // eax text; stack maxChars, font
constexpr uintptr_t kCbufAddText = 0x594200;     // eax text, ecx localClient
constexpr uintptr_t kScrPlaceFull = 0x957360;
constexpr uintptr_t kUiReady = 0x48AE4DC;        // SCR_DrawScreenField draws nothing while 0
constexpr uintptr_t kClcState = 0x305842C;
constexpr uintptr_t kConnectTime = 0x3010010;
constexpr uintptr_t kRealtime = 0x48AE4E8;

constexpr uint8_t kErrorSiteBefore[] = {0x56, 0x68, 0x6C, 0xB8, 0x84, 0x00, 0x6A, 0x01};
constexpr uint8_t kErrorSiteAfter[] = {0x83, 0xC4, 0x0C, 0xB0, 0x01};
constexpr uint8_t kFieldSiteAfter[] = {0x83, 0xC4, 0x04};
constexpr uint8_t kFieldSig[] = {0xA1, 0xC4, 0xB4, 0xDC, 0x03, 0x8B, 0x48, 0x04};
constexpr uint8_t kUIDrawTextSig[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF8, 0x83, 0xEC, 0x0C, 0x8B, 0x55, 0x08};
constexpr uint8_t kRTextWidthSig[] = {0x83, 0xEC, 0x08, 0x53, 0x55, 0x33, 0xED, 0x33, 0xDB};
constexpr uint8_t kCbufSig[] = {0x55, 0x56, 0x57, 0x68, 0xF8, 0x90, 0x29, 0x02};

const char* const kRetryable[] = {
    "EXE_ERR_CANNOTJOININPROGRESS",
    "EXE_SERVERISFULL",
    "EXE_BAD_CHALLENGE",
    "EXE_ERR_HOSTALREADYCONNECTED",
};

template <typename T>
T rd(uintptr_t a) { return *reinterpret_cast<volatile T*>(a); }
template <typename T>
void wr(uintptr_t a, T v) { *reinterpret_cast<volatile T*>(a) = v; }

bool g_armed = false;
bool g_patched_error = false;
bool g_patched_draw = false;
bool g_cbuf_ok = false;
ULONGLONG g_deadline_ms = 60000;

// All on the main thread: the OOB handler, the frame tick and the draw.
ULONGLONG g_first_ms = 0;        // clc.state first 4/5 (the connect)
bool g_done = false;             // got past state 5
bool g_gave_up = false;
bool g_gave_up_silent = false;   // gave up with no Com_Error box: the line says so
ULONGLONG g_gave_up_ms = 0;
int g_refusals = 0;
char g_reason[64] = {};
bool g_waiting = false;          // the line is up
ULONGLONG g_next_beat = 0;
long g_faults = 0;
char g_giveup_msg[256] = {};

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

bool bytes_at(uintptr_t at, const uint8_t* want, size_t n) {
    uint8_t got[16] = {};
    return n <= sizeof got && memory::read_raw(at, got, n) && std::memcmp(got, want, n) == 0;
}

int clc_state() { return rd<int>(kClcState); }
bool connecting(int s) { return s == 4 || s == 5; }
double secs(ULONGLONG ms) { return static_cast<double>(ms) / 1000.0; }

// ------------------------------------------------------------ the refusal --

const char* retryable(const char* msg) {
    __try {
        for (const char* r : kRetryable)
            if (std::strstr(msg, r)) return r;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
    return nullptr;
}

// 0 = not ours: Com_Error as the engine meant it.  1 = swallowed: retry.
// 2 = give up: Com_Error, but with g_giveup_msg in place of the engine's message.
int __cdecl decide(int code, const char* /*fmt*/, const char* msg) {
    if (!g_armed || g_done || g_gave_up || code != 1 || !msg) return 0;
    const char* hit = retryable(msg);
    if (!hit) {
        ENW_INFO("join_retry: the server refused with '%.80s' -- not a 'not ready yet' answer, "
                 "so the engine's error stands", msg);
        return 0;
    }
    const ULONGLONG now = ::GetTickCount64();
    if (!g_first_ms) g_first_ms = now;
    std::strncpy(g_reason, hit, sizeof g_reason - 1);
    const ULONGLONG waited = now - g_first_ms;
    if (waited >= g_deadline_ms) {
        g_gave_up = true;
        g_gave_up_ms = now;
        g_waiting = false;
        std::snprintf(g_giveup_msg, sizeof g_giveup_msg,
                      "The ENW server did not let you in within %d seconds. Press Play again.",
                      static_cast<int>(g_deadline_ms / 1000));
        ENW_ERROR("join_retry: GIVING UP after %.1f s and %d refusal(s); last answer %s. The "
                  "player sees: %s", secs(waited), g_refusals + 1, hit, g_giveup_msg);
        return 2;
    }
    ++g_refusals;
    // Back to "ask for a challenge". connectTime = now; the frame tick below brings the
    // engine's 3000 ms resend forward to 2000 ms while we are waiting (run retry1 set it
    // to now-1000 here as well and the two together retried every 1.0 s).
    const int rt = rd<int>(kRealtime);
    wr<int>(kClcState, 4);
    wr<int>(kConnectTime, rt);
    ENW_INFO("join_retry: the server is not ready (%s), refusal %d, %.1f s after the connect -- "
             "NOT fatal: clc.state -> 4, asking again in 2 s (gives up at %d s). "
             "ENW_JOIN_RETRY=0 restores the stock error.",
             hit, g_refusals, secs(waited), static_cast<int>(g_deadline_ms / 1000));
    return 1;
}

uintptr_t g_com_error = kComError;
const char* g_giveup_ptr = g_giveup_msg;

// Com_Error's stack exactly: [esp] ret, [esp+4] code, [esp+8] fmt, [esp+0xC] msg.
__declspec(naked) void error_thunk() {
    __asm {
        push dword ptr [esp + 0x0C]
        push dword ptr [esp + 0x0C]
        push dword ptr [esp + 0x0C]
        call decide
        add esp, 0x0C
        cmp eax, 1
        je swallow
        cmp eax, 2
        jne stock
        mov eax, g_giveup_ptr
        mov dword ptr [esp + 0x0C], eax
    stock:
        jmp dword ptr [g_com_error]
    swallow:
        ret
    }
}

// --------------------------------------------------------------- the line --

uintptr_t g_ui_draw_text = kUIDrawText;
uintptr_t g_r_text_width = kRTextWidth;
using field_t = void(__cdecl*)(int);
field_t g_field = reinterpret_cast<field_t>(kDrawScreenField);

// The same two engine thunks as chat_overlay.cpp (its are file-local): UI_DrawText takes
// nine stack arguments with horzAlign in ECX and vertAlign in EAX; R_TextWidth takes the
// text in EAX.
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

void centred(const char* s, float y, float scale, const float* color) {
    const float sy = rd<float>(kScrPlaceFull + 0x4);
    void* font = stock_font::pick(sy * scale);
    if (!font) return;
    const int ph = rd<int>(reinterpret_cast<uintptr_t>(font) + 4);   // Font_s::pixelHeight
    if (ph <= 0 || ph > 256) return;
    const float w = static_cast<float>(r_text_width(s, 0x7FFFFFFF, font)) * scale * 48.0f /
                    static_cast<float>(ph);
    ui_draw_text(reinterpret_cast<const void*>(kScrPlaceFull), s, 0x7FFFFFFF, font,
                 320.0f - w * 0.5f, y, scale, color, 3 /*shadowed*/, 0, 0);
}

void draw_line() {
    static const float white[4] = {1.f, 1.f, 1.f, 1.f};
    static const float grey[4] = {0.75f, 0.75f, 0.75f, 1.f};
    const ULONGLONG now = ::GetTickCount64();
    char a[96], b[128];
    if (g_gave_up) {
        if (!g_gave_up_silent || now - g_gave_up_ms > 15000) return;
        std::snprintf(a, sizeof a, "Could not reach the server");
        std::snprintf(b, sizeof b, "Press Play again in the launcher.");
    } else {
        const int s = static_cast<int>((now - g_first_ms) / 1000);
        std::snprintf(a, sizeof a, "Waiting for the server... %d s", s);
        if (g_refusals)   // the engine's code (g_reason) is in the log, not on screen
            std::snprintf(b, sizeof b, "The map is still starting on the server, asking again every 2 s");
        else
            std::snprintf(b, sizeof b, "The server is starting up, asking every 2 s");
    }
    centred(a, 300.0f, 0.4f, white);
    centred(b, 322.0f, 0.28f, grey);
}

void draw_guarded() {
    __try {
        draw_line();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        if (++g_faults <= 3)
            ENW_ERROR("join_retry: fault 0x%08lX while drawing the waiting line%s",
                      GetExceptionCode(), g_faults == 3 ? "; not drawing it again" : "");
    }
}

void __cdecl field_hook(int stereo) {
    g_field(stereo);
    if (!rd<int>(kUiReady)) return;
    if (g_faults < 3 && (g_waiting || (g_gave_up_silent && ::GetTickCount64() - g_gave_up_ms <= 15000))) draw_guarded();
    menu_lockdown::draw_over();   // [lockdown] last: it covers the main menu, and this line with it
}

// ------------------------------------------------------------ frame tick --

void cbuf_add_text(const char* text) {
    const uintptr_t fn = kCbufAddText;
    __asm {
        mov eax, text
        xor ecx, ecx
        mov edx, fn
        call edx
    }
}

void tick(uint64_t) {
    const int s = clc_state();
    const ULONGLONG now = ::GetTickCount64();
    if (!g_first_ms && connecting(s)) {
        g_first_ms = now;
        ENW_INFO("join_retry: connect under way (clc.state %d); a 'not ready yet' refusal will be "
                 "retried every 2 s for %d s", s, static_cast<int>(g_deadline_ms / 1000));
    }
    if (!g_first_ms || g_done) return;
    if (s >= 6) {
        g_done = true;
        if (g_waiting || g_refusals)
            ENW_INFO("join_retry: IN -- the server took the connect after %.1f s and %d refusal(s) "
                     "(clc.state %d)", secs(now - g_first_ms), g_refusals, s);
        g_waiting = false;
        return;
    }
    if (g_gave_up) return;
    if (!connecting(s)) return;   // a disconnect/error elsewhere: not ours to judge

    if (!g_waiting && (g_refusals > 0 || now - g_first_ms >= 2500)) {
        g_waiting = true;
        g_next_beat = now + 10000;
        boot_direct::lift_cover("waiting for the server");
        ENW_INFO("join_retry: WAITING for the server (%s, %.1f s after the connect); the line "
                 "'Waiting for the server...' is up", g_refusals ? "refused, retrying" : "no answer yet",
                 secs(now - g_first_ms));
    }
    if (!g_waiting) return;

    if (s == 4) {   // bring the 3000 ms getchallenge resend forward to 2000 ms
        const int rt = rd<int>(kRealtime), ct = rd<int>(kConnectTime);
        if (rt - ct >= 2000 && rt - ct < 3000) wr<int>(kConnectTime, rt - 3000);
    }
    if (now >= g_next_beat) {
        g_next_beat = now + 10000;
        ENW_INFO("join_retry: still waiting, %.0f s, clc.state %d, %d refusal(s)",
                 secs(now - g_first_ms), s, g_refusals);
    }
    // After refusals, the next refusal past the deadline gives up through the engine's own
    // error box with our message (decide() returns 2); allow it 4 s to arrive (giveup1 hit
    // the deadline between two refusals and took the silent path instead).
    if (now - g_first_ms >= g_deadline_ms + (g_refusals ? 4000 : 0)) {
        g_gave_up = true;
        g_gave_up_silent = true;
        g_gave_up_ms = now;
        g_waiting = false;
        ENW_ERROR("join_retry: GIVING UP -- no way in after %.0f s (%d refusal(s), clc.state %d). "
                  "Disconnecting; the player sees 'Could not reach the server'.",
                  secs(now - g_first_ms), g_refusals, s);
        if (g_cbuf_ok) cbuf_add_text("disconnect\n");
    }
}

// SCR_DrawScreenField's one call site -> field_hook. Byte-checked; on any mismatch nothing is
// patched and neither the waiting line nor the lockdown cover is drawn.
void bind_field_seam() {
    if (g_patched_draw) return;
    if (memory::call_target(kFieldCallSite) == kDrawScreenField &&
        bytes_at(kFieldCallSite - 1, reinterpret_cast<const uint8_t*>("\x56"), 1) &&
        bytes_at(kFieldCallSite + 5, kFieldSiteAfter, sizeof kFieldSiteAfter) &&
        bytes_at(kDrawScreenField, kFieldSig, sizeof kFieldSig) &&
        bytes_at(kUIDrawText, kUIDrawTextSig, sizeof kUIDrawTextSig) &&
        bytes_at(kRTextWidth, kRTextWidthSig, sizeof kRTextWidthSig) &&
        memory::retarget_call(kFieldCallSite, reinterpret_cast<const void*>(&field_hook))) {
        g_patched_draw = true;
        ENW_INFO("join_retry: SCR_DrawScreenField's call (0x%08X) bound: the waiting line and the main-menu "
                 "lockdown cover draw after the engine's screen", static_cast<unsigned>(kFieldCallSite));
    } else {
        ENW_WARN("join_retry: could not bind SCR_DrawScreenField (0x%08X: %s); no waiting line, no lockdown cover",
                 static_cast<unsigned>(kFieldCallSite), memory::hex_dump(kFieldCallSite - 1, 9).c_str());
    }
}

class join_retry_component final : public component {
public:
    const char* name() const override { return "join_retry"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        // [lockdown] The seam is bound for EVERY client process now, not only a launcher join:
        // menu_lockdown.cpp draws its cover after the engine's screen through it (one owner of
        // the call site, README hard rule 9). The retry below is still a launcher join's only.
        bind_field_seam();
        const char* m = std::getenv("ENW_CLIENT_CONNECT");
        if (!m || !*m) return;   // Play Local, a menu launch: the stock rules
        const char* off = std::getenv("ENW_JOIN_RETRY");
        if (off && off[0] == '0') {
            ENW_WARN("join_retry: OFF (ENW_JOIN_RETRY=0) - a refused join is fatal, as stock");
            return;
        }
        if (const char* d = std::getenv("ENW_JOIN_RETRY_SECONDS"); d && *d) {
            const long v = std::strtol(d, nullptr, 10);
            if (v >= 5 && v <= 600) g_deadline_ms = static_cast<ULONGLONG>(v) * 1000;
        }

        if (memory::call_target(kErrorCallSite) != kComError ||
            !bytes_at(kErrorCallSite - sizeof kErrorSiteBefore, kErrorSiteBefore,
                      sizeof kErrorSiteBefore) ||
            !bytes_at(kErrorCallSite + 5, kErrorSiteAfter, sizeof kErrorSiteAfter)) {
            ENW_ERROR("join_retry: 0x%08X is not CL_ConnectionlessPacket's `call Com_Error` on "
                      "this image (%s). OFF.", static_cast<unsigned>(kErrorCallSite),
                      memory::hex_dump(kErrorCallSite - 8, 18).c_str());
            return;
        }
        if (!memory::retarget_call(kErrorCallSite, reinterpret_cast<const void*>(&error_thunk))) {
            ENW_ERROR("join_retry: retarget of 0x%08X failed. OFF.",
                      static_cast<unsigned>(kErrorCallSite));
            return;
        }
        g_patched_error = true;
        g_armed = true;

        // The line is a nicety: without it the retry still works (the seam is bound above).
        g_cbuf_ok = bytes_at(kCbufAddText, kCbufSig, sizeof kCbufSig);
        ENW_INFO("join_retry: bound. CL_ConnectionlessPacket's Com_Error (0x%08X) now retries "
                 "'not ready yet' refusals every 2 s for %d s; waiting line %s. "
                 "Off switch ENW_JOIN_RETRY=0.", static_cast<unsigned>(kErrorCallSite),
                 static_cast<int>(g_deadline_ms / 1000), g_patched_draw ? "on" : "OFF");
    }

    void post_init() override {
        if (!g_armed) return;
        enw::frame::subscribe("join_retry", tick);
    }
};

}  // namespace
}  // namespace enw::client

ENW_REGISTER_COMPONENT(enw::client::join_retry_component)
