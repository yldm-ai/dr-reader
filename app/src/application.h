#pragma once
#include "dr/library.h"
#include "dr/window.h"
#include "webview.h"
#include "agent_runner.h"
#include <condition_variable>
#include <queue>
#include <thread>
namespace dr
{
class Application
{
  public:
    Application(fs::path root, fs::path assets, std::vector<fs::path> files, std::string shell);
    ~Application();
    int run(HINSTANCE instance);

  private:
    void receive(const Json &request, std::vector<fs::path> dropped);
    void enqueue(std::function<void()> work);
    void worker(std::stop_token stop);
    std::vector<fs::path> pick_books();
    fs::path pick_notes_path(const std::string &title, bool &markdown);
    fs::path pick_notes_import_path();
    void apply_settings(const Json &settings);
    void send_caption();
    void release_cursor();
    bool receive_agent(const Json &id, const std::string &method, const Json &params);
    Window window_;
    WebView webview_;
    Library library_;
    fs::path assets_;
    std::vector<fs::path> initial_files_;
    std::string shell_override_;
    bool page_ready_ = false;
    HCURSOR cursor_hold_ = nullptr;
    UINT32 cursor_hold_id_ = 0;
    bool cursor_releasing_ = false;
    bool cursor_released_up_ = false;
    POINT cursor_release_point_{};
    Json last_caption_;
    std::mutex mutex_;
    std::condition_variable_any wake_;
    std::queue<std::function<void()>> queue_;
    std::jthread thread_;
    // Declared last, so it is destroyed first: its runs still post to the window while stopping.
    std::unique_ptr<AgentRunner> agents_;
};
} // namespace dr
