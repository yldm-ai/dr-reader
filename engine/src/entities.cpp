#include "dr/splitter.h"
#include <algorithm>
#include <iterator>
#include <string_view>
#include <utility>

namespace dr
{
namespace
{
constexpr std::pair<std::string_view, std::string_view> entities[] = {
#include "html-entities.inc"
};
bool name_char(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
}

// Strategy reference: calibre's oeb/parse_utils.py and xml_replace_entities().
// Independently normalize named HTML entities before XML parsing. Numeric references
// keep XML delimiters escaped and ensure text such as &amp;nbsp; is decoded only once.
std::string xml_compatible_entities(const std::string &markup)
{
    std::string output;
    output.reserve(markup.size());
    for (size_t i = 0; i < markup.size();)
    {
        std::string_view terminator;
        if (markup.compare(i, 9, "<![CDATA[") == 0) terminator = "]]>";
        else if (markup.compare(i, 4, "<!--") == 0) terminator = "-->";
        else if (markup.compare(i, 2, "<?") == 0) terminator = "?>";
        if (!terminator.empty())
        {
            const auto end = markup.find(terminator, i + 2);
            const auto length = end == markup.npos ? markup.size() - i : end + terminator.size() - i;
            output.append(markup, i, length);
            i += length;
            continue;
        }
        if (markup.compare(i, 9, "<!DOCTYPE") == 0)
        {
            size_t end = i + 9;
            int subset = 0;
            char quote = 0;
            for (; end < markup.size(); ++end)
            {
                const char c = markup[end];
                if (quote) { if (c == quote) quote = 0; }
                else if (c == '\'' || c == '"') quote = c;
                else if (c == '[') ++subset;
                else if (c == ']') --subset;
                else if (c == '>' && !subset) { ++end; break; }
            }
            output.append(markup, i, end - i);
            i = end;
            continue;
        }
        if (markup[i] == '&')
        {
            size_t end = i + 1;
            while (end < markup.size() && end - i <= 32 && name_char(markup[end])) ++end;
            if (end < markup.size() && markup[end] == ';')
            {
                const auto name = std::string_view(markup).substr(i + 1, end - i - 1);
                const auto found = std::lower_bound(std::begin(entities), std::end(entities), name,
                    [](const auto &entry, std::string_view value) { return entry.first < value; });
                if (found != std::end(entities) && found->first == name)
                {
                    output += found->second;
                    i = end + 1;
                    continue;
                }
            }
        }
        output += markup[i++];
    }
    return output;
}
} // namespace dr
