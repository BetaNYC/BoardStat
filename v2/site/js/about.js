// About page: data sources and definitions, read from the same manifest the district pages use.
import { loadManifest, renderDataStatus, el, fmtInt, fmtPct, fmtDateTime } from './lib.js';

const $ = (id) => document.getElementById(id);

function renderSources(manifest) {
  const c = manifest.counts;
  const a = manifest.agreement;
  const s = manifest.sources;
  $('about').replaceChildren(
    el('ul', {},
      el('li', {}, '311 requests: ', el('a', { href: s.service_requests.url, text: s.service_requests.name || '311 Service Requests' }), ` (dataset ${s.service_requests.id}) on NYC Open Data.`),
      el('li', {}, 'Boundaries: Department of City Planning ',
        el('a', { href: `https://data.cityofnewyork.us/d/${s.community_districts.id}`, text: 'Community Districts' }), ` (release ${s.community_districts.version || 'unknown'}) and `,
        el('a', { href: `https://data.cityofnewyork.us/d/${s.council_districts.id}`, text: 'City Council Districts' }), ` (release ${s.council_districts.version || 'unknown'}).`),
      el('li', {}, 'Every request with a location was placed in a district by BoardStat, using where it happened and today\'s boundary lines. Requests are re-mapped to current lines even if they were made under older ones.'),
      el('li', {}, `${fmtInt(c.without_coords)} of ${fmtInt(c.total)} requests citywide (${fmtPct(c.without_coords / c.total)}) have no usable location, so they are not on any district page.`),
      el('li', {}, `How often our district matches the city's own fields: council district ${fmtPct(a.council.share)} of ${fmtInt(a.council.compared)} requests; community district ${fmtPct(a.community_district.share)} of ${fmtInt(a.community_district.compared)}.` +
        ' Small differences are expected where a request sits near a boundary line. For older requests, the city\'s council field often uses the lines in force before the 2023 redistricting, so the two differ more often there.'),
      el('li', {}, `Problem names are grouped regardless of capitalization (for example PLUMBING and Plumbing). ${manifest.complaint_types.unreviewed} of ${manifest.complaint_types.groups} groupings have not yet been reviewed by a person.`),
      el('li', {}, `Time to close (days to close) is the close date minus the created date, in days. It counts only requests marked Closed. Requests with no close date, closed before they were opened (${fmtInt(c.closed_before_created)} citywide) or with a close date in the future (${fmtInt(c.closed_in_future)}) are left out, and so are the few requests that carry a close date but whose status is not Closed.`),
      el('li', {}, `"Not yet closed" means any status other than Closed (for example Open, In Progress, Assigned). Days open are counted from when a request was created to when this data was built (${fmtDateTime(manifest.generated_at)}), not to today.`),
      el('li', {}, '311 counts are reports, not problems. Closed doesn\'t mean fixed. A count shows who reports and how, not only how many problems exist: a higher count can mean more engaged neighbors, not a worse block.'),
    ),
  );
}

async function main() {
  try {
    const manifest = await loadManifest();
    renderDataStatus(manifest, $('as-of'), $('stale'));
    renderSources(manifest);
  } catch (err) {
    $('as-of').textContent = String(err.message || err);
    $('about').replaceChildren();
  }
}

main();
