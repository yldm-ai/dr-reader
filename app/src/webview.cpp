#include "webview.h"
#include <WebView2EnvironmentOptions.h>
#include <algorithm>
#include <shlobj.h>
#include <sstream>
namespace dr
{
using Microsoft::WRL::Callback;
namespace
{
/**
 * A composition-hosted WebView2 has no window to receive OLE drag and drop, so the shell
 * window registers this target and forwards each step to the page, as WebView2APISample's
 * DropTarget/ViewComponent do for visual hosting. The page's own drag events then decide
 * the effect; the shell's drag image helper draws the dragged files over the window.
 */
class DropTarget : public Microsoft::WRL::RuntimeClass<
                       Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IDropTarget>
{
  public:
    DropTarget(HWND window, Microsoft::WRL::ComPtr<ICoreWebView2CompositionController3> view,
               std::function<POINT(POINTL)> to_view)
        : window_(window), view_(std::move(view)), to_view_(std::move(to_view))
    {
        CoCreateInstance(CLSID_DragDropHelper, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&helper_));
    }
    STDMETHODIMP DragEnter(IDataObject *data, DWORD keys, POINTL at, DWORD *effect) override
    {
        auto hr = view_->DragEnter(data, keys, to_view_(at), effect);
        if (helper_)
        {
            POINT screen{at.x, at.y};
            helper_->DragEnter(window_, data, &screen, *effect);
        }
        return hr;
    }
    STDMETHODIMP DragOver(DWORD keys, POINTL at, DWORD *effect) override
    {
        auto hr = view_->DragOver(keys, to_view_(at), effect);
        if (helper_)
        {
            POINT screen{at.x, at.y};
            helper_->DragOver(&screen, *effect);
        }
        return hr;
    }
    STDMETHODIMP DragLeave() override
    {
        if (helper_) helper_->DragLeave();
        return view_->DragLeave();
    }
    STDMETHODIMP Drop(IDataObject *data, DWORD keys, POINTL at, DWORD *effect) override
    {
        auto hr = view_->Drop(data, keys, to_view_(at), effect);
        if (helper_)
        {
            POINT screen{at.x, at.y};
            helper_->Drop(data, &screen, *effect);
        }
        return hr;
    }

  private:
    HWND window_;
    Microsoft::WRL::ComPtr<ICoreWebView2CompositionController3> view_;
    Microsoft::WRL::ComPtr<IDropTargetHelper> helper_;
    std::function<POINT(POINTL)> to_view_;
};
}
void WebView::register_drop_target(HWND window)
{
    Microsoft::WRL::ComPtr<ICoreWebView2CompositionController3> view;
    if (FAILED(composition_.As(&view))) return;
    // OLE gives screen coordinates; the page takes them relative to the WebView's top-left.
    drop_target_ = Microsoft::WRL::Make<DropTarget>(window, view, [this, window](POINTL at) {
        POINT point{at.x, at.y};
        ScreenToClient(window, &point);
        return POINT{point.x - bounds_.left, point.y - bounds_.top};
    });
    RegisterDragDrop(window, drop_target_.Get());
}
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
    place();
}
// As in WebView2APISample's ViewComponent::ResizeWebView for visual hosting: the controller
// takes the size, while the root visual carries the offset and clips to the page.
void WebView::place()
{
    if (!controller_ || !root_ || !device_) return;
    controller_->put_Bounds(bounds_);
    root_->SetOffsetX(static_cast<float>(bounds_.left));
    root_->SetOffsetY(static_cast<float>(bounds_.top));
    device_->Commit();
}
void WebView::set_theme(const std::string &theme)
{
    theme_ = theme;
}
void WebView::set_caption_height(double height)
{
    caption_height_ = height;
}
void WebView::set_background(UINT32 rgb)
{
    Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
    if (controller_ && SUCCEEDED(controller_.As(&controller2)))
        controller2->put_DefaultBackgroundColor(
            COREWEBVIEW2_COLOR{255, BYTE(rgb >> 16), BYTE(rgb >> 8), BYTE(rgb)});
}
void WebView::send(const Json &message)
{
    if (view_)
        view_->PostWebMessageAsJson(widen(message.dump()).c_str());
}
void WebView::mouse(UINT message, WPARAM wparam, POINT point)
{
    if (!composition_) return;
    COREWEBVIEW2_MOUSE_EVENT_KIND kind{};
    UINT32 data = 0;
    switch (message)
    {
    case WM_MOUSEMOVE: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE; break;
    case WM_LBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN; break;
    case WM_LBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP; break;
    case WM_LBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK; break;
    case WM_RBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN; break;
    case WM_RBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP; break;
    case WM_RBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK; break;
    case WM_MBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN; break;
    case WM_MBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP; break;
    case WM_MBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK; break;
    case WM_XBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN; data = GET_XBUTTON_WPARAM(wparam); break;
    case WM_XBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP; data = GET_XBUTTON_WPARAM(wparam); break;
    case WM_XBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOUBLE_CLICK; data = GET_XBUTTON_WPARAM(wparam); break;
    case WM_MOUSEWHEEL: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL; data = static_cast<UINT32>(GET_WHEEL_DELTA_WPARAM(wparam)); break;
    case WM_MOUSEHWHEEL: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL; data = static_cast<UINT32>(GET_WHEEL_DELTA_WPARAM(wparam)); break;
    case WM_MOUSELEAVE: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE; break;
    default: return;
    }
    // The MK_* flags and COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS share their values.
    const auto keys = static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(
        message == WM_MOUSELEAVE ? 0 : GET_KEYSTATE_WPARAM(wparam));
    composition_->SendMouseInput(kind, keys, data, point);
}
bool WebView::cursor()
{
    if (!composition_) return false;
    HCURSOR cursor = nullptr;
    if (SUCCEEDED(composition_->get_Cursor(&cursor)) && cursor)
    {
        SetCursor(cursor);
        return true;
    }
    UINT32 id = 0;
    if (SUCCEEDED(composition_->get_SystemCursorId(&id)) && id)
    {
        SetCursor(LoadCursorW(nullptr, MAKEINTRESOURCEW(id)));
        return true;
    }
    return false;
}
UINT32 WebView::system_cursor()
{
    UINT32 id = 0;
    if (composition_) composition_->get_SystemCursorId(&id);
    return id;
}
void WebView::focus()
{
    if (controller_)
        controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}
void WebView::notify_move()
{
    if (controller_)
        controller_->NotifyParentWindowPositionChanged();
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
            [this, window, web_root, data_root, ready](HRESULT result, ICoreWebView2Environment *env) -> HRESULT
            {
                if (FAILED(result) || !env)
                {
                    fail(result, L"WebView2 初始化");
                    return S_OK;
                }
                Microsoft::WRL::ComPtr<ICoreWebView2Environment3> env3;
                if (FAILED(env->QueryInterface(IID_PPV_ARGS(&env3))))
                {
                    fail(E_NOINTERFACE, L"WebView2 合成宿主接口");
                    return S_OK;
                }
                auto requested = env3->CreateCoreWebView2CompositionController(
                    window, Callback<ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler>(
                        [this, window, web_root, data_root, ready](
                            HRESULT created, ICoreWebView2CompositionController *controller) -> HRESULT
                        {
                            if (FAILED(created) || !controller)
                            {
                                fail(created, L"WebView2 合成控制器创建");
                                return S_OK;
                            }
                            composition_ = controller;
                            if (FAILED(composition_.As(&controller_)) ||
                                FAILED(controller_->get_CoreWebView2(&view_)) || !view_)
                            {
                                fail(E_NOINTERFACE, L"WebView2 控制器接口");
                                return S_OK;
                            }
                            // The visual sits above the window's own Direct2D drawing, so the
                            // caption and startup placeholder show wherever the page is absent.
                            auto hr = DCompositionCreateDevice(nullptr, IID_PPV_ARGS(&device_));
                            if (SUCCEEDED(hr)) hr = device_->CreateTargetForHwnd(window, TRUE, &target_);
                            if (SUCCEEDED(hr)) hr = device_->CreateVisual(&root_);
                            if (SUCCEEDED(hr)) hr = target_->SetRoot(root_.Get());
                            if (SUCCEEDED(hr)) hr = composition_->put_RootVisualTarget(root_.Get());
                            if (FAILED(hr))
                            {
                                fail(hr, L"WebView2 合成视觉树");
                                return S_OK;
                            }
                            EventRegistrationToken cursor_token{};
                            composition_->add_CursorChanged(
                                Callback<ICoreWebView2CursorChangedEventHandler>(
                                    [this](ICoreWebView2CompositionController *, IUnknown *) -> HRESULT
                                    {
                                        if (on_cursor_changed) on_cursor_changed();
                                        return S_OK;
                                    }).Get(), &cursor_token);
                            register_drop_target(window);
                            configure(web_root, data_root, ready);
                            return S_OK;
                        }).Get());
                if (FAILED(requested))
                    fail(requested, L"WebView2 合成控制器请求");
                return S_OK;
            })
            .Get());
    if (FAILED(hr))
        fail(hr, L"WebView2 环境请求");
}
void WebView::configure(const fs::path &web_root, const fs::path &data_root, std::function<void()> ready)
{
    // Transparent until the page paints its opaque body, so the window's themed startup
    // placeholder shows through instead of a blank (white) view.
    Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(controller_.As(&controller2)))
        controller2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{0, 0, 0, 0});
    place();
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
        return;
    }
    h = v3->SetVirtualHostNameToFolderMapping(L"app.dr-reader.local", web_root.c_str(),
                                              COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
    if (FAILED(h))
    {
        fail(h, L"界面资源映射");
        return;
    }
    h = v3->SetVirtualHostNameToFolderMapping(L"books.dr-reader.local", (data_root / "books").c_str(),
                                              COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
    if (FAILED(h))
    {
        fail(h, L"书库资源映射");
        return;
    }
    // Publication frames use a separate origin. Render their sanitized XHTML via fetch+srcdoc.
    Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
    view_->get_Settings(&settings);
    // Disable browser zoom shortcuts and Ctrl+wheel for every page/frame.
    settings->put_IsZoomControlEnabled(FALSE);
    Microsoft::WRL::ComPtr<ICoreWebView2Settings5> settings5;
    if (SUCCEEDED(settings.As(&settings5)))
        settings5->put_IsPinchZoomEnabled(FALSE);
    // Browser autofill would offer earlier search terms ("Saved info") under every text field.
    Microsoft::WRL::ComPtr<ICoreWebView2Settings4> settings4;
    if (SUCCEEDED(settings.As(&settings4)))
    {
        settings4->put_IsGeneralAutofillEnabled(FALSE);
        settings4->put_IsPasswordAutosaveEnabled(FALSE);
    }
    settings->put_AreDefaultContextMenusEnabled(FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreHostObjectsAllowed(FALSE);
    EventRegistrationToken token{};
    view_->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this](ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT
            {
                LPWSTR source = nullptr, raw = nullptr;
                args->get_Source(&source);
                args->get_WebMessageAsJson(&raw);
                std::wstring origin = source ? source : L"";
                std::string text = raw ? narrow(raw) : "";
                CoTaskMemFree(source);
                CoTaskMemFree(raw);
                if (origin != L"https://app.dr-reader.local/index.html" || text.size() > 256 * 1024)
                    return S_OK;
                // Files dropped on the page arrive as DOM File objects posted with the message;
                // only these native paths are trusted, never paths written into the JSON.
                std::vector<fs::path> files;
                Microsoft::WRL::ComPtr<ICoreWebView2WebMessageReceivedEventArgs2> args2;
                Microsoft::WRL::ComPtr<ICoreWebView2ObjectCollectionView> objects;
                UINT32 count = 0;
                if (SUCCEEDED(args->QueryInterface(IID_PPV_ARGS(&args2))) &&
                    SUCCEEDED(args2->get_AdditionalObjects(&objects)) && objects &&
                    SUCCEEDED(objects->get_Count(&count)))
                    for (UINT32 i = 0; i < count; ++i)
                    {
                        Microsoft::WRL::ComPtr<IUnknown> object;
                        Microsoft::WRL::ComPtr<ICoreWebView2File> file;
                        LPWSTR path = nullptr;
                        if (SUCCEEDED(objects->GetValueAtIndex(i, &object)) && object &&
                            SUCCEEDED(object.As(&file)) && SUCCEEDED(file->get_Path(&path)) && path)
                            files.emplace_back(path);
                        CoTaskMemFree(path);
                    }
                try
                {
                    if (on_message)
                        on_message(Json::parse(text), std::move(files));
                }
                catch (const std::exception &)
                { /* malformed messages never cross the native boundary */
                }
                return S_OK;
            }).Get(), &token);
    view_->add_NavigationStarting(
        Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *args) -> HRESULT
            {
                LPWSTR uri = nullptr;
                args->get_Uri(&uri);
                bool allowed = uri && std::wstring_view(uri) == L"https://app.dr-reader.local/index.html";
                CoTaskMemFree(uri);
                if (!allowed)
                    args->put_Cancel(TRUE);
                return S_OK;
            }).Get(), &token);
    view_->add_NewWindowRequested(
        Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [](ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *args) -> HRESULT
            {
                args->put_Handled(TRUE);
                return S_OK;
            }).Get(), &token);
    if (ready)
        ready();
    // Give <body> the window's theme, and the page the height of a WebView2-drawn caption,
    // before the first paint; app.ts takes over once the settings load. Top-level app page only.
    std::wostringstream caption;
    caption << std::max(0.0, caption_height_);
    const std::wstring theme_script =
        L"if (window === top && location.host === 'app.dr-reader.local') "
        L"new MutationObserver((_, observer) => { "
        L"if (document.documentElement) { document.documentElement.style.setProperty('--caption-height', '" +
        caption.str() + L"px'); " + (caption_height_ > 0 ? L"document.documentElement.dataset.caption = 'web'; " : L"") +
        L"} "
        L"if (!document.body) return; "
        L"document.body.dataset.theme ??= '" + widen(theme_) + L"'; observer.disconnect(); })"
        L".observe(document, { childList: true, subtree: true });";
    view_->AddScriptToExecuteOnDocumentCreated(theme_script.c_str(), nullptr);
    view_->Navigate(L"https://app.dr-reader.local/index.html");
}
} // namespace dr