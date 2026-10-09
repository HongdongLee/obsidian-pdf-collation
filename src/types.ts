export interface CollationSettings {
  /** Frontmatter 属性名优先级列表（逗号分隔），用于显式指定配对 PDF */
  frontmatterKeys: string[]
  /** 同名 PDF 自动查找的子目录列表 */
  pdfSubfolders: string[]
  /** 自定义页标正则（第一个捕获组或命名捕获组 (?<page>\d+) 提取页码） */
  customPagemarkPattern: string
  /** 默认是否开启 PDF 滚动联动 */
  defaultFollowScroll: boolean
  /** 默认是否把 PDF 放在左侧 */
  defaultSwapped: boolean
}

export const DEFAULT_SETTINGS: CollationSettings = {
  frontmatterKeys: ['pdf', 'source_pdf', 'annotation-target', 'file'],
  pdfSubfolders: ['', '原始PDF', 'PDF', 'pdfs', 'assets'],
  customPagemarkPattern: '',
  defaultFollowScroll: false,
  defaultSwapped: false,
}

export interface PagemarkOptions {
  customPattern?: string
  pageOffset?: number
}

export interface MarkdownPageBlock {
  index: number
  pdfPage: number | null
  markerRaw: string | null
  markdown: string
  bodyStart: number
  bodyEnd: number
}

export interface SplitMarkdownResult {
  frontmatterPrefix: string
  body: string
  blocks: MarkdownPageBlock[]
}

export interface PdfTextItem {
  str: string
  width: number
  height: number
  transform: number[]
}

export interface PdfViewport {
  scale: number
  convertToViewportPoint: (x: number, y: number) => number[]
}
