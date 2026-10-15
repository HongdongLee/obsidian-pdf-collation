# Obsidian PDF Collation (双轨校勘)

将 Markdown 笔记与 PDF 原件并排对照的 Obsidian 插件。无论你手头只有一份刚下载的 `.pdf`，还是用 MinerU、Marker、Doc2X 跑完 OCR 的粗稿，或是正在做逐页引文核查与古籍校勘，都能直接上手。

Side-by-side Markdown & PDF collation plugin for Obsidian. Features zero-config pairing, one-click PDF-to-Markdown draft extraction, fault-tolerant bidirectional text selection highlighting, synchronized page scrolling, and inline page-block editing.

---

## Web Demo / 浏览器体验版

一个无需安装 Obsidian 的本地优先体验站，现已同步 **v0.1.3**：可双栏阅读 PDF 与 Markdown、双向划选定位、生成校勘底稿、自动分页和下载改订稿。阅读时以距顶部 **35% 的基准线**定位当前页，双栏按页内比例连续跟随；划选结合前后文和实际页码消歧，高亮在滚动、缩放后保持对齐。

默认含十二页示例文献，也支持本地导入自己的文件。「更多 → 新手教程」提供五步引导和真实的双向选择、阅读联动与高亮保持演示，可直接核验新版行为。

[**在线体验 Collatio Web Demo**](https://hongdonglee.github.io/obsidian-pdf-collation/)

![PDF Collation Web Demo](web-demo/docs/desktop.png)

```bash
cd web-demo
npm install
npm run dev
```

更多说明请见 [Web Demo README](web-demo/README.md)。演示通过 GitHub Pages 提供访问，文献在浏览器本地处理，不会上传文件或修改 Obsidian Vault。

---

## 30 秒零配置上手

甚至不需要提前准备 `.md` 文件，也不需要手写 YAML 路径、手动打页标或预先清洗 OCR 错字。

1. **只有 PDF 也能直接用（免准备 MD 文件）**
   - 手头只有一份 `.pdf`、完全没有 `.md` 笔记时，直接在左侧文件树右键该 `.pdf` 点击 **「在双轨校勘视图中打开 (从 PDF 生成校勘底稿)」**（或打开 PDF 后点击左侧边栏的双轨校勘图标）。
   - 插件会自动提取 PDF 各页文字层、合并碎裂断行并按首行缩进与标题序号智能分段，当场生成带 `[pdf. 1]`、`[pdf. 2]` 页标的同名 `.md` 校勘底稿并排打开。
2. **已有 MD 时自动配对 PDF（免写路径）**
   - 把 `论文.md` 和 `论文.pdf` 改成同名放在同一目录（或 `PDF/`、`pdfs/`、`assets/`、`原始PDF/` 子目录），打开双轨视图即自动配对。
   - 文件名不同也没关系，点击视图顶部的 **「绑定 PDF」** 按钮，弹窗搜索全库 PDF 回车即可绑定。
3. **无页标也能双向划选高亮，或一键自动按 PDF 分页（免手打页标）**
   - 就算是一篇没有任何页码标记的普通 Markdown，在左栏用鼠标划选任意一句话，右侧 PDF 会自动检索全篇、跳到对应页并画上黄色高亮框；反过来在右侧 PDF 划选句子，左侧 Markdown 也会自动滚动到对应段落并高亮文字。
   - 想把一篇纯文本裸稿变成按页联动的校勘本时，直接点击吸顶栏右上角的 **「⚡ 自动按 PDF 分页」** 按钮（或运行命令面板中的 `根据配对 PDF 自动插入页标`），插件会自动读取右侧 PDF 各页文字层并在对应段落前插好 `[pdf. 1]`、`[pdf. 2]` 页标。
4. **容忍 OCR 脏稿与人工改字（免预先清洗）**
   - 内置五级容错匹配算法，自动抹平中英文空格、连字符断行、全半角标点与弯直引号差异。
   - 就算句子中间有 OCR 错别字、跨页断句，或者你已经加入了 `［校按：...］` 注记与 `[^1]` 脚注，依然能靠前后文锚点精准对齐原文。

## 四档渐进用法

你可以按手头文献的精细程度，随时停留在最省事的一档。

| 阶段 | 你手头有什么 | 需要做什么 | 解锁的体验 |
| :--- | :--- | :--- | :--- |
| **0. 纯 PDF 裸开** | 只有一份 `.pdf`，没有 `.md` | 右键该 PDF 选「在双轨校勘视图中打开」 | 自动提取文字层、智能分段并生成带 `[pdf. N]` 页标的同名 `.md` 校勘底稿 |
| **1. 随手通读** | 一篇普通 Markdown + 一份 PDF | 点顶部「绑定 PDF」或同名放置；也可点「⚡ 自动按 PDF 分页」 | 双向划选文字跨全书定位高亮，或一键自动插好全文页标 |
| **2. OCR 直出对照** | Marker / MinerU / Doc2X 导出的带分页符初稿 | 保留工具自带的 `<!-- page 12 -->`、`--- page 12 ---` 或 `{12}----` | 自动按页切块、左右滚动双向同步翻页、单页就地改字 (`⌘S` 写回) |
| **3. 学术与古籍精校** | 需要区分「原书印刷页码」与「PDF 物理页码」的定本 | 使用 `[p. 33 / pdf. 35]` 双页标，或用 `[p. 33]` 搭配 frontmatter `pdf_offset: 2` | 吸顶栏同时显示原书页码与 PDF 页码，严格锁页消歧，引文核查零误差 |

### 原生兼容的页标格式

无需手动转换成单一格式，以下写法独占一行时均会自动识别为分页锚点

- **OCR 工具默认分隔符** `<!-- page 35 -->`、`<!-- pdf: 35 -->`、`--- page 35 ---`、`{35}------------------------------------------------`
- **单轨页标** `[pdf. 35]` 或 `[p. 33]`（可在笔记属性设置 `pdf_offset` 自动换算差值）
- **双轨校勘页标** `[p. 33 / pdf. 35]` 或罗马数字前言页 `[p. iv / pdf. 8]`
- **自定义格式** 在插件设置中填入带捕获组 `(\d+)` 的正则表达式即可适配任意私有页标。

## 安装方式

### 方式一：通过 BRAT 一键安装（推荐普通用户）

1. 在 Obsidian 社区插件市场搜索并安装 **BRAT**。
2. 打开 BRAT 设置，点击 **Add Beta plugin**。
3. 填入本仓库地址 `https://github.com/HongdongLee/obsidian-pdf-collation`，点击 **Add Plugin** 并启用。

### 方式二：从 GitHub Release 下载安装

1. 前往本仓库右侧的 **Releases** 页面，下载最新版本的 `main.js`、`manifest.json`、`styles.css` 三个文件。
2. 将它们放入你的 Obsidian 库目录 `<你的库目录>/.obsidian/plugins/pdf-collation/` 下。
3. 在 Obsidian「设置 -> 第三方插件」中刷新并启用 **PDF Collation (双轨校勘)**。

### 方式三：源码构建（开发者）

请使用 Node.js 22.18 或更新版本。

```bash
git clone https://github.com/HongdongLee/obsidian-pdf-collation.git
cd obsidian-pdf-collation
npm install
npm run build
VAULT_PATH="/path/to/your/vault" npm run install-vault
```

---

## English Overview

**PDF Collation** brings a dedicated dual-pane workspace to Obsidian for researchers, translators, and digital humanities scholars who work with PDFs and OCR-generated Markdown notes.

### Key Features

- **Start from a Standalone PDF (Zero Markdown Required)** Right-click any `.pdf` file and select *Open in PDF Collation*. If no paired `.md` note exists yet, the plugin extracts the PDF text layer, reconstructs natural paragraphs from baseline coordinates, and generates a paginated `.md` draft (`[pdf. 1]`, `[pdf. 2]`, ...) automatically.
- **Bidirectional Character-Level Highlight Sync** Select any phrase in the Markdown pane to jump to and highlight the exact characters on the PDF canvas (and vice versa), powered by a 5-tier fault-tolerant matcher that normalizes spaces, hyphens, quotes, editorial notes (`［校按：...］`), and OCR typos.
- **One-Click Auto-Pagination** Have an unpaginated Markdown note? Click **⚡ Auto-paginate from PDF** (`auto-paginate-from-pdf`) to match PDF page boundaries against your Markdown paragraphs in one click.
- **In-Place Page Block Editing** Click **✎ Edit Page** (or `Option`/`Alt` + double-click any paragraph) to fix OCR typos inline and save with `⌘S` / `Ctrl+S` without losing your scroll position or frontmatter.

## 使用限制

- 从 PDF 生成 Markdown 依赖 PDF 自带的文字层；纯扫描图片 PDF 需要先运行 OCR。
- 自动分页和容错高亮使用文本匹配，对复杂版式、严重 OCR 错误或重复段落仍需人工核对。
- 当前为 `0.1.3`，要求 Obsidian 1.13.7 或更新版本。建议在批量分页或修改重要文献前备份笔记。

## Privacy and access

The plugin processes Markdown and PDF files locally within your Obsidian vault. It does not use external services, send document contents to a server, collect telemetry, display ads, or require an account or payment. It uses the PDF renderer bundled with Obsidian and does not install dependencies at runtime. Note rendering uses Obsidian's Markdown renderer, so remote embeds in your own notes follow Obsidian's normal behavior.

To find matching notes and show the PDF picker, the plugin enumerates vault file paths locally. Binding a PDF updates the selected note's frontmatter. Generating a draft creates a Markdown file in the vault; auto-pagination and page-block edits update the selected Markdown file when you invoke those actions.

## License

MIT License
