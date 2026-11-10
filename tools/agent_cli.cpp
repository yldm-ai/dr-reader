// Runs one reading-assistance question through the app's AgentRunner, for checking a locally
// installed agent CLI end to end.
// Usage: dr-agent <codex|claude|opencode> [model] [--cancel-after <ms>] < prompt.txt
#include "../app/src/agent_runner.h"
#include "dr/paths.h"
#include <windows.h>
#include <future>
#include <iostream>
#include <iterator>
#include <string>
int wmain(int argc, wchar_t **argv)
{
    SetConsoleOutputCP(CP_UTF8);
    if (argc < 2)
    {
        std::cerr << "usage: dr-agent <codex|claude|opencode> [model] < prompt\n";
        return 2;
    }
    auto narrow = [](const wchar_t *text) {
        int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
        std::string result(size > 0 ? size - 1 : 0, '\0');
        WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), size, nullptr, nullptr);
        return result;
    };
    auto kind = dr::agent_kind(narrow(argv[1]));
    if (!kind)
    {
        std::cerr << "unknown agent\n";
        return 2;
    }
    auto agent = dr::AgentRunner::find(*kind);
    if (!agent)
    {
        std::cerr << dr::agent_label(*kind) << " not found\n";
        return 3;
    }
    std::cerr << "using " << dr::utf8(agent->path) << "\n";
    std::string prompt(std::istreambuf_iterator<char>(std::cin), {});
    std::promise<int> outcome;
    dr::AgentRunner runner([&](const dr::AgentUpdate &update) {
        switch (update.type)
        {
        case dr::AgentUpdate::Type::Text: std::cout << update.text << std::flush; break;
        case dr::AgentUpdate::Type::Status: std::cerr << "[status] " << update.text << "\n"; break;
        case dr::AgentUpdate::Type::Done: std::cout << "\n[done]\n"; outcome.set_value(0); break;
        case dr::AgentUpdate::Type::Error: std::cout << "\n[error] " << update.text << "\n"; outcome.set_value(1); break;
        }
    });
    std::string model;
    unsigned long cancel_after = 0;
    for (int i = 2; i < argc; ++i)
        if (std::wstring_view(argv[i]) == L"--cancel-after" && i + 1 < argc) cancel_after = std::stoul(argv[++i]);
        else model = narrow(argv[i]);
    runner.start("cli", *agent, model, prompt);
    if (cancel_after)
    {
        Sleep(cancel_after);
        runner.cancel("cli");
    }
    return outcome.get_future().get();
}
