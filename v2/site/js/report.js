// "Report a data problem" form on the Help page: the first tool to use BetaNYC's
// data-issue intake (betanyc-ai-workspace epic #1594).
//
// The endpoint and its rules come from the intake's WordPress snippet (betanyc-ai-workspace
// PR #1603). The page sends exactly these keys and nothing else, because the server
// rejects any key it does not know (HTTP 400):
//   schema "betanyc-data-issue/1", tool "boardstat", kind "problem-report",
//   page_url (required, at most 500 characters, no whitespace),
//   description (required, at most 2000 characters after NFKC and trimming),
//   record (optional, at most 300 characters), website (the honeypot: people leave it empty).
// No name, email or other contact field is sent. Answers are JSON { ok, error }:
// 201 filed, 400 bad input, 403 origin not allowed, 429 too many (Retry-After, seconds),
// 503 unavailable. From localhost the server answers 403, by design.
//
// The pure functions are exported for `node --test v2/tests-js/`; the page wiring at the
// bottom runs only in a browser, on a page that has the form.
import { el } from './lib.js';

export const REPORT_ENDPOINT = 'https://www.beta.nyc/wp-json/betanyc-data/v1/report';
export const LIMITS = { description: 2000, record: 300, page_url: 500, body_bytes: 64 * 1024 };
const SEND_TIMEOUT_MS = 20000;

// The only link parameters that may go into page_url: the place, the dates and the filters,
// as district.html and map.html write them (filterstate.js filtersToParams). `addr`, the
// street address an address page carries in its link, is never on this list, so no street
// address can reach the report (v2/README.md, "Address filter" and the analytics notes).
export const PAGE_PARAMS = ['geo', 'id', 'start', 'end', 'type', 'desc', 'descx', 'agency', 'status'];

// The pages whose "Report a data problem" link hands their address to the form, as
// help.html?from=<page>&<their parameters>. Only these exact file names are read back:
// any other `from` is ignored, so the Help page's link can never point page_url anywhere else.
export const REPORT_FROM_PAGES = ['district.html', 'map.html', 'address.html'];
const REPORT_ANCHOR = '#report-h';

/**
 * The href of a data page's "Report a data problem" link: `page` is the page's file name
 * and `params` the URLSearchParams its own links carry (filterstate.js filtersToParams).
 * Only PAGE_PARAMS are kept, so a street address (`addr`) never goes into it. An unknown
 * page gets the plain link, which leaves the form to the referrer.
 */
export function reportLinkHref(page, params) {
  if (!REPORT_FROM_PAGES.includes(page)) return `help.html${REPORT_ANCHOR}`;
  const kept = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(params || '')) if (PAGE_PARAMS.includes(k)) kept.append(k, v);
  const q = kept.toString();
  return `help.html?from=${page}${q ? `&${q}` : ''}${REPORT_ANCHOR}`;
}

/** Characters as the server counts them: code points after trimming, NFKC applied or not, whichever is more. */
export function charCount(text) {
  const s = String(text ?? '');
  return Math.max([...s.trim()].length, [...s.normalize('NFKC').trim()].length);
}

/** origin + the folder the page is in, e.g. "https://www.beta.nyc/boardstat/". */
function siteBase(u) {
  return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
}

/**
 * A same-site page URL with only PAGE_PARAMS kept and the fragment dropped. The kept
 * parameters are copied as written (the URL parser has already percent-encoded any
 * whitespace), so the link staff open is the one the visitor had.
 */
function cleanPageUrl(u) {
  const keyOf = (pair) => {
    try { return decodeURIComponent(pair.split('=')[0].replace(/\+/g, ' ')); } catch { return null; }
  };
  const kept = u.search.slice(1).split('&').filter((pair) => pair && PAGE_PARAMS.includes(keyOf(pair)));
  return u.origin + u.pathname + (kept.length ? `?${kept.join('&')}` : '');
}

/**
 * The page_url to send, in this order:
 * 1. the hand-off: this page's own link says from=district.html, map.html or address.html
 *    (exactly; REPORT_FROM_PAGES), so the page is that file in this site's folder, with the
 *    PAGE_PARAMS copied from this page's link. It is current when the visitor clicked,
 *    filters applied since the page loaded included, and it needs no referrer.
 * 2. the page the visitor came from, when it is a BoardStat page on this same site.
 *    A referrer from any other origin, including look-alike hosts, is never used.
 * 3. this page's own address, without its query string.
 * `from` itself is never in page_url. Over 500 characters, the address without its query
 * string is sent instead.
 */
export function choosePageUrl(locationHref, referrer) {
  const here = new URL(locationHref);
  const base = siteBase(here);
  let page = new URL(here.origin + here.pathname);
  const from = here.searchParams.get('from');
  if (from && REPORT_FROM_PAGES.includes(from)) {
    // cleanPageUrl drops every parameter not in PAGE_PARAMS, `from` included.
    page = new URL(base + from + here.search);
  } else if (referrer) {
    let r = null;
    try { r = new URL(referrer); } catch { r = null; }
    if (r && r.origin === here.origin && (r.origin + r.pathname).startsWith(base)) page = r;
  }
  const full = cleanPageUrl(page);
  if (full.length <= LIMITS.page_url) return full;
  const bare = page.origin + page.pathname;
  return bare.length <= LIMITS.page_url ? bare : base.slice(0, LIMITS.page_url);
}

/** Field errors before sending: { ok, errors: { description?, record? } }. */
export function validateReport({ description = '', record = '' } = {}) {
  const errors = {};
  const d = charCount(description);
  if (d === 0) errors.description = 'Please say what looks wrong.';
  else if (d > LIMITS.description) errors.description = `This is ${d.toLocaleString('en-US')} characters. Please shorten it to ${LIMITS.description.toLocaleString('en-US')} or fewer.`;
  const r = charCount(record);
  if (r > LIMITS.record) errors.record = `This is ${r.toLocaleString('en-US')} characters. Please shorten it to ${LIMITS.record} or fewer.`;
  return { ok: Object.keys(errors).length === 0, errors };
}

/** The JSON body: exactly the keys the endpoint allows for a problem report, and no contact details. */
export function buildPayload({ description = '', record = '', website = '', pageUrl }) {
  const body = {
    schema: 'betanyc-data-issue/1',
    tool: 'boardstat',
    kind: 'problem-report',
    page_url: String(pageUrl || ''),
    description: String(description).trim(),
    website: String(website ?? ''),
  };
  const rec = String(record ?? '').trim();
  if (rec) body.record = rec;
  return body;
}

/** "about 3 minutes" from a Retry-After header in seconds, or null if it is missing or not a number. */
export function retryWait(retryAfter) {
  if (retryAfter == null || !/^\s*\d+\s*$/.test(String(retryAfter))) return null;
  const minutes = Math.max(1, Math.ceil(Number(retryAfter) / 60));
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hours`;
}

export const MESSAGES = {
  sent: 'Thank you. Your report was sent, and a BetaNYC staff member will read it.',
  failed: 'Your report did not go through. What you wrote is still here: try again, or send it with the Email boardstat@beta.nyc button above.',
};

/**
 * What to tell the visitor. `result` is { status, retryAfter } from a response, or
 * { networkError: true } when the request never got an answer.
 * Returns { kind: 'sent' | 'busy' | 'failed', message }.
 */
export function describeResult(result) {
  if (!result || result.networkError) return { kind: 'failed', message: MESSAGES.failed };
  if (result.status === 201) return { kind: 'sent', message: MESSAGES.sent };
  if (result.status === 429) {
    const wait = retryWait(result.retryAfter);
    return {
      kind: 'busy',
      message: `Too many reports have come in for now, so yours was not sent. What you wrote is still here. Please try again ${wait ? `in ${wait}` : 'later'}.`,
    };
  }
  return { kind: 'failed', message: MESSAGES.failed };
}

/**
 * POST one report. Never throws: a network failure, a timeout or a body over the size limit
 * all come back as a 'failed' result. `fetchImpl` is injectable for tests.
 */
export async function sendReport(payload, { fetchImpl = globalThis.fetch, endpoint = REPORT_ENDPOINT, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > LIMITS.body_bytes) return describeResult({ networkError: true });
  try {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);
    const r = await fetchImpl(endpoint, init);
    return describeResult({ status: r.status, retryAfter: r.headers?.get?.('Retry-After') ?? null });
  } catch {
    return describeResult({ networkError: true });
  }
}

// ---------------------------------------------------------------- page wiring

function setFieldError(input, errorNode, hintId, message) {
  errorNode.textContent = message || '';
  errorNode.hidden = !message;
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', `${hintId} ${errorNode.id}`);
  } else {
    input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', hintId);
  }
}

/** Run the form. The block is hidden in the HTML, so without JavaScript there is no dead button. */
export function setupReportForm(doc = document, win = window) {
  const $ = (id) => doc.getElementById(id);
  const wrap = $('report');
  const form = $('report-form');
  if (!wrap || !form) return;
  const desc = $('report-desc');
  const rec = $('report-record');
  const hp = $('report-website');
  const button = $('report-send');
  const status = $('report-status');
  const pageUrl = choosePageUrl(win.location.href, doc.referrer);
  $('report-page-url').replaceChildren(el('code', { text: pageUrl }));
  wrap.hidden = false;
  // A data page's link opens help.html#report-h. The block was hidden when the browser
  // looked for that heading, so bring it into view now that it shows.
  if (win.location.hash === REPORT_ANCHOR) $('report-h')?.scrollIntoView();

  let sending = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (sending) return;
    const v = validateReport({ description: desc.value, record: rec.value });
    setFieldError(desc, $('report-desc-error'), 'report-desc-hint', v.errors.description);
    setFieldError(rec, $('report-record-error'), 'report-record-hint', v.errors.record);
    if (!v.ok) {
      status.textContent = 'Please fix the box marked above, then send again.';
      (v.errors.description ? desc : rec).focus();
      return;
    }
    sending = true;
    button.disabled = true;
    status.textContent = 'Sending…';
    const result = await sendReport(buildPayload({ description: desc.value, record: rec.value, website: hp.value, pageUrl }));
    sending = false;
    button.disabled = false;
    status.textContent = result.message;
    if (result.kind === 'sent') form.reset();
  });
}

if (typeof document !== 'undefined' && document.getElementById('report-form')) setupReportForm();
