// ENW Zombies - shared DLL core.
// Copyright (C) 2026 the ENW Zombies authors.
// Licensed GPL-3.0-or-later (client) / AGPL-3.0-or-later (server); see repo README.
#pragma once

// We are a 32-bit in-process DLL inside a 2009 game. Keep the Windows surface small.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

static_assert(sizeof(void*) == 4, "enw_t4 must be built 32-bit: CoDWaW.exe is x86.");

namespace enw {

// The game's image base. CoDWaW.exe is not ASLR-relocatable in practice (no
// dynamic base in the PE), so the public addresses from the vault are absolute.
// Everything still goes through base() so a relocated image is a one-line fix
// rather than a rewrite.
inline uintptr_t base() {
    static const uintptr_t b = reinterpret_cast<uintptr_t>(::GetModuleHandleW(nullptr));
    return b;
}

// Preferred base recorded in the PE (0x400000 for CoDWaW.exe).
constexpr uintptr_t kPreferredBase = 0x400000;

// Turn a vault address (which assumes base 0x400000) into a live pointer.
inline uintptr_t at(uintptr_t vault_address) {
    return vault_address - kPreferredBase + base();
}

template <typename T>
inline T* ptr(uintptr_t vault_address) {
    return reinterpret_cast<T*>(at(vault_address));
}

}  // namespace enw
