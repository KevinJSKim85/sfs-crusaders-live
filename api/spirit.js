// Replaces a dead CORS proxy (api.codetabs.com) that the client used to
// scrape https://issuu.com/thesfhsspirit for the student magazine's issues.
// The origin is healthy server-side — the proxy was the only broken part.
//
// The client's old scrape (see index.html, loadSpirit) collected cover IDs
// and /docs/ slugs into two separate flat lists — covers from a <link
// rel="preload"> block in the first ~1.3 KB of the document, slugs from the
// publication-card grid ~77 KB further down — then zipped them by array
// index. That "gamble" pairing only works because both lists happen to be in
// the same order today; any Issuu change (a pinned card, an extra /docs/
// link) desyncs them and produces a cover paired with the wrong title/link
// while still looking perfectly healthy. This endpoint prefers structural
// pairing instead: each publication card is one DOM node holding its own
// cover <img> and its own /docs/<slug> <a>, so cover and slug can never be
// cross-wired. See extractStructural / extractPositional below.

import { parse } from 'node-html-parser';
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

const SOURCE = 'issuu.com/thesfhsspirit';
const PROFILE_URL = 'https://issuu.com/thesfhsspirit';
const MAX_ITEMS = 5;

/**
 * Ported from cleanSpiritTitle() in index.html. Kept byte-for-byte in logic
 * so the API and the client's own cache-seed formatting never drift apart.
 */
function cleanSpiritTitle(slug) {
  let s = String(slug).replace(/_[a-f0-9]{10,}$/i, ''); // strip trailing dedupe hash
  s = s.replace(/_s_/g, "'s ");
  s = s.replace(/_-_|_/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Capitalize first letter of each space-separated word (don't touch letters after apostrophes)
  s = s.replace(/(^|\s)(\w)/g, (_, pre, c) => pre + c.toUpperCase());
  s = s.replace(/\bApri\b/g, 'April')
       .replace(/\bJanua\b/g, 'January')
       .replace(/\bFebrua\b/g, 'February')
       .replace(/\bDecemb\b/g, 'December');
  return s;
}

/**
 * Ported from parseCoverDate() in index.html, adapted to return a
 * YYYY-MM-DD string (the item contract) instead of a Date, which sidesteps
 * local-timezone drift in whatever region the function happens to run in.
 */
function parseCoverDate(coverId) {
  const head = String(coverId).split('-')[0]; // format: YYMMDDHHMMSS-hex
  if (!/^\d{12}$/.test(head)) return null;
  const yyyy = 2000 + Number(head.slice(0, 2));
  const mm = head.slice(2, 4);
  const dd = head.slice(4, 6);
  return `${yyyy}-${mm}-${dd}`;
}

function toItem(coverId, slug, pairing) {
  return {
    slug: clean(slug),
    title: clean(cleanSpiritTitle(slug)),
    cover: safeUrl(`https://image.isu.pub/${coverId}/jpg/page_1_thumb_large.jpg`),
    url: safeUrl(`https://issuu.com/thesfhsspirit/docs/${slug}`),
    publishedAt: parseCoverDate(coverId),
    pairing
  };
}

/**
 * Preferred path. Each publication card on the profile page is a single
 * `[data-testid="publication-card"]` node wrapping both its cover <img> and
 * its own /docs/<slug> <a> — pairing within that node can't cross-wire two
 * different issues no matter how Issuu reorders or adds cards around it.
 */
function extractStructural(html) {
  const root = parse(html);
  const cards = root.querySelectorAll('[data-testid="publication-card"]');
  const pairs = [];
  for (const card of cards) {
    const src = card.querySelector('img')?.getAttribute('src') || '';
    const href = card.querySelector('a[href*="/docs/"]')?.getAttribute('href') || '';
    const coverMatch = src.match(/image\.isu\.pub\/(\d{12}-[a-f0-9]+)/);
    const slugMatch = href.match(/\/docs\/([^"?#]+)/);
    if (coverMatch && slugMatch) {
      pairs.push({ coverId: coverMatch[1], slug: clean(slugMatch[1]) });
    }
  }
  return pairs;
}

/**
 * Fallback path — the old client's approach, kept only for when Issuu's
 * markup no longer matches extractStructural. Two flat lists zipped by
 * index; the caller must run isMonotonicByDate() on the result before
 * trusting it, since a desynced zip is otherwise indistinguishable from a
 * correct one.
 */
function extractPositional(html) {
  const coverIds = [];
  const seenCovers = new Set();
  for (const m of html.matchAll(/image\.isu\.pub\/(\d{12}-[a-f0-9]+)/g)) {
    if (!seenCovers.has(m[1])) { seenCovers.add(m[1]); coverIds.push(m[1]); }
  }
  const slugs = [];
  const seenSlugs = new Set();
  for (const m of html.matchAll(/\/docs\/([a-zA-Z0-9_-]+)/g)) {
    if (!seenSlugs.has(m[1])) { seenSlugs.add(m[1]); slugs.push(m[1]); }
  }
  const count = Math.min(MAX_ITEMS, coverIds.length, slugs.length);
  const pairs = [];
  for (let i = 0; i < count; i++) pairs.push({ coverId: coverIds[i], slug: clean(slugs[i]) });
  return pairs;
}

/** Cover IDs are YYMMDDHHMMSS-prefixed, so a correctly-ordered, correctly-paired list decodes to non-increasing dates. */
function isMonotonicByDate(pairs) {
  let prev = null;
  for (const { coverId } of pairs) {
    const head = coverId.split('-')[0];
    if (prev !== null && head > prev) return false;
    prev = head;
  }
  return true;
}

export default handler(SOURCE, async (req, res) => {
  const response = await fetchWithTimeout(PROFILE_URL);
  if (!response.ok) {
    return fail(res, { source: SOURCE, error: `upstream ${response.status}` });
  }
  const html = await response.text();

  let pairs = extractStructural(html);
  let pairing = 'structural';

  if (pairs.length === 0) {
    pairing = 'positional_fallback';
    pairs = extractPositional(html);
    // Failing closed here is deliberate: a wrong "Latest Issue" (right cover,
    // wrong title/link) is worse than the widget simply having no data.
    if (pairs.length === 0 || !isMonotonicByDate(pairs)) {
      return fail(res, { source: SOURCE, error: 'pairing_unverifiable' });
    }
  } else {
    // Newest first by the cover's embedded timestamp, not DOM order — a
    // featured/pinned card is correctly paired but isn't necessarily latest.
    pairs = pairs.slice().sort((a, b) => (a.coverId.split('-')[0] < b.coverId.split('-')[0] ? 1 : -1));
  }

  const items = pairs.slice(0, MAX_ITEMS).map((p) => toItem(p.coverId, p.slug, pairing));
  return ok(res, { source: SOURCE, items, sMaxage: 3600, swr: 86400 });
});
