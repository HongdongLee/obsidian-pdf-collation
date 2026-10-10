import { loadPdfJs } from 'obsidian'
import { matchPdfTextSlices } from './compare'
import {
  buildTextLayer,
  computeSliceHighlightBoxes,
  createHighlightRectFromBox,
  createPageContainer,
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
  private baseMeta: PageMeta = { w: 612, h: 792 }
  private scale = 1
  private zoomFactor = 1
  private pageSizes: PageMeta[] = []
  private containers = new Map<number, HTMLDivElement>()
  private rendered = new Map<number, { renderTask?: any; textLayerTask?: any }>()
  private rendering = new Set<number>()
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
    this.badgeEl.style.display = 'none'
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

  containsNode(node: Node | null): boolean {
    return !!node && this.paneEl.contains(node)
  }

  async load(resourceUrl: string): Promise<void> {
    this.cleanupDoc()
    this.statusEl.className = 'pdf-status'
    this.statusEl.textContent = 'PDF 载入中…'
    this.statusEl.style.display = 'block'
    this.badgeEl.style.display = 'none'

    try {
      const pdfjs: any = await loadPdfJs()
      if (this.destroyed) return
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
      if (this.destroyed) {
        doc.destroy?.()
        return
      }

      this.doc = doc
      this.numPages = doc.numPages
      const page1 = await doc.getPage(1)
      const vp1 = page1.getViewport({ scale: 1 })
      this.baseMeta = { w: vp1.width, h: vp1.height }
      this.computeScale()
      this.pageSizes = Array.from({ length: doc.numPages }, () => ({
        w: vp1.width,
        h: vp1.height,
      }))

      this.innerEl.replaceChildren()
      this.containers.clear()
      for (let i = 1; i <= doc.numPages; i++) {
        const c = createPageContainer(i)
        this.innerEl.append(c)
        this.containers.set(i, c)
        this.layoutPage(i)
      }

      this.statusEl.style.display = 'none'
      this.badgeEl.style.display = 'block'
      this.setupResizeObserver()
      this.updateVisible()
    } catch (e: any) {
      if (this.destroyed) return
      this.statusEl.className = 'pdf-status pdf-err'
      this.statusEl.textContent = `PDF 载入失败 (${e?.message || String(e)})`
      this.statusEl.style.display = 'block'
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

  /**
   * 在目标页（优先当前对应页及相邻页，未命中时自动检索全篇）查找并高亮精确字符区间
   */
  async highlightOnPage(
    preferredPage: number,
    text: string,
    context?: SelectionContext
  ): Promise<HighlightResult> {
    if (!this.doc || this.numPages < 1) return { page: preferredPage, count: 0 }

    const clampedPref = Math.max(1, Math.min(preferredPage || 1, this.numPages))
    const priorityPages: number[] = [clampedPref]
    if (clampedPref + 1 <= this.numPages) priorityPages.push(clampedPref + 1)
    if (clampedPref - 1 >= 1) priorityPages.push(clampedPref - 1)

    let bestHit: { page: number; slices: PdfMatchedSlice[]; score: number } | null = null

    for (const p of priorityPages) {
      const items = await this.getPageItems(p)
      const matched = matchPdfTextSlices(items, text, context)
      if (!matched || matched.slices.length === 0) continue
      const pageBonus = p === clampedPref ? 15 : 0
      const totalScore = matched.score + pageBonus
      if (!bestHit || totalScore > bestHit.score) {
        bestHit = { page: p, slices: matched.slices, score: totalScore }
      }
    }

    // 若优先页及相邻页未找到，检索全篇其余页
    if (!bestHit) {
      const visited = new Set(priorityPages)
      for (let p = 1; p <= this.numPages; p++) {
        if (visited.has(p)) continue
        const items = await this.getPageItems(p)
        const matched = matchPdfTextSlices(items, text, context)
        if (!matched || matched.slices.length === 0) continue
        if (!bestHit || matched.score > bestHit.score) {
          bestHit = { page: p, slices: matched.slices, score: matched.score }
        }
      }
    }

    if (!bestHit) {
      this.scrollToPage(clampedPref, true)
      return { page: clampedPref, count: 0 }
    }

    const { page: targetPage, slices } = bestHit
    this.activeHighlight = { page: targetPage, slices }

    if (targetPage !== this.curPage) {
      this.scrollToPage(targetPage)
    }
    await this.renderPage(targetPage)
    await this.drawHighlightOnRenderedPage(targetPage, slices, true)

    return { page: targetPage, count: slices.length }
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

    const pageEl = el0.closest('.pdf-page-c') as HTMLElement | null
    const page = Number(pageEl?.dataset.page) || this.curPage || 1
    const textLayerEl = pageEl?.querySelector('.textLayer') as HTMLElement | null

    let before = ''
    let after = ''
    if (textLayerEl) {
      try {
        const preRange = document.createRange()
        preRange.selectNodeContents(textLayerEl)
        preRange.setEnd(range.startContainer, range.startOffset)
        before = preRange.toString().slice(-60)

        const postRange = document.createRange()
        postRange.selectNodeContents(textLayerEl)
        postRange.setStart(range.endContainer, range.endOffset)
        after = postRange.toString().slice(0, 60)
      } catch {
        // ignore range boundary errors
      }
    }

    // 在 PDF 当前页同步绘制持久黄框，使左右两栏同时呈现清晰的对位高亮
    void this.getPageItems(page).then(async (items) => {
      const matched = matchPdfTextSlices(items, text, { before, after })
      if (matched && matched.slices.length > 0) {
        this.activeHighlight = { page, slices: matched.slices }
        await this.drawHighlightOnRenderedPage(page, matched.slices, false)
      }
    })

    this.callbacks.onPdfSelect(text, page, { before, after })
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
    for (const box of boxes) {
      if (box.top < minTop) minTop = box.top
      wrap.append(createHighlightRectFromBox(box))
    }
    c.append(wrap)

    if (scrollIntoCenter && Number.isFinite(minTop)) {
      const targetScroll = Math.max(0, c.offsetTop + minTop - this.paneEl.clientHeight * 0.35)
      this.paneEl.scrollTo({ top: targetScroll, behavior: 'smooth' })
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
    const width = this.paneEl.clientWidth || 600
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
    const prev = this.scale
    const next = this.computeScale()
    if (Math.abs(next - prev) < 0.01) return false

    for (const n of Array.from(this.rendered.keys())) this.clearPageDom(n)
    for (const n of Array.from(this.rendering)) this.clearPageDom(n)
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
    c.style.setProperty('--scale-round-x', '1px')
    c.style.setProperty('--scale-round-y', '1px')
  }

  private clearPageDom(n: number): void {
    const c = this.containers.get(n)
    if (!c) return
    const r = this.rendered.get(n)
    const hadTask = !!r?.renderTask
    try {
      r?.renderTask?.cancel?.()
      r?.textLayerTask?.cancel?.()
    } catch {
      // ignore
    }
    this.rendered.delete(n)
    this.pageSpans.delete(n)
    for (const child of Array.from(c.querySelectorAll('canvas, .textLayer, .pdf-hl-wrap'))) {
      child.remove()
    }
    if (hadTask && !this.destroyed) this.scheduleUpdate()
  }

  private async renderPage(n: number): Promise<void> {
    if (!this.doc || n < 1 || n > this.numPages) return
    if (this.rendering.has(n) || this.rendered.has(n)) return
    this.rendering.add(n)

    try {
      const page = await this.doc.getPage(n)
      const vp1 = page.getViewport({ scale: 1 })
      if (
        Math.abs(vp1.width - this.baseMeta.w) > 2 ||
        Math.abs(vp1.height - this.baseMeta.h) > 2
      ) {
        this.pageSizes[n - 1] = { w: vp1.width, h: vp1.height }
        this.layoutPage(n, this.pageSizes[n - 1])
      }

      const c = this.containers.get(n)
      if (!c) return
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
      const entry: { renderTask?: any; textLayerTask?: any } = { renderTask }
      this.rendered.set(n, entry)
      await renderTask.promise

      const tc = await this.getPageTextContent(n)
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
      if (
        e?.name !== 'RenderingCancelledException' &&
        e?.name !== 'AbortException' &&
        !String(e?.message || '').includes('cancel')
      ) {
        console.warn(`PDF 第 ${n} 页渲染异常`, e)
      }
    } finally {
      this.rendering.delete(n)
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
