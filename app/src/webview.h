#pragma once
#include "dr/epub.h"
#include "dr/paths.h"
#include <functional>
#include <objbase.h>
#include <windows.h>
#include <wrl.h>

// The generated WebView2 header requires COM definitions before its forward declarations.
#include <WebView2.h>

namespace dr
{
class WebView
{
  public:
    void create(HWND window, const fs::path &web_root, const fs::path &data_root,
                std::function<void()> ready);
    void resize(RECT bounds);
    void send(const Json &message);
    std::function<void(const Json &)> on_message;
    std::function<void(const std::wstring &)> on_error;
    std::function<void()> on_toggle_borderless;

  private:
    Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
    Microsoft::WRL::ComPtr<ICoreWebView2> view_;
    RECT bounds_{};
    void fail(HRESULT error, const wchar_t *step);
};
std::wstring widen(std::string_view text);
std::string narrow(std::wstring_view text);
} // namespace dr
