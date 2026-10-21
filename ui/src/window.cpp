#include "dr/window.h"
#include <algorithm>
#include <dwmapi.h>
#include <windowsx.h>
namespace dr
{
namespace
{
constexpr UINT dispatch = WM_APP + 1;
constexpr UINT_PTR caption_tip_timer = 43;
}
int Window::scale(int x) const
{
    return MulDiv(x, GetDpiForWindow(hwnd_), 96);
}
int Window::caption_height() const
{
    const auto dpi=GetDpiForWindow(hwnd_);
    RECT frame{};
    AdjustWindowRectExForDpi(&frame,WS_OVERLAPPEDWINDOW,FALSE,0,dpi);
    const int resize=GetSystemMetricsForDpi(SM_CYFRAME,dpi)+GetSystemMetricsForDpi(SM_CXPADDEDBORDER,dpi);
    return -frame.top-(IsZoomed(hwnd_)?resize:0);
}
bool Window::create(HINSTANCE instance, ShellStyle style, int icon_resource)
{
    style_ = style;
    icon_resource_ = icon_resource;
    WNDCLASSEXW wc{sizeof(wc)};
    wc.hInstance = instance;
    wc.lpfnWndProc = procedure;
    wc.lpszClassName = L"DRReader.NativeShell";
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(icon_resource_));
    wc.hIconSm = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(icon_resource_), IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_SHARED));
    RegisterClassExW(&wc);
    RECT work{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    auto dpi = GetDpiForSystem();
    int width = std::min<int>(MulDiv(1280, dpi, 96), work.right - work.left - MulDiv(48, dpi, 96));
    // 1027 DIP is the former 880 DIP default plus one sixth; still bounded by the work area.
    int height = std::min<int>(MulDiv(1027, dpi, 96), work.bottom - work.top - MulDiv(48, dpi, 96));
    hwnd_ = CreateWindowExW(0, wc.lpszClassName, title_.c_str(), WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                            work.left + (work.right - work.left - width) / 2,
                            work.top + (work.bottom - work.top - height) / 2, width, height, nullptr, nullptr,
                            instance, this);
    if (!hwnd_)
        return false;
    update_icons();
    apply_frame();
    ShowWindow(hwnd_, SW_SHOW);
    UpdateWindow(hwnd_);
    return true;
}
void Window::update_icons()
{
    const auto dpi = GetDpiForWindow(hwnd_);
    const auto instance = reinterpret_cast<HINSTANCE>(GetWindowLongPtrW(hwnd_, GWLP_HINSTANCE));
    // Own DPI-specific window icons; class icons remain shared system resources.
    for (const auto size : {ICON_SMALL, ICON_BIG})
    {
        const bool is_small = size == ICON_SMALL;
        const auto icon = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(icon_resource_), IMAGE_ICON,
            GetSystemMetricsForDpi(is_small ? SM_CXSMICON : SM_CXICON, dpi),
            GetSystemMetricsForDpi(is_small ? SM_CYSMICON : SM_CYICON, dpi), LR_DEFAULTCOLOR));
        if (icon)
        {
            SendMessageW(hwnd_, WM_SETICON, size, reinterpret_cast<LPARAM>(icon));
            auto &previous = is_small ? small_icon_ : large_icon_;
            if (previous)
                DestroyIcon(previous);
            previous = icon;
        }
    }
}
RECT Window::content_bounds() const
{
    RECT r{};
    GetClientRect(hwnd_, &r);
    if (draws_caption())
        r.top = caption_height();
    return r;
}
RECT Window::screen_content() const
{
    RECT r = content_bounds();
    MapWindowPoints(hwnd_, nullptr, reinterpret_cast<POINT *>(&r), 2);
    return r;
}
void Window::set_title(const std::wstring &title)
{
    title_ = title;
    SetWindowTextW(hwnd_, title.c_str());
    InvalidateRect(hwnd_, nullptr, FALSE);
}
void Window::set_style(ShellStyle style)
{
    if(style_==style)return;
    caption_tip(HTNOWHERE);
    style_ = style;
    target_.Reset();
    apply_frame();
    if (on_resize)
        on_resize();
    InvalidateRect(hwnd_, nullptr, TRUE);
}
void Window::set_theme(const std::string &theme)
{
    // Match the web application's --bg, --text and --hover in styles.css.
    const bool dark = theme == "dark";
    const bool sepia = theme == "sepia";
    caption_background_ = dark ? 0x191919 : sepia ? 0xf5f1eb : 0xffffff;
    caption_text_ = dark ? 0xe6e6e5 : sepia ? 0x4a4036 : 0x37352f;
    caption_hover_ = dark ? 0x2c2c2c : sepia ? 0xeee7de : 0xf1f1ef;
    BOOL value = dark;
    DwmSetWindowAttribute(hwnd_, 20, &value, sizeof(value));
    InvalidateRect(hwnd_, nullptr, FALSE);
}
void Window::set_fullscreen(bool enabled)
{
    if (fullscreen_ == enabled) return;
    caption_tip(HTNOWHERE);
    if (enabled)
    {
        windowed_placement_.length = sizeof(WINDOWPLACEMENT);
        GetWindowPlacement(hwnd_, &windowed_placement_);
        windowed_style_ = GetWindowLongPtrW(hwnd_, GWL_STYLE);
        MONITORINFO monitor{sizeof(MONITORINFO)};
        GetMonitorInfoW(MonitorFromWindow(hwnd_, MONITOR_DEFAULTTONEAREST), &monitor);
        fullscreen_ = true;
        SetWindowLongPtrW(hwnd_, GWL_STYLE, windowed_style_ & ~WS_OVERLAPPEDWINDOW);
        apply_frame();
        SetWindowPos(hwnd_, HWND_TOP, monitor.rcMonitor.left, monitor.rcMonitor.top,
                     monitor.rcMonitor.right - monitor.rcMonitor.left,
                     monitor.rcMonitor.bottom - monitor.rcMonitor.top,
                     SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
    }
    else
    {
        fullscreen_ = false;
        SetWindowLongPtrW(hwnd_, GWL_STYLE, windowed_style_);
        apply_frame();
        SetWindowPlacement(hwnd_, &windowed_placement_);
        SetWindowPos(hwnd_, nullptr, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    }
    target_.Reset();
    if (on_resize) on_resize();
    InvalidateRect(hwnd_, nullptr, TRUE);
}
void Window::set_borderless(bool enabled)
{
    if (borderless_ == enabled) return;
    caption_tip(HTNOWHERE);
    // The page stays in place; the title bar is added or removed around it.
    const RECT before = screen_content();
    RECT window{};
    GetWindowRect(hwnd_, &window);
    borderless_ = enabled;
    target_.Reset();
    apply_frame();
    // Maximized and fullscreen windows keep filling their monitor.
    if (!fullscreen_ && !IsZoomed(hwnd_))
    {
        const RECT after = screen_content();
        window.left += before.left - after.left;
        window.top += before.top - after.top;
        window.right += before.right - after.right;
        window.bottom += before.bottom - after.bottom;
        // Keep a returning title bar on screen.
        MONITORINFO monitor{sizeof(MONITORINFO)};
        if (!enabled && GetMonitorInfoW(MonitorFromWindow(hwnd_, MONITOR_DEFAULTTONEAREST), &monitor) &&
            window.top < monitor.rcWork.top)
            OffsetRect(&window, 0, monitor.rcWork.top - window.top);
        SetWindowPos(hwnd_, nullptr, window.left, window.top, window.right - window.left,
                     window.bottom - window.top, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }
    if (on_resize) on_resize();
    InvalidateRect(hwnd_, nullptr, TRUE);
}
void Window::apply_frame()
{
    DWORD backdrop = style_ == ShellStyle::Mica && !fullscreen_ ? 2 : 1;
    mica_available_ = SUCCEEDED(DwmSetWindowAttribute(hwnd_, 38, &backdrop, sizeof(backdrop))) &&
                      style_ == ShellStyle::Mica && !fullscreen_;
    DWORD corners = fullscreen_ ? 1 : 2;
    DwmSetWindowAttribute(hwnd_, 33, &corners, sizeof(corners));
    MARGINS margins{0, 0, style_ == ShellStyle::Mica && !fullscreen_ && !borderless_ ? 1 : 0, 0};
    DwmExtendFrameIntoClientArea(hwnd_, &margins);
    SetWindowPos(hwnd_, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
}
void Window::post(std::function<void()> fn)
{
    {
        std::lock_guard lock(mutex_);
        pending_.push_back(std::move(fn));
    }
    PostMessageW(hwnd_, dispatch, 0, 0);
}
int Window::caption_hit(POINT p) const
{
    RECT r{};
    GetClientRect(hwnd_, &r);
    if (p.y < 0 || p.y >= caption_height())
        return HTCLIENT;
    int w = scale(46);
    if (p.x >= r.right - w)
        return HTCLOSE;
    if (p.x >= r.right - w * 2)
        return HTMAXBUTTON;
    if (p.x >= r.right - w * 3)
        return HTMINBUTTON;
    return HTCAPTION;
}
RECT Window::caption_button(int hit) const
{
    RECT r{};
    GetClientRect(hwnd_, &r);
    const int w = scale(46), slot = hit == HTCLOSE ? 1 : hit == HTMAXBUTTON ? 2 : 3;
    return {r.right - w * slot, 0, r.right - w * (slot - 1), caption_height()};
}
// As in the MSIME settings window, a caption button's tip waits 500 ms under a still pointer
// and goes away as soon as the pointer moves to another part of the caption or presses.
void Window::caption_tip(int hit)
{
    const int button = hit == HTMINBUTTON || hit == HTMAXBUTTON || hit == HTCLOSE ? hit : HTNOWHERE;
    if (button == tip_)
        return;
    tip_ = button;
    KillTimer(hwnd_, caption_tip_timer);
    if (on_caption_tooltip)
        on_caption_tooltip(L"", RECT{});
    if (button != HTNOWHERE)
        SetTimer(hwnd_, caption_tip_timer, 500, nullptr);
}
void Window::paint()
{
    PAINTSTRUCT ps{};
    BeginPaint(hwnd_, &ps);
    RECT rc{};
    GetClientRect(hwnd_, &rc);
    if (draws_caption() && rc.right > 0 && rc.bottom > 0)
    {
        if (!factory_)
            D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, factory_.GetAddressOf());
        if (!write_)
            DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                reinterpret_cast<IUnknown **>(write_.GetAddressOf()));
        if (write_ && !text_)
        {
            const wchar_t *family = L"Segoe UI";
            Microsoft::WRL::ComPtr<IDWriteFontCollection> fonts;
            if (SUCCEEDED(write_->GetSystemFontCollection(&fonts)))
            {
                for (const auto candidate : {L"Microsoft YaHei", L"Microsoft YaHei UI", L"Noto Sans SC",
                                             L"Noto Sans CJK SC", L"Segoe UI"})
                {
                    UINT32 index = 0;
                    BOOL exists = FALSE;
                    if (SUCCEEDED(fonts->FindFamilyName(candidate, &index, &exists)) && exists)
                    {
                        family = candidate;
                        break;
                    }
                }
            }
            write_->CreateTextFormat(family, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                                     DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 12, L"zh-CN",
                                     &text_);
            if (text_)
            {
                text_->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
                // Long book titles end in an ellipsis before the caption buttons instead of being cut.
                text_->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
                Microsoft::WRL::ComPtr<IDWriteInlineObject> ellipsis;
                if (SUCCEEDED(write_->CreateEllipsisTrimmingSign(text_.Get(), &ellipsis)))
                {
                    const DWRITE_TRIMMING trimming{DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0};
                    text_->SetTrimming(&trimming, ellipsis.Get());
                }
            }
        }
        if (write_ && !caption_icons_)
        {
            const wchar_t *family = L"Segoe Fluent Icons";
            Microsoft::WRL::ComPtr<IDWriteFontCollection> fonts;
            UINT32 index = 0;
            BOOL exists = FALSE;
            if (SUCCEEDED(write_->GetSystemFontCollection(&fonts)) &&
                SUCCEEDED(fonts->FindFamilyName(family, &index, &exists)) && !exists)
                family = L"Segoe MDL2 Assets";
            write_->CreateTextFormat(family, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                                     DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 10, L"en-US",
                                     &caption_icons_);
            if (caption_icons_)
            {
                caption_icons_->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
                caption_icons_->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
                caption_icons_->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
            }
        }
        if (factory_ && !target_)
            factory_->CreateHwndRenderTarget(
                D2D1::RenderTargetProperties(),
                D2D1::HwndRenderTargetProperties(hwnd_, D2D1::SizeU(rc.right, rc.bottom)), &target_);
        if (target_)
        {
            target_->SetDpi(float(GetDpiForWindow(hwnd_)), float(GetDpiForWindow(hwnd_)));
            auto size = target_->GetSize();
            const float height=caption_height()*96.0f/GetDpiForWindow(hwnd_);
            target_->BeginDraw();
            Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> brush;
            target_->CreateSolidColorBrush(D2D1::ColorF(caption_background_), &brush);
            if (brush)
            {
                target_->FillRectangle(D2D1::RectF(0, 0, size.width, height), brush.Get());
                brush->SetColor(D2D1::ColorF(caption_text_));
                if (text_)
                    target_->DrawTextW(title_.c_str(), static_cast<UINT32>(title_.size()), text_.Get(),
                                       D2D1::RectF(10, 0, std::max(10.f, size.width - 150), height), brush.Get(),
                                       D2D1_DRAW_TEXT_OPTIONS_CLIP);
                for (int i = 0; i < 3; ++i)
                {
                    int hit = i == 0 ? HTMINBUTTON : i == 1 ? HTMAXBUTTON : HTCLOSE;
                    float x = size.width - 46 * (3 - i);
                    if (hot_ == hit)
                    {
                        brush->SetColor(D2D1::ColorF(hit == HTCLOSE ? 0xc42b1c : caption_hover_));
                        target_->FillRectangle(D2D1::RectF(x, 0, x + 46, height), brush.Get());
                    }
                    brush->SetColor(D2D1::ColorF(
                        hot_ == HTCLOSE && hit == HTCLOSE ? 0xffffff : caption_text_));
                    // Segoe Fluent Icons: ChromeMinimize, ChromeMaximize/Restore, ChromeClose.
                    const wchar_t glyph = i == 0 ? L'\uE921'
                                          : i == 1 ? (IsZoomed(hwnd_) ? L'\uE923' : L'\uE922')
                                                   : L'\uE8BB';
                    if (caption_icons_)
                        target_->DrawTextW(&glyph, 1, caption_icons_.Get(),
                                           D2D1::RectF(x, 0, x + 46, height), brush.Get(),
                                           D2D1_DRAW_TEXT_OPTIONS_CLIP);
                }
            }
            if (target_->EndDraw() == D2DERR_RECREATE_TARGET)
                target_.Reset();
        }
    }
    EndPaint(hwnd_, &ps);
}
LRESULT CALLBACK Window::procedure(HWND h, UINT m, WPARAM w, LPARAM l)
{
    auto self = reinterpret_cast<Window *>(GetWindowLongPtrW(h, GWLP_USERDATA));
    if (m == WM_NCCREATE)
    {
        self = static_cast<Window *>(reinterpret_cast<CREATESTRUCTW *>(l)->lpCreateParams);
        self->hwnd_ = h;
        SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    return self ? self->message(m, w, l) : DefWindowProcW(h, m, w, l);
}
LRESULT Window::message(UINT m, WPARAM w, LPARAM l)
{
    if (m == dispatch)
    {
        std::vector<std::function<void()>> work;
        {
            std::lock_guard lock(mutex_);
            work.swap(pending_);
        }
        for (auto &fn : work)
            fn();
        return 0;
    }
    switch (m)
    {
    case WM_SYSKEYDOWN:
        if (w == VK_RETURN && (GetKeyState(VK_MENU) & 0x8000))
        {
            if (!(l & (1LL << 30)) && on_toggle_borderless) on_toggle_borderless();
            return 0;
        }
        break;
    case WM_NCCALCSIZE:
        if (fullscreen_) return 0;
        // The Direct2D caption and a hidden title bar both keep the invisible side and bottom
        // resize borders while the caption height becomes client area.
        if (w && (style_ == ShellStyle::Direct2D || borderless_))
        {
            auto p = reinterpret_cast<NCCALCSIZE_PARAMS *>(l);
            auto top = p->rgrc[0].top;
            auto result = DefWindowProcW(hwnd_, m, w, l);
            p->rgrc[0].top =
                top + (IsZoomed(hwnd_)
                           ? GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(hwnd_)) +
                                 GetSystemMetricsForDpi(SM_CXPADDEDBORDER, GetDpiForWindow(hwnd_))
                           : 0);
            return result;
        }
        break;
    case WM_NCHITTEST:
        if (fullscreen_) return HTCLIENT;
        break;
    case WM_PAINT:
        paint();
        return 0;
    case WM_ERASEBKGND:
        return 1;
    case WM_CLOSE:
        if (on_close)
        {
            on_close();
            SetTimer(hwnd_, 42, 1800, nullptr);
            return 0;
        }
        break;
    case WM_TIMER:
        if (w == 42)
        {
            DestroyWindow(hwnd_);
            return 0;
        }
        if (w == caption_tip_timer)
        {
            KillTimer(hwnd_, caption_tip_timer);
            if (tip_ != HTNOWHERE && pressed_ == HTNOWHERE && draws_caption() && on_caption_tooltip)
                on_caption_tooltip(tip_ == HTMINBUTTON   ? L"最小化"
                                   : tip_ == HTCLOSE     ? L"关闭"
                                   : IsZoomed(hwnd_)     ? L"向下还原"
                                                         : L"最大化",
                                   caption_button(tip_));
            return 0;
        }
        break;
    case WM_GETMINMAXINFO:
    {
        auto info = reinterpret_cast<MINMAXINFO *>(l);
        info->ptMinTrackSize = {scale(780), scale(540)};
        return 0;
    }
    case WM_DPICHANGED:
    {
        update_icons();
        auto r = reinterpret_cast<RECT *>(l);
        SetWindowPos(hwnd_, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER);
        if (on_resize)
            on_resize();
        return 0;
    }
    case WM_SIZE:
    {
        if (target_)
            target_->Resize(D2D1::SizeU(LOWORD(l), HIWORD(l)));
        if (on_resize)
            on_resize();
        InvalidateRect(hwnd_, nullptr, FALSE);
        return 0;
    }
    case WM_ACTIVATE:
        InvalidateRect(hwnd_, nullptr, FALSE);
        break;
    case WM_DESTROY:
        if (small_icon_)
            DestroyIcon(small_icon_);
        if (large_icon_)
            DestroyIcon(large_icon_);
        small_icon_ = large_icon_ = nullptr;
        PostQuitMessage(0);
        return 0;
    }
    if (draws_caption())
    {
        switch (m)
        {
        case WM_NCHITTEST:
        {
            auto result = DefWindowProcW(hwnd_, m, w, l);
            if (result != HTCLIENT)
                return result;
            POINT p{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
            ScreenToClient(hwnd_, &p);
            if (!IsZoomed(hwnd_) && p.y < scale(6))
                return HTTOP;
            return caption_hit(p);
        }
        case WM_NCMOUSEMOVE:
        {
            hot_ = static_cast<int>(w);
            if (pressed_ == HTNOWHERE)
                caption_tip(hot_);
            TRACKMOUSEEVENT t{sizeof(t), TME_NONCLIENT | TME_LEAVE, hwnd_, 0};
            TrackMouseEvent(&t);
            InvalidateRect(hwnd_, nullptr, FALSE);
            if (hot_ == HTMAXBUTTON)
                break;
            return 0;
        }
        case WM_NCMOUSELEAVE:
            hot_ = HTNOWHERE;
            caption_tip(HTNOWHERE);
            InvalidateRect(hwnd_, nullptr, FALSE);
            return 0;
        case WM_NCLBUTTONDOWN:
            if (w == HTMINBUTTON || w == HTMAXBUTTON || w == HTCLOSE)
            {
                caption_tip(HTNOWHERE);
                pressed_ = static_cast<int>(w);
                SetCapture(hwnd_);
                return 0;
            }
            break;
        case WM_MOUSEMOVE:
            if (pressed_ != HTNOWHERE)
            {
                POINT p{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
                hot_ = caption_hit(p);
                InvalidateRect(hwnd_, nullptr, FALSE);
                return 0;
            }
            break;
        case WM_LBUTTONUP:
            if (pressed_ != HTNOWHERE)
            {
                POINT p{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
                auto hit = caption_hit(p);
                auto old = pressed_;
                pressed_ = HTNOWHERE;
                ReleaseCapture();
                if (hit == old)
                    PostMessageW(hwnd_, WM_SYSCOMMAND,
                                 hit == HTCLOSE       ? SC_CLOSE
                                 : hit == HTMINBUTTON ? SC_MINIMIZE
                                 : IsZoomed(hwnd_)    ? SC_RESTORE
                                                      : SC_MAXIMIZE,
                                 0);
                return 0;
            }
            break;
        case WM_CAPTURECHANGED:
            pressed_ = HTNOWHERE;
            break;
        }
    }
    return DefWindowProcW(hwnd_, m, w, l);
}
} // namespace dr
