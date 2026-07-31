// /api/lunch.js
//
// Moves the lunch-menu pipeline off the client. The dashboard used to fetch a
// 222 KB Google Drive PDF through a dead CORS proxy and parse it with pdf.js
// in the browser — 320 KB of pdf.js shipped on every page load just for this,
// and the parse re-ran up to 12x/hour per open tab. The Drive URL fetches
// fine from a server (no CORS involved), so this endpoint fetches + parses
// once and lets the CDN cache (see ok()'s sMaxage) absorb repeat requests.

import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

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
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false
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

    // Section labels in Crave PDFs sit in the MIDDLE of their cell, so use the
    // midpoint between adjacent labels as the boundary instead of "label above".
    function sectionFor(item) {
      for (let i = 0; i < sectionMarkers.length; i++) {
        const s = sectionMarkers[i];
        const prev = sectionMarkers[i - 1];
        const next = sectionMarkers[i + 1];
        const lower = prev ? (prev.y + s.y) / 2 : -Infinity;
        const upper = next ? (s.y + next.y) / 2 : Infinity;
        if (item.y >= lower && item.y < upper) return s.text;
      }
      return sectionMarkers.length ? sectionMarkers[0].text : null;
    }

    // Day = the day-marker closest in Y AND positioned to the left of the item.
    function dayFor(item) {
      let nearest = null, minDist = 25;
      for (let i = 0; i < dayMarkers.length; i++) {
        const d = dayMarkers[i];
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
      const day = dayFor(item) || 'Wk';
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
      days[d] = clean((raw.days[d] || raw.days.Wk || ''));
    });
    out.push({ key: raw.section, label, days });
  });
  return out;
}

export default handler('drive+firestore', async (req, res) => {
  const overrideFileId = getQueryParam(req, 'fileId');

  let driveFileId = null;
  let week = null;
  let updatedAt = null;

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
  if (overrideFileId) driveFileId = overrideFileId; // explicit test override wins

  if (!driveFileId) {
    return fail(res, { source: 'drive+firestore', error: 'no_drive_file_id' });
  }
  if (!DRIVE_ID_RE.test(driveFileId)) {
    return fail(res, { source: 'drive+firestore', error: 'invalid_file_id' });
  }

  const fallbackEmbed = safeUrl(`https://drive.google.com/file/d/${driveFileId}/preview`);

  let pdfRes;
  try {
    pdfRes = await fetchWithTimeout(`https://drive.google.com/uc?export=download&id=${driveFileId}`, { timeout: 15000 });
  } catch (error) {
    console.error('lunch: drive fetch failed:', error);
    return fail(res, { source: 'drive+firestore', error: 'drive_fetch_failed', fallbackEmbed });
  }
  if (!pdfRes.ok) {
    return fail(res, { source: 'drive+firestore', error: `drive_http_${pdfRes.status}`, fallbackEmbed });
  }

  const buf = Buffer.from(await pdfRes.arrayBuffer());
  if (buf.length < 100 || buf.toString('ascii', 0, 5) !== '%PDF-') {
    return fail(res, { source: 'drive+firestore', error: 'not_a_pdf', fallbackEmbed });
  }

  let rawSections;
  try {
    rawSections = await parseLunchPdf(buf);
  } catch (error) {
    console.error('lunch: pdf parse threw:', error);
    return fail(res, { source: 'drive+firestore', error: 'pdf_parse_unavailable', fallbackEmbed });
  }
  if (rawSections.length === 0) {
    console.error('lunch: pdf parsed but yielded no sections');
    return fail(res, { source: 'drive+firestore', error: 'pdf_parse_unavailable', fallbackEmbed });
  }

  return ok(res, {
    source: 'drive+firestore',
    items: [],
    week: week ? clean((week)) : null,
    driveFileId: clean(driveFileId),
    updatedAt: updatedAt ? clean(updatedAt) : null,
    stale: isStale(updatedAt),
    sections: toResponseSections(rawSections),
    fallbackEmbed,
    sMaxage: 1800,
    swr: 86400
  });
});
