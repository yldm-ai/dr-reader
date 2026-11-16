#pragma once
#include "dr/epub.h"
#include "dr/paths.h"
#include <functional>
#include <objbase.h>
#include <windows.h>
#include <wrl.h>
#include <dcomp.h>

// The generated WebView2 header requires COM definitions before its forward declarations.
#include <WebView2.h>

namespace dr
{
/**
 * A visually hosted WebView2: the page renders into a DirectComposition visual of the shell
 * window rather than into a browser-owned child window. The shell relays mouse input and
 * applies the cursor the page asks for, so the cursor has a single owner.
 */
class WebView
{
  public:
    void create(HWND window, const fs::path &web_root, const fs::path &data_root,
                std::function<void()> ready);
    void resize(RECT bounds);
    /** The window's resolved theme, given to the page so its first paint already matches. */
    void set_theme(const std::string &theme);
    /** The caption height in CSS pixels the page lays out under before its first paint. */
    void set_caption_height(double height);
    /** Once the page is opaque, an opaque default background keeps ClearType text. */
    void set_background(UINT32 rgb);
    void send(const Json &message);
    /** Relays one mouse message; the point is relative to the WebView's top-left. */
    void mouse(UINT message, WPARAM wparam, POINT point);
    /** Applies the page's cursor; false before the page exists. */
    bool cursor();
    /** The system cursor (IDC_*) the page asks for, or 0 for none or a custom one. */
    UINT32 system_cursor();
    void focus();
    void notify_move();
    /** A page message and the paths of the DOM File objects posted with it (dropped files). */
    std::function<void(const Json &, std::vector<fs::path>)> on_message;
    std::function<void(const std::wstring &)> on_error;
    std::function<void()> on_toggle_borderless;
    std::function<void()> on_cursor_changed;

  private:
    Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
    Microsoft::WRL::ComPtr<ICoreWebView2CompositionController> composition_;
    Microsoft::WRL::ComPtr<ICoreWebView2> view_;
    Microsoft::WRL::ComPtr<IDCompositionDevice> device_;
    Microsoft::WRL::ComPtr<IDCompositionTarget> target_;
    Microsoft::WRL::ComPtr<IDCompositionVisual> root_;
    Microsoft::WRL::ComPtr<IDropTarget> drop_target_;
    RECT bounds_{};
    std::string theme_ = "light";
    double caption_height_ = 0;
    void fail(HRESULT error, const wchar_t *step);
    void place();
    void register_drop_target(HWND window);
    void configure(const fs::path &web_root, const fs::path &data_root, std::function<void()> ready);
};
std::wstring widen(std::string_view text);
std::string narrow(std::wstring_view text);
} // namespace dr
