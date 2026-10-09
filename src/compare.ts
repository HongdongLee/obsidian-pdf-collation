import {
  isPdfTextItem,
} from './pdf-dom.ts'
import type {
  MarkdownPageBlock,
  PagemarkOptions,
  PdfTextItem,
  SplitMarkdownResult,
} from './types.ts'

/**
 * 归一化：抹平人工校订文本与 PDF 文字层之间的空格、连字符、引号、破折号差异
 */
export function normalizeText(s: string): string {
  return s
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u300C\u300D\u300E\u300F]/g, '"')
    .replace(/[\u2013\u2014\u2012]/g, '-')
    .replace(/[\s\u00A0\u002D]/g, '')
    .toLowerCase()
}

// 内置兼容的页标语法：
// 1. SOP 双页标：[p. 33 / pdf. 35]
// 2. 单轨 PDF 页标：[pdf. 35] 或 [pdf 35]
// 3. HTML 注释页标：<!-- page 35 --> 或 <!-- pdf: 35 -->
// 4. 分隔线页标：--- page 35 --- 或 {35}------------------------------------------------
// 5. 印刷页标（可配合 frontmatter pdf_offset 偏移）：[p. 33]
const BUILTIN_MARKER_SOURCE = [
  String.raw`\[p\.[^\]\n/]*\/[ \t]*pdf\.[ \t]*(\d+)[^\]\n]*\]`,
  String.raw`\[pdf\.?[ \t]*(\d+)[^\]\n]*\]`,
  String.raw`<!--[ \t]*(?:pdf|page)[ \t.:=-]*(\d+)[ \t]*-->`,
  String.raw`(?:^|\n)[ \t]*---+[ \t]*page[ \t]+(\d+)[ \t]*---+`,
  String.raw`(?:^|\n)\{(\d+)\}-{10,}`,
  String.raw`\[p\.[ \t]*(\d+)\]`
].join('|')

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

  // 显式含 pdf 页码（[p. X / pdf. Y] 或 [pdf. Y] 或 <!-- pdf: Y -->）
  const pdfMatch =
    text.match(/pdf\.?[ \t]*(\d+)/i) ||
    text.match(/<!--[ \t]*(?:pdf|page)[ \t.:=-]*(\d+)[ \t]*-->/i) ||
    text.match(/---+[ \t]*page[ \t]+(\d+)[ \t]*---+/i) ||
    text.match(/\{(\d+)\}-{10,}/)
  if (pdfMatch) {
    const n = Number(pdfMatch[1])
    return Number.isFinite(n) && n > 0 ? n : null
  }

  // 仅含印刷页码 [p. 33]：叠加上下文中配置的 pageOffset
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

  // 跳过 fenced code blocks，避免代码块中的示例页标把文章切碎
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
      hits.push({ index: offset, raw, pdfPage: page })
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
          markerRaw: null,
          markdown: body,
          bodyStart: 0,
          bodyEnd: body.length,
        },
      ],
    }
  }

  const blocks: MarkdownPageBlock[] = []

  // 第一个页标之前的卷首内容（若非纯空白）
  const firstHit = hits[0]
  if (firstHit.index > 0) {
    const lead = body.slice(0, firstHit.index)
    if (lead.trim().length > 0) {
      blocks.push({
        index: blocks.length,
        pdfPage: null,
        markerRaw: null,
        markdown: lead,
        bodyStart: 0,
        bodyEnd: firstHit.index,
      })
    }
  }

  // 合并同一页码的连续命中，切出每个页块
  let curStart = firstHit.index
  let curPage = firstHit.pdfPage
  let curMarker = firstHit.raw

  for (let i = 1; i < hits.length; i++) {
    const h = hits[i]
    if (h.pdfPage === curPage) continue
    blocks.push({
      index: blocks.length,
      pdfPage: curPage,
      markerRaw: curMarker,
      markdown: body.slice(curStart, h.index),
      bodyStart: curStart,
      bodyEnd: h.index,
    })
    curStart = h.index
    curPage = h.pdfPage
    curMarker = h.raw
  }

  blocks.push({
    index: blocks.length,
    pdfPage: curPage,
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
 * 将块内页标语法转为可点击的 HTML 徽标（供 MarkdownRenderer 渲染）
 */
export function decoratePagemarksInBlock(markdown: string, options?: PagemarkOptions): string {
  const hits = collectMarkers(markdown, options)
  if (hits.length === 0) return markdown

  let out = ''
  let cursor = 0
  for (const h of hits) {
    out += markdown.slice(cursor, h.index)
    const escaped = h.raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
    out += `<span class="pagemark" data-page="${h.pdfPage}" title="跳转 pdf. ${h.pdfPage}">${escaped}</span>`
    cursor = h.index + h.raw.length
  }
  out += markdown.slice(cursor)
  return out
}

/**
 * 在单页 PDF 的 textContent.items 中匹配归一化查询串，返回命中的 PdfTextItem 列表
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

  const idx = full.indexOf(norm)
  if (idx === -1) return []
  const end = idx + norm.length

  const matched: PdfTextItem[] = []
  for (const s of spans) {
    if (s.len === 0 || s.start + s.len <= idx || s.start >= end) continue
    matched.push(s.it)
  }
  return matched
}
