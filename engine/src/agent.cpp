#include "dr/agent.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <stdexcept>
namespace dr
{
using Json = nlohmann::json;
namespace
{
bool identifier(std::string_view value)
{
    return !value.empty() && value.size() <= 64 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return std::isalnum(c) || c == '_' || c == '-';
    });
}
std::string string_at(const Json &object, const char *key)
{
    if (!object.is_object()) return {};
    auto found = object.find(key);
    return found != object.end() && found->is_string() ? found->get<std::string>() : std::string();
}
const Json &child(const Json &object, const char *key)
{
    static const Json empty = Json::object();
    if (!object.is_object()) return empty;
    auto found = object.find(key);
    return found != object.end() ? *found : empty;
}
} // namespace

std::optional<AgentKind> agent_kind(std::string_view name)
{
    if (name == "codex") return AgentKind::Codex;
    if (name == "claude") return AgentKind::Claude;
    if (name == "opencode") return AgentKind::OpenCode;
    return std::nullopt;
}
const char *agent_id(AgentKind kind)
{
    switch (kind)
    {
    case AgentKind::Codex: return "codex";
    case AgentKind::Claude: return "claude";
    default: return "opencode";
    }
}
const char *agent_executable(AgentKind kind) { return agent_id(kind); }
const char *agent_label(AgentKind kind)
{
    switch (kind)
    {
    case AgentKind::Codex: return "Codex";
    case AgentKind::Claude: return "Claude Code";
    default: return "opencode";
    }
}
void validate_agent_model(std::string_view model)
{
    // Provider/model ids such as "anthropic/claude-sonnet-5", "gpt-6.1" or "opus[1m]"; nothing a
    // shell or cmd.exe would interpret.
    if (model.size() > 128 || !std::all_of(model.begin(), model.end(), [](unsigned char c) {
            return std::isalnum(c) || std::string_view("._:/@+-[]").find(static_cast<char>(c)) != std::string_view::npos;
        }))
        throw std::runtime_error("模型名称只能包含字母、数字和 . _ : / @ + - [ ]");
}
void validate_agent_effort(std::string_view effort)
{
    if (!effort.empty() && (effort.size() > 32 || !identifier(effort)))
        throw std::runtime_error("思考强度只能包含字母、数字、_ 和 -");
}
std::vector<std::string> agent_arguments(AgentKind kind, std::string_view model, std::string_view effort,
                                         const std::vector<std::string> &codex_mcp_servers)
{
    validate_agent_model(model);
    validate_agent_effort(effort);
    std::vector<std::string> args;
    switch (kind)
    {
    case AgentKind::Claude:
        // No built-in tools, no MCP servers, no project settings or slash commands, and nothing
        // written to the user's session list. User settings stay on: they may hold the API key,
        // gateway or default model the CLI is configured with.
        args = {"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--tools", "", "--strict-mcp-config", "--setting-sources", "user",
                "--disable-slash-commands", "--no-session-persistence"};
        if (!model.empty()) args.insert(args.end(), {"--model", std::string(model)});
        if (!effort.empty()) args.insert(args.end(), {"--effort", std::string(effort)});
        break;
    case AgentKind::Codex:
    {
        // `codex exec` keeps the user's config (model, provider) but runs read-only, never asks
        // for approval and switches tool features off. Feature names change between releases;
        // unknown ones only produce a warning item, and the read-only sandbox stays the guard.
        // Values are bare words: Codex reads a value that is not valid TOML as a string.
        args = {"exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
                "-c", "approval_policy=never", "-c", "web_search=disabled", "-c", "project_doc_max_bytes=0",
                "-c", "notify=[]"};
        for (auto feature : {"shell_tool", "unified_exec", "hooks", "plugins", "apps", "multi_agent", "code_mode",
                             "code_mode_host", "view_image", "image_generation", "browser_use", "computer_use"})
            args.insert(args.end(), {"-c", std::string("features.") + feature + "=false"});
        for (auto &name : codex_mcp_servers)
            if (identifier(name)) args.insert(args.end(), {"-c", "mcp_servers." + name + ".enabled=false"});
        if (!model.empty()) args.insert(args.end(), {"--model", std::string(model)});
        if (!effort.empty()) args.insert(args.end(), {"-c", "model_reasoning_effort=" + std::string(effort)});
        args.push_back("-"); // read the prompt from stdin
        break;
    }
    case AgentKind::OpenCode:
        args = {"run", "--format", "json"};
        if (!model.empty()) args.insert(args.end(), {"--model", std::string(model)});
        if (!effort.empty()) args.insert(args.end(), {"--variant", std::string(effort)});
        break;
    }
    return args;
}
std::vector<std::pair<std::string, std::string>> agent_environment(AgentKind kind)
{
    switch (kind)
    {
    case AgentKind::Claude:
        // The user's CLAUDE.md and auto memory describe their coding work, not this book.
        return {{"CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"}, {"CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"}, {"NO_COLOR", "1"}};
    case AgentKind::OpenCode:
        // Inline config overrides the user's: every tool off, every permission denied, no MCP.
        return {{"OPENCODE_CONFIG_CONTENT",
                 R"({"tools":{"*":false},"permission":{"*":"deny"},"mcp":{},"share":"disabled","autoupdate":false})"},
                {"NO_COLOR", "1"}};
    default: return {{"NO_COLOR", "1"}};
    }
}
std::vector<std::string> codex_mcp_server_names(std::string_view config)
{
    std::vector<std::string> names;
    size_t start = 0;
    while (start <= config.size())
    {
        auto end = config.find('\n', start);
        auto line = config.substr(start, end == config.npos ? config.npos : end - start);
        start = end == config.npos ? config.size() + 1 : end + 1;
        auto first = line.find_first_not_of(" \t");
        if (first == line.npos || !line.substr(first).starts_with("[mcp_servers.")) continue;
        auto name = line.substr(first + 13);
        std::string value;
        if (!name.empty() && (name[0] == '"' || name[0] == '\''))
        {
            auto close = name.find(name[0], 1);
            if (close == name.npos) continue;
            value = std::string(name.substr(1, close - 1));
        }
        else value = std::string(name.substr(0, name.find_first_of(".] \t")));
        if (identifier(value) && std::find(names.begin(), names.end(), value) == names.end()) names.push_back(value);
    }
    return names;
}

void AgentStream::append(std::vector<AgentEvent> &events, std::string text, bool new_block)
{
    if (text.empty()) return;
    // Separate messages (Codex items, opencode parts) by a blank line, as Markdown paragraphs.
    if (new_block && !answer_.empty()) text = "\n\n" + text;
    answer_ += text;
    events.push_back({AgentEvent::Type::Text, std::move(text)});
}
void AgentStream::fail(std::vector<AgentEvent> &events, std::string message)
{
    if (failed_) return;
    failed_ = true;
    if (message.empty()) message = std::string(agent_label(kind_)) + " 返回了错误";
    last_error_ = message;
    events.push_back({AgentEvent::Type::Error, std::move(message)});
}
std::vector<AgentEvent> AgentStream::line(std::string_view text)
{
    std::vector<AgentEvent> events;
    auto event = Json::parse(text, nullptr, false);
    if (event.is_discarded() || !event.is_object() || failed_) return events;
    const auto type = string_at(event, "type");
    switch (kind_)
    {
    case AgentKind::Claude:
    {
        // Subagent output never reaches the answer.
        if (event.contains("parent_tool_use_id") && !event["parent_tool_use_id"].is_null()) break;
        if (type == "stream_event")
        {
            const auto &inner = child(event, "event");
            const auto inner_type = string_at(inner, "type");
            if (inner_type == "content_block_delta" && string_at(child(inner, "delta"), "type") == "text_delta")
                append(events, string_at(child(inner, "delta"), "text"), false);
            else if (inner_type == "content_block_start" && string_at(child(inner, "content_block"), "type") == "text")
                append(events, string_at(child(inner, "content_block"), "text"), false);
        }
        else if (type == "system" && string_at(event, "subtype") == "api_retry")
        {
            auto attempt = event.value("attempt", 0);
            events.push_back({AgentEvent::Type::Status, "模型服务暂时不可用，正在重试（第 " + std::to_string(attempt) + " 次）"});
        }
        else if (type == "result")
        {
            // The final `result` repeats the streamed text; it only decides success.
            if (event.value("is_error", false) || string_at(event, "subtype") != "success")
                fail(events, string_at(event, "result"));
            else
            {
                if (answer_.empty()) append(events, string_at(event, "result"), false);
                succeeded_ = true;
            }
        }
        else if (type == "error") last_error_ = string_at(child(event, "error"), "message");
        break;
    }
    case AgentKind::Codex:
    {
        const auto &item = child(event, "item");
        // Item-level "error" entries are configuration warnings; the turn decides success.
        if (type == "item.completed" && string_at(item, "type") == "agent_message")
            append(events, string_at(item, "text"), true);
        else if (type == "turn.completed") succeeded_ = true;
        else if (type == "turn.failed") fail(events, string_at(child(event, "error"), "message"));
        else if (type == "error")
        {
            last_error_ = string_at(event, "message");
            if (!last_error_.empty()) events.push_back({AgentEvent::Type::Status, last_error_});
        }
        break;
    }
    case AgentKind::OpenCode:
    {
        const auto &part = child(event, "part");
        if (type == "text")
        {
            // Each text part arrives complete; a new part id starts a new paragraph.
            auto id = string_at(part, "id");
            append(events, string_at(part, "text"), id != last_part_);
            last_part_ = id;
        }
        else if (type == "step_finish" && string_at(part, "reason") == "stop") succeeded_ = true;
        else if (type == "error")
        {
            const auto &error = child(event, "error");
            auto message = string_at(child(error, "data"), "message");
            fail(events, message.empty() ? string_at(error, "name") : message);
        }
        break;
    }
    }
    return events;
}

std::vector<std::string> AgentModelProbe::arguments(const std::vector<std::string> &codex_mcp_servers) const
{
    std::vector<std::string> args;
    switch (kind_)
    {
    case AgentKind::Codex:
        // Only the protocol starts; no thread or turn is created. Hooks, plugins and the user's
        // MCP servers stay off as in agent_arguments.
        args = {"app-server", "--listen", "stdio://", "-c", "features.hooks=false", "-c", "features.plugins=false"};
        for (auto &name : codex_mcp_servers)
            if (identifier(name)) args.insert(args.end(), {"-c", "mcp_servers." + name + ".enabled=false"});
        break;
    case AgentKind::Claude:
        args = {"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                "--tools", "", "--strict-mcp-config", "--setting-sources", "user",
                "--disable-slash-commands", "--no-session-persistence"};
        break;
    case AgentKind::OpenCode: args = {"models", "--verbose"}; break;
    }
    return args;
}
std::string AgentModelProbe::request(int id, const char *method, const std::string &params) const
{
    return Json{{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", Json::parse(params)}}.dump() + "\n";
}
std::string AgentModelProbe::start() const
{
    switch (kind_)
    {
    case AgentKind::Codex:
        return request(1, "initialize", R"({"clientInfo":{"name":"dr-reader","version":"0.1.0"},"capabilities":{}})");
    case AgentKind::Claude:
        return R"({"type":"control_request","request_id":"models","request":{"subtype":"initialize"}})"
               "\n";
    default: return {};
    }
}
std::string AgentModelProbe::line(std::string_view text)
{
    if (finished()) return {};
    if (kind_ == AgentKind::OpenCode)
    {
        // "provider/model" on its own line, then (with --verbose) the model as a JSON object that
        // opens with "{" and closes with "}" at the start of a line.
        while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.remove_suffix(1);
        if (!pending_.empty())
        {
            pending_.append(text).push_back('\n');
            if (text == "}") end();
            return {};
        }
        if (text == "{" && !models_.empty())
        {
            pending_ = "{\n";
            return {};
        }
        while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) text.remove_prefix(1);
        if (text.find('/') != text.npos && text.find_first_of(" {}\"") == text.npos)
            models_.push_back({std::string(text), std::string(text), {}, false});
        return {};
    }
    auto message = Json::parse(text, nullptr, false);
    if (message.is_discarded() || !message.is_object()) return {};
    if (kind_ == AgentKind::Claude)
    {
        if (string_at(message, "type") != "control_response") return {};
        const auto &response = child(message, "response");
        if (string_at(response, "request_id") != "models") return {};
        if (string_at(response, "subtype") != "success")
        {
            failed_ = true;
            error_ = string_at(response, "error");
            return {};
        }
        // "default" is the CLI's own choice; the aliases (opus, sonnet…) follow new releases.
        const auto &entries = child(child(response, "response"), "models");
        std::string default_model;
        for (auto &entry : entries.is_array() ? entries : Json::array())
            if (string_at(entry, "value") == "default") default_model = string_at(entry, "resolvedModel");
        auto efforts = [](const Json &entry) {
            std::vector<std::string> list;
            const auto &levels = child(entry, "supportedEffortLevels");
            if (entry.value("supportsEffort", false) && levels.is_array())
                for (auto &level : levels)
                    if (level.is_string()) list.push_back(level.get<std::string>());
            return list;
        };
        bool marked = false;
        for (auto &entry : entries.is_array() ? entries : Json::array())
        {
            auto id = string_at(entry, "value");
            if (id.empty() || id == "default") continue;
            bool is_default = !marked && !default_model.empty() && string_at(entry, "resolvedModel") == default_model;
            marked = marked || is_default;
            models_.push_back({id, string_at(entry, "displayName"), string_at(entry, "description"), is_default, efforts(entry)});
        }
        finished_ = true;
        return {};
    }
    // Codex app-server, JSON-RPC 2.0. Requests from the server get a refusal: this client offers
    // no operations.
    const auto method = string_at(message, "method");
    const bool has_id = message.contains("id") && !message["id"].is_null();
    if (!method.empty())
        return has_id ? Json{{"jsonrpc", "2.0"}, {"id", message["id"]},
                             {"error", {{"code", -32601}, {"message", "dr-reader only lists models"}}}}.dump() + "\n"
                      : std::string();
    if (!has_id || !message["id"].is_number_integer()) return {};
    const auto id = message["id"].get<int>();
    if (message.contains("error") && !message["error"].is_null())
    {
        failed_ = true;
        error_ = string_at(child(message, "error"), "message");
        return {};
    }
    if (id == 1)
        return Json{{"method", "initialized"}, {"params", Json::object()}}.dump() + "\n" +
               request(2, "model/list", R"({"limit":100})");
    if (id != pages_ + 2) return {};
    const auto &result = child(message, "result");
    const auto &data = child(result, "data");
    for (auto &entry : data.is_array() ? data : Json::array())
        if (!entry.value("hidden", false))
        {
            AgentModel model{string_at(entry, "model"), string_at(entry, "displayName"), string_at(entry, "description"),
                             entry.value("isDefault", false)};
            const auto &efforts = child(entry, "supportedReasoningEfforts");
            for (auto &effort : efforts.is_array() ? efforts : Json::array())
                if (auto value = string_at(effort, "reasoningEffort"); !value.empty()) model.efforts.push_back(value);
            model.default_effort = string_at(entry, "defaultReasoningEffort");
            models_.push_back(std::move(model));
        }
    auto cursor = string_at(result, "nextCursor");
    if (cursor.empty() || ++pages_ >= 20)
    {
        finished_ = true;
        return {};
    }
    return request(pages_ + 2, "model/list", Json{{"limit", 100}, {"cursor", cursor}}.dump());
}
void AgentModelProbe::end()
{
    if (pending_.empty() || models_.empty()) return;
    // Ordered, so variants keep the CLI's low → max order.
    auto object = nlohmann::ordered_json::parse(pending_, nullptr, false);
    pending_.clear();
    if (object.is_discarded() || !object.is_object()) return;
    auto &model = models_.back();
    if (auto name = object.find("name"); name != object.end() && name->is_string()) model.name = name->get<std::string>();
    if (auto variants = object.find("variants"); variants != object.end() && variants->is_object())
        for (auto &[key, _] : variants->items()) model.efforts.push_back(key);
}
std::vector<AgentModel> AgentModelProbe::models() const
{
    std::vector<AgentModel> result;
    for (auto model : models_)
    {
        if (model.id.empty() || model.id.size() > 128) continue;
        try { validate_agent_model(model.id); }
        catch (const std::exception &) { continue; }
        if (std::any_of(result.begin(), result.end(), [&](auto &known) { return known.id == model.id; })) continue;
        if (model.name.empty()) model.name = model.id;
        std::erase_if(model.efforts, [](const std::string &effort) { return effort.empty() || effort.size() > 32 || !identifier(effort); });
        if (std::find(model.efforts.begin(), model.efforts.end(), model.default_effort) == model.efforts.end()) model.default_effort.clear();
        result.push_back(std::move(model));
    }
    return result;
}
} // namespace dr
