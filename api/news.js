// GET /api/news — Seoul Foreign School community news, scraped server-side.
//
// Why this exists: the dashboard used to reach seoulforeign.org (a Finalsite
// site) through a free CORS proxy. The proxy is dead; the origin itself is
// healthy when fetched from a server (no CORS restriction applies here), so
// scraping moved behind this endpoint. See _lib/respond.js for the shared
// response contract.
import { parse } from 'node-html-parser';
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

const SOURCE = 'seoulforeign.org';
const ORIGIN = 'https://www.seoulforeign.org';
const NEWS_URL = `${ORIGIN}/community/news`;
const MAX_ITEMS = 8;

function abs(url) {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${ORIGIN}${url}`;
  return `${ORIGIN}/${url}`;
}

// Finalsite lazy-loads thumbnails behind a JSON blob of size variants on
// data-image-sizes rather than a plain src/data-src. Ported from
// finalsiteImageUrl() in loadSFSNews() (index.html).
function finalsiteImageUrl(el) {
  if (!el) return null;
  const direct = el.getAttribute('data-src') || el.getAttribute('src');
  if (direct && !/pixel|blank|spacer/i.test(direct)) return direct;
  const holder = el.hasAttribute('data-image-sizes') ? el : el.querySelector('[data-image-sizes]');
  const raw = holder && holder.getAttribute('data-image-sizes');
  if (!raw) return null;
  try {
    const sizes = JSON.parse(raw.includes('%22') ? decodeURIComponent(raw) : raw);
    if (!Array.isArray(sizes) || sizes.length === 0) return null;
    const sorted = [...sizes].sort((a, b) => (a.width || 0) - (b.width || 0));
    const pick = sorted.find((img) => (img.width || 0) >= 512) || sorted[sorted.length - 1];
    return (pick && pick.url) || null;
  } catch {
    const m = raw.match(/https?:[^"'\]}]+/);
    return m ? m[0] : null;
  }
}

// Finalsite stamps thumbnail URLs with a Cloudinary-style version segment —
// .../v1775458550/... — the unix timestamp of when the asset was uploaded,
// which tracks the article's publish date closely enough to sort by. The
// listing ships no other date signal (verified live: every candidate wrapper
// has zero .fsDateTime/time[datetime]/.date nodes), so this is what actually
// recovers dates in practice, and it's free since the URL is already fetched
// for the thumbnail.
function imageVersionDate(imageUrl) {
  if (!imageUrl) return null;
  const match = imageUrl.match(/\/v(\d{9,10})\//);
  if (!match) return null;
  const date = new Date(Number(match[1]) * 1000);
  const year = date.getUTCFullYear();
  if (year < 2010 || year > 2100) return null; // guard against an unrelated numeric path segment
  return date;
}

// Try, in order: a structured date attribute (e.g. <time datetime="...">),
// scraped date text, then the image version stamp. 'meta' vs 'dom' records
// whether the value came from an attribute (structured) or parsed text.
function resolveDate(wrapper, imageUrl) {
  const dateEl = wrapper.querySelector('.fsDateTime, time[datetime], [class*="Date"], .date');
  if (dateEl) {
    const attr = dateEl.getAttribute('datetime');
    if (attr) {
      const fromAttr = new Date(attr);
      if (!Number.isNaN(fromAttr.getTime())) return { publishedAt: fromAttr.toISOString(), dateSource: 'meta' };
    }
    const text = clean(dateEl.text);
    if (text) {
      const fromText = new Date(text);
      if (!Number.isNaN(fromText.getTime())) return { publishedAt: fromText.toISOString(), dateSource: 'dom' };
    }
  }
  const versionDate = imageVersionDate(imageUrl);
  if (versionDate) return { publishedAt: versionDate.toISOString(), dateSource: 'image_version' };
  return { publishedAt: null, dateSource: null };
}

// Newest first; items with no resolvable date sort last instead of landing
// unpredictably among dated ones.
function sortKey(item) {
  return item.publishedAt ? new Date(item.publishedAt).getTime() : -1;
}

export default handler(SOURCE, async (req, res) => {
  const response = await fetchWithTimeout(NEWS_URL, { timeout: 10000 });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  const html = await response.text();
  const root = parse(html);

  // Strategy 1 wrapper selector ported from loadSFSNews(). It also matches
  // several empty `fsResource fsResourceTypeImage` article shells that carry
  // no heading and only a decoy href (/fs/pages/339). Those shells sit first
  // in DOM order, so filter on title/link validity across the FULL matched
  // set before slicing to MAX_ITEMS — capping first would eat the budget on
  // shells and never reach real content.
  const wrappers = root.querySelectorAll('.fsListItem, .fsPosts .fsPost, article, [class*="ArticleListItem"]');
  const seen = new Set();
  const candidates = [];

  for (const wrapper of wrappers) {
    const titleEl = wrapper.querySelector('.fsTitle, h2 a, h3 a, h4 a, h2, h3, h4, .title');
    const titleText = clean(titleEl ? titleEl.text : '');
    if (titleText.length <= 8) continue; // empty shells have no heading at all

    // The known real article href shape, not a generic a[href] — the empty
    // shells' only anchor points at /fs/pages/339, never a news article.
    const linkEl = wrapper.querySelector('a[href*="/community/news/article/"]');
    const link = linkEl ? safeUrl(abs(linkEl.getAttribute('href'))) : null;
    if (!link) continue;

    const key = `${titleText}|${link}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const imgEl = wrapper.querySelector(
      '.fsThumbnail [data-image-sizes], [class*="Thumbnail"] [data-image-sizes], img[data-image-sizes], img'
    );
    const imageRaw = finalsiteImageUrl(imgEl);
    const image = safeUrl(abs(imageRaw));
    const { publishedAt, dateSource } = resolveDate(wrapper, imageRaw);

    candidates.push({ title: clean(titleText), link, image, publishedAt, dateSource });
  }

  if (candidates.length === 0) return fail(res, { source: SOURCE, error: 'no_articles_parsed' });

  const items = candidates.sort((a, b) => sortKey(b) - sortKey(a)).slice(0, MAX_ITEMS);
  return ok(res, { source: SOURCE, items, sMaxage: 900, swr: 3600 });
});
