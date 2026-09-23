// overlay_guard_rules: the pure half of overlay_guard.cpp (no engine, no hooks), so it can
// be unit-tested on its own: client-dll/tests/overlay_console_test.cpp.
//
// Which DLLs we refuse to let into CoDWaW.exe, and how we measure the address space
// they would need. See overlay_guard.cpp for why (Discord's graphics hook maps a
// 50 MB view into a 2 GB process and dereferences NULL when that fails), and which
// ones we let in anyway (ENW_DISCORD_HOOK=auto: only while a 50 MB hole exists).
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

// ENW_DISCORD_HOOK=auto|allow|refuse (the launcher/site setting "Discord overlay":
// Auto / On / Off; the launcher passes the stored value, auto|allow|refuse). Unset, empty
// or anything else is auto; on/1 and off/0 are accepted for a hand-set environment.
enum class mode { automatic, allow, refuse };

inline bool eq_ci(const char* a, const char* b) {
    for (; *a && *b; ++a, ++b) {
        char x = *a, y = *b;
        if (x >= 'A' && x <= 'Z') x = static_cast<char>(x + 32);
        if (y >= 'A' && y <= 'Z') y = static_cast<char>(y + 32);
        if (x != y) return false;
    }
    return !*a && !*b;
}

inline mode parse_mode(const char* v) {
    if (!v || !*v) return mode::automatic;
    if (eq_ci(v, "allow") || eq_ci(v, "on") || eq_ci(v, "1")) return mode::allow;
    if (eq_ci(v, "refuse") || eq_ci(v, "off") || eq_ci(v, "0")) return mode::refuse;
    return mode::automatic;
}

inline const char* mode_name(mode m) {
    return m == mode::allow ? "allow" : m == mode::refuse ? "refuse" : "auto";
}

// What Discord's capture init maps in one piece (DiscordHook.dll 1342ee47cf7536:
// CreateFileMappingA(..., 0, 0x3200048) + MapViewOfFile of all of it), and the smallest
// single free region auto lets it in with: "a 50 MB block", made exact. The view is
// rounded up to whole 4 KB pages (0x3201000) and must start on a 64 KB allocation
// boundary, and a free region's own start can be up to 60 KB short of one, so a region of
// 0x3210000 bytes (50.06 MB) always holds it and anything smaller may not.
// Deliberately no margin for the game's own later allocations (coordinator, 2026-09-23:
// "allow the hook when a >= 50 MB free block exists"); see chat-overlay.md 13.6.
inline constexpr uint64_t kDiscordMapBytes = 52428872ull;
inline constexpr uint64_t kAutoMinLargestFree = 0x3210000ull;

// True = let DiscordHook.dll load. `largest_free` is measure_free().largest at the moment
// it asks to load.
inline bool allow_discord(mode m, uint64_t largest_free) {
    if (m == mode::allow) return true;
    if (m == mode::refuse) return false;
    return largest_free >= kAutoMinLargestFree;
}

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
