#include "dr/settings.h"
#include <sstream>
#include <toml++/toml.hpp>

namespace dr
{
namespace
{
toml::table to_table(const Json &value);
toml::array to_array(const Json &value);

template <class Insert> void insert_value(const Json &value, Insert insert)
{
    if (value.is_object()) insert(to_table(value));
    else if (value.is_array()) insert(to_array(value));
    else if (value.is_string()) insert(value.get<std::string>());
    else if (value.is_boolean()) insert(value.get<bool>());
    else if (value.is_number_integer()) insert(value.get<int64_t>());
    else if (value.is_number_float()) insert(value.get<double>());
    else throw std::runtime_error("配置包含不支持的值");
}

toml::table to_table(const Json &value)
{
    toml::table table;
    for (const auto &[key, item] : value.items())
        insert_value(item, [&](auto converted) { table.insert(key, std::move(converted)); });
    return table;
}

toml::array to_array(const Json &value)
{
    toml::array array;
    for (const auto &item : value)
        insert_value(item, [&](auto converted) { array.push_back(std::move(converted)); });
    return array;
}
} // namespace

Json parse_settings_toml(std::string_view text)
{
    const auto table = toml::parse(text);
    std::ostringstream json;
    json << toml::json_formatter(table);
    return patch_settings(default_settings(), Json::parse(json.str()));
}

std::string format_settings_toml(const Json &settings)
{
    const auto table = to_table(settings);
    std::ostringstream text;
    text << "# DR Reader configuration. Window ratios are fractions of the current screen.\n"
         << toml::toml_formatter(table) << '\n';
    return text.str();
}
} // namespace dr
