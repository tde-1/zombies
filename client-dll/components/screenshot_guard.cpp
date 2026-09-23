// screenshot_guard: F12 (the game's own `screenshotJPEG`) can no longer drop a player out of a game.
//
// FOUND 2026-09-23, lane CE (B: "it ran very smoothly, but at the very end I died and the game
// crashed", nazi_zombie_ccube, launcher 0.2.35, client DLL 1b482aa2, box lease m_90af19a0;
// client.md §14). Not a crash: an ERR_DROP 5 s after the game over, while the server was still
// up (the host's restart grace), which the lockdown then covered and quit 4 s later:
//     Com_Error(1, "Hunk_AllocateTempMemory: failed on 11059216 bytes (total 10 MB, ...)")
//     called from 0x5E450A (Hunk_AllocateTempMemory 0x5E4450) <- 0x7460CB
// 11059216 = 2560 * 1440 * 3 + 16: a screen-sized RGB buffer on B's 2560x1440 desktop. The same
// line, the same stack, ended B's 0.2.7 run enw-11524.log on 2026-09-22 (client.md §7, left
// "UNPROVEN" there), a few seconds into a game -- both times at a moment worth a screenshot.
//
// The chain, read out of the decrypted exe (docs: client.md §14):
//   F12 is bound to `screenshotJPEG` in every stock profile (B's `myu` config.cfg included) ->
//   render command 0x725160 -> 0x70D0A0 (the screenshot command; `levelshot`/`savegame`/`silent`)
//   -> 0x70CF30(w, h, name): malloc(w*h*3), 0x70C980 reads the back buffer (refused when a
//   window is partially off-screen -- why no dev run ever hit this), then
//   -> 0x746080 (the JPEG writer: h in EAX; name, w, rgb on the stack), whose OUTPUT buffer is
//      Hunk_AllocateTempMemory(w*h*3) at 0x7460CB, freed by Hunk_FreeTempMemory (0x5E4580,
//      block in ESI) at 0x7461B6.
// In a map the SP hunk is 10 MB in total, so any display over ~3.4 megapixels (2560x1440,
// 3440x1440, 4K) cannot fit the JPEG buffer and the engine drops the game: every map, any
// moment, the one keypress. 1920x1080 needs 6.2 MB and gets by.
//
// FIX: the two calls in 0x746080 are retargeted to thunks with the same register contracts that
// take the block from the process heap instead. The hunk is untouched; the screenshot is written
// as before, to "<Documents>\Activision\CoDWaW\screenshots\shotNNNN.jpg" -- which is the
// player's own folder unless enw_localappdata also redirects CSIDL_PERSONAL (it does since CE;
// client.md §14.5). If the heap refuses (it will not: 11 MB of a
// 32-bit process with ~290 MB largest free block), the engine's own allocator is called and
// behaves exactly as before, and the free goes back to it. The savegame thumbnail (0x70D040,
// 512x512) uses the same writer and simply stops touching the hunk too.
//
// Byte-checked: 0x746080's prologue and the three call sites' rel32 must match, or nothing is
// patched and it says so. Client only. Off switch: ENW_SCREENSHOT_GUARD=0.
//
// Harness only (client.md §14.4), both OFF unless set:
//   ENW_SCREENSHOT_TEST=WxH   the screenshot command writes a synthetic W x H frame instead of
//                             reading the back buffer (0x70D2C2's call to 0x70CF30 retargeted), so
//                             an off-screen 640x480 test window takes B's 2560x1440-sized path;
//   ENW_SCREENSHOT_KEY_FILE=p when the file appears it is deleted and F12 is posted to the game
//                             window, as a player's keypress (the stock bind does the rest).
#include "component.hpp"
#include "frame.hpp"
#include "input_gate.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace enw::client {
namespace {

constexpr uintptr_t kJpegWrite = 0x746080;
// push ebp; mov ebp,esp; and esp,-8; sub esp,20Ch; push ebx; mov ebx,[ebp+0Ch]
constexpr uint8_t kJpegWriteSig[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF8, 0x81, 0xEC,
                                     0x0C, 0x02, 0x00, 0x00, 0x53, 0x8B, 0x5D, 0x0C};
constexpr uintptr_t kHunkTempAlloc = 0x5E4450;   // size in EAX -> block in EAX; ECX/EBX/ESI/EDI/EBP kept
constexpr uintptr_t kHunkTempFree = 0x5E4580;    // block in ESI
constexpr uintptr_t kAllocSite = 0x7460CB;
constexpr uintptr_t kFreeSite = 0x7461B6;
constexpr uintptr_t kShotFull = 0x70CF30;        // cdecl (w, h, name): grab + write, full screen
constexpr uintptr_t kShotFullSite = 0x70D2C2;    // in 0x70D0A0, the `screenshotJPEG` command

std::atomic<long> g_heap_blocks{0};
std::atomic<long> g_engine_blocks{0};
std::atomic<unsigned long> g_largest{0};
void* g_engine_block = nullptr;   // the one block the engine's own allocator gave us (0x746080 is not re-entrant)

void* engine_temp_alloc(size_t bytes) {
    void* p = nullptr;
    const uintptr_t fn = kHunkTempAlloc;
    __asm {
        mov eax, bytes
        mov ecx, fn
        call ecx
        mov p, eax
    }
    return p;
}

void engine_temp_free(void* p) {
    const uintptr_t fn = kHunkTempFree;
    __asm {
        push esi
        mov esi, p
        mov eax, fn
        call eax
        pop esi
    }
}

void* __cdecl jpeg_block_alloc(size_t size) {
    void* p = ::HeapAlloc(::GetProcessHeap(), HEAP_ZERO_MEMORY, size);
    if (p) {
        const long n = ++g_heap_blocks;
        unsigned long prev = g_largest.load();
        while (size > prev && !g_largest.compare_exchange_weak(prev, static_cast<unsigned long>(size))) {}
        if (n <= 3 || size > 4u * 1024 * 1024)
            ENW_INFO("screenshot_guard: JPEG buffer of %lu bytes from the heap, not the 10 MB hunk (#%ld)",
                     static_cast<unsigned long>(size), n);
        return p;
    }
    ++g_engine_blocks;
    ENW_WARN("screenshot_guard: the heap refused %lu bytes -- falling back to the engine's hunk (it may drop "
             "the game exactly as before)", static_cast<unsigned long>(size));
    g_engine_block = engine_temp_alloc(size);   // Com_Error (longjmp) if the hunk cannot fit it either
    return g_engine_block;
}

void __cdecl jpeg_block_free(void* p) {
    if (!p) return;
    if (p == g_engine_block) {
        g_engine_block = nullptr;
        engine_temp_free(p);
        return;
    }
    ::HeapFree(::GetProcessHeap(), 0, p);
}

// Same contract as 0x5E4450 at 0x7460CB: size in EAX, block in EAX; everything else kept.
__declspec(naked) void alloc_thunk() {
    __asm {
        push ecx
        push edx
        push eax
        call jpeg_block_alloc
        add esp, 4
        pop edx
        pop ecx
        ret
    }
}

// Same contract as 0x5E4580 at 0x7461B6: block in ESI; everything else kept.
__declspec(naked) void free_thunk() {
    __asm {
        push eax
        push ecx
        push edx
        push esi
        call jpeg_block_free
        add esp, 4
        pop edx
        pop ecx
        pop eax
        ret
    }
}

// ------------------------------------------------------------------ harness only --
int g_test_w = 0, g_test_h = 0;
long g_test_shots = 0;

// Replaces 0x70CF30 at 0x70D2C2 in test runs: the same writer (0x746080) with a synthetic frame
// of the test size. Every byte after the grab is the engine's own path.
void __cdecl test_full_shot(int w, int h, const char* name) {
    const int tw = g_test_w, th = g_test_h;
    const size_t n = static_cast<size_t>(tw) * th * 3;
    uint8_t* rgb = static_cast<uint8_t*>(std::malloc(n));
    if (!rgb) {
        ENW_ERROR("screenshot_guard: TEST could not allocate %lu bytes for the synthetic frame",
                  static_cast<unsigned long>(n));
        return;
    }
    for (size_t i = 0; i < n; ++i) rgb[i] = static_cast<uint8_t>((i / 3 / tw) * 255 / (th ? th : 1));
    ++g_test_shots;
    ENW_INFO("screenshot_guard: TEST screenshotJPEG '%s' at %dx%d (the window is %dx%d) -> the engine's JPEG "
             "writer 0x746080 needs %lu bytes for its buffer", name ? name : "?", tw, th, w, h,
             static_cast<unsigned long>(n + 16));
    const uintptr_t fn = kJpegWrite;
    __asm {
        push rgb
        push tw
        push name
        mov eax, th
        mov ecx, fn
        call ecx
        add esp, 12
    }
    std::free(rgb);
    ENW_INFO("screenshot_guard: TEST screenshot written, the game goes on");
}

std::string g_key_file;
DWORD g_key_poll = 0;
long g_keys_posted = 0;

void key_file_tick() {
    if (g_key_file.empty()) return;
    const DWORD now = ::GetTickCount();
    if (now - g_key_poll < 100) return;
    g_key_poll = now;
    if (::GetFileAttributesA(g_key_file.c_str()) == INVALID_FILE_ATTRIBUTES) return;
    HWND h = input_gate::window();
    if (!h) return;
    ::DeleteFileA(g_key_file.c_str());
    const LPARAM down = 1 | (0x58 << 16), up = 1 | (0x58 << 16) | (3u << 30);   // F12, scan 0x58
    ::PostMessageA(h, WM_KEYDOWN, VK_F12, down);
    ::PostMessageA(h, WM_KEYUP, VK_F12, up);
    ++g_keys_posted;
    ENW_INFO("screenshot_guard: TEST F12 posted to the game window (#%ld) -- the stock bind is screenshotJPEG",
             g_keys_posted);
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

bool call_is(uintptr_t site, uintptr_t target, const char* what) {
    if (memory::call_target(site) == target) return true;
    ENW_ERROR("screenshot_guard: 0x%08X is not `call 0x%08X` (%s) on this image (%s). OFF.",
              static_cast<unsigned>(site), static_cast<unsigned>(target), what, memory::hex_dump(site, 5).c_str());
    return false;
}

class screenshot_guard final : public component {
public:
    const char* name() const override { return "screenshot_guard"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        uint8_t got[sizeof kJpegWriteSig] = {};
        if (!memory::read_raw(kJpegWrite, got, sizeof got) || std::memcmp(got, kJpegWriteSig, sizeof got) != 0) {
            ENW_ERROR("screenshot_guard: 0x%08X is not the engine's JPEG writer on this image (%s). OFF.",
                      static_cast<unsigned>(kJpegWrite), memory::hex_dump(kJpegWrite, 16).c_str());
            return;
        }
        if (const char* t = std::getenv("ENW_SCREENSHOT_TEST"); t && t[0]) {
            int w = 0, h = 0;
            if (std::sscanf(t, "%dx%d", &w, &h) == 2 && w >= 64 && h >= 64 && w <= 8192 && h <= 8192 &&
                call_is(kShotFullSite, kShotFull, "the screenshot command's full-screen grab") &&
                memory::retarget_call(kShotFullSite, reinterpret_cast<const void*>(&test_full_shot))) {
                g_test_w = w;
                g_test_h = h;
                ENW_WARN("screenshot_guard: TEST ENW_SCREENSHOT_TEST=%dx%d -- screenshotJPEG writes a synthetic "
                         "%dx%d frame (harness only)", w, h, w, h);
            } else {
                ENW_ERROR("screenshot_guard: TEST ENW_SCREENSHOT_TEST='%s' not applied", t);
            }
        }
        if (const char* k = std::getenv("ENW_SCREENSHOT_KEY_FILE"); k && k[0]) {
            g_key_file = k;
            ENW_INFO("screenshot_guard: TEST key file armed: %s (F12 when it appears)", k);
        }

        const char* v = std::getenv("ENW_SCREENSHOT_GUARD");
        if (v && v[0] == '0' && !v[1]) {
            ENW_WARN("screenshot_guard: OFF (ENW_SCREENSHOT_GUARD=0) -- F12 on a display over ~3.4 megapixels "
                     "drops the game (Hunk_AllocateTempMemory)");
            return;
        }
        if (!call_is(kAllocSite, kHunkTempAlloc, "Hunk_AllocateTempMemory") ||
            !call_is(kFreeSite, kHunkTempFree, "Hunk_FreeTempMemory"))
            return;
        if (!memory::retarget_call(kAllocSite, reinterpret_cast<const void*>(&alloc_thunk))) {
            ENW_ERROR("screenshot_guard: retarget of 0x%08X failed. OFF.", static_cast<unsigned>(kAllocSite));
            return;
        }
        if (!memory::retarget_call(kFreeSite, reinterpret_cast<const void*>(&free_thunk))) {
            // Never leave a heap alloc paired with the hunk's free: put the allocation back.
            memory::retarget_call(kAllocSite, reinterpret_cast<const void*>(kHunkTempAlloc));
            ENW_ERROR("screenshot_guard: retarget of 0x%08X failed; allocation restored. OFF.",
                      static_cast<unsigned>(kFreeSite));
            return;
        }
        ENW_INFO("screenshot_guard: the JPEG writer (0x%08X, F12 / screenshotJPEG and the savegame thumbnail) "
                 "takes its buffer from the heap, not the 10 MB hunk -- a screenshot on a large display no "
                 "longer drops the game. Off: ENW_SCREENSHOT_GUARD=0.", static_cast<unsigned>(kJpegWrite));
    }

    void post_init() override {
        if (!g_key_file.empty()) frame::subscribe("screenshot_key_file", [](uint64_t) { key_file_tick(); });
    }

    void pre_destroy() override {
        if (g_heap_blocks || g_engine_blocks || g_test_shots || g_keys_posted)
            ENW_INFO("screenshot_guard: session: %ld JPEG buffer(s) from the heap (largest %lu bytes), %ld from the "
                     "hunk; test shots %ld, F12 posted %ld",
                     g_heap_blocks.load(), g_largest.load(), g_engine_blocks.load(), g_test_shots, g_keys_posted);
    }
};

ENW_REGISTER_COMPONENT(screenshot_guard)

}  // namespace
}  // namespace enw::client
