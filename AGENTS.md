# 项目协作规则

## calibre 参考要求

- 处理 EPUB 导入、解析、字符编码、HTML/XML 实体、目录、拆章及阅读渲染兼容性问题时，必须先查阅成熟项目 `C:/Users/suxiaofan/EDisk/CppCodes/RefProjects/calibre` 中对应的实现与测试，理解其处理顺序和边界，再确定本项目的方案。
- 采用参考策略时，在代码注释、提交说明或工作说明中指出具体参考文件或函数，并说明本项目如何独立实现。不要仅针对某一本书做字面替换。
- 参考 calibre 的处理思路，独立实现；不要直接复制其 GPL 源码，也不要使本地 calibre 安装或源码成为本项目的运行时依赖。
- 用触发问题的原书在独立测试书库中复现并验证，同时补充相关回归测试。原始 EPUB 保持只读；处理已导入内容时保留阅读进度、分类和笔记，不通过删除图书来规避缓存或迁移问题。

实体处理可参考 `src/calibre/ebooks/oeb/parse_utils.py` 的 `parse_html`、`src/calibre/__init__.py` 的 `xml_replace_entities`：在 XML 解析前把 HTML 命名实体转换成 XML 可处理的形式，避免序列化后变成字面文本，并避免重复解码已转义的正文。
