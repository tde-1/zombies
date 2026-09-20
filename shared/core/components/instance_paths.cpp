// Per-instance user data: giving each game its own profile directory.
//
// THE PROBLEM. `+set fs_homepath <dir>` only moves `main/`. The profile stays at
// `%LOCALAPPDATA%\Activision\CoDWaW\players`, so every instance on a box shares
// one profile, one `mods/` folder and one `__CoDWaW` single-instance marker.
// Several games per machine is in the cost model, so this has to be solved.
// Setting the LOCALAPPDATA environment variable does not work (`dedi` tested it):
// the engine resolves the folder with SHGetFolderPathA, which reads the shell's
// own state, not the environment.
//
// THE FIX. CoDWaW.exe imports `SHGetFolderPathA` from SHELL32 (confirmed in the
// import table) and appends the literal `\Activision\CoDWaW` to whatever it
// returns (the string is at 0x47EC90). So we replace that one import-table entry
// and hand back a per-instance directory for the AppData CSIDLs. The engine then
// builds `<ours>\Activision\CoDWaW\players\...` on its own and everything --
// profile, mods, the `__CoDWaW` marker -- becomes per-instance.
//
// WHY AN IAT PATCH AND NOT A DETOUR. The IAT lives in `.rdata`, which SteamStub
// does not encrypt, and the loader fills it before the PE entry point runs. So
// this can be installed in `post_load`, BEFORE the game's code is decrypted and
// before any engine code executes. That matters: the profile path is resolved
// during very early init, quite possibly before `post_unpack`. It is also a
// single pointer write, trivially reversible, with no prologue to relocate.
//
// STATUS: off by default (`ENW_PRIVATE_PROFILE=1` to enable) and NOT YET PROVEN
// END TO END, because until the startup dialogs were being dismissed no run ever
// reached a state where the profile mattered. See docs/kickstart/foundation.md
// for how much of this is measured and how much is reasoned.
#include "../component.hpp"

#include "../logger.hpp"
#include "../memory.hpp"

#include <shlobj.h>

namespace enw {
namespace {

using SHGetFolderPathA_t = HRESULT(__stdcall*)(HWND, int, HANDLE, DWORD, LPSTR);

SHGetFolderPathA_t g_original = nullptr;
char g_redirect[MAX_PATH]{};
volatile LONG g_hits = 0;

std::string env(const char* name) {
    char buf[MAX_PATH]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}

// Create every level of a path. The engine will happily fail quietly if the
// directory it is handed does not exist.
void make_tree(const char* path) {
    std::string p(path);
    for (size_t i = 3; i <= p.size(); ++i) {
        if (i == p.size() || p[i] == '\\' || p[i] == '/') {
            const std::string part = p.substr(0, i);
            ::CreateDirectoryA(part.c_str(), nullptr);
        }
    }
}

bool is_appdata(int csidl) {
    // Strip CSIDL_FLAG_CREATE / _DONT_VERIFY etc. before comparing.
    const int id = csidl & 0xFF;
    return id == (CSIDL_LOCAL_APPDATA & 0xFF) || id == (CSIDL_APPDATA & 0xFF);
}

HRESULT __stdcall shgetfolderpath_detour(HWND hwnd, int csidl, HANDLE token, DWORD flags,
                                         LPSTR out) {
    if (out && g_redirect[0] && is_appdata(csidl)) {
        ::InterlockedIncrement(&g_hits);
        // The caller's buffer is documented as MAX_PATH.
        strcpy_s(out, MAX_PATH, g_redirect);
        return S_OK;
    }
    if (!g_original) return E_FAIL;
    return g_original(hwnd, csidl, token, flags, out);
}

class instance_paths final : public component {
public:
    const char* name() const override { return "instance_paths"; }

    void post_load() override {
        // Opt-in: redirecting to an empty directory means no profile, which
        // brings its own first-run flow. launch.ps1 seeds the directory first.
        if (env("ENW_PRIVATE_PROFILE") != "1") {
            ENW_DEBUG("instance_paths: off (set ENW_PRIVATE_PROFILE=1 to enable)");
            return;
        }

        std::string dir = env("ENW_INSTANCE_APPDATA");
        if (dir.empty()) {
            ENW_ERROR("instance_paths: ENW_PRIVATE_PROFILE=1 but ENW_INSTANCE_APPDATA is unset; "
                      "not redirecting. launch.ps1 normally sets it.");
            return;
        }
        while (!dir.empty() && (dir.back() == '\\' || dir.back() == '/')) dir.pop_back();
        if (dir.size() >= MAX_PATH - 32) {
            ENW_ERROR("instance_paths: '%s' is too long to be safe", dir.c_str());
            return;
        }

        make_tree(dir.c_str());
        strcpy_s(g_redirect, sizeof(g_redirect), dir.c_str());

        // This runs at post_load, i.e. while .text is still encrypted -- which is
        // the whole point: the engine resolves this path during early init.
        if (!memory::hook_import("SHELL32.dll", "SHGetFolderPathA",
                                 reinterpret_cast<void*>(&shgetfolderpath_detour),
                                 reinterpret_cast<void**>(&g_original))) {
            ENW_ERROR("instance_paths: could not patch the SHGetFolderPathA import; "
                      "this instance will share the machine-wide profile");
            g_redirect[0] = '\0';
            return;
        }

        ENW_INFO("instance_paths: AppData redirected to '%s' - the engine will build "
                 "'%s\\Activision\\CoDWaW\\players' from it",
                 g_redirect, g_redirect);
    }

    void post_init() override {
        if (!g_redirect[0]) return;
        const LONG hits = ::InterlockedCompareExchange(&g_hits, 0, 0);
        ENW_INFO("instance_paths: SHGetFolderPathA redirected %ld time(s)", hits);
        if (hits == 0) {
            ENW_WARN("instance_paths: the engine never asked for AppData through "
                     "SHGetFolderPathA. Either it caches the path somewhere we have not found, "
                     "or it resolves the profile another way. Profile is NOT per-instance.");
        }
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::instance_paths)
