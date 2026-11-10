#include "dr/annotations.h"
#include "dr/agent.h"
#include <sqlite3.h>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <stdexcept>
#include <string>
namespace dr {
namespace {
void check(sqlite3* db,int code){if(code!=SQLITE_OK&&code!=SQLITE_DONE&&code!=SQLITE_ROW)throw std::runtime_error(std::string("阅读数据库: ")+sqlite3_errmsg(db));}
void execute(sqlite3* db,const char* sql){check(db,sqlite3_exec(db,sql,nullptr,nullptr,nullptr));}
class Statement {
public:
 Statement(sqlite3* db,const char* sql):db_(db){check(db,sqlite3_prepare_v2(db,sql,-1,&value_,nullptr));}
 ~Statement(){sqlite3_finalize(value_);}
 void text(int index,const std::string& value){check(db_,sqlite3_bind_text(value_,index,value.data(),static_cast<int>(value.size()),SQLITE_TRANSIENT));}
 void integer(int index,int64_t value){check(db_,sqlite3_bind_int64(value_,index,value));}
 void real(int index,double value){check(db_,sqlite3_bind_double(value_,index,value));}
 bool row(){auto result=sqlite3_step(value_);check(db_,result);return result==SQLITE_ROW;}
 std::string string(int col)const{auto value=sqlite3_column_text(value_,col);auto length=sqlite3_column_bytes(value_,col);return value?std::string(reinterpret_cast<const char*>(value),static_cast<size_t>(length)):"";}
 int64_t number(int col)const{return sqlite3_column_int64(value_,col);}
 double real(int col)const{return sqlite3_column_double(value_,col);}
private:sqlite3* db_;sqlite3_stmt* value_=nullptr;
};
Json read_annotation(Statement& s){return {{"id",s.string(0)},{"bookId",s.string(1)},{"chapter",s.number(2)},{"href",s.string(3)},{"start",s.number(4)},{"end",s.number(5)},{"quote",s.string(6)},{"prefix",s.string(7)},{"suffix",s.string(8)},{"note",s.string(9)},{"color",s.string(10)},{"style",s.string(11)},{"createdAt",s.number(12)},{"updatedAt",s.number(13)}};}
constexpr auto columns="id,book_id,chapter,href,start_offset,end_offset,quote,prefix,suffix,note,color,style,created_at,updated_at";
// Colours are the original five names or a custom lowercase #rrggbb (schema version 2); a 'note'
// annotation keeps its note after its highlight or underline is removed (schema version 3).
std::string annotation_table(const std::string& name){return "CREATE TABLE IF NOT EXISTS "+name+R"((
 id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))), book_id TEXT NOT NULL,
 chapter INTEGER NOT NULL CHECK(chapter>=0), href TEXT NOT NULL,
 start_offset INTEGER NOT NULL CHECK(start_offset>=0),end_offset INTEGER NOT NULL CHECK(end_offset>start_offset),
 quote TEXT NOT NULL CHECK(length(quote)>0),prefix TEXT NOT NULL DEFAULT '',suffix TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','purple') OR color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
 style TEXT NOT NULL CHECK(style IN ('highlight','underline','note')),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),updated_at INTEGER NOT NULL DEFAULT(unixepoch()));)";}
bool valid_color(const std::string& color){
 if(color=="yellow"||color=="green"||color=="blue"||color=="pink"||color=="purple")return true;
 return color.size()==7&&color[0]=='#'&&std::all_of(color.begin()+1,color.end(),[](unsigned char c){return std::isdigit(c)||(c>='a'&&c<='f');});}
}
AnnotationStore::AnnotationStore(const fs::path& path){fs::create_directories(path.parent_path());auto result=sqlite3_open_v2(utf8(path).c_str(),&db_,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_FULLMUTEX,nullptr);
 if(result!=SQLITE_OK){std::string message=db_?sqlite3_errmsg(db_):"无法打开数据库";if(db_)sqlite3_close(db_);db_=nullptr;throw std::runtime_error(message);}
 try{sqlite3_busy_timeout(db_,5000);execute(db_,"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
 // The version statement is finalized before migrating: SQLite cannot drop a table while it runs.
 const auto schema=[&]{Statement version(db_,"PRAGMA user_version");version.row();return version.number(0);}();
 if(schema>3)throw std::runtime_error("阅读数据库版本较新，请使用新版 DR Reader");
 execute(db_,"BEGIN IMMEDIATE");
 try{
  // Versions 1 and 2 had narrower colour and style CHECKs. SQLite cannot relax a CHECK in place,
  // so the table is rebuilt once with every row copied unchanged.
  if(schema==1||schema==2){execute(db_,(annotation_table("annotations_v3")+R"(
   INSERT INTO annotations_v3()"+columns+") SELECT "+columns+R"( FROM annotations;
   DROP TABLE annotations; ALTER TABLE annotations_v3 RENAME TO annotations;)").c_str());}
  execute(db_,(annotation_table("annotations")+R"(
  CREATE INDEX IF NOT EXISTS annotations_location ON annotations(book_id,chapter,start_offset);
  CREATE TABLE IF NOT EXISTS bookmarks(book_id TEXT NOT NULL,chapter INTEGER NOT NULL,ratio REAL NOT NULL,title TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL DEFAULT(unixepoch()),PRIMARY KEY(book_id,chapter,ratio));
  CREATE TABLE IF NOT EXISTS migrations(book_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS agent_sessions(id TEXT PRIMARY KEY,book_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',
   created_at INTEGER NOT NULL DEFAULT(unixepoch()),updated_at INTEGER NOT NULL DEFAULT(unixepoch()));
  CREATE INDEX IF NOT EXISTS agent_sessions_book ON agent_sessions(book_id,updated_at);
  CREATE TABLE IF NOT EXISTS agent_messages(session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
   seq INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL,quote TEXT NOT NULL DEFAULT '',
   agent TEXT NOT NULL DEFAULT '',label TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',effort TEXT NOT NULL DEFAULT '',
   stopped INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT(unixepoch()),PRIMARY KEY(session_id,seq));
  -- The conversation tables are only added, so version 3 stays readable by earlier releases.
  PRAGMA user_version=3;)").c_str());
  execute(db_,"COMMIT");
 }catch(...){sqlite3_exec(db_,"ROLLBACK",nullptr,nullptr,nullptr);throw;}
 }catch(...){sqlite3_close(db_);db_=nullptr;throw;}}
AnnotationStore::~AnnotationStore(){if(db_)sqlite3_close(db_);}
Json AnnotationStore::list(const std::string& book)const{std::string sql=std::string("SELECT ")+columns+" FROM annotations WHERE book_id=? ORDER BY chapter,start_offset,created_at";Statement s(db_,sql.c_str());s.text(1,book);Json result=Json::array();while(s.row())result.push_back(read_annotation(s));return result;}
Json AnnotationStore::save(const std::string& book,const Json& a){return save_record(book,a,false);}
Json AnnotationStore::save_record(const std::string& book,const Json& a,bool importing){auto start=a.at("start").get<int64_t>(),end=a.at("end").get<int64_t>();auto quote=a.at("quote").get<std::string>(),note=a.value("note",std::string()),color=a.value("color",std::string("yellow")),style=a.value("style",std::string("highlight"));
 const auto quote_length=utf16_length(quote);
 if(start<0||end<=start||end>2147483647||end-start>16000||quote.empty()||quote_length>32768||utf16_length(note)>32768)throw std::runtime_error("选中文字或笔记超出可保存范围");
 if(quote_length!=static_cast<size_t>(end-start))throw std::runtime_error("标注文本偏移不一致");
 if(!valid_color(color))throw std::runtime_error("无效高亮颜色");if(style!="highlight"&&style!="underline"&&style!="note")throw std::runtime_error("无效标注样式");
 auto prefix=a.value("prefix",std::string()),suffix=a.value("suffix",std::string());if(prefix.size()>512||suffix.size()>512)throw std::runtime_error("标注上下文过长");auto id=a.value("id",std::string());
 if(importing){
  if(id.empty()||id.size()>128)throw std::runtime_error("无效笔记 ID");
  for(auto key:{"createdAt","updatedAt"})if(!a.at(key).is_number_integer()||a.at(key)<0||a.at(key)>253402300799LL)throw std::runtime_error("无效笔记时间");
  if(a.at("updatedAt")<a.at("createdAt"))throw std::runtime_error("笔记修改时间早于创建时间");
  Statement exists(db_,("SELECT "+std::string(columns)+" FROM annotations WHERE id=?").c_str());exists.text(1,id);
  if(exists.row()){
   auto local=read_annotation(exists);
   if(local.at("bookId")!=book)throw std::runtime_error("笔记 ID 已被其他图书使用");
   return local; // Import adds missing records; it never overwrites local edits.
  }
 }else if(id.empty()){Statement random(db_,"SELECT lower(hex(randomblob(16)))");random.row();id=random.string(0);}else{Statement exists(db_,"SELECT 1 FROM annotations WHERE book_id=? AND id=?");exists.text(1,book);exists.text(2,id);if(!exists.row())throw std::runtime_error("这条笔记不存在或不属于当前书籍");}
 Statement s(db_,R"(INSERT INTO annotations(id,book_id,chapter,href,start_offset,end_offset,quote,prefix,suffix,note,color,style) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET chapter=excluded.chapter,href=excluded.href,start_offset=excluded.start_offset,end_offset=excluded.end_offset,quote=excluded.quote,prefix=excluded.prefix,suffix=excluded.suffix,note=excluded.note,color=excluded.color,style=excluded.style,updated_at=unixepoch() WHERE annotations.book_id=excluded.book_id)");
 s.text(1,id);s.text(2,book);s.integer(3,a.at("chapter"));s.text(4,a.at("href"));s.integer(5,start);s.integer(6,end);s.text(7,quote);s.text(8,prefix);s.text(9,suffix);s.text(10,note);s.text(11,color);s.text(12,style);s.row();
 if(importing){Statement times(db_,"UPDATE annotations SET created_at=?,updated_at=? WHERE id=? AND book_id=?");times.integer(1,a.at("createdAt"));times.integer(2,a.at("updatedAt"));times.text(3,id);times.text(4,book);times.row();}
 std::string sql=std::string("SELECT ")+columns+" FROM annotations WHERE id=? AND book_id=?";Statement saved(db_,sql.c_str());saved.text(1,id);saved.text(2,book);if(!saved.row())throw std::runtime_error("未能保存笔记");return read_annotation(saved);}
Json AnnotationStore::import_annotations(const std::string& book,const Json& annotations){
 auto result=import_backup(book,annotations,Json::array());result.erase("conversationsImported");result.erase("conversationsSkipped");return result;}
Json AnnotationStore::import_backup(const std::string& book,const Json& annotations,const Json& sessions){
 if(!sessions.is_array()||sessions.size()>10000)throw std::runtime_error("对话列表无效或超过 10000 段");
 execute(db_,"BEGIN IMMEDIATE");
 try{
  const auto before=list(book).size(),sessions_before=agent_sessions(book).size();
  for(const auto& annotation:annotations)save_record(book,annotation,true);
  for(const auto& session:sessions)save_session(book,session,true);
  const auto added=list(book).size()-before,sessions_added=agent_sessions(book).size()-sessions_before;
  execute(db_,"COMMIT");
  return {{"imported",added},{"skipped",annotations.size()-added},{"conversationsImported",sessions_added},{"conversationsSkipped",sessions.size()-sessions_added}};
 }catch(...){sqlite3_exec(db_,"ROLLBACK",nullptr,nullptr,nullptr);throw;}
}
void AnnotationStore::remove(const std::string& book,const std::string& id){Statement s(db_,"DELETE FROM annotations WHERE book_id=? AND id=?");s.text(1,book);s.text(2,id);s.row();if(sqlite3_changes(db_)!=1)throw std::runtime_error("标注不存在或已被删除");}
void AnnotationStore::remove_book(const std::string& book){
 execute(db_,"BEGIN IMMEDIATE");
 try{
  for(auto sql:{"DELETE FROM annotations WHERE book_id=?","DELETE FROM bookmarks WHERE book_id=?","DELETE FROM migrations WHERE book_id=?","DELETE FROM agent_sessions WHERE book_id=?"}){
   Statement s(db_,sql);s.text(1,book);s.row();
  }
  execute(db_,"COMMIT");
 }catch(...){sqlite3_exec(db_,"ROLLBACK",nullptr,nullptr,nullptr);throw;}
}
void AnnotationStore::migrate_bookmarks(const std::string& book,const Json& legacy)const{Statement migrated(db_,"SELECT 1 FROM migrations WHERE book_id=?");migrated.text(1,book);if(migrated.row())return;
 execute(db_,"BEGIN IMMEDIATE");try{for(auto& mark:legacy){int chapter=mark.value("chapter",-1);double ratio=mark.value("ratio",0.0);if(chapter<0||!std::isfinite(ratio)||ratio<0||ratio>1)continue;
 Statement s(db_,"INSERT OR IGNORE INTO bookmarks(book_id,chapter,ratio,title) VALUES(?,?,?,?)");s.text(1,book);s.integer(2,chapter);s.real(3,ratio);s.text(4,mark.value("title",std::string()));s.row();}
 Statement done(db_,"INSERT OR IGNORE INTO migrations(book_id) VALUES(?)");done.text(1,book);done.row();execute(db_,"COMMIT");}catch(...){sqlite3_exec(db_,"ROLLBACK",nullptr,nullptr,nullptr);throw;}}
Json AnnotationStore::bookmarks(const std::string& book)const{Statement s(db_,"SELECT chapter,ratio,title FROM bookmarks WHERE book_id=? ORDER BY chapter,ratio");s.text(1,book);Json result=Json::array();while(s.row())result.push_back({{"chapter",s.number(0)},{"ratio",s.real(1)},{"title",s.string(2)}});return result;}
Json AnnotationStore::toggle_bookmark(const std::string& book,const Json& mark){int chapter=mark.at("chapter");double ratio=mark.at("ratio");
 execute(db_,"BEGIN IMMEDIATE");try{Statement remove(db_,"DELETE FROM bookmarks WHERE book_id=? AND chapter=? AND abs(ratio-?)<0.02");remove.text(1,book);remove.integer(2,chapter);remove.real(3,ratio);remove.row();if(sqlite3_changes(db_)==0){Statement insert(db_,"INSERT INTO bookmarks(book_id,chapter,ratio,title) VALUES(?,?,?,?)");insert.text(1,book);insert.integer(2,chapter);insert.real(3,ratio);insert.text(4,mark.value("title",std::string()));insert.row();}execute(db_,"COMMIT");}catch(...){sqlite3_exec(db_,"ROLLBACK",nullptr,nullptr,nullptr);throw;}return bookmarks(book);}

namespace {
bool session_id(const std::string& id){return !id.empty()&&id.size()<=64&&std::all_of(id.begin(),id.end(),[](unsigned char c){return std::isalnum(c)||c=='-';});}
bool valid_time(const Json& value){return value.is_number_integer()&&value>=0&&value<=253402300799LL;}
}
Json AnnotationStore::read_session(const std::string& book,const std::string& id,bool messages)const{
 Statement s(db_,"SELECT id,book_id,title,created_at,updated_at,(SELECT count(*) FROM agent_messages WHERE session_id=agent_sessions.id) FROM agent_sessions WHERE id=? AND book_id=?");
 s.text(1,id);s.text(2,book);if(!s.row())throw std::runtime_error("这段对话不存在或不属于当前书籍");
 Json session={{"id",s.string(0)},{"bookId",s.string(1)},{"title",s.string(2)},{"createdAt",s.number(3)},{"updatedAt",s.number(4)},{"messageCount",s.number(5)}};
 if(!messages)return session;
 Statement m(db_,"SELECT role,text,quote,agent,label,model,effort,stopped,created_at FROM agent_messages WHERE session_id=? ORDER BY seq");m.text(1,id);
 Json list=Json::array();
 while(m.row())list.push_back({{"role",m.string(0)},{"text",m.string(1)},{"quote",m.string(2)},{"agent",m.string(3)},{"label",m.string(4)},{"model",m.string(5)},{"effort",m.string(6)},{"stopped",m.number(7)!=0},{"createdAt",m.number(8)}});
 session["messages"]=std::move(list);return session;}
Json AnnotationStore::agent_sessions(const std::string& book)const{
 Statement s(db_,"SELECT id FROM agent_sessions WHERE book_id=? ORDER BY updated_at DESC,created_at DESC,rowid DESC");s.text(1,book);
 std::vector<std::string> ids;while(s.row())ids.push_back(s.string(0));
 Json result=Json::array();for(auto& id:ids)result.push_back(read_session(book,id,false));return result;}
Json AnnotationStore::agent_session(const std::string& book,const std::string& id)const{return read_session(book,id,true);}
Json AnnotationStore::export_agent_sessions(const std::string& book)const{
 Statement s(db_,"SELECT id FROM agent_sessions WHERE book_id=? ORDER BY created_at,rowid");s.text(1,book);
 std::vector<std::string> ids;while(s.row())ids.push_back(s.string(0));
 Json result=Json::array();for(auto& id:ids){auto session=read_session(book,id,true);session.erase("messageCount");result.push_back(std::move(session));}return result;}
Json AnnotationStore::save_agent_session(const std::string& book,const Json& session){
 execute(db_,"BEGIN IMMEDIATE");
 try{auto saved=save_session(book,session,false);execute(db_,"COMMIT");return saved;}
 catch(...){sqlite3_exec(db_,"ROLLBACK",nullptr,nullptr,nullptr);throw;}}
// Runs inside the caller's transaction.
Json AnnotationStore::save_session(const std::string& book,const Json& session,bool importing){
 if(!session.is_object())throw std::runtime_error("对话格式无效");
 const auto id=session.value("id",std::string());
 if(!session_id(id))throw std::runtime_error("无效对话 ID");
 auto title=session.value("title",std::string());
 if(utf16_length(title)>200)throw std::runtime_error("对话标题过长");
 const auto& messages=session.at("messages");
 if(!messages.is_array()||messages.empty()||messages.size()>2000)throw std::runtime_error("对话消息为空或超过 2000 条");
 size_t total=0;
 for(const auto& message:messages){
  if(!message.is_object())throw std::runtime_error("对话消息格式无效");
  const auto role=message.value("role",std::string()),text=message.value("text",std::string());
  if(role!="user"&&role!="assistant")throw std::runtime_error("对话消息角色无效");
  if(text.empty()||text.size()>(1u<<20)||message.value("quote",std::string()).size()>(64u<<10))throw std::runtime_error("对话消息为空或过长");
  const auto agent=message.value("agent",std::string());
  if(!agent.empty()&&!agent_kind(agent))throw std::runtime_error("对话消息的工具无效");
  if(message.value("label",std::string()).size()>64)throw std::runtime_error("对话消息的工具名称过长");
  validate_agent_model(message.value("model",std::string()));validate_agent_effort(message.value("effort",std::string()));
  if(message.contains("stopped")&&!message["stopped"].is_boolean())throw std::runtime_error("对话消息格式无效");
  if(message.contains("createdAt")&&!valid_time(message["createdAt"]))throw std::runtime_error("对话消息时间无效");
  total+=text.size();}
 if(total>(8u<<20))throw std::runtime_error("对话内容超过 8 MiB");
 Statement owner(db_,"SELECT book_id FROM agent_sessions WHERE id=?");owner.text(1,id);
 if(owner.row()){
  if(owner.string(0)!=book)throw std::runtime_error("对话 ID 已被其他图书使用");
  if(importing)return read_session(book,id,true); // import never overwrites local conversations
 }
 if(importing)for(auto key:{"createdAt","updatedAt"})if(!session.contains(key)||!valid_time(session.at(key)))throw std::runtime_error("对话时间无效");
 Statement upsert(db_,"INSERT INTO agent_sessions(id,book_id,title) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=unixepoch()");
 upsert.text(1,id);upsert.text(2,book);upsert.text(3,title);upsert.row();
 if(importing){Statement times(db_,"UPDATE agent_sessions SET created_at=?,updated_at=? WHERE id=?");times.integer(1,session.at("createdAt"));times.integer(2,session.at("updatedAt"));times.text(3,id);times.row();}
 Statement clear(db_,"DELETE FROM agent_messages WHERE session_id=?");clear.text(1,id);clear.row();
 int64_t seq=0;
 for(const auto& message:messages){
  Statement insert(db_,"INSERT INTO agent_messages(session_id,seq,role,text,quote,agent,label,model,effort,stopped,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,coalesce(?,unixepoch()))");
  insert.text(1,id);insert.integer(2,seq++);insert.text(3,message.at("role"));insert.text(4,message.at("text"));
  insert.text(5,message.value("quote",std::string()));insert.text(6,message.value("agent",std::string()));insert.text(7,message.value("label",std::string()));
  insert.text(8,message.value("model",std::string()));insert.text(9,message.value("effort",std::string()));insert.integer(10,message.value("stopped",false)?1:0);
  if(message.contains("createdAt"))insert.integer(11,message.at("createdAt"));
  insert.row();}
 return read_session(book,id,true);}
void AnnotationStore::remove_agent_session(const std::string& book,const std::string& id){
 Statement s(db_,"DELETE FROM agent_sessions WHERE book_id=? AND id=?");s.text(1,book);s.text(2,id);s.row();
 if(sqlite3_changes(db_)!=1)throw std::runtime_error("对话不存在或已被删除");}
}
