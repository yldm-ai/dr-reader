#include "dr/library.h"
#include "dr/settings.h"
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
    annotations_=std::make_unique<AnnotationStore>(root_/"reader.sqlite3");
}
fs::path Library::book_path(const std::string &id) const
{
    if (id.size() != 16 || id.find_first_not_of("0123456789abcdef") != id.npos)
        throw std::runtime_error("无效书籍 ID");
    return root_ / "books" / id;
}
Json Library::get(const std::string &id) const
{
    auto book=Json::parse(read_file(book_path(id) / "book.json"));
    annotations_->migrate_bookmarks(id,book.value("bookmarks",Json::array()));
    book["bookmarks"]=annotations_->bookmarks(id);
    return book;
}
void Library::store(const std::string &id, const Json &book) const
{
    auto metadata=book;
    metadata.erase("bookmarks");
    write_atomic(book_path(id) / "book.json", metadata.dump(2));
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
void Library::remove_book(const std::string &id)
{
    auto path = book_path(id);
    if (!fs::exists(path / "book.json"))
        throw std::runtime_error("图书不存在或已被删除");
    // Hide the book first; restore it if the database transaction fails.
    auto removed = root_ / ("removed-" + id);
    if (fs::exists(removed)) fs::remove_all(removed);
    fs::rename(path, removed);
    try { annotations_->remove_book(id); }
    catch (...) { fs::rename(removed, path); throw; }
    // A locked resource must not turn a completed deletion into an error.
    std::error_code error;
    fs::remove_all(removed, error);
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
    book["bookmarks"]=annotations_->toggle_bookmark(id,{{"chapter",c},{"ratio",r},{"title",mark.value("title",std::string())}});
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
Json Library::chapter_lengths(const std::string &id) const
{
    auto book = get(id);
    Json lengths = Json::array();
    for (size_t i = 0; i < book["chapters"].size(); ++i)
    {
        const auto text = read_file(book_path(id) / "search" / (std::to_string(i) + ".txt"));
        size_t count = 0;
        for (size_t at = 0; at < text.size();)
        {
            // Decode one UTF-8 code point; malformed bytes count as one unit and move on.
            const auto lead = static_cast<unsigned char>(text[at]);
            const size_t size = lead < 0x80 ? 1 : lead >> 5 == 6 ? 2 : lead >> 4 == 14 ? 3 : lead >> 3 == 30 ? 4 : 1;
            char32_t cp = size == 1 ? lead : lead & (0x7f >> size);
            for (size_t k = 1; k < size && at + k < text.size(); ++k)
                cp = (cp << 6) | (static_cast<unsigned char>(text[at + k]) & 0x3f);
            at += size;
            // Matches the reader's \s: ASCII and Unicode spaces, line separators and the BOM.
            const bool space = cp == ' ' || (cp >= 0x09 && cp <= 0x0d) || cp == 0xa0 || cp == 0x1680 ||
                               (cp >= 0x2000 && cp <= 0x200a) || cp == 0x2028 || cp == 0x2029 || cp == 0x202f ||
                               cp == 0x205f || cp == 0x3000 || cp == 0xfeff;
            if (!space)
                count += cp > 0xffff ? 2 : 1;
        }
        lengths.push_back(count);
    }
    return lengths;
}
Json Library::settings() const
{
    auto p = root_ / "settings.json";
    if (fs::exists(p))
    {
        try
        {
            return normalize_settings(Json::parse(read_file(p)));
        }
        catch (const std::exception &)
        {
        }
    }
    return default_settings();
}
Json Library::save_settings(const Json &patch)
{
    auto s = patch_settings(settings(),patch);
    write_atomic(root_ / "settings.json", s.dump(2));
    return s;
}
Json Library::annotations(const std::string& id) const {get(id);return annotations_->list(id);}
Json Library::save_annotation(const std::string& id,const Json& annotation){auto book=get(id);int chapter=annotation.at("chapter");if(chapter<0||static_cast<size_t>(chapter)>=book["chapters"].size()||annotation.at("href")!=book["chapters"][chapter]["href"])throw std::runtime_error("标注章节不属于当前书籍");return annotations_->save(id,annotation);}
void Library::remove_annotation(const std::string& id,const std::string& annotation_id){get(id);annotations_->remove(id,annotation_id);}
std::string Library::lookup_url(const std::string& dictionary,const std::string& text)const{return dictionary_url(settings(),dictionary,text);}
} // namespace dr
