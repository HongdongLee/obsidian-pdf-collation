# Obsidian PDF Collation (双轨校勘)

将整篇 Markdown 校订稿与 PDF 原件并排对照的 Obsidian 插件。面向使用 MinerU、Marker、Doc2X 或大模型 OCR 将文献转写为 Markdown 后，需要在库内长期精读、核查引文页码与随手修字的学术及古籍校勘用户。

## 核心能力

1. **零坐标污染的双向定位**
   - 正文无需插入脆弱的 `selection=x,y` 字符偏移链，仅靠轻量页标（如 `[p. 33 / pdf. 35]`、`[pdf. 35]`、`<!-- page 35 -->`、`--- page 35 ---`）切分页块。
   - 在 Markdown 栏划选任意文字，右侧 PDF 自动跳到对应页，并通过文本归一化算法（抹平空格、连字符、弯直引号差异）在 PDF 画布上动态画框高亮。
   - 在 PDF 文字层划选任意句子，左侧 Markdown 自动反向滚动定位到对应页块。
2. **页块级就地改字**
   - 对照发现 OCR 错字时，点击该页块右上角的 `✎ 校改本段`，直接在当前双栏内打开内联编辑框，按 `⌘S` / `Ctrl+S` 即可写回原文件（完整保留 YAML frontmatter 与其余段落），右侧 PDF 视口保持不动。
3. **通用 PDF 配对规则**
   - 优先读取笔记 frontmatter 中的 `pdf`、`source_pdf`、`annotation-target`、`file` 字段（支持 `[[xxx.pdf]]` 或相对路径）。
   - 未显式配置时，自动在同级目录及 `原始PDF/`、`PDF/`、`pdfs/`、`assets/` 子目录中寻找同名 `.pdf`。
   - 支持在视图顶部一键模糊搜索库内 PDF 并写入 frontmatter 绑定。

## 构建与安装

```bash
cd /Users/lihaodong/project/obsidian-pdf-collation
npm install
npm run build          # 运行 typecheck + eslint + 单元测试，并打包生成 main.js
npm run install-vault  # 一键构建并复制 main.js / manifest.json / styles.css 到本地 Obsidian 库
```

如需安装到其他 Obsidian 库：

```bash
VAULT_PATH="/path/to/your/vault" npm run install-vault
```
