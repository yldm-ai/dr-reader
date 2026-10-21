#include "dr/window.h"
#include <algorithm>
#include <dwmapi.h>
#include <windowsx.h>
namespace dr
{
namespace
{
constexpr UINT dispatch = WM_APP + 1;
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
    int height = std::min<int>(MulDiv(880, dpi, 96), work.bottom - work.top - MulDiv(48, dpi, 96));
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
    if (style_ == ShellStyle::Direct2D)
        r.top = caption_height();
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
    style_ = style;
    target_.Reset();
    apply_frame();
    if (on_resize)
        on_resize();
    InvalidateRect(hwnd_, nullptr, TRUE);
}
void Window::set_dark(bool dark)
{
    dark_ = dark;
    BOOL value = dark;
    DwmSetWindowAttribute(hwnd_, 20, &value, sizeof(value));
    InvalidateRect(hwnd_, nullptr, FALSE);
}
void Window::apply_frame()
{
    DWORD backdrop = style_ == ShellStyle::Mica ? 2 : 1;
    mica_available_ = SUCCEEDED(DwmSetWindowAttribute(hwnd_, 38, &backdrop, sizeof(backdrop))) &&
                      style_ == ShellStyle::Mica;
    DWORD corners = 2;
    DwmSetWindowAttribute(hwnd_, 33, &corners, sizeof(corners));
    MARGINS margins{0, 0, style_ == ShellStyle::Mica ? 1 : 0, 0};
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
void Window::paint()
{
    PAINTSTRUCT ps{};
    BeginPaint(hwnd_, &ps);
    RECT rc{};
    GetClientRect(hwnd_, &rc);
    if (style_ == ShellStyle::Direct2D && rc.right > 0 && rc.bottom > 0)
    {
        if (!factory_)
            D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, factory_.GetAddressOf());
        if (!write_)
            DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                reinterpret_cast<IUnknown **>(write_.GetAddressOf()));
        if (write_ && !text_)
        {
            write_->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                                     DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 12, L"zh-CN",
                                     &text_);
            if (text_)
                text_->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
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
            target_->CreateSolidColorBrush(D2D1::ColorF(dark_ ? 0x20211f : 0xf4f3ef), &brush);
            if (brush)
            {
                target_->FillRectangle(D2D1::RectF(0, 0, size.width, height), brush.Get());
                brush->SetColor(D2D1::ColorF(dark_ ? 0xe3e3dd : 0x30372f));
                if (text_)
                    target_->DrawTextW(title_.c_str(), static_cast<UINT32>(title_.size()), text_.Get(),
                                       D2D1::RectF(18, 0, std::max(18.f, size.width - 150), height), brush.Get(),
                                       D2D1_DRAW_TEXT_OPTIONS_CLIP);
                for (int i = 0; i < 3; ++i)
                {
                    int hit = i == 0 ? HTMINBUTTON : i == 1 ? HTMAXBUTTON : HTCLOSE;
                    float x = size.width - 46 * (3 - i);
                    if (hot_ == hit)
                    {
                        brush->SetColor(D2D1::ColorF(hit == HTCLOSE ? 0xc42b1c
                                                     : dark_        ? 0x363832
                                                                    : 0xe5e5df));
                        target_->FillRectangle(D2D1::RectF(x, 0, x + 46, height), brush.Get());
                    }
                    brush->SetColor(D2D1::ColorF(hot_ == HTCLOSE && hit == HTCLOSE ? 0xffffff
                                                 : dark_                           ? 0xe3e3dd
                                                                                   : 0x30372f));
                    float cx = x + 23, cy = height/2;
                    if (i == 0)
                        target_->DrawLine({cx - 5, cy}, {cx + 5, cy}, brush.Get());
                    else if (i == 1)
                    {
                        if (IsZoomed(hwnd_))
                        {
                            target_->DrawRectangle(D2D1::RectF(cx - 3, cy - 6, cx + 6, cy + 3), brush.Get());
                            target_->DrawRectangle(D2D1::RectF(cx - 5, cy - 4, cx + 4, cy + 5), brush.Get());
                        }
                        else
                            target_->DrawRectangle(D2D1::RectF(cx - 5, cy - 5, cx + 5, cy + 5), brush.Get());
                    }
                    else
                    {
                        target_->DrawLine({cx - 5, cy - 5}, {cx + 5, cy + 5}, brush.Get());
                        target_->DrawLine({cx - 5, cy + 5}, {cx + 5, cy - 5}, brush.Get());
                    }
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
    if (style_ == ShellStyle::Direct2D)
    {
        switch (m)
        {
        case WM_NCCALCSIZE:
            if (w)
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
            TRACKMOUSEEVENT t{sizeof(t), TME_NONCLIENT | TME_LEAVE, hwnd_, 0};
            TrackMouseEvent(&t);
            InvalidateRect(hwnd_, nullptr, FALSE);
            if (hot_ == HTMAXBUTTON)
                break;
            return 0;
        }
        case WM_NCMOUSELEAVE:
            hot_ = HTNOWHERE;
            InvalidateRect(hwnd_, nullptr, FALSE);
            return 0;
        case WM_NCLBUTTONDOWN:
            if (w == HTMINBUTTON || w == HTMAXBUTTON || w == HTCLOSE)
            {
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
