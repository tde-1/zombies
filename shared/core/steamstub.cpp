#include "steamstub.hpp"

#include "logger.hpp"
#include "memory.hpp"

namespace enw::steamstub {
namespace {
report g_report;
volatile LONG g_abort = 0;
}

void abort_wait() { ::InterlockedExchange(&g_abort, 1); }

bool is_protected_build() { return memory::section_by_name(".bind").valid(); }

bool is_encrypted() {
    const auto text = memory::text_section();
    if (!text.valid()) return false;
    uint32_t first = 0;
    if (!memory::read(text.start, &first)) return false;
    return first == kEncryptedMarker;
}

bool is_decrypted() {
    const auto text = memory::text_section();
    if (!text.valid()) return false;

    uint32_t first = 0;
    if (!memory::read(text.start, &first)) return false;
    if (first == kEncryptedMarker) return false;

    // The marker being gone is necessary but not sufficient -- an all-zero page
    // would also pass. Require real-looking code at the documented address.
    return memory::looks_like_function(at(kFirstCodeAddress));
}

bool wait_for_decrypt(unsigned timeout_ms) {
    const auto text = memory::text_section();
    g_report = {};
    g_report.protected_build = is_protected_build();

    if (!text.valid()) {
        ENW_ERROR("steamstub: no .text section in the main module - cannot tell. Refusing to patch.");
        return false;
    }

    memory::read(text.start, &g_report.first_text_dword);
    ENW_INFO("steamstub: image base %08X, .text %08X+%X, first dword %08X, .bind %s",
             static_cast<unsigned>(base()), static_cast<unsigned>(text.start),
             static_cast<unsigned>(text.size), g_report.first_text_dword,
             g_report.protected_build ? "present (SteamStub)" : "absent");

    if (!g_report.protected_build && is_decrypted()) {
        ENW_INFO("steamstub: unprotected build, code is already readable");
        g_report.decrypted = true;
        g_report.first_code_bytes = memory::hex_dump(at(kFirstCodeAddress), 16);
        return true;
    }

    ::InterlockedExchange(&g_abort, 0);
    const DWORD started = ::GetTickCount();
    unsigned polls = 0;
    // Short sleeps at first (the stub is usually done in well under a second),
    // then back off so a wedged launch does not spin a core for a minute.
    while (::GetTickCount() - started < timeout_ms) {
        if (::InterlockedCompareExchange(&g_abort, 0, 0) != 0) {
            ENW_WARN("steamstub: wait abandoned after %u ms (the DLL is being unloaded)",
                     ::GetTickCount() - started);
            return false;
        }
        if (is_decrypted()) {
            g_report.waited_ms = ::GetTickCount() - started;
            g_report.decrypted = true;
            memory::read(text.start, &g_report.first_text_dword);
            g_report.first_code_bytes = memory::hex_dump(at(kFirstCodeAddress), 16);
            ENW_INFO("steamstub: decrypted after %u ms (%u polls); 0x401000 = %s",
                     g_report.waited_ms, polls, g_report.first_code_bytes.c_str());
            return true;
        }
        ++polls;
        ::Sleep(polls < 200 ? 1 : 10);
    }

    g_report.waited_ms = ::GetTickCount() - started;
    memory::read(text.start, &g_report.first_text_dword);
    g_report.first_code_bytes = memory::hex_dump(at(kFirstCodeAddress), 16);
    ENW_ERROR("steamstub: STILL ENCRYPTED after %u ms. first dword %08X, 0x401000 = %s. "
              "Is the Steam client running and does this account own app 10090? "
              "Not touching game memory.",
              g_report.waited_ms, g_report.first_text_dword, g_report.first_code_bytes.c_str());
    return false;
}

report last_report() { return g_report; }

}  // namespace enw::steamstub
