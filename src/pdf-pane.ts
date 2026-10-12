import { loadPdfJs } from 'obsidian'
import { matchPdfTextSlices, normalizeText } from './compare'
import {
  buildTextLayer,
  computeSliceHighlightBoxes,
  createHighlightRectFromBox,
  createPageContainer,
  isPdfTextItem,
} from './pdf-dom'
import type { PdfMatchedSlice, SelectionContext } from './types'

interface PageMeta {
  w: number
  h: number
}

export interface PdfPaneCallbacks {
  onPageChange: (page: number, totalPages: number) => void
  onPdfSelect: (selectedText: string, page: number, context: SelectionContext) => void
}

export interface HighlightOptions extends SelectionContext {
  /**
   * 当 Markdown 笔记存在明确页标时设为 true：
   * 仅在指定页（及首尾跨页断句时的相邻页）内查找，绝不跳转到全书其它页码
   */
  strictPage?: boolean
}

export interface HighlightResult {
  page: number
  count: number
}

/**
 * 原生 DOM 驱动的虚拟化 PDF 渲染面板（复用 Obsidian 内置 loadPdfJs、TextLayer 与 cmaps 字体库）
 */
export class PdfPaneController {
  private wrapEl: HTMLDivElement
  private paneEl: HTMLDivElement
  private innerEl: HTMLDivElement
  private statusEl: HTMLDivElement
  private badgeEl: HTMLDivElement

  private pdfjs: any = null
  private doc: any = null
  private loadSeq = 0
  private currentResourceUrl = ''
  private baseMeta: PageMeta = { w: 612, h: 792 }
  private scale = 1
  private zoomFactor = 1
  private pageSizes: PageMeta[] = []
  private containers = new Map<number, HTMLDivElement>()
  private rendered = new Map<
    number,
    { cancelled?: boolean; renderTask?: any; textLayerTask?: any }
  >()
  private rendering = new Map<number, Promise<void>>()
  private textContentCache = new Map<number, any>()
  private itemsCache = new Map<number, readonly unknown[]>()
  private pageSpans = new Map<number, readonly (HTMLElement | null)[]>()
  private activeHighlight: { page: number; slices: PdfMatchedSlice[] } | null = null
  private curPage = 0
  private numPages = 0
  private updateTimer = 0
  private resizeObserver: ResizeObserver | null = null
  private destroyed = false
  private callbacks: PdfPaneCallbacks

  constructor(parentEl: HTMLElement, callbacks: PdfPaneCallbacks) {
    this.callbacks = callbacks

    this.wrapEl = document.createElement('div')
    this.wrapEl.className = 'pdf-wrap'

    this.paneEl = document.createElement('div')
    this.paneEl.className = 'cmp-pane pdf-pane'

    this.innerEl = document.createElement('div')
    this.innerEl.className = 'pdf-pane-inner'
    this.paneEl.append(this.innerEl)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'pdf-status'
    this.statusEl.textContent = 'PDF 载入中…'
    this.paneEl.append(this.statusEl)

    this.badgeEl = document.createElement('div')
    this.badgeEl.className = 'pdf-badge'
    this.badgeEl.classList.add('cmp-hidden')
    this.wrapEl.append(this.paneEl, this.badgeEl)

    parentEl.append(this.wrapEl)

    this.paneEl.addEventListener('scroll', () => this.scheduleUpdate())
  }

  get totalPages(): number {
    return this.numPages
  }

  get currentPage(): number {
    return this.curPage || 1
  }

  get zoomPercent(): number {
    return Math.round(this.zoomFactor * 100)
  }

  get loadedResourceUrl(): string {
    return this.currentResourceUrl
  }

  containsNode(node: Node | null): boolean {
    return !!node && this.paneEl.contains(node)
  }

  clear(message = '未找到配对的 PDF 原件，点击顶部「绑定 PDF」可手动关联'): void {
    ++this.loadSeq
    this.currentResourceUrl = ''
    this.cleanupDoc()
    this.innerEl.replaceChildren()
    this.paneEl.scrollTop = 0
    this.badgeEl.classList.add('cmp-hidden')
    this.statusEl.className = 'pdf-status'
    this.statusEl.textContent = message
    this.statusEl.classList.remove('cmp-hidden')
  }

  async load(resourceUrl: string): Promise<void> {
    const seq = ++this.loadSeq
    this.currentResourceUrl = resourceUrl
    this.cleanupDoc()
    this.innerEl.replaceChildren()
    this.paneEl.scrollTop = 0
    this.statusEl.className = 'pdf-status'
    this.statusEl.textContent = 'PDF 载入中…'
    this.statusEl.classList.remove('cmp-hidden')
    this.badgeEl.classList.add('cmp-hidden')

    try {
      const pdfjs: any = await loadPdfJs()
      if (this.destroyed || seq !== this.loadSeq) return
      this.pdfjs = pdfjs

      if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = '/lib/pdfjs/pdf.worker.min.mjs'
      }

      // 挂载 Obsidian 内置的 CMap 与标准字体库，确保知网/古籍等非内嵌 CJK 字体完整渲染
      const loadingTask = pdfjs.getDocument({
        url: resourceUrl,
        cMapUrl: '/lib/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/lib/pdfjs/standard_fonts/',
        wasmUrl: '/lib/pdfjs/wasm/',
        iccUrl: '/lib/pdfjs/iccs/',
        isEvalSupported: false,
      })
      const doc = await loadingTask.promise
      if (this.destroyed || seq !== this.loadSeq) {
        doc.destroy?.()
        return
      }

      this.doc = doc
      this.numPages = doc.numPages
      const page1 = await doc.getPage(1)
      const page2 = doc.numPages >= 2 ? await doc.getPage(2) : null
      if (this.destroyed || seq !== this.loadSeq) {
        doc.destroy?.()
        return
      }
      const vp1 = page1.getViewport({ scale: 1 })
      const vp2 = page2 ? page2.getViewport({ scale: 1 }) : vp1
      this.baseMeta = { w: Math.max(vp1.width, vp2.width), h: vp2.height }
      this.pageSizes = Array.from({ length: doc.numPages }, (_, idx) =>
        idx === 0
          ? { w: vp1.width, h: vp1.height }
          : { w: vp2.width, h: vp2.height }
      )

      for (const n of Array.from(this.rendered.keys())) this.clearPageDom(n)
      for (const n of Array.from(this.rendering.keys())) this.clearPageDom(n)
      this.innerEl.replaceChildren()
      this.containers.clear()
      for (let i = 1; i <= doc.numPages; i++) {
        const c = createPageContainer(i)
        this.innerEl.append(c)
        this.containers.set(i, c)
      }

      this.paneEl.scrollTop = 0
      this.statusEl.classList.add('cmp-hidden')
      this.badgeEl.classList.remove('cmp-hidden')

      // 先布局一次撑开滚动高度，若纵向滚动条出现导致 clientWidth 变化则立即二次收敛缩放，避免首屏刚启动渲染就被 ensureScale 打断
      const initialScale = this.computeScale()
      for (let i = 1; i <= doc.numPages; i++) {
        this.layoutPage(i)
      }
      if (Math.abs(this.computeScale() - initialScale) >= 0.005) {
        for (let i = 1; i <= doc.numPages; i++) {
          this.layoutPage(i)
        }
      }

      this.setupResizeObserver()
      this.updateVisible()
    } catch (e: any) {
      if (this.destroyed || seq !== this.loadSeq) return
      this.currentResourceUrl = ''
      this.statusEl.className = 'pdf-status pdf-err'
      this.statusEl.textContent = `PDF 载入失败 (${e?.message || String(e)})`
      this.statusEl.classList.remove('cmp-hidden')
    }
  }

  adjustZoom(delta: number): number {
    this.zoomFactor = Math.max(0.6, Math.min(2.4, Math.round((this.zoomFactor + delta) * 20) / 20))
    this.forceRescale()
    return this.zoomPercent
  }

  resetZoom(): number {
    this.zoomFactor = 1
    this.forceRescale()
    return this.zoomPercent
  }

  scrollToPage(n: number, smooth = false): void {
    if (!this.numPages) return
    const target = Math.max(1, Math.min(n, this.numPages))
    const c = this.containers.get(target)
    if (!c) return
    this.paneEl.scrollTo({
      top: Math.max(0, c.offsetTop - 8),
      behavior: smooth ? 'smooth' : 'auto',
    })
    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer)
      this.updateTimer = 0
    }
    this.updateVisible()
  }

  clearHighlight(): void {
    this.activeHighlight = null
    for (const old of Array.from(this.innerEl.querySelectorAll('.pdf-hl-wrap'))) {
      old.remove()
    }
  }

  private isPageVisibleInViewport(pageNumber: number): boolean {
    const c = this.containers.get(pageNumber)
    if (!c) return false
    const viewTop = this.paneEl.scrollTop
    const viewBottom = viewTop + this.paneEl.clientHeight
    const pageTop = c.offsetTop
    const pageBottom = pageTop + c.offsetHeight
    return pageBottom > viewTop + 48 && pageTop < viewBottom - 48
  }

  /**
   * 在目标页查找并高亮精确字符区间。
   * 当 strictPage 为 true（笔记含明确页标）时严格锁定在当前对应页（仅当本页无完整命中时才检查相邻页），绝不跨全书乱跳
   */
  async highlightOnPage(
    preferredPage: number,
    text: string,
    options?: HighlightOptions
  ): Promise<HighlightResult> {
    if (!this.doc || this.numPages < 1) return { page: preferredPage, count: 0 }

    const clampedPref = Math.max(1, Math.min(preferredPage || 1, this.numPages))
    const strictPage = options?.strictPage ?? false

    let bestHit: { page: number; slices: PdfMatchedSlice[]; score: number } | null = null

    const prefItems = await this.getPageItems(clampedPref)
    const prefMatched = matchPdfTextSlices(prefItems, text, options)
    if (prefMatched && prefMatched.slices.length > 0) {
      bestHit = {
        page: clampedPref,
        slices: prefMatched.slices,
        score: prefMatched.score + 150,
      }
    }

    // 仅当优先页未命中（或仅命中残缺断句 score < 500）时，才探测紧邻的前后各一页（处理跨页断句）
    if (!bestHit || bestHit.score < 650) {
      const neighborPages: number[] = []
      if (clampedPref + 1 <= this.numPages) neighborPages.push(clampedPref + 1)
      if (clampedPref - 1 >= 1) neighborPages.push(clampedPref - 1)

      for (const p of neighborPages) {
        const items = await this.getPageItems(p)
        const matched = matchPdfTextSlices(items, text, options)
        if (!matched || matched.slices.length === 0) continue
        // 在严格页码模式下，相邻页必须具备高置信度（精确命中或强上下文夹逼）才允许采纳
        if (strictPage && matched.score < 850) continue
        if (!bestHit || matched.score > bestHit.score) {
          bestHit = { page: p, slices: matched.slices, score: matched.score }
        }
      }
    }

    // 仅在无页标文档（!strictPage）且当前页及相邻页均未命中时，才检索全篇其余页的高置信精确匹配
    if (!bestHit && !strictPage) {
      const visited = new Set([clampedPref, clampedPref - 1, clampedPref + 1])
      for (let p = 1; p <= this.numPages; p++) {
        if (visited.has(p)) continue
        const items = await this.getPageItems(p)
        const matched = matchPdfTextSlices(items, text, options)
        if (!matched || matched.slices.length === 0 || matched.score < 950) continue
        if (!bestHit || matched.score > bestHit.score) {
          bestHit = { page: p, slices: matched.slices, score: matched.score }
        }
      }
    }

    if (!bestHit) {
      this.clearHighlight()
      if (!this.isPageVisibleInViewport(clampedPref)) {
        this.scrollToPage(clampedPref, true)
      }
      return { page: clampedPref, count: 0 }
    }

    const { page: targetPage, slices } = bestHit
    this.activeHighlight = { page: targetPage, slices }

    await this.renderPage(targetPage)
    await this.drawHighlightOnRenderedPage(targetPage, slices, true)

    return { page: targetPage, count: slices.length }
  }

  private extractDirectPdfSelectionSlices(
    page: number,
    range: Range,
    items: readonly unknown[]
  ): PdfMatchedSlice[] | null {
    const spans = this.pageSpans.get(page)
    if (!spans || spans.length === 0) return null

    const slices: PdfMatchedSlice[] = []
    for (let idx = 0; idx < spans.length; idx++) {
      const span = spans[idx]
      const item = items[idx]
      if (!span || !span.isConnected || !isPdfTextItem(item) || !item.str) continue
      if (!range.intersectsNode(span)) continue

      const textNode = span.firstChild
      const len = item.str.length
      let startOffset = 0
      let endOffset = len

      if (textNode) {
        if (range.startContainer === textNode || range.startContainer === span) {
          startOffset = Math.max(0, Math.min(len, range.startOffset))
        }
        if (range.endContainer === textNode || range.endContainer === span) {
          endOffset = Math.max(startOffset, Math.min(len, range.endOffset))
        }
      }

      if (endOffset > startOffset) {
        slices.push({
          itemIdx: idx,
          item,
          startOffset,
          endOffset,
        })
      }
    }

    return slices.length > 0 ? slices : null
  }

  /**
   * 处理用户在 PDF 面板内的鼠标划选：提取选中文字与前后上下文，在 PDF 本地保持高亮，并通知左栏高亮对应文本
   */
  handlePdfSelectionFromWindow(sel: Selection): boolean {
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    const common = range.commonAncestorContainer
    const el0 = common.nodeType === 3 ? common.parentElement : (common as HTMLElement)
    if (!el0 || !this.paneEl.contains(el0)) return false

    const text = sel.toString().trim()
    if (text.length < 1) return false

    const startNode = range.startContainer
    const startEl =
      startNode.nodeType === 3 ? startNode.parentElement : (startNode as HTMLElement)
    const endNode = range.endContainer
    const endEl = endNode.nodeType === 3 ? endNode.parentElement : (endNode as HTMLElement)

    const pageEl =
      (startEl?.closest('.pdf-page-c') as HTMLElement | null) ??
      (endEl?.closest('.pdf-page-c') as HTMLElement | null) ??
      (el0.closest('.pdf-page-c') as HTMLElement | null)
    const page = Number(pageEl?.dataset.page) || this.curPage || 1
    const textLayerEl = pageEl?.querySelector('.textLayer') as HTMLElement | null

    let before = ''
    let after = ''
    let progress: number | undefined
    if (textLayerEl) {
      try {
        const preRange = document.createRange()
        preRange.selectNodeContents(textLayerEl)
        preRange.setEnd(range.startContainer, range.startOffset)
        const rawBefore = preRange.toString()
        before = rawBefore.slice(-80)

        const postRange = document.createRange()
        postRange.selectNodeContents(textLayerEl)
        postRange.setStart(range.endContainer, range.endOffset)
        const rawAfter = postRange.toString()
        after = rawAfter.slice(0, 80)

        const bLen = normalizeText(rawBefore).length
        const sLen = normalizeText(text).length
        const aLen = normalizeText(rawAfter).length
        const total = bLen + sLen + aLen
        if (total > 0) {
          progress = bLen / total
        }
      } catch {
        // ignore range boundary errors
      }
    }

    const directRange = range.cloneRange()
    // 在 PDF 当前页同步绘制持久黄框，优先直接读取 DOM 选区对应的 textLayer 切片，避免同页同词误判
    void this.getPageItems(page).then(async (items) => {
      const directSlices = this.extractDirectPdfSelectionSlices(page, directRange, items)
      if (directSlices && directSlices.length > 0) {
        this.activeHighlight = { page, slices: directSlices }
        await this.drawHighlightOnRenderedPage(page, directSlices, false)
        return
      }
      const matched = matchPdfTextSlices(items, text, { before, after, progress })
      if (matched && matched.slices.length > 0) {
        this.activeHighlight = { page, slices: matched.slices }
        await this.drawHighlightOnRenderedPage(page, matched.slices, false)
      }
    })

    this.callbacks.onPdfSelect(text, page, { before, after, progress })
    return true
  }

  destroy(): void {
    this.destroyed = true
    this.cleanupDoc()
    this.wrapEl.remove()
  }

  private async drawHighlightOnRenderedPage(
    targetPage: number,
    slices: readonly PdfMatchedSlice[],
    scrollIntoCenter: boolean
  ): Promise<void> {
    if (!this.doc) return
    const c = this.containers.get(targetPage)
    if (!c) return

    const page = await this.doc.getPage(targetPage)
    const vp = page.getViewport({ scale: this.scale })
    const spans = this.pageSpans.get(targetPage)

    for (const old of Array.from(this.innerEl.querySelectorAll('.pdf-hl-wrap'))) {
      old.remove()
    }

    const boxes = computeSliceHighlightBoxes(slices, spans, c, vp, this.scale)
    if (boxes.length === 0) return

    const wrap = document.createElement('div')
    wrap.className = 'pdf-hl-wrap'
    let minTop = Infinity
    let maxBottom = -Infinity
    for (const box of boxes) {
      if (box.top < minTop) minTop = box.top
      if (box.top + box.height > maxBottom) maxBottom = box.top + box.height
      wrap.append(createHighlightRectFromBox(box))
    }
    c.append(wrap)

    if (scrollIntoCenter && Number.isFinite(minTop)) {
      const hlTop = c.offsetTop + minTop
      const hlBottom = c.offsetTop + (Number.isFinite(maxBottom) ? maxBottom : minTop + 24)
      const viewTop = this.paneEl.scrollTop
      const viewHeight = this.paneEl.clientHeight
      const viewBottom = viewTop + viewHeight
      const margin = Math.min(72, viewHeight * 0.14)

      const alreadyVisible = hlTop >= viewTop + margin && hlBottom <= viewBottom - margin
      if (!alreadyVisible) {
        const targetScroll = Math.max(0, hlTop - viewHeight * 0.32)
        this.paneEl.scrollTo({ top: targetScroll, behavior: 'smooth' })
      }
      this.scheduleUpdate()
    }
  }

  private cleanupDoc(): void {
    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer)
      this.updateTimer = 0
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    for (const n of Array.from(this.rendered.keys())) {
      this.clearPageDom(n)
    }
    this.containers.clear()
    this.rendered.clear()
    this.rendering.clear()
    this.textContentCache.clear()
    this.itemsCache.clear()
    this.pageSpans.clear()
    this.activeHighlight = null
    this.pageSizes = []
    this.curPage = 0
    this.numPages = 0
    try {
      this.doc?.destroy?.()
    } catch {
      // ignore
    }
    this.doc = null
  }

  private setupResizeObserver(): void {
    this.resizeObserver?.disconnect()
    this.resizeObserver = new ResizeObserver(() => this.scheduleUpdate())
    this.resizeObserver.observe(this.paneEl)
  }

  private computeScale(): number {
    const rawWidth = this.paneEl.clientWidth
    const width = rawWidth > 0 ? rawWidth : 600
    const fit = Math.max(0.35, Math.min(3, (width - 24) / (this.baseMeta.w || 612)))
    this.scale = fit * this.zoomFactor
    return this.scale
  }

  private forceRescale(): void {
    this.scale = 0
    this.updateVisible()
  }

  private ensureScale(): boolean {
    if (!this.baseMeta.w) return false
    if (this.paneEl.clientWidth <= 0 && this.scale > 0) return false
    const prev = this.scale
    const next = this.computeScale()
    if (Math.abs(next - prev) < 0.01) return false

    for (const n of Array.from(this.rendered.keys())) this.clearPageDom(n)
    for (const n of Array.from(this.rendering.keys())) this.clearPageDom(n)
    for (const [n] of this.containers) this.layoutPage(n)
    this.curPage = 0
    return true
  }

  private layoutPage(n: number, meta?: PageMeta): void {
    const c = this.containers.get(n)
    if (!c) return
    const m = meta ?? this.pageSizes[n - 1] ?? this.baseMeta
    c.style.width = `${Math.round(m.w * this.scale)}px`
    c.style.height = `${Math.round(m.h * this.scale)}px`
    c.style.setProperty('--scale-factor', String(this.scale))
    c.style.setProperty('--total-scale-factor', String(this.scale))
  }

  private clearPageDom(n: number): void {
    const c = this.containers.get(n)
    const r = this.rendered.get(n)
    const hadTask = !!r && !r.cancelled
    if (r) {
      r.cancelled = true
      try {
        r.renderTask?.cancel?.()
        r.textLayerTask?.cancel?.()
      } catch {
        // ignore
      }
    }
    this.rendered.delete(n)
    this.rendering.delete(n)
    this.pageSpans.delete(n)
    if (c) {
      for (const child of Array.from(c.querySelectorAll('canvas, .textLayer, .pdf-hl-wrap'))) {
        child.remove()
      }
    }
    if (hadTask && !this.destroyed) this.scheduleUpdate()
  }

  private renderPage(n: number): Promise<void> {
    if (!this.doc || n < 1 || n > this.numPages) return Promise.resolve()
    const inFlight = this.rendering.get(n)
    if (inFlight) return inFlight
    if (this.rendered.has(n)) {
      const c = this.containers.get(n)
      const cv = c?.querySelector('canvas')
      if (cv && cv.width > 0 && cv.height > 0) {
        return Promise.resolve()
      }
      this.clearPageDom(n)
    }

    const entry: { cancelled?: boolean; renderTask?: any; textLayerTask?: any } = {
      cancelled: false,
    }
    this.rendered.set(n, entry)

    const promise = this.doRenderPage(n, entry).finally(() => {
      if (this.rendering.get(n) === promise) {
        this.rendering.delete(n)
      }
    })
    this.rendering.set(n, promise)
    return promise
  }

  private async doRenderPage(
    n: number,
    entry: { cancelled?: boolean; renderTask?: any; textLayerTask?: any }
  ): Promise<void> {
    const doc = this.doc
    if (!doc) return
    const isStale = () =>
      this.destroyed || this.doc !== doc || !!entry.cancelled || this.rendered.get(n) !== entry

    try {
      const page = await doc.getPage(n)
      if (isStale()) return

      const vp1 = page.getViewport({ scale: 1 })
      const curMeta = this.pageSizes[n - 1] ?? this.baseMeta
      if (
        Math.abs(vp1.width - curMeta.w) > 2 ||
        Math.abs(vp1.height - curMeta.h) > 2
      ) {
        this.pageSizes[n - 1] = { w: vp1.width, h: vp1.height }
        this.layoutPage(n, this.pageSizes[n - 1])
      }

      const c = this.containers.get(n)
      if (!c) return
      for (const old of Array.from(c.querySelectorAll('canvas, .textLayer'))) {
        old.remove()
      }

      const scale = this.scale
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const vp = page.getViewport({ scale: scale * dpr })

      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`
      c.append(canvas)

      const renderTask = page.render({
        canvasContext: canvas.getContext('2d')!,
        viewport: vp,
      })
      entry.renderTask = renderTask
      await renderTask.promise
      if (isStale()) return

      const tc = await this.getPageTextContent(n)
      if (isStale()) return

      const tl = document.createElement('div')
      tl.className = 'textLayer'
      c.append(tl)

      const cssViewport = page.getViewport({ scale })
      if (typeof this.pdfjs?.TextLayer === 'function') {
        const tlInstance = new this.pdfjs.TextLayer({
          textContentSource: tc,
          container: tl,
          viewport: cssViewport,
        })
        entry.textLayerTask = tlInstance
        await tlInstance.render()
        if (isStale()) return
        const tlItems = (tlInstance.textContentItems as readonly unknown[]) || []
        const tlDivs = (tlInstance.textDivs as readonly HTMLElement[]) || []
        if (tlItems.length > 0) {
          this.itemsCache.set(n, tlItems)
        }
        this.pageSpans.set(n, tlDivs)
      } else {
        const items = await this.getPageItems(n)
        const spans = buildTextLayer(items, cssViewport, tl)
        this.pageSpans.set(n, spans)
      }

      // 若该页存在当前激活的高亮，重绘后自动恢复
      if (this.activeHighlight && this.activeHighlight.page === n) {
        await this.drawHighlightOnRenderedPage(n, this.activeHighlight.slices, false)
      }
    } catch (e: any) {
      if (this.rendered.get(n) === entry) {
        this.rendered.delete(n)
        this.pageSpans.delete(n)
        const c = this.containers.get(n)
        if (c) {
          for (const child of Array.from(c.querySelectorAll('canvas, .textLayer'))) {
            child.remove()
          }
        }
      }
      if (
        e?.name !== 'RenderingCancelledException' &&
        e?.name !== 'AbortException' &&
        !String(e?.message || '').includes('cancel')
      ) {
        console.warn(`PDF 第 ${n} 页渲染异常`, e)
      }
    }
  }

  private async getPageTextContent(n: number): Promise<any> {
    const cached = this.textContentCache.get(n)
    if (cached) return cached
    const page = await this.doc.getPage(n)
    const tc = await page.getTextContent()
    this.textContentCache.set(n, tc)
    const rawItems = ((tc?.items as readonly unknown[]) || []).filter(
      (it: any) => it && typeof it.str === 'string'
    )
    this.itemsCache.set(n, rawItems)
    return tc
  }

  private async getPageItems(n: number): Promise<readonly unknown[]> {
    const cached = this.itemsCache.get(n)
    if (cached) return cached
    await this.getPageTextContent(n)
    return this.itemsCache.get(n) || []
  }

  async extractAllPageItems(): Promise<(readonly unknown[])[]> {
    if (!this.doc || this.numPages < 1) return []
    const pages: (readonly unknown[])[] = []
    for (let p = 1; p <= this.numPages; p++) {
      const items = await this.getPageItems(p)
      pages.push(items)
    }
    return pages
  }

  async extractAllPageTexts(): Promise<string[]> {
    if (!this.doc || this.numPages < 1) return []
    const texts: string[] = []
    for (let p = 1; p <= this.numPages; p++) {
      const items = await this.getPageItems(p)
      const pageStr = items
        .filter(isPdfTextItem)
        .map((it) => it.str)
        .join(' ')
      texts.push(pageStr)
    }
    return texts
  }

  private currentPageFromScroll(): number {
    if (!this.numPages) return 1
    const probe = this.paneEl.scrollTop + this.paneEl.clientHeight * 0.35
    let cur = 1
    for (const [n, c] of this.containers) {
      if (c.offsetTop <= probe) cur = n
      else break
    }
    return cur
  }

  private updateVisible(): void {
    if (this.destroyed || !this.doc) return
    this.ensureScale()
    const f = this.currentPageFromScroll()
    if (f !== this.curPage) {
      this.curPage = f
      this.badgeEl.textContent = `pdf. ${f} / ${this.numPages}`
      this.callbacks.onPageChange(f, this.numPages)
    }
    for (let p = f - 1; p <= f + 2; p++) {
      void this.renderPage(p)
    }
    for (const n of Array.from(this.rendered.keys())) {
      if (n < f - 3 || n > f + 3) this.clearPageDom(n)
    }
  }

  private scheduleUpdate(): void {
    if (this.updateTimer || this.destroyed) return
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = 0
      this.updateVisible()
    }, 80)
  }
}
