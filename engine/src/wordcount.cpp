#include "dr/wordcount.h"
#include "dr/splitter.h"
#include <functional>
#include <unordered_set>
// The counting rule follows calibre's src/calibre/utils/wordcount.py (get_wordcount): East Asian
// characters count one each and other text counts by words. This is an independent implementation
// that classifies code points by script instead of calibre's "above U+3000" test, so CJK
// punctuation, fullwidth Latin and emoji are not mistaken for characters, and punctuation is
// reported separately so both totals can be shown.
namespace dr
{
namespace
{
enum class Kind
{
    space,
    ignorable,
    cjk,
    punctuation,
    letter
};
bool in(char32_t c, char32_t first, char32_t last)
{
    return c >= first && c <= last;
}
Kind classify(char32_t c)
{
    if (c == ' ' || in(c, 0x09, 0x0d) || c == 0xa0 || c == 0x1680 || in(c, 0x2000, 0x200a) || c == 0x2028 ||
        c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000)
        return Kind::space;
    // Combining marks, zero-width joiners, variation selectors, controls and the BOM.
    if (c < 0x20 || in(c, 0x7f, 0x9f) || c == 0xad || in(c, 0x300, 0x36f) || in(c, 0x1ab0, 0x1aff) ||
        in(c, 0x200b, 0x200f) || in(c, 0x2060, 0x206f) || in(c, 0x20d0, 0x20ff) || in(c, 0xfe00, 0xfe0f) ||
        in(c, 0xfe20, 0xfe2f) || c == 0xfeff || in(c, 0x3099, 0x309a) || in(c, 0xe0000, 0xe0fff))
        return Kind::ignorable;
    if (c < 0x80)
        return (c >= '0' && c <= '9') || ((c | 0x20) >= 'a' && (c | 0x20) <= 'z') ? Kind::letter
                                                                                  : Kind::punctuation;
    if (in(c, 0xa1, 0xbf))
        return c == 0xaa || c == 0xb2 || c == 0xb3 || c == 0xb5 || c == 0xb9 || c == 0xba || in(c, 0xbc, 0xbe)
                   ? Kind::letter
                   : Kind::punctuation;
    if (c == 0xd7 || c == 0xf7)
        return Kind::punctuation;
    // Han ideographs and radicals, Japanese kana and iteration marks, Bopomofo.
    if (in(c, 0x2e80, 0x2fdf) || in(c, 0x3005, 0x3007) || in(c, 0x3021, 0x3029) || in(c, 0x3031, 0x3035) ||
        in(c, 0x3038, 0x303c) || in(c, 0x3041, 0x309f) || in(c, 0x30a1, 0x30fa) || in(c, 0x30fc, 0x30ff) ||
        in(c, 0x3105, 0x312f) || in(c, 0x31a0, 0x31bf) || in(c, 0x31f0, 0x31ff) || in(c, 0x3400, 0x4dbf) ||
        in(c, 0x4e00, 0x9fff) || in(c, 0xf900, 0xfaff) || in(c, 0x20000, 0x323af))
        return Kind::cjk;
    // General punctuation, arrows, mathematical and technical symbols, box drawing, shapes,
    // dingbats, CJK punctuation and brackets, vertical, small and fullwidth forms, and emoji.
    if (in(c, 0x2010, 0x2027) || in(c, 0x2030, 0x205e) || in(c, 0x2190, 0x2bff) || in(c, 0x2e00, 0x2e7f) ||
        in(c, 0x3001, 0x3004) || in(c, 0x3008, 0x3020) || c == 0x3030 || in(c, 0x303d, 0x303f) || c == 0x30a0 ||
        c == 0x30fb || in(c, 0x3200, 0x33ff) || in(c, 0xfe10, 0xfe19) || in(c, 0xfe30, 0xfe6b) ||
        in(c, 0xff01, 0xff0f) || in(c, 0xff1a, 0xff20) || in(c, 0xff3b, 0xff40) || in(c, 0xff5b, 0xff65) ||
        in(c, 0xffe0, 0xffee) || in(c, 0x1f000, 0x1faff))
        return Kind::punctuation;
    return Kind::letter;
}
bool digit(char32_t c)
{
    return (c >= '0' && c <= '9') || in(c, 0xff10, 0xff19);
}
} // namespace
WordCount count_words(std::string_view text)
{
    WordCount count;
    bool word = false;
    char32_t previous = 0, joiner = 0;
    for (size_t at = 0; at < text.size();)
    {
        // Decode one UTF-8 code point; malformed bytes count as one unit and move on.
        const auto lead = static_cast<unsigned char>(text[at]);
        const size_t size = lead < 0x80 ? 1 : lead >> 5 == 6 ? 2 : lead >> 4 == 14 ? 3 : lead >> 3 == 30 ? 4 : 1;
        char32_t c = size == 1 ? lead : lead & (0x7f >> size);
        for (size_t k = 1; k < size && at + k < text.size(); ++k)
            c = (c << 6) | (static_cast<unsigned char>(text[at + k]) & 0x3f);
        at += size;
        const auto kind = classify(c);
        if (kind == Kind::ignorable)
            continue;
        if (joiner)
        {
            // "don't", "well-known", "3.14" and "1,000" stay single words.
            const bool numeric = joiner == '.' || joiner == ',';
            if (kind == Kind::letter && (!numeric || (digit(previous) && digit(c))))
            {
                joiner = 0;
                previous = c;
                continue;
            }
            ++count.punctuation;
            joiner = 0;
            word = false;
        }
        if (kind == Kind::letter)
        {
            if (!word)
                ++count.words;
            word = true;
            previous = c;
            continue;
        }
        if (word && (c == '\'' || c == 0x2019 || c == '-' || c == 0x2010 || c == 0x2011 || c == '.' || c == ','))
        {
            joiner = c;
            continue;
        }
        word = false;
        if (kind == Kind::cjk)
            ++count.cjk;
        else if (kind == Kind::punctuation)
            ++count.punctuation;
    }
    if (joiner)
        ++count.punctuation;
    return count;
}
std::string reading_text(pugi::xml_node node)
{
    static const std::unordered_set<std::string> inline_elements = {
        "a",   "abbr", "b",      "bdi",  "bdo", "big", "cite", "code", "data",   "del",  "dfn",
        "em",  "font", "i",      "img",  "ins", "kbd", "mark", "q",    "rb",     "ruby", "s",
        "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr"};
    std::string out;
    std::function<void(pugi::xml_node)> visit = [&](pugi::xml_node n)
    {
        if (n.type() == pugi::node_pcdata || n.type() == pugi::node_cdata)
        {
            out += n.value();
            return;
        }
        if (n.type() != pugi::node_element && n.type() != pugi::node_document)
            return;
        const auto name = local_name(n);
        if (name == "script" || name == "style" || name == "head" || name == "rt" || name == "rp" || name == "template")
            return;
        for (auto child : n.children())
            visit(child);
        if (n.type() == pugi::node_element && !inline_elements.contains(name))
            out += '\n';
    };
    visit(node);
    return out;
}
} // namespace dr
