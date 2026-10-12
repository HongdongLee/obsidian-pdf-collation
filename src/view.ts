import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian'
import {
  autoInsertPagemarks,
  buildMarkdownFromPdfPages,
  decoratePagemarksInBlock,
  matchSegmentSlices,
  normalizeText,
  parsePagemark,
  replaceBlockInMarkdown,
  splitMarkdownByPagemarks,
  stripEditorialNoise,
} from './compare'
import {
  extractPageOffsetFromFrontmatter,
  parseFrontmatterFromMarkdown,
  resolvePairedMarkdown,
  resolvePairedPdf,
  upsertFrontmatterPdf,
} from './pairing'
import { PdfPaneController } from './pdf-pane'
import { PdfSuggestModal } from './pdf-suggest-modal'
import type {
  CollationSettings,
  MarkdownPageBlock,
  SelectionContext,
  SplitMarkdownResult,
} from './types'

export const VIEW_TYPE_COLLATION = 'pdf-collation-view'

export interface CollationPluginHost {
  settings: CollationSettings
  saveSettings: () => Promise<void>
}

export class CollationView extends ItemView {
  private plugin: CollationPluginHost
  private mdFile: TFile | null = null
  private pdfFile: TFile | null = null
  private splitState: SplitMarkdownResult | null = null
  private follow = true
  private swapped = false

  // 防止 MD ⇄ PDF 双向滚动联动互相触发形成死循环
  private syncLockSource: 'md' | 'pdf' | null = null
  private syncLockTimer = 0
  private mdScrollTimer = 0
  private selectionSettleTimer = 0
  private lastMdSyncedPage = 0
  private lastSelectionSig = ''
  private loadFileSeq = 0
  private renderSeq = 0
  private isRenderingMd = false
  private pendingStateFile: string | null = null
  private isOpenComplete = false

  private rootEl!: HTMLDivElement
  private crumbEl!: HTMLSpanElement
  private pdfStatusBtn!: HTMLButtonElement
  private pageJumpInput!: HTMLInputElement
  private pageTotalSpan!: HTMLSpanElement
  private zoomResetBtn!: HTMLButtonElement
  private gridEl!: HTMLDivElement
  private mdPaneEl!: HTMLDivElement
  private articleEl!: HTMLElement
  private pdfController: PdfPaneController | null = null

  constructor(leaf: WorkspaceLeaf, plugin: CollationPluginHost) {
    super(leaf)
    this.plugin = plugin
    this.follow = plugin.settings.defaultFollowScroll
    this.swapped = plugin.settings.defaultSwapped
  }

  getViewType(): string {
    return VIEW_TYPE_COLLATION
  }

  getDisplayText(): string {
    return this.mdFile ? `校勘 · ${this.mdFile.basename}` : '双轨校勘'
  }

  getIcon(): string {
    return 'columns'
  }

  getMarkdownFile(): TFile | null {
    return this.mdFile
  }

  async setState(state: any, result: any): Promise<void> {
    await super.setState(state, result)
    const stateFile =
      typeof state?.file === 'string' && state.file.trim() ? state.file.trim() : null
    if (stateFile) {
      this.pendingStateFile = stateFile
    }
    if (!this.isOpenComplete) {
      return
    }
    await this.applyPendingOrActiveFile(stateFile ?? this.pendingStateFile)
  }

  getState(): Record<string, unknown> {
    return {
      file: this.mdFile?.path ?? this.pendingStateFile ?? null,
    }
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty()
    this.contentEl.addClass('pdf-collation-container')

    this.rootEl = this.contentEl.createDiv({ cls: 'pdf-collation-root' })
    this.buildHeader()

    this.gridEl = this.rootEl.createDiv({
      cls: 'compare-grid' + (this.swapped ? ' swapped' : ''),
    })

    this.mdPaneEl = this.gridEl.createDiv({ cls: 'cmp-pane cmp-md' })
    this.articleEl = this.mdPaneEl.createEl('article', { cls: 'cmp-article' })

    this.mdPaneEl.addEventListener('click', (e) => this.onMdClick(e))
    this.mdPaneEl.addEventListener('scroll', () => this.onMdScroll())

    // 全局监听鼠标释放，确保拖选到分栏边缘或双击选词都能稳定触发双向对位高亮
    this.registerDomEvent(document, 'mouseup', () => {
      window.clearTimeout(this.selectionSettleTimer)
      this.selectionSettleTimer = window.setTimeout(() => {
        this.handleDocumentSelection()
      }, 25)
    })

    this.pdfController = new PdfPaneController(this.gridEl, {
      onPageChange: (page, total) => this.onPdfPageChange(page, total),
      onPdfSelect: (text, page, context) => this.onPdfSelect(text, page, context),
    })

    this.isOpenComplete = true

    // 监听工作区文件打开事件：当用户切换到另一篇带配对 PDF 的文献笔记（或对应 PDF）时，双轨视图自动同步切换
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        void this.onWorkspaceFileOpen(file)
      })
    )

    // 监听当前笔记的 frontmatter / 缓存变更，若通过命令或外部修改了配对 PDF 则实时同步
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (this.mdFile && file.path === this.mdFile.path) {
          void this.syncPairedPdfIfChanged()
        }
      })
    )

    // 监听文件重命名，保持标题栏与配对路径同步
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) {
          if (this.mdFile && (oldPath === this.mdFile.path || file === this.mdFile)) {
            this.mdFile = file
            this.pendingStateFile = file.path
            ;(this.leaf as any).updateHeader?.()
            this.crumbEl.setText(file.basename)
            this.crumbEl.setAttr('title', file.path)
            void this.syncPairedPdfIfChanged()
          } else if (this.pdfFile && (oldPath === this.pdfFile.path || file === this.pdfFile)) {
            this.pdfFile = file
            this.updatePdfStatusUI()
          }
        }
      })
    )

    if (this.pendingStateFile || this.mdFile) {
      await this.applyPendingOrActiveFile(this.pendingStateFile ?? this.mdFile?.path ?? null)
    } else {
      this.app.workspace.onLayoutReady(() => {
        if (!this.mdFile && !this.isRenderingMd && this.isOpenComplete) {
          void this.applyPendingOrActiveFile(this.pendingStateFile)
        }
      })
    }
  }

  async onClose(): Promise<void> {
    this.isOpenComplete = false
    window.clearTimeout(this.syncLockTimer)
    window.clearTimeout(this.mdScrollTimer)
    window.clearTimeout(this.selectionSettleTimer)
    this.pdfController?.destroy()
    this.pdfController = null
  }

  private async applyPendingOrActiveFile(targetPath: string | null): Promise<void> {
    if (targetPath) {
      const f = this.app.vault.getAbstractFileByPath(targetPath)
      if (f instanceof TFile) {
        if (f.extension.toLowerCase() === 'md') {
          await this.loadMarkdownFile(f)
          return
        }
        if (f.extension.toLowerCase() === 'pdf') {
          await this.loadPdfFileOrGenerateMarkdown(f)
          return
        }
      } else {
        // 冷启动时若 Vault 尚未挂载完文件树，待 layoutReady 后重试 targetPath，避免误回退到其它活动标签页
        this.app.workspace.onLayoutReady(() => {
          const retry = this.app.vault.getAbstractFileByPath(targetPath)
          if (retry instanceof TFile) {
            if (retry.extension.toLowerCase() === 'md') {
              void this.loadMarkdownFile(retry)
            } else if (retry.extension.toLowerCase() === 'pdf') {
              void this.loadPdfFileOrGenerateMarkdown(retry)
            }
          }
        })
        return
      }
    }

    if (!this.mdFile) {
      const active = this.app.workspace.getActiveFile()
      if (active && active.extension.toLowerCase() === 'md') {
        await this.loadMarkdownFile(active)
      } else if (active && active.extension.toLowerCase() === 'pdf') {
        await this.loadPdfFileOrGenerateMarkdown(active)
      } else {
        this.renderEmpty('请先打开一篇 Markdown 笔记或 PDF 文献，再启动双轨校勘视图。')
        this.pdfController?.clear('未打开文献或笔记')
      }
    }
  }

  private async onWorkspaceFileOpen(file: TFile | null): Promise<void> {
    if (!file || !this.isOpenComplete) return
    const ext = file.extension.toLowerCase()
    if (ext === 'md') {
      if (this.mdFile?.path === file.path) return
      let raw: string
      try {
        raw = await this.app.vault.read(file)
      } catch {
        return
      }
      const pairedPdf = resolvePairedPdf(this.app, file, this.plugin.settings, raw)
      // 当用户在库内切换到另一篇配对有 PDF 的文献笔记时，双轨视图自动同步加载该笔记与对应 PDF
      if (pairedPdf) {
        await this.loadMarkdownFile(file, false, pairedPdf, raw)
      }
    } else if (ext === 'pdf') {
      if (this.pdfFile?.path === file.path) return
      const pairedMd = resolvePairedMarkdown(this.app, file, this.plugin.settings)
      if (pairedMd) {
        await this.loadMarkdownFile(pairedMd, false, file)
      }
    }
  }

  private async syncPairedPdfIfChanged(): Promise<void> {
    if (!this.mdFile || !this.isOpenComplete) return
    let raw: string
    try {
      raw = await this.app.vault.read(this.mdFile)
    } catch {
      return
    }
    const nextPdf = resolvePairedPdf(this.app, this.mdFile, this.plugin.settings, raw)
    const prevPath = this.pdfFile?.path ?? null
    const nextPath = nextPdf?.path ?? null
    if (prevPath !== nextPath) {
      this.pdfFile = nextPdf
      this.updatePdfStatusUI()
      if (this.pdfFile) {
        const url = this.app.vault.getResourcePath(this.pdfFile)
        void this.pdfController?.load(url)
      } else {
        this.pageJumpInput.value = ''
        this.pageTotalSpan.setText('/ - 页')
        this.pdfController?.clear(
          `未找到与「${this.mdFile.basename}」配对的 PDF 原件，点击顶部「绑定 PDF」可手动关联`
        )
      }
    }
  }

  private updatePdfStatusUI(): void {
    if (!this.pdfStatusBtn) return
    if (this.pdfFile) {
      const sameName = this.mdFile && this.pdfFile.basename === this.mdFile.basename
      const label = sameName ? 'PDF 已配对' : `PDF · ${this.pdfFile.basename}`
      this.pdfStatusBtn.setText(label)
      this.pdfStatusBtn.setAttr(
        'title',
        `当前绑定 PDF：${this.pdfFile.path}（点击可换绑）`
      )
      this.pdfStatusBtn.removeClass('is-missing')
    } else {
      this.pdfStatusBtn.setText('绑定 PDF')
      this.pdfStatusBtn.setAttr('title', '未找到配对 PDF，点击从库中选择绑定')
      this.pdfStatusBtn.addClass('is-missing')
    }
  }

  /**
   * 当用户直接针对一个 PDF 文件启动双轨校勘视图时：
   * 若已有配对的 Markdown 笔记则直接加载；若尚无任何 MD 文件，则自动从 PDF 提取各页文字层、重建分段并生成同名 .md 底稿后打开
   */
  async loadPdfFileOrGenerateMarkdown(pdfFile: TFile): Promise<void> {
    if (!this.isOpenComplete) {
      this.pendingStateFile = pdfFile.path
      return
    }
    const existingMd = resolvePairedMarkdown(this.app, pdfFile, this.plugin.settings)
    if (existingMd) {
      await this.loadMarkdownFile(existingMd, false, pdfFile)
      return
    }

    this.pdfFile = pdfFile
    this.crumbEl.setText(pdfFile.basename)
    this.crumbEl.setAttr('title', pdfFile.path)
    this.updatePdfStatusUI()
    this.renderEmpty(`正在从「${pdfFile.name}」提取文字层并生成双轨校勘底稿…`)

    const url = this.app.vault.getResourcePath(pdfFile)
    await this.pdfController?.load(url)

    const pagesItems = (await this.pdfController?.extractAllPageItems()) ?? []
    if (pagesItems.length === 0) {
      this.renderEmpty(`无法从「${pdfFile.name}」提取页面内容`)
      return
    }

    const key = this.plugin.settings.frontmatterKeys[0] || 'pdf'
    const generatedMd = buildMarkdownFromPdfPages(pagesItems, pdfFile.path, key)
    const mdPath = pdfFile.path.replace(/\.pdf$/i, '.md')

    let createdMd: TFile
    const existingAbstract = this.app.vault.getAbstractFileByPath(mdPath)
    if (existingAbstract instanceof TFile) {
      createdMd = existingAbstract
    } else {
      try {
        createdMd = await this.app.vault.create(mdPath, generatedMd)
        new Notice(`已从 PDF 自动生成校勘底稿：${createdMd.name}（共 ${pagesItems.length} 页）`)
      } catch (e: any) {
        this.renderEmpty(`创建校勘底稿失败 (${e?.message || String(e)})`)
        return
      }
    }

    await this.loadMarkdownFile(createdMd, true, pdfFile, generatedMd)
  }

  async loadMarkdownFile(
    file: TFile,
    force = false,
    explicitPdfFile?: TFile | null,
    preloadedRaw?: string
  ): Promise<void> {
    if (!this.isOpenComplete) {
      this.pendingStateFile = file.path
      return
    }
    const isSameMd = this.mdFile?.path === file.path
    if (!force && isSameMd && explicitPdfFile === undefined && (this.isRenderingMd || this.splitState)) {
      if (!this.pdfFile) {
        await this.syncPairedPdfIfChanged()
      }
      return
    }

    const fileSeq = ++this.loadFileSeq
    const switchingFile = !isSameMd
    this.mdFile = file
    this.pendingStateFile = file.path
    this.lastMdSyncedPage = 0
    this.lastSelectionSig = ''
    ;(this.leaf as any).updateHeader?.()
    this.crumbEl.setText(file.basename)
    this.crumbEl.setAttr('title', file.path)

    if (switchingFile) {
      this.mdPaneEl.scrollTop = 0
    }

    let raw = preloadedRaw
    if (raw === undefined) {
      try {
        raw = await this.app.vault.read(file)
      } catch {
        if (fileSeq !== this.loadFileSeq) return
        this.renderEmpty(`无法读取笔记文件：${file.path}`)
        this.pdfFile = null
        this.updatePdfStatusUI()
        this.pdfController?.clear('无法读取对应 Markdown 笔记')
        return
      }
    }
    if (fileSeq !== this.loadFileSeq) return

    const nextPdf =
      explicitPdfFile !== undefined
        ? explicitPdfFile
        : resolvePairedPdf(this.app, file, this.plugin.settings, raw)

    this.pdfFile = nextPdf
    this.updatePdfStatusUI()

    if (this.pdfFile) {
      const url = this.app.vault.getResourcePath(this.pdfFile)
      if (
        force ||
        switchingFile ||
        this.pdfController?.loadedResourceUrl !== url ||
        (this.pdfController?.totalPages ?? 0) === 0
      ) {
        void this.pdfController?.load(url)
      }
    } else {
      this.pageJumpInput.value = ''
      this.pageTotalSpan.setText('/ - 页')
      this.pdfController?.clear(
        `未找到与「${file.basename}」配对的 PDF 原件，点击顶部「绑定 PDF」可手动关联`
      )
    }

    await this.renderMarkdownBlocks(raw, switchingFile)
  }

  private lockSync(source: 'md' | 'pdf', durationMs = 520): void {
    this.syncLockSource = source
    window.clearTimeout(this.syncLockTimer)
    this.syncLockTimer = window.setTimeout(() => {
      this.syncLockSource = null
    }, durationMs)
  }

  private buildHeader(): void {
    const head = this.rootEl.createDiv({ cls: 'collation-head' })

    const left = head.createDiv({ cls: 'collation-crumb-wrap' })
    this.crumbEl = left.createSpan({ cls: 'collation-crumb', text: '未打开笔记' })
    this.pdfStatusBtn = left.createEl('button', {
      cls: 'collation-btn collation-pdf-btn',
      text: '绑定 PDF',
    })
    this.pdfStatusBtn.addEventListener('click', () => this.promptBindPdf())

    const actions = head.createDiv({ cls: 'collation-actions' })

    // 页码跳转：PDF [ 1 ] / 6 页
    const jumpWrap = actions.createDiv({ cls: 'collation-jump-wrap' })
    jumpWrap.createSpan({ cls: 'collation-jump-label', text: 'PDF' })
    this.pageJumpInput = jumpWrap.createEl('input', {
      cls: 'collation-page-input',
      type: 'number',
      attr: { placeholder: '1', min: '1', title: '输入 PDF 页码回车跳转' },
    })
    this.pageTotalSpan = jumpWrap.createSpan({ cls: 'collation-jump-total', text: '/ - 页' })
    this.pageJumpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = Number(this.pageJumpInput.value)
        if (n > 0) {
          this.lockSync('pdf')
          this.pdfController?.scrollToPage(n, true)
        }
      }
    })

    // 缩放控制：- 100% +
    const zoomGroup = actions.createDiv({ cls: 'collation-zoom-group' })
    const zoomOutBtn = zoomGroup.createEl('button', {
      cls: 'collation-btn',
      text: '−',
      attr: { title: '缩小 PDF' },
    })
    this.zoomResetBtn = zoomGroup.createEl('button', {
      cls: 'collation-btn collation-zoom-pct',
      text: '100%',
      attr: { title: '点击重置为自适应页宽 (100%)' },
    })
    const zoomInBtn = zoomGroup.createEl('button', {
      cls: 'collation-btn',
      text: '+',
      attr: { title: '放大 PDF' },
    })
    zoomOutBtn.addEventListener('click', () => {
      const pct = this.pdfController?.adjustZoom(-0.15) ?? 100
      this.zoomResetBtn.setText(`${pct}%`)
    })
    this.zoomResetBtn.addEventListener('click', () => {
      const pct = this.pdfController?.resetZoom() ?? 100
      this.zoomResetBtn.setText(`${pct}%`)
    })
    zoomInBtn.addEventListener('click', () => {
      const pct = this.pdfController?.adjustZoom(0.15) ?? 100
      this.zoomResetBtn.setText(`${pct}%`)
    })

    // 双向滚动联动开关
    const followLabel = actions.createEl('label', {
      cls: 'collation-follow-toggle',
      attr: { title: '开启后，滚动左栏 Markdown 或右栏 PDF 都会双向同步翻页' },
    })
    const followInput = followLabel.createEl('input', { type: 'checkbox' })
    followInput.checked = this.follow
    followLabel.appendText('双向联动')
    followInput.addEventListener('change', () => {
      this.follow = followInput.checked
    })

    // 左右互换
    const swapBtn = actions.createEl('button', {
      cls: 'collation-btn',
      text: this.swapped ? '⇄ PDF 在左' : '⇄ MD 在左',
      attr: { title: '交换 Markdown 与 PDF 的左右位置' },
    })
    swapBtn.addEventListener('click', () => {
      this.swapped = !this.swapped
      swapBtn.setText(this.swapped ? '⇄ PDF 在左' : '⇄ MD 在左')
      this.gridEl.toggleClass('swapped', this.swapped)
    })

    // 在普通编辑器中打开
    const openMdBtn = actions.createEl('button', {
      cls: 'collation-btn',
      text: '原笔记',
      attr: { title: '在相邻标签页打开原始 Markdown 编辑器' },
    })
    openMdBtn.addEventListener('click', () => {
      if (this.mdFile) {
        void this.app.workspace.getLeaf('tab').openFile(this.mdFile)
      }
    })
  }

  private renderEmpty(msg: string): void {
    this.articleEl.empty()
    this.articleEl.createDiv({ cls: 'collation-empty', text: msg })
  }

  private getPagemarkOptions(rawMarkdown?: string) {
    const cache = this.mdFile ? this.app.metadataCache.getFileCache(this.mdFile) : null
    const cachedFm = (cache?.frontmatter as Record<string, unknown> | undefined) ?? {}
    const parsedFm = rawMarkdown ? parseFrontmatterFromMarkdown(rawMarkdown) : {}
    const pageOffset = extractPageOffsetFromFrontmatter({ ...cachedFm, ...parsedFm })
    return {
      customPattern: this.plugin.settings.customPagemarkPattern,
      pageOffset,
    }
  }

  private async renderMarkdownBlocks(preloadedRaw?: string, resetScroll = false): Promise<void> {
    if (!this.mdFile) return
    const seq = ++this.renderSeq
    this.isRenderingMd = true
    try {
      const prevScroll = resetScroll ? 0 : this.mdPaneEl.scrollTop
      const raw =
        preloadedRaw !== undefined ? preloadedRaw : await this.app.vault.read(this.mdFile)
      if (seq !== this.renderSeq) return

      const opts = this.getPagemarkOptions(raw)
      const split = splitMarkdownByPagemarks(raw, opts)
      this.splitState = split

      const sections: HTMLElement[] = []
      for (const block of split.blocks) {
        const sec = document.createElement('section')
        sec.className = 'cmp-block'
        sec.dataset.blockIndex = String(block.index)
        if (block.pdfPage != null) {
          sec.dataset.pdfPage = String(block.pdfPage)
        } else {
          sec.classList.add('cmp-block-lead')
        }
        await this.populateBlockSection(sec, block)
        if (seq !== this.renderSeq) return
        sections.push(sec)
      }

      this.articleEl.empty()
      for (const sec of sections) {
        this.articleEl.append(sec)
      }

      this.mdPaneEl.scrollTop = prevScroll
    } finally {
      if (seq === this.renderSeq) {
        this.isRenderingMd = false
      }
    }
  }

  private formatBlockTitle(block: MarkdownPageBlock): string {
    if (block.pdfPage == null) {
      return (this.splitState?.blocks.length ?? 0) <= 1
        ? '全文对照（未设页标 · 划选任意句子自动定位 PDF）'
        : '卷首说明与考证注记'
    }
    if (block.printPage) {
      return `原书 p. ${block.printPage}  ·  PDF 第 ${block.pdfPage} 页`
    }
    return `PDF 第 ${block.pdfPage} 页`
  }

  private async populateBlockSection(
    sec: HTMLElement,
    block: MarkdownPageBlock
  ): Promise<void> {
    sec.empty()

    const bar = sec.createDiv({ cls: 'cmp-block-bar' })
    const pageTag = bar.createSpan({
      cls: 'cmp-block-tag',
      text: this.formatBlockTitle(block),
      attr: {
        title:
          block.pdfPage != null
            ? `点击让右侧 PDF 跳至第 ${block.pdfPage} 页`
            : '卷首导言区块',
      },
    })
    if (block.pdfPage != null) {
      pageTag.addEventListener('click', (e) => {
        e.stopPropagation()
        this.setActiveBlock(sec)
        this.lockSync('md')
        this.pdfController?.scrollToPage(block.pdfPage!, true)
      })
    }

    const barRight = bar.createDiv({ cls: 'cmp-block-bar-right' })
    if (block.pdfPage == null && (this.splitState?.blocks.length ?? 0) <= 1) {
      const autoPageBtn = barRight.createEl('button', {
        cls: 'cmp-block-edit-btn',
        text: '⚡ 自动按 PDF 分页',
        attr: { title: '根据右侧 PDF 各页文字自动匹配并在对应段落前插入页标' },
      })
      autoPageBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.autoPaginateFromPdf(autoPageBtn)
      })
    }
    const editBtn = barRight.createEl('button', {
      cls: 'cmp-block-edit-btn',
      text: '✎ 校改本页',
      attr: { title: '就地修改当前页块的 Markdown 文本（也可按住 Option/Alt 双击正文段落）' },
    })
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.openInlineBlockEditor(sec, block)
    })

    // 卷首非正文元数据块默认折叠，打开视图即可直接对齐第一页正文
    let renderTarget: HTMLElement
    if (block.pdfPage == null && (this.splitState?.blocks.length ?? 0) > 1) {
      const details = sec.createEl('details', { cls: 'cmp-lead-details' })
      details.createEl('summary', {
        cls: 'cmp-lead-summary',
        text: '点击展开/收起卷首元数据与考证注记',
      })
      renderTarget = details.createDiv({ cls: 'cmp-block-body' })
    } else {
      renderTarget = sec.createDiv({ cls: 'cmp-block-body' })
    }

    renderTarget.addEventListener('dblclick', (e) => {
      if (!e.altKey) return
      const target = e.target as HTMLElement
      if (target.closest('a, button, .pagemark')) return
      const paraText = target.closest('p, li, blockquote, h1, h2, h3, h4')?.textContent?.trim()
      this.openInlineBlockEditor(sec, block, paraText)
    })

    const decorated = decoratePagemarksInBlock(block.markdown, {
      ...this.getPagemarkOptions(),
      stripLeadingMarker: block.pdfPage != null,
    })
    await MarkdownRenderer.render(
      this.app,
      decorated,
      renderTarget,
      this.mdFile?.path ?? '',
      this
    )
  }

  private openInlineBlockEditor(
    sec: HTMLElement,
    block: MarkdownPageBlock,
    focusSubstring?: string
  ): void {
    if (sec.querySelector('.cmp-inline-editor')) return
    const bodyEl = sec.querySelector('.cmp-block-body') as HTMLElement | null
    const detailsEl = sec.querySelector('.cmp-lead-details') as HTMLDetailsElement | null
    if (detailsEl) detailsEl.open = true
    if (bodyEl) bodyEl.style.display = 'none'

    const wrap = sec.createDiv({ cls: 'cmp-inline-editor' })
    const ta = wrap.createEl('textarea', { cls: 'cmp-inline-textarea' })
    ta.value = block.markdown
    ta.rows = Math.max(6, Math.min(26, block.markdown.split('\n').length + 3))

    const foot = wrap.createDiv({ cls: 'cmp-inline-foot' })
    const hint = foot.createSpan({
      cls: 'cmp-inline-hint',
      text: '⌘S / Ctrl+S 保存修改，Esc 取消',
    })
    const cancelBtn = foot.createEl('button', { cls: 'collation-btn', text: '取消' })
    const saveBtn = foot.createEl('button', {
      cls: 'collation-btn collation-btn-accent',
      text: '保存 (⌘S)',
    })

    const cancel = () => {
      wrap.remove()
      if (bodyEl) bodyEl.style.display = ''
    }

    const save = async () => {
      if (!this.mdFile || !this.splitState) return
      const nextText = ta.value
      hint.setText('保存中…')
      const opts = this.getPagemarkOptions()
      let updatedContent = ''
      await this.app.vault.process(this.mdFile, (currentRaw) => {
        const freshSplit = splitMarkdownByPagemarks(currentRaw, opts)
        updatedContent = replaceBlockInMarkdown(freshSplit, block.index, nextText)
        return updatedContent
      })
      new Notice(`已保存 ${this.formatBlockTitle(block)}`)
      const nextSplit = updatedContent ? splitMarkdownByPagemarks(updatedContent, opts) : null
      const updatedBlock = nextSplit?.blocks[block.index]
      if (
        nextSplit &&
        updatedBlock &&
        nextSplit.blocks.length === this.splitState.blocks.length &&
        updatedBlock.pdfPage === block.pdfPage
      ) {
        this.splitState = nextSplit
        await this.populateBlockSection(sec, updatedBlock)
      } else {
        await this.renderMarkdownBlocks()
      }
    }

    cancelBtn.addEventListener('click', cancel)
    saveBtn.addEventListener('click', () => void save())
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    })

    ta.focus()
    if (focusSubstring && focusSubstring.length >= 4) {
      const snippet = focusSubstring.slice(0, 12)
      const idx = block.markdown.indexOf(snippet)
      if (idx !== -1) {
        ta.setSelectionRange(idx, idx)
      }
    }
  }

  private setActiveBlock(el: HTMLElement): void {
    const prev = this.articleEl.querySelector('.cmp-active')
    if (prev && prev !== el) prev.classList.remove('cmp-active')
    el.classList.add('cmp-active')
  }

  private getCurrentMdBlock(blocks: readonly HTMLElement[]): HTMLElement | null {
    if (!blocks.length) return null
    const probe = this.mdPaneEl.scrollTop + Math.min(120, this.mdPaneEl.clientHeight * 0.22)
    let currentBlock = blocks[0]
    for (const b of blocks) {
      if (b.offsetTop <= probe) currentBlock = b
      else break
    }
    return currentBlock
  }

  /**
   * 左栏滚动 → 自动检测当前阅读的页块并同步右侧 PDF
   */
  private onMdScroll(): void {
    if (this.isRenderingMd || !this.follow) return
    if (this.syncLockSource === 'pdf') {
      // 平滑滚动动画进行中持续续期锁，避免动画尾帧反弹触发反向跳转
      this.lockSync('pdf', 260)
      return
    }
    if (this.mdScrollTimer) return

    this.mdScrollTimer = window.setTimeout(() => {
      this.mdScrollTimer = 0
      if (this.isRenderingMd || !this.follow || this.syncLockSource === 'pdf') return

      const blocks = Array.from(
        this.articleEl.querySelectorAll<HTMLElement>('.cmp-block[data-pdf-page]')
      )
      const currentBlock = this.getCurrentMdBlock(blocks)
      if (!currentBlock) return

      this.setActiveBlock(currentBlock)
      const page = Number(currentBlock.dataset.pdfPage)
      if (page > 0 && page !== this.lastMdSyncedPage && page !== this.pdfController?.currentPage) {
        this.lastMdSyncedPage = page
        this.lockSync('md', 650)
        this.pdfController?.scrollToPage(page, true)
      }
    }, 90)
  }

  private onMdClick(e: MouseEvent): void {
    const t = e.target as HTMLElement
    const pm = t.closest('.pagemark') as HTMLElement | null
    if (pm) {
      const page =
        Number(pm.dataset.page) ||
        parsePagemark(pm.textContent || '', this.getPagemarkOptions())
      if (page) {
        this.lockSync('md')
        this.pdfController?.scrollToPage(page, true)
        return
      }
    }

    const internalLink = t.closest('a.internal-link') as HTMLAnchorElement | null
    if (internalLink && this.mdFile) {
      e.preventDefault()
      const href = internalLink.getAttribute('data-href') || internalLink.getAttribute('href')
      if (!href) return

      const [linkpath, subpath] = href.split('#')
      const dest = linkpath
        ? this.app.metadataCache.getFirstLinkpathDest(linkpath, this.mdFile.path)
        : this.mdFile
      if (dest && dest.extension.toLowerCase() === 'pdf' && !e.metaKey && !e.ctrlKey) {
        const pageMatch = subpath?.match(/page=(\d+)/i)
        const targetPage = pageMatch ? Number(pageMatch[1]) : 0
        if (this.pdfFile?.path !== dest.path) {
          this.pdfFile = dest
          this.updatePdfStatusUI()
          const url = this.app.vault.getResourcePath(dest)
          void this.pdfController?.load(url).then(() => {
            if (targetPage > 0) this.pdfController?.scrollToPage(targetPage, true)
          })
        } else if (targetPage > 0) {
          this.lockSync('md')
          this.pdfController?.scrollToPage(targetPage, true)
        }
        return
      }

      if (dest && dest.extension.toLowerCase() === 'md' && !e.metaKey && !e.ctrlKey) {
        void this.loadMarkdownFile(dest, true)
        return
      }

      void this.app.workspace.openLinkText(href, this.mdFile.path, true)
    }
  }

  private clearMarkdownInlineHighlights(): void {
    for (const mark of Array.from(this.articleEl.querySelectorAll('mark.cmp-inline-hl'))) {
      const parent = mark.parentNode
      while (mark.firstChild) {
        parent?.insertBefore(mark.firstChild, mark)
      }
      mark.remove()
      parent?.normalize()
    }
    for (const old of Array.from(this.articleEl.querySelectorAll('.cmp-para-flash'))) {
      old.classList.remove('cmp-para-flash')
    }
  }

  private collectBlockTextNodes(root: HTMLElement): Text[] {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest('.pagemark, .cmp-block-bar, .cmp-inline-editor, .cmp-lead-summary')) {
          return NodeFilter.FILTER_REJECT
        }
        return (node.nodeValue?.length ?? 0) > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
      },
    })
    let cur = walker.nextNode()
    while (cur) {
      nodes.push(cur as Text)
      cur = walker.nextNode()
    }
    return nodes
  }

  private handleDocumentSelection(): void {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.lastSelectionSig = ''
      return
    }

    const range = sel.getRangeAt(0)
    const common = range.commonAncestorContainer
    const el0 = common.nodeType === 3 ? common.parentElement : (common as HTMLElement)
    if (!el0 || !this.rootEl.contains(el0)) return

    const text = sel.toString().trim()
    if (text.length < 1) return

    const startNode = range.startContainer
    const startEl =
      startNode.nodeType === 3 ? startNode.parentElement : (startNode as HTMLElement)
    const blockIdx =
      (startEl?.closest('.cmp-block') as HTMLElement | null)?.dataset.blockIndex ??
      (el0.closest('.cmp-block') as HTMLElement | null)?.dataset.blockIndex ??
      ''

    // 避免同一次静止选区重复触发
    const sig = `${this.mdPaneEl.contains(el0) ? 'md' : 'pdf'}:${blockIdx}:${text}:${range.startOffset}:${range.endOffset}`
    if (sig === this.lastSelectionSig) return
    this.lastSelectionSig = sig

    if (this.mdPaneEl.contains(el0)) {
      this.handleMdSelection(range, startEl ?? el0, text)
    } else if (this.pdfController?.containsNode(el0)) {
      this.pdfController.handlePdfSelectionFromWindow(sel)
    }
  }

  private handleMdSelection(range: Range, anchorEl: HTMLElement, text: string): void {
    if (anchorEl.closest('.cmp-inline-editor, .cmp-block-bar, .cmp-lead-summary')) return
    if (normalizeText(text).length === 0) return

    const blockEl = anchorEl.closest('.cmp-block') as HTMLElement | null
    if (blockEl) this.setActiveBlock(blockEl)

    const bodyEl =
      (anchorEl.closest('.cmp-block-body') as HTMLElement | null) ?? blockEl ?? this.articleEl

    // 必须在 clearMarkdownInlineHighlights() 之前提取上下文，否则移除 <mark> 并 normalize() 会令 range 节点失效
    let before = ''
    let after = ''
    let progress: number | undefined
    try {
      const preRange = document.createRange()
      preRange.selectNodeContents(bodyEl)
      preRange.setEnd(range.startContainer, range.startOffset)
      const rawBefore = preRange.toString()
      before = stripEditorialNoise(rawBefore).slice(-80)

      const postRange = document.createRange()
      postRange.selectNodeContents(bodyEl)
      postRange.setStart(range.endContainer, range.endOffset)
      const rawAfter = postRange.toString()
      after = stripEditorialNoise(rawAfter).slice(0, 80)

      const bLen = normalizeText(rawBefore).length
      const sLen = normalizeText(text).length
      const aLen = normalizeText(rawAfter).length
      const total = bLen + sLen + aLen
      if (total > 0) {
        progress = bLen / total
      }
    } catch {
      // ignore range errors
    }

    this.clearMarkdownInlineHighlights()

    const blockPage = Number(blockEl?.dataset.pdfPage) || 0
    const hasPagemarks = (this.splitState?.blocks.some((b) => b.pdfPage != null)) ?? false
    const preferredPage = blockPage || this.pdfController?.currentPage || 1
    const strictPage = blockPage > 0 || hasPagemarks

    this.lockSync('md', 900)
    this.pdfController
      ?.highlightOnPage(preferredPage, text, { before, after, progress, strictPage })
      .then((res) => {
        if (res.count === 0) {
          new Notice(`PDF 第 ${preferredPage} 页中未找到与选中内容匹配的文本`)
        }
      })
      .catch(() => {})
  }

  /**
   * 右栏 PDF 滚动翻页 → 左栏自动跟随到对应页块
   */
  private onPdfPageChange(n: number, total: number): void {
    this.pageJumpInput.value = String(n)
    this.pageTotalSpan.setText(`/ ${total} 页`)

    if (this.isRenderingMd || !this.follow || this.syncLockSource === 'md') return

    const blocks = Array.from(
      this.articleEl.querySelectorAll<HTMLElement>('.cmp-block[data-pdf-page]')
    )
    if (!blocks.length) return

    let target: HTMLElement | null =
      blocks.find((el) => Number(el.dataset.pdfPage) === n) ?? null
    if (!target) {
      let bestLePage = -Infinity
      for (const el of blocks) {
        const p = Number(el.dataset.pdfPage)
        if (p <= n && p >= bestLePage) {
          bestLePage = p
          target = el
        }
      }
    }
    if (!target) target = blocks[0]

    // 初次加载 PDF 第 1 页且左栏处于顶部时，仅记录页码并高亮块，不跳越卷首折叠说明
    if (this.lastMdSyncedPage === 0 && n === 1 && this.mdPaneEl.scrollTop === 0) {
      this.setActiveBlock(target)
      this.lastMdSyncedPage = 1
      return
    }

    const currentBlock = this.getCurrentMdBlock(blocks)
    if (
      currentBlock &&
      Number(currentBlock.dataset.pdfPage) === Number(target.dataset.pdfPage)
    ) {
      this.setActiveBlock(currentBlock)
      this.lastMdSyncedPage = n
      return
    }

    this.setActiveBlock(target)
    this.lastMdSyncedPage = n
    const top = target.offsetTop - 12
    if (Math.abs(this.mdPaneEl.scrollTop - top) > 48) {
      this.lockSync('pdf', 700)
      this.mdPaneEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }
  }

  /**
   * 右栏 PDF 划选文字 → 反查左栏对应文本节点并包裹精确 <mark class="cmp-inline-hl"> 高亮
   */
  private onPdfSelect(text: string, pdfPage: number, context: SelectionContext): void {
    if (normalizeText(text).length === 0) return
    this.clearMarkdownInlineHighlights()

    const allBlocks = Array.from(this.articleEl.querySelectorAll<HTMLElement>('.cmp-block'))
    if (!allBlocks.length) return

    const pagedBlocks = allBlocks.filter((b) => Number(b.dataset.pdfPage) > 0)

    let bestBlock: HTMLElement | null = null
    let bestNodes: Text[] = []
    let bestSlices: { segIdx: number; startOffset: number; endOffset: number }[] = []
    let bestScore = -1

    const searchGroup = (group: HTMLElement[], minRequiredScore = 0) => {
      for (const blockEl of group) {
        const bodyEl =
          blockEl.querySelector<HTMLElement>('.cmp-block-body') ?? blockEl
        const textNodes = this.collectBlockTextNodes(bodyEl)
        if (!textNodes.length) continue
        const strs = textNodes.map((n) => n.nodeValue || '')
        const matched = matchSegmentSlices(strs, text, context)
        if (!matched || matched.slices.length === 0) continue
        if (matched.score < minRequiredScore) continue

        const pageBonus = Number(blockEl.dataset.pdfPage) === pdfPage ? 150 : 0
        const totalScore = matched.score + pageBonus
        if (totalScore > bestScore) {
          bestScore = totalScore
          bestBlock = blockEl
          bestNodes = textNodes
          bestSlices = matched.slices
        }
      }
    }

    if (pagedBlocks.length > 0) {
      // 有明确页标时：优先精确搜当前对应页块；仅当当前页无完整命中时才检查相邻页，绝不跨全书乱跳或误展开卷首说明
      const samePageBlocks = pagedBlocks.filter(
        (b) => Number(b.dataset.pdfPage) === pdfPage
      )
      searchGroup(samePageBlocks)
      if (!bestBlock || bestScore < 650) {
        const neighborBlocks = pagedBlocks.filter(
          (b) => Math.abs(Number(b.dataset.pdfPage) - pdfPage) === 1
        )
        searchGroup(neighborBlocks, samePageBlocks.length > 0 ? 850 : 500)
      }
    } else {
      // 无页标笔记才检索全篇
      searchGroup(allBlocks)
    }

    if (!bestBlock || bestSlices.length === 0) {
      new Notice(`Markdown 第 ${pdfPage} 页中未找到与选中内容匹配的文本`)
      return
    }

    const targetBlock = bestBlock as HTMLElement
    this.setActiveBlock(targetBlock)

    const detailsEl = targetBlock.querySelector<HTMLDetailsElement>('.cmp-lead-details')
    if (detailsEl && !detailsEl.open) {
      detailsEl.open = true
    }

    let firstMark: HTMLElement | null = null
    // 逆序包裹匹配的 DOM Text 节点切片，避免切分前序节点影响后续偏移量
    const reversed = [...bestSlices].sort((a, b) => b.segIdx - a.segIdx)
    for (const s of reversed) {
      const node = bestNodes[s.segIdx]
      if (!node || !node.parentNode) continue
      const len = node.nodeValue?.length ?? 0
      const start = Math.max(0, Math.min(s.startOffset, len))
      const end = Math.max(start, Math.min(s.endOffset, len))
      if (end <= start) continue

      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      const mark = document.createElement('mark')
      mark.className = 'cmp-inline-hl'
      try {
        range.surroundContents(mark)
        firstMark = mark
      } catch {
        // ignore if range crosses element boundary
      }
    }

    this.lockSync('pdf', 900)
    if (firstMark) {
      const paneRect = this.mdPaneEl.getBoundingClientRect()
      const markRect = firstMark.getBoundingClientRect()
      const margin = Math.min(72, this.mdPaneEl.clientHeight * 0.14)
      const alreadyVisible =
        markRect.top >= paneRect.top + margin &&
        markRect.bottom <= paneRect.bottom - margin
      if (!alreadyVisible) {
        const targetScroll =
          this.mdPaneEl.scrollTop +
          (markRect.top - paneRect.top) -
          this.mdPaneEl.clientHeight * 0.32
        this.mdPaneEl.scrollTo({
          top: Math.max(0, targetScroll),
          behavior: 'smooth',
        })
      }
    } else {
      const top = targetBlock.offsetTop - 16
      if (Math.abs(this.mdPaneEl.scrollTop - top) > 48) {
        this.mdPaneEl.scrollTo({
          top: Math.max(0, top),
          behavior: 'smooth',
        })
      }
    }
  }

  promptBindPdf(): void {
    if (!this.mdFile) {
      new Notice('当前没有已加载的 Markdown 笔记')
      return
    }
    const targetMd = this.mdFile
    new PdfSuggestModal(this.app, async (chosenPdf) => {
      if (!this.mdFile || this.mdFile.path !== targetMd.path) return
      const key = this.plugin.settings.frontmatterKeys[0] || 'pdf'
      let updatedRaw = ''
      await this.app.vault.process(targetMd, (raw) => {
        updatedRaw = upsertFrontmatterPdf(raw, chosenPdf.path, key)
        return updatedRaw
      })
      new Notice(`已绑定 ${chosenPdf.name}`)
      await this.loadMarkdownFile(targetMd, true, chosenPdf, updatedRaw)
    }).open()
  }

  async autoPaginateFromPdf(triggerBtn?: HTMLButtonElement): Promise<void> {
    if (!this.mdFile) {
      new Notice('当前没有已加载的 Markdown 笔记')
      return
    }
    if (!this.pdfFile || !this.pdfController || this.pdfController.totalPages < 1) {
      new Notice('请先为当前笔记绑定并加载配对的 PDF 原件')
      return
    }

    const prevText = triggerBtn?.textContent ?? ''
    if (triggerBtn) {
      triggerBtn.disabled = true
      triggerBtn.setText('正在匹配分页…')
    }

    try {
      const pageTexts = await this.pdfController.extractAllPageTexts()
      if (pageTexts.length === 0 || pageTexts.every((t) => !t.trim())) {
        new Notice('当前 PDF 未检测到可提取的文字层，无法自动匹配分页')
        return
      }

      const targetMd = this.mdFile
      let insertedCount = 0
      let nextRaw = ''
      await this.app.vault.process(targetMd, (raw) => {
        const opts = this.getPagemarkOptions(raw)
        const res = autoInsertPagemarks(raw, pageTexts, opts)
        insertedCount = res.insertedCount
        nextRaw = res.markdown
        return res.markdown
      })

      if (insertedCount > 0) {
        new Notice(`已根据 PDF 自动插入 ${insertedCount} 处页标`)
        await this.renderMarkdownBlocks(nextRaw, false)
      } else {
        new Notice('未能找到新的分页匹配位置（可能已存在完整页标或正文与 PDF 差异过大）')
      }
    } finally {
      if (triggerBtn && triggerBtn.isConnected) {
        triggerBtn.disabled = false
        triggerBtn.setText(prevText)
      }
    }
  }
}
