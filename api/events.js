// Scrapes the Finalsite-hosted school events calendar. See _lib/respond.js
// for the shared contract every /api/* endpoint follows.
//
// The rendered page ships two full month grids: a "mini" grid whose days
// carry the fsStateHasEvents class but no event markup (its content is
// filled client-side), and a second grid whose days hold the real
// <a class="fsCalendarEventTitle"> anchors inside an fsCalendarInfo wrapper.
// Scoping the event search to each daybox's own subtree handles both
// uniformly — the empty grid just contributes nothing — without needing to
// special-case which one is "real".
//
// The feed itself is noisy: every day also carries one or two day-cycle
// labels ("1", "1A", "6A" ...), and a real event often repeats two or three
// times with a day-cycle prefix ("1 - First Day of School",
// "1A - First Day of School", "First Day of School"). Both are filtered out
// below rather than left for the client to deal with.

import { parse } from 'node-html-parser';
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

const SOURCE = 'seoulforeign.org/calendar';
const ORIGIN = 'https://www.seoulforeign.org/community/calendar';

// A bare day-cycle label ("1", "2A", "6A") and nothing else — not an event.
const DAY_CYCLE_ONLY = /^\d+[A-Z]?$/;
// The same label prefixed onto a real event's title ("1A - First Day of School").
const DAY_CYCLE_PREFIX = /^\d+[A-Z]?\s*-\s*/;

// Checked in order; the first matching category wins. IB/SAT/PSAT are
// case-sensitive and word-boundary-anchored because their lowercase forms
// are common English substrings ("exhibit", "Saturday") that would
// otherwise false-positive; "break" is boundary-anchored on both sides so
// it doesn't fire on "breakfast".
const CATEGORY_RULES = [
  { category: 'arts', patterns: [/\bmusical/i, /\bconcert/i, /\brecital/i, /\bdrama/i, /\bplay/i, /\baudition/i, /\bart/i, /\bband/i, /\bchoir/i, /\borchestra/i, /theat(?:re|er)/i] },
  { category: 'athletics', patterns: [/\bsport/i, /\btryout/i, /\bgame/i, /\bmatch/i, /\btournament/i, /\bKAIAC/i, /\bAPAC/i, /\bpractice/i] },
  { category: 'holiday', patterns: [/\bholiday/i, /no classes/i, /no school/i, /\bbreak\b/i, /\bvacation/i, /day off/i, /절/] },
  { category: 'academic', patterns: [/\bexam/i, /\bIB/, /\bassessment/i, /report card/i, /\bconference/i, /\bdeadline/i, /\borientation/i, /\bPSAT\b/, /\bSAT\b/] }
];

function categorize(title) {
  const rule = CATEGORY_RULES.find(({ patterns }) => patterns.some((re) => re.test(title)));
  return rule ? rule.category : 'school';
}

/** Today where the students are, not where the function happens to run. */
function seoulToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

/** cal_date query value for the 1st of the month after `dateStr` (YYYY-MM-DD). */
function nextMonthCalDate(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

/** Every {date, title} pair found in one month's rendered calendar HTML. */
function extractEvents(html) {
  const root = parse(html);
  const events = [];
  let sawDate = false;
  for (const box of root.querySelectorAll('.fsCalendarDaybox')) {
    const dateEl = box.querySelector('.fsCalendarDate');
    const day = dateEl?.getAttribute('data-day');
    const month = dateEl?.getAttribute('data-month'); // zero-indexed
    const year = dateEl?.getAttribute('data-year');
    if (day == null || month == null || year == null) continue;
    sawDate = true;
    const date = `${year}-${String(Number(month) + 1).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
    for (const a of box.querySelectorAll('a.fsCalendarEventTitle')) {
      const title = clean(a.getAttribute('title') || a.text);
      if (title) events.push({ date, title });
    }
  }
  return { events, sawDate };
}

async function fetchMonth(url) {
  const response = await fetchWithTimeout(url, { timeout: 12000 });
  if (!response.ok) throw new Error(`origin responded ${response.status}`);
  return extractEvents(await response.text());
}

export default handler(SOURCE, async (req, res) => {
  const today = seoulToday();
  const [currentMonth, nextMonth] = await Promise.allSettled([
    fetchMonth(ORIGIN),
    fetchMonth(`${ORIGIN}?cal_date=${nextMonthCalDate(today)}`)
  ]);

  const warnings = [];
  const rawEvents = [];
  let sawDate = false;

  if (currentMonth.status === 'fulfilled') {
    rawEvents.push(...currentMonth.value.events);
    sawDate = sawDate || currentMonth.value.sawDate;
  } else {
    warnings.push('current_month_fetch_failed');
  }

  if (nextMonth.status === 'fulfilled') {
    rawEvents.push(...nextMonth.value.events);
    sawDate = sawDate || nextMonth.value.sawDate;
  } else {
    warnings.push('next_month_fetch_failed');
  }

  if (!sawDate) {
    return fail(res, { source: SOURCE, error: 'calendar_not_parsed' });
  }

  // Drop day-cycle-only labels, strip a day-cycle prefix off real titles,
  // then dedupe same-day events that differ only by that prefix.
  const seen = new Set();
  const deduped = [];
  for (const { date, title } of rawEvents) {
    if (DAY_CYCLE_ONLY.test(title)) continue;
    const stripped = title.replace(DAY_CYCLE_PREFIX, '').trim();
    if (!stripped) continue;
    const key = `${date}|${stripped}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ date, title: stripped });
  }

  const upcoming = deduped
    .filter((ev) => ev.date >= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Multi-day things (auditions, tryouts, exam weeks) are one calendar entry
  // per day upstream. Left alone, two of them fill the whole widget with five
  // repeats each and nothing further out is ever visible. Collapse a run of
  // consecutive dates for the same title into one entry with an end date.
  const nextDay = (d) => {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  };
  const runs = [];
  const openRun = new Map();          // title -> index into runs
  for (const ev of upcoming) {
    const idx = openRun.get(ev.title);
    if (idx !== undefined && nextDay(runs[idx].endDate) === ev.date) {
      runs[idx].endDate = ev.date;
      continue;
    }
    openRun.set(ev.title, runs.length);
    runs.push({ date: ev.date, endDate: ev.date, title: ev.title });
  }

  const items = runs
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, 12)
    .map((ev) => ({
      date: ev.date,
      endDate: ev.endDate === ev.date ? null : ev.endDate,
      days: ev.endDate === ev.date
        ? 1
        : Math.round((Date.parse(ev.endDate) - Date.parse(ev.date)) / 86400000) + 1,
      title: ev.title,
      category: categorize(ev.title),
      url: null
    }));

  if (items.length === 0) warnings.push('no_events_after_filtering');

  const categories = [...new Set(items.map((i) => i.category))].sort();
  const nonAthleticsCount = items.filter((i) => i.category !== 'athletics').length;

  return ok(res, {
    source: SOURCE,
    items,
    categories,
    nonAthleticsCount,
    calendarUrl: safeUrl(ORIGIN),
    warnings,
    sMaxage: 3600,
    swr: 86400
  });
});
