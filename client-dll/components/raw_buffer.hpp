// raw_buffer.hpp -- where GetRawInputBuffer puts the RAWMOUSE, in THIS process.
//
// 2026-09-23 (client.md §1f). A 32-bit process on 64-bit Windows (WOW64 -- which
// is every player: CoDWaW.exe is x86) gets GetRawInputBuffer's blocks laid out
// with the 64-BIT RAWINPUTHEADER: dwType, dwSize, then an 8-byte hDevice and an
// 8-byte wParam, 24 bytes, where the 32-bit struct is 16. `ri->data.mouse` in
// 32-bit code therefore reads 8 bytes early:
//     lLastX  <- the real usButtonFlags | usButtonData << 16
//     lLastY  <- the real ulRawButtons (0)
//     usButtonFlags <- the high dword of the 64-bit wParam (0)
// i.e. every report taken through the buffered read lost its motion and its
// buttons, and a wheel notch turned into a ~7.8 million-count yaw.
//
// Prior art, not our discovery: Microsoft's GetRawInputBuffer remarks ("To ensure
// GetRawInputBuffer behaves properly on WOW64, you must align the RAWINPUT
// structure by 8 bytes", with `[FieldOffset(16+8)] RAWMOUSE mouse`), and SDL3's
// WIN_PollRawInput, which adds 8 to sizeof(RAWINPUTHEADER) when IsWow64Process is
// true. Proven on this box by tools/dev/rawprobe.cpp: injected moves carry a
// dwExtraInfo marker and the marker reads back only at the WOW64 offset.
//
// GetRawInputData (the per-WM_INPUT read) is NOT affected -- it thunks to the
// 32-bit layout -- which is why the dispatched reports were always fine and only
// the buffered ones were lost.
//
// NEXTRAWINPUTBLOCK stays correct on WOW64: it steps by header.dwSize (which
// includes the extra 8 bytes) and dwType/dwSize are the first two DWORDs in
// both layouts.
#pragma once

#include <windows.h>

namespace enw::rawbuf {

// Offset of the RAWMOUSE inside one GetRawInputBuffer block for a process with
// the given WOW64 state. Pure, so it is unit-testable.
constexpr unsigned mouse_offset_for(bool wow64, unsigned ptr_size) {
    return (ptr_size == 4 && wow64) ? 24u : static_cast<unsigned>(sizeof(RAWINPUTHEADER));
}

// For this process. Cached by the caller; IsWow64Process is cheap but not free.
inline unsigned mouse_offset() {
    BOOL wow = FALSE;
    if (!::IsWow64Process(::GetCurrentProcess(), &wow)) wow = FALSE;
    return mouse_offset_for(wow != FALSE, static_cast<unsigned>(sizeof(void*)));
}

inline const RAWMOUSE* mouse_of(const RAWINPUT* block, unsigned offset) {
    return reinterpret_cast<const RAWMOUSE*>(reinterpret_cast<const BYTE*>(block) + offset);
}

}  // namespace enw::rawbuf
