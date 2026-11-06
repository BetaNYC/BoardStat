// BoardStat traffic measurement: the beta.nyc Google tag (GT-MQ7Q7VP), with addresses removed.
//
// A classic script (not a module), loaded in every page's <head>. It does nothing
// unless the page is served from beta.nyc, so localhost and serve.py never report.
//
// Privacy rules (Noel, 2026-11-06; About page, "What we measure"):
// - Google never sees a street address, a search, or coordinates. Before the tag
//   loads, page_location, page_referrer and page_title are replaced with cleaned
//   copies, set globally so every event the tag sends uses them
//   (https://developers.google.com/analytics/devguides/collection/ga4/reference/config).
//   Only the query parameters in SAFE_PARAMS survive; the fragment is dropped.
// - The automatic page view is off (send_page_view: false); one cleaned page_view
//   is sent by hand (https://developers.google.com/analytics/devguides/collection/ga4/views?client_type=gtag).
// - "Page changes based on browser history events" can only be turned off in the GA
//   property, not from code (same page). So BoardStat itself never writes an address
//   into the URL after load (district.js, writeUrl), and the address page never
//   rewrites its URL. A history page view, if that setting is on, sees no address.
// - Our own events carry only fixed names and short codes (TRACK_PARAMS), never
//   free text, never an address.
(function (root) {
  'use strict';

  var TAG_ID = 'GT-MQ7Q7VP';
  var HOSTS = ['www.beta.nyc', 'beta.nyc'];
  // The only query parameters that reach Google: which district, and which dates.
  // Filter values (problem, description, agency, status) and addresses are dropped;
  // the About page promises filters are counted by name only.
  var SAFE_PARAMS = ['geo', 'id', 'start', 'end'];
  // Parameters our own events may carry, and the values allowed for each.
  var TRACK_PARAMS = {
    geo: /^(cd|cc)$/,
    district_id: /^\d{1,4}$/,
    page_type: /^(district|address)$/,
    filter: /^(type|desc|agency|status|dates|address|reset)$/,
    months: /^\d{1,3}$/,
    start_year: /^\d{4}$/,
  };
  var ADDRESS_TITLE = 'Address · BoardStat 2.0 (prototype)';

  /** The page URL with every parameter outside SAFE_PARAMS, and the fragment, removed. */
  function sanitizeUrl(href) {
    var u;
    try { u = new URL(href); } catch (e) { return ''; }
    var out = new URL(u.origin + u.pathname);
    SAFE_PARAMS.forEach(function (k) {
      u.searchParams.getAll(k).forEach(function (v) { out.searchParams.append(k, v); });
    });
    return out.href;
  }

  /** Same-site referrers are cleaned like page URLs; other sites are cut to their origin. */
  function sanitizeReferrer(ref, host) {
    if (!ref) return '';
    var u;
    try { u = new URL(ref); } catch (e) { return ''; }
    if (u.hostname === host || HOSTS.indexOf(u.hostname) >= 0) return sanitizeUrl(ref);
    return u.origin + '/';
  }

  /** Address pages get a fixed title; any other title loses any address the URL carried. */
  function sanitizeTitle(title, href) {
    var u;
    try { u = new URL(href); } catch (e) { return ''; }
    if (/address\.html$/.test(u.pathname)) return ADDRESS_TITLE;
    var t = String(title || '');
    u.searchParams.forEach(function (v, k) {
      if (SAFE_PARAMS.indexOf(k) < 0 && v && v.length >= 3) t = t.split(v).join('');
    });
    return t;
  }

  /** Keep only allowed event parameters with allowed values; drop everything else. */
  function cleanParams(params) {
    var out = {};
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (TRACK_PARAMS[k] && (typeof v === 'string' || typeof v === 'number') && TRACK_PARAMS[k].test(String(v))) out[k] = v;
    });
    return out;
  }

  var api = { sanitizeUrl: sanitizeUrl, sanitizeReferrer: sanitizeReferrer, sanitizeTitle: sanitizeTitle, cleanParams: cleanParams, TAG_ID: TAG_ID, SAFE_PARAMS: SAFE_PARAMS };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; } // Node tests

  var active = HOSTS.indexOf(root.location.hostname) >= 0;
  /** Send one BoardStat event: boardstatTrack('filter_changed', { filter: 'type' }). No-op off beta.nyc. */
  root.boardstatTrack = function () {};
  if (!active) return;

  var loc = sanitizeUrl(root.location.href);
  var title = sanitizeTitle(root.document.title, root.location.href);
  var ref = sanitizeReferrer(root.document.referrer, root.location.hostname);

  root.dataLayer = root.dataLayer || [];
  function gtag() { root.dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('set', 'page_location', loc);
  gtag('set', 'page_referrer', ref);
  gtag('set', 'page_title', title);
  gtag('config', TAG_ID, { send_page_view: false });
  gtag('event', 'page_view', { page_location: loc, page_referrer: ref, page_title: title });
  root.boardstatTrack = function (name, params) {
    if (/^[a-z][a-z0-9_]{1,39}$/.test(name)) gtag('event', name, cleanParams(params));
  };

  var s = root.document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + TAG_ID;
  root.document.head.appendChild(s);
})(typeof window !== 'undefined' ? window : globalThis);
