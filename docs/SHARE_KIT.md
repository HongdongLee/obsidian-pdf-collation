# PDF Collation · 社区分享素材 / Launch kit

这份素材用于介绍 [PDF Collation](https://github.com/HongdongLee/obsidian-pdf-collation)。欢迎按不同社区的惯例改写、提供演示和回应真实问题；不要批量刷屏或宣称尚未实现的功能。

- 代码仓库：https://github.com/HongdongLee/obsidian-pdf-collation
- 无需安装的在线体验：https://hongdonglee.github.io/obsidian-pdf-collation/
- 发布页：https://github.com/HongdongLee/obsidian-pdf-collation/releases/latest
- 反馈入口：https://github.com/HongdongLee/obsidian-pdf-collation/issues

## 一句话介绍

**中文：** 一个免费开源的 Obsidian 插件，让 PDF 原文与 Markdown 笔记并排对照：双向划选定位、自动分页、OCR 底稿编辑；可先在浏览器中体验。

**English:** An open-source Obsidian plugin for side-by-side PDF and Markdown collation, with bidirectional selection highlighting, auto-pagination, and editable OCR drafts. Try the browser demo without installing anything.

## 中文：科研与知识管理社区

**标题建议：** 查论文原文总是来回翻页？我做了一个 PDF × Markdown 双轨校勘插件

我在用 Obsidian 整理文献时，经常需要从笔记里的引文找回 PDF 原句，或者从 PDF 里查对应的 Markdown 底稿。于是做了 PDF Collation：让两边并排显示，并在划选句子后跳转和高亮对应位置。

目前支持 PDF 生成分页 Markdown 底稿、已有笔记自动配对、双向划选定位、自动分页，以及页块就地编辑。整个插件本地处理，无须上传文档。纯扫描 PDF 需要先跑 OCR；复杂排版及 OCR 错字仍然需要人工核查。

不用安装 Obsidian 也可以先试浏览器演示：[在线体验](https://hongdonglee.github.io/obsidian-pdf-collation/)。源码按 MIT 协议开放：[GitHub](https://github.com/HongdongLee/obsidian-pdf-collation)。欢迎反馈最影响实际校勘体验的问题。

## 中文：开发者社区

**标题建议：** [开源自荐] Obsidian PDF × Markdown 双轨校勘：双向高亮、自动分页与 OCR 底稿修订

开源了一个 Obsidian 插件 PDF Collation（TypeScript，MIT）。核心问题是：Markdown 与 PDF 不总是逐字一致，尤其在 OCR 错字、断行、标点变化和人工加注之后，如何仍然找到原文对应位置。

现在可以在两端划选文本进行相互定位，也能从带文字层的 PDF 生成分页 Markdown，或给已有笔记自动插页标。仓库里还附了一个无需安装 Obsidian 的 Web Demo，便于先体验核心交互。

- Demo：https://hongdonglee.github.io/obsidian-pdf-collation/
- Repo：https://github.com/HongdongLee/obsidian-pdf-collation
- 已知限制：扫描件需要先 OCR，复杂排版和重复段落仍应人工核验。

欢迎提交 Issue 或讨论边界情况。

## English: Obsidian Forum / international communities

**Suggested title:** PDF Collation — jump between selected text in PDF originals and Markdown notes

Hi! I built an open-source Obsidian plugin for a workflow I kept repeating while reading academic PDFs: checking passages in a Markdown draft against the PDF original.

PDF Collation gives you a side-by-side view, bidirectional text-selection highlighting, auto-pagination, and inline editing of paginated drafts. It can generate a Markdown draft from a PDF with an extractable text layer, or pair an existing note with its source PDF.

There's a [browser demo](https://hongdonglee.github.io/obsidian-pdf-collation/) so you can try the interaction without installing anything. Source and installation instructions are on [GitHub](https://github.com/HongdongLee/obsidian-pdf-collation). It is free, MIT-licensed, and processes files locally. Image-only scans need OCR first, and tricky layouts still require manual verification.

I'd especially appreciate feedback from researchers, translators, and anyone maintaining OCR-corrected notes.

## 20–30 秒录屏脚本

1. **0–4 秒：** PDF 和 Markdown 左右并排，字幕：「读论文时，如何快速核对原文？」
2. **4–12 秒：** 在 Markdown 划选短句，镜头呈现 PDF 跳转和黄色高亮。
3. **12–19 秒：** 在 PDF 中反向划选，Markdown 自动定位。
4. **19–25 秒：** 展示分页底稿编辑或自动分页（只展示在当前版本中确实可复现的功能）。
5. **25–30 秒：** 显示在线体验地址与 GitHub 仓库地址；不要求用户安装才能看懂效果。

建议演示内容来自项目示例文档或有授权的公开材料，不要展示个人笔记、未公开文献或隐私信息。

## 发布前核对

- 在线演示能正常打开；README 的截图与当前界面一致。
- 最新 Release 的三个安装文件齐全。
- 说明这是早期版本，避免承诺零误差或把 Web Demo 等同于完整插件。
- 遵循社区自荐规则；依据用户反馈改进，不发布重复灌水内容。
