// Waiting for Steam's DRM shim to decrypt the game's code.
//
// CoDWaW.exe on Steam is wrapped in SteamStub v2: the PE has an extra `.bind`
// section, the entry point (0x4EBB2ED) is inside it, and `.text` is ENCRYPTED ON
// DISK. At runtime the stub talks to the Steam client, decrypts `.text` in place
// and jumps to the real entry point.
//
// Our DLL is a static import of the exe, so the Windows loader runs our DllMain
// BEFORE the entry point -- i.e. before any of that has happened. Every game
// address is garbage until it has. So: DllMain does nothing but start a thread,
// the thread waits here, and only then do components get to touch game memory.
//
// We never decrypt anything ourselves, never modify the exe on disk, and never
// strip the DRM. We just wait our turn.
#pragma once
#include "enw.hpp"

namespace enw::steamstub {

// First dword of .text while still encrypted. This is a *marker we observe*, not
// a key: T4M-Enhanced uses the same check. (Vault 11 §1.)
inline constexpr uint32_t kEncryptedMarker = 0x9EF490B8;

// Vault 11 §1: "code at 0x401000 readable/sane -> safe to patch".
inline constexpr uintptr_t kFirstCodeAddress = 0x401000;

// Is there a `.bind` section at all? (false => not a SteamStub build; nothing to wait for)
bool is_protected_build();

// True while the encrypted marker is still sitting at the start of .text.
bool is_encrypted();

// Marker gone AND 0x401000 looks like real code.
bool is_decrypted();

// Block until is_decrypted(), or give up. Returns true if it decrypted.
// Polls; the stub takes well under a second in practice, but a cold Steam client
// can be slow, hence the generous default.
bool wait_for_decrypt(unsigned timeout_ms = 60000);

// Abandon an in-flight wait_for_decrypt(). Called from DLL_PROCESS_DETACH so a
// process that unloads us mid-wait does not sit there for the full timeout.
void abort_wait();

// What we saw, for the log / the board.
struct report {
    bool protected_build = false;
    bool decrypted = false;
    unsigned waited_ms = 0;
    uint32_t first_text_dword = 0;
    std::string first_code_bytes;
};
report last_report();

}  // namespace enw::steamstub
