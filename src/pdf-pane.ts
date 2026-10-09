import { loadPdfJs } from 'obsidian'
import { matchTextSpans } from './compare'
import {
  buildTextLayer,
  createHighlightRect,
  createPageContainer,
} from './pdf-dom'

interface PageMeta {
  w: number
  h: number
}

export interface PdfPaneCallbacks {
  onPageChange: (page: number, totalPages: number) => void
  onPdfSelect: (selectedText: string, page: number) => void
}

/**
 * 原生 DOM 驱动的虚拟化 PDF 渲染面板（复用 Obsidian 内置 loadPdfJs，零外部 worker 体积）
 */
export class PdfPaneController {
  private wrapEl: HTMLDivElement
  private paneEl: HTMLDivElement
  private innerEl: HTMLDivElement
  private statusEl: HTMLDivElement
  private badgeEl: HTMLDivElement

  private doc: any = null
  private baseMeta: PageMeta = { w: 612, h: 792 }
  private scale = 1
  private zoomFactor = 1
  private pageSizes: PageMeta[] = []
  private containers = new Map<number, HTMLDivElement>()
  private rendered = new Map<number, { renderTask?: any }>()
  private rendering = new Set<number>()
  private itemsCache = new Map<number, readonly unknown[]>()
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
    this.paneEl.addEventListener('mouseup', () => this.handleMouseUp())
  }

  get totalPages(): number {
    return this.numPages
  }

  get currentPage(): number {
    return this.curPage || 1
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

      const loadingTask = pdfjs.getDocument(resourceUrl)
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

  adjustZoom(delta: number): void {
    this.zoomFactor = Math.max(0.6, Math.min(2.4, Math.round((this.zoomFactor + delta) * 10) / 10))
    this.forceRescale()
  }

  resetZoom(): void {
    this.zoomFactor = 1
    this.forceRescale()
  }

  scrollToPage(n: number): void {
    if (!this.numPages) return
    const target = Math.max(1, Math.min(n, this.numPages))
    const c = this.containers.get(target)
    if (!c) return
    this.paneEl.scrollTo({ top: Math.max(0, c.offsetTop - 8) })
    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer)
      this.updateTimer = 0
    }
    this.updateVisible()
  }

  async highlightOnPage(n: number, text: string): Promise<number> {
    if (!this.doc || n < 1 || n > this.numPages) return 0
    const items = await this.getPageItems(n)
    const matched = matchTextSpans(items, text)
    if (matched.length === 0) return 0

    await this.renderPage(n)
    const page = await this.doc.getPage(n)
    const vp = page.getViewport({ scale: this.scale })
    const c = this.containers.get(n)
    if (!c) return 0

    for (const old of Array.from(c.querySelectorAll('.pdf-hl-wrap'))) {
      old.remove()
    }

    const wrap = document.createElement('div')
    wrap.className = 'pdf-hl-wrap'
    for (const item of matched) {
      wrap.append(createHighlightRect(item, vp, this.scale))
    }
    c.append(wrap)
    window.setTimeout(() => wrap.remove(), 6000)
    return matched.length
  }

  destroy(): void {
    this.destroyed = true
    this.cleanupDoc()
    this.wrapEl.remove()
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
    this.itemsCache.clear()
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
    const fit = Math.max(0.35, Math.min(3, (width - 28) / (this.baseMeta.w || 612)))
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
  }

  private clearPageDom(n: number): void {
    const c = this.containers.get(n)
    if (!c) return
    const r = this.rendered.get(n)
    const hadTask = !!r?.renderTask
    try {
      r?.renderTask?.cancel?.()
    } catch {
      // ignore
    }
    this.rendered.delete(n)
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
      this.rendered.set(n, { renderTask })
      await renderTask.promise

      const items = await this.getPageItems(n)
      const tl = document.createElement('div')
      tl.className = 'textLayer'
      c.append(tl)
      buildTextLayer(items, page.getViewport({ scale }), tl)
    } catch (e: any) {
      if (
        e?.name !== 'RenderingCancelledException' &&
        !String(e?.message || '').includes('cancel')
      ) {
        console.warn(`PDF 第 ${n} 页渲染异常`, e)
      }
    } finally {
      this.rendering.delete(n)
    }
  }

  private async getPageItems(n: number): Promise<readonly unknown[]> {
    const cached = this.itemsCache.get(n)
    if (cached) return cached
    const page = await this.doc.getPage(n)
    const tc = await page.getTextContent()
    const items = (tc?.items as readonly unknown[]) || []
    this.itemsCache.set(n, items)
    return items
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
    }, 100)
  }

  private handleMouseUp(): void {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const anchor = sel.anchorNode
    if (!anchor || !this.paneEl.contains(anchor)) return
    const text = sel.toString().trim()
    if (text.length < 2) return
    const pageEl = (
      anchor.nodeType === 3 ? anchor.parentElement : (anchor as HTMLElement)
    )?.closest('.pdf-page-c') as HTMLElement | null
    const page = Number(pageEl?.dataset.page) || this.curPage || 1
    this.callbacks.onPdfSelect(text, page)
  }
}
