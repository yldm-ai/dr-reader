#pragma once
#include "dr/epub.h"
namespace dr {
Json default_settings();
Json normalize_settings(const Json& source);
Json patch_settings(const Json& current,const Json& patch);
std::string dictionary_url(const Json& settings,const std::string& id,const std::string& text);
}
