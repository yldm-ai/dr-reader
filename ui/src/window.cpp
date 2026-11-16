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
constexpr UINT_PTR delayed_timer = 44;
bool mouse_message(UINT m)
{
    switch (m)
    {
    case WM_MOUSEMOVE:
    case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_LBUTTONDBLCLK:
    case WM_RBUTTONDOWN: case WM_RBUTTONUP: case WM_RBUTTONDBLCLK:
    case WM_MBUTTONDOWN: case WM_MBUTTONUP: case WM_MBUTTONDBLCLK:
    case WM_XBUTTONDOWN: case WM_XBUTTONUP: case WM_XBUTTONDBLCLK:
    case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
    case WM_MOUSELEAVE:
        return true;
    }
    return false;
}
bool button_down(UINT m)
{
    return m == WM_LBUTTONDOWN || m == WM_RBUTTONDOWN || m == WM_MBUTTONDOWN || m == WM_XBUTTONDOWN ||
           m == WM_LBUTTONDBLCLK || m == WM_RBUTTONDBLCLK || m == WM_MBUTTONDBLCLK || m == WM_XBUTTONDBLCLK;
}
bool button_up(UINT m)
{
    return m == WM_LBUTTONUP || m == WM_RBUTTONUP || m == WM_MBUTTONUP || m == WM_XBUTTONUP;
}
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
bool Window::create(HINSTANCE instance, ShellStyle style, int icon_resource, double width_ratio, double height_ratio,
                    const std::string &theme)
{
    width_ratio_ = width_ratio;
    height_ratio_ = height_ratio;
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
    POINT cursor{};
    GetCursorPos(&cursor);
    MONITORINFO monitor{sizeof(monitor)};
    if (!GetMonitorInfoW(MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY), &monitor))
    {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &monitor.rcWork, 0);
        monitor.rcMonitor = monitor.rcWork;
    }
    const RECT &work = monitor.rcWork;
    const int width = std::min<int>(static_cast<int>((monitor.rcMonitor.right - monitor.rcMonitor.left) * width_ratio_),
                               work.right - work.left);
    const int height = std::min<int>(static_cast<int>((monitor.rcMonitor.bottom - monitor.rcMonitor.top) * height_ratio_),
                                work.bottom - work.top);
    hwnd_ = CreateWindowExW(0, wc.lpszClassName, title_.c_str(), WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                            work.left + (work.right - work.left - width) / 2,
                            work.top + (work.bottom - work.top - height) / 2, width, height, nullptr, nullptr,
                            instance, this);
    if (!hwnd_)
        return false;
    update_icons();
    apply_frame();
    set_theme(theme);
    // Shown before its first Direct2D frame (factory, fonts and render target take ~100 ms),
    // the window would appear as a blank white surface. Paint that frame while cloaked and
    // uncloak once DWM has it, so the first visible frame is the themed placeholder.
    BOOL cloak = TRUE;
    DwmSetWindowAttribute(hwnd_, DWMWA_CLOAK, &cloak, sizeof(cloak));
    ShowWindow(hwnd_, SW_SHOW);
    UpdateWindow(hwnd_);
    DwmFlush();
    cloak = FALSE;
    DwmSetWindowAttribute(hwnd_, DWMWA_CLOAK, &cloak, sizeof(cloak));
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
    // A WebView2 caption is part of the page, which therefore covers the whole client area.
    if (custom_caption() && style_ == ShellStyle::Direct2D)
        r.top = caption_height();
    return r;
}
RECT Window::input_bounds() const
{
    RECT r = content_bounds();
    // The caption strip, whoever draws it, is hit-tested and handled here.
    if (custom_caption())
        r.top = std::max<LONG>(r.top, caption_height());
    return r;
}
CaptionState Window::caption_state() const
{
    CaptionState state;
    state.visible = style_ == ShellStyle::WebView2 && custom_caption();
    if (!state.visible) return state;
    state.height = caption_height();
    state.button_width = scale(46);
    state.hot = hot_ == HTMINBUTTON || hot_ == HTMAXBUTTON || hot_ == HTCLOSE ? hot_ : HTNOWHERE;
    state.maximized = IsZoomed(hwnd_) != FALSE;
    state.title = title_;
    return state;
}
void Window::caption_changed()
{
    if (on_caption_change) on_caption_change();
}
void Window::update_cursor()
{
    POINT p{};
    if (!GetCursorPos(&p) || WindowFromPoint(p) != hwnd_) return;
    const auto hit = SendMessageW(hwnd_, WM_NCHITTEST, 0, MAKELPARAM(p.x, p.y));
    SendMessageW(hwnd_, WM_SETCURSOR, reinterpret_cast<WPARAM>(hwnd_), MAKELPARAM(hit, WM_MOUSEMOVE));
}
bool Window::relay_pointer()
{
    POINT p{};
    if (!on_mouse || !GetCursorPos(&p) || WindowFromPoint(p) != hwnd_) return false;
    ScreenToClient(hwnd_, &p);
    const RECT input = input_bounds();
    if (!PtInRect(&input, p)) return false;
    WPARAM keys = 0;
    if (GetKeyState(VK_LBUTTON) & 0x8000) keys |= MK_LBUTTON;
    if (GetKeyState(VK_RBUTTON) & 0x8000) keys |= MK_RBUTTON;
    if (GetKeyState(VK_MBUTTON) & 0x8000) keys |= MK_MBUTTON;
    if (GetKeyState(VK_SHIFT) & 0x8000) keys |= MK_SHIFT;
    if (GetKeyState(VK_CONTROL) & 0x8000) keys |= MK_CONTROL;
    const RECT content = content_bounds();
    on_mouse(WM_MOUSEMOVE, keys, POINT{p.x - content.left, p.y - content.top});
    return true;
}
void Window::after(UINT ms, std::function<void()> action)
{
    delayed_ = std::move(action);
    SetTimer(hwnd_, delayed_timer, ms, nullptr);
}
void Window::leave_content()
{
    if (!content_hovered_ || content_captured_) return;
    content_hovered_ = false;
    if (on_mouse) on_mouse(WM_MOUSELEAVE, 0, POINT{});
}
// Follows the visual-hosting input relay of Microsoft's WebView2APISample (ViewComponent::
// OnMouseMessage): points become WebView-relative, a press inside the page captures the mouse
// so drags continue outside the window, and leaving the page is reported once.
bool Window::relay_mouse(UINT m, WPARAM w, LPARAM l)
{
    if (!on_mouse || !mouse_message(m)) return false;
    if (m == WM_MOUSELEAVE)
    {
        leave_content();
        return false;
    }
    POINT p{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
    if (m == WM_MOUSEWHEEL || m == WM_MOUSEHWHEEL) ScreenToClient(hwnd_, &p);
    const RECT input = input_bounds();
    if (!content_captured_ && !PtInRect(&input, p))
    {
        leave_content();
        return false;
    }
    if (button_down(m) && !content_captured_)
    {
        if (on_focus) on_focus();
        content_captured_ = true;
        SetCapture(hwnd_);
    }
    if (!content_hovered_ && m != WM_MOUSEWHEEL && m != WM_MOUSEHWHEEL)
    {
        content_hovered_ = true;
        TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE, hwnd_, 0};
        TrackMouseEvent(&track);
    }
    const RECT content = content_bounds();
    on_mouse(m, w, POINT{p.x - content.left, p.y - content.top});
    if (button_up(m) && content_captured_ &&
        !(w & (MK_LBUTTON | MK_RBUTTON | MK_MBUTTON | MK_XBUTTON1 | MK_XBUTTON2)))
    {
        content_captured_ = false;
        ReleaseCapture();
        // A drag that ended outside the page leaves it now.
        if (!PtInRect(&input, p)) leave_content();
    }
    return true;
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
    caption_changed();
}
void Window::set_style(ShellStyle style)
{
    if(style_==style)return;
    caption_tip(HTNOWHERE);
    style_ = style;
    hot_ = pressed_ = HTNOWHERE;
    target_.Reset();
    apply_frame();
    if (on_resize)
        on_resize();
    InvalidateRect(hwnd_, nullptr, TRUE);
    caption_changed();
}
void Window::set_theme(const std::string &theme)
{
    follow_system_theme_ = theme == "system";
    DWORD light = 1, size = sizeof(light);
    if (follow_system_theme_)
        RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                     L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &light, &size);
    // Match the web application's --bg, --text and --hover in styles.css.
    const bool dark = theme == "dark" || (follow_system_theme_ && light == 0);
    const bool sepia = theme == "sepia";
    resolved_theme_ = dark ? "dark" : sepia ? "sepia" : "light";
    caption_background_ = dark ? 0x191919 : sepia ? 0xf5f1eb : 0xffffff;
    caption_text_ = dark ? 0xe6e6e5 : sepia ? 0x4a4036 : 0x37352f;
    caption_hover_ = dark ? 0x2c2c2c : sepia ? 0xeee7de : 0xf1f1ef;
    sidebar_ = dark ? 0x202020 : sepia ? 0xeee8df : 0xf7f7f5;
    border_ = dark ? 0x363636 : sepia ? 0xe5dcd0 : 0xe9e9e7;
    selected_ = dark ? 0x303030 : sepia ? 0xe8e0d5 : 0xebebea;
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
    caption_changed();
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
    caption_changed();
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
// As in the MSIME settings window (TitleBar::HitTestCaption), minimize and close are reported
// as client area and tracked here: the system shows its own "Minimize"/"Close" tooltips for
// HTMINBUTTON and HTCLOSE. Only maximize stays HTMAXBUTTON so Windows 11 offers Snap Layouts.
static bool client_caption_button(int hit)
{
    return hit == HTMINBUTTON || hit == HTCLOSE;
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
void Window::set_placeholder(bool shown)
{
    if (placeholder_ == shown) return;
    placeholder_ = shown;
    InvalidateRect(hwnd_, nullptr, FALSE);
}
// The library layout in placeholder blocks while WebView2 starts: the page's own geometry
// (styles.css .sidebar, .library-view, .search-field, .book-grid, .cover-wrap; the compact
// sizes below 1000px) in CSS pixels, which are this target's DIPs. Static, no text or icons,
// so it reads as "the library is coming" and the real page lands on the same shapes.
void Window::paint_placeholder(float top)
{
    Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> fill;
    target_->CreateSolidColorBrush(D2D1::ColorF(caption_hover_), &fill);
    if (!fill) return;
    const auto size = target_->GetSize();
    const float width = size.width, height = size.height - top;
    if (width < 320 || height < 240) return;
    const bool compact = width <= 1000;
    const auto block = [&](float x, float y, float w, float h, float radius, UINT32 color) {
        fill->SetColor(D2D1::ColorF(color));
        target_->FillRoundedRectangle(D2D1::RoundedRect(D2D1::RectF(x, top + y, x + w, top + y + h), radius, radius), fill.Get());
    };
    // Sidebar panel with its brand, import button, five library entries and settings.
    const float side_w = compact ? 195.f : 224.f, side_pad = compact ? 13.f : 12.f, side_top = compact ? 24.f : 20.f;
    const auto panel = D2D1::RoundedRect(D2D1::RectF(12.5f, top + 12.5f, 12.5f + side_w - 1, top + height - 12.5f), 14, 14);
    fill->SetColor(D2D1::ColorF(sidebar_));
    target_->FillRoundedRectangle(panel, fill.Get());
    fill->SetColor(D2D1::ColorF(border_));
    target_->DrawRoundedRectangle(panel, fill.Get(), 1);
    const float sx = 12 + side_pad, sw = side_w - 2 * side_pad;
    float y = 12 + side_top;
    block(sx + 8, y, 30, 32, 6, selected_);
    block(sx + 48, y + 5, 86, 11, 3, selected_);
    block(sx + 48, y + 22, 64, 8, 3, selected_);
    y += 54;
    block(sx, y, sw, 36, 4, selected_);
    y += 36 + 22;
    block(sx + 10, y, 48, 9, 3, selected_);
    y += 22;
    // Five four-character entries (全部图书 …), the first one selected.
    for (int i = 0; i < 5; ++i, y += 38)
    {
        if (i == 0) block(sx, y, sw, 36, 6, selected_);
        block(sx + 10, y + 10, 16, 16, 4, i == 0 ? caption_hover_ : selected_);
        block(sx + 38, y + 12, 56, 12, 3, i == 0 ? caption_hover_ : selected_);
    }
    block(sx + 10, height - 12 - 12 - 26, 16, 16, 4, selected_);
    block(sx + 38, height - 12 - 12 - 24, 72, 12, 3, selected_);
    // Library header, search field, sort and view controls.
    const float pad = compact ? 28.f : 40.f, mx = 12 + side_w + pad, mw = width - mx - pad;
    if (mw < 160) return;
    block(mx, 38, 112, 26, 5, caption_hover_);
    block(mx + 124, 40, 24, 22, 5, caption_hover_);
    block(mx, 98, std::min(compact ? 245.f : 330.f, mw), 38, 6, caption_hover_);
    if (mw > 560)
    {
        block(mx + mw - 36, 99, 36, 36, 6, caption_hover_);
        block(mx + mw - 80, 99, 36, 36, 6, caption_hover_);
        block(mx + mw - 104 - 130, 98, 130, 38, 6, caption_hover_);
    }
    // Book grid: auto-fill columns of at least 145px, 32px gaps, cards at most 210px wide.
    const int columns = std::max(1, int((mw + 32) / (145 + 32)));
    const float column = (mw - 32 * (columns - 1)) / columns, card = std::min(column, 210.f);
    const float cover = compact ? 205.f : 225.f, pitch = cover + 135;
    for (float row = 158; row < height; row += pitch)
        for (int i = 0; i < columns; ++i)
        {
            const float x = mx + i * (column + 32);
            block(x, row, card, cover, 5, caption_hover_);
            block(x + 5, row + cover + 23, card * .72f, 12, 3, caption_hover_);
            block(x + 5, row + cover + 50, card * .44f, 10, 3, caption_hover_);
        }
}
void Window::paint()
{
    PAINTSTRUCT ps{};
    BeginPaint(hwnd_, &ps);
    RECT rc{};
    GetClientRect(hwnd_, &rc);
    // The Direct2D shell owns the whole client area: until WebView2 paints, the content
    // area shows the theme background (the page's --bg) instead of an uncleared black target.
    if (style_ != ShellStyle::Mica && rc.right > 0 && rc.bottom > 0)
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
            Microsoft::WRL::ComPtr<IDWriteFontCollection> fonts;
            if (SUCCEEDED(write_->GetSystemFontCollection(&fonts)))
                for (const auto *name : {L"Segoe Fluent Icons", L"Segoe MDL2 Assets"})
                {
                    UINT32 index = 0;
                    BOOL exists = FALSE;
                    Microsoft::WRL::ComPtr<IDWriteFontFamily> family;
                    Microsoft::WRL::ComPtr<IDWriteFont> font;
                    Microsoft::WRL::ComPtr<IDWriteFontFace> face;
                    const UINT32 codes[] = {0xe921, 0xe922, 0xe923, 0xe8bb};
                    UINT16 glyphs[4] = {};
                    if (FAILED(fonts->FindFamilyName(name, &index, &exists)) || !exists ||
                        FAILED(fonts->GetFontFamily(index, &family)) ||
                        FAILED(family->GetFirstMatchingFont(DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                            DWRITE_FONT_STYLE_NORMAL, &font)) || FAILED(font->CreateFontFace(&face)) ||
                        FAILED(face->GetGlyphIndices(codes, 4, glyphs)) ||
                        std::any_of(std::begin(glyphs), std::end(glyphs), [](UINT16 glyph) { return glyph == 0; })) continue;
                    if (SUCCEEDED(write_->CreateTextFormat(name, nullptr, DWRITE_FONT_WEIGHT_NORMAL,
                            DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, 10, L"en-US", &caption_icons_))) break;
                }
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
            target_->Clear(D2D1::ColorF(caption_background_));
            if (placeholder_)
                paint_placeholder(custom_caption() ? height : 0);
            Microsoft::WRL::ComPtr<ID2D1SolidColorBrush> brush;
            target_->CreateSolidColorBrush(D2D1::ColorF(caption_background_), &brush);
            if (brush && draws_caption())
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
                    else
                    {
                        // Font-free last resort: caption controls must remain visible and usable.
                        const float cx = x + 23, cy = height / 2;
                        if (i == 0)
                            target_->DrawLine(D2D1::Point2F(cx - 5, cy), D2D1::Point2F(cx + 5, cy), brush.Get());
                        else if (i == 2)
                        {
                            target_->DrawLine(D2D1::Point2F(cx - 5, cy - 5), D2D1::Point2F(cx + 5, cy + 5), brush.Get());
                            target_->DrawLine(D2D1::Point2F(cx - 5, cy + 5), D2D1::Point2F(cx + 5, cy - 5), brush.Get());
                        }
                        else if (IsZoomed(hwnd_))
                        {
                            target_->DrawRectangle(D2D1::RectF(cx - 3, cy - 5, cx + 5, cy + 3), brush.Get());
                            brush->SetColor(D2D1::ColorF(hot_ == hit ? caption_hover_ : caption_background_));
                            target_->FillRectangle(D2D1::RectF(cx - 5, cy - 3, cx + 3, cy + 5), brush.Get());
                            brush->SetColor(D2D1::ColorF(caption_text_));
                            target_->DrawRectangle(D2D1::RectF(cx - 5, cy - 3, cx + 3, cy + 5), brush.Get());
                        }
                        else target_->DrawRectangle(D2D1::RectF(cx - 5, cy - 5, cx + 5, cy + 5), brush.Get());
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
    // A press that started in the page keeps the mouse until released, even over the caption.
    if (content_captured_ && relay_mouse(m, w, l))
        return 0;
    switch (m)
    {
    case WM_SETCURSOR:
        // Over the page, the cursor is the one the page asks for, and only this window sets it:
        // nothing else can switch it back while the page relayouts under a still pointer.
        if (LOWORD(l) == HTCLIENT && reinterpret_cast<HWND>(w) == hwnd_ && on_cursor)
        {
            POINT p{};
            GetCursorPos(&p);
            ScreenToClient(hwnd_, &p);
            const RECT input = input_bounds();
            if ((content_captured_ || PtInRect(&input, p)) && on_cursor())
                return TRUE;
        }
        break;
    case WM_SETFOCUS:
        if (on_focus) on_focus();
        break;
    case WM_MOVE:
        caption_tip(HTNOWHERE);
        if (on_move) on_move();
        break;
    case WM_CAPTURECHANGED:
        if (reinterpret_cast<HWND>(l) != hwnd_ && content_captured_)
        {
            content_captured_ = false;
            leave_content();
        }
        break;
    case WM_SETTINGCHANGE:
    case WM_THEMECHANGED:
        if (follow_system_theme_) set_theme("system");
        break;
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
        if (w && (style_ != ShellStyle::Mica || borderless_))
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
        if (w == delayed_timer)
        {
            KillTimer(hwnd_, delayed_timer);
            if (auto action = std::move(delayed_)) action();
            return 0;
        }
        if (w == caption_tip_timer)
        {
            KillTimer(hwnd_, caption_tip_timer);
            if (tip_ != HTNOWHERE && pressed_ == HTNOWHERE && custom_caption() && on_caption_tooltip)
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
        MONITORINFO monitor{sizeof(monitor)};
        info->ptMinTrackSize = {scale(780), scale(540)};
        if (GetMonitorInfoW(MonitorFromWindow(hwnd_, MONITOR_DEFAULTTONEAREST), &monitor))
        {
            // High DPI or a small screen must not force the initial window above its screen fraction.
            info->ptMinTrackSize.x = std::min<LONG>(info->ptMinTrackSize.x,
                std::min<int>(static_cast<int>((monitor.rcMonitor.right - monitor.rcMonitor.left) * width_ratio_),
                         monitor.rcWork.right - monitor.rcWork.left));
            info->ptMinTrackSize.y = std::min<LONG>(info->ptMinTrackSize.y,
                std::min<int>(static_cast<int>((monitor.rcMonitor.bottom - monitor.rcMonitor.top) * height_ratio_),
                         monitor.rcWork.bottom - monitor.rcWork.top));
        }
        return 0;
    }
    case WM_DPICHANGED:
    {
        update_icons();
        auto r = reinterpret_cast<RECT *>(l);
        SetWindowPos(hwnd_, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER);
        if (on_resize)
            on_resize();
        caption_changed();
        return 0;
    }
    case WM_SIZE:
    {
        if (target_)
            target_->Resize(D2D1::SizeU(LOWORD(l), HIWORD(l)));
        if (on_resize)
            on_resize();
        InvalidateRect(hwnd_, nullptr, FALSE);
        caption_changed();
        return 0;
    }
    // A click into the inactive window activates it and still reaches what it was on (buttons, links,
    // the sidebar). Only the page tap is skipped, by the reader itself (Reader.beginPageTap): eating
    // the button-down here (MA_ACTIVATEANDEAT) also swallowed every other control's click.
    case WM_ACTIVATE:
        InvalidateRect(hwnd_, nullptr, FALSE);
        break;
    case WM_DESTROY:
        RevokeDragDrop(hwnd_); // the page's drop target, if one was registered
        content_captured_ = false;
        if (small_icon_)
            DestroyIcon(small_icon_);
        if (large_icon_)
            DestroyIcon(large_icon_);
        small_icon_ = large_icon_ = nullptr;
        PostQuitMessage(0);
        return 0;
    }
    if (custom_caption())
    {
        // A WebView2 caption repaints from caption_state(), so report hover changes to it.
        struct HotChange
        {
            Window *self;
            int before;
            ~HotChange() { if (self->hot_ != before) self->caption_changed(); }
        } hot_change{this, hot_};
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
            const auto hit = caption_hit(p);
            return client_caption_button(hit) ? HTCLIENT : hit;
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
            // Leaving maximize for minimize arrives after that button's WM_MOUSEMOVE.
            if (client_caption_button(hot_))
                return 0;
            hot_ = HTNOWHERE;
            caption_tip(HTNOWHERE);
            InvalidateRect(hwnd_, nullptr, FALSE);
            return 0;
        case WM_NCLBUTTONDOWN:
            if (w == HTMAXBUTTON)
            {
                caption_tip(HTNOWHERE);
                pressed_ = static_cast<int>(w);
                SetCapture(hwnd_);
                return 0;
            }
            break;
        case WM_LBUTTONDOWN:
        {
            POINT p{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
            const auto hit = caption_hit(p);
            if (client_caption_button(hit))
            {
                caption_tip(HTNOWHERE);
                hot_ = pressed_ = hit;
                SetCapture(hwnd_);
                InvalidateRect(hwnd_, nullptr, FALSE);
                return 0;
            }
            break;
        }
        case WM_MOUSEMOVE:
        {
            POINT p{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
            if (pressed_ != HTNOWHERE)
            {
                hot_ = caption_hit(p);
                InvalidateRect(hwnd_, nullptr, FALSE);
                return 0;
            }
            const auto hit = caption_hit(p);
            if (client_caption_button(hit))
            {
                leave_content();
                if (hot_ != hit)
                {
                    hot_ = hit;
                    InvalidateRect(hwnd_, nullptr, FALSE);
                }
                caption_tip(hit);
                TRACKMOUSEEVENT t{sizeof(t), TME_LEAVE, hwnd_, 0};
                TrackMouseEvent(&t);
                return 0;
            }
            if (client_caption_button(hot_))
            {
                hot_ = HTNOWHERE;
                caption_tip(HTNOWHERE);
                InvalidateRect(hwnd_, nullptr, FALSE);
            }
            break;
        }
        case WM_MOUSELEAVE:
            if (client_caption_button(hot_) && pressed_ == HTNOWHERE)
            {
                hot_ = HTNOWHERE;
                caption_tip(HTNOWHERE);
                InvalidateRect(hwnd_, nullptr, FALSE);
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
    if (relay_mouse(m, w, l))
        return 0;
    return DefWindowProcW(hwnd_, m, w, l);
}
} // namespace dr
