import { normalizeText } from "../../src/compare.ts";

/** Build a searchable, punctuation-tolerant index while preserving source offsets. */
function readable(text) {
  return text
    .replace(/^\s*\[pdf\.\s*\d+\]\s*$/gim, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
    .replace(/\[\^([^\]]+)\]/g, " ")
    .replace(/\*\*|__|~~|\x60/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function indexed(text) {
  let normalized = "";
  const offsets = [];
  for (let i = 0; i < text.length; i++) {
    const output = normalizeText(text[i]);
    for (const char of output) {
      normalized += char;
      offsets.push(i);
    }
  }
  return { text, normalized, offsets };
}

export function buildSearchDocuments(blocks, pageTexts) {
  const docs = [];
  for (const block of blocks) {
    const raw = readable(block.markdown);
    if (raw)
      docs.push({ source: "md", page: block.pdfPage || 1, ...indexed(raw) });
  }
  pageTexts.forEach((raw, index) => {
    if (raw)
      docs.push({ source: "pdf", page: index + 1, ...indexed(readable(raw)) });
  });
  return docs;
}

export function searchDocuments(documents, query, limit = 60) {
  const needle = normalizeText(query.trim());
  if (!needle || needle.length > 150) return { hits: [], total: 0 };
  const hits = [];
  let total = 0;
  for (const doc of documents) {
    if (!doc.normalized) continue;
    let from = 0;
    while (from < doc.normalized.length) {
      const index = doc.normalized.indexOf(needle, from);
      if (index < 0) break;
      total++;
      if (hits.length < limit) {
        const start = doc.offsets[index] ?? index;
        const last = doc.offsets[index + needle.length - 1] ?? start;
        const end = last + 1;
        const left = Math.max(0, start - 32);
        const right = Math.min(doc.text.length, end + 44);
        hits.push({
          key: doc.source + "-" + doc.page + "-" + index,
          source: doc.source,
          page: doc.page,
          matchText: doc.text.slice(start, end),
          excerptBefore: (left ? "…" : "") + doc.text.slice(left, start),
          excerptAfter:
            doc.text.slice(end, right) + (right < doc.text.length ? "…" : ""),
          context: {
            before: doc.text.slice(Math.max(0, start - 80), start),
            after: doc.text.slice(end, Math.min(doc.text.length, end + 80)),
            progress: index / Math.max(1, doc.normalized.length),
          },
        });
      }
      from = index + Math.max(needle.length, 1);
    }
  }
  hits.sort(
    (a, b) =>
      a.page - b.page ||
      (a.source === b.source ? 0 : a.source === "md" ? -1 : 1),
  );
  return { hits, total };
}
