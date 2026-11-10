#include "webview.h"
#include <WebView2EnvironmentOptions.h>
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
void WebView::set_theme(const std::string &theme)
{
    theme_ = theme;
}
void WebView::send(const Json &message)
{
    if (view_)
        view_->PostWebMessageAsJson(widen(message.dump()).c_str());
}
void WebView::create(HWND window, const fs::path &web_root, const fs::path &data_root,
                     std::function<void()> ready)
{
    // At 150% display scaling and above Chromium composites every overflow scroller (sidebar,
    // settings, notes), and text in a composited scroller loses ClearType: it was drawn with
    // greyscale antialiasing while the rest of the window kept subpixel text, so the sidebar
    // looked blurred. Measured in the real window: 0% vs 40-50% subpixel-coloured text pixels.
    // This switch keeps such scrollers in the main layer, trading compositor scrolling of small
    // panels for crisp text. Explicitly promoted layers (page turns) are unaffected.
    auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    options->put_AdditionalBrowserArguments(L"--disable-prefer-compositing-to-lcd-text");
    auto hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, (data_root / "webview-profile").c_str(), options.Get(),
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
                                    // Transparent until the page paints its opaque body, so the window's themed
                                    // startup placeholder shows through instead of a blank (white) view.
                                    Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
                                    if (SUCCEEDED(controller_.As(&controller2)))
                                        controller2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{0, 0, 0, 0});
                                    controller_->put_Bounds(bounds_);
                                    controller_->put_ZoomFactor(1.0);
                                    EventRegistrationToken zoom_token{};
                                    controller_->add_ZoomFactorChanged(
                                        Callback<ICoreWebView2ZoomFactorChangedEventHandler>(
                                            [](ICoreWebView2Controller *sender, IUnknown *) -> HRESULT
                                            {
                                                double zoom = 1.0;
                                                if (SUCCEEDED(sender->get_ZoomFactor(&zoom)) && zoom != 1.0)
                                                    return sender->put_ZoomFactor(1.0);
                                                return S_OK;
                                            }).Get(), &zoom_token);
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
                                                    if (!status.WasKeyDown && on_toggle_borderless) on_toggle_borderless();
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
                                    // Disable browser zoom shortcuts and Ctrl+wheel for every page/frame.
                                    settings->put_IsZoomControlEnabled(FALSE);
                                    Microsoft::WRL::ComPtr<ICoreWebView2Settings5> settings5;
                                    if (SUCCEEDED(settings.As(&settings5)))
                                        settings5->put_IsPinchZoomEnabled(FALSE);
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
                                    // Give <body> the window's theme before the first paint; app.js replaces
                                    // it with the saved settings once they load. Top-level app page only.
                                    const std::wstring theme_script =
                                        L"if (window === top && location.host === 'app.dr-reader.local') "
                                        L"new MutationObserver((_, observer) => { if (!document.body) return; "
                                        L"document.body.dataset.theme ??= '" + widen(theme_) + L"'; observer.disconnect(); })"
                                        L".observe(document, { childList: true, subtree: true });";
                                    view_->AddScriptToExecuteOnDocumentCreated(theme_script.c_str(), nullptr);
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
