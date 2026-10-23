# DR Reader

Windows 本地 EPUB 阅读器。C++20 + Win32 / Direct2D / DirectWrite + WebView2，不使用 Electron、Node.js 运行时或 Python 解析 EPUB。

## 运行

已经构建的程序：`build/bin/Release/dr-reader.exe`。保持同目录下的 `web/` 和 `resources/` 一起使用。首次启动会添加原创示例书《给阅读留一盏灯》；通过“添加图书”导入自己的无 DRM EPUB，支持多选。

```powershell
./build/bin/Release/dr-reader.exe
./build/bin/Release/dr-reader.exe "D:/Books/example.epub"
./build/bin/Release/dr-reader.exe --shell direct2d
./build/bin/Release/dr-reader.exe --shell mica --data-dir "D:/ReaderData"
```

窗口外壳也可以在设置中即时切换。系统云母使用 Windows 11 22H2+ 的 DWM backdrop；旧版 Windows 自动使用标准原生标题栏。自绘外壳使用 Direct2D/DirectWrite，保留原生移动、缩放、最大化和系统贴靠交互。

## 构建

需要 Windows 10/11、Visual Studio 2022 或更新版的“使用 C++ 的桌面开发”工具链、Windows SDK、CMake 3.25+、Node.js 22.18+、pnpm 12 和 WebView2 Evergreen Runtime。C++ 依赖由 CMake 下载固定版本，前端依赖由 pnpm 锁文件固定；首次配置需要联网，不需要 vcpkg。

```powershell
pnpm install --frozen-lockfile
cmake -S . -B build -A x64
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
pnpm test
pnpm test:browser
```

前端采用 Vite + TypeScript 渐进迁移，现有阅读器保留轻量 DOM 实现，新图标、字体选择、下拉组件、设置比较与章节缓存使用严格类型检查。CMake 在前端源码变化时自动运行 `pnpm build`，将 `dist/` 打包产物复制到程序的 `web/` 目录；安装与便携打包也使用该产物，运行时无需 Node.js。

`pnpm dev` 用于样式开发与热更新；书库、SQLite 和系统字体枚举仍由桌面程序提供。`pnpm test:browser` 使用本机 Edge 的独立无界面进程测试源码和生产包，结果与截图保存到 `build/browser-tests/`，不会使用日常浏览器配置。可通过 `DR_EDGE_PATH` 指定 Chromium/Edge 路径。

也可以运行 `./scripts/build.ps1`；`CMakePresets.json` 的预设对应本机 Visual Studio 2026，使用 VS 2022 时执行上面的通用命令或向脚本传 `-Generator 'Visual Studio 17 2022'`。

生成便携目录：

```powershell
./scripts/package.ps1
```

## 当前功能

- 书架网格/列表、封面、书名/作者搜索、排序、作者筛选、最近阅读、未读/已读筛选。图书右键菜单支持打开阅读、导出 Markdown 笔记与标注、通过二级菜单添加至分类（含新建分类）。支持确认后删除图书及其阅读数据，保留原始 EPUB 文件。
- C++ 后台导入：ZIP 解包、OPF 元数据、spine 阅读顺序、EPUB 3 nav / EPUB 2 NCX、封面与章节缓存。
- C++ XHTML 拆分：保持 DOM 祖先和 head，分页标记、256 KiB 内容预算、锚点归属、跨章节链接与目录重映射。
- WebView2 正文排版：目录、上下滚动/左右翻页、章节内锚点，以及字体、字号、字重、行距、段距、字距、首行缩进、对齐、正文宽度、页面留白、原书样式开关和明亮/纸张/夜间主题。
- 应用设置与阅读设置分开：应用设置控制界面主题、标题栏外壳、动画、选词菜单和自定义查词网站；阅读设置只影响正文。
- SQLite 笔记与高亮：五色高亮、下划线、笔记编辑/删除、标注列表，以及重排后用文本锚点恢复位置。旧 JSON 书签会迁移到 `reader.sqlite3`。
- 选中文字菜单：高亮、下划线、记笔记、复制、书内搜索和默认浏览器查词。复制和查词由 C++ 原生接口完成。
- 开书入场、平移 / 覆盖 / 淡入淡出，以及基于 [StPageFlip](https://github.com/Nodlik/StPageFlip) 的软纸卷页（滚轮或点击位于页面上半/下半时分别从上角/下角卷起）和硬纸翻页；动画只受应用动画开关控制。
- 左右翻页可选单页或双页布局：双页时每屏左右两页、中间有书脊阴影，窗口窄于 640px 自动回到单页；双页只提供无动画和 StPageFlip 的书本式软纸 / 硬纸翻页。
- 阅读设置可分别隐藏工具栏、目录、章节标题、翻页栏和进度条，也可一键“只看正文”。背景铺满、正文铺满与上/下/左/右留白独立设置，旧的左右/上下留白会保留并迁移。
- 平移使用整页同步移出/移入；单页仿真翻页保留当前排版、字体和高亮，左右点击区域支持翻页，拖动选中文字、链接和标注操作不会触发翻页。
- 本地进度恢复、继续阅读、书签、C++ 书内搜索（每章返回第一处匹配，最多 100 章）。
- 系统云母 / Direct2D 自绘两种原生标题栏，支持 DPI 缩放。

快捷键：`Ctrl+O` 导入，`Ctrl+K` 搜索书库，阅读时 `Ctrl+F` 搜索正文，左右方向键 / PageUp / PageDown 翻页，`F8` 打开阅读设置，`Alt+Enter` 隐藏 / 显示标题栏（窗口大小、位置和正文位置不变，保留阴影、圆角、贴靠和两侧及底边调整大小；无标题栏时用 Win+方向键或 Alt+空格移动窗口），`F11` 切换全屏。`Esc` 优先关闭弹层或退出全屏，再返回书库。隐藏工具栏后，点击正文中央或移到顶部可临时显示书库、阅读设置和退出全屏入口。

## 代码结构

```text
app/          应用组合、COM 生命周期、WebView2 宿主、消息桥、串行后台任务
ui/           不依赖业务的 Win32 / Direct2D / DirectWrite 窗口外壳
engine/       不依赖 WebView2 的 C++ EPUB、DOM 拆分、书库、检索、SQLite 标注与设置
web/          JS/TypeScript 书架和阅读器；Vite 入口与严格类型的通用组件
dist/         Vite 生成的部署静态资源（不提交）
resources/    可再分发的原创示例 EPUB
tests/        C++ 集成测试，运行时生成 EPUB / 恶意 ZIP 测试夹具
tools/        无界面 EPUB 导入检查工具 dr-epub
scripts/      本地构建、示例书生成
docs/         架构、拆分策略与验证记录
```

参考 MSIME-Windows 的 `ui/` 与业务分层、设置窗口 caption hit-test 和 DPI 处理方式；界面布局参考本机 Neat Reader 与 Starrea。此项目独立构建，不依赖它们的源码或安装目录。

## 存储

默认在 `%LOCALAPPDATA%/DRReader`，可用 `--data-dir` 指定独立目录。从带包标识的应用启动时，Windows 可能重定向到该包的 LocalCache；设置底部会显示实际书库路径。

```text
config.toml                    应用设置、阅读设置、排序规则与启动窗口比例
reader.sqlite3                 SQLite 标注、笔记与书签
books/<content-id>/book.json   元数据、目录与阅读进度
books/<content-id>/content/    解包资源、拆分后的 XHTML
books/<content-id>/search/     C++ 提取的每节纯文本
webview-profile/              WebView2 用户数据
```

原始 EPUB 不会被修改。导入先写 staging，成功后整体发布；失败清理临时内容。书库元数据和进度使用 JSON 文件，设置统一使用 TOML；标注、笔记和书签使用 WAL 模式的 SQLite。旧版书签会在首次读取书籍时自动迁移。旧 `settings.json` 会在首次启动时迁移为 `config.toml`，并保留旧文件作为备份；迁移后只读写 `config.toml`。关闭应用后可直接编辑该文件，`[window]` 的 `widthRatio = 0.6` 和 `heightRatio = 0.75` 分别控制启动窗口占当前屏幕的宽高比例，`[application]` 的 `librarySort` 支持 `added`、`read`、`title`、`author`。

## 当前边界

当前针对无 DRM、可重排 EPUB。尚未实现 PDF、漫画/固定版式、竖排/RTL 分页、云同步与自定义分类。分页位置采用“章节 + 相对位置”，改变字号后恢复到附近位置，不是 EPUB CFI。标注使用 UTF-16 文本偏移和前后文重定位，适合正常重排；跨多个不同结构节点的复杂选区仍可能无法稳定恢复。

拆分参考 calibre 的处理思路，独立用 C++ 实现，**不是 calibre 转换管线的等价移植**。支持内联分页声明、嵌入/直接链接 CSS 中的标签、类、ID 和后代选择器；尚无完整 CSS cascade、复杂选择器、`@import`、预处理清洗和损坏 HTML 修复。巨型段落、表格、SVG、pre 等保持完整并产生提示；256 KiB 是内容预算，不是含 head 的最终文档硬上限。字体混淆暂不解码；解析到明确 DRM 时拒绝导入。

书籍脚本被移除并在 sandbox iframe 内禁用；原生消息只接受应用主页的请求。资源从本地虚拟主机提供，不启动 HTTP 服务器。细节见 [架构说明](docs/architecture.md)。

第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

感谢 [xianyukang/MyKeymap](https://github.com/xianyukang/MyKeymap)。本项目的开书动画参考了其 `examples/SoundControlAnimation/main.cpp` 中的五层彩色圆环效果，并使用 Canvas 2D 在应用内重现展开、旋转和缩小淡出动画。
