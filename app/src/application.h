#pragma once
#include "dr/library.h"
#include "dr/window.h"
#include "webview.h"
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
    void receive(const Json &request);
    void enqueue(std::function<void()> work);
    void worker(std::stop_token stop);
    std::vector<fs::path> pick_books();
    void apply_settings(const Json &settings);
    Window window_;
    WebView webview_;
    Library library_;
    fs::path assets_;
    std::vector<fs::path> initial_files_;
    std::string shell_override_;
    std::mutex mutex_;
    std::condition_variable_any wake_;
    std::queue<std::function<void()>> queue_;
    std::jthread thread_;
};
} // namespace dr
