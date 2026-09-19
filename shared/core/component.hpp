// The component registry.
//
// Add a feature by dropping a .cpp into the build with a class and one macro at
// the bottom. No shared list to edit, so four agents can add components without
// ever touching the same file.
//
//     #include "component.hpp"
//     class my_thing final : public enw::component {
//     public:
//       const char* name() const override { return "my_thing"; }
//       void post_unpack() override { /* safe to touch game memory here */ }
//     };
//     ENW_REGISTER_COMPONENT(my_thing)
//
// Pattern (interface shape, installer template, REGISTER macro) follows
// alterware/iw4x-sp's component_loader, GPL-3.0; our build is GPL/AGPL too.
//
// THE PHASES MATTER:
//   post_load()   runs on the loader thread while the game's .text may still be
//                 SteamStub-encrypted. Read your config, start your threads, do
//                 NOT read or patch game memory.
//   post_unpack() runs once the game is decrypted and verified. This is where
//                 hooks and patches go. NOTE: this is only ~100 ms into the
//                 process -- the engine has not started yet, so Com_Printf goes
//                 nowhere and no engine subsystem exists.
//   post_init()   runs once the engine's dvar system is up (Com_Init has run),
//                 AND runs on the game's own main thread. This is the first
//                 moment the in-game console, dvars and commands actually work.
//                 Put anything user-visible, and anything that touches engine
//                 state, here.
#pragma once
#include "enw.hpp"

#include <memory>
#include <type_traits>

namespace enw {

class component {
public:
    virtual ~component() = default;

    virtual const char* name() const = 0;

    // Skip this component entirely (e.g. client-only code in a dedicated server).
    virtual bool is_supported() { return true; }

    virtual void post_load() {}
    virtual void post_unpack() {}
    virtual void post_init() {}
    virtual void pre_destroy() {}
};

class components final {
public:
    template <typename T>
    class installer final {
        static_assert(std::is_base_of_v<component, T>, "component must derive from enw::component");

    public:
        installer() { components::add(std::make_unique<T>()); }
    };

    static void add(std::unique_ptr<component>&& c);

    // Each returns the number of components that ran.
    static size_t run_post_load();
    static size_t run_post_unpack();
    static size_t run_post_init();
    static void run_pre_destroy();

    static size_t count();

    template <typename T>
    static T* get() {
        for (const auto& c : list()) {
            if (auto* p = dynamic_cast<T*>(c.get())) return p;
        }
        return nullptr;
    }

private:
    static std::vector<std::unique_ptr<component>>& list();
};

}  // namespace enw

#define ENW_REGISTER_COMPONENT(type_name)                     \
    namespace {                                               \
    ::enw::components::installer<type_name> enw_installer_;    \
    }
