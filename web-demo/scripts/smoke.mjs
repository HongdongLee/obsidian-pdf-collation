import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const url = process.env.DEMO_URL || "http://127.0.0.1:5173/";
const chromePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome");
const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: ["--no-sandbox"],
});
const errors = [];

// Use rendered geometry so these checks also cover different pane heights and zoom.
const readingPosition = (pane, selector, key) => {
  const line = pane.getBoundingClientRect().top + pane.clientHeight * 0.35;
  const sections = [...pane.querySelectorAll(selector)];
  const section =
    sections.find((el) => el.getBoundingClientRect().bottom > line) ||
    sections.at(-1);
  const bounds = section.getBoundingClientRect();
  return {
    page: Number(section.dataset[key]),
    progress: Math.max(0, Math.min(1, (line - bounds.top) / bounds.height)),
  };
};

async function scrollToProgress(page, source, number, progress) {
  // Retry the scroll event until a previous navigation/selection lock releases.
  // Waiting on the observed destination also covers rendering and animation frames.
  await page.waitForFunction(
    ({ source, number, progress, readingPositionSource }) => {
      const position = new Function("return " + readingPositionSource)();
      const isPdf = source === "pdf";
      const pane = document.querySelector(isPdf ? ".pdf-scroll" : ".md-scroll");
      const section = pane.querySelector(
        isPdf ? `[data-pdf-page="${number}"]` : `[data-page="${number}"]`,
      );
      pane.scrollTop +=
        section.getBoundingClientRect().top -
        pane.getBoundingClientRect().top +
        section.getBoundingClientRect().height * progress -
        pane.clientHeight * 0.35;
      pane.dispatchEvent(new Event("scroll"));
      const other = document.querySelector(
        isPdf ? ".md-scroll" : ".pdf-scroll",
      );
      const a = position(
        pane,
        isPdf ? "[data-pdf-page]" : "[data-page]",
        isPdf ? "pdfPage" : "page",
      );
      const b = position(
        other,
        isPdf ? "[data-page]" : "[data-pdf-page]",
        isPdf ? "page" : "pdfPage",
      );
      return (
        a.page === number &&
        b.page === number &&
        Math.abs(a.progress - progress) < 0.015 &&
        Math.abs(a.progress - b.progress) < 0.02 &&
        document.querySelector(".page-current")?.textContent === String(number)
      );
    },
    {
      source,
      number,
      progress,
      readingPositionSource: readingPosition.toString(),
    },
    { timeout: 10000 },
  );
}

// PDF extractors may split a phrase across spans or use compatibility radicals.
function findTextRange(root, text, occurrence = 0) {
  const normalize = (value) =>
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\p{Unified_Ideograph}a-z0-9]/gu, "");
  const needle = normalize(text);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let full = "";
  const positions = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    for (let offset = 0; offset < node.textContent.length;) {
      const char = String.fromCodePoint(node.textContent.codePointAt(offset));
      const normalized = normalize(char);
      for (const ignored of normalized)
        positions.push({ node, start: offset, end: offset + char.length });
      full += normalized;
      offset += char.length;
    }
  }
  let start = full.indexOf(needle);
  while (start >= 0 && occurrence-- > 0)
    start = full.indexOf(needle, start + needle.length);
  if (start < 0) return null;
  const from = positions[start];
  const to = positions[start + needle.length - 1];
  const range = document.createRange();
  range.setStart(from.node, from.start);
  range.setEnd(to.node, to.end);
  return range;
}

async function selectText(page, selector, text, occurrence = 0) {
  await page.locator(selector).waitFor({ state: "attached" });
  await page.locator(selector).evaluate(
    (el, { text, occurrence, rangeSource }) => {
      const findRange = new Function("return " + rangeSource)();
      const range = findRange(el, text, occurrence);
      if (!range)
        throw new Error(`Text occurrence ${occurrence} not found: ${text}`);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { text, occurrence, rangeSource: findTextRange.toString() },
  );
}

async function clearSelection(page) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

async function waitForMdHighlight(page, number, text, paragraph = null) {
  await page
    .waitForFunction(
      ({ number, text, paragraph }) => {
        const ranges = [...(CSS.highlights?.get("collatio-md-match") || [])];
        if (!ranges.length || ranges.map((r) => r.toString()).join("") !== text)
          return false;
        return ranges.every((range) => {
          const el = range.startContainer.parentElement;
          if (Number(el.closest("[data-page]")?.dataset.page) !== number)
            return false;
          return (
            paragraph == null ||
            [...el.closest(".md-prose").querySelectorAll("p")][
              paragraph
            ].contains(range.startContainer)
          );
        });
      },
      { number, text, paragraph },
    )
    .catch(async (error) => {
      const actual = await page.evaluate(() => ({
        page: document.querySelector(".page-current")?.textContent,
        toast: document.querySelector(".toast")?.textContent,
        matches: [...(CSS.highlights?.get("collatio-md-match") || [])].map(
          (range) => ({
            page: range.startContainer.parentElement.closest("[data-page]")
              ?.dataset.page,
            text: range.toString(),
          }),
        ),
        selection: window.getSelection()?.toString(),
      }));
      console.error(
        "Markdown highlight mismatch",
        JSON.stringify(
          {
            expected: { number, text, paragraph },
            actual,
          },
          null,
          2,
        ),
      );
      throw error;
    });
}

async function waitForPdfHighlightAtText(page, number, text, occurrence = 0) {
  await page.waitForFunction(
    ({ number, text, occurrence, rangeSource }) => {
      const section = document.querySelector(`[data-pdf-page="${number}"]`);
      const marks = [...section.querySelectorAll(".pdf-highlight-box")];
      const layer = section.querySelector(".pdf-text-layer");
      if (!marks.length || !layer) return false;
      const findRange = new Function("return " + rangeSource)();
      const range = findRange(layer, text, occurrence);
      if (!range) return false;
      const target = range.getClientRects()[0];
      return (
        target &&
        marks.some((mark) => {
          const box = mark.getBoundingClientRect();
          return (
            Math.abs(box.top - target.top) < 4 &&
            box.left <= target.left + 3 &&
            box.right >= target.right - 3
          );
        })
      );
    },
    { number, text, occurrence, rangeSource: findTextRange.toString() },
  );
}

// A one-page PDF with three identical paragraphs makes word context ambiguous.
// Only the selection's real vertical progress identifies the last occurrence.
const repeatedParagraph =
  "Reading an identical paragraph keeps every neighbouring word fixed for this check. The evidence belongs at this position within the repeated passage. An identical conclusion keeps the surrounding context deliberately stable and provides no clue to which copy was selected.";
function repetitionPdf() {
  const lines =
    repeatedParagraph.match(/.{1,68}(?:\s|$)/g)?.map((line) => line.trim()) ||
    [];
  const stream = ["BT", "/F1 12 Tf"];
  for (const top of [720, 480, 240]) {
    lines.forEach((line, index) =>
      stream.push(`1 0 0 1 48 ${top - index * 17} Tm (${line}) Tj`),
    );
  }
  stream.push("ET");
  const content = stream.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-pdf-page="2"] canvas').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector(".busy-box"), {
    timeout: 20000,
  });
  await page.waitForFunction(() => CSS.highlights?.has("collatio-md-match"));

  // Main interface shows only search, export, more and the reading surfaces.
  assert.equal(await page.locator(".left-sidebar.collapsed").count(), 1);
  assert.equal(await page.locator('[data-testid="start-guide"]').count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "打开新手教程" }).count(),
    0,
  );
  assert.ok(
    await page
      .locator(".workbench")
      .evaluate((el) => el.clientHeight > window.innerHeight * 0.8),
  );
  assert.equal(await page.locator(".pdf-page-section").count(), 12);
  assert.equal(await page.locator(".demo-version").innerText(), "v0.1.3");
  assert.equal(await page.locator(".reading-guide").count(), 2);
  for (const name of ["md", "pdf"]) {
    const offset = await page.locator(`.${name}-pane`).evaluate((pane) => {
      const scroll = pane.querySelector(
        `.${pane.classList.contains("pdf-pane") ? "pdf" : "md"}-scroll`,
      );
      return Math.abs(
        pane.querySelector(".reading-guide").getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          scroll.clientHeight * 0.35,
      );
    });
    assert.ok(offset <= 2, `${name} guide must mark the 35% reading line`);
  }
  assert.ok(
    (await page.locator(".pdf-highlight-box").count()) > 0,
    "Default PDF highlight",
  );
  assert.ok(
    await page.evaluate(() => CSS.highlights?.has("collatio-md-match")),
    "Default MD highlight",
  );
  await page.screenshot({ path: "docs/desktop.png", fullPage: true });

  // Moving inside the same page must update the opposite pane in both directions.
  await scrollToProgress(page, "pdf", 4, 0.2);
  await scrollToProgress(page, "pdf", 4, 0.72);
  await scrollToProgress(page, "md", 4, 0.3);
  await scrollToProgress(page, "md", 4, 0.68);

  // Keep the selected page rendered when it is far outside the visible window.
  await scrollToProgress(page, "pdf", 8, 0.4);
  const persistentMark = page
    .locator('[data-pdf-page="1"] .pdf-highlight-box')
    .first();
  assert.ok(
    await persistentMark.count(),
    "Scrolling must retain the original matched PDF page",
  );
  assert.ok(
    await page.evaluate(() => CSS.highlights?.has("collatio-md-match")),
    "Scrolling must retain the Markdown highlight",
  );
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await page.locator(".page-current").innerText(), "9");
  assert.ok(
    await persistentMark.count(),
    "Page controls must retain the previous match",
  );
  const markWidth = await persistentMark.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.waitForFunction((oldWidth) => {
    const mark = document.querySelector(
      '[data-pdf-page="1"] .pdf-highlight-box',
    );
    return mark?.getBoundingClientRect().width > oldWidth * 1.05;
  }, markWidth);
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.waitForFunction((oldWidth) => {
    const mark = document.querySelector(
      '[data-pdf-page="1"] .pdf-highlight-box',
    );
    return mark && Math.abs(mark.getBoundingClientRect().width - oldWidth) < 2;
  }, markWidth);
  await page.locator('[data-page="1"] .md-prose p').first().click();
  await page.waitForFunction(
    () => document.querySelector(".page-current")?.textContent === "1",
  );

  // A short repeated word must resolve to the paragraph that was actually selected.
  const conclusion = '[data-page="1"] .md-prose p:last-child';
  await selectText(page, conclusion, "校勘");
  await waitForPdfHighlightAtText(page, 1, "校勘", 3);
  await clearSelection(page);

  // Select text on the next PDF page while page 1 is still the reading position.
  // The source is the selection's page, not the toolbar's current page.
  await page
    .locator('[data-pdf-page="2"] .pdf-text-layer .textLayerNode')
    .first()
    .waitFor({ state: "attached" });
  await selectText(
    page,
    '[data-pdf-page="2"] .pdf-text-layer',
    "只有把出处放在眼前",
  );
  await waitForMdHighlight(page, 2, "只有把出处放在眼前");
  await clearSelection(page);

  const field = page.getByRole("textbox", { name: "搜索文献" });
  await field.fill("校勘");
  await page.waitForTimeout(280);
  assert.ok(
    (await page.locator(".search-hit").count()) >= 5,
    "Search should find multi-page results",
  );
  assert.ok((await page.locator(".hit-source.md").count()) > 0);
  assert.ok((await page.locator(".hit-source.pdf").count()) > 0);
  await page.screenshot({ path: "docs/search.png", fullPage: true });

  await field.fill("只有把出处放在眼前");
  await page.waitForTimeout(260);
  assert.equal(
    await page.locator(".search-hit").count(),
    2,
    "Bidirectional search in the twelve-page sample",
  );
  await page.locator(".search-hit").last().click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".page-current").innerText(), "2");
  assert.ok(
    (await page.locator(".pdf-highlight-box").count()) > 0,
    "Search must highlight PDF",
  );
  assert.ok(
    await page.evaluate(() => CSS.highlights?.has("collatio-md-match")),
    "Search must highlight MD",
  );

  await field.fill("查无此词zz879243");
  await page.waitForTimeout(260);
  assert.equal(
    await page.locator(".search-empty").count(),
    1,
    "Search should show a meaningful empty state",
  );
  await field.press("Escape");
  assert.equal(await page.locator(".search-results").count(), 0);

  // Enter must work even before the debounce delay expires.
  await field.fill("OCR");
  await field.press("Enter");
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator(".search-results").count(),
    0,
    "Enter selects the current query immediately",
  );
  await page.keyboard.press("Meta+k");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "搜索文献",
  );
  await field.fill("文本");
  await page.waitForTimeout(260);
  assert.ok((await page.locator(".search-hit").count()) > 0);
  await field.press("ArrowDown");
  await field.press("Enter");
  await page.waitForTimeout(220);
  assert.equal(
    await page.locator(".search-results").count(),
    0,
    "Keyboard navigation must select a result",
  );

  // Real long-range collation: selecting a Markdown paragraph from page 11
  // must jump to the matching PDF page, without navigating with page buttons.
  const longRangeTarget = page.locator('[data-page="11"] .md-prose p').first();
  await longRangeTarget.scrollIntoViewIfNeeded();
  await longRangeTarget.click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".page-current").innerText(), "11");
  assert.ok((await page.locator(".pdf-highlight-box").count()) > 0);
  // Reset to the first page before testing the existing tutorial and scrolling.
  await page.locator('[data-page="1"] .md-prose p').first().click();
  await page.waitForTimeout(240);

  // Exactly one permanent tutorial entry: More > Tutorial.
  await page.getByRole("button", { name: "更多操作" }).click();
  assert.equal(
    await page.getByRole("menuitem", { name: "新手教程" }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("menuitem", { name: "导入 PDF" }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("menuitem", { name: "导入 Markdown" }).count(),
    1,
  );
  await page.screenshot({ path: "docs/menu.png", fullPage: true });
  await page.getByRole("menuitem", { name: "新手教程" }).click();
  assert.equal(
    await page.getByRole("dialog", { name: "双轨校勘新手引导" }).count(),
    1,
  );
  assert.equal(await page.locator(".tour-count").innerText(), "1 / 5");
  assert.ok((await page.locator(".tour-card").innerText()).includes("十二页"));
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: /演示：Markdown/ }).click();
  await waitForMdHighlight(page, 1, "数字工具的价值，在于让细节重新变得可见");
  await waitForPdfHighlightAtText(page, 1, "数字工具的价值");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: /演示：PDF/ }).click();
  await waitForMdHighlight(
    page,
    2,
    "只有把出处放在眼前，才可能把解释留在证据之内",
  );
  await waitForPdfHighlightAtText(page, 2, "只有把出处放在眼前");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "演示：页内连续联动" }).click();
  await page.waitForFunction(
    ({ source }) => {
      const position = new Function("return " + source)();
      const md = position(
        document.querySelector(".md-scroll"),
        "[data-page]",
        "page",
      );
      const pdf = position(
        document.querySelector(".pdf-scroll"),
        "[data-pdf-page]",
        "pdfPage",
      );
      return (
        md.page === pdf.page &&
        Math.abs(md.progress - pdf.progress) < 0.02 &&
        md.progress > 0.3
      );
    },
    { source: readingPosition.toString() },
  );
  await page.screenshot({ path: "docs/tutorial.png", fullPage: true });
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  assert.equal(await page.locator(".tour-count").innerText(), "5 / 5");
  assert.equal(await page.locator(".tour-import button").count(), 2);
  await page.getByRole("button", { name: "退出教程" }).click();

  // Continuous PDF scroll retains source page; page controls remain functional.
  const pdf = page.locator(".pdf-scroll");
  await page
    .getByRole("button", { name: "上一页" })
    .click()
    .catch(() => {});
  const area = await pdf.boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.wheel(0, 1250);
  await page.waitForTimeout(350);
  assert.ok(
    (await pdf.evaluate((el) => el.scrollTop)) > 200,
    "Wheel should scroll PDF continuously",
  );

  // Three identical surrounding contexts require real vertical selection progress.
  await page.locator('input[accept^=".pdf"]').setInputFiles({
    name: "repeated-context.pdf",
    mimeType: "application/pdf",
    buffer: repetitionPdf(),
  });
  await page.waitForFunction(
    () =>
      !document.querySelector(".busy-box") &&
      document
        .querySelector(".pdf-footer")
        ?.textContent?.includes("repeated-context.pdf") &&
      document.querySelectorAll(".pdf-page-section").length === 1,
  );
  await page.locator('input[accept^=".md"]').setInputFiles({
    name: "repeated-context.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "[pdf. 1]\n\n" + Array(3).fill(repeatedParagraph).join("\n\n"),
    ),
  });
  await page.waitForFunction(
    () => document.querySelectorAll(".md-prose p").length === 3,
  );
  await page
    .locator(".pdf-text-layer .textLayerNode")
    .first()
    .waitFor({ state: "attached" });
  await selectText(page, ".md-prose p:nth-of-type(3)", "evidence");
  await waitForPdfHighlightAtText(page, 1, "evidence", 2);
  // Change the native range directly: identical words and offsets in different
  // nodes must be processed, even without an intervening collapsed selection.
  await selectText(page, ".md-prose p:nth-of-type(2)", "evidence");
  await waitForPdfHighlightAtText(page, 1, "evidence", 1);
  await selectText(page, ".md-prose p:nth-of-type(3)", "evidence");
  await waitForPdfHighlightAtText(page, 1, "evidence", 2);
  // Move the existing match away before testing the reverse direction, so a
  // stale highlight cannot satisfy the expected third-paragraph result.
  await selectText(page, ".pdf-text-layer", "evidence", 1);
  await waitForMdHighlight(page, 1, "evidence", 1);
  await selectText(page, ".pdf-text-layer", "evidence", 2);
  await waitForMdHighlight(page, 1, "evidence", 2);
  await clearSelection(page);

  // Every tutorial demo must also stay within an imported one-page PDF.
  await page.evaluate(() => {
    const indicator = document.querySelector(".page-current");
    window.shortTutorialPages = [indicator.textContent];
    window.shortTutorialObserver = new MutationObserver(() => {
      window.shortTutorialPages.push(indicator.textContent);
    });
    window.shortTutorialObserver.observe(indicator, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "新手教程" }).click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: /演示：Markdown/ }).click();
  await waitForMdHighlight(page, 1, repeatedParagraph.slice(0, -1), 0);
  assert.equal(await page.locator(".page-current").innerText(), "1");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: /演示：PDF/ }).click();
  assert.equal(await page.locator(".page-current").innerText(), "1");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "演示：页内连续联动" }).click();
  // Wait through the animation-frame alignment, then inspect every page change.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await page.locator(".page-current").innerText(), "1");
  assert.ok(
    await page.evaluate(() => {
      window.shortTutorialObserver.disconnect();
      return window.shortTutorialPages.every((number) => number === "1");
    }),
    "Tutorial demos must never navigate beyond the imported PDF",
  );
  await page.getByRole("button", { name: "退出教程" }).click();

  // Import markdown, export the imported name, edit.
  await page.locator('input[accept^=".md"]').setInputFiles({
    name: "research.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("[pdf. 1]\n\n# 一项新的研究\n\n证据需要被认真核查。"),
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".pane-filename")
        ?.textContent?.includes("research.md") ||
      document
        .querySelector(".document-pair")
        ?.textContent?.includes("research.md"),
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  assert.ok((await page.locator("textarea.block-editor").count()) > 0);
  await page.getByRole("button", { name: "完成编辑" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出" }).click();
  assert.equal((await download).suggestedFilename(), "research.md");

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  mobile.on("pageerror", (error) => errors.push("mobile: " + error.message));
  await mobile.goto(url);
  await mobile.locator(".pdf-page-section").last().waitFor({ timeout: 20000 });
  await mobile.waitForTimeout(350);
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
  await mobile.screenshot({ path: "docs/mobile.png", fullPage: true });
  assert.deepEqual(errors, [], "No browser exceptions or console errors");
  console.log(
    "PASS: v0.1.3, 35% reading guides, bidirectional within-page scroll, retained highlights across distant pages and zoom, repeated-word context/progress, actual PDF selection page, five-step tutorial and one-page PDF bounds, search/keyboard, edit/export, mobile.",
  );
} finally {
  await browser.close();
}
