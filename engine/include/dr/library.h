#pragma once
#include "dr/epub.h"
#include "dr/annotations.h"
#include <memory>
namespace dr
{
class Library
{
  public:
    explicit Library(fs::path root);
    Json list() const;
    Json shelves() const;
    Json save_shelves(const Json &shelves);
    Json import_book(const fs::path &archive);
    void remove_book(const std::string &id);
    Json get(const std::string &id) const;
    Json save_position(const std::string &id, const Json &position);
    Json toggle_bookmark(const std::string &id, const Json &mark);
    Json search(const std::string &id, const std::string &query) const;
    // Visible characters per chapter (UTF-16 units, whitespace excluded) from the search text,
    // for estimating whole-book page counts without loading every chapter.
    Json chapter_lengths(const std::string &id) const;
    Json settings() const;
    Json save_settings(const Json &settings);
    Json annotations(const std::string& id) const;
    Json save_annotation(const std::string& id,const Json& annotation);
    void remove_annotation(const std::string& id,const std::string& annotation_id);
    std::string lookup_url(const std::string& dictionary,const std::string& text) const;
    const fs::path &root() const
    {
        return root_;
    }

  private:
    fs::path root_;
    std::unique_ptr<AnnotationStore> annotations_;
    fs::path book_path(const std::string &id) const;
    void store(const std::string &id, const Json &book) const;
};
} // namespace dr
