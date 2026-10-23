#include "dr/epub.h"
#include "dr/splitter.h"
#include <algorithm>
#include <cctype>
#include <functional>
#include <memory>
#include <regex>
#include <miniz.h>
#include <set>
#include <stdexcept>
namespace dr
{
namespace
{
struct Zip
{
    mz_zip_archive zip{};
    ~Zip()
    {
        mz_zip_reader_end(&zip);
    }
};
void extract(const fs::path &archive, const fs::path &dest, const ImportLimits &limits)
{
    // Initialize through a FILE handle so Windows Unicode filenames work.
#ifdef _WIN32
    FILE *raw = nullptr;
    _wfopen_s(&raw, archive.c_str(), L"rb");
#else
    FILE *raw = std::fopen(archive.c_str(), "rb");
#endif
    if (!raw)
        throw std::runtime_error("无法打开 EPUB");
    std::unique_ptr<FILE, decltype(&std::fclose)> handle(raw, &std::fclose);
    Zip reader;
    if (!mz_zip_reader_init_cfile(&reader.zip, handle.get(), 0, 0))
        throw std::runtime_error("无效的 ZIP / EPUB 文件");
    auto count = mz_zip_reader_get_num_files(&reader.zip);
    if (count > limits.max_entries)
        throw std::runtime_error("EPUB 文件数量超限");
    uint64_t total = 0;
    std::set<std::string> names;
    for (mz_uint i = 0; i < count; ++i)
    {
        mz_zip_archive_file_stat info{};
        if (!mz_zip_reader_file_stat(&reader.zip, i, &info))
            throw std::runtime_error("无法读取 ZIP 目录");
        auto length = mz_zip_reader_get_filename(&reader.zip, i, nullptr, 0);
        std::string name(length, '\0');
        mz_zip_reader_get_filename(&reader.zip, i, name.data(), length);
        if (!name.empty())
            name.pop_back();
        if (name.empty() || name.find('\0') != name.npos || name.find('\\') != name.npos ||
            name.find(':') != name.npos || name.starts_with('/'))
            throw std::runtime_error("不安全的 ZIP 路径");
        auto p = path8(name).lexically_normal();
        auto safe = utf8(p);
        if (safe == ".." || safe.starts_with("../") || p.is_absolute())
            throw std::runtime_error("ZIP 路径越界");
        // Windows aliases and case-insensitive collisions must not overwrite entries.
        std::string canonical = safe;
        std::transform(canonical.begin(), canonical.end(), canonical.begin(),
                       [](unsigned char c) { return char(std::tolower(c)); });
        for (auto &component : p)
        {
            auto piece = utf8(component);
            auto stem = piece.substr(0, piece.find('.'));
            std::transform(stem.begin(), stem.end(), stem.begin(),
                           [](unsigned char c) { return char(std::toupper(c)); });
            if (piece.ends_with('.') || piece.ends_with(' ') || stem == "CON" || stem == "PRN" ||
                stem == "AUX" || stem == "NUL" ||
                (stem.size() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem[3] >= '1' &&
                 stem[3] <= '9'))
                throw std::runtime_error("EPUB 含 Windows 非法文件名");
        }
        if (info.m_is_directory)
        {
            fs::create_directories(dest / p);
            continue;
        }
        if (!names.insert(canonical).second)
            throw std::runtime_error("EPUB 内存在重复文件路径");
        if (info.m_is_encrypted)
            throw std::runtime_error("不支持加密 ZIP");
        if (info.m_uncomp_size > limits.max_entry_bytes ||
            info.m_uncomp_size > limits.max_total_bytes - total)
            throw std::runtime_error("EPUB 解包大小超限");
        total += info.m_uncomp_size;
        size_t bytes = 0;
        void *memory = mz_zip_reader_extract_to_heap(&reader.zip, i, &bytes, 0);
        if (!memory)
            throw std::runtime_error("EPUB 解压失败 / CRC 校验失败");
        std::unique_ptr<void, decltype(&mz_free)> data(memory, &mz_free);
        write_file(dest / p, std::string_view(static_cast<const char *>(memory), bytes));
    }
}
// NCX labels are plain text. Some publishers leave literal '<' markers and bad UTF-8
// in them; repair only label contents, keeping structural XML and URI attributes strict.
std::string repair_ncx_labels(const std::string &source)
{
    static const std::regex label(R"(<((?:[A-Za-z_][A-Za-z0-9_.-]*:)?text)(?:\s[^<>]*?)?>([\s\S]*?)</\1\s*>)");
    const auto name_start = [](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == ':' || c >= 0x80;
    };
    std::string result;
    size_t copied = 0;
    for (std::sregex_iterator it(source.begin(), source.end(), label), end; it != end; ++it)
    {
        const auto &match = *it;
        const size_t start = static_cast<size_t>(match.position(2));
        result.append(source, copied, start - copied);
        // Replacement characters keep damaged bytes visible instead of silently dropping text.
        const auto text = Json::parse(Json(match.str(2)).dump(-1, ' ', false, Json::error_handler_t::replace)).get<std::string>();
        for (size_t i = 0; i < text.size(); ++i)
        {
            if (text.compare(i, 9, "<![CDATA[") == 0 || text.compare(i, 4, "<!--") == 0)
            {
                const bool cdata = text.compare(i, 9, "<![CDATA[") == 0;
                const auto close = text.find(cdata ? "]]>" : "-->", i + (cdata ? 9 : 4));
                if (close != text.npos)
                {
                    result.append(text, i, close + 3 - i);
                    i = close + 2;
                    continue;
                }
            }
            if (text[i] == '<')
            {
                const size_t next = i + 1 + (i + 1 < text.size() && text[i + 1] == '/' ? 1 : 0);
                if (next >= text.size() || (!name_start(static_cast<unsigned char>(text[next])) &&
                    text[next] != '!' && text[next] != '?'))
                {
                    result += "&lt;";
                    continue;
                }
            }
            result += text[i];
        }
        copied = start + static_cast<size_t>(match.length(2));
    }
    result.append(source, copied, source.size() - copied);
    return result;
}
pugi::xml_document parse(const fs::path &p, bool ncx_labels = false)
{
    pugi::xml_document d;
    auto s = xml_compatible_entities(read_file(p));
    if (ncx_labels) s = repair_ncx_labels(s);
    auto r = d.load_buffer(s.data(), s.size());
    if (!r)
    {
        const auto offset = std::min(static_cast<size_t>(std::max<ptrdiff_t>(0, r.offset)), s.size());
        const auto line = 1 + std::count(s.begin(), s.begin() + offset, '\n');
        throw std::runtime_error("XML 解析失败: " + utf8(p) + "（第 " + std::to_string(line) +
            " 行，" + r.description() + "）");
    }
    return d;
}
void visit(pugi::xml_node n, const std::function<void(pugi::xml_node)> &fn)
{
    fn(n);
    for (auto c : n.children())
        visit(c, fn);
}
struct Item
{
    std::string path, type, properties;
};
std::string trim(std::string s)
{
    auto a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
    return a == s.npos ? "" : s.substr(a, b - a + 1);
}
std::string opf_path(const fs::path &content)
{
    auto container = parse(content / "META-INF" / "container.xml");
    std::string opf;
    visit(container,
          [&](auto n)
          {
              if (opf.empty() && local_name(n) == "rootfile")
                  opf = n.attribute("full-path").value();
          });
    if (opf.empty())
        throw std::runtime_error("container.xml 中没有 OPF");
    return resolve_href("", opf);
}
// Collapses runs of whitespace, including no-break and ideographic spaces, like calibre's
// normalize_whitespace.
std::string collapse_spaces(const std::string &text)
{
    std::string out;
    for (size_t i = 0; i < text.size(); ++i)
    {
        const char c = text[i];
        size_t extra = text.compare(i, 2, "\xC2\xA0") == 0 ? 1 : text.compare(i, 3, "\xE3\x80\x80") == 0 ? 2 : 0;
        const bool space = extra || c == ' ' || c == '\t' || c == '\r' || c == '\n';
        i += extra;
        if (!space)
            out += c;
        else if (!out.empty() && out.back() != ' ')
            out += ' ';
    }
    return trim(out);
}
// Descriptions are often escaped HTML. Keep paragraph breaks and drop the markup.
std::string description_text(const std::string &source)
{
    std::string text;
    for (size_t at = 0; at < source.size(); ++at)
    {
        const auto next = at + 1 < source.size() ? static_cast<unsigned char>(source[at + 1]) : 0;
        if (source[at] != '<' || !(std::isalpha(next) || next == '/' || next == '!'))
        {
            text += source[at];
            continue;
        }
        const auto close = source.find('>', at);
        if (close == source.npos)
        {
            text.append(source, at);
            break;
        }
        std::string tag = source.substr(at + 1, close - at - 1);
        if (!tag.empty() && tag[0] == '/')
            tag.erase(0, 1);
        tag = tag.substr(0, tag.find_first_of(" \t\r\n/"));
        std::transform(tag.begin(), tag.end(), tag.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        if (tag == "br" || tag == "p" || tag == "div" || tag == "li" || tag == "tr" ||
            (tag.size() == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6'))
            text += '\n';
        at = close;
    }
    // Decode the inner HTML's entities with the same HTML5 table used for chapters.
    pugi::xml_document decoded;
    const auto wrapped = "<d>" + xml_compatible_entities(text) + "</d>";
    if (decoded.load_buffer(wrapped.data(), wrapped.size()))
        text = decoded.document_element().text().get();
    std::string out;
    size_t start = 0;
    while (start <= text.size())
    {
        auto end = text.find('\n', start);
        if (end == text.npos)
            end = text.size();
        const auto line = collapse_spaces(text.substr(start, end - start));
        if (!line.empty())
            out += (out.empty() ? "" : "\n") + line;
        start = end + 1;
    }
    return out;
}
} // namespace
Json import_epub(const fs::path &archive, const fs::path &dest, const ImportLimits &limits)
{
    auto content = dest / "content";
    fs::create_directories(content);
    extract(archive, content, limits);
    if (fs::exists(content / "META-INF" / "encryption.xml"))
    {
        auto encryption = parse(content / "META-INF" / "encryption.xml");
        bool drm = false;
        visit(encryption,
              [&](auto n)
              {
                  if (local_name(n) == "EncryptionMethod")
                  {
                      std::string a = n.attribute("Algorithm").value();
                      if (a != "http://www.idpf.org/2008/embedding" && a != "http://ns.adobe.com/pdf/enc#RC")
                          drm = true;
                  }
              });
        if (drm)
            throw std::runtime_error("这本书受 DRM 保护，初版仅支持无 DRM EPUB");
    }
    const auto opf = opf_path(content);
    auto package = parse(content / path8(opf));
    auto root = package.document_element();
    Json book = {{"title", utf8(archive.stem())},
                 {"author", "未知作者"},
                 {"language", ""},
                 {"publisher", ""},
                 {"cover", ""},
                 {"chapters", Json::array()},
                 {"toc", Json::array()},
                 {"warnings", Json::array()},
                 {"progress", 0.0},
                 {"position", Json::object()},
                 {"bookmarks", Json::array()},
                 {"subjects", Json::array()}};
    auto metadata = child_named(root, "metadata");
    std::string cover_id;
    for (auto n : metadata.children())
    {
        auto name = local_name(n), text = trim(node_text(n));
        if (name == "title" && !text.empty())
            book["title"] = text;
        else if (name == "creator" && !text.empty())
            book["author"] = text;
        else if (name == "language")
            book["language"] = text;
        else if (name == "publisher")
            book["publisher"] = text;
        else if (name == "subject")
            book["subjects"].push_back(text);
        else if (name == "meta" && std::string(n.attribute("name").value()) == "cover")
            cover_id = n.attribute("content").value();
    }
    std::unordered_map<std::string, Item> manifest;
    std::string nav_path, ncx_path;
    for (auto n : child_named(root, "manifest").children())
    {
        std::string id = n.attribute("id").value();
        Item item{resolve_href(opf, n.attribute("href").value()), n.attribute("media-type").value(),
                  n.attribute("properties").value()};
        manifest[id] = item;
        if (item.properties.find("nav") != item.properties.npos)
            nav_path = item.path;
        if (item.type == "application/x-dtbncx+xml")
            ncx_path = item.path;
        if (id == cover_id || item.properties.find("cover-image") != item.properties.npos)
            book["cover"] = item.path;
    }
    struct Processed
    {
        std::string original;
        SplitResult split;
    };
    std::vector<Processed> processed;
    std::unordered_map<std::string, std::unordered_map<std::string, std::string>> mappings;
    auto spine = child_named(root, "spine");
    book["direction"] = std::string(spine.attribute("page-progression-direction").value());
    for (auto ref : spine.children())
    {
        auto found = manifest.find(ref.attribute("idref").value());
        if (found == manifest.end())
            throw std::runtime_error("spine 引用了不存在的章节");
        auto &item = found->second;
        if (std::string(ref.attribute("linear").value()) == "no")
            continue;
        if (item.type != "application/xhtml+xml" && item.type != "text/html")
            continue;
        auto markup = xml_compatible_entities(read_file(content / path8(item.path)));
        SplitOptions options;
        pugi::xml_document source_doc;
        source_doc.load_string(markup.c_str());
        visit(source_doc,
              [&](auto n)
              {
                  if (local_name(n) == "link")
                  {
                      std::string rel = n.attribute("rel").value(), href = n.attribute("href").value();
                      if (rel == "stylesheet" && !href.empty() && !external_url(href))
                      {
                          auto path = resolve_href(item.path, href);
                          if (fs::exists(content / path8(path)))
                              options.stylesheet += read_file(content / path8(path)) + "\n";
                      }
                  }
              });
        auto split = split_xhtml(item.path, markup, options);
        mappings[item.path] = split.anchors;
        for (auto &w : split.warnings)
            book["warnings"].push_back(w);
        processed.push_back({item.path, std::move(split)});
    }
    auto remap = [&](const std::string &base, const std::string &href)
    {
        if (external_url(href))
            return href;
        auto file = resolve_href(base, href);
        auto hash = href.find('#');
        auto anchor = hash == href.npos ? "" : url_decode(href.substr(hash + 1));
        auto found = mappings.find(file);
        if (found != mappings.end())
        {
            auto it = found->second.find(anchor);
            file = it != found->second.end() ? it->second : found->second.at("");
        }
        return file + (anchor.empty() ? "" : "#" + url_encode(anchor));
    };
    for (auto &entry : processed)
        for (auto &flow : entry.split.flows)
        {
            pugi::xml_document doc;
            doc.load_string(flow.html.c_str());
            visit(doc,
                  [&](auto n)
                  {
                      if (local_name(n) == "a")
                          if (auto href = n.attribute("href"))
                          {
                              std::string old = href.value();
                              if (!external_url(old))
                              {
                                  auto target = remap(entry.original, old);
                                  auto hash = target.find('#');
                                  auto file = target.substr(0, hash);
                                  auto rel =
                                      utf8(path8(file).lexically_relative(path8(flow.path).parent_path()));
                                  href.set_value(
                                      (url_encode(rel) + (hash == target.npos ? "" : target.substr(hash)))
                                          .c_str());
                              }
                          }
                  });
            write_file(content / path8(flow.path), html_compatible(xml_string(doc)));
            auto index = book["chapters"].size();
            std::string title = trim(flow.title);
            if (title.empty())
                title = "第 " + std::to_string(index + 1) + " 节";
            book["chapters"].push_back({{"title", title},
                                        {"href", flow.path},
                                        {"source", entry.original},
                                        {"bytes", flow.html.size()}});
            write_file(dest / "search" / (std::to_string(index) + ".txt"), flow.text);
        }
    if (book["chapters"].empty())
        throw std::runtime_error("EPUB 没有可阅读的 XHTML 章节");
    if (!nav_path.empty())
    {
        auto nav = parse(content / path8(nav_path));
        pugi::xml_node toc;
        visit(nav,
              [&](auto n)
              {
                  if (local_name(n) == "nav")
                  {
                      std::string kind = n.attribute("epub:type").value();
                      if (!toc || kind.find("toc") != kind.npos)
                          toc = n;
                  }
              });
        std::function<void(pugi::xml_node, int)> collect = [&](auto n, int depth)
        {
            if (local_name(n) == "a" && n.attribute("href"))
            {
                auto href = std::string(n.attribute("href").value());
                if (!external_url(href))
                    book["toc"].push_back({{"title", trim(node_text(n))},
                                           {"href", remap(nav_path, href)},
                                           {"depth", std::max(0, depth - 1)}});
            }
            for (auto c : n.children())
                collect(c, depth + (local_name(c) == "ol" ? 1 : 0));
        };
        if (toc)
            collect(toc, 0);
    }
    if (book["toc"].empty() && !ncx_path.empty())
    {
        auto ncx = parse(content / path8(ncx_path), true);
        std::function<void(pugi::xml_node, int)> collect = [&](auto n, int depth)
        {
            if (local_name(n) == "navPoint")
            {
                auto src = child_named(n, "content").attribute("src").value();
                if (*src && !external_url(src))
                    book["toc"].push_back({{"title", trim(node_text(child_named(n, "navLabel")))},
                                           {"href", remap(ncx_path, src)},
                                           {"depth", depth}});
                ++depth;
            }
            for (auto c : n.children())
                collect(c, depth);
        };
        collect(ncx, 0);
    }
    if (book["toc"].empty())
        for (auto &c : book["chapters"])
            book["toc"].push_back({{"title", c["title"]}, {"href", c["href"]}, {"depth", 0}});
    // Sanitize non-spine HTML too; all publication documents remain script-free.
    for (auto &[id, item] : manifest)
        if (!mappings.contains(item.path) &&
            (item.type == "application/xhtml+xml" || item.type == "text/html"))
        {
            try
            {
                auto doc = parse(content / path8(item.path));
                sanitize_document(doc);
                write_file(content / path8(item.path), html_compatible(xml_string(doc)));
            }
            catch (const std::exception &)
            {
                book["warnings"].push_back("未能处理附属文档: " + item.path);
            }
        }
    book["format"] = "EPUB";
    book["fileBytes"] = fs::file_size(archive);
    return book;
}
// Mirrors the reading order of calibre's src/calibre/ebooks/metadata/opf3.py (read_title,
// read_authors, read_series, read_pubdate, read_identifiers, read_tags, read_comments): EPUB 3
// refinements first, OPF 2 attributes and calibre:series meta as fallbacks. Independently written.
Json read_opf_metadata(const fs::path &content)
{
    const auto package = parse(content / path8(opf_path(content)));
    const auto lower = [](std::string text) {
        std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        return text;
    };
    // Matches opf:role, opf:scheme and opf:file-as whatever prefix the publisher bound.
    const auto attribute = [](pugi::xml_node node, std::string_view name) {
        for (auto a : node.attributes())
        {
            std::string_view key = a.name();
            if (key.substr(key.find(':') == key.npos ? 0 : key.find(':') + 1) == name)
                return std::string(a.value());
        }
        return std::string();
    };
    // OPF 1 nests Dublin Core entries in dc-metadata and x-metadata.
    std::vector<pugi::xml_node> entries;
    for (auto n : child_named(package.document_element(), "metadata").children())
    {
        const auto name = local_name(n);
        if (name == "dc-metadata" || name == "x-metadata")
            for (auto c : n.children())
                entries.push_back(c);
        else
            entries.push_back(n);
    }
    std::unordered_map<std::string, std::vector<std::pair<std::string, std::string>>> refines;
    for (auto n : entries)
    {
        const std::string target = n.attribute("refines").value();
        if (local_name(n) == "meta" && target.starts_with('#'))
            refines[target.substr(1)].emplace_back(n.attribute("property").value(), collapse_spaces(node_text(n)));
    }
    const auto properties = [&](pugi::xml_node n, std::string_view name) {
        std::vector<std::string> values;
        const auto found = refines.find(n.attribute("id").value());
        if (found != refines.end())
            for (const auto &[key, value] : found->second)
                if (key == name && !value.empty())
                    values.push_back(value);
        return values;
    };
    const auto first_property = [&](pugi::xml_node n, std::string_view name) {
        const auto values = properties(n, name);
        return values.empty() ? std::string() : values.front();
    };
    const auto unique_push = [](Json &list, const Json &value) {
        if (std::find(list.begin(), list.end(), value) == list.end())
            list.push_back(value);
    };

    Json result = {{"title", ""},          {"subtitle", ""},  {"authors", Json::array()},
                   {"contributors", Json::array()}, {"series", ""}, {"publisher", ""},
                   {"published", ""},      {"languages", Json::array()}, {"subjects", Json::array()},
                   {"identifiers", Json::array()},  {"description", ""}};
    struct Person
    {
        std::string name;
        int seq;
    };
    std::vector<Person> roled, unroled, editors;
    std::vector<std::pair<std::string, std::string>> contributors;
    pugi::xml_node first_title, main_title, subtitle;
    std::string description, series, series_index, publication_date, other_date;
    for (auto n : entries)
    {
        const auto name = local_name(n);
        const auto text = collapse_spaces(node_text(n));
        if (name == "title" && !text.empty())
        {
            const auto type = lower(first_property(n, "title-type"));
            if (!first_title)
                first_title = n;
            if (type == "main" && !main_title)
                main_title = n;
            else if (type == "subtitle" && !subtitle)
                subtitle = n;
        }
        else if ((name == "creator" || name == "contributor") && !text.empty())
        {
            auto roles = properties(n, "role");
            for (auto &role : roles)
                role = lower(role);
            const auto opf_role = lower(attribute(n, "role"));
            int seq = 0;
            try
            {
                seq = std::stoi(first_property(n, "display-seq"));
            }
            catch (const std::exception &)
            {
            }
            const auto has = [&](const char *role) {
                return roles.empty() ? opf_role == role : std::find(roles.begin(), roles.end(), role) != roles.end();
            };
            if (name == "creator" && has("aut"))
                roled.push_back({text, seq});
            else if (name == "creator" && roles.empty() && opf_role.empty())
                unroled.push_back({text, seq});
            if (name == "creator" && has("edt"))
                editors.push_back({text, seq});
            for (const char *role : {"trl", "edt", "ill"})
                if (has(role))
                    contributors.emplace_back(text, role);
        }
        else if (name == "publisher" && !text.empty() && result["publisher"] == "")
            result["publisher"] = text;
        else if (name == "date" && !text.empty())
        {
            const auto event = lower(attribute(n, "event"));
            if (event == "publication" && publication_date.empty())
                publication_date = text;
            else if (event != "modification" && event != "creation" && other_date.empty())
                other_date = text;
        }
        else if (name == "language" && !text.empty() && lower(text) != "und")
            unique_push(result["languages"], text);
        else if (name == "subject")
        {
            for (size_t start = 0; start <= text.size();)
            {
                auto end = std::min(text.find(',', start), text.size());
                const auto tag = collapse_spaces(text.substr(start, end - start));
                if (!tag.empty())
                    unique_push(result["subjects"], tag);
                start = end + 1;
            }
        }
        else if (name == "description" && !text.empty())
            description += (description.empty() ? "" : "\n") + node_text(n);
        else if (name == "identifier" && !text.empty())
        {
            std::string scheme = attribute(n, "scheme"), value = text;
            bool from_value = false;
            if (scheme.empty() || lower(value).starts_with("urn:"))
            {
                if (lower(value).starts_with("urn:"))
                    value.erase(0, 4);
                const auto colon = value.find(':');
                scheme = colon == value.npos ? "" : value.substr(0, colon);
                value = colon == value.npos ? "" : value.substr(colon + 1);
                from_value = true;
            }
            scheme = lower(scheme);
            if (scheme == "http" || scheme == "https")
            {
                if (!from_value)
                    continue;
                value = scheme + ":" + value;
                scheme = "url";
            }
            if (scheme.starts_with("isbn"))
            {
                scheme = "isbn";
                value = value.substr(value.rfind(':') == value.npos ? 0 : value.rfind(':') + 1);
                std::string digits;
                for (char c : value)
                    if (std::isdigit(static_cast<unsigned char>(c)) || c == 'X' || c == 'x')
                        digits += char(std::toupper(static_cast<unsigned char>(c)));
                // Reject malformed numbers with the ISBN-10 / ISBN-13 check digits.
                int sum = 0;
                bool valid = digits.size() == 10 || digits.size() == 13;
                for (size_t i = 0; valid && i < digits.size(); ++i)
                {
                    const bool x = digits[i] == 'X';
                    if (x && (digits.size() != 10 || i != 9))
                        valid = false;
                    const int d = x ? 10 : digits[i] - '0';
                    sum += digits.size() == 10 ? d * int(10 - i) : d * (i % 2 ? 3 : 1);
                }
                value = valid && sum % (digits.size() == 10 ? 11 : 10) == 0 ? digits : "";
            }
            // calibre and uuid identifiers only tie the file to a library.
            if (!scheme.empty() && !value.empty() && scheme != "uuid" && scheme != "calibre")
                unique_push(result["identifiers"], {{"scheme", scheme}, {"value", value}});
        }
        else if (name == "meta")
        {
            const std::string property = n.attribute("property").value(), key = n.attribute("name").value();
            if (property == "belongs-to-collection" && !text.empty() && series.empty() &&
                lower(first_property(n, "collection-type")) == "series")
            {
                series = text;
                series_index = first_property(n, "group-position");
            }
            else if (key == "calibre:series" && result["series"] == "")
                result["series"] = collapse_spaces(n.attribute("content").value());
            else if (key == "calibre:series_index" && result.value("seriesIndex", Json()).is_null())
                result["seriesIndex"] = n.attribute("content").value();
        }
    }
    const auto title = main_title ? main_title : first_title;
    if (title)
        result["title"] = collapse_spaces(node_text(title));
    if (subtitle && subtitle != title)
        result["subtitle"] = collapse_spaces(node_text(subtitle));
    auto &authors = !roled.empty() ? roled : !unroled.empty() ? unroled : editors;
    std::stable_sort(authors.begin(), authors.end(), [](auto &a, auto &b) { return a.seq < b.seq; });
    for (const auto &person : authors)
        unique_push(result["authors"], person.name);
    for (const auto &[person, role] : contributors)
        if (std::find(result["authors"].begin(), result["authors"].end(), person) == result["authors"].end())
            unique_push(result["contributors"], {{"name", person}, {"role", role}});
    if (!series.empty())
    {
        result["series"] = series;
        result["seriesIndex"] = series_index;
    }
    // A bare series index without a name carries no information.
    if (result["series"] == "")
        result.erase("seriesIndex");
    else if (result.contains("seriesIndex"))
    {
        try
        {
            result["seriesIndex"] = std::stod(result["seriesIndex"].get<std::string>());
        }
        catch (const std::exception &)
        {
            result["seriesIndex"] = 1.0;
        }
    }
    // Keep the calendar date; calibre treats years up to 101 as undefined.
    auto date = publication_date.empty() ? other_date : publication_date;
    std::smatch match;
    if (std::regex_search(date, match, std::regex(R"(^(\d{4})(-\d{1,2}(-\d{1,2})?)?)")))
        date = std::stoi(match[1]) > 101 ? match.str(0) : "";
    result["published"] = date;
    result["description"] = description_text(description);
    return result;
}
} // namespace dr
