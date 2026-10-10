import { isPdfTextItem } from './pdf-dom.ts'
import type {
  MarkdownPageBlock,
  PagemarkOptions,
  PdfTextItem,
  SplitMarkdownResult,
} from './types.ts'

/**
 * 剔除校勘文本中的人工校按注记、Markdown 脚注引用与页标，避免干扰 PDF 原文匹配
 */
export function stripEditorialNoise(s: string): string {
  return s
    .replace(/[［[【]\s*校(?:按|注|勘)[：:][^\n］\]】]*[］\]】]/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\[p\.[^\]\n/]*\/[ \t]*pdf\.[^\]\n]*\]/gi, '')
    .replace(/\[(?:pdf|p)\.?[ \t]*\d+[^\]\n]*\]/gi, '')
}

/**
 * 归一化：抹平人工校订文本与 PDF 文字层之间的空格、连字符、引号、破折号、方括号差异
 */
export function normalizeText(s: string): string {
  return stripEditorialNoise(s)
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u300C\u300D\u300E\u300F]/g, '"')
    .replace(/[\u2013\u2014\u2012]/g, '-')
    .replace(/[［【]/g, '[')
    .replace(/[］】]/g, ']')
    .replace(/[\s\u00A0\u002D]/g, '')
    .toLowerCase()
}

const BUILTIN_MARKER_SOURCE = [
  String.raw`\[p\.[^\]\n/]*\/[ \t]*pdf\.[ \t]*(\d+)[^\]\n]*\]`,
  String.raw`\[pdf\.?[ \t]*(\d+)[^\]\n]*\]`,
  String.raw`<!--[ \t]*(?:pdf|page)[ \t.:=-]*(\d+)[ \t]*-->`,
  String.raw`(?:^|\n)[ \t]*---+[ \t]*page[ \t]+(\d+)[ \t]*---+`,
  String.raw`(?:^|\n)\{(\d+)\}-{10,}`,
  String.raw`\[p\.[ \t]*(\d+)\]`,
].join('|')

/**
 * 提取页标中的原书印刷页码（如 `[p. 72 / pdf. 1]` -> `"72"`）
 */
export function parsePrintPage(text: string): string | null {
  const m = text.match(/\[p\.[ \t]*([^\]\n/]+?)(?:[ \t]*\/|[ \t]*\])/i)
  return m ? m[1].trim() : null
}

/**
 * 从单个页标字符串解析目标 PDF 页码
 */
export function parsePagemark(text: string, options?: PagemarkOptions): number | null {
  const custom = options?.customPattern?.trim()
  if (custom) {
    try {
      const re = new RegExp(custom, 'i')
      const m = text.match(re)
      if (m) {
        const rawNum = m.groups?.page ?? m[1]
        const n = Number(rawNum)
        if (Number.isFinite(n) && n > 0) return n
      }
    } catch {
      // 用户自定义正则非法时回退内置规则
    }
  }

  const pdfMatch =
    text.match(/pdf\.?[ \t]*(\d+)/i) ||
    text.match(/<!--[ \t]*(?:pdf|page)[ \t.:=-]*(\d+)[ \t]*-->/i) ||
    text.match(/---+[ \t]*page[ \t]+(\d+)[ \t]*---+/i) ||
    text.match(/\{(\d+)\}-{10,}/)
  if (pdfMatch) {
    const n = Number(pdfMatch[1])
    return Number.isFinite(n) && n > 0 ? n : null
  }

  const printMatch = text.match(/^\[p\.[ \t]*(\d+)\]$/)
  if (printMatch) {
    const n = Number(printMatch[1]) + (options?.pageOffset ?? 0)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  return null
}

/**
 * 分离文件头部的 YAML frontmatter 与正文，保持字节级原样前缀
 */
export function splitFrontmatter(rawFullFile: string): { frontmatterPrefix: string; body: string } {
  const m = rawFullFile.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)
  if (!m) {
    return { frontmatterPrefix: '', body: rawFullFile }
  }
  const prefix = m[0]
  return {
    frontmatterPrefix: prefix,
    body: rawFullFile.slice(prefix.length),
  }
}

interface MarkerHit {
  index: number
  raw: string
  pdfPage: number
  printPage: string | null
}

function collectMarkers(body: string, options?: PagemarkOptions): MarkerHit[] {
  const custom = options?.customPattern?.trim()
  let pattern = BUILTIN_MARKER_SOURCE
  if (custom) {
    try {
      new RegExp(custom)
      pattern = `(?:${custom})|${BUILTIN_MARKER_SOURCE}`
    } catch {
      // 忽略无效正则
    }
  }

  const fenceRanges: [number, number][] = []
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm
  for (const fm of body.matchAll(fenceRe)) {
    if (fm.index != null) {
      fenceRanges.push([fm.index, fm.index + fm[0].length])
    }
  }
  const inFence = (pos: number) => fenceRanges.some(([s, e]) => pos >= s && pos < e)

  const hits: MarkerHit[] = []
  const re = new RegExp(pattern, 'gi')
  for (const m of body.matchAll(re)) {
    if (m.index == null) continue
    let raw = m[0]
    let offset = m.index
    if (raw.startsWith('\n')) {
      raw = raw.slice(1)
      offset += 1
    }
    if (inFence(offset)) continue
    const page = parsePagemark(raw, options)
    if (page != null) {
      hits.push({
        index: offset,
        raw,
        pdfPage: page,
        printPage: parsePrintPage(raw),
      })
    }
  }
  return hits
}

/**
 * 按页标把 Markdown 切分成带精确字符偏移量的页块，支持按块就地编辑与写回
 */
export function splitMarkdownByPagemarks(
  rawFullFile: string,
  options?: PagemarkOptions
): SplitMarkdownResult {
  const { frontmatterPrefix, body } = splitFrontmatter(rawFullFile)
  const hits = collectMarkers(body, options)

  if (hits.length === 0) {
    return {
      frontmatterPrefix,
      body,
      blocks: [
        {
          index: 0,
          pdfPage: null,
          printPage: null,
          markerRaw: null,
          markdown: body,
          bodyStart: 0,
          bodyEnd: body.length,
        },
      ],
    }
  }

  const blocks: MarkdownPageBlock[] = []

  const firstHit = hits[0]
  if (firstHit.index > 0) {
    const lead = body.slice(0, firstHit.index)
    if (lead.trim().length > 0) {
      blocks.push({
        index: blocks.length,
        pdfPage: null,
        printPage: null,
        markerRaw: null,
        markdown: lead,
        bodyStart: 0,
        bodyEnd: firstHit.index,
      })
    }
  }

  let curStart = firstHit.index
  let curPage = firstHit.pdfPage
  let curPrintPage = firstHit.printPage
  let curMarker = firstHit.raw

  for (let i = 1; i < hits.length; i++) {
    const h = hits[i]
    if (h.pdfPage === curPage) continue
    blocks.push({
      index: blocks.length,
      pdfPage: curPage,
      printPage: curPrintPage,
      markerRaw: curMarker,
      markdown: body.slice(curStart, h.index),
      bodyStart: curStart,
      bodyEnd: h.index,
    })
    curStart = h.index
    curPage = h.pdfPage
    curPrintPage = h.printPage
    curMarker = h.raw
  }

  blocks.push({
    index: blocks.length,
    pdfPage: curPage,
    printPage: curPrintPage,
    markerRaw: curMarker,
    markdown: body.slice(curStart, body.length),
    bodyStart: curStart,
    bodyEnd: body.length,
  })

  return { frontmatterPrefix, body, blocks }
}

/**
 * 将用户在某个页块内的编辑写回完整 Markdown 文本，原样保留 frontmatter 与其余所有页块
 */
export function replaceBlockInMarkdown(
  split: SplitMarkdownResult,
  blockIndex: number,
  nextBlockMarkdown: string
): string {
  const target = split.blocks[blockIndex]
  if (!target) {
    return split.frontmatterPrefix + split.body
  }
  const nextBody =
    split.body.slice(0, target.bodyStart) +
    nextBlockMarkdown +
    split.body.slice(target.bodyEnd)
  return split.frontmatterPrefix + nextBody
}

/**
 * 将块内页标语法转为可点击的 HTML 徽标；若块首就是单独成行的主页标，则可隐藏以免与吸顶栏重复
 */
export function decoratePagemarksInBlock(
  markdown: string,
  options?: PagemarkOptions & { stripLeadingMarker?: boolean }
): string {
  const hits = collectMarkers(markdown, options)
  if (hits.length === 0) return markdown

  let out = ''
  let cursor = 0
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    out += markdown.slice(cursor, h.index)
    const isLeadingLine =
      options?.stripLeadingMarker &&
      i === 0 &&
      markdown.slice(0, h.index).trim() === '' &&
      (markdown[h.index + h.raw.length] === '\n' ||
        markdown[h.index + h.raw.length] === '\r' ||
        h.index + h.raw.length === markdown.length)

    if (!isLeadingLine) {
      const escaped = h.raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
      out += `<span class="pagemark" data-page="${h.pdfPage}" title="跳转 pdf. ${h.pdfPage}">${escaped}</span>`
    }
    cursor = h.index + h.raw.length
    if (isLeadingLine) {
      while (cursor < markdown.length && (markdown[cursor] === '\r' || markdown[cursor] === '\n')) {
        cursor++
      }
    }
  }
  out += markdown.slice(cursor)
  return out
}

function findBestRange(full: string, norm: string): [number, number] | null {
  const exact = full.indexOf(norm)
  if (exact !== -1) {
    return [exact, exact + norm.length]
  }

  // 容错匹配：若用户在校订稿中修改过个别错字，尝试用首尾锚点区间定位
  if (norm.length >= 8) {
    const anchorLen = Math.min(6, Math.floor(norm.length / 3))
    const head = norm.slice(0, anchorLen)
    const tail = norm.slice(-anchorLen)
    let searchFrom = 0
    while (searchFrom < full.length) {
      const hIdx = full.indexOf(head, searchFrom)
      if (hIdx === -1) break
      const maxEnd = Math.min(full.length, hIdx + Math.ceil(norm.length * 1.6) + anchorLen)
      const windowSlice = full.slice(hIdx, maxEnd)
      const tRel = windowSlice.lastIndexOf(tail)
      if (tRel !== -1 && tRel >= anchorLen) {
        return [hIdx, hIdx + tRel + anchorLen]
      }
      searchFrom = hIdx + 1
    }
  }

  // 退化匹配：取前段或后段连续子串
  if (norm.length >= 6) {
    const subLen = Math.max(4, Math.floor(norm.length * 0.6))
    const front = full.indexOf(norm.slice(0, subLen))
    if (front !== -1) return [front, front + subLen]
    const back = full.indexOf(norm.slice(-subLen))
    if (back !== -1) return [back, back + subLen]
  }

  return null
}

/**
 * 在单页 PDF 的 textContent.items 中匹配归一化查询串（支持容错锚点匹配），返回命中的 PdfTextItem 列表
 */
export function matchTextSpans(items: readonly unknown[], query: string): PdfTextItem[] {
  const norm = normalizeText(query)
  if (norm.length < 2) return []

  let full = ''
  const spans: { it: PdfTextItem; start: number; len: number }[] = []
  for (const it of items) {
    if (!isPdfTextItem(it)) continue
    const ns = normalizeText(it.str)
    spans.push({ it, start: full.length, len: ns.length })
    full += ns
  }

  const range = findBestRange(full, norm)
  if (!range) return []
  const [idx, end] = range

  const matched: PdfTextItem[] = []
  for (const s of spans) {
    if (s.len === 0 || s.start + s.len <= idx || s.start >= end) continue
    matched.push(s.it)
  }
  return matched
}
