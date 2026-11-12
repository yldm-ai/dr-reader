#pragma once
#include <d2d1.h>
#include <dwrite.h>
#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <vector>
#include <windows.h>
#include <wrl.h>
namespace dr
{
enum class ShellStyle
{
    Mica,
    Direct2D
};
// The native shell knows nothing about books or WebView2.
class Window
{
  public:
    /** `theme` is applied before the window is first shown, so the first frame already matches it. */
    bool create(HINSTANCE instance, ShellStyle style, int icon_resource, double width_ratio = 0.6, double height_ratio = 0.75,
                const std::string &theme = "light");
    HWND handle() const
    {
        return hwnd_;
    }
    RECT content_bounds() const;
    void set_style(ShellStyle style);
    void set_theme(const std::string &theme);
    /** The theme's window background (0xRRGGBB), equal to the page's --bg. */
    UINT32 background() const { return caption_background_; }
    /** "light", "dark" or "sepia", with "system" resolved from the Windows app theme. */
    const char *resolved_theme() const { return resolved_theme_; }
    void set_fullscreen(bool enabled);
    bool fullscreen() const { return fullscreen_; }
    /**
     * Keeps the system cursor on the horizontal-resize shape until released. WebView2
     * re-selects the CSS cursor whenever the page reflows under the pointer, so a resize
     * handle that changes the layout would otherwise flicker between two cursor images.
     */
    void set_resize_cursor(bool enabled);
    // Hides the title bar of either shell while keeping the window, its content position,
    // shadow, rounded corners, snapping and side/bottom resize borders.
    void set_borderless(bool enabled);
    bool borderless() const { return borderless_; }
    void set_title(const std::wstring &title);
    void post(std::function<void()> action);
    /**
     * While shown (the default), the Direct2D shell draws a static placeholder of the library
     * layout in the theme's colours, for the time before the web content is ready.
     */
    void set_placeholder(bool shown);
    std::function<void()> on_resize;
    std::function<void()> on_close;
    std::function<void()> on_toggle_borderless;
    // Hover tip for a Direct2D caption button: its text and client-pixel rectangle, or an
    // empty text to hide it. The tip is drawn below the caption, over the web content.
    std::function<void(const std::wstring &, RECT)> on_caption_tooltip;
    bool mica_available() const
    {
        return mica_available_;
    }

  private:
    double width_ratio_ = 0.6;
    double height_ratio_ = 0.75;
    bool follow_system_theme_ = false;
    static LRESULT CALLBACK procedure(HWND, UINT, WPARAM, LPARAM);
    static LRESULT CALLBACK resize_cursor_hook(int, WPARAM, LPARAM);
    static LRESULT CALLBACK resize_cursor_message_hook(int, WPARAM, LPARAM);
    static void CALLBACK resize_cursor_tick_proc(PVOID, BOOLEAN);
    LRESULT message(UINT, WPARAM, LPARAM);
    void paint();
    void paint_placeholder(float top);
    int caption_hit(POINT point) const;
    RECT caption_button(int hit) const;
    void caption_tip(int hit);
    void apply_frame();
    void update_icons();
    int scale(int dip) const;
    int caption_height() const;
    // The custom caption is drawn only by a windowed Direct2D shell that shows its title bar.
    bool draws_caption() const { return style_ == ShellStyle::Direct2D && !fullscreen_ && !borderless_; }
    RECT screen_content() const;
    HWND hwnd_ = nullptr;
    int icon_resource_ = 0;
    HICON small_icon_ = nullptr, large_icon_ = nullptr;
    ShellStyle style_ = ShellStyle::Mica;
    bool mica_available_ = false;
    bool fullscreen_ = false;
    bool borderless_ = false;
    std::atomic<bool> resize_cursor_ = false;
    HHOOK resize_cursor_hook_ = nullptr;
    HHOOK resize_cursor_message_hook_ = nullptr;
    HANDLE resize_cursor_timer_ = nullptr;
    WINDOWPLACEMENT windowed_placement_{sizeof(WINDOWPLACEMENT)};
    LONG_PTR windowed_style_ = 0;
    UINT32 caption_background_ = 0xffffff;
    const char *resolved_theme_ = "light";
    UINT32 caption_text_ = 0x37352f;
    UINT32 caption_hover_ = 0xf1f1ef;
    // The page's --sidebar, --border and --selected for the placeholder (--hover is caption_hover_).
    UINT32 sidebar_ = 0xf7f7f5, border_ = 0xe9e9e7, selected_ = 0xebebea;
    bool placeholder_ = true;
    int hot_ = HTNOWHERE, pressed_ = HTNOWHERE, tip_ = HTNOWHERE;
    std::wstring title_ = L"DR Reader";
    Microsoft::WRL::ComPtr<ID2D1Factory> factory_;
    Microsoft::WRL::ComPtr<ID2D1HwndRenderTarget> target_;
    Microsoft::WRL::ComPtr<IDWriteFactory> write_;
    Microsoft::WRL::ComPtr<IDWriteTextFormat> text_;
    Microsoft::WRL::ComPtr<IDWriteTextFormat> caption_icons_;
    std::mutex mutex_;
    std::vector<std::function<void()>> pending_;
};
} // namespace dr
