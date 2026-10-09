import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decoratePagemarksInBlock,
  matchTextSpans,
  normalizeText,
  parsePagemark,
  replaceBlockInMarkdown,
  splitMarkdownByPagemarks,
} from '../src/compare.ts'
import {
  buildPdfCandidates,
  cleanPdfLinkValue,
  extractPageOffsetFromFrontmatter,
  extractPdfTargetFromFrontmatter,
  upsertFrontmatterPdf,
} from '../src/pairing.ts'

describe('normalizeText', () => {
  it('normalizes spaces, hyphens, smart quotes, CJK corner quotes, and dashes', () => {
    const mdSide = '“戏剧人类学”——一种跨文化的身体-技术（Body-Technique）'
    const pdfSide = '「戏剧人类学」 - 一种跨文化的 身体 - 技术（Body-\u00ADTechnique）'
    assert.equal(normalizeText(mdSide), normalizeText(pdfSide))
  })
})

describe('parsePagemark', () => {
  it('parses SOP dual pagemarks [p. X / pdf. Y]', () => {
    assert.equal(parsePagemark('[p. 33 / pdf. 35]'), 35)
    assert.equal(parsePagemark('[p. iv / pdf. 8]'), 8)
  })

  it('parses single-track PDF markers and OCR page dividers', () => {
    assert.equal(parsePagemark('[pdf. 42]'), 42)
    assert.equal(parsePagemark('<!-- page 19 -->'), 19)
    assert.equal(parsePagemark('<!-- pdf: 27 -->'), 27)
    assert.equal(parsePagemark('--- page 105 ---'), 105)
    assert.equal(parsePagemark('{12}------------------------------------------------'), 12)
  })

  it('parses printed page marker [p. X] with optional pageOffset', () => {
    assert.equal(parsePagemark('[p. 10]'), 10)
    assert.equal(parsePagemark('[p. 10]', { pageOffset: 6 }), 16)
  })

  it('supports user custom regex pattern', () => {
    assert.equal(
      parsePagemark('【第 88 页】', { customPattern: '【第\\s*(\\d+)\\s*页】' }),
      88
    )
  })
})

describe('splitMarkdownByPagemarks & replaceBlockInMarkdown', () => {
  const sampleDoc = [
    '---',
    'title: 测试文献',
    'pdf: "[[原始PDF/测试文献.pdf]]"',
    '---',
    '',
    '> 卷首校勘说明',
    '',
    '[p. 1 / pdf. 3]',
    '第一页正文第一段。',
    '',
    '```markdown',
    '[p. 99 / pdf. 99] 代码块里的示例页标不应切分块',
    '```',
    '',
    '[p. 2 / pdf. 4]',
    '第二页正文，含 OCR 错字“剧场性”。',
    '',
  ].join('\n')

  it('splits frontmatter, lead block, and page blocks while ignoring fenced code blocks', () => {
    const split = splitMarkdownByPagemarks(sampleDoc)
    assert.equal(split.blocks.length, 3)
    assert.equal(split.blocks[0].pdfPage, null)
    assert.match(split.blocks[0].markdown, /卷首校勘说明/)

    assert.equal(split.blocks[1].pdfPage, 3)
    assert.match(split.blocks[1].markdown, /第一页正文第一段/)
    assert.match(split.blocks[1].markdown, /pdf\. 99/)

    assert.equal(split.blocks[2].pdfPage, 4)
    assert.match(split.blocks[2].markdown, /第二页正文/)
  })

  it('replaces a single edited page block while preserving frontmatter and other blocks byte-for-byte', () => {
    const split = splitMarkdownByPagemarks(sampleDoc)
    const editedPage4 = '[p. 2 / pdf. 4]\n第二页正文，已修正错字。\n'
    const updatedRaw = replaceBlockInMarkdown(split, 2, editedPage4)

    assert.ok(updatedRaw.startsWith('---\ntitle: 测试文献\npdf: "[[原始PDF/测试文献.pdf]]"\n---\n'))
    assert.match(updatedRaw, /第一页正文第一段/)
    assert.match(updatedRaw, /第二页正文，已修正错字。/)
    assert.doesNotMatch(updatedRaw, /含 OCR 错字/)
  })

  it('decorates pagemarks into clickable spans inside a block', () => {
    const decorated = decoratePagemarksInBlock('[p. 2 / pdf. 4]\n正文内容')
    assert.match(decorated, /<span class="pagemark" data-page="4"/)
  })
})

describe('matchTextSpans', () => {
  it('matches normalized query across multiple PDF text items', () => {
    const items = [
      { str: 'The ', width: 20, height: 10, transform: [1, 0, 0, 1, 10, 100] },
      { str: 'ritual-theatre', width: 60, height: 10, transform: [1, 0, 0, 1, 30, 100] },
      { str: ' space', width: 30, height: 10, transform: [1, 0, 0, 1, 90, 100] },
    ]
    const matched = matchTextSpans(items, 'ritual theatre')
    assert.equal(matched.length, 1)
    assert.equal(matched[0].str, 'ritual-theatre')
  })
})

describe('pairing helpers', () => {
  it('cleans wikilink and plain path values in frontmatter', () => {
    assert.equal(cleanPdfLinkValue('[[原始PDF/foo.pdf|原件]]'), '原始PDF/foo.pdf')
    assert.equal(cleanPdfLinkValue('![[bar.pdf#page=12]]'), 'bar.pdf')
    assert.equal(cleanPdfLinkValue('docs/baz'), 'docs/baz.pdf')
  })

  it('extracts PDF target and page offset from frontmatter', () => {
    const fm = {
      title: '某书',
      source_pdf: '[[原始PDF/某书.pdf]]',
      pdf_offset: 14,
    }
    assert.equal(
      extractPdfTargetFromFrontmatter(fm, ['pdf', 'source_pdf']),
      '原始PDF/某书.pdf'
    )
    assert.equal(extractPageOffsetFromFrontmatter(fm), 14)
  })

  it('builds candidate PDF paths including sibling and parent subfolders', () => {
    const cands = buildPdfCandidates('文献库/整理成果/某书.md', ['', '原始PDF'])
    assert.ok(cands.includes('文献库/整理成果/某书.pdf'))
    assert.ok(cands.includes('文献库/整理成果/原始PDF/某书.pdf'))
    assert.ok(cands.includes('文献库/原始PDF/某书.pdf'))
    assert.ok(cands.includes('原始PDF/某书.pdf'))
  })

  it('upserts pdf key into existing or missing frontmatter', () => {
    const withFm = '---\ntitle: 测试\n---\n正文'
    const res1 = upsertFrontmatterPdf(withFm, '原始PDF/测试.pdf')
    assert.equal(res1, '---\ntitle: 测试\npdf: "[[原始PDF/测试.pdf]]"\n---\n正文')

    const noFm = '# 标题\n正文'
    const res2 = upsertFrontmatterPdf(noFm, '测试.pdf')
    assert.equal(res2, '---\npdf: "[[测试.pdf]]"\n---\n\n# 标题\n正文')
  })
})
