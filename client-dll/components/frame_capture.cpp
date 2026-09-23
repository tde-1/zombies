// frame_capture: a test instrument that saves the frame the player actually sees.
//
// OFF unless ENW_FRAME_CAPTURE=1 or ENW_CHAT_SELFTEST is set. Nothing is patched
// until the first capture is asked for.
//
// Why it exists (2026-09-22, chat overlay): the engine's own `screenshotJPEG`
// refuses with "cannot take screenshot: game window is partially off-screen",
// and dev launches park the window at -4000,-4000 so they never appear on B's
// desktop. A picture of the game is the only acceptable evidence that something
// was drawn (chat-overlay.md §2's second signal), and it must work in exclusive
// fullscreen too, where nothing outside the process can see the frame.
//
// How: dx.device is [0x3BF3B08] -- the out-pointer of R_CreateDevice's
// IDirect3D9::CreateDevice call at 0x6D605A (vtable +0x40; the IDirect3D9 is
// [0x3BF3B04], stored straight from the Direct3DCreate9 wrapper 0x75A9A8 at
// 0x6D62C2). On a request we swap IDirect3DDevice9::Present (vtable slot 17) for
// ours, which copies the back buffer into system memory and writes a .bmp BEFORE
// calling the real Present -- so it is exactly the frame that goes to the screen,
// on whichever thread presents. The slot is put back after the last pending
// capture. A vtable slot, not a MinHook detour: no code bytes are touched.
#include "component.hpp"
#include "logger.hpp"

#include <windows.h>
#include <d3d9.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>

namespace enw::client::frame_capture {
namespace {

constexpr uintptr_t kDxDevice = 0x3BF3B08;
constexpr int kPresentSlot = 17;

using present_t = HRESULT(__stdcall*)(IDirect3DDevice9*, const RECT*, const RECT*, HWND,
                                      const RGNDATA*);
present_t g_real_present = nullptr;
void** g_vtbl = nullptr;
// T4 presents through a swap chain (IW engines keep one per window), so the
// swap chain's own Present (IDirect3DSwapChain9 slot 3) is patched as well.
using sc_present_t = HRESULT(__stdcall*)(IDirect3DSwapChain9*, const RECT*, const RECT*, HWND,
                                         const RGNDATA*, DWORD);
sc_present_t g_real_sc_present = nullptr;
void** g_sc_vtbl = nullptr;
constexpr int kScPresentSlot = 3;
IDirect3DDevice9* g_dev = nullptr;
std::mutex g_mu;
std::string g_pending;          // name of the next capture, empty = none
std::string g_dir;
std::atomic<long> g_done{0};
bool g_allowed = false;

bool write_bmp(const std::string& path, const uint8_t* bits, int pitch, int w, int h) {
    FILE* f = nullptr;
    if (fopen_s(&f, path.c_str(), "wb") != 0 || !f) return false;
    const int row = w * 3;
    const int pad = (4 - row % 4) % 4;
    BITMAPFILEHEADER bf{};
    BITMAPINFOHEADER bi{};
    bi.biSize = sizeof bi;
    bi.biWidth = w;
    bi.biHeight = h;  // bottom-up
    bi.biPlanes = 1;
    bi.biBitCount = 24;
    bi.biSizeImage = static_cast<DWORD>((row + pad) * h);
    bf.bfType = 0x4D42;
    bf.bfOffBits = sizeof bf + sizeof bi;
    bf.bfSize = bf.bfOffBits + bi.biSizeImage;
    fwrite(&bf, sizeof bf, 1, f);
    fwrite(&bi, sizeof bi, 1, f);
    std::string line(static_cast<size_t>(row + pad), '\0');
    for (int y = h - 1; y >= 0; --y) {
        const uint8_t* src = bits + static_cast<size_t>(y) * pitch;
        for (int x = 0; x < w; ++x) {  // X8R8G8B8 / A8R8G8B8: B,G,R,X in memory
            line[x * 3 + 0] = static_cast<char>(src[x * 4 + 0]);
            line[x * 3 + 1] = static_cast<char>(src[x * 4 + 1]);
            line[x * 3 + 2] = static_cast<char>(src[x * 4 + 2]);
        }
        fwrite(line.data(), 1, line.size(), f);
    }
    fclose(f);
    return true;
}

void capture(IDirect3DDevice9* dev, const char* name);

// Work that must run on the thread that owns the D3D device (the one that
// presents): stock_font creates its texture here. One slot is enough.
using device_job = void (*)(IDirect3DDevice9*);
std::atomic<device_job> g_job{nullptr};

void run_job_seh(IDirect3DDevice9* dev) {
    device_job j = g_job.exchange(nullptr);
    if (!j) return;
    __try {
        j(dev);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ENW_ERROR("frame_capture: fault 0x%08lX in a device job", GetExceptionCode());
    }
}

void capture_seh(IDirect3DDevice9* dev, const char* name) {
    __try {
        capture(dev, name);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ENW_ERROR("frame_capture: fault 0x%08lX while capturing", GetExceptionCode());
    }
}

void capture(IDirect3DDevice9* dev, const char* name) {
    IDirect3DSurface9* bb = nullptr;
    if (FAILED(dev->GetBackBuffer(0, 0, D3DBACKBUFFER_TYPE_MONO, &bb)) || !bb) {
        ENW_WARN("frame_capture: GetBackBuffer failed");
        return;
    }
    D3DSURFACE_DESC d{};
    bb->GetDesc(&d);
    IDirect3DSurface9* src = bb;
    IDirect3DSurface9* resolved = nullptr;
    if (d.MultiSampleType != D3DMULTISAMPLE_NONE) {
        if (SUCCEEDED(dev->CreateRenderTarget(d.Width, d.Height, d.Format, D3DMULTISAMPLE_NONE, 0,
                                              FALSE, &resolved, nullptr)) &&
            SUCCEEDED(dev->StretchRect(bb, nullptr, resolved, nullptr, D3DTEXF_NONE)))
            src = resolved;
    }
    IDirect3DSurface9* sys = nullptr;
    bool ok = false;
    if (SUCCEEDED(dev->CreateOffscreenPlainSurface(d.Width, d.Height, d.Format, D3DPOOL_SYSTEMMEM,
                                                   &sys, nullptr)) &&
        SUCCEEDED(dev->GetRenderTargetData(src, sys))) {
        D3DLOCKED_RECT lr{};
        if (SUCCEEDED(sys->LockRect(&lr, nullptr, D3DLOCK_READONLY))) {
            char stamp[32];
            SYSTEMTIME t;
            ::GetLocalTime(&t);
            std::snprintf(stamp, sizeof stamp, "%02d%02d%02d", t.wHour, t.wMinute, t.wSecond);
            const std::string path = g_dir + "\\enwshot-" + stamp + "-" + std::string(name) + ".bmp";
            ok = (d.Format == D3DFMT_X8R8G8B8 || d.Format == D3DFMT_A8R8G8B8) &&
                 write_bmp(path, static_cast<const uint8_t*>(lr.pBits), lr.Pitch,
                           static_cast<int>(d.Width), static_cast<int>(d.Height));
            sys->UnlockRect();
            if (ok)
                ENW_INFO("frame_capture: '%s' -> %s (%ux%u back buffer, format %u)", name,
                         path.c_str(), d.Width, d.Height, static_cast<unsigned>(d.Format));
        }
    }
    if (!ok) ENW_WARN("frame_capture: '%s' failed (format %u)", name,
                      static_cast<unsigned>(d.Format));
    if (sys) sys->Release();
    if (resolved) resolved->Release();
    bb->Release();
    ++g_done;
}

HRESULT __stdcall present_hook(IDirect3DDevice9* dev, const RECT* a, const RECT* b, HWND c,
                               const RGNDATA* e) {
    std::string name;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        name.swap(g_pending);
    }
    if (!name.empty()) capture_seh(dev, name.c_str());
    run_job_seh(dev);
    return g_real_present(dev, a, b, c, e);
}

HRESULT __stdcall sc_present_hook(IDirect3DSwapChain9* sc, const RECT* a, const RECT* b, HWND c,
                                  const RGNDATA* e, DWORD f) {
    std::string name;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        name.swap(g_pending);
    }
    // The swap chain's OWN device, not the one cached at install: `vid_restart` destroys
    // the device and makes a new one (esc-menu.md §9). The vtable slots are per class in
    // d3d9.dll, so this hook survives the restart; a cached device pointer would not.
    IDirect3DDevice9* dev = nullptr;
    if (FAILED(sc->GetDevice(&dev))) dev = nullptr;
    if (dev) {
        if (!name.empty()) capture_seh(dev, name.c_str());
        run_job_seh(dev);
        dev->Release();
    }
    return g_real_sc_present(sc, a, b, c, e, f);
}

bool patch_slot(void** vtbl, int slot, void* fn, void** old_fn) {
    DWORD old = 0;
    if (!::VirtualProtect(&vtbl[slot], sizeof(void*), PAGE_READWRITE, &old)) return false;
    if (old_fn) *old_fn = vtbl[slot];
    vtbl[slot] = fn;
    ::VirtualProtect(&vtbl[slot], sizeof(void*), old, &old);
    return true;
}

bool install() {
    if (g_vtbl) return true;
    auto* dev = *reinterpret_cast<IDirect3DDevice9* volatile*>(kDxDevice);
    if (!dev) {
        ENW_WARN("frame_capture: dx.device [0x%08X] is null", static_cast<unsigned>(kDxDevice));
        return false;
    }
    void** vtbl = *reinterpret_cast<void***>(dev);
    DWORD old = 0;
    if (!::VirtualProtect(&vtbl[kPresentSlot], sizeof(void*), PAGE_READWRITE, &old)) {
        ENW_WARN("frame_capture: VirtualProtect on the vtable failed (%lu)", ::GetLastError());
        return false;
    }
    g_real_present = reinterpret_cast<present_t>(vtbl[kPresentSlot]);
    vtbl[kPresentSlot] = reinterpret_cast<void*>(&present_hook);
    ::VirtualProtect(&vtbl[kPresentSlot], sizeof(void*), old, &old);
    g_vtbl = vtbl;
    g_dev = dev;
    IDirect3DSwapChain9* sc = nullptr;
    if (SUCCEEDED(dev->GetSwapChain(0, &sc)) && sc) {
        void** sv = *reinterpret_cast<void***>(sc);
        void* old_fn = nullptr;
        if (patch_slot(sv, kScPresentSlot, reinterpret_cast<void*>(&sc_present_hook), &old_fn)) {
            g_real_sc_present = reinterpret_cast<sc_present_t>(old_fn);
            g_sc_vtbl = sv;
        }
        sc->Release();
    }
    ENW_INFO("frame_capture: IDirect3DDevice9::Present (vtable slot %d of device 0x%p) now "
             "saves requested frames to %s; swap chain Present %s", kPresentSlot,
             static_cast<void*>(dev), g_dir.c_str(), g_sc_vtbl ? "patched too" : "NOT patched");
    return true;
}

void uninstall() {
    if (!g_vtbl || !g_real_present) return;
    DWORD old = 0;
    if (::VirtualProtect(&g_vtbl[kPresentSlot], sizeof(void*), PAGE_READWRITE, &old)) {
        g_vtbl[kPresentSlot] = reinterpret_cast<void*>(g_real_present);
        ::VirtualProtect(&g_vtbl[kPresentSlot], sizeof(void*), old, &old);
    }
    g_vtbl = nullptr;
    if (g_sc_vtbl && g_real_sc_present)
        patch_slot(g_sc_vtbl, kScPresentSlot, reinterpret_cast<void*>(g_real_sc_present), nullptr);
    g_sc_vtbl = nullptr;
}

class frame_capture_component final : public component {
public:
    const char* name() const override { return "frame_capture"; }
    void post_load() override {
        const char* a = std::getenv("ENW_FRAME_CAPTURE");
        const char* b = std::getenv("ENW_CHAT_SELFTEST");
        g_allowed = (a && a[0] && a[0] != '0') || (b && b[0] && b[0] != '0');
        if (const char* d = std::getenv("ENW_FRAME_CAPTURE_DIR"); d && d[0]) g_dir = d;
        else if (const char* l = std::getenv("ENW_LOGDIR"); l && l[0]) g_dir = l;
        else g_dir = ".";
        if (g_allowed) ENW_INFO("frame_capture: armed; frames go to %s", g_dir.c_str());
    }
    void pre_destroy() override { uninstall(); }
};

ENW_REGISTER_COMPONENT(frame_capture_component)

}  // namespace

// Run `fn` once, on the device's own thread, just before the next Present. Not
// gated on the capture switch: this is how stock_font makes its texture. False
// while the device is not up yet (ask again next frame).
bool run_at_present(void (*fn)(IDirect3DDevice9*)) {
    if (!install()) return false;
    device_job expected = nullptr;
    return g_job.compare_exchange_strong(expected, fn);
}

// Main thread. Returns false when the instrument is off or the device is not up.
bool request(const char* name) {
    if (!g_allowed) {
        ENW_WARN("frame_capture: not armed (ENW_FRAME_CAPTURE / ENW_CHAT_SELFTEST unset)");
        return false;
    }
    if (!install()) return false;
    std::lock_guard<std::mutex> lk(g_mu);
    g_pending = name ? name : "frame";
    return true;
}

}  // namespace enw::client::frame_capture
