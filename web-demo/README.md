# Collatio — PDF ↔ Markdown Web Demo

这是 [Obsidian PDF Collation](https://github.com/HongdongLee/obsidian-pdf-collation) 的独立浏览器体验版，可在不安装 Obsidian 的情况下体验真实的双轨对勘功能。

当前演示同步 **v0.1.3**，包含阅读基准线、页内比例连续联动、上下文消歧，以及滚动、缩放后的高亮保持。页面版本直接读取仓库根目录的 `manifest.json`。

[**打开在线演示**](https://hongdonglee.github.io/obsidian-pdf-collation/)

![专注双轨阅读工作台](docs/desktop.png)

## 运行

需要 Node.js 22.18+。

```bash
cd web-demo
npm install
npm run dev
```

打开终端给出的本地地址（通常为 `http://127.0.0.1:5173/`）。页面会自动加载十二页示例 PDF 和对应的 Markdown，不需要上传文件。

## 使用

主界面只保留阅读、搜索、编辑、导出与 PDF 页码/缩放。左上角菜单打开文献导航抽屉，右上角「更多」（···）包含其他工具。

- **双向高亮与重复文本消歧**：在 Markdown 中划选文字或单击段落，PDF 自动定位并高亮；从 PDF 中划选，也会在 Markdown 中突出对应字词。匹配结合选区前后文，并使用选区所在的真实页码，减少重复句子跳错页的情况。
- **35% 阅读基准线**：以阅读区距顶部 35% 的位置确定当前阅读页和页内进度，翻页更贴近实际阅读位置。
- **页内比例连续联动**：滚动 Markdown 或 PDF，另一栏跟随当前页内的相对位置；PDF 支持滚轮自然跨页，长文献可持续双向阅读。
- **高亮保持**：选区高亮随 PDF 滚动和缩放重新对齐，不需要重新划选。
- **全文搜索**：`⌘/Ctrl + K` 聚焦搜索；索引当前 Markdown 和 PDF 文字层，可查看页码、来源、片段与结果数量。点击结果或用 ↑/↓、Enter 定位，Esc 关闭。无结果时显示原因提示。
- **文件与工具**：从「更多」导入 PDF、导入 Markdown、自动分页、交换左右栏、切换联动与深色模式。
- **编辑和导出**：每页 Markdown 可编辑；点击顶部「导出」保存为本地 `.md` 文件。
- **新手教程**：从 **「更多 → 新手教程」** 进入，可随时重开。五步教程依次介绍十二页示例、Markdown → PDF 选择、PDF → Markdown 选择、v0.1.3 阅读联动与高亮保持、本地导入。演示按钮直接定位工作台中的真实文字和阅读位置，可在十二页长文献中核验效果。

![跨 PDF 与 Markdown 搜索](docs/search.png)

## 数据安全与限制

文献在**浏览器本地**读取、解析、搜索和编辑，不上传服务器、无需账号，也不操作 Obsidian Vault。编辑内容仅保存在页面内存，记得导出；刷新会重新载入示例。

PDF 需有可提取的文字层；扫描件应先做 OCR。为控制大型文献的开销，最多预索引前 120 页，其余页可以继续浏览，但不参与全文匹配。复杂排版、重复引文和 OCR 错字仍需人工核验。Markdown 精确高亮优先使用 CSS Highlight API；在不支持该接口的浏览器中，自动使用字符坐标高亮层，并在窗口大小变化后重新对齐。

## 开发与验证

前端使用 React、Vite、PDF.js、React Markdown 和 Lucide；核心页标、容错匹配与高亮坐标函数**直接复用父仓库**的 `src/compare.ts` 和 `src/pdf-dom.ts`。前端样式由 `styles.css` 和 `workspace.css` 组成，不改动 Obsidian 插件构建入口。

```bash
npm run build
# 保持 npm run dev 在另一个终端运行
npm run test:e2e
```

浏览器测试使用本机 Chrome；可用 `CHROME_PATH` 指定可执行文件，用 `DEMO_URL` 指定演示地址。测试覆盖搜索、多种定位、双向选区、连续阅读、高亮保持、五步教程、编辑、下载与移动端。

## GitHub Pages 部署

在线地址为 [hongdonglee.github.io/obsidian-pdf-collation](https://hongdonglee.github.io/obsidian-pdf-collation/)。仓库的 Pages 发布来源使用 **GitHub Actions**。

`.github/workflows/pages.yml` 在 `main` 分支的演示源码、共享匹配代码或根目录 `manifest.json` 更新时自动安装依赖、构建并部署 `web-demo/dist`，也支持手动运行。Vite 使用相对资源路径，适配 GitHub Pages 的项目子目录。

版本以根目录 `manifest.json` 为准，页面标识、HTML 的 `application-version` 元数据和构建产物 `version.json` 使用同一来源。今后在 `main` 上更新插件版本即可触发演示重新部署，页面版本不依赖演示包的版本号。部署后可查看在线 [`version.json`](https://hongdonglee.github.io/obsidian-pdf-collation/version.json) 核验实际发布版本。

示例 PDF 为项目内原创演示文本，位于 `public/sample.pdf`。

## Default long-form example

The browser demo now opens with a **12-page original sample PDF** and its matching paginated Markdown. Select text or scroll either pane to explore long-range collation; you can still import your own documents. The sample is original demonstration content, not a published academic work.
