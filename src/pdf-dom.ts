import type { PdfTextItem, PdfViewport } from './types'

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

export function buildTextLayer(
  items: readonly unknown[],
  viewport: PdfViewport,
  container: HTMLElement
): void {
  container.replaceChildren()
  const frag = document.createDocumentFragment()
  const pairs: { span: HTMLSpanElement; width: number }[] = []

  for (const value of items) {
    if (!isPdfTextItem(value) || !value.str || value.width <= 0) continue
    const [x, y] = viewport.convertToViewportPoint(value.transform[4], value.transform[5])
    const height = Math.abs(value.height || 10) * viewport.scale
    const width = Math.abs(value.width) * viewport.scale
    if (height <= 0 || width <= 0) continue

    const span = document.createElement('span')
    span.textContent = value.str
    span.style.left = `${x}px`
    span.style.top = `${y - height}px`
    span.style.fontSize = `${height}px`
    span.style.fontFamily = 'serif'
    frag.append(span)
    pairs.push({ span, width })
  }

  container.append(frag)
  const measured = pairs.map(({ span }) => span.getBoundingClientRect().width)
  pairs.forEach(({ span, width }, index) => {
    if (measured[index] > 0 && Math.abs(measured[index] - width) > 0.5) {
      span.style.transform = `scaleX(${width / measured[index]})`
    }
  })
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

export function createHighlightRect(
  item: PdfTextItem,
  viewport: PdfViewport,
  scale: number
): HTMLDivElement {
  const [x0, y0] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
  const [x1] = viewport.convertToViewportPoint(item.transform[4] + item.width, item.transform[5])
  const height = Math.abs(item.height || 10) * scale

  const rect = document.createElement('div')
  rect.className = 'pdf-hl'
  rect.style.left = `${Math.min(x0, x1)}px`
  rect.style.top = `${y0 - height}px`
  rect.style.width = `${Math.max(2, Math.abs(x1 - x0))}px`
  rect.style.height = `${height}px`
  return rect
}
