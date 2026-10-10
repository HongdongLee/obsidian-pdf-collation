import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian'
import {
  decoratePagemarksInBlock,
  matchSegmentSlices,
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
    window.clearTimeout(this.syncLockTimer)
    window.clearTimeout(this.mdScrollTimer)
    window.clearTimeout(this.selectionSettleTimer)
    this.pdfController?.destroy()
    this.pdfController = null
  }

  async loadMarkdownFile(file: TFile): Promise<void> {
    this.mdFile = file
    ;(this.leaf as any).updateHeader?.()
    this.crumbEl.setText(file.basename)
    this.crumbEl.setAttr('title', file.path)

    this.pdfFile = resolvePairedPdf(this.app, file, this.plugin.settings)
    if (this.pdfFile) {
      this.pdfStatusBtn.setText('PDF 已配对')
      this.pdfStatusBtn.setAttr('title', `当前绑定 PDF：${this.pdfFile.path}（点击可换绑）`)
      this.pdfStatusBtn.removeClass('is-missing')
      const url = this.app.vault.getResourcePath(this.pdfFile)
      void this.pdfController?.load(url)
    } else {
      this.pdfStatusBtn.setText('绑定 PDF')
      this.pdfStatusBtn.setAttr('title', '未找到同名 PDF，点击从库中选择绑定')
      this.pdfStatusBtn.addClass('is-missing')
    }

    await this.renderMarkdownBlocks()
  }

  private lockSync(source: 'md' | 'pdf', durationMs = 480): void {
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
    const prevScroll = this.mdPaneEl.scrollTop
    const raw = await this.app.vault.read(this.mdFile)
    const opts = this.getPagemarkOptions()
    this.splitState = splitMarkdownByPagemarks(raw, opts)

    this.articleEl.empty()
    for (const block of this.splitState.blocks) {
      const sec = this.articleEl.createEl('section', { cls: 'cmp-block' })
      sec.dataset.blockIndex = String(block.index)
      if (block.pdfPage != null) {
        sec.dataset.pdfPage = String(block.pdfPage)
      } else {
        sec.addClass('cmp-block-lead')
      }
      await this.populateBlockSection(sec, block)
    }

    if (prevScroll > 0) {
      this.mdPaneEl.scrollTop = prevScroll
    }
  }

  private formatBlockTitle(block: MarkdownPageBlock): string {
    if (block.pdfPage == null) return '卷首说明与考证注记'
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
      await this.app.vault.process(this.mdFile, (currentRaw) => {
        const freshSplit = splitMarkdownByPagemarks(currentRaw, this.getPagemarkOptions())
        return replaceBlockInMarkdown(freshSplit, block.index, nextText)
      })
      new Notice(`已保存 ${this.formatBlockTitle(block)}`)
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

  /**
   * 左栏滚动 → 自动检测当前阅读的页块并同步右侧 PDF
   */
  private onMdScroll(): void {
    if (!this.follow || this.syncLockSource === 'pdf') return
    if (this.mdScrollTimer) return

    this.mdScrollTimer = window.setTimeout(() => {
      this.mdScrollTimer = 0
      if (!this.follow || this.syncLockSource === 'pdf') return

      const blocks = Array.from(
        this.articleEl.querySelectorAll<HTMLElement>('.cmp-block[data-pdf-page]')
      )
      if (!blocks.length) return

      const probe = this.mdPaneEl.scrollTop + this.mdPaneEl.clientHeight * 0.28
      let currentBlock = blocks[0]
      for (const b of blocks) {
        if (b.offsetTop <= probe) currentBlock = b
        else break
      }

      this.setActiveBlock(currentBlock)
      const page = Number(currentBlock.dataset.pdfPage)
      if (page > 0 && page !== this.lastMdSyncedPage && page !== this.pdfController?.currentPage) {
        this.lastMdSyncedPage = page
        this.lockSync('md')
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
      if (href) {
        void this.app.workspace.openLinkText(href, this.mdFile.path, true)
      }
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
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

    const range = sel.getRangeAt(0)
    const common = range.commonAncestorContainer
    const el0 = common.nodeType === 3 ? common.parentElement : (common as HTMLElement)
    if (!el0 || !this.rootEl.contains(el0)) return

    const text = sel.toString().trim()
    if (text.length < 1) return

    // 避免同一次静止选区重复触发
    const sig = `${this.mdPaneEl.contains(el0) ? 'md' : 'pdf'}:${text}:${range.startOffset}:${range.endOffset}`
    if (sig === this.lastSelectionSig) return
    this.lastSelectionSig = sig

    if (this.mdPaneEl.contains(el0)) {
      this.handleMdSelection(range, el0, text)
    } else if (this.pdfController?.containsNode(el0)) {
      this.pdfController.handlePdfSelectionFromWindow(sel)
    }
  }

  private handleMdSelection(range: Range, el0: HTMLElement, text: string): void {
    if (el0.closest('.cmp-inline-editor, .cmp-block-bar, .cmp-lead-summary')) return

    this.clearMarkdownInlineHighlights()

    const blockEl = el0.closest('.cmp-block') as HTMLElement | null
    if (blockEl) this.setActiveBlock(blockEl)

    const bodyEl =
      (el0.closest('.cmp-block-body') as HTMLElement | null) ?? blockEl ?? this.articleEl

    let before = ''
    let after = ''
    try {
      const preRange = document.createRange()
      preRange.selectNodeContents(bodyEl)
      preRange.setEnd(range.startContainer, range.startOffset)
      before = preRange.toString().slice(-60)

      const postRange = document.createRange()
      postRange.selectNodeContents(bodyEl)
      postRange.setStart(range.endContainer, range.endOffset)
      after = postRange.toString().slice(0, 60)
    } catch {
      // ignore range errors
    }

    const preferredPage =
      Number(blockEl?.dataset.pdfPage) || this.pdfController?.currentPage || 1

    this.lockSync('md', 900)
    this.pdfController
      ?.highlightOnPage(preferredPage, text, { before, after })
      .then((res) => {
        if (res.count === 0) {
          new Notice(`PDF 中未找到与选中内容匹配的文本`)
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

    if (!this.follow || this.syncLockSource === 'md') return

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
      const top = target.offsetTop - 12
      if (Math.abs(this.mdPaneEl.scrollTop - top) > 48) {
        this.lockSync('pdf')
        this.mdPaneEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      }
    }
  }

  /**
   * 右栏 PDF 划选文字 → 反查左栏对应文本节点并包裹精确 <mark class="cmp-inline-hl"> 高亮
   */
  private onPdfSelect(text: string, pdfPage: number, context: SelectionContext): void {
    this.clearMarkdownInlineHighlights()

    const allBlocks = Array.from(this.articleEl.querySelectorAll<HTMLElement>('.cmp-block'))
    if (!allBlocks.length) return

    const priorityBlocks = allBlocks.filter((b) => {
      const p = Number(b.dataset.pdfPage)
      return p === pdfPage || p === pdfPage - 1 || p === pdfPage + 1
    })
    const prioritySet = new Set(priorityBlocks)
    const remainingBlocks = allBlocks.filter((b) => !prioritySet.has(b))

    let bestBlock: HTMLElement | null = null
    let bestNodes: Text[] = []
    let bestSlices: { segIdx: number; startOffset: number; endOffset: number }[] = []
    let bestScore = -1

    const searchGroup = (group: HTMLElement[]) => {
      for (const blockEl of group) {
        const bodyEl =
          blockEl.querySelector<HTMLElement>('.cmp-block-body') ?? blockEl
        const textNodes = this.collectBlockTextNodes(bodyEl)
        if (!textNodes.length) continue
        const strs = textNodes.map((n) => n.nodeValue || '')
        const matched = matchSegmentSlices(strs, text, context)
        if (!matched || matched.slices.length === 0) continue

        const pageBonus = Number(blockEl.dataset.pdfPage) === pdfPage ? 15 : 0
        const totalScore = matched.score + pageBonus
        if (totalScore > bestScore) {
          bestScore = totalScore
          bestBlock = blockEl
          bestNodes = textNodes
          bestSlices = matched.slices
        }
      }
    }

    searchGroup(priorityBlocks)
    if (!bestBlock) {
      searchGroup(remainingBlocks)
    }

    if (!bestBlock || bestSlices.length === 0) {
      new Notice('Markdown 中未找到与选中内容匹配的文本')
      return
    }

    const targetBlock = bestBlock as HTMLElement
    this.setActiveBlock(targetBlock)

    // 若命中的是默认折叠的卷首导言块，自动展开
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
      const targetScroll =
        this.mdPaneEl.scrollTop + (markRect.top - paneRect.top) - this.mdPaneEl.clientHeight * 0.35
      this.mdPaneEl.scrollTo({
        top: Math.max(0, targetScroll),
        behavior: 'smooth',
      })
    } else {
      this.mdPaneEl.scrollTo({
        top: Math.max(0, targetBlock.offsetTop - 16),
        behavior: 'smooth',
      })
    }
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
      new Notice(`已绑定 ${chosenPdf.name}`)
      await this.loadMarkdownFile(this.mdFile)
    }).open()
  }
}
