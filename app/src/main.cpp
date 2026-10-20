#include "application.h"
#include <shellapi.h>
#include <shlobj.h>
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int)
{
    auto initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized))
        return 1;
    int result = 1;
    try
    {
        PWSTR local = nullptr;
        if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local)))
            throw std::runtime_error("无法找到本地应用数据目录");
        dr::fs::path root = dr::fs::path(local) / "DRReader";
        CoTaskMemFree(local);
        std::wstring executable(32768, L'\0');
        auto size = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
        executable.resize(size);
        int argc = 0;
        LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        std::vector<dr::fs::path> files;
        std::string shell;
        for (int i = 1; i < argc; ++i)
        {
            std::wstring arg = argv[i];
            if (arg == L"--data-dir" && i + 1 < argc)
                root = argv[++i];
            else if (arg == L"--shell" && i + 1 < argc)
            {
                shell = dr::narrow(argv[++i]);
                if (shell != "mica" && shell != "direct2d")
                    throw std::runtime_error("--shell 仅支持 mica 或 direct2d");
            }
            else if (arg.starts_with(L"--"))
                throw std::runtime_error("未知命令行参数");
            else
                files.emplace_back(arg);
        }
        LocalFree(argv);
        auto assets = dr::fs::path(executable).parent_path() / "web";
        if (!dr::fs::exists(assets / "index.html"))
            throw std::runtime_error("未找到 web/index.html，请保持 web 目录与程序位于一起");
        {
            dr::Application app(dr::fs::absolute(root), assets, std::move(files), shell);
            result = app.run(instance);
        }
    }
    catch (const std::exception &e)
    {
        MessageBoxW(nullptr, dr::widen(e.what()).c_str(), L"DR Reader", MB_OK | MB_ICONERROR);
    }
    CoUninitialize();
    return result;
}
