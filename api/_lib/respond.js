// Shared contract for every /api/* endpoint.
//
// Why these endpoints exist: the dashboard used to reach its sources through
// free CORS proxies (allorigins, then codetabs). Both are dead, and five
// widgets have been silently serving hardcoded fallbacks as a result. Every
// origin is healthy when fetched server-side, so the transport was the whole
// problem.
//
// Design rule: the CDN is the cache. Each response sets s-maxage, so how often
// we hit an origin depends on time, not on how many students have the page
// open. A thousand tabs share one upstream fetch per window.

/**
 * Escape HTML-significant characters.
 *
 * NOT used on the JSON payloads these endpoints return, and deliberately so:
 * JSON is already a safe transport, and escaping here would double-escape once
 * the client escapes again at its own DOM sink — an apostrophe in a headline
 * would reach the reader as `&#39;`. Escaping belongs at the sink, which the
 * client does. Kept exported for any future endpoint that genuinely emits HTML.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/** Allow only http(s) URLs through; anything else becomes null. */
export function safeUrl(value) {
  const url = String(value ?? '').trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Collapse whitespace and trim — scraped text is full of newlines and tabs. */
export function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Fetch with a hard timeout. Without this a hung origin holds the function
 * open until the platform kills it, which burns the invocation budget and
 * returns nothing useful.
 */
export async function fetchWithTimeout(url, { timeout = 8000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Success. `sMaxage` is how long the CDN serves this without asking us again;
 * `swr` is how long it may keep serving the stale copy while it refreshes in
 * the background. Together they mean a slow origin never becomes a slow page.
 */
export function ok(res, { source, items, sMaxage = 900, swr = 3600, warnings = [], ...extra }) {
  res.setHeader('Cache-Control', `public, s-maxage=${sMaxage}, stale-while-revalidate=${swr}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json({
    ok: true,
    source,
    fetchedAt: new Date().toISOString(),
    warnings,
    items,
    ...extra
  });
}

/**
 * Failure — deliberately still HTTP 200.
 *
 * A 5xx would leave the client unable to tell "our API broke" from "the source
 * broke", and browsers/CDNs treat the two very differently. Caching a failure
 * for the full success window would also be worse than simply retrying soon,
 * so failures get a short window with a long stale-while-revalidate: the CDN
 * can keep serving the last good body while it retries.
 */
export function fail(res, { source, error, sMaxage = 60, swr = 600, ...extra }) {
  res.setHeader('Cache-Control', `public, s-maxage=${sMaxage}, stale-while-revalidate=${swr}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json({
    ok: false,
    source,
    fetchedAt: new Date().toISOString(),
    error: String(error?.message || error || 'unknown'),
    warnings: [],
    items: [],
    ...extra
  });
}

/**
 * Wrap a handler so an unexpected throw still returns the standard envelope
 * rather than a platform error page the client cannot parse.
 */
export function handler(source, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!res.headersSent) fail(res, { source, error });
    }
  };
}
