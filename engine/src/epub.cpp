#include "dr/epub.h"
#include "dr/splitter.h"
#include <algorithm>
#include <functional>
#include <memory>
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
pugi::xml_document parse(const fs::path &p)
{
    pugi::xml_document d;
    auto s = read_file(p);
    auto r = d.load_buffer(s.data(), s.size());
    if (!r)
        throw std::runtime_error("XML 解析失败: " + utf8(p));
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
    opf = resolve_href("", opf);
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
        auto markup = read_file(content / path8(item.path));
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
        auto ncx = parse(content / path8(ncx_path));
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
} // namespace dr
