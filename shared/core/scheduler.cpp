#include "scheduler.hpp"

#include "logger.hpp"

#include <deque>
#include <mutex>

namespace enw::scheduler {
namespace {

constexpr size_t kMaxPending = 256;

std::mutex g_mutex;
std::deque<std::function<void()>> g_queue;
unsigned long g_main_thread = 0;
stats g_stats;

// Per-thread guard: a job that itself calls something that pumps must not recurse.
thread_local bool tl_pumping = false;

// SEH needs its own function: MSVC refuses __try where C++ objects must unwind.
unsigned invoke_guarded(std::function<void()>* fn) {
    __try {
        (*fn)();
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return static_cast<unsigned>(GetExceptionCode());
    }
}

}  // namespace

void set_main_thread(unsigned long thread_id) { g_main_thread = thread_id; }
unsigned long main_thread_id() { return g_main_thread; }
bool on_main_thread() { return g_main_thread != 0 && ::GetCurrentThreadId() == g_main_thread; }

bool run_on_main(std::function<void()> fn) {
    if (!fn) return false;
    std::lock_guard<std::mutex> lk(g_mutex);
    g_queue.emplace_back(std::move(fn));
    ++g_stats.queued;
    bool ok = true;
    while (g_queue.size() > kMaxPending) {
        g_queue.pop_front();
        ++g_stats.dropped;
        ok = false;
    }
    return ok;
}

size_t pump(size_t max_items) {
    if (!on_main_thread() || tl_pumping) return 0;
    tl_pumping = true;
    size_t ran = 0;
    while (ran < max_items) {
        std::function<void()> fn;
        {
            std::lock_guard<std::mutex> lk(g_mutex);
            if (g_queue.empty()) break;
            fn = std::move(g_queue.front());
            g_queue.pop_front();
            ++g_stats.pumps;
        }
        const unsigned code = invoke_guarded(&fn);
        if (code) ENW_ERROR("scheduler: a main-thread job faulted (%08X)", code);
        ++ran;
    }
    if (ran) {
        std::lock_guard<std::mutex> lk(g_mutex);
        g_stats.ran += ran;
    }
    tl_pumping = false;
    return ran;
}

stats snapshot() {
    std::lock_guard<std::mutex> lk(g_mutex);
    stats s = g_stats;
    s.pending = g_queue.size();
    return s;
}

}  // namespace enw::scheduler
