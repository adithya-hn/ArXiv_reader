// cors.js
// export.arxiv.org (the API) and arxiv.org (PDFs) don't send CORS headers
// for browser-side fetch, so a plain client-side app can't read their
// responses directly. We fall through a short list of free CORS proxies.
//
// This is the one real limitation of a no-backend PWA talking to arXiv.
// If these public proxies ever go away, the fix is to swap in your own
// (e.g. a one-file Cloudflare Worker) — only this module would need to change.

const PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL that won't grant this origin CORS access, via a chain of
 * public CORS proxies.
 * @param {string} targetUrl
 * @param {{ as?: 'text' | 'blob', tryDirect?: boolean, timeoutMs?: number }} opts
 */
export async function corsFetch(targetUrl, { as = "text", tryDirect = false, timeoutMs = 9000 } = {}) {
  const candidates = tryDirect
    ? [targetUrl, ...PROXIES.map((p) => p(targetUrl))]
    : PROXIES.map((p) => p(targetUrl));

  if (as === "text") {
    // Small payloads: fire requests at the proxies in parallel and take
    // whichever one answers first, instead of waiting on dead ones in turn.
    const attempts = candidates.map((url) =>
      fetchWithTimeout(url, timeoutMs).then((res) => res.text())
    );
    try {
      return await Promise.any(attempts);
    } catch {
      throw new Error("All fetch strategies failed");
    }
  }

  // Blobs (PDFs) can be large, so try one at a time to avoid multiplying
  // mobile-data usage; a too-small response usually means a proxy returned
  // an error page instead of the real file, so we keep going past it.
  let lastErr;
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      const blob = await res.blob();
      if (blob.size < 2000) throw new Error("Response too small to be a real PDF");
      return blob;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All fetch strategies failed");
}

