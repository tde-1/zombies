// Client side: actually connect to our headless server.
//
// NOTE FOR `foundation`: new file only -- I have not touched auth_token.cpp or
// network.cpp. The coordinator handed me the end-to-end join, and this is the client
// half of it. Move or fold it into yours as you like.
//
// WHY THIS EXISTS: `+connect` is not a client command in this exe at all. `connect`
// exists only as the server-side out-of-band name at 0x635253, which is why a client
// launched with `+connect 127.0.0.1:28960` sat at the menu doing nothing (run join1).
// T4's equivalent of iw4x's `connect_coop` is the function at 0x641730.
//
// CONVENTION, PROVEN FROM THE INSTRUCTIONS (not inferred -- that mistake has cost this
// project three times tonight). Disassembled from re's flat dump:
//
//   00641730  push ebp / mov ebp,esp / and esp,0xFFFFFFF8   args at [ebp+8], [ebp+0Ch]
//   00641883  call 0x642C80                                 CL_SendConnectPacket
//   006418BF  cmp byte ptr [ebp+0Ch], bl                    arg2 is a byte/bool
//   006418D9  mov esi, dword ptr [ebp+8]                    arg1 is a dword...
//   006418DC  mov eax, 0x87B6D0 / mov edx,esi / call 5F6AF0  ...compared as a string
//   0064194F  ret                                           plain ret, NOT ret 8
//
// and both call sites clean up themselves:
//   0x6321A2  call 0x641730 ; add esp, 8     (the map-load path)
//   0x65838A  call 0x641730 ; add esp, 8
//
//   => void __cdecl CL_ConnectLocal(const char* mapName, int flag);
//
// 0x87B6D0 is the literal "credits", which arg1 is compared against, so arg1 is a map
// name. 0x86F0D4 is "localhost": this function hardcodes the local server, which is
// exactly what we want for the loopback test.
//
// THE GATE IS NOT A GATE. The brief said client state at [0x305842C] must be >= 6 or
// the connect branch never runs. It is the opposite: `jl 0x6417D2` jumps INTO the
// connect path when state < 6, and the >= 6 fall-through only early-outs if we are
// already on "localhost". A freshly launched, disconnected client (state 0) therefore
// takes the connect path with nothing to set up first.
//
// HOW IT FIRES: no console command, because registering one would mean trusting an
// unverified Cmd_AddCommand. Set ENW_CLIENT_CONNECT=<mapname> and we call it once from
// the shared frame tick, on the main thread, a few seconds in so the engine is fully up.
//
// Clean room: our own code.

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <cstdlib>
#include <cstring>

namespace enw::client {
namespace {

constexpr uintptr_t kCL_ConnectLocal = 0x641730;

// The first six bytes of the function, from the dump. If the image does not match we
// refuse to call rather than jump into the middle of something.
constexpr uint8_t kPrologue[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF8};

using CL_ConnectLocal_t = void(__cdecl*)(const char*, int);

char g_map[64] = {};
bool g_armed = false;
bool g_fired = false;

void try_connect() {
    if (g_fired) return;
    g_fired = true;

    const uintptr_t live = enw::at(kCL_ConnectLocal);
    uint8_t got[sizeof kPrologue] = {};
    if (!memory::read_raw(live, got, sizeof got) ||
        std::memcmp(got, kPrologue, sizeof got) != 0) {
        ENW_ERROR("connect_local: 0x%08X does not have the expected prologue (%s); refusing to call",
                  static_cast<unsigned>(kCL_ConnectLocal),
                  memory::hex_dump(live, 8).c_str());
        return;
    }

    ENW_INFO("connect_local: calling CL_ConnectLocal(\"%s\", 0) at 0x%08X", g_map,
             static_cast<unsigned>(kCL_ConnectLocal));
    const auto fn = reinterpret_cast<CL_ConnectLocal_t>(live);
    fn(g_map, 0);
    ENW_INFO("connect_local: returned; client state [0x305842C] = %d",
             *reinterpret_cast<const int*>(enw::at(0x305842C)));
}

class connect_local_component final : public component {
public:
    const char* name() const override { return "connect_local"; }

    void post_load() override {
        const char* m = std::getenv("ENW_CLIENT_CONNECT");
        if (!m || !*m) return;
        // NEVER on the server. A full build compiles client-dll components into the
        // dedicated DLL too, and the join test exports ENW_CLIENT_CONNECT to both
        // processes -- without this the server would try to connect to itself at
        // frame 300. Checked from the command line because the dedicated component
        // is not linked into a client-only build.
        const char* cmd = ::GetCommandLineA();
        if (cmd && std::strstr(cmd, "dedicated 1")) {
            ENW_INFO("connect_local: this process is a dedicated server; not arming");
            return;
        }
        std::strncpy(g_map, m, sizeof g_map - 1);
        g_armed = true;
        ENW_INFO("connect_local: armed for map '%s'", g_map);
    }

    void post_init() override {
        if (!g_armed) return;
        // A few seconds in: the engine is up, the menu has settled, and we are on the
        // main thread at a frame boundary.
        enw::frame::subscribe("connect_local", [](uint64_t n) {
            if (n == 300) try_connect();
        });
        ENW_INFO("connect_local: will fire at frame 300 (frame tick installed=%s)",
                 enw::frame::installed() ? "yes" : "NO");
    }
};

}  // namespace
}  // namespace enw::client

ENW_REGISTER_COMPONENT(enw::client::connect_local_component)
