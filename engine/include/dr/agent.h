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
//
// Streaming: Claude Code's `-p --include-partial-messages` already prints text deltas. `codex exec
// --json` and `opencode run --format json` only print finished messages, so those two CLIs are run
// as servers instead and driven over stdio: Codex through `app-server` (JSON-RPC; `thread/start`,
// `turn/start`, deltas in `item/agentMessage/delta`, checked against the schema `codex app-server
// generate-json-schema` prints) and opencode through `acp`, the Agent Client Protocol
// (`session/new`, `session/set_config_option`, `session/prompt`, deltas in `agent_message_chunk`;
// see packages/opencode/src/acp/event.ts and config-option.ts in opencode 1.19).
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
/** Throws unless the reasoning effort is a plain word such as "high"; empty means the default. */
void validate_agent_effort(std::string_view effort);
/**
 * Arguments after the executable. They contain no shell metacharacters, so they also survive
 * an npm `.cmd` shim launched through cmd.exe. The prompt itself is written to stdin.
 * `effort` is the reasoning effort: Claude `--effort`; Codex and opencode, which run as servers,
 * receive model and effort in their protocol requests (see AgentStream::start). They are still
 * validated here. `codex_mcp_servers` are the user's configured Codex MCP servers, which are
 * switched off by name.
 */
std::vector<std::string> agent_arguments(AgentKind kind, std::string_view model, std::string_view effort = {},
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
/**
 * Turns one CLI's JSONL stdout into answer text, progress and failure. For Codex and opencode it
 * also holds the server side of the conversation: write `start()` to stdin, feed each stdout line
 * to `line()`, write back `take_reply()`, and end the server once `finished()`.
 */
class AgentStream
{
  public:
    explicit AgentStream(AgentKind kind) : kind_(kind) {}
    /** Codex and opencode keep stdin open for requests; Claude Code reads the prompt and EOF. */
    bool interactive() const { return kind_ != AgentKind::Claude; }
    /**
     * The first stdin input: the prompt itself for Claude Code, the protocol's opening request for
     * the servers, which then ask the question with `model` and `effort` (empty: the CLI's
     * default). `cwd` is the process's working directory; ACP sessions need it as an absolute path.
     */
    std::string start(std::string prompt, std::string model = {}, std::string effort = {}, std::string cwd = {});
    /** Parses one stdout line; lines that are not JSON objects are ignored. */
    std::vector<AgentEvent> line(std::string_view text);
    /** Input to write back after the last `line()`, possibly empty. */
    std::string take_reply() { return std::exchange(reply_, {}); }
    /** The turn is over, either way; a server may then be ended. */
    bool finished() const { return succeeded_ || failed_; }
    /** True once the provider reported a successful end of its turn. */
    bool succeeded() const { return succeeded_ && !failed_; }
    bool failed() const { return failed_; }
    /** The failure message, or a provider error seen without a terminal event. */
    const std::string &last_error() const { return last_error_; }
    const std::string &answer() const { return answer_; }

  private:
    void append(std::vector<AgentEvent> &events, std::string text, bool new_block);
    void fail(std::vector<AgentEvent> &events, std::string message);
    void send(int id, const char *method, const std::string &params);
    /** opencode: the request after `after` (model → effort → prompt), skipping unset options. */
    void opencode_next(int after);
    AgentKind kind_;
    bool succeeded_ = false;
    bool failed_ = false;
    std::string answer_;
    std::string last_error_;
    std::string last_part_;
    std::string prompt_, model_, effort_, cwd_;
    std::string session_; // Codex thread id or ACP session id
    std::string reply_;
};

/** A model an agent CLI offers; `id` is what `--model` takes. */
struct AgentModel
{
    std::string id;
    std::string name;
    std::string description;
    bool is_default = false;
    /** Reasoning efforts the model accepts, in the CLI's order; empty when it has none. */
    std::vector<std::string> efforts;
    std::string default_effort;
};
/**
 * Asks an agent CLI which models it can use, without starting a model turn (approach as in
 * NeoRead's models.go, independently implemented): Codex through `app-server` and its
 * `model/list` JSON-RPC method, Claude Code through the stream-json `initialize` control request,
 * opencode through `opencode models --verbose` (an id line, then the model as a JSON object
 * whose `variants` are its reasoning efforts). Codex and Claude Code keep running as servers, so the
 * caller writes `start()`, feeds stdout lines to `line()`, writes back what it returns, and ends
 * the process once `finished()`; opencode just prints its list and exits.
 */
class AgentModelProbe
{
  public:
    explicit AgentModelProbe(AgentKind kind) : kind_(kind) {}
    std::vector<std::string> arguments(const std::vector<std::string> &codex_mcp_servers = {}) const;
    /** The first stdin input. */
    std::string start() const;
    /** Whether stdin stays open for a conversation (otherwise it is closed after `start()`). */
    bool interactive() const { return kind_ != AgentKind::OpenCode; }
    /** Parses one stdout line; returns input to write back, possibly empty. */
    std::string line(std::string_view text);
    /** The answer is complete (or failed) and the process may be ended. */
    bool finished() const { return finished_ || failed_; }
    bool failed() const { return failed_; }
    const std::string &error() const { return error_; }
    /** Usable models, deduplicated, with ids that pass `validate_agent_model`. */
    std::vector<AgentModel> models() const;
    /** Ends the output: opencode's last model object closes here. */
    void end();

  private:
    std::string request(int id, const char *method, const std::string &params) const;
    AgentKind kind_;
    bool finished_ = false;
    bool failed_ = false;
    int pages_ = 0;
    std::string error_;
    std::string pending_; // opencode: the JSON object being collected for the last id line
    std::vector<AgentModel> models_;
};
} // namespace dr
