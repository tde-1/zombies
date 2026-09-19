// SHA-256, public-domain-style reimplementation from FIPS 180-4.
// Needed for `hello.exe_sha256` (game-link v0) so the host can prove which
// binary an instance is actually running.
#pragma once
#include "enw.hpp"

namespace enw::sha256 {

std::string hex(const void* data, size_t size);

// Hex digest of a file, or "" if it cannot be read. Streams it: the exe is ~5.9 MB.
std::string file_hex(const std::string& path);

}  // namespace enw::sha256
