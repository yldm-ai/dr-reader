#pragma once
// Reading assistance through locally installed agent CLIs (Codex CLI, Claude Code, opencode).
//
// Approach informed by NeoRead (apps/server/internal/neoread/cli.go, claude.go, codex.go): every
// question is a fresh, tool-free, non-persistent CLI run in an empty working directory, the prompt
// (with the conversation replayed in it) goes through stdin, and only the provider's terminal
// success event plus a clean exit count as an answer. This is an independent implementation: the
// flags and event shapes below were verified against codex-cli 0.167, Claude Code 2.1 and
// opencode 1.19, and opencode (which NeoRead does not support) is configured through
// OPENCODE_CONFIG_CONTENT.
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
namespace dr
{
enum class AgentKind
{
    Codex,
    Claude,
    OpenCode
};
std::optional<AgentKind> agent_kind(std::string_view name);
/** The settings / protocol identifier: "codex", "claude" or "opencode". */
const char *agent_id(AgentKind kind);
/** The executable base name looked up on PATH. */
const char *agent_executable(AgentKind kind);
/** Display name for messages. */
const char *agent_label(AgentKind kind);
/** Throws for model names that are not plain identifiers; empty means the CLI's default. */
void validate_agent_model(std::string_view model);
/**
 * Arguments after the executable. They contain no shell metacharacters, so they also survive
 * an npm `.cmd` shim launched through cmd.exe. The prompt itself is written to stdin.
 * `codex_mcp_servers` are the user's configured Codex MCP servers, which are switched off by name.
 */
std::vector<std::string> agent_arguments(AgentKind kind, std::string_view model,
                                         const std::vector<std::string> &codex_mcp_servers = {});
/** Extra environment variables for the child process. */
std::vector<std::pair<std::string, std::string>> agent_environment(AgentKind kind);
/** Names of `[mcp_servers.<name>]` tables in a Codex config.toml, limited to safe identifiers. */
std::vector<std::string> codex_mcp_server_names(std::string_view config_toml);

struct AgentEvent
{
    enum class Type
    {
        Text,   // answer text to append
        Status, // transient progress, e.g. a retry
        Error   // the run failed; text explains why
    };
    Type type;
    std::string text;
};
/** Turns one CLI's JSONL stdout into answer text, progress and failure. */
class AgentStream
{
  public:
    explicit AgentStream(AgentKind kind) : kind_(kind) {}
    /** Parses one stdout line; lines that are not JSON objects are ignored. */
    std::vector<AgentEvent> line(std::string_view text);
    /** True once the provider reported a successful end of its turn. */
    bool succeeded() const { return succeeded_ && !failed_; }
    bool failed() const { return failed_; }
    /** The failure message, or a provider error seen without a terminal event. */
    const std::string &last_error() const { return last_error_; }
    const std::string &answer() const { return answer_; }

  private:
    void append(std::vector<AgentEvent> &events, std::string text, bool new_block);
    void fail(std::vector<AgentEvent> &events, std::string message);
    AgentKind kind_;
    bool succeeded_ = false;
    bool failed_ = false;
    std::string answer_;
    std::string last_error_;
    std::string last_part_;
};
} // namespace dr
