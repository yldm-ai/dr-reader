#pragma once
#include "dr/epub.h"
struct sqlite3;
namespace dr {
// One serialized SQLite connection; used by the application's serial worker queue.
class AnnotationStore {
public:
 explicit AnnotationStore(const fs::path& path);
 ~AnnotationStore();
 AnnotationStore(const AnnotationStore&)=delete;
 AnnotationStore& operator=(const AnnotationStore&)=delete;
 Json list(const std::string& book) const;
 Json save(const std::string& book,const Json& annotation);
 void remove(const std::string& book,const std::string& id);
 void remove_book(const std::string& book);
 void migrate_bookmarks(const std::string& book,const Json& legacy) const;
 Json bookmarks(const std::string& book) const;
 Json toggle_bookmark(const std::string& book,const Json& mark);
private:
 sqlite3* db_=nullptr;
};
}
