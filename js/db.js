// db.js
// Thin promise-based wrapper around IndexedDB for all local persistence.
// Everything here lives only on this device, in this browser's storage.

const DB_NAME = "daily-arxiv";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("papers")) {
        db.createObjectStore("papers", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("pdfs")) {
        db.createObjectStore("pdfs"); // key: paper id, value: Blob
      }
      if (!db.objectStoreNames.contains("annotations")) {
        db.createObjectStore("annotations"); // key: paper id, value: { strokes: [...] }
      }
      if (!db.objectStoreNames.contains("notes")) {
        db.createObjectStore("notes"); // key: paper id, value: { text, updatedAt }
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings"); // key: name, value: anything
      }
      if (!db.objectStoreNames.contains("feedCache")) {
        db.createObjectStore("feedCache"); // key: query string, value: { entries, fetchedAt }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then(
    (db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      resolve({ t, store });
      t.onerror = () => reject(t.error);
    })
  );
}

async function getAll(storeName) {
  const { store } = await tx(storeName, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(storeName, key) {
  const { store } = await tx(storeName, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(storeName, value, key) {
  const { store, t } = await tx(storeName, "readwrite");
  return new Promise((resolve, reject) => {
    const req = key !== undefined ? store.put(value, key) : store.put(value);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve(true);
  });
}

async function del(storeName, key) {
  const { store, t } = await tx(storeName, "readwrite");
  return new Promise((resolve, reject) => {
    store.delete(key);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

// ---------- Papers (library) ----------

export async function saveLibraryPaper(paper) {
  return put("papers", { ...paper, savedAt: paper.savedAt || Date.now() });
}

export async function removeLibraryPaper(id) {
  await del("papers", id);
  await del("pdfs", id);
  await del("annotations", id);
  await del("notes", id);
}

export async function getLibraryPaper(id) {
  return get("papers", id);
}

export async function getAllLibraryPapers() {
  const all = await getAll("papers");
  return all.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function isInLibrary(id) {
  const p = await get("papers", id);
  return !!p;
}

export async function markDownloaded(id, downloaded) {
  const p = await get("papers", id);
  if (!p) return;
  p.downloaded = downloaded;
  await put("papers", p);
}

// ---------- PDFs ----------

export async function savePdfBlob(id, blob) {
  await put("pdfs", blob, id);
  await markDownloaded(id, true);
}

export async function getPdfBlob(id) {
  return get("pdfs", id);
}

export async function hasPdfBlob(id) {
  const b = await getPdfBlob(id);
  return !!b;
}

export async function deletePdfBlob(id) {
  await del("pdfs", id);
  await markDownloaded(id, false);
}

// ---------- Annotations ----------

export async function getAnnotations(id) {
  const rec = await get("annotations", id);
  return rec || { strokes: [] };
}

export async function saveAnnotations(id, data) {
  return put("annotations", { ...data, updatedAt: Date.now() }, id);
}

// ---------- Notes ----------

export async function getNote(id) {
  const rec = await get("notes", id);
  return rec || { text: "", updatedAt: null };
}

export async function saveNote(id, text) {
  return put("notes", { text, updatedAt: Date.now() }, id);
}

// ---------- Settings ----------

export async function getSetting(name, fallback) {
  const v = await get("settings", name);
  return v === undefined ? fallback : v;
}

export async function setSetting(name, value) {
  return put("settings", value, name);
}

// ---------- Feed cache (so Today/Search feel instant + work offline-ish) ----------

export async function getFeedCache(key) {
  return get("feedCache", key);
}

export async function setFeedCache(key, entries) {
  return put("feedCache", { entries, fetchedAt: Date.now() }, key);
}

// ---------- Export / import (backup) ----------

export async function exportLibraryJSON() {
  const [papers, settings] = await Promise.all([
    getAllLibraryPapers(),
    get("settings", "quickCategories"),
  ]);
  const notesAndAnnotations = {};
  for (const p of papers) {
    notesAndAnnotations[p.id] = {
      note: await getNote(p.id),
      annotations: await getAnnotations(p.id),
    };
  }
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      papers,
      notesAndAnnotations,
      quickCategories: settings || null,
    },
    null,
    2
  );
}

export async function importLibraryJSON(json) {
  const data = JSON.parse(json);
  for (const p of data.papers || []) {
    await saveLibraryPaper(p);
  }
  for (const [id, bundle] of Object.entries(data.notesAndAnnotations || {})) {
    if (bundle.note && bundle.note.text) await saveNote(id, bundle.note.text);
    if (bundle.annotations) await saveAnnotations(id, bundle.annotations);
  }
  if (data.quickCategories) await setSetting("quickCategories", data.quickCategories);
}
