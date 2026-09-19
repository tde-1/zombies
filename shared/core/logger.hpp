// Logging: file + debugger + (once the game is unpacked) the in-game console.
#pragma once
#include "enw.hpp"

namespace enw::log {

enum class level { trace, debug, info, warn, error };

// Opens ZombiesDev\logs\<instance>\enw-<pid>.log (ENW_LOGDIR wins if set, else the
// directory this DLL lives in). Safe to call twice.
void init();
void shutdown();

// Thread-safe. Never throws; a logging failure must never take the game down.
void write(level lv, const char* fmt, ...);

// Mirror everything to the game console from now on. Called once the game's code
// is decrypted and Com_Printf has been verified.
void enable_game_console(bool on);

const std::string& file_path();

}  // namespace enw::log

#define ENW_TRACE(...) ::enw::log::write(::enw::log::level::trace, __VA_ARGS__)
#define ENW_DEBUG(...) ::enw::log::write(::enw::log::level::debug, __VA_ARGS__)
#define ENW_INFO(...)  ::enw::log::write(::enw::log::level::info,  __VA_ARGS__)
#define ENW_WARN(...)  ::enw::log::write(::enw::log::level::warn,  __VA_ARGS__)
#define ENW_ERROR(...) ::enw::log::write(::enw::log::level::error, __VA_ARGS__)
