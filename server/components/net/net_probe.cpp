// net_probe: what the dedicated server actually puts on the wire, per client, every 5 s --
// and the one dvar that was throttling every internet player (sv_maxRate).
//
// WHY. B, 2026-09-23 01:24-01:27 box time, on nazi_zombie_fear_mc_2: "extremely laggy,
// pretty much unplayable", while the server frame loop held a flat 60.8 Hz on a box at
// load 0.6 and his client ran 120-228 fps. Neither end was slow; the wire between them was.
//
// THE MECHANISM, read from the decrypted 1.7 image (tools/re/t4map.py; docs/re/t4-sp-map.md):
//   0x632B10  SV_Init registers `sv_maxRate`: default 0x1B58 = **7000** bytes/s, domain
//             0..25000, dvar pointer stored at [0x2FCD9C4].
//   0x630650  SV_UserinfoChanged: client_t+0x323E8 = userinfo `rate` clamped 1000..90000
//             (5000 when absent); client_t+0x323EC = 1000 / userinfo `snaps` (snaps 1..30,
//             50 ms when absent).
//   0x6392D0  SV_RateMsec(client, msgSize): size clamped to 0x48C (1164);
//             rate = min(client rate, sv_maxRate); return (size + 64) * 1000 / rate.
//   0x6393F0  SV_SendMessageToClient: after Netchan_Transmit (0x678450) --
//               loopback (adr type 2) or Sys_IsLANAddress (0x600280)
//                 -> nextSnapshotTime = svs.time - 1          (NO THROTTLE AT ALL)
//               else msec = SV_RateMsec(); if msec < snapshotMsec: msec = snapshotMsec,
//                    rateDelayed(client+0x10) = 0, else rateDelayed = 1;
//                    nextSnapshotTime(client+0x1161C) = svs.time + msec.
//   0x639BD0  SV_SendClientMessages: clients at 0x2547090, stride 0x58D30; svs.time at
//             0x2547084; pending fragments (client+0x50) go out paced the same way.
//
// So an internet client gets at most sv_maxRate = 7000 bytes a second. At sv_fps 20 that is
// (7000/20) - 64 = 286 bytes a snapshot before the server starts skipping frames; a busy
// custom map's snapshot is several times that, so the player gets a handful of snapshots a
// second: zombies that jump, rubber-banding. EVERY local test we have ever run was on
// 127.0.0.1, which Sys_IsLANAddress calls LAN, which skips the rate code entirely -- the
// harness could never have seen this.
//
// At rate 25000 the formula cannot exceed 50 ms ((1164 + 64) * 1000 / 25000 = 49.1 ms), so a
// 20 Hz client is never throttled at all. 25000 is also the most the engine allows: it is
// sv_maxRate's domain maximum and the client `rate` dvar's (0x6465BF: 1000..25000, default
// 25000). So this component raises sv_maxRate to 25000 at the first frame, through the
// engine's own int setter (0x5EF390: value in ECX, dvar and source on the stack).
//
// WHAT IT LOGS (every 5 s, `net_probe:`), dedicated only:
//   * sv_maxRate, and per connected client: state, userinfo rate, effective rate,
//     snapshotMsec, messages sent (detected as nextSnapshotTime changing), how many of them
//     the rate code delayed (rateDelayed), the delay the engine chose (avg / max ms),
//     LAN-unthrottled sends, pending fragments;
//   * per destination (an IAT hook on WSOCK32 #20 sendto): packets, bytes, avg / max size,
//     netchan fragments (sequence bit 31), out-of-band packets, and time spent inside
//     sendto (so a slow Wine UDP path would show as sendto microseconds).
//
// SWITCHES
//   ENW_SV_MAXRATE=<n>     sv_maxRate to apply (default 25000); 0 = leave the stock 7000.
//   ENW_NET_PROBE=0        no logging, no sendto hook (the sv_maxRate raise still applies).
//   ENW_NET_FORCE_WAN=1    TEST ONLY: the two Sys_IsLANAddress calls in the send path
//                          report "not LAN", so a 127.0.0.1 harness client is paced exactly
//                          like an internet one. Never set on the box.
//
// Clean room: our own code, from our own dump.

#include "component.hpp"
#include "enw.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>

namespace enw::net {
namespace {

// ---- engine facts (see the header) -----------------------------------------------------
constexpr uintptr_t kSvMaxRateDvarPtr = 0x2FCD9C4;
constexpr uintptr_t kSvMaxClientsDvarPtr = 0x23D5C30;
constexpr uintptr_t kSvsTime = 0x2547084;
constexpr uintptr_t kClients = 0x2547090;
constexpr uintptr_t kClientStride = 0x58D30;
constexpr uintptr_t kClRateDelayed = 0x10;
constexpr uintptr_t kClAdrType = 0x24;
constexpr uintptr_t kClUnsentFragments = 0x50;
constexpr uintptr_t kClNextSnapshotTime = 0x1161C;
constexpr uintptr_t kClRate = 0x323E8;
constexpr uintptr_t kClSnapshotMsec = 0x323EC;
constexpr uintptr_t kDvarSetInt = 0x5EF390;       // ecx = value, [esp+4] dvar, [esp+8] source
constexpr uintptr_t kDvarValue = 0x10;
constexpr uintptr_t kDvarType = 0x0A;             // 5 = int
constexpr int kMaxRateCeiling = 25000;            // sv_maxRate domain max (push 0x61A8 @0x633034)

// The two `call Sys_IsLANAddress` in the send path (ENW_NET_FORCE_WAN only).
constexpr uintptr_t kLanCallSites[2] = {0x6395CE, 0x639C7A};
const uint8_t kLanCallBytes[2][5] = {{0xE8, 0xAD, 0x6C, 0xFC, 0xFF},
                                     {0xE8, 0x01, 0x66, 0xFC, 0xFF}};
const uint8_t kXorEaxNop3[5] = {0x31, 0xC0, 0x90, 0x90, 0x90};

constexpr int kMaxClients = 8;
constexpr uint16_t kWsockSendtoOrdinal = 20;      // IAT 0x7EB3F4
constexpr DWORD kWindowMs = 5000;

std::string env(const char* name) {
    char buf[64]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
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

// ---- the wire: sendto ------------------------------------------------------------------
struct sockaddr_in4 {
    uint16_t family;
    uint16_t port_be;
    uint8_t addr[4];
};

struct dest_stats {
    uint32_t ip = 0;
    uint16_t port = 0;
    bool used = false;
    uint32_t pkts = 0, bytes = 0, max = 0, frags = 0, frag_bytes = 0, oob = 0;
};

using sendto_t = int(__stdcall*)(uintptr_t, const char*, int, int, const void*, int);
sendto_t g_orig_sendto = nullptr;
std::mutex g_mu;
dest_stats g_dest[16];
uint64_t g_sendto_ticks = 0, g_sendto_max_ticks = 0;
uint32_t g_sendto_calls = 0, g_sendto_errors = 0;
LARGE_INTEGER g_qpf{};

int __stdcall sendto_hook(uintptr_t s, const char* buf, int len, int flags, const void* to,
                          int tolen) {
    LARGE_INTEGER a, b;
    ::QueryPerformanceCounter(&a);
    const int r = g_orig_sendto(s, buf, len, flags, to, tolen);
    ::QueryPerformanceCounter(&b);
    const DWORD err = r < 0 ? ::GetLastError() : 0;

    if (to && tolen >= static_cast<int>(sizeof(sockaddr_in4)) && buf && len >= 4) {
        const auto* sa = static_cast<const sockaddr_in4*>(to);
        uint32_t ip;
        std::memcpy(&ip, sa->addr, 4);
        uint32_t seq;
        std::memcpy(&seq, buf, 4);
        std::lock_guard<std::mutex> lk(g_mu);
        const uint64_t t = static_cast<uint64_t>(b.QuadPart - a.QuadPart);
        g_sendto_ticks += t;
        if (t > g_sendto_max_ticks) g_sendto_max_ticks = t;
        ++g_sendto_calls;
        if (r < 0) ++g_sendto_errors;
        dest_stats* d = nullptr;
        for (auto& e : g_dest)
            if (e.used && e.ip == ip && e.port == sa->port_be) { d = &e; break; }
        if (!d)
            for (auto& e : g_dest)
                if (!e.used) { e = dest_stats{}; e.used = true; e.ip = ip; e.port = sa->port_be; d = &e; break; }
        if (d) {
            ++d->pkts;
            d->bytes += static_cast<uint32_t>(len);
            if (static_cast<uint32_t>(len) > d->max) d->max = static_cast<uint32_t>(len);
            if (seq == 0xFFFFFFFFu) ++d->oob;
            else if (seq & 0x80000000u) { ++d->frags; d->frag_bytes += static_cast<uint32_t>(len); }
        }
    }
    if (r < 0) ::SetLastError(err);
    return r;
}

// ---- the engine's pacing decisions -----------------------------------------------------
struct client_window {
    int last_next = 0;
    bool seen = false;
    uint32_t sends = 0, delayed = 0, lan = 0, delay_sum = 0, delay_max = 0, frag_pending = 0;
};
client_window g_cw[kMaxClients];

template <typename T>
T rd(uintptr_t a, T fallback = T{}) {
    T v = fallback;
    memory::read(a, &v);
    return v;
}

void dvar_set_int(uintptr_t dvar, int value) {
    const uintptr_t fn = enw::at(kDvarSetInt);
    __asm {
        push 0
        push dvar
        mov ecx, value
        call fn
        add esp, 8
    }
}

int g_target_maxrate = kMaxRateCeiling;
bool g_maxrate_done = false;
bool g_probe = true;

void apply_maxrate() {
    if (g_maxrate_done) return;
    const uintptr_t dv = rd<uintptr_t>(enw::at(kSvMaxRateDvarPtr));
    if (!dv) return;                               // SV_Init has not registered it yet
    g_maxrate_done = true;
    const int cur = rd<int>(dv + kDvarValue, -1);
    const uint8_t type = rd<uint8_t>(dv + kDvarType, 0xFF);
    if (g_target_maxrate <= 0) {
        ENW_INFO("net_probe: sv_maxRate left at %d (ENW_SV_MAXRATE=0)", cur);
        return;
    }
    if (type != 5) {
        ENW_ERROR("net_probe: sv_maxRate dvar at 0x%08X has type %u, not int (5); NOT setting it",
                  static_cast<unsigned>(dv), type);
        return;
    }
    if (cur >= g_target_maxrate) {
        ENW_INFO("net_probe: sv_maxRate already %d (>= %d); left alone", cur, g_target_maxrate);
        return;
    }
    dvar_set_int(dv, g_target_maxrate);
    const int now = rd<int>(dv + kDvarValue, -1);
    ENW_INFO("net_probe: sv_maxRate %d -> %d (stock 7000 capped every internet client at 7000 "
             "bytes/s, i.e. ~286 bytes per 20 Hz snapshot; at 25000 SV_RateMsec cannot exceed "
             "49 ms, so a 20 Hz client is never rate-delayed)%s",
             cur, now, now == g_target_maxrate ? "" : "  ** DID NOT TAKE **");
}

void sample_clients() {
    const int svs_time = rd<int>(enw::at(kSvsTime));
    const uintptr_t mc_dv = rd<uintptr_t>(enw::at(kSvMaxClientsDvarPtr));
    int maxc = mc_dv ? rd<int>(mc_dv + kDvarValue) : 0;
    if (maxc > kMaxClients) maxc = kMaxClients;
    for (int i = 0; i < maxc; ++i) {
        const uintptr_t cl = enw::at(kClients) + static_cast<uintptr_t>(i) * kClientStride;
        const int state = rd<int>(cl);
        client_window& w = g_cw[i];
        if (state < 2) { w.seen = false; continue; }
        const int next = rd<int>(cl + kClNextSnapshotTime);
        if (!w.seen) { w.seen = true; w.last_next = next; continue; }
        if (next == w.last_next) continue;
        w.last_next = next;
        ++w.sends;
        if (rd<int>(cl + kClUnsentFragments)) ++w.frag_pending;
        const int delay = next - svs_time;
        if (delay < 0) { ++w.lan; continue; }       // svs.time - 1: loopback / LAN, unthrottled
        if (rd<int>(cl + kClRateDelayed)) ++w.delayed;
        w.delay_sum += static_cast<uint32_t>(delay);
        if (static_cast<uint32_t>(delay) > w.delay_max) w.delay_max = static_cast<uint32_t>(delay);
    }
}

void report(double secs) {
    const uintptr_t dv = rd<uintptr_t>(enw::at(kSvMaxRateDvarPtr));
    const int maxrate = dv ? rd<int>(dv + kDvarValue, -1) : -1;
    const uintptr_t mc_dv = rd<uintptr_t>(enw::at(kSvMaxClientsDvarPtr));
    int maxc = mc_dv ? rd<int>(mc_dv + kDvarValue) : 0;
    if (maxc > kMaxClients) maxc = kMaxClients;

    std::string line;
    char b[400];
    for (int i = 0; i < maxc; ++i) {
        const uintptr_t cl = enw::at(kClients) + static_cast<uintptr_t>(i) * kClientStride;
        const int state = rd<int>(cl);
        client_window& w = g_cw[i];
        if (state >= 2) {
            const int rate = rd<int>(cl + kClRate);
            const int eff = (maxrate > 0 && maxrate < rate) ? (maxrate < 1000 ? 1000 : maxrate) : rate;
            const uint32_t timed = w.sends - w.lan;
            std::snprintf(b, sizeof b,
                          " | cl%d st=%d adr=%d rate=%d eff=%d snapMsec=%d msgs=%u (%.1f/s) "
                          "delayed=%u delay avg=%.0f max=%u ms lan=%u fragpend=%u",
                          i, state, rd<int>(cl + kClAdrType), rate, eff,
                          rd<int>(cl + kClSnapshotMsec), w.sends, w.sends / secs, w.delayed,
                          timed ? static_cast<double>(w.delay_sum) / timed : 0.0, w.delay_max,
                          w.lan, w.frag_pending);
            line += b;
        }
        const bool seen = w.seen;
        const int last = w.last_next;
        w = client_window{};
        w.seen = seen;
        w.last_next = last;
    }

    std::string wire;
    uint64_t ticks, maxt;
    uint32_t calls, errs;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        for (auto& d : g_dest) {
            if (!d.used || d.pkts == 0) { d = dest_stats{}; continue; }
            const uint8_t* ip = reinterpret_cast<const uint8_t*>(&d.ip);
            std::snprintf(b, sizeof b,
                          " | to %u.%u.%u.%u:%u pkts=%u (%.1f/s) bytes=%u (%.0f B/s) avg=%u max=%u "
                          "frag=%u (%u B) oob=%u",
                          ip[0], ip[1], ip[2], ip[3],
                          static_cast<unsigned>((d.port >> 8) | ((d.port & 0xFF) << 8)), d.pkts,
                          d.pkts / secs, d.bytes, d.bytes / secs, d.bytes / d.pkts, d.max, d.frags,
                          d.frag_bytes, d.oob);
            wire += b;
            d = dest_stats{};
        }
        ticks = g_sendto_ticks; maxt = g_sendto_max_ticks; calls = g_sendto_calls; errs = g_sendto_errors;
        g_sendto_ticks = g_sendto_max_ticks = 0; g_sendto_calls = g_sendto_errors = 0;
    }
    const double us = g_qpf.QuadPart ? 1e6 / static_cast<double>(g_qpf.QuadPart) : 0.0;
    if (line.empty() && calls == 0) return;        // idle server, nothing to say
    ENW_INFO("net_probe: %.1fs sv_maxRate=%d%s%s | sendto %u calls %u err, %.0f us total, max %.0f us",
             secs, maxrate, line.c_str(), wire.c_str(), calls, errs, ticks * us, maxt * us);
}

void force_wan() {
    for (int i = 0; i < 2; ++i) {
        const uintptr_t site = enw::at(kLanCallSites[i]);
        uint8_t got[5]{};
        if (!memory::read_raw(site, got, 5) || std::memcmp(got, kLanCallBytes[i], 5) != 0) {
            ENW_ERROR("net_probe: ENW_NET_FORCE_WAN: 0x%08X is not the expected call (%s); not "
                      "patched", static_cast<unsigned>(kLanCallSites[i]),
                      memory::hex_dump(site, 5).c_str());
            continue;
        }
        if (memory::write_raw(site, kXorEaxNop3, 5))
            ENW_WARN("net_probe: ENW_NET_FORCE_WAN: Sys_IsLANAddress at 0x%08X now reports "
                     "'not LAN' - local clients are rate-paced like internet ones (TEST ONLY)",
                     static_cast<unsigned>(kLanCallSites[i]));
    }
}

class net_probe final : public component {
public:
    const char* name() const override { return "net_probe"; }

    void post_unpack() override {
        if (!cmdline_dedicated()) return;
        ::QueryPerformanceFrequency(&g_qpf);

        const std::string mr = env("ENW_SV_MAXRATE");
        if (!mr.empty()) {
            g_target_maxrate = std::atoi(mr.c_str());
            if (g_target_maxrate > kMaxRateCeiling) g_target_maxrate = kMaxRateCeiling;
        }
        g_probe = env("ENW_NET_PROBE") != "0";
        if (env("ENW_NET_FORCE_WAN") == "1") force_wan();

        if (g_probe &&
            !memory::hook_import_ordinal("WSOCK32.dll", kWsockSendtoOrdinal,
                                         reinterpret_cast<void*>(&sendto_hook),
                                         reinterpret_cast<void**>(&g_orig_sendto))) {
            ENW_WARN("net_probe: could not hook WSOCK32#20 (sendto); no wire stats");
        }

        frame::subscribe("net_probe", [](uint64_t) {
            apply_maxrate();
            if (!g_probe) return;
            sample_clients();
            static DWORD last = 0;
            const DWORD now = ::GetTickCount();
            if (last == 0) { last = now; return; }
            if (now - last < kWindowMs) return;
            report((now - last) / 1000.0);
            last = now;
        });
        ENW_INFO("net_probe: armed (sv_maxRate target %d%s, probe %s)", g_target_maxrate,
                 g_target_maxrate <= 0 ? " = stock" : "", g_probe ? "on" : "off");
    }
};

}  // namespace
}  // namespace enw::net

ENW_REGISTER_COMPONENT(enw::net::net_probe)
