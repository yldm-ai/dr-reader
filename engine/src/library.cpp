#include "dr/library.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
namespace dr
{
namespace
{
std::string content_id(const fs::path &file)
{
    std::ifstream f(file, std::ios::binary);
    if (!f)
        throw std::runtime_error("无法打开 EPUB 文件");
    uint64_t hash = 14695981039346656037ull;
    char buffer[65536];
    while (f)
    {
        f.read(buffer, sizeof(buffer));
        for (std::streamsize i = 0; i < f.gcount(); ++i)
        {
            hash ^= static_cast<unsigned char>(buffer[i]);
            hash *= 1099511628211ull;
        }
    }
    std::ostringstream out;
    out << std::hex << std::setw(16) << std::setfill('0') << hash;
    return out.str();
}
int64_t now()
{
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
} // namespace
Library::Library(fs::path root) : root_(std::move(root))
{
    fs::create_directories(root_ / "books");
}
fs::path Library::book_path(const std::string &id) const
{
    if (id.size() != 16 || id.find_first_not_of("0123456789abcdef") != id.npos)
        throw std::runtime_error("无效书籍 ID");
    return root_ / "books" / id;
}
Json Library::get(const std::string &id) const
{
    return Json::parse(read_file(book_path(id) / "book.json"));
}
void Library::store(const std::string &id, const Json &book) const
{
    write_atomic(book_path(id) / "book.json", book.dump(2));
}
Json Library::list() const
{
    Json books = Json::array();
    for (auto &entry : fs::directory_iterator(root_ / "books"))
    {
        if (entry.is_directory() && fs::exists(entry.path() / "book.json"))
        {
            try
            {
                books.push_back(get(utf8(entry.path().filename())));
            }
            catch (const std::exception &)
            {
            }
        }
    }
    return books;
}
Json Library::import_book(const fs::path &file)
{
    auto id = content_id(file);
    auto final = book_path(id);
    if (fs::exists(final / "book.json"))
        return get(id);
    auto stage = root_ / ("staging-" + id);
    if (fs::exists(stage))
        fs::remove_all(stage);
    try
    {
        auto book = import_epub(file, stage);
        book["id"] = id;
        book["addedAt"] = now();
        book["lastRead"] = 0;
        write_atomic(stage / "book.json", book.dump(2));
        fs::rename(stage, final);
        return book;
    }
    catch (...)
    {
        std::error_code error;
        fs::remove_all(stage, error);
        throw;
    }
}
Json Library::save_position(const std::string &id, const Json &position)
{
    auto book = get(id);
    auto chapter = position.value("chapter", 0);
    double ratio = position.value("ratio", 0.0);
    if (chapter < 0 || static_cast<size_t>(chapter) >= book["chapters"].size() || !std::isfinite(ratio))
        throw std::runtime_error("无效阅读位置");
    ratio = std::clamp(ratio, 0.0, 1.0);
    book["position"] = {{"chapter", chapter}, {"ratio", ratio}};
    book["progress"] = (chapter + ratio) / static_cast<double>(book["chapters"].size());
    book["lastRead"] = now();
    store(id, book);
    return book;
}
Json Library::toggle_bookmark(const std::string &id, const Json &mark)
{
    auto book = get(id);
    int c = mark.at("chapter");
    double r = mark.value("ratio", 0.0);
    if (c < 0 || static_cast<size_t>(c) >= book["chapters"].size() || !std::isfinite(r) || r < 0 || r > 1)
        throw std::runtime_error("无效书签");
    auto &marks = book["bookmarks"];
    auto it = std::find_if(marks.begin(), marks.end(), [&](auto &m)
                           { return m["chapter"] == c && std::abs(m.value("ratio", 0.0) - r) < 0.02; });
    if (it != marks.end())
        marks.erase(it);
    else
        marks.push_back({{"chapter", c}, {"ratio", r}, {"title", mark.value("title", std::string())}});
    store(id, book);
    return book;
}
Json Library::search(const std::string &id, const std::string &query) const
{
    if (query.empty() || query.size() > 256)
        return Json::array();
    auto book = get(id);
    Json results = Json::array();
    for (size_t i = 0; i < book["chapters"].size() && results.size() < 100; ++i)
    {
        auto text = read_file(book_path(id) / "search" / (std::to_string(i) + ".txt"));
        auto pos = text.find(query);
        if (pos != text.npos)
        {
            size_t begin = pos > 90 ? pos - 90 : 0;
            while (begin < pos && (static_cast<unsigned char>(text[begin]) & 0xc0) == 0x80)
                ++begin;
            size_t end = std::min(text.size(), pos + query.size() + 150);
            while (end < text.size() && (static_cast<unsigned char>(text[end]) & 0xc0) == 0x80)
                ++end;
            results.push_back({{"chapter", i},
                               {"title", book["chapters"][i]["title"]},
                               {"snippet", text.substr(begin, end - begin)}});
        }
    }
    return results;
}
Json Library::settings() const
{
    auto p = root_ / "settings.json";
    if (fs::exists(p))
    {
        try
        {
            return Json::parse(read_file(p));
        }
        catch (const std::exception &)
        {
        }
    }
    return {{"shell", "mica"},       {"theme", "light"}, {"fontSize", 20}, {"lineHeight", 1.9},
            {"fontFamily", "serif"}, {"mode", "scroll"}, {"width", 760}};
}
Json Library::save_settings(const Json &patch)
{
    auto s = settings();
    for (auto it = patch.begin(); it != patch.end(); ++it)
    {
        if (it.key() == "shell" && (it.value() == "mica" || it.value() == "direct2d"))
            s[it.key()] = it.value();
        else if (it.key() == "theme" &&
                 (it.value() == "light" || it.value() == "sepia" || it.value() == "dark"))
            s[it.key()] = it.value();
        else if (it.key() == "mode" && (it.value() == "scroll" || it.value() == "paged"))
            s[it.key()] = it.value();
        else if (it.key() == "fontFamily" && (it.value() == "serif" || it.value() == "sans-serif"))
            s[it.key()] = it.value();
        else if (it.key() == "fontSize" && it.value().is_number())
            s[it.key()] = std::clamp(it.value().get<int>(), 14, 36);
        else if (it.key() == "lineHeight" && it.value().is_number())
            s[it.key()] = std::clamp(it.value().get<double>(), 1.3, 2.5);
        else if (it.key() == "width" && it.value().is_number())
            s[it.key()] = std::clamp(it.value().get<int>(), 480, 1100);
    }
    write_atomic(root_ / "settings.json", s.dump(2));
    return s;
}
} // namespace dr
