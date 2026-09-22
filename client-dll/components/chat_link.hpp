// What the launcher hands the game for cross-server chat, and how the overlay asks
// for it. Defined in auth_token.cpp, which owns the launcher's one-shot pipe.
//
// The launcher's pipe line (`launcher/src/main/launch.js`, serveToken) is
//     {"v":0, "token":"<invite, optional>", "chat":{"base":"https://...","bearer":"gc1...."}}
// `chat` is a per-launch bearer the SITE minted for the signed-in account
// (`POST /api/launcher/chat-token`): it is good for `/api/game-chat/*` and nothing
// else, for twelve hours, so the game never holds the site session itself.
//
// Dev fallback, for a harness with no launcher: ENW_CHAT_BASE + ENW_CHAT_BEARER,
// both cleared from the environment as soon as they are read.
#pragma once

#include <string>

namespace enw::auth {

// False when nothing was offered. Never logs the bearer.
bool chat_credentials(std::string* base, std::string* bearer);

}  // namespace enw::auth
