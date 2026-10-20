#include "dr/splitter.h"
#include "dr/paths.h"
#include <algorithm>
#include <functional>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <unordered_set>
namespace dr
{
std::string local_name(pugi::xml_node n)
{
    std::string s = n.name();
    auto p = s.find(':');
    return p == s.npos ? s : s.substr(p + 1);
}
pugi::xml_node child_named(pugi::xml_node n, const char *name)
{
    for (auto c : n.children())
        if (local_name(c) == name)
            return c;
    return {};
}
std::string xml_string(pugi::xml_node n)
{
    std::ostringstream s;
    n.print(s, "", pugi::format_raw, pugi::encoding_utf8);
    return s.str();
}
std::string node_text(pugi::xml_node n)
{
    std::string out;
    std::function<void(pugi::xml_node)> visit = [&](auto x)
    {
        if (x.type() == pugi::node_pcdata || x.type() == pugi::node_cdata)
            out += x.value();
        else if (local_name(x) != "script" && local_name(x) != "style")
        {
            for (auto c : x.children())
                visit(c);
            if (x.type() == pugi::node_element)
                out += '\n';
        }
    };
    visit(n);
    return out;
}
void sanitize_document(pugi::xml_node n)
{
    for (auto c = n.first_child(); c;)
    {
        auto next = c.next_sibling();
        auto tag = local_name(c);
        if (tag == "script" || tag == "iframe" || tag == "object" || tag == "embed" || tag == "base" ||
            tag == "form" || (tag == "meta" && c.attribute("http-equiv")))
            n.remove_child(c);
        else
        {
            for (auto a = c.first_attribute(); a;)
            {
                auto next_a = a.next_attribute();
                std::string name = a.name(), v = a.value();
                std::transform(name.begin(), name.end(), name.begin(),
                               [](unsigned char z) { return char(std::tolower(z)); });
                if (name.starts_with("on") || name == "srcdoc" ||
                    ((name == "href" || name == "src" || name == "xlink:href") && external_url(v) &&
                     !v.starts_with("data:image/")))
                    c.remove_attribute(a);
                a = next_a;
            }
            sanitize_document(c);
        }
        c = next;
    }
}
namespace
{
struct Unit
{
    pugi::xml_node node;
    size_t bytes;
    bool before = false, after = false;
};
bool visible(std::string_view s)
{
    return s.find_first_not_of(" \r\n\t") != s.npos;
}
bool forced(std::string s, const char *side)
{
    s.erase(std::remove_if(s.begin(), s.end(), [](unsigned char c) { return std::isspace(c) != 0; }),
            s.end());
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    for (auto value : {"always", "page", "left", "right"})
        if (s.find(std::string("break-") + side + ":" + value) != s.npos)
            return true;
    return false;
}
std::string strip(std::string s)
{
    auto a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
    return a == s.npos ? "" : s.substr(a, b - a + 1);
}
bool simple_match(pugi::xml_node n, const std::string &selector)
{
    if (n.type() != pugi::node_element || selector.empty() ||
        selector.find_first_of(":[>+~") != selector.npos)
        return false;
    size_t pos = selector.find_first_of(".#");
    auto tag = selector.substr(0, pos);
    if (!tag.empty() && tag != "*" && tag != local_name(n))
        return false;
    while (pos != selector.npos)
    {
        auto next = selector.find_first_of(".#", pos + 1);
        auto value = selector.substr(pos + 1, next == selector.npos ? selector.npos : next - pos - 1);
        if (selector[pos] == '#')
        {
            if (value != n.attribute("id").value())
                return false;
        }
        else
        {
            std::istringstream names(n.attribute("class").value());
            std::string name;
            bool has = false;
            while (names >> name)
                has |= name == value;
            if (!has)
                return false;
        }
        pos = next;
    }
    return true;
}
bool selector_match(pugi::xml_node n, const std::string &selector)
{
    std::istringstream in(selector);
    std::vector<std::string> tokens;
    std::string word;
    while (in >> word)
        tokens.push_back(word);
    if (tokens.empty() || !simple_match(n, tokens.back()))
        return false;
    for (size_t i = tokens.size() - 1; i > 0; --i)
    {
        n = n.parent();
        while (n && !simple_match(n, tokens[i - 1]))
            n = n.parent();
        if (!n)
            return false;
    }
    return true;
}
struct BreakRule
{
    std::string selector;
    bool before, after;
};
std::vector<BreakRule> break_rules(std::string css)
{
    std::vector<BreakRule> out;
    css = std::regex_replace(css, std::regex(R"(/\*[\s\S]*?\*/)"), "");
    const std::regex rule(R"(([^{}]+)\{([^{}]*)\})");
    for (std::sregex_iterator it(css.begin(), css.end(), rule), end; it != end; ++it)
    {
        auto declarations = (*it)[2].str();
        bool before = forced(declarations, "before"), after = forced(declarations, "after");
        if (!before && !after)
            continue;
        std::istringstream selectors((*it)[1].str());
        std::string selector;
        while (std::getline(selectors, selector, ','))
            out.push_back({strip(selector), before, after});
    }
    return out;
}
} // namespace
SplitResult split_xhtml(const std::string &path, const std::string &markup, const SplitOptions &opts)
{
    pugi::xml_document doc;
    auto parsed = doc.load_buffer(markup.data(), markup.size(), pugi::parse_default | pugi::parse_ws_pcdata);
    if (!parsed)
        throw std::runtime_error("XHTML 解析失败: " + path + " (" + parsed.description() + ")");
    auto html = doc.document_element(), body = child_named(html, "body");
    if (!body)
        throw std::runtime_error("XHTML 缺少 body: " + path);
    sanitize_document(doc);
    std::string css = opts.stylesheet;
    std::function<void(pugi::xml_node)> collect_css = [&](auto n)
    {
        if (local_name(n) == "style")
            for (auto text : n.children())
                css += text.value();
        for (auto c : n.children())
            collect_css(c);
    };
    collect_css(doc);
    auto rules = break_rules(css);
    std::vector<Unit> units;
    using Range = std::pair<size_t, size_t>;
    std::unordered_map<size_t, Range> ranges;
    std::function<void(pugi::xml_node)> gather = [&](auto n)
    {
        size_t start = units.size();
        auto tag = local_name(n);
        bool atom = tag == "p" || tag == "pre" || tag == "table" || tag == "svg" || tag == "math" ||
                    tag == "figure" || tag == "h1" || tag == "h2" || tag == "h3" || tag == "h4" ||
                    tag == "h5" || tag == "h6";
        if (n.type() == pugi::node_pcdata || n.type() == pugi::node_cdata)
        {
            if (visible(n.value()))
                units.push_back({n, std::string(n.value()).size()});
        }
        else if (atom || !n.first_child())
            units.push_back({n, xml_string(n).size()});
        else
            for (auto c : n.children())
                gather(c);
        size_t end = units.size();
        ranges[n.hash_value()] = {start, end};
        if (start < end && n != body)
        {
            auto style = std::string(n.attribute("style").value());
            units[start].before |= forced(style, "before");
            units[end - 1].after |= forced(style, "after");
            for (auto &rule : rules)
                if (selector_match(n, rule.selector))
                {
                    units[start].before |= rule.before;
                    units[end - 1].after |= rule.after;
                }
        }
    };
    gather(body);
    SplitResult result;
    std::vector<Range> parts;
    size_t start = 0, bytes = 0;
    for (size_t i = 0; i < units.size(); ++i)
    {
        bool page = opts.page_breaks && units[i].before;
        bool heading = local_name(units[i].node).starts_with('h') && local_name(units[i].node).size() == 2;
        if (i > start && (page || (opts.max_bytes && bytes + units[i].bytes > opts.max_bytes) ||
                          (heading && opts.max_bytes && bytes > opts.max_bytes * 3 / 4)))
        {
            parts.emplace_back(start, i);
            start = i;
            bytes = 0;
        }
        bytes += units[i].bytes;
        if (opts.max_bytes && units[i].bytes > opts.max_bytes)
            result.warnings.push_back("不可拆分的大块内容保留原样: " + path);
        if (opts.page_breaks && units[i].after && i + 1 < units.size())
        {
            parts.emplace_back(start, i + 1);
            start = i + 1;
            bytes = 0;
        }
    }
    if (start < units.size() || parts.empty())
        parts.emplace_back(start, units.size());
    std::unordered_set<std::string> owned;
    for (size_t k = 0; k < parts.size(); ++k)
    {
        pugi::xml_document out;
        auto root = out.append_child(html.name());
        for (auto attr : html.attributes())
            root.append_attribute(attr.name()).set_value(attr.value());
        pugi::xml_node target;
        for (auto node : html.children())
        {
            if (node == body)
            {
                target = root.append_child(body.name());
                for (auto attr : body.attributes())
                    target.append_attribute(attr.name()).set_value(attr.value());
            }
            else
                root.append_copy(node);
        }
        auto [begin, end] = parts[k];
        std::function<void(pugi::xml_node, pugi::xml_node)> copy = [&](auto from, auto to)
        {
            auto found = ranges.find(from.hash_value());
            if (found == ranges.end())
                return;
            auto [a, b] = found->second;
            if (a == b && from.type() == pugi::node_pcdata && a >= begin && a < end)
            {
                to.append_copy(from);
                return;
            }
            if (b <= begin || a >= end)
                return;
            if (a >= begin && b <= end)
            {
                to.append_copy(from);
                return;
            }
            auto clone = to.append_child(from.name());
            for (auto attr : from.attributes())
                clone.append_attribute(attr.name()).set_value(attr.value());
            for (auto c : from.children())
                copy(c, clone);
        };
        for (auto c : body.children())
            copy(c, target);
        auto file = parts.size() == 1
                        ? path
                        : utf8(path8(path).parent_path() /
                               path8(utf8(path8(path).stem()) + ".dr-" + std::to_string(k) + ".xhtml"));
        std::function<void(pugi::xml_node)> anchors = [&](auto n)
        {
            for (const char *key : {"id", "name"})
                if (auto attr = n.attribute(key))
                {
                    std::string id = attr.value();
                    if (!id.empty())
                    {
                        if (owned.insert(id).second)
                            result.anchors[id] = file;
                        else
                            n.remove_attribute(attr);
                    }
                }
            for (auto c : n.children())
                anchors(c);
        };
        anchors(target);
        auto head = child_named(root, "head");
        if (!head)
            head = root.prepend_child("head");
        auto meta = head.prepend_child("meta");
        meta.append_attribute("http-equiv") = "Content-Security-Policy";
        meta.append_attribute("content") =
            "default-src https://books.dr-reader.local data: blob:; script-src 'none'; style-src "
            "https://books.dr-reader.local 'unsafe-inline'; object-src 'none'; connect-src 'none'; frame-src "
            "'none'; form-action 'none'";
        std::string title;
        std::function<void(pugi::xml_node)> find_heading = [&](auto n)
        {
            auto tag = local_name(n);
            if (title.empty() && (tag == "h1" || tag == "h2" || tag == "h3"))
                title = node_text(n);
            for (auto c : n.children())
                find_heading(c);
        };
        find_heading(target);
        result.flows.push_back({file, xml_string(out), title, node_text(target)});
    }
    result.anchors[""] = result.flows.front().path;
    return result;
}
} // namespace dr
