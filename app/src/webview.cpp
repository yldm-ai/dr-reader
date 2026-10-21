#include "webview.h"
#include <sstream>
namespace dr
{
using Microsoft::WRL::Callback;
std::wstring widen(std::string_view s)
{
    if (s.empty())
        return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring r(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), r.data(), n);
    return r;
}
std::string narrow(std::wstring_view s)
{
    if (s.empty())
        return {};
    int n =
        WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
    std::string r(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), r.data(), n, nullptr, nullptr);
    return r;
}
void WebView::fail(HRESULT hr, const wchar_t *step)
{
    std::wostringstream out;
    out << step << L" 失败 (0x" << std::hex << hr << L")。请确认已安装 Microsoft Edge WebView2 Runtime。";
    if (on_error)
        on_error(out.str());
}
void WebView::resize(RECT bounds)
{
    bounds_ = bounds;
    if (controller_)
        controller_->put_Bounds(bounds);
}
void WebView::send(const Json &message)
{
    if (view_)
        view_->PostWebMessageAsJson(widen(message.dump()).c_str());
}
void WebView::create(HWND window, const fs::path &web_root, const fs::path &data_root,
                     std::function<void()> ready)
{
    auto hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, (data_root / "webview-profile").c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this, window, web_root, data_root, ready](HRESULT result,
                                                       ICoreWebView2Environment *env) -> HRESULT
            {
                if (FAILED(result) || !env)
                {
                    fail(result, L"WebView2 初始化");
                    return S_OK;
                }
                auto hr2 = env->CreateCoreWebView2Controller(
                    window, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                                [this, web_root, data_root,
                                 ready](HRESULT result2, ICoreWebView2Controller *controller) -> HRESULT
                                {
                                    if (FAILED(result2) || !controller)
                                    {
                                        fail(result2, L"WebView2 控制器创建");
                                        return S_OK;
                                    }
                                    controller_ = controller;
                                    controller_->get_CoreWebView2(&view_);
                                    controller_->put_Bounds(bounds_);
                                    EventRegistrationToken accelerator_token{};
                                    controller_->add_AcceleratorKeyPressed(
                                        Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
                                            [this](ICoreWebView2Controller *, ICoreWebView2AcceleratorKeyPressedEventArgs *args) -> HRESULT
                                            {
                                                UINT key = 0;
                                                COREWEBVIEW2_KEY_EVENT_KIND kind{};
                                                COREWEBVIEW2_PHYSICAL_KEY_STATUS status{};
                                                args->get_VirtualKey(&key);
                                                args->get_KeyEventKind(&kind);
                                                args->get_PhysicalKeyStatus(&status);
                                                if (key == VK_RETURN && (GetKeyState(VK_MENU) & 0x8000) &&
                                                    (kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN ||
                                                     kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN))
                                                {
                                                    args->put_Handled(TRUE);
                                                    if (!status.WasKeyDown && on_toggle_fullscreen) on_toggle_fullscreen();
                                                }
                                                return S_OK;
                                            }).Get(), &accelerator_token);
                                    Microsoft::WRL::ComPtr<ICoreWebView2_3> v3;
                                    auto h = view_.As(&v3);
                                    if (FAILED(h))
                                    {
                                        fail(h, L"WebView2 虚拟目录支持");
                                        return S_OK;
                                    }
                                    h = v3->SetVirtualHostNameToFolderMapping(
                                        L"app.dr-reader.local", web_root.c_str(),
                                        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
                                    if (FAILED(h))
                                    {
                                        fail(h, L"界面资源映射");
                                        return S_OK;
                                    }
                                    h = v3->SetVirtualHostNameToFolderMapping(
                                        L"books.dr-reader.local", (data_root / "books").c_str(),
                                        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                                    if (FAILED(h))
                                    {
                                        fail(h, L"书库资源映射");
                                        return S_OK;
                                    }
                                    // Publication frames use a separate origin. Render their sanitized XHTML
                                    // via fetch+srcdoc.
                                    Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
                                    view_->get_Settings(&settings);
                                    settings->put_AreDefaultContextMenusEnabled(FALSE);
                                    settings->put_IsStatusBarEnabled(FALSE);
                                    settings->put_AreHostObjectsAllowed(FALSE);
                                    EventRegistrationToken token{};
                                    view_->add_WebMessageReceived(
                                        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                            [this](ICoreWebView2 *,
                                                   ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT
                                            {
                                                LPWSTR source = nullptr, raw = nullptr;
                                                args->get_Source(&source);
                                                args->get_WebMessageAsJson(&raw);
                                                std::wstring origin = source ? source : L"";
                                                std::string text = raw ? narrow(raw) : "";
                                                CoTaskMemFree(source);
                                                CoTaskMemFree(raw);
                                                if (origin != L"https://app.dr-reader.local/index.html" ||
                                                text.size() > 256 * 1024)
                                                    return S_OK;
                                                try
                                                {
                                                    if (on_message)
                                                        on_message(Json::parse(text));
                                                }
                                                catch (const std::exception &)
                                                { /* malformed messages never cross the native boundary */
                                                }
                                                return S_OK;
                                            })
                                            .Get(),
                                        &token);
                                    view_->add_NavigationStarting(
                                        Callback<ICoreWebView2NavigationStartingEventHandler>(
                                            [](ICoreWebView2 *,
                                               ICoreWebView2NavigationStartingEventArgs *args) -> HRESULT
                                            {
                                                LPWSTR uri = nullptr;
                                                args->get_Uri(&uri);
                                                bool allowed =
                                                    uri && std::wstring_view(uri) ==
                                                               L"https://app.dr-reader.local/index.html";
                                                CoTaskMemFree(uri);
                                                if (!allowed)
                                                    args->put_Cancel(TRUE);
                                                return S_OK;
                                            })
                                            .Get(),
                                        &token);
                                    view_->add_NewWindowRequested(
                                        Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                                            [](ICoreWebView2 *,
                                               ICoreWebView2NewWindowRequestedEventArgs *args) -> HRESULT
                                            {
                                                args->put_Handled(TRUE);
                                                return S_OK;
                                            })
                                            .Get(),
                                        &token);
                                    if (ready)
                                        ready();
                                    view_->Navigate(L"https://app.dr-reader.local/index.html");
                                    return S_OK;
                                })
                                .Get());
                if (FAILED(hr2))
                    fail(hr2, L"WebView2 控制器请求");
                return S_OK;
            })
            .Get());
    if (FAILED(hr))
        fail(hr, L"WebView2 环境请求");
}
} // namespace dr
