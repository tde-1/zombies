// rawprobe: a 32-bit harness that answers two questions without the game.
//
//   1. Does SendInput(MOUSEEVENTF_MOVE) at 1000 Hz reach the raw-input stream
//      (WM_INPUT / GetRawInputBuffer) of a window registered with RIDEV_INPUTSINK?
//   2. In a WOW64 (32-bit on 64-bit Windows) process, where does GetRawInputBuffer
//      put the RAWMOUSE -- at the 32-bit RAWINPUTHEADER size (16) or at the
//      64-bit one (24)? Microsoft's GetRawInputBuffer page says to align RAWINPUT
//      by 8 on WOW64 and shows `[FieldOffset(16+8)] RAWMOUSE mouse`; SDL3's
//      WIN_PollRawInput adds 8 to the header size when IsWow64Process is true.
//      mouse_polling.cpp's drain_raw_buffer() read `ri->data.mouse` at 16.
//
// Every injected move carries dwExtraInfo = 0xE17Exxxx, so the RAWMOUSE offset is
// PROVEN by where ulExtraInformation reads back as that marker, not guessed.
// Moves alternate +1/-1 so the cursor ends where it started. The window is never
// shown. Usage: rawprobe [seconds=3] [hz=1000] [mode=buffer|message]
#include <windows.h>
#include <mmsystem.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "../../client-dll/components/raw_buffer.hpp"

namespace {
volatile LONG g_stop = 0;
volatile LONG g_sent = 0;
int g_hz = 1000;

DWORD WINAPI injector(LPVOID) {
    ::timeBeginPeriod(1);
    LARGE_INTEGER f, t0, now;
    ::QueryPerformanceFrequency(&f);
    ::QueryPerformanceCounter(&t0);
    const double period = static_cast<double>(f.QuadPart) / g_hz;
    long n = 0;
    while (!g_stop) {
        ::QueryPerformanceCounter(&now);
        const long due = static_cast<long>((now.QuadPart - t0.QuadPart) / period);
        while (n < due && !g_stop) {
            INPUT in = {};
            in.type = INPUT_MOUSE;
            in.mi.dx = (n & 1) ? -1 : 1;
            in.mi.dwFlags = MOUSEEVENTF_MOVE;
            in.mi.dwExtraInfo = 0xE17E0000u | (static_cast<unsigned>(n) & 0xFFFF);
            if (::SendInput(1, &in, sizeof in) == 1) ::InterlockedIncrement(&g_sent);
            ++n;
        }
        ::Sleep(0);
    }
    return 0;
}

long g_msg_reports = 0, g_msg_marker = 0;
LRESULT CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_INPUT) {
        RAWINPUT ri = {};
        UINT sz = sizeof ri;
        if (::GetRawInputData(reinterpret_cast<HRAWINPUT>(l), RID_INPUT, &ri, &sz,
                              sizeof(RAWINPUTHEADER)) != static_cast<UINT>(-1) &&
            ri.header.dwType == RIM_TYPEMOUSE) {
            ++g_msg_reports;
            if ((ri.data.mouse.ulExtraInformation & 0xFFFF0000u) == 0xE17E0000u) ++g_msg_marker;
        }
    }
    return ::DefWindowProcA(h, m, w, l);
}
}  // namespace

// `rawprobe inject <secs> <hz> [block]`: the synthetic mouse for mousebench.ps1.
// dx = +1 for `block` reports, then -1 for `block`, so each frame sees a steady
// turn and the cursor ends where it began. No window, no raw registration.
int inject_only(int secs, int hz, int block) {
    ::timeBeginPeriod(1);
    LARGE_INTEGER f, t0, now;
    ::QueryPerformanceFrequency(&f);
    ::QueryPerformanceCounter(&t0);
    const double period = static_cast<double>(f.QuadPart) / hz;
    const long total = static_cast<long>(secs) * hz;
    long n = 0, ok = 0;
    while (n < total) {
        ::QueryPerformanceCounter(&now);
        const long due = static_cast<long>((now.QuadPart - t0.QuadPart) / period);
        while (n < due && n < total) {
            INPUT in = {};
            in.type = INPUT_MOUSE;
            in.mi.dx = ((n / block) & 1) ? -1 : 1;
            in.mi.dwFlags = MOUSEEVENTF_MOVE;
            in.mi.dwExtraInfo = 0xE17E0000u | (static_cast<unsigned>(n) & 0xFFFF);
            if (::SendInput(1, &in, sizeof in) == 1) ++ok;
            ++n;
        }
        ::Sleep(0);
    }
    ::QueryPerformanceCounter(&now);
    const double el = static_cast<double>(now.QuadPart - t0.QuadPart) / f.QuadPart;
    std::printf("inject: %ld moves sent (|dx|=1 each) in %.2f s = %.0f Hz\n", ok, el, ok / el);
    return 0;
}

int main(int argc, char** argv) {
    if (argc > 1 && std::strcmp(argv[1], "inject") == 0)
        return inject_only(argc > 2 ? std::atoi(argv[2]) : 30, argc > 3 ? std::atoi(argv[3]) : 1000,
                           argc > 4 ? std::atoi(argv[4]) : 1000);
    const int secs = argc > 1 ? std::atoi(argv[1]) : 3;
    g_hz = argc > 2 ? std::atoi(argv[2]) : 1000;
    const bool buffer_mode = !(argc > 3 && std::strcmp(argv[3], "message") == 0);

    BOOL wow = FALSE;
    ::IsWow64Process(::GetCurrentProcess(), &wow);
    std::printf("rawprobe: sizeof(void*)=%u sizeof(RAWINPUTHEADER)=%u WOW64=%d, %d Hz for %d s, "
                "mode=%s\n",
                static_cast<unsigned>(sizeof(void*)), static_cast<unsigned>(sizeof(RAWINPUTHEADER)),
                wow, g_hz, secs, buffer_mode ? "buffer" : "message");

    WNDCLASSA wc = {};
    wc.lpfnWndProc = proc;
    wc.hInstance = ::GetModuleHandleA(nullptr);
    wc.lpszClassName = "enw_rawprobe";
    ::RegisterClassA(&wc);
    HWND hwnd = ::CreateWindowExA(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, wc.lpszClassName, "rawprobe",
                                  WS_POPUP, -4000, -4000, 16, 16, nullptr, nullptr, wc.hInstance,
                                  nullptr);  // never shown
    RAWINPUTDEVICE rid = {0x01, 0x02, RIDEV_INPUTSINK, hwnd};
    if (!::RegisterRawInputDevices(&rid, 1, sizeof rid)) {
        std::printf("RegisterRawInputDevices failed %lu\n", ::GetLastError());
        return 2;
    }

    HANDLE th = ::CreateThread(nullptr, 0, injector, nullptr, 0, nullptr);
    ::timeBeginPeriod(1);
    const DWORD end = ::GetTickCount() + static_cast<DWORD>(secs) * 1000;

    static BYTE buf[512 * 48];
    long buf_reports = 0, at16_marker = 0, at24_marker = 0, at_helper_marker = 0;
    long sum16 = 0, sum24 = 0, sum_helper = 0, calls = 0;
    const unsigned helper_off = enw::rawbuf::mouse_offset();
    while (::GetTickCount() < end) {
        if (buffer_mode) {
            // Read the queued reports BEFORE pumping, so the buffer path carries
            // (nearly) all of them -- the way a once-a-frame bulk read would.
            for (;;) {
                UINT size = sizeof buf;
                const UINT n = ::GetRawInputBuffer(reinterpret_cast<PRAWINPUT>(buf), &size,
                                                   sizeof(RAWINPUTHEADER));
                if (n == 0 || n == static_cast<UINT>(-1)) break;
                ++calls;
                PRAWINPUT ri = reinterpret_cast<PRAWINPUT>(buf);
                for (UINT i = 0; i < n; ++i) {
                    if (ri->header.dwType == RIM_TYPEMOUSE) {
                        ++buf_reports;
                        const auto* m16 = reinterpret_cast<const RAWMOUSE*>(
                            reinterpret_cast<const BYTE*>(ri) + 16);
                        const auto* m24 = reinterpret_cast<const RAWMOUSE*>(
                            reinterpret_cast<const BYTE*>(ri) + 24);
                        const auto* mh = enw::rawbuf::mouse_of(ri, helper_off);
                        if ((m16->ulExtraInformation & 0xFFFF0000u) == 0xE17E0000u) ++at16_marker;
                        if ((m24->ulExtraInformation & 0xFFFF0000u) == 0xE17E0000u) ++at24_marker;
                        if ((mh->ulExtraInformation & 0xFFFF0000u) == 0xE17E0000u)
                            ++at_helper_marker;
                        if (buf_reports <= 3) {
                            std::printf("  block %ld dwSize=%lu bytes:", buf_reports,
                                        ri->header.dwSize);
                            for (unsigned b = 0; b < ri->header.dwSize && b < 48; ++b)
                                std::printf("%s%02X", (b % 4) ? "" : " ",
                                            reinterpret_cast<const BYTE*>(ri)[b]);
                            std::printf("\n    @16: lLastX=%ld lLastY=%ld btnFlags=0x%04X | "
                                        "@24: lLastX=%ld lLastY=%ld btnFlags=0x%04X\n",
                                        m16->lLastX, m16->lLastY, m16->usButtonFlags, m24->lLastX,
                                        m24->lLastY, m24->usButtonFlags);
                        }
                        sum16 += labs(m16->lLastX);
                        sum24 += labs(m24->lLastX);
                        sum_helper += labs(mh->lLastX);
                    }
                    ri = NEXTRAWINPUTBLOCK(ri);
                }
            }
        }
        MSG msg;
        while (::PeekMessageA(&msg, nullptr, 0, 0, PM_REMOVE)) ::DispatchMessageA(&msg);
        ::Sleep(4);  // a 250 fps "frame"
    }
    g_stop = 1;
    ::WaitForSingleObject(th, 2000);
    MSG msg;
    while (::PeekMessageA(&msg, nullptr, 0, 0, PM_REMOVE)) ::DispatchMessageA(&msg);

    std::printf("injected %ld moves (|dx|=1 each)\n", g_sent);
    std::printf("WM_INPUT via GetRawInputData: %ld reports, %ld carry the marker\n", g_msg_reports,
                g_msg_marker);
    if (buffer_mode) {
        std::printf("GetRawInputBuffer: %ld calls, %ld reports\n", calls, buf_reports);
        std::printf("  RAWMOUSE at +16 (32-bit header): marker %ld/%ld, sum|dx| %ld\n", at16_marker,
                    buf_reports, sum16);
        std::printf("  RAWMOUSE at +24 (64-bit header): marker %ld/%ld, sum|dx| %ld\n", at24_marker,
                    buf_reports, sum24);
        std::printf("  rawbuf::mouse_offset()=%u        : marker %ld/%ld, sum|dx| %ld\n", helper_off,
                    at_helper_marker, buf_reports, sum_helper);
    }
    return 0;
}
