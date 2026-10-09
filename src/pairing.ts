import type { App, TFile } from 'obsidian'
import type { CollationSettings } from './types'

/**
 * 清理 frontmatter 中的 wikilink 或路径字符串，提取纯净的 PDF 链接目标
 * 例如：
 * - "[[原始PDF/foo.pdf|原件]]" -> "原始PDF/foo.pdf"
 * - "[[foo.pdf#page=3]]" -> "foo.pdf"
 * - "原始PDF/foo.pdf" -> "原始PDF/foo.pdf"
 */
export function cleanPdfLinkValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null

  const wiki = s.match(/^!?\[\[([^\]]+)\]\]$/)
  if (wiki) {
    s = wiki[1].split('|')[0].split('#')[0].trim()
  } else {
    s = s.split('#')[0].trim()
  }
  if (!s) return null
  return s.toLowerCase().endsWith('.pdf') ? s : `${s}.pdf`
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
    const cleaned = cleanPdfLinkValue(val)
    if (cleaned) return cleaned
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
    const norm = p.replace(/^\/+/, '').replace(/\/+/g, '/')
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
  const keyRe = new RegExp(`^(${key}\\s*:\\s*).*$`, 'm')
  if (keyRe.test(body)) {
    const updatedBody = body.replace(keyRe, `$1${formattedValue}`)
    return `${open}${updatedBody}${close}${rest}`
  }
  const updatedBody = body.trimEnd() + `\n${key}: ${formattedValue}`
  return `${open}${updatedBody}${close}${rest}`
}

/**
 * 在 Obsidian Vault 中解析当前 Markdown 笔记对应的 PDF 文件
 */
export function resolvePairedPdf(
  app: App,
  mdFile: TFile,
  settings: CollationSettings
): TFile | null {
  const cache = app.metadataCache.getFileCache(mdFile)
  const explicitTarget = extractPdfTargetFromFrontmatter(
    cache?.frontmatter as Record<string, unknown> | undefined,
    settings.frontmatterKeys
  )

  if (explicitTarget) {
    const direct = app.vault.getAbstractFileByPath(explicitTarget)
    if (direct && 'extension' in direct && (direct as TFile).extension.toLowerCase() === 'pdf') {
      return direct as TFile
    }
    const resolved = app.metadataCache.getFirstLinkpathDest(explicitTarget, mdFile.path)
    if (resolved && resolved.extension.toLowerCase() === 'pdf') {
      return resolved
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
