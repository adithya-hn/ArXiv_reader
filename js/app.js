// app.js
import * as db from "./db.js";
import * as arxiv from "./arxiv.js";
import * as reader from "./reader.js";
import {
  ARCHIVES,
  DEFAULT_QUICK_CATEGORIES,
  categoryLabel,
  categoryAccent,
} from "./categories.js";

const el = (id) => document.getElementById(id);
const PAGE_SIZE = 20;

const state = {
  quickCategories: [...DEFAULT_QUICK_CATEGORIES],
  todayCategory: "astro-ph.SR",
  todayStart: 0,
  todayHasMore: true,
  todayLoading: false,

  searchStart: 0,
  searchHasMore: true,
  searchLoading: false,
  lastSearchParams: null,

  libraryFilter: "all",
};

// ---------------------------------------------------------------- toast ----

let toastTimer = null;
function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

// ------------------------------------------------------------ formatting --

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtAuthors(authors) {
  if (!authors || !authors.length) return "Unknown authors";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 2).join(", ")}, et al. (${authors.length})`;
}

// ------------------------------------------------------------ paper card --

function categoryChipHTML(code) {
  const accent = categoryAccent(code);
  return `<span class="chip-cat accent-${accent}" title="${categoryLabel(code)}">${code}</span>`;
}

async function buildCardActions(paper) {
  const saved = await db.isInLibrary(paper.id);
  const downloaded = await db.hasPdfBlob(paper.id);
  const note = await db.getNote(paper.id);
  const hasNote = !!(note && note.text && note.text.trim());

  return `
    <button class="btn btn-ghost btn-save ${saved ? "is-active" : ""}" data-action="save" data-id="${paper.id}">
      ${saved ? "✓ Saved" : "Save"}
    </button>
    <button class="btn btn-ghost btn-download" data-action="download" data-id="${paper.id}">
      ${downloaded ? "Downloaded" : "Download"}
    </button>
    <button class="btn btn-primary btn-read" data-action="read" data-id="${paper.id}">
      Read
    </button>
    ${hasNote ? '<span class="note-dot" title="Has notes"></span>' : ""}
  `;
}

async function renderPaperCard(paper) {
  const card = document.createElement("article");
  card.className = "paper-card";
  card.dataset.id = paper.id;

  const cats = paper.categories && paper.categories.length ? paper.categories : [paper.primaryCategory];
  const catChips = cats.slice(0, 3).map(categoryChipHTML).join("");

  card.innerHTML = `
    <div class="card-top">
      <div class="card-cats">${catChips}</div>
      <span class="card-id">${paper.id}</span>
    </div>
    <h3 class="card-title" data-action="toggle-abstract">${paper.title}</h3>
    <p class="card-byline">${fmtAuthors(paper.authors)} · ${fmtDate(paper.published)}</p>
    <p class="card-abstract">${paper.summary}</p>
    <div class="card-actions">${await buildCardActions(paper)}</div>
  `;
  return card;
}

async function renderPaperList(container, papers, { append = false } = {}) {
  if (!append) container.innerHTML = "";
  for (const paper of papers) {
    container.appendChild(await renderPaperCard(paper));
  }
}

// Shared click handling for any container of paper cards.
async function handleCardAction(action, id, container) {
  const card = container.querySelector(`.paper-card[data-id="${CSS.escape(id)}"]`);
  if (action === "toggle-abstract") {
    card.classList.toggle("expanded");
    return;
  }
  const paper = await findPaperById(id);
  if (!paper) return;

  if (action === "save") {
    const already = await db.isInLibrary(id);
    if (already) {
      await db.removeLibraryPaper(id);
      toast("Removed from library");
    } else {
      await db.saveLibraryPaper(paper);
      toast("Saved to library");
    }
    refreshCardActions(card, paper);
    if (el("view-library").classList.contains("active")) renderLibrary();
  }

  if (action === "download") {
    const btn = card.querySelector(".btn-download");
    btn.textContent = "Downloading…";
    btn.disabled = true;
    try {
      await reader.downloadPdf(paper);
      await db.saveLibraryPaper(paper); // reading material belongs in the library
      toast("PDF saved for offline reading");
    } catch (err) {
      toast("Couldn't save the PDF — it'll open in Safari instead");
    }
    btn.disabled = false;
    refreshCardActions(card, paper);
  }

  if (action === "read") {
    await db.saveLibraryPaper(paper);
    openPaper(paper);
    refreshCardActions(card, paper);
  }

  if (action === "remove") {
    await db.removeLibraryPaper(id);
    toast("Removed from library");
    renderLibrary();
  }
}

async function refreshCardActions(card, paper) {
  const actions = card.querySelector(".card-actions");
  if (actions) actions.innerHTML = await buildCardActions(paper);
}

// Each list view keeps its own in-memory copy of fetched papers so card
// actions can look themselves up without re-hitting the network.
const listCache = {
  today: new Map(),
  search: new Map(),
  library: new Map(),
};

async function findPaperById(id) {
  for (const cache of Object.values(listCache)) {
    if (cache.has(id)) return cache.get(id);
  }
  return db.getLibraryPaper(id);
}

function cacheEntries(map, entries) {
  entries.forEach((p) => map.set(p.id, p));
}

// --------------------------------------------------------------- tab nav --

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "library") renderLibrary();
}

// --------------------------------------------------------------- today ----

function renderQuickChips() {
  const wrap = el("today-chips");
  wrap.innerHTML = "";
  for (const code of state.quickCategories) {
    const chip = document.createElement("button");
    chip.className = "chip" + (code === state.todayCategory ? " active" : "");
    chip.textContent = code;
    chip.title = categoryLabel(code);
    chip.addEventListener("click", () => {
      state.todayCategory = code;
      renderQuickChips();
      loadToday({ reset: true });
    });
    wrap.appendChild(chip);
  }
}

async function loadToday({ reset = false } = {}) {
  if (state.todayLoading) return;
  state.todayLoading = true;
  if (reset) {
    state.todayStart = 0;
    state.todayHasMore = true;
    el("today-feed-list").innerHTML = "";
  }
  const cacheKey = arxiv.feedCacheKey({ categories: [state.todayCategory] });

  if (reset) {
    const cached = await db.getFeedCache(cacheKey);
    if (cached) {
      cacheEntries(listCache.today, cached.entries);
      await renderPaperList(el("today-feed-list"), cached.entries);
      el("today-updated").textContent = `Cached · ${new Date(cached.fetchedAt).toLocaleTimeString()}`;
    }
  }

  el("today-load-more-btn").textContent = "Loading…";
  el("today-load-more-btn").disabled = true;
  try {
    const { entries } = await arxiv.fetchByCategory({
      categories: [state.todayCategory],
      start: state.todayStart,
      maxResults: PAGE_SIZE,
    });
    cacheEntries(listCache.today, entries);
    await renderPaperList(el("today-feed-list"), entries, { append: !reset });
    el("today-empty").hidden = entries.length > 0 || state.todayStart > 0;
    state.todayHasMore = entries.length === PAGE_SIZE;
    state.todayStart += entries.length;
    el("today-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if (reset) await db.setFeedCache(cacheKey, entries);
  } catch (err) {
    toast("Couldn't reach arXiv — showing what's cached");
  }
  el("today-load-more-btn").disabled = false;
  el("today-load-more-btn").textContent = "Load more";
  el("today-load-more-btn").hidden = !state.todayHasMore;
  state.todayLoading = false;
}

// -------------------------------------------------------------- search ----

function populateSearchCategorySelect() {
  const select = el("search-category-select");
  select.innerHTML = '<option value="">All categories</option>';
  for (const group of ARCHIVES) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const [code, label] of group.categories) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = `${code} — ${label}`;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
}

async function runSearch({ reset = true } = {}) {
  if (state.searchLoading) return;
  const keywords = el("search-input").value.trim();
  const category = el("search-category-select").value;
  const sortBy = el("search-sort-select").value;

  if (!keywords && !category) {
    toast("Type a keyword or pick a category first");
    return;
  }

  if (reset) {
    state.searchStart = 0;
    state.searchHasMore = true;
    el("search-results").innerHTML = "";
  }
  state.lastSearchParams = { keywords, categories: category ? [category] : [], sortBy };
  state.searchLoading = true;
  el("search-go-btn").textContent = "Searching…";
  el("search-go-btn").disabled = true;

  try {
    const { entries } = await arxiv.searchPapers({
      ...state.lastSearchParams,
      start: state.searchStart,
      maxResults: PAGE_SIZE,
    });
    cacheEntries(listCache.search, entries);
    await renderPaperList(el("search-results"), entries, { append: !reset });
    el("search-empty").hidden = entries.length > 0 || state.searchStart > 0;
    state.searchHasMore = entries.length === PAGE_SIZE;
    state.searchStart += entries.length;
  } catch (err) {
    toast("Search failed — check your connection and try again");
  }
  state.searchLoading = false;
  el("search-go-btn").disabled = false;
  el("search-go-btn").textContent = "Search";
  el("search-load-more-btn").hidden = !state.searchHasMore;
}

// ------------------------------------------------------------- library ----

function matchesLibraryFilter(paper) {
  if (state.libraryFilter === "downloaded") return !!paper.downloaded;
  if (state.libraryFilter === "notes") return !!paper._hasNote;
  return true;
}

async function renderLibrary() {
  const all = await db.getAllLibraryPapers();
  for (const p of all) {
    const note = await db.getNote(p.id);
    p._hasNote = !!(note && note.text && note.text.trim());
  }
  cacheEntries(listCache.library, all);
  const filtered = all.filter(matchesLibraryFilter);

  el("library-empty").hidden = filtered.length > 0;
  const container = el("library-list");
  container.innerHTML = "";
  for (const paper of filtered) {
    const card = await renderLibraryCard(paper);
    container.appendChild(card);
  }
}

async function renderLibraryCard(paper) {
  const card = document.createElement("article");
  card.className = "paper-card paper-card-compact";
  card.dataset.id = paper.id;
  const cats = paper.categories && paper.categories.length ? paper.categories : [paper.primaryCategory];

  card.innerHTML = `
    <div class="card-top">
      <div class="card-cats">${cats.slice(0, 3).map(categoryChipHTML).join("")}</div>
      <span class="card-id">${paper.id}</span>
    </div>
    <h3 class="card-title" data-action="toggle-abstract">${paper.title}</h3>
    <p class="card-byline">${fmtAuthors(paper.authors)} · ${fmtDate(paper.published)}</p>
    <p class="card-abstract">${paper.summary}</p>
    <div class="card-actions">
      <button class="btn btn-primary btn-read" data-action="read" data-id="${paper.id}">Read</button>
      <button class="btn btn-ghost" data-action="remove" data-id="${paper.id}">Remove</button>
      ${paper.downloaded ? '<span class="status-pill">Offline ready</span>' : ""}
      ${paper._hasNote ? '<span class="note-dot" title="Has notes"></span>' : ""}
    </div>
  `;
  return card;
}

async function exportLibrary() {
  const json = await db.exportLibraryJSON();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `daily-arxiv-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Library exported");
}

async function importLibrary(file) {
  const text = await file.text();
  try {
    await db.importLibraryJSON(text);
    toast("Library imported");
    renderLibrary();
  } catch (err) {
    toast("That backup file couldn't be read");
  }
}

// ------------------------------------------------------------ categories --

function openCategoryModal() {
  const modal = el("category-modal");
  modal.classList.add("active");
  renderCategoryModalList("");
  el("category-modal-search").value = "";
  el("category-modal-search").focus();
}

function renderCategoryModalList(filterText) {
  const list = el("category-modal-list");
  list.innerHTML = "";
  const lower = filterText.toLowerCase();
  for (const group of ARCHIVES) {
    const matches = group.categories.filter(
      ([code, label]) =>
        !lower || code.toLowerCase().includes(lower) || label.toLowerCase().includes(lower)
    );
    if (!matches.length) continue;
    const heading = document.createElement("div");
    heading.className = "category-group-heading";
    heading.textContent = group.label;
    list.appendChild(heading);
    for (const [code, label] of matches) {
      const row = document.createElement("button");
      const active = state.quickCategories.includes(code);
      row.className = "category-row" + (active ? " is-active" : "");
      row.innerHTML = `<span class="dot accent-${categoryAccent(code)}"></span><span class="category-row-code">${code}</span><span class="category-row-label">${label}</span>${active ? '<span class="checkmark">✓</span>' : ""}`;
      row.addEventListener("click", () => toggleQuickCategory(code));
      list.appendChild(row);
    }
  }
}

function toggleQuickCategory(code) {
  const idx = state.quickCategories.indexOf(code);
  if (idx >= 0) {
    if (state.quickCategories.length === 1) {
      toast("Keep at least one category");
      return;
    }
    state.quickCategories.splice(idx, 1);
    if (state.todayCategory === code) state.todayCategory = state.quickCategories[0];
  } else {
    state.quickCategories.push(code);
  }
  db.setSetting("quickCategories", state.quickCategories);
  renderQuickChips();
  renderCategoryModalList(el("category-modal-search").value);
}

// -------------------------------------------------------------- reader ----

async function openPaper(paper) {
  await reader.openReader(paper);
  reader.bindNotesAutosave();
}

function wireReaderToolbar() {
  el("reader-back-btn").addEventListener("click", () => {
    reader.closeReader();
    renderLibrary();
  });

  document.querySelectorAll("#reader-toolbar [data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#reader-toolbar [data-tool]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      reader.setTool(btn.dataset.tool);
    });
  });

  document.querySelectorAll("#reader-toolbar [data-color]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#reader-toolbar [data-color]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      reader.setColor(btn.dataset.color);
    });
  });

  el("reader-undo-btn").addEventListener("click", () => reader.undo());
  el("reader-clear-btn").addEventListener("click", () => {
    if (confirm("Clear all ink on this page?")) reader.clearCurrentPage();
  });

  el("reader-finger-toggle").addEventListener("change", (e) => {
    reader.setFingerDraw(e.target.checked);
  });

  el("reader-notes-toggle-btn").addEventListener("click", () => {
    el("reader-notes-panel").classList.toggle("open");
  });
  el("reader-notes-close-btn").addEventListener("click", () => {
    el("reader-notes-panel").classList.remove("open");
  });
}

// ------------------------------------------------------------- bindings --

function bindDelegatedClicks(containerId) {
  el(containerId).addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    handleCardAction(target.dataset.action, target.dataset.id, el(containerId));
  });
}

async function init() {
  switchTab("today");

  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  const savedCategories = await db.getSetting("quickCategories", null);
  if (savedCategories && savedCategories.length) {
    state.quickCategories = savedCategories;
    state.todayCategory = savedCategories[0];
  }
  renderQuickChips();
  loadToday({ reset: true });
  el("today-refresh-btn").addEventListener("click", () => loadToday({ reset: true }));
  el("today-load-more-btn").addEventListener("click", () => loadToday({ reset: false }));
  el("today-add-category-btn").addEventListener("click", openCategoryModal);

  populateSearchCategorySelect();
  el("search-go-btn").addEventListener("click", () => runSearch({ reset: true }));
  el("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch({ reset: true });
  });
  el("search-load-more-btn").addEventListener("click", () => runSearch({ reset: false }));

  document.querySelectorAll(".library-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".library-filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.libraryFilter = chip.dataset.filter;
      renderLibrary();
    });
  });
  el("library-export-btn").addEventListener("click", exportLibrary);
  el("library-import-input").addEventListener("change", (e) => {
    if (e.target.files[0]) importLibrary(e.target.files[0]);
  });

  el("category-modal-close").addEventListener("click", () => el("category-modal").classList.remove("active"));
  el("category-modal-search").addEventListener("input", (e) => renderCategoryModalList(e.target.value));

  bindDelegatedClicks("today-feed-list");
  bindDelegatedClicks("search-results");
  bindDelegatedClicks("library-list");

  wireReaderToolbar();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
