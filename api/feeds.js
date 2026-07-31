// GET /api/feeds?set=world|college — merges a whole RSS/Atom set server-side
// so the dashboard makes one request instead of one per source. Replaces
// api.rss2json.com; see _lib/respond.js for why this api/ directory exists.
import { XMLParser } from 'fast-xml-parser';
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

const FEED_SETS = new Map([
  ['world', [
    { key: 'econ',  label: 'Economist', domain: 'economist.com',   url: 'https://www.economist.com/finance-and-economics/rss.xml' },
    { key: 'bbc',   label: 'BBC',       domain: 'bbc.com',         url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { key: 'nyt',   label: 'NY Times',  domain: 'nytimes.com',     url: 'https://rss.nytimes.com/services/xml/rss/nyt/Education.xml' },
    { key: 'guard', label: 'Guardian',  domain: 'theguardian.com', url: 'https://www.theguardian.com/education/rss' }
  ]],
  ['college', [
    { key: 'ihe',  label: 'Inside Higher Ed', domain: 'insidehighered.com',  url: 'https://www.insidehighered.com/rss.xml' },
    { key: 'hech', label: 'Hechinger',        domain: 'hechingerreport.org', url: 'https://hechingerreport.org/feed/' },
    { key: 'harv', label: 'Harvard',          domain: 'harvard.edu',         url: 'https://news.harvard.edu/gazette/feed/' },
    { key: 'mit',  label: 'MIT',              domain: 'mit.edu',             url: 'https://news.mit.edu/rss/feed' }
  ]]
]);

// Namespaced tags (media:thumbnail, dc:date, ...) only survive parsing intact
// because we don't ask fast-xml-parser to strip prefixes. processEntities as
// an object (not the `true` shorthand) swaps the library's hardcoded
// 1000-expansion count cap for its size-based guards (100000-char expanded
// length, 1000 distinct entities) — MIT's feed is just linearly entity-heavy
// real content (thousands of &#8217;/&nbsp;), not a nested-expansion bomb,
// and the size guards are what actually stop the latter.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: {}
});

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return textOf(value['#text']);
  return String(value);
}

function firstImageSrc(html) {
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function extractLink(entry) {
  if (typeof entry.link === 'string') return entry.link;
  const links = toArray(entry.link);
  // Atom entries can carry several <link> elements (alternate, self, ...);
  // "alternate" (or the bare, rel-less form) is the one a reader should open.
  const chosen = links.find((l) => l && typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) || links[0];
  if (chosen && typeof chosen === 'object') return chosen['@_href'] || null;
  if (typeof chosen === 'string') return chosen;
  return typeof entry.id === 'string' && /^https?:\/\//i.test(entry.id) ? entry.id : null;
}

function extractDate(entry) {
  const raw = textOf(entry.pubDate || entry.published || entry.updated || entry['dc:date']);
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function extractThumbnail(entry) {
  const thumb = toArray(entry['media:thumbnail'])[0];
  if (thumb && thumb['@_url']) return thumb['@_url'];
  const media = toArray(entry['media:content']).find((m) => m && m['@_url']);
  if (media) return media['@_url'];
  if (entry.enclosure && entry.enclosure['@_url']) return entry.enclosure['@_url'];
  const html = textOf(entry['content:encoded']) || textOf(entry.description) || textOf(entry.summary) || textOf(entry.content);
  return html ? firstImageSrc(html) : null;
}

function entriesFromXml(xml) {
  const data = parser.parse(xml);
  if (data?.rss?.channel?.item) return toArray(data.rss.channel.item);
  if (data?.feed?.entry) return toArray(data.feed.entry);
  return [];
}

async function fetchFeed(feed) {
  const res = await fetchWithTimeout(feed.url, { timeout: 6000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const entries = entriesFromXml(await res.text());

  const items = [];
  for (const entry of entries) {
    if (items.length >= 2) break;   // cap per feed BEFORE merging, matching prior client behavior
    const link = safeUrl(extractLink(entry));
    if (!link) continue;            // a card that can never be opened isn't worth shipping
    const thumbnail = safeUrl(extractThumbnail(entry));
    items.push({
      title: clean((textOf(entry.title))),
      link: clean(link),
      // No parseable date beats a fake one — epoch sinks the item in the
      // desc sort instead of a bad parse making it look freshly posted.
      publishedAt: extractDate(entry) || new Date(0).toISOString(),
      thumbnail: thumbnail ? clean(thumbnail) : null,
      sourceKey: clean(feed.key),
      sourceLabel: clean(feed.label),
      sourceDomain: clean(feed.domain)
    });
  }
  return items;
}

export default handler('rss', async (req, res) => {
  const requested = req.query?.set;
  const setParam = Array.isArray(requested) ? requested[0] : requested;
  // Map, not a plain object — a hostile `set` value must not resolve to
  // Object.prototype the way FEED_SETS['__proto__'] would on a literal.
  const setName = FEED_SETS.has(setParam) ? setParam : 'world';
  const feeds = FEED_SETS.get(setName);

  const settled = await Promise.allSettled(feeds.map(fetchFeed));

  const merged = [];
  const sources = [];
  settled.forEach((result, idx) => {
    const feed = feeds[idx];
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
      sources.push({ key: feed.key, label: feed.label, ok: true, count: result.value.length, error: null });
    } else {
      sources.push({ key: feed.key, label: feed.label, ok: false, count: 0, error: String(result.reason?.message || result.reason) });
    }
  });

  if (sources.every((s) => !s.ok)) {
    return fail(res, { source: 'rss', error: 'all_feeds_failed', sources });
  }

  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return ok(res, { source: 'rss', items: merged.slice(0, 10), sMaxage: 1800, swr: 7200, sources });
});
