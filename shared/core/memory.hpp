// Memory helpers: protection, patching, call/jmp rewriting, pattern scanning.
//
// Everything here is x86-specific and assumes the target is the game image in our
// own process. Every function is defensive: a bad address returns false and logs,
// it never faults the game.
#pragma once
#include "enw.hpp"

namespace enw::memory {

struct section {
    uintptr_t start = 0;
    size_t size = 0;
    bool valid() const { return start != 0 && size != 0; }
    bool contains(uintptr_t a) const { return a >= start && a < start + size; }
};

// Sections of the main module (CoDWaW.exe), read out of its PE headers at runtime.
section text_section();
section rdata_section();
section section_by_name(const char* name);

bool is_readable(const void* addr, size_t size);
bool is_executable(const void* addr);

// RAII: drop protection on a range and put it back.
class scoped_unprotect {
public:
    scoped_unprotect(void* addr, size_t size);
    ~scoped_unprotect();
    bool ok() const { return ok_; }
    scoped_unprotect(const scoped_unprotect&) = delete;
    scoped_unprotect& operator=(const scoped_unprotect&) = delete;

private:
    void* addr_ = nullptr;
    size_t size_ = 0;
    DWORD old_ = 0;
    bool ok_ = false;
};

// Raw write through protection, then flush the instruction cache.
bool write_raw(uintptr_t address, const void* src, size_t size);
bool read_raw(uintptr_t address, void* dst, size_t size);

template <typename T>
bool write(uintptr_t address, const T& value) {
    return write_raw(address, &value, sizeof(T));
}

template <typename T>
bool read(uintptr_t address, T* out) {
    return read_raw(address, out, sizeof(T));
}

bool fill(uintptr_t address, uint8_t byte, size_t count);
bool nop(uintptr_t address, size_t count);

// Write a fresh 5-byte E9/E8 at `address`. Use only where you know the 5 bytes you
// are clobbering; for an existing call/jmp prefer retarget_* below.
bool write_jmp(uintptr_t address, const void* destination);
bool write_call(uintptr_t address, const void* destination);

// Read/replace the rel32 of an EXISTING E8 (call) or E9 (jmp) at `site`.
// This is the safest way to hook T4: the vault's "detour site" / "jump site"
// addresses are exactly these, and nothing is relocated or re-decoded.
uintptr_t call_target(uintptr_t site);
uintptr_t jmp_target(uintptr_t site);
bool retarget_call(uintptr_t site, const void* destination);
bool retarget_jmp(uintptr_t site, const void* destination);

// IDA-style signature: "48 8B ? ? 89", '?' or "??" is a wildcard.
// Searches .text of the main module unless a range is given. 0 if not found.
uintptr_t find_pattern(const char* signature);
uintptr_t find_pattern(const char* signature, uintptr_t start, size_t size);

// --------------------------------------------------------- import patching --
// Replace an entry in the main module's import address table.
//
// Unlike everything else here, this WORKS BEFORE SteamStub HAS DECRYPTED: the
// IAT lives in .rdata and the Windows loader fills it in before the PE entry
// point runs. So it is the only way to intercept something the engine calls
// during its very earliest init -- see components/instance_paths.cpp.
//
// `dll` is matched case-insensitively against the import descriptor's name.
// `*original` receives the pointer that was there.
bool hook_import(const char* dll, const char* function, void* replacement, void** original);

// Address of the IAT slot, or nullptr. Useful to check an import exists.
void** find_import(const char* dll, const char* function);

// The same, for imports bound BY ORDINAL rather than by name. CoDWaW.exe imports
// every socket function that way (WSOCK32 ordinal 52 is gethostbyname), so the
// name-based lookups above simply never find them.
void** find_import_ordinal(const char* dll, uint16_t ordinal);
bool hook_import_ordinal(const char* dll, uint16_t ordinal, void* replacement, void** original);

// Does `address` look like the start of a real x86 function in .text?
// Used to sanity-check the vault's public addresses before we call them.
bool looks_like_function(uintptr_t address);

// Hex dump for the log, e.g. "55 8B EC 81 EC ...". Up to 32 bytes.
std::string hex_dump(uintptr_t address, size_t count);

}  // namespace enw::memory
