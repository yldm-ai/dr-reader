#pragma once
#include "dr/epub.h"
namespace dr {
Json default_settings();
Json parse_settings_toml(std::string_view text);
std::string format_settings_toml(const Json& settings);
Json normalize_settings(const Json& source);
Json patch_settings(const Json& current,const Json& patch);
std::string dictionary_url(const Json& settings,const std::string& id,const std::string& text);
}
