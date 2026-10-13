# Collatio — PDF ↔ Markdown Web Demo

这是 [Obsidian PDF Collation](https://github.com/HongdongLee/obsidian-pdf-collation) 的独立浏览器体验版，可在不安装 Obsidian 的情况下体验真实的双轨对勘功能。

[**打开在线演示**](https://hongdonglee.github.io/obsidian-pdf-collation/)

![专注双轨阅读工作台](docs/desktop.png)

## 运行

需要 Node.js 22.18+。

```bash
cd web-demo
npm install
npm run dev
```

打开终端给出的本地地址（通常为 `http://127.0.0.1:5173/`）。页面会自动加载三页示例 PDF 和对应的 Markdown，不需要上传文件。

## 使用

主界面只保留阅读、搜索、编辑、导出与 PDF 页码/缩放。左上角菜单打开文献导航抽屉，右上角「更多」（···）包含其他工具。

- **双向高亮**：在 Markdown 中划选文字或单击段落，PDF 自动定位并高亮；从 PDF 中划选，也会在 Markdown 中突出对应字词。
- **连续阅读**：PDF 支持滚轮自然跨页，Markdown 与 PDF 可以按页标双向跟随。
- **全文搜索**：`⌘/Ctrl + K` 聚焦搜索；索引当前 Markdown 和 PDF 文字层，可查看页码、来源、片段与结果数量。点击结果或用 ↑/↓、Enter 定位，Esc 关闭。无结果时显示原因提示。
- **文件与工具**：从「更多」导入 PDF、导入 Markdown、自动分页、交换左右栏、切换联动与深色模式。
- **编辑和导出**：每页 Markdown 可编辑；点击顶部「导出」保存为本地 `.md` 文件。
- **新手教程**：仅保留 **「更多 → 新手教程」** 一个入口。四步教程包含真实的双向高亮演示，可随时重开。

![跨 PDF 与 Markdown 搜索](docs/search.png)

## 数据安全与限制

文献在**浏览器本地**读取、解析、搜索和编辑，不上传服务器、无需账号，也不操作 Obsidian Vault。编辑内容仅保存在页面内存，记得导出；刷新会重新载入示例。

PDF 需有可提取的文字层；扫描件应先做 OCR。为控制大型文献的开销，最多预索引前 120 页，其余页可以继续浏览，但不参与全文匹配。复杂排版、重复引文和 OCR 错字仍需人工核验。Markdown 精确高亮依赖浏览器的 CSS Highlight API。

## 开发与验证

前端使用 React、Vite、PDF.js、React Markdown 和 Lucide；核心页标、容错匹配与高亮坐标函数**直接复用父仓库**的 `src/compare.ts` 和 `src/pdf-dom.ts`。前端样式由 `styles.css` 和 `workspace.css` 组成，不改动 Obsidian 插件构建入口。

```bash
npm run build
# 保持 npm run dev 在另一个终端运行
npm run test:e2e
```

浏览器测试使用本机 Chrome；可用 `CHROME_PATH` 指定可执行文件，用 `DEMO_URL` 指定演示地址。测试覆盖搜索、多种定位、高亮、教程单入口、滚轮阅读、编辑、下载与移动端。

## GitHub Pages 部署

在线地址为 [hongdonglee.github.io/obsidian-pdf-collation](https://hongdonglee.github.io/obsidian-pdf-collation/)。仓库的 Pages 发布来源使用 **GitHub Actions**。

`.github/workflows/pages.yml` 在 `main` 分支的演示源码或共享匹配代码更新时自动安装依赖、构建并部署 `web-demo/dist`，也支持手动运行。Vite 使用相对资源路径，适配 GitHub Pages 的项目子目录。

示例 PDF 为项目内原创演示文本，位于 `public/sample.pdf`。
