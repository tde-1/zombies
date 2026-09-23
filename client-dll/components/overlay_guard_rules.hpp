// overlay_guard_rules: the pure half of overlay_guard.cpp (no engine, no hooks), so it can
// be unit-tested on its own: client-dll/tests/overlay_console_test.cpp.
//
// Which DLLs we refuse to let into CoDWaW.exe, and how we measure the address space
// they would need. See overlay_guard.cpp for why (Discord's graphics hook maps a
// 50 MB view into a 2 GB process and dereferences NULL when that fails).
#pragma once

#include <windows.h>

#include <cstddef>
#include <cstdint>
#include <cwchar>

namespace enw::overlay_rule {

// Discord's in-process graphics hook (overlay, Go Live game capture, Clips). The
// 64-bit name never loads into this 32-bit game but is listed so the rule reads
// complete.
inline constexpr const wchar_t* kRefused[] = {L"discordhook.dll", L"discordhook64.dll"};

// The file-name part of a path or bare name: after the last '\' or '/'.
inline const wchar_t* base_name(const wchar_t* s, size_t len, size_t* out_len) {
    size_t start = 0;
    for (size_t i = 0; i < len; ++i)
        if (s[i] == L'\\' || s[i] == L'/') start = i + 1;
    *out_len = len - start;
    return s + start;
}

inline wchar_t lower(wchar_t c) { return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c + 32) : c; }

// True when `name` (a bare name or any path, `len` characters, not necessarily
// NUL-terminated -- a UNICODE_STRING) names a refused DLL. A name without ".dll"
// is matched too, since LoadLibrary appends it.
inline bool refuse_module(const wchar_t* name, size_t len) {
    if (!name || !len) return false;
    size_t bl = 0;
    const wchar_t* b = base_name(name, len, &bl);
    for (const wchar_t* r : kRefused) {
        const size_t rl = std::wcslen(r);
        const size_t stem = rl - 4;  // without ".dll"
        if (bl != rl && bl != stem) continue;
        bool eq = true;
        for (size_t i = 0; i < bl; ++i)
            if (lower(b[i]) != r[i]) { eq = false; break; }
        if (eq) return true;
    }
    return false;
}

// ENW_ALLOW_DISCORD_HOOK=1 lets Discord in (the player's own choice, and the way to
// re-test once Discord fixes its NULL check). Anything else, or unset: refused.
inline bool allow_from_env(const char* v) { return v && v[0] == '1' && !v[1]; }

struct vm_free {
    uint64_t total = 0;    // bytes free in the user address space
    uint64_t largest = 0;  // the biggest single free region (what one MapViewOfFile can get)
};

// Walks the process's address space with VirtualQuery. A few thousand regions, well
// under a millisecond; safe on any thread (no allocation, no locks).
inline vm_free measure_free() {
    vm_free r;
    SYSTEM_INFO si;
    ::GetSystemInfo(&si);
    auto p = reinterpret_cast<uintptr_t>(si.lpMinimumApplicationAddress);
    const auto end = reinterpret_cast<uintptr_t>(si.lpMaximumApplicationAddress);
    MEMORY_BASIC_INFORMATION mbi;
    while (p < end && ::VirtualQuery(reinterpret_cast<void*>(p), &mbi, sizeof mbi) == sizeof mbi) {
        if (mbi.State == MEM_FREE) {
            r.total += mbi.RegionSize;
            if (mbi.RegionSize > r.largest) r.largest = mbi.RegionSize;
        }
        const uintptr_t next = reinterpret_cast<uintptr_t>(mbi.BaseAddress) + mbi.RegionSize;
        if (next <= p) break;
        p = next;
    }
    return r;
}

}  // namespace enw::overlay_rule
