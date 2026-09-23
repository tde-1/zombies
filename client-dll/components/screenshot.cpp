// screenshot: ENW's own screenshot key. World at War's F12 is gone; ours takes its place.
//
// B, 2026-09-24: "Take over the screenshots. Unbind their screenshot and use our own, a common
// screenshotting approach that works with World at War: capture the whole screen, industry-standard
// compression but not too much, so the images look beautiful on people's computers. And have Open
// image / Open screenshots folder." (client.md Â§15; the launcher half is launcher/src/main/screenshots.js.)
//
// WHY NOT THE ENGINE'S. `screenshotJpeg` (F12 in every stock profile) drops the game on any display
// over ~3.4 megapixels (client.md Â§14: an 11 MB temp-hunk block from a 10 MB hunk), writes
// "<Documents>\Activision\CoDWaW\screenshots\shotNNNN.jpg" -- the player's own World at War folder --
// refuses a window that is partly off-screen, and is 4:2:0 libjpeg at the engine's quality.
//
// THE APPROACH is the one every D3D9 capture tool uses; we took ReShade's shape (BSD-3-Clause,
// crosire/reshade `runtime::save_screenshot`: grab the finished back buffer at Present, resolve
// MSAA with StretchRect, GetRenderTargetData into a system-memory surface, encode on a worker
// thread), reimplemented here -- no code copied -- with Windows Imaging Component instead of stb, so
// nothing new ships with the DLL:
//   * KEY. Our own console command `enw_screenshot`, linked into the engine's command list
//     (cmd_functions 0x1F416F4; node layout next/name/dir/ext/function read out of the inlined
//     Cmd_AddCommand at 0x72540C). The launcher binds F12 to it (wawcfg.js) and the settings catalogue
//     makes it rebindable like any control ("Screenshot", Controls > interact). The engine's own two
//     commands -- `screenshot` 0x725150 and `screenshotJpeg` 0x725160, both `push n; call 0x70D0A0`,
//     registered by R_RegisterCmds from static nodes -- are re-pointed at ours with a 5-byte jmp at
//     their first byte (byte-checked), so an old `bind F12 "screenshotJPEG"` in any config takes OUR
//     picture and the stock path cannot run. Harness only: ENW_SCREENSHOT_STOCK=1 leaves them alone.
//   * GRAB (render thread, frame_capture's Present hook, before the real Present): exactly the frame
//     the player sees, HUD and our overlays included, in windowed, borderless and fullscreen alike;
//     a multisampled back buffer is resolved first. Spread over Presents so no single one waits:
//     Present 1 StretchRects the back buffer into a render target (a queued GPU copy), Present 2
//     issues GetRenderTargetData into a system-memory surface, and that and later Presents try
//     LockRect with D3DLOCK_DONOTWAIT until the DMA has landed. The locked surface goes to the worker
//     as it is -- no copy on the render thread -- and is unlocked and released by one more Present
//     job once the file is written. In exclusive fullscreen the device's gamma ramp
//     (r_gamma) is applied to the pixels, since the hardware applies it to the screen, not the buffer.
//   * ENCODE (worker thread, WIC): JPEG quality 0.95 with 4:4:4 chroma (no subsampling) by default,
//     or PNG (lossless) when the setting says so (`enw_shotformat` png, ENW_SCREENSHOT_FORMAT).
//     No metadata is written, so no EXIF. Written to "<name>.part", then renamed.
//   * WHERE: %USERPROFILE%\Pictures\ENW Zombies (SHGetKnownFolderPath(FOLDERID_Pictures)), or
//     ENW_SCREENSHOT_DIR (the launcher passes the same folder; tests pass a scratch one). Named
//     "ENW Zombies <map> <yyyy-mm-dd hh-mm-ss>.jpg" (screenshot_name.hpp). Never the game's hunk,
//     never Documents.
//   * FEEDBACK: "Screenshot saved" as a system line in the chat overlay's HUD feed; the launcher
//     watches the folder for the rest. One press per 500 ms; a press while one is being written is
//     dropped (and logged).
// Client only. Off: ENW_SCREENSHOT=0 (the engine's commands then stay the engine's).
#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include "screenshot_name.hpp"
#include "settings_tab.hpp"

#include <windows.h>
#include <d3d9.h>
#include <knownfolders.h>
#include <shlobj.h>
#include <wincodec.h>

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

namespace enw::client {
namespace frame_capture { bool run_at_present(void (*fn)(IDirect3DDevice9*)); }   // frame_capture.cpp
namespace chat_notice { void system_line(const char* text); }                     // chat_overlay.cpp
namespace screenshot {
void grab_job(IDirect3DDevice9* dev);   // below; frame_capture runs it at Present
namespace {

namespace sn = screenshot_name;

// ------------------------------------------------------------------ the engine --
constexpr uintptr_t kCmdFunctions = 0x1F416F4;      // cmd_function_s* head
constexpr uintptr_t kStockShot = 0x725150;          // `screenshot`:     6A 01 E8 <0x70D0A0> 59 C3
constexpr uintptr_t kStockShotJpeg = 0x725160;      // `screenshotJpeg`: 6A 00 E8 <0x70D0A0> 59 C3
constexpr uintptr_t kShotCmd = 0x70D0A0;            // the render-command screenshot (client.md Â§14.2)

struct cmd_function_s {
    cmd_function_s* next;
    const char* name;
    const char* auto_dir;
    const char* auto_ext;
    void(__cdecl* function)();
};

void __cdecl cmd_enw_screenshot();
void __cdecl cmd_stock_screenshot();
void __cdecl cmd_stock_screenshot_jpeg();

cmd_function_s g_node{nullptr, "enw_screenshot", nullptr, nullptr, &cmd_enw_screenshot};
bool g_node_linked = false;
bool g_stock_patched = false;
bool g_enabled = true;

// ------------------------------------------------------------------ one shot --
// REQUESTED: waiting for Present 1 (copy the frame on the GPU); COPIED: reading it back over the
// following Presents; GRABBED: the worker is encoding; ENCODED: waiting to give the surfaces back.
enum : int { IDLE = 0, REQUESTED = 1, GRABBED = 2, ENCODED = 3, COPIED = 4 };
std::atomic<int> g_state{IDLE};

struct shot {
    // set on the main thread at the press
    std::string map;
    sn::format fmt = sn::format::jpg;
    SYSTEMTIME at{};
    const char* via = "";
    // set on the render thread by the grab
    IDirect3DSurface9* sys = nullptr;   // LOCKED (once locked) until release_job
    IDirect3DSurface9* rt = nullptr;    // the GPU copy of the frame, between the two Presents
    bool locked = false;
    bool issued = false;                // GetRenderTargetData has been issued
    int tries = 0;                      // LockRect(DONOTWAIT) attempts, one per Present
    double ms_a = 0, ms_b = 0;          // render thread at Present 1, and the worst single Present after it
    char steps[160] = {};               // where that time went
    const uint8_t* bits = nullptr;
    int pitch = 0;
    UINT w = 0, h = 0;
    D3DFORMAT d3dfmt = D3DFMT_UNKNOWN;
    bool msaa = false, fullscreen = false, gamma = false;
    WORD ramp[3 * 256] = {};
    double grab_ms = 0;
    // set by the worker
    bool ok = false;
    std::wstring path;
    unsigned long long bytes = 0;
    double encode_ms = 0;
    std::string err;
};
shot g_shot;                 // owned by whoever the state says; no two threads touch it at once
std::mutex g_mu;             // only for the handover of `err`/`path` strings to the log
HANDLE g_wake = nullptr;
HANDLE g_worker = nullptr;
std::atomic<bool> g_stop{false};
std::atomic<bool> g_grab_queued{false};
std::atomic<bool> g_b_queued{false};
std::atomic<bool> g_grab_failed{false};
std::atomic<bool> g_release_queued{false};
bool g_posted = false;       // main thread: the result of this shot has been told
ULONGLONG g_requested_at = 0;
sn::rate_limit g_limit;
long g_shots = 0, g_failed = 0, g_limited = 0, g_busy = 0;
double g_worst_grab = 0;
unsigned long long g_total_bytes = 0;

// Main-thread frame periods around a shot: the hitch as the game thread sees it.
LARGE_INTEGER g_qpf{};
LARGE_INTEGER g_last_tick{};
double g_periods[64] = {};
int g_period_n = 0;
double g_baseline = 0;
int g_watch = 0;
std::string g_after;

double qpc_ms(const LARGE_INTEGER& a, const LARGE_INTEGER& b) {
    return static_cast<double>(b.QuadPart - a.QuadPart) * 1000.0 / static_cast<double>(g_qpf.QuadPart ? g_qpf.QuadPart : 1);
}

std::string to_utf8(const std::wstring& w) {
    if (w.empty()) return {};
    const int n = ::WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(static_cast<size_t>(n > 0 ? n : 0), '\0');
    if (n > 0) ::WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}
std::wstring to_wide(const std::string& s) {
    if (s.empty()) return {};
    const int n = ::MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n > 0 ? n : 0), L'\0');
    if (n > 0) ::MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), w.data(), n);
    return w;
}
std::wstring env_w(const wchar_t* name) {
    wchar_t buf[1024];
    const DWORD n = ::GetEnvironmentVariableW(name, buf, 1024);
    return n && n < 1024 ? std::wstring(buf, n) : std::wstring();
}

// %USERPROFILE%\Pictures\ENW Zombies, or ENW_SCREENSHOT_DIR. Created if missing.
std::wstring shots_dir() {
    std::wstring dir = env_w(L"ENW_SCREENSHOT_DIR");
    if (dir.empty()) {
        PWSTR p = nullptr;
        if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_Pictures, KF_FLAG_CREATE, nullptr, &p)) && p) {
            dir = std::wstring(p) + L"\\ENW Zombies";
        }
        if (p) ::CoTaskMemFree(p);
    }
    while (!dir.empty() && (dir.back() == L'\\' || dir.back() == L'/')) dir.pop_back();
    if (!dir.empty()) ::SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);   // ok if it exists
    return dir;
}

// ------------------------------------------------------------------ the press --
// Main thread (the engine runs commands from Com_Frame's Cbuf_Execute).
void request(const char* via) {
    if (!g_limit.allow(::GetTickCount64(), 500)) {
        if (++g_limited <= 5) ENW_INFO("screenshot: '%s' within 500 ms of the last one -- ignored", via);
        return;
    }
    if (g_state.load() != IDLE) {
        if (++g_busy <= 5) ENW_INFO("screenshot: '%s' while the last one is still being written -- ignored", via);
        return;
    }
    LARGE_INTEGER t0, t1;
    ::QueryPerformanceCounter(&t0);
    shot& s = g_shot;
    s = shot{};
    s.via = via;
    ::GetLocalTime(&s.at);
    std::string title;
    {
        const std::wstring t = env_w(L"ENW_MAP_TITLE");
        title = to_utf8(t);
    }
    const char* launch_map = std::getenv("ENW_MAP");
    const std::string bsp = settings_tab::dvar_text("mapname");
    s.map = sn::map_part(bsp, title, launch_map ? launch_map : "");
    std::string f = settings_tab::dvar_text("enw_shotformat");
    if (f.empty()) if (const char* e = std::getenv("ENW_SCREENSHOT_FORMAT")) f = e;
    s.fmt = sn::parse_format(f);
    g_requested_at = ::GetTickCount64();
    g_grab_failed = false;
    g_posted = false;
    g_state = REQUESTED;
    g_grab_queued = true;
    if (!frame_capture::run_at_present(&grab_job)) g_grab_queued = false;   // slot busy: the tick retries
    ::QueryPerformanceCounter(&t1);
    // The hitch watch: the next 8 main-thread frame periods against the last 60.
    if (g_period_n > 0) {
        const int n = std::min(g_period_n, 60);
        std::vector<double> v(g_periods, g_periods + n);
        std::nth_element(v.begin(), v.begin() + n / 2, v.end());
        g_baseline = v[n / 2];
    }
    g_watch = 8;
    g_after.clear();
    ENW_INFO("screenshot: '%s' -> %s of '%s' (main thread %.3f ms; the grab is %s)", via, sn::ext(s.fmt),
             s.map.c_str(), qpc_ms(t0, t1), g_grab_queued ? "queued for the next Present" : "waiting for the Present slot");
}

void __cdecl cmd_enw_screenshot() { request("enw_screenshot"); }
void __cdecl cmd_stock_screenshot() { request("screenshot (engine command, redirected)"); }
void __cdecl cmd_stock_screenshot_jpeg() { request("screenshotJpeg (engine command, redirected)"); }

}  // namespace

// ------------------------------------------------------------------ the grab --
// Two Presents, so neither stalls the render thread for long (measured in ss1: one-step, 7-9 ms at
// 2560x1440 with MSAA, all of it at one Present):
//   Present 1 (grab_a): StretchRect the finished back buffer into a plain render target -- a GPU
//     copy that also resolves MSAA and is queued, not waited for -- and make the system-memory
//     surface. This is exactly the frame the player sees at that Present.
//   Present 2 (grab_b): GetRenderTargetData from that copy (the GPU finished it a frame ago) and
//     lock it; the worker encodes straight out of the lock.
namespace {
double step_ms(LARGE_INTEGER& t) {
    LARGE_INTEGER n;
    ::QueryPerformanceCounter(&n);
    const double ms = qpc_ms(t, n);
    t = n;
    return ms;
}
void fail_grab(const char* why, D3DFORMAT f) {
    shot& s = g_shot;
    s.err = why;
    s.err += " (format " + std::to_string(static_cast<unsigned>(f)) + ")";
    if (s.rt) s.rt->Release();
    if (s.sys) s.sys->Release();
    s.rt = s.sys = nullptr;
    g_grab_failed = true;
    g_state = IDLE;
}
}  // namespace

void grab_b_job(IDirect3DDevice9* dev);

void grab_a(IDirect3DDevice9* dev) {
    LARGE_INTEGER t0, t;
    ::QueryPerformanceCounter(&t0);
    t = t0;
    if (g_state.load() != REQUESTED) return;
    shot& s = g_shot;
    IDirect3DSurface9* bb = nullptr;
    D3DSURFACE_DESC d{};
    if (FAILED(dev->GetBackBuffer(0, 0, D3DBACKBUFFER_TYPE_MONO, &bb)) || !bb) return fail_grab("GetBackBuffer failed", d.Format);
    bb->GetDesc(&d);
    if (d.Format != D3DFMT_X8R8G8B8 && d.Format != D3DFMT_A8R8G8B8 && d.Format != D3DFMT_A2R10G10B10) {
        bb->Release();
        return fail_grab("unsupported back-buffer format", d.Format);
    }
    s.msaa = d.MultiSampleType != D3DMULTISAMPLE_NONE;
    const double m_bb = step_ms(t);
    HRESULT hr = dev->CreateRenderTarget(d.Width, d.Height, d.Format, D3DMULTISAMPLE_NONE, 0, FALSE, &s.rt, nullptr);
    const double m_rt = step_ms(t);
    if (SUCCEEDED(hr)) hr = dev->StretchRect(bb, nullptr, s.rt, nullptr, D3DTEXF_NONE);
    const double m_copy = step_ms(t);
    bb->Release();
    if (FAILED(hr)) return fail_grab("the GPU copy of the frame failed", d.Format);
    if (FAILED(dev->CreateOffscreenPlainSurface(d.Width, d.Height, d.Format, D3DPOOL_SYSTEMMEM, &s.sys, nullptr)))
        return fail_grab("no system-memory surface", d.Format);
    const double m_sys = step_ms(t);
    IDirect3DSwapChain9* sc = nullptr;
    if (SUCCEEDED(dev->GetSwapChain(0, &sc)) && sc) {
        D3DPRESENT_PARAMETERS pp{};
        if (SUCCEEDED(sc->GetPresentParameters(&pp))) s.fullscreen = !pp.Windowed;
        sc->Release();
    }
    if (s.fullscreen) {
        D3DGAMMARAMP r{};
        dev->GetGammaRamp(0, &r);
        bool ident = true;
        for (int i = 0; i < 256; ++i) {
            s.ramp[i] = r.red[i];
            s.ramp[256 + i] = r.green[i];
            s.ramp[512 + i] = r.blue[i];
            const int want = i * 257;
            if (std::abs(r.red[i] - want) > 256 || std::abs(r.green[i] - want) > 256 || std::abs(r.blue[i] - want) > 256)
                ident = false;
        }
        s.gamma = !ident;
    }
    s.w = d.Width;
    s.h = d.Height;
    s.d3dfmt = d.Format;
    s.ms_a = step_ms(t) + m_bb + m_rt + m_copy + m_sys;
    std::snprintf(s.steps, sizeof s.steps, "P1: backbuffer %.2f, create RT %.2f, copy%s %.2f, create sysmem %.2f", m_bb, m_rt,
                  s.msaa ? "+resolve" : "", m_copy, m_sys);
    // The slot was emptied before this job ran; the main thread's tick retries if it is taken.
    // (Flag before state, so the tick never queues a second one while this one is going in.)
    g_b_queued = true;
    g_state = COPIED;
    if (!frame_capture::run_at_present(&grab_b_job)) g_b_queued = false;
}

// Present 2 issues the readback (GetRenderTargetData returns at once: measured 0.01 ms); the WAIT is
// in LockRect (ss2: 5-7 ms blocking at 2560x1440). So the lock is tried with D3DLOCK_DONOTWAIT at
// Present 2 and each Present after it until the copy has landed; only after kMaxTries does it block.
constexpr int kMaxTries = 60;

void grab_b(IDirect3DDevice9* dev) {
    LARGE_INTEGER t0, t;
    ::QueryPerformanceCounter(&t0);
    t = t0;
    if (g_state.load() != COPIED) return;
    shot& s = g_shot;
    double m_read = 0;
    if (!s.issued) {
        if (FAILED(dev->GetRenderTargetData(s.rt, s.sys))) return fail_grab("GetRenderTargetData failed", s.d3dfmt);
        s.issued = true;
        m_read = step_ms(t);
    }
    ++s.tries;
    D3DLOCKED_RECT lr{};
    const bool last = s.tries >= kMaxTries;
    const HRESULT hr = s.sys->LockRect(&lr, nullptr, D3DLOCK_READONLY | (last ? 0 : D3DLOCK_DONOTWAIT));
    const double m_lock = step_ms(t);
    LARGE_INTEGER t1;
    ::QueryPerformanceCounter(&t1);
    s.ms_b = std::max(s.ms_b, qpc_ms(t0, t1));
    if (hr == D3DERR_WASSTILLDRAWING && !last) {
        // Not there yet: again at the next Present (the slot was emptied before this job ran).
        g_b_queued = true;
        if (!frame_capture::run_at_present(&grab_b_job)) g_b_queued = false;   // the tick retries
        return;
    }
    if (FAILED(hr)) return fail_grab("LockRect failed", s.d3dfmt);
    s.rt->Release();
    s.rt = nullptr;
    s.locked = true;
    s.bits = static_cast<const uint8_t*>(lr.pBits);
    s.pitch = lr.Pitch;
    const size_t used = std::strlen(s.steps);
    std::snprintf(s.steps + used, sizeof s.steps - used, "; P2: readback issued %.2f; lock landed on try %d%s (%.2f)",
                  m_read, s.tries, last ? ", blocking" : "", m_lock);
    s.grab_ms = std::max(s.ms_a, s.ms_b);
    g_state = GRABBED;
    ::SetEvent(g_wake);
}

void grab_job(IDirect3DDevice9* dev) {
    g_grab_queued = false;
    __try {
        grab_a(dev);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        g_grab_failed = true;
        g_state = IDLE;
    }
}

void grab_b_job(IDirect3DDevice9* dev) {
    g_b_queued = false;
    __try {
        grab_b(dev);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        g_grab_failed = true;
        g_state = IDLE;
    }
}

namespace {

// Render thread, once the worker is done with the pixels (or a shot was abandoned between the two
// Presents). IDLE before the queued flag drops, so the main thread never queues a second release.
void release_job(IDirect3DDevice9*) {
    shot& s = g_shot;
    __try {
        if (s.sys && s.locked) s.sys->UnlockRect();
        if (s.sys) s.sys->Release();
        if (s.rt) s.rt->Release();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
    s.sys = nullptr;
    s.rt = nullptr;
    s.locked = false;
    s.bits = nullptr;
    g_state = IDLE;
    g_release_queued = false;
}

// ------------------------------------------------------------------ the encode --
// The locked surface as a WIC source, 24-bit BGR, converted a row at a time as the encoder asks:
// the pixels are never copied whole. X8R8G8B8/A8R8G8B8 are B,G,R,X in memory; A2R10G10B10 drops
// its two low bits. The alpha byte is ignored (the back buffer's is not meaningful).
class frame_source final : public IWICBitmapSource {
public:
    explicit frame_source(const shot& s) : s_(s) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** pp) override {
        if (!pp) return E_POINTER;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IWICBitmapSource)) {
            *pp = static_cast<IWICBitmapSource*>(this);
            AddRef();
            return S_OK;
        }
        *pp = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return static_cast<ULONG>(::InterlockedIncrement(&ref_)); }
    ULONG STDMETHODCALLTYPE Release() override { return static_cast<ULONG>(::InterlockedDecrement(&ref_)); }   // on the stack
    HRESULT STDMETHODCALLTYPE GetSize(UINT* w, UINT* h) override {
        if (!w || !h) return E_INVALIDARG;
        *w = s_.w;
        *h = s_.h;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPixelFormat(WICPixelFormatGUID* pf) override {
        if (!pf) return E_INVALIDARG;
        *pf = GUID_WICPixelFormat24bppBGR;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetResolution(double* x, double* y) override {
        if (!x || !y) return E_INVALIDARG;
        *x = *y = 96.0;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE CopyPalette(IWICPalette*) override { return WINCODEC_ERR_PALETTEUNAVAILABLE; }
    HRESULT STDMETHODCALLTYPE CopyPixels(const WICRect* rc, UINT stride, UINT size, BYTE* buf) override {
        WICRect r{0, 0, static_cast<INT>(s_.w), static_cast<INT>(s_.h)};
        if (rc) r = *rc;
        if (!buf || r.X < 0 || r.Y < 0 || r.Width < 0 || r.Height < 0 || static_cast<UINT>(r.X + r.Width) > s_.w ||
            static_cast<UINT>(r.Y + r.Height) > s_.h)
            return E_INVALIDARG;
        if (r.Width == 0 || r.Height == 0) return S_OK;
        const UINT row = static_cast<UINT>(r.Width) * 3;
        if (stride < row || static_cast<unsigned long long>(stride) * (r.Height - 1) + row > size) return E_INVALIDARG;
        const bool ten = s_.d3dfmt == D3DFMT_A2R10G10B10;
        for (INT y = 0; y < r.Height; ++y) {
            const uint8_t* src = s_.bits + static_cast<size_t>(r.Y + y) * s_.pitch + static_cast<size_t>(r.X) * 4;
            BYTE* dst = buf + static_cast<size_t>(y) * stride;
            for (INT x = 0; x < r.Width; ++x, src += 4, dst += 3) {
                uint8_t b, g, rr;
                if (ten) {
                    uint32_t v;
                    std::memcpy(&v, src, 4);
                    rr = static_cast<uint8_t>((v >> 22) & 0xFF);
                    g = static_cast<uint8_t>((v >> 12) & 0xFF);
                    b = static_cast<uint8_t>((v >> 2) & 0xFF);
                } else {
                    b = src[0];
                    g = src[1];
                    rr = src[2];
                }
                if (s_.gamma) {
                    rr = static_cast<uint8_t>(s_.ramp[rr] >> 8);
                    g = static_cast<uint8_t>(s_.ramp[256 + g] >> 8);
                    b = static_cast<uint8_t>(s_.ramp[512 + b] >> 8);
                }
                dst[0] = b;
                dst[1] = g;
                dst[2] = rr;
            }
        }
        return S_OK;
    }

private:
    const shot& s_;
    LONG ref_ = 1;
};

template <typename T>
void rel(T*& p) {
    if (p) p->Release();
    p = nullptr;
}

// Worker thread. Returns an error string, empty on success.
std::string encode(shot& s, IWICImagingFactory* wic) {
    const std::wstring dir = shots_dir();
    if (dir.empty()) return "no Pictures folder";
    std::wstring final_path;
    const std::wstring map = to_wide(s.map);
    for (int dup = 1; dup < 100; ++dup) {
        const std::string n = sn::file_name(s.map, s.at.wYear, s.at.wMonth, s.at.wDay, s.at.wHour, s.at.wMinute,
                                            s.at.wSecond, s.fmt, dup);
        final_path = dir + L"\\" + to_wide(n);
        if (::GetFileAttributesW(final_path.c_str()) == INVALID_FILE_ATTRIBUTES) break;
    }
    const std::wstring tmp = final_path + L".part";
    IWICStream* st = nullptr;
    IWICBitmapEncoder* enc = nullptr;
    IWICBitmapFrameEncode* fr = nullptr;
    IPropertyBag2* props = nullptr;
    std::string err;
    frame_source src(s);
    HRESULT hr = wic->CreateStream(&st);
    if (SUCCEEDED(hr)) hr = st->InitializeFromFilename(tmp.c_str(), GENERIC_WRITE);
    if (FAILED(hr)) err = "could not create the file";
    if (err.empty()) {
        hr = wic->CreateEncoder(s.fmt == sn::format::png ? GUID_ContainerFormatPng : GUID_ContainerFormatJpeg, nullptr, &enc);
        if (SUCCEEDED(hr)) hr = enc->Initialize(st, WICBitmapEncoderNoCache);
        if (SUCCEEDED(hr)) hr = enc->CreateNewFrame(&fr, &props);
        if (FAILED(hr)) err = "no encoder";
    }
    if (err.empty() && s.fmt == sn::format::jpg && props) {
        // Quality 0.95 and 4:4:4: near-lossless, and red and blue edges stay sharp (4:2:0 halves their
        // resolution, which is what makes game HUD text fringe). JpegYCrCbSubsampling is Windows 8+.
        PROPBAG2 opt[2] = {};
        VARIANT val[2];
        ::VariantInit(&val[0]);
        ::VariantInit(&val[1]);
        opt[0].pstrName = const_cast<LPOLESTR>(L"ImageQuality");
        val[0].vt = VT_R4;
        val[0].fltVal = 0.95f;
        opt[1].pstrName = const_cast<LPOLESTR>(L"JpegYCrCbSubsampling");
        val[1].vt = VT_UI1;
        val[1].bVal = static_cast<BYTE>(WICJpegYCrCbSubsampling444);
        if (FAILED(props->Write(2, opt, val))) {
            props->Write(1, opt, val);
            s.err = "4:2:0 (this Windows has no 4:4:4 option)";
        }
    }
    if (err.empty()) {
        hr = fr->Initialize(props);
        if (SUCCEEDED(hr)) hr = fr->SetSize(s.w, s.h);
        WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
        if (SUCCEEDED(hr)) hr = fr->SetPixelFormat(&pf);
        if (SUCCEEDED(hr)) hr = fr->SetResolution(96.0, 96.0);
        if (SUCCEEDED(hr)) hr = fr->WriteSource(&src, nullptr);
        if (SUCCEEDED(hr)) hr = fr->Commit();
        if (SUCCEEDED(hr)) hr = enc->Commit();
        if (FAILED(hr)) {
            char b[64];
            std::snprintf(b, sizeof b, "encode failed (0x%08lX)", static_cast<unsigned long>(hr));
            err = b;
        }
    }
    rel(props);
    rel(fr);
    rel(enc);
    rel(st);
    if (err.empty()) {
        if (!::MoveFileExW(tmp.c_str(), final_path.c_str(), MOVEFILE_WRITE_THROUGH)) err = "could not rename the file";
    }
    if (!err.empty()) {
        ::DeleteFileW(tmp.c_str());
        return err;
    }
    WIN32_FILE_ATTRIBUTE_DATA fa{};
    if (::GetFileAttributesExW(final_path.c_str(), GetFileExInfoStandard, &fa))
        s.bytes = (static_cast<unsigned long long>(fa.nFileSizeHigh) << 32) | fa.nFileSizeLow;
    s.path = final_path;
    return {};
}

// 0 ok, 1 error (in *err), 2 fault. No C++ objects here, so SEH is allowed.
int encode_into(shot* s, IWICImagingFactory* wic, std::string* err) {
    *err = encode(*s, wic);
    return err->empty() ? 0 : 1;
}
int encode_seh(shot* s, IWICImagingFactory* wic, std::string* err) {
    __try {
        return encode_into(s, wic, err);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 2;
    }
}

DWORD WINAPI worker(void*) {
    const HRESULT co = ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IWICImagingFactory* wic = nullptr;
    if (FAILED(::CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic))))
        wic = nullptr;
    for (;;) {
        ::WaitForSingleObject(g_wake, INFINITE);
        if (g_stop) break;
        if (g_state.load() != GRABBED) continue;
        shot& s = g_shot;
        LARGE_INTEGER t0, t1;
        ::QueryPerformanceCounter(&t0);
        std::string err;
        if (!wic) err = "Windows Imaging Component is not available";
        else if (encode_seh(&s, wic, &err) == 2) err = "fault while encoding";
        ::QueryPerformanceCounter(&t1);
        s.encode_ms = qpc_ms(t0, t1);
        {
            std::lock_guard<std::mutex> lk(g_mu);
            s.ok = err.empty();
            if (!err.empty()) s.err = err;
        }
        g_state = ENCODED;
    }
    rel(wic);
    if (SUCCEEDED(co)) ::CoUninitialize();
    return 0;
}

// ------------------------------------------------------------------ the tick --
// Walk the engine's command list; link our node at the head when it is not in. Returns
// 0 already in, 1 linked now, 2 list empty (too early), 3 a foreign enw_screenshot, 4 fault.
int link_walk(int* count, uintptr_t* jpeg_fn) {
    __try {
        auto** head = reinterpret_cast<cmd_function_s**>(kCmdFunctions);
        if (!*head) return 2;
        int n = 0;
        for (cmd_function_s* c = *head; c && n < 8192; c = c->next, ++n) {
            if (c == &g_node) return 0;
            if (c->name && _stricmp(c->name, "enw_screenshot") == 0) return 3;
            if (c->name && _stricmp(c->name, "screenshotJpeg") == 0)
                *jpeg_fn = reinterpret_cast<uintptr_t>(c->function);
        }
        *count = n;
        g_node.next = *head;
        *head = &g_node;
        return 1;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 4;
    }
}

void link_command() {
    int n = 0;
    uintptr_t jpeg = 0;
    const int r = link_walk(&n, &jpeg);
    if (r == 1) {
        if (!g_node_linked)
            ENW_INFO("screenshot: 'enw_screenshot' linked into the command list (%d commands before it; the engine's "
                     "screenshotJpeg node %s, function 0x%08X)", n, jpeg ? "found" : "not registered yet",
                     static_cast<unsigned>(jpeg));
        else
            ENW_WARN("screenshot: 'enw_screenshot' had left the command list; linked again");
        g_node_linked = true;
    } else if (r == 3 && !g_node_linked) {
        ENW_WARN("screenshot: another 'enw_screenshot' command is registered; ours is not linked");
        g_node_linked = true;
    } else if (r == 4) {
        ENW_ERROR("screenshot: fault walking the command list at 0x%08X", static_cast<unsigned>(kCmdFunctions));
        g_node_linked = true;   // do not retry every frame
    }
}

void post_result() {
    shot& s = g_shot;
    std::string path, err;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        path = to_utf8(s.path);
        err = s.err;
    }
    if (s.ok) {
        ++g_shots;
        g_total_bytes += s.bytes;
        g_worst_grab = std::max(g_worst_grab, s.grab_ms);
        chat_notice::system_line("Screenshot saved");
        ENW_INFO("screenshot: saved %s (%ux%u%s%s, %.2f MB, %s) -- render thread %.2f ms at Present 1, at most %.2f ms at any later Present [%s], worker %.0f ms "
                 "(encode + write)%s%s",
                 path.c_str(), s.w, s.h, s.msaa ? ", MSAA resolved" : "", s.gamma ? ", fullscreen gamma applied" : "",
                 static_cast<double>(s.bytes) / (1024.0 * 1024.0),
                 s.fmt == sn::format::png ? "PNG" : "JPEG q95 4:4:4", s.ms_a, s.ms_b, s.steps, s.encode_ms,
                 err.empty() ? "" : "; note: ", err.c_str());
    } else {
        ++g_failed;
        chat_notice::system_line("Screenshot failed");
        ENW_WARN("screenshot: FAILED: %s (render thread %.2f + %.2f ms [%s])", err.c_str(), s.ms_a, s.ms_b, s.steps);
    }
}

void tick(uint64_t) {
    LARGE_INTEGER now;
    ::QueryPerformanceCounter(&now);
    if (g_last_tick.QuadPart) {
        const double p = qpc_ms(g_last_tick, now);
        std::memmove(g_periods + 1, g_periods, sizeof(double) * 63);
        g_periods[0] = p;
        if (g_period_n < 64) ++g_period_n;
        if (g_watch > 0) {
            char b[16];
            std::snprintf(b, sizeof b, "%s%.1f", g_after.empty() ? "" : " ", p);
            g_after += b;
            if (--g_watch == 0)
                ENW_INFO("screenshot: main-thread frame periods after the press: %s ms (median of the 60 before: %.1f ms)",
                         g_after.c_str(), g_baseline);
        }
    }
    g_last_tick = now;

    static uint64_t n = 0;
    if ((++n & 63) == 1 || !g_node_linked) link_command();

    const int st = g_state.load();
    if (st == REQUESTED) {
        if (!g_grab_queued.exchange(true) && !frame_capture::run_at_present(&grab_job)) g_grab_queued = false;
        if (::GetTickCount64() - g_requested_at > 3000) {
            // No Present in 3 s (a lost device, a minimised exclusive-fullscreen window). The queued job,
            // if it ever runs, sees the state and does nothing.
            g_state = IDLE;
            ++g_failed;
            ENW_WARN("screenshot: no frame was presented within 3 s -- nothing captured");
            chat_notice::system_line("Screenshot failed");
        }
    } else if (st == COPIED) {
        if (!g_b_queued.exchange(true) && !frame_capture::run_at_present(&grab_b_job)) g_b_queued = false;
        if (::GetTickCount64() - g_requested_at > 3000) {
            // Copied but never read back: give the surfaces back through the normal release path.
            g_shot.ok = false;
            g_shot.err = "no second frame was presented within 3 s";
            g_state = ENCODED;
        }
    } else if (st == IDLE && g_grab_failed.exchange(false)) {
        post_result();
    } else if (st == ENCODED) {
        if (!g_posted) {
            g_posted = true;
            post_result();
        }
        // The pixels go back to D3D on its own thread; the slot may be busy (stock_font): next tick.
        // (Flag first: the job can run on the render thread before run_at_present returns.)
        if (!g_release_queued.exchange(true) && !frame_capture::run_at_present(&release_job)) g_release_queued = false;
    }
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

bool stock_command_is(uintptr_t at, uint8_t push_arg) {
    uint8_t b[9] = {};
    if (!memory::read_raw(at, b, sizeof b)) return false;
    return b[0] == 0x6A && b[1] == push_arg && b[2] == 0xE8 && memory::call_target(at + 2) == kShotCmd && b[7] == 0x59 &&
           b[8] == 0xC3;
}

class screenshot_component final : public component {
public:
    const char* name() const override { return "screenshot"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        const char* off = std::getenv("ENW_SCREENSHOT");
        if (off && off[0] == '0' && !off[1]) {
            g_enabled = false;
            ENW_WARN("screenshot: OFF (ENW_SCREENSHOT=0) -- F12 is World at War's own screenshot again");
            return;
        }
        ::QueryPerformanceFrequency(&g_qpf);
        const char* stock = std::getenv("ENW_SCREENSHOT_STOCK");
        if (stock && stock[0] == '1') {
            ENW_WARN("screenshot: ENW_SCREENSHOT_STOCK=1 (harness) -- the engine's screenshot/screenshotJpeg stay the "
                     "engine's; only enw_screenshot is ours");
            return;
        }
        if (!stock_command_is(kStockShot, 0x01) || !stock_command_is(kStockShotJpeg, 0x00)) {
            ENW_ERROR("screenshot: the engine's screenshot commands are not the expected bytes (%s / %s) -- left alone",
                      memory::hex_dump(kStockShot, 9).c_str(), memory::hex_dump(kStockShotJpeg, 9).c_str());
            return;
        }
        if (!memory::write_jmp(kStockShot, reinterpret_cast<const void*>(&cmd_stock_screenshot)) ||
            !memory::write_jmp(kStockShotJpeg, reinterpret_cast<const void*>(&cmd_stock_screenshot_jpeg))) {
            ENW_ERROR("screenshot: could not redirect the engine's screenshot commands");
            return;
        }
        g_stock_patched = true;
        ENW_INFO("screenshot: the engine's `screenshot` (0x%08X) and `screenshotJpeg` (0x%08X) now take ENW's screenshot "
                 "-- the stock writer (hunk, Documents) is unreachable",
                 static_cast<unsigned>(kStockShot), static_cast<unsigned>(kStockShotJpeg));
    }

    void post_init() override {
        if (!g_enabled) return;
        g_wake = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
        g_worker = g_wake ? ::CreateThread(nullptr, 0, &worker, nullptr, 0, nullptr) : nullptr;
        if (!g_worker) {
            ENW_ERROR("screenshot: no worker thread -- OFF");
            g_enabled = false;
            return;
        }
        frame::subscribe("screenshot", &tick);
        const std::wstring dir = shots_dir();
        std::string f;
        if (const char* e = std::getenv("ENW_SCREENSHOT_FORMAT")) f = e;
        ENW_INFO("screenshot: ready -- `enw_screenshot` (bind F12) saves %s to %s", sn::ext(sn::parse_format(f)),
                 dir.empty() ? "(no Pictures folder!)" : to_utf8(dir).c_str());
    }

    void pre_destroy() override {
        if (!g_enabled) return;
        if (g_shots || g_failed || g_limited || g_busy)
            ENW_INFO("screenshot: session: %ld saved (%.1f MB), %ld failed, %ld too fast, %ld while busy; worst render-thread "
                     "grab %.2f ms", g_shots, static_cast<double>(g_total_bytes) / (1024.0 * 1024.0), g_failed, g_limited,
                     g_busy, g_worst_grab);
        g_stop = true;
        if (g_wake) ::SetEvent(g_wake);
    }
};

ENW_REGISTER_COMPONENT(screenshot_component)

}  // namespace
}  // namespace screenshot
}  // namespace enw::client
