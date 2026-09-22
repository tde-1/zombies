// A dedicated server must never sit behind a modal MessageBox.
//
// THE INCIDENT (2026-09-22 19:07, zombies-dev). A fresh instance booted 2 s after
// another was retired raised "Set Optimal Settings?" and the main thread never reached
// the frame loop (frames=0 for 160 s) while a player dialled it. Nobody can see a
// dialog under Xvfb; `xdotool key Escape` freed it instantly.
//
// THE CALL SITE (decrypted 1.7 image, tools/re/t4map.py):
//   0x59C7C0  if com_recommendedSet (dvar ptr 0x1F96490) is set, call 0x59BCE0;
//             `test al,al; je` -> a FALSE return SKIPS applying configure.csv.
//   0x59BCE0  checksum = (hash of configure.csv bytes & 0x0FFFFFFF) + 1, -> 0x5FE410
//   0x5FE410  if saved sys_configSum != 0 and != checksum, ask 0x5FE250; then store
//             the new checksum into sys_configSum either way.
//   0x5FE250  MessageBoxA(GetActiveWindow(), WIN_CONFIGURE_UPDATED_BODY,
//             WIN_CONFIGURE_UPDATED_TITLE, 0x44 = MB_YESNO|MB_ICONINFORMATION);
//             returns (result == IDYES).
// So IDNO = "keep the saved settings": the recommended set is not applied, the new
// checksum is stored, and startup carries on. That is the answer we give.
//
// THE HOOK. CoDWaW.exe imports MessageBoxA by name (IAT 0x7EB33C, 11 call sites), so
// an IAT hook catches every engine dialog -- the same shape as no_winconsole.cpp. It
// does NOT import MessageBoxW; we try it anyway and say so. Every box is logged
// (caption, text, flags) and answered with the button that keeps the process moving:
//   YESNO / YESNOCANCEL -> IDNO     OKCANCEL / RETRYCANCEL -> IDCANCEL
//   ABORTRETRYIGNORE    -> IDIGNORE CANCELTRYCONTINUE      -> IDCONTINUE
//   OK                  -> IDOK (a fatal-error box then lets the process exit, which
//                          the host agent sees and replaces -- better than a hang)
//
// DEDICATED ONLY: the command line must carry `dedicated 1` or `2` (decided in
// post_load; the engine's own dvar does not exist yet). A player's client keeps its
// dialogs. Off-switch: ENW_NO_MSGBOX_HOOK=1.
//
// Clean room: our own code.

#include "component.hpp"
#include "game_link.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>

#include <cstring>
#include <string>

namespace enw::dedi {
namespace {

using MessageBoxA_t = int(__stdcall*)(HWND, LPCSTR, LPCSTR, UINT);
using MessageBoxW_t = int(__stdcall*)(HWND, LPCWSTR, LPCWSTR, UINT);
MessageBoxA_t g_orig_a = nullptr;
MessageBoxW_t g_orig_w = nullptr;
volatile LONG g_answered = 0;

std::string env(const char* name) {
    char buf[64]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}

bool cmdline_dedicated() {
    const char* cmd = ::GetCommandLineA();
    if (!cmd) return false;
    const char* p = cmd;
    while ((p = std::strstr(p, "dedicated")) != nullptr) {
        p += 9;
        while (*p == ' ' || *p == '\t' || *p == '"') ++p;
        if (*p == '1' || *p == '2') return true;
    }
    return false;
}

int answer_for(UINT flags) {
    switch (flags & MB_TYPEMASK) {
        case MB_YESNO:
        case MB_YESNOCANCEL: return IDNO;
        case MB_OKCANCEL:
        case MB_RETRYCANCEL: return IDCANCEL;
        case MB_ABORTRETRYIGNORE: return IDIGNORE;
        case MB_CANCELTRYCONTINUE: return IDCONTINUE;
        default: return IDOK;
    }
}

const char* answer_name(int id) {
    switch (id) {
        case IDNO: return "No";
        case IDCANCEL: return "Cancel";
        case IDIGNORE: return "Ignore";
        case IDCONTINUE: return "Continue";
        default: return "OK";
    }
}

void report(const char* caption, const char* text, UINT flags, int id) {
    ::InterlockedIncrement(&g_answered);
    ENW_WARN("no_msgbox: answered MessageBox '%s' / '%s' (flags 0x%X) with %s",
             caption ? caption : "", text ? text : "", flags, answer_name(id));
    game_link::get().send_log("warn", "MessageBox '%s' answered %s (%s)", caption ? caption : "",
                              answer_name(id), text ? text : "");
}

int __stdcall message_box_a(HWND, LPCSTR text, LPCSTR caption, UINT flags) {
    const int id = answer_for(flags);
    report(caption, text, flags, id);
    return id;
}

std::string narrow(LPCWSTR w) {
    if (!w) return {};
    const int n = ::WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string s(static_cast<size_t>(n - 1), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
    return s;
}

int __stdcall message_box_w(HWND, LPCWSTR text, LPCWSTR caption, UINT flags) {
    const int id = answer_for(flags);
    report(narrow(caption).c_str(), narrow(text).c_str(), flags, id);
    return id;
}

class no_msgbox final : public component {
public:
    const char* name() const override { return "no_msgbox"; }

    void post_load() override {
        if (env("ENW_NO_MSGBOX_HOOK") == "1") {
            ENW_INFO("no_msgbox: off by request (ENW_NO_MSGBOX_HOOK=1)");
            return;
        }
        if (!cmdline_dedicated()) {
            ENW_DEBUG("no_msgbox: not a dedicated server; dialogs left alone");
            return;
        }
        const bool a = memory::hook_import("USER32.dll", "MessageBoxA",
                                           reinterpret_cast<void*>(&message_box_a),
                                           reinterpret_cast<void**>(&g_orig_a));
        const bool w = memory::hook_import("USER32.dll", "MessageBoxW",
                                           reinterpret_cast<void*>(&message_box_w),
                                           reinterpret_cast<void**>(&g_orig_w));
        if (!a) {
            ENW_ERROR("no_msgbox: could not patch MessageBoxA; an engine dialog will block the "
                      "main thread (host agent Escape belt is the fallback)");
            return;
        }
        ENW_INFO("no_msgbox: armed (MessageBoxA hooked, MessageBoxW %s). Engine dialogs are "
                 "logged and auto-answered; 'Set Optimal Settings?' gets No = keep saved settings.",
                 w ? "hooked" : "not imported");
    }

    void post_init() override {
        const LONG n = ::InterlockedCompareExchange(&g_answered, 0, 0);
        if (n) ENW_INFO("no_msgbox: %ld dialog(s) auto-answered during init", n);
    }
};

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::no_msgbox)
