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
  await page.waitForTimeout(350);

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
  assert.ok(
    (await page.locator(".pdf-highlight-box").count()) > 0,
    "Default PDF highlight",
  );
  assert.ok(
    await page.evaluate(() => CSS.highlights?.has("collatio-md-match")),
    "Default MD highlight",
  );
  await page.screenshot({ path: "docs/desktop.png", fullPage: true });

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
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: /演示：Markdown/ }).click();
  await page.waitForTimeout(150);
  assert.ok((await page.locator(".pdf-highlight-box").count()) > 0);
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
    "PASS: minimalist reader, single tutorial entry, search across PDF/MD, no-results, immediate Enter, arrow keys, highlighting, continuous scroll, edit/export, mobile.",
  );
} finally {
  await browser.close();
}
