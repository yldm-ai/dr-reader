#include "agent_runner.h"
#include "dr/paths.h"
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <cwctype>
#include <functional>
#include <stdexcept>
#include <thread>
#include <vector>
namespace dr
{
namespace
{
std::wstring wide(std::string_view text)
{
    if (text.empty()) return {};
    int size = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), size);
    return result;
}
std::wstring environment(const wchar_t *name)
{
    DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    value.resize(GetEnvironmentVariableW(name, value.data(), size));
    return value;
}
std::wstring registry_path(HKEY root, const wchar_t *key)
{
    DWORD type = 0, bytes = 0;
    if (RegGetValueW(root, key, L"Path", RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND, &type, nullptr, &bytes) != ERROR_SUCCESS)
        return {};
    std::wstring value(bytes / sizeof(wchar_t), L'\0');
    if (RegGetValueW(root, key, L"Path", RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND, &type, value.data(), &bytes) != ERROR_SUCCESS)
        return {};
    value.resize(wcsnlen(value.c_str(), value.size()));
    if (type != REG_EXPAND_SZ) return value;
    DWORD size = ExpandEnvironmentStringsW(value.c_str(), nullptr, 0);
    std::wstring expanded(size, L'\0');
    expanded.resize(ExpandEnvironmentStringsW(value.c_str(), expanded.data(), size));
    if (!expanded.empty() && expanded.back() == L'\0') expanded.pop_back();
    return expanded;
}
/**
 * The search path: the app's own PATH, the registry PATH (a CLI installed after the app or
 * Explorer started is not in the inherited one), then folders the CLIs' installers use. Relative
 * and duplicate entries are dropped so the current directory is never searched.
 */
std::vector<std::filesystem::path> search_path()
{
    std::vector<std::wstring> sources{
        environment(L"PATH"),
        registry_path(HKEY_CURRENT_USER, L"Environment"),
        registry_path(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")};
    const auto home = environment(L"USERPROFILE"), appdata = environment(L"APPDATA"), local = environment(L"LOCALAPPDATA");
    std::wstring extra;
    for (auto &dir : {home + L"\\.local\\bin", appdata + L"\\npm", local + L"\\Programs\\OpenAI\\Codex\\bin",
                      home + L"\\scoop\\shims", home + L"\\.opencode\\bin", local + L"\\pnpm", home + L"\\.bun\\bin"})
        extra += dir + L";";
    sources.push_back(extra);
    std::vector<std::filesystem::path> dirs;
    for (auto &source : sources)
    {
        size_t start = 0;
        while (start <= source.size())
        {
            auto end = source.find(L';', start);
            auto entry = source.substr(start, end == source.npos ? source.npos : end - start);
            start = end == source.npos ? source.size() + 1 : end + 1;
            entry.erase(std::remove(entry.begin(), entry.end(), L'"'), entry.end());
            std::filesystem::path dir(entry);
            if (entry.empty() || !dir.is_absolute()) continue;
            auto same = [&](const std::filesystem::path &known) { return _wcsicmp(known.c_str(), dir.c_str()) == 0; };
            if (std::none_of(dirs.begin(), dirs.end(), same)) dirs.push_back(dir);
        }
    }
    return dirs;
}
std::wstring joined(const std::vector<std::filesystem::path> &dirs)
{
    std::wstring value;
    for (auto &dir : dirs) value += dir.native() + L";";
    if (!value.empty()) value.pop_back();
    return value;
}
/** Quotes one argument by the MSVC runtime rules that the CLIs' launchers parse with. */
std::wstring quote(const std::wstring &arg)
{
    if (!arg.empty() && arg.find_first_of(L" \t\"") == arg.npos) return arg;
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (auto c : arg)
    {
        if (c == L'\\') { ++slashes; continue; }
        result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        slashes = 0;
        result += c;
    }
    result.append(slashes * 2, L'\\');
    return result + L"\"";
}
bool valid_utf8(std::string_view text)
{
    for (size_t i = 0; i < text.size();)
    {
        unsigned char c = text[i];
        size_t length = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
        if (!length || i + length > text.size()) return false;
        for (size_t k = 1; k < length; ++k)
            if ((static_cast<unsigned char>(text[i + k]) >> 6) != 2) return false;
        i += length;
    }
    return true;
}
/** The last meaningful lines of stderr, for a failure message; empty if not readable text. */
std::string stderr_summary(std::string text)
{
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.pop_back();
    if (text.size() > 600) text = text.substr(text.size() - 600);
    // Cutting may split a UTF-8 sequence at the front; skip continuation bytes.
    size_t first = 0;
    while (first < text.size() && (static_cast<unsigned char>(text[first]) >> 6) == 2) ++first;
    text = text.substr(first);
    return valid_utf8(text) ? text : std::string();
}
struct Handle
{
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h == INVALID_HANDLE_VALUE ? nullptr : h) {}
    Handle(const Handle &) = delete;
    Handle &operator=(const Handle &) = delete;
    ~Handle() { reset(); }
    void reset()
    {
        if (value) CloseHandle(value);
        value = nullptr;
    }
    HANDLE get() const { return value; }
    HANDLE *put() { reset(); return &value; }
};
std::filesystem::path codex_config()
{
    auto home = environment(L"CODEX_HOME");
    if (home.empty()) home = environment(L"USERPROFILE") + L"\\.codex";
    return std::filesystem::path(home) / L"config.toml";
}
std::vector<std::string> codex_servers(AgentKind kind)
{
    std::vector<std::string> servers;
    if (kind == AgentKind::Codex)
        if (std::error_code error; std::filesystem::is_regular_file(codex_config(), error))
            servers = codex_mcp_server_names(read_file(codex_config()));
    return servers;
}

/** One CLI process: what to run, what to feed it and how to react to its output. */
struct ProcessSpec
{
    AgentExecutable agent;
    std::vector<std::string> arguments;
    std::string input;
    /** Keep stdin open after `input` so `line` can answer; otherwise stdin closes once written. */
    bool interactive = false;
    HANDLE cancel = nullptr;
    unsigned long timeout_ms = 0;
    /** Called per stdout line; returns input to write back (interactive only). */
    std::function<std::string(std::string_view)> line;
    /** Polled after each line; true ends the process early (a server that has answered). */
    std::function<bool()> done;
};
struct ProcessResult
{
    DWORD code = 1;
    bool timed_out = false;
    std::string errors;
};
/**
 * Runs an agent CLI hidden, in an empty temporary working directory of its own (the CLIs must not
 * pick up a project, its instructions or files), inside a job object that ends its whole process
 * tree on cancel, timeout or early finish.
 */
ProcessResult run_process(const ProcessSpec &spec)
{
    const auto label = std::string(agent_label(spec.agent.kind));
    wchar_t temp[MAX_PATH + 1]{};
    GetTempPathW(MAX_PATH + 1, temp);
    static std::atomic<unsigned> counter = 0;
    auto workdir = std::filesystem::path(temp) / L"dr-reader-agent" /
                   (std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L"-" +
                    std::to_wstring(++counter));
    std::filesystem::create_directories(workdir);
    struct Cleanup
    {
        std::filesystem::path dir;
        ~Cleanup()
        {
            std::error_code ignored;
            std::filesystem::remove_all(dir, ignored);
        }
    } cleanup{workdir};

    std::wstring command = quote(spec.agent.path.native());
    for (auto &arg : spec.arguments) command += L" " + quote(wide(arg));
    std::wstring application = spec.agent.path.native();
    const auto extension = spec.agent.path.extension().native();
    if (_wcsicmp(extension.c_str(), L".cmd") == 0 || _wcsicmp(extension.c_str(), L".bat") == 0)
    {
        // Batch shims need cmd.exe. Every argument is free of cmd metacharacters (see
        // agent_arguments), and /s keeps the outer quotes from being re-parsed.
        application = environment(L"ComSpec");
        if (application.empty()) application = L"C:\\Windows\\System32\\cmd.exe";
        command = L"cmd.exe /d /s /c \"" + command + L"\"";
    }

    // Inherited environment plus the full search path and the CLI's overrides.
    auto overrides = agent_environment(spec.agent.kind);
    std::vector<std::pair<std::wstring, std::wstring>> extra{{L"PATH", joined(search_path())}};
    for (auto &[key, value] : overrides) extra.emplace_back(wide(key), wide(value));
    std::wstring block;
    if (auto strings = GetEnvironmentStringsW())
    {
        for (auto entry = strings; *entry; entry += wcslen(entry) + 1)
        {
            std::wstring_view item(entry);
            auto equals = item.find(L'=', 1);
            auto key = item.substr(0, equals);
            bool replaced = std::any_of(extra.begin(), extra.end(), [&](auto &pair) {
                return pair.first.size() == key.size() && _wcsnicmp(pair.first.c_str(), key.data(), key.size()) == 0;
            });
            if (!replaced) block.append(item).push_back(L'\0');
        }
        FreeEnvironmentStringsW(strings);
    }
    for (auto &[key, value] : extra) block.append(key + L"=" + value).push_back(L'\0');
    block.push_back(L'\0');

    SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
    Handle in_read, in_write, out_read, out_write, err_read, err_write;
    if (!CreatePipe(in_read.put(), in_write.put(), &inherit, 0) || !CreatePipe(out_read.put(), out_write.put(), &inherit, 0) ||
        !CreatePipe(err_read.put(), err_write.put(), &inherit, 0))
        throw std::runtime_error("无法创建与 " + label + " 通信的管道");
    for (auto parent : {in_write.get(), out_read.get(), err_read.get()}) SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0);

    // Only the three pipe ends reach the child, not every inheritable handle of the app.
    HANDLE inherited[] = {in_read.get(), out_write.get(), err_write.get()};
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<char> attributes(size);
    auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    if (!InitializeProcThreadAttributeList(list, 1, 0, &size) ||
        !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr))
        throw std::runtime_error("无法准备 " + label + " 的启动参数");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = in_read.get();
    startup.StartupInfo.hStdOutput = out_write.get();
    startup.StartupInfo.hStdError = err_write.get();
    startup.lpAttributeList = list;

    Handle job(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job.get() || !SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        throw std::runtime_error("无法为 " + label + " 创建进程组");

    PROCESS_INFORMATION info{};
    std::wstring mutable_command = command;
    const bool created = CreateProcessW(application.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                                        block.data(), workdir.c_str(), &startup.StartupInfo, &info);
    DeleteProcThreadAttributeList(list);
    if (!created) throw std::runtime_error("无法启动 " + label + "（错误 " + std::to_string(GetLastError()) + "）");
    Handle process(info.hProcess), thread(info.hThread);
    if (!AssignProcessToJobObject(job.get(), process.get()))
    {
        TerminateProcess(process.get(), 1);
        throw std::runtime_error("无法管理 " + label + " 进程");
    }
    ResumeThread(thread.get());
    in_read.reset();
    out_write.reset();
    err_write.reset();

    // Stop on cancel or timeout; once the CLI exits, also end helpers that kept its pipes open.
    ProcessResult result;
    Handle exited(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    std::thread watchdog([&] {
        HANDLE waits[] = {process.get(), spec.cancel, exited.get()};
        if (WaitForMultipleObjects(3, waits, FALSE, spec.timeout_ms) == WAIT_TIMEOUT) result.timed_out = true;
        TerminateJobObject(job.get(), 1);
    });
    auto write = [&](std::string_view text) {
        DWORD written = 0;
        for (size_t offset = 0; offset < text.size() && in_write.get(); offset += written)
            if (!WriteFile(in_write.get(), text.data() + offset, static_cast<DWORD>(std::min<size_t>(text.size() - offset, 1 << 16)), &written, nullptr))
                break;
    };
    std::thread writer;
    if (spec.interactive) write(spec.input); // a short request; replies follow from this thread
    else
        writer = std::thread([&] {
            write(spec.input);
            in_write.reset(); // end of input: the CLIs start once stdin closes
        });
    std::thread error_reader([&] {
        char buffer[4096];
        DWORD read = 0;
        while (ReadFile(err_read.get(), buffer, sizeof(buffer), &read, nullptr) && read)
        {
            result.errors.append(buffer, read);
            if (result.errors.size() > 16384) result.errors.erase(0, result.errors.size() - 8192);
        }
    });

    std::string pending;
    char buffer[65536];
    DWORD read = 0;
    bool done = false;
    auto deliver = [&](std::string_view line) {
        if (done) return;
        if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
        auto reply = spec.line(line);
        if (spec.interactive && !reply.empty()) write(reply);
        if (spec.done && spec.done())
        {
            done = true;
            SetEvent(exited.get()); // answered: the server is not needed any more
        }
    };
    while (ReadFile(out_read.get(), buffer, sizeof(buffer), &read, nullptr) && read)
    {
        pending.append(buffer, read);
        size_t start = 0;
        for (size_t end; (end = pending.find('\n', start)) != pending.npos; start = end + 1)
            deliver(std::string_view(pending).substr(start, end - start));
        pending.erase(0, start);
        if (pending.size() > (64u << 20)) pending.clear(); // a runaway line, not an event
    }
    if (!pending.empty()) deliver(pending);
    WaitForSingleObject(process.get(), INFINITE);
    SetEvent(exited.get()); // releases the watchdog if the CLI exited on its own
    watchdog.join();
    if (writer.joinable()) writer.join();
    in_write.reset();
    error_reader.join();
    GetExitCodeProcess(process.get(), &result.code);
    return result;
}
} // namespace

struct AgentRunner::Run
{
    std::string request;
    Handle cancel{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    std::atomic<bool> cancelled = false;
};

AgentRunner::AgentRunner(Sink sink) : sink_(std::move(sink)) {}
AgentRunner::~AgentRunner()
{
    std::unique_lock lock(mutex_);
    for (auto &[_, run] : runs_)
    {
        run->cancelled = true;
        SetEvent(run->cancel.get());
    }
    idle_.wait(lock, [this] { return runs_.empty(); });
}
std::optional<AgentExecutable> AgentRunner::find(AgentKind kind)
{
    const auto name = wide(agent_executable(kind));
    // A native binary first; npm installs only provide a .cmd shim.
    for (auto extension : {L".exe", L".cmd", L".bat"})
        for (auto &dir : search_path())
        {
            auto candidate = dir / (name + extension);
            std::error_code error;
            if (std::filesystem::is_regular_file(candidate, error)) return AgentExecutable{kind, candidate};
        }
    return std::nullopt;
}
void AgentRunner::start(const std::string &request, const AgentExecutable &agent, const std::string &model,
                        const std::string &effort, const std::string &prompt)
{
    validate_agent_model(model);
    validate_agent_effort(effort);
    auto run = std::make_shared<Run>();
    run->request = request;
    {
        std::lock_guard lock(mutex_);
        if (runs_.contains(request)) throw std::runtime_error("这个提问已经在进行");
        runs_[request] = run;
    }
    std::thread([this, run, agent, model, effort, prompt] { execute(run, agent, model, effort, prompt); }).detach();
}
void AgentRunner::cancel(const std::string &request)
{
    std::lock_guard lock(mutex_);
    if (auto found = runs_.find(request); found != runs_.end())
    {
        found->second->cancelled = true;
        SetEvent(found->second->cancel.get());
    }
}
void AgentRunner::execute(std::shared_ptr<Run> run, AgentExecutable agent, std::string model, std::string effort,
                          std::string prompt)
{
    const auto label = std::string(agent_label(agent.kind));
    auto finish = [&](AgentUpdate::Type type, std::string text) {
        sink_({run->request, type, std::move(text)});
        std::lock_guard lock(mutex_);
        runs_.erase(run->request);
        idle_.notify_all();
    };
    try
    {
        AgentStream stream(agent.kind);
        ProcessSpec spec{agent, agent_arguments(agent.kind, model, effort, codex_servers(agent.kind)), std::move(prompt)};
        spec.cancel = run->cancel.get();
        spec.timeout_ms = timeout_ms;
        spec.line = [&](std::string_view line) {
            for (auto &event : stream.line(line))
            {
                if (run->cancelled) break;
                if (event.type == AgentEvent::Type::Text) sink_({run->request, AgentUpdate::Type::Text, event.text});
                else if (event.type == AgentEvent::Type::Status) sink_({run->request, AgentUpdate::Type::Status, event.text});
            }
            return std::string();
        };
        auto result = run_process(spec);
        if (run->cancelled && !result.timed_out) return finish(AgentUpdate::Type::Error, "已停止回答");
        if (result.timed_out) return finish(AgentUpdate::Type::Error, label + " 超过 15 分钟没有完成回答，已停止");
        if (stream.failed())
        {
            // The stream already explained the failure; repeat it as the final word.
            return finish(AgentUpdate::Type::Error, stream.last_error().empty() ? label + " 返回了错误" : stream.last_error());
        }
        if (stream.succeeded() && result.code == 0) return finish(AgentUpdate::Type::Done, {});
        auto detail = !stream.last_error().empty() ? stream.last_error() : stderr_summary(result.errors);
        finish(AgentUpdate::Type::Error, detail.empty() ? label + " 异常退出（代码 " + std::to_string(result.code) + "）" : detail);
    }
    catch (const std::exception &error)
    {
        finish(AgentUpdate::Type::Error, error.what());
    }
}
void AgentRunner::list_models(const AgentExecutable &agent, ModelsSink done)
{
    auto run = std::make_shared<Run>();
    {
        std::lock_guard lock(mutex_);
        run->request = "models-" + std::to_string(++model_queries_);
        runs_[run->request] = run;
    }
    std::thread([this, run, agent, done = std::move(done)] {
        const auto label = std::string(agent_label(agent.kind));
        std::vector<AgentModel> models;
        std::string error;
        try
        {
            AgentModelProbe probe(agent.kind);
            ProcessSpec spec{agent, probe.arguments(codex_servers(agent.kind)), probe.start(), probe.interactive()};
            spec.cancel = run->cancel.get();
            spec.timeout_ms = model_timeout_ms;
            spec.line = [&](std::string_view line) { return probe.line(line); };
            spec.done = [&] { return probe.finished(); };
            auto result = run_process(spec);
            probe.end();
            models = probe.models();
            if (result.timed_out) error = label + " 没有及时返回模型列表";
            else if (probe.failed()) error = probe.error().empty() ? label + " 拒绝了模型查询" : probe.error();
            else if (models.empty())
            {
                auto detail = stderr_summary(result.errors);
                error = detail.empty() ? label + " 没有返回可用的模型，请确认已登录" : detail;
            }
        }
        catch (const std::exception &failure)
        {
            error = failure.what();
        }
        if (!run->cancelled) done(error.empty() ? std::move(models) : std::vector<AgentModel>{}, error);
        std::lock_guard lock(mutex_);
        runs_.erase(run->request);
        idle_.notify_all();
    }).detach();
}
} // namespace dr
