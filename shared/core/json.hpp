// A small JSON writer and parser.
//
// Deliberately dependency-free: this DLL is injected into a 2009 game and every
// extra library is another thing that can go wrong in DllMain. The protocol
// (docs/protocol/game-link-v0.md) is NDJSON, one flat-ish object per line, so a
// full JSON implementation would be overkill.
#pragma once
#include "enw.hpp"

#include <map>
#include <memory>

namespace enw::json {

std::string escape(std::string_view s);

// ---------------------------------------------------------------- writing --
// writer w; w.str("t", "hello").num("ms", 1234).boolean("ok", true);
// std::string line = w.str();   // {"t":"hello","ms":1234,"ok":true}
class writer {
public:
    writer() { buf_.push_back('{'); }

    writer& str(std::string_view key, std::string_view value);
    writer& num(std::string_view key, double value);
    writer& integer(std::string_view key, long long value);
    writer& boolean(std::string_view key, bool value);
    writer& null(std::string_view key);
    // Insert an already-serialised value (array, nested object, ...).
    writer& raw(std::string_view key, std::string_view json_value);

    // Closes the object. Callable once; further use is undefined.
    std::string done();

private:
    void comma();
    void key(std::string_view k);
    std::string buf_;
    bool first_ = true;
};

// A serialised array builder, for the `snap`/`players` lists.
class array {
public:
    array() { buf_.push_back('['); }
    array& raw(std::string_view json_value);
    array& str(std::string_view value);
    array& num(double value);
    array& integer(long long value);
    std::string done();
    size_t count() const { return n_; }

private:
    std::string buf_;
    size_t n_ = 0;
};

// ---------------------------------------------------------------- reading --
enum class kind { null, boolean, number, string, array, object };

class value {
public:
    kind type = kind::null;
    bool b = false;
    double n = 0.0;
    std::string s;
    std::vector<value> items;
    std::map<std::string, value> fields;

    bool is_null() const { return type == kind::null; }
    bool has(const std::string& k) const { return type == kind::object && fields.count(k) != 0; }

    // Lookups that never throw: a missing/wrong-typed field yields the fallback.
    const value* find(const std::string& k) const;
    std::string str_or(const std::string& k, std::string_view fallback = "") const;
    double num_or(const std::string& k, double fallback = 0.0) const;
    long long int_or(const std::string& k, long long fallback = 0) const;
    bool bool_or(const std::string& k, bool fallback = false) const;
};

// Parses one complete JSON value. Returns false on malformed input; `out` is then
// untouched. Depth-limited so a hostile peer cannot blow the stack.
bool parse(std::string_view text, value* out);

}  // namespace enw::json
