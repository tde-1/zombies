// stock_font: the overlay's text is ALWAYS World at War's own font, whatever mod
// is loaded. (B, 0.2.17: "The overlay must not use the font that comes from the
// map ... It needs to be static: the exact same World at War font every time.")
//
// WHY IT CHANGED. Many custom maps ship their own fonts/* and the
// fonts/gamefonts_pc atlas in mod.ff (29 of the 78 archived mods do; mw2rust is the
// one used for the proof -- fear_mc_2 does NOT, see chat-overlay.md §12). Measured
// with ENW_FONT_PROBE=1 on mw2rust (01:58): T4 overrides an asset IN PLACE. The font
// pool slot sharedUiInfo points at (0x00AD1C9C, bigFont) now holds the mod's font
// (20 px, 190 glyphs) and the STOCK header was moved to a spare slot of the same
// pool (0x00AD1D2C: 32 px, 191 glyphs, glyph table in the code_post_gfx zone,
// SHA-256 identical to a stock game's). The material slot (0x00AEA3C0,
// fonts/gamefonts_pc) and the atlas image slot are overridden the same way.
// Anything that asks the engine for "fonts/bigFont" -- including the sharedUiInfo
// pointers the overlay used -- gets the mod's font.
//
// THE FIX, with nothing of Activision's shipped (docs/kickstart/ip-posture.md §0:
// everything of theirs reaches the player from their own install, at runtime):
//   1. Find the STOCK font headers in the font pool: the slot named "fonts/X" whose
//      glyph table hashes to the SHA-256 recorded below from a stock game. Only the
//      hashes are ours; the data is the player's own code_post_gfx zone in memory.
//   2. "Stock zone" = within 1.5 MB of that header's glyph table and name string
//      (code_post_gfx is 1.13 MB and loads first; a mod's zone loads last).
//   3. Find the stock material and the stock atlas image the same way: the pool
//      slot with the right name whose name string lies in the stock zone (the live
//      slot when no mod overrides it, the saved original when one does).
//   4. Copy them into OUR memory -- a Font_s header per face, the material (0x70),
//      its texture table, the image struct -- wired to each other. The glyph table,
//      the state bits and the D3D texture are the stock zone's own and that zone is
//      never unloaded, so nothing a map loads or unloads later changes our copies.
// The overlay and the Esc menu draw with these; the rest of the game is untouched.
// If the stock data cannot be found (a non-English install with other glyph tables,
// a future patch) it says so once and falls back to the engine's fonts.
//
// ENW_FONT_PROBE=1 additionally logs the font pool, as used for the finding above.
#include "component.hpp"
#include "logger.hpp"
#include "sha256.hpp"

#include <windows.h>
#include <d3d9.h>

#include <atomic>

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace enw::client {
namespace frame_capture { bool run_at_present(void (*fn)(IDirect3DDevice9*)); }
}

namespace enw::client::stock_font {
namespace {

bool readable(const void* p, size_t n) {
    MEMORY_BASIC_INFORMATION mbi{};
    if (!p || !::VirtualQuery(p, &mbi, sizeof mbi)) return false;
    if (mbi.State != MEM_COMMIT) return false;
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
    const auto end = reinterpret_cast<uintptr_t>(mbi.BaseAddress) + mbi.RegionSize;
    return reinterpret_cast<uintptr_t>(p) + n <= end;
}

std::string cstr_at(uintptr_t p) {
    if (!readable(reinterpret_cast<void*>(p), 1)) return "?";
    std::string s;
    for (int i = 0; i < 64; ++i) {
        if (!readable(reinterpret_cast<void*>(p + i), 1)) break;
        const char c = *reinterpret_cast<const char*>(p + i);
        if (!c) break;
        if (c < 0x20 || c > 0x7E) return "?";
        s.push_back(c);
    }
    return s;
}

std::string hexdump(uintptr_t p, size_t n) {
    std::string out;
    char b[12];
    for (size_t i = 0; i < n; i += 4) {
        if (!readable(reinterpret_cast<void*>(p + i), 4)) { out += "????????"; break; }
        std::snprintf(b, sizeof b, "%08X ", *reinterpret_cast<const uint32_t*>(p + i));
        out += b;
    }
    return out;
}

// Every committed, readable, non-image region of the process.
template <typename F>
void each_region(F&& f) {
    uintptr_t a = 0x10000;
    MEMORY_BASIC_INFORMATION mbi{};
    while (a < 0x7FFF0000 && ::VirtualQuery(reinterpret_cast<void*>(a), &mbi, sizeof mbi)) {
        const uintptr_t base = reinterpret_cast<uintptr_t>(mbi.BaseAddress);
        const uintptr_t next = base + mbi.RegionSize;
        const bool ok = mbi.State == MEM_COMMIT && !(mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                        (mbi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                                        PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE));
        if (ok) f(base, mbi.RegionSize);
        if (next <= a) break;
        a = next;
    }
}

size_t scan_raw(uintptr_t base, size_t size, const uint8_t* pat, size_t n, size_t align,
                uintptr_t* out, size_t cap) {
    size_t k = 0;
    __try {
        const uint8_t* p = reinterpret_cast<const uint8_t*>(base);
        for (size_t i = 0; i + n <= size && k < cap; i += align)
            if (p[i] == pat[0] && std::memcmp(p + i, pat, n) == 0) out[k++] = base + i;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
    return k;
}

std::vector<uintptr_t> find_bytes(const void* pat, size_t n, size_t align) {
    std::vector<uintptr_t> out;
    uintptr_t buf[256];
    each_region([&](uintptr_t base, size_t size) {
        const size_t k = scan_raw(base, size, static_cast<const uint8_t*>(pat), n, align, buf, 256);
        out.insert(out.end(), buf, buf + k);
    });
    return out;
}

std::vector<uintptr_t> find_dword(uint32_t v) { return find_bytes(&v, 4, 4); }

void probe_font(const char* name, uintptr_t live) {
    ENW_INFO("font_probe: ---- %s: sharedUiInfo holds 0x%08X", name, static_cast<unsigned>(live));
    std::string z(name);
    const auto strs = find_bytes(z.c_str(), z.size() + 1, 1);
    for (uintptr_t s : strs) {
        const auto refs = find_dword(static_cast<uint32_t>(s));
        for (uintptr_t h : refs) {
            if (!readable(reinterpret_cast<void*>(h), 0x18)) continue;
            const auto* f = reinterpret_cast<const uint32_t*>(h);
            const int px = static_cast<int>(f[1]), cnt = static_cast<int>(f[2]);
            if (px <= 0 || px > 128 || cnt <= 0 || cnt > 4096) continue;
            std::string gh = "?";
            if (readable(reinterpret_cast<void*>(f[5]), static_cast<size_t>(cnt) * 0x18))
                gh = sha256::hex(reinterpret_cast<void*>(f[5]), static_cast<size_t>(cnt) * 0x18).substr(0, 16);
            ENW_INFO("font_probe:   header 0x%08X (name str 0x%08X) px=%d glyphs=%d material=0x%08X "
                     "glow=0x%08X glyphTable=0x%08X sha=%s mat='%s'%s",
                     static_cast<unsigned>(h), static_cast<unsigned>(s), px, cnt, f[3], f[4], f[5],
                     gh.c_str(), cstr_at(readable(reinterpret_cast<void*>(f[3]), 4) ? *reinterpret_cast<const uint32_t*>(f[3]) : 0).c_str(),
                     h == live ? "  <- LIVE" : "");
        }
    }
}

void probe_named(const char* what, const char* name, size_t dump) {
    std::string z(name);
    const auto strs = find_bytes(z.c_str(), z.size() + 1, 1);
    ENW_INFO("font_probe: ---- %s '%s': %zu copies of the string", what, name, strs.size());
    for (uintptr_t s : strs) {
        for (uintptr_t h : find_dword(static_cast<uint32_t>(s))) {
            ENW_INFO("font_probe:   ref at 0x%08X (str 0x%08X): %s", static_cast<unsigned>(h),
                     static_cast<unsigned>(s), hexdump(h, dump).c_str());
        }
    }
}

// ------------------------------------------------------------ the stock font
constexpr uintptr_t kLiveBig = 0x20A10E8;     // sharedUiInfo.assets.bigFont
constexpr uint32_t kFontSlot = 0x18;          // sizeof(Font_s)
constexpr uint32_t kMaterialSlot = 0x70;      // sizeof(Material), the pool stride
constexpr uint32_t kMatTextureCount = 0x5B;   // u8
constexpr uint32_t kMatTextureTable = 0x64;   // MaterialTextureDef*
// T4's MaterialTextureDef is 0x10: nameHash, nameStart, nameEnd, samplerState,
// semantic, isMatureContent + pad, then the GfxImage* at +0xC (read off the stock
// table at 0x180E2210: A0AB1041 00EB7063 00000000 <image>).
constexpr uint32_t kTexDef = 0x10, kTexDefImage = 0xC;
constexpr uint32_t kImageCopy = 0x60;         // GfxImage, generously
constexpr uint32_t kZoneWindow = 0x180000;
// GfxImage (0x24): mapType, texture (IDirect3DBaseTexture9*), ..., cardMemory at
// +0x10, width|height at +0x18, name at +0x20. The stock gamefonts_pc atlas is
// 512x512 DXT5 with mips, 0x55570 bytes (stock probe 02:05) -- facts, not data.
constexpr uint32_t kImgCardMemory = 0x10, kImgWidthHeight = 0x18;
constexpr uint32_t kStockAtlasBytes = 0x55570, kStockAtlasWH = 0x02000200;

struct face { const char* name; const char* sha; uintptr_t live; uint32_t hdr[6]; bool ok; };
// SHA-256 of each font's glyph table (glyphCount * 0x18 bytes) in a stock English
// World at War 1.7 (probe, stock Nacht, 2026-09-23 01:56). Facts about the data,
// not the data.
face g_faces[] = {
    {"fonts/smallFont", "a50d7342cd222fbd271f2ef1e7c67bfff4f81fe9b616ad7b03369e63a70fbf30", 0x20A10EC, {}, false},
    {"fonts/normalFont", "27a9694d501f48c5a35c57dcecb58e0d1be72e21529d462be85dd3b791750a4a", 0x20A10F8, {}, false},
    {"fonts/bigFont", "213e080e84fa8db09e3356acd38e9313028a9749a03cf9f4dcb54cf2848adffd", 0x20A10E8, {}, false},
    {"fonts/extraBigFont", "dd0cb8115410667af087c9d9ab9f02516a6da1250388a72d2a3ba1f3ce43d893", 0x20A10FC, {}, false},
};
enum { F_SMALL, F_NORMAL, F_BIG, F_XBIG };

alignas(16) uint8_t g_mat[kMaterialSlot];
alignas(16) uint8_t g_glow[kMaterialSlot];
alignas(16) uint8_t g_mat_tt[8 * 0x10];
alignas(16) uint8_t g_glow_tt[8 * 0x10];
alignas(16) uint8_t g_images[16][kImageCopy];
int g_n_images = 0;
int g_state = 0;   // 0 not tried, 1 resolved, -1 failed (fallback to the engine's)
uint32_t g_zone_lo = 0, g_zone_hi = 0;
std::string g_fail;

bool in_zone(uint32_t p) { return p >= g_zone_lo && p < g_zone_hi; }

bool str_eq(uint32_t p, const char* want) {
    if (!readable(reinterpret_cast<void*>(p), std::strlen(want) + 1)) return false;
    return std::strcmp(reinterpret_cast<const char*>(p), want) == 0;
}

// The pool slot (stride `stride`, searched outwards from `live`) whose name pointer
// (at +name_off) is a string equal to `name` lying in the stock zone.
uint32_t find_stock_slot(uint32_t live, uint32_t stride, uint32_t name_off, const char* name, int span) {
    for (int i = 0; i <= span; ++i) {
        for (int sgn = -1; sgn <= 1; sgn += 2) {
            if (i == 0 && sgn < 0) continue;
            const uint32_t c = live + static_cast<uint32_t>(sgn * i) * stride;
            if (!readable(reinterpret_cast<void*>(c), name_off + 4)) continue;
            const uint32_t np = *reinterpret_cast<const uint32_t*>(c + name_off);
            if (in_zone(np) && str_eq(np, name)) return c;
        }
    }
    return 0;
}

// ---- the atlas pixels -------------------------------------------------------
// A mod can replace the ATLAS without shipping a font: images are loaded from the
// IWDs by name, so a mod's images/gamefonts_pc.iwi (mw2rust has a 1024x1024 one)
// is what even the STOCK image asset gets -- measured: both gamefonts_pc image
// slots held the mod's 1024x1024 texture. The stock pixels then never enter the
// process. So they are read from the player's own install: main\*.iwd (never a
// mod's folder), highest-numbered first as the engine orders them, the stored
// (uncompressed) images/gamefonts_pc.iwi -- in a stock English install it is in
// localized_english_iw00.iwd, 349580 bytes: a 28-byte IWI header (IWi, v6, DXT5,
// 512x512) and ten mips, smallest first. A D3D texture is made from it on the
// device's own thread (frame_capture::run_at_present) and wired into our own
// GfxImage (0x24: mapType 3, texture at +4, cardMemory +0x10/+0x14, 512|512 at
// +0x18, depth|category +0x1C, name +0x20 -- the stock struct's values, probe 02:05).
alignas(16) uint32_t g_image_words[9] = {3, 0, 0x00010000, 0, kStockAtlasBytes, kStockAtlasBytes,
                                          kStockAtlasWH, 0x00030001, 0};
uint8_t* const g_image = reinterpret_cast<uint8_t*>(g_image_words);
const char kImageName[] = "enw_stock_gamefonts_pc";
std::vector<uint8_t> g_iwi;
std::atomic<int> g_tex_state{0};   // 0 none, 1 queued, 2 ready, -1 failed
std::string g_iwi_from;

uint16_t rd16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
uint32_t rd32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24); }

// One stored entry out of a zip (IWD) file. False if absent or compressed.
bool zip_read_stored(const std::string& path, const char* want, std::vector<uint8_t>* out, std::string* why) {
    HANDLE f = ::CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;
    bool ok = false;
    LARGE_INTEGER size{};
    ::GetFileSizeEx(f, &size);
    auto read_at = [&](uint64_t off, void* dst, DWORD n) {
        LARGE_INTEGER o;
        o.QuadPart = static_cast<LONGLONG>(off);
        DWORD got = 0;
        return ::SetFilePointerEx(f, o, nullptr, FILE_BEGIN) && ::ReadFile(f, dst, n, &got, nullptr) && got == n;
    };
    // End of central directory: in the last 64 KB + 22.
    const uint64_t tail = (std::min<uint64_t>)(static_cast<uint64_t>(size.QuadPart), 65557);
    std::vector<uint8_t> t(static_cast<size_t>(tail));
    if (tail >= 22 && read_at(static_cast<uint64_t>(size.QuadPart) - tail, t.data(), static_cast<DWORD>(tail))) {
        for (size_t e = t.size() - 22 + 1; e-- > 0;) {
            if (rd32(&t[e]) != 0x06054B50) continue;
            const uint32_t cd_size = rd32(&t[e + 12]), cd_off = rd32(&t[e + 16]);
            std::vector<uint8_t> cd(cd_size);
            if (!read_at(cd_off, cd.data(), cd_size)) break;
            for (size_t k = 0; k + 46 <= cd.size();) {
                if (rd32(&cd[k]) != 0x02014B50) break;
                const uint16_t method = rd16(&cd[k + 10]);
                const uint32_t csize = rd32(&cd[k + 20]), usize = rd32(&cd[k + 24]);
                const uint16_t nlen = rd16(&cd[k + 28]), xlen = rd16(&cd[k + 30]), clen = rd16(&cd[k + 32]);
                const uint32_t loff = rd32(&cd[k + 42]);
                const std::string name(reinterpret_cast<const char*>(&cd[k + 46]), nlen);
                if (_stricmp(name.c_str(), want) == 0) {
                    if (method != 0 || csize != usize) {
                        *why = "compressed in " + path;
                    } else {
                        uint8_t lh[30];
                        if (read_at(loff, lh, 30) && rd32(lh) == 0x04034B50) {
                            out->resize(usize);
                            ok = read_at(loff + 30 + rd16(lh + 26) + rd16(lh + 28), out->data(), usize);
                        }
                    }
                    break;
                }
                k += 46 + nlen + xlen + clen;
            }
            break;
        }
    }
    ::CloseHandle(f);
    return ok;
}

bool load_stock_iwi() {
    char exe[MAX_PATH] = {};
    ::GetModuleFileNameA(nullptr, exe, MAX_PATH);
    std::string dir(exe);
    dir = dir.substr(0, dir.find_last_of("\\/") + 1) + "main\\";
    std::vector<std::string> iwds;
    for (const char* pat : {"*.iwd"}) {
        WIN32_FIND_DATAA fd{};
        HANDLE h = ::FindFirstFileA((dir + pat).c_str(), &fd);
        if (h == INVALID_HANDLE_VALUE) continue;
        do { iwds.push_back(fd.cFileName); } while (::FindNextFileA(h, &fd));
        ::FindClose(h);
    }
    // The engine searches later packs first (iw_27 before iw_00; localized_ packs
    // above the rest); the atlas exists once in a stock install anyway.
    std::sort(iwds.begin(), iwds.end(), [](const std::string& a, const std::string& b) {
        const bool la = _strnicmp(a.c_str(), "localized_", 10) == 0, lb = _strnicmp(b.c_str(), "localized_", 10) == 0;
        if (la != lb) return la;
        return _stricmp(a.c_str(), b.c_str()) > 0;
    });
    std::string why;
    for (const auto& n : iwds) {
        std::vector<uint8_t> data;
        if (!zip_read_stored(dir + n, "images/gamefonts_pc.iwi", &data, &why)) continue;
        const bool shape = data.size() == 28 + kStockAtlasBytes && data[0] == 'I' && data[1] == 'W' &&
                           data[2] == 'i' && rd16(&data[6]) == 512 && rd16(&data[8]) == 512;
        if (!shape) { why = n + " holds a gamefonts_pc.iwi that is not the stock 512x512 atlas"; continue; }
        g_iwi = std::move(data);
        g_iwi_from = dir + n;
        return true;
    }
    g_fail = why.empty() ? "images/gamefonts_pc.iwi not found in " + dir + "*.iwd" : why;
    return false;
}

// On the device's thread. Ten DXT5 mips, 512 .. 1; the IWI stores them smallest first.
void make_texture(IDirect3DDevice9* dev) {
    IDirect3DTexture9* tex = nullptr;
    if (FAILED(dev->CreateTexture(512, 512, 10, 0, D3DFMT_DXT5, D3DPOOL_MANAGED, &tex, nullptr)) || !tex) {
        g_tex_state = -1;
        return;
    }
    size_t off = 28;
    for (int level = 9; level >= 0; --level) {
        const UINT dim = 512u >> level;
        const UINT blocks = (std::max)(1u, dim / 4);
        const size_t bytes = static_cast<size_t>(blocks) * blocks * 16;
        D3DLOCKED_RECT lr{};
        if (off + bytes > g_iwi.size() || FAILED(tex->LockRect(static_cast<UINT>(level), &lr, nullptr, 0))) {
            tex->Release();
            g_tex_state = -1;
            return;
        }
        for (UINT row = 0; row < blocks; ++row)
            std::memcpy(static_cast<uint8_t*>(lr.pBits) + row * lr.Pitch, &g_iwi[off + row * blocks * 16], blocks * 16);
        tex->UnlockRect(static_cast<UINT>(level));
        off += bytes;
    }
    g_image_words[1] = reinterpret_cast<uint32_t>(static_cast<IDirect3DBaseTexture9*>(tex));
    g_tex_state = 2;
}

// Copy a stock material (its texture images resolved to stock too) into `dst`.
bool clone_material(uint32_t live_mat, const char* name, uint8_t* dst, uint8_t* tt) {
    const uint32_t m = find_stock_slot(live_mat, kMaterialSlot, 0, name, 512);
    if (!m) { g_fail = std::string("no stock material '") + name + "'"; return false; }
    std::memcpy(dst, reinterpret_cast<const void*>(m), kMaterialSlot);
    const int n = (std::max)(1, (std::min)(8, static_cast<int>(dst[kMatTextureCount])));
    const uint32_t src_tt = *reinterpret_cast<const uint32_t*>(dst + kMatTextureTable);
    if (!readable(reinterpret_cast<void*>(src_tt), static_cast<size_t>(n) * kTexDef)) {
        g_fail = "stock texture table unreadable";
        return false;
    }
    std::memcpy(tt, reinterpret_cast<const void*>(src_tt), static_cast<size_t>(n) * kTexDef);
    *reinterpret_cast<uint32_t*>(dst + kMatTextureTable) = reinterpret_cast<uint32_t>(tt);
    // Every texture of the material is the atlas; point them all at OUR image,
    // whose texture is made from the player's own stock images/gamefonts_pc.iwi.
    for (int i = 0; i < n; ++i)
        *reinterpret_cast<uint32_t*>(tt + i * kTexDef + kTexDefImage) = reinterpret_cast<uint32_t>(g_image);
    ENW_INFO("stock_font:   material '%s': stock slot 0x%08X (live 0x%08X%s)", name, m, live_mat,
             m == live_mat ? ", not overridden" : ", OVERRIDDEN by a mod");
    return true;
}

void resolve() {
    if (g_state) return;
    const uint32_t live_big = *reinterpret_cast<const uint32_t*>(kLiveBig);
    if (!live_big) return;  // the UI is not up yet: try again later
    g_state = -1;
    // 1. the stock headers, by glyph-table hash
    for (auto& f : g_faces) {
        for (int i = -64; i <= 128 && !f.ok; ++i) {
            const uint32_t h = live_big + static_cast<uint32_t>(i) * kFontSlot;
            if (!readable(reinterpret_cast<void*>(h), kFontSlot)) continue;
            const auto* v = reinterpret_cast<const uint32_t*>(h);
            if (!str_eq(v[0], f.name)) continue;
            const size_t bytes = static_cast<size_t>(v[2]) * kFontSlot;
            if (v[2] == 0 || v[2] > 4096 || !readable(reinterpret_cast<void*>(v[5]), bytes)) continue;
            if (sha256::hex(reinterpret_cast<void*>(v[5]), bytes) != f.sha) continue;
            std::memcpy(f.hdr, v, sizeof f.hdr);
            f.ok = true;
            const bool live = h == *reinterpret_cast<const uint32_t*>(f.live);
            ENW_INFO("stock_font:   %s: stock header in font pool slot 0x%08X (%u px, %u glyphs)%s", f.name,
                     h, v[1], v[2], live ? ", the live one" : "; the live slot holds a mod's font");
        }
    }
    const face& big = g_faces[F_BIG];
    if (!big.ok) {
        g_fail = "no font with the stock bigFont glyph table (a non-English or patched install?)";
    } else {
        const uint32_t a = (std::min)(big.hdr[0], big.hdr[5]), b = (std::max)(big.hdr[0], big.hdr[5]);
        g_zone_lo = a > kZoneWindow ? a - kZoneWindow : 0;
        g_zone_hi = b + kZoneWindow;
        if (clone_material(big.hdr[3], "fonts/gamefonts_pc", g_mat, g_mat_tt) &&
            clone_material(big.hdr[4], "fonts/gamefonts_pc_glow", g_glow, g_glow_tt)) {
            for (auto& f : g_faces) {
                if (!f.ok) continue;
                f.hdr[3] = reinterpret_cast<uint32_t>(g_mat);
                f.hdr[4] = reinterpret_cast<uint32_t>(g_glow);
            }
            g_image_words[8] = reinterpret_cast<uint32_t>(kImageName);
            if (load_stock_iwi()) g_state = 2;   // the texture is made at the next Present
        }
    }
    if (g_state == 2)
        ENW_INFO("stock_font: stock glyph tables and materials found (stock zone 0x%08X..0x%08X); the "
                 "atlas comes from %s (%zu bytes)", g_zone_lo, g_zone_hi, g_iwi_from.c_str(), g_iwi.size());
    else
        ENW_WARN("stock_font: could not find the stock font (%s); drawing with the engine's current "
                 "fonts instead -- a mod's font will show", g_fail.c_str());
}

bool g_probed = false;

void dump_material(uint32_t m) {
    if (!readable(reinterpret_cast<void*>(m), 0x70)) return;
    ENW_INFO("font_probe:     material 0x%08X '%s': %s", m,
             cstr_at(*reinterpret_cast<const uint32_t*>(m)).c_str(), hexdump(m, 0x70).c_str());
    // any dword that points to readable memory whose +8 points to a struct naming an image
    for (uint32_t off = 0; off < 0x70; off += 4) {
        const uint32_t t = *reinterpret_cast<const uint32_t*>(m + off);
        if (!readable(reinterpret_cast<void*>(t), 0xC)) continue;
        const uint32_t img = *reinterpret_cast<const uint32_t*>(t + 8);
        if (!readable(reinterpret_cast<void*>(img), 0x40)) continue;
        for (uint32_t k = 0; k < 0x40; k += 4) {
            const std::string nm = cstr_at(*reinterpret_cast<const uint32_t*>(img + k));
            if (nm.size() > 3 && nm != "?") {
                ENW_INFO("font_probe:       +0x%02X -> table 0x%08X [%s] -> image 0x%08X name@+0x%02X '%s': %s",
                         off, t, hexdump(t, 0xC).c_str(), img, k, nm.c_str(), hexdump(img, 0x40).c_str());
                break;
            }
        }
    }
}

void probe_now() {
    if (g_probed) return;
    g_probed = true;
    const uint32_t live_big = *reinterpret_cast<const uint32_t*>(0x20A10E8);
    ENW_INFO("font_probe: sharedUiInfo bigFont 0x%08X small 0x%08X normal 0x%08X extraBig 0x%08X console 0x%08X",
             live_big, *reinterpret_cast<const uint32_t*>(0x20A10EC), *reinterpret_cast<const uint32_t*>(0x20A10F8),
             *reinterpret_cast<const uint32_t*>(0x20A10FC), *reinterpret_cast<const uint32_t*>(0x20A10F0));
    // The font pool: static .bss slots of 0x18 around the live pointer.
    const uint32_t lo = live_big - 0x18 * 24, hi = live_big + 0x18 * 24;
    for (uint32_t h = lo; h < hi; h += 4) {
        if (!readable(reinterpret_cast<void*>(h), 0x18)) continue;
        const auto* f = reinterpret_cast<const uint32_t*>(h);
        const std::string nm = cstr_at(f[0]);
        if (nm.rfind("fonts/", 0) != 0) continue;
        const int px = static_cast<int>(f[1]), cnt = static_cast<int>(f[2]);
        if (px <= 0 || px > 128 || cnt <= 0 || cnt > 4096) continue;
        std::string gh = "?";
        if (readable(reinterpret_cast<void*>(f[5]), static_cast<size_t>(cnt) * 0x18))
            gh = sha256::hex(reinterpret_cast<void*>(f[5]), static_cast<size_t>(cnt) * 0x18);
        ENW_INFO("font_probe:   slot 0x%08X '%s' px=%d glyphs=%d material=0x%08X glow=0x%08X glyphs@0x%08X sha256=%s",
                 h, nm.c_str(), px, cnt, f[3], f[4], f[5], gh.c_str());
        if (nm == "fonts/bigFont") dump_material(f[3]);
    }
}

}  // namespace

// The face for a real pixel scale, by World at War's own thresholds at their STOCK
// values (ui_smallFont 0.25, ui_bigFont 0.4, ui_extraBigFont 0.55, from their
// registration at 0x5D0430..0x5D048E) -- not the dvars, which a mod may change.
void* pick(float real_scale) {
    if (g_state == 0) resolve();
    if (g_state == 2) {
        const int t = g_tex_state.load();
        if (t == 0 && frame_capture::run_at_present(&make_texture)) g_tex_state = 1;
        if (t == 2) {
            g_state = 1;
            std::vector<uint8_t>().swap(g_iwi);
            ENW_INFO("stock_font: READY -- the overlay and the Esc menu draw with World at War's stock "
                     "font (this install's code_post_gfx glyph tables, its own stock atlas from %s), "
                     "whatever fonts or images a mod or map loads", g_iwi_from.c_str());
        }
        if (t == -1) {
            g_state = -1;
            ENW_WARN("stock_font: could not make the stock atlas texture; falling back to the engine's fonts");
        }
    }
    const int want = real_scale <= 0.25f ? F_SMALL : real_scale >= 0.55f ? F_XBIG
                     : real_scale >= 0.4f ? F_BIG : F_NORMAL;
    if (g_state == 1)
        for (int k = want; k >= 0; --k)   // a face that failed its hash falls back one smaller
            if (g_faces[k].ok) return g_faces[k].hdr;
    return *reinterpret_cast<void* const*>(g_faces[want].live);
}

// Called by the overlay on its first in-map frame.
void on_first_map_frame() {
    const char* v = std::getenv("ENW_FONT_PROBE");
    if (v && v[0] == '1') probe_now();
}

}  // namespace enw::client::stock_font
