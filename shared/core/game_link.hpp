// The game half of docs/protocol/game-link-v0.md.
//
// One TCP connection to ENW_HOST, NDJSON both ways, driven by ONE background
// thread. The contract that matters:
//
//   * send() NEVER blocks and never touches the socket. It appends to a bounded
//     queue and returns. If the host is wedged we DROP THE OLDEST message and
//     count it -- a game frame must never wait on a socket.
//   * the worker reconnects with exponential backoff and re-sends `hello`.
//   * inbound commands are dispatched to handlers registered by `t`. By default a
//     handler runs on the GAME thread (queued, then drained by pump()), because
//     almost everything the host asks for -- exec, dvar set, pause -- is only
//     safe there. Pass want_game_thread=false for something genuinely thread-safe.
//
// pump() must be called from a game-thread hook once per frame. Until somebody
// hooks a frame function it simply never drains, and the inbound queue caps out
// (bounded, oldest dropped) rather than growing.
#pragma once
#include "enw.hpp"

#include "json.hpp"

#include <atomic>
#include <functional>

namespace enw {

class game_link {
public:
    static game_link& get();

    struct config {
        std::string host = "127.0.0.1";
        uint16_t port = 0;         // 0 => no ENW_HOST, stay dormant
        std::string instance;
        std::string role = "solo";
        size_t out_queue_max = 4096;
        size_t in_queue_max = 1024;
        size_t max_line = 1 << 20;  // a peer that never sends \n gets dropped
    };

    struct stats {
        uint64_t sent = 0;
        uint64_t dropped = 0;
        uint64_t received = 0;
        uint64_t bad_lines = 0;
        uint64_t connects = 0;
        bool connected = false;
    };

    // Reads ENW_HOST / ENW_INSTANCE / ENW_ROLE. Returns false if ENW_HOST is
    // absent or unparseable -- that is normal for a hand-launched game and is
    // not an error.
    bool configure_from_environment();
    void configure(const config& c);

    void start();
    void stop();

    bool connected() const { return connected_.load(std::memory_order_relaxed); }
    stats snapshot_stats() const;
    const config& settings() const { return cfg_; }

    // --- game -> host ---
    // Queues one NDJSON line. `obj` must be a complete JSON object without a
    // trailing newline. Returns false only if the link is off.
    bool send_line(std::string obj);
    bool send(json::writer& w) { return send_line(w.done()); }

    // Convenience for the common shapes.
    bool send_log(const char* level, const char* fmt, ...);
    bool send_reply(const std::string& id, bool ok, std::string_view error = {},
                    std::string_view raw_value = {});

    // Monotonic ms since the DLL loaded; used for `ms` until level.time is wired up.
    static uint32_t now_ms();

    // --- host -> game ---
    using handler = std::function<void(const json::value&)>;
    void on(const std::string& type, handler h, bool want_game_thread = true);

    // Drain queued game-thread handlers. Call from a frame hook.
    size_t pump(size_t max_messages = 32);

private:
    game_link() = default;
    ~game_link();
    game_link(const game_link&) = delete;
    game_link& operator=(const game_link&) = delete;

    void worker();
    bool connect_once(uintptr_t* out_socket);
    void send_hello();
    void dispatch(const json::value& msg);

    config cfg_;
    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};
    void* thread_ = nullptr;
    struct impl;
    impl* impl_ = nullptr;
};

}  // namespace enw
