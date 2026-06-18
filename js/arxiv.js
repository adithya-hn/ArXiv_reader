// arxiv.js
// Talks to the public arXiv API (export.arxiv.org) and parses its Atom feed
// into plain objects the rest of the app can use.

const API_BASE = "https://export.arxiv.org/api/query";

// arXiv asks API clients not to hammer the endpoint. We keep a tiny queue
// so rapid tab-switching/searching never fires overlapping requests.
let lastRequestAt = 0;
const MIN_GAP_MS = 3000;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttledFetch(url) {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_GAP_MS) {
    await wait(MIN_GAP_MS - elapsed);
  }
  lastRequestAt = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`arXiv API responded with ${res.status}`);
  }
  return res.text();
}

function text(node, tag) {
  const el = node.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : "";
}

function parsePdfLink(entry, idWithVersion) {
  const links = entry.getElementsByTagName("link");
  for (const link of links) {
    const title = link.getAttribute("title");
    const type = link.getAttribute("type");
    if (title === "pdf" || type === "application/pdf") {
      return link.getAttribute("href");
    }
  }
  return `https://arxiv.org/pdf/${idWithVersion}`;
}

function parseEntry(entry) {
  const rawId = text(entry, "id"); // e.g. http://arxiv.org/abs/2401.01234v2
  const match = rawId.match(/abs\/([^v]+)v?(\d+)?/);
  const idNoVersion = match ? match[1] : rawId;
  const version = match && match[2] ? `v${match[2]}` : "";
  const idWithVersion = idNoVersion + version;

  const categories = Array.from(entry.getElementsByTagName("category")).map(
    (c) => c.getAttribute("term")
  );

  const authors = Array.from(entry.getElementsByTagName("author")).map((a) =>
    text(a, "name")
  );

  let primaryCategory = categories[0] || "";
  const primaryEl = entry.getElementsByTagName("arxiv:primary_category")[0];
  if (primaryEl) {
    primaryCategory = primaryEl.getAttribute("term") || primaryCategory;
  }

  return {
    id: idNoVersion,
    idWithVersion,
    title: text(entry, "title").replace(/\s+/g, " ").trim(),
    summary: text(entry, "summary").replace(/\s+/g, " ").trim(),
    authors,
    published: text(entry, "published"),
    updated: text(entry, "updated"),
    categories,
    primaryCategory,
    pdfUrl: parsePdfLink(entry, idWithVersion),
    absUrl: `https://arxiv.org/abs/${idNoVersion}`,
    comment: text(entry, "arxiv:comment"),
  };
}

function parseFeed(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const errorNode = doc.getElementsByTagName("parsererror")[0];
  if (errorNode) {
    throw new Error("Could not parse arXiv response");
  }
  const totalResultsEl = doc.getElementsByTagName("opensearch:totalResults")[0];
  const totalResults = totalResultsEl ? parseInt(totalResultsEl.textContent, 10) : null;
  const entries = Array.from(doc.getElementsByTagName("entry")).map(parseEntry);
  return { entries, totalResults };
}

function buildSearchQuery({ categories, keywords }) {
  const parts = [];
  if (categories && categories.length) {
    if (categories.length === 1) {
      parts.push(`cat:${categories[0]}`);
    } else {
      parts.push("(" + categories.map((c) => `cat:${c}`).join(" OR ") + ")");
    }
  }
  if (keywords && keywords.trim()) {
    const cleaned = keywords.trim();
    // Allow the user to type author:, ti:, abs: prefixes directly; otherwise
    // search across title+abstract+author.
    if (/^(au|ti|abs|cat|all):/i.test(cleaned)) {
      parts.push(cleaned);
    } else {
      const words = cleaned.split(/\s+/).join("+");
      parts.push(`(ti:"${cleaned}" OR abs:"${cleaned}" OR au:"${cleaned}")`);
    }
  }
  return parts.length ? parts.join(" AND ") : "all:*";
}

/**
 * Fetch a feed for one or more categories, newest first.
 */
export async function fetchByCategory({ categories, start = 0, maxResults = 25 }) {
  const search_query = buildSearchQuery({ categories });
  const url =
    `${API_BASE}?search_query=${encodeURIComponent(search_query)}` +
    `&start=${start}&max_results=${maxResults}` +
    `&sortBy=submittedDate&sortOrder=descending`;
  const xml = await throttledFetch(url);
  return parseFeed(xml);
}

/**
 * Free-text search, optionally scoped to categories.
 */
export async function searchPapers({ keywords, categories, start = 0, maxResults = 25, sortBy = "relevance" }) {
  const search_query = buildSearchQuery({ categories, keywords });
  const url =
    `${API_BASE}?search_query=${encodeURIComponent(search_query)}` +
    `&start=${start}&max_results=${maxResults}` +
    `&sortBy=${sortBy === "newest" ? "submittedDate" : "relevance"}&sortOrder=descending`;
  const xml = await throttledFetch(url);
  return parseFeed(xml);
}

export function feedCacheKey({ categories, keywords }) {
  return JSON.stringify({ categories: categories || [], keywords: keywords || "" });
}
