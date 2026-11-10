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
 // Add missing IDs atomically, preserving existing local annotations and imported timestamps.
 Json import_annotations(const std::string& book,const Json& annotations);
 // A notes backup: annotations and conversations are added in one transaction.
 Json import_backup(const std::string& book,const Json& annotations,const Json& sessions);
 void remove(const std::string& book,const std::string& id);
 void remove_book(const std::string& book);
 void migrate_bookmarks(const std::string& book,const Json& legacy) const;
 Json bookmarks(const std::string& book) const;
 Json toggle_bookmark(const std::string& book,const Json& mark);
 // AI 问书 conversations. A session is {id,bookId,title,createdAt,updatedAt,messages:[{role,text,
 // quote,agent,label,model,effort,stopped,createdAt}]}; the page saves the whole session after each
 // answer, and messages are replaced together in one transaction.
 /** Summaries without messages (plus messageCount), most recently updated first. */
 Json agent_sessions(const std::string& book) const;
 Json agent_session(const std::string& book,const std::string& id) const;
 /** Every session with its messages, oldest first, for export. */
 Json export_agent_sessions(const std::string& book) const;
 Json save_agent_session(const std::string& book,const Json& session);
 void remove_agent_session(const std::string& book,const std::string& id);
private:
 Json save_record(const std::string& book,const Json& annotation,bool importing);
 Json save_session(const std::string& book,const Json& session,bool importing);
 Json read_session(const std::string& book,const std::string& id,bool messages) const;
 sqlite3* db_=nullptr;
};
}
