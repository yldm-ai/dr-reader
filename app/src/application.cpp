#include "application.h"
#include "../resource.h"
#include "dr/settings.h"
#include <shobjidl.h>
#include <stdexcept>
#include <set>
#include <shellapi.h>
namespace dr
{
namespace {
Json installed_fonts(){Microsoft::WRL::ComPtr<IDWriteFactory> factory;Json result=Json::array();if(FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED,__uuidof(IDWriteFactory),reinterpret_cast<IUnknown**>(factory.GetAddressOf()))))return result;
 Microsoft::WRL::ComPtr<IDWriteFontCollection> collection;if(FAILED(factory->GetSystemFontCollection(&collection)))return result;std::set<std::string> names;
 for(UINT32 i=0;i<collection->GetFontFamilyCount();++i){Microsoft::WRL::ComPtr<IDWriteFontFamily> family;Microsoft::WRL::ComPtr<IDWriteLocalizedStrings> localized;if(FAILED(collection->GetFontFamily(i,&family))||FAILED(family->GetFamilyNames(&localized)))continue;UINT32 index=0;BOOL exists=FALSE;localized->FindLocaleName(L"zh-cn",&index,&exists);if(!exists)localized->FindLocaleName(L"en-us",&index,&exists);if(!exists)index=0;UINT32 length=0;localized->GetStringLength(index,&length);std::wstring name(length+1,L'\0');if(SUCCEEDED(localized->GetString(index,name.data(),length+1))){name.resize(length);names.insert(narrow(name));}}
 for(auto& name:names)result.push_back(name);return result;}
void copy_text(HWND owner,const std::string& text){if(text.size()>65536)throw std::runtime_error("复制内容过长");auto wide=widen(text);auto bytes=(wide.size()+1)*sizeof(wchar_t);HGLOBAL memory=GlobalAlloc(GMEM_MOVEABLE,bytes);if(!memory)throw std::runtime_error("无法分配剪贴板内存");auto data=GlobalLock(memory);if(!data){GlobalFree(memory);throw std::runtime_error("无法锁定剪贴板内存");}memcpy(data,wide.c_str(),bytes);GlobalUnlock(memory);
 if(!OpenClipboard(owner)){GlobalFree(memory);throw std::runtime_error("剪贴板正被其他程序使用");}EmptyClipboard();if(!SetClipboardData(CF_UNICODETEXT,memory)){CloseClipboard();GlobalFree(memory);throw std::runtime_error("无法写入剪贴板");}CloseClipboard();}
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
    window_.set_style(app.value("shell", std::string("mica")) == "direct2d" ? ShellStyle::Direct2D
                                                                          : ShellStyle::Mica);
    window_.set_theme(app.value("theme", std::string("light")));
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
    dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM);
    auto hr = dialog->Show(window_.handle());
    if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED))
        return files;
    if (FAILED(hr))
        throw std::runtime_error("文件选择失败");
    Microsoft::WRL::ComPtr<IShellItemArray> items;
    dialog->GetResults(&items);
    DWORD count = 0;
    items->GetCount(&count);
    for (DWORD i = 0; i < count; ++i)
    {
        Microsoft::WRL::ComPtr<IShellItem> item;
        items->GetItemAt(i, &item);
        LPWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)))
        {
            files.emplace_back(path);
            CoTaskMemFree(path);
        }
    }
    return files;
}
void Application::receive(const Json &request)
{
    if (!request.is_object() || !request.contains("id") || !request["id"].is_number_unsigned() ||
        !request.contains("method") || !request["method"].is_string())
        return;
    auto id = request["id"];
    auto method = request["method"].get<std::string>();
    auto params = request.value("params", Json::object());
    if(method=="copy"){try{copy_text(window_.handle(),params.at("text"));webview_.send({{"id",id},{"result",true}});}catch(const std::exception& e){webview_.send({{"id",id},{"error",e.what()}});}return;}
    std::vector<fs::path> files;
    if (method == "import")
    {
        try
        {
            files = pick_books();
        }
        catch (const std::exception &error)
        {
            webview_.send({{"id", id}, {"error", error.what()}});
            return;
        }
    }
    enqueue(
        [this, id, method, params, files]
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
                    if (library_.list().empty() && fs::exists(sample))
                        library_.import_book(sample);
                    result = {{"books", library_.list()},
                              {"settings", library_.settings()},
                              {"dataPath", utf8(library_.root())},
                              {"fonts",installed_fonts()},
                              {"defaults",default_settings()},
                              {"importErrors", errors}};
                    if (!shell_override_.empty())
                        result["settings"]["application"]["shell"] = shell_override_;
                }
                else if (method == "list")
                    result = library_.list();
                else if (method == "close")
                {
                    window_.post([this] { DestroyWindow(window_.handle()); });
                    return;
                }
                else if (method == "import")
                {
                    Json errors = Json::array();
                    for (auto &path : files)
                    {
                        try
                        {
                            library_.import_book(path);
                        }
                        catch (const std::exception &e)
                        {
                            errors.push_back(utf8(path.filename()) + ": " + e.what());
                        }
                    }
                    result = {{"books", library_.list()}, {"errors", errors}};
                }
                else if (method == "open")
                {
                    auto book = library_.get(params.at("id"));
                    result = book;
                    window_.post([this, title = book.at("title").get<std::string>()]
                                 { window_.set_title(widen(title) + L" — DR Reader"); });
                }
                else if (method == "position")
                    result = library_.save_position(params.at("id"), params.at("position"));
                else if (method == "bookmark")
                    result = library_.toggle_bookmark(params.at("id"), params.at("mark"));
                else if (method == "search")
                    result = library_.search(params.at("id"), params.at("query"));
                else if(method=="annotations")result=library_.annotations(params.at("id"));
                else if(method=="annotation.save")result=library_.save_annotation(params.at("id"),params.at("annotation"));
                else if(method=="annotation.delete"){library_.remove_annotation(params.at("id"),params.at("annotationId"));result=true;}
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
int Application::run(HINSTANCE instance)
{
    auto settings = library_.settings();
    if (!shell_override_.empty())
        settings["application"]["shell"] = shell_override_;
    if (!window_.create(instance, settings["application"].value("shell", std::string("mica")) == "direct2d"
                                      ? ShellStyle::Direct2D
                                      : ShellStyle::Mica, IDI_DR_READER))
        return 1;
    window_.on_resize = [this] { webview_.resize(window_.content_bounds()); };
    window_.set_theme(settings["application"].value("theme", std::string("light")));
    webview_.on_message = [this](auto &request) { receive(request); };
    webview_.on_error = [this](const auto &error)
    { MessageBoxW(window_.handle(), error.c_str(), L"DR Reader", MB_OK | MB_ICONERROR); };
    window_.on_close = [this] { webview_.send({{"event", "closing"}}); };
    webview_.resize(window_.content_bounds());
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
