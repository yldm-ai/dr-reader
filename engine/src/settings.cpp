#include "dr/settings.h"
#include "dr/agent.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>
#include <stdexcept>
namespace dr {
Json default_settings()
{
    return Json::parse(R"defaults({
  "application": {
    "agent": "auto",
    "agentModels": { "claude": "", "codex": "", "opencode": "" },
    "agentEfforts": { "claude": "", "codex": "", "opencode": "" },
    "animations": true,
    "librarySort": "added",
    "bookOpeningAnimation": "circles",
    "bookOpeningEnabled": true,
    "dictionaries": [
      {
        "enabled": true,
        "id": "youdao",
        "name": "有道词典",
        "url": "https://dict.youdao.com/result?word={text}&lang=en"
      },
      {
        "enabled": true,
        "id": "bing",
        "name": "必应搜索",
        "url": "https://www.bing.com/search?q={text}"
      }
    ],
    "highlightColors": [
      "#ddedea",
      "#fbf3db",
      "#ddebf1",
      "#f4dfeb",
      "#eae4f2"
    ],
    "selectionActions": {
      "ask": true,
      "copy": true,
      "dictionary": true,
      "highlight": true,
      "note": true,
      "search": true,
      "underline": true
    },
    "shell": "direct2d",
    "theme": "system",
    "underlineColor": "#ddebf1"
  },
  "reading": {
    "alignment": "justify",
    "animation": "turn",
    "animationDuration": 500,
    "background": "plain",
    "doubleAnimation": "turn",
    "fontFamily": "Microsoft YaHei UI",
    "fontSize": 18,
    "fontWeight": 400,
    "fullBackground": true,
    "fullWidth": true,
    "layout": "double",
    "letterSpacing": 0.0,
    "lineHeight": 1.9,
    "mode": "paged",
    "paddingBottom": 38,
    "paddingLeft": 44,
    "paddingRight": 44,
    "paddingTop": 38,
    "paddingX": 44,
    "paddingY": 38,
    "paragraphSpacing": 1.0,
    "publisherStyles": true,
    "showBookPages": true,
    "showChapterTitle": false,
    "showPagination": false,
    "showProgress": true,
    "autoHideProgress": false,
    "showToc": true,
    "showToolbar": true,
    "textIndent": 0.0,
    "theme": "system",
    "tocPinned": false,
    "turnDuration": 500,
    "width": 760
  },
  "window": {
    "widthRatio": 0.6,
    "heightRatio": 0.75
  },
  "version": 2
})defaults");
}
namespace {
void enumeration(Json& target,const Json& patch,const char* key,std::initializer_list<const char*> allowed){if(!patch.contains(key))return;for(auto value:allowed)if(patch[key]==value){target[key]=value;return;}throw std::runtime_error(std::string("不支持的设置值: ")+key);}
void number(Json& target,const Json& patch,const char* key,double minimum,double maximum,bool integral=false){if(!patch.contains(key))return;if(!patch[key].is_number())throw std::runtime_error(std::string("设置必须是数字: ")+key);double value=patch[key].get<double>();if(!std::isfinite(value))throw std::runtime_error("设置值无效");value=std::clamp(value,minimum,maximum);if(integral)target[key]=static_cast<int>(std::round(value));else target[key]=value;}
void boolean(Json& target,const Json& patch,const char* key){if(!patch.contains(key))return;if(!patch[key].is_boolean())throw std::runtime_error("设置必须为开关值");target[key]=patch[key];}
void validate_url(const std::string& url){if(url.size()>2048||(!url.starts_with("https://")&&!url.starts_with("http://"))||url.find_first_of(" \r\n\t\\")!=url.npos||url.find('\0')!=url.npos||url.find("{text}")==url.npos)throw std::runtime_error("查词地址必须是包含 {text} 的 HTTP/HTTPS 地址");auto host=url.substr(url.find("://")+3);host=host.substr(0,host.find_first_of("/?#"));if(host.empty()||host.find('@')!=host.npos)throw std::runtime_error("无效的查词网站地址");}
}
Json patch_settings(const Json& current,const Json& patch){if(!patch.is_object())throw std::runtime_error("设置格式无效");auto result=current;
 if(patch.contains("application")){auto p=patch.at("application");if(!p.is_object())throw std::runtime_error("应用设置格式无效");auto& a=result["application"];enumeration(a,p,"shell",{"mica","direct2d"});enumeration(a,p,"librarySort",{"added","read","title","author"});enumeration(a,p,"theme",{"system","light","sepia","dark"});boolean(a,p,"animations");boolean(a,p,"bookOpeningEnabled");enumeration(a,p,"bookOpeningAnimation",{"circles","book","cover","none"});
 // Most recent highlight colours first; the reader pushes a new pick to the front.
 if(p.contains("highlightColors")){auto colors=p["highlightColors"];if(!colors.is_array()||colors.empty()||colors.size()>8)throw std::runtime_error("高亮颜色需要 1 到 8 个");Json palette=Json::array();for(auto& color:colors){if(!color.is_string())throw std::runtime_error("高亮颜色格式无效");auto value=color.get<std::string>();std::transform(value.begin(),value.end(),value.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});if(value.size()!=7||value[0]!='#'||!std::all_of(value.begin()+1,value.end(),[](unsigned char c){return std::isxdigit(c)!=0;}))throw std::runtime_error("高亮颜色必须是 #rrggbb");palette.push_back(value);}a["highlightColors"]=palette;}
 if(p.contains("underlineColor")){auto color=p["underlineColor"];if(!color.is_string())throw std::runtime_error("下划线颜色格式无效");auto value=color.get<std::string>();std::transform(value.begin(),value.end(),value.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});if(value.size()!=7||value[0]!='#'||!std::all_of(value.begin()+1,value.end(),[](unsigned char c){return std::isxdigit(c)!=0;}))throw std::runtime_error("下划线颜色必须是 #rrggbb");a["underlineColor"]=value;}
 if(p.contains("selectionActions")){auto actions=p["selectionActions"];if(!actions.is_object())throw std::runtime_error("选词菜单设置无效");for(auto key:{"highlight","underline","note","copy","search","dictionary","ask"})boolean(a["selectionActions"],actions,key);}
 // Reading assistance: which local agent CLI answers, and an optional model and reasoning effort per CLI.
 enumeration(a,p,"agent",{"auto","codex","claude","opencode"});
 if(p.contains("agentModels")){auto models=p["agentModels"];if(!models.is_object())throw std::runtime_error("模型设置格式无效");for(auto key:{"codex","claude","opencode"}){if(!models.contains(key))continue;if(!models[key].is_string())throw std::runtime_error("模型名称格式无效");auto model=models[key].get<std::string>();validate_agent_model(model);a["agentModels"][key]=model;}}
 if(p.contains("agentEfforts")){auto efforts=p["agentEfforts"];if(!efforts.is_object())throw std::runtime_error("思考强度设置格式无效");for(auto key:{"codex","claude","opencode"}){if(!efforts.contains(key))continue;if(!efforts[key].is_string())throw std::runtime_error("思考强度格式无效");auto effort=efforts[key].get<std::string>();validate_agent_effort(effort);a["agentEfforts"][key]=effort;}}
 if(p.contains("dictionaries")){if(!p["dictionaries"].is_array()||p["dictionaries"].size()>12)throw std::runtime_error("最多添加 12 个查词网站");Json dictionaries=Json::array();std::set<std::string> ids;for(auto& item:p["dictionaries"]){auto id=item.at("id").get<std::string>(),name=item.at("name").get<std::string>(),url=item.at("url").get<std::string>();if(id.empty()||id.size()>64||name.empty()||name.size()>128||!ids.insert(id).second)throw std::runtime_error("查词网站名称或标识无效");validate_url(url);dictionaries.push_back({{"id",id},{"name",name},{"url",url},{"enabled",item.value("enabled",true)}});}a["dictionaries"]=dictionaries;}}
 if(patch.contains("reading")){auto p=patch["reading"];if(!p.is_object())throw std::runtime_error("排版设置格式无效");auto& r=result["reading"];enumeration(r,p,"theme",{"system","light","dark","sepia","green","gray","night"});enumeration(r,p,"background",{"plain","grain","fiber","linen","wash"});enumeration(r,p,"mode",{"scroll","paged"});enumeration(r,p,"layout",{"single","double"});enumeration(r,p,"doubleAnimation",{"none","turn","turn-hard"});enumeration(r,p,"alignment",{"justify","left","center"});if(p.contains("animation")&&p["animation"]=="turn-bottom")p["animation"]="turn";/* The soft-page corner now follows the pointer; keep saved bottom-corner choices loadable. */enumeration(r,p,"animation",{"none","slide","cover","fade","turn","turn-hard"});
 if(p.contains("fontFamily")){auto font=p.at("fontFamily").get<std::string>();if(font.empty()||font.size()>256||font.find_first_of("\r\n")!=font.npos)throw std::runtime_error("无效字体名称");r["fontFamily"]=font;}
 number(r,p,"fontSize",10,56,true);number(r,p,"fontWeight",300,800,true);number(r,p,"lineHeight",1.0,3.0);number(r,p,"paragraphSpacing",0,3);number(r,p,"letterSpacing",-1,6);number(r,p,"textIndent",0,4);number(r,p,"width",400,1600,true);number(r,p,"paddingX",0,240,true);number(r,p,"paddingY",0,240,true);
 if(p.contains("paddingX")){if(!p.contains("paddingLeft"))r["paddingLeft"]=r["paddingX"];if(!p.contains("paddingRight"))r["paddingRight"]=r["paddingX"];}
 if(p.contains("paddingY")){if(!p.contains("paddingTop"))r["paddingTop"]=r["paddingY"];if(!p.contains("paddingBottom"))r["paddingBottom"]=r["paddingY"];}
 for(auto key:{"paddingTop","paddingBottom","paddingLeft","paddingRight"})number(r,p,key,0,240,true);
 for(auto key:{"showToolbar","showToc","tocPinned","showChapterTitle","showPagination","showProgress","autoHideProgress","fullBackground","fullWidth","showBookPages"})boolean(r,p,key);
 number(r,p,"animationDuration",100,600,true);number(r,p,"turnDuration",300,2000,true);boolean(r,p,"publisherStyles");}
 if(patch.contains("window")){const auto& p=patch.at("window");if(!p.is_object())throw std::runtime_error("窗口设置格式无效");auto& w=result["window"];number(w,p,"widthRatio",0.1,1.0);number(w,p,"heightRatio",0.1,1.0);for(auto key:{"widthRatio","heightRatio"})w[key]=std::round(w[key].get<double>()*100.0)/100.0;}
 result["version"]=2;return result;}
Json normalize_settings(const Json& source){auto defaults=default_settings();if(!source.is_object())return defaults;if(source.contains("application")||source.contains("reading")||source.contains("window")){try{auto normalized=patch_settings(defaults,source);if(source.contains("application")&&source["application"].is_object()&&!source["application"].contains("bookOpeningEnabled")&&source["application"].contains("animations"))normalized["application"]["bookOpeningEnabled"]=normalized["application"]["animations"];return normalized;}catch(const std::exception&){return defaults;}}
 Json old_app=Json::object(),old_reading=Json::object();for(auto key:{"shell","theme"})if(source.contains(key))old_app[key]=source[key];for(auto key:{"theme","fontFamily","fontSize","lineHeight","width","mode"})if(source.contains(key))old_reading[key]=source[key];try{return patch_settings(defaults,{{"application",old_app},{"reading",old_reading}});}catch(const std::exception&){return defaults;}}
std::string dictionary_url(const Json& settings,const std::string& id,const std::string& text){if(text.empty()||text.size()>8192)throw std::runtime_error("查词文字为空或过长");for(auto& item:settings.at("application").at("dictionaries"))if(item["id"]==id&&item.value("enabled",true)){auto url=item.at("url").get<std::string>();validate_url(url);std::string encoded;for(unsigned char c:text){constexpr char digits[]="0123456789ABCDEF";if(std::isalnum(c)||c=='-'||c=='_'||c=='.'||c=='~')encoded+=char(c);else{encoded+='%';encoded+=digits[c>>4];encoded+=digits[c&15];}}for(size_t p=0;(p=url.find("{text}",p))!=url.npos;p+=encoded.size())url.replace(p,6,encoded);return url;}throw std::runtime_error("查词网站不存在或已禁用");}
}
