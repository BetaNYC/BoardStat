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
//
// Agency, Problem and Description are UI SDK comboboxes with several picks shown as
// chips (#187; Agency in #192), and each list follows the one before it: Problem lists
// the chosen agencies' problems, Description the chosen problems' descriptions.
// Exclude is a UI SDK checkbox, and Apply and Reset are UI SDK buttons (#187;
// js/uisdk.js loads them). The form follows their change events (valuechange,
// checkedchange, action) into `draft`, and still applies nothing until Apply.
import { el, fmtDate, fmtInt } from './lib.js';
import { whereSql, DESC_SQL, NOT_CLOSED_SQL, lit } from './filtersql.js';
import { copyFilters, changedFields, patchBoth, sectionCount, SECTIONS, NOT_CLOSED, describeFilters, getListOrder, setListOrder, listOrderFromParams } from './filterstate.js';

export const DATE_ORDER_MSG = 'The From date is after the To date. Change one of them, then press Apply filters.';
/** The status line after a page counts its requests: "1 request matches.", "2 requests match." */
export const matchMsg = (n) => `${fmtInt(n)} ${n === 1 ? 'request matches' : 'requests match'}.`;
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

/**
 * Wait until the UI SDK parts the form uses are defined (js/uisdk.js), so their
 * properties (value, items, checked) are set on the real elements. Resolves false if
 * they have not loaded after `ms` (a dropped connection); the page then says so.
 */
export function formPartsReady(ms = 20000) {
  if (typeof customElements === 'undefined') return Promise.resolve(true);
  const parts = Promise.all(['ui-combobox', 'ui-checkbox', 'ui-button'].map((t) => customElements.whenDefined(t))).then(() => true);
  return Promise.race([parts, new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
}

export const PARTS_FAILED_MSG = 'The Agency, Problem and Description boxes did not load, so those filters, Exclude, Apply and Reset may not work. This can happen if the connection drops. Reload the page to try again.';

/** Show PARTS_FAILED_MSG in the form's own warning line (#parts-failed), which the
 *  status line's counts never overwrite, and which stays shown when the panel closes. */
export function showPartsFailed($ = (id) => document.getElementById(id)) {
  const node = $('parts-failed');
  if (!node) return;
  node.textContent = PARTS_FAILED_MSG;
  node.hidden = false;
}

/**
 * Names for a picker's chips row, chips and remove buttons (QA round 1). UI SDK names a
 * remove button "Remove X", so a problem and a description with the same name (14 real
 * names are both) gave two buttons one name, and it names the chips row like its
 * combobox. Its own names are rewritten on every render, so a template cannot change
 * them; an observer puts these back whenever UI SDK writes its own.
 */
export function chipNames(kind, exclude = false) {
  const plural = { agency: 'agencies', problem: 'problems', description: 'descriptions' }[kind];
  return {
    row: exclude ? `Excluded ${plural}` : `Chosen ${plural}`,
    chip: (v) => `${exclude ? 'Excluded' : 'Chosen'} ${kind}: ${v}`,
    remove: (v) => `Remove ${kind} filter ${v}`,
  };
}

function nameChips(box, names) {
  const row = box.querySelector('ui-combobox-chips');
  if (!row) return () => {};
  const set = (node, value) => { if (node && node.getAttribute('aria-label') !== value) node.setAttribute('aria-label', value); };
  const apply = () => {
    const n = names();
    set(row, n.row);
    if (row.hasAttribute('aria-labelledby')) row.removeAttribute('aria-labelledby');
    for (const chip of row.querySelectorAll('ui-combobox-chip')) {
      const value = chip.getAttribute('value') ?? '';
      set(chip, n.chip(value));
      set(chip.querySelector('ui-combobox-chip-remove > button'), n.remove(value));
    }
  };
  new MutationObserver(apply).observe(row, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'aria-labelledby'] });
  apply();
  return apply;
}

/** Whether two lists hold the same values in the same order. */
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A combobox's choices as UI SDK items: a name is both the value and the label. */
export const asItems = (names) => names.map((n) => ({ value: n, label: n }));

/** Description rows are this tall (css/ui-theme.css), so the list can place them by index. */
export const ROW_PX = 40;

/**
 * Description's virtualized list (#187), the pattern in UI SDK's Combobox docs
 * ("Virtualized"): the combobox gets every item as data, so filtering, the keyboard and
 * an agent know them all, while only the rows near the scroll position are in the page.
 * The text filter here matches UI SDK's default ("contains", ignoring case and accents),
 * so the `highlight` event's index points at the same row.
 */
export function virtualList(box, { row = ROW_PX } = {}) {
  const scroller = box.querySelector('.vlist');
  const list = scroller.querySelector('ui-combobox-list');
  const fold = (t) => String(t).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  let all = [];
  let matches = [];
  const rendered = new Map();
  const filter = (text) => {
    const needle = fold(text.trim());
    matches = needle ? all.filter((item) => fold(item.label).includes(needle)) : all;
  };
  function render() {
    list.style.height = `${matches.length * row}px`;
    const height = scroller.clientHeight || 320;
    const start = Math.max(0, Math.floor(scroller.scrollTop / row) - 4);
    const end = Math.min(matches.length, Math.ceil((scroller.scrollTop + height) / row) + 4);
    const visible = new Map(matches.slice(start, end).map((item, i) => [item.value, start + i]));
    for (const [value, node] of rendered) {
      if (!visible.has(value)) { node.remove(); rendered.delete(value); }
    }
    for (const [value, index] of visible) {
      const node = rendered.get(value) ?? el('ui-combobox-item', { value, label: value },
        el('span', { class: 'vlist-text', text: value }), el('ui-combobox-item-indicator', { 'aria-hidden': 'true' }));
      node.setAttribute('index', String(index));
      node.style.top = `${index * row}px`;
      if (!rendered.has(value)) { list.append(node); rendered.set(value, node); }
    }
  }
  let shownQuery = '';
  /** Filter by the combobox's text as it is now. A querychange can still be cancelled
   *  after this listener runs (bind() keeps unchosen text on click-away), so the list
   *  waits a tick and reads `box.query` instead of trusting the event (QA round 1). */
  function sync() {
    const query = box.query ?? '';
    filter(query);
    if (query !== shownQuery) {
      shownQuery = query;
      // New matches start at the top. Left scrolled past the end of a shorter list, the
      // window would hold no rows, and UI SDK would then draw every match itself.
      scroller.scrollTop = 0;
    }
    render();
  }
  box.addEventListener('querychange', () => setTimeout(sync, 0));
  box.addEventListener('openchange', () => requestAnimationFrame(sync));
  box.addEventListener('highlight', (e) => {
    const { index } = e.detail;
    if (index < 0) return;
    const top = index * row;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + row > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + row - scroller.clientHeight;
    render();
  });
  scroller.addEventListener('scroll', render);
  return {
    /** Replace the choices (names), keeping the combobox's selection. */
    setItems(names) {
      all = asItems(names);
      filter(box.query ?? '');
      for (const node of rendered.values()) node.remove();
      rendered.clear();
      render();
      box.items = all;
    },
  };
}

/** The choice in `list` that `text` names, ignoring case and outer spaces, or undefined. */
export function findChoice(list, text) {
  const t = String(text).trim().toLowerCase();
  return list.find((x) => String(x).toLowerCase() === t);
}

/** The value of the item (UI SDK { value, label }) whose value or label `text` names, or undefined. */
export function findItem(items, text) {
  return items.find((i) => findChoice([i.value, i.label], text) !== undefined)?.value;
}

/** An agency as the Agency box lists it: its code, then its name (#192). */
export const agencyItems = (rows) => rows.map((r) => ({ value: r.agency, label: `${r.agency}${r.label ? ` (${r.label})` : ''}` }));

/** The note under the buttons and the text after each group's heading. */
export function pendingSummary(draft, applied, defaults, fmt = fmtDate) {
  const changed = changedFields(draft, applied);
  const counts = {};
  for (const section of Object.keys(SECTIONS)) {
    const n = sectionCount(draft, defaults, section);
    const edited = changed.some((k) => SECTIONS[section].includes(k) || (section === 'problem' && k === 'descEx'));
    const parts = [];
    if (section === 'dates') {
      parts.push(`${fmt(draft.start)} to ${fmt(draft.end)}`);
      if (draft.status) parts.push(`status: ${draft.status === NOT_CLOSED ? 'not yet closed' : draft.status}`);
    } else if (n) parts.push(`${n} chosen`);
    if (edited) parts.push('not applied yet');
    counts[section] = parts.length ? `(${parts.join(', ')})` : '';
  }
  return { pending: changed.length > 0, msg: changed.length ? PENDING_MSG : '', counts };
}

/**
 * Which rows the lists offer choices from (#149 QA): requests created in the applied
 * dates, plus every request not yet closed. The extra year a borough page loads for its
 * year-earlier line, and any older rows a page still holds, never feed the lists, so
 * the district page and the full-page map offer the same choices for the same dates.
 */
export function listScopeSql(s) {
  const dates = whereSql({ start: s.start, end: s.end, agencies: [], types: [], descs: [], descEx: false, status: '', addr: '' });
  return `((${dates}) OR ${NOT_CLOSED_SQL})`;
}

/**
 * Most requests in the applied dates first, then most in the scope, then by name. The
 * form says so next to the Problem and Agency boxes.
 */
export function listOrderSql(s) {
  const dates = whereSql({ start: s.start, end: s.end, agencies: [], types: [], descs: [], descEx: false, status: '', addr: '' });
  return `count(*) FILTER (WHERE ${dates}) DESC, count(*) DESC, 1`;
}

/**
 * The form's lists from a page's `req` table, for the filters `getState()` returns.
 * "Closed" is always a status choice (keepKnownStatus always keeps it, round 1).
 */
export function tableLists(query, getState) {
  const scope = () => listScopeSql(getState());
  const order = () => listOrderSql(getState());
  const among = (col, list) => (list.length ? `AND ${col} IN (${list.map(lit).join(', ')})` : '');
  // The form's "Sort suggestions" switch (filterstate.js): A to Z, or most requests first as queried.
  const sorted = (list, key = (v) => v) => (getListOrder() === 'az' ? [...list].sort((a, b) => String(key(a)).localeCompare(String(key(b)), 'en', { sensitivity: 'base', numeric: true })) : list);
  return {
    problems: async (agencies = []) => sorted((await query(`
      SELECT complaint_type AS t FROM req WHERE ${scope()} ${among('agency', agencies)}
      GROUP BY 1 ORDER BY ${order()}`)).map((r) => r.t)),
    descriptions: async (types, agencies = []) => sorted((await query(`
      SELECT ${DESC_SQL} AS d FROM req WHERE ${scope()}
      ${among('agency', agencies)} ${among('complaint_type', types)}
      GROUP BY 1 ORDER BY ${order()}`)).map((r) => r.d)),
    agencies: async () => sorted(await query(`SELECT agency, any_value(agency_name) AS label FROM req WHERE ${scope()} GROUP BY 1 ORDER BY ${order()}`), (r) => r.agency),
    statuses: async () => {
      const list = (await query(`SELECT status FROM req WHERE ${scope()} AND status IS NOT NULL GROUP BY 1 ORDER BY ${order()}`)).map((r) => r.status);
      return list.includes('Closed') ? list : [...list, 'Closed'];
    },
  };
}

/**
 * Whether the filter panel starts open (#149): the district, borough, council district and
 * address pages start open on a wide screen, where the form is the main control, and
 * closed at 640 px or less, where it pushes everything down. The full-page map starts
 * closed everywhere, so the map stays in view.
 */
export function panelStartsOpen({ mapPage, phone }) {
  return !mapPage && !phone;
}

/** Whether the panel closes after the form's own Apply or Reset: always on the map, on a phone elsewhere. */
export function panelClosesAfterApply({ mapPage, phone }) {
  return mapPage || phone;
}

/** The text of the toggle button for an open or closed panel. */
export const toggleLabel = (open) => (open ? 'Hide filters' : 'Change filters');

/** The menu values a status filter may hold: '' (any), "not yet closed", and the data's statuses. */
export function statusChoices(known) {
  return ['', NOT_CLOSED, ...known];
}

/**
 * Run the form on this page.
 *   defaults()          the filters a link without filters opens with (Reset's target)
 *   lists.problems(agencies)   problem names for those agencies (all if none), most common first
 *   lists.descriptions(types, agencies)  descriptions for those problems and agencies (all if none)
 *   lists.agencies()    [{ agency, label }]
 *   lists.statuses()    status values
 *   onApply(applied)    the page redraws for these filters
 *   lastFailed()        true if the page's last redraw failed (Apply then always reruns)
 *   matchText()         the status line for an Apply that changes nothing ("N requests match.")
 *   setStatus(msg)      the page's status line
 *   lockAddress         the address page: its address is fixed and not shown as a filter
 */
export function createFilterForm({ defaults, lists, onApply, lastFailed = () => false, matchText = () => '', setStatus, lockAddress = false, onListOrder = () => {}, $ = (id) => document.getElementById(id) }) {
  let applied = copyFilters(defaults());
  let draft = copyFilters(applied);
  let agencies = []; // UI SDK items: { value: code, label: "code (name)" }
  let problems = [];
  let descs = [];
  let problemKey = null;
  let descKey = null;
  let listsReady = false; // the page has rows to list (fillLists has run)
  let knownStatuses = []; // what lists.statuses() returned: the data's statuses, and "Closed"
  let panel = null; // the open/close toggle (setupPanel): { mapPage, scrollTo }
  let formApplied = false; // the last change came from the form's own Apply or Reset
  let descList = null; // Description's virtualized list (virtualList), made on first use
  // The chips' names (chipNames); Description's change with Exclude.
  const nameAgencyChips = nameChips($('f-agency'), () => chipNames('agency'));
  const nameTypeChips = nameChips($('f-type'), () => chipNames('problem'));
  const nameDescChips = nameChips($('f-desc'), () => chipNames('description', draft.descEx));

  /** Open or close the panel. When closed, only its status line stays, under the summary line. */
  function showPanel(open) {
    if (!$('filters-toggle')) return;
    $('filters').classList.toggle('is-collapsed', !open);
    $('filters-toggle').setAttribute('aria-expanded', String(open));
    $('filters-toggle').textContent = toggleLabel(open);
    renderSummary();
  }

  /** The applied filters in one line, above the panel (always on the map; elsewhere only while closed). */
  function renderSummary() {
    const node = $('filters-summary');
    if (!node) return;
    node.textContent = `${describeFilters(applied, fmtDate).join('; ')}.`;
    if (panel && !panel.mapPage) node.hidden = !$('filters').classList.contains('is-collapsed');
  }

  /** The chips are UI SDK's (ui-combobox-chips); this marks Exclude mode and the address. */
  function renderChips() {
    $('f-desc').toggleAttribute('data-exclude', draft.descEx);
    nameAgencyChips();
    nameTypeChips();
    nameDescChips();
    $('addr-filter').hidden = lockAddress || !draft.addr;
    $('addr-value').textContent = draft.addr;
  }

  /** Put the form controls back in line with `draft` (after a reset or a shortcut button). */
  function syncControls() {
    $('f-start').value = draft.start;
    $('f-end').value = draft.end;
    // The status menu may lack the form's value before its list is filled (or after a
    // failed first load): show it as an extra option rather than "Any status". After
    // that, a status the data does not have is never offered (#149 QA).
    const v = draft.status;
    dropExtras('f-status', v);
    if (v && ![...$('f-status').options].some((o) => o.value === v) && !(listsReady && !knownStatuses.includes(v))) {
      $('f-status').append(el('option', { value: v, text: v, 'data-extra': '' }));
    }
    $('f-status').value = v;
    // UI SDK parts: setting a property is an "imperative" change; the listeners in bind()
    // copy it back into the draft, which already holds it. A chosen agency with no
    // requests in the new dates stays a chip (itemToLabel names it).
    if (!sameList($('f-agency').value ?? [], draft.agencies)) $('f-agency').value = [...draft.agencies];
    if (!sameList($('f-type').value ?? [], draft.types)) $('f-type').value = [...draft.types];
    if (!sameList($('f-desc').value ?? [], draft.descs)) $('f-desc').value = [...draft.descs];
    if ($('f-desc-ex').checked !== draft.descEx) $('f-desc-ex').checked = draft.descEx;
  }

  /** Remove extra options (syncControls) other than `keep`. */
  function dropExtras(id, keep) {
    for (const o of [...$(id).querySelectorAll('option[data-extra]')]) if (o.value !== keep) o.remove();
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
    updateLists().catch((err) => console.error(err));
  }

  /** Problem lists only the chosen agencies' problems, and Description only the chosen
   *  problems' (and agencies') descriptions; all of them when none is chosen (#192). */
  async function updateLists() {
    if (!listsReady) return;
    const pKey = draft.agencies.join('|');
    if (pKey !== problemKey) {
      problemKey = pKey;
      const list = await lists.problems(draft.agencies);
      if (pKey !== problemKey) return; // a newer pick asked again; its answer wins
      problems = list;
      $('f-type').items = asItems(problems);
    }
    const key = `${pKey}||${draft.types.join('|')}`;
    if (key === descKey) return;
    descKey = key;
    const list = await lists.descriptions(draft.types, draft.agencies);
    if (key !== descKey) return;
    descs = list;
    // Made on first use: a page may fill the lists before it calls bind().
    descList ??= virtualList($('f-desc'));
    descList.setItems(descs);
  }

  /** Text that matches no choice stays in the box, with a short status saying so. Returns false then. */
  function noMatch(box, kind, text) {
    setStatus(`No ${kind} named “${String(text).trim()}”. Choose one of the suggestions as you type, or clear the box.`);
    $(box).api?.focus();
    return false;
  }

  /** A picker's choices as UI SDK items, its kind, and its key in the filters. */
  const PICKERS = {
    'f-agency': { kind: 'agency', key: 'agencies', items: () => agencies },
    'f-type': { kind: 'problem', key: 'types', items: () => asItems(problems) },
    'f-desc': { kind: 'description', key: 'descs', items: () => asItems(descs) },
  };

  /** Typed text not yet chosen in a picker: added as a chip if it names a choice (its code or its label). */
  function addTyped(id) {
    const { kind, key, items } = PICKERS[id];
    const text = $(id).query ?? '';
    if (!text.trim()) return true;
    const match = findItem(items(), text);
    if (match === undefined) return noMatch(id, kind, text);
    if (!draft[key].includes(match)) { draft[key] = [...draft[key], match]; changed(); }
    $(id).query = '';
    syncControls();
    return true;
  }

  /** Apply: copy the form's filters to the page, after the checks. */
  function apply() {
    // Text typed but not yet chosen is added first, if it names a choice exactly. Text
    // that matches nothing stops the Apply and says so, instead of vanishing.
    const typed = Object.keys(PICKERS).some((id) => ($(id).query ?? '').trim());
    for (const id of Object.keys(PICKERS)) if (!addTyped(id)) return;
    const check = applyCheck({ draft, applied, typed, lastFailed: lastFailed() });
    if (check === 'date-order') { setStatus(DATE_ORDER_MSG); $('f-start').focus(); return; }
    if (check === 'no-change') { setStatus(matchText()); return; }
    applied = copyFilters(draft);
    formApplied = true;
    onApply(copyFilters(applied));
  }

  /** Reset is a deliberate "start over", so it applies at once. */
  function reset() {
    applied = copyFilters(defaults());
    draft = copyFilters(applied);
    $('f-agency').query = '';
    $('f-type').query = '';
    $('f-desc').query = '';
    formApplied = true;
    onApply(copyFilters(applied));
  }

  /**
   * Filter groups open and close with native <details>/<summary>, which keyboards and
   * screen readers already handle. On a phone only groups with something set start open.
   * On a wider screen every group starts open, so UI SDK's agent bridge, which cannot see
   * inside a closed group, sees Agency, Problem and Description (#192).
   * `compact` (the full-page map, where the map needs the room) uses the phone rule on
   * every screen.
   */
  function openGroups({ compact = false } = {}) {
    const phone = compact || window.matchMedia('(max-width: 640px)').matches;
    const d0 = defaults();
    for (const d of document.querySelectorAll('#filters details.filter-group')) {
      const set = sectionCount(applied, d0, d.dataset.section) > 0;
      d.open = set || !phone;
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
      renderSummary();
      updateLists().catch((err) => console.error(err));
    },
    /**
     * A shortcut button in the page (an agency, a description, an address) applies at
     * once. The same change goes into the form; other edits waiting there stay unapplied.
     */
    applyNow(fn) {
      ({ applied, draft } = patchBoth(applied, draft, fn));
      formApplied = false; // a shortcut elsewhere on the page never closes or moves to the panel
      onApply(copyFilters(applied));
    },
    /** Fill the agency, problem, description and status lists (again after the page's rows changed). */
    async fillLists() {
      agencies = agencyItems(await lists.agencies());
      $('f-agency').items = agencies;
      // Keep the fixed first options ("Any status", "Not yet closed"); replace the rest.
      const fixedStatus = [...$('f-status').options].filter((o) => !o.hasAttribute('data-extra') && (o.value === '' || o.value === NOT_CLOSED));
      knownStatuses = await lists.statuses();
      $('f-status').replaceChildren(...fixedStatus, ...knownStatuses.map((v) => el('option', { value: v, text: v })));
      problemKey = null;
      descKey = null;
      listsReady = true;
      await updateLists();
      syncControls();
    },
    /** The status values the data allows (never what the menu happens to show). */
    statusChoices: () => statusChoices(knownStatuses),
    openGroups,
    /**
     * The panel's open/close toggle (#149): a "Hide filters" / "Change filters" button
     * outside the form (#filters-toggle, aria-expanded) and the summary line
     * (#filters-summary). `mapPage` picks the defaults (panelStartsOpen); `scrollTo` is
     * where the page goes back to when the panel closes after an Apply.
     */
    setupPanel({ mapPage = false, scrollTo = null } = {}) {
      panel = { mapPage, scrollTo };
      const phone = window.matchMedia('(max-width: 640px)').matches;
      showPanel(panelStartsOpen({ mapPage, phone }));
      $('filters-toggle').addEventListener('click', () => showPanel($('filters').classList.contains('is-collapsed')));
    },
    /** The page drew the filters it was given. After the form's own Apply or Reset, close
     *  the panel where that is the rule, and keep keyboard focus on the toggle. */
    afterRedraw() {
      if (!panel || !formApplied) return;
      formApplied = false;
      const phone = window.matchMedia('(max-width: 640px)').matches;
      if (!panelClosesAfterApply({ mapPage: panel.mapPage, phone })) return;
      showPanel(false);
      panel.scrollTo?.scrollIntoView({ block: 'start' });
      // The control that had focus is now hidden: keep keyboard and screen-reader users
      // on the button that opens the form again (the status line has just said the count).
      $('filters-toggle').focus({ preventScroll: true });
    },
    /** Wire up the controls. Changing a control changes only the form (#142); Apply, or
     *  Enter in a date box or an empty picker, runs the page's queries. */
    bind(min, max) {
      // "Sort suggestions": reorders the three lists at once, at once (no Apply). Not a
      // filter; the link carries it (sort=count; A to Z, the default, adds nothing).
      const ORDER_HINT = { count: 'Suggestions are listed with the most requests in these dates first.', az: 'Suggestions are listed A to Z.' };
      const setOrder = (v, refill) => {
        setListOrder(v);
        if ($('list-order')) $('list-order').textContent = ORDER_HINT[v];
        if (refill && listsReady) this.fillLists().catch((err) => console.error(err));
      };
      const fromLink = listOrderFromParams(new URLSearchParams(location.search));
      for (const r of document.querySelectorAll('input[name="list-order"]')) {
        r.checked = r.value === fromLink;
        r.addEventListener('change', () => { if (r.checked) { setOrder(r.value, true); onListOrder(); } });
      }
      setOrder(fromLink, fromLink === 'count');
      for (const id of ['f-start', 'f-end']) { $(id).min = min; $(id).max = max; }
      $('f-start').addEventListener('change', (e) => { if (e.target.value) { draft.start = e.target.value; changed(); } });
      $('f-end').addEventListener('change', (e) => { if (e.target.value) { draft.end = e.target.value; changed(); } });
      $('f-status').addEventListener('change', (e) => { draft.status = e.target.value; dropExtras('f-status', draft.status); changed(); });
      // The pickers keep their own chips; their valuechange says what is chosen now.
      // A problem or description name is both an item's value and its label, and an
      // agency's chip shows its listed label, or its code before the lists load, so
      // chips set from a link show at once.
      for (const [id, { key }] of Object.entries(PICKERS)) {
        $(id).itemToLabel = id === 'f-agency' ? (v) => agencies.find((i) => i.value === v)?.label ?? String(v) : (v) => String(v);
        $(id).addEventListener('valuechange', (e) => {
          const next = [...(e.detail.value ?? [])];
          if (!sameList(next, draft[key])) { draft[key] = next; changed(); }
        });
        $(id).addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.defaultPrevented) return;
          const text = ($(id).query ?? '').trim();
          // Enter in an empty, closed picker applies the filters, like Enter in a date box.
          if (!text && !$(id).open) { e.preventDefault(); $('filters').requestSubmit(); return; }
          // Enter after typing a whole name, with nothing highlighted, adds it (as before #187).
          if (text && $(id).api?.getHighlighted() == null && findItem(PICKERS[id].items(), text) !== undefined) {
            e.preventDefault();
            addTyped(id);
          }
        });
        // UI SDK clears typed text that was never chosen when focus leaves. Keep it in the
        // box instead, so Apply adds it if it names a choice, or stops and says it names
        // nothing (#142's rule), rather than dropping it without a word.
        $(id).addEventListener('querychange', (e) => {
          if (e.detail.value === '' && ['focus-out', 'outside-press'].includes(e.detail.reason) && ($(id).query ?? '').trim()) e.preventDefault();
        });
      }
      $('f-desc-ex').addEventListener('checkedchange', (e) => { draft.descEx = e.detail.value === true; changed(); });
      $('addr-clear').addEventListener('click', () => { draft.addr = ''; changed(); });
      $('filters').addEventListener('submit', (e) => { e.preventDefault(); apply(); });
      $('reset').addEventListener('action', reset);
    },
  };
}
