// Keep the player's own World at War data out of our way -- and ours out of theirs.
//
// B, 2026-09-23: "our client must never touch the user's own World at War data."
// Steam-launched vanilla WaW must see nothing of ours. Everything we add -- maps,
// config, saves, profiles, our DLL -- lives under %LOCALAPPDATA%\ENWZombies\.
//
// WHY THIS NEEDS A HOOK AT ALL. `+set fs_homepath <dir>` only moves `main/`
// (foundation.md 7). Four things stay in the player's own
// `%LOCALAPPDATA%\Activision\CoDWaW\`:
//
//   players\profiles\...      the profile, config.cfg and binds
//   mods\<bsp>\               WHERE CUSTOM MAPS MUST LIVE -- and the reason the
//                             vanilla game's Mods menu was listing ENW's maps
//   __CoDWaW                  the single-instance / safe-mode marker
//   the map-exists check      dedi.md 14: before `+map`, the engine opens
//                             <LocalAppData>\Activision\CoDWaW\<fs_game>\<bsp>.ff
//                             with CreateFileA and answers "Can't find map" from
//                             that one call, ignoring the FS search path entirely
//
// So until LocalAppData itself moves, installing a map means writing into the
// player's folder. That is the thing B wants stopped, and it is one hook.
//
// HOW. CoDWaW.exe imports `SHGetFolderPathA` from SHELL32 and appends the literal
// "\Activision\CoDWaW" to whatever it returns (the string is at 0x47EC90; the
// import is confirmed in the import table). Replace that one IAT entry and hand
// back <ENW home>\localappdata for the two AppData CSIDLs; the engine builds
// `<ours>\Activision\CoDWaW\players`, `...\mods`, `...\__CoDWaW` and the
// map-exists path off it by itself. Setting the LOCALAPPDATA *environment*
// variable does nothing -- the dedi lane measured that; SHGetFolderPathA reads
// the shell's own state, not the environment.
//
// WHY AN IAT PATCH AND NOT A DETOUR. The IAT lives in `.rdata`, which SteamStub
// does not encrypt, and the loader fills it before the PE entry point runs. So
// this installs in `post_load`, BEFORE the game's code is decrypted and before any
// engine code executes -- which it has to be, because the profile path is resolved
// during very early init. One pointer write, reversible, no prologue to relocate.
//
// SELF-VERIFYING. `post_init` prints how many times the engine actually came
// through the hook and WARNS LOUDLY at zero, because a redirect that silently did
// not happen looks exactly like one that worked until a player's own save is
// overwritten. It also prints the resolved folder so a run can be checked against
// what is on disk.
//
// HOOK OWNERSHIP (dev-box.md rule 12 / kickstart rule 9). `shared/core`'s
// `instance_paths` patches THE SAME IMPORT for per-instance profiles. It is
// opt-in (`ENW_PRIVATE_PROFILE=1`) and this component stands down when it is on,
// rather than letting two owners race for one IAT slot and letting the loser find
// out from a log line.
#include "../../shared/core/component.hpp"

#include "../../shared/core/logger.hpp"
#include "../../shared/core/memory.hpp"

#include <shlobj.h>

#include <string>

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

// Create every level of a path. The engine fails quietly if the directory it is
// handed does not exist, which is the worst possible way for this to go wrong.
void make_tree(const char* path) {
    std::string p(path);
    for (size_t i = 3; i <= p.size(); ++i) {
        if (i == p.size() || p[i] == '\\' || p[i] == '/') {
            ::CreateDirectoryA(p.substr(0, i).c_str(), nullptr);
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
        strcpy_s(out, MAX_PATH, g_redirect);  // documented as MAX_PATH
        return S_OK;
    }
    if (!g_original) return E_FAIL;
    return g_original(hwnd, csidl, token, flags, out);
}

class enw_localappdata final : public component {
public:
    const char* name() const override { return "enw_localappdata"; }

    void post_load() override {
        if (env("ENW_PRIVATE_PROFILE") == "1") {
            ENW_INFO("enw_localappdata: standing down - ENW_PRIVATE_PROFILE=1, so core's "
                     "instance_paths owns the SHGetFolderPathA import for this process. "
                     "One hook, one owner.");
            return;
        }

        // ENW_LOCALAPPDATA is the launcher's name for it; ENW_INSTANCE_APPDATA is the
        // one the dev scripts already set. Either will do.
        std::string dir = env("ENW_LOCALAPPDATA");
        if (dir.empty()) dir = env("ENW_INSTANCE_APPDATA");
        if (dir.empty()) {
            ENW_INFO("enw_localappdata: off - neither ENW_LOCALAPPDATA nor "
                     "ENW_INSTANCE_APPDATA is set, so the game will use the machine's own "
                     "%%LOCALAPPDATA%%. The launcher always sets it.");
            return;
        }
        while (!dir.empty() && (dir.back() == '\\' || dir.back() == '/')) dir.pop_back();
        // The engine appends "\Activision\CoDWaW\players\profiles\<name>\config.cfg" and
        // more to this, into a MAX_PATH buffer. Leave room for it rather than letting a
        // long path truncate into something that half-resolves.
        if (dir.size() >= MAX_PATH - 96) {
            ENW_ERROR("enw_localappdata: '%s' is too long to be safe (%zu chars); "
                      "not redirecting.", dir.c_str(), dir.size());
            return;
        }

        make_tree(dir.c_str());
        strcpy_s(g_redirect, sizeof(g_redirect), dir.c_str());

        if (!memory::hook_import("SHELL32.dll", "SHGetFolderPathA",
                                 reinterpret_cast<void*>(&shgetfolderpath_detour),
                                 reinterpret_cast<void**>(&g_original))) {
            ENW_ERROR("enw_localappdata: could not patch the SHGetFolderPathA import. "
                      "THE GAME WILL USE THE PLAYER'S OWN %%LOCALAPPDATA%%\\Activision\\CoDWaW "
                      "for profiles, mods and the map-exists check.");
            g_redirect[0] = '\0';
            return;
        }

        ENW_INFO("enw_localappdata: LocalAppData redirected to '%s' - the engine will build "
                 "'%s\\Activision\\CoDWaW\\{players,mods,__CoDWaW}' from it, and nothing of "
                 "ours reaches the player's own folder.",
                 g_redirect, g_redirect);
    }

    void post_init() override {
        if (!g_redirect[0]) return;
        const LONG hits = ::InterlockedCompareExchange(&g_hits, 0, 0);
        ENW_INFO("enw_localappdata: SHGetFolderPathA redirected %ld time(s) -> '%s'", hits,
                 g_redirect);
        if (hits == 0) {
            ENW_WARN("enw_localappdata: THE ENGINE NEVER ASKED FOR APPDATA THROUGH "
                     "SHGetFolderPathA in this run. The redirect did not take: profiles, "
                     "mods and the map-exists check are still resolving to the player's own "
                     "folder. Treat any 'we did not touch their data' claim from this run as "
                     "unproven.");
        }
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::enw_localappdata)
