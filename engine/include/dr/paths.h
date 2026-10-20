#pragma once
#include <filesystem>
#include <string>
#include <string_view>
namespace dr
{
namespace fs = std::filesystem;
std::string utf8(const fs::path &path);
fs::path path8(std::string_view value);
std::string read_file(const fs::path &path);
void write_file(const fs::path &path, std::string_view data);
void write_atomic(const fs::path &path, std::string_view data);
std::string url_decode(std::string_view value);
std::string url_encode(std::string_view value);
// Resolve archive URLs using URI separators, rejecting traversal outside the EPUB.
std::string resolve_href(std::string_view base, std::string_view href);
bool external_url(std::string_view value);
} // namespace dr
