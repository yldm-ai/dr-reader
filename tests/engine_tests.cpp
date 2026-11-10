#include "dr/library.h"
#include "dr/agent.h"
#include "dr/annotations.h"
#include "dr/settings.h"
#include "dr/splitter.h"
#include "dr/wordcount.h"
#include <algorithm>
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
// Event lines are trimmed copies of real output from codex-cli 0.167, Claude Code 2.1 and opencode 1.19.
void agent_checks()
{
    using dr::AgentEvent;
    using dr::AgentKind;
    auto texts = [](const std::vector<AgentEvent> &events) {
        std::string text;
        for (auto &event : events)
            if (event.type == AgentEvent::Type::Text) text += event.text;
        return text;
    };
    {
        dr::AgentStream claude(AgentKind::Claude);
        require(claude.line(R"({"type":"system","subtype":"init","tools":[],"mcp_servers":[]})").empty(), "claude init is silent");
        std::string answer;
        answer += texts(claude.line(R"({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null})"));
        answer += texts(claude.line(R"({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"书中"}},"parent_tool_use_id":null})"));
        answer += texts(claude.line(R"({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"x"}},"parent_tool_use_id":null})"));
        answer += texts(claude.line(R"({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"写道"}},"parent_tool_use_id":"tool_1"})"));
        answer += texts(claude.line(R"({"type":"assistant","message":{"content":[{"type":"text","text":"书中"}]}})"));
        auto retry = claude.line(R"({"type":"system","subtype":"api_retry","attempt":2,"max_retries":10})");
        require(retry.size() == 1 && retry[0].type == AgentEvent::Type::Status, "claude retry is progress");
        require(claude.line("not json at all").empty() && !claude.succeeded(), "claude ignores noise");
        claude.line(R"({"type":"result","subtype":"success","is_error":false,"result":"书中"})");
        require(answer == "书中" && claude.succeeded(), "claude streams text deltas only once");
        dr::AgentStream failing(AgentKind::Claude);
        auto failed = failing.line(R"({"type":"result","subtype":"success","is_error":true,"result":"API Error: 503"})");
        require(failing.failed() && failed.at(0).type == AgentEvent::Type::Error && failing.last_error() == "API Error: 503", "claude errors fail");
    }
    {
        dr::AgentStream codex(AgentKind::Codex);
        codex.line(R"({"type":"thread.started","thread_id":"01a1"})");
        auto warning = codex.line(R"({"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable"}})");
        require(warning.empty() && !codex.failed(), "codex warning items are not failures");
        auto first = texts(codex.line(R"({"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"第一段"}})"));
        auto second = texts(codex.line(R"({"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"第二段"}})"));
        require(first == "第一段" && second == "\n\n第二段", "codex messages become paragraphs");
        require(!codex.succeeded(), "codex waits for its turn");
        codex.line(R"({"type":"turn.completed","usage":{"input_tokens":1}})");
        require(codex.succeeded(), "codex turn completion succeeds");
        dr::AgentStream failing(AgentKind::Codex);
        failing.line(R"({"type":"error","message":"The 'x' model is not supported"})");
        failing.line(R"({"type":"turn.failed","error":{"message":"The 'x' model is not supported"}})");
        require(failing.failed() && failing.last_error() == "The 'x' model is not supported", "codex turn failure");
    }
    {
        dr::AgentStream opencode(AgentKind::OpenCode);
        opencode.line(R"({"type":"step_start","part":{"type":"step-start"}})");
        auto first = texts(opencode.line(R"({"type":"text","part":{"id":"prt_1","type":"text","text":"甲"}})"));
        auto second = texts(opencode.line(R"({"type":"text","part":{"id":"prt_2","type":"text","text":"乙"}})"));
        opencode.line(R"({"type":"step_finish","part":{"reason":"tool-calls","type":"step-finish"}})");
        require(first == "甲" && second == "\n\n乙" && !opencode.succeeded(), "opencode parts and intermediate steps");
        opencode.line(R"({"type":"step_finish","part":{"reason":"stop","type":"step-finish"}})");
        require(opencode.succeeded(), "opencode stop finishes");
        dr::AgentStream failing(AgentKind::OpenCode);
        failing.line(R"({"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error."}}})");
        require(failing.failed() && failing.last_error() == "Unexpected server error.", "opencode error");
    }
    // Arguments: tool-free, read-only, prompt on stdin, no cmd.exe metacharacters.
    auto codex = dr::agent_arguments(AgentKind::Codex, "gpt-6.1", "high", std::vector<std::string>{"node_repl", "bad name"});
    require(codex.back() == "-" && std::count(codex.begin(), codex.end(), "mcp_servers.node_repl.enabled=false") == 1 &&
                std::none_of(codex.begin(), codex.end(), [](auto &arg) { return arg.find("bad name") != arg.npos; }),
            "codex reads stdin and disables valid MCP names");
    require(std::count(codex.begin(), codex.end(), "model_reasoning_effort=high") == 1, "codex reasoning effort");
    auto effortful = dr::agent_arguments(AgentKind::Claude, "opus", "max");
    auto flag = std::find(effortful.begin(), effortful.end(), "--effort");
    require(flag != effortful.end() && flag + 1 != effortful.end() && flag[1] == "max", "claude effort flag");
    auto variant = dr::agent_arguments(AgentKind::OpenCode, "opencode/beam-free", "xhigh");
    require(variant.end()[-2] == "--variant" && variant.back() == "xhigh", "opencode variant flag");
    for (auto kind : {AgentKind::Codex, AgentKind::Claude, AgentKind::OpenCode})
    {
        auto plain = dr::agent_arguments(kind, "");
        require(std::none_of(plain.begin(), plain.end(), [](auto &arg) { return arg == "--effort" || arg == "--variant" || arg.starts_with("model_reasoning_effort"); }),
                "no effort keeps the CLI default");
    }
    rejects([] { dr::agent_arguments(AgentKind::Claude, "", "high&calc"); }, "efforts cannot inject commands");
    rejects([] { dr::agent_arguments(AgentKind::Codex, "", "a=b"); }, "efforts cannot set other Codex options");
    auto claude = dr::agent_arguments(AgentKind::Claude, "");
    require(std::find(claude.begin(), claude.end(), "--no-session-persistence") != claude.end() &&
                std::find(claude.begin(), claude.end(), "--model") == claude.end(),
            "claude does not persist sessions and keeps its default model");
    for (auto kind : {AgentKind::Codex, AgentKind::Claude, AgentKind::OpenCode})
        for (auto &arg : dr::agent_arguments(kind, "anthropic/claude-sonnet-5", "high"))
            require(arg.find_first_of("&|<>^%!\"") == arg.npos, "agent arguments are cmd-safe");
    rejects([] { dr::agent_arguments(AgentKind::OpenCode, "x & calc"); }, "model names cannot inject commands");
    auto names = dr::codex_mcp_server_names("model = \"x\"\n[mcp_servers.node_repl]\n[mcp_servers.node_repl.env]\n  [mcp_servers.\"quoted-one\"]\n[mcp_servers.bad$name]\n[plugins.\"a@b\"]\n");
    require(names == std::vector<std::string>{"node_repl", "quoted-one"}, "codex MCP server names");
    // Settings accept the agent choice and per-CLI models, and reject unsafe model names.
    auto settings = dr::patch_settings(dr::default_settings(), {{"application", {{"agent", "claude"}, {"agentModels", {{"claude", "opus"}}}}}});
    require(settings["application"]["agent"] == "claude" && settings["application"]["agentModels"]["claude"] == "opus" &&
                settings["application"]["agentModels"]["codex"] == "" && settings["application"]["selectionActions"]["ask"] == true,
            "agent settings");
    rejects([] { dr::patch_settings(dr::default_settings(), {{"application", {{"agent", "gemini"}}}}); }, "unknown agent");
    rejects([] { dr::patch_settings(dr::default_settings(), {{"application", {{"agentModels", {{"codex", "a;b"}}}}}}); }, "unsafe model");
    auto effort = dr::patch_settings(dr::default_settings(), {{"application", {{"agentEfforts", {{"codex", "xhigh"}}}}}});
    require(effort["application"]["agentEfforts"]["codex"] == "xhigh" && effort["application"]["agentEfforts"]["claude"] == "", "effort settings");
    rejects([] { dr::patch_settings(dr::default_settings(), {{"application", {{"agentEfforts", {{"claude", "high max"}}}}}}); }, "unsafe effort");

    // Model discovery: no model turn, only the CLIs' own listing protocols.
    {
        dr::AgentModelProbe codex(AgentKind::Codex);
        auto args = codex.arguments({"node_repl"});
        require(args.at(0) == "app-server" && std::count(args.begin(), args.end(), "mcp_servers.node_repl.enabled=false") == 1 &&
                    codex.interactive() && codex.start().find(R"("method":"initialize")") != std::string::npos,
                "codex lists models through app-server");
        require(codex.line(R"({"method":"remoteControl/status/changed","params":{"status":"disabled"}})").empty(), "codex notifications need no reply");
        auto refusal = codex.line(R"({"id":7,"method":"item/tool/requestUserInput","params":{}})");
        require(refusal.find(R"("id":7)") != std::string::npos && refusal.find("-32601") != std::string::npos, "codex server requests are refused");
        auto next = codex.line(R"({"id":1,"result":{"userAgent":"dr-reader/0.167.0","codexHome":"C:\\Users\\x\\.codex"}})");
        require(next.find(R"("method":"initialized")") != std::string::npos && next.find(R"("method":"model/list")") != std::string::npos,
                "codex asks for models once initialized");
        auto page = codex.line(R"({"id":2,"result":{"data":[{"id":"gpt-6.1-sol","model":"gpt-6.1-sol","displayName":"GPT-6.1-Sol","description":"Latest workhorse model.","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast"},{"reasoningEffort":"high","description":"Deep"},{"reasoningEffort":"bad effort"}],"defaultReasoningEffort":"low","isDefault":true},{"id":"x","model":"internal-x","displayName":"X","hidden":true,"isDefault":false}],"nextCursor":"c2"}})");
        require(page.find(R"("cursor":"c2")") != std::string::npos && page.find(R"("id":3)") != std::string::npos && !codex.finished(),
                "codex follows the next page");
        codex.line(R"({"id":3,"result":{"data":[{"model":"gpt-6-astra","displayName":"GPT-6-Astra","isDefault":false},{"model":"gpt-6.1-sol","displayName":"dup"}],"nextCursor":null}})");
        auto models = codex.models();
        require(codex.finished() && !codex.failed() && models.size() == 2 && models[0].id == "gpt-6.1-sol" && models[0].is_default &&
                    models[0].name == "GPT-6.1-Sol" && models[1].id == "gpt-6-astra" &&
                    models[0].efforts == std::vector<std::string>{"low", "high"} && models[0].default_effort == "low" && models[1].efforts.empty(),
                "codex models: hidden and duplicate entries dropped");
        dr::AgentModelProbe rejected(AgentKind::Codex);
        rejected.line(R"({"id":1,"error":{"code":-32600,"message":"Not logged in"}})");
        require(rejected.failed() && rejected.error() == "Not logged in", "codex discovery error");
    }
    {
        dr::AgentModelProbe claude(AgentKind::Claude);
        auto args = claude.arguments();
        require(std::find(args.begin(), args.end(), "stream-json") != args.end() && std::find(args.begin(), args.end(), "--no-session-persistence") != args.end() &&
                    claude.start().find(R"("subtype":"initialize")") != std::string::npos,
                "claude lists models through the initialize control request");
        claude.line(R"({"type":"system","subtype":"init"})");
        require(!claude.finished(), "claude waits for its control response");
        claude.line(R"j({"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"commands":[],"models":[{"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default (recommended)"},{"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"Custom Opus model","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"sonnet","resolvedModel":"claude-sonnet-5-5","displayName":"Sonnet 5.5"},{"value":"opus[1m]","resolvedModel":"claude-opus-5-5[1m]","displayName":"Opus (1M context)"},{"value":"bad model","displayName":"Bad"}]}}})j");
        auto models = claude.models();
        require(claude.finished() && models.size() == 3 && models[0].id == "opus" && models[0].is_default && !models[1].is_default &&
                    models[2].id == "opus[1m]" && models[0].efforts.size() == 5 && models[0].efforts.back() == "max" && models[1].efforts.empty(),
                "claude models: aliases kept, default marked, unsafe ids dropped");
        dr::AgentModelProbe rejected(AgentKind::Claude);
        rejected.line(R"({"type":"control_response","response":{"subtype":"error","request_id":"models","error":"Invalid API key"}})");
        require(rejected.failed() && rejected.error() == "Invalid API key", "claude discovery error");
    }
    {
        dr::AgentModelProbe opencode(AgentKind::OpenCode);
        require(opencode.arguments() == std::vector<std::string>{"models", "--verbose"} && !opencode.interactive() && opencode.start().empty(),
                "opencode lists models with `opencode models --verbose`");
        // Verbose output: the id line, then the model object; variants are its reasoning efforts.
        for (auto line : {"opencode/beam-free\r", "{", "  \"name\": \"Beam Free\",", "  \"limit\": {", "    \"context\": 1048576", "  },",
                          "  \"variants\": {", "    \"low\": { \"reasoningEffort\": \"low\" },", "    \"xhigh\": {}, \"max\": {}", "  }", "}\r",
                          "magpie/auto/gpt-5.6-luna", "{", "  \"name\": \"GPT-5.6 Luna\",", "  \"variants\": {}", "}",
                          "", "Warning: something", "opencode/beam-free", "plain/model-without-details"})
            opencode.line(line);
        opencode.end();
        auto models = opencode.models();
        require(models.size() == 3 && models[0].id == "opencode/beam-free" && models[0].name == "Beam Free" &&
                    models[0].efforts == std::vector<std::string>{"low", "xhigh", "max"} && models[1].name == "GPT-5.6 Luna" &&
                    models[1].efforts.empty() && models[2].name == "plain/model-without-details",
                "opencode models: names and variants in the CLI's order");
    }
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
        {
            const std::string input = "&amp;&lt;&gt;&quot;&apos;&#160;&#xA0;&nbsp;&copy;&NotEqualTilde;&unknown;";
            const std::string expected = "&amp;&lt;&gt;&quot;&apos;&#160;&#xA0;&#xA0;&#xA9;&#x2242;&#x338;&unknown;";
            require(dr::xml_compatible_entities(input) == expected, "HTML5 named entities become XML-safe numeric references");
            require(dr::xml_compatible_entities(expected) == expected, "entity normalization is idempotent");
            const std::string raw = R"(<!DOCTYPE html [<!ENTITY example "&nbsp;">]><!-- &copy; --><![CDATA[&nbsp;]]><?test &copy;?>)";
            require(dr::xml_compatible_entities(raw) == raw, "entities in declarations, comments and CDATA remain literal");
            auto entities = dr::split_xhtml("entities.xhtml",
                R"entity(<html><head/><body><h1 id="heading">目&nbsp;&nbsp;录</h1><p title="A&nbsp;B">正文&nbsp;&copy;&NotEqualTilde; &amp;nbsp; &lt;tag&gt;</p><a href="javascript&colon;alert(1)">链接</a></body></html>)entity");
            require(entities.flows[0].title == "目  录\n" && entities.flows[0].text.find("正文 ©≂̸ &nbsp; <tag>") != std::string::npos,
                    "split chapter title and search text contain decoded Unicode, without double decoding literal entities");
            pugi::xml_document parsed;
            require(parsed.load_string(entities.flows[0].html.c_str()), "entity-normalized output remains valid XML");
            const auto paragraph = dr::child_named(dr::child_named(parsed.document_element(), "body"), "p");
            require(std::string(paragraph.attribute("title").value()) == "A B", "attribute entities decode before parsing");
            require(entities.flows[0].html.find("&amp;copy;") == std::string::npos &&
                        entities.flows[0].html.find("javascript") == std::string::npos,
                    "entity output is not double escaped and sanitization sees decoded URL schemes");
        }
        {
            const auto mixed = dr::count_words("你好，世界。Hello, world! don't “well-known” 3.14 1,000 ＡＢＣ 😀 々");
            require(mixed.cjk == 5 && mixed.words == 7 && mixed.punctuation == 7,
                    "Han characters count singly, words by run, punctuation and symbols separately");
            require(dr::count_words("end-  -- 'quote'").words == 2 && dr::count_words("end-  -- 'quote'").punctuation == 5,
                    "joiners only bind letters on both sides");
            pugi::xml_document doc;
            doc.load_string(R"(<html><head><title>标题</title></head><body><p><span>T</span>he <ruby>汉<rp>(</rp><rt>hàn</rt><rp>)</rp></ruby>字</p><p>next</p><script>x</script></body></html>)");
            const auto text = dr::reading_text(doc);
            const auto counted = dr::count_words(text);
            require(counted.words == 2 && counted.cjk == 2 && counted.punctuation == 0,
                    "reading text keeps inline markup contiguous and skips ruby annotations, head and scripts");
            const auto opf = root / "opf-metadata";
            dr::write_file(opf / "META-INF" / "container.xml", R"(<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>)");
            dr::write_file(opf / "OEBPS" / "content.opf", R"(<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><metadata>
<dc:title id="t1">  三体  </dc:title><dc:title id="t2">地球往事</dc:title><meta refines="#t2" property="title-type">subtitle</meta>
<dc:creator id="c2">刘慈欣</dc:creator><meta refines="#c2" property="role" scheme="marc:relators">aut</meta><meta refines="#c2" property="display-seq">1</meta>
<dc:creator id="c3">Ken Liu</dc:creator><meta refines="#c3" property="role" scheme="marc:relators">trl</meta>
<dc:creator opf:role="aut">第二作者</dc:creator>
<dc:publisher>重庆出版社</dc:publisher><dc:date opf:event="modification">2020-01-01</dc:date><dc:date>2008-01-15T00:00:00Z</dc:date>
<dc:language>zh-CN</dc:language><dc:language>und</dc:language><dc:subject>科幻, 小说</dc:subject><dc:subject>小说</dc:subject>
<dc:identifier opf:scheme="ISBN">978-7-5366-9293-0</dc:identifier><dc:identifier>urn:uuid:1234</dc:identifier><dc:identifier>urn:isbn:9787536692931</dc:identifier>
<dc:description>&lt;p&gt;第一段&amp;nbsp;&amp;amp;&lt;/p&gt;&lt;p&gt;第二段&lt;br/&gt;第三行&lt;/p&gt;</dc:description>
<meta property="belongs-to-collection" id="s">地球往事三部曲</meta><meta refines="#s" property="collection-type">series</meta><meta refines="#s" property="group-position">1</meta>
</metadata><manifest/><spine/></package>)");
            const auto meta = dr::read_opf_metadata(opf);
            require(meta["title"] == "三体" && meta["subtitle"] == "地球往事", "main title and refined subtitle");
            require(meta["authors"] == dr::Json::array({"第二作者", "刘慈欣"}), "only aut roles are authors, ordered by display-seq");
            require(meta["contributors"] == dr::Json::array({{{"name", "Ken Liu"}, {"role", "trl"}}}), "translator kept as contributor");
            require(meta["publisher"] == "重庆出版社" && meta["published"] == "2008-01-15", "publisher and publication date");
            require(meta["languages"] == dr::Json::array({"zh-CN"}) && meta["subjects"] == dr::Json::array({"科幻", "小说"}),
                    "languages skip und, subjects split by comma and deduplicate");
            require(meta["identifiers"] == dr::Json::array({{{"scheme", "isbn"}, {"value", "9787536692930"}}}),
                    "ISBN check digits validated, uuid hidden, invalid ISBN dropped");
            require(meta["description"] == "第一段 &\n第二段\n第三行", "escaped HTML description becomes plain paragraphs");
            require(meta["series"] == "地球往事三部曲" && meta["seriesIndex"] == 1.0, "EPUB 3 series collection");
        }
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
        {
            const auto ncx_fixture = root / "ncx-labels.epub";
            const std::string package = R"(<package><metadata><title>NCX labels</title></metadata><manifest><item id="c" href="text.xhtml" media-type="application/xhtml+xml"/><item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="toc"><itemref idref="c"/></spine></package>)";
            const auto fixture = [&](const std::string &ncx) {
                zip(ncx_fixture, {{"META-INF/container.xml", R"(<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>)"},
                    {"OPS/package.opf", package}, {"OPS/text.xhtml", source}, {"OPS/toc.ncx", ncx}});
            };
            std::string ncx = R"(<ncx xmlns:n="urn:ncx"><navMap><navPoint><navLabel><text>第一章&lt;原文&gt;<@>标题 &amp; 名称 <![CDATA[<@>]]></text></navLabel><content src="text.xhtml#start"/><navPoint><navLabel><n:text>)";
            ncx += static_cast<char>(0xc7);
            ncx += R"(第二节 < 5</n:text></navLabel><content src="text.xhtml#end"/></navPoint></navPoint></navMap></ncx>)";
            fixture(ncx);
            auto recovered = dr::import_epub(ncx_fixture, root / "ncx-recovered");
            require(recovered["toc"].size() == 2 && recovered["toc"][0]["title"] == "第一章<原文> 标题 & 名称",
                    "NCX recovers invalid angle markers as separators without double escaping entities or CDATA");
            require(dr::clean_toc_title("第1章<@>无法无动于衷") == "第1章 无法无动于衷" &&
                        dr::clean_toc_title(" A <#> B<*-+>C ") == "A B C",
                    "symbol-only bracket markers become one separating space");
            require(dr::clean_toc_title("第<5>章 <原文> < 5 <@@@@> <> a<b") == "第<5>章 <原文> < 5 <@@@@> <> a<b",
                    "digits, names, spaced or long brackets stay literal");
            require(recovered["toc"][1]["title"] == "�第二节 < 5" && recovered["toc"][1]["depth"] == 1 &&
                        recovered["toc"][1]["href"].get<std::string>().find(".dr-1.xhtml#end") != std::string::npos,
                    "NCX repairs invalid UTF-8 in prefixed labels, preserving hierarchy and remapped links");
            require(!recovered.dump().empty(), "repaired NCX metadata is valid UTF-8 JSON");
            fixture("<ncx><navMap><navPoint><navLabel><text>标题</text></navLabel></navMap></ncx>");
            try
            {
                dr::import_epub(ncx_fixture, root / "ncx-malformed");
                throw std::runtime_error("malformed NCX structure was accepted");
            }
            catch (const std::exception &error)
            {
                require(std::string(error.what()).find("第 1 行") != std::string::npos,
                        "broken NCX structure stays an error and reports its location");
            }
        }
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
        const dr::Json private_shelf = {{"id", "private"}, {"name", "隐私书架"}, {"bookIds", dr::Json::array()}};
        require(library.shelves() == dr::Json::array({private_shelf}), "new library has only the private shelf");
        const auto literature = dr::Json::array({{{"id", "test-shelf"}, {"name", "文学"}, {"bookIds", dr::Json::array({id})}}});
        const auto shelves = dr::Json::array({private_shelf, literature[0]});
        require(library.save_shelves(literature) == shelves, "save shelf membership; the private shelf is kept first");
        rejects([&] { library.save_shelves(dr::Json::array({shelves[1], shelves[1]})); }, "reject duplicate shelves");
        rejects([&] { library.save_shelves(dr::Json::array({{{"id", "x"}, {"name", "隐私书架"}, {"bookIds", dr::Json::array()}}})); },
                "the private shelf name is reserved");
        rejects([&] { library.save_shelves(dr::Json::array({{{"id", "private"}, {"name", "私密"}, {"bookIds", dr::Json::array()}}})); },
                "the private shelf cannot be renamed");
        require(library.shelves() == shelves, "invalid save preserves shelves");
        auto hidden = shelves;
        hidden[0]["bookIds"] = dr::Json::array({id});
        require(library.save_shelves(hidden) == hidden, "hiding a book stores it in the private shelf");
        dr::write_file(root / "legacy-shelves" / "shelves.json",
                       R"([{"id":"a","name":"文学","bookIds":[]},{"id":"old","name":"隐私书架","bookIds":[]}])");
        {
            dr::Library legacy(root / "legacy-shelves");
            const auto adopted = legacy.shelves();
            require(adopted.size() == 2 && adopted[0]["id"] == "private" && adopted[1]["id"] == "a",
                    "an existing shelf with the reserved name becomes the private shelf");
        }
        auto covered_shelves = shelves;
        covered_shelves[1]["cover"] = {{"bookId", id}};
        require(library.save_shelves(covered_shelves) == covered_shelves, "book cover persists");
        covered_shelves[1]["cover"] = {{"image", "data:image/webp;base64,UklGRg=="}};
        require(library.save_shelves(covered_shelves) == covered_shelves, "uploaded cover persists");
        covered_shelves[1]["cover"] = {{"image", "file:///private.png"}};
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
            {
                // A book imported before TOC title cleaning keeps its "<@>" marker on disk.
                const auto file = root / "library" / "books" / id / "book.json";
                auto stored = dr::Json::parse(dr::read_file(file));
                stored["toc"][0]["title"] = "第一节<@>旧标题";
                stored.erase("tocTitleVersion");
                dr::write_file(file, stored.dump(2));
                const auto migrated = reopened.get(id);
                const auto saved = dr::Json::parse(dr::read_file(file));
                require(migrated["toc"][0]["title"] == "第一节 旧标题" && saved["toc"][0]["title"] == "第一节 旧标题" &&
                            saved["tocTitleVersion"] == dr::toc_title_version && saved["position"] == stored["position"] &&
                            saved["progress"] == stored["progress"],
                        "old TOC titles are cleaned once in place, keeping reading position");
            }
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
            // Chapters read "一开头文字跳转" and "二结尾文字"; the <title> in head is not text.
            auto info = reopened.info(id);
            require(info["title"] == "测试书" && info["authors"] == dr::Json::array({"测试作者"}) &&
                        info["chapters"] == 2 && info["words"]["cjk"] == 12 &&
                        info["words"]["withPunctuation"] == 12 && info["words"]["withoutPunctuation"] == 12,
                    "book info reads cached OPF metadata and counts every chapter");
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
        require(dr::parse_settings_toml(dr::format_settings_toml(defaults)) == defaults,
                "all default settings round trip through TOML");
        {
            const auto config_root = root / "配置迁移";
            dr::Library migration(config_root);
            auto old_settings = dr::patch_settings(defaults, {
                {"application", {{"librarySort", "author"}, {"theme", "dark"}}},
                {"reading", {{"fontFamily", "中文字体 \"测试\""}, {"fontSize", 26}}},
                {"window", {{"widthRatio", 0.7}, {"heightRatio", 0.8}}}
            });
            dr::write_file(config_root / "settings.json", old_settings.dump(2));
            require(migration.settings() == old_settings && dr::fs::exists(config_root / "config.toml"),
                    "legacy JSON settings migrate to TOML, including Unicode strings and window ratios");
            require(dr::read_file(config_root / "settings.json") == old_settings.dump(2),
                    "migration preserves the original JSON backup");
            dr::write_file(config_root / "settings.json", defaults.dump());
            dr::Library reopened(config_root);
            require(reopened.settings() == old_settings, "TOML takes precedence over legacy JSON");
            auto changed = reopened.save_settings({{"application", {{"librarySort", "read"}, {"dictionaries", dr::Json::array()}}}});
            require(dr::parse_settings_toml(dr::read_file(config_root / "config.toml")) == changed &&
                        changed["application"]["dictionaries"].empty(),
                    "settings changes and empty arrays persist in TOML");
            dr::write_file(config_root / "config.toml", "# manual edits\n[application]\nlibrarySort = 'title'\n[window]\nwidthRatio = 0.65\nheightRatio = 0.75\n");
            auto manual = reopened.settings();
            require(manual["application"]["librarySort"] == "title" && manual["window"]["widthRatio"] == 0.65 &&
                        manual["reading"] == defaults["reading"], "manual TOML edits load with defaults for omitted settings");
            const std::string broken = "[application\nlibrarySort = 'title'\n";
            dr::write_file(config_root / "config.toml", broken);
            rejects([&] { reopened.save_settings({{"application", {{"librarySort", "read"}}}}); },
                    "malformed TOML is reported before saving");
            require(dr::read_file(config_root / "config.toml") == broken, "malformed TOML is never overwritten");
            rejects([&] { dr::parse_settings_toml("[window]\nwidthRatio = 'wide'\n"); }, "window ratios must be numeric");
        }

        require(defaults["application"]["librarySort"] == "added", "library defaults to recently added");
        for (const auto *sort : {"added", "read", "title", "author"})
        {
            library.save_settings({{"application", {{"librarySort", sort}}}});
            dr::Library reopened(root / "library");
            require(reopened.settings()["application"]["librarySort"] == sort,
                    "library sort survives reopening the library");
        }
        rejects([&] { library.save_settings({{"application", {{"librarySort", "invalid"}}}}); },
                "invalid library sort is rejected");
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
        require(library.export_notes(id).empty(), "a book without notes has nothing to export");
        library.save_annotation(id, {{"chapter", 1}, {"href", annotation_href},
                                    {"start", 0}, {"end", 8}, {"quote", "结尾文字\n第二行"},
                                    {"style", "underline"}, {"note", "重点 *内容* <tag>\n下一行"}});
        const auto markdown = library.export_notes_markdown(id);
        require(markdown.starts_with("# 测试书\n") && markdown.find("> 结尾文字\n> 第二行") != markdown.npos &&
                    markdown.find("标注：下划线") != markdown.npos && markdown.find("重点 \\*内容\\* \\<tag\\>") != markdown.npos,
                "Markdown export contains the book, quoted passage, mark type and safely escaped multiline note");
        rejects([&] { library.export_notes("../invalid"); }, "export rejects an unsafe book ID");
        {
            library.save_annotation(id, {{"chapter", 1}, {"href", annotation_href},
                {"start", 8}, {"end", 10}, {"quote", "🚀"}, {"prefix", "正文前"}, {"suffix", "正文后"},
                {"style", "highlight"}, {"color", "#ddedea"}, {"note", "中文与 emoji 🚀\n<tag> & \"引号\""}});
            library.save_annotation(id, {{"chapter", 1}, {"href", annotation_href},
                {"start", 10}, {"end", 12}, {"quote", "笔记"}, {"style", "note"}, {"note", "只留笔记"}});
            const auto original = library.annotations(id);
            const auto backup = library.export_notes(id);
            const auto archive = dr::Json::parse(backup);
            require(archive["type"] == "dr-reader-notes" && archive["version"] == 1 &&
                        archive["book"]["id"] == id && archive["annotations"] == original,
                    "versioned backup preserves all annotation data");
            dr::Json restored_snapshot;
            {
                dr::Library restored(root / "notes-restore");
                require(restored.import_book(epub)["id"] == id, "backup targets the same original EPUB in another library");
                restored.save_position(id, {{"chapter", 1}, {"ratio", 0.37}});
                restored.save_shelves(literature);
                restored.toggle_bookmark(id, {{"chapter", 1}, {"ratio", 0.6}, {"title", "保留书签"}});
                const auto local = restored.save_annotation(id, {{"chapter", 1}, {"href", annotation_href},
                    {"start", 20}, {"end", 22}, {"quote", "本地"}, {"note", "保留已有笔记"}});
                const auto book_before = restored.get(id), shelves_before = restored.shelves();
                require(restored.import_notes(id, backup) == dr::Json({{"imported", 3}, {"skipped", 0}}),
                        "import restores every annotation in a separate library");
                auto notes = restored.annotations(id);
                require(notes.size() == 4 && std::find(notes.begin(), notes.end(), local) != notes.end(),
                        "import adds notes without deleting local notes");
                for (const auto &note : original)
                    require(std::find(notes.begin(), notes.end(), note) != notes.end(),
                            "round trip preserves IDs, UTF-16 offsets, contexts, styles, colors, text and timestamps");
                require(restored.import_notes(id, backup) == dr::Json({{"imported", 0}, {"skipped", 3}}),
                        "repeated import is idempotent");
                auto edited = original[0]; edited["note"] = "本地修改优先";
                const auto saved_edit = restored.save_annotation(id, edited);
                restored.import_notes(id, backup);
                notes = restored.annotations(id);
                require(std::find(notes.begin(), notes.end(), saved_edit) != notes.end(), "old backup never overwrites local edits");
                auto invalid = archive;
                invalid["version"] = 2;
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "unknown backup version rejected");
                invalid = archive; invalid["book"]["id"] = "another-book";
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "backup for another EPUB rejected");
                invalid = archive; invalid["book"]["chapters"][0] = "different-layout.xhtml";
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "changed chapter layout rejected");
                invalid = archive; invalid["annotations"][0]["href"] = "wrong-chapter.xhtml";
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "foreign chapter anchor rejected");
                invalid = archive; invalid["annotations"][0]["start"] = 0.5;
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "fractional text positions rejected");
                invalid = archive; invalid["annotations"][0]["createdAt"] = uint64_t(-1);
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "overflowing timestamp rejected even for duplicate ID");
                // The first row is inserted before the second fails SQLite-side validation.
                // Both rows must roll back, including with the same import retried later.
                invalid = archive;
                invalid["annotations"] = dr::Json::array({original[0], original[1]});
                invalid["annotations"][0]["id"] = "rollback-first";
                invalid["annotations"][1]["id"] = "rollback-second";
                invalid["annotations"][1]["color"] = "invalid-color";
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "invalid batch fails atomically");
                require(restored.annotations(id) == notes, "a failed batch leaves no partial annotation writes");
                invalid["annotations"][1]["color"] = original[1]["color"];
                require(restored.import_notes(id, invalid.dump()) == dr::Json({{"imported", 2}, {"skipped", 0}}),
                        "a corrected batch can be retried after rollback");
                invalid = archive; invalid["annotations"] = dr::Json::array();
                require(restored.import_notes(id, invalid.dump()) == dr::Json({{"imported", 0}, {"skipped", 0}}),
                        "empty backup is a no-op");
                require(restored.import_notes(id, std::string("\xef\xbb\xbf") + backup)["skipped"] == 3,
                        "UTF-8 BOM backup is accepted");
                invalid = archive;
                invalid["annotations"] = dr::Json::array({original[0], original[0]});
                for (auto &note : invalid["annotations"]) note["id"] = "duplicate-within-file";
                require(restored.import_notes(id, invalid.dump()) == dr::Json({{"imported", 1}, {"skipped", 1}}),
                        "duplicate IDs inside a backup are imported once");
                {
                    dr::AnnotationStore store(root / "notes-restore" / "reader.sqlite3");
                    auto foreign = original[0]; foreign.erase("id");
                    const auto saved_foreign = store.save("another-book", foreign);
                    invalid = archive; invalid["annotations"][0]["id"] = saved_foreign["id"];
                    const auto before_collision = restored.annotations(id);
                    rejects([&] { restored.import_notes(id, invalid.dump()); }, "ID collision with another book rejected");
                    require(restored.annotations(id) == before_collision && store.list("another-book")[0] == saved_foreign,
                            "ID collision preserves both books");
                }
                rejects([&] { restored.import_notes(id, "{broken json"); }, "broken backup rejected");
                rejects([&] { restored.import_notes(id, markdown); }, "legacy Markdown is not guessed into positions");
                rejects([&] { restored.import_notes(id, std::string(dr::Library::notes_max_bytes + 1, ' ')); },
                        "oversized backup rejected");
                require(restored.get(id) == book_before && restored.shelves() == shelves_before,
                        "import preserves reading position, bookmarks, categories and metadata");
                require(library.annotations(id) == original, "source library is unchanged by restoration");
                restored_snapshot = restored.annotations(id);
            }
            dr::Library reopened(root / "notes-restore");
            require(reopened.annotations(id) == restored_snapshot, "restored annotations persist after reopening the library");
        }
        {
            // AI 问书 conversations: saved per book, summarised, exported and restored with the notes.
            const auto messages = dr::Json::array({
                {{"role", "user"}, {"text", "这句话想表达什么？"}, {"quote", "结尾文字"}},
                {{"role", "assistant"}, {"text", "## 要点\n回答 *Markdown*"}, {"agent", "claude"}, {"label", "Claude Code"},
                 {"model", "opus"}, {"effort", "high"}}});
            const auto first = library.save_agent_session(id, {{"id", "session-one"}, {"title", "这句话想表达什么？"}, {"messages", messages}});
            require(first["messages"].size() == 2 && first["messages"][1]["effort"] == "high" && first["messages"][0]["quote"] == "结尾文字" &&
                        first["messages"][1]["stopped"] == false && first["createdAt"].get<int64_t>() > 0 && first["bookId"] == id,
                    "conversation saved with its messages");
            auto longer = messages;
            longer.push_back({{"role", "user"}, {"text", "再举个例子"}});
            longer.push_back({{"role", "assistant"}, {"text", "例子"}, {"stopped", true}, {"label", "Codex"}, {"agent", "codex"}});
            library.save_agent_session(id, {{"id", "session-two"}, {"title", "第二段"}, {"messages", messages}});
            library.save_agent_session(id, {{"id", "session-one"}, {"title", "这句话想表达什么？"}, {"messages", longer}});
            auto list = library.agent_sessions(id);
            auto one = std::find_if(list.begin(), list.end(), [](auto &session) { return session["id"] == "session-one"; });
            require(list.size() == 2 && one != list.end() && (*one)["messageCount"] == 4 && !one->contains("messages"),
                    "summaries count messages without loading them");
            require(library.agent_session(id, "session-one")["messages"][3]["stopped"] == true, "a later save replaces the messages");
            rejects([&] { library.agent_session(id, "missing"); }, "missing conversation");
            rejects([&] { library.agent_sessions("../invalid"); }, "conversations need a valid book");
            rejects([&] { library.save_agent_session(id, {{"id", "bad id"}, {"messages", messages}}); }, "unsafe conversation id");
            rejects([&] { library.save_agent_session(id, {{"id", "x"}, {"messages", dr::Json::array()}}); }, "empty conversation");
            auto invalid_messages = messages;
            invalid_messages[0]["role"] = "system";
            rejects([&] { library.save_agent_session(id, {{"id", "x"}, {"messages", invalid_messages}}); }, "unknown role");
            invalid_messages = messages;
            invalid_messages[1]["model"] = "a;b";
            rejects([&] { library.save_agent_session(id, {{"id", "x"}, {"messages", invalid_messages}}); }, "unsafe model in a conversation");
            require(library.agent_sessions(id).size() == 2, "rejected conversations are not saved");

            const auto backup = dr::Json::parse(library.export_notes(id));
            require(backup["conversations"].size() == 2 && backup["conversations"][0]["id"] == "session-one" &&
                        backup["conversations"][0]["messages"].size() == 4 && !backup["conversations"][0].contains("messageCount"),
                    "the backup carries every conversation");
            const auto text = library.export_notes_markdown(id);
            require(text.find("## AI 问书") != text.npos && text.find("**读者**：这句话想表达什么？") != text.npos &&
                        text.find("> 结尾文字") != text.npos && text.find("#### 要点") != text.npos &&
                        text.find("**Codex**（回答被中途停止）：") != text.npos,
                    "Markdown export appends the conversations with demoted headings");
            {
                dr::Library restored(root / "conversation-restore");
                restored.import_book(epub);
                auto result = restored.import_notes(id, backup.dump());
                require(result["conversationsImported"] == 2 && result["conversationsSkipped"] == 0 && result["imported"] == backup["annotations"].size(),
                        "import restores conversations together with the notes");
                require(restored.agent_session(id, "session-one") == library.agent_session(id, "session-one"),
                        "round trip preserves conversation text, settings and timestamps");
                restored.save_agent_session(id, {{"id", "session-two"}, {"title", "本地修改"}, {"messages", messages}});
                result = restored.import_notes(id, backup.dump());
                require(result["conversationsImported"] == 0 && result["conversationsSkipped"] == 2 &&
                            restored.agent_session(id, "session-two")["title"] == "本地修改",
                        "import never overwrites local conversations");
                auto invalid = backup;
                invalid["conversations"][0]["id"] = "new-one";
                invalid["conversations"][1]["id"] = "new-two";
                invalid["conversations"][1]["messages"][0]["role"] = "system";
                const auto sessions_before = restored.agent_sessions(id);
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "an invalid conversation fails the import");
                require(restored.agent_sessions(id) == sessions_before, "a failed import writes no conversation");
                invalid = backup;
                invalid["conversations"][0]["bookId"] = "another-book";
                rejects([&] { restored.import_notes(id, invalid.dump()); }, "conversations of another book rejected");
                invalid = backup;
                invalid.erase("conversations");
                require(!restored.import_notes(id, invalid.dump()).contains("conversationsImported"), "backups without conversations import as before");
            }
            library.remove_agent_session(id, "session-two");
            require(library.agent_sessions(id).size() == 1, "a conversation can be deleted");
            rejects([&] { library.remove_agent_session(id, "session-two"); }, "a deleted conversation is gone");
        }
        library.toggle_bookmark(id, {{"chapter", 1}, {"ratio", 0.4}});
        rejects([&] { library.remove_book("../library"); }, "reject unsafe deletion ID");
        require(library.list().size() == 1, "invalid deletion preserves library");
        {
            dr::AnnotationStore store(root / "library" / "reader.sqlite3");
            store.toggle_bookmark("another-book", {{"chapter", 0}, {"ratio", 0.2}});
            store.save_agent_session("another-book", {{"id", "other-session"}, {"messages", {{{"role", "user"}, {"text", "问"}}}}});
            require(!store.agent_sessions(id).empty(), "the book has a conversation before deletion");
            library.remove_book(id);
            require(store.list(id).empty() && store.bookmarks(id).empty() && store.agent_sessions(id).empty(), "delete book reading data and conversations");
            require(store.bookmarks("another-book").size() == 1 && store.agent_sessions("another-book").size() == 1, "preserve other book data");
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
        agent_checks();
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
