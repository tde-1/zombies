#include "game_link.hpp"

#include "logger.hpp"
#include "sha256.hpp"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <cstdarg>
#include <deque>
#include <map>
#include <mutex>

#pragma comment(lib, "ws2_32.lib")

namespace enw {
namespace {

std::string env(const char* name) {
    char buf[1024]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}

std::string exe_path() {
    char buf[MAX_PATH]{};
    ::GetModuleFileNameA(nullptr, buf, MAX_PATH);
    return buf;
}

const uint32_t g_start_tick = ::GetTickCount();

}  // namespace

struct game_link::impl {
    std::mutex out_mutex;
    std::deque<std::string> out;

    std::mutex in_mutex;
    std::deque<json::value> in;

    std::mutex handler_mutex;
    std::map<std::string, std::pair<handler, bool>> handlers;  // type -> (fn, wants game thread)

    mutable std::mutex stats_mutex;
    game_link::stats st;

    HANDLE wake = nullptr;  // poked when there is something to send
    std::string dll_build;
    std::string exe_hash;   // computed lazily on the worker; ~5.9 MB, not on the game thread
};

game_link& game_link::get() {
    static game_link instance;
    return instance;
}

game_link::~game_link() { stop(); }

uint32_t game_link::now_ms() { return ::GetTickCount() - g_start_tick; }

void game_link::configure(const config& c) {
    cfg_ = c;
    if (!impl_) impl_ = new impl();
}

bool game_link::configure_from_environment() {
    if (!impl_) impl_ = new impl();

    const std::string host = env("ENW_HOST");
    cfg_.instance = env("ENW_INSTANCE");
    const std::string role = env("ENW_ROLE");
    if (!role.empty()) cfg_.role = role;
    if (cfg_.instance.empty()) cfg_.instance = "unnamed";

    if (host.empty()) {
        ENW_INFO("game-link: ENW_HOST is not set; link stays off (this is fine for a manual launch)");
        cfg_.port = 0;
        return false;
    }
    const auto colon = host.rfind(':');
    if (colon == std::string::npos) {
        ENW_WARN("game-link: ENW_HOST='%s' has no :port; link off", host.c_str());
        cfg_.port = 0;
        return false;
    }
    cfg_.host = host.substr(0, colon);
    const int port = atoi(host.c_str() + colon + 1);
    if (port <= 0 || port > 65535) {
        ENW_WARN("game-link: ENW_HOST='%s' has a bad port; link off", host.c_str());
        cfg_.port = 0;
        return false;
    }
    cfg_.port = static_cast<uint16_t>(port);
    ENW_INFO("game-link: host %s:%u instance='%s' role='%s'", cfg_.host.c_str(), cfg_.port,
             cfg_.instance.c_str(), cfg_.role.c_str());
    return true;
}

void game_link::start() {
    if (!impl_) impl_ = new impl();
    if (cfg_.port == 0) return;
    if (running_.exchange(true)) return;

    impl_->wake = ::CreateEventA(nullptr, FALSE, FALSE, nullptr);
    thread_ = ::CreateThread(
        nullptr, 0,
        [](LPVOID p) -> DWORD {
            static_cast<game_link*>(p)->worker();
            return 0;
        },
        this, 0, nullptr);
    if (!thread_) {
        running_ = false;
        ENW_ERROR("game-link: CreateThread failed (%lu)", ::GetLastError());
    }
}

void game_link::stop() {
    if (!running_.exchange(false)) return;
    if (impl_ && impl_->wake) ::SetEvent(impl_->wake);
    if (thread_) {
        // The worker polls running_ at most every 200 ms.
        ::WaitForSingleObject(thread_, 3000);
        ::CloseHandle(thread_);
        thread_ = nullptr;
    }
    if (impl_ && impl_->wake) {
        ::CloseHandle(impl_->wake);
        impl_->wake = nullptr;
    }
}

game_link::stats game_link::snapshot_stats() const {
    if (!impl_) return {};
    std::lock_guard<std::mutex> lk(impl_->stats_mutex);
    stats s = impl_->st;
    s.connected = connected_.load(std::memory_order_relaxed);
    return s;
}

bool game_link::send_line(std::string obj) {
    if (!impl_ || cfg_.port == 0) return false;
    obj.push_back('\n');
    size_t dropped_now = 0;
    {
        std::lock_guard<std::mutex> lk(impl_->out_mutex);
        impl_->out.emplace_back(std::move(obj));
        while (impl_->out.size() > cfg_.out_queue_max) {
            impl_->out.pop_front();  // drop OLDEST: fresh state beats stale state
            ++dropped_now;
        }
    }
    if (dropped_now) {
        std::lock_guard<std::mutex> lk(impl_->stats_mutex);
        impl_->st.dropped += dropped_now;
    }
    if (impl_->wake) ::SetEvent(impl_->wake);
    return true;
}

bool game_link::send_log(const char* level, const char* fmt, ...) {
    char body[1024];
    va_list args;
    va_start(args, fmt);
    _vsnprintf_s(body, sizeof(body), _TRUNCATE, fmt, args);
    va_end(args);

    json::writer w;
    w.str("t", "log").integer("ms", now_ms()).str("level", level).str("msg", body);
    return send(w);
}

bool game_link::send_reply(const std::string& id, bool ok, std::string_view error,
                           std::string_view raw_value) {
    json::writer w;
    w.str("t", "reply").integer("ms", now_ms()).str("id", id).boolean("ok", ok);
    if (!error.empty()) w.str("error", error);
    if (!raw_value.empty()) w.raw("value", raw_value);
    return send(w);
}

void game_link::on(const std::string& type, handler h, bool want_game_thread) {
    if (!impl_) impl_ = new impl();
    std::lock_guard<std::mutex> lk(impl_->handler_mutex);
    impl_->handlers[type] = {std::move(h), want_game_thread};
}

void game_link::dispatch(const json::value& msg) {
    const std::string t = msg.str_or("t");
    if (t.empty()) return;

    handler fn;
    bool game_thread = true;
    {
        std::lock_guard<std::mutex> lk(impl_->handler_mutex);
        const auto it = impl_->handlers.find(t);
        // Unknown `t` values are ignored -- that is the protocol's forward-compat rule.
        if (it == impl_->handlers.end()) return;
        fn = it->second.first;
        game_thread = it->second.second;
    }

    if (!game_thread) {
        fn(msg);
        return;
    }

    std::lock_guard<std::mutex> lk(impl_->in_mutex);
    impl_->in.push_back(msg);
    while (impl_->in.size() > cfg_.in_queue_max) impl_->in.pop_front();
}

size_t game_link::pump(size_t max_messages) {
    if (!impl_) return 0;
    size_t done = 0;
    while (done < max_messages) {
        json::value msg;
        {
            std::lock_guard<std::mutex> lk(impl_->in_mutex);
            if (impl_->in.empty()) break;
            msg = std::move(impl_->in.front());
            impl_->in.pop_front();
        }
        handler fn;
        {
            std::lock_guard<std::mutex> lk(impl_->handler_mutex);
            const auto it = impl_->handlers.find(msg.str_or("t"));
            if (it != impl_->handlers.end()) fn = it->second.first;
        }
        if (fn) fn(msg);
        ++done;
    }
    return done;
}

void game_link::send_hello() {
    json::writer w;
    w.integer("v", 0)
        .str("t", "hello")
        .integer("ms", now_ms())
        .str("instance", cfg_.instance)
        .str("role", cfg_.role)
        .integer("pid", static_cast<long long>(::GetCurrentProcessId()))
        .str("exe_sha256", impl_->exe_hash)
        .str("dll_build", impl_->dll_build);
    send_line(w.done());
}

bool game_link::connect_once(uintptr_t* out_socket) {
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    char port_text[8];
    _snprintf_s(port_text, sizeof(port_text), _TRUNCATE, "%u", cfg_.port);

    addrinfo* res = nullptr;
    if (::getaddrinfo(cfg_.host.c_str(), port_text, &hints, &res) != 0 || !res) return false;

    const SOCKET s = ::socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == INVALID_SOCKET) {
        ::freeaddrinfo(res);
        return false;
    }
    const bool ok = ::connect(s, res->ai_addr, static_cast<int>(res->ai_addrlen)) != SOCKET_ERROR;
    ::freeaddrinfo(res);
    if (!ok) {
        ::closesocket(s);
        return false;
    }

    BOOL nodelay = TRUE;
    ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay), sizeof(nodelay));
    u_long nonblocking = 1;
    ::ioctlsocket(s, FIONBIO, &nonblocking);

    *out_socket = static_cast<uintptr_t>(s);
    return true;
}

void game_link::worker() {
    WSADATA wsa{};
    if (::WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        ENW_ERROR("game-link: WSAStartup failed");
        running_ = false;
        return;
    }

    impl_->dll_build = __DATE__ " " __TIME__;
    impl_->exe_hash = sha256::file_hex(exe_path());
    ENW_INFO("game-link: exe sha256 %s", impl_->exe_hash.c_str());

    unsigned backoff_ms = 250;
    constexpr unsigned kMaxBackoff = 10000;
    std::string inbuf;

    while (running_.load(std::memory_order_relaxed)) {
        uintptr_t raw = 0;
        if (!connect_once(&raw)) {
            // Quiet about it: with no host agent running this would otherwise spam.
            ENW_DEBUG("game-link: connect to %s:%u failed, retrying in %u ms", cfg_.host.c_str(),
                      cfg_.port, backoff_ms);
            ::WaitForSingleObject(impl_->wake, backoff_ms);
            backoff_ms = backoff_ms * 2 > kMaxBackoff ? kMaxBackoff : backoff_ms * 2;
            continue;
        }

        const SOCKET s = static_cast<SOCKET>(raw);
        backoff_ms = 250;
        connected_ = true;
        inbuf.clear();
        {
            std::lock_guard<std::mutex> lk(impl_->stats_mutex);
            ++impl_->st.connects;
        }
        ENW_INFO("game-link: connected to %s:%u", cfg_.host.c_str(), cfg_.port);
        send_hello();

        std::string pending;  // the line we are part-way through writing

        while (running_.load(std::memory_order_relaxed)) {
            fd_set rd, wr;
            FD_ZERO(&rd);
            FD_ZERO(&wr);
            FD_SET(s, &rd);

            bool want_write = !pending.empty();
            if (!want_write) {
                std::lock_guard<std::mutex> lk(impl_->out_mutex);
                want_write = !impl_->out.empty();
            }
            if (want_write) FD_SET(s, &wr);

            timeval tv{0, 200 * 1000};  // 200 ms, so stop() is noticed promptly
            const int n = ::select(0, &rd, want_write ? &wr : nullptr, nullptr, &tv);
            if (n == SOCKET_ERROR) break;

            if (FD_ISSET(s, &rd)) {
                char buf[4096];
                const int got = ::recv(s, buf, sizeof(buf), 0);
                if (got == 0) break;  // clean close
                if (got < 0) {
                    if (::WSAGetLastError() != WSAEWOULDBLOCK) break;
                } else {
                    inbuf.append(buf, static_cast<size_t>(got));
                    size_t nl;
                    while ((nl = inbuf.find('\n')) != std::string::npos) {
                        std::string line = inbuf.substr(0, nl);
                        inbuf.erase(0, nl + 1);
                        if (!line.empty() && line.back() == '\r') line.pop_back();
                        if (line.empty()) continue;

                        json::value msg;
                        if (!json::parse(line, &msg) || msg.type != json::kind::object) {
                            std::lock_guard<std::mutex> lk(impl_->stats_mutex);
                            ++impl_->st.bad_lines;
                            continue;
                        }
                        {
                            std::lock_guard<std::mutex> lk(impl_->stats_mutex);
                            ++impl_->st.received;
                        }
                        dispatch(msg);
                    }
                    if (inbuf.size() > cfg_.max_line) {
                        ENW_WARN("game-link: host sent %u bytes with no newline; dropping the link",
                                 static_cast<unsigned>(inbuf.size()));
                        break;
                    }
                }
            }

            if (want_write && FD_ISSET(s, &wr)) {
                if (pending.empty()) {
                    std::lock_guard<std::mutex> lk(impl_->out_mutex);
                    if (!impl_->out.empty()) {
                        pending = std::move(impl_->out.front());
                        impl_->out.pop_front();
                    }
                }
                if (!pending.empty()) {
                    const int put = ::send(s, pending.data(), static_cast<int>(pending.size()), 0);
                    if (put == SOCKET_ERROR) {
                        if (::WSAGetLastError() != WSAEWOULDBLOCK) break;
                    } else {
                        pending.erase(0, static_cast<size_t>(put));
                        if (pending.empty()) {
                            std::lock_guard<std::mutex> lk(impl_->stats_mutex);
                            ++impl_->st.sent;
                        }
                    }
                }
            }
        }

        connected_ = false;
        ::closesocket(s);
        if (running_.load(std::memory_order_relaxed)) {
            ENW_WARN("game-link: disconnected; reconnecting in %u ms", backoff_ms);
            ::WaitForSingleObject(impl_->wake, backoff_ms);
        }
    }

    connected_ = false;
    ::WSACleanup();
}

}  // namespace enw
