// Inline hooking. Thin RAII wrapper over MinHook (thirdparty/minhook, BSD-2-Clause),
// which brings its own length disassembler so a 5-byte detour relocates the stolen
// instructions correctly instead of corrupting whatever straddles byte 5.
//
// Prefer memory::retarget_call() where the vault gives you a *call site* (e.g.
// Scr_GetMethod at 0x683043): rewriting one rel32 is strictly safer than a detour.
// Use this when you must intercept a function everybody calls.
#pragma once
#include "enw.hpp"

namespace enw {

namespace hooks {
// MH_Initialize / MH_Uninitialize. init() is idempotent and must be called after
// the game is decrypted, before any hook is created.
bool init();
void shutdown();
// Apply every created-but-not-yet-enabled hook in one pass (one thread freeze).
bool enable_all();
}  // namespace hooks

class hook {
public:
    hook() = default;
    ~hook();
    hook(const hook&) = delete;
    hook& operator=(const hook&) = delete;
    hook(hook&& other) noexcept;
    hook& operator=(hook&& other) noexcept;

    // `target` is a live address in the game (already decrypted!).
    bool create(void* target, void* detour, const char* label = nullptr);
    bool create(uintptr_t vault_address, void* detour, const char* label = nullptr);

    bool enable();
    bool disable();
    void remove();

    bool valid() const { return trampoline_ != nullptr; }

    // Call the original function through the trampoline.
    template <typename T>
    T original() const {
        return reinterpret_cast<T>(trampoline_);
    }

private:
    void* target_ = nullptr;
    void* trampoline_ = nullptr;
    const char* label_ = "";
    bool enabled_ = false;
};

}  // namespace enw
