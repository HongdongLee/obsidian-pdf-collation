import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decoratePagemarksInBlock,
  matchPdfTextSlices,
  matchSegmentSlices,
  matchTextSpans,
  normalizeText,
  parsePagemark,
  parsePrintPage,
  replaceBlockInMarkdown,
  splitMarkdownByPagemarks,
  stripEditorialNoise,
} from '../src/compare.ts'
import {
  buildPdfCandidates,
  cleanPdfLinkValue,
  extractPageOffsetFromFrontmatter,
  extractPdfTargetFromFrontmatter,
  upsertFrontmatterPdf,
} from '../src/pairing.ts'

describe('normalizeText & stripEditorialNoise', () => {
  it('normalizes spaces, hyphens, smart quotes, CJK corner quotes, full/half-width brackets, and citation numbers', () => {
    const mdSide = '“戏剧人类学”——一种跨文化的身体-技术（Body-Technique）［10］。'
    const pdfSide = '「戏剧人类学」 - 一种跨文化的 身体 - 技术 (Body-\u00ADTechnique) ［ 10 ］ 119 。'
    assert.equal(normalizeText(mdSide), normalizeText(pdfSide))
  })

  it('strips editorial notes ［校按：...］, footnotes, and inline pagemarks before matching', () => {
    const raw =
      '歌舞剧《窈窕淑女》［校按：原误作「窃窕淑女」］在1990年代香港上演[^1] [p. 72 / pdf. 1]'
    const stripped = stripEditorialNoise(raw)
    assert.equal(stripped.trim(), '歌舞剧《窈窕淑女》在1990年代香港上演')
  })
})

describe('parsePagemark & parsePrintPage', () => {
  it('parses SOP dual pagemarks [p. X / pdf. Y] and printed page label', () => {
    assert.equal(parsePagemark('[p. 33 / pdf. 35]'), 35)
    assert.equal(parsePagemark('[p. iv / pdf. 8]'), 8)
    assert.equal(parsePrintPage('[p. 72 / pdf. 1]'), '72')
    assert.equal(parsePrintPage('[p. iv / pdf. 8]'), 'iv')
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
    assert.equal(split.blocks[1].printPage, '1')
    assert.match(split.blocks[1].markdown, /第一页正文第一段/)
    assert.match(split.blocks[1].markdown, /pdf\. 99/)

    assert.equal(split.blocks[2].pdfPage, 4)
    assert.equal(split.blocks[2].printPage, '2')
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

  it('decorates pagemarks into clickable spans or strips leading marker when requested', () => {
    const decorated = decoratePagemarksInBlock('[p. 2 / pdf. 4]\n正文内容')
    assert.match(decorated, /<span class="pagemark" data-page="4"/)

    const strippedLeading = decoratePagemarksInBlock('[p. 2 / pdf. 4]\n正文内容', {
      stripLeadingMarker: true,
    })
    assert.equal(strippedLeading, '正文内容')
  })
})

describe('matchTextSpans & matchPdfTextSlices', () => {
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

  it('returns exact character startOffset and endOffset inside a long PdfTextItem', () => {
    const lineStr = '1997 年，中国香港春天剧团推出了歌舞剧'
    const items = [{ str: lineStr, width: 200, height: 10, transform: [1, 0, 0, 1, 10, 200] }]
    const res = matchPdfTextSlices(items, '春天剧团')
    assert.ok(res)
    assert.equal(res.slices.length, 1)
    const slice = res.slices[0]
    assert.equal(lineStr.slice(slice.startOffset, slice.endOffset), '春天剧团')
  })

  it('disambiguates repeated short words on the same page using surrounding context', () => {
    const segs = [
      '来源文本《卖花女》作为一部社会问题剧，描绘英国社会阶层差异。',
      '从建筑造型上看，香港的卖花女也不似30年代来港务工劳力居住的棚屋。',
    ]
    const hit2 = matchSegmentSlices(segs, '卖花女', {
      before: '从建筑造型上看，香港的',
      after: '也不似30年代来港务工',
    })
    assert.ok(hit2)
    assert.equal(hit2.slices.length, 1)
    assert.equal(hit2.slices[0].segIdx, 1)
    assert.equal(
      segs[1].slice(hit2.slices[0].startOffset, hit2.slices[0].endOffset),
      '卖花女'
    )
  })

  it('locates a short edited name (谢君豪 vs 谢天豪) via surrounding context bracketing', () => {
    const pdfSegs = ['当时扮演谭教授的青年演员谢天豪，刚出演完《南海十三郎》中的民国粤剧天才。']
    const hit = matchSegmentSlices(pdfSegs, '谢君豪', {
      before: '当时扮演谭教授的青年演员',
      after: '，刚出演完《南海十三郎》',
    })
    assert.ok(hit)
    assert.equal(hit.slices.length, 1)
    assert.equal(
      pdfSegs[0].slice(hit.slices[0].startOffset, hit.slices[0].endOffset),
      '谢天豪'
    )
  })

  it('matches PDF spans even when Markdown contains editorial notes and corrected typos', () => {
    const items = [
      { str: '本文聚焦于1990年代香港本土音乐剧的', width: 120, height: 10, transform: [1, 0, 0, 1, 10, 200] },
      { str: '视觉操演性（visual performativity）与文化身份认同问题。', width: 180, height: 10, transform: [1, 0, 0, 1, 10, 185] },
    ]
    const mdParagraph =
      '本文聚焦于1990年代香港本土音乐剧的视觉展演性［校按：原做「操演性」］（visual performativity）与文化身份认同问题。'
    const matched = matchTextSpans(items, mdParagraph)
    assert.equal(matched.length, 2)
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
