import type { App, TFile } from 'obsidian'
import type { CollationSettings } from './types'

const NON_PDF_EXT_RE =
  /\.(mp4|mp3|wav|m4a|mov|mkv|avi|png|jpe?g|webp|gif|svg|html?|docx?|epub|json|csv|canvas)$/i

/**
 * 规范化库内相对路径（处理冗余斜杠、`.` 与 `..`）
 */
export function normalizeVaultPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/**
 * 清理 frontmatter 中的 wikilink 或路径字符串，提取纯净的 PDF 链接目标
 * 例如：
 * - "[[原始PDF/foo.pdf|原件]]" -> "原始PDF/foo.pdf"
 * - "[[foo.pdf#page=3]]" -> "foo.pdf"
 * - "原始PDF/foo.pdf" -> "原始PDF/foo.pdf"
 * 自动过滤网址、音视频路径、代码块标记与纯文本馆藏描述，避免将非 PDF 字符串误拼上 `.pdf`
 */
export function cleanPdfLinkValue(raw: unknown, allowBareName = true): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.replace(/\r?\n/g, ' ').trim()
  if (!s || /^[>|][-+]?$/.test(s)) return null
  if (/^https?:\/\//i.test(s)) return null

  // 若字符串内包含显式指向 .pdf 的 wikilink，优先提取该链接
  const pdfWiki = s.match(/!?\[\[([^\]|#]+\.pdf)(?:[|#][^\]]*)?\]\]/i)
  if (pdfWiki) {
    return pdfWiki[1].trim()
  }

  const wiki = s.match(/^!?\[\[([^\]]+)\]\]$/)
  if (wiki) {
    s = wiki[1].split('|')[0].split('#')[0].trim()
  } else if (s.includes('[[') || s.includes(']]')) {
    return null
  } else {
    s = s.split('#')[0].trim()
  }
  if (!s) return null
  if (/^https?:\/\//i.test(s) || NON_PDF_EXT_RE.test(s)) return null

  if (s.toLowerCase().endsWith('.pdf')) return s
  if (!allowBareName) return null
  // 含中文全角括号、书名号、分号、顿号等叙述性标点时，判定为馆藏文字说明而非文件路径
  if (/[（）：；、《》＋]/.test(s)) return null

  s = s.replace(/\.(md|txt)$/i, '')
  return s ? `${s}.pdf` : null
}

/**
 * 直接从 Markdown 原始文本头部解析 YAML frontmatter 键值（兼容引号与 `>-` / `|` 多行折叠标量）
 * 解决 Obsidian metadataCache 在文件刚写入或冷启动时尚未刷新导致配对滞后的问题
 */
export function parseFrontmatterFromMarkdown(rawFullFile: string): Record<string, unknown> {
  const m = rawFullFile.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!m) return {}
  const lines = m[1].split(/\r?\n/)
  const result: Record<string, unknown> = {}

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([a-zA-Z0-9_\u4e00-\u9fa5-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].trim()
    let val = kv[2].trim()
    if (/^[>|][-+]?$/.test(val)) {
      const folded: string[] = []
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        i++
        folded.push(lines[i].trim())
      }
      val = folded.join(' ')
    } else {
      val = val.replace(/^["']|["']$/g, '').trim()
    }
    if (val) {
      result[key] = val
    }
  }
  return result
}

/**
 * 从 frontmatter 对象中按优先级提取显式绑定的 PDF 路径或链接
 */
export function extractPdfTargetFromFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): string | null {
  if (!frontmatter) return null
  for (const key of keys) {
    const k = key.trim()
    if (!k) continue
    const val = frontmatter[k]
    const isGenericSourceKey = k.toLowerCase() === 'source' || k.toLowerCase() === 'file'
    const rawStr = typeof val === 'string' ? val.trim() : ''
    const isWikilink = /^!?\[\[[^\]]+\]\]$/.test(rawStr)
    const cleaned = cleanPdfLinkValue(val, !isGenericSourceKey || isWikilink)
    if (cleaned) return cleaned
  }
  return null
}

/**
 * 从正文前部（卷首 Callout / 元数据导言区）提取显式嵌入的 PDF 链接
 * 兼容如 `> 人读原件 (PDF): [[原始PDF/xxx.pdf|PDF 原件]]` 或 `> 整理对象原件: 原始PDF/xxx.pdf`
 */
export function extractPdfTargetFromBodyHeader(rawFullFile: string): string | null {
  if (!rawFullFile) return null
  const withoutFm = rawFullFile.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
  const lines = withoutFm.split(/\r?\n/).slice(0, 45)
  const codeFenceRe = /^(`{3,}|~{3,})/
  let inFence = false

  for (const line of lines) {
    if (codeFenceRe.test(line.trim())) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // 忽略行内代码包裹的示例路径
    const strippedCode = line.replace(/`+[^`]+`+/g, '')
    const wikiMatch = strippedCode.match(/!?\[\[([^\]|#\n]+\.pdf)(?:[|#][^\]]*)?\]\]/i)
    if (wikiMatch) return wikiMatch[1].trim()
    const pathMatch = strippedCode.match(
      /(?:原始PDF|PDF|pdfs|assets)\/[^\s|><"()（）\]]+\.pdf/i
    )
    if (pathMatch) return pathMatch[0].trim()
  }
  return null
}

/**
 * 从 frontmatter 中提取印刷页码与 PDF 页码的固定偏移量（pdf_offset / page_offset）
 */
export function extractPageOffsetFromFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined
): number {
  if (!frontmatter) return 0
  for (const k of ['pdf_offset', 'page_offset', 'pdfOffset']) {
    const v = Number(frontmatter[k])
    if (Number.isFinite(v)) return v
  }
  return 0
}

/**
 * 针对显式指定的 PDF 目标路径（可能为相对于当前笔记目录或父目录的相对路径），
 * 生成从近到远的精确候选路径列表
 */
export function buildExplicitPdfCandidates(
  mdPath: string,
  explicitTarget: string,
  subfolders: readonly string[] = []
): string[] {
  const seen = new Set<string>()
  const add = (p: string) => {
    const norm = normalizeVaultPath(p)
    if (norm) seen.add(norm)
  }

  const ancestorDirs: string[] = []
  let cur = mdPath
  while (true) {
    const idx = cur.lastIndexOf('/')
    if (idx < 0) {
      ancestorDirs.push('')
      break
    }
    cur = cur.slice(0, idx)
    ancestorDirs.push(cur)
  }

  for (const dir of ancestorDirs) {
    add(dir ? `${dir}/${explicitTarget}` : explicitTarget)
  }
  add(explicitTarget)

  const tSlash = explicitTarget.lastIndexOf('/')
  const tDir = tSlash >= 0 ? explicitTarget.slice(0, tSlash) : ''
  const tFile = tSlash >= 0 ? explicitTarget.slice(tSlash + 1) : explicitTarget

  for (const dir of ancestorDirs) {
    for (const sub of subfolders) {
      const s = sub.trim().replace(/^\/+|\/+$/g, '')
      if (!s) continue
      if (tDir) {
        add(dir ? `${dir}/${tDir}/${s}/${tFile}` : `${tDir}/${s}/${tFile}`)
      }
      add(dir ? `${dir}/${s}/${tFile}` : `${s}/${tFile}`)
    }
  }

  return [...seen]
}

/**
 * 根据当前笔记路径（如 "文献库/底本/某书.md"）和子目录配置，生成候选同名 PDF 路径列表
 */
export function buildPdfCandidates(mdPath: string, subfolders: readonly string[]): string[] {
  const slashIdx = mdPath.lastIndexOf('/')
  const dir = slashIdx >= 0 ? mdPath.slice(0, slashIdx) : ''
  const fileName = slashIdx >= 0 ? mdPath.slice(slashIdx + 1) : mdPath
  const baseName = fileName.replace(/\.(md|txt)$/i, '')
  const pdfName = `${baseName}.pdf`

  const seen = new Set<string>()
  const add = (p: string) => {
    const norm = normalizeVaultPath(p)
    if (norm) seen.add(norm)
  }

  for (const sub of subfolders) {
    const s = sub.trim().replace(/^\/+|\/+$/g, '')
    if (!s) {
      add(dir ? `${dir}/${pdfName}` : pdfName)
    } else {
      if (dir) add(`${dir}/${s}/${pdfName}`)
      add(`${s}/${pdfName}`)
      // 若笔记在 "文献库/整理成果/xxx.md"，也自动探测上一级 "文献库/原始PDF/xxx.pdf"
      const parentSlash = dir.lastIndexOf('/')
      if (parentSlash >= 0) {
        const parentDir = dir.slice(0, parentSlash)
        add(`${parentDir}/${s}/${pdfName}`)
      }
    }
  }

  return [...seen]
}

/**
 * 在 Markdown 文本的 YAML frontmatter 中写入或更新 `pdf: "[[...]]"` 字段
 */
export function upsertFrontmatterPdf(
  rawFullFile: string,
  pdfLinkpath: string,
  key = 'pdf'
): string {
  const formattedValue = `"[[${pdfLinkpath}]]"`
  const fmMatch = rawFullFile.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/)
  if (!fmMatch) {
    return `---\n${key}: ${formattedValue}\n---\n\n${rawFullFile}`
  }

  const [, open, body, close] = fmMatch
  const rest = rawFullFile.slice(fmMatch[0].length)
  // 兼容替换单行值或 `>-` / `|` 折叠多行值
  const keyRe = new RegExp(
    `^(${key}\\s*:\\s*)(?:[>|][-+]?[ \\t]*(?:\\r?\\n[ \\t]+[^\\r\\n]+)*|.*)$`,
    'm'
  )
  if (keyRe.test(body)) {
    const updatedBody = body.replace(keyRe, `$1${formattedValue}`)
    return `${open}${updatedBody}${close}${rest}`
  }
  const updatedBody = body.trimEnd() + `\n${key}: ${formattedValue}`
  return `${open}${updatedBody}${close}${rest}`
}

function tryResolveTargetToPdfFile(
  app: App,
  mdFile: TFile,
  target: string,
  subfolders: readonly string[]
): TFile | null {
  const explicitCands = buildExplicitPdfCandidates(mdFile.path, target, subfolders)
  for (const cand of explicitCands) {
    const hit = app.vault.getAbstractFileByPath(cand)
    if (hit && 'extension' in hit && (hit as TFile).extension.toLowerCase() === 'pdf') {
      return hit as TFile
    }
  }

  const resolved = app.metadataCache.getFirstLinkpathDest(target, mdFile.path)
  if (resolved && resolved.extension.toLowerCase() === 'pdf') {
    return resolved
  }

  const slashIdx = target.lastIndexOf('/')
  if (slashIdx >= 0) {
    const fileNameOnly = target.slice(slashIdx + 1)
    if (fileNameOnly) {
      const byName = app.metadataCache.getFirstLinkpathDest(fileNameOnly, mdFile.path)
      if (byName && byName.extension.toLowerCase() === 'pdf') {
        return byName
      }
    }
  }

  return null
}

/**
 * 在 Obsidian Vault 中解析当前 Markdown 笔记对应的 PDF 文件
 */
export function resolvePairedPdf(
  app: App,
  mdFile: TFile,
  settings: CollationSettings,
  rawMarkdown?: string
): TFile | null {
  const cache = app.metadataCache.getFileCache(mdFile)
  const cachedFm = (cache?.frontmatter as Record<string, unknown> | undefined) ?? {}
  const parsedFm = rawMarkdown ? parseFrontmatterFromMarkdown(rawMarkdown) : {}
  const mergedFm: Record<string, unknown> = { ...cachedFm, ...parsedFm }

  const explicitTarget = extractPdfTargetFromFrontmatter(mergedFm, settings.frontmatterKeys)
  if (explicitTarget) {
    const hit = tryResolveTargetToPdfFile(app, mdFile, explicitTarget, settings.pdfSubfolders)
    if (hit) return hit
  }

  if (rawMarkdown) {
    const headerTarget = extractPdfTargetFromBodyHeader(rawMarkdown)
    if (headerTarget) {
      const hit = tryResolveTargetToPdfFile(app, mdFile, headerTarget, settings.pdfSubfolders)
      if (hit) return hit
    }
  }

  const candidates = buildPdfCandidates(mdFile.path, settings.pdfSubfolders)
  for (const cand of candidates) {
    const hit = app.vault.getAbstractFileByPath(cand)
    if (hit && 'extension' in hit && (hit as TFile).extension.toLowerCase() === 'pdf') {
      return hit as TFile
    }
  }

  // 最后回退：按同名 .pdf 在全库索引中查找
  const fallbackDest = app.metadataCache.getFirstLinkpathDest(`${mdFile.basename}.pdf`, mdFile.path)
  if (fallbackDest && fallbackDest.extension.toLowerCase() === 'pdf') {
    return fallbackDest
  }

  return null
}

/**
 * 反向配对：给定一个 PDF 文件（如 `硕论/文献库/原始PDF/xxx.pdf`），在同目录、父目录或全库中寻找配对的 Markdown 笔记
 */
export function resolvePairedMarkdown(
  app: App,
  pdfFile: TFile,
  settings: CollationSettings
): TFile | null {
  const mdName = `${pdfFile.basename}.md`
  const candidates: string[] = []
  let cur = pdfFile.path
  while (true) {
    const idx = cur.lastIndexOf('/')
    if (idx < 0) {
      candidates.push(mdName)
      break
    }
    cur = cur.slice(0, idx)
    candidates.push(`${cur}/${mdName}`)
  }

  for (const cand of candidates) {
    const norm = normalizeVaultPath(cand)
    const hit = app.vault.getAbstractFileByPath(norm)
    if (hit && 'extension' in hit && (hit as TFile).extension.toLowerCase() === 'md') {
      return hit as TFile
    }
  }

  const byLink = app.metadataCache.getFirstLinkpathDest(mdName, pdfFile.path)
  if (byLink && byLink.extension.toLowerCase() === 'md') {
    return byLink
  }

  // 若文件名不同，扫描全库 Markdown 的 frontmatter 是否显式绑定了该 PDF
  const allMdFiles = app.vault.getMarkdownFiles?.() ?? []
  for (const md of allMdFiles) {
    const paired = resolvePairedPdf(app, md, settings)
    if (paired && paired.path === pdfFile.path) {
      return md
    }
  }

  return null
}
