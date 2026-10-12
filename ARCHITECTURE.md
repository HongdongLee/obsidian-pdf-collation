# Obsidian PDF Collation 架构与边界

## 质量闸门

任何修改必须通过：

```bash
npm run check   # TypeScript strict + ESLint + Node unit tests
npm run build   # check + esbuild production bundle (main.js)
```

## 模块职责

- `src/types.ts`：设置、页块切片与 PDF 渲染的公共类型定义。
- `src/compare.ts`：纯函数核心（无 Obsidian 运行时依赖，100% 单测覆盖）。负责文本归一化 `normalizeText`、多格式页标解析 `parsePagemark`、Markdown 按页切块 `splitMarkdownByPagemarks`、单块无损替换 `replaceBlockInMarkdown` 以及 PDF 文本层 span 匹配 `matchTextSpans`。
- `src/pairing.ts`：笔记与 PDF 原件的配对策略。分离了纯路径/frontmatter 解析函数与 Obsidian `Vault` / `MetadataCache` 查询。
- `src/pdf-dom.ts`：PDF 单页容器、透明文字层 `buildTextLayer` 与高亮框 `createHighlightRect` 的纯 DOM 构造。
- `src/pdf-pane.ts`：基于 Obsidian 内置 `loadPdfJs()` 的虚拟化 PDF 渲染控制器，只渲染可视页邻域（`curPage - 1` 至 `curPage + 2`），远离页面自动销毁画布释放内存。
- `src/view.ts`：`CollationView`（继承 `ItemView`），组合左栏 Markdown 页块渲染、页块内联编辑与右栏 `PdfPaneController`。
- `src/settings.ts` 与 `src/main.ts`：插件配置页与生命周期入口。
