#pragma once
#include "dr/epub.h"
namespace dr
{
class Library
{
  public:
    explicit Library(fs::path root);
    Json list() const;
    Json import_book(const fs::path &archive);
    Json get(const std::string &id) const;
    Json save_position(const std::string &id, const Json &position);
    Json toggle_bookmark(const std::string &id, const Json &mark);
    Json search(const std::string &id, const std::string &query) const;
    Json settings() const;
    Json save_settings(const Json &settings);
    const fs::path &root() const
    {
        return root_;
    }

  private:
    fs::path root_;
    fs::path book_path(const std::string &id) const;
    void store(const std::string &id, const Json &book) const;
};
} // namespace dr
