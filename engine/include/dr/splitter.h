#pragma once
#include <pugixml.hpp>
#include <string>
#include <unordered_map>
#include <vector>
namespace dr
{
std::string local_name(pugi::xml_node node);
pugi::xml_node child_named(pugi::xml_node node, const char *name);
std::string node_text(pugi::xml_node node);
std::string xml_string(pugi::xml_node node);
struct Flow
{
    std::string path, html, title, text;
};
struct SplitResult
{
    std::vector<Flow> flows;
    std::unordered_map<std::string, std::string> anchors;
    std::vector<std::string> warnings;
};
struct SplitOptions
{
    size_t max_bytes = 256 * 1024;
    bool page_breaks = true;
    std::string stylesheet;
};
// Independently implemented DOM partitioning. No calibre source is embedded.
SplitResult split_xhtml(const std::string &source_path, const std::string &markup,
                        const SplitOptions &options = {});
void sanitize_document(pugi::xml_node node);
} // namespace dr
