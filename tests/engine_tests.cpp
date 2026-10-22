#include "dr/library.h"
#include "dr/annotations.h"
#include "dr/settings.h"
#include "dr/splitter.h"
#include <chrono>
#include <iostream>
#include <miniz.h>
#include <sqlite3.h>
#include <stdexcept>
namespace
{
void require(bool ok, const char *message)
{
    if (!ok)
        throw std::runtime_error(message);
}
template <class F> void rejects(F fn, const char *message)
{
    bool failed = false;
    try
    {
        fn();
    }
    catch (const std::exception &)
    {
        failed = true;
    }
    require(failed, message);
}
void zip(const dr::fs::path &path, const std::vector<std::pair<std::string, std::string>> &files)
{
    mz_zip_archive z{};
    require(mz_zip_writer_init_file(&z, dr::utf8(path).c_str(), 0) != 0, "zip init");
    for (auto &[name, text] : files)
        require(mz_zip_writer_add_mem(&z, name.c_str(), text.data(), text.size(),
                                      static_cast<mz_uint>(MZ_DEFAULT_COMPRESSION)) != 0,
                "zip add");
    require(mz_zip_writer_finalize_archive(&z) != 0, "zip finish");
    mz_zip_writer_end(&z);
}
} // namespace
int main()
{
    auto root =
        dr::fs::temp_directory_path() /
        ("dr-reader-tests-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try
    {
        dr::fs::create_directories(root);
        require(dr::resolve_href("OPS/Text/a.xhtml", "../Images/a%20b.png") == "OPS/Images/a b.png",
                "relative URI");
        rejects([] { dr::resolve_href("a.xhtml", "../escape"); }, "traversal rejected");
        rejects([] { dr::resolve_href("", "%2e%2e/out"); }, "encoded traversal rejected");
        std::string source =
            R"(<html xmlns="http://www.w3.org/1999/xhtml"><head><title>test</title><link href="style.css" rel="stylesheet"/></head><body><section id="outer"><h1 id="start">一</h1><p>开头文字<a href="#end">跳转</a></p><div><h2 style="page-break-before: always" id="end">二</h2><p>结尾文字</p></div></section></body></html>)";
        auto result = dr::split_xhtml("OPS/text.xhtml", source);
        require(result.flows.size() == 2, "page break split nested DOM");
        require(result.anchors.at("start") == result.flows[0].path, "first anchor");
        require(result.anchors.at("end") == result.flows[1].path, "second anchor");
        require(result.flows[1].html.find("style.css") != std::string::npos, "head preserved");
        require(result.flows[1].html.find("id=\"outer\"") == std::string::npos,
                "duplicated ancestor anchor removed");
        for (auto &flow : result.flows)
        {
            pugi::xml_document d;
            require(d.load_string(flow.html.c_str()), "valid split XML");
        }
        std::string large = "<html><head/><body><section>";
        for (int i = 0; i < 80; ++i)
            large += "<p id=\"p" + std::to_string(i) + "\">" + std::string(100, 'a') + "</p>";
        large += "</section></body></html>";
        auto sized = dr::split_xhtml("long.xhtml", large, {1024, true});
        require(sized.flows.size() > 2, "size split");
        require(sized.anchors.size() == 81, "all anchors preserved");
        auto css_split = dr::split_xhtml(
            "css.xhtml",
            R"(<html><head><style>.part {break-before: page}</style></head><body><p>前文</p><section class="part"><p>后文</p></section></body></html>)");
        require(css_split.flows.size() == 2, "embedded CSS class page break");
        auto linked_css = dr::split_xhtml(
            "linked.xhtml", R"(<html><head/><body><p>前文</p><p class="part">后文</p></body></html>)",
            {1024, true, "body p.part {page-break-before: always}"});
        require(linked_css.flows.size() == 2, "linked CSS descendant selector");
        auto unicode = dr::split_xhtml("OPS/中文.xhtml", source);
        require(unicode.flows[1].path == "OPS/中文.dr-1.xhtml", "Unicode split filenames");
        auto dangerous = dr::split_xhtml(
            "safe.xhtml",
            "<html><head/><body><script>alert(1)</script><p onclick=\"evil()\">安全内容</p></body></html>");
        require(dangerous.flows[0].html.find("<script>") == std::string::npos, "script removed");
        require(dangerous.flows[0].html.find("onclick") == std::string::npos, "event removed");
        auto epub = root / "fixture.epub";
        zip(epub,
            {{"mimetype", "application/epub+zip"},
             {"META-INF/container.xml",
              R"(<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>)"},
             {"OPS/package.opf",
              R"(<package xmlns:dc="urn:dc"><metadata><dc:title>测试书</dc:title><dc:creator>测试作者</dc:creator></metadata><manifest><item id="c" href="text.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>)"},
             {"OPS/text.xhtml", source},
             {"OPS/nav.xhtml",
              R"(<html xmlns:epub="urn:epub"><body><nav epub:type="toc"><ol><li><a href="text.xhtml#start">第一节</a></li><li><a href="text.xhtml#end">第二节</a></li></ol></nav></body></html>)"}});
        std::string id;
        std::string annotation_href;
        {
        dr::Library library(root / "library");
        auto book = library.import_book(epub);
        id = book["id"].get<std::string>();
        require(book["title"] == "测试书", "metadata");
        require(book["chapters"].size() == 2, "spine split");
        require(book["toc"][1]["href"].get<std::string>().find(".dr-1.xhtml#end") != std::string::npos,
                "TOC remap");
        annotation_href = book["chapters"][1]["href"].get<std::string>();
        auto html = dr::read_file(root / "library" / "books" / id / "content" / "OPS" / "text.dr-0.xhtml");
        require(html.find("text.dr-1.xhtml#end") != std::string::npos, "cross-flow link remap");
        require(library.import_book(epub)["id"] == id && library.list().size() == 1, "duplicate import");
        require(library.shelves().empty(), "new library has no shelves");
        const auto shelves = dr::Json::array({{{"id", "test-shelf"}, {"name", "文学"}, {"bookIds", dr::Json::array({id})}}});
        require(library.save_shelves(shelves) == shelves, "save shelf membership");
        rejects([&] { library.save_shelves(dr::Json::array({shelves[0], shelves[0]})); }, "reject duplicate shelves");
        require(library.shelves() == shelves, "invalid save preserves shelves");
        auto covered_shelves = shelves;
        covered_shelves[0]["cover"] = {{"bookId", id}};
        require(library.save_shelves(covered_shelves) == covered_shelves, "book cover persists");
        covered_shelves[0]["cover"] = {{"image", "data:image/webp;base64,UklGRg=="}};
        require(library.save_shelves(covered_shelves) == covered_shelves, "uploaded cover persists");
        covered_shelves[0]["cover"] = {{"image", "file:///private.png"}};
        rejects([&] { library.save_shelves(covered_shelves); }, "reject invalid cover source");
        library.save_shelves(shelves);
        require(library.save_position(id, {{"chapter", 1}, {"ratio", 1}})["progress"] < 1, "content end precedes completion page");
        require(library.save_position(id, {{"chapter", 2}, {"ratio", 1}})["progress"] == 1, "completion page reaches 100 percent");
        require(dr::Library(root / "library").get(id)["position"]["chapter"] == 2, "completion survives restart");
        rejects([&] { library.save_position(id, {{"chapter", 3}, {"ratio", 0}}); }, "reject position beyond completion");
        library.save_position(id, {{"chapter", 1}, {"ratio", 0.4}});
        {
            dr::Library reopened(root / "library");
            require(reopened.shelves() == shelves, "shelves survive restart");
            require(reopened.get(id)["position"]["chapter"] == 1, "progress survives restart");
            require(reopened.search(id, "结尾").size() == 1, "C++ search");
            // Chapters are parsed as HTML: <title/> would swallow the document as title text.
            require(dr::html_compatible(R"(<head><title/><link href="a.css"/></head><p a="x/>" b='y'/><svg:path d="M0"/><br/>)") ==
                        R"(<head><title></title><link href="a.css"/></head><p a="x/>" b='y'></p><svg:path d="M0"></svg:path><br/>)",
                    "self-closing non-void elements are written HTML-safe");
            // The fixture's second chapter reads "二结尾文字": five visible characters.
            auto lengths = reopened.chapter_lengths(id);
            require(lengths.size() == reopened.get(id)["chapters"].size() && lengths[1] == 5,
                    "chapter lengths count visible characters without whitespace");
            require(reopened.toggle_bookmark(id, {{"chapter", 1}, {"ratio", 0.4}})["bookmarks"].size() == 1,
                    "bookmark add");
            require(reopened.toggle_bookmark(id, {{"chapter", 1}, {"ratio", 0.4}})["bookmarks"].empty(),
                    "bookmark remove");
        }
        std::string annotation_id;
        {
            dr::AnnotationStore annotations(root / "annotations.sqlite3");
            auto annotation = annotations.save(
                id, {{"chapter", 1}, {"href", annotation_href}, {"start", 0}, {"end", 4},
                     {"quote", "结尾文字"}, {"prefix", "前文"}, {"suffix", "后文"}, {"note", "重要"},
                     {"color", "green"}, {"style", "highlight"}});
            annotation_id = annotation["id"].get<std::string>();
            require(!annotation_id.empty(), "annotation insert");
            require(annotations.list(id).size() == 1, "annotation list");
            auto emoji_json = dr::Json::parse(
                std::string(R"({"chapter":1,"href":")") + annotation_href +
                R"(","start":20,"end":22,"quote":"\uD83D\uDE00","prefix":"","suffix":"","note":"emoji","color":"yellow","style":"highlight"})");
            auto emoji = annotations.save(id, emoji_json);
            require(!emoji["id"].get<std::string>().empty(), "UTF-16 annotation offsets");
            annotations.remove(id, emoji["id"]);
            annotation["note"] = "修订后的笔记";
            annotation["color"] = "blue";
            auto revised = annotations.save(id, annotation);
            require(revised["note"] == "修订后的笔记" && revised["color"] == "blue",
                    "annotation update");
        }
        {
            dr::AnnotationStore reopened_annotations(root / "annotations.sqlite3");
            require(reopened_annotations.list(id).size() == 1 &&
                        reopened_annotations.list(id)[0]["note"] == "修订后的笔记",
                    "annotation persistence");
            reopened_annotations.remove(id, annotation_id);
            require(reopened_annotations.list(id).empty(), "annotation delete");
        }
        {
            // A version 1 database only allowed five colour names; opening it must rebuild the
            // table without losing rows, after which custom #rrggbb colours save.
            const auto legacy_path = root / "legacy.sqlite3";
            sqlite3 *legacy = nullptr;
            require(sqlite3_open(legacy_path.string().c_str(), &legacy) == SQLITE_OK, "legacy database");
            const char *v1 = R"(CREATE TABLE annotations(
              id TEXT PRIMARY KEY, book_id TEXT NOT NULL, chapter INTEGER NOT NULL CHECK(chapter>=0), href TEXT NOT NULL,
              start_offset INTEGER NOT NULL CHECK(start_offset>=0), end_offset INTEGER NOT NULL CHECK(end_offset>start_offset),
              quote TEXT NOT NULL CHECK(length(quote)>0), prefix TEXT NOT NULL DEFAULT '', suffix TEXT NOT NULL DEFAULT '',
              note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','purple')),
              style TEXT NOT NULL CHECK(style IN ('highlight','underline')),
              created_at INTEGER NOT NULL DEFAULT(unixepoch()), updated_at INTEGER NOT NULL DEFAULT(unixepoch()));
              INSERT INTO annotations(id,book_id,chapter,href,start_offset,end_offset,quote,note,color,style)
                VALUES('old','book',0,'c.html',0,2,'旧注','保留','pink','underline');
              PRAGMA user_version=1;)";
            require(sqlite3_exec(legacy, v1, nullptr, nullptr, nullptr) == SQLITE_OK, "legacy schema");
            sqlite3_close(legacy);
            dr::AnnotationStore migrated(legacy_path);
            auto kept = migrated.list("book");
            require(kept.size() == 1 && kept[0]["id"] == "old" && kept[0]["note"] == "保留" &&
                        kept[0]["color"] == "pink" && kept[0]["style"] == "underline",
                    "schema 2 migration keeps every annotation");
            auto custom = migrated.save("book", {{"chapter", 0}, {"href", "c.html"}, {"start", 4}, {"end", 6},
                                                 {"quote", "新色"}, {"color", "#a1b2c3"}, {"style", "highlight"}});
            require(custom["color"] == "#a1b2c3", "custom highlight colour");
            // Removing the mark from an annotation with a note keeps the note (schema 3).
            auto note_only = migrated.save("book", {{"id", "old"}, {"chapter", 0}, {"href", "c.html"}, {"start", 0},
                                                    {"end", 2}, {"quote", "旧注"}, {"note", "保留"}, {"color", "pink"},
                                                    {"style", "note"}});
            require(note_only["style"] == "note" && note_only["note"] == "保留", "note-only annotations save");
            rejects([&] { migrated.save("book", {{"chapter", 0}, {"href", "c.html"}, {"start", 8}, {"end", 9},
                                                 {"quote", "错"}, {"color", "pink"}, {"style", "strike"}}); },
                    "unknown annotation styles are rejected");
            rejects([&] { migrated.save("book", {{"chapter", 0}, {"href", "c.html"}, {"start", 8}, {"end", 9},
                                                 {"quote", "错"}, {"color", "#ABC"}, {"style", "highlight"}}); },
                    "malformed highlight colours are rejected");
        }
        {
            // Reopening a migrated database is a no-op.
            dr::AnnotationStore again(root / "legacy.sqlite3");
            require(again.list("book").size() == 2, "migrated database reopens");
        }
        auto defaults = dr::default_settings();
        require(defaults["application"]["shell"] == "direct2d" && defaults["reading"]["mode"] == "paged",
                "settings defaults");
        require(defaults["application"]["theme"] == "system" && defaults["reading"]["theme"] == "system",
                "both themes default to following the system");
        require(defaults["reading"]["fontFamily"] == "Microsoft YaHei UI" && defaults["reading"]["fontSize"] == 18 &&
                    defaults["reading"]["layout"] == "double" && defaults["reading"]["animation"] == "turn" &&
                    defaults["reading"]["animationDuration"] == 500 && defaults["reading"]["turnDuration"] == 500 &&
                    defaults["reading"]["publisherStyles"] == true && defaults["reading"]["showChapterTitle"] == false &&
                    defaults["reading"]["showPagination"] == false,
                "defaults capture current reading preferences");
        require(defaults["reading"]["autoHideProgress"] == false &&
                    dr::patch_settings(defaults, {{"reading", {{"autoHideProgress", true}}}})["reading"]["autoHideProgress"] == true,
                "footer auto hide defaults off and can persist");
        rejects([&] { dr::patch_settings(defaults, {{"reading", {{"autoHideProgress", "yes"}}}}); }, "footer auto hide requires boolean");
        require(dr::normalize_settings(defaults) == defaults, "system themes survive settings normalization");
        require(dr::patch_settings(defaults, {{"reading", {{"theme", "dark"}}}})["application"]["theme"] == "system",
                "fixed reading theme keeps application system preference");
        require(!defaults["reading"]["tocPinned"].get<bool>(), "sidebar defaults to auto-hide");
        auto pinned_settings = library.save_settings({{"reading", {{"tocPinned", true}}}});
        require(pinned_settings["reading"]["tocPinned"].get<bool>() &&
                    library.settings()["reading"]["tocPinned"].get<bool>(), "sidebar pin preference persists");
        rejects([&] { library.save_settings({{"reading", {{"tocPinned", "true"}}}}); },
                "sidebar pin requires a boolean");
        auto scroll_preferences = dr::normalize_settings(
            {{"version", 2}, {"reading", {{"mode", "scroll"}}}});
        require(scroll_preferences["reading"]["mode"] == "scroll",
                "preserve an explicitly saved scroll preference");
        auto customized = dr::patch_settings(
            defaults, {{"application", {{"theme", "dark"}, {"animations", false}}},
                       {"reading", {{"fontSize", 24}, {"lineHeight", 2.2}, {"animation", "turn"}}}});
        require(customized["application"]["theme"] == "dark" &&
                    customized["reading"]["fontSize"] == 24 &&
                    customized["reading"]["animation"] == "turn",
                "settings patch");
        require(defaults["application"]["bookOpeningAnimation"] == "circles" &&
                    dr::patch_settings(defaults, {{"application", {{"bookOpeningAnimation", "book"}}}})
                        ["application"]["bookOpeningAnimation"] == "book",
                "opening animation choice defaults and persistence");
        require(dr::patch_settings(defaults, {{"application", {{"bookOpeningAnimation", "cover"}}}})
                    ["application"]["bookOpeningAnimation"] == "cover",
                "full height cover opening choice persists");
        rejects([&] { dr::patch_settings(defaults, {{"application", {{"bookOpeningAnimation", "invalid"}}}}); },
                "reject invalid opening animation choices");
        auto opening_only = dr::patch_settings(defaults, {{"application", {{"animations", false}, {"bookOpeningEnabled", true}}}});
        require(!opening_only["application"]["animations"].get<bool>() &&
                    opening_only["application"]["bookOpeningEnabled"].get<bool>(),
                "book opening has an independent enable switch");
        require(!dr::normalize_settings({{"application", {{"animations", false}}}})
                     ["application"]["bookOpeningEnabled"].get<bool>(),
                "old settings preserve disabled opening animations during migration");
        require(dr::normalize_settings(opening_only)["application"]["bookOpeningEnabled"].get<bool>(),
                "explicit independent opening preference survives normalization");
        rejects([&] { dr::patch_settings(defaults, {{"application", {{"bookOpeningEnabled", "false"}}}}); },
                "reject invalid opening enable switches");
        auto legacy_corner = dr::normalize_settings(
            {{"version", 2}, {"reading", {{"fontSize", 26}, {"animation", "turn-bottom"}}}});
        require(legacy_corner["reading"]["animation"] == "turn" && legacy_corner["reading"]["fontSize"] == 26,
                "saved bottom-corner turns migrate without discarding other settings");
        require(legacy_corner["reading"]["turnDuration"] == 500 &&
                    dr::patch_settings(defaults, {{"reading", {{"turnDuration", 5000}}}})["reading"]["turnDuration"] == 2000 &&
                    dr::patch_settings(defaults, {{"reading", {{"turnDuration", 1234}}}})["reading"]["turnDuration"] == 1234,
                "page turns default to 500 ms and keep a custom duration within 300-2000 ms");
        require(defaults["application"]["highlightColors"].size() == 5 &&
                    dr::patch_settings(defaults, {{"application", {{"highlightColors", {"#ABCDEF", "#fbf3db"}}}}})
                            ["application"]["highlightColors"][0] == "#abcdef" &&
                    defaults["reading"]["showBookPages"] == true &&
                    dr::patch_settings(defaults, {{"reading", {{"theme", "night"}, {"animation", "cover"}}}})
                            ["reading"]["animation"] == "cover",
                "highlight palette, whole-book pages, new themes and the cover animation");
        rejects([&] { dr::patch_settings(defaults, {{"application", {{"highlightColors", {"yellow"}}}}}); },
                "highlight palette entries must be #rrggbb");
        require(defaults["application"]["underlineColor"] == "#ddebf1" &&
                    dr::patch_settings(defaults, {{"application", {{"underlineColor", "#A1B2C3"}}}})
                            ["application"]["underlineColor"] == "#a1b2c3",
                "the underline colour is remembered separately");
        rejects([&] { dr::patch_settings(defaults, {{"application", {{"underlineColor", "blue"}}}}); },
                "underline colours must be #rrggbb");
        auto immersive = dr::patch_settings(defaults, {{"reading", {
            {"showToolbar", false}, {"showToc", false}, {"showChapterTitle", false},
            {"showPagination", false}, {"showProgress", false}, {"fullBackground", true}, {"fullWidth", true},
            {"paddingTop", 0}, {"paddingBottom", 80}, {"paddingLeft", 10}, {"paddingRight", 90}}}});
        require(!immersive["reading"]["showToolbar"].get<bool>() && immersive["reading"]["fullWidth"] &&
                    immersive["reading"]["paddingTop"] == 0 && immersive["reading"]["paddingRight"] == 90,
                "immersive settings and independent margins");
        auto migrated_margins = dr::normalize_settings({{"reading", {{"paddingX", 62}, {"paddingY", 28}}}});
        require(migrated_margins["reading"]["paddingLeft"] == 62 && migrated_margins["reading"]["paddingRight"] == 62 &&
                    migrated_margins["reading"]["paddingTop"] == 28 && migrated_margins["reading"]["paddingBottom"] == 28,
                "legacy horizontal and vertical margins migrate without losing customization");
        rejects([&] { dr::patch_settings(defaults, {{"reading", {{"showToolbar", "false"}}}}); },
                "immersive switches require boolean values");
        auto legacy = dr::normalize_settings(
            {{"shell", "direct2d"}, {"theme", "sepia"}, {"fontSize", 22}, {"mode", "paged"}});
        require(legacy["application"]["shell"] == "direct2d" &&
                    legacy["application"]["theme"] == "sepia" &&
                    legacy["reading"]["fontSize"] == 22 && legacy["reading"]["mode"] == "paged",
                "legacy settings migration");
        rejects([&] { dr::patch_settings(defaults, {{"reading", {{"mode", "invalid"}}}}); },
                "invalid reading mode");
        auto dictionary = dr::patch_settings(
            defaults,
            {{"application",
              {{"dictionaries",
                {{{"id", "custom"}, {"name", "测试"}, {"url", "https://example.com/?q={text}"},
                  {"enabled", true}}}}}}});
        auto lookup = dr::dictionary_url(dictionary, "custom", "阅读 & 笔记/测试");
        require(lookup.find("example.com") != std::string::npos &&
                    lookup.find("&amp;") == std::string::npos &&
                    lookup.find("%2F") != std::string::npos,
                "dictionary URL encoding");
        rejects([&] { library.save_position(id, {{"chapter", -1}}); }, "invalid progress");
        library.save_annotation(id, {{"chapter", 1}, {"href", annotation_href},
                                    {"start", 0}, {"end", 4}, {"quote", "结尾文字"}});
        library.toggle_bookmark(id, {{"chapter", 1}, {"ratio", 0.4}});
        rejects([&] { library.remove_book("../library"); }, "reject unsafe deletion ID");
        require(library.list().size() == 1, "invalid deletion preserves library");
        {
            dr::AnnotationStore store(root / "library" / "reader.sqlite3");
            store.toggle_bookmark("another-book", {{"chapter", 0}, {"ratio", 0.2}});
            library.remove_book(id);
            require(store.list(id).empty() && store.bookmarks(id).empty(), "delete book reading data");
            require(store.bookmarks("another-book").size() == 1, "preserve other book data");
        }
        require(library.list().empty() && !dr::fs::exists(root / "library" / "books" / id),
                "delete removes library entry and extracted files");
        require(dr::fs::exists(epub), "delete preserves original EPUB");
        rejects([&] { library.get(id); }, "deleted book cannot open");
        rejects([&] { library.remove_book(id); }, "missing book deletion reports error");
        {
            dr::Library reopened(root / "library");
            require(reopened.list().empty(), "deletion survives restart");
            auto reimported = reopened.import_book(epub);
            require(reimported.value("lastRead", 0) == 0 && reopened.annotations(id).empty() &&
                        reopened.get(id)["bookmarks"].empty(), "reimport starts with clean reading data");
        }
        }
        auto bad = root / "bad.epub";
        zip(bad, {{"../outside.txt", "escape"}});
        {
            dr::Library invalid_archive_library(root / "invalid-archive");
            rejects([&] { invalid_archive_library.import_book(bad); }, "zip traversal");
        }
        require(!dr::fs::exists(root / "outside.txt"), "no extraction escape");
        auto huge = root / "huge.epub";
        zip(huge, {{"huge.txt", std::string(5000, 'z')}});
        rejects([&] { dr::import_epub(huge, root / "limited", {1024, 2048, 100}); }, "expansion limit");
        dr::fs::remove_all(root);
        std::cout << "All EPUB, DOM split, URI, link, persistence, annotations, settings and archive checks passed.\n";
        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << e.what() << "\nFixtures: " << dr::utf8(root) << '\n';
        return 1;
    }
}
