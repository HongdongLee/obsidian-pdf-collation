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
  const decomposed = half
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  let out = ''
  for (const c of decomposed) {
    if (/[\p{Unified_Ideograph}a-z0-9]/u.test(c)) {
      out += c
    }
  }
  return out
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
  isStandalone: boolean
}

function isStandaloneMarkerOnLine(body: string, offset: number, length: number): boolean {
  const lineStart = body.lastIndexOf('\n', offset - 1) + 1
  const nextNl = body.indexOf('\n', offset + length)
  const lineEnd = nextNl === -1 ? body.length : nextNl
  const beforeOnLine = body.slice(lineStart, offset)
  const afterOnLine = body.slice(offset + length, lineEnd)
  return /^[ \t]*$/.test(beforeOnLine) && /^[ \t\r]*$/.test(afterOnLine)
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

  const ignoredRanges: [number, number][] = []
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm
  for (const fm of body.matchAll(fenceRe)) {
    if (fm.index != null) {
      ignoredRanges.push([fm.index, fm.index + fm[0].length])
    }
  }
  // 忽略行内代码（如考证注记中形如 `[p. 37 / pdf. 1]` 至 `[p. 60 / pdf. 24]` 的说明文字）
  const inlineCodeRe = /`+[^`\n]+`+/g
  for (const ic of body.matchAll(inlineCodeRe)) {
    if (ic.index != null) {
      ignoredRanges.push([ic.index, ic.index + ic[0].length])
    }
  }
  const isIgnored = (pos: number) => ignoredRanges.some(([s, e]) => pos >= s && pos < e)

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
    if (isIgnored(offset)) continue
    const page = parsePagemark(raw, options)
    if (page != null) {
      hits.push({
        index: offset,
        raw,
        pdfPage: page,
        printPage: parsePrintPage(raw),
        isStandalone: isStandaloneMarkerOnLine(body, offset, raw.length),
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
  const allHits = collectMarkers(body, options)
  // 优先采用独占一行的标准页标切分，避免正文或按语中顺带提及 `[p. 124]` 等引文误切分页面
  const standaloneHits = allHits.filter((h) => h.isStandalone)
  const hits = standaloneHits.length > 0 ? standaloneHits : allHits

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
  if (hits.length === 0) {
    return options?.stripLeadingMarker
      ? markdown.replace(/(?:\r?\n)+---+[ \t]*(?:\r?\n)*$/, '\n')
      : markdown
  }

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
  if (options?.stripLeadingMarker) {
    out = out.replace(/(?:\r?\n)+---+[ \t]*(?:\r?\n)*$/, '\n')
  }
  return out
}

export interface CharOrigin {
  segIdx: number
  charIdx: number
  charLen?: number
  wordStart?: boolean
  wordEnd?: boolean
}

export interface SegmentSlice {
  segIdx: number
  startOffset: number
  endOffset: number
}

const NOISE_SPAN_RE =
  /[［[【]\s*校(?:按|注|勘|改)[：:][^\n］\]】]*[］\]】]|\[\^[^\]]+\]|\[p\.[^\]\n/]*\/[ \t]*pdf\.[^\]\n]*\]|\[(?:pdf|p)\.?[ \t]*\d+[^\]\n]*\]|[［[][ \t]*\d{1,3}(?:[ \t]*[-,，][ \t]*\d{1,3})*[ \t]*[］\]][ \t]*\d*/gi

function isLatinAlnum(ch: string | undefined): boolean {
  return !!ch && /[a-z0-9]/i.test(ch)
}

/**
 * 将一组文本片段（如 PDF textItems 或 Markdown DOM Text 节点）归一化为连续字符串，
 * 同时记录每个归一化字符精确对应的源片段下标与字符偏移量，自动跳过校按/角标等噪声区间
 */
export function buildCharOriginMap(segments: readonly string[]): {
  norm: string
  origins: CharOrigin[]
} {
  let rawJoined = ''
  const rawMap: { segIdx: number; charIdx: number }[] = []
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
  for (let i = 0; i < rawJoined.length; ) {
    const cp = rawJoined.codePointAt(i)!
    const chStr = String.fromCodePoint(cp)
    const charLen = chStr.length
    if (!skipped[i]) {
      const normalized = normalizeCharForMatch(chStr)
      if (normalized) {
        const prevRaw = i > 0 ? rawJoined[i - 1] : ''
        const nextRaw = i + charLen < rawJoined.length ? rawJoined[i + charLen] : ''
        const wordStart = !isLatinAlnum(prevRaw)
        const wordEnd = !isLatinAlnum(nextRaw)
        for (let k = 0; k < normalized.length; k++) {
          norm += normalized[k]
          origins.push({
            segIdx: rawMap[i].segIdx,
            charIdx: rawMap[i].charIdx,
            charLen,
            wordStart: k === 0 ? wordStart : false,
            wordEnd: k === normalized.length - 1 ? wordEnd : false,
          })
        }
      }
    }
    i += charLen
  }

  return { norm, origins }
}

function scoreContextOverlap(
  full: string,
  start: number,
  end: number,
  beforeNorm: string,
  afterNorm: string,
  progress?: number
): number {
  let score = 0
  if (beforeNorm) {
    const bSlice = beforeNorm.slice(-36)
    const leftWin = full.slice(Math.max(0, start - bSlice.length - 16), start)
    // 紧邻后缀直接重合权重最高（允许极小 0..2 字符间隙）
    for (let gap = 0; gap <= Math.min(2, leftWin.length); gap++) {
      const trimmedLeft = leftWin.slice(0, leftWin.length - gap)
      let suffixLen = 0
      const maxCheck = Math.min(bSlice.length, trimmedLeft.length)
      while (
        suffixLen < maxCheck &&
        bSlice[bSlice.length - 1 - suffixLen] === trimmedLeft[trimmedLeft.length - 1 - suffixLen]
      ) {
        suffixLen++
      }
      if (suffixLen >= 1) {
        score += suffixLen * 5 - gap * 2
        break
      }
    }
    for (let len = Math.min(bSlice.length, leftWin.length); len >= 2; len--) {
      if (leftWin.includes(bSlice.slice(-len))) {
        score += len * 4
        break
      }
    }
    for (let i = 0; i < bSlice.length - 1; i++) {
      if (leftWin.includes(bSlice.slice(i, i + 2))) score += 2
    }
  }
  if (afterNorm) {
    const aSlice = afterNorm.slice(0, 36)
    const rightWin = full.slice(end, Math.min(full.length, end + aSlice.length + 16))
    for (let gap = 0; gap <= Math.min(2, rightWin.length); gap++) {
      const trimmedRight = rightWin.slice(gap)
      let prefixLen = 0
      const maxCheck = Math.min(aSlice.length, trimmedRight.length)
      while (prefixLen < maxCheck && aSlice[prefixLen] === trimmedRight[prefixLen]) {
        prefixLen++
      }
      if (prefixLen >= 1) {
        score += prefixLen * 5 - gap * 2
        break
      }
    }
    for (let len = Math.min(aSlice.length, rightWin.length); len >= 2; len--) {
      if (rightWin.includes(aSlice.slice(0, len))) {
        score += len * 4
        break
      }
    }
    for (let i = 0; i < aSlice.length - 1; i++) {
      if (rightWin.includes(aSlice.slice(i, i + 2))) score += 2
    }
  }
  if (typeof progress === 'number' && Number.isFinite(progress) && full.length > 0) {
    const hitProgress = start / full.length
    const dist = Math.abs(hitProgress - progress)
    score += Math.round(Math.max(0, 1 - dist * 1.6) * 36)
  }
  return score
}

function orderedCharSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen > 120) {
    const bigrams = new Set<string>()
    for (let i = 0; i < a.length - 1; i++) bigrams.add(a.slice(i, i + 2))
    if (bigrams.size === 0) return a === b ? 1 : 0
    let hits = 0
    for (let i = 0; i < b.length - 1; i++) {
      if (bigrams.has(b.slice(i, i + 2))) hits++
    }
    return hits / Math.max(1, maxLen - 1)
  }

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
  return dp[n] / maxLen
}

function countLanguageUnits(norm: string): number {
  let units = 0
  for (const ch of norm) {
    units += /\p{Unified_Ideograph}/u.test(ch) ? 1 : 0.35
  }
  return units
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
  afterNorm = '',
  progress?: number,
  origins?: readonly CharOrigin[]
): RangeMatchResult | null {
  if (!full || !queryNorm) return null
  const isPureLatin = /^[a-z0-9]+$/.test(queryNorm)
  const units = countLanguageUnits(queryNorm)

  // Tier 1: 精确子串匹配（若同页出现多次，结合前后文与页内相对位置打分消歧）
  const exactHits: number[] = []
  let pos = 0
  while (pos <= full.length - queryNorm.length) {
    const idx = full.indexOf(queryNorm, pos)
    if (idx === -1) break
    exactHits.push(idx)
    pos = idx + 1
  }

  if (exactHits.length >= 1) {
    let bestStart = exactHits[0]
    let bestScore = -Infinity
    for (const start of exactHits) {
      const end = start + queryNorm.length
      let s = scoreContextOverlap(full, start, end, beforeNorm, afterNorm, progress)
      if (isPureLatin && origins && origins.length === full.length) {
        const wStart = origins[start]?.wordStart ?? true
        const wEnd = origins[end - 1]?.wordEnd ?? true
        if (wStart && wEnd) s += 28
        else if (!wStart && !wEnd && queryNorm.length <= 5) s -= 40
      }
      if (s > bestScore) {
        bestScore = s
        bestStart = start
      }
    }
    return {
      start: bestStart,
      end: bestStart + queryNorm.length,
      score: 1000 + queryNorm.length * 4 + Math.max(0, bestScore),
    }
  }

  // Tier 2: 前后文夹逼定位（针对用户刚好选中了被校改的短词，如「谢君豪」vs「谢天豪」）
  if (beforeNorm.length >= 3 && afterNorm.length >= 3 && queryNorm.length <= 24) {
    let bestBracket: RangeMatchResult | null = null
    for (let bLen = Math.min(12, beforeNorm.length); bLen >= 3; bLen--) {
      const bAnchor = beforeNorm.slice(-bLen)
      let bSearch = 0
      while (bSearch < full.length) {
        const bIdx = full.indexOf(bAnchor, bSearch)
        if (bIdx === -1) break
        const targetStart = bIdx + bLen
        for (let aLen = Math.min(12, afterNorm.length); aLen >= 3; aLen--) {
          const aAnchor = afterNorm.slice(0, aLen)
          const maxSpan = Math.max(queryNorm.length * 2 + 4, 10)
          const windowRight = full.slice(targetStart, targetStart + maxSpan + aLen)
          const aRel = windowRight.indexOf(aAnchor)
          if (aRel >= 1 && aRel <= maxSpan) {
            const targetEnd = targetStart + aRel
            const ctxScore = scoreContextOverlap(
              full,
              targetStart,
              targetEnd,
              beforeNorm,
              afterNorm,
              progress
            )
            const score = 850 + (bLen + aLen) * 5 + ctxScore
            if (!bestBracket || score > bestBracket.score) {
              bestBracket = { start: targetStart, end: targetEnd, score }
            }
          }
        }
        bSearch = bIdx + 1
      }
      if (bestBracket) return bestBracket
    }
  }

  // Tier 3: 首尾锚点容错匹配（句子中间存在校改异文或增删字）
  if (queryNorm.length >= 5 && units >= 3.2) {
    const maxAnchor = Math.min(6, Math.floor(queryNorm.length / 2))
    const minAnchor = isPureLatin ? Math.min(3, maxAnchor) : 2
    let bestCandidate: RangeMatchResult | null = null

    for (let anchorLen = maxAnchor; anchorLen >= minAnchor; anchorLen--) {
      const head = queryNorm.slice(0, anchorLen)
      const tail = queryNorm.slice(-anchorLen)
      let searchFrom = 0
      while (searchFrom < full.length) {
        const hIdx = full.indexOf(head, searchFrom)
        if (hIdx === -1) break
        const minSpan = Math.max(anchorLen + 1, Math.floor(queryNorm.length * 0.65))
        const maxSpan = Math.ceil(queryNorm.length * 1.45) + anchorLen
        const windowSlice = full.slice(hIdx, Math.min(full.length, hIdx + maxSpan))
        const tRel = windowSlice.lastIndexOf(tail)
        if (tRel !== -1 && tRel + anchorLen >= minSpan) {
          const end = hIdx + tRel + anchorLen
          const sim = orderedCharSimilarity(queryNorm, full.slice(hIdx, end))
          if (sim >= 0.62) {
            const ctxScore = scoreContextOverlap(full, hIdx, end, beforeNorm, afterNorm, progress)
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

  // Tier 4: 2-gram 滑动窗口近似匹配
  if (queryNorm.length >= 4 && units >= 3.0) {
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

    const minWinLen = Math.max(3, Math.ceil(queryNorm.length * 0.75))
    let bestWin: RangeMatchResult | null = null
    for (const s of candidateStarts) {
      const e = Math.min(full.length, s + queryNorm.length)
      if (e - s < minWinLen) continue
      const sim = orderedCharSimilarity(queryNorm, full.slice(s, e))
      if (sim >= 0.72) {
        const ctxScore = scoreContextOverlap(full, s, e, beforeNorm, afterNorm, progress)
        const score = Math.round(sim * 500) + ctxScore
        if (!bestWin || score > bestWin.score) {
          bestWin = { start: s, end: e, score }
        }
      }
    }
    if (bestWin) return bestWin
  }

  // Tier 5: 跨页断句：匹配较长的前缀或后缀
  if (queryNorm.length >= 6 && units >= 4.2) {
    const subLen = Math.max(4, Math.floor(queryNorm.length * 0.58))
    const frontSub = queryNorm.slice(0, subLen)
    const backSub = queryNorm.slice(-subLen)
    let bestPartial: RangeMatchResult | null = null

    for (const sub of [frontSub, backSub]) {
      let searchPos = 0
      while (searchPos <= full.length - sub.length) {
        const hit = full.indexOf(sub, searchPos)
        if (hit === -1) break
        const end = hit + sub.length
        const ctxScore = scoreContextOverlap(full, hit, end, beforeNorm, afterNorm, progress)
        const score = 300 + ctxScore
        if (!bestPartial || score > bestPartial.score) {
          bestPartial = { start: hit, end, score }
        }
        searchPos = hit + 1
      }
    }
    if (bestPartial) return bestPartial
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

  const match = findBestNormalizedRange(
    norm,
    queryNorm,
    beforeNorm,
    afterNorm,
    context?.progress,
    origins
  )
  if (!match || match.end <= match.start) return null

  const sliceMap = new Map<number, { startOffset: number; endOffset: number }>()
  for (let i = match.start; i < match.end && i < origins.length; i++) {
    const { segIdx, charIdx, charLen } = origins[i]
    const spanEnd = charIdx + (charLen ?? 1)
    const prev = sliceMap.get(segIdx)
    if (!prev) {
      sliceMap.set(segIdx, { startOffset: charIdx, endOffset: spanEnd })
    } else {
      if (charIdx < prev.startOffset) prev.startOffset = charIdx
      if (spanEnd > prev.endOffset) prev.endOffset = spanEnd
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

function findPageStartNormIndex(
  norm: string,
  pNorm: string,
  searchStart: number
): { normIdx: number; matchedOffset: number } | null {
  if (!pNorm || pNorm.length < 2 || searchStart >= norm.length) return null

  if (pNorm.length < 8) {
    const idx = norm.indexOf(pNorm, searchStart)
    return idx !== -1 ? { normIdx: idx, matchedOffset: 0 } : null
  }

  const passes = [
    { anchorLen: Math.min(8, Math.max(4, Math.floor(pNorm.length * 0.3))), minSim: 0.52 },
    { anchorLen: Math.min(4, pNorm.length), minSim: 0.62 },
  ]

  for (const { anchorLen, minSim } of passes) {
    const maxOffset = Math.min(120, Math.max(0, pNorm.length - anchorLen))
    for (let offset = 0; offset <= maxOffset; offset += 2) {
      const anchor = pNorm.slice(offset, offset + anchorLen)
      let pos = searchStart
      let bestHit = -1
      let bestSim = 0

      while (pos <= norm.length - anchorLen) {
        const idx = norm.indexOf(anchor, pos)
        if (idx === -1) break
        const checkLen = Math.min(72, pNorm.length - offset)
        const pdfSlice = pNorm.slice(offset, offset + checkLen)
        const mdSlice = norm.slice(idx, Math.min(norm.length, idx + Math.ceil(checkLen * 1.25)))
        const sim = orderedCharSimilarity(pdfSlice, mdSlice)
        if (sim > bestSim) {
          bestSim = sim
          bestHit = idx
        }
        if (sim >= 0.72) break
        pos = idx + 1
      }

      if (bestHit !== -1 && bestSim >= minSim) {
        let curOffset = offset
        let curHit = bestHit
        while (curOffset > 0 && curHit > searchStart) {
          if (norm[curHit - 1] === pNorm[curOffset - 1]) {
            curOffset--
            curHit--
          } else if (
            curOffset >= 2 &&
            curHit >= searchStart + 2 &&
            norm[curHit - 2] === pNorm[curOffset - 2]
          ) {
            curOffset -= 2
            curHit -= 2
          } else {
            break
          }
        }
        return { normIdx: curHit, matchedOffset: curOffset }
      }
    }
  }

  return null
}

/**
 * 根据 PDF 各页提取出的文本层内容，自动在无页标（或缺页标）的 Markdown 正文中推断分页位置并插入页标
 */
export function autoInsertPagemarks(
  rawFullFile: string,
  pageTexts: readonly string[],
  options?: PagemarkOptions
): { markdown: string; insertedCount: number } {
  if (!rawFullFile || pageTexts.length === 0) {
    return { markdown: rawFullFile, insertedCount: 0 }
  }

  const { frontmatterPrefix, body } = splitFrontmatter(rawFullFile)
  if (!body.trim()) {
    return { markdown: rawFullFile, insertedCount: 0 }
  }

  const existingHits = collectMarkers(body, options).filter((h) => h.isStandalone)
  const existingPages = new Set(existingHits.map((h) => h.pdfPage))

  // 将代码块与卷首连续 Callout 导言区掩码为空格，保持与 body 1:1 字符偏移，避免把页标插进代码块或元数据框
  let maskedBody = body.replace(
    /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm,
    (m) => ' '.repeat(m.length)
  )
  maskedBody = maskedBody.replace(
    /^(?:[ \t]*\r?\n)*(?:>[ \t]*\[![^\n]+\r?\n(?:>[^\n]*\r?\n)+)/,
    (m) => ' '.repeat(m.length)
  )

  const { norm, origins } = buildCharOriginMap([maskedBody])
  if (norm.length === 0) {
    return { markdown: rawFullFile, insertedCount: 0 }
  }

  const insertions: { pos: number; page: number; midLine: boolean }[] = []
  const usedPositions = new Set<number>()
  let searchStart = 0

  for (let p = 1; p <= pageTexts.length; p++) {
    if (existingPages.has(p)) {
      const hit = existingHits.find((h) => h.pdfPage === p)
      if (hit) {
        while (searchStart < origins.length && origins[searchStart].charIdx < hit.index) {
          searchStart++
        }
      }
      continue
    }

    const pNorm = normalizeText(pageTexts[p - 1] || '')
    if (pNorm.length < 2) continue

    const found = findPageStartNormIndex(norm, pNorm, searchStart)
    if (!found) continue

    const { normIdx, matchedOffset } = found
    let rawCharIdx = origins[normIdx].charIdx

    // 若段中切分点紧挨着前导左引号/左书名号/左括号，将切分点回退到左标点之前，避免劈开成对标点
    const lineStart = body.lastIndexOf('\n', rawCharIdx - 1) + 1
    while (
      rawCharIdx > lineStart &&
      /[“‘「『《〈（([【［*"']/.test(body[rawCharIdx - 1])
    ) {
      rawCharIdx--
    }

    const lineEndIdx = body.indexOf('\n', rawCharIdx)
    const lineEnd = lineEndIdx === -1 ? body.length : lineEndIdx
    const lineStr = body.slice(lineStart, lineEnd)
    const beforeInLine = body.slice(lineStart, rawCharIdx)
    const afterInLine = body.slice(rawCharIdx, lineEnd)

    const isBlockSyntaxLine =
      /^[ \t]*(?:#{1,6}[ \t]|>[ \t]?|\|)/.test(lineStr) ||
      /^[ \t]*(?:[-*+]|\d+\.)[ \t]/.test(lineStr)

    let targetPos: number
    let midLine = false

    if (normalizeText(beforeInLine).length <= 16 || isBlockSyntaxLine) {
      targetPos = lineStart
    } else if (normalizeText(afterInLine).length <= 10 && lineEndIdx !== -1) {
      let nextLineStart = lineEndIdx + 1
      while (nextLineStart < body.length && (body[nextLineStart] === '\r' || body[nextLineStart] === '\n')) {
        nextLineStart++
      }
      targetPos = nextLineStart
    } else {
      targetPos = rawCharIdx
      midLine = true
    }

    if (!usedPositions.has(targetPos)) {
      usedPositions.add(targetPos)
      insertions.push({ pos: targetPos, page: p, midLine })
    }

    const consumed = Math.max(1, Math.min(16, Math.floor((pNorm.length - matchedOffset) * 0.25)))
    searchStart = Math.min(norm.length, normIdx + consumed)
  }

  if (insertions.length === 0) {
    return { markdown: rawFullFile, insertedCount: 0 }
  }

  const pageOffset = options?.pageOffset ?? 0
  const formatMarker = (pdfPage: number) => {
    if (pageOffset !== 0 && pdfPage - pageOffset >= 1) {
      return `[p. ${pdfPage - pageOffset} / pdf. ${pdfPage}]`
    }
    return `[pdf. ${pdfPage}]`
  }

  let nextBody = body
  const sortedDesc = [...insertions].sort((a, b) => b.pos - a.pos)
  for (const ins of sortedDesc) {
    const marker = formatMarker(ins.page)
    if (ins.midLine) {
      const leftTrimmed = nextBody.slice(0, ins.pos).replace(/[ \t]+$/, '')
      const rightTrimmed = nextBody.slice(ins.pos).replace(/^[ \t]+/, '')
      nextBody = `${leftTrimmed}\n\n${marker}\n${rightTrimmed}`
    } else {
      const before = nextBody.slice(0, ins.pos)
      const after = nextBody.slice(ins.pos)
      const needLeadingNewline = before.length > 0 && !before.endsWith('\n')
      const prefix = needLeadingNewline ? '\n' : ''
      nextBody = `${before}${prefix}${marker}\n${after}`
    }
  }

  return {
    markdown: frontmatterPrefix + nextBody,
    insertedCount: insertions.length,
  }
}

interface VisualLine {
  text: string
  x: number
  endX: number
  y: number
  h: number
}

function isCjkOrPunct(ch: string | undefined): boolean {
  if (!ch) return false
  return /[\p{Unified_Ideograph}，。、；：？！“”‘’「」『』（）【】《》〈〉［］—…·]/u.test(ch)
}

/**
 * 从单页 PDF 的 textContent.items 重建适合阅读与校勘的自适应分段 Markdown 文本
 * 自动合并同一水平基线上的碎裂字词，识别首行缩进、行尾留白、字号跳变与标题序号完成自然分段
 */
export function reconstructPageMarkdownFromItems(items: readonly unknown[]): string {
  const valid = items.filter(isPdfTextItem).filter((it) => it.str.trim().length > 0)
  if (valid.length === 0) return ''

  const lines: VisualLine[] = []
  for (const it of valid) {
    const str = it.str.replace(/\s+/g, ' ').trim()
    if (!str) continue
    const x = Number(it.transform[4]) || 0
    const y = Number(it.transform[5]) || 0
    const rawH =
      Math.hypot(Number(it.transform[2]) || 0, Number(it.transform[3]) || 0) ||
      Number(it.height) ||
      10
    const h = Math.max(6, rawH)
    const w = Math.max(0, Number(it.width) || str.length * h * 0.85)

    const prev = lines[lines.length - 1]
    if (
      prev &&
      Math.abs(y - prev.y) <= Math.max(h, prev.h) * 0.6 &&
      x >= prev.x - Math.max(h, prev.h) * 1.5
    ) {
      const gap = x - prev.endX
      const lastCh = prev.text[prev.text.length - 1]
      const firstCh = str[0]
      let sep = ''
      if (isCjkOrPunct(lastCh) || isCjkOrPunct(firstCh)) {
        // 中文与全角标点之间绝不插入多余半角空格（除非横跨极大制表符间距）
        sep = gap > Math.max(h, prev.h) * 3.5 ? ' ' : ''
      } else if (/[a-zA-Z0-9]/.test(lastCh || '') && /[a-zA-Z0-9]/.test(firstCh || '')) {
        sep = gap > Math.max(h, prev.h) * 0.1 ? ' ' : ''
      } else if (gap > Math.max(h, prev.h) * 0.4) {
        sep = ' '
      }
      prev.text = (prev.text + sep + str).replace(/ {2,}/g, ' ')
      prev.endX = Math.max(prev.endX, x + w)
      prev.h = (prev.h + h) / 2
    } else {
      lines.push({
        text: str,
        x,
        endX: x + w,
        y,
        h,
      })
    }
  }

  // 剔除首行或末行孤立的纯数字页码（如 "- 12 -" 或 "12"）
  const isStandalonePageNum = (s: string) => /^[-—–\s]*\d{1,4}[-—–\s]*$/.test(s.trim())
  if (lines.length > 1 && isStandalonePageNum(lines[0].text)) {
    lines.shift()
  }
  if (lines.length > 1 && isStandalonePageNum(lines[lines.length - 1].text)) {
    lines.pop()
  }
  if (lines.length === 0) return ''

  // 计算当前页相邻行的中位行距 medianDy，自适应不同排版行距（如 Word 28 磅固定行距或期刊双栏紧凑行距）
  const downwardGaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i - 1].y - lines[i].y
    const refLineH = Math.max(lines[i - 1].h, lines[i].h, 8)
    if (dy > refLineH * 0.4 && dy < refLineH * 5) {
      downwardGaps.push(dy)
    }
  }
  downwardGaps.sort((a, b) => a - b)
  const medianDy =
    downwardGaps.length > 0
      ? downwardGaps[Math.floor(downwardGaps.length / 2)]
      : (lines[0]?.h || 12) * 1.8

  const paragraphs: string[] = []
  let curPara = lines[0].text.trim()

  const headingOrListRe =
    /^(?:[一二三四五六七八九十百]+[、.．]|（[一二三四五六七八九十]+）|\([一二三四五六七八九十]+\)|\d{1,2}[.．、]\s*[^\d]|第[一二三四五六七八九十百\d]+[章节部分条]|[•●▪➢]|Abstract\b|Keywords\b|内容摘要|摘\s*要|关键词|中图分类号|引\s*言|结\s*语|参考文献)/i
  const sentenceEndRe = /[。！？；.!?”’」』）)]$/

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]
    const cur = lines[i]
    const text = cur.text.trim()
    if (!text) continue

    const refH = Math.max(prev.h, cur.h)
    const verticalGap = prev.y - cur.y
    const fontChanged = Math.abs(cur.h - prev.h) > Math.min(cur.h, prev.h) * 0.18
    const largeVerticalGap = verticalGap > Math.max(medianDy * 1.45, refH * 2.2)
    const upwardColumnJump = cur.y > prev.y + refH * 0.8 && sentenceEndRe.test(prev.text)
    const isHeadingStart = headingOrListRe.test(text)
    const isIndentedNewPara =
      cur.x - prev.x >= refH * 1.15 && sentenceEndRe.test(prev.text)

    // 计算邻域行的右边界，判断上一行是否提前结束（如标题行或段尾行）
    let localRightMargin = Math.max(prev.endX, cur.endX)
    for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) {
      if (Math.abs(lines[k].x - cur.x) < refH * 6) {
        localRightMargin = Math.max(localRightMargin, lines[k].endX)
      }
    }
    const prevEndedShort =
      prev.endX < localRightMargin - refH * 3.0 &&
      (sentenceEndRe.test(prev.text) || prev.text.length <= 24)

    if (
      fontChanged ||
      largeVerticalGap ||
      upwardColumnJump ||
      isHeadingStart ||
      isIndentedNewPara ||
      prevEndedShort
    ) {
      paragraphs.push(curPara.trim())
      curPara = text
    } else {
      const lastCh = curPara[curPara.length - 1]
      const firstCh = text[0]
      if (/[a-zA-Z]-$/.test(curPara) && /^[a-z]/.test(text)) {
        curPara = curPara.slice(0, -1) + text
      } else if (isCjkOrPunct(lastCh) || isCjkOrPunct(firstCh)) {
        curPara += text
      } else {
        curPara += ` ${text}`
      }
    }
  }

  if (curPara.trim()) {
    paragraphs.push(curPara.trim())
  }

  return paragraphs.join('\n\n')
}

/**
 * 从整本 PDF 各页的 textContent.items 直接生成带 frontmatter 绑定与 `[pdf. N]` 页标的完整 Markdown 校勘底稿
 */
export function buildMarkdownFromPdfPages(
  pagesItems: readonly (readonly unknown[])[],
  pdfLinkpath: string,
  frontmatterKey = 'pdf'
): string {
  const lines: string[] = [
    '---',
    `${frontmatterKey}: "[[${pdfLinkpath}]]"`,
    '---',
    '',
  ]

  for (let i = 0; i < pagesItems.length; i++) {
    const pageNum = i + 1
    const pageText = reconstructPageMarkdownFromItems(pagesItems[i] || [])
    lines.push(`[pdf. ${pageNum}]`)
    lines.push(pageText || '（本页无可提取文字层，可在此直接录入校勘笔记）')
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 从浏览器原生选区和所属容器中提取前后文与垂直位置比例，用于简短词和多处重名文本的精准消歧
 */
export function extractSelectionContext(
  target: Selection | Range,
  containerEl?: HTMLElement | null
): SelectionContext {
  const range =
    target instanceof Range
      ? target
      : !target || target.rangeCount === 0 || target.isCollapsed
        ? null
        : target.getRangeAt(0)
  if (!range) return {}
  let before = ''
  let after = ''
  let progress: number | undefined

  if (
    containerEl &&
    containerEl.contains(range.startContainer) &&
    containerEl.contains(range.endContainer)
  ) {
    try {
      const beforeRange = document.createRange()
      beforeRange.selectNodeContents(containerEl)
      beforeRange.setEnd(range.startContainer, range.startOffset)
      before = beforeRange.toString().slice(-60)
    } catch {
      // 跨节点异常忽略
    }

    try {
      const afterRange = document.createRange()
      afterRange.selectNodeContents(containerEl)
      afterRange.setStart(range.endContainer, range.endOffset)
      after = afterRange.toString().slice(0, 60)
    } catch {
      // 跨节点异常忽略
    }

    try {
      const selRect = range.getBoundingClientRect()
      const containerRect = containerEl.getBoundingClientRect()
      if (containerRect.height > 0) {
        progress = Math.max(0, Math.min(1, (selRect.top - containerRect.top) / containerRect.height))
      }
    } catch {
      // 坐标计算异常忽略
    }
  }

  // 兜底：如果从父容器提取为空，从当前的文本节点提取本节点内的前后文
  if (!before && range.startContainer.nodeType === Node.TEXT_NODE) {
    const val = range.startContainer.nodeValue || ''
    before = val.slice(0, range.startOffset).slice(-40)
  }
  if (!after && range.endContainer.nodeType === Node.TEXT_NODE) {
    const val = range.endContainer.nodeValue || ''
    after = val.slice(range.endOffset).slice(0, 40)
  }

  return { before, after, progress }
}
