// loadtest.exe -- load enw_t4.dll outside the game.
//
// Proves DllMain, the loader thread, logging, component registration and the
// game-link client all work, WITHOUT taking the game lock or launching CoDWaW.
// The SteamStub wait and the address verification are expected to fail here (we
// are not the game) -- and seeing them fail *safely*, with log lines instead of a
// crash, is precisely the point.
//
//   loadtest.exe <path-to-enw_t4.dll> [seconds]
//
// binkw32_org.dll must sit next to the DLL, because every one of our 71 exports
// forwards to it and the loader resolves forwarders eagerly.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdio>
#include <cstdlib>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::printf("usage: loadtest <enw_t4.dll> [seconds]\n");
        return 2;
    }
    const char* path = argv[1];
    const unsigned seconds = argc > 2 ? static_cast<unsigned>(atoi(argv[2])) : 5;

    // No "the program can't start" popups: we want an exit code, not a dialog.
    ::SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX | SEM_NOGPFAULTERRORBOX);

    std::printf("loading %s ...\n", path);
    const DWORD t0 = ::GetTickCount();
    const HMODULE m = ::LoadLibraryA(path);
    if (!m) {
        const DWORD err = ::GetLastError();
        std::printf("LoadLibrary FAILED: error %lu\n", err);
        if (err == ERROR_MOD_NOT_FOUND) {
            std::printf("  (is binkw32_org.dll next to the dll? every export forwards to it)\n");
        }
        if (err == ERROR_BAD_EXE_FORMAT) {
            std::printf("  (architecture mismatch - loadtest and the dll must both be x86)\n");
        }
        return 1;
    }
    std::printf("loaded at %p in %lu ms; waiting %u s for the loader thread\n", m,
                ::GetTickCount() - t0, seconds);
    ::Sleep(seconds * 1000);

    std::printf("unloading\n");
    ::FreeLibrary(m);
    std::printf("done\n");
    return 0;
}
