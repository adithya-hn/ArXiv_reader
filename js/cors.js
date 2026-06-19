// cors.js
// export.arxiv.org (the API) generally sends CORS headers, but arxiv.org's
// PDF server does not, so a plain client-side app can't read a PDF response
// directly. We fall through a short list of free CORS proxies for that case
// (and as a safety net if direct ever stops working for the API too).
//
// This is the one real limitation of a no-backend PWA talking to arXiv.
// Free public proxies change their terms/limits without notice, which is
// the most common cause of "PDF won't load" in apps like this one. If you
// run into that again, the durable fix is OWN_PROXY below: deploy a
// one-file Cloudflare Worker (free tier) that just forwards requests to
// arXiv with the right headers, then paste its URL in OWN_PROXY — it gets
// tried first, ahead of every public proxy.
//
// Example Worker (Cloudflare Workers, free tier, no account limits that
// matter here):
//
//   export default {
//     async fetch(req) {
//       const target = new URL(req.url).searchParams.get("url");
//       if (!target) return new Response("missing url", { status: 400 });
//       const upstream = await fetch(target);
//       const res = new Response(upstream.body, upstream);
//       res.headers.set("Access-Control-Allow-Origin", "*");
//       return res;
//     }
//   };
//
// Then set: const OWN_PROXY = "https://your-worker.workers.dev/?url=";

const OWN_PROXY = ""; // e.g. "https://your-worker.workers.dev/?url=" — leave blank if you don't have one

// Tried for text (small) responses — the arXiv Atom feed. Order doesn't
// matter much here since all candidates (direct + these) race in parallel
// and we just take whichever answers first.
const TEXT_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

// Tried for blob (PDF) responses, in order, one at a time. codetabs is
// listed first because it explicitly supports binary/image payloads and has
// a generous 5MB/request limit. corsproxy.io is last because its free tier
// now restricts itself to text-based content types and a small handful of
// allowed origins, so it's the least likely of the three to hand back a
// usable PDF — but it's free and occasionally still works, so it stays as
// a last resort rather than being removed outright.
const BLOB_PROXIES = [
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

function ownProxyFirst(list) {
  return OWN_PROXY ? [(url) => `${OWN_PROXY}${encodeURIComponent(url)}`, ...list] : list;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url.startsWith("http") ? url : "direct";
  }
}

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
 * Fetch a URL that may not grant this origin CORS access, via a direct
 * attempt (optional) and a chain of CORS proxies.
 * @param {string} targetUrl
 * @param {{ as?: 'text' | 'blob', tryDirect?: boolean, timeoutMs?: number }} opts
 */
export async function corsFetch(targetUrl, { as = "text", tryDirect = false, timeoutMs } = {}) {
  if (as === "text") {
    const proxies = ownProxyFirst(TEXT_PROXIES);
    const candidates = tryDirect ? [targetUrl, ...proxies.map((p) => p(targetUrl))] : proxies.map((p) => p(targetUrl));
    const ms = timeoutMs || 9000;

    // Small payloads: fire requests at every candidate in parallel and take
    // whichever one answers first, instead of waiting on dead ones in turn.
    const attempts = candidates.map((url) =>
      fetchWithTimeout(url, ms)
        .then((res) => res.text())
        .catch((err) => {
          throw new Error(`${hostOf(url)}: ${err.message}`);
        })
    );
    try {
      return await Promise.any(attempts);
    } catch (aggregate) {
      const reasons = (aggregate.errors || []).map((e) => e.message).join(" | ");
      throw new Error(`Couldn't reach arXiv via any route (${reasons || "all attempts failed"})`);
    }
  }

  // Blobs (PDFs) can be large, so try one at a time to avoid multiplying
  // mobile-data usage; a too-small response usually means a proxy returned
  // an error page instead of the real file, so we keep going past it.
  const proxies = ownProxyFirst(BLOB_PROXIES);
  const candidates = tryDirect ? [targetUrl, ...proxies.map((p) => p(targetUrl))] : proxies.map((p) => p(targetUrl));
  const ms = timeoutMs || 20000;

  const failures = [];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, ms);
      const blob = await res.blob();
      if (blob.size < 2000) throw new Error("response too small to be a real PDF");
      return blob;
    } catch (err) {
      failures.push(`${hostOf(url)}: ${err.message}`);
    }
  }
  throw new Error(`Couldn't download the PDF via any route (${failures.join(" | ")})`);
}
