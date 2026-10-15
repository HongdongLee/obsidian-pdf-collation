import React, { useEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import SEED_MD from "./sample.md?raw";
import manifest from "../../manifest.json";
import ReactMarkdown from "react-markdown";
import { buildSearchDocuments, searchDocuments } from "./search.js";
import remarkGfm from "remark-gfm";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Command,
  Crosshair,
  FilePlus2,
  FileText,
  FileUp,
  Github,
  Highlighter,
  Layers3,
  Link2,
  LoaderCircle,
  Menu,
  Moon,
  Pencil,
  RotateCcw,
  Search,
  ShieldCheck,
  Play,
  Sun,
  Upload,
  WandSparkles,
  MoreHorizontal,
  ExternalLink,
  SlidersHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  autoInsertPagemarks,
  buildMarkdownFromPdfPages,
  extractSelectionContext,
  matchPdfTextSlices,
  normalizeText,
  matchSegmentSlices,
  replaceBlockInMarkdown,
  splitMarkdownByPagemarks,
} from "../../src/compare.ts";
import {
  buildTextLayer,
  computeSliceHighlightBoxes,
} from "../../src/pdf-dom.ts";

GlobalWorkerOptions.workerSrc = workerUrl;
const REPO_URL = "https://github.com/HongdongLee/obsidian-pdf-collation";
const ALIGN_RATIO = 0.35;

function readingPosition(pane, selector) {
  if (!pane) return null;
  const line =
    pane.getBoundingClientRect().top + pane.clientHeight * ALIGN_RATIO;
  const sections = [...pane.querySelectorAll(selector)];
  if (!sections.length) return null;
  const section = sections.reduce((nearest, candidate) => {
    const distance = (el) => {
      const rect = el.getBoundingClientRect();
      return Math.max(rect.top - line, line - rect.bottom, 0);
    };
    return distance(candidate) < distance(nearest) ? candidate : nearest;
  });
  const rect = section.getBoundingClientRect();
  return {
    page: Number(section.dataset.pdfPage || section.dataset.page),
    ratio: Math.max(
      0,
      Math.min(1, (line - rect.top) / Math.max(1, rect.height)),
    ),
  };
}

function ReadingGuide({ visible }) {
  return visible ? (
    <div className="reading-guide" aria-hidden="true">
      <span>对齐基准</span>
    </div>
  ) : null;
}

const safeName = (name, fallback) =>
  (name || fallback).replace(/[^\w\-.\u4e00-\u9fff\s]/g, "_");

function MiniLogo({ small = false }) {
  return (
    <span className={"brand-mark" + (small ? " small" : "")}>
      <span className="mark-sheet mark-back"></span>
      <span className="mark-sheet mark-front">
        <span className="mark-bar" />
        <span className="mark-bar short" />
      </span>
    </span>
  );
}

function Toast({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <Check size={15} />
      <span>{message}</span>
      <button onClick={onClose} aria-label="关闭提示">
        <X size={14} />
      </button>
    </div>
  );
}

function PDFPage({ doc, items, page, width, height, highlight }) {
  const canvasRef = useRef(null);
  const layerRef = useRef(null);
  const marksRef = useRef(null);
  const spansRef = useRef([]);
  const viewportRef = useRef(null);
  const [renderToken, setRenderToken] = useState(0);

  useEffect(() => {
    if (!doc || !canvasRef.current || !layerRef.current) return;
    let cancelled = false;
    let renderTask = null;
    const render = async () => {
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const source = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: width / source.width });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d", { alpha: false });
        if (!canvas || !context || !layerRef.current) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(viewport.width * dpr);
        canvas.height = Math.round(viewport.height * dpr);
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";
        layerRef.current.style.width = viewport.width + "px";
        layerRef.current.style.height = viewport.height + "px";
        viewportRef.current = viewport;
        renderTask = pdfPage.render({
          canvasContext: context,
          canvas,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;
        let pageItems = items[page - 1];
        if (!pageItems) pageItems = (await pdfPage.getTextContent()).items;
        if (cancelled || !layerRef.current) return;
        spansRef.current = buildTextLayer(
          pageItems,
          viewport,
          layerRef.current,
        );
        setRenderToken((t) => t + 1);
      } catch (e) {
        if (!cancelled && e?.name !== "RenderingCancelledException")
          console.error(e);
      }
    };
    render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, items, page, width]);

  useEffect(() => {
    const holder = marksRef.current;
    const vp = viewportRef.current;
    if (!holder) return;
    holder.replaceChildren();
    if (!highlight || highlight.page !== page || !vp || !layerRef.current)
      return;
    const boxes = computeSliceHighlightBoxes(
      highlight.slices,
      spansRef.current,
      layerRef.current,
      vp,
      vp.scale,
    );
    for (const box of boxes) {
      const marker = document.createElement("div");
      marker.className = "pdf-highlight-box";
      marker.style.left = box.left + "px";
      marker.style.top = box.top + "px";
      marker.style.width = box.width + "px";
      marker.style.height = box.height + "px";
      holder.appendChild(marker);
    }
  }, [highlight, page, renderToken]);

  return (
    <div className="pdf-stage continuous-stage">
      <div className="pdf-shadow">
        <div className="pdf-canvas-wrap" style={{ width, height }}>
          <canvas ref={canvasRef} aria-label={"PDF 第 " + page + " 页"} />
          <div ref={layerRef} className="pdf-text-layer" />
          <div ref={marksRef} className="pdf-marks-layer" aria-hidden="true" />
        </div>
      </div>
      <div className="pdf-under">
        <span>ORIGINAL DOCUMENT</span>
        <span>PAGE {String(page).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

function MarkdownBlock({
  block,
  active,
  highlighted,
  onClick,
  onSelect,
  editing,
  onChange,
  pageFallback,
}) {
  const content = block.markdown
    .replace(
      /^\s*(?:\[p\.[^\]\n]+\]|\[pdf\.\s*\d+\]|<!--[ \t]*(?:pdf|page)[^>]*-->|---+\s*page\s+\d+\s*---+)\s*\n?/i,
      "",
    )
    .trim();
  return (
    <article
      className={
        "md-page-block" +
        (active ? " is-active" : "") +
        (highlighted ? " is-highlighted" : "")
      }
      onClick={(e) => {
        if (editing || window.getSelection()?.toString().trim()) return;
        const paragraph = e.target.closest(
          ".md-prose p, .md-prose h1, .md-prose h2, .md-prose h3",
        );
        if (paragraph && paragraph.textContent.trim()) {
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          onSelect(
            paragraph.textContent.trim(),
            block.pdfPage,
            extractSelectionContext(range, paragraph.closest(".md-prose")),
          );
        } else onClick(block.pdfPage || pageFallback);
      }}
    >
      <div className="md-page-label">
        <span className="page-line" />
        <span>
          {block.pdfPage == null
            ? "未分配页标"
            : "PDF · " + String(block.pdfPage).padStart(2, "0")}
        </span>
        <span className="page-line end" />
      </div>
      {editing ? (
        <textarea
          className="block-editor"
          aria-label="编辑 Markdown 页块"
          spellCheck={false}
          value={block.markdown}
          onChange={(e) => onChange(block.index, e.target.value)}
        />
      ) : (
        <>
          <div className="md-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content || "（本页暂无文本）"}
            </ReactMarkdown>
          </div>
          <div className="md-marks-layer" aria-hidden="true" />
        </>
      )}
    </article>
  );
}

function WelcomeCard({ onPdf, onMd, onReset }) {
  return (
    <div className="drop-prompt">
      <span className="prompt-icon">
        <Layers3 size={25} />
      </span>
      <h2>让每一处订正，都有据可循。</h2>
      <p>导入 PDF 和 Markdown，在原始页面与校勘稿之间自由往返。</p>
      <div className="prompt-actions">
        <button className="btn primary" onClick={onPdf}>
          <Upload size={16} /> 导入 PDF
        </button>
        <button className="btn" onClick={onMd}>
          <FileText size={16} /> 导入 Markdown
        </button>
      </div>
      <button className="text-action" onClick={onReset}>
        或者打开内置演示 <ArrowRight size={14} />
      </button>
    </div>
  );
}

export default function App() {
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfItems, setPdfItems] = useState([]);
  const [pageTexts, setPageTexts] = useState([]);
  const [pdfSizes, setPdfSizes] = useState([]);
  const [pdfPaneWidth, setPdfPaneWidth] = useState(600);
  const [pdfName, setPdfName] = useState("sample.pdf");
  const [mdName, setMdName] = useState("校勘底稿.md");
  const [markdown, setMarkdown] = useState(SEED_MD);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [synced, setSynced] = useState(true);
  const [swapped, setSwapped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dark, setDark] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchCursor, setSearchCursor] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [mdFocus, setMdFocus] = useState(null);
  const [mdMatch, setMdMatch] = useState(null);
  const [tourStep, setTourStep] = useState(-1);
  const mdScrollRef = useRef(null);
  const selectionSignature = useRef(null);
  const selectionTimer = useRef(null);
  const [toast, setToast] = useState("");
  const [status, setStatus] = useState("本地处理 · 数据不上传");
  const pdfInput = useRef(null);
  const mdInput = useRef(null);
  const searchInput = useRef(null);
  const searchHolder = useRef(null);
  const moreHolder = useRef(null);
  const initialized = useRef(false);
  const requestId = useRef(0);
  const mdImportRevision = useRef(0);
  const pdfHolder = useRef(null);
  const scrollGuard = useRef(null);
  const scrollGuardTimer = useRef(null);
  const pageScrollTick = useRef(null);
  const mdScrollTick = useRef(null);

  const lockScroll = (source) => {
    scrollGuard.current = source;
    clearTimeout(scrollGuardTimer.current);
    scrollGuardTimer.current = setTimeout(() => {
      scrollGuard.current = null;
    }, 260);
  };
  const releaseScroll = () => {
    clearTimeout(scrollGuardTimer.current);
    scrollGuard.current = null;
  };
  const alignSection = (pane, section, ratio, source) => {
    if (!pane || !section) return;
    const rect = section.getBoundingClientRect();
    lockScroll(source);
    pane.scrollTo({
      top:
        pane.scrollTop +
        rect.top -
        pane.getBoundingClientRect().top +
        rect.height * ratio -
        pane.clientHeight * ALIGN_RATIO,
      behavior: "instant",
    });
  };
  const alignRange = (pane, range) => {
    if (!pane) return;
    const rect = range.getBoundingClientRect();
    if (!rect.height) return;
    lockScroll("nav");
    pane.scrollTo({
      top:
        pane.scrollTop +
        rect.top -
        pane.getBoundingClientRect().top -
        pane.clientHeight * ALIGN_RATIO,
      behavior: "instant",
    });
  };
  const scrollPdfRatio = (n, ratio, source) => {
    const pane = pdfHolder.current;
    alignSection(
      pane,
      pane?.querySelector('[data-pdf-page="' + n + '"]'),
      ratio,
      source,
    );
  };
  const scrollMarkdownRatio = (n, ratio, source) => {
    const pane = mdScrollRef.current;
    const sections = [...(pane?.querySelectorAll("[data-page]") || [])];
    // Sparse page markers cover the following pages until the next marker.
    const section =
      sections.find((el) => Number(el.dataset.page) === n) ||
      sections.filter((el) => Number(el.dataset.page) <= n).at(-1) ||
      sections[0];
    alignSection(pane, section, ratio, source);
  };
  const scrollToPdf = (n, source = "nav", focusSlice = null) => {
    const pane = pdfHolder.current;
    const section = pane?.querySelector('[data-pdf-page="' + n + '"]');
    if (!pane || !section) return;
    lockScroll(source);
    const canvas = section.querySelector(".pdf-canvas-wrap, .pdf-placeholder");
    const pageTop =
      pane.scrollTop +
      (focusSlice ? canvas || section : section).getBoundingClientRect().top -
      pane.getBoundingClientRect().top;
    const size = pdfSizes[n - 1] || pdfSizes[0];
    const pageWidth =
      section.querySelector(".pdf-canvas-wrap, .pdf-placeholder")
        ?.clientWidth || Math.max(240, pdfPaneWidth - 78) * zoom;
    const pdfY = focusSlice?.item?.transform?.[5];
    const offset =
      size && Number.isFinite(pdfY)
        ? ((size.height - pdfY - (focusSlice.item.height || 0)) * pageWidth) /
            size.width -
          pane.clientHeight * ALIGN_RATIO
        : 0;
    pane.scrollTo({ top: pageTop + offset, behavior: "instant" });
  };
  const scrollToMarkdown = (n, source = "pdf") =>
    scrollMarkdownRatio(n, 0, source);
  useEffect(() => {
    const pane = pdfHolder.current;
    if (!pane) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 100) setPdfPaneWidth(width);
    });
    ro.observe(pane);
    return () => ro.disconnect();
  }, [pdfDoc]);

  const onPdfScroll = () => {
    if (pageScrollTick.current) return;
    pageScrollTick.current = requestAnimationFrame(() => {
      pageScrollTick.current = null;
      if (scrollGuard.current === "md" || scrollGuard.current === "nav") return;
      const position = readingPosition(pdfHolder.current, "[data-pdf-page]");
      if (!position?.page) return;
      setCurrentPage(position.page);
      if (synced && !editing)
        scrollMarkdownRatio(position.page, position.ratio, "pdf");
    });
  };
  const onMarkdownScroll = () => {
    if (mdScrollTick.current) return;
    mdScrollTick.current = requestAnimationFrame(() => {
      mdScrollTick.current = null;
      if (scrollGuard.current === "pdf" || scrollGuard.current === "nav")
        return;
      if (!synced || editing) return;
      const position = readingPosition(mdScrollRef.current, "[data-page]");
      if (!position?.page) return;
      setCurrentPage(position.page);
      scrollPdfRatio(position.page, position.ratio, "md");
    });
  };
  useEffect(
    () => () => {
      clearTimeout(scrollGuardTimer.current);
      if (pageScrollTick.current) cancelAnimationFrame(pageScrollTick.current);
      if (mdScrollTick.current) cancelAnimationFrame(mdScrollTick.current);
    },
    [],
  );

  const split = useMemo(() => splitMarkdownByPagemarks(markdown), [markdown]);
  const displayBlocks = split.blocks;
  const mappedCount = displayBlocks.filter((b) => b.pdfPage != null).length;
  const totalPages = pdfDoc?.numPages || 0;
  const searchIndex = useMemo(
    () => buildSearchDocuments(displayBlocks, pageTexts),
    [displayBlocks, pageTexts],
  );
  const searchResult = useMemo(
    () => searchDocuments(searchIndex, settledQuery),
    [searchIndex, settledQuery],
  );
  useEffect(() => {
    const id = window.setTimeout(
      () => setSettledQuery(searchValue.trim()),
      120,
    );
    return () => clearTimeout(id);
  }, [searchValue]);
  useEffect(() => {
    setSearchCursor(0);
  }, [settledQuery]);
  useEffect(() => {
    const close = (event) => {
      if (!searchHolder.current?.contains(event.target)) setSearchOpen(false);
      if (!moreHolder.current?.contains(event.target)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const notify = (text) => {
    setToast(text);
    window.setTimeout(() => setToast((old) => (old === text ? "" : old)), 3500);
  };

  const loadPDF = async (arrayBuffer, filename, demo = false) => {
    const id = ++requestId.current;
    const mdRevisionAtStart = mdImportRevision.current;
    setBusy(true);
    setStatus("正在读取 PDF 文字层…");
    try {
      const task = getDocument({ data: new Uint8Array(arrayBuffer) });
      const nextDoc = await task.promise;
      const pagesItems = [];
      const texts = [];
      const sizes = [];
      const limit = Math.min(nextDoc.numPages, 120);
      for (let i = 1; i <= limit; i++) {
        const p = await nextDoc.getPage(i);
        const layer = await p.getTextContent();
        const view = p.getViewport({ scale: 1 });
        sizes.push({ width: view.width, height: view.height });
        if (id !== requestId.current) return;
        pagesItems.push(layer.items);
        texts.push(layer.items.map((item) => item.str || "").join(" "));
        p.cleanup();
      }
      if (id !== requestId.current) return;
      setPdfDoc((old) => {
        if (old && old !== nextDoc) old.destroy().catch(() => {});
        return nextDoc;
      });
      setPdfItems(pagesItems);
      setPageTexts(texts);
      setPdfSizes(sizes);
      setPdfName(filename);
      if (mdImportRevision.current === mdRevisionAtStart) {
        setMdName(
          demo
            ? "研究札记.md"
            : safeName(filename.replace(/\.pdf$/i, ""), "校勘底稿") + ".md",
        );
        setMarkdown(
          demo ? SEED_MD : buildMarkdownFromPdfPages(pagesItems, filename),
        );
      }
      setCurrentPage(1);
      if (pdfHolder.current) pdfHolder.current.scrollTop = 0;
      if (mdScrollRef.current) mdScrollRef.current.scrollTop = 0;
      setMdFocus(null);
      setMdMatch(null);
      setHighlight(null);
      setEditing(false);
      setZoom(1);
      setStatus(
        nextDoc.numPages > limit
          ? "已索引前 " + limit + " 页 · 其他页面仍可浏览"
          : "浏览器本地处理 · 无需上传",
      );
      if (demo) {
        const excerpt = "面对同一部作品，研究者往往有 PDF 原件";
        const initial = matchPdfTextSlices(pagesItems[0] || [], excerpt);
        if (initial && initial.score >= 500) {
          setHighlight({
            page: 1,
            slices: initial.slices,
            score: initial.score,
            selection: excerpt,
          });
          setMdMatch({ selection: excerpt, page: 1 });
          setMdFocus(1);
        }
      }
      if (!demo) notify("PDF 已导入，并生成带页标的 Markdown 底稿");
    } catch (error) {
      console.error(error);
      setStatus("文件读取失败");
      notify("PDF 读取失败：请确认文件未加密或损坏");
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };

  const loadSample = async () => {
    setBusy(true);
    try {
      const res = await fetch(import.meta.env.BASE_URL + "sample.pdf");
      if (!res.ok) throw new Error("示例 PDF 未找到");
      await loadPDF(await res.arrayBuffer(), "sample.pdf", true);
    } catch (e) {
      setBusy(false);
      setMarkdown(SEED_MD);
      notify("示例 PDF 未能载入，请导入本地 PDF");
    }
  };

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    loadSample();
  }, []);

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMoreOpen(false);
        setSearchOpen(true);
        searchInput.current?.focus();
        searchInput.current?.select();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && editing) {
        e.preventDefault();
        setEditing(false);
        notify("已保留本轮编辑，可导出 Markdown");
      }
      if (e.key === "Escape") {
        setTourStep(-1);
        setSearchOpen(false);
        setMoreOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  const goToPage = (p, scrollMd = true) => {
    if (!totalPages) return;
    const n = Math.max(1, Math.min(totalPages, p));
    setCurrentPage(n);
    scrollToPdf(n, "nav");
    if (scrollMd && synced) scrollToMarkdown(n, "nav");
  };

  const focusPdfSelection = (
    selection,
    preferredPage = null,
    context = {},
    quiet = false,
  ) => {
    if (!pdfDoc || !synced || normalizeText(selection).length < 2) return false;
    const tagged = displayBlocks.some((b) => b.pdfPage != null);
    const strict = preferredPage != null && tagged;
    const preferred = preferredPage || currentPage;
    const candidates = [preferred, preferred + 1, preferred - 1].filter(
      (p, i, arr) => p >= 1 && p <= pdfItems.length && arr.indexOf(p) === i,
    );
    let best = null;
    const tryPage = (number, minScore) => {
      const m = matchPdfTextSlices(
        pdfItems[number - 1] || [],
        selection,
        context,
      );
      if (!m?.slices?.length || m.score < minScore) return;
      if (
        !best ||
        m.score + (number === preferred ? 150 : 0) >
          best.score + (best.page === preferred ? 150 : 0)
      ) {
        best = { page: number, slices: m.slices, score: m.score, selection };
      }
    };
    tryPage(preferred, 380);
    if (!best || best.score < 500) {
      candidates
        .filter((n) => n !== preferred)
        .forEach((n) => tryPage(n, strict ? 850 : 700));
    }
    if (!strict && !best) {
      pdfItems.forEach((_, index) => {
        if (!candidates.includes(index + 1)) tryPage(index + 1, 950);
      });
    }
    if (best) {
      setCurrentPage(best.page);
      scrollToPdf(best.page, "nav", best.slices[0]);
      setHighlight(best);
      setMdMatch({ selection, page: best.page, context });
      setMdFocus(best.page);
      setStatus("已匹配到 PDF 第 " + best.page + " 页");
      return true;
    }
    if (!quiet) notify("未找到可靠匹配；扫描版 PDF 需要先进行 OCR");
    return false;
  };

  const focusMdSelection = (
    selection,
    pdfPage = currentPage,
    context = {},
    quiet = false,
  ) => {
    if (!synced || normalizeText(selection).length < 2) return false;
    const tagged = displayBlocks.some((b) => b.pdfPage != null);
    const candidates = tagged
      ? displayBlocks.filter(
          (b) =>
            b.pdfPage === pdfPage ||
            Math.abs((b.pdfPage || -99) - pdfPage) === 1,
        )
      : displayBlocks;
    let best = null;
    for (const block of candidates) {
      const m = matchSegmentSlices([block.markdown], selection, context);
      if (!m?.slices?.length) continue;
      const samePage = block.pdfPage === pdfPage;
      if (tagged && !samePage && m.score < 850) continue;
      if (
        !best ||
        m.score + (samePage ? 150 : 0) >
          best.score + (best.block.pdfPage === pdfPage ? 150 : 0)
      )
        best = { block, score: m.score };
    }
    if (!best || best.score < 380) {
      if (!quiet) notify("Markdown 中未找到可靠的对应文字");
      return false;
    }
    const page = best.block.pdfPage || pdfPage;
    setMdFocus(page);
    setMdMatch({ selection, page, context, blockIndex: best.block.index });
    if (best.block.pdfPage) setCurrentPage(page);
    setStatus("已定位到 Markdown 对应字词");
    return true;
  };

  // A PDF text-layer selection must remain highlighted even after the browser selection disappears.
  const focusPdfToMd = (selection, pdfPage, context = {}) => {
    if (!synced) return;
    const m = matchPdfTextSlices(
      pdfItems[pdfPage - 1] || [],
      selection,
      context,
    );
    if (m?.slices?.length && m.score >= 380) {
      setHighlight({
        page: pdfPage,
        slices: m.slices,
        score: m.score,
        selection,
      });
      scrollToPdf(pdfPage, "nav", m.slices[0]);
    }
    setCurrentPage(pdfPage);
    focusMdSelection(selection, pdfPage, context);
  };

  // Unlike mouseup-only handlers, this also covers keyboard selections and touch selections.
  useEffect(() => {
    const handleSelection = () => {
      if (!synced || editing) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        selectionSignature.current = null;
        return;
      }
      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const el =
        ancestor.nodeType === Node.TEXT_NODE
          ? ancestor.parentElement
          : ancestor;
      const inMd = el?.closest?.(".md-prose");
      const inPdf = el?.closest?.(".pdf-text-layer");
      if (!inMd && !inPdf) return;
      const text = selection.toString().trim();
      if (normalizeText(text).length < 2 || text.length > 1000) return;
      const pdfPage = Number(
        inPdf?.closest("[data-pdf-page]")?.dataset.pdfPage,
      );
      const previous = selectionSignature.current;
      if (
        previous?.text === text &&
        previous.range.startContainer === range.startContainer &&
        previous.range.endContainer === range.endContainer &&
        previous.range.startOffset === range.startOffset &&
        previous.range.endOffset === range.endOffset
      )
        return;
      selectionSignature.current = { text, range: range.cloneRange() };
      const context = extractSelectionContext(range, inMd || inPdf);
      if (inMd) {
        const block = inMd.closest(".md-page-block");
        const page =
          Number(block?.closest("[data-page]")?.dataset.page) || null;
        focusPdfSelection(
          text,
          block && displayBlocks.some((b) => b.pdfPage === page) ? page : null,
          context,
        );
      } else {
        focusPdfToMd(text, pdfPage, context);
      }
    };
    const schedule = () => {
      clearTimeout(selectionTimer.current);
      selectionTimer.current = setTimeout(handleSelection, 140);
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("mouseup", schedule);
    document.addEventListener("keyup", schedule);
    return () => {
      clearTimeout(selectionTimer.current);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("mouseup", schedule);
      document.removeEventListener("keyup", schedule);
    };
  }, [pdfItems, displayBlocks, synced, editing, currentPage, tourStep]);

  // Keep React's text nodes intact, including in browsers without CSS highlights.
  useEffect(() => {
    CSS.highlights?.delete("collatio-md-match");
    if (!mdMatch || editing) return;
    let clearFallback = () => {};
    const blocks = [...document.querySelectorAll(".md-page-block")];
    const preferred = blocks.filter((b) =>
      mdMatch.blockIndex != null
        ? Number(b.closest("[data-block-index]")?.dataset.blockIndex) ===
          mdMatch.blockIndex
        : Number(b.closest("[data-page]")?.dataset.page) === mdMatch.page,
    );
    const choices = preferred.length ? preferred : blocks;
    for (const block of choices) {
      const prose = block.querySelector(".md-prose");
      if (!prose) continue;
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode())
        if (walker.currentNode.textContent?.trim())
          nodes.push(walker.currentNode);
      const m = matchSegmentSlices(
        nodes.map((n) => n.textContent),
        mdMatch.selection,
        mdMatch.context,
      );
      if (!m?.slices?.length || m.score < 380) continue;
      const ranges = [];
      for (const slice of m.slices) {
        const node = nodes[slice.segIdx];
        if (!node) continue;
        const r = document.createRange();
        r.setStart(node, Math.min(slice.startOffset, node.length));
        r.setEnd(node, Math.min(slice.endOffset, node.length));
        if (!r.collapsed) ranges.push(r);
      }
      if (!ranges.length) continue;
      if (CSS.highlights && typeof Highlight !== "undefined") {
        CSS.highlights.set("collatio-md-match", new Highlight(...ranges));
      } else {
        const holder = block.querySelector(".md-marks-layer");
        if (holder) {
          const draw = () => {
            holder.replaceChildren();
            const origin = holder.getBoundingClientRect();
            for (const range of ranges) {
              for (const rect of range.getClientRects()) {
                if (!rect.width || !rect.height) continue;
                const marker = document.createElement("div");
                marker.className = "md-highlight-box";
                Object.assign(marker.style, {
                  left: rect.left - origin.left + "px",
                  top: rect.top - origin.top + "px",
                  width: rect.width + "px",
                  height: rect.height + "px",
                });
                holder.appendChild(marker);
              }
            }
          };
          draw();
          const observer = new ResizeObserver(draw);
          observer.observe(prose);
          clearFallback = () => {
            observer.disconnect();
            holder.replaceChildren();
          };
        }
      }
      alignRange(mdScrollRef.current, ranges[0]);
      break;
    }
    return () => {
      CSS.highlights?.delete("collatio-md-match");
      clearFallback();
    };
  }, [mdMatch, markdown, editing]);

  const demoMdToPdf = () => {
    const sampleText = "数字工具的价值，在于让细节重新变得可见";
    const sampleMatch = matchPdfTextSlices(pdfItems[0] || [], sampleText);
    if (
      normalizeText(markdown).includes(normalizeText(sampleText)) &&
      sampleMatch?.score >= 380
    ) {
      focusPdfSelection(sampleText, 1);
      return;
    }
    const paragraph =
      mdScrollRef.current?.querySelector(
        '[data-page="' + currentPage + '"] .md-prose p',
      ) || mdScrollRef.current?.querySelector(".md-prose p");
    if (!paragraph) return notify("请先载入有文字层的 PDF 和 Markdown");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    focusPdfSelection(
      paragraph.textContent.trim(),
      Number(paragraph.closest("[data-page]")?.dataset.page) || null,
      extractSelectionContext(range, paragraph.closest(".md-prose")),
    );
  };
  const demoPdfToMd = () => {
    const sampleText = "只有把出处放在眼前，才可能把解释留在证据之内";
    const sampleMatch = matchPdfTextSlices(pdfItems[1] || [], sampleText);
    const sample =
      sampleMatch?.score >= 380 &&
      normalizeText(markdown).includes(normalizeText(sampleText));
    const page = sample ? 2 : Math.max(1, Math.min(currentPage, totalPages));
    const selection = sample
      ? sampleText
      : (pageTexts[page - 1] || "").trim().slice(0, 120);
    if (!selection) return notify("请先载入有文字层的 PDF");
    const items = pdfItems[page - 1] || [];
    const m = matchPdfTextSlices(items, selection);
    if (m?.slices?.length)
      setHighlight({ page, slices: m.slices, score: m.score, selection });
    setCurrentPage(page);
    scrollToPdf(page, "nav", m?.slices?.[0]);
    focusMdSelection(selection, page);
  };
  const demoContinuousScroll = () => {
    if (!totalPages) return notify("请先载入 PDF");
    const page = Math.min(6, totalPages);
    setSynced(true);
    setEditing(false);
    setCurrentPage(page);
    requestAnimationFrame(() => {
      scrollPdfRatio(page, 0.55, "nav");
      scrollMarkdownRatio(page, 0.55, "nav");
    });
    setStatus(`第 ${page} 页 · 两栏按页内 55% 位置对齐；滚动任一栏继续体验`);
  };

  const chooseSearchHit = (hit) => {
    if (!hit) return;
    setSearchOpen(false);
    setSearchCursor(0);
    setHighlight(null);
    setMdMatch(null);
    setMdFocus(null);
    if (hit.page <= totalPages) {
      setCurrentPage(hit.page);
      const exactOnPdf = normalizeText(pageTexts[hit.page - 1] || "").includes(
        normalizeText(hit.matchText),
      );
      const matched = exactOnPdf
        ? matchPdfTextSlices(
            pdfItems[hit.page - 1] || [],
            hit.matchText,
            hit.context,
          )
        : null;
      if (matched?.slices?.length && matched.score >= 380) {
        setHighlight({
          page: hit.page,
          slices: matched.slices,
          score: matched.score,
          selection: hit.matchText,
        });
        scrollToPdf(hit.page, "nav", matched.slices[0]);
      } else {
        scrollToPdf(hit.page, "nav");
      }
    }
    if (
      hit.source === "md" ||
      displayBlocks.some(
        (block) =>
          block.pdfPage === hit.page &&
          normalizeText(block.markdown).includes(normalizeText(hit.matchText)),
      )
    ) {
      setMdFocus(hit.page);
      setMdMatch({
        page: hit.page,
        selection: hit.matchText,
        context: hit.context,
      });
      scrollToMarkdown(hit.page, "nav");
    } else if (synced) {
      scrollToMarkdown(hit.page, "nav");
    }
    setStatus(
      "搜索定位 · " +
        (hit.source === "md" ? "Markdown" : "PDF") +
        " 第 " +
        hit.page +
        " 页",
    );
    searchInput.current?.blur();
  };
  const search = (event) => {
    event?.preventDefault();
    const live =
      searchValue.trim() === settledQuery
        ? searchResult
        : searchDocuments(searchIndex, searchValue.trim());
    if (!live.hits.length) {
      setSearchOpen(true);
      return;
    }
    chooseSearchHit(live.hits[Math.min(searchCursor, live.hits.length - 1)]);
  };
  const onSearchKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(false);
      searchInput.current?.blur();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSearchOpen(true);
      if (searchResult.hits.length)
        setSearchCursor(
          (i) =>
            (i +
              (event.key === "ArrowDown" ? 1 : -1) +
              searchResult.hits.length) %
            searchResult.hits.length,
        );
    }
  };

  const changeBlock = (index, value) => {
    setMarkdown((current) =>
      replaceBlockInMarkdown(splitMarkdownByPagemarks(current), index, value),
    );
  };

  const autoPaginate = () => {
    if (!pageTexts.length) return notify("请先导入有文字层的 PDF");
    const result = autoInsertPagemarks(markdown, pageTexts);
    setMarkdown(result.markdown);
    notify(
      result.insertedCount > 0
        ? "已自动插入 " + result.insertedCount + " 个页标"
        : "无需新增页标，或尚未找到可靠分界",
    );
  };

  const exportMd = () => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = mdName.endsWith(".md") ? mdName : mdName + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    notify("Markdown 已导出到下载目录");
  };

  const onPdfInput = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf"))
      return notify("请选择 .pdf 文件");
    await loadPDF(await f.arrayBuffer(), f.name);
    e.target.value = "";
  };
  const onMdInput = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!/\.(md|markdown|txt)$/i.test(f.name))
      return notify("请选择 .md 或 .txt 文件");
    mdImportRevision.current += 1;
    setMarkdown(await f.text());
    setMdName(f.name);
    setMdFocus(null);
    setMdMatch(null);
    setHighlight(null);
    notify("Markdown 已导入；可以划选文本对照 PDF");
    e.target.value = "";
  };
  const onDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    const pdf = files.find((f) => /\.pdf$/i.test(f.name));
    const md = files.find((f) => /\.(md|txt|markdown)$/i.test(f.name));
    if (pdf) await loadPDF(await pdf.arrayBuffer(), pdf.name);
    if (md) {
      mdImportRevision.current += 1;
      setMarkdown(await md.text());
      setMdName(md.name);
      setMdFocus(null);
      setMdMatch(null);
      setHighlight(null);
      notify("文件已导入");
    }
  };

  return (
    <div
      className={"app" + (dark ? " dark" : "")}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <input
        ref={pdfInput}
        hidden
        type="file"
        accept=".pdf,application/pdf"
        onChange={onPdfInput}
      />
      <input
        ref={mdInput}
        hidden
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        onChange={onMdInput}
      />
      <header className="app-header simplified-header">
        <div className="header-left">
          <button
            className="icon-button header-menu-trigger"
            aria-label="打开文件导航"
            title="文献与页码"
            onClick={() => setSidebar((value) => !value)}
          >
            <Menu size={19} />
          </button>
          <MiniLogo />
          <div className="brand-lockup">
            <span className="brand-word">
              collatio<span className="brand-dot">.</span>
            </span>
          </div>
        </div>
        <div className="header-center" ref={searchHolder}>
          <form
            className={"global-search" + (searchOpen ? " is-open" : "")}
            role="search"
            onSubmit={search}
          >
            <Search size={17} />
            <input
              ref={searchInput}
              aria-label="搜索文献"
              placeholder="搜索 PDF 与 Markdown…"
              autoComplete="off"
              value={searchValue}
              onFocus={() => {
                setSearchOpen(true);
                setMoreOpen(false);
              }}
              onChange={(e) => {
                setSearchValue(e.target.value);
                setSearchOpen(true);
              }}
              onKeyDown={onSearchKeyDown}
              aria-expanded={searchOpen && !!searchValue.trim()}
              aria-controls="search-results"
            />
            {searchValue && (
              <button
                type="button"
                className="search-clear"
                title="清空搜索"
                aria-label="清空搜索"
                onClick={() => {
                  setSearchValue("");
                  setSearchCursor(0);
                  searchInput.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
            {!searchValue && <kbd>⌘ K</kbd>}
          </form>
          {searchOpen && !!searchValue.trim() && (
            <div
              id="search-results"
              className="search-results"
              role="listbox"
              aria-label="文献搜索结果"
            >
              <div className="search-results-title">
                <span>
                  {settledQuery !== searchValue.trim()
                    ? "正在搜索…"
                    : searchResult.total
                      ? "找到 " + searchResult.total + " 处结果"
                      : "没有找到匹配内容"}
                </span>
                <span>Markdown / PDF</span>
              </div>
              {settledQuery === searchValue.trim() &&
              searchResult.hits.length ? (
                <div className="search-results-scroll">
                  {searchResult.hits.map((hit, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === searchCursor}
                      className={
                        "search-hit" +
                        (index === searchCursor ? " selected" : "")
                      }
                      key={hit.key}
                      onMouseEnter={() => setSearchCursor(index)}
                      onClick={() => chooseSearchHit(hit)}
                    >
                      <span className={"hit-source " + hit.source}>
                        {hit.source === "md" ? "MD" : "PDF"}
                      </span>
                      <span className="hit-main">
                        <span className="hit-location">
                          第 {hit.page} 页 ·{" "}
                          {hit.source === "md" ? "校勘稿" : "PDF 原文"}
                        </span>
                        <span className="hit-excerpt">
                          {hit.excerptBefore}
                          <mark>{hit.matchText}</mark>
                          {hit.excerptAfter}
                        </span>
                      </span>
                      <ArrowRight size={14} className="hit-arrow" />
                    </button>
                  ))}
                  {searchResult.total > searchResult.hits.length && (
                    <p className="search-truncated">
                      仅展示前 {searchResult.hits.length}{" "}
                      条，可输入更长的关键词缩小范围。
                    </p>
                  )}
                </div>
              ) : (
                settledQuery === searchValue.trim() && (
                  <div className="search-empty">
                    当前两份文献中没有这个词。试试更短的关键词；扫描版 PDF
                    请先进行 OCR。
                  </div>
                )
              )}
              <div className="search-results-footer">
                ↑ ↓ 选择结果 <span>Enter 定位 · Esc 关闭</span>
              </div>
            </div>
          )}
        </div>
        <div className="header-right simplified-actions">
          <button
            className="header-export"
            onClick={exportMd}
            title="下载当前 Markdown"
          >
            <ArrowDownToLine size={15} />
            <span>导出</span>
          </button>
          <div className="more-anchor" ref={moreHolder}>
            <button
              className={
                "icon-button more-trigger" + (moreOpen ? " selected" : "")
              }
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => {
                setMoreOpen((value) => !value);
                setSearchOpen(false);
              }}
            >
              <MoreHorizontal size={21} />
            </button>
            {moreOpen && (
              <div className="more-menu" role="menu" aria-label="更多操作">
                <div className="more-menu-group">
                  <span className="more-menu-label">文件</span>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      pdfInput.current?.click();
                    }}
                  >
                    <FileUp size={16} /> 导入 PDF
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      mdInput.current?.click();
                    }}
                  >
                    <FileText size={16} /> 导入 Markdown
                  </button>
                  <button
                    role="menuitem"
                    disabled={!pdfDoc || busy}
                    onClick={() => {
                      setMoreOpen(false);
                      autoPaginate();
                    }}
                  >
                    <WandSparkles size={16} /> 自动分页
                  </button>
                </div>
                <div className="more-menu-group">
                  <span className="more-menu-label">阅读</span>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setSynced(!synced);
                      if (!synced && !editing) {
                        const position = readingPosition(
                          mdScrollRef.current,
                          "[data-page]",
                        );
                        if (position?.page) {
                          setCurrentPage(position.page);
                          scrollPdfRatio(position.page, position.ratio, "nav");
                        }
                      }
                      setMoreOpen(false);
                    }}
                  >
                    <Link2 size={16} /> 双栏滚动联动{" "}
                    <span className="more-menu-meta">
                      {synced ? "开启" : "关闭"}
                    </span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setSwapped((value) => !value);
                      setMoreOpen(false);
                    }}
                  >
                    <ArrowLeftRight size={16} /> 交换左右栏
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setDark((value) => !value);
                      setMoreOpen(false);
                    }}
                  >
                    {dark ? <Sun size={16} /> : <Moon size={16} />}{" "}
                    {dark ? "浅色外观" : "深色外观"}
                  </button>
                </div>
                <div className="more-menu-group">
                  <span className="more-menu-label">帮助</span>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      setTourStep(0);
                    }}
                  >
                    <BookOpen size={16} /> 新手教程
                  </button>
                  <a
                    role="menuitem"
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setMoreOpen(false)}
                  >
                    <Github size={16} /> GitHub 仓库{" "}
                    <ExternalLink size={14} className="menu-external" />
                  </a>
                </div>
                <div className="more-menu-foot">
                  <ShieldCheck size={13} /> 所有文献都在浏览器本地处理
                </div>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="app-main">
        <aside className={"left-sidebar" + (sidebar ? "" : " collapsed")}>
          <div className="side-section library">
            <div className="side-eyebrow">
              当前文献 <span>DOCUMENTS</span>
            </div>
            <div className="sidebar-file active-file">
              <span className="file-icon pdf">
                <FileText size={17} />
              </span>
              <span className="sidebar-file-text">
                <strong title={pdfName}>{pdfName}</strong>
                <small>原始文献 · {totalPages || "—"} 页</small>
              </span>
              <Check size={15} className="muted-check" />
            </div>
            <div className="sidebar-file">
              <span className="file-icon md">
                <FileText size={17} />
              </span>
              <span className="sidebar-file-text">
                <strong title={mdName}>{mdName}</strong>
                <small>Markdown 校勘底稿</small>
              </span>
            </div>
          </div>
          <div className="sidebar-rule" />
          <div className="side-section">
            <div className="side-eyebrow">
              页面导航 <span>{mappedCount} MARKS</span>
            </div>
            <div className="page-navigation">
              {Array.from(
                { length: Math.min(totalPages || 3, 15) },
                (_, i) => i + 1,
              ).map((n) => (
                <button
                  key={n}
                  className={
                    "page-nav-item" + (n === currentPage ? " active" : "")
                  }
                  onClick={() => goToPage(n)}
                >
                  <span className="page-nav-icon">
                    {String(n).padStart(2, "0")}
                  </span>
                  <span>第 {n} 页</span>
                  {n === currentPage && (
                    <span className="page-nav-active-dot" />
                  )}
                </button>
              ))}
              {totalPages > 15 && (
                <span className="nav-more">
                  共 {totalPages} 页 · 使用右侧翻页
                </span>
              )}
            </div>
          </div>
        </aside>

        <main className="work-main">
          <div className="workbench">
            <div className="workbench-utility">
              <div className="workspace-label">
                <span className="label-icon">
                  <Layers3 size={17} />
                </span>
                <strong>双轨校勘</strong>
                <span className="demo-version" title="与 Obsidian 插件版本同步">
                  v{manifest.version}
                </span>
                <span
                  className="document-pair"
                  title={mdName + " ↔ " + pdfName}
                >
                  {mdName} <ArrowLeftRight size={12} /> {pdfName}
                </span>
              </div>
            </div>
            {pdfDoc ? (
              <div className={"panes" + (swapped ? " swapped" : "")}>
                <section className="pane md-pane">
                  <div className="pane-header">
                    <div className="pane-tab">
                      <span className="tab-icon md-tab">
                        <FileText size={15} />
                      </span>
                      <div>
                        <strong>Markdown</strong>
                        <small>校勘与整理稿</small>
                      </div>
                    </div>
                    <div className="pane-tools">
                      <button
                        className={"pill-button" + (editing ? " enabled" : "")}
                        onClick={() => {
                          setEditing((s) => !s);
                          if (editing) notify("改动已保留，点击导出可保存");
                        }}
                      >
                        <Pencil size={13} /> {editing ? "完成编辑" : "编辑"}
                      </button>
                      <span className="tiny-dot" />
                    </div>
                  </div>
                  <div className="pane-subbar">
                    <span className="pane-filename">
                      <FileText size={13} />
                      {mdName}
                    </span>
                    <span className="file-type">MARKDOWN</span>
                  </div>
                  <div className="reading-surface">
                    <ReadingGuide visible={synced && !editing} />
                    <div
                      ref={mdScrollRef}
                      className="md-scroll"
                      onScroll={onMarkdownScroll}
                      onWheel={releaseScroll}
                      onPointerDown={releaseScroll}
                      onTouchStart={releaseScroll}
                      onKeyDown={releaseScroll}
                    >
                      <div className="md-document">
                        <div className="doc-headline">
                          <span className="doc-type">
                            ANNOTATED TEXT · 校勘底稿
                          </span>
                          <h2>{mdName.replace(/\.md$/i, "")}</h2>
                          <span className="doc-underline" />
                        </div>
                        {displayBlocks.map((block, index) => (
                          <div
                            key={index}
                            data-page={block.pdfPage ?? undefined}
                            data-block-index={block.index}
                          >
                            <MarkdownBlock
                              block={block}
                              active={(block.pdfPage || 1) === currentPage}
                              highlighted={mdFocus === (block.pdfPage || 1)}
                              pageFallback={1}
                              onClick={goToPage}
                              onSelect={(text, page, context) =>
                                focusPdfSelection(text, page, context)
                              }
                              editing={editing}
                              onChange={changeBlock}
                            />
                          </div>
                        ))}
                        <div className="end-of-document">
                          END OF DOCUMENT <span>✦</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="pane-footer">
                    <span>
                      <span className="footer-green" />{" "}
                      {editing ? "编辑模式 · 尚未导出" : "文档已就绪"}
                    </span>
                    <span>MD · {markdown.length.toLocaleString()} 字符</span>
                  </div>
                </section>

                <section className="pane pdf-pane">
                  <div className="pane-header">
                    <div className="pane-tab">
                      <span className="tab-icon pdf-tab">
                        <FileText size={15} />
                      </span>
                      <div>
                        <strong>Original PDF</strong>
                        <small>原件与版面证据</small>
                      </div>
                    </div>
                    <div className="pane-tools">
                      <span className="read-only">
                        <ShieldCheck size={13} /> 原件只读
                      </span>
                    </div>
                  </div>
                  <div className="pdf-toolbar">
                    <div className="pdf-pagination">
                      <button
                        className="icon-button"
                        aria-label="上一页"
                        disabled={currentPage <= 1}
                        onClick={() => goToPage(currentPage - 1)}
                      >
                        <ChevronLeft size={17} />
                      </button>
                      <span className="page-current">{currentPage}</span>
                      <span className="page-slash">/</span>
                      <span>{totalPages}</span>
                      <button
                        className="icon-button"
                        aria-label="下一页"
                        disabled={currentPage >= totalPages}
                        onClick={() => goToPage(currentPage + 1)}
                      >
                        <ChevronRight size={17} />
                      </button>
                    </div>
                    <div className="pdf-zoom">
                      <button
                        className="icon-button"
                        aria-label="缩小"
                        onClick={() =>
                          setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))
                        }
                      >
                        <ZoomOut size={16} />
                      </button>
                      <span>{Math.round(zoom * 100)}%</span>
                      <button
                        className="icon-button"
                        aria-label="放大"
                        onClick={() =>
                          setZoom((z) => Math.min(1.8, +(z + 0.1).toFixed(2)))
                        }
                      >
                        <ZoomIn size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="reading-surface">
                    <ReadingGuide visible={synced && !editing} />
                    <div
                      ref={pdfHolder}
                      className="pdf-scroll continuous-pdf"
                      onScroll={onPdfScroll}
                      onWheel={releaseScroll}
                      onPointerDown={releaseScroll}
                      onTouchStart={releaseScroll}
                      onKeyDown={releaseScroll}
                    >
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                        (n) => {
                          const size = pdfSizes[n - 1] ||
                            pdfSizes[0] || { width: 595, height: 842 };
                          const width = Math.round(
                            Math.min(
                              size.width * 1.55,
                              Math.max(240, pdfPaneWidth - 78),
                            ) * zoom,
                          );
                          const height = Math.round(
                            (width * size.height) / size.width,
                          );
                          return (
                            <section
                              className="pdf-page-section"
                              data-pdf-page={n}
                              key={n}
                            >
                              {Math.abs(currentPage - n) <= 2 ||
                              highlight?.page === n ? (
                                <PDFPage
                                  doc={pdfDoc}
                                  items={pdfItems}
                                  page={n}
                                  width={width}
                                  height={height}
                                  highlight={highlight}
                                />
                              ) : (
                                <div className="pdf-stage continuous-stage">
                                  <div
                                    className="pdf-placeholder"
                                    style={{ width, height }}
                                    aria-label={
                                      "PDF 第 " + n + " 页，滚动后加载"
                                    }
                                  />
                                  <div className="pdf-under">
                                    <span>ORIGINAL DOCUMENT</span>
                                    <span>
                                      PAGE {String(n).padStart(2, "0")}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </section>
                          );
                        },
                      )}
                    </div>
                  </div>
                  <div className="pane-footer pdf-footer">
                    <span>
                      <Crosshair size={13} />{" "}
                      {highlight
                        ? "已高亮匹配文字"
                        : "滚轮连续阅读 · 划选文字可定位"}
                    </span>
                    <span>{pdfName}</span>
                  </div>
                </section>
              </div>
            ) : (
              <WelcomeCard
                onPdf={() => pdfInput.current?.click()}
                onMd={() => mdInput.current?.click()}
                onReset={loadSample}
              />
            )}
          </div>
        </main>
      </div>

      {tourStep >= 0 && (
        <div className="tour-card" role="dialog" aria-label="双轨校勘新手引导">
          <div className="tour-top">
            <span className="tour-kicker">INTERACTIVE GUIDE</span>
            <span className="tour-count">{tourStep + 1} / 5</span>
            <button
              className="icon-button"
              aria-label="退出教程"
              onClick={() => setTourStep(-1)}
            >
              <X size={16} />
            </button>
          </div>
          <div className="tour-progress">
            {[0, 1, 2, 3, 4].map((n) => (
              <span key={n} className={n <= tourStep ? "active" : ""} />
            ))}
          </div>
          <h2>
            {
              [
                "欢迎来到双轨校勘",
                "让 Markdown 自动定位 PDF",
                "从 PDF 反向高亮 Markdown",
                "沿着同一条基准线连续阅读",
                "换成你自己的文献",
              ][tourStep]
            }
          </h2>
          <p>
            {
              [
                `左栏是可编辑的校勘稿，右栏是原始 PDF。十二页示例已准备好，可体验 ${manifest.version} 的连续联动、上下文定位和持久高亮。`,
                "在 Markdown 中划选一句话，或者直接点击一个段落。PDF 会定位到对应文字，并沿阅读基准线对齐；重复词会结合前后文和页内位置匹配。",
                "在 PDF 上划选文字，Markdown 也会定位并高亮。取消原生选区、滚动翻页或调整缩放后，匹配高亮仍会保留，直到下一次定位。",
                "浅色虚线位于阅读区域的 35%。滚动任一栏时，另一栏会跟随同一页内的相对位置；无需等到翻页。点击下方按钮试读第六页，再滚动任一栏。",
                "导入自己的 PDF 会生成 Markdown 底稿，也能导入已有 Markdown。修改后点击“导出”保存文件，全部在浏览器本地完成。",
              ][tourStep]
            }
          </p>
          {tourStep === 1 && (
            <button className="tour-demo-button" onClick={demoMdToPdf}>
              <Highlighter size={15} /> 演示：Markdown → PDF 自动高亮{" "}
              <Play size={13} />
            </button>
          )}
          {tourStep === 2 && (
            <button className="tour-demo-button" onClick={demoPdfToMd}>
              <Highlighter size={15} /> 演示：PDF → Markdown 精确高亮{" "}
              <Play size={13} />
            </button>
          )}
          {tourStep === 3 && (
            <button className="tour-demo-button" onClick={demoContinuousScroll}>
              <Link2 size={15} /> 演示：页内连续联动 <Play size={13} />
            </button>
          )}
          {tourStep === 4 && (
            <div className="tour-import">
              <button
                onClick={() => {
                  setTourStep(-1);
                  pdfInput.current?.click();
                }}
              >
                <FileUp size={14} /> 导入 PDF
              </button>
              <button
                onClick={() => {
                  setTourStep(-1);
                  mdInput.current?.click();
                }}
              >
                <FileText size={14} /> 导入 MD
              </button>
            </div>
          )}
          <div className="tour-bottom">
            <button
              className="tour-skip"
              onClick={() => {
                setTourStep(-1);
              }}
            >
              {tourStep === 4 ? "完成教程" : "跳过教程"}
            </button>
            <div className="tour-buttons">
              {tourStep > 0 && (
                <button
                  className="tour-back"
                  onClick={() => setTourStep((s) => s - 1)}
                >
                  上一步
                </button>
              )}
              <button
                className="btn primary"
                onClick={() => {
                  if (tourStep === 4) {
                    setTourStep(-1);
                  } else setTourStep((s) => s + 1);
                }}
              >
                {tourStep === 4 ? "开始使用" : "下一步"}{" "}
                <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
      {busy && (
        <div className="busy-overlay">
          <div className="busy-box">
            <LoaderCircle size={26} className="spin" />
            <strong>正在建立文字索引</strong>
            <span>所有处理都在当前浏览器中完成</span>
          </div>
        </div>
      )}
      <Toast message={toast} onClose={() => setToast("")} />
    </div>
  );
}
