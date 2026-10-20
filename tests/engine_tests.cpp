#include "dr/library.h"
#include "dr/splitter.h"
#include <chrono>
#include <iostream>
#include <miniz.h>
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
        dr::Library library(root / "library");
        auto book = library.import_book(epub);
        auto id = book["id"].get<std::string>();
        require(book["title"] == "测试书", "metadata");
        require(book["chapters"].size() == 2, "spine split");
        require(book["toc"][1]["href"].get<std::string>().find(".dr-1.xhtml#end") != std::string::npos,
                "TOC remap");
        auto html = dr::read_file(root / "library" / "books" / id / "content" / "OPS" / "text.dr-0.xhtml");
        require(html.find("text.dr-1.xhtml#end") != std::string::npos, "cross-flow link remap");
        require(library.import_book(epub)["id"] == id && library.list().size() == 1, "duplicate import");
        library.save_position(id, {{"chapter", 1}, {"ratio", 0.4}});
        dr::Library reopened(root / "library");
        require(reopened.get(id)["position"]["chapter"] == 1, "progress survives restart");
        require(reopened.search(id, "结尾").size() == 1, "C++ search");
        require(reopened.toggle_bookmark(id, {{"chapter", 1}, {"ratio", 0.4}})["bookmarks"].size() == 1,
                "bookmark add");
        require(reopened.toggle_bookmark(id, {{"chapter", 1}, {"ratio", 0.4}})["bookmarks"].empty(),
                "bookmark remove");
        rejects([&] { reopened.save_position(id, {{"chapter", -1}}); }, "invalid progress");
        auto bad = root / "bad.epub";
        zip(bad, {{"../outside.txt", "escape"}});
        rejects([&] { library.import_book(bad); }, "zip traversal");
        require(!dr::fs::exists(root / "outside.txt"), "no extraction escape");
        auto huge = root / "huge.epub";
        zip(huge, {{"huge.txt", std::string(5000, 'z')}});
        rejects([&] { dr::import_epub(huge, root / "limited", {1024, 2048, 100}); }, "expansion limit");
        dr::fs::remove_all(root);
        std::cout << "All EPUB, DOM split, URI, link, persistence, search and archive checks passed.\n";
        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << e.what() << "\nFixtures: " << dr::utf8(root) << '\n';
        return 1;
    }
}
