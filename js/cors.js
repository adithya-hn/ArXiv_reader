// cors.js
// export.arxiv.org (the API) and arxiv.org (PDFs) don't send CORS headers
// for browser-side fetch, so a plain client-side app can't read their
// responses directly. We try a direct fetch first (in case that ever
// changes), then fall through a short list of free CORS proxies.
//
// This is the one real limitation of a no-backend PWA talking to arXiv.
// If these public proxies ever go away, the fix is to swap in your own
// (e.g. a one-file Cloudflare Worker) — only this module would need to change.

const PROXIES = [
  (url) => url,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

/**
 * Fetch a URL that may not grant this origin CORS access, trying a direct
 * request first and then a chain of public CORS proxies.
 * @param {string} targetUrl
 * @param {{ as?: 'text' | 'blob' }} opts
 */
export async function corsFetch(targetUrl, { as = "text" } = {}) {
  let lastErr;
  for (const build of PROXIES) {
    try {
      const res = await fetch(build(targetUrl));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "blob" ? await res.blob() : await res.text();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All fetch strategies failed");
}
