import { $, call, escape, toast, errorMessage } from './bridge.ts';
import { icon } from './icons.ts';
import { readingPalette, readingThemes } from './reading-palette.ts';
import { backgroundImage, readingBackgrounds } from './reading-backgrounds.ts';
import type { ReadingBackground } from './settings-state.ts';
import { SelectControl } from './select-control.ts';
import { dragDialog } from './drag-dialog.ts';
import { OverlayScrollbar } from './scrollbar.ts';
import { fontChoices } from './fonts.ts';
import type { AgentChoice, AgentId, AgentModelInfo, ApplicationSettings, Bootstrap, Dictionary, SelectionAction, Settings, SettingsPatch } from './types.ts';
export { fontStack } from './fonts.ts';

type Group = keyof SettingsPatch;
type Option = readonly [value: string | number, text: string, glyph?: string];
type Values = Record<string, unknown>;
/** Every control bound to a reading setting: range and number pairs, checkboxes, radios and selects. */
type ReadingControl = HTMLInputElement | HTMLSelectElement;

// Application and reading themes can follow the system or use a fixed paper.
const themes=(group:Group,list:readonly (readonly [string,string])[]=[['light','明亮'],['sepia','纸张'],['dark','夜间']])=>`<div class="theme-options${group==='reading'?' compact':''}">${list.map(([value,label])=>`<button class="theme-swatch ${value}" data-setting-theme="${group}" data-value="${value}"><span>Aa</span>${label}</button>`).join('')}</div>`;
// The editable number beside the track is the only readout, so values are not shown twice.
const slider=(key:string,label:string,min:number,max:number,step:number,unit='')=>`<label class="setting-row slider-row" for="setting-${key}">${label}<div class="range-control"><input id="setting-${key}" data-reading="${key}" type="range" min="${min}" max="${max}" step="${step}"><span class="range-value"><input id="number-${key}" class="range-number" data-reading="${key}" type="number" min="${min}" max="${max}" step="${step}" aria-label="${label}数值"><span class="range-unit">${unit}</span></span></div></label>`;
const checkbox=(key:string,label:string,hint='')=>`<label class="setting-row checkbox-row"><span>${label}${hint?`<small>${hint}</small>`:''}</span><input id="setting-${key}" data-reading="${key}" type="checkbox"></label>`;
const select=(key:string,label:string,options:readonly Option[])=>`<div class="setting-row select-row"><span id="setting-${key}-label">${label}</span><select id="setting-${key}" aria-labelledby="setting-${key}-label" data-reading="${key}">${options.map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select></div>`;
// Two or three choices read better as one visible segmented control than as a dropdown.
const segmented=(key:string,label:string,options:readonly Option[])=>`<div class="setting-row segmented-row"><span id="setting-${key}-label">${label}</span><div class="segmented" role="radiogroup" aria-labelledby="setting-${key}-label">${options.map(([value,text,glyph])=>`<label><input type="radio" name="setting-${key}" id="setting-${key}-${value}" data-reading="${key}" value="${value}"><span>${glyph?icon(glyph):''}${text}</span></label>`).join('')}</div></div>`;
function dialog(id:string,title:string,eyebrow:string,body:string){return `<dialog id="${id}" class="settings-dialog"><div class="settings-header"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div><button data-close="${id}" class="icon-button" aria-label="关闭${title}">${icon('close')}</button></div><div class="settings-body">${body}</div></dialog>`;}
const input=(id:string)=>$<HTMLInputElement>(id);
const dialogElement=(id:string)=>$<HTMLDialogElement>(id);
const agents:[AgentId,string][]=[['codex','Codex'],['claude','Claude Code'],['opencode','opencode']];
// Mirrors validate_agent_model in engine/src/agent.cpp.
const agentModelPattern=/^[A-Za-z0-9._:/@+\-[\]]{0,128}$/;
// Mirrors validate_agent_effort.
const agentEffortPattern=/^[A-Za-z0-9_-]{0,32}$/;
// Neither a valid model id nor an effort, so it can stand for "type another one" in the lists.
const CUSTOM_CHOICE='*custom';
const effortNames:Record<string,string>={none:'不思考',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极限'};
const effortLabel=(effort:string)=>effortNames[effort]?`${effortNames[effort]}（${effort}）`:effort;
// A display name that only restates the id ("GPT-6.1-Sol" for gpt-6.1-sol) is shown alone.
const plain=(text:string)=>text.toLowerCase().replace(/[\s_-]/g,'');
const modelLabel=(model:AgentModelInfo)=>plain(model.name)===plain(model.id)?model.name:`${model.name}（${model.id}）`;

export class SettingsPanel {
 onChange:(value:Settings)=>void;
 pending:SettingsPatch={};
 chain:Promise<void>=Promise.resolve();
 revision=0;
 selectControls=new Map<string,SelectControl>();
 value?:Settings;
 confirmed?:Settings;
 defaults?:Settings;
 fonts:string[]=[];
 updateFrame=0;
 timer?:ReturnType<typeof setTimeout>;
 returnFocus:Element|null=null;
 editingDictionary:string|null=null;
 /** The application settings group shown last; the dialog reopens on it. */
 section='appearance';
 dictionarySignature?:string;
 /** Each CLI's model list, queried when the settings open and kept for the session. */
 agentModels=new Map<AgentId,{models?:AgentModelInfo[];error?:string;loading?:boolean}>();
 /** 其他… is chosen in that list and its value is being typed. */
 customChoice={model:false,effort:false};

 constructor(onChange:(value:Settings)=>void){this.onChange=onChange;
 // Application settings: a draggable modal with a caption bar (as in DR Dict's settings), vertical
 // tabs on the left and one group at a time on the right, each a ruled heading over borderless rows.
 const groups=[['appearance',icon('palette'),'外观'],['selection',icon('highlighter'),'选词与查词'],['agent',icon('agent','fluent'),'AI 助读'],['about',icon('info'),'关于']];
 const group=(id:string,title:string,rows:string)=>`<section id="app-section-${id}" class="app-section" role="tabpanel" aria-labelledby="app-tab-${id}" hidden><h2 id="app-section-${id}-title">${title}</h2>${rows}</section>`;
 const label=(text:string,hint='',id='')=>`<span class="app-row-label"${id?` id="${id}"`:''}>${text}${hint?`<small>${hint}</small>`:''}</span>`;
 const application=group('appearance','外观',`<div class="app-row app-row-stack">${label('界面主题','书库、工具栏和设置的配色；阅读页面在阅读设置中单独选择')}${themes('application',[['light','明亮'],['dark','黑暗'],['sepia','纸张'],['system','跟随系统']])}</div>
 <label class="app-row checkbox-row">${label('界面动画','同时遵循系统的减少动态效果偏好')}<input id="app-animations" type="checkbox"></label>
 <label class="app-row checkbox-row">${label('开书动画','打开书籍时播放动画，独立于界面动画')}<input id="app-book-opening-enabled" type="checkbox"></label>
 <div class="app-row">${label('开书动画样式','正文就绪后结束动画','app-book-opening-label')}<select id="app-book-opening" aria-labelledby="app-book-opening-label"><option value="circles">彩色圆环</option><option value="book">翻开书本</option><option value="cover">封面展开右移</option><option value="none">无</option></select></div>
 <div class="app-row">${label('窗口标题栏','自绘标题栏的高度随系统指标与 DPI 变化','shell-label')}<div class="segmented" role="radiogroup" aria-labelledby="shell-label"><label><input type="radio" name="shell" value="mica"><span>系统云母</span></label><label><input type="radio" name="shell" value="direct2d"><span>Direct2D 自绘</span></label></div></div>`)
 +group('selection','选词与查词',`<div class="app-row app-row-stack">${label('选中文字后的菜单','只显示你常用的操作')}<div class="action-options">${[['highlight','高亮'],['underline','下划线'],['note','记笔记'],['copy','复制文字'],['search','书内搜索'],['dictionary','跳转查词'],['ask','问 AI']].map(([key,text])=>`<label><input type="checkbox" data-selection-action="${key}">${text}</label>`).join('')}</div></div>
 <div class="app-row app-row-stack">${label('查词网站','点击时通过默认浏览器打开；使用 {text} 表示选中的文字，支持 HTTP / HTTPS')}<div id="dictionary-list"></div><form id="dictionary-form" class="dictionary-form"><input id="dictionary-name" maxlength="32" placeholder="名称，例如：我的词典" aria-label="查词网站名称" required><input id="dictionary-url" type="url" maxlength="2048" placeholder="https://example.com/search?q={text}" aria-label="查词地址模板" required><div class="form-actions"><button id="dictionary-cancel" type="button" class="text-button" hidden>取消编辑</button><button type="submit" class="primary" id="dictionary-submit">添加网站</button></div><p id="dictionary-error" class="inline-error" role="alert" hidden></p></form></div>`)
 +group('agent','AI 助读',`<div class="app-row">${label('回答问题的工具','复用本机已安装并登录的命令行 Agent','app-agent-label')}<div class="agent-control"><button id="app-agent-detect" class="icon-button" type="button" title="重新检测本机工具" aria-label="重新检测本机工具">${icon('refresh')}</button><select id="app-agent" aria-labelledby="app-agent-label"><option value="auto">自动选择</option>${agents.map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></div></div>
 <div class="app-row">${label('模型','<span id="app-agent-model-status"></span>','app-agent-model-label')}<div class="agent-control"><button id="app-agent-model-refresh" class="icon-button" type="button" title="重新查询可用模型" aria-label="重新查询可用模型">${icon('refresh')}</button><select id="app-agent-model" aria-labelledby="app-agent-model-label"></select></div></div>
 <div id="app-agent-model-custom-row" class="app-row" hidden>${label('其他模型','填写该工具能识别的模型名称，按 Enter 保存','app-agent-model-custom-label')}<input id="app-agent-model-custom" class="app-text-input" maxlength="128" spellcheck="false" autocomplete="off" aria-labelledby="app-agent-model-custom-label"></div>
 <div class="app-row">${label('思考强度','<span id="app-agent-effort-status"></span>','app-agent-effort-label')}<div class="agent-control"><select id="app-agent-effort" aria-labelledby="app-agent-effort-label"></select></div></div>
 <div id="app-agent-effort-custom-row" class="app-row" hidden>${label('其他强度','填写该工具能识别的强度名称，按 Enter 保存','app-agent-effort-custom-label')}<input id="app-agent-effort-custom" class="app-text-input" maxlength="32" spellcheck="false" autocomplete="off" aria-labelledby="app-agent-effort-custom-label"></div>
 <div class="app-row app-row-stack">${label('本机检测','自动选择时，按 Codex、Claude Code、opencode 的顺序使用第一个找到的工具')}<ul id="app-agent-status" class="agent-status"></ul><p class="setting-note">提问时，选中的文字、当前章节阅读位置附近的正文和本次对话会发送给该工具所连接的模型服务。工具在临时目录中以只读、不调用工具的方式运行，不会写入你的项目或会话列表。</p></div>`)
 +group('about','关于',`<div class="app-row about"><span class="brand-mark">${icon('book')}</span><span class="app-row-label">DR Reader<small>0.2.0 · 本地阅读与笔记</small></span></div>
 <div class="app-row app-row-stack">${label('数据目录','书库与 SQLite 笔记数据库 reader.sqlite3')}<code id="data-path" class="storage-path"></code></div>`);
 const reading=`<section><h3>阅读方式</h3>${segmented('mode','翻页与滚动',[['paged','左右翻页','paged'],['scroll','上下滚动','scroll']])}${segmented('layout','页面布局',[['single','单页','page-single'],['double','双页','page-double']])}<p class="setting-note">左右翻页：点击正文右侧翻下一页，左侧翻上一页。滚轮和方向键也可翻页；选中文字、点击链接和标注时不会翻页。上下滚动：滚轮连续滚动正文。</p></section><section><h3>页面主题</h3>${themes('reading',readingThemes)}<div class="setting-row texture-row"><span id="setting-background-label">背景</span><div class="theme-textures" role="radiogroup" aria-labelledby="setting-background-label">${readingBackgrounds.map(([value,text])=>`<button type="button" class="theme-texture" role="radio" data-setting-background="${value}" aria-checked="false"><span class="theme-texture-sample"></span><span>${text}</span></button>`).join('')}</div></div><p class="setting-note">只影响阅读页面，应用外观在应用设置中单独调整。</p></section>
 <section><h3>字体与文字</h3>${select('fontFamily','字体',[])}${slider('fontSize','字号',10,56,1,'px')}${select('fontWeight','字重',[[300,'细体'],[400,'常规'],[500,'中等'],[600,'半粗'],[700,'粗体'],[800,'特粗']])}${slider('lineHeight','行间距',1,3,.05,'倍')}${slider('paragraphSpacing','段间距',0,3,.1,'em')}${slider('letterSpacing','字间距',-1,6,.1,'px')}${slider('textIndent','首行缩进',0,4,.5,'字')}${segmented('alignment','正文对齐',[['justify','两端','align-justify'],['left','左对齐','align-left'],['center','居中','align-center']])}<label class="setting-row checkbox-row"><span>保留原书段落样式<small>开启后由原书控制段距、缩进和文字细节</small></span><input id="setting-publisherStyles" data-reading="publisherStyles" type="checkbox"></label></section>
 <section><h3>沉浸与界面</h3><div class="setting-row select-row"><span id="setting-immersive-label">沉浸式阅读</span><select id="setting-immersive" aria-labelledby="setting-immersive-label"><option value="keep">保持现状</option><option value="text">只看正文</option><option value="chrome">显示阅读界面</option><option value="window">窗口内全屏</option></select></div>${checkbox('showToolbar','顶部工具栏')}${checkbox('showToc','左侧目录与笔记')}${checkbox('showChapterTitle','章节标题')}${checkbox('showPagination','上一页、下一页与页码')}${checkbox('showProgress','底部进度条')}${checkbox('autoHideProgress','自动隐藏底部信息栏','鼠标移到阅读区域底部时显示，移开后自动收起')}${checkbox('showBookPages','全书页码','在底部显示读到全书第几页、共多少页；按当前排版估算，翻阅过的章节会更准确')}<p class="setting-note">Alt + Enter 隐藏标题栏，窗口大小和位置不变，再按一次恢复；无标题栏时可用 Win + 方向键或 Alt + 空格移动窗口。F11 进入或退出全屏，Esc 退出全屏。F8 随时打开阅读设置。隐藏工具栏后，点击正文中央或移动到顶部可找回操作入口。</p></section><section><h3>页面布局</h3>${checkbox('fullBackground','正文背景铺满阅读区域','去掉纸张边界，正文之外的阅读区域也使用纸张颜色')}${checkbox('fullWidth','正文使用全部可用宽度','四周留白仍可单独调整；关闭后使用下面的宽度限制')}${slider('width','正文区域宽度',400,1600,20,'px')}${slider('paddingTop','顶部留白',0,240,2,'px')}${slider('paddingBottom','底部留白',0,240,2,'px')}${slider('paddingLeft','左侧留白',0,240,2,'px')}${slider('paddingRight','右侧留白',0,240,2,'px')}</section>
 <section><h3>翻页动画</h3>${select('animation','动画效果',[['none','无动画'],['slide','平移'],['cover','覆盖'],['fade','淡入淡出'],['turn','软纸卷页'],['turn-hard','硬纸翻页']])}${select('doubleAnimation','双页动画',[['none','无动画'],['turn','软纸卷页'],['turn-hard','硬纸翻页']])}${slider('animationDuration','动画时长',100,600,10,'ms')}${slider('turnDuration','翻页时长',300,2000,50,'ms')}<p class="setting-note">动画时长用于平移、覆盖和淡入淡出，翻页时长用于软纸卷页和硬纸翻页；双页布局只提供书本式翻页。动画在应用关闭动态效果时自动停用。</p></section><button id="reset-reading" class="text-button reset-button">恢复默认排版</button>`;
 for(const id of ['application-settings','reading-settings'])document.getElementById(id)?.remove();
 document.body.insertAdjacentHTML('beforeend',`<dialog id="application-settings" class="app-settings" aria-labelledby="application-settings-title"><header class="app-settings-caption"><h1 id="application-settings-title" class="app-settings-title">应用设置</h1><button id="application-settings-close" class="caption-close" type="button" title="关闭" aria-label="关闭应用设置">${icon('caption-close','fluent')}</button></header><nav class="app-settings-nav" role="tablist" aria-orientation="vertical" aria-label="设置分类"><span class="app-settings-indicator" aria-hidden="true"></span>${groups.map(([id,glyph,title])=>`<button type="button" role="tab" id="app-tab-${id}" class="app-settings-tab" data-section="${id}" aria-controls="app-section-${id}" aria-selected="false" tabindex="-1">${glyph}<span>${title}</span></button>`).join('')}</nav><div class="app-settings-main"><div id="application-settings-scroll" class="app-settings-scroll">${application}</div></div></dialog>`+dialog('reading-settings','阅读设置','READING PREFERENCES',reading));
 const appDialog=dialogElement('application-settings'),appScroll=$('application-settings-scroll');
 $('application-settings-close').onclick=()=>this.closeApplication();
 dragDialog(appDialog,'.app-settings-caption');
 // Esc, the close button or a click on the backdrop dismisses it.
 appDialog.addEventListener('click',e=>{if(e.target!==appDialog)return;const r=appDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)this.closeApplication();});
 appDialog.addEventListener('close',()=>{(this.returnFocus as HTMLElement|null)?.focus?.({preventScroll:true});this.flush();});
 const tabs=[...appDialog.querySelectorAll<HTMLButtonElement>('.app-settings-tab')];
 for(const tab of tabs)tab.onclick=()=>this.showSection(tab.dataset.section!);
 // The narrow layout lays the tabs out in a row; the bar follows without sliding.
 new ResizeObserver(()=>this.placeIndicator(false)).observe(appDialog.querySelector('.app-settings-nav')!);
 // Arrow keys move between tabs, as in a native property sheet; Home and End jump to the ends.
 appDialog.querySelector('.app-settings-nav')!.addEventListener('keydown',event=>{const key=(event as KeyboardEvent).key;if(!['ArrowUp','ArrowDown','Home','End'].includes(key))return;event.preventDefault();
 const index=tabs.findIndex(tab=>tab.dataset.section===this.section);const next=key==='Home'?0:key==='End'?tabs.length-1:(index+(key==='ArrowDown'?1:tabs.length-1))%tabs.length;this.showSection(tabs[next].dataset.section!,true);});
 new OverlayScrollbar(appScroll,appDialog.querySelector<HTMLElement>('.app-settings-main')!);
 for(const id of ['application-settings','reading-settings'])$(id).removeAttribute('style');
 new OverlayScrollbar($('reading-settings').querySelector<HTMLElement>('.settings-body')!,$('reading-settings'));
 for(const button of document.querySelectorAll<HTMLButtonElement>('[data-close]'))button.onclick=()=>dialogElement(button.dataset.close!).close();
 // The floating drawer has margins on every side; a click anywhere outside it closes it.
 $('reading-settings').addEventListener('click',e=>{const d=dialogElement('reading-settings');if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();});
 document.querySelectorAll<HTMLButtonElement>('[data-setting-theme]').forEach(b=>{const palette=readingPalette(b.dataset.value!);b.style.backgroundColor=palette.paper;b.style.color=palette.text;b.onclick=()=>this.update(b.dataset.settingTheme as Group,{theme:b.dataset.value} as Values);});
 document.querySelectorAll<HTMLButtonElement>('[data-setting-background]').forEach(b=>b.onclick=()=>this.update('reading',{background:b.dataset.settingBackground as ReadingBackground}));
 document.querySelectorAll<HTMLInputElement>('[name=shell]').forEach(b=>b.onchange=()=>this.update('application',{shell:b.value as ApplicationSettings['shell']}));
 this.selectControls.set('bookOpeningAnimation',new SelectControl($<HTMLSelectElement>('app-book-opening')));
 $('app-book-opening').onchange=()=>this.update('application',{bookOpeningAnimation:$<HTMLSelectElement>('app-book-opening').value as ApplicationSettings['bookOpeningAnimation']});
 $('app-book-opening-enabled').onchange=()=>this.update('application',{bookOpeningEnabled:input('app-book-opening-enabled').checked});
 $('app-animations').onchange=()=>this.update('application',{animations:input('app-animations').checked});
 this.selectControls.set('agent',new SelectControl($<HTMLSelectElement>('app-agent')));
 $('app-agent').onchange=()=>{this.customChoice={model:false,effort:false};this.update('application',{agent:$<HTMLSelectElement>('app-agent').value as AgentChoice});this.loadAgentModels();};
 $('app-agent-detect').onclick=()=>this.detectAgents(true);
 this.selectControls.set('agent-model',new SelectControl($<HTMLSelectElement>('app-agent-model'),{placeholder:'搜索模型',count:n=>`${n} 个模型，输入名称缩小范围`,empty:'没有匹配的模型'}));
 this.selectControls.set('agent-effort',new SelectControl($<HTMLSelectElement>('app-agent-effort')));
 $('app-agent-model-refresh').onclick=()=>this.loadAgentModels(true);
 for(const kind of ['model','effort'] as const){
 $(`app-agent-${kind}`).onchange=()=>this.chooseAgentOption(kind);
 $(`app-agent-${kind}-custom`).onchange=()=>this.saveCustomOption(kind);
 $(`app-agent-${kind}-custom`).onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();this.saveCustomOption(kind);}};}
 document.querySelectorAll<HTMLInputElement>('[data-selection-action]').forEach(control=>control.onchange=()=>this.update('application',{selectionActions:{...this.value!.application.selectionActions,[control.dataset.selectionAction as SelectionAction]:control.checked}}));
 document.querySelectorAll<ReadingControl>('[data-reading]').forEach(control=>{const update=()=>{if(!control.checkValidity())return;const value=control instanceof HTMLInputElement&&control.type==='checkbox'?control.checked:['range','number'].includes(control.type)||control.dataset.reading==='fontWeight'?Number(control.value):control.value;if(control.dataset.reading==='fontFamily'&&!String(value).trim())return;this.update('reading',{[control.dataset.reading!]:value});};const event=control.type==='range'||control.type==='number'?'input':'change';control.addEventListener(event,update);});
 document.querySelectorAll<HTMLSelectElement>('select[data-reading]').forEach(control=>this.selectControls.set(control.dataset.reading!,new SelectControl(control,control.dataset.reading==='fontFamily')));
 // Immersive reading is a one-shot preset: each choice applies once and is not stored, so the
 // dropdown reopens on "保持现状" instead of contradicting the individual switches below it.
 this.selectControls.set('immersive',new SelectControl($<HTMLSelectElement>('setting-immersive')));
 $('setting-immersive').onchange=()=>this.applyImmersive($<HTMLSelectElement>('setting-immersive').value);
 $<HTMLFormElement>('dictionary-form').onsubmit=e=>{e.preventDefault();this.saveDictionary();};$('dictionary-cancel').onclick=()=>this.clearDictionary();$('reset-reading').onclick=()=>this.update('reading',structuredClone(this.defaults!.reading));
 }
 configure(data:Bootstrap){this.value=structuredClone(data.settings);this.confirmed=structuredClone(data.settings);this.defaults=data.defaults;$('data-path').textContent=data.dataPath;this.fonts=data.fonts||[];this.selectControls.get('fontFamily')!.setChoices(fontChoices(this.fonts,this.value.reading.fontFamily));this.sync();this.onChange(this.value);}
 update<G extends Group>(group:G,patch:NonNullable<SettingsPatch[G]>){const value=this.value!;const current=value[group] as unknown as Values;if(Object.entries(patch).every(([key,next])=>Object.is(current[key],next)))return;(value as unknown as Record<Group,Values>)[group]={...current,...patch};(this.pending as Record<Group,Values>)[group]={...this.pending[group],...patch};this.revision++;cancelAnimationFrame(this.updateFrame);this.updateFrame=requestAnimationFrame(()=>{this.updateFrame=0;this.sync();this.onChange(this.value!);});clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),250);}
 async flush():Promise<void>{clearTimeout(this.timer);if(this.updateFrame){cancelAnimationFrame(this.updateFrame);this.updateFrame=0;this.sync();this.onChange(this.value!);}if(!Object.keys(this.pending).length)return this.chain;const patch=this.pending;this.pending={};const revision=this.revision;this.chain=this.chain.then(async()=>{try{const result=await call<Settings>('settings',patch);this.confirmed=result;if(revision===this.revision){this.value=result;this.sync();this.onChange(result);}}catch(e){toast(errorMessage(e), "error");if(revision===this.revision){this.value=structuredClone(this.confirmed);this.sync();this.onChange(this.value!);}}});return this.chain;}
 /** Opens a settings dialog; application settings reopen on the last group unless one is named. */
 open(group:Group,section?:string){this.sync();if(group==='application'){
 this.returnFocus=document.activeElement;
 document.dispatchEvent(new Event('reader-dismiss-selection'));
 this.showSection(section??this.section);dialogElement('application-settings').showModal();this.placeIndicator(false);this.detectAgents();this.loadAgentModels();
 return;
 }$<HTMLSelectElement>('setting-immersive').value='keep';this.selectControls.get('immersive')!.sync();document.dispatchEvent(new Event('reader-dismiss-selection'));dialogElement('reading-settings').showModal();}
 // "只看正文" keeps the left sidebar available but tucked away: enabled and unpinned, so it hides
 // until the pointer reaches the left edge. (Older builds switched it off with showToc: false.)
 // "窗口内全屏" hides the title bar without leaving the window, the same as Alt + Enter.
 applyImmersive(choice:string){const titlebar=(hidden:boolean)=>call('titlebar',{hidden}).catch(error=>toast(errorMessage(error), "error"));
 if(choice==='text')this.update('reading',{showToolbar:false,showToc:true,tocPinned:false,showChapterTitle:false,showPagination:false,showProgress:false,showBookPages:false,fullBackground:true,fullWidth:true});
 else if(choice==='chrome'){this.update('reading',{showToolbar:true,showToc:true,showChapterTitle:true,showPagination:true,showProgress:true});if(document.body.dataset.titlebar==='hidden')titlebar(false);}
 else if(choice==='window')titlebar(true);}
 /** Shows one settings group: its tab is selected and the page starts from the top. */
 showSection(section:string,focus=false){const dialog=$('application-settings');if(!dialog.querySelector(`#app-section-${section}`))section='appearance';this.section=section;
 dialog.querySelectorAll<HTMLButtonElement>('.app-settings-tab').forEach(tab=>{const selected=tab.dataset.section===section;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();});
 dialog.querySelectorAll<HTMLElement>('.app-section').forEach(panel=>panel.hidden=panel.id!==`app-section-${section}`);$('application-settings-scroll').scrollTop=0;
 if((dialog as HTMLDialogElement).open)this.placeIndicator(true);}
 /** Moves the accent bar to the selected tab's left edge; it slides between tabs, as in the library sidebar. */
 placeIndicator(animate:boolean){const dialog=$('application-settings') as HTMLDialogElement;if(!dialog.open)return;
 const tab=dialog.querySelector<HTMLElement>('.app-settings-tab[aria-selected="true"]'),bar=dialog.querySelector<HTMLElement>('.app-settings-indicator');if(!tab||!bar)return;
 const transform=`translate(${tab.offsetLeft}px, ${tab.offsetTop+(tab.offsetHeight-bar.offsetHeight)/2}px) translateX(-50%)`;
 // The nav also resizes when a taller or shorter group is shown; that must not cut the slide short.
 if(bar.style.transform===transform)return;
 if(!animate)bar.style.transition='none';
 bar.style.transform=transform;
 if(!animate){void bar.offsetHeight;bar.style.removeProperty('transition');}}
 closeApplication(){if(dialogElement('application-settings').open)dialogElement('application-settings').close();}
 get applicationOpen():boolean{return dialogElement('application-settings').open;}
 sync(){if(!this.value)return;const a=this.value.application,r=this.value.reading as unknown as Values;const settings=this.value as unknown as Record<Group,Values>;
 // Texture samples are drawn on the current reading paper, as the page will show them.
 const paper=readingPalette(String(r.theme));document.querySelectorAll<HTMLButtonElement>('[data-setting-background]').forEach(b=>{b.setAttribute('aria-checked',String((r.background??'plain')===b.dataset.settingBackground));const sample=b.querySelector<HTMLElement>('.theme-texture-sample')!;sample.style.backgroundColor=paper.paper;sample.style.backgroundImage=backgroundImage(b.dataset.settingBackground,paper.dark,2.2);sample.style.setProperty('--swatch-text',paper.text);});document.querySelectorAll<HTMLButtonElement>('[data-setting-theme]').forEach(b=>{b.classList.toggle('selected',settings[b.dataset.settingTheme as Group].theme===b.dataset.value);const palette=readingPalette(b.dataset.value!);b.style.backgroundColor=palette.paper;b.style.color=palette.text;});document.querySelectorAll<HTMLInputElement>('[name=shell]').forEach(b=>b.checked=b.value===a.shell);input('app-animations').checked=a.animations;$<HTMLSelectElement>('app-book-opening').value=a.bookOpeningAnimation||'circles';input('app-book-opening-enabled').checked=a.bookOpeningEnabled??a.animations??true;$<HTMLSelectElement>('app-book-opening').disabled=!input('app-book-opening-enabled').checked;$<HTMLButtonElement>('app-book-opening-trigger').disabled=!input('app-book-opening-enabled').checked;if(!input('app-book-opening-enabled').checked)this.selectControls.get('bookOpeningAnimation')!.close(false);document.querySelectorAll<HTMLInputElement>('[data-selection-action]').forEach(i=>i.checked=a.selectionActions[i.dataset.selectionAction as SelectionAction]);for(const control of document.querySelectorAll<ReadingControl>('[data-reading]')){const key=control.dataset.reading!;if(control instanceof HTMLInputElement&&control.type==='checkbox')control.checked=Boolean(r[key]);else if(control instanceof HTMLInputElement&&control.type==='radio')control.checked=String(r[key])===control.value;else if(control.tagName==='SELECT'||document.activeElement!==control||control.id.startsWith('number-'))control.value=String(r[key]);}const reading=this.value.reading;input('setting-autoHideProgress').disabled=reading.showProgress===false&&(reading.showBookPages===false||reading.mode!=='paged');input('setting-width').disabled=Boolean(reading.fullWidth);input('number-width').disabled=Boolean(reading.fullWidth);const double=reading.mode==='paged'&&reading.layout==='double',effect=double?reading.doubleAnimation:reading.animation,turning=String(effect).startsWith('turn');$('setting-animation').closest<HTMLElement>('.setting-row')!.hidden=double;$('setting-doubleAnimation').closest<HTMLElement>('.setting-row')!.hidden=!double;document.querySelectorAll<HTMLInputElement>('[name=setting-layout]').forEach(i=>i.disabled=reading.mode!=='paged');for(const [key,off] of [['animationDuration',turning||effect==='none'],['turnDuration',!turning]] as const){input(`setting-${key}`).disabled=off;input(`number-${key}`).disabled=off;}for(const control of this.selectControls.values())control.sync();for(const range of document.querySelectorAll<HTMLInputElement>('.settings-body input[type=range]'))range.style.setProperty('--fill',`${(Number(range.value)-Number(range.min))/(Number(range.max)-Number(range.min))*100}%`);this.syncAgent();this.renderDictionaries();}
 /**
  * Model and reasoning effort belong to the chosen CLI. Each list offers the default, what the CLI
  * reports, a saved value it did not report, and 其他… for typing one. Efforts follow the chosen
  * model (or the CLI's default model). 自动选择 has no single CLI to configure.
  */
 syncAgent(){const a=this.value!.application,agent=a.agent||'auto',auto=agent==='auto';
 const state=auto?undefined:this.agentModels.get(agent),models=state?.models;
 const savedModel=auto?'':a.agentModels?.[agent]??'',savedEffort=auto?'':a.agentEfforts?.[agent]??'';
 const fallback=models?.find(m=>m.default),model=savedModel?models?.find(m=>m.id===savedModel):fallback;
 const modelChoices=[{value:'',label:fallback?`默认（${fallback.name}）`:'工具的默认模型'},...(models??[]).map(m=>({value:m.id,label:modelLabel(m)}))];
 const effortChoices=[{value:'',label:model?.defaultEffort?`默认（${effortNames[model.defaultEffort]??model.defaultEffort}）`:'模型的默认强度'},...(model?.efforts??[]).map(e=>({value:e,label:effortLabel(e)}))];
 this.syncAgentChoice('model',auto,modelChoices,savedModel,'其他模型…');
 this.syncAgentChoice('effort',auto,effortChoices,savedEffort,'其他强度…');
 $<HTMLButtonElement>('app-agent-model-refresh').disabled=auto||Boolean(state?.loading);
 const status=$('app-agent-model-status');
 status.textContent=auto?'自动选择时使用各工具的默认模型':state?.loading?'正在查询可用模型…':state?.error?`无法获取模型列表：${state.error}`:models?`共 ${models.length} 个可用模型`:'打开设置时查询该工具的可用模型';
 status.classList.toggle('agent-model-error',Boolean(!auto&&state?.error&&!state.loading));
 $('app-agent-effort-status').textContent=auto?'自动选择时使用各模型的默认强度':!model?'按模型的默认强度，也可手动指定':model.efforts.length?`${model.name} 支持 ${model.efforts.length} 档`:`${model.name} 不提供强度选项`;}
 /** One list-plus-other pair: the select, its 其他… row and that row's input. */
 syncAgentChoice(kind:'model'|'effort',auto:boolean,choices:{value:string;label:string}[],saved:string,other:string){
 const select=$<HTMLSelectElement>(`app-agent-${kind}`),control=this.selectControls.get(`agent-${kind}`)!,custom=input(`app-agent-${kind}-custom`);
 if(auto)choices=[{value:'',label:'先选择具体的工具'}];
 else{if(saved&&!choices.some(c=>c.value===saved))choices.push({value:saved,label:`${saved}（自定义）`});choices.push({value:CUSTOM_CHOICE,label:other});}
 control.setChoices(choices);select.value=this.customChoice[kind]&&!auto?CUSTOM_CHOICE:saved;control.sync();
 select.disabled=auto;$<HTMLButtonElement>(`app-agent-${kind}-trigger`).disabled=auto;if(auto)control.close(false);
 $(`app-agent-${kind}-custom-row`).hidden=auto||!this.customChoice[kind];if(document.activeElement!==custom)custom.value=saved;}
 /** Asks the chosen CLI for its models once per session; the refresh button asks again. */
 loadAgentModels(force=false){const agent=this.value?.application.agent||'auto';if(agent==='auto')return;const known=this.agentModels.get(agent);if(known?.loading||(known?.models&&!force))return;
 this.agentModels.set(agent,{...known,loading:true});this.syncAgent();
 call<{models:AgentModelInfo[]}>('agent.models',{agent}).then(result=>this.agentModels.set(agent,{models:result.models}),error=>this.agentModels.set(agent,{models:known?.models,error:errorMessage(error)})).finally(()=>this.syncAgent());}
 chooseAgentOption(kind:'model'|'effort'){const agent=this.value!.application.agent||'auto';if(agent==='auto')return;const value=$<HTMLSelectElement>(`app-agent-${kind}`).value;
 if(value===CUSTOM_CHOICE){this.customChoice[kind]=true;this.syncAgent();input(`app-agent-${kind}-custom`).focus();input(`app-agent-${kind}-custom`).select();return;}
 this.customChoice[kind]=false;this.saveAgentOption(agent,kind,value);}
 saveCustomOption(kind:'model'|'effort'){const a=this.value!.application,agent=a.agent||'auto';if(agent==='auto'||!this.customChoice[kind])return;const field=input(`app-agent-${kind}-custom`),value=field.value.trim();
 const [pattern,message]=kind==='model'?[agentModelPattern,'模型名称只能包含字母、数字和 . _ : / @ + - [ ]']:[agentEffortPattern,'思考强度只能包含字母、数字、_ 和 -'];
 if(!pattern.test(value)){toast(message,'error');field.value=(kind==='model'?a.agentModels:a.agentEfforts)?.[agent]??'';return;}
 this.customChoice[kind]=false;field.blur();this.saveAgentOption(agent,kind,value);this.syncAgent();}
 /** A new model drops a saved effort it is known not to accept. */
 saveAgentOption(agent:AgentId,kind:'model'|'effort',value:string){const a=this.value!.application;
 if(kind==='effort'){this.update('application',{agentEfforts:{...a.agentEfforts,[agent]:value}});return;}
 const models=this.agentModels.get(agent)?.models,model=value?models?.find(m=>m.id===value):models?.find(m=>m.default),effort=a.agentEfforts?.[agent]??'';
 const patch:Partial<ApplicationSettings>={agentModels:{...a.agentModels,[agent]:value}};
 if(effort&&model&&!model.efforts.includes(effort)){patch.agentEfforts={...a.agentEfforts,[agent]:''};this.customChoice.effort=false;}
 this.update('application',patch);}
 /**
  * Shows which agent CLIs this machine has. Detection runs each time the settings open and on
  * request; a manual check also retries model lists that failed, e.g. before a CLI was installed.
  */
 detectAgents(manual=false){const list=$('app-agent-status'),button=$<HTMLButtonElement>('app-agent-detect');if(button.disabled)return;
 if(manual||!list.childElementCount)list.innerHTML='<li><small>正在检测…</small></li>';button.disabled=true;
 if(manual)for(const [id,state] of this.agentModels)if(state.error&&!state.loading)this.agentModels.delete(id);
 call<Record<AgentId,{path:string}|null>>('agent.detect').then(found=>{list.replaceChildren(...agents.map(([id,name])=>{const item=document.createElement('li');item.dataset.found=String(Boolean(found[id]));item.innerHTML=`<span>${name}</span><small>${found[id]?`已找到 · ${escape(found[id]!.path)}`:'未找到'}</small>`;return item;}));},error=>{list.innerHTML=`<li><small>${escape(errorMessage(error))}</small></li>`;})
 .finally(()=>{button.disabled=false;if(manual){this.syncAgent();this.loadAgentModels();}});}
 renderDictionaries(){const dictionaries=this.value!.application.dictionaries;const signature=JSON.stringify(dictionaries);if(signature===this.dictionarySignature)return;this.dictionarySignature=signature;const root=$('dictionary-list');root.replaceChildren();for(const dictionary of dictionaries){const row=document.createElement('div');row.className='dictionary-row';row.innerHTML=`<label><input type="checkbox" ${dictionary.enabled?'checked':''}><span><strong>${escape(dictionary.name)}</strong><small>${escape(dictionary.url)}</small></span></label><button class="icon-button" aria-label="编辑 ${escape(dictionary.name)}">${icon('edit')}</button><button class="icon-button" aria-label="移除 ${escape(dictionary.name)}">${icon('delete')}</button>`;row.querySelector('input')!.onchange=e=>this.update('application',{dictionaries:this.value!.application.dictionaries.map(d=>d.id===dictionary.id?{...d,enabled:(e.target as HTMLInputElement).checked}:d)});const buttons=row.querySelectorAll('button');buttons[0].onclick=()=>{this.editingDictionary=dictionary.id;input('dictionary-name').value=dictionary.name;input('dictionary-url').value=dictionary.url;$('dictionary-submit').textContent='保存网站';$('dictionary-cancel').hidden=false;$('dictionary-name').focus();};buttons[1].onclick=()=>{this.update('application',{dictionaries:this.value!.application.dictionaries.filter(d=>d.id!==dictionary.id)});if(this.editingDictionary===dictionary.id)this.clearDictionary();};root.append(row);}}
 clearDictionary(){this.editingDictionary=null;$<HTMLFormElement>('dictionary-form').reset();$('dictionary-submit').textContent='添加网站';$('dictionary-cancel').hidden=true;$('dictionary-error').hidden=true;}
 saveDictionary(){try{const name=input('dictionary-name').value.trim(),url=input('dictionary-url').value.trim(),parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||!url.includes('{text}')||parsed.username||parsed.password)throw new Error('请输入包含 {text} 的 HTTP/HTTPS 地址。');if(!name)throw new Error('请填写网站名称。');const dictionaries:Dictionary[]=this.value!.application.dictionaries.map(d=>({...d}));if(this.editingDictionary){const index=dictionaries.findIndex(d=>d.id===this.editingDictionary);dictionaries[index]={...dictionaries[index],name,url};}else{if(dictionaries.length>=12)throw new Error('最多添加 12 个查词网站。');dictionaries.push({id:crypto.randomUUID(),name,url,enabled:true});}this.update('application',{dictionaries});this.clearDictionary();}catch(e){$('dictionary-error').textContent=errorMessage(e);$('dictionary-error').hidden=false;}}
}
