#pragma once
#include <pugixml.hpp>
#include <cstdint>
#include <string>
#include <string_view>
namespace dr
{
// Each Han / kana character is one unit, each run of other letters or digits is one word,
// and each punctuation mark or symbol is counted separately.
struct WordCount
{
    uint64_t cjk = 0, words = 0, punctuation = 0;
    WordCount &operator+=(const WordCount &other)
    {
        cjk += other.cjk;
        words += other.words;
        punctuation += other.punctuation;
        return *this;
    }
};
WordCount count_words(std::string_view utf8);
// Reading text of a document: inline markup stays contiguous so "<span>T</span>he" is one word,
// block boundaries become line breaks, and scripts, styles and ruby annotations are skipped.
std::string reading_text(pugi::xml_node node);
} // namespace dr
