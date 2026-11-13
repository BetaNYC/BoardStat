// The filter form, shared by the district, address and full-page map pages (#149).
// Each page has the same <form id="filters"> markup (a test keeps the three copies the
// same); this module runs it: groups that open and close, problem and description chips,
// Apply, Reset, the "not applied yet" note, the date-order and problem-name checks, and
// #142's rule that an Apply with nothing changed does not run every query again.
//
// The form keeps two copies of the filters (filterstate.js): `applied`, what the page
// shows and its link carries, and `draft`, what the form shows. Only Apply, Reset and the
// page's shortcut buttons change `applied`; then the page's onApply redraws.
//
// The page supplies the lists to choose from (it knows where its rows are) and what to do
// on Apply. The pure decisions are exported for v2/tests-js.
import { el, fmtDate } from './lib.js';
import { copyFilters, changedFields, patchBoth, sectionCount, SECTIONS, NOT_CLOSED } from './filterstate.js';

export const DATE_ORDER_MSG = 'The From date is after the To date. Change one of them, then press Apply filters.';
export const PENDING_MSG = 'Filters changed. Press Apply filters to update the page.';

/**
 * What Apply does with this draft: 'date-order' (stop and say so; checked first, so dates
 * swapped in a link are flagged even with nothing changed), 'no-change' (nothing to redo,
 * unless text was typed or the last run failed, so Apply can retry), or 'apply'.
 */
export function applyCheck({ draft, applied, typed = false, lastFailed = false }) {
  if (draft.start > draft.end) return 'date-order';
  if (!typed && !lastFailed && changedFields(draft, applied).length === 0) return 'no-change';
  return 'apply';
}

/** The choice in `list` that `text` names, ignoring case and outer spaces, or undefined. */
export function findChoice(list, text) {
  const t = String(text).trim().toLowerCase();
  return list.find((x) => String(x).toLowerCase() === t);
}

/** The note under the buttons and the text after each group's heading. */
export function pendingSummary(draft, applied, defaults, fmt = fmtDate) {
  const changed = changedFields(draft, applied);
  const counts = {};
  for (const section of Object.keys(SECTIONS)) {
    const n = sectionCount(draft, defaults, section);
    const edited = changed.some((k) => SECTIONS[section].includes(k) || (section === 'problem' && k === 'descEx'));
    const parts = [];
    if (section === 'dates') parts.push(`${fmt(draft.start)} to ${fmt(draft.end)}`);
    else if (n) parts.push(`${n} chosen`);
    if (edited) parts.push('not applied yet');
    counts[section] = parts.length ? `(${parts.join(', ')})` : '';
  }
  return { pending: changed.length > 0, msg: changed.length ? PENDING_MSG : '', counts };
}

/**
 * Run the form on this page.
 *   defaults()          the filters a link without filters opens with (Reset's target)
 *   lists.problems()    problem names, most common first
 *   lists.descriptions(types)  descriptions for those problems (all if none)
 *   lists.agencies()    [{ agency, label }]
 *   lists.statuses()    status values
 *   onApply(applied)    the page redraws for these filters
 *   lastFailed()        true if the page's last redraw failed (Apply then always reruns)
 *   matchText()         the status line for an Apply that changes nothing ("N requests match.")
 *   setStatus(msg)      the page's status line
 *   lockAddress         the address page: its address is fixed and not shown as a filter
 */
export function createFilterForm({ defaults, lists, onApply, lastFailed = () => false, matchText = () => '', setStatus, lockAddress = false, $ = (id) => document.getElementById(id) }) {
  let applied = copyFilters(defaults());
  let draft = copyFilters(applied);
  let problems = [];
  let descs = [];
  let descKey = null;
  let listsReady = false; // the page has rows to list (fillLists has run)

  function renderChips() {
    $('type-chips').replaceChildren(...draft.types.map((t) => el('li', {},
      el('button', { type: 'button', 'aria-label': `Remove problem filter ${t}`, onclick: () => { draft.types = draft.types.filter((x) => x !== t); changed(); } }, `${t} ×`))));
    $('desc-chips').classList.toggle('exclude', draft.descEx);
    $('desc-chips').setAttribute('aria-label', draft.descEx ? 'Excluded descriptions' : 'Selected descriptions');
    $('desc-chips').replaceChildren(...draft.descs.map((d) => el('li', {},
      el('button', { type: 'button', 'aria-label': `Remove description filter ${d}`, onclick: () => { draft.descs = draft.descs.filter((x) => x !== d); changed(); } },
        `${draft.descEx ? 'Not: ' : ''}${d} ×`))));
    $('addr-filter').hidden = lockAddress || !draft.addr;
    $('addr-value').textContent = draft.addr;
  }

  /** Put the form controls back in line with `draft` (after a reset or a shortcut button). */
  function syncControls() {
    $('f-start').value = draft.start;
    $('f-end').value = draft.end;
    // Before the lists are filled (or after a failed first load) a menu may not have the
    // applied value yet: add it, so the menu shows what is applied, never "All agencies".
    for (const [id, v] of [['f-agency', draft.agency], ['f-status', draft.status]]) {
      if (v && ![...$(id).options].some((o) => o.value === v)) $(id).append(el('option', { value: v, text: v }));
    }
    $('f-agency').value = draft.agency;
    $('f-status').value = draft.status;
    $('f-desc-ex').checked = draft.descEx;
  }

  function renderPending() {
    const s = pendingSummary(draft, applied, defaults());
    $('apply').classList.toggle('is-pending', s.pending);
    if ($('pending').textContent !== s.msg) $('pending').textContent = s.msg;
    for (const [section, text] of Object.entries(s.counts)) {
      const node = document.querySelector(`[data-count-for="${section}"]`);
      if (node) node.textContent = text;
    }
  }

  /** A control changed the draft: redraw the form, never the page. */
  function changed() {
    renderChips();
    renderPending();
    updateDescriptions().catch((err) => console.error(err));
  }

  /** The Description list offers only descriptions of the selected problems (all if none). */
  async function updateDescriptions() {
    const key = draft.types.join('|');
    if (!listsReady || key === descKey) return;
    descKey = key;
    descs = await lists.descriptions(draft.types);
    $('desc-options').replaceChildren(...descs.map((d) => el('option', { value: d })));
  }

  /** Text that matches no choice stays in the box, with a short status saying so. Returns false then. */
  function noMatch(box, kind, text) {
    setStatus(`No ${kind} named “${String(text).trim()}”. Choose one of the suggestions as you type, or clear the box.`);
    $(box).focus();
    return false;
  }

  function addDesc(d) {
    const match = findChoice(descs, d);
    if (match === undefined) return noMatch('f-desc', 'description', d);
    if (!draft.descs.includes(match)) { draft.descs = [...draft.descs, match]; changed(); }
    $('f-desc').value = '';
    return true;
  }

  function addType(t) {
    const match = findChoice(problems, t);
    if (match === undefined) return noMatch('f-type', 'problem', t);
    if (!draft.types.includes(match)) { draft.types = [...draft.types, match]; changed(); }
    $('f-type').value = '';
    return true;
  }

  /** Apply: copy the form's filters to the page, after the checks. */
  function apply() {
    // Text typed but not yet added as a chip is added first, if it matches a choice.
    // Text that matches nothing stops the Apply and says so, instead of vanishing.
    const typed = Boolean($('f-type').value.trim() || $('f-desc').value.trim());
    if ($('f-type').value.trim() && !addType($('f-type').value)) return;
    if ($('f-desc').value.trim() && !addDesc($('f-desc').value)) return;
    const check = applyCheck({ draft, applied, typed, lastFailed: lastFailed() });
    if (check === 'date-order') { setStatus(DATE_ORDER_MSG); $('f-start').focus(); return; }
    if (check === 'no-change') { setStatus(matchText()); return; }
    applied = copyFilters(draft);
    onApply(copyFilters(applied));
  }

  /** Reset is a deliberate "start over", so it applies at once. */
  function reset() {
    applied = copyFilters(defaults());
    draft = copyFilters(applied);
    $('f-type').value = '';
    $('f-desc').value = '';
    onApply(copyFilters(applied));
  }

  /**
   * Filter groups open and close with native <details>/<summary>, which keyboards and
   * screen readers already handle. On a phone only groups with something set start open.
   * On a wider screen Dates and Problem start open, and Agency and status opens if set.
   * `compact` (the full-page map, where the map needs the room) uses the phone rule on
   * every screen.
   */
  function openGroups({ compact = false } = {}) {
    const phone = compact || window.matchMedia('(max-width: 640px)').matches;
    const d0 = defaults();
    for (const d of document.querySelectorAll('#filters details.filter-group')) {
      const set = sectionCount(applied, d0, d.dataset.section) > 0;
      d.open = set || (!phone && d.dataset.section !== 'agency');
    }
    renderPending();
  }

  return {
    /** The applied filters (a copy). */
    applied: () => copyFilters(applied),
    /** Replace the applied filters and the form (a link, or the page dropped an unknown status). */
    set(s) {
      applied = copyFilters(s);
      draft = copyFilters(s);
      this.render();
    },
    /** Redraw the form from its state. */
    render() {
      syncControls();
      renderChips();
      renderPending();
      updateDescriptions().catch((err) => console.error(err));
    },
    /**
     * A shortcut button in the page (an agency, a description, an address) applies at
     * once. The same change goes into the form; other edits waiting there stay unapplied.
     */
    applyNow(fn) {
      ({ applied, draft } = patchBoth(applied, draft, fn));
      onApply(copyFilters(applied));
    },
    /** Fill the problem, agency and status lists (again after the page's rows changed). */
    async fillLists() {
      problems = await lists.problems();
      $('type-options').replaceChildren(...problems.map((t) => el('option', { value: t })));
      // Keep the fixed first options ("All agencies", "Any status", "Not yet closed"); replace the rest.
      $('f-agency').replaceChildren($('f-agency').options[0], ...(await lists.agencies())
        .map((r) => el('option', { value: r.agency, text: `${r.agency}${r.label ? ` (${r.label})` : ''}` })));
      const fixedStatus = [...$('f-status').options].filter((o) => o.value === '' || o.value === NOT_CLOSED);
      $('f-status').replaceChildren(...fixedStatus, ...(await lists.statuses()).map((v) => el('option', { value: v, text: v })));
      descKey = null;
      listsReady = true;
      await updateDescriptions();
      syncControls();
    },
    /** The status values the status list offers, including '' and "not yet closed". */
    statusChoices: () => [...$('f-status').options].map((o) => o.value),
    openGroups,
    /** Wire up the controls. Changing a control changes only the form (#142); Apply, or
     *  Enter in a text or date box, runs the page's queries. */
    bind(min, max) {
      for (const id of ['f-start', 'f-end']) { $(id).min = min; $(id).max = max; }
      $('f-start').addEventListener('change', (e) => { if (e.target.value) { draft.start = e.target.value; changed(); } });
      $('f-end').addEventListener('change', (e) => { if (e.target.value) { draft.end = e.target.value; changed(); } });
      $('f-agency').addEventListener('change', (e) => { draft.agency = e.target.value; changed(); });
      $('f-status').addEventListener('change', (e) => { draft.status = e.target.value; changed(); });
      // Enter with text in the box adds it as a chip; Enter in an empty box applies the filters.
      $('f-type').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); addType(e.target.value); } });
      $('f-type').addEventListener('change', (e) => { if (problems.includes(e.target.value)) addType(e.target.value); });
      $('f-desc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); addDesc(e.target.value); } });
      $('f-desc').addEventListener('change', (e) => { if (descs.includes(e.target.value)) addDesc(e.target.value); });
      $('f-desc-ex').addEventListener('change', (e) => { draft.descEx = e.target.checked; changed(); });
      $('addr-clear').addEventListener('click', () => { draft.addr = ''; changed(); });
      $('filters').addEventListener('submit', (e) => { e.preventDefault(); apply(); });
      $('reset').addEventListener('click', reset);
    },
  };
}
