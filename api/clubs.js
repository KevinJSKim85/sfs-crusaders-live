// Scrapes the SFHS Clubs & Organizations site, a Google Sites page with no
// prior client-side integration. See _lib/respond.js for the shared contract
// every /api/* endpoint follows.
//
// Google Sites doesn't render club listings as a content table — instead the
// whole site's page tree ships as a navigation widget, and every club (and
// every section) happens to be its own page in that tree. A "section" node
// (Day 1, Official Functions, ...) is a nav item whose direct children are
// all leaf pages (no sub-pages of their own); a "container" node (Crusader
// Clubs, holding Day 1 and Day 4) is one whose children have children of
// their own. That structural difference — not any hardcoded label — is what
// separates the two below. The nav tree itself is duplicated 2-3x in the raw
// HTML (desktop header nav, mobile menu, overflow "more" submenu); only the
// first copy encountered is walked, so nothing needs deduping afterward.

import { parse } from 'node-html-parser';
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

const SOURCE = 'sites.google.com/.../sfhsclubsorganizations25-26';
const ORIGIN = 'https://sites.google.com/seoulforeign.org/sfhsclubsorganizations25-26/home';
const SITE_ORIGIN = 'https://sites.google.com';

/**
 * Google Sites routes every off-site link through a redirector and gives
 * on-site page links a site-relative data-url instead of an absolute one —
 * both need to become a plain absolute URL.
 */
function resolveNavUrl(dataUrl) {
  const raw = String(dataUrl || '').trim();
  if (!raw) return null;
  if (raw.startsWith('/')) return safeUrl(SITE_ORIGIN + raw);
  const redirected = raw.match(/^https?:\/\/www\.google\.com\/url\?q=([^&]+)/i);
  return safeUrl(redirected ? decodeURIComponent(redirected[1]) : raw);
}

function slugify(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A nav <li>'s own page link — always the first data-url anchor in document order, since its child <ul> (if any) sits later in the DOM. */
function navLink(li) {
  const a = li.querySelector('a[data-url]');
  return { text: clean(a ? a.text : ''), dataUrl: a ? a.getAttribute('data-url') : '' };
}

/** The <ul> holding this li's direct sub-pages, if any. */
function childList(li) {
  return li.querySelector(':scope > div.oGuwee > ul, :scope > ul');
}

function childItems(li) {
  const ul = childList(li);
  return ul ? ul.querySelectorAll(':scope > li') : [];
}

/**
 * Recursively find "section" nodes: pages whose direct children are all
 * leaves. Pages whose children have children of their own (grouping pages
 * like "Crusader Clubs") are walked into instead of being treated as a
 * section themselves.
 */
function collectSections(ul, sections) {
  for (const li of ul.querySelectorAll(':scope > li')) {
    const kids = childItems(li);
    if (kids.length === 0) continue; // plain page (e.g. "Home"), not a section
    if (kids.every((kid) => childItems(kid).length === 0)) {
      const { text: label, dataUrl } = navLink(li);
      if (!label) continue;
      const clubs = kids
        .map((kid) => {
          const { text: name, dataUrl: kidUrl } = navLink(kid);
          return name ? { name, url: resolveNavUrl(kidUrl) } : null;
        })
        .filter(Boolean);
      if (clubs.length) {
        const key = dataUrl.split('/').filter(Boolean).pop() || slugify(label);
        sections.push({ key, label, clubs });
      }
    } else {
      const nested = childList(li);
      if (nested) collectSections(nested, sections);
    }
  }
}

/** First link on the page whose href contains `needle`, or null. */
function firstLinkHref(root, needle) {
  const a = root.querySelector(`a[href*="${needle}"]`);
  return a ? safeUrl(a.getAttribute('href')) : null;
}

/**
 * The sign-up deadline and "meetings begin" dates live as "Semester N: <date>"
 * paragraphs directly following their labeled heading paragraph. Matched by
 * text content, not position, so unrelated copy shifting around above them
 * doesn't break it — but an actual redesign of this list correctly yields
 * nothing rather than a wrong date.
 */
function extractKeyDates(paragraphs) {
  const triggers = [
    { test: /^Clubs Sign-up Deadline/i, label: 'Clubs sign-up deadline' },
    { test: /^Club Meetings Begin/i, label: 'Club meetings begin' }
  ];
  const dates = [];
  paragraphs.forEach((text, i) => {
    const trigger = triggers.find((t) => t.test.test(text));
    if (!trigger) return;
    for (let j = i + 1; j < paragraphs.length; j++) {
      const m = paragraphs[j].match(/^Semester\s+(\d+):\s*(.+)$/i);
      if (!m) break;
      dates.push({ label: `${trigger.label} (Semester ${m[1]})`, value: clean(m[2]) });
    }
  });
  return dates;
}

export default handler(SOURCE, async (req, res) => {
  const response = await fetchWithTimeout(ORIGIN, { timeout: 12000 });
  if (!response.ok) {
    return fail(res, { source: SOURCE, error: `origin responded ${response.status}` });
  }
  const html = await response.text();
  const root = parse(html);

  const firstTopLevel = root.querySelector('li[data-nav-level="1"]');
  const sections = [];
  if (firstTopLevel && firstTopLevel.parentNode) {
    collectSections(firstTopLevel.parentNode, sections);
  }

  const items = sections.flatMap((s) =>
    s.clubs.map((c) => ({ name: c.name, section: s.key, sectionLabel: s.label, url: c.url }))
  );

  if (items.length === 0) {
    return fail(res, { source: SOURCE, error: 'no_clubs_parsed' });
  }

  const meetingDays = sections.filter((s) => /^Day\s+\d+$/i.test(s.label)).map((s) => s.label);

  const paragraphs = root.querySelectorAll('p').map((p) => clean(p.text)).filter(Boolean);
  const keyDates = extractKeyDates(paragraphs);

  // The page links three separate spreadsheets (Clubs List, Meeting
  // Schedule, a sheet-based Calendar); spreadsheetUrl picks the first as the
  // primary one, and all three ride along in `spreadsheets` so none of them
  // is silently dropped.
  const spreadsheets = root.querySelectorAll('a[href*="docs.google.com/spreadsheets"]').map((a) => ({
    label: clean(a.text),
    url: safeUrl(a.getAttribute('href'))
  }));

  const signup = {
    calendarUrl: firstLinkHref(root, 'calendar.google.com'),
    spreadsheetUrl: spreadsheets[0]?.url || null,
    formUrl: firstLinkHref(root, 'docs.google.com/forms'),
    canvaUrl: firstLinkHref(root, 'canva.com'),
    spreadsheets
  };

  return ok(res, {
    source: SOURCE,
    meetingDays,
    sections,
    items,
    signup,
    keyDates,
    sMaxage: 21600,
    swr: 86400
  });
});
