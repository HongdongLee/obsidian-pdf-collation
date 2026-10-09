import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian'
import {
  decoratePagemarksInBlock,
  normalizeText,
  parsePagemark,
  replaceBlockInMarkdown,
  splitMarkdownByPagemarks,
} from './compare'
import {
  extractPageOffsetFromFrontmatter,
  resolvePairedPdf,
  upsertFrontmatterPdf,
} from './pairing'
import { PdfPaneController } from './pdf-pane'
import { PdfSuggestModal } from './pdf-suggest-modal'
import type { CollationSettings, MarkdownPageBlock, SplitMarkdownResult } from './types'

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
  private follow = false
  private swapped = false

  private rootEl!: HTMLDivElement
  private crumbEl!: HTMLDivElement
  private pdfStatusBtn!: HTMLButtonElement
  private pageJumpInput!: HTMLInputElement
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

  async setState(state: any, result: any): Promise<void> {
    await super.setState(state, result)
    if (state?.file && typeof state.file === 'string') {
      const f = this.app.vault.getAbstractFileByPath(state.file)
      if (f instanceof TFile) {
        await this.loadMarkdownFile(f)
      }
    }
  }

  getState(): Record<string, unknown> {
    return {
      file: this.mdFile?.path ?? null,
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
    this.mdPaneEl.addEventListener('mouseup', () => this.onMdMouseUp())

    this.pdfController = new PdfPaneController(this.gridEl, {
      onPageChange: (page) => this.onPdfPageChange(page),
      onPdfSelect: (text) => this.onPdfSelect(text),
    })

    // 若尚未指定文件，默认尝试加载当前活动笔记
    if (!this.mdFile) {
      const active = this.app.workspace.getActiveFile()
      if (active && active.extension.toLowerCase() === 'md') {
        await this.loadMarkdownFile(active)
      } else {
        this.renderEmpty('请先打开一篇 Markdown 笔记，再启动双轨校勘视图。')
      }
    }
  }

  async onClose(): Promise<void> {
    this.pdfController?.destroy()
    this.pdfController = null
  }

  async loadMarkdownFile(file: TFile): Promise<void> {
    this.mdFile = file
    ;(this.leaf as any).updateHeader?.()
    this.crumbEl.setText(file.path)

    this.pdfFile = resolvePairedPdf(this.app, file, this.plugin.settings)
    if (this.pdfFile) {
      this.pdfStatusBtn.setText(`PDF · ${this.pdfFile.name}`)
      this.pdfStatusBtn.removeClass('is-missing')
      const url = this.app.vault.getResourcePath(this.pdfFile)
      void this.pdfController?.load(url)
    } else {
      this.pdfStatusBtn.setText('未找到配对 PDF（点击绑定）')
      this.pdfStatusBtn.addClass('is-missing')
    }

    await this.renderMarkdownBlocks()
  }

  private buildHeader(): void {
    const head = this.rootEl.createDiv({ cls: 'collation-head' })

    const left = head.createDiv({ cls: 'collation-crumb-wrap' })
    this.crumbEl = left.createDiv({ cls: 'collation-crumb', text: '未打开笔记' })
    this.pdfStatusBtn = left.createEl('button', {
      cls: 'collation-btn collation-pdf-btn',
      text: '绑定 PDF',
      attr: { title: '点击选择或切换当前笔记绑定的 PDF 原件' },
    })
    this.pdfStatusBtn.addEventListener('click', () => this.promptBindPdf())

    const actions = head.createDiv({ cls: 'collation-actions' })

    // 页码跳转与缩放
    const jumpWrap = actions.createDiv({ cls: 'collation-jump-wrap' })
    this.pageJumpInput = jumpWrap.createEl('input', {
      cls: 'collation-page-input',
      type: 'number',
      attr: { placeholder: '页码', min: '1', title: '输入 PDF 页码回车跳转' },
    })
    this.pageJumpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = Number(this.pageJumpInput.value)
        if (n > 0) this.pdfController?.scrollToPage(n)
      }
    })

    const zoomOutBtn = actions.createEl('button', {
      cls: 'collation-btn',
      text: '−',
      attr: { title: '缩小 PDF' },
    })
    zoomOutBtn.addEventListener('click', () => this.pdfController?.adjustZoom(-0.15))

    const zoomInBtn = actions.createEl('button', {
      cls: 'collation-btn',
      text: '+',
      attr: { title: '放大 PDF' },
    })
    zoomInBtn.addEventListener('click', () => this.pdfController?.adjustZoom(0.15))

    // 滚动联动开关
    const followLabel = actions.createEl('label', {
      cls: 'collation-follow-toggle',
      attr: { title: 'PDF 滚动时，Markdown 栏自动跟随到对应页块' },
    })
    const followInput = followLabel.createEl('input', { type: 'checkbox' })
    followInput.checked = this.follow
    followLabel.appendText('滚动联动')
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
      text: '打开原笔记',
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

  private getPagemarkOptions() {
    const cache = this.mdFile ? this.app.metadataCache.getFileCache(this.mdFile) : null
    const pageOffset = extractPageOffsetFromFrontmatter(
      cache?.frontmatter as Record<string, unknown> | undefined
    )
    return {
      customPattern: this.plugin.settings.customPagemarkPattern,
      pageOffset,
    }
  }

  private async renderMarkdownBlocks(): Promise<void> {
    if (!this.mdFile) return
    const raw = await this.app.vault.read(this.mdFile)
    const opts = this.getPagemarkOptions()
    this.splitState = splitMarkdownByPagemarks(raw, opts)

    this.articleEl.empty()
    for (const block of this.splitState.blocks) {
      const sec = this.articleEl.createEl('section', { cls: 'cmp-block' })
      sec.dataset.blockIndex = String(block.index)
      if (block.pdfPage != null) {
        sec.dataset.pdfPage = String(block.pdfPage)
      }
      await this.populateBlockSection(sec, block)
    }
  }

  private async populateBlockSection(
    sec: HTMLElement,
    block: MarkdownPageBlock
  ): Promise<void> {
    sec.empty()

    const bar = sec.createDiv({ cls: 'cmp-block-bar' })
    const pageTag = bar.createSpan({
      cls: 'cmp-block-tag',
      text: block.pdfPage != null ? `pdf. ${block.pdfPage}` : '卷首 / 未标页',
    })
    if (block.pdfPage != null) {
      pageTag.addEventListener('click', (e) => {
        e.stopPropagation()
        this.pdfController?.scrollToPage(block.pdfPage!)
      })
    }

    const editBtn = bar.createEl('button', {
      cls: 'cmp-block-edit-btn',
      text: '✎ 校改本段',
      attr: { title: '就地修改当前页块的 Markdown 文本（⌘S 保存）' },
    })
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.openInlineBlockEditor(sec, block)
    })

    const bodyEl = sec.createDiv({ cls: 'cmp-block-body' })
    const decorated = decoratePagemarksInBlock(block.markdown, this.getPagemarkOptions())
    await MarkdownRenderer.render(
      this.app,
      decorated,
      bodyEl,
      this.mdFile?.path ?? '',
      this
    )
  }

  private openInlineBlockEditor(sec: HTMLElement, block: MarkdownPageBlock): void {
    if (sec.querySelector('.cmp-inline-editor')) return
    const bodyEl = sec.querySelector('.cmp-block-body') as HTMLElement | null
    if (bodyEl) bodyEl.style.display = 'none'

    const wrap = sec.createDiv({ cls: 'cmp-inline-editor' })
    const ta = wrap.createEl('textarea', { cls: 'cmp-inline-textarea' })
    ta.value = block.markdown
    ta.rows = Math.max(5, Math.min(24, block.markdown.split('\n').length + 2))

    const foot = wrap.createDiv({ cls: 'cmp-inline-foot' })
    const hint = foot.createSpan({ cls: 'cmp-inline-hint', text: '⌘S / Ctrl+S 保存，Esc 取消' })
    const cancelBtn = foot.createEl('button', { cls: 'collation-btn', text: '取消' })
    const saveBtn = foot.createEl('button', {
      cls: 'collation-btn collation-btn-accent',
      text: '保存修改',
    })

    const cancel = () => {
      wrap.remove()
      if (bodyEl) bodyEl.style.display = ''
    }

    const save = async () => {
      if (!this.mdFile || !this.splitState) return
      const nextText = ta.value
      hint.setText('保存中…')
      await this.app.vault.process(this.mdFile, (currentRaw) => {
        const freshSplit = splitMarkdownByPagemarks(currentRaw, this.getPagemarkOptions())
        return replaceBlockInMarkdown(freshSplit, block.index, nextText)
      })
      new Notice(`已保存 pdf. ${block.pdfPage ?? '卷首'} 页块修改`)
      await this.renderMarkdownBlocks()
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
  }

  private setActiveBlock(el: HTMLElement): void {
    const prev = this.articleEl.querySelector('.cmp-active')
    if (prev && prev !== el) prev.classList.remove('cmp-active')
    el.classList.add('cmp-active')
  }

  private onMdClick(e: MouseEvent): void {
    const t = e.target as HTMLElement
    const pm = t.closest('.pagemark') as HTMLElement | null
    if (pm) {
      const page =
        Number(pm.dataset.page) ||
        parsePagemark(pm.textContent || '', this.getPagemarkOptions())
      if (page) {
        this.pdfController?.scrollToPage(page)
        new Notice(`PDF 已跳转第 ${page} 页`)
        return
      }
    }

    // 处理内部 wikilink 点击跳转
    const internalLink = t.closest('a.internal-link') as HTMLAnchorElement | null
    if (internalLink && this.mdFile) {
      e.preventDefault()
      const href = internalLink.getAttribute('data-href') || internalLink.getAttribute('href')
      if (href) {
        void this.app.workspace.openLinkText(href, this.mdFile.path, true)
      }
    }
  }

  private onMdMouseUp(): void {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const anchor = sel.anchorNode
    const el0 = anchor
      ? anchor.nodeType === 3
        ? anchor.parentElement
        : (anchor as HTMLElement)
      : null
    if (!el0 || !this.mdPaneEl.contains(el0)) return
    if (el0.closest('.cmp-inline-editor')) return

    const text = sel.toString().trim()
    if (text.length < 2) return

    const blockEl = el0.closest('.cmp-block') as HTMLElement | null
    if (blockEl) this.setActiveBlock(blockEl)

    const pageStr = blockEl?.dataset.pdfPage
    if (!pageStr) {
      new Notice('当前段落未关联 PDF 页码（请添加如 [p. 1 / pdf. 1] 的页标）')
      return
    }

    const n = Number(pageStr)
    this.pdfController?.scrollToPage(n)
    this.pdfController
      ?.highlightOnPage(n, text)
      .then((count) => {
        if (count > 0) {
          new Notice(`已在 pdf. ${n} 高亮 ${count} 处对应文本`)
        } else {
          new Notice(`已跳转 pdf. ${n}（该页未精确匹配文字层，可能为纯图像扫描件）`)
        }
      })
      .catch(() => {})
  }

  private onPdfPageChange(n: number): void {
    this.pageJumpInput.value = String(n)
    if (!this.follow) return

    const blocks = Array.from(
      this.articleEl.querySelectorAll<HTMLElement>('.cmp-block[data-pdf-page]')
    )
    if (!blocks.length) return

    let target: HTMLElement | null = null
    for (const el of blocks) {
      if (Number(el.dataset.pdfPage) <= n) target = el
      else break
    }
    if (target) {
      this.setActiveBlock(target)
      const top = target.offsetTop - 60
      if (Math.abs(this.mdPaneEl.scrollTop - top) > 60) {
        this.mdPaneEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      }
    }
  }

  private onPdfSelect(text: string): void {
    const q = normalizeText(text)
    if (q.length < 2) return

    const blocks = Array.from(this.articleEl.querySelectorAll<HTMLElement>('.cmp-block'))
    for (const el of blocks) {
      if (normalizeText(el.textContent || '').includes(q)) {
        this.setActiveBlock(el)
        this.mdPaneEl.scrollTo({
          top: Math.max(0, el.offsetTop - 60),
          behavior: 'smooth',
        })
        const page = el.dataset.pdfPage
        new Notice(page ? `Markdown 已定位到 pdf. ${page} 段落` : 'Markdown 已定位对应段落')
        return
      }
    }
    new Notice('Markdown 栏未找到完全匹配文本（校订稿与 PDF 文字层存在差异）')
  }

  promptBindPdf(): void {
    if (!this.mdFile) {
      new Notice('当前没有已加载的 Markdown 笔记')
      return
    }
    new PdfSuggestModal(this.app, async (chosenPdf) => {
      if (!this.mdFile) return
      const key = this.plugin.settings.frontmatterKeys[0] || 'pdf'
      await this.app.vault.process(this.mdFile, (raw) =>
        upsertFrontmatterPdf(raw, chosenPdf.path, key)
      )
      new Notice(`已将 ${chosenPdf.name} 绑定至当前笔记 frontmatter`)
      await this.loadMarkdownFile(this.mdFile)
    }).open()
  }
}
