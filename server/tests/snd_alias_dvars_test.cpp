// Unit test for server/components/dedicated/snd_alias_dvars.hpp (dedi.md §25).
//
// Not under server/components/: CMake globs that directory into the DLL. Build and run:
//
//     cl /nologo /EHsc /std:c++17 server\tests\snd_alias_dvars_test.cpp /Fe:build\snd_alias_dvars_test.exe
//     build\snd_alias_dvars_test.exe [path\to\codwaw-1.7-a.exe]
//
// Part 1 is pure. Part 2 reads the decrypted dump (default C:\Users\b\ZombiesDev\dumps\
// codwaw-1.7-a.exe) and checks every address in the header against the image: the names and
// descriptions, SND_Init's two instructions per dvar, and every reader's `mov reg, [slot]`
// followed by the `+0x10` test. It is skipped, and says so, when the dump is not there.
#include "../components/dedicated/snd_alias_dvars.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <vector>

using namespace enw::snd_alias_dvars;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

static void test_reader_model() {
    // The §25 fault: an alias the zones do not have, on a server that never ran SND_Init.
    check(reader_outcome(false, false, false) == outcome::access_violation,
          "missing alias + unregistered dvar = access violation (the freeze)");
    // What a retail client does: the dvar exists and is 0.
    check(reader_outcome(false, true, false) == outcome::silent,
          "missing alias + registered dvar at its default 0 = silent, like a client");
    check(reader_outcome(false, true, true) == outcome::script_error,
          "missing alias + dvar set to 1 = a script error, not a fault");
    // Why the server survives minutes first: an alias that exists never reads the dvar.
    check(reader_outcome(true, false, false) == outcome::plays,
          "an alias that exists never touches the dvar, registered or not");
    check(reader_outcome(true, true, false) == outcome::plays, "found alias, registered dvar");
}

static void test_decide() {
    check(decide(false, false, 0, true) == action::not_dedicated, "a client is left alone");
    check(decide(true, true, 0, true) == action::off, "ENW_DEDI_NO_SND_ALIAS_DVARS wins");
    check(decide(true, false, 0x021C1DF0, true) == action::already_registered,
          "a slot that already holds a dvar is never re-registered");
    check(decide(true, false, 0, false) == action::signature_mismatch,
          "a different exe: register nothing");
    check(decide(true, false, 0, true) == action::register_it, "dedicated + NULL + our exe");
}

static void test_table() {
    check(kSlotCount == 2, "two dvars");
    check(std::strcmp(kSlots[0].name_text, "snd_errorOnMissing") == 0, "slot 0 name");
    check(kSlots[0].slot == 0x3BE65DC, "slot 0 is [0x3BE65DC], the pointer read at 0x4F0579");
    for (size_t i = 0; i < kReaderCount; ++i) {
        bool known = false;
        for (size_t j = 0; j < kSlotCount; ++j) known |= kReaders[i].slot == kSlots[j].slot;
        check(known, "every reader reads one of our two slots");
    }
    uint8_t a[5], b[5];
    expected_insns(kSlots[0], a, b);
    const uint8_t want_a[5] = {0xBF, 0xC0, 0xC3, 0x89, 0x00};   // 0x6B487D mov edi, 0x89C3C0
    const uint8_t want_b[5] = {0xA3, 0xDC, 0x65, 0xBE, 0x03};   // 0x6B4887 mov [0x3BE65DC], eax
    check(std::memcmp(a, want_a, 5) == 0, "expected_insns: mov edi, name");
    check(std::memcmp(b, want_b, 5) == 0, "expected_insns: mov [slot], eax");
    const uint8_t eax_load[] = {0xA1, 0xDC, 0x65, 0xBE, 0x03};
    const uint8_t ecx_load[] = {0x8B, 0x0D, 0xDC, 0x65, 0xBE, 0x03};
    const uint8_t other[] = {0x8B, 0x0D, 0xD8, 0x65, 0xBE, 0x03};
    check(reader_load_len(eax_load, 0x3BE65DC) == 5, "A1 load");
    check(reader_load_len(ecx_load, 0x3BE65DC) == 6, "8B 0D load");
    check(reader_load_len(other, 0x3BE65DC) == 0, "a load of the other slot is not this slot's");
}

// ---- part 2: the image -------------------------------------------------------------------
struct image {
    std::vector<uint8_t> mem;
    uint32_t base = 0;
    const uint8_t* at(uintptr_t va) const {
        if (va < base || va - base >= mem.size()) return nullptr;
        return mem.data() + (va - base);
    }
};

static bool load_image(const char* path, image& img) {
    FILE* f = std::fopen(path, "rb");
    if (!f) return false;
    std::vector<uint8_t> raw;
    uint8_t buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) raw.insert(raw.end(), buf, buf + n);
    std::fclose(f);
    auto u16 = [&](size_t o) { return static_cast<uint32_t>(raw[o] | (raw[o + 1] << 8)); };
    auto u32 = [&](size_t o) { return u16(o) | (u16(o + 2) << 16); };
    if (raw.size() < 0x400 || raw[0] != 'M' || raw[1] != 'Z') return false;
    const size_t pe = u32(0x3C);
    const uint32_t nsec = u16(pe + 6), opt = u16(pe + 20);
    img.base = u32(pe + 24 + 28);
    const uint32_t size = u32(pe + 24 + 56);
    img.mem.assign(size, 0);
    std::memcpy(img.mem.data(), raw.data(), std::min<size_t>(u32(pe + 24 + 60), raw.size()));
    for (uint32_t i = 0; i < nsec; ++i) {
        const size_t s = pe + 24 + opt + i * 40;
        const uint32_t va = u32(s + 12), rsz = u32(s + 16), rptr = u32(s + 20);
        if (rptr + rsz <= raw.size() && va + rsz <= size) std::memcpy(&img.mem[va], &raw[rptr], rsz);
    }
    return true;
}

static void test_image(const image& img) {
    char what[256];
    for (size_t i = 0; i < kSlotCount; ++i) {
        const dvar_slot& s = kSlots[i];
        const uint8_t* nm = img.at(s.name);
        std::snprintf(what, sizeof what, "image: the string at 0x%X is \"%s\"", unsigned(s.name), s.name_text);
        check(nm && std::strcmp(reinterpret_cast<const char*>(nm), s.name_text) == 0, what);
        const uint8_t* ds = img.at(s.desc);
        std::snprintf(what, sizeof what, "image: the description of %s", s.name_text);
        check(ds && std::strcmp(reinterpret_cast<const char*>(ds), s.desc_text) == 0, what);
        uint8_t a[5], b[5];
        expected_insns(s, a, b);
        std::snprintf(what, sizeof what, "image: SND_Init 0x%X is `mov edi, %s`", unsigned(s.name_insn), s.name_text);
        check(img.at(s.name_insn) && std::memcmp(img.at(s.name_insn), a, 5) == 0, what);
        std::snprintf(what, sizeof what, "image: SND_Init 0x%X stores %s to 0x%X", unsigned(s.store_insn), s.name_text, unsigned(s.slot));
        check(img.at(s.store_insn) && std::memcmp(img.at(s.store_insn), b, 5) == 0, what);
        // Between the name and the store: `call Dvar_RegisterBool` (E8 rel32), and a
        // `xor al, al` (default 0) right before the name -- or for slot 1, before it too.
        const uint8_t* call = img.at(s.name_insn + 5);
        const uintptr_t target = s.name_insn + 10 + static_cast<int32_t>(
            call[1] | (call[2] << 8) | (call[3] << 16) | (static_cast<uint32_t>(call[4]) << 24));
        std::snprintf(what, sizeof what, "image: %s is registered by Dvar_RegisterBool 0x%X", s.name_text, unsigned(kDvarRegisterBool));
        check(call[0] == 0xE8 && target == kDvarRegisterBool, what);
        const uint8_t* x = img.at(s.name_insn - 2);
        std::snprintf(what, sizeof what, "image: %s defaults to 0 (`xor al, al`)", s.name_text);
        check(x[0] == 0x32 && x[1] == 0xC0, what);
    }
    for (size_t i = 0; i < kReaderCount; ++i) {
        const reader& r = kReaders[i];
        const uint8_t* b = img.at(r.load);
        const int len = b ? reader_load_len(b, r.slot) : 0;
        std::snprintf(what, sizeof what, "image: 0x%X loads [0x%X] (%s)", unsigned(r.load), unsigned(r.slot), r.where);
        check(len > 0, what);
        if (!len) continue;
        // then `cmp byte ptr [reg+0x10], 0|al` : 80 7x 10 00  or  38 4x 10
        const uint8_t* c = b + len;
        const bool cmp_imm = c[0] == 0x80 && (c[1] & 0xF8) == 0x78 && c[2] == 0x10 && c[3] == 0x00;
        const bool cmp_al = c[0] == 0x38 && (c[1] & 0xF8) == 0x40 && c[2] == 0x10;
        std::snprintf(what, sizeof what, "image: 0x%X then tests current.enabled at +0x10", unsigned(r.load));
        check(cmp_imm || cmp_al, what);
    }
    // Com_FindSoundAlias's prologue (what the component calls for its probe).
    const uint8_t fsa[] = {0x53, 0x8B, 0x5C, 0x24, 0x08};
    check(std::memcmp(img.at(kFindSoundAlias), fsa, sizeof fsa) == 0, "image: Com_FindSoundAlias prologue");
}

int main(int argc, char** argv) {
    test_reader_model();
    test_decide();
    test_table();
    const char* dump = argc > 1 ? argv[1] : "C:\\Users\\b\\ZombiesDev\\dumps\\codwaw-1.7-a.exe";
    image img;
    if (load_image(dump, img)) {
        test_image(img);
        std::printf("image checks ran against %s\n", dump);
    } else {
        std::printf("SKIPPED the image checks: no dump at %s\n", dump);
    }
    std::printf("snd_alias_dvars_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
