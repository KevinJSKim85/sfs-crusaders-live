// GET /api/instagram?account=sfs|athletics — recent posts for the two school
// accounts, fetched server-side with no login and no token to rotate.
//
// Why this endpoint exists: the dashboard used to regex `/p/{shortcode}/` out
// of https://www.instagram.com/{user}/. That page is a ~610 KB JavaScript shell
// with zero post links in it, so the regex matched nothing and the widget
// silently fell back to a hardcoded seed list that has been rotting ever since.
// It was never a login wall — the markup simply does not contain the posts.
//
// The endpoint below is Instagram's own public web API, the one instagram.com
// calls from the browser. It needs the public web app id header and nothing
// else: no cookie, no session, no access token, no 60-day refresh.
import { handler, ok, fail, safeUrl, clean, fetchWithTimeout } from './_lib/respond.js';

/**
 * The exact header set Instagram's own page sends when it calls this API.
 *
 * x-ig-app-id is the public web app id shipped in instagram.com's client
 * bundle — no credential, just the identifier the API requires.
 *
 * The Sec-Fetch-* trio is not optional and not cargo cult. Node's fetch
 * (undici) stamps `Sec-Fetch-Site: cross-site` on every request it makes and
 * will not let the caller drop the header; Instagram answers that with a bare
 * `400 SecFetch Policy violation.` Overriding the value to what a same-origin
 * XHR from instagram.com would send is what makes this work under Node. curl
 * sends no Sec-Fetch headers at all and sails through, so this failure is
 * invisible to command-line testing and only appears once the code runs on the
 * server — which is the only place it matters.
 */
const IG_HEADERS = {
  'x-ig-app-id': '936619743392459',
  Accept: '*/*',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty'
};

// Map, not a plain object — a hostile `account` value must not resolve to
// Object.prototype the way ACCOUNTS['__proto__'] would on a literal.
const ACCOUNTS = new Map([
  ['sfs',       { username: 'seoul_foreign_school', juicerFeed: '333326' }],
  ['athletics', { username: 'sfscrusaderathletics', juicerFeed: null }]
]);

const MAX_ITEMS = 12;

/**
 * Route thumbnails through weserv rather than handing out Instagram CDN URLs.
 *
 * Two reasons. Instagram's CDN links carry a signed expiry, so a URL cached at
 * our edge for the full window can outlive its own signature; weserv refetches
 * server-side and is not subject to that. And the CDN sets hotlink rules that
 * have blocked third-party origins before — weserv is already the proxy the
 * rest of this dashboard trusts for Instagram media.
 */
function proxied(url) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}`;
}

/**
 * Pick a thumbnail-sized image rather than the full-resolution original.
 *
 * `candidates` arrives largest-first. The smallest one still wide enough for a
 * card beats candidates[0], which is routinely 1440px — a card that renders at
 * 300px should not pull a megabyte per post.
 */
function pickImage(media) {
  const candidates = media?.image_versions2?.candidates
    // A carousel container can omit image_versions2 and carry it on the first
    // child instead, so fall through to that before giving up.
    || media?.carousel_media?.[0]?.image_versions2?.candidates
    || [];
  if (!candidates.length) return null;
  const wideEnough = candidates.filter((c) => (c.width || 0) >= 480);
  const chosen = wideEnough.length ? wideEnough[wideEnough.length - 1] : candidates[0];
  return safeUrl(chosen?.url);
}

/**
 * Normalize one item from either upstream into the shape the client reads.
 *
 * The shortcode is validated before it is interpolated into a URL: everything
 * here is third-party data, and a post link is something a student clicks.
 */
function toItem({ shortcode, image, caption, postedAt }) {
  const code = String(shortcode ?? '');
  if (!/^[A-Za-z0-9_-]{6,}$/.test(code)) return null;
  const at = postedAt instanceof Date && !Number.isNaN(postedAt.getTime()) ? postedAt : null;
  return {
    shortcode: code,
    url: `https://www.instagram.com/p/${code}/`,
    // No image is survivable — the client can render a text card. A broken
    // <img> that 404s on every paint is not.
    thumbnail: image ? proxied(image) : null,
    // Not HTML-escaped on purpose: JSON is the transport and the client escapes
    // at its own DOM sink. See the note in _lib/respond.js.
    caption: clean(caption),
    // Epoch rather than a fake "now" when a timestamp is missing, so a bad
    // parse sinks the item in a desc sort instead of masquerading as fresh.
    postedAt: (at || new Date(0)).toISOString()
  };
}

/**
 * Primary source: Instagram's public web feed API.
 *
 * Deliberately NOT /api/v1/users/web_profile_info/, which is the better-known
 * unauthenticated endpoint. That one currently returns a hard 400 for
 * seoul_foreign_school specifically — "Asset asset://laser.provider/
 * ig_business_category_subvertical has been deleted" — a Meta-side schema bug
 * in a business-profile field that account happens to populate. It is
 * reproducible on every call and there is nothing we can do about it from the
 * client side. This endpoint returns media without that profile block, so it
 * answers 200 for both accounts.
 */
async function fromInstagram(username) {
  const res = await fetchWithTimeout(
    `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=${MAX_ITEMS}`,
    { timeout: 9000, headers: IG_HEADERS }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) throw new Error('no_items');

  return items
    .map((media) => toItem({
      shortcode: media?.code,
      image: pickImage(media),
      caption: media?.caption?.text,
      // taken_at is unix seconds. Videos and reels carry it exactly like
      // photos do, which is what lets this source cover post types the old
      // /p/{code}/media/ thumbnail trick could never render.
      postedAt: media?.taken_at ? new Date(media.taken_at * 1000) : null
    }))
    .filter(Boolean);
}

/**
 * Fallback, main account only: the school's own Juicer widget.
 *
 * seoulforeign.org embeds Juicer feed 333326 to render "TODAY AT SFS", and its
 * backing JSON is public and uncredentialed. Worth wiring up precisely because
 * web_profile_info proved Instagram can break one account and not the other —
 * if that happens to the feed API too, this keeps the widget populated.
 *
 * It is a fallback and not the primary because it lags: Juicer syncs on its own
 * schedule and was last observed a post behind the live account.
 */
async function fromJuicer(feedId) {
  const res = await fetchWithTimeout(`https://www.juicer.io/api/feeds/${encodeURIComponent(feedId)}`, { timeout: 9000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const posts = Array.isArray(data?.posts?.items) ? data.posts.items : [];
  // The feed can aggregate several networks; only Instagram posts have a
  // shortcode, and only they belong in an Instagram widget.
  return posts
    .filter((p) => p?.source?.source === 'Instagram')
    .slice(0, MAX_ITEMS)
    .map((p) => toItem({
      shortcode: p?.external_id,
      image: safeUrl(p?.image),
      // Juicer bakes <br /> into its caption fields, including the one named
      // "unformatted". Left alone those reach the reader as literal "<br />"
      // text, because the client escapes at its sink rather than parsing HTML.
      caption: String(p?.unformatted_message || p?.message || '').replace(/<[^>]*>/g, ' '),
      postedAt: p?.external_created_at ? new Date(p.external_created_at) : null
    }))
    .filter(Boolean);
}

export default handler('instagram', async (req, res) => {
  const requested = req.query?.account;
  const key = Array.isArray(requested) ? requested[0] : requested;
  const accountKey = ACCOUNTS.has(key) ? key : 'sfs';
  const account = ACCOUNTS.get(accountKey);

  const warnings = [];
  let items = [];

  try {
    items = await fromInstagram(account.username);
  } catch (error) {
    warnings.push(`instagram: ${String(error?.message || error)}`);
    if (!account.juicerFeed) {
      return fail(res, { source: 'instagram', error, account: accountKey, username: account.username });
    }
    try {
      items = await fromJuicer(account.juicerFeed);
      warnings.push('served from juicer fallback; may lag the live account');
    } catch (fallbackError) {
      warnings.push(`juicer: ${String(fallbackError?.message || fallbackError)}`);
      return fail(res, { source: 'instagram', error: 'all_sources_failed', account: accountKey, username: account.username, warnings });
    }
  }

  if (!items.length) {
    return fail(res, { source: 'instagram', error: 'no_items', account: accountKey, username: account.username, warnings });
  }

  items.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

  // Long swr on purpose: these two accounts post on a school calendar and go
  // quiet for weeks over breaks. A stale-but-real post beats an empty widget,
  // and there is no one babysitting this site to notice the difference.
  return ok(res, {
    source: 'instagram',
    items: items.slice(0, MAX_ITEMS),
    sMaxage: 1800,
    swr: 86400,
    warnings,
    account: accountKey,
    username: account.username,
    profileUrl: `https://www.instagram.com/${account.username}/`
  });
});
