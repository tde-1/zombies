// Bounding the compressed-message decoder (CVE-2018-10718 class).
//
// THE BUG, as it actually is on our binary. `re`'s audit (docs/re/security-audit.md
// §1) found that MSG_ReadBitsCompress at 0x6751D0 bounds its decode loop only by
// the INPUT bit count and never against the destination, and that
// SV_ExecuteClientMessage (0x630F70) feeds it an attacker-controlled length on
// every message from a connected client. Confirmed here by reading the decoder
// out of our own decrypted dump:
//
//     lea  ebx, [esi*8]        ; total_bits = 8 * src_len
//     ...
//     mov  [esi], dl           ; write one output byte
//     add  esi, 1              ; advance dst
//     cmp  [esp+0x10], ebx     ; only ever compares CONSUMED BITS
//     jl   loop
//
// Nothing compares the output pointer with any end. Since a symbol can be as
// short as one bit, output can reach 8x input, and both destinations are only
// 0x20000 bytes.
//
// ONE CORRECTION TO THE AUDIT: it says the function "receives a capacity argument
// (0x20000) from both callers but ignores it". It does not receive one at all.
// The signature is three parameters in a compiler-chosen convention:
//
//     int MSG_ReadBitsCompress(int src_len /*eax*/, const void* src /*ecx*/,
//                              void* dst /*[esp+4]*/);        // returns bytes written
//
// (prologue `mov esi,eax` / `mov edi,ecx` / `mov ebp,[esp+0x14]`; the method-0
// branch does `memcpy(ebp, edi, esi)`; the loop returns `dst_end - dst_start`.
// Every `ret` is C3, so the caller cleans the one stack argument.)
// That makes it worse, not better: the decoder cannot bound its output even in
// principle, so the fix has to live outside it.
//
// THE FIX. We interpose on the decoder and give it somewhere safe to write:
//   1. decode into OUR scratch buffer, not the caller's;
//   2. the scratch is 8x the maximum input (the provable worst case: one output
//      byte per input bit) and is followed by a PAGE_NOACCESS guard page, so if
//      the worst case is ever wrong we take a clean AV inside our own allocation
//      instead of quietly corrupting the game's .data;
//   3. copy back at most the real destination capacity (0x20000, the size of
//      both the client buffer and the server's ring window);
//   4. if the decode produced more than that, copy nothing, return 0, and shout.
//      Failing closed is right here: a message that expands past the window is
//      not a message we want parsed.
//
// This protects the client and the server with one hook, which is why it lives
// in shared/core rather than either side's tree.
#include "../component.hpp"

#include "../hook.hpp"
#include "../logger.hpp"
#include "../memory.hpp"

#include "t4/addresses.hpp"

namespace enw {
namespace {

// Both decode destinations are 0x20000 (t4::size::decompress_window).
constexpr size_t kCapacity = 0x20000;

// A symbol is at least one bit, so output <= 8 * input. Input is capped by the
// netchan reassembly buffer at 0x20000, so 1 MiB is the true worst case. Round
// up and then guard the end anyway.
constexpr size_t kMaxInput = 0x20000;
constexpr size_t kScratch = kMaxInput * 8 + 0x10000;

hook g_hook;
uint8_t* g_scratch = nullptr;
volatile LONG g_calls = 0;
volatile LONG g_rejected_len = 0;
volatile LONG g_rejected_overflow = 0;
volatile LONG g_faults = 0;
volatile LONG g_max_out = 0;

using decoder_t = int(*)();  // never called directly; see call_original

// Call the original through MinHook's trampoline, reproducing the convention
// exactly: length in eax, source in ecx, destination pushed.
__declspec(noinline) int call_original(int src_len, const void* src, void* dst) {
    void* trampoline = g_hook.original<void*>();
    int result = 0;
    __asm {
        mov  eax, src_len
        mov  ecx, src
        push dst
        call trampoline
        add  esp, 4
        mov  result, eax
    }
    return result;
}

// SEH around the call: if our worst-case sizing is ever wrong the write lands on
// the guard page and we get an access violation here instead of corruption.
int call_original_guarded(int src_len, const void* src, void* dst, int* out) {
    __try {
        *out = call_original(src_len, src, dst);
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return static_cast<unsigned>(GetExceptionCode());
    }
}

int decode_bounded(int src_len, const void* src, void* dst) {
    ::InterlockedIncrement(&g_calls);

    if (!src || !dst || src_len <= 0 || static_cast<size_t>(src_len) > kMaxInput) {
        ::InterlockedIncrement(&g_rejected_len);
        ENW_WARN("huffman: rejecting a decode with src_len=%d (limit %u)", src_len,
                 static_cast<unsigned>(kMaxInput));
        return 0;
    }
    if (!g_scratch) return call_original(src_len, src, dst);  // guard never armed

    int produced = 0;
    const unsigned fault = call_original_guarded(src_len, src, g_scratch, &produced);
    if (fault) {
        ::InterlockedIncrement(&g_faults);
        ENW_ERROR("huffman: the decoder faulted (%08X) on a %d-byte message. It ran past even our "
                  "8x scratch buffer, which should be impossible - the guard page caught it and "
                  "the game's memory is intact. Dropping the message.",
                  fault, src_len);
        return 0;
    }

    if (produced < 0) produced = 0;
    if (static_cast<LONG>(produced) > ::InterlockedCompareExchange(&g_max_out, 0, 0)) {
        ::InterlockedExchange(&g_max_out, produced);
    }

    if (static_cast<size_t>(produced) > kCapacity) {
        ::InterlockedIncrement(&g_rejected_overflow);
        // This is the attack, or a corrupt stream. Either way the caller's buffer
        // is 0x20000 and we are not going to write more than that into it.
        ENW_ERROR("huffman: BLOCKED an overlong decode - %d bytes from a %d-byte message, "
                  "destination capacity is %u. Without this guard that would have written %d "
                  "bytes past the end of the decode window. Message dropped.",
                  produced, src_len, static_cast<unsigned>(kCapacity),
                  produced - static_cast<int>(kCapacity));
        return 0;
    }

    memcpy(dst, g_scratch, static_cast<size_t>(produced));
    return produced;
}

// The convention is compiler-chosen (eax/ecx/stack), so the entry point has to be
// naked: we cannot express it with any __cdecl/__stdcall/__fastcall declaration.
__declspec(naked) void decoder_detour() {
    __asm {
        // on entry: eax = src_len, ecx = src, [esp+4] = dst, [esp] = return address
        push ebp
        mov  ebp, esp
        push ebx
        push esi
        push edi

        push dword ptr [ebp + 8]   // dst
        push ecx                   // src
        push eax                   // src_len
        call decode_bounded
        add  esp, 12               // __cdecl: we clean our own call

        pop  edi
        pop  esi
        pop  ebx
        mov  esp, ebp
        pop  ebp
        ret                        // caller cleans `dst`, matching the original
    }
}

class huffman_guard final : public component {
public:
    const char* name() const override { return "huffman_guard"; }

    void post_unpack() override {
        // Allocate scratch + an unmapped guard page directly after it.
        const size_t total = kScratch + 0x1000;
        auto* base = static_cast<uint8_t*>(
            ::VirtualAlloc(nullptr, total, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
        if (!base) {
            ENW_ERROR("huffman: could not allocate the %u-byte scratch buffer; guard NOT armed",
                      static_cast<unsigned>(total));
            return;
        }
        DWORD old = 0;
        if (!::VirtualProtect(base + kScratch, 0x1000, PAGE_NOACCESS, &old)) {
            ENW_WARN("huffman: could not mark the guard page; the scratch is still 8x oversized");
        }
        g_scratch = base;

        if (!g_hook.create(t4::fn::MSG_ReadBitsCompress,
                           reinterpret_cast<void*>(&decoder_detour), "MSG_ReadBitsCompress")) {
            ENW_ERROR("huffman: could not hook the decoder at %08X. THE SERVER IS UNPROTECTED "
                      "against CVE-2018-10718-class compressed-message overflow.",
                      static_cast<unsigned>(t4::fn::MSG_ReadBitsCompress));
            ::VirtualFree(base, 0, MEM_RELEASE);
            g_scratch = nullptr;
            return;
        }

        ENW_INFO("huffman: bounded decode armed at %08X (scratch %u KB + guard page, "
                 "destination capacity %u)",
                 static_cast<unsigned>(t4::fn::MSG_ReadBitsCompress),
                 static_cast<unsigned>(kScratch / 1024), static_cast<unsigned>(kCapacity));
    }

    void post_init() override {
        if (!g_scratch) {
            ENW_WARN("huffman: guard is NOT armed - do not expose this instance to untrusted "
                     "clients");
        }
    }

    void pre_destroy() override {
        const LONG calls = ::InterlockedCompareExchange(&g_calls, 0, 0);
        if (calls) {
            ENW_INFO("huffman: %ld decodes, largest output %ld bytes, %ld rejected for length, "
                     "%ld blocked as overlong, %ld faults",
                     calls, ::InterlockedCompareExchange(&g_max_out, 0, 0),
                     ::InterlockedCompareExchange(&g_rejected_len, 0, 0),
                     ::InterlockedCompareExchange(&g_rejected_overflow, 0, 0),
                     ::InterlockedCompareExchange(&g_faults, 0, 0));
        }
        g_hook.remove();
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::huffman_guard)
