// net_probe_client: how snapshots actually ARRIVE at the player's game, every 5 s.
//
// The server half is server/components/net/net_probe.cpp (docs/kickstart/dedi.md §22): the
// dedicated server throttled every internet client to sv_maxRate = 7000 bytes/s, which on a
// busy custom map (nazi_zombie_fear_mc_2) means a few snapshots a second instead of 20. This
// is the matching view from the other end of the wire, so a "laggy" report comes with numbers
// from the player's own log instead of a guess.
//
// HOW. An IAT hook on WSOCK32 #17 (recvfrom, IAT 0x7EB400 -- CoDWaW.exe imports every socket
// call by ordinal). For every datagram the game reads, keyed by source address: packets,
// bytes, max size, netchan fragments (sequence bit 31), out-of-band packets (sequence
// 0xFFFFFFFF), and -- for in-band packets -- the interval between arrivals: avg, max,
// standard deviation (jitter) and how many gaps exceeded 100 ms and 250 ms. Timestamps are
// taken when the game reads the socket, so they are quantised to the client's frame
// (<= 8 ms at 120 fps); a gap of 150 ms is a real gap.
//
// Logged as `net_probe_client:` every 5 s for the busiest source only (the game server), and
// only while packets are arriving. Not on a dedicated server. ENW_NET_PROBE=0 turns it off.
//
// Clean room: our own code.

#include "component.hpp"
#include "enw.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>

namespace enw::client {
namespace {

constexpr uint16_t kWsockRecvfromOrdinal = 17;
constexpr double kWindowMs = 5000.0;

struct sockaddr_in4 {
    uint16_t family;
    uint16_t port_be;
    uint8_t addr[4];
};

struct src_stats {
    bool used = false;
    uint32_t ip = 0;
    uint16_t port = 0;
    uint32_t pkts = 0, bytes = 0, max = 0, frags = 0, oob = 0;
    uint32_t inband = 0, gaps = 0, gap100 = 0, gap250 = 0;
    double last_ms = 0, gap_sum = 0, gap_sq = 0, gap_max = 0;
};

using recvfrom_t = int(__stdcall*)(uintptr_t, char*, int, int, void*, int*);
recvfrom_t g_orig = nullptr;
std::atomic<ULONGLONG> g_last_inband_tick{0};   // [lockdown] GetTickCount64 of the last in-band datagram
std::mutex g_mu;
src_stats g_src[8];
double g_window_start = 0;
double g_qpf_ms = 0;

double now_ms() {
    LARGE_INTEGER c;
    ::QueryPerformanceCounter(&c);
    return static_cast<double>(c.QuadPart) / g_qpf_ms;
}

void flush_locked(double t) {
    if (g_window_start == 0) { g_window_start = t; return; }
    if (t - g_window_start < kWindowMs) return;
    const double secs = (t - g_window_start) / 1000.0;
    g_window_start = t;

    src_stats* top = nullptr;
    for (auto& s : g_src)
        if (s.used && s.inband > 0 && (!top || s.inband > top->inband)) top = &s;
    if (top) {
        const auto* ip = reinterpret_cast<const uint8_t*>(&top->ip);
        const double avg = top->gaps ? top->gap_sum / top->gaps : 0.0;
        const double var = top->gaps ? top->gap_sq / top->gaps - avg * avg : 0.0;
        ENW_INFO("net_probe_client: %.1fs from %u.%u.%u.%u:%u pkts=%u (%.1f/s) bytes=%u (%.0f B/s) "
                 "max=%u frag=%u oob=%u | arrival gap avg=%.1f max=%.0f sd=%.1f ms, >100ms=%u "
                 ">250ms=%u",
                 secs, ip[0], ip[1], ip[2], ip[3],
                 static_cast<unsigned>((top->port >> 8) | ((top->port & 0xFF) << 8)), top->pkts,
                 top->pkts / secs, top->bytes, top->bytes / secs, top->max, top->frags, top->oob,
                 avg, top->gap_max, var > 0 ? std::sqrt(var) : 0.0, top->gap100, top->gap250);
    }
    for (auto& s : g_src) {
        if (!s.used) continue;
        const double last = s.last_ms;
        const uint32_t ipk = s.ip;
        const uint16_t pk = s.port;
        const bool keep = s.pkts > 0;
        s = src_stats{};
        if (keep) { s.used = true; s.ip = ipk; s.port = pk; s.last_ms = last; }
    }
}

int __stdcall recvfrom_hook(uintptr_t sock, char* buf, int len, int flags, void* from,
                            int* fromlen) {
    const int r = g_orig(sock, buf, len, flags, from, fromlen);
    if (r < 4 || !buf || !from || !fromlen || *fromlen < static_cast<int>(sizeof(sockaddr_in4)))
        return r;
    const DWORD err = ::GetLastError();
    const auto* sa = static_cast<const sockaddr_in4*>(from);
    if (sa->family != 2) return r;
    uint32_t ip, seq;
    std::memcpy(&ip, sa->addr, 4);
    std::memcpy(&seq, buf, 4);
    const double t = now_ms();
    {
        std::lock_guard<std::mutex> lk(g_mu);
        src_stats* s = nullptr;
        for (auto& e : g_src)
            if (e.used && e.ip == ip && e.port == sa->port_be) { s = &e; break; }
        if (!s)
            for (auto& e : g_src)
                if (!e.used) { e = src_stats{}; e.used = true; e.ip = ip; e.port = sa->port_be; s = &e; break; }
        if (s) {
            ++s->pkts;
            s->bytes += static_cast<uint32_t>(r);
            if (static_cast<uint32_t>(r) > s->max) s->max = static_cast<uint32_t>(r);
            if (seq == 0xFFFFFFFFu) {
                ++s->oob;
            } else {
                if (seq & 0x80000000u) ++s->frags;
                ++s->inband;
                if (s->last_ms > 0) {
                    const double g = t - s->last_ms;
                    ++s->gaps;
                    s->gap_sum += g;
                    s->gap_sq += g * g;
                    if (g > s->gap_max) s->gap_max = g;
                    if (g > 100) ++s->gap100;
                    if (g > 250) ++s->gap250;
                }
                s->last_ms = t;
                g_last_inband_tick = ::GetTickCount64();   // [lockdown] the server is still talking
            }
        }
        flush_locked(t);
    }
    ::SetLastError(err);
    return r;
}

bool cmdline_dedicated() {
    const char* cmd = ::GetCommandLineA();
    if (!cmd) return false;
    const char* p = cmd;
    while ((p = std::strstr(p, "dedicated")) != nullptr) {
        p += 9;
        while (*p == ' ' || *p == '\t' || *p == '"') ++p;
        if (*p == '1' || *p == '2') return true;
    }
    return false;
}

class net_probe_client final : public component {
public:
    const char* name() const override { return "net_probe_client"; }

    void post_unpack() override {
        if (cmdline_dedicated()) return;
        char v[8]{};
        if (::GetEnvironmentVariableA("ENW_NET_PROBE", v, sizeof v) && v[0] == '0') return;
        LARGE_INTEGER f;
        ::QueryPerformanceFrequency(&f);
        g_qpf_ms = static_cast<double>(f.QuadPart) / 1000.0;
        if (!memory::hook_import_ordinal("WSOCK32.dll", kWsockRecvfromOrdinal,
                                         reinterpret_cast<void*>(&recvfrom_hook),
                                         reinterpret_cast<void**>(&g_orig))) {
            ENW_WARN("net_probe_client: could not hook WSOCK32#17 (recvfrom); no arrival stats");
            return;
        }
        ENW_INFO("net_probe_client: armed (recvfrom, 5 s windows)");
    }
};

}  // namespace

// [lockdown] menu_lockdown.cpp: when did the server last send an in-band datagram (0 = never,
// or the probe is off). A box that is killed after a game over sends no disconnect, and this
// engine then never times the client out (l12b: 60 s at clc.state 10 with cl_timeout 10).
namespace net_probe_client_api {
ULONGLONG last_inband_tick() { return g_last_inband_tick.load(); }
}  // namespace net_probe_client_api
}  // namespace enw::client

ENW_REGISTER_COMPONENT(enw::client::net_probe_client)
