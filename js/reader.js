// reader.js
// PDF rendering (via PDF.js, loaded lazily from a CDN) + an ink layer tuned
// for Apple Pencil, plus the per-paper notes panel. Annotation coordinates
// are stored as fractions of the page (0..1) so they replay correctly at
// any zoom level or screen size. PDF.js is imported lazily so that a CDN
// hiccup only affects the reader feature, not the whole app.

import * as db from "./db.js";
import { corsFetch } from "./cors.js";

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs";

let pdfjsLibPromise = null;
function getPdfjsLib() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib = await import(PDFJS_URL);
      try {
        // Safari is strict about loading a Worker script from a different
        // origin; fetching the script ourselves and handing pdf.js a same-
        // origin Blob URL sidesteps that reliably.
        const workerCode = await fetch(PDFJS_WORKER_URL).then((r) => r.text());
        const blobUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
        lib.GlobalWorkerOptions.workerSrc = blobUrl;
      } catch {
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      }
      return lib;
    })();
  }
  return pdfjsLibPromise;
}

const ERASE_RADIUS = 16; // px, at displayed canvas scale

const TOOL_DEFAULTS = {
  pen: { width: 2.5, alpha: 1 },
  highlighter: { width: 16, alpha: 0.32 },
};

let state = null; // current open-paper state, see openReader()

function el(id) {
  return document.getElementById(id);
}

/**
 * Downloads a paper's PDF and caches it for offline reading + annotation.
 * Throws if the network/CORS prevented caching; caller should fall back to
 * a plain external link in that case.
 */
export async function downloadPdf(paper) {
  const blob = await corsFetch(paper.pdfUrl, { as: "blob", tryDirect: true });
  await db.savePdfBlob(paper.id, blob);
  return blob;
}

async function loadPdfDocument(paper) {
  let blob = await db.getPdfBlob(paper.id);
  if (!blob) {
    blob = await downloadPdf(paper); // throws if it can't be fetched (e.g. CORS)
  }
  const buf = await blob.arrayBuffer();
  const pdfjsLib = await getPdfjsLib();
  return pdfjsLib.getDocument({ data: buf }).promise;
}

function fmtAuthors(authors) {
  if (!authors || !authors.length) return "";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 2).join(", ")}, et al.`;
}

export async function openReader(paper) {
  state = {
    paper,
    pdf: null,
    strokes: {}, // pageNum -> array of stroke objects
    undoStack: [], // { page, type: 'add'|'remove', strokes: [...] }
    tool: "pen",
    color: "#E8A33D",
    finger: false,
    activeStroke: null,
    erasing: null,
    pageObservers: [],
  };

  el("view-reader").classList.add("active");
  el("reader-title").textContent = paper.title;
  el("reader-byline").textContent = fmtAuthors(paper.authors);
  el("reader-pages").innerHTML = "";
  el("reader-status").textContent = "Loading…";
  el("reader-status").hidden = false;
  el("reader-fallback").hidden = true;
  el("reader-toolbar").hidden = true;

  const annoRecord = await db.getAnnotations(paper.id);
  for (const stroke of annoRecord.strokes || []) {
    (state.strokes[stroke.page] = state.strokes[stroke.page] || []).push(stroke);
  }

  const noteRecord = await db.getNote(paper.id);
  el("reader-notes-textarea").value = noteRecord.text || "";

  try {
    state.pdf = await loadPdfDocument(paper);
  } catch (err) {
    showFallback(paper, err);
    return;
  }

  el("reader-status").hidden = true;
  el("reader-toolbar").hidden = false;
  try {
    await renderAllPages();
    setupPageTracking();
  } catch (err) {
    el("reader-toolbar").hidden = true;
    showFallback(paper, err);
  }
}

function showFallback(paper, err) {
  console.error("Daily arXiv reader error:", err);
  el("reader-status").hidden = true;
  el("reader-fallback").hidden = false;
  el("reader-fallback-link").href = paper.pdfUrl;
  const detail = el("reader-fallback-detail");
  if (detail) detail.textContent = err && err.message ? err.message : "";
}

export function closeReader() {
  if (state) {
    state.pageObservers.forEach((o) => o.disconnect());
  }
  el("view-reader").classList.remove("active");
  state = null;
}

async function renderAllPages() {
  const container = el("reader-pages");
  const targetCssWidth = Math.min(container.clientWidth || 900, 980);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (let n = 1; n <= state.pdf.numPages; n++) {
    if (!state) return; // reader was closed mid-render
    const page = await state.pdf.getPage(n);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetCssWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.dataset.page = String(n);
    wrapper.style.width = viewport.width + "px";
    wrapper.style.height = viewport.height + "px";

    const pdfCanvas = document.createElement("canvas");
    pdfCanvas.className = "pdf-canvas";
    pdfCanvas.width = viewport.width * dpr;
    pdfCanvas.height = viewport.height * dpr;
    pdfCanvas.style.width = viewport.width + "px";
    pdfCanvas.style.height = viewport.height + "px";

    const ctx = pdfCanvas.getContext("2d");
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const inkCanvas = document.createElement("canvas");
    inkCanvas.className = "ink-canvas";
    inkCanvas.width = viewport.width * dpr;
    inkCanvas.height = viewport.height * dpr;
    inkCanvas.style.width = viewport.width + "px";
    inkCanvas.style.height = viewport.height + "px";

    wrapper.appendChild(pdfCanvas);
    wrapper.appendChild(inkCanvas);
    container.appendChild(wrapper);

    redrawPage(n, inkCanvas);
    attachPointerHandlers(inkCanvas, n);
  }

  el("reader-page-indicator").textContent = `1 / ${state.pdf.numPages}`;
}

function redrawPage(pageNum, canvasEl) {
  const canvas = canvasEl || document.querySelector(`.pdf-page[data-page="${pageNum}"] .ink-canvas`);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = (state.strokes[pageNum] || []);
  for (const stroke of strokes) drawStroke(ctx, canvas, stroke);
}

function drawStroke(ctx, canvas, stroke) {
  if (stroke.points.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = stroke.alpha;
  ctx.strokeStyle = stroke.color;
  ctx.beginPath();
  stroke.points.forEach((p, i) => {
    const x = p.x * canvas.width;
    const y = p.y * canvas.height;
    const pressure = stroke.tool === "pen" ? 0.6 + (p.p || 0.5) * 0.8 : 1;
    ctx.lineWidth = stroke.width * pressure * (canvas.width / (canvas.clientWidth || canvas.width));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function attachPointerHandlers(canvas, pageNum) {
  canvas.addEventListener("pointerdown", (e) => onPointerDown(e, canvas, pageNum));
  canvas.addEventListener("pointermove", (e) => onPointerMove(e, canvas, pageNum));
  canvas.addEventListener("pointerup", (e) => onPointerEnd(e, canvas, pageNum));
  canvas.addEventListener("pointercancel", (e) => onPointerEnd(e, canvas, pageNum));
}

function shouldDraw(e) {
  if (e.pointerType === "pen") return true;
  if (e.pointerType === "mouse") return true;
  if (e.pointerType === "touch") return state.finger;
  return false;
}

function pointFromEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  return { x, y, p: e.pressure || 0.5 };
}

function onPointerDown(e, canvas, pageNum) {
  if (!shouldDraw(e)) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  if (state.tool === "eraser") {
    state.erasing = { page: pageNum, removed: [] };
    eraseNear(e, canvas, pageNum);
    return;
  }

  const cfg = TOOL_DEFAULTS[state.tool] || TOOL_DEFAULTS.pen;
  state.activeStroke = {
    page: pageNum,
    tool: state.tool,
    color: state.color,
    width: cfg.width,
    alpha: cfg.alpha,
    points: [pointFromEvent(e, canvas)],
  };
}

function onPointerMove(e, canvas, pageNum) {
  if (!shouldDraw(e)) return;
  if (state.tool === "eraser" && state.erasing) {
    eraseNear(e, canvas, pageNum);
    return;
  }
  if (!state.activeStroke) return;
  e.preventDefault();
  state.activeStroke.points.push(pointFromEvent(e, canvas));
  const ctx = canvas.getContext("2d");
  redrawPage(pageNum, canvas);
  drawStroke(ctx, canvas, state.activeStroke);
}

function onPointerEnd(e, canvas, pageNum) {
  if (state.tool === "eraser") {
    if (state.erasing && state.erasing.removed.length) {
      state.undoStack.push({ type: "remove", page: pageNum, strokes: state.erasing.removed });
    }
    state.erasing = null;
    return;
  }
  if (!state.activeStroke) return;
  if (state.activeStroke.points.length > 1) {
    (state.strokes[pageNum] = state.strokes[pageNum] || []).push(state.activeStroke);
    state.undoStack.push({ type: "add", page: pageNum, strokes: [state.activeStroke] });
    persistAnnotations();
  }
  state.activeStroke = null;
}

function eraseNear(e, canvas, pageNum) {
  const pt = pointFromEvent(e, canvas);
  const list = state.strokes[pageNum] || [];
  const radiusFrac = ERASE_RADIUS / canvas.clientWidth;
  const remaining = [];
  for (const stroke of list) {
    const hit = stroke.points.some(
      (p) => Math.hypot(p.x - pt.x, p.y - pt.y) < radiusFrac
    );
    if (hit) state.erasing.removed.push(stroke);
    else remaining.push(stroke);
  }
  if (state.erasing.removed.length) {
    state.strokes[pageNum] = remaining;
    redrawPage(pageNum, canvas);
    persistAnnotations();
  }
}

function flattenStrokes() {
  const all = [];
  for (const [page, list] of Object.entries(state.strokes)) {
    list.forEach((s) => all.push({ ...s, page: Number(page) }));
  }
  return all;
}

let saveTimer = null;
function persistAnnotations() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state) return;
    await db.saveAnnotations(state.paper.id, { strokes: flattenStrokes() });
  }, 400);
}

export function undo() {
  if (!state || !state.undoStack.length) return;
  const action = state.undoStack.pop();
  if (action.type === "add") {
    const list = state.strokes[action.page] || [];
    state.strokes[action.page] = list.filter((s) => !action.strokes.includes(s));
  } else {
    state.strokes[action.page] = (state.strokes[action.page] || []).concat(action.strokes);
  }
  redrawPage(action.page);
  persistAnnotations();
}

export function clearCurrentPage() {
  if (!state) return;
  const pageNum = Number(el("reader-page-indicator").dataset.current || 1);
  const removed = state.strokes[pageNum] || [];
  if (!removed.length) return;
  state.undoStack.push({ type: "remove", page: pageNum, strokes: removed });
  state.strokes[pageNum] = [];
  redrawPage(pageNum);
  persistAnnotations();
}

export function setTool(tool) {
  if (!state) return;
  state.tool = tool;
}

export function setColor(color) {
  if (!state) return;
  state.color = color;
}

export function setFingerDraw(enabled) {
  if (!state) return;
  state.finger = enabled;
}

function setupPageTracking() {
  const indicator = el("reader-page-indicator");
  const pages = document.querySelectorAll(".pdf-page");
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((en) => en.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) {
        const n = visible.target.dataset.page;
        indicator.textContent = `${n} / ${state.pdf.numPages}`;
        indicator.dataset.current = n;
      }
    },
    { threshold: [0.5] }
  );
  pages.forEach((p) => observer.observe(p));
  state.pageObservers.push(observer);
}

export function bindNotesAutosave() {
  const textarea = el("reader-notes-textarea");
  let timer = null;
  textarea.addEventListener("input", () => {
    clearTimeout(timer);
    const value = textarea.value;
    timer = setTimeout(() => {
      if (state) db.saveNote(state.paper.id, value);
    }, 500);
  });
}

export function getCurrentPaper() {
  return state ? state.paper : null;
}
