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
// HOW IT REACHES USERINFO. `re` gave us DVAR_FLAG_USERINFO = 0x2 and
// Dvar_RegisterString at 0x5EED90, but that function's prologue shows eight-plus
// arguments including two 8-byte domain values, so it is the generic register
// helper rather than a tidy string one, and I will not guess that layout. We use
// the engine's own front door instead -- `setu`, which is exactly the command for
// registering a USERINFO dvar. See write_userinfo_cfg() below for the mechanics
// and why the token still never appears in argv.
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

// Where we drop the one-line config the engine execs for us. Instance-private.
std::string g_cfg_path;

// Put the token into userinfo.
//
// `re` established DVAR_FLAG_USERINFO = 0x2 (from the resend gate at 0x644B64 on
// dvar_modifiedFlags 0x21ACF30) and gave us Dvar_RegisterString at 0x5EED90.
// I am NOT calling that directly: its prologue shows an ebp frame taking
// arguments at +0x08, +0x0C, +0x10, +0x14 (8 bytes), +0x1C (8 bytes), +0x24,
// +0x28 and +0x2C -- it is the generic registration helper with a domain, not a
// tidy four-argument string register, and I cannot confirm that layout from a
// prologue. Guessing it would corrupt the dvar system.
//
// So we use the engine's own front door instead. `setu` registers a dvar with
// the USERINFO flag and is exactly what this is for; the console command router
// is at 0x5A00E0 and the engine execs config files during startup anyway. We
// write one line into the instance's own `main/enw_auth.cfg` before the engine
// starts (post_load runs before any engine code) and the launcher passes
// `+exec enw_auth.cfg`. THE TOKEN IS STILL NOT ON THE COMMAND LINE -- argv
// carries only the filename. The file lives in this instance's private homepath
// and we delete it in post_init, as soon as the engine has read it.
//
// When `re` hands over the full Dvar_RegisterString prototype this becomes a
// direct call and the file goes away.
bool write_userinfo_cfg(const std::string& homepath) {
    if (!g_present || homepath.empty()) return false;

    std::string dir = homepath;
    while (!dir.empty() && (dir.back() == '\\' || dir.back() == '/')) dir.pop_back();
    dir += "\\main";
    ::CreateDirectoryA(dir.c_str(), nullptr);
    g_cfg_path = dir + "\\enw_auth.cfg";

    // The token is b64url plus one dot -- validated above -- so it cannot break
    // out of the quotes or inject a second command.
    const std::string line = "setu enw_token \"" + g_token + "\"\n";

    HANDLE h = ::CreateFileA(g_cfg_path.c_str(), GENERIC_WRITE, 0 /*no sharing*/, nullptr,
                             CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const BOOL ok = ::WriteFile(h, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
    ::CloseHandle(h);
    return ok && written == line.size();
}

void remove_userinfo_cfg() {
    if (g_cfg_path.empty()) return;
    // Overwrite before unlinking: the token should not survive in free blocks.
    HANDLE h = ::CreateFileA(g_cfg_path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                             FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        std::string blank(256, ' ');
        DWORD n = 0;
        ::WriteFile(h, blank.data(), static_cast<DWORD>(blank.size()), &n, nullptr);
        ::CloseHandle(h);
    }
    ::DeleteFileA(g_cfg_path.c_str());
    g_cfg_path.clear();
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

        // Must happen here, before the engine starts, so `+exec enw_auth.cfg`
        // finds the file.
        char home[MAX_PATH]{};
        const DWORD hn = ::GetEnvironmentVariableA("ENW_FS_HOMEPATH", home, sizeof(home));
        if (hn == 0 || hn >= sizeof(home)) {
            ENW_ERROR("auth: ENW_FS_HOMEPATH is not set, so there is nowhere instance-private to "
                      "put the userinfo config. Token NOT installed.");
            return;
        }
        if (auth::write_userinfo_cfg(std::string(home, hn))) {
            ENW_INFO("auth: wrote the userinfo config; the launcher's +exec will register "
                     "enw_token as a USERINFO dvar (flag 0x2)");
        } else {
            ENW_ERROR("auth: could not write the userinfo config (err %lu); token NOT installed",
                      ::GetLastError());
        }
    }

    void post_init() override {
        if (!auth::g_present) return;

        // Delete the file the moment the engine has had its chance to exec it.
        auth::remove_userinfo_cfg();

        // Verify rather than assume: if the dvar exists, `setu` ran and the
        // token is in userinfo. find_dvar is the one dvar call we have proven.
        if (game::find_dvar("enw_token") != nullptr) {
            auth::g_installed = true;
            ENW_INFO("auth: enw_token is registered - the token is in userinfo");
            game_link::get().send_log("info", "invite token installed in userinfo");
            return;
        }
        ENW_WARN("auth: enw_token did NOT register. Either the launcher did not pass "
                 "'+exec enw_auth.cfg', or the engine execs it later than post_init. The server "
                 "will see a connect with no token.");
        game_link::get().send_log("warn", "invite token did not reach userinfo");
    }

    void pre_destroy() override {
        auth::remove_userinfo_cfg();
        if (!auth::g_token.empty()) {
            SecureZeroMemory(&auth::g_token[0], auth::g_token.size());
            auth::g_token.clear();
        }
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::auth_token)
