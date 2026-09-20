// The invite token, client side.
//
// The site issues `<payload-b64url>.<sig-b64url>` (Ed25519, bound to steamid +
// match id, 5-minute TTL -- infra/host-agent/lib/tokens.js). The game carries it
// in **userinfo** at connect; the server reads it out of `client_s.userinfo`
// (+0x6F0) in SV_DirectConnect and asks the host agent, which answers
// `auth {slot, allow, reason}` over the game link.
//
// NEVER ON THE COMMAND LINE. A command line is readable by every process on the
// box (and lands in our own logs, and in `ps` output, and in crash dumps). We
// take it from the environment, which is per-process and which we can then
// scrub. The launcher sets `ENW_AUTH_TOKEN`; this component reads it once in
// post_load and immediately clears the variable so it is not inherited by any
// child process and not visible to anything that walks our environment block
// afterwards.
//
// WHAT IS STILL MISSING, honestly: getting the string INTO userinfo. That needs
// one of
//   * `Dvar_SetStringByName` / `Dvar_RegisterString` plus the USERINFO flag
//     value, so we can set a userinfo dvar directly; or
//   * `Cbuf_AddText`, so we can run `setu enw_token <value>`; or
//   * `CL_Connect` / the userinfo builder, to append it as the connect string is
//     assembled.
// None of those is verified on our binary yet -- `Dvar_FindVar` and
// `Dvar_RegisterBool/Enum` are, but not a string setter. Asked `re` on the
// board. Everything either side of that gap is done and tested: the token
// arrives, is validated for shape, is held privately, and there is a single
// function to call once the seam exists.
#include "../../shared/core/component.hpp"

#include "../../shared/core/game.hpp"
#include "../../shared/core/game_link.hpp"
#include "../../shared/core/logger.hpp"

namespace enw {
namespace auth {

namespace {

std::string g_token;
bool g_present = false;
bool g_installed = false;

// b64url alphabet plus the single separating dot. Anything else is not one of
// ours and we would rather say so here than have the server reject it later.
bool looks_like_token(const std::string& t) {
    if (t.size() < 32 || t.size() > 1024) return false;
    const size_t dot = t.find('.');
    if (dot == std::string::npos || dot == 0 || dot + 1 >= t.size()) return false;
    if (t.find('.', dot + 1) != std::string::npos) return false;  // exactly one dot
    for (const char c : t) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
        if (!ok) return false;
    }
    return true;
}

// Never log the token itself. This is what goes in the log instead.
std::string fingerprint(const std::string& t) {
    if (t.size() < 12) return "<short>";
    return t.substr(0, 6) + "..." + t.substr(t.size() - 4) + " (" + std::to_string(t.size()) + " chars)";
}

}  // namespace

bool have_token() { return g_present; }
const std::string& token() { return g_token; }

// Call once the userinfo seam exists. Returns false while it does not.
bool install_into_userinfo() {
    if (!g_present) return false;
    // TODO(re): needs Dvar_SetStringByName / Cbuf_AddText / the userinfo builder.
    // The value to set is `enw_token` = token(), flagged USERINFO, before connect.
    return false;
}

bool installed() { return g_installed; }

}  // namespace auth

namespace {

class auth_token final : public component {
public:
    const char* name() const override { return "auth_token"; }

    void post_load() override {
        char buf[2048]{};
        const DWORD n = ::GetEnvironmentVariableA("ENW_AUTH_TOKEN", buf, sizeof(buf));
        if (n == 0 || n >= sizeof(buf)) {
            ENW_DEBUG("auth: no ENW_AUTH_TOKEN in the environment (fine for a solo run)");
            return;
        }

        std::string t(buf, n);
        // Scrub our own copy of the buffer and the environment variable straight
        // away, whatever happens next.
        SecureZeroMemory(buf, sizeof(buf));
        ::SetEnvironmentVariableA("ENW_AUTH_TOKEN", nullptr);

        if (!auth::looks_like_token(t)) {
            ENW_ERROR("auth: ENW_AUTH_TOKEN is not shaped like an invite token "
                      "(expected <b64url>.<b64url>); ignoring it");
            SecureZeroMemory(&t[0], t.size());
            return;
        }

        auth::g_token = std::move(t);
        auth::g_present = true;
        ENW_INFO("auth: invite token accepted %s; cleared from the environment",
                 auth::fingerprint(auth::g_token).c_str());
    }

    void post_init() override {
        if (!auth::g_present) return;
        if (auth::install_into_userinfo()) {
            auth::g_installed = true;
            ENW_INFO("auth: token placed in userinfo");
            return;
        }
        ENW_WARN("auth: HAVE a valid token but no way to put it in userinfo yet - the server will "
                 "see a connect with no token and reject it. Needs Dvar_SetStringByName, "
                 "Cbuf_AddText or the userinfo builder from `re`.");
        game_link::get().send_log("warn", "invite token held but userinfo seam is missing");
    }

    void pre_destroy() override {
        if (!auth::g_token.empty()) {
            SecureZeroMemory(&auth::g_token[0], auth::g_token.size());
            auth::g_token.clear();
        }
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::auth_token)
