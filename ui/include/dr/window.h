#pragma once
#include <d2d1.h>
#include <dwrite.h>
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
    bool create(HINSTANCE instance, ShellStyle style, int icon_resource);
    HWND handle() const
    {
        return hwnd_;
    }
    RECT content_bounds() const;
    void set_style(ShellStyle style);
    void set_dark(bool dark);
    void set_title(const std::wstring &title);
    void post(std::function<void()> action);
    std::function<void()> on_resize;
    std::function<void()> on_close;
    bool mica_available() const
    {
        return mica_available_;
    }

  private:
    static LRESULT CALLBACK procedure(HWND, UINT, WPARAM, LPARAM);
    LRESULT message(UINT, WPARAM, LPARAM);
    void paint();
    int caption_hit(POINT point) const;
    void apply_frame();
    void update_icons();
    int scale(int dip) const;
    int caption_height() const;
    HWND hwnd_ = nullptr;
    int icon_resource_ = 0;
    HICON small_icon_ = nullptr, large_icon_ = nullptr;
    ShellStyle style_ = ShellStyle::Mica;
    bool dark_ = false, mica_available_ = false;
    int hot_ = HTNOWHERE, pressed_ = HTNOWHERE;
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
