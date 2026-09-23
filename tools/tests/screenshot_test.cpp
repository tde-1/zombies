// Unit tests for client-dll/components/screenshot_name.hpp (lane SS, client.md §15): the file name,
// the format setting and the key-spam limit of ENW's own screenshot.
//
//   build\<name>\RelWithDebInfo\screenshot_test.exe     exit code = failures
#include "screenshot_name.hpp"

#include <cstdio>
#include <string>

namespace {
int g_pass = 0, g_fail = 0;
void check(bool ok, const char* what, const std::string& detail = {}) {
    if (ok) { ++g_pass; std::printf("  ok   %s\n", what); }
    else { ++g_fail; std::printf("  FAIL %s [%s]\n", what, detail.c_str()); }
}
}  // namespace

using namespace enw::client::screenshot_name;

int main() {
    std::printf("names\n");
    check(file_name("Nacht der Untoten", 2026, 9, 24, 14, 3, 22, format::jpg) == "ENW Zombies Nacht der Untoten 2026-09-24 14-03-22.jpg",
          "B's shape: ENW Zombies <map> <yyyy-mm-dd hh-mm-ss>.jpg",
          file_name("Nacht der Untoten", 2026, 9, 24, 14, 3, 22, format::jpg));
    check(file_name("Der Riese", 2026, 1, 2, 3, 4, 5, format::png) == "ENW Zombies Der Riese 2026-01-02 03-04-05.png", "png, zero-padded");
    check(file_name("Der Riese", 2026, 1, 2, 3, 4, 5, format::jpg, 2) == "ENW Zombies Der Riese 2026-01-02 03-04-05 (2).jpg",
          "a second shot in the same second gets (2)");
    check(file_name("", 2026, 1, 2, 3, 4, 5, format::jpg) == "ENW Zombies World at War 2026-01-02 03-04-05.jpg", "no map: World at War");

    std::printf("map part\n");
    check(map_part("nazi_zombie_prototype", "", "") == "Nacht der Untoten", "stock Nacht by its own name");
    check(map_part("NAZI_ZOMBIE_FACTORY", "", "") == "Der Riese", "case-blind");
    check(map_part("nazi_zombie_asylum", "", "") == "Verruckt" && map_part("nazi_zombie_sumpf", "", "") == "Shi No Numa", "Verruckt, Shi No Numa");
    check(map_part("nazi_zombie_ccube", "Cheese Cube", "nazi_zombie_ccube") == "Cheese Cube", "the launcher's title for the launched map");
    check(map_part("nazi_zombie_ccube", "Cheese Cube", "") == "Cheese Cube", "a title with no launch bsp is trusted");
    check(map_part("nazi_zombie_other", "Cheese Cube", "nazi_zombie_ccube") == "nazi_zombie_other", "a title for ANOTHER map is not used");
    check(map_part("nazi_zombie_ccube", "", "") == "nazi_zombie_ccube", "a custom map without a title: its bsp");
    check(map_part("", "", "") == "World at War", "no map at all");
    check(map_part("x", "  Leviathan: Remastered? <v2>  ", "x") == "Leviathan Remastered v2", "a title is made safe for a file name",
          map_part("x", "  Leviathan: Remastered? <v2>  ", "x"));

    std::printf("sanitize\n");
    check(sanitize("a\\b/c:d*e?f\"g<h>i|j") == "a b c d e f g h i j", "every character Windows refuses", sanitize("a\\b/c:d*e?f\"g<h>i|j"));
    check(sanitize("..hidden.  ") == "hidden", "no leading/trailing dots or spaces");
    check(sanitize(std::string("tab\there\nnl")) == "tab here nl", "control characters");
    check(sanitize("") == "", "empty stays empty");
    {
        const std::string longs(100, 'x');
        check(sanitize(longs).size() == 64, "at most 64 bytes");
        std::string utf = std::string(63, 'a') + "\xC3\xA9" + "zzz";   // an e-acute straddling byte 64
        const std::string cut = sanitize(utf);
        check(cut.size() == 63 && cut.back() == 'a', "never cut mid-character", std::to_string(cut.size()));
    }

    std::printf("format\n");
    check(parse_format("png") == format::png && parse_format("PNG") == format::png && parse_format("\"png\"") == format::png, "png, any case, quoted");
    check(parse_format("") == format::jpg && parse_format("jpg") == format::jpg && parse_format("jpeg") == format::jpg && parse_format("bmp") == format::jpg,
          "anything else is JPEG (the default)");
    check(std::string(ext(format::jpg)) == "jpg" && std::string(ext(format::png)) == "png", "extensions");

    std::printf("rate limit\n");
    {
        rate_limit r;
        check(r.allow(1000), "the first press");
        check(!r.allow(1200) && !r.allow(1499), "a press within 500 ms is refused");
        check(r.allow(1500), "500 ms later it is allowed again");
        check(!r.allow(1999) && r.allow(2000), "measured from the last ACCEPTED press");
        rate_limit z;
        check(z.allow(0), "a clock at zero still takes the first press");
    }

    std::printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail;
}
