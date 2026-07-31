// Replaces the dead CORS proxy the dashboard used to scrape
// https://sfscrusaderathletics.com/ (a Sidearm Sports site). The origin is
// healthy server-side; only the transport was broken. See _lib/respond.js
// for the shared contract every /api/* endpoint follows.
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

const SOURCE = 'sfscrusaderathletics.com';
const ORIGIN = 'https://sfscrusaderathletics.com/';
const HOME_AWAY = new Set(['H', 'A', 'N']);
const OUTCOMES = new Set(['W', 'L', 'T']);

/**
 * Sport-name -> icon-key lookup, ported from sportFor() in index.html so the
 * dashboard keeps showing the right sport icon for events fetched here.
 */
function sportFor(text) {
  const s = String(text || '').toLowerCase();
  if (s.includes('soccer') || s.includes('football')) return 'soccer';
  if (s.includes('basketball') || s.includes('hoops')) return 'basketball';
  if (s.includes('volleyball')) return 'volleyball';
  if (s.includes('baseball') || s.includes('softball')) return 'baseball';
  if (s.includes('tennis')) return 'tennis';
  if (s.includes('badminton')) return 'badminton';
  if (s.includes('swim') || s.includes('aquat')) return 'swim';
  if (s.includes('track') || s.includes('cross country') || s.includes('running')) return 'track';
  if (s.includes('golf')) return 'golf';
  if (s.includes('cricket')) return 'cricket';
  return 'trophy';
}

/**
 * Walk forward from an object literal's opening brace, tracking nesting depth
 * and skipping over string contents (both quote styles, with backslash
 * escapes), until depth returns to 0. Replaces a prior approach that searched
 * for one of three hardcoded literal terminators — the exact whitespace
 * Sidearm's minifier happened to emit. Any minifier/whitespace change broke
 * all three silently; depth-tracking has no such dependency.
 */
function extractBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Find every <script> block that looks like the Sidearm events widget (both
 * markers present — there are ~18 other `var obj = ` blocks on the page for
 * unrelated widgets) and pull the JSON out of each. Returns whether a
 * candidate block was seen at all, separately from whether it yielded any
 * events, so the caller can tell "widget markup changed" apart from
 * "no games this window".
 */
function findEvents(html) {
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  const events = [];
  let foundBlock = false;
  let match;
  while ((match = scriptRe.exec(html))) {
    const text = match[1];
    if (!text.includes('sidearmComponents.push(obj)') || !text.includes('"type":"events"')) continue;
    foundBlock = true;
    const markerIdx = text.indexOf('var obj = ');
    if (markerIdx === -1) continue;
    const braceStart = text.indexOf('{', markerIdx);
    if (braceStart === -1) continue;
    const literal = extractBalancedObject(text, braceStart);
    if (!literal) continue;
    let obj;
    try {
      obj = JSON.parse(literal);
    } catch {
      continue;
    }
    if (obj && obj.type === 'events' && Array.isArray(obj.data)) events.push(...obj.data);
  }
  return { events, foundBlock };
}

// Sidearm dates arrive as "2026-04-10T00:00:00" with no timezone — slicing
// the literal prefix avoids a Date round-trip shifting the day by one.
function toIsoDate(value) {
  const raw = String(value || '');
  const dateOnly = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (dateOnly) return dateOnly[0];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function toScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toResult(event) {
  const outcome = event.result && event.result.status;
  if (!OUTCOMES.has(outcome)) return null;
  return {
    outcome,
    team: toScore(event.result.team_score),
    opponent: toScore(event.result.opponent_score)
  };
}

/** Mirrors eventToAthleticItem()/parseSidearmEvents() from index.html. */
function toAthleticItem(event) {
  const sportTitle = clean(event.sport && (event.sport.abbreviation || event.sport.title || event.sport.short_title));
  const opponentName = clean(event.opponent && (event.opponent.title || event.opponent.name));
  const date = toIsoDate(event.date);
  if (!sportTitle || !opponentName || !date) return null;
  const id = event.id != null ? String(event.id) : `${date}-${sportTitle}-${opponentName}`;
  return {
    id: clean(id),
    sport: clean(sportTitle),
    sportKey: sportFor(sportTitle),
    opponent: clean(opponentName),
    homeAway: HOME_AWAY.has(event.location_indicator) ? event.location_indicator : 'N',
    date,
    conference: clean((event.conference_abbrev || event.conference || '')),
    status: event.result && event.result.status ? 'final' : 'scheduled',
    result: toResult(event),
    link: safeUrl(event.schedule && event.schedule.url) || ORIGIN
  };
}

export default handler(SOURCE, async (req, res) => {
  const response = await fetchWithTimeout(ORIGIN, { timeout: 10000 });
  if (!response.ok) {
    return fail(res, { source: SOURCE, error: `origin responded ${response.status}` });
  }
  const html = await response.text();
  const { events, foundBlock } = findEvents(html);
  if (!foundBlock) {
    return fail(res, { source: SOURCE, error: 'events_block_not_found' });
  }

  // Newest first; the client needs the top of the list to be the most recent
  // result, not whatever order Sidearm happened to emit.
  const items = events
    .map(toAthleticItem)
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 10);

  if (items.length === 0) {
    // A script block was found but produced nothing — Sidearm's payload
    // shape likely changed. Surface that explicitly instead of failing
    // silently into an empty widget with no signal.
    return ok(res, {
      source: SOURCE,
      items,
      warnings: ['no_events_parsed'],
      latestEventDate: null,
      sMaxage: 900,
      swr: 3600
    });
  }

  // The season being over is not an error — the client uses this to label
  // the widget honestly instead of presenting stale spring results as live.
  return ok(res, {
    source: SOURCE,
    items,
    latestEventDate: items[0].date,
    sMaxage: 900,
    swr: 3600
  });
});
