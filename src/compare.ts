import { isPdfTextItem } from './pdf-dom.ts'
import type {
  MarkdownPageBlock,
  PagemarkOptions,
  PdfMatchedSlice,
  PdfTextItem,
  SelectionContext,
  SplitMarkdownResult,
} from './types.ts'

/**
 * 剔除校勘文本中的人工校按注记、Markdown 脚注引用与页标，避免干扰 PDF 原文匹配
 */
export function stripEditorialNoise(s: string): string {
  return s
    .replace(/[［[【]\s*校(?:按|注|勘|改)[：:][^\n］\]】]*[］\]】]/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\[p\.[^\]\n/]*\/[ \t]*pdf\.[^\]\n]*\]/gi, '')
    .replace(/\[(?:pdf|p)\.?[ \t]*\d+[^\]\n]*\]/gi, '')
}

function normalizeCharForMatch(ch: string): string {
  const code = ch.charCodeAt(0)
  const half = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch
  const lower = half.toLowerCase()
  if (/[\p{Unified_Ideograph}a-z0-9]/u.test(lower)) {
    return lower
  }
  return ''
}

/**
 * 归一化：抹平人工校订文本与 PDF 文字层之间的全半角括号、引号、破折号、标点、参考文献角标与空格差异
 */
export function normalizeText(s: string): string {
  const stripped = stripEditorialNoise(s).replace(
    /[［[][ \t]*\d{1,3}(?:[ \t]*[-,，][ \t]*\d{1,3})*[ \t]*[］\]][ \t]*\d*/g,
    ''
  )
  let out = ''
  for (const ch of stripped) {
    out += normalizeCharForMatch(ch)
  }
  if (out.length > 0) return out

  // 若输入仅含数字角标或特殊符号，回退保留基础字符
  let fallback = ''
  for (const ch of stripEditorialNoise(s)) {
    fallback += normalizeCharForMatch(ch)
  }
  return fallback
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

export interface CharOrigin {
  segIdx: number
  charIdx: number
}

export interface SegmentSlice {
  segIdx: number
  startOffset: number
  endOffset: number
}

const NOISE_SPAN_RE =
  /[［[【]\s*校(?:按|注|勘|改)[：:][^\n］\]】]*[］\]】]|\[\^[^\]]+\]|\[p\.[^\]\n/]*\/[ \t]*pdf\.[^\]\n]*\]|\[(?:pdf|p)\.?[ \t]*\d+[^\]\n]*\]|[［[][ \t]*\d{1,3}(?:[ \t]*[-,，][ \t]*\d{1,3})*[ \t]*[］\]][ \t]*\d*/gi

/**
 * 将一组文本片段（如 PDF textItems 或 Markdown DOM Text 节点）归一化为连续字符串，
 * 同时记录每个归一化字符精确对应的源片段下标与字符偏移量，自动跳过校按/角标等噪声区间
 */
export function buildCharOriginMap(segments: readonly string[]): {
  norm: string
  origins: CharOrigin[]
} {
  let rawJoined = ''
  const rawMap: CharOrigin[] = []
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx] || ''
    for (let charIdx = 0; charIdx < seg.length; charIdx++) {
      rawMap.push({ segIdx, charIdx })
    }
    rawJoined += seg
  }

  const skipped = new Uint8Array(rawJoined.length)
  for (const m of rawJoined.matchAll(NOISE_SPAN_RE)) {
    if (m.index != null) {
      skipped.fill(1, m.index, m.index + m[0].length)
    }
  }

  let norm = ''
  const origins: CharOrigin[] = []
  for (let i = 0; i < rawJoined.length; i++) {
    if (skipped[i]) continue
    const ch = normalizeCharForMatch(rawJoined[i])
    if (ch) {
      norm += ch
      origins.push(rawMap[i])
    }
  }

  return { norm, origins }
}

function scoreContextOverlap(
  full: string,
  start: number,
  end: number,
  beforeNorm: string,
  afterNorm: string
): number {
  let score = 0
  if (beforeNorm) {
    const bSlice = beforeNorm.slice(-24)
    const leftWin = full.slice(Math.max(0, start - bSlice.length - 8), start)
    // 从右向左检查连续后缀重合与字符重现率
    for (let len = Math.min(bSlice.length, leftWin.length); len >= 2; len--) {
      if (leftWin.includes(bSlice.slice(-len))) {
        score += len * 3
        break
      }
    }
    for (let i = 0; i < bSlice.length - 1; i++) {
      if (leftWin.includes(bSlice.slice(i, i + 2))) score += 1
    }
  }
  if (afterNorm) {
    const aSlice = afterNorm.slice(0, 24)
    const rightWin = full.slice(end, Math.min(full.length, end + aSlice.length + 8))
    for (let len = Math.min(aSlice.length, rightWin.length); len >= 2; len--) {
      if (rightWin.includes(aSlice.slice(0, len))) {
        score += len * 3
        break
      }
    }
    for (let i = 0; i < aSlice.length - 1; i++) {
      if (rightWin.includes(aSlice.slice(i, i + 2))) score += 1
    }
  }
  return score
}

function orderedCharSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen > 120) {
    // 长串使用 2-gram 重合率快速估算
    const bigrams = new Set<string>()
    for (let i = 0; i < a.length - 1; i++) bigrams.add(a.slice(i, i + 2))
    if (bigrams.size === 0) return a === b ? 1 : 0
    let hits = 0
    for (let i = 0; i < b.length - 1; i++) {
      if (bigrams.has(b.slice(i, i + 2))) hits++
    }
    return hits / Math.max(1, b.length - 1)
  }

  // 短中串使用 DP 计算最长公共子序列 (LCS)
  const m = a.length
  const n = b.length
  const dp = new Uint16Array(n + 1)
  for (let i = 1; i <= m; i++) {
    let prev = 0
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      if (ca === b.charCodeAt(j - 1)) {
        dp[j] = prev + 1
      } else if (dp[j - 1] > dp[j]) {
        dp[j] = dp[j - 1]
      }
      prev = temp
    }
  }
  return dp[n] / Math.min(m, n)
}

export interface RangeMatchResult {
  start: number
  end: number
  score: number
}

/**
 * 在归一化全文中结合上下文查找最佳匹配区间，支持多处重名消歧、异文夹逼定位与首尾锚点容错
 */
export function findBestNormalizedRange(
  full: string,
  queryNorm: string,
  beforeNorm = '',
  afterNorm = ''
): RangeMatchResult | null {
  if (!full || !queryNorm) return null

  // Tier 1: 精确子串匹配（若同页出现多次，用前后文打分消歧）
  const exactHits: number[] = []
  let pos = 0
  while (pos <= full.length - queryNorm.length) {
    const idx = full.indexOf(queryNorm, pos)
    if (idx === -1) break
    exactHits.push(idx)
    pos = idx + 1
  }

  if (exactHits.length === 1) {
    const start = exactHits[0]
    const end = start + queryNorm.length
    const ctxScore = scoreContextOverlap(full, start, end, beforeNorm, afterNorm)
    return { start, end, score: 1000 + queryNorm.length * 4 + ctxScore }
  }

  if (exactHits.length > 1) {
    let bestStart = exactHits[0]
    let bestCtx = -1
    for (const start of exactHits) {
      const s = scoreContextOverlap(full, start, start + queryNorm.length, beforeNorm, afterNorm)
      if (s > bestCtx) {
        bestCtx = s
        bestStart = start
      }
    }
    return {
      start: bestStart,
      end: bestStart + queryNorm.length,
      score: 1000 + queryNorm.length * 4 + Math.max(0, bestCtx),
    }
  }

  // Tier 2: 前后文夹逼定位（针对用户刚好选中了被校改的短词，如「谢君豪」vs「谢天豪」）
  if (beforeNorm.length >= 3 && afterNorm.length >= 3 && queryNorm.length <= 24) {
    for (let bLen = Math.min(10, beforeNorm.length); bLen >= 3; bLen--) {
      const bAnchor = beforeNorm.slice(-bLen)
      let bSearch = 0
      while (bSearch < full.length) {
        const bIdx = full.indexOf(bAnchor, bSearch)
        if (bIdx === -1) break
        const targetStart = bIdx + bLen
        for (let aLen = Math.min(10, afterNorm.length); aLen >= 3; aLen--) {
          const aAnchor = afterNorm.slice(0, aLen)
          const maxSpan = Math.max(queryNorm.length * 2 + 4, 10)
          const windowRight = full.slice(targetStart, targetStart + maxSpan + aLen)
          const aRel = windowRight.indexOf(aAnchor)
          if (aRel >= 1 && aRel <= maxSpan) {
            const targetEnd = targetStart + aRel
            const ctxScore = scoreContextOverlap(full, targetStart, targetEnd, beforeNorm, afterNorm)
            return {
              start: targetStart,
              end: targetEnd,
              score: 850 + (bLen + aLen) * 5 + ctxScore,
            }
          }
        }
        bSearch = bIdx + 1
      }
    }
  }

  // Tier 3: 首尾锚点容错匹配（句子中间存在校改异文或增删字）
  if (queryNorm.length >= 5) {
    const maxAnchor = Math.min(6, Math.floor(queryNorm.length / 2))
    let bestCandidate: RangeMatchResult | null = null

    for (let anchorLen = maxAnchor; anchorLen >= 2; anchorLen--) {
      const head = queryNorm.slice(0, anchorLen)
      const tail = queryNorm.slice(-anchorLen)
      let searchFrom = 0
      while (searchFrom < full.length) {
        const hIdx = full.indexOf(head, searchFrom)
        if (hIdx === -1) break
        const minSpan = Math.max(anchorLen + 1, Math.floor(queryNorm.length * 0.6))
        const maxSpan = Math.ceil(queryNorm.length * 1.55) + anchorLen
        const windowSlice = full.slice(hIdx, Math.min(full.length, hIdx + maxSpan))
        const tRel = windowSlice.lastIndexOf(tail)
        if (tRel !== -1 && tRel + anchorLen >= minSpan) {
          const end = hIdx + tRel + anchorLen
          const sim = orderedCharSimilarity(queryNorm, full.slice(hIdx, end))
          if (sim >= 0.58) {
            const ctxScore = scoreContextOverlap(full, hIdx, end, beforeNorm, afterNorm)
            const score = Math.round(sim * 600) + anchorLen * 12 + ctxScore
            if (!bestCandidate || score > bestCandidate.score) {
              bestCandidate = { start: hIdx, end, score }
            }
          }
        }
        searchFrom = hIdx + 1
      }
      if (bestCandidate) return bestCandidate
    }
  }

  // Tier 4: 2-gram 滑动窗口近似匹配与跨页断句前后缀匹配
  if (queryNorm.length >= 3) {
    const candidateStarts = new Set<number>()
    for (let i = 0; i < queryNorm.length - 1; i++) {
      const bg = queryNorm.slice(i, i + 2)
      let p = 0
      while (p < full.length) {
        const hit = full.indexOf(bg, p)
        if (hit === -1) break
        candidateStarts.add(Math.max(0, hit - i))
        p = hit + 1
      }
    }

    let bestWin: RangeMatchResult | null = null
    for (const s of candidateStarts) {
      const e = Math.min(full.length, s + queryNorm.length)
      if (e - s < 2) continue
      const sim = orderedCharSimilarity(queryNorm, full.slice(s, e))
      if (sim >= 0.68) {
        const ctxScore = scoreContextOverlap(full, s, e, beforeNorm, afterNorm)
        const score = Math.round(sim * 500) + ctxScore
        if (!bestWin || score > bestWin.score) {
          bestWin = { start: s, end: e, score }
        }
      }
    }
    if (bestWin) return bestWin
  }

  // 跨页断句：匹配较长的前缀或后缀
  if (queryNorm.length >= 6) {
    const subLen = Math.max(4, Math.floor(queryNorm.length * 0.55))
    const front = full.indexOf(queryNorm.slice(0, subLen))
    if (front !== -1) {
      const end = front + subLen
      return {
        start: front,
        end,
        score: 300 + scoreContextOverlap(full, front, end, beforeNorm, afterNorm),
      }
    }
    const back = full.indexOf(queryNorm.slice(-subLen))
    if (back !== -1) {
      const end = back + subLen
      return {
        start: back,
        end,
        score: 300 + scoreContextOverlap(full, back, end, beforeNorm, afterNorm),
      }
    }
  }

  return null
}

/**
 * 通用片段级精确字符区间匹配（同时服务 PDF textItems 与 Markdown DOM 文本节点）
 */
export function matchSegmentSlices(
  segments: readonly string[],
  query: string,
  context?: SelectionContext
): { slices: SegmentSlice[]; score: number } | null {
  const queryNorm = normalizeText(query)
  if (queryNorm.length < 1) return null

  const { norm, origins } = buildCharOriginMap(segments)
  if (!norm.length) return null

  const beforeNorm = context?.before ? normalizeText(context.before) : ''
  const afterNorm = context?.after ? normalizeText(context.after) : ''

  const match = findBestNormalizedRange(norm, queryNorm, beforeNorm, afterNorm)
  if (!match || match.end <= match.start) return null

  const sliceMap = new Map<number, { startOffset: number; endOffset: number }>()
  for (let i = match.start; i < match.end && i < origins.length; i++) {
    const { segIdx, charIdx } = origins[i]
    const prev = sliceMap.get(segIdx)
    if (!prev) {
      sliceMap.set(segIdx, { startOffset: charIdx, endOffset: charIdx + 1 })
    } else {
      if (charIdx < prev.startOffset) prev.startOffset = charIdx
      if (charIdx + 1 > prev.endOffset) prev.endOffset = charIdx + 1
    }
  }

  const slices: SegmentSlice[] = []
  for (const [segIdx, range] of sliceMap.entries()) {
    slices.push({
      segIdx,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    })
  }
  return slices.length > 0 ? { slices, score: match.score } : null
}

/**
 * 在单页 PDF 的 textContent.items 中匹配并返回带字符起止偏移量的子区间切片
 */
export function matchPdfTextSlices(
  items: readonly unknown[],
  query: string,
  context?: SelectionContext
): { slices: PdfMatchedSlice[]; score: number } | null {
  const validItems: { rawIndex: number; item: PdfTextItem }[] = []
  const strs: string[] = []
  items.forEach((it, idx) => {
    if (isPdfTextItem(it)) {
      validItems.push({ rawIndex: idx, item: it })
      strs.push(it.str)
    }
  })

  const res = matchSegmentSlices(strs, query, context)
  if (!res) return null

  const pdfSlices: PdfMatchedSlice[] = res.slices.map((s) => ({
    itemIdx: validItems[s.segIdx].rawIndex,
    item: validItems[s.segIdx].item,
    startOffset: s.startOffset,
    endOffset: s.endOffset,
  }))
  return { slices: pdfSlices, score: res.score }
}

/**
 * 在单页 PDF 的 textContent.items 中匹配归一化查询串（支持容错锚点与上下文消歧），返回命中的 PdfTextItem 列表
 */
export function matchTextSpans(
  items: readonly unknown[],
  query: string,
  context?: SelectionContext
): PdfTextItem[] {
  const res = matchPdfTextSlices(items, query, context)
  return res ? res.slices.map((s) => s.item) : []
}

