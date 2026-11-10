#pragma once
#include "dr/agent.h"
#include <condition_variable>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
namespace dr
{
/** Where an agent CLI was found; `.cmd` shims (npm installs) run through cmd.exe. */
struct AgentExecutable
{
    AgentKind kind;
    std::filesystem::path path;
};
/** An agent run's progress, delivered on a background thread. */
struct AgentUpdate
{
    std::string request;
    enum class Type
    {
        Text,
        Status,
        Done,
        Error
    } type;
    std::string text;
};

/**
 * Runs agent CLIs as hidden child processes. Each run gets an empty temporary working directory
 * and a job object, so cancelling, timing out or closing the app also ends the CLI's own
 * children (node, MCP helpers).
 */
class AgentRunner
{
  public:
    using Sink = std::function<void(const AgentUpdate &)>;
    explicit AgentRunner(Sink sink);
    ~AgentRunner();
    AgentRunner(const AgentRunner &) = delete;
    AgentRunner &operator=(const AgentRunner &) = delete;

    /** Looks the CLI up on the current and the registry PATH plus common install folders. */
    static std::optional<AgentExecutable> find(AgentKind kind);
    /** Starts a run; updates for `request` follow through the sink and end with Done or Error. */
    void start(const std::string &request, const AgentExecutable &agent, const std::string &model,
               const std::string &prompt);
    void cancel(const std::string &request);
    /** Longest a single answer may take before the CLI is stopped. */
    static constexpr unsigned long timeout_ms = 15 * 60 * 1000;

  private:
    struct Run;
    void execute(std::shared_ptr<Run> run, AgentExecutable agent, std::string model, std::string prompt);
    Sink sink_;
    std::mutex mutex_;
    std::condition_variable idle_;
    std::map<std::string, std::shared_ptr<Run>> runs_;
};
} // namespace dr
