# 笔记文件格式

`.drnotes` 是 UTF-8 JSON 文件，默认不带 BOM，导入也接受 UTF-8 BOM。它是笔记、标注与 AI 问书对话的往返交换格式；Markdown 保留为可读导出（对话附在「AI 问书」一节，回答中的标题降为四级），不参与导入。现有 SQLite 数据库无需迁移。

## 版本 1

```json
{
  "type": "dr-reader-notes",
  "version": 1,
  "exportedAt": 1792800000,
  "book": {
    "id": "0123456789abcdef",
    "title": "示例图书",
    "author": "作者",
    "chapters": ["OPS/chapter.xhtml"]
  },
  "annotations": [
    {
      "id": "a1b2c3d4e5f678901234567890abcdef",
      "bookId": "0123456789abcdef",
      "chapter": 0,
      "href": "OPS/chapter.xhtml",
      "start": 0,
      "end": 4,
      "quote": "一段摘录",
      "prefix": "",
      "suffix": "之后的正文",
      "note": "我的想法",
      "color": "#ddedea",
      "style": "highlight",
      "createdAt": 1792700000,
      "updatedAt": 1792800000
    }
  ],
  "conversations": [
    {
      "id": "6f1c2c1e-4b5a-4d8e-9f00-1a2b3c4d5e6f",
      "bookId": "0123456789abcdef",
      "title": "这句话想表达什么？",
      "createdAt": 1792700000,
      "updatedAt": 1792800000,
      "messages": [
        { "role": "user", "text": "这句话想表达什么？", "quote": "一段摘录", "agent": "", "label": "", "model": "", "effort": "", "stopped": false, "createdAt": 1792700000 },
        { "role": "assistant", "text": "**要点**：……", "quote": "", "agent": "claude", "label": "Claude Code", "model": "opus", "effort": "high", "stopped": false, "createdAt": 1792700000 }
      ]
    }
  ]
}
```

- `book.id` 是本项目对原始 EPUB 字节计算的现有内容 ID；书名和作者仅用于描述，不用于猜测匹配。另一书库导入同一原文件后仍有相同 ID。
- `book.chapters` 是按阅读顺序排列的已拆章资源路径。导入必须与目标书库的章节布局完全一致，避免拆章规则变化后错绑位置。
- `chapter` 从 0 开始；`href` 必须属于该章。`start`、`end` 为正文扫描器的 UTF-16 单位偏移，结束位置不包含在选区内；`quote`、`prefix`、`suffix` 保留原文和上下文，供现有阅读器定位恢复。
- `style` 为 `highlight`、`underline` 或 `note`；颜色为原有五种颜色名称或小写 `#rrggbb`。笔记正文保留换行、Unicode 和特殊符号。
- 时间为 Unix 秒数，创建/修改时间必须非负，修改时间不得早于创建时间，最大为 `253402300799`。恢复后不重写这些时间。
- `conversations` 可省略：没有对话的书不写这个字段，早期版本导入时忽略它，所以仍是版本 1。对话 ID 由字母、数字和 `-` 组成（最长 64）；`role` 为 `user` 或 `assistant`；`quote` 是提问时附带的选中文字；回答记录工具（`codex`、`claude`、`opencode` 或空）、显示名、模型、思考强度，`stopped` 表示回答被中途停止。每段对话 1～2000 条消息，正文合计不超过 8 MiB。
- 不包含书签、阅读进度、分类或 EPUB 正文；导入不会修改这些数据。

## 合并与校验

按标注 ID 进行追加合并，已有 ID 保留本地记录，包含本地修改；备份不会恢复覆盖操作或删除操作。同一批次中重复的 ID 也只保留第一条。与其他书籍的 ID 冲突时拒绝导入。

导入先检查文件版本、图书 ID、章节布局、字段类型及位置，再在 SQLite 事务中检查并保存记录。重复记录也必须通过校验。任何一条失败则整批回滚。返回 `imported`（新增数）和 `skipped`（已有 ID 数）；空列表返回两个 0。带 `conversations` 的备份另外返回 `conversationsImported` 与 `conversationsSkipped`；对话同样按 ID 追加，已有对话（含本地后续追问）不被覆盖，并与标注在同一事务中保存。未知字段忽略，未知版本拒绝。

文件上限为 32 MiB、10000 条标注和 32 层 JSON 嵌套；选区长度、笔记长度、上下文长度等沿用普通标注保存的限制。

## 设计参考

查阅了 calibre（GPL v3）的 `src/calibre/gui2/viewer/highlights.py` 中 `Export.exported_data`、`src/calibre/db/annotations.py` 中 `merge_annot_lists` / `merge_annots_with_identical_field`，以及 `src/calibre/db/tests/writing.py` 中 `test_annotations`。也检索了维护中的 [calibre 官方仓库](https://github.com/kovidgoyal/calibre)及其[标注导出实现](https://github.com/kovidgoyal/calibre/blob/master/src/calibre/gui2/viewer/highlights.py)。

参考其版本化 JSON 容器、稳定标注 ID 与合并边界的设计。本项目独立使用 C++、现有 JSON 库、SQLite 事务及现有 UTF-16 文字锚点实现，不复制 GPL 源码，也不依赖 calibre。calibre 按时间选择同 ID 的记录，本项目为保护本地修改采用保留已有记录的合并策略；两种文件格式不互通。
