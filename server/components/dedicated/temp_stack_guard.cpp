// The server leaks the engine's temp-memory stack once per client message, and the
// leaked pointer walks through the script-variable pool. This puts the pointer back.
//
// ---------------------------------------------------------------------------
// The bug, measured (dedi.md 7j, runs join33-join45)
// ---------------------------------------------------------------------------
// T4 decodes a client's compressed message into temp memory. `SV_ExecuteClientMessage`
// 0x630F70 takes the current temp-stack offset out of the dword at 0x046E5054, bumps it
// by 0x20000, and decodes into `0x0212B2F8 + old_offset`:
//
//     00630F78  mov  eax, [0x46E5054]     ; the offset
//     00630F7D  mov  ebp, eax
//     00630F7F  add  eax, 0x20000         ; one 128 KB frame
//     00630F8B  mov  [esp+0x10], ebp      ; remember the old offset
//     00630F91  mov  [0x46E5054], eax     ; push
//     00630F96  lea  ebp, [ebp+0x212B2F8] ; dst = base + old offset
//     ...
//     00631035  mov  [0x46E5054], edx     ; pop  (and four more like it, one per
//                                         ;       return path -- all five restore)
//
// On our headless dedicated server the pop stops happening the moment a real client is
// active. A hardware watchpoint on 0x046E5054 (var_watch.cpp, run join44) catches it in
// as many words: the writes from 0x630F96 climb 0x60000, 0x80000, 0xA0000, 0xC0000 ...
// one per client message, with every nested push/pop inside them balanced and not one
// write from any of the five restore sites in between.
//
// So the decode destination marches forward through the process 128 KB at a time.
// tools/dev/varcheck.py watched it cross the script-variable pool: in join40 the offset
// went 0x1780000 -> 0x1BE0000 between two sweeps, which is 0x038AB2F8 -> 0x03D0B2F8, and
// the pool runs 0x03974700 - 0x03A74700. In that same half second the pool's chain
// invariant broke -- fourteen slots left occupying a hash bucket they are no longer
// linked into -- and it never recovered. Four seconds later the frame loop stopped in
// 0x0068F090's predecessor search, hunting a slot that is not in its chain. join37
// closed that loop by hand: the `index` the spin was searching for, 0x16C0, is one of
// the slots varcheck.py had already flagged.
//
// The freeze of 7j is therefore a SYMPTOM. The bug is this leak, and the script pool is
// simply the first thing in its path that the engine reads back.
//
// Ruled out along the way, each by a run rather than by argument:
//   * the variable allocator (the damage is a 16-byte record repeated every 0x20000
//     bytes, which no hash table produces),
//   * our `huffman_guard`, which hooks the decoder in the middle of this very span
//     (join45: guard off with ENW_NO_HUFFMAN_GUARD=1, leak and freeze identical),
//   * our own game components (join24, dedi.md 7j),
//   * pool exhaustion (join25).
//
// WHAT IS STILL NOT KNOWN: why the engine's own pop is skipped. Every return path in
// 0x630F70 writes 0x046E5054 back, no Com_Error is raised (error_trap.cpp counted zero
// in join44), and the function plainly does return, because the server keeps serving.
//
// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------
// Put the offset back to its frame-boundary baseline at the end of every frame.
//
// Why that is safe, measured rather than assumed: at a frame boundary NOTHING holds a
// temp frame. varcheck.py sampled this dword four times a second for the eleven
// seconds before the client connected (join40) and it read 0 every time, and the
// engine's own code writes it back on every balanced path. Our frame tick runs after
// Com_Frame, so every packet for the frame has already been handled and every temp
// block taken during it is dead. The component captures the baseline itself at its
// first tick instead of hard-coding 0, and only ever restores a value it read.
//
// Effect: the offset can no longer climb past one frame's worth of client messages
// above the base of the temp arena -- which is where the engine itself takes it,
// several frames deep, in ordinary play -- instead of marching 68 MB into gScrVarGlob.
// Runs join48-join51: 120 s with a player in the game, ~2,000 frames put back each
// time, the pool's invariant never broken once, the frame loop never stopping.
//
// A SECOND, OPTIONAL PART, and what it ruled out. ENW_DEDI_TEMP_THUNK=1 also wraps
// SV_PacketEvent's tail jump into SV_ExecuteClientMessage
//
//     006357A4  mov eax, ebp
//     006357A7  mov ecx, ebx
//     006357AA  jmp 0x630F70        <- retargeted
//
// and puts the offset back if that call returns deeper than it went in. It never has
// to: join49-join51 counted 2,502 wrapped calls and 0 corrections while the frame
// reset was putting 2,034 frames back in the same run. So SV_ExecuteClientMessage's
// own frame is balanced and the unpopped push is reached some other way. That is worth
// keeping as an instrument and not worth patching a branch for, so it is off by
// default. (The wrap is safe where it is because the site is a tail JUMP: the callee
// takes EAX and ECX and has no stack arguments, the only reference to 0x630F70 in the
// image being this one jump, so the extra return address the thunk pushes is never
// read as an argument. The five bytes are checked before they are touched, the way
// no_autosave.cpp checks its cleanup bytes.)
//
// ENW_DEDI_NO_TEMP_GUARD=1 turns the whole thing off, for bisecting.
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "dedicated.hpp"

#include <windows.h>
#include <cstdint>
#include <cstdlib>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw::dedi {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

constexpr uintptr_t kExecClientMessage = 0x630F70;   // SV_ExecuteClientMessage
constexpr uintptr_t kTailJumpSite      = 0x6357AA;   // jmp 0x630F70, in SV_PacketEvent
constexpr uintptr_t kTempOffset        = 0x046E5054; // the temp-stack offset
constexpr uintptr_t kTempBase          = 0x0212B2F8; // decode dst = base + offset

// Filled in at install time so the thunk never has to call enw::at().
uintptr_t g_temp_offset_addr = 0;
uintptr_t g_target = 0;

volatile long g_calls = 0;
volatile long g_restored = 0;
uint32_t g_worst = 0;

constexpr uint32_t kNoBaseline = 0xFFFFFFFFu;
uint32_t g_baseline = kNoBaseline;
uint32_t g_worst_frame = 0;
volatile long g_frame_resets = 0;

void __cdecl note_restored(uint32_t leaked) {
    const long n = ::InterlockedIncrement(&g_restored);
    if (leaked > g_worst) g_worst = leaked;
    if (n <= 3) {
        ENW_WARN("dedi_temp_guard: SV_ExecuteClientMessage returned with the temp-stack "
                 "offset 0x%X deeper than it went in (#%ld). Put back. Without this the "
                 "decode destination walks forward 0x20000 at a time and eventually "
                 "writes through gScrVarGlob - see dedi.md 7j.",
                 static_cast<unsigned>(leaked), n);
    }
}

void __cdecl note_call() { ++g_calls; }

// Entered by JMP, so [esp] is already SV_PacketEvent's caller's return address, and
// EAX/ECX hold the arguments. We must not disturb either before the call.
//
// The saved offset is kept ON THE STACK, not in a register. SV_ExecuteClientMessage's
// prologue is `sub esp,0x60; push ebp; push esi; push edi` -- it does NOT preserve EBX,
// so a first version of this thunk that held the value in EBX compared against whatever
// the callee left there and concluded, 2,503 times out of 2,503, that nothing had
// leaked. That reading is retracted; the frame-boundary counter in the same run said
// 1,998.
__declspec(naked) void exec_client_message_thunk() {
    __asm {
        push eax                           // [esp] = caller's eax, [esp+4] = retaddr
        mov  eax, dword ptr [g_temp_offset_addr]
        mov  eax, dword ptr [eax]          // the offset on the way in
        xchg eax, dword ptr [esp]          // park it; eax is the argument again
        call dword ptr [g_target]          // SV_ExecuteClientMessage(eax, ecx)

        pushfd
        pushad                             // pushfd 4 + pushad 32 = 36
        mov  ecx, dword ptr [g_temp_offset_addr]
        mov  edx, dword ptr [ecx]
        mov  ebx, dword ptr [esp + 36]     // the offset we parked
        cmp  edx, ebx
        jbe  balanced
        sub  edx, ebx
        push edx
        call note_restored
        add  esp, 4
        mov  ecx, dword ptr [g_temp_offset_addr]
        mov  ebx, dword ptr [esp + 36]
        mov  dword ptr [ecx], ebx          // put the stack back where it was
    balanced:
        call note_call
        popad
        popfd

        add  esp, 4                        // drop the parked offset
        ret
    }
}

class temp_stack_guard_component final : public component {
public:
    const char* name() const override { return "dedi_temp_guard"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_NO_TEMP_GUARD")) {
            ENW_WARN("dedi_temp_guard: ENW_DEDI_NO_TEMP_GUARD set - the temp-stack leak in "
                     "SV_ExecuteClientMessage is NOT corrected. The server will corrupt the "
                     "script-variable pool and freeze about ten seconds after a player "
                     "spawns. Diagnostic use only.");
            return;
        }

        // The offset must be readable, and at post_init (no client has connected yet)
        // it must be 0 -- that is what join40-join51 measured, and it is what makes
        // "put it back to the baseline" mean anything. Checked, not assumed.
        g_temp_offset_addr = enw::at(kTempOffset);
        uint32_t now = 0xFFFFFFFF;
        if (!memory::read(g_temp_offset_addr, &now)) {
            ENW_ERROR("dedi_temp_guard: NOT installing: 0x%08X is not readable",
                      static_cast<unsigned>(g_temp_offset_addr));
            return;
        }
        if (now != 0) {
            ENW_WARN("dedi_temp_guard: the temp-stack offset is 0x%X at post_init, not 0. "
                     "That is not what join40-join51 measured; installing anyway, because "
                     "the guard only ever restores a value it read itself.", now);
        }

        // ---- the call wrap: OFF by default, and here for what it ruled out -------
        //
        // It wraps SV_PacketEvent's tail jump into SV_ExecuteClientMessage and puts the
        // offset back if the call returns deeper than it went in. Runs join49-join51
        // say it never has to: 2,502 calls, 0 put back, while the frame-boundary reset
        // below put 2,034 frames back in the same run. So SV_ExecuteClientMessage's own
        // frame is BALANCED, and the unpopped push is reached some other way -- which is
        // worth keeping the instrument for, and not worth patching a branch in the
        // shipping path for. ENW_DEDI_TEMP_THUNK=1 puts it back in.
        if (::GetEnvironmentVariableA("ENW_DEDI_TEMP_THUNK", nullptr, 0) == 0) {
            install_frame_reset();
            ENW_INFO("dedi_temp_guard: the temp-stack offset at 0x%08X is put back to its "
                     "frame-boundary baseline at the end of every frame. The call wrap is "
                     "off (ENW_DEDI_TEMP_THUNK=1); it has never had anything to do. "
                     "dedi.md 7j.", static_cast<unsigned>(g_temp_offset_addr));
            return;
        }

        const uintptr_t site = enw::at(kTailJumpSite);

        // Check 1: it really is `jmp SV_ExecuteClientMessage`. An E9 with the wrong
        // target, or anything that is not an E9, and we refuse rather than write a
        // branch into the middle of an instruction.
        uint8_t op = 0;
        if (!memory::read(site, &op) || op != 0xE9) {
            ENW_ERROR("dedi_temp_guard: NOT patching 0x%08X: expected a near jmp (E9), found "
                      "%s", static_cast<unsigned>(kTailJumpSite),
                      memory::hex_dump(site, 8).c_str());
            return;
        }
        const uintptr_t target = memory::jmp_target(site);
        if (target != enw::at(kExecClientMessage)) {
            ENW_ERROR("dedi_temp_guard: NOT patching 0x%08X: it jumps to 0x%08X, expected "
                      "SV_ExecuteClientMessage 0x%08X", static_cast<unsigned>(kTailJumpSite),
                      static_cast<unsigned>(target),
                      static_cast<unsigned>(enw::at(kExecClientMessage)));
            return;
        }

        g_target = target;
        if (!memory::retarget_jmp(site, &exec_client_message_thunk)) {
            ENW_ERROR("dedi_temp_guard: retarget_jmp on 0x%08X failed",
                      static_cast<unsigned>(kTailJumpSite));
            g_target = 0;
            return;
        }

        install_frame_reset();

        ENW_INFO("dedi_temp_guard: SV_PacketEvent's tail jump at 0x%08X now goes through a "
                 "thunk that puts the temp-stack offset at 0x%08X back after every "
                 "SV_ExecuteClientMessage. dedi.md 7j.",
                 static_cast<unsigned>(kTailJumpSite),
                 static_cast<unsigned>(g_temp_offset_addr));
    }

private:
    void install_frame_reset() {
        // ---- the frame-boundary reset, which is the part that actually holds -------
        //
        // The thunk above wraps the only reference to SV_ExecuteClientMessage in the
        // image, and run join47 shows it is not enough: 10 calls through the thunk,
        // none of them unbalanced, and the offset still at 0x20E0000. So the pushes
        // that are not being popped outnumber the entries we can see, and the leak is
        // reached by a path this thunk does not cover.
        //
        // What is true whatever that path is: at a frame boundary NOTHING holds a temp
        // frame. Measured, not assumed -- varcheck.py sampled this dword four times a
        // second for the eleven seconds before the client connected (join40) and it was
        // 0 every time, and the engine's own code restores it to 0 on every balanced
        // path. Our frame tick runs after Com_Frame, so every packet for the frame has
        // been handled and every temp block taken during it is dead.
        //
        // So: capture the baseline at the first tick, and put the offset back to it at
        // the end of every frame. The offset can then never climb more than one frame's
        // worth of client messages above the base of the temp arena -- which is where
        // the engine itself takes it, several deep, in ordinary play -- instead of
        // marching 68 MB into gScrVarGlob.
        enw::frame::subscribe("dedi_temp_guard", [](uint64_t n) {
            uint32_t live = 0;
            if (!memory::read(g_temp_offset_addr, &live)) return;
            if (g_baseline == kNoBaseline) {
                g_baseline = live;
                ENW_INFO("dedi_temp_guard: temp-stack baseline at the first frame boundary "
                         "is 0x%X (decode dst 0x%08X)", live,
                         static_cast<unsigned>(enw::at(kTempBase) + live));
            } else if (live > g_baseline) {
                const uint32_t leaked = live - g_baseline;
                if (leaked > g_worst_frame) g_worst_frame = leaked;
                memory::write<uint32_t>(g_temp_offset_addr, g_baseline);
                const long k = ::InterlockedIncrement(&g_frame_resets);
                if (k <= 3)
                    ENW_WARN("dedi_temp_guard: the temp-stack offset was 0x%X above its "
                             "baseline at the end of frame %llu (#%ld). Put back. Left alone "
                             "it walks 0x20000 per client message into gScrVarGlob and the "
                             "frame loop stops - dedi.md 7j.", leaked,
                             static_cast<unsigned long long>(n), k);
            }
            if (n % 600) return;      // about every 10 s at 60 Hz
            ENW_INFO("dedi_temp_guard: %ld calls, %ld put back at the call, %ld put back at a "
                     "frame boundary (worst 0x%X in one frame); offset 0x%X",
                     g_calls, g_restored, g_frame_resets, g_worst_frame, live);
        });

    }

public:
    void pre_destroy() override {
        if (g_calls || g_frame_resets) {
            ENW_INFO("dedi_temp_guard: %ld wrapped calls (%ld put back at the call), %ld "
                     "frames ended with the temp-stack offset above its baseline and were "
                     "put back; worst 0x%X in one frame.",
                     g_calls, g_restored, g_frame_resets, g_worst_frame);
        }
    }
};

#else

class temp_stack_guard_component final : public component {
public:
    const char* name() const override { return "dedi_temp_guard"; }
};

#endif

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::temp_stack_guard_component)
