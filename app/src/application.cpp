#include "application.h"
#include "../resource.h"
#include "dr/settings.h"
#include <algorithm>
#include <cmath>
#include <optional>
#include <shobjidl.h>
#include <stdexcept>
#include <set>
#include <shellapi.h>
namespace dr
{
namespace {
Json installed_icon_glyphs()
{
    Json result = {{"Segoe Fluent Icons", Json::array()}, {"Segoe MDL2 Assets", Json::array()}};
    Microsoft::WRL::ComPtr<IDWriteFactory> factory;
    Microsoft::WRL::ComPtr<IDWriteFontCollection> collection;
    if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
            reinterpret_cast<IUnknown **>(factory.GetAddressOf()))) ||
        FAILED(factory->GetSystemFontCollection(&collection))) return result;
    // Probe the icon range in one call per installed face; glyph index zero means missing.
    std::vector<UINT32> codepoints;
    for (UINT32 code = 0xe700; code <= 0xf8ff; ++code) codepoints.push_back(code);
    std::vector<UINT16> indices(codepoints.size());
    for (const auto *name : {L"Segoe Fluent Icons", L"Segoe MDL2 Assets"})
    {
        UINT32 index = 0;
        BOOL exists = FALSE;
        Microsoft::WRL::ComPtr<IDWriteFontFamily> family;
        Microsoft::WRL::ComPtr<IDWriteFont> font;
        Microsoft::WRL::ComPtr<IDWriteFontFace> face;
        if (FAILED(collection->FindFamilyName(name, &index, &exists)) || !exists ||
            FAILED(collection->GetFontFamily(index, &family)) ||
            FAILED(family->GetFirstMatchingFont(DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                DWRITE_FONT_STYLE_NORMAL, &font)) || FAILED(font->CreateFontFace(&face)) ||
            FAILED(face->GetGlyphIndices(codepoints.data(), static_cast<UINT32>(codepoints.size()), indices.data()))) continue;
        auto &available = result[narrow(name)];
        for (size_t i = 0; i < indices.size(); ++i)
            if (indices[i]) available.push_back(codepoints[i]);
    }
    return result;
}
Json installed_fonts(){Microsoft::WRL::ComPtr<IDWriteFactory> factory;Json result=Json::array();if(FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED,__uuidof(IDWriteFactory),reinterpret_cast<IUnknown**>(factory.GetAddressOf()))))return result;
 Microsoft::WRL::ComPtr<IDWriteFontCollection> collection;if(FAILED(factory->GetSystemFontCollection(&collection)))return result;std::set<std::string> names;
 for(UINT32 i=0;i<collection->GetFontFamilyCount();++i){Microsoft::WRL::ComPtr<IDWriteFontFamily> family;Microsoft::WRL::ComPtr<IDWriteLocalizedStrings> localized;if(FAILED(collection->GetFontFamily(i,&family))||FAILED(family->GetFamilyNames(&localized)))continue;UINT32 index=0;BOOL exists=FALSE;localized->FindLocaleName(L"zh-cn",&index,&exists);if(!exists)localized->FindLocaleName(L"en-us",&index,&exists);if(!exists)index=0;UINT32 length=0;localized->GetStringLength(index,&length);std::wstring name(length+1,L'\0');if(SUCCEEDED(localized->GetString(index,name.data(),length+1))){name.resize(length);names.insert(narrow(name));}}
 for(auto& name:names)result.push_back(name);return result;}
void copy_text(HWND owner,const std::string& text){if(text.size()>65536)throw std::runtime_error("复制内容过长");auto wide=widen(text);auto bytes=(wide.size()+1)*sizeof(wchar_t);HGLOBAL memory=GlobalAlloc(GMEM_MOVEABLE,bytes);if(!memory)throw std::runtime_error("无法分配剪贴板内存");auto data=GlobalLock(memory);if(!data){GlobalFree(memory);throw std::runtime_error("无法锁定剪贴板内存");}memcpy(data,wide.c_str(),bytes);GlobalUnlock(memory);
 if(!OpenClipboard(owner)){GlobalFree(memory);throw std::runtime_error("剪贴板正被其他程序使用");}EmptyClipboard();if(!SetClipboardData(CF_UNICODETEXT,memory)){CloseClipboard();GlobalFree(memory);throw std::runtime_error("无法写入剪贴板");}CloseClipboard();}
// One argument as CommandLineToArgvW reads it back: quoted, inner quotes and the backslashes
// before them escaped.
std::wstring command_line_argument(const std::wstring &text)
{
    std::wstring quoted = L"\"";
    size_t backslashes = 0;
    for (wchar_t c : text)
    {
        if (c == L'\\') { ++backslashes; quoted += c; continue; }
        if (c == L'"') quoted.append(backslashes + 1, L'\\');
        backslashes = 0;
        quoted += c;
    }
    quoted.append(backslashes, L'\\');
    return quoted + L"\"";
}
// The selected text's box from the page (CSS pixels of the WebView's viewport, see
// selectionLineRect in web/reader.ts) in screen pixels, or nothing when the page sent none or a
// box that makes no sense. `content` is where the WebView sits in the window's client area.
std::optional<RECT> selection_screen_rect(HWND window, RECT content, const Json &params)
{
    if (!params.contains("rect") || !params["rect"].is_object()) return std::nullopt;
    const auto &rect = params["rect"];
    const double scale = params.contains("scale") && params["scale"].is_number() ? params["scale"].get<double>() : 0;
    if (!std::isfinite(scale) || scale <= 0 || scale > 16) return std::nullopt;
    double side[4]{};
    const char *names[4]{"left", "top", "right", "bottom"};
    for (int i = 0; i < 4; ++i)
    {
        if (!rect.contains(names[i]) || !rect[names[i]].is_number()) return std::nullopt;
        side[i] = rect[names[i]].get<double>();
        if (!std::isfinite(side[i]) || std::abs(side[i]) > 100000) return std::nullopt;
    }
    if (side[0] > side[2] || side[1] > side[3]) return std::nullopt;
    POINT origin{content.left, content.top};
    if (!ClientToScreen(window, &origin)) return std::nullopt;
    return RECT{origin.x + static_cast<LONG>(std::floor(side[0] * scale)),
                origin.y + static_cast<LONG>(std::floor(side[1] * scale)),
                origin.x + static_cast<LONG>(std::ceil(side[2] * scale)),
                origin.y + static_cast<LONG>(std::ceil(side[3] * scale))};
}
// “查词典”: shows the word in DR Dict's lookup popup (../dr-dict, app/src/popup.h). With the
// selection's box the popup opens right below the text (DR Dict's "caret" anchor, flipped above
// when there is no room); otherwise beside the pointer, which is on the selection menu just
// clicked. The caret-anchored popup is not near the pointer, so it is sent as "keyboard": DR Dict
// then skips its pointer-leave auto-hide (which would close it at once) and closes it on Esc, a
// click elsewhere or focus moving on. A running DR Dict is asked through WM_COPYDATA to its popup
// host; otherwise DR Dict is started with --lookup, found through the App Paths entry DR Dict
// registers when it runs.
void lookup_in_dr_dict(HWND owner, const std::string &word, const std::optional<RECT> &caret)
{
    constexpr ULONG_PTR lookup_request = 0x4B4C5244; // "DRLK", DR Dict's dr::lookup_request
    POINT at{};
    GetCursorPos(&at);
    if (HWND popup = FindWindowW(L"DrDictPopup", nullptr))
    {
        DWORD process = 0;
        GetWindowThreadProcessId(popup, &process);
        AllowSetForegroundWindow(process); // so the popup may take focus from us
        Json request{{"word", word}, {"x", at.x}, {"y", at.y}};
        if (caret)
        {
            request["caret"] = Json::array({caret->left, caret->top, caret->right, caret->bottom});
            request["keyboard"] = true;
        }
        const auto payload = request.dump();
        COPYDATASTRUCT data{lookup_request, static_cast<DWORD>(payload.size()), const_cast<char *>(payload.data())};
        DWORD_PTR handled = 0;
        if (SendMessageTimeoutW(popup, WM_COPYDATA, reinterpret_cast<WPARAM>(owner), reinterpret_cast<LPARAM>(&data),
                                SMTO_ABORTIFHUNG, 3000, &handled) && handled)
            return;
    }
    auto arguments = L"--lookup " + command_line_argument(widen(word));
    if (caret)
        arguments += L" --caret " + std::to_wstring(caret->left) + L"," + std::to_wstring(caret->top) + L"," +
                     std::to_wstring(caret->right) + L"," + std::to_wstring(caret->bottom) + L" --keyboard";
    SHELLEXECUTEINFOW info{sizeof(info)};
    info.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
    info.hwnd = owner;
    info.lpVerb = L"open";
    info.lpFile = L"dr-dict.exe";
    info.lpParameters = arguments.c_str();
    info.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&info))
        throw std::runtime_error("未找到 DR Dict，请先运行一次 DR Dict");
}
// Matches the toolbar: titles past 20 characters (code points, not UTF-16 units) end in an ellipsis.
std::wstring short_title(const std::wstring& title,size_t max=20){size_t count=0;for(size_t i=0;i<title.size();++i){if(IS_LOW_SURROGATE(title[i]))continue;if(count++==max)return title.substr(0,i)+L"…";}return title;}
bool is_epub(const fs::path &path)
{
    return _wcsicmp(path.extension().c_str(), L".epub") == 0;
}
// The books among files dropped from Explorer: EPUB files as given, and the EPUB files inside
// dropped folders (recursively, in path order), as calibre's "add books from directories"
// collects them (gui2/add.py, ebooks/metadata/meta.py find_books_in_directory). Other files
// are reported rather than silently ignored.
std::vector<fs::path> dropped_books(const std::vector<fs::path> &dropped, Json &errors)
{
    std::vector<fs::path> books;
    std::set<fs::path> seen;
    auto add = [&](const fs::path &path) { if (seen.insert(path).second) books.push_back(path); };
    for (auto &path : dropped)
    {
        std::error_code error;
        if (fs::is_directory(path, error))
        {
            std::vector<fs::path> found;
            for (fs::recursive_directory_iterator it(path, fs::directory_options::skip_permission_denied, error), end;
                 !error && it != end; it.increment(error))
                if (is_epub(it->path()) && it->is_regular_file(error)) found.push_back(it->path());
            if (error) errors.push_back(utf8(path.filename()) + ": 无法读取文件夹");
            else if (found.empty()) errors.push_back(utf8(path.filename()) + ": 文件夹中没有 EPUB 文件");
            std::sort(found.begin(), found.end());
            for (auto &book : found) add(book);
        }
        else if (!is_epub(path))
            errors.push_back(utf8(path.filename()) + ": 不是 EPUB 文件");
        else
            add(path);
    }
    return books;
}
ShellStyle shell_style(const std::string &shell)
{
    return shell == "direct2d" ? ShellStyle::Direct2D : shell == "webview2" ? ShellStyle::WebView2 : ShellStyle::Mica;
}
}
Application::Application(fs::path root, fs::path assets, std::vector<fs::path> files, std::string shell)
    : library_(std::move(root)), assets_(std::move(assets)), initial_files_(std::move(files)),
      shell_override_(std::move(shell)), thread_([this](std::stop_token stop) { worker(stop); })
{
}
Application::~Application()
{
    thread_.request_stop();
    wake_.notify_all();
    if (thread_.joinable())
        thread_.join();
}
void Application::worker(std::stop_token stop)
{
    while (true)
    {
        std::function<void()> work;
        {
            std::unique_lock lock(mutex_);
            wake_.wait(lock, stop, [this] { return !queue_.empty(); });
            if (queue_.empty())
                return;
            work = std::move(queue_.front());
            queue_.pop();
        }
        work();
    }
}
void Application::enqueue(std::function<void()> work)
{
    {
        std::lock_guard lock(mutex_);
        queue_.push(std::move(work));
    }
    wake_.notify_one();
}
void Application::apply_settings(const Json &s)
{
    auto app=s.at("application");
    window_.set_style(shell_style(app.value("shell", std::string("mica"))));
    window_.set_theme(app.value("theme", std::string("light")));
    webview_.set_theme(window_.resolved_theme());
    if (page_ready_) webview_.set_background(window_.background());
}
void Application::release_cursor()
{
    if (!cursor_releasing_) return;
    cursor_releasing_ = false;
    cursor_hold_ = nullptr;
    window_.update_cursor();
}
void Application::send_caption()
{
    const auto state = window_.caption_state();
    const double scale = 96.0 / GetDpiForWindow(window_.handle());
    const char *hot = state.hot == HTMINBUTTON ? "minimize" : state.hot == HTMAXBUTTON ? "maximize"
                    : state.hot == HTCLOSE ? "close" : "";
    Json caption{{"event", "caption"}, {"visible", state.visible}, {"height", state.height * scale},
                 {"buttonWidth", state.button_width * scale}, {"hot", hot}, {"maximized", state.maximized},
                 {"title", narrow(state.title)}};
    if (caption == last_caption_) return;
    last_caption_ = caption;
    webview_.send(caption);
}
std::vector<fs::path> Application::pick_books()
{
    std::vector<fs::path> files;
    Microsoft::WRL::ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))))
        throw std::runtime_error("无法打开文件选择器");
    COMDLG_FILTERSPEC filters[] = {{L"EPUB 电子书", L"*.epub"}};
    dialog->SetFileTypes(1, filters);
    dialog->SetTitle(L"添加 EPUB 到书库");
    DWORD options = 0;
    if (FAILED(dialog->GetOptions(&options)) ||
        FAILED(dialog->SetOptions(options | FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM)))
        throw std::runtime_error("无法启用图书多选");
    auto hr = dialog->Show(window_.handle());
    if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED))
        return files;
    if (FAILED(hr))
        throw std::runtime_error("文件选择失败");
    Microsoft::WRL::ComPtr<IShellItemArray> items;
    DWORD count = 0;
    if (FAILED(dialog->GetResults(&items)) || FAILED(items->GetCount(&count)))
        throw std::runtime_error("无法取得选中的图书列表");
    files.reserve(count);
    for (DWORD i = 0; i < count; ++i)
    {
        Microsoft::WRL::ComPtr<IShellItem> item;
        if (FAILED(items->GetItemAt(i, &item)))
            throw std::runtime_error("无法取得选中的图书");
        LPWSTR path = nullptr;
        if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)))
            throw std::runtime_error("无法取得选中图书的文件路径");
        fs::path selected(path);
        CoTaskMemFree(path);
        files.push_back(std::move(selected));
    }
    return files;
}
fs::path Application::pick_notes_path(const std::string &title, bool &markdown)
{
    Microsoft::WRL::ComPtr<IFileSaveDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))))
        throw std::runtime_error("无法打开笔记保存窗口");
    const COMDLG_FILTERSPEC filters[] = {{L"DR Reader 笔记备份 (*.drnotes)", L"*.drnotes"},
                                        {L"Markdown 笔记与对话（仅供阅读） (*.md)", L"*.md"}};
    dialog->SetFileTypes(2, filters);
    dialog->SetDefaultExtension(L"drnotes");
    dialog->SetTitle(L"导出阅读笔记与 AI 对话");
    auto filename = widen(title);
    for (auto &c : filename)
        if (c < 32 || std::wstring_view(L"<>:\"/\\|?*").find(c) != std::wstring_view::npos) c = L'_';
    filename = filename.substr(0, 100) + L" - 阅读笔记";
    dialog->SetFileName(filename.c_str());
    FILEOPENDIALOGOPTIONS options{};
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT | FOS_PATHMUSTEXIST);
    const auto result = dialog->Show(window_.handle());
    if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {};
    if (FAILED(result)) throw std::runtime_error("无法保存笔记");
    Microsoft::WRL::ComPtr<IShellItem> item;
    PWSTR path = nullptr;
    if (FAILED(dialog->GetResult(&item)) || FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)))
        throw std::runtime_error("无法取得笔记保存路径");
    fs::path destination(path);
    CoTaskMemFree(path);
    UINT type = 1;
    if (FAILED(dialog->GetFileTypeIndex(&type))) throw std::runtime_error("无法取得笔记导出格式");
    markdown = type == 2;
    // An explicitly typed known extension also selects its format.
    if (_wcsicmp(destination.extension().c_str(), L".md") == 0) markdown = true;
    else if (_wcsicmp(destination.extension().c_str(), L".drnotes") == 0) markdown = false;
    return destination;
}
fs::path Application::pick_notes_import_path()
{
    Microsoft::WRL::ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))))
        throw std::runtime_error("无法打开笔记文件选择窗口");
    const COMDLG_FILTERSPEC filters[] = {{L"DR Reader 笔记备份 (*.drnotes)", L"*.drnotes"}};
    dialog->SetFileTypes(1, filters);
    dialog->SetTitle(L"导入阅读笔记");
    FILEOPENDIALOGOPTIONS options{};
    if (FAILED(dialog->GetOptions(&options)) ||
        FAILED(dialog->SetOptions((options & ~FOS_ALLOWMULTISELECT) | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST)))
        throw std::runtime_error("无法配置笔记文件选择窗口");
    const auto result = dialog->Show(window_.handle());
    if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {};
    if (FAILED(result)) throw std::runtime_error("笔记文件选择失败");
    Microsoft::WRL::ComPtr<IShellItem> item;
    PWSTR path = nullptr;
    if (FAILED(dialog->GetResult(&item)) || FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)))
        throw std::runtime_error("无法取得笔记文件路径");
    fs::path source(path);
    CoTaskMemFree(path);
    return source;
}
void Application::receive(const Json &request, std::vector<fs::path> dropped)
{
    if (!request.is_object() || !request.contains("id") || !request["id"].is_number_unsigned() ||
        !request.contains("method") || !request["method"].is_string())
        return;
    auto id = request["id"];
    auto method = request["method"].get<std::string>();
    auto params = request.value("params", Json::object());
    if (method == "ready")
    {
        // The page has rendered the library (or failed to load it) and covers the window's
        // startup placeholder, which no longer needs drawing behind the transparent view.
        window_.set_placeholder(false);
        // The page now paints an opaque body. An opaque default background lets Chromium keep
        // subpixel (ClearType) text in the composition-hosted view.
        page_ready_ = true;
        webview_.set_background(window_.background());
        last_caption_ = nullptr;
        send_caption();
        webview_.send({{"id", id}, {"result", true}});
        return;
    }
    if (method == "fullscreen")
    {
        const bool enabled = params.value("enabled", !window_.fullscreen());
        window_.set_fullscreen(enabled);
        webview_.send({{"event", "fullscreen"}, {"enabled", enabled}});
        webview_.send({{"id", id}, {"result", enabled}});
        return;
    }
    if (method == "titlebar")
    {
        const bool hidden = params.value("hidden", !window_.borderless());
        window_.set_borderless(hidden);
        webview_.send({{"event", "titlebar"}, {"hidden", hidden}});
        webview_.send({{"id", id}, {"result", hidden}});
        return;
    }
    if (method == "cursor.hold")
    {
        // While a page drag relayouts the book, Chromium briefly reports the book frame's own
        // cursor. The page holds the drag's cursor here until its layout has settled.
        const auto cursor = params.value("cursor", std::string());
        if (cursor == "ew-resize")
        {
            cursor_hold_ = LoadCursorW(nullptr, IDC_SIZEWE);
            cursor_hold_id_ = 32644; // OCR_SIZEWE
            cursor_releasing_ = false;
            cursor_released_up_ = false;
            window_.update_cursor();
        }
        else if (cursor.empty())
        {
            // Chromium may still hold the frame's stale cursor. A fresh move at the pointer makes
            // it hit-test again; hand over once it reports the held cursor, or after a moment.
            if (cursor_hold_ && !cursor_releasing_)
            {
                cursor_releasing_ = true;
                if (window_.relay_pointer()) window_.after(200, [this] { release_cursor(); });
                else release_cursor();
            }
        }
        else
        {
            webview_.send({{"id", id}, {"error", "不支持的光标"}});
            return;
        }
        webview_.send({{"id", id}, {"result", true}});
        return;
    }
    if (method.starts_with("agent.") && receive_agent(id, method, params)) return;
    if (method == "dict.popup")
    {
        try
        {
            lookup_in_dr_dict(window_.handle(), params.at("text").get<std::string>(),
                              selection_screen_rect(window_.handle(), window_.content_bounds(), params));
            webview_.send({{"id", id}, {"result", true}});
        }
        catch (const std::exception &e) { webview_.send({{"id", id}, {"error", e.what()}}); }
        return;
    }
    if(method=="copy"){try{copy_text(window_.handle(),params.at("text"));webview_.send({{"id",id},{"result",true}});}catch(const std::exception& e){webview_.send({{"id",id},{"error",e.what()}});}return;}
    std::vector<fs::path> files;
    fs::path notes_file;
    // Books dropped on the library: the paths come only from the File objects of the drop.
    if (method == "import.dropped") files = std::move(dropped);
    if (method == "import" || method == "notes.import")
    {
        try
        {
            if (method == "import") files = pick_books();
            else notes_file = pick_notes_import_path();
        }
        catch (const std::exception &error)
        {
            webview_.send({{"id", id}, {"error", error.what()}});
            return;
        }
    }
    enqueue(
        [this, id, method, params, files, notes_file]
        {
            try
            {
                Json result;
                if (method == "bootstrap")
                {
                    Json errors = Json::array();
                    for (auto &path : initial_files_)
                    {
                        try
                        {
                            library_.import_book(path);
                        }
                        catch (const std::exception &e)
                        {
                            errors.push_back(e.what());
                        }
                    }
                    initial_files_.clear();
                    auto sample = assets_.parent_path() / "resources" / "welcome.epub";
                    auto welcome_marker = library_.root() / "welcome-initialized";
                    if (!fs::exists(welcome_marker))
                    {
                        if (library_.list().empty() && fs::exists(sample))
                            library_.import_book(sample);
                        write_atomic(welcome_marker, "1");
                    }
                    result = {{"books", library_.list()},
                              {"settings", library_.settings()},
                              {"shelves", library_.shelves()},
                              {"dataPath", utf8(library_.root())},
                              {"fonts",installed_fonts()},
                              {"iconFonts",installed_icon_glyphs()},
                              {"defaults",default_settings()},
                              {"importErrors", errors}};
                    if (!shell_override_.empty())
                        result["settings"]["application"]["shell"] = shell_override_;
                }
                else if (method == "list")
                    result = library_.list();
                else if (method == "shelves.save")
                    result = library_.save_shelves(params.at("shelves"));
                else if (method == "book.delete")
                {
                    library_.remove_book(params.at("id"));
                    result = true;
                }
                else if (method == "books.delete")
                    result = library_.remove_books(params.at("ids"));
                else if (method == "close")
                {
                    window_.post([this] { DestroyWindow(window_.handle()); });
                    return;
                }
                else if (method == "import" || method == "import.dropped")
                {
                    // Reference: calibre gui2/actions/add.py AddAction.add_books/_add_books.
                    // Independently use our Win32 selection and serial worker to import the full batch.
                    Json errors = Json::array();
                    const auto books = method == "import" ? files : dropped_books(files, errors);
                    size_t imported = 0;
                    for (auto &path : books)
                    {
                        try
                        {
                            library_.import_book(path);
                            ++imported;
                        }
                        catch (const std::exception &e)
                        {
                            errors.push_back(utf8(path.filename()) + ": " + e.what());
                        }
                    }
                    result = {{"books", library_.list()}, {"errors", errors}, {"imported", imported}};
                }
                else if (method == "open")
                {
                    auto book = library_.get(params.at("id"));
                    result = book;
                    window_.post([this, title = book.at("title").get<std::string>()]
                                 { window_.set_title(short_title(widen(title)) + L" — DR Reader"); });
                }
                else if (method == "position")
                    result = library_.save_position(params.at("id"), params.at("position"));
                else if (method == "bookmark")
                    result = library_.toggle_bookmark(params.at("id"), params.at("mark"));
                else if (method == "search")
                    result = library_.search(params.at("id"), params.at("query"));
                else if (method == "book.stats")
                    result = {{"chars", library_.chapter_lengths(params.at("id"))}};
                else if (method == "book.info")
                    result = library_.info(params.at("id"));
                else if (method == "notes.export")
                {
                    const auto book_id = params.at("id").get<std::string>();
                    if (library_.annotations(book_id).empty() && library_.agent_sessions(book_id).empty())
                        result = {{"saved", false}, {"empty", true}};
                    else
                    {
                        const auto title = library_.get(book_id).value("title", std::string("阅读笔记"));
                        window_.post([this, id, title, book_id] {
                            try
                            {
                                bool markdown = false;
                                const auto path = pick_notes_path(title, markdown);
                                if (path.empty())
                                {
                                    webview_.send({{"id", id}, {"result", {{"saved", false}}}});
                                    return;
                                }
                                enqueue([this, id, path, book_id, markdown] {
                                    try
                                    {
                                        const auto text = markdown ? library_.export_notes_markdown(book_id) : library_.export_notes(book_id);
                                        write_atomic(path, text);
                                        window_.post([this, id] { webview_.send({{"id", id}, {"result", {{"saved", true}}}}); });
                                    }
                                    catch (const std::exception &error)
                                    {
                                        window_.post([this, id, error = std::string(error.what())] { webview_.send({{"id", id}, {"error", error}}); });
                                    }
                                });
                            }
                            catch (const std::exception &error) { webview_.send({{"id", id}, {"error", error.what()}}); }
                        });
                        return;
                    }
                }
                else if (method == "notes.import")
                {
                    if (notes_file.empty()) result = {{"cancelled", true}};
                    else
                    {
                        if (fs::file_size(notes_file) > Library::notes_max_bytes)
                            throw std::runtime_error("笔记文件不能超过 32 MiB");
                        result = library_.import_notes(params.at("id"), read_file(notes_file));
                    }
                }
                else if(method=="annotations")result=library_.annotations(params.at("id"));
                else if(method=="annotation.save")result=library_.save_annotation(params.at("id"),params.at("annotation"));
                else if(method=="annotation.delete"){library_.remove_annotation(params.at("id"),params.at("annotationId"));result=true;}
                // AI 问书 conversations, saved per book after each answer.
                else if(method=="conversations")result=library_.agent_sessions(params.at("id"));
                else if(method=="conversation")result=library_.agent_session(params.at("id"),params.at("session"));
                else if(method=="conversation.save")result=library_.save_agent_session(params.at("id"),params.at("session"));
                else if(method=="conversation.delete"){library_.remove_agent_session(params.at("id"),params.at("session"));result=true;}
                else if(method=="lookup"){auto url=library_.lookup_url(params.at("dictionaryId"),params.at("text"));window_.post([this,id,url]{auto result=ShellExecuteW(window_.handle(),L"open",widen(url).c_str(),nullptr,nullptr,SW_SHOWNORMAL);if(reinterpret_cast<INT_PTR>(result)>32)webview_.send({{"id",id},{"result",true}});else webview_.send({{"id",id},{"error","无法打开浏览器"}});});return;}
                else if (method == "settings")
                {
                    result = library_.save_settings(params);
                    window_.post([this, result] { apply_settings(result); });
                }
                else
                    throw std::runtime_error("未知命令");
                window_.post([this, id, result = std::move(result)]
                             { webview_.send({{"id", id}, {"result", result}}); });
            }
            catch (const std::exception &error)
            {
                window_.post([this, id, error = std::string(error.what())]
                             { webview_.send({{"id", id}, {"error", error}}); });
            }
        });
}
// Reading assistance through local agent CLIs. Answers stream back as `agent` events keyed by
// the page's request id; each request ends with a `done` or `error` event.
bool Application::receive_agent(const Json &id, const std::string &method, const Json &params)
{
    static constexpr AgentKind kinds[] = {AgentKind::Codex, AgentKind::Claude, AgentKind::OpenCode};
    try
    {
        if (method == "agent.detect")
        {
            // Looking through PATH touches the disk and registry; keep it off the UI thread.
            enqueue([this, id] {
                Json result = Json::object();
                for (auto kind : kinds)
                {
                    auto found = AgentRunner::find(kind);
                    result[agent_id(kind)] = found ? Json{{"path", utf8(found->path)}} : Json(nullptr);
                }
                window_.post([this, id, result] { webview_.send({{"id", id}, {"result", result}}); });
            });
            return true;
        }
        if (method == "agent.cancel")
        {
            if (agents_) agents_->cancel(params.at("request").get<std::string>());
            webview_.send({{"id", id}, {"result", true}});
            return true;
        }
        auto runner = [this]() -> AgentRunner & {
            if (!agents_)
                agents_ = std::make_unique<AgentRunner>([this](const AgentUpdate &update) {
                    static constexpr const char *types[] = {"text", "status", "done", "error"};
                    Json event{{"event", "agent"}, {"request", update.request},
                               {"type", types[static_cast<int>(update.type)]}, {"text", update.text}};
                    window_.post([this, event = std::move(event)] { webview_.send(event); });
                });
            return *agents_;
        };
        if (method == "agent.models")
        {
            // Runs the CLI for a few seconds: off the UI thread and outside the serial worker queue.
            auto kind = agent_kind(params.value("agent", std::string()));
            if (!kind) throw std::runtime_error("请先选择具体的工具");
            auto agent = AgentRunner::find(*kind);
            if (!agent) throw std::runtime_error(std::string("没有找到 ") + agent_label(*kind) + "，请确认已安装并能在终端中运行");
            runner().list_models(*agent, [this, id](std::vector<AgentModel> models, std::string error) {
                Json reply{{"id", id}};
                if (!error.empty()) reply["error"] = error;
                else
                {
                    Json list = Json::array();
                    for (auto &model : models)
                        list.push_back({{"id", model.id}, {"name", model.name}, {"description", model.description},
                                        {"default", model.is_default}, {"efforts", model.efforts},
                                        {"defaultEffort", model.default_effort}});
                    reply["result"] = {{"models", list}};
                }
                window_.post([this, reply = std::move(reply)] { webview_.send(reply); });
            });
            return true;
        }
        if (method != "agent.ask") return false;
        const auto request = params.at("request").get<std::string>();
        const auto prompt = params.at("prompt").get<std::string>();
        const auto choice = params.value("agent", std::string("auto"));
        const auto model = params.value("model", std::string());
        const auto effort = params.value("effort", std::string());
        if (request.empty() || request.size() > 64) throw std::runtime_error("提问标识无效");
        if (prompt.empty() || prompt.size() > (1u << 20)) throw std::runtime_error("问题为空或附带的正文过长");
        std::optional<AgentExecutable> agent;
        if (choice == "auto")
        {
            for (auto kind : kinds)
                if ((agent = AgentRunner::find(kind))) break;
            if (!agent) throw std::runtime_error("没有找到 Codex、Claude Code 或 opencode，请先安装其中一个并登录");
        }
        else
        {
            auto kind = agent_kind(choice);
            if (!kind) throw std::runtime_error("不支持的 Agent");
            agent = AgentRunner::find(*kind);
            if (!agent) throw std::runtime_error(std::string("没有找到 ") + agent_label(*kind) + "，请确认已安装并能在终端中运行");
        }
        runner().start(request, *agent, model, effort, prompt);
        webview_.send({{"id", id}, {"result", {{"agent", agent_id(agent->kind)}, {"label", agent_label(agent->kind)}}}});
    }
    catch (const std::exception &error)
    {
        webview_.send({{"id", id}, {"error", error.what()}});
    }
    return true;
}
int Application::run(HINSTANCE instance)
{
    auto settings = library_.settings();
    if (!shell_override_.empty())
        settings["application"]["shell"] = shell_override_;
    if (!window_.create(instance, shell_style(settings["application"].value("shell", std::string("mica"))), IDI_DR_READER,
                         settings["window"]["widthRatio"].get<double>(),
                         settings["window"]["heightRatio"].get<double>(),
                         settings["application"].value("theme", std::string("light"))))
        return 1;
    window_.on_resize = [this] { webview_.resize(window_.content_bounds()); };
    // Alt+Enter hides or restores the title bar; fullscreen stays on F11 and the toolbar.
    window_.on_toggle_borderless = [this] {
        // Dispatch out of the synchronous WebView2 accelerator callback before resizing it.
        window_.post([this] {
            window_.set_borderless(!window_.borderless());
            webview_.send({{"event", "titlebar"}, {"hidden", window_.borderless()}});
        });
    };
    webview_.on_toggle_borderless = window_.on_toggle_borderless;
    // The page draws the Direct2D caption buttons' tips with its own tooltip, directly below
    // the caption; positions are converted from client pixels to CSS pixels.
    window_.on_caption_tooltip = [this](const std::wstring &text, RECT button) {
        const double scale = 96.0 / GetDpiForWindow(window_.handle());
        // A Direct2D button ends where the page begins; a WebView2 caption is inside the page.
        const auto caption = window_.caption_state();
        const bool web = caption.visible && page_ready_;
        webview_.send({{"event", "caption-tooltip"}, {"text", narrow(text)},
                       {"left", button.left * scale}, {"width", (button.right - button.left) * scale},
                       {"top", web ? 0.0 : -1.0}, {"height", web ? caption.height * scale : 1.0}});
    };
    window_.on_caption_change = [this] { if (page_ready_) send_caption(); };
    // The page is composition-hosted: this window relays its mouse input and applies its cursor.
    window_.on_mouse = [this](UINT message, WPARAM w, POINT point) {
        webview_.mouse(message, w, point);
        if (!cursor_hold_) return;
        // A held cursor is for a still pointer. Once the pointer moves away from where the drag
        // ended, each move hit-tests afresh, so the page's own cursor is current again.
        POINT screen{};
        GetCursorPos(&screen);
        if (message == WM_LBUTTONUP) { cursor_release_point_ = screen; cursor_released_up_ = true; }
        else if (message == WM_MOUSEMOVE && cursor_released_up_ && !(w & (MK_LBUTTON | MK_RBUTTON | MK_MBUTTON)) &&
                 (std::abs(screen.x - cursor_release_point_.x) > 4 || std::abs(screen.y - cursor_release_point_.y) > 4))
        {
            cursor_releasing_ = true;
            release_cursor();
        }
    };
    window_.on_cursor = [this] {
        if (!cursor_hold_) return webview_.cursor();
        SetCursor(cursor_hold_);
        return true;
    };
    window_.on_focus = [this] { webview_.focus(); };
    window_.on_move = [this] { webview_.notify_move(); };
    webview_.on_cursor_changed = [this] {
        if (cursor_releasing_ && webview_.system_cursor() == cursor_hold_id_) release_cursor();
        else window_.update_cursor();
    };
    window_.set_theme(settings["application"].value("theme", std::string("light")));
    webview_.set_theme(window_.resolved_theme());
    webview_.on_message = [this](auto &request, auto dropped) { receive(request, std::move(dropped)); };
    webview_.on_error = [this](const auto &error)
    { MessageBoxW(window_.handle(), error.c_str(), L"DR Reader", MB_OK | MB_ICONERROR); };
    window_.on_close = [this] { webview_.send({{"event", "closing"}}); };
    webview_.resize(window_.content_bounds());
    {
        const auto caption = window_.caption_state();
        webview_.set_caption_height(caption.visible ? caption.height * 96.0 / GetDpiForWindow(window_.handle()) : 0.0);
    }
    webview_.create(window_.handle(), assets_, library_.root(), [] {});
    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return static_cast<int>(msg.wParam);
}
} // namespace dr
