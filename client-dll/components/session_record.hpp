// session_record: the calls other client components make to keep session-<pid>.json
// current. Every one is cheap (interlocked stores, or one small file write at a moment
// that is already rare), none takes a lock the caller might hold, and all are no-ops
// when the record is off (ENW_SESSION_RECORD=0, a dedicated process, or no log dir).
// See session_record.cpp.
#pragma once

#include <cstdint>

struct _EXCEPTION_POINTERS;

namespace enw::client::session_record {

// overlay_guard: its address-space measurements (load-time, engine start, once a minute).
void note_largest_free(uint64_t bytes);
// overlay_guard: DiscordHook.dll loads refused so far.
void note_discord_refused(long count);
// menu_lockdown: the engine error text (com_errorMessage) the session ended on.
void note_error(const char* text);

// hang_watchdog, after its dump: exit 'hang'. `dump_path` null when the dump failed.
void write_hang(const char* dump_path);

// overlay_guard's unhandled-exception filter, BEFORE anything else: exit 'crash'. No
// heap, no CRT formatting, no locks; one CreateFileA/WriteFile/CloseHandle. Once.
void write_crash(const _EXCEPTION_POINTERS* ep);

}  // namespace enw::client::session_record
