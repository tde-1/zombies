cmake_minimum_required(VERSION 3.21)

# ENW Zombies -- the in-game DLL.
#
# ONE target: enw_t4.dll, 32-bit, MSVC. It is deployed into a dev game copy under
# the name of a DLL the game already imports (binkw32.dll) with every export
# forwarded to the renamed original -- see shared/core/dllmain.cpp.
#
#   Configure + build:  powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1
#   Deploy:             powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 foundation
#
# CoDWaW.exe is x86, so this project is x86. There is no 64-bit configuration and
# there never will be; the CMake preset / build script passes -A Win32.

project(enw_zombies LANGUAGES C CXX)

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
    message(FATAL_ERROR
        "enw_t4 must be configured for 32-bit (CoDWaW.exe is x86).\n"
        "Use tools\\dev\\build.ps1, or pass -A Win32 to cmake.")
endif()

if(NOT MSVC)
    message(FATAL_ERROR "enw_t4 is MSVC-only (it lives inside a Windows game process).")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

# Static CRT: the DLL is dropped into a game folder we do not control the
# redistributables of. Nothing to install alongside it.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "" FORCE)
endif()

option(ENW_WITH_SERVER_COMPONENTS
    "Compile server/components/**/*.cpp into the DLL (other agents' components)" ON)
option(ENW_WITH_CLIENT_COMPONENTS
    "Compile client-dll/components/**/*.cpp into the DLL" ON)

# ----------------------------------------------------------------- MinHook --
# thirdparty/minhook, BSD-2-Clause, vendored verbatim (see its LICENSE.txt and
# VENDORED-FROM.txt). Brings its own length disassembler, which is the whole
# reason we are not hand-rolling a 5-byte detour.
file(GLOB MINHOOK_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/minhook/src/*.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/minhook/src/hde/*.c")

add_library(minhook STATIC ${MINHOOK_SOURCES})
target_include_directories(minhook PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/minhook/include")
target_compile_definitions(minhook PRIVATE _CRT_SECURE_NO_WARNINGS)
set_target_properties(minhook PROPERTIES FOLDER thirdparty)

# ----------------------------------------------------------------- enw_t4 ---
# Globbed on purpose: components self-register (shared/core/component.hpp), so
# adding a feature is adding a file. CONFIGURE_DEPENDS makes the build notice.
file(GLOB_RECURSE ENW_CORE_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/shared/core/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/shared/core/*.hpp")

file(GLOB_RECURSE ENW_T4_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/shared/t4/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/shared/t4/*.hpp")

set(ENW_COMPONENT_SOURCES "")
if(ENW_WITH_SERVER_COMPONENTS)
    file(GLOB_RECURSE ENW_SERVER_SOURCES CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/server/components/*.cpp")
    list(APPEND ENW_COMPONENT_SOURCES ${ENW_SERVER_SOURCES})
endif()
if(ENW_WITH_CLIENT_COMPONENTS)
    file(GLOB_RECURSE ENW_CLIENT_SOURCES CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/client-dll/components/*.cpp")
    list(APPEND ENW_COMPONENT_SOURCES ${ENW_CLIENT_SOURCES})
endif()

set(ENW_PROXY_DEF "${CMAKE_CURRENT_SOURCE_DIR}/shared/core/proxy/binkw32.def")

add_library(enw_t4 SHARED
    ${ENW_CORE_SOURCES}
    ${ENW_T4_SOURCES}
    ${ENW_COMPONENT_SOURCES}
    ${ENW_PROXY_DEF})

set_source_files_properties(${ENW_PROXY_DEF} PROPERTIES HEADER_FILE_ONLY ON)

set_target_properties(enw_t4 PROPERTIES
    OUTPUT_NAME "enw_t4"
    PREFIX ""
    # The 71 forwarders that make us look like binkw32.dll.
    LINK_FLAGS "/DEF:\"${ENW_PROXY_DEF}\"")

target_include_directories(enw_t4 PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/shared/core"
    "${CMAKE_CURRENT_SOURCE_DIR}/shared")

target_link_libraries(enw_t4 PRIVATE minhook ws2_32)

target_compile_definitions(enw_t4 PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
    _WINSOCK_DEPRECATED_NO_WARNINGS)

target_compile_options(enw_t4 PRIVATE
    /W4
    /permissive-
    /Zc:__cplusplus
    /utf-8
    /MP
    # We use __try/__except around every call into game code and every component
    # entry point; a component faulting must be a log line, not a dead game.
    /EHsc)

# Debug info even in release: a crash inside a 2009 game with no symbols is a
# very bad afternoon.
target_link_options(enw_t4 PRIVATE /DEBUG)

# --------------------------------------------------------------- loadtest --
# A 32-bit host that just LoadLibrary()s the DLL, so we can smoke-test DllMain
# without taking the game lock. Built by default; it costs nothing.
add_executable(loadtest "${CMAKE_CURRENT_SOURCE_DIR}/tools/dev/loadtest.cpp")
target_compile_definitions(loadtest PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
set_target_properties(loadtest PROPERTIES FOLDER tools)

# ------------------------------------------------------------- mouse_tests --
# Unit tests for client-dll/components/raw_buffer.hpp and mouse_jitter.hpp
# (client.md §1f). Pure headers, so no game and no lock. Exit code 0 = pass.
add_executable(mouse_tests "${CMAKE_CURRENT_SOURCE_DIR}/tools/dev/mouse_tests.cpp")
target_compile_definitions(mouse_tests PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
set_target_properties(mouse_tests PROPERTIES FOLDER tools)

# rawprobe: the 32-bit harness that proved the WOW64 offset and that SendInput
# at 1000 Hz reaches an RIDEV_INPUTSINK window. Not a test; a measuring tool.
add_executable(rawprobe "${CMAKE_CURRENT_SOURCE_DIR}/tools/dev/rawprobe.cpp")
target_compile_definitions(rawprobe PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
target_link_libraries(rawprobe PRIVATE winmm)
set_target_properties(rawprobe PROPERTIES FOLDER tools)

source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES
    ${ENW_CORE_SOURCES} ${ENW_T4_SOURCES} ${ENW_COMPONENT_SOURCES} ${ENW_PROXY_DEF})

list(LENGTH ENW_COMPONENT_SOURCES _n_components)
message(STATUS "enw_t4: ${_n_components} component source(s) from server/ + client-dll/")
