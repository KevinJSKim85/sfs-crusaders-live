// GET /api/feeds?set=world|college — merges a whole RSS/Atom set server-side
// so the dashboard makes one request instead of one per source. Replaces
// api.rss2json.com; see _lib/respond.js for why this api/ directory exists.
import { XMLParser } from 'fast-xml-parser';
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

// One catalog rather than two fixed lists, so students can pick their own mix.
// `topic` drives the grouping in the picker; `sets` is which preset a source
// belongs to when nobody has chosen anything.
//
// Note on NY Times: the widget already carried an nyt key, but pointed at the
// Education feed, so "NY Times" in a world-news panel meant campus policy
// stories. World and Tech are separate entries now, and the Education one is
// labelled as such.
const CATALOG = new Map([
  ['nyt-world',  { label: 'NY Times · World',   domain: 'nytimes.com',         topic: 'World',      sets: ['world'], url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' }],
  ['bbc',        { label: 'BBC · World',        domain: 'bbc.com',             topic: 'World',      sets: ['world'], url: 'https://feeds.bbci.co.uk/news/world/rss.xml' }],
  ['guard-world',{ label: 'Guardian · World',   domain: 'theguardian.com',     topic: 'World',      sets: [],        url: 'https://www.theguardian.com/world/rss' }],
  // AP was here via rsshub.app, which now 403s all traffic. Left out rather
  // than offered as a choice that fails the moment a student picks it.

  ['econ',       { label: 'Economist',          domain: 'economist.com',       topic: 'Business',   sets: ['world'], url: 'https://www.economist.com/finance-and-economics/rss.xml' }],
  ['nyt-biz',    { label: 'NY Times · Business',domain: 'nytimes.com',         topic: 'Business',   sets: [],        url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' }],

  ['nyt-tech',   { label: 'NY Times · Tech',    domain: 'nytimes.com',         topic: 'Science',    sets: [],        url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' }],
  ['nyt-sci',    { label: 'NY Times · Science', domain: 'nytimes.com',         topic: 'Science',    sets: ['world'], url: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml' }],
  ['quanta',     { label: 'Quanta',             domain: 'quantamagazine.org',  topic: 'Science',    sets: [],        url: 'https://api.quantamagazine.org/feed/' }],
  ['nasa',       { label: 'NASA',               domain: 'nasa.gov',            topic: 'Science',    sets: [],        url: 'https://www.nasa.gov/news-release/feed/' }],

  ['guard-arts', { label: 'Guardian · Culture', domain: 'theguardian.com',     topic: 'Arts',       sets: [],        url: 'https://www.theguardian.com/culture/rss' }],
  ['nyt-arts',   { label: 'NY Times · Arts',    domain: 'nytimes.com',         topic: 'Arts',       sets: [],        url: 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml' }],

  ['korea',      { label: 'Korea Herald',       domain: 'koreaherald.com',     topic: 'Korea',      sets: [],        url: 'https://www.koreaherald.com/rss/newsAll' }],

  ['ihe',        { label: 'Inside Higher Ed',   domain: 'insidehighered.com',  topic: 'College',    sets: ['college'], url: 'https://www.insidehighered.com/rss.xml' }],
  ['hech',       { label: 'Hechinger',          domain: 'hechingerreport.org', topic: 'College',    sets: ['college'], url: 'https://hechingerreport.org/feed/' }],
  ['harv',       { label: 'Harvard Gazette',    domain: 'harvard.edu',         topic: 'College',    sets: ['college'], url: 'https://news.harvard.edu/gazette/feed/' }],
  ['mit',        { label: 'MIT News',           domain: 'mit.edu',             topic: 'College',    sets: ['college'], url: 'https://news.mit.edu/rss/feed' }],
  ['nyt-edu',    { label: 'NY Times · Education', domain: 'nytimes.com',       topic: 'College',    sets: [],        url: 'https://rss.nytimes.com/services/xml/rss/nyt/Education.xml' }],
  ['guard-edu',  { label: 'Guardian · Education', domain: 'theguardian.com',   topic: 'College',    sets: [],        url: 'https://www.theguardian.com/education/rss' }]
]);

function feedsForSet(setName) {
  const out = [];
  for (const [key, meta] of CATALOG) {
    if (meta.sets.includes(setName)) out.push({ key, ...meta });
  }
  return out;
}

// Explicit picks win over the preset. Unknown keys are dropped rather than
// erroring: a saved preference from an older build should degrade to the
// sources that still exist, not blank the widget.
function feedsForKeys(raw) {
  const seen = new Set();
  const out = [];
  for (const k of String(raw).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12)) {
    if (CATALOG.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push({ key: k, ...CATALOG.get(k) });
    }
  }
  return out;
}

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

const one = (v) => (Array.isArray(v) ? v[0] : v);

export default handler('rss', async (req, res) => {
  const setParam = one(req.query?.set);
  const sourcesParam = one(req.query?.sources);

  // Map, not a plain object — a hostile key must not resolve to
  // Object.prototype the way CATALOG['__proto__'] would on a literal.
  const setName = ['world', 'college'].includes(setParam) ? setParam : 'world';
  let feeds = sourcesParam ? feedsForKeys(sourcesParam) : [];
  if (!feeds.length) feeds = feedsForSet(setName);

  // Always ship the catalog so the client can build its picker without a
  // second request or a hardcoded copy that drifts from this list.
  const catalog = [...CATALOG].map(([key, m]) => ({
    key, label: m.label, domain: m.domain, topic: m.topic, inSet: m.sets
  }));

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
    return fail(res, { source: 'rss', error: 'all_feeds_failed', sources, catalog });
  }

  merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return ok(res, {
    source: 'rss',
    items: merged.slice(0, 10),
    sMaxage: 1800, swr: 7200,
    sources, catalog,
    selected: feeds.map((f) => f.key)
  });
});
