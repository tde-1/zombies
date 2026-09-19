#include "json.hpp"

#include <cmath>
#include <cstdlib>

namespace enw::json {

std::string escape(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (const unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char tmp[8];
                    _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "\\u%04x", c);
                    out += tmp;
                } else {
                    // Bytes >= 0x80 pass through. Game strings are Latin-1-ish; the
                    // host side decodes as UTF-8 and tolerates replacement chars.
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    return out;
}

namespace {
std::string number_to_string(double v) {
    if (!std::isfinite(v)) return "null";  // JSON has no NaN/Infinity
    char tmp[40];
    if (v == static_cast<double>(static_cast<long long>(v)) && std::fabs(v) < 9.0e15) {
        _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%lld", static_cast<long long>(v));
    } else {
        _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%.6g", v);
    }
    return tmp;
}
}  // namespace

void writer::comma() {
    if (!first_) buf_.push_back(',');
    first_ = false;
}

void writer::key(std::string_view k) {
    comma();
    buf_.push_back('"');
    buf_ += escape(k);
    buf_ += "\":";
}

writer& writer::str(std::string_view k, std::string_view v) {
    key(k);
    buf_.push_back('"');
    buf_ += escape(v);
    buf_.push_back('"');
    return *this;
}

writer& writer::num(std::string_view k, double v) {
    key(k);
    buf_ += number_to_string(v);
    return *this;
}

writer& writer::integer(std::string_view k, long long v) {
    key(k);
    char tmp[32];
    _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%lld", v);
    buf_ += tmp;
    return *this;
}

writer& writer::boolean(std::string_view k, bool v) {
    key(k);
    buf_ += v ? "true" : "false";
    return *this;
}

writer& writer::null(std::string_view k) {
    key(k);
    buf_ += "null";
    return *this;
}

writer& writer::raw(std::string_view k, std::string_view json_value) {
    key(k);
    buf_ += json_value;
    return *this;
}

std::string writer::done() {
    buf_.push_back('}');
    return buf_;
}

array& array::raw(std::string_view v) {
    if (n_++) buf_.push_back(',');
    buf_ += v;
    return *this;
}

array& array::str(std::string_view v) {
    if (n_++) buf_.push_back(',');
    buf_.push_back('"');
    buf_ += escape(v);
    buf_.push_back('"');
    return *this;
}

array& array::num(double v) {
    if (n_++) buf_.push_back(',');
    buf_ += number_to_string(v);
    return *this;
}

array& array::integer(long long v) {
    if (n_++) buf_.push_back(',');
    char tmp[32];
    _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%lld", v);
    buf_ += tmp;
    return *this;
}

std::string array::done() {
    buf_.push_back(']');
    return buf_;
}

// ------------------------------------------------------------------ parser --
namespace {

constexpr int kMaxDepth = 24;

struct parser {
    std::string_view t;
    size_t i = 0;

    void ws() {
        while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) ++i;
    }
    bool eof() const { return i >= t.size(); }
    char peek() const { return i < t.size() ? t[i] : '\0'; }

    bool lit(const char* s, size_t n) {
        if (t.size() - i < n || t.compare(i, n, s) != 0) return false;
        i += n;
        return true;
    }

    bool hex4(unsigned* out) {
        if (t.size() - i < 4) return false;
        unsigned v = 0;
        for (int k = 0; k < 4; ++k) {
            const char c = t[i + k];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
            else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
            else return false;
        }
        i += 4;
        *out = v;
        return true;
    }

    static void append_utf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool string(std::string* out) {
        if (peek() != '"') return false;
        ++i;
        out->clear();
        while (!eof()) {
            const char c = t[i++];
            if (c == '"') return true;
            if (c != '\\') {
                out->push_back(c);
                continue;
            }
            if (eof()) return false;
            const char e = t[i++];
            switch (e) {
                case '"': out->push_back('"'); break;
                case '\\': out->push_back('\\'); break;
                case '/': out->push_back('/'); break;
                case 'b': out->push_back('\b'); break;
                case 'f': out->push_back('\f'); break;
                case 'n': out->push_back('\n'); break;
                case 'r': out->push_back('\r'); break;
                case 't': out->push_back('\t'); break;
                case 'u': {
                    unsigned cp = 0;
                    if (!hex4(&cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF && t.size() - i >= 6 && t[i] == '\\' && t[i + 1] == 'u') {
                        const size_t save = i;
                        i += 2;
                        unsigned lo = 0;
                        if (hex4(&lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        } else {
                            i = save;
                        }
                    }
                    append_utf8(*out, cp);
                    break;
                }
                default: return false;
            }
        }
        return false;
    }

    bool number(double* out) {
        const size_t start = i;
        if (peek() == '-') ++i;
        while (!eof() && ((peek() >= '0' && peek() <= '9') || peek() == '.' || peek() == 'e' ||
                          peek() == 'E' || peek() == '+' || peek() == '-')) {
            ++i;
        }
        if (i == start) return false;
        const std::string tmp(t.substr(start, i - start));
        char* end = nullptr;
        const double v = strtod(tmp.c_str(), &end);
        if (end == tmp.c_str()) return false;
        *out = v;
        return true;
    }

    bool val(value* out, int depth) {
        if (depth > kMaxDepth) return false;
        ws();
        if (eof()) return false;
        switch (peek()) {
            case 'n':
                if (!lit("null", 4)) return false;
                out->type = kind::null;
                return true;
            case 't':
                if (!lit("true", 4)) return false;
                out->type = kind::boolean;
                out->b = true;
                return true;
            case 'f':
                if (!lit("false", 5)) return false;
                out->type = kind::boolean;
                out->b = false;
                return true;
            case '"':
                out->type = kind::string;
                return string(&out->s);
            case '[': {
                ++i;
                out->type = kind::array;
                ws();
                if (peek() == ']') { ++i; return true; }
                for (;;) {
                    value item;
                    if (!val(&item, depth + 1)) return false;
                    out->items.push_back(std::move(item));
                    ws();
                    if (peek() == ',') { ++i; continue; }
                    if (peek() == ']') { ++i; return true; }
                    return false;
                }
            }
            case '{': {
                ++i;
                out->type = kind::object;
                ws();
                if (peek() == '}') { ++i; return true; }
                for (;;) {
                    ws();
                    std::string k;
                    if (!string(&k)) return false;
                    ws();
                    if (peek() != ':') return false;
                    ++i;
                    value item;
                    if (!val(&item, depth + 1)) return false;
                    out->fields[std::move(k)] = std::move(item);
                    ws();
                    if (peek() == ',') { ++i; continue; }
                    if (peek() == '}') { ++i; return true; }
                    return false;
                }
            }
            default:
                out->type = kind::number;
                return number(&out->n);
        }
    }
};

}  // namespace

bool parse(std::string_view text, value* out) {
    if (!out) return false;
    parser p{text, 0};
    value v;
    if (!p.val(&v, 0)) return false;
    p.ws();
    if (!p.eof()) return false;  // trailing junk: reject the whole line
    *out = std::move(v);
    return true;
}

const value* value::find(const std::string& k) const {
    if (type != kind::object) return nullptr;
    const auto it = fields.find(k);
    return it == fields.end() ? nullptr : &it->second;
}

std::string value::str_or(const std::string& k, std::string_view fallback) const {
    const value* v = find(k);
    return (v && v->type == kind::string) ? v->s : std::string(fallback);
}

double value::num_or(const std::string& k, double fallback) const {
    const value* v = find(k);
    return (v && v->type == kind::number) ? v->n : fallback;
}

long long value::int_or(const std::string& k, long long fallback) const {
    const value* v = find(k);
    return (v && v->type == kind::number) ? static_cast<long long>(v->n) : fallback;
}

bool value::bool_or(const std::string& k, bool fallback) const {
    const value* v = find(k);
    return (v && v->type == kind::boolean) ? v->b : fallback;
}

}  // namespace enw::json
