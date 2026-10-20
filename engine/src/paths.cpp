#include "dr/paths.h"
#include <cctype>
#include <fstream>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#endif
namespace dr
{
std::string utf8(const fs::path &p)
{
    auto s = p.generic_u8string();
    return {reinterpret_cast<const char *>(s.data()), s.size()};
}
fs::path path8(std::string_view s)
{
    return fs::path(std::u8string_view(reinterpret_cast<const char8_t *>(s.data()), s.size()));
}
std::string read_file(const fs::path &p)
{
    std::ifstream f(p, std::ios::binary);
    if (!f)
        throw std::runtime_error("无法读取文件: " + utf8(p));
    return {std::istreambuf_iterator<char>(f), {}};
}
void write_file(const fs::path &p, std::string_view data)
{
    fs::create_directories(p.parent_path());
    std::ofstream f(p, std::ios::binary | std::ios::trunc);
    if (!f || !f.write(data.data(), static_cast<std::streamsize>(data.size())))
        throw std::runtime_error("无法写入文件: " + utf8(p));
}
void write_atomic(const fs::path &p, std::string_view data)
{
    auto temp = p;
    temp += ".tmp";
    write_file(temp, data);
#ifdef _WIN32
    if (!MoveFileExW(temp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("保存失败");
#else
    fs::rename(temp, p);
#endif
}
static int hex(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}
std::string url_decode(std::string_view s)
{
    std::string r;
    for (size_t i = 0; i < s.size(); ++i)
    {
        if (s[i] == '%' && i + 2 < s.size() && hex(s[i + 1]) >= 0 && hex(s[i + 2]) >= 0)
        {
            r += char(hex(s[i + 1]) * 16 + hex(s[i + 2]));
            i += 2;
        }
        else
            r += s[i];
    }
    return r;
}
std::string url_encode(std::string_view s)
{
    constexpr char digits[] = "0123456789ABCDEF";
    std::string r;
    for (unsigned char c : s)
    {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || c == '/')
            r += char(c);
        else
        {
            r += '%';
            r += digits[c >> 4];
            r += digits[c & 15];
        }
    }
    return r;
}
bool external_url(std::string_view s)
{
    return s.starts_with("//") || s.find(':') != std::string_view::npos;
}
std::string resolve_href(std::string_view base, std::string_view href)
{
    if (external_url(href))
        throw std::runtime_error("不支持外部资源路径");
    auto h = url_decode(href.substr(0, href.find_first_of("#?")));
    if (h.empty())
        return std::string(base);
    if (h.find('\0') != std::string::npos || h.find('\\') != std::string::npos || h.starts_with('/') ||
        h.find(':') != std::string::npos)
        throw std::runtime_error("非法 EPUB 路径");
    auto result = (path8(base).parent_path() / path8(h)).lexically_normal();
    auto s = utf8(result);
    if (s == ".." || s.starts_with("../"))
        throw std::runtime_error("EPUB 路径越界");
    return s;
}
} // namespace dr
