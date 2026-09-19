#include "component.hpp"

#include "logger.hpp"

namespace enw {
namespace {

// One component crashing must not take the other three agents' work down with it.
// The SEH filter lives in its own tiny function: MSVC refuses __try in a function
// that also needs C++ object unwinding.
enum class phase { load, unpack, init, destroy };

unsigned call_guarded(component* c, phase p) {
    __try {
        switch (p) {
            case phase::load: c->post_load(); break;
            case phase::unpack: c->post_unpack(); break;
            case phase::init: c->post_init(); break;
            case phase::destroy: c->pre_destroy(); break;
        }
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return static_cast<unsigned>(GetExceptionCode());
    }
}

}  // namespace

// Function-local static: components register during CRT init, before DllMain's
// body runs, so a namespace-scope vector would be a static-init-order bug waiting
// to happen. This one is constructed on first use, i.e. at the first registration.
std::vector<std::unique_ptr<component>>& components::list() {
    static std::vector<std::unique_ptr<component>> instances;
    return instances;
}

void components::add(std::unique_ptr<component>&& c) {
    if (c) list().emplace_back(std::move(c));
}

size_t components::count() { return list().size(); }

size_t components::run_post_load() {
    size_t ran = 0;
    for (const auto& c : list()) {
        if (!c->is_supported()) {
            ENW_DEBUG("components: %s not supported here, skipped", c->name());
            continue;
        }
        const unsigned code = call_guarded(c.get(), phase::load);
        if (code) {
            ENW_ERROR("components: %s faulted (%08X) in post_load", c->name(), code);
        } else {
            ++ran;
        }
    }
    ENW_INFO("components: post_load done (%u of %u ok)", static_cast<unsigned>(ran),
             static_cast<unsigned>(list().size()));
    return ran;
}

size_t components::run_post_unpack() {
    size_t ran = 0;
    for (const auto& c : list()) {
        if (!c->is_supported()) continue;
        const unsigned code = call_guarded(c.get(), phase::unpack);
        if (code) {
            ENW_ERROR("components: %s faulted (%08X) in post_unpack", c->name(), code);
        } else {
            ++ran;
        }
    }
    ENW_INFO("components: post_unpack done (%u of %u ok)", static_cast<unsigned>(ran),
             static_cast<unsigned>(list().size()));
    return ran;
}

size_t components::run_post_init() {
    size_t ran = 0;
    for (const auto& c : list()) {
        if (!c->is_supported()) continue;
        const unsigned code = call_guarded(c.get(), phase::init);
        if (code) {
            ENW_ERROR("components: %s faulted (%08X) in post_init", c->name(), code);
        } else {
            ++ran;
        }
    }
    ENW_INFO("components: post_init done (%u of %u ok)", static_cast<unsigned>(ran),
             static_cast<unsigned>(list().size()));
    return ran;
}

void components::run_pre_destroy() {
    for (const auto& c : list()) {
        call_guarded(c.get(), phase::destroy);
    }
}

}  // namespace enw
