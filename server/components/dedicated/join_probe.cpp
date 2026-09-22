// Watch a client walk the connect state machine on a headless server.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// Run join11 got a client to `Going from CS_FREE to CS_CONNECTED`, the client
// loaded the map, and then printed `ERROR: Server connection timed out.` and
// nothing else. `SV_PacketEvent` stopped climbing at 275, so the conversation
// died rather than never starting -- but the server console said nothing at all
// about WHY, because every line the server prints on that path goes through
// Com_DPrintf, which is gated on `developer` and we are not allowed to set it.
//
// So this component reads the state machine directly instead of asking the
// engine to narrate it.
//
// ---------------------------------------------------------------------------
// T4 HAS NO CS_PRIMED. Correct the record before reading the code.
// ---------------------------------------------------------------------------
// Everything written in this repo so far said the client walks
// `CS_CONNECTED -> CS_PRIMED -> CS_ACTIVE`. That is Quake 3 / CoD4. The strings
// in our own dump say T4's middle state is called **CS_CLIENTLOADING**:
//
//     0x887114  "SV_SendClientGameState() for %s\n"
//     0x887138  "Going from CS_CONNECTED to CS_CLIENTLOADING for %s\n"
//     0x88716C  "Sending %i bytes in gamestate to client: %i\n"
//     0x88719C  "Going from CS_CLIENTLOADING to CS_ACTIVE for %s\n"
//     0x88755C  "%s : dropped gamestate, resending\n"
//
// The numeric values are unchanged (FREE 0, ZOMBIE 1, CONNECTED 2, LOADING 3,
// ACTIVE 4) -- proven by `cmp dword ptr [esi], 1` guarding the ZOMBIE early-out
// at 0x6310AB and `cmp dword ptr [esi], 3` guarding SV_ClientEnterWorld at
// 0x63101B. Only the name was wrong, and a wrong name sends you looking for a
// function that does not exist.
//
// ---------------------------------------------------------------------------
// The state machine, read off SV_ExecuteClientMessage 0x630F70
// ---------------------------------------------------------------------------
//     00630FFF  mov  eax, [esi + 0x52C00]   ; the serverId the CLIENT echoed
//     00631008  cmp  eax, ecx               ; ecx = sv.serverId = [0x46E5124]
//     0063100A  je   0x631080               ; match -> read the message normally
//     0063100C  cmp  byte ptr [esi+0x1156D], 0
//     00631013  jne  0x631080
//     00631015  xor  eax, ecx
//     00631017  test al, 0xF0               ; differs ONLY in the low nibble?
//     00631019  jne  0x631042               ;   no  -> consider resending gamestate
//     0063101B  cmp  dword ptr [esi], 3     ;   yes -> CS_CLIENTLOADING?
//     0063101E  jne  0x631031
//     00631029  call 0x62FC30               ;          SV_ClientEnterWorld
//   ...
//     00631042  mov  eax, [esi + 0x110FC]   ; cl->messageAcknowledge
//     00631048  cmp  eax, [esi + 0x11100]   ; cl->gamestateMessageNum
//     0063104E  jle  0x631031               ; not yet -> say nothing, do nothing
//     0063105E  call 0x59A310               ; "%s : dropped gamestate, resending"
//     00631067  call 0x62F500               ; SV_SendClientGameState
//
// Which gives four distinguishable failure shapes, and this component's whole
// job is to say which one we are in:
//
//   state stuck at 2, gamestateMessageNum never set  -> the server never sent a
//        gamestate; look at messageAcknowledge, the client is not acking.
//   state 3 for ever, client serverId never updates  -> the client has the
//        gamestate but is not echoing the new serverId in its moves.
//   state 3, serverId matches exactly                -> we are on the `je` path
//        and SV_ClientEnterWorld is never reached, because the entry to the
//        world is ONLY on the near-miss branch. Worth knowing before guessing.
//   state 4                                          -> it worked.
//
// Nothing here writes to the game. It is a read-only instrument plus one hook
// that only logs. Dedicated only.
//
// ENW_DEDI_NO_JOINPROBE=1 turns it off.
// ENW_DEDI_DPRINT=0 keeps the state poller but drops the Com_DPrintf mirror.
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "hook.hpp"
#include "dedicated.hpp"

#include <cstdlib>
#include <cstring>
#include <mutex>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw::dedi {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

// ---- what we read ---------------------------------------------------------
// [V] svs.clients base and stride, from SV_GameSendServerCommand 0x5A937E:
//     `imul eax, eax, 0x58D30` / `add eax, 0x2547090`.
constexpr uintptr_t kClientsBase   = 0x2547090;
constexpr uintptr_t kClientStride  = 0x58D30;
// [V] sv_maxclients dvar_s*, read two instructions earlier at 0x5A9373.
constexpr uintptr_t kMaxClientsDvarPtr = 0x23D5C30;
// [V] sv.serverId, the dword SV_ExecuteClientMessage compares against.
constexpr uintptr_t kSvServerId    = 0x46E5124;
// [V] sv_pure dvar_s*, the gate on the EXE_UNPURECLIENTDETECTED drop at 0x6310C9.
constexpr uintptr_t kSvPureDvarPtr = 0x23D5C24;

// client_s offsets, every one read off an instruction in SV_ExecuteClientMessage
// or SV_ClientEnterWorld rather than taken from a header.
constexpr uintptr_t kOffState        = 0x00000;  // [V] 0x63101B, 0x6310AB, 0x62FC59
constexpr uintptr_t kOffMsgAck       = 0x110FC;  // [V] 0x631042
constexpr uintptr_t kOffGamestateNum = 0x11100;  // [V] 0x631048
constexpr uintptr_t kOffGentity      = 0x11544;  // [V] 0x62FC80
constexpr uintptr_t kOffName         = 0x11548;  // [V] 0x62FC34, 0x631050
constexpr uintptr_t kOffPureState    = 0x323F0;  // [V] 0x6310D4 (== 2 means "unpure")
constexpr uintptr_t kOffClientSvId   = 0x52C00;  // [V] 0x630FFF
constexpr uintptr_t kOffDownloading  = 0x1156D;  // [V] 0x63100C

constexpr uintptr_t kComDPrintf = 0x59A310;      // [V] void(int channel, const char* fmt, ...)

const char* state_name(uint32_t s) {
    switch (s) {
        case 0: return "CS_FREE";
        case 1: return "CS_ZOMBIE";
        case 2: return "CS_CONNECTED";
        case 3: return "CS_CLIENTLOADING";
        case 4: return "CS_ACTIVE";
        default: return "CS_?";
    }
}

struct slot_snapshot {
    uint32_t state = 0;
    uint32_t msg_ack = 0;
    uint32_t gamestate_num = 0;
    uint32_t client_svid = 0;
    uint32_t gentity = 0;
    bool valid = false;
};

constexpr int kMaxSlots = 8;
slot_snapshot g_last[kMaxSlots];
uint32_t g_last_sv_serverid = 0;
bool g_ever_seen_client = false;
uint64_t g_last_heartbeat = 0;

int max_clients() {
    uintptr_t dvar = 0;
    if (!memory::read(enw::at(kMaxClientsDvarPtr), &dvar) || !dvar) return 0;
    int32_t v = 0;
    if (!memory::read(dvar + 0x10, &v)) return 0;
    return (v > 0 && v <= kMaxSlots) ? v : (v > kMaxSlots ? kMaxSlots : 0);
}

// The name field is a fixed char array inside client_s, so this is a read of our
// own process memory with a hard bound -- not a strlen on a foreign pointer.
void copy_name(uintptr_t client, char* out, size_t cap) {
    out[0] = '\0';
    char raw[36] = {};
    if (!memory::read_raw(client + kOffName, raw, sizeof raw - 1)) return;
    size_t j = 0;
    for (size_t i = 0; i < sizeof raw - 1 && j + 1 < cap; ++i) {
        const auto c = static_cast<unsigned char>(raw[i]);
        if (c == '\0') break;
        out[j++] = (c < 0x20 || c > 0x7E) ? '.' : static_cast<char>(c);
    }
    out[j] = '\0';
}

bool read_slot(uintptr_t client, slot_snapshot& s) {
    s.valid = memory::read(client + kOffState, &s.state)
           && memory::read(client + kOffMsgAck, &s.msg_ack)
           && memory::read(client + kOffGamestateNum, &s.gamestate_num)
           && memory::read(client + kOffClientSvId, &s.client_svid)
           && memory::read(client + kOffGentity, &s.gentity);
    return s.valid;
}

void report(int slot, uintptr_t client, const slot_snapshot& s, uint32_t sv_id, const char* why) {
    char name[40];
    copy_name(client, name, sizeof name);
    uint8_t downloading = 0;
    memory::read(client + kOffDownloading, &downloading);
    uint32_t pure = 0;
    memory::read(client + kOffPureState, &pure);

    const uint32_t diff = s.client_svid ^ sv_id;
    const char* verdict =
        (s.client_svid == sv_id)        ? "serverId MATCHES (SV_ClientEnterWorld is NOT on this branch)"
      : ((diff & 0xF0u) == 0)           ? "serverId near-miss (low nibble only) -> the enter-world branch"
                                        : "serverId differs widely -> gamestate resend branch";

    ENW_INFO("join_probe: slot %d %-16s (%s) name=\"%s\" msgAck=%d gamestateNum=%d "
             "clientSvId=0x%08X svServerId=0x%08X %s gentity=0x%08X dl=%u pure=%u",
             slot, state_name(s.state), why, name,
             static_cast<int>(s.msg_ack), static_cast<int>(s.gamestate_num),
             s.client_svid, sv_id, verdict, s.gentity,
             static_cast<unsigned>(downloading), static_cast<unsigned>(pure));
}

void poll(uint64_t frame) {
    const int n = max_clients();
    if (n <= 0) return;

    uint32_t sv_id = 0;
    memory::read(enw::at(kSvServerId), &sv_id);
    if (sv_id != g_last_sv_serverid) {
        ENW_INFO("join_probe: sv.serverId 0x%08X -> 0x%08X (a map load or map_restart)",
                 g_last_sv_serverid, sv_id);
        g_last_sv_serverid = sv_id;
    }

    bool any_live = false;
    for (int i = 0; i < n; ++i) {
        const uintptr_t client = enw::at(kClientsBase) + static_cast<uintptr_t>(i) * kClientStride;
        slot_snapshot s;
        if (!read_slot(client, s)) continue;
        if (s.state != 0) any_live = true;

        const slot_snapshot& was = g_last[i];
        const bool changed = !was.valid
                          || s.state != was.state
                          || s.gamestate_num != was.gamestate_num
                          || s.client_svid != was.client_svid
                          || s.gentity != was.gentity
                          // messageAcknowledge climbs constantly; only report it
                          // while the client is not yet in the world, where it is
                          // the thing that decides whether a gamestate is resent.
                          || (s.state != 0 && s.state < 4 && s.msg_ack != was.msg_ack);

        if (changed) {
            if (s.state != 0 && !g_ever_seen_client) {
                g_ever_seen_client = true;
                ENW_INFO("join_probe: first client appeared in slot %d on frame %llu", i,
                         static_cast<unsigned long long>(frame));
            }
            report(i, client, s, sv_id, was.valid ? "changed" : "first read");
            if (was.valid && was.state == 3 && s.state == 4)
                ENW_INFO("join_probe: *** slot %d ENTERED THE WORLD (CS_CLIENTLOADING -> "
                         "CS_ACTIVE). Milestone (d).", i);
            if (was.valid && s.state == 0 && was.state != 0)
                ENW_WARN("join_probe: slot %d went back to CS_FREE from %s -- it was dropped",
                         i, state_name(was.state));
        }
        g_last[i] = s;
    }

    // A heartbeat while somebody is half-connected: a state that never changes is
    // exactly the symptom, and a poller that only logs changes would go silent
    // precisely when the interesting thing is happening.
    if (any_live && frame - g_last_heartbeat >= 600) {
        g_last_heartbeat = frame;
        for (int i = 0; i < n; ++i) {
            if (!g_last[i].valid || g_last[i].state == 0 || g_last[i].state == 4) continue;
            const uintptr_t client = enw::at(kClientsBase) + static_cast<uintptr_t>(i) * kClientStride;
            report(i, client, g_last[i], sv_id, "still");
        }
    }
}

// ---- the script VM's operand stack ----------------------------------------
// Run join12 died 19 s after the player spawned in, with
// `Sys_Error("Internal script stack overflow")` and a 680,000-line thread dump.
// The raise is at 0x69A8D0, and it is a plain push-with-bounds-check:
//
//     0069A8E0  mov ecx, [eax + 0x3BD4710]   ; gScrVmPub[inst].top
//     0069A8E6  cmp ecx, [eax + 0x3BD4704]   ; gScrVmPub[inst].maxstack
//     0069A8EC  jne 0x69A8F8                 ; room left -> push
//     0069A8EE  push 0x89ACAC                ; "Internal script stack overflow"
//     0069A8F3  call Sys_Error
//     0069A8F8  add dword [eax + 0x3BD4710], 8   ; one slot is 8 bytes
//
// So the stack is a pointer that walks up towards a fixed ceiling, and the
// distance between them is a gauge we can read every second. That turns "it
// blew up eventually" into "it started climbing at this exact moment", which is
// the difference between knowing the cause and guessing at it. The autosave
// that fires at the same time is the obvious suspect and obvious suspects in
// this engine have been wrong twice already.
constexpr uintptr_t kVmTop      = 0x3BD4710;  // [V] 0x69A8E0, instance 0
constexpr uintptr_t kVmMaxStack = 0x3BD4704;  // [V] 0x69A8E6, instance 0
constexpr uintptr_t kVmDepth    = 0x3BD4718;  // [V] 0x69A8FF, bumped with every push

uint32_t g_vm_peak_used = 0;
uint64_t g_vm_last_log = 0;
bool g_vm_warned = false;

void poll_vm(uint64_t frame) {
    uint32_t top = 0, max = 0, depth = 0;
    if (!memory::read(enw::at(kVmTop), &top) || !memory::read(enw::at(kVmMaxStack), &max)) return;
    if (!top || !max || max <= top) return;
    memory::read(enw::at(kVmDepth), &depth);

    const uint32_t free_slots = (max - top) / 8;
    const uint32_t used = depth;
    if (used > g_vm_peak_used) g_vm_peak_used = used;

    // Every ~4 s while things are normal, and a loud one-off the first time the
    // stack is more than half consumed -- by then there is still time to see what
    // was happening when it started.
    if (!g_vm_warned && free_slots < 1024) {
        g_vm_warned = true;
        ENW_WARN("join_probe/vm: the script stack is within %u slots of the ceiling "
                 "(top=0x%08X max=0x%08X depth=%u). 'Internal script stack overflow' is close.",
                 free_slots, top, max, depth);
    }
    if (frame - g_vm_last_log >= 240) {
        g_vm_last_log = frame;
        ENW_INFO("join_probe/vm: script stack top=0x%08X max=0x%08X free=%u slots depth=%u peak=%u",
                 top, max, free_slots, depth, g_vm_peak_used);
    }
}

// ---- the script variable free lists ---------------------------------------
// join14 died on `exceeded maximum number of script variables` while every
// category the engine prints in its own dump stayed flat (223 entities, 8 hud
// elements, ~2,300 variables, unchanged across all 2,150 dumps). So the pool is
// being consumed by something the dump does not attribute, and the only honest
// way to find out is to count what is left.
//
// Both allocators fail the same way, and neither keeps a counter -- they keep a
// circular free list whose head is a 16-bit index:
//
//     0068FCE9  imul  eax, eax, 0x160000      ; script instance
//     0068FCEF  movzx esi, word [eax+0x3914714]   ; head of the OBJECT free list
//     0068FCF6  test  si, si
//     0068FCF9  jne   0x68FD2C                ; zero -> "exceeded maximum number
//     0068FD03                                ;          of script variables"
//
//     0068F21D  movzx edi, word [edx+0x3974704]   ; head of the CHILD free list
//     0068F224  test  edi, edi                    ; same error on zero
//
// Entries are 16 bytes and the next index is the first word of the entry
// (`shl eax,4` then `add eax, base` then `movzx edi, word [eax]`), so the list
// can simply be walked. It is walked once a second, bounded, off the frame tick.
// That turns "it ran out eventually" into a rate and a start time, which is the
// difference between knowing what consumed it and guessing.
constexpr uintptr_t kVarObjBase  = 0x3914710;  // [V] 0x68FD3C
constexpr uintptr_t kVarObjHead  = 0x3914714;  // [V] 0x68FCEF
constexpr uintptr_t kVarChildBase = 0x3974700; // [V] 0x68F258
constexpr uintptr_t kVarChildHead = 0x3974704; // [V] 0x68F21D
constexpr uint32_t kWalkCap = 70000;           // the index is 16-bit; this cannot loop for ever

uint64_t g_pool_last_log = 0;
uint32_t g_pool_first_obj = 0, g_pool_first_child = 0;
bool g_pool_have_first = false;

// Follow the chain from `head` and count it. Returns kWalkCap if the list does
// not terminate, which is itself worth seeing.
uint32_t count_free(uintptr_t base, uintptr_t head_addr) {
    uint16_t idx = 0;
    if (!memory::read(enw::at(head_addr), &idx)) return 0;
    const uint16_t first = idx;
    uint32_t n = 0;
    while (idx && n < kWalkCap) {
        ++n;
        uint16_t next = 0;
        if (!memory::read(enw::at(base) + static_cast<uintptr_t>(idx) * 16, &next)) break;
        if (next == first) break;    // circular
        idx = next;
    }
    return n;
}

// OFF by default, and here is the honest reason. Run join15 walked both lists
// once a second and the object list read 1 every single time while the child
// list bounced between 1 and 4,548 with no trend -- because these are live,
// doubly-linked, circular lists being rewritten by the VM at 20 Hz, and a
// snapshot of one is a snapshot of a list mid-edit. The numbers are real and
// they mean nothing. Kept because the addresses are right and a future attempt
// should start from a walk taken INSIDE the allocator, not from the frame tick.
//
// ENW_DEDI_VARPOOL=1 turns it on.
bool g_pool_enabled = false;

void poll_var_pools(uint64_t frame) {
    if (!g_pool_enabled) return;
    if (frame - g_pool_last_log < 60) return;   // about once a second
    g_pool_last_log = frame;

    const uint32_t obj = count_free(kVarObjBase, kVarObjHead);
    const uint32_t child = count_free(kVarChildBase, kVarChildHead);
    if (!obj && !child) return;                  // not brought up yet

    if (!g_pool_have_first) {
        g_pool_have_first = true;
        g_pool_first_obj = obj;
        g_pool_first_child = child;
        ENW_INFO("join_probe/vars: free lists at first read - objects %u, children %u. "
                 "These are what run out when the VM says 'exceeded maximum number of script "
                 "variables'.", obj, child);
        return;
    }

    const int32_t d_obj = static_cast<int32_t>(obj) - static_cast<int32_t>(g_pool_first_obj);
    const int32_t d_child = static_cast<int32_t>(child) - static_cast<int32_t>(g_pool_first_child);
    ENW_INFO("join_probe/vars: free objects %u (%+d) children %u (%+d)",
             obj, d_obj, child, d_child);
}

// ---- Com_DPrintf mirror ---------------------------------------------------
// Every interesting line on the connect path is a Com_DPrintf, which the engine
// throws away unless `developer` is 1 -- and we are not allowed to set that (it
// changes asset handling and script behaviour, which would make anything we
// measured a different game). Hooking it costs nothing and changes nothing: the
// stub logs the format string and jumps straight to the trampoline, so the
// engine still decides for itself whether to print.
//
// The format string, not the formatted line: this stub does not touch the
// varargs, because guessing at a caller's argument count is how you corrupt a
// stack. "Going from CS_CONNECTED to CS_CLIENTLOADING for %s" identifies the
// event, and the poller above already has the values.
void* g_dprintf_tramp = nullptr;
enw::hook g_dprintf_hook;

std::mutex g_seen_mutex;
struct seen_entry { uint32_t fmt = 0; uint32_t count = 0; };
constexpr int kSeenCap = 96;
seen_entry g_seen[kSeenCap];
int g_seen_used = 0;
constexpr uint32_t kPerFormatCap = 20;

void __cdecl on_dprintf(uint32_t channel, uint32_t fmt) {
    if (!fmt || !memory::is_readable(reinterpret_cast<const void*>(fmt), 1)) return;

    uint32_t count = 0;
    {
        std::lock_guard<std::mutex> lock(g_seen_mutex);
        int i = 0;
        for (; i < g_seen_used; ++i) {
            if (g_seen[i].fmt == fmt) break;
        }
        if (i == g_seen_used) {
            if (g_seen_used >= kSeenCap) return;   // table full: stay quiet rather than spam
            g_seen[g_seen_used++] = { fmt, 0 };
        }
        count = ++g_seen[i].count;
    }
    if (count > kPerFormatCap) return;

    char text[200];
    const char* p = reinterpret_cast<const char*>(fmt);
    size_t j = 0;
    for (size_t k = 0; k < sizeof text - 1; ++k) {
        if (!memory::is_readable(p + k, 1)) break;
        const auto c = static_cast<unsigned char>(p[k]);
        if (c == '\0') break;
        if (c == '\n' || c == '\r') { text[j++] = ' '; continue; }
        text[j++] = (c < 0x20 || c > 0x7E) ? '.' : static_cast<char>(c);
    }
    text[j] = '\0';

    ENW_INFO("dprint[%u] %s%s", static_cast<unsigned>(channel), text,
             count == kPerFormatCap ? "   (further copies of this line suppressed)" : "");
}

// esp+36 = the original esp after pushfd(4) + pushad(32). The caller pushed
// right to left, so [esp+36+0] is the return address, [esp+36+4] the channel and
// [esp+36+8] the format pointer. We read, we do not consume: the trampoline sees
// the stack exactly as the engine left it.
__declspec(naked) void dprintf_stub() {
    __asm { pushfd }
    __asm { pushad }
    __asm { mov  eax, [esp + 36 + 8] }
    __asm { push eax }
    __asm { mov  eax, [esp + 36 + 4 + 4] }
    __asm { push eax }
    __asm { call on_dprintf }
    __asm { add  esp, 8 }
    __asm { popad }
    __asm { popfd }
    __asm { jmp  dword ptr [g_dprintf_tramp] }
}

class join_probe_component final : public component {
public:
    const char* name() const override { return "dedi_join_probe"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_NO_JOINPROBE")) {
            ENW_INFO("dedi_join_probe: off (ENW_DEDI_NO_JOINPROBE)");
            return;
        }

        const char* dprint = std::getenv("ENW_DEDI_DPRINT");
        if (!dprint || std::strcmp(dprint, "0") != 0) install_dprintf_mirror();
        g_pool_enabled = std::getenv("ENW_DEDI_VARPOOL") != nullptr;

        enw::frame::subscribe("dedi_join_probe", [](uint64_t n) {
            if ((n & 3u) != 0) return;   // ~15 Hz at 61 Hz, far finer than any state change
            poll(n);
            poll_vm(n);
            poll_var_pools(n);
        });

        ENW_INFO("dedi_join_probe: watching svs.clients[0..] at 0x%08X stride 0x%X, "
                 "sv.serverId at [0x%08X]. T4's middle state is CS_CLIENTLOADING(3), not "
                 "CS_PRIMED -- see the header of this file.",
                 static_cast<unsigned>(kClientsBase), static_cast<unsigned>(kClientStride),
                 static_cast<unsigned>(kSvServerId));

        uintptr_t pure_dvar = 0;
        if (memory::read(enw::at(kSvPureDvarPtr), &pure_dvar) && pure_dvar) {
            int32_t v = 0;
            memory::read(pure_dvar + 0x10, &v);
            ENW_INFO("dedi_join_probe: sv_pure = %d at post_init (non-zero means a client whose "
                     "[client+0x323F0] reads 2 is dropped with EXE_UNPURECLIENTDETECTED)",
                     static_cast<int>(v));
        } else {
            ENW_INFO("dedi_join_probe: the sv_pure dvar_s* at [0x%08X] is not registered yet",
                     static_cast<unsigned>(kSvPureDvarPtr));
        }
    }

    void pre_destroy() override {
        if (!g_ever_seen_client)
            ENW_INFO("dedi_join_probe: no client ever occupied a slot");
    }

private:
    static void install_dprintf_mirror() {
        const uintptr_t live = enw::at(kComDPrintf);
        if (!memory::looks_like_function(live)) {
            ENW_WARN("dedi_join_probe: 0x%08X does not look like a function (%s) - not mirroring "
                     "Com_DPrintf", static_cast<unsigned>(kComDPrintf),
                     memory::hex_dump(live, 8).c_str());
            return;
        }
        if (!g_dprintf_hook.create(live, &dprintf_stub, "Com_DPrintf") || !g_dprintf_hook.enable()) {
            ENW_WARN("dedi_join_probe: could not hook Com_DPrintf at 0x%08X",
                     static_cast<unsigned>(kComDPrintf));
            return;
        }
        g_dprintf_tramp = g_dprintf_hook.original<void*>();
        ENW_INFO("dedi_join_probe: mirroring Com_DPrintf 0x%08X (the connect path narrates itself "
                 "through this function and the engine drops it unless `developer` is 1, which we "
                 "do not set). First %u copies of each distinct line.",
                 static_cast<unsigned>(kComDPrintf), static_cast<unsigned>(kPerFormatCap));
    }
};

#else

class join_probe_component final : public component {
public:
    const char* name() const override { return "dedi_join_probe"; }
};

#endif

ENW_REGISTER_COMPONENT(join_probe_component)

}  // namespace
}  // namespace enw::dedi
