import type { PdfMatchedSlice, PdfTextItem, PdfViewport } from './types'

export interface HighlightBox {
  left: number
  top: number
  width: number
  height: number
}

export function isPdfTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PdfTextItem>
  return (
    typeof item.str === 'string' &&
    typeof item.width === 'number' &&
    typeof item.height === 'number' &&
    Array.isArray(item.transform) &&
    item.transform.length >= 6
  )
}

function getItemFontSize(item: PdfTextItem): number {
  const fromMatrix = Math.hypot(item.transform[2] || 0, item.transform[3] || 0)
  return Math.abs(fromMatrix || item.height || 10)
}

export function buildTextLayer(
  items: readonly unknown[],
  viewport: PdfViewport,
  container: HTMLElement
): (HTMLSpanElement | null)[] {
  container.replaceChildren()
  const frag = document.createDocumentFragment()
  const pairs: { span: HTMLSpanElement; width: number }[] = []
  const spansByItem: (HTMLSpanElement | null)[] = []

  for (let i = 0; i < items.length; i++) {
    const value = items[i]
    if (!isPdfTextItem(value) || !value.str || value.width <= 0) {
      spansByItem.push(null)
      continue
    }
    const [x, y] = viewport.convertToViewportPoint(value.transform[4], value.transform[5])
    const rawFont = getItemFontSize(value)
    const height = rawFont * viewport.scale
    const width = Math.abs(value.width) * viewport.scale
    if (height <= 0 || width <= 0) {
      spansByItem.push(null)
      continue
    }

    const span = document.createElement('span')
    span.className = 'textLayerNode'
    span.dataset.idx = String(i)
    span.textContent = value.str
    span.style.left = `${x}px`
    span.style.top = `${y - height * 0.85}px`
    span.style.fontSize = `${height}px`
    frag.append(span)
    pairs.push({ span, width })
    spansByItem.push(span)
  }

  container.append(frag)
  const measured = pairs.map(({ span }) => span.getBoundingClientRect().width)
  pairs.forEach(({ span, width }, index) => {
    if (measured[index] > 0 && Math.abs(measured[index] - width) > 0.5) {
      span.style.transform = `scaleX(${width / measured[index]})`
    }
  })
  return spansByItem
}

export function createPageContainer(pageNumber: number): HTMLDivElement {
  const container = document.createElement('div')
  container.className = 'pdf-page-c'
  container.dataset.page = String(pageNumber)

  const label = document.createElement('span')
  label.className = 'pdf-page-num'
  label.textContent = String(pageNumber)
  container.append(label)
  return container
}

function computeFallbackBox(
  slice: PdfMatchedSlice,
  viewport: PdfViewport,
  scale: number
): HighlightBox {
  const { item, startOffset, endOffset } = slice
  const strLen = Math.max(1, item.str.length)
  const fracStart = Math.max(0, Math.min(1, startOffset / strLen))
  const fracEnd = Math.max(fracStart, Math.min(1, endOffset / strLen))

  const xStartPdf = item.transform[4] + item.width * fracStart
  const xEndPdf = item.transform[4] + item.width * fracEnd
  const [x0, y0] = viewport.convertToViewportPoint(xStartPdf, item.transform[5])
  const [x1] = viewport.convertToViewportPoint(xEndPdf, item.transform[5])

  const fontHeight = getItemFontSize(item) * scale
  return {
    left: Math.min(x0, x1),
    top: y0 - fontHeight * 0.86,
    width: Math.max(4, Math.abs(x1 - x0)),
    height: Math.max(10, fontHeight * 1.12),
  }
}

/**
 * 合并同一水平行内相邻或重叠的高亮矩形，避免知网 PDF 标点拆碎成十几个零散小框
 */
export function mergeLineBoxes(boxes: HighlightBox[]): HighlightBox[] {
  if (boxes.length <= 1) return boxes
  const sorted = [...boxes].sort((a, b) => {
    const dy = a.top - b.top
    if (Math.abs(dy) > Math.min(a.height, b.height) * 0.55) return dy
    return a.left - b.left
  })

  const merged: HighlightBox[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const prev = merged[merged.length - 1]
    const sameRow = Math.abs(cur.top - prev.top) <= Math.min(cur.height, prev.height) * 0.55
    const gap = cur.left - (prev.left + prev.width)
    if (sameRow && gap <= Math.max(cur.height, prev.height) * 1.6) {
      const right = Math.max(prev.left + prev.width, cur.left + cur.width)
      const top = Math.min(prev.top, cur.top)
      const bottom = Math.max(prev.top + prev.height, cur.top + cur.height)
      prev.left = Math.min(prev.left, cur.left)
      prev.top = top
      prev.width = right - prev.left
      prev.height = bottom - top
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

/**
 * 精确计算匹配切片在 PDF 页面容器内的像素矩形：优先使用真实 textLayer DOM Range，回退至数学插值
 */
export function computeSliceHighlightBoxes(
  slices: readonly PdfMatchedSlice[],
  spans: readonly (HTMLElement | null)[] | undefined,
  pageContainer: HTMLElement,
  viewport: PdfViewport,
  scale: number
): HighlightBox[] {
  const pageRect = pageContainer.getBoundingClientRect()
  const rawBoxes: HighlightBox[] = []

  for (const slice of slices) {
    let measuredFromDom = false
    const span = spans?.[slice.itemIdx]
    let textNode: Node | null = span?.firstChild ?? null
    if (textNode && textNode.nodeType !== Node.TEXT_NODE) {
      const walker = document.createTreeWalker(span!, NodeFilter.SHOW_TEXT)
      textNode = walker.nextNode()
    }
    if (
      span &&
      span.isConnected &&
      textNode &&
      textNode.nodeType === Node.TEXT_NODE &&
      pageRect.width > 0
    ) {
      const len = textNode.nodeValue?.length ?? 0
      const s = Math.max(0, Math.min(slice.startOffset, len))
      const e = Math.max(s, Math.min(slice.endOffset, len))
      if (e > s) {
        const range = document.createRange()
        range.setStart(textNode, s)
        range.setEnd(textNode, e)
        const clientRects = Array.from(range.getClientRects())
        for (const r of clientRects) {
          if (r.width > 0.5 && r.height > 0.5) {
            rawBoxes.push({
              left: r.left - pageRect.left,
              top: r.top - pageRect.top - 1,
              width: Math.max(3, r.width),
              height: r.height + 2,
            })
            measuredFromDom = true
          }
        }
      }
    }

    if (!measuredFromDom) {
      rawBoxes.push(computeFallbackBox(slice, viewport, scale))
    }
  }

  return mergeLineBoxes(rawBoxes)
}

export function createHighlightRectFromBox(box: HighlightBox): HTMLDivElement {
  const rect = document.createElement('div')
  rect.className = 'pdf-hl'
  rect.style.left = `${box.left}px`
  rect.style.top = `${box.top}px`
  rect.style.width = `${box.width}px`
  rect.style.height = `${box.height}px`
  return rect
}

