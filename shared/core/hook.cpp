#include "hook.hpp"

#include "logger.hpp"
#include "memory.hpp"

#include <MinHook.h>

namespace enw {
namespace {
bool g_mh_ready = false;

const char* mh_error(MH_STATUS s) {
    switch (s) {
        case MH_OK: return "OK";
        case MH_ERROR_ALREADY_INITIALIZED: return "already initialized";
        case MH_ERROR_NOT_INITIALIZED: return "not initialized";
        case MH_ERROR_ALREADY_CREATED: return "already created";
        case MH_ERROR_NOT_CREATED: return "not created";
        case MH_ERROR_ENABLED: return "already enabled";
        case MH_ERROR_DISABLED: return "already disabled";
        case MH_ERROR_NOT_EXECUTABLE: return "target not executable";
        case MH_ERROR_UNSUPPORTED_FUNCTION: return "unsupported function (cannot relocate prologue)";
        case MH_ERROR_MEMORY_ALLOC: return "memory alloc failed";
        case MH_ERROR_MEMORY_PROTECT: return "memory protect failed";
        default: return "unknown";
    }
}
}  // namespace

namespace hooks {

bool init() {
    if (g_mh_ready) return true;
    const MH_STATUS s = MH_Initialize();
    if (s != MH_OK && s != MH_ERROR_ALREADY_INITIALIZED) {
        ENW_ERROR("hooks: MH_Initialize failed: %s", mh_error(s));
        return false;
    }
    g_mh_ready = true;
    ENW_DEBUG("hooks: MinHook ready");
    return true;
}

void shutdown() {
    if (!g_mh_ready) return;
    MH_DisableHook(MH_ALL_HOOKS);
    MH_Uninitialize();
    g_mh_ready = false;
}

bool enable_all() {
    if (!g_mh_ready) return false;
    const MH_STATUS s = MH_EnableHook(MH_ALL_HOOKS);
    if (s != MH_OK) {
        ENW_ERROR("hooks: MH_EnableHook(ALL) failed: %s", mh_error(s));
        return false;
    }
    return true;
}

}  // namespace hooks

hook::~hook() { remove(); }

hook::hook(hook&& other) noexcept
    : target_(other.target_), trampoline_(other.trampoline_), label_(other.label_), enabled_(other.enabled_) {
    other.target_ = nullptr;
    other.trampoline_ = nullptr;
    other.enabled_ = false;
}

hook& hook::operator=(hook&& other) noexcept {
    if (this != &other) {
        remove();
        target_ = other.target_;
        trampoline_ = other.trampoline_;
        label_ = other.label_;
        enabled_ = other.enabled_;
        other.target_ = nullptr;
        other.trampoline_ = nullptr;
        other.enabled_ = false;
    }
    return *this;
}

bool hook::create(void* target, void* detour, const char* label) {
    label_ = label ? label : "?";
    if (!hooks::init()) return false;
    if (!target || !detour) {
        ENW_ERROR("hooks: %s: null target/detour", label_);
        return false;
    }
    // A hook onto still-encrypted or bogus code is the single easiest way to
    // crash the game in a way nobody can debug. Refuse loudly instead.
    if (!memory::looks_like_function(reinterpret_cast<uintptr_t>(target))) {
        ENW_ERROR("hooks: %s: %p does not look like code (%s). Refusing to hook.", label_, target,
                  memory::hex_dump(reinterpret_cast<uintptr_t>(target), 16).c_str());
        return false;
    }

    const MH_STATUS s = MH_CreateHook(target, detour, &trampoline_);
    if (s != MH_OK) {
        ENW_ERROR("hooks: %s: MH_CreateHook(%p) failed: %s", label_, target, mh_error(s));
        trampoline_ = nullptr;
        return false;
    }
    target_ = target;
    ENW_DEBUG("hooks: %s: created at %p (trampoline %p)", label_, target, trampoline_);
    return true;
}

bool hook::create(uintptr_t vault_address, void* detour, const char* label) {
    return create(reinterpret_cast<void*>(at(vault_address)), detour, label);
}

bool hook::enable() {
    if (!target_) return false;
    const MH_STATUS s = MH_EnableHook(target_);
    if (s != MH_OK) {
        ENW_ERROR("hooks: %s: MH_EnableHook failed: %s", label_, mh_error(s));
        return false;
    }
    enabled_ = true;
    return true;
}

bool hook::disable() {
    if (!target_ || !enabled_) return false;
    const MH_STATUS s = MH_DisableHook(target_);
    if (s != MH_OK) {
        ENW_ERROR("hooks: %s: MH_DisableHook failed: %s", label_, mh_error(s));
        return false;
    }
    enabled_ = false;
    return true;
}

void hook::remove() {
    if (!target_) return;
    MH_RemoveHook(target_);
    target_ = nullptr;
    trampoline_ = nullptr;
    enabled_ = false;
}

}  // namespace enw
