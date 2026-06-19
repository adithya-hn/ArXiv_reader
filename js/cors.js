// cors.js
// export.arxiv.org (the API) generally sends CORS headers, but arxiv.org's
// PDF server does not, so a plain client-side app can't read a PDF response
// directly. We fall through a short list of free CORS proxies for that case
// (and as a safety net if direct ever stops working for the API too).
//
// This is the one real limitation of a no-backend PWA talking to arXiv.
// Free public proxies change their terms/limits without notice, which is
// the most common cause of "PDF won't load" in apps like this one — as of
// this writing all three below are degraded in one way or another. The
// durable fix is OWN_PROXY: deploy a one-file Cloudflare Worker (free
// tier, no card required) that just forwards requests to arXiv with the
// right headers, then paste its URL below — it gets tried first, ahead of
// every public proxy.
//
// Worker code (paste into the Cloudflare dashboard's Worker editor):
//
//   export default {
//     async fetch(request) {
//       const target = new URL(request.url).searchParams.get("url");
//       const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
//       if (request.method === "OPTIONS") return new Response(null, { headers: cors });
//       if (!target) return new Response("missing url", { status: 400, headers: cors });
//       try {
//         const upstream = await fetch(target);
//         const res = new Response(upstream.body, upstream);
//         Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
//         return res;
//       } catch (err) {
//         return new Response("upstream fetch failed: " + err.message, { status: 502, headers: cors });
//       }
//     }
//   };
//
// Then set: const OWN_PROXY = "https://your-worker.workers.dev/?url=";

const OWN_PROXY = "https://arxiv-proxy.adithyabhattsringeri.workers.dev/?url=";

// Tried for text (small) responses — the arXiv Atom feed. These only get
// hit at all if a direct fetch fails or is slow (see HEDGE_DELAY_MS below);
// order doesn't matter much since whichever answers first wins.
const TEXT_PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

// Tried for blob (PDF) responses, in order, one at a time. None of these
// three is reliably good at binary downloads on its free tier right now —
// allorigins is rate-limited under load, corsproxy.io's free tier doesn't
// proxy binary content at all (text formats only — binary is a paid
// feature), and codetabs has been returning blanket HTTP 400s. They're
// kept as a last-ditch fallback chain, but OWN_PROXY above is the real fix.
const BLOB_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function aggregateToError(aggregate, prefix) {
  const reasons = (aggregate.errors || [aggregate]).map((e) => e.message).join(" | ");
  return new Error(`${prefix} (${reasons || "all attempts failed"})`);
}

// How long direct gets to answer on its own before we also start racing the
// proxies. Short enough that a genuinely stuck direct request doesn't stall
// the UI, long enough to cover normal arXiv response times (typically well
// under a second, occasionally a few seconds under load) without wastefully
// opening proxy connections that usually won't even be needed.
const HEDGE_DELAY_MS = 1200;

/**
 * Fetch a URL that may not grant this origin CORS access, via a direct
 * attempt (optional) and a chain of CORS proxies.
 * @param {string} targetUrl
 * @param {{ as?: 'text' | 'blob', tryDirect?: boolean, timeoutMs?: number }} opts
 */
export async function corsFetch(targetUrl, { as = "text", tryDirect = false, timeoutMs } = {}) {
  if (as === "text") {
    const ms = timeoutMs || 9000;
    const attempt = (url) =>
      fetchWithTimeout(url, ms)
        .then((res) => res.text())
        .catch((err) => {
          throw new Error(`${hostOf(url)}: ${err.message}`);
        });

    const proxyUrls = ownProxyFirst(TEXT_PROXIES).map((p) => p(targetUrl));

    if (!tryDirect) {
      // No direct-CORS path available — race the proxies in parallel as
      // before, since there's nothing to hedge against.
      try {
        return await Promise.any(proxyUrls.map(attempt));
      } catch (aggregate) {
        throw aggregateToError(aggregate, "Couldn't reach arXiv via any route");
      }
    }

    // Hedged: fire the direct request alone first. Only also start racing
    // the proxies once HEDGE_DELAY_MS has passed *or* direct has already
    // failed (whichever comes first) — so the common case (direct just
    // works) makes exactly one network request instead of four.
    let directSettled = false;
    const directAttempt = attempt(targetUrl).finally(() => {
      directSettled = true;
    });
    const trigger = Promise.race([wait(HEDGE_DELAY_MS), directAttempt.catch(() => {})]);
    const hedgedProxies = proxyUrls.map((url) =>
      trigger.then(() => {
        if (directSettled) {
          // directAttempt already resolved by the time our trigger fired —
          // check if it actually succeeded by racing against it; if so,
          // skip this proxy call entirely rather than wasting a request.
          return directAttempt.then(
            () => Promise.reject(new Error(`${hostOf(url)}: skipped, direct already answered`)),
            () => attempt(url) // direct failed — go ahead and try this proxy
          );
        }
        return attempt(url); // direct still pending past the hedge window — try in parallel
      })
    );

    try {
      return await Promise.any([directAttempt, ...hedgedProxies]);
    } catch (aggregate) {
      throw aggregateToError(aggregate, "Couldn't reach arXiv via any route");
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
