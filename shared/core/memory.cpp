#include "memory.hpp"

#include "logger.hpp"

namespace enw::memory {
namespace {

const IMAGE_NT_HEADERS32* nt_headers() {
    const auto b = base();
    if (!b) return nullptr;
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(b);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return nullptr;
    const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS32*>(b + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return nullptr;
    return nt;
}

int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

struct sig_byte {
    uint8_t value;
    bool wildcard;
};

std::vector<sig_byte> parse_signature(const char* sig) {
    std::vector<sig_byte> out;
    for (const char* p = sig; *p;) {
        if (*p == ' ') { ++p; continue; }
        if (*p == '?') {
            ++p;
            if (*p == '?') ++p;
            out.push_back({0, true});
            continue;
        }
        const int hi = hex_nibble(p[0]);
        const int lo = p[1] ? hex_nibble(p[1]) : -1;
        if (hi < 0 || lo < 0) return {};  // malformed: better nothing than a wrong hit
        out.push_back({static_cast<uint8_t>((hi << 4) | lo), false});
        p += 2;
    }
    return out;
}

}  // namespace

section section_by_name(const char* name) {
    const auto* nt = nt_headers();
    if (!nt) return {};
    const auto* sec = IMAGE_FIRST_SECTION(nt);
    for (unsigned i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++sec) {
        char n[9]{};
        memcpy(n, sec->Name, 8);
        if (_stricmp(n, name) == 0) {
            const size_t size = sec->Misc.VirtualSize ? sec->Misc.VirtualSize : sec->SizeOfRawData;
            return {base() + sec->VirtualAddress, size};
        }
    }
    return {};
}

section text_section() {
    static const section s = section_by_name(".text");
    return s;
}

section rdata_section() {
    static const section s = section_by_name(".rdata");
    return s;
}

bool is_readable(const void* addr, size_t size) {
    if (!addr || !size) return false;
    MEMORY_BASIC_INFORMATION mbi{};
    const auto* p = static_cast<const uint8_t*>(addr);
    const auto* end = p + size;
    while (p < end) {
        if (::VirtualQuery(p, &mbi, sizeof(mbi)) == 0) return false;
        if (mbi.State != MEM_COMMIT) return false;
        if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
        p = static_cast<const uint8_t*>(mbi.BaseAddress) + mbi.RegionSize;
    }
    return true;
}

bool is_executable(const void* addr) {
    MEMORY_BASIC_INFORMATION mbi{};
    if (::VirtualQuery(addr, &mbi, sizeof(mbi)) == 0) return false;
    if (mbi.State != MEM_COMMIT) return false;
    constexpr DWORD kExec = PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
    return (mbi.Protect & kExec) != 0;
}

scoped_unprotect::scoped_unprotect(void* addr, size_t size) : addr_(addr), size_(size) {
    ok_ = ::VirtualProtect(addr, size, PAGE_EXECUTE_READWRITE, &old_) != FALSE;
}

scoped_unprotect::~scoped_unprotect() {
    if (ok_) {
        DWORD ignored = 0;
        ::VirtualProtect(addr_, size_, old_, &ignored);
    }
}

bool write_raw(uintptr_t address, const void* src, size_t size) {
    if (!address || !src || !size) return false;
    auto* dst = reinterpret_cast<void*>(address);
    scoped_unprotect guard(dst, size);
    if (!guard.ok()) {
        ENW_ERROR("memory: VirtualProtect failed at %p (%u bytes), err=%lu", dst,
                  static_cast<unsigned>(size), ::GetLastError());
        return false;
    }
    memcpy(dst, src, size);
    ::FlushInstructionCache(::GetCurrentProcess(), dst, size);
    return true;
}

bool read_raw(uintptr_t address, void* dst, size_t size) {
    if (!is_readable(reinterpret_cast<const void*>(address), size)) return false;
    memcpy(dst, reinterpret_cast<const void*>(address), size);
    return true;
}

bool fill(uintptr_t address, uint8_t byte, size_t count) {
    std::vector<uint8_t> buf(count, byte);
    return write_raw(address, buf.data(), buf.size());
}

bool nop(uintptr_t address, size_t count) { return fill(address, 0x90, count); }

bool write_jmp(uintptr_t address, const void* destination) {
    uint8_t patch[5] = {0xE9};
    const auto rel = static_cast<int32_t>(reinterpret_cast<uintptr_t>(destination) - address - 5);
    memcpy(patch + 1, &rel, 4);
    return write_raw(address, patch, sizeof(patch));
}

bool write_call(uintptr_t address, const void* destination) {
    uint8_t patch[5] = {0xE8};
    const auto rel = static_cast<int32_t>(reinterpret_cast<uintptr_t>(destination) - address - 5);
    memcpy(patch + 1, &rel, 4);
    return write_raw(address, patch, sizeof(patch));
}

namespace {

uintptr_t rel32_target(uintptr_t site, uint8_t expected_opcode, const char* what) {
    uint8_t op = 0;
    int32_t rel = 0;
    if (!read(site, &op) || !read(site + 1, &rel)) {
        ENW_ERROR("memory: %s site %08X is not readable", what, static_cast<unsigned>(site));
        return 0;
    }
    if (op != expected_opcode) {
        ENW_ERROR("memory: %s site %08X has opcode %02X, expected %02X (bytes: %s)", what,
                  static_cast<unsigned>(site), op, expected_opcode, hex_dump(site, 8).c_str());
        return 0;
    }
    return site + 5 + static_cast<uintptr_t>(static_cast<intptr_t>(rel));
}

bool retarget_rel32(uintptr_t site, const void* destination, uint8_t expected_opcode, const char* what) {
    if (rel32_target(site, expected_opcode, what) == 0) return false;
    const auto rel = static_cast<int32_t>(reinterpret_cast<uintptr_t>(destination) - site - 5);
    return write(site + 1, rel);
}

}  // namespace

uintptr_t call_target(uintptr_t site) { return rel32_target(site, 0xE8, "call"); }
uintptr_t jmp_target(uintptr_t site) { return rel32_target(site, 0xE9, "jmp"); }

bool retarget_call(uintptr_t site, const void* destination) {
    return retarget_rel32(site, destination, 0xE8, "call");
}

bool retarget_jmp(uintptr_t site, const void* destination) {
    return retarget_rel32(site, destination, 0xE9, "jmp");
}

uintptr_t find_pattern(const char* signature, uintptr_t start, size_t size) {
    const auto sig = parse_signature(signature);
    if (sig.empty() || size < sig.size()) return 0;
    if (!is_readable(reinterpret_cast<const void*>(start), size)) {
        ENW_WARN("memory: find_pattern range %08X+%u is not fully readable",
                 static_cast<unsigned>(start), static_cast<unsigned>(size));
        return 0;
    }
    const auto* data = reinterpret_cast<const uint8_t*>(start);
    const size_t last = size - sig.size();
    for (size_t i = 0; i <= last; ++i) {
        size_t j = 0;
        for (; j < sig.size(); ++j) {
            if (!sig[j].wildcard && data[i + j] != sig[j].value) break;
        }
        if (j == sig.size()) return start + i;
    }
    return 0;
}

uintptr_t find_pattern(const char* signature) {
    const auto t = text_section();
    if (!t.valid()) return 0;
    return find_pattern(signature, t.start, t.size);
}

void** find_import(const char* dll, const char* function) {
    const auto* nt = nt_headers();
    if (!nt || !dll || !function) return nullptr;

    const auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dir.VirtualAddress || !dir.Size) return nullptr;

    const auto b = base();
    const auto* desc = reinterpret_cast<const IMAGE_IMPORT_DESCRIPTOR*>(b + dir.VirtualAddress);

    for (; desc->Name; ++desc) {
        const char* name = reinterpret_cast<const char*>(b + desc->Name);
        if (_stricmp(name, dll) != 0) continue;

        // OriginalFirstThunk keeps the names; FirstThunk is the live IAT the
        // loader overwrote with addresses. Walk them in step.
        const auto* thunk = reinterpret_cast<const IMAGE_THUNK_DATA32*>(
            b + (desc->OriginalFirstThunk ? desc->OriginalFirstThunk : desc->FirstThunk));
        auto* iat = reinterpret_cast<IMAGE_THUNK_DATA32*>(b + desc->FirstThunk);

        for (; thunk->u1.AddressOfData; ++thunk, ++iat) {
            if (thunk->u1.Ordinal & IMAGE_ORDINAL_FLAG32) continue;  // imported by ordinal
            const auto* import_by_name =
                reinterpret_cast<const IMAGE_IMPORT_BY_NAME*>(b + thunk->u1.AddressOfData);
            if (strcmp(reinterpret_cast<const char*>(import_by_name->Name), function) == 0) {
                return reinterpret_cast<void**>(&iat->u1.Function);
            }
        }
    }
    return nullptr;
}

void** find_import_ordinal(const char* dll, uint16_t ordinal) {
    const auto* nt = nt_headers();
    if (!nt || !dll) return nullptr;

    const auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dir.VirtualAddress || !dir.Size) return nullptr;

    const auto b = base();
    const auto* desc = reinterpret_cast<const IMAGE_IMPORT_DESCRIPTOR*>(b + dir.VirtualAddress);

    for (; desc->Name; ++desc) {
        const char* name = reinterpret_cast<const char*>(b + desc->Name);
        if (_stricmp(name, dll) != 0) continue;

        const auto* thunk = reinterpret_cast<const IMAGE_THUNK_DATA32*>(
            b + (desc->OriginalFirstThunk ? desc->OriginalFirstThunk : desc->FirstThunk));
        auto* iat = reinterpret_cast<IMAGE_THUNK_DATA32*>(b + desc->FirstThunk);

        for (; thunk->u1.Ordinal; ++thunk, ++iat) {
            if (!(thunk->u1.Ordinal & IMAGE_ORDINAL_FLAG32)) continue;
            if (IMAGE_ORDINAL32(thunk->u1.Ordinal) == ordinal) {
                return reinterpret_cast<void**>(&iat->u1.Function);
            }
        }
    }
    return nullptr;
}

bool hook_import_ordinal(const char* dll, uint16_t ordinal, void* replacement, void** original) {
    void** slot = find_import_ordinal(dll, ordinal);
    if (!slot) {
        ENW_ERROR("memory: %s ordinal %u is not in the import table", dll ? dll : "?", ordinal);
        return false;
    }
    if (original) *original = *slot;

    scoped_unprotect guard(slot, sizeof(void*));
    if (!guard.ok()) {
        ENW_ERROR("memory: could not unprotect the IAT slot for %s#%u", dll, ordinal);
        return false;
    }
    *slot = replacement;
    ENW_DEBUG("memory: IAT %s#%u %p -> %p", dll, ordinal, original ? *original : nullptr,
              replacement);
    return true;
}

bool hook_import(const char* dll, const char* function, void* replacement, void** original) {
    void** slot = find_import(dll, function);
    if (!slot) {
        ENW_ERROR("memory: %s!%s is not in the import table", dll ? dll : "?",
                  function ? function : "?");
        return false;
    }
    if (original) *original = *slot;

    scoped_unprotect guard(slot, sizeof(void*));
    if (!guard.ok()) {
        ENW_ERROR("memory: could not unprotect the IAT slot for %s!%s", dll, function);
        return false;
    }
    *slot = replacement;
    ENW_DEBUG("memory: IAT %s!%s %p -> %p", dll, function, original ? *original : nullptr,
              replacement);
    return true;
}

bool looks_like_function(uintptr_t address) {
    const auto t = text_section();
    if (t.valid() && !t.contains(address)) return false;
    if (!is_readable(reinterpret_cast<const void*>(address), 16)) return false;
    if (!is_executable(reinterpret_cast<const void*>(address))) return false;

    uint8_t b[16]{};
    memcpy(b, reinterpret_cast<const void*>(address), sizeof(b));

    // All-zero / all-0xCC means we are looking at padding or still-encrypted data.
    bool all_same = true;
    for (int i = 1; i < 16; ++i) {
        if (b[i] != b[0]) { all_same = false; break; }
    }
    if (all_same) return false;

    // Plausible MSVC x86 prologue openers. Deliberately generous: this is a smoke
    // test against "the address is garbage", not a proof of identity.
    switch (b[0]) {
        case 0x55:  // push ebp
        case 0x53: case 0x56: case 0x57:  // push ebx/esi/edi
        case 0x83: case 0x81:  // sub esp, imm
        case 0x8B:  // mov
        case 0xA1:  // mov eax, [m32]
        case 0xB8:  // mov eax, imm32
        case 0x6A: case 0x68:  // push imm
        case 0x51: case 0x52: case 0x50:  // push ecx/edx/eax
        case 0xE9: case 0xEB:  // jmp thunk
        case 0x33:  // xor
        case 0x64:  // fs: prefix (SEH prologue)
            return true;
        default:
            return false;
    }
}

std::string hex_dump(uintptr_t address, size_t count) {
    if (count > 32) count = 32;
    if (!is_readable(reinterpret_cast<const void*>(address), count)) return "<unreadable>";
    const auto* p = reinterpret_cast<const uint8_t*>(address);
    std::string out;
    out.reserve(count * 3);
    char tmp[4];
    for (size_t i = 0; i < count; ++i) {
        _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%02X", p[i]);
        if (i) out.push_back(' ');
        out += tmp;
    }
    return out;
}

}  // namespace enw::memory
