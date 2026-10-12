import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  autoInsertPagemarks,
  buildMarkdownFromPdfPages,
  decoratePagemarksInBlock,
  matchPdfTextSlices,
  matchSegmentSlices,
  matchTextSpans,
  normalizeText,
  parsePagemark,
  parsePrintPage,
  reconstructPageMarkdownFromItems,
  replaceBlockInMarkdown,
  splitMarkdownByPagemarks,
  stripEditorialNoise,
} from '../src/compare.ts'
import {
  buildExplicitPdfCandidates,
  buildPdfCandidates,
  cleanPdfLinkValue,
  extractPageOffsetFromFrontmatter,
  extractPdfTargetFromBodyHeader,
  extractPdfTargetFromFrontmatter,
  parseFrontmatterFromMarkdown,
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

    const strippedLeading = decoratePagemarksInBlock('[p. 2 / pdf. 4]\n正文内容\n\n---\n', {
      stripLeadingMarker: true,
    })
    assert.equal(strippedLeading, '正文内容\n')
  })

  it('ignores inline code pagemarks and mid-sentence citations when splitting page blocks', () => {
    const docWithHeaderNotes = [
      '# 论文标题',
      '',
      '## 版本考证注记',
      '- **页标体系**：全篇嵌入 24 处双页标 `[p. 37 / pdf. 1]` 至 `[p. 60 / pdf. 24]`，严格对齐 PDF。',
      '',
      '[p. 37 / pdf. 1]',
      '第一页正文，其中提及 Shaw [p. 124] 的书信引文。',
      '',
      '[p. 38 / pdf. 2]',
      '第二页正文。',
    ].join('\n')

    const split = splitMarkdownByPagemarks(docWithHeaderNotes)
    assert.equal(split.blocks.length, 3)
    assert.equal(split.blocks[0].pdfPage, null)
    assert.equal(split.blocks[1].pdfPage, 1)
    assert.match(split.blocks[1].markdown, /第一页正文/)
    assert.equal(split.blocks[2].pdfPage, 2)

    const decoratedLead = decoratePagemarksInBlock(split.blocks[0].markdown)
    assert.match(decoratedLead, /`\[p\. 37 \/ pdf\. 1\]` 至 `\[p\. 60 \/ pdf\. 24\]`/)
    assert.doesNotMatch(decoratedLead, /<span class="pagemark"/)
  })

  it('automatically infers and inserts pagemarks into unpaginated Markdown from PDF page texts', () => {
    const rawUnpaginated = [
      '---',
      'title: 香港本土音乐剧研究',
      'pdf_offset: -71',
      '---',
      '',
      '> [!info] 导读说明',
      '> 本文为 OCR 初稿，尚未手工打页标。',
      '',
      '# 香港本土音乐剧的兴起',
      '',
      '1990年代香港春天剧团推出了一系列广受欢迎的本土舞台剧目，吸引了大批市民走进剧场。',
      '',
      '进入21世纪后，舞台视觉设计与跨文化改编进一步融合，形成了兼具商业活力与本土记忆的剧场美学。',
    ].join('\n')

    const pdfPageTexts = [
      '《戏剧艺术》2010年第2期 72 香港本土音乐剧的兴起 1990年代香港春天剧团推出了一系列广受欢迎的本土舞台剧目，吸引了大批市民走进剧场。',
      '《戏剧艺术》2010年第2期 73 进入21世纪后，舞台视觉设计与跨文化改编进一步融合，形成了兼具商业活力与本土记忆的剧场美学。',
    ]

    const res = autoInsertPagemarks(rawUnpaginated, pdfPageTexts, { pageOffset: -71 })
    assert.equal(res.insertedCount, 2)
    assert.match(res.markdown, /\[p\. 72 \/ pdf\. 1\]\n# 香港本土音乐剧的兴起/)
    assert.match(res.markdown, /\[p\. 73 \/ pdf\. 2\]\n进入21世纪后/)

    const split = splitMarkdownByPagemarks(res.markdown)
    assert.equal(split.blocks.length, 3)
    assert.equal(split.blocks[1].pdfPage, 1)
    assert.equal(split.blocks[1].printPage, '72')
    assert.equal(split.blocks[2].pdfPage, 2)
    assert.equal(split.blocks[2].printPage, '73')
  })

  it('reconstructs natural paragraphs and paginated Markdown directly from standalone PDF text items', () => {
    const page1Items = [
      { str: '1', width: 10, height: 10, transform: [10, 0, 0, 10, 300, 780] },
      { str: '一、关于选题', width: 72, height: 12, transform: [12, 0, 0, 12, 80, 700] },
      {
        str: '1.“专业学位论文”须与',
        width: 140,
        height: 12,
        transform: [12, 0, 0, 12, 80, 670],
      },
      {
        str: '“专业实践能力展示”紧密结合。',
        width: 160,
        height: 12,
        transform: [12, 0, 0, 12, 220, 670],
      },
      {
        str: '须根据所学的理论知识进行阐述。',
        width: 180,
        height: 12,
        transform: [12, 0, 0, 12, 60, 642],
      },
      {
        str: '2.选题应有价值，体现作者的独立思考。',
        width: 220,
        height: 12,
        transform: [12, 0, 0, 12, 80, 614],
      },
    ]
    const page1Md = reconstructPageMarkdownFromItems(page1Items)
    assert.match(page1Md, /一、关于选题\n\n1\.“专业学位论文”须与“专业实践能力展示”紧密结合。须根据所学的理论知识进行阐述。\n\n2\.选题应有价值/)

    const fullMd = buildMarkdownFromPdfPages([page1Items], '写作规范/论文规范.pdf')
    assert.match(fullMd, /^---\npdf: "\[\[写作规范\/论文规范\.pdf\]\]"\n---\n\n\[pdf\. 1\]\n/)
    const split = splitMarkdownByPagemarks(fullMd)
    assert.equal(split.blocks.length, 1)
    assert.equal(split.blocks[0].pdfPage, 1)
  })
})

describe('matchTextSpans & matchPdfTextSlices', () => {
  it('matches normalized query across multiple PDF text items including ligatures', () => {
    const items = [
      { str: 'The ', width: 20, height: 10, transform: [1, 0, 0, 1, 10, 100] },
      { str: 'ritual-theatre', width: 60, height: 10, transform: [1, 0, 0, 1, 30, 100] },
      { str: ' ﬁeld', width: 30, height: 10, transform: [1, 0, 0, 1, 90, 100] },
    ]
    const matched = matchTextSpans(items, 'ritual theatre field')
    assert.equal(matched.length, 2)
    assert.equal(matched[0].str, 'ritual-theatre')
    assert.equal(matched[1].str, ' ﬁeld')
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

  it('disambiguates repeated short words on the same page using surrounding context and progress', () => {
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

    // 当两处上下文相近时，通过页内相对位置 progress 精确命中后半页的同名短词
    const dialogueSegs = [
      '杜立德：我只想要一点点钱。',
      '中间隔了一大段旁白与舞台指示文字，描述伦敦街头的布景变换。',
      '杜立德：我只想要一点点钱。',
    ]
    const lateHit = matchSegmentSlices(dialogueSegs, '杜立德', { progress: 0.85 })
    assert.ok(lateHit)
    assert.equal(lateHit.slices[0].segIdx, 2)
  })

  it('prefers whole-word Latin matches over mid-word substrings', () => {
    const segs = ['This department partly relies on modern art in performance.']
    const hit = matchSegmentSlices(segs, 'art')
    assert.ok(hit)
    assert.equal(
      segs[0].slice(hit.slices[0].startOffset, hit.slices[0].endOffset),
      'art'
    )
    assert.equal(hit.slices[0].startOffset, segs[0].indexOf('art in'))
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

    const multilineFm = [
      '---',
      'title: 多行折叠路径',
      'pdf: >-',
      '  原始PDF/旧文件.pdf',
      'author: 某人',
      '---',
      '正文',
    ].join('\n')
    const res3 = upsertFrontmatterPdf(multilineFm, '原始PDF/新文件.pdf')
    assert.equal(
      res3,
      '---\ntitle: 多行折叠路径\npdf: "[[原始PDF/新文件.pdf]]"\nauthor: 某人\n---\n正文'
    )
  })

  it('parses multiline YAML folded frontmatter and rejects non-PDF or prose source values', () => {
    const rawDoc = [
      '---',
      'title: "The Myth of the Post-National Musical"',
      'source: >-',
      '  原始PDF/20110700_Jeff Berryman_The Myth of the Post-National',
      '  Musical.pdf',
      'pdf_offset: 12',
      '---',
      '正文',
    ].join('\n')
    const fm = parseFrontmatterFromMarkdown(rawDoc)
    assert.ok(fm)
    assert.equal(
      extractPdfTargetFromFrontmatter(fm, ['pdf', 'source']),
      '原始PDF/20110700_Jeff Berryman_The Myth of the Post-National Musical.pdf'
    )
    assert.equal(extractPageOffsetFromFrontmatter(fm), 12)

    // 非 PDF 扩展名（.mp4/.md）、网页 URL、中文叙述说明不应被当作 PDF 文件名
    assert.equal(
      extractPdfTargetFromFrontmatter(
        { source: '音像资料/原视频/测试访谈.mp4' },
        ['pdf', 'source']
      ),
      null
    )
    assert.equal(
      extractPdfTargetFromFrontmatter(
        { source: 'https://example.com/article' },
        ['pdf', 'source']
      ),
      null
    )
    assert.equal(
      extractPdfTargetFromFrontmatter(
        { source: '基于田野笔记（1-3）＋《大公报》史料整理' },
        ['pdf', 'source']
      ),
      null
    )
  })

  it('extracts PDF target from body header callouts and resolves relative paths across ancestor folders', () => {
    const reviewNote = [
      '---',
      'title: 复盘笔记',
      'source: "[[文献库/某书.md]]"',
      '---',
      '',
      '> [!info] 导读与校勘元数据',
      '> - **AI 研读底本**：[[文献库/某书|某书]]',
      '> - **人读原件 (PDF)**：[[文献库/原始PDF/1999_某书.pdf|PDF 原件]]',
      '',
      '正文内容',
    ].join('\n')

    const headerTarget = extractPdfTargetFromBodyHeader(reviewNote)
    assert.equal(headerTarget, '文献库/原始PDF/1999_某书.pdf')

    const explicitCands = buildExplicitPdfCandidates(
      '硕论/文献库/整理成果/某书_校勘版.md',
      '原始PDF/1999_某书.pdf',
      ['', '原始PDF', '文献库/原始PDF']
    )
    assert.ok(explicitCands.includes('硕论/文献库/原始PDF/1999_某书.pdf'))
    assert.ok(explicitCands.includes('硕论/文献库/整理成果/原始PDF/1999_某书.pdf'))
  })
})
