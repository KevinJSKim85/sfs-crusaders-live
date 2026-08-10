// /api/lunch.js
//
// Moves the lunch-menu pipeline off the client. The dashboard used to fetch a
// 222 KB Google Drive PDF through a dead CORS proxy and parse it with pdf.js
// in the browser — 320 KB of pdf.js shipped on every page load just for this,
// and the parse re-ran up to 12x/hour per open tab. The Drive URL fetches
// fine from a server (no CORS involved), so this endpoint fetches + parses
// once and lets the CDN cache (see ok()'s sMaxage) absorb repeat requests.

import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

// pdfjs-dist v4 calls Promise.withResolvers, which only exists from Node 22.
// Vercel may run this on Node 20, where a static top-level import of pdfjs
// throws before the handler ever runs and the whole endpoint fails.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

// Loaded lazily for the same reason: a resolution failure should degrade this
// endpoint to its Drive-preview fallback, not take it down.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .catch(() => import('pdfjs-dist/build/pdf.mjs'))
      .catch(() => import('pdfjs-dist'));
  }
  return pdfjsPromise;
}

const FIRESTORE_URL =
  'https://firestore.googleapis.com/v1/projects/sfs-crusader-hub/databases/(default)/documents/config/lunch' +
  '?key=AIzaSyAJn9zVU7Cnql992b4T88z1j9fTq9LrZkE';

const STALE_MS = 10 * 24 * 60 * 60 * 1000; // config doc counts as stale past this age
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// Google Drive file IDs are alnum/dash/underscore. fileId can arrive from the
// public ?fileId= override, so reject anything that doesn't look like one
// before it gets woven into a Drive URL.
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,100}$/;

const DAY_RE = /^(Mon|Tue|Wed|Thu|Fri)\.?$/i;
const SECTION_RE = /^[A-Z][A-Z\s&'/]{3,}$/;
// Crave's HS menu sections — used to filter out brand-name false positives
// (VOSS, ICE CREAM) that look like sections. Falls back to generic detection
// if we don't find at least 3 known names (handles other PDF layouts).
const KNOWN_RE = /^(INTERNATIONAL|KOREAN|BURGER OF THE WEEK|SOUP OF THE WEEK|BUILD YOUR OWN|SALAD BAR|GRAB & GO|GRILL|BEVERAGES)$/;
const JUNK_RE = /^(₩|\d+[,.]?\d*|.*[-]\s*(Brazil|USA|Korea|China|Australia|Foreign|Vietnam)\s*|High School|crave|\d+\s*\/\s*\d+)$/i;

// Raw section name -> compact display label. Sections not listed here are
// dropped from the response (BEVERAGES, ICE CREAM, VOSS, GRAB & GO, SALAD
// BAR, etc. — noise that isn't an actual main meal).
const SECTION_LABELS = {
  'INTERNATIONAL':      'Intl.',
  'KOREAN':              'Korean',
  'BURGER OF THE WEEK':  'Burger',
  'SOUP OF THE WEEK':    'Soup',
  'GRILL':               'Grill',
  'BUILD YOUR OWN':      'Salad'
};

/** Firestore REST "Value" objects are a tagged union; pull out the payload. */
function firestoreValue(field) {
  if (!field) return null;
  if ('stringValue' in field) return field.stringValue;
  if ('timestampValue' in field) return field.timestampValue;
  if ('integerValue' in field) return Number(field.integerValue);
  if ('doubleValue' in field) return field.doubleValue;
  if ('booleanValue' in field) return field.booleanValue;
  return null;
}

/** Vercel populates req.query; a plain Node req (e.g. a local test) doesn't. */
function getQueryParam(req, name) {
  if (req.query && typeof req.query[name] === 'string') return req.query[name];
  try {
    return new URL(req.url, 'http://localhost').searchParams.get(name);
  } catch {
    return null;
  }
}

// Unknown age is treated as stale — the point of this flag is to stop the
// dashboard asserting freshness it can't back up.
function isStale(updatedAt) {
  const t = updatedAt ? new Date(updatedAt).getTime() : NaN;
  return Number.isNaN(t) || (Date.now() - t) > STALE_MS;
}

// Parse the PDF text and group it into { section, days: { Mon: '...', Wk: '...' } }.
// Ported from the client's fetchAndParseLunchPdf position-based grouping.
async function parseLunchPdf(buf) {
  // The legacy build already runs inline; disableWorker is the supported knob.
  // Do not touch GlobalWorkerOptions.workerSrc — its setter rejects null.
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableWorker: true
  });
  const pdf = await loadingTask.promise;

  try {
    // Collect text items with positions (Y normalized top-down, pages stacked).
    const items = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageHeight = (page.view && page.view[3]) || 0;
      content.items.forEach((it) => {
        const s = (it.str || '').trim();
        if (!s) return;
        items.push({
          text: s,
          x: it.transform[4],
          y: pageHeight - it.transform[5] + (i - 1) * 10000
        });
      });
    }

    const dayMarkers = items.filter((it) => DAY_RE.test(it.text));
    const knownHits = items.filter((it) => KNOWN_RE.test(it.text));
    const sectionMarkers = (knownHits.length >= 3
      ? knownHits
      : items.filter((it) => SECTION_RE.test(it.text) && it.text.length < 35)
    ).slice().sort((a, b) => a.y - b.y);

    // A section label sits in the MIDDLE of its block, and blocks differ in
    // height, so splitting halfway between two labels lands inside the taller
    // one. The day rows are the real structure, so use them as the anchor.
    //
    // Group day markers into weekly runs — a new run starts wherever the
    // weekday stops advancing (…Thu, Fri, Mon…). Each run is one section's
    // body, which gives an exact gap to split on instead of a guess.
    const DAY_ORDER = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4 };
    const dayRuns = [];
    let currentRun = null;
    let prevIdx = -1;
    for (const d of dayMarkers.slice().sort((a, b) => a.y - b.y)) {
      const idx = DAY_ORDER[d.text.slice(0, 3).toLowerCase()];
      if (idx === undefined) continue;
      if (!currentRun || idx <= prevIdx) {
        currentRun = { start: d.y, end: d.y };
        dayRuns.push(currentRun);
      }
      currentRun.end = d.y;
      prevIdx = idx;
    }
    const runFor = (s) => dayRuns.find((r) => s.y >= r.start && s.y <= r.end) || null;

    function boundaryBetween(a, b) {
      const ra = runFor(a);
      const rb = runFor(b);
      if (ra && rb) return (ra.end + rb.start) / 2;   // split the gap between blocks
      if (ra) return (ra.end + b.y) / 2;              // weekly section below a daily one
      if (rb) return (a.y + rb.start) / 2;
      return (a.y + b.y) / 2;                         // two weekly sections
    }

    const bounds = sectionMarkers.map((s, i) => ({
      text: s.text,
      lower: i === 0 ? -Infinity : boundaryBetween(sectionMarkers[i - 1], s),
      upper: i === sectionMarkers.length - 1 ? Infinity : boundaryBetween(s, sectionMarkers[i + 1])
    }));

    function sectionFor(item) {
      for (const b of bounds) {
        if (item.y >= b.lower && item.y < b.upper) return b.text;
      }
      return sectionMarkers.length ? sectionMarkers[0].text : null;
    }

    // Day = the day-marker closest in Y AND positioned to the left of the item.
    // Only match a day row inside the item's own section. Without that bound,
    // "Burger of the week" (a weekly item sitting 24px under Korean's Friday
    // row) latched onto Friday and vanished Mon-Thu, when it is served all week.
    function dayFor(item, sectionBounds) {
      let nearest = null, minDist = 25;
      for (let i = 0; i < dayMarkers.length; i++) {
        const d = dayMarkers[i];
        if (sectionBounds && (d.y < sectionBounds.lower || d.y >= sectionBounds.upper)) continue;
        const dist = Math.abs(d.y - item.y);
        if (dist < minDist && d.x < item.x - 10) { minDist = dist; nearest = d; }
      }
      if (!nearest) return null;
      const s = nearest.text.slice(0, 3);
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    }

    const grouped = {};
    items.forEach((item) => {
      if (DAY_RE.test(item.text)) return;
      // BUG FIX (was `sectionMarkers.length < 3`): the guard must check
      // knownHits — what actually decided we're on the generic path — not
      // sectionMarkers, the result of that decision. The generic path usually
      // yields MORE than 3 markers, so the old guard never fired there and
      // generic section headers leaked into cell text, getting concatenated
      // into day cells.
      if (KNOWN_RE.test(item.text) || (knownHits.length < 3 && SECTION_RE.test(item.text) && item.text.length < 35)) return;
      if (JUNK_RE.test(item.text)) return;
      if (item.text === '₩' || /^\d+[,.]?\d*$/.test(item.text)) return;

      const section = sectionFor(item);
      if (!section) return;
      const day = dayFor(item, bounds.find((b) => b.text === section)) || 'Wk';
      if (!grouped[section]) grouped[section] = { section, days: {} };
      if (!grouped[section].days[day]) {
        grouped[section].days[day] = item.text;
      } else {
        grouped[section].days[day] += ' / ' + item.text;
      }
    });

    // Preserve section order from the markers list (top-down on the page).
    return sectionMarkers
      .map((s) => grouped[s.text])
      .filter((g) => g && Object.keys(g.days).length > 0);
  } finally {
    // Serverless invocations can be warm-reused; don't let pdf.js state pile up.
    await pdf.destroy();
  }
}

// Map raw grouped sections to the wire shape: known label + all 5 weekdays,
// falling back to the weekly ('Wk') entry for sections that don't change
// daily (Burger/Soup of the week, Grill, Build Your Own).
function toResponseSections(rawSections) {
  const out = [];
  rawSections.forEach((raw) => {
    const label = SECTION_LABELS[raw.section];
    if (!label) return; // drop noisy/unknown sections
    const days = {};
    WEEKDAYS.forEach((d) => {
      days[d] = clean(raw.days[d] || raw.days.Wk || '');
    });
    out.push({ key: raw.section, label, days });
  });
  return out;
}

const LUNCH_PAGE = 'https://www.seoulforeign.org/lunch';

// The school's lunch page links each division's menu through a Finalsite
// resource-manager UUID that stays the same while the PDF behind it is
// swapped. That makes it a stable address for "the current High School menu",
// which is what removes the weekly copy-paste this endpoint used to need.
//
// Do NOT trust the resolved filename for the week: the file that served this
// week's menu was still called ...HS223-227.pdf (Feb 23-27) because the school
// reuses the name. The Cloudinary-style /v{unix}/ segment in the resolved URL
// is the real signal — it moved to Aug 9 when they uploaded the new menu.
async function discoverSchoolMenu() {
  const page = await fetchWithTimeout(LUNCH_PAGE, { timeout: 12000 });
  if (!page.ok) throw new Error(`lunch_page_http_${page.status}`);
  const html = await page.text();

  // Match the anchor whose visible text is the division name, not a filename
  // pattern — the names are what the school maintains deliberately.
  const re = /<a\b[^>]*href="(\/fs\/resource-manager\/view\/[a-f0-9-]{36})"[^>]*>([\s\S]*?)<\/a>/gi;
  let m, target = null;
  while ((m = re.exec(html)) !== null) {
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (label === 'high school') { target = m[1]; break; }
  }
  if (!target) throw new Error('high_school_link_not_found');

  const res = await fetchWithTimeout(`https://www.seoulforeign.org${target}`, { timeout: 25000 });
  if (!res.ok) throw new Error(`menu_pdf_http_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.toString('ascii', 0, 5) !== '%PDF-') throw new Error('menu_not_a_pdf');

  const stamp = (res.url || '').match(/\/v(\d{9,10})\//);
  return {
    buf,
    sourceUrl: `https://www.seoulforeign.org${target}`,
    uploadedAt: stamp ? new Date(Number(stamp[1]) * 1000).toISOString() : null
  };
}

export default handler('seoulforeign.org/lunch', async (req, res) => {
  const overrideFileId = getQueryParam(req, 'fileId');
  const warnings = [];

  let buf = null;
  let week = null;
  let updatedAt = null;
  let origin = 'school';
  let sourceUrl = LUNCH_PAGE;
  let fallbackEmbed = safeUrl(LUNCH_PAGE);

  // Preferred path: read the school's own lunch page. Nobody has to remember
  // anything for this to stay current.
  if (!overrideFileId) {
    try {
      const found = await discoverSchoolMenu();
      buf = found.buf;
      updatedAt = found.uploadedAt;
      sourceUrl = found.sourceUrl;
      fallbackEmbed = safeUrl(found.sourceUrl);
    } catch (error) {
      console.warn('lunch: school page path failed:', error);
      warnings.push(`school_page_failed:${String(error.message || error).slice(0, 60)}`);
    }
  }

  // Fallback / manual override: a Drive file set in /admin. Kept so the menu
  // can still be published by hand if the school page moves or breaks.
  if (!buf) {
    let driveFileId = overrideFileId;
    if (!driveFileId) {
      const configRes = await fetchWithTimeout(FIRESTORE_URL).catch((error) => {
        console.warn('lunch: firestore config fetch failed:', error);
        return null;
      });
      if (configRes && configRes.ok) {
        const doc = await configRes.json();
        const fields = doc.fields || {};
        driveFileId = firestoreValue(fields.driveFileId);
        week = firestoreValue(fields.week);
        updatedAt = firestoreValue(fields.updatedAt);
      }
    }
    if (!driveFileId) {
      return fail(res, { source: 'seoulforeign.org/lunch', error: 'no_menu_source', warnings, fallbackEmbed });
    }
    if (!DRIVE_ID_RE.test(driveFileId)) {
      return fail(res, { source: 'seoulforeign.org/lunch', error: 'invalid_file_id', warnings, fallbackEmbed });
    }

    origin = 'admin';
    sourceUrl = `https://drive.google.com/file/d/${driveFileId}/view`;
    fallbackEmbed = safeUrl(`https://drive.google.com/file/d/${driveFileId}/preview`);

    let pdfRes;
    try {
      pdfRes = await fetchWithTimeout(`https://drive.google.com/uc?export=download&id=${driveFileId}`, { timeout: 25000 });
    } catch (error) {
      console.error('lunch: drive fetch failed:', error);
      return fail(res, { source: 'seoulforeign.org/lunch', error: 'drive_fetch_failed', warnings, fallbackEmbed });
    }
    if (!pdfRes.ok) {
      return fail(res, { source: 'seoulforeign.org/lunch', error: `drive_http_${pdfRes.status}`, warnings, fallbackEmbed });
    }
    buf = Buffer.from(await pdfRes.arrayBuffer());
    if (buf.length < 100 || buf.toString('ascii', 0, 5) !== '%PDF-') {
      return fail(res, { source: 'seoulforeign.org/lunch', error: 'not_a_pdf', warnings, fallbackEmbed });
    }
  }

  let rawSections;
  try {
    rawSections = await parseLunchPdf(buf);
  } catch (error) {
    console.error('lunch: pdf parse threw:', error);
    // Carry the underlying reason. Bare 'pdf_parse_unavailable' told us the
    // endpoint had degraded but not whether the runtime, the download or the
    // layout was at fault, which is the only thing worth knowing here.
    return fail(res, {
      source: 'seoulforeign.org/lunch',
      error: 'pdf_parse_unavailable',
      fallbackEmbed,
      detail: String(error && error.message || error).slice(0, 200)
    });
  }
  if (rawSections.length === 0) {
    console.error('lunch: pdf parsed but yielded no sections');
    return fail(res, {
      source: 'seoulforeign.org/lunch',
      error: 'pdf_parse_unavailable',
      fallbackEmbed,
      detail: 'parsed_zero_sections'
    });
  }

  return ok(res, {
    source: 'seoulforeign.org/lunch',
    items: [],
    // `origin` tells the client whether this came from the school page or from
    // a hand-published Drive file, which changes what a stale menu means.
    origin,
    sourceUrl: safeUrl(sourceUrl),
    week: week ? clean(week) : null,
    updatedAt: updatedAt ? clean(updatedAt) : null,
    stale: isStale(updatedAt),
    sections: toResponseSections(rawSections),
    fallbackEmbed,
    warnings,
    sMaxage: 1800,
    swr: 86400
  });
});
