#pragma once
#include "dr/paths.h"
#include <nlohmann/json.hpp>
namespace dr
{
using Json = nlohmann::json;
struct ImportLimits
{
    uint64_t max_entry_bytes = 64ull * 1024 * 1024;
    uint64_t max_total_bytes = 512ull * 1024 * 1024;
    size_t max_entries = 20000;
};
// Destination must be a new staging directory. Extraction is bounded and path checked.
Json import_epub(const fs::path &archive, const fs::path &destination, const ImportLimits &limits = {});
// Descriptive OPF metadata of an extracted EPUB: title, subtitle, authors, contributors, series,
// publisher, publication date, languages, subjects, identifiers and description.
Json read_opf_metadata(const fs::path &content);
} // namespace dr
