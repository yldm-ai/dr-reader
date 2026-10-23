#include "dr/library.h"
#include "dr/settings.h"
#include "dr/splitter.h"
#include "dr/wordcount.h"
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
Json Library::shelves() const
{
    const auto path = root_ / "shelves.json";
    return fs::exists(path) ? Json::parse(read_file(path)) : Json::array();
}
Json Library::save_shelves(const Json &shelves)
{
    if (!shelves.is_array()) throw std::runtime_error("书架格式无效");
    Json clean = Json::array();
    for (const auto &shelf : shelves)
    {
        const auto id = shelf.at("id").get<std::string>();
        const auto name = shelf.at("name").get<std::string>();
        if (id.empty() || id.size() > 128 || name.empty() || name.size() > 320 ||
            name.find_first_not_of(" \t\r\n") == std::string::npos || !shelf.at("bookIds").is_array())
            throw std::runtime_error("书架格式无效");
        for (const auto &other : clean)
            if (other.at("id") == id || other.at("name") == name)
                throw std::runtime_error("书架名称或 ID 重复");
        Json ids = Json::array();
        for (const auto &value : shelf.at("bookIds"))
        {
            const auto book = value.get<std::string>();
            if (fs::exists(book_path(book) / "book.json") && std::find(ids.begin(), ids.end(), value) == ids.end())
                ids.push_back(book);
        }
        Json cover = nullptr;
        if (shelf.contains("cover") && !shelf.at("cover").is_null())
        {
            const auto &source = shelf.at("cover");
            if (source.contains("image"))
            {
                const auto image = source.at("image").get<std::string>();
                const std::string prefix = "data:image/webp;base64,";
                if (!image.starts_with(prefix) || image.size() > 2 * 1024 * 1024 ||
                    image.size() <= prefix.size() ||
                    image.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=", prefix.size()) != std::string::npos)
                    throw std::runtime_error("封面图片格式无效或过大");
                cover = {{"image", image}};
            }
            else if (source.contains("bookId"))
            {
                const auto book = source.at("bookId").get<std::string>();
                if (std::find(ids.begin(), ids.end(), book) != ids.end())
                    cover = {{"bookId", book}};
            }
        }
        Json item = {{"id", id}, {"name", name}, {"bookIds", ids}};
        if (!cover.is_null()) item["cover"] = cover;
        clean.push_back(item);
    }
    write_atomic(root_ / "shelves.json", clean.dump(2));
    return clean;
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
    if (chapter < 0 || static_cast<size_t>(chapter) > book["chapters"].size() || !std::isfinite(ratio))
        throw std::runtime_error("无效阅读位置");
    ratio = std::clamp(ratio, 0.0, 1.0);
    book["position"] = {{"chapter", chapter}, {"ratio", ratio}};
    book["progress"] = static_cast<size_t>(chapter) == book["chapters"].size() ? 1.0
        : std::min(0.999, (chapter + ratio) / static_cast<double>(book["chapters"].size()));
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
Json Library::info(const std::string &id) const
{
    const auto book = get(id);
    const auto path = book_path(id);
    // Reading the cached OPF keeps details available for books imported before this view existed.
    Json metadata = Json::object();
    try
    {
        metadata = read_opf_metadata(path / "content");
    }
    catch (const std::exception &)
    {
    }
    WordCount count;
    for (size_t i = 0; i < book["chapters"].size(); ++i)
    {
        std::string text;
        try
        {
            pugi::xml_document doc;
            const auto markup =
                xml_compatible_entities(read_file(path / "content" / path8(book["chapters"][i].at("href").get<std::string>())));
            if (doc.load_buffer(markup.data(), markup.size()))
                text = reading_text(doc);
        }
        catch (const std::exception &)
        {
        }
        // Search text breaks words at inline markup, so it is only the fallback.
        if (text.empty())
        {
            const auto search = path / "search" / (std::to_string(i) + ".txt");
            if (fs::exists(search))
                text = read_file(search);
        }
        count += count_words(text);
    }
    const auto fallback = [&](const char *key, const Json &value) {
        if (!metadata.contains(key) || metadata[key] == "" || metadata[key] == Json::array())
            metadata[key] = value;
    };
    fallback("title", book.value("title", std::string()));
    const auto author = book.value("author", std::string());
    fallback("authors", author.empty() || author == "未知作者" ? Json::array() : Json::array({author}));
    fallback("publisher", book.value("publisher", std::string()));
    const auto language = book.value("language", std::string());
    fallback("languages", language.empty() ? Json::array() : Json::array({language}));
    fallback("subjects", book.value("subjects", Json::array()));
    metadata["id"] = id;
    metadata["format"] = book.value("format", std::string("EPUB"));
    metadata["fileBytes"] = book.value("fileBytes", Json());
    metadata["addedAt"] = book.value("addedAt", Json());
    metadata["lastRead"] = book.value("lastRead", Json());
    metadata["progress"] = book.value("progress", 0.0);
    metadata["chapters"] = book["chapters"].size();
    metadata["words"] = {{"cjk", count.cjk},
                         {"words", count.words},
                         {"punctuation", count.punctuation},
                         {"withPunctuation", count.cjk + count.words + count.punctuation},
                         {"withoutPunctuation", count.cjk + count.words}};
    return metadata;
}
Json Library::settings() const
{
    const auto config = root_ / "config.toml";
    if (fs::exists(config))
    {
        try { return parse_settings_toml(read_file(config)); }
        catch (const std::exception &error)
        {
            throw std::runtime_error("无法读取配置 " + utf8(config) + ": " + error.what());
        }
    }
    auto settings = default_settings();
    const auto legacy = root_ / "settings.json";
    if (fs::exists(legacy))
        settings = normalize_settings(Json::parse(read_file(legacy)));
    // Keep legacy settings as a backup, but use TOML exclusively after migration.
    write_atomic(config, format_settings_toml(settings));
    return settings;
}
Json Library::save_settings(const Json &patch)
{
    auto settings = patch_settings(this->settings(), patch);
    write_atomic(root_ / "config.toml", format_settings_toml(settings));
    return settings;
}
std::string Library::export_notes(const std::string &id) const
{
    const auto book = get(id);
    const auto notes = annotations_->list(id);
    if (notes.empty()) return {};
    const auto escaped = [](const std::string &text) {
        std::string result;
        for (char c : text)
        {
            if (c == '\r') continue;
            if (std::string_view("\\`*_{}[]<>()#+.!|-").find(c) != std::string_view::npos) result += '\\';
            result += c;
        }
        return result;
    };
    std::ostringstream out;
    out << "# " << escaped(book.value("title", std::string("阅读笔记"))) << "\n\n";
    const auto author = book.value("author", std::string());
    if (!author.empty()) out << "作者：" << escaped(author) << "\n\n";
    int previous = -1;
    for (const auto &note : notes)
    {
        const int chapter = note.at("chapter");
        if (chapter != previous)
        {
            const auto &chapters = book.at("chapters");
            std::string title = chapter >= 0 && static_cast<size_t>(chapter) < chapters.size()
                ? chapters[chapter].value("title", std::string()) : "";
            if (title.empty()) title = "第 " + std::to_string(chapter + 1) + " 节";
            out << "## " << escaped(title) << "\n\n";
            previous = chapter;
        }
        std::istringstream quote(escaped(note.value("quote", std::string())));
        std::string line;
        while (std::getline(quote, line)) out << "> " << line << '\n';
        const auto style = note.value("style", std::string("highlight"));
        out << "\n标注：" << (style == "underline" ? "下划线" : style == "note" ? "笔记" : "高亮") << "\n";
        const auto text = note.value("note", std::string());
        if (!text.empty()) out << "\n**笔记**\n\n" << escaped(text) << "\n";
        out << "\n---\n\n";
    }
    return out.str();
}
Json Library::annotations(const std::string& id) const {get(id);return annotations_->list(id);}
Json Library::save_annotation(const std::string& id,const Json& annotation){auto book=get(id);int chapter=annotation.at("chapter");if(chapter<0||static_cast<size_t>(chapter)>=book["chapters"].size()||annotation.at("href")!=book["chapters"][chapter]["href"])throw std::runtime_error("标注章节不属于当前书籍");return annotations_->save(id,annotation);}
void Library::remove_annotation(const std::string& id,const std::string& annotation_id){get(id);annotations_->remove(id,annotation_id);}
std::string Library::lookup_url(const std::string& dictionary,const std::string& text)const{return dictionary_url(settings(),dictionary,text);}
} // namespace dr
