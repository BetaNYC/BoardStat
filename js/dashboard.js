import {
  getAgencyBreakdown,
  getAgencyStatusBreakdown,
  getAnnualBreakdown,
  getAddressBreakdown,
  getAverageDaysToClose,
  getBoardBreakdown,
  getComplaintTimeline,
  getComplaintDescriptorBreakdown,
  getDatasetSummary,
  getDescriptorBreakdown,
  getDescriptorTimeline,
  getFilterOptions,
  getHotspotBreakdown,
  getMapHotspots,
  getMapPoints,
  getMonthlyComplaintBreakdown,
  getMonthlyBreakdown,
  getRecentRequests,
  getStatusBreakdown,
  getTimeline,
  getTopComplaintTypes,
  getTotalRequests,
  searchAddresses,
  validateFilters,
} from "./api.js?v=20260910-security-1";
import { BOROUGHS, getBoroughConfig } from "./boroughs.js";
import {
  renderAgencyChart,
  renderAgencyStatusChart,
  renderAnnualChart,
  renderAddressComplaintChart,
  renderAddressTimelineChart,
  renderBoardChart,
  renderComplaintChart,
  renderComplaintComparisonChart,
  renderDescriptorChart,
  renderDescriptorTimelineChart,
  renderMonthlyComplaintChart,
  renderMonthlyChart,
  renderStatusChart,
  renderTimelineChart,
} from "./charts.js?v=20260910-a11y-1";
import { renderMapHotspots, renderMapPoints } from "./map.js?v=20260910-a11y-1";

const configuredRoute = getBoroughConfig(document.body.dataset.borough);
const routeParameter = new URLSearchParams(window.location.search).get("borough");
const ROUTE_FIXED = document.body.dataset.routeFixed === "true";
const ROUTE = (ROUTE_FIXED ? configuredRoute : getBoroughConfig(routeParameter)) || configuredRoute || BOROUGHS.manhattan;
const REFRESH_DELAY = 350;
const OPTION_REFRESH_DELAY = 650;
const ADDRESS_SEARCH_DELAY = 350;
const MAP_MODES = Object.freeze(["requests", "hotspots"]);
const MONTHLY_MODES = Object.freeze(["totals", "complaints"]);
const VIEWS = Object.freeze(["filters", "overview", "address", "map", "agency", "trends", "annual", "monthly"]);
const ARRAY_FILTERS = Object.freeze(["boards", "complaints", "descriptors", "agencies", "statuses", "addresses"]);
const URL_PARAMETERS = Object.freeze({
  boards: "board",
  complaints: "complaint",
  descriptors: "descriptor",
  agencies: "agency",
  statuses: "status",
  addresses: "address",
  years: "year",
});
const OPTION_CONTAINERS = Object.freeze({
  boards: "board-options",
  complaints: "complaint-options",
  descriptors: "descriptor-options",
  agencies: "agency-options",
  statuses: "status-options",
  years: "year-options",
});
const FILTER_LABELS = Object.freeze({
  boards: "Community Boards",
  complaints: "Complaint Types",
  descriptors: "Descriptors",
  agencies: "Agencies",
  statuses: "Statuses",
  addresses: "Addresses",
  years: "Years",
});

const numberFormatter = new Intl.NumberFormat("en-US");
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

const elements = {
  form: document.getElementById("filters"),
  startDate: document.getElementById("start-date"),
  endDate: document.getElementById("end-date"),
  reset: document.getElementById("reset-filters"),
  filterError: document.getElementById("filter-error"),
  filterOptionsStatus: document.getElementById("filter-options-status"),
  filterCount: document.getElementById("filter-count"),
  status: document.getElementById("dashboard-status"),
  retry: document.getElementById("retry-dashboard"),
  activeRange: document.getElementById("active-range"),
  activeFilterList: document.getElementById("active-filter-list"),
  total: document.getElementById("total-requests"),
  averageDays: document.getElementById("average-days"),
  recentBody: document.getElementById("recent-requests-body"),
  addressSearch: document.getElementById("address-search"),
  addressSearchStatus: document.getElementById("address-search-status"),
  addressSuggestions: document.getElementById("address-suggestions"),
  selectedAddresses: document.getElementById("selected-addresses"),
  clearAddresses: document.getElementById("clear-addresses"),
  rankingsDetails: document.getElementById("rankings-details"),
  pairsBody: document.getElementById("complaint-pairs-body"),
  addressRankingBody: document.getElementById("address-ranking-body"),
  addressAnalysis: document.getElementById("address-analysis"),
  addressAnalysisGuidance: document.getElementById("address-analysis-guidance"),
  agencyStatusDetails: document.getElementById("agency-status-details"),
  agencyStatusHead: document.getElementById("agency-status-head"),
  agencyStatusBody: document.getElementById("agency-status-body"),
  monthlyLeadersBody: document.getElementById("monthly-leaders-body"),
  sharedFilterPanel: document.getElementById("shared-filter-panel"),
  boroughRoute: document.getElementById("borough-route"),
  pageTitle: document.getElementById("page-title"),
};

let state;
let lastFilterOptions = { complaints: [], descriptors: [], agencies: [], statuses: [] };
let activeViewController;
let filterOptionsController;
let addressSearchController;
let refreshTimer;
let optionRefreshTimer;
let addressSearchTimer;

function toInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDefaultState() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return {
    borough: ROUTE.slug,
    boards: document.body.dataset.defaultBoards === "all" ? [...ROUTE.boards] : [ROUTE.defaultBoard],
    complaints: [],
    descriptors: [],
    agencies: [],
    statuses: [],
    addresses: [],
    years: [],
    startDate: toInputDate(start),
    endDate: toInputDate(end),
    view: "overview",
    mapMode: "requests",
    monthlyMode: "totals",
  };
}

function uniqueStrings(values, maximum = 25) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length <= 200))].slice(0, maximum);
}

function parseUrlState() {
  const defaults = getDefaultState();
  const parameters = new URLSearchParams(window.location.search);
  const boards = uniqueStrings(parameters.getAll("board")).filter((board) => ROUTE.boards.includes(board));
  const years = parameters
    .getAll("year")
    .map(Number)
    .filter((year) => Number.isInteger(year) && year >= 2010 && year <= new Date().getFullYear());

  const nextState = {
    ...defaults,
    boards: parameters.has("board") && boards.length ? boards : defaults.boards,
    complaints: uniqueStrings(parameters.getAll("complaint")),
    descriptors: uniqueStrings(parameters.getAll("descriptor")),
    agencies: uniqueStrings(parameters.getAll("agency")),
    statuses: uniqueStrings(parameters.getAll("status")),
    addresses: uniqueStrings(parameters.getAll("address"), 10),
    years: [...new Set(years)],
    startDate: parameters.get("start") || defaults.startDate,
    endDate: parameters.get("end") || defaults.endDate,
    view: VIEWS.includes(parameters.get("view")) ? parameters.get("view") : defaults.view,
    mapMode: MAP_MODES.includes(parameters.get("map_mode")) ? parameters.get("map_mode") : defaults.mapMode,
    monthlyMode: MONTHLY_MODES.includes(parameters.get("monthly_mode")) ? parameters.get("monthly_mode") : defaults.monthlyMode,
  };

  try {
    validateFilters(nextState);
    return nextState;
  } catch {
    return defaults;
  }
}

function toApiFilters(source = state) {
  return {
    borough: ROUTE.slug,
    boards: [...source.boards],
    complaints: [...source.complaints],
    descriptors: [...source.descriptors],
    agencies: [...source.agencies],
    statuses: [...source.statuses],
    addresses: [...source.addresses],
    years: [...source.years],
    startDate: source.startDate,
    endDate: source.endDate,
  };
}

function writeUrl({ push = false } = {}) {
  const parameters = new URLSearchParams();
  if (!ROUTE_FIXED && ROUTE !== BOROUGHS.manhattan) parameters.set("borough", ROUTE.slug);
  Object.entries(URL_PARAMETERS).forEach(([stateKey, parameter]) => {
    state[stateKey].forEach((value) => parameters.append(parameter, String(value)));
  });
  parameters.set("start", state.startDate);
  parameters.set("end", state.endDate);
  parameters.set("view", state.view);
  if (state.mapMode !== "requests") parameters.set("map_mode", state.mapMode);
  if (state.monthlyMode !== "totals") parameters.set("monthly_mode", state.monthlyMode);
  const url = `${window.location.pathname}?${parameters.toString()}`;
  window.history[push ? "pushState" : "replaceState"]({}, "", url);
}

function getCheckedValues(name) {
  return [...elements.form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function readFormState() {
  Object.keys(OPTION_CONTAINERS).forEach((name) => { state[name] = getCheckedValues(name); });
  state.years = state.years.map(Number);
  state.startDate = elements.startDate.value;
  state.endDate = elements.endDate.value;
}

function optionRowsFor(filterName) {
  if (filterName === "boards") return ROUTE.boards.map((label) => ({ label }));
  if (filterName === "years") {
    const rows = [];
    for (let year = 2010; year <= new Date().getFullYear(); year += 1) rows.push({ label: String(year) });
    return rows;
  }
  return lastFilterOptions[filterName] || [];
}

function renderCheckboxOptions(filterName) {
  const container = document.getElementById(OPTION_CONTAINERS[filterName]);
  const focusedValue = container.contains(document.activeElement) ? document.activeElement.value : null;
  const selected = new Set(state[filterName].map(String));
  const rows = optionRowsFor(filterName);
  const known = new Set(rows.map((row) => String(row.label)));
  const merged = [
    ...[...selected].filter((value) => !known.has(value)).map((label) => ({ label })),
    ...rows,
  ];

  const fragment = document.createDocumentFragment();
  merged.forEach((row) => {
    const value = String(row.label);
    const label = document.createElement("label");
    label.className = "checkbox-option";
    label.dataset.optionText = value.toLocaleLowerCase();
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = filterName;
    input.value = value;
    input.checked = selected.has(value);
    const text = document.createElement("span");
    text.textContent = value;
    label.append(input, text);
    if (Number.isFinite(row.count)) {
      const count = document.createElement("small");
      count.textContent = numberFormatter.format(row.count);
      label.append(count);
    }
    fragment.append(label);
  });

  if (!merged.length) {
    const empty = document.createElement("p");
    empty.className = "option-note";
    empty.textContent = "No options match the current filters.";
    fragment.append(empty);
  }
  container.replaceChildren(fragment);
  applyOptionSearch(container.id);
  if (focusedValue !== null) {
    [...container.querySelectorAll("input")].find((input) => input.value === focusedValue)?.focus({ preventScroll: true });
  }
}

function renderAllFilterOptions() {
  Object.keys(OPTION_CONTAINERS).forEach(renderCheckboxOptions);
}

function applyOptionSearch(containerId) {
  const input = document.querySelector(`[data-option-search="${containerId}"]`);
  if (!input) return;
  const term = input.value.trim().toLocaleLowerCase();
  document.querySelectorAll(`#${containerId} .checkbox-option`).forEach((option) => {
    option.hidden = Boolean(term) && !option.dataset.optionText.includes(term);
  });
}

function syncFormFromState() {
  const today = getDefaultState().endDate;
  elements.startDate.value = state.startDate;
  elements.endDate.value = state.endDate;
  elements.startDate.max = today;
  elements.endDate.max = today;
  renderAllFilterOptions();
  document.querySelectorAll('input[name="map-mode"]').forEach((input) => { input.checked = input.value === state.mapMode; });
  document.querySelectorAll('input[name="monthly-mode"]').forEach((input) => { input.checked = input.value === state.monthlyMode; });
  document.getElementById("monthly-panel")?.toggleAttribute("hidden", state.monthlyMode !== "totals");
  document.getElementById("monthly-complaints-panel")?.toggleAttribute("hidden", state.monthlyMode !== "complaints");
  const mapEyebrow = document.getElementById("map-eyebrow");
  const mapHeading = document.getElementById("map-heading");
  if (mapEyebrow) mapEyebrow.textContent = state.mapMode === "hotspots" ? "Highest-volume matching locations" : "Newest geocoded requests";
  if (mapHeading) mapHeading.textContent = state.mapMode === "hotspots" ? "Request hotspots" : "Request map";
}

function selectionSummaryItems() {
  const items = [
    `Borough route: ${ROUTE.name}`,
    `Date range: ${state.startDate} through ${state.endDate}`,
    `${FILTER_LABELS.boards}: ${state.boards.join(", ") || "None"}`,
  ];
  [...ARRAY_FILTERS.slice(1), "years"].forEach((filterName) => {
    if (state[filterName].length) items.push(`${FILTER_LABELS[filterName]}: ${state[filterName].join(", ")}`);
  });
  return items;
}

function renderStateSummary() {
  const activeSelections = ARRAY_FILTERS.reduce((sum, filterName) => sum + state[filterName].length, 0) + state.years.length;
  elements.filterCount.textContent = `${activeSelections} active selection${activeSelections === 1 ? "" : "s"}`;
  const formatDate = (value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? "Choose a date" : dateFormatter.format(date);
  };
  const start = formatDate(state.startDate);
  const end = formatDate(state.endDate);
  const boardSummary = state.boards.length <= 3 ? state.boards.join(", ") : `${state.boards.length} boards`;
  let datasetText = "dataset unavailable until filters are valid";
  try {
    const datasets = getDatasetSummary(toApiFilters());
    datasetText = datasets.ids.length ? `datasets ${datasets.ids.join(" + ")}` : "no applicable dataset";
  } catch {
    // The validation message provides the actionable detail.
  }
  elements.activeRange.textContent = `${ROUTE.name} · ${boardSummary} · ${start}–${end} (inclusive) · ${datasetText}`;

  const fragment = document.createDocumentFragment();
  selectionSummaryItems().forEach((item) => {
    const listItem = document.createElement("li");
    listItem.textContent = item;
    fragment.append(listItem);
  });
  elements.activeFilterList.replaceChildren(fragment);
}

function renderSelectedAddresses() {
  if (!state.addresses.length) {
    const empty = document.createElement("p");
    empty.className = "option-note";
    empty.textContent = "No addresses selected.";
    elements.selectedAddresses.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.addresses.forEach((address) => {
    const chip = document.createElement("span");
    chip.className = "filter-chip";
    const text = document.createElement("span");
    text.textContent = address;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.removeAddress = address;
    button.setAttribute("aria-label", `Remove address ${address}`);
    button.textContent = "×";
    chip.append(text, button);
    fragment.append(chip);
  });
  elements.selectedAddresses.replaceChildren(fragment);
}

function getValidationMessage() {
  try {
    validateFilters(toApiFilters());
    return "";
  } catch (error) {
    return error.message;
  }
}

function showValidation(message) {
  elements.filterError.textContent = message;
  elements.filterError.hidden = !message;
}

function setPanelLoading(panelId) {
  const panel = document.getElementById(panelId);
  panel.classList.remove("is-error");
  panel.setAttribute("aria-busy", "true");
  const hadContent = panel.dataset.hasContent === "true";
  if (hadContent) panel.dataset.stale = "true";
  panel.querySelector(".panel-state").textContent = hadContent
    ? "Loading live data… Previous result remains visible."
    : "Loading live data…";
}

function setPanelReady(panelId, message = "") {
  const panel = document.getElementById(panelId);
  panel.classList.remove("is-error");
  delete panel.dataset.stale;
  panel.setAttribute("aria-busy", "false");
  panel.querySelector(".panel-state").textContent = message;
}

function setPanelError(panelId, error) {
  const panel = document.getElementById(panelId);
  panel.classList.add("is-error");
  panel.setAttribute("aria-busy", "false");
  const hadContent = panel.dataset.hasContent === "true";
  if (hadContent) panel.dataset.stale = "true";
  else delete panel.dataset.stale;
  panel.querySelector(".panel-state").textContent = hadContent
    ? `Could not refresh this panel. Showing the last successful result. ${error.message}`
    : `Could not load this panel. ${error.message}`;
}

function isEmptyResult(data) {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (Array.isArray(data.rows)) return data.rows.length === 0;
  return false;
}

async function loadPanel(panelId, task, render, emptyMessage = "") {
  const controller = activeViewController;
  setPanelLoading(panelId);
  try {
    const data = await task();
    if (controller.signal.aborted || activeViewController !== controller) return "aborted";
    render(data);
    document.getElementById(panelId).dataset.hasContent = "true";
    setPanelReady(panelId, isEmptyResult(data) ? emptyMessage : "");
    return "success";
  } catch (error) {
    if (controller.signal.aborted || activeViewController !== controller || error.name === "AbortError") return "aborted";
    console.error(`BoardStat panel failed: ${panelId}`, error);
    setPanelError(panelId, error);
    return "failed";
  }
}

function valueOrDash(value) {
  return value || "—";
}

function formatSocrataDateTime(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return valueOrDash(value);
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  return dateTimeFormatter.format(date);
}

function createTableRow(values) {
  const row = document.createElement("tr");
  values.forEach((value) => {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  });
  return row;
}

function replaceTableRows(body, rows, columnCount, emptyMessage) {
  if (!rows.length) {
    const row = createTableRow([emptyMessage]);
    row.className = "empty-row";
    row.firstElementChild.colSpan = columnCount;
    rows = [row];
  }
  body.replaceChildren(...rows);
}

function renderRecentRequests(rows) {
  replaceTableRows(elements.recentBody, rows.map((request) => createTableRow([
    formatSocrataDateTime(request.created_date),
    formatSocrataDateTime(request.closed_date),
    valueOrDash(request.community_board),
    valueOrDash(request.complaint_type),
    valueOrDash(request.descriptor),
    valueOrDash(request.agency),
    valueOrDash(request.incident_address),
    valueOrDash(request.status),
    valueOrDash(request.datasetLabel),
  ])), 9, "No service requests match these filters.");
}

function renderComplaintPairs(rows) {
  const tableRows = rows.map((item) => {
    const row = createTableRow([item.complaintType, item.descriptor, numberFormatter.format(item.count)]);
    const actionCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button compact-action";
    button.dataset.useComplaint = item.complaintType;
    button.dataset.useDescriptor = item.descriptor;
    button.textContent = "Use as filters";
    actionCell.append(button);
    row.append(actionCell);
    return row;
  });
  replaceTableRows(elements.pairsBody, tableRows, 4, "No complaint and descriptor pairs match these filters.");
}

function renderAddressRanking(result) {
  const tableRows = result.rows.map((item) => {
    const row = createTableRow([item.label, numberFormatter.format(item.count)]);
    const actionCell = document.createElement("td");
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "text-button compact-action";
    addButton.dataset.addRankedAddress = item.label;
    addButton.textContent = "Add address";
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "text-button compact-action";
    viewButton.dataset.viewRankedAddress = item.label;
    viewButton.textContent = "View address";
    actionCell.append(addButton, viewButton);
    row.append(actionCell);
    return row;
  });
  replaceTableRows(elements.addressRankingBody, tableRows, 3, "No incident addresses match these filters.");
  document.getElementById("address-ranking-note").textContent = result.isCandidateRanking
    ? "Top addresses from a limited set of historical and current results; some addresses may be missing from this ranking."
    : "Top addresses matching these filters.";
}

function renderAgencyStatusTable(rows) {
  const totals = new Map();
  rows.forEach((row) => totals.set(row.agency, (totals.get(row.agency) || 0) + row.count));
  const agencies = [...totals.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .slice(0, 10)
    .map(([agency]) => agency);
  const statuses = [...new Set(rows.map((row) => row.status))].sort();
  const counts = new Map(rows.map((row) => [`${row.agency}\u0000${row.status}`, row.count]));
  const headRow = document.createElement("tr");
  ["Agency", ...statuses, "Total"].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  });
  elements.agencyStatusHead.replaceChildren(headRow);
  const fragment = document.createDocumentFragment();
  agencies.forEach((agency) => {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = agency;
    row.append(heading);
    statuses.forEach((status) => {
      const cell = document.createElement("td");
      cell.textContent = numberFormatter.format(counts.get(`${agency}\u0000${status}`) || 0);
      row.append(cell);
    });
    const total = document.createElement("td");
    total.textContent = numberFormatter.format(totals.get(agency));
    row.append(total);
    fragment.append(row);
  });
  if (!agencies.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = Math.max(statuses.length + 2, 2);
    cell.textContent = "No agency and status combinations match these filters.";
    row.append(cell);
    fragment.append(row);
  }
  elements.agencyStatusBody.replaceChildren(fragment);
  renderAgencyStatusChart(rows);
}

function renderMonthlyComplaintMix(rows) {
  const { leaders } = renderMonthlyComplaintChart(rows, state.complaints);
  elements.monthlyLeadersBody.replaceChildren(...leaders.map((leader) =>
    createTableRow([leader.month, leader.complaintType, numberFormatter.format(leader.count)])));
}

function renderAverageDays(value) {
  elements.averageDays.textContent = value === null ? "—" : `${value.toFixed(1)} days`;
}

function updateAddressAnalysisVisibility(hasAddresses) {
  elements.addressAnalysis.hidden = !hasAddresses;
  elements.addressAnalysisGuidance.hidden = hasAddresses;
}

function viewTasks(filters, options) {
  switch (state.view) {
    case "overview": {
      const tasks = [
        loadPanel("total-panel", () => getTotalRequests(filters, options), (value) => { elements.total.textContent = numberFormatter.format(value); }),
        loadPanel("boards-panel", () => getBoardBreakdown(filters, options), renderBoardChart, "No board totals match these filters."),
        loadPanel("complaints-panel", () => getTopComplaintTypes(filters, options), renderComplaintChart, "No complaint types match these filters."),
        loadPanel("descriptors-panel", () => getDescriptorBreakdown(filters, options), renderDescriptorChart, "No descriptors match these filters."),
      ];
      if (elements.rankingsDetails.open) {
        tasks.push(
          loadPanel("complaint-pairs-panel", () => getComplaintDescriptorBreakdown(filters, options), renderComplaintPairs, "No complaint and descriptor pairs match these filters."),
          loadPanel("address-ranking-panel", () => getAddressBreakdown(filters, options), renderAddressRanking, "No incident addresses match these filters."),
        );
      }
      return tasks;
    }
    case "address": {
      const tasks = [loadPanel("address-results-panel", () => getRecentRequests(filters, options), renderRecentRequests, "No requests match these filters.")];
      updateAddressAnalysisVisibility(Boolean(filters.addresses.length));
      if (filters.addresses.length) {
        tasks.push(
          loadPanel("address-timeline-panel", () => getTimeline(filters, options), renderAddressTimelineChart, "No requests match this period for the selected addresses."),
          loadPanel("address-complaints-panel", () => getTopComplaintTypes(filters, options), renderAddressComplaintChart, "No complaint types match the selected addresses."),
        );
        if (filters.complaints.length) {
          tasks.push(loadPanel("address-descriptors-panel", () => getDescriptorTimeline(filters, options), renderDescriptorTimelineChart, "No descriptor timeline matches these filters."));
        } else {
          renderDescriptorTimelineChart({ descriptors: [], rows: [] });
          setPanelReady("address-descriptors-panel", "Choose a complaint type in Shared filters to load descriptor trends.");
        }
      }
      return tasks;
    }
    case "map":
      if (state.mapMode === "hotspots") {
        return [loadPanel(
          "map-panel",
          () => getMapHotspots(filters, options),
          (result) => {
            const count = renderMapHotspots(result, ROUTE.center, (hotspot) => getHotspotBreakdown(filters, hotspot, options));
            const note = result.isCandidateRanking
              ? `${numberFormatter.format(count)} leading locations from bounded historical and current candidates; not an exhaustive cross-dataset ranking`
              : `${numberFormatter.format(count)} highest-volume matching locations`;
            document.getElementById("map-limit-note").textContent = note;
          },
          "No geocoded hotspots match these filters.",
        )];
      }
      return [loadPanel(
        "map-panel",
        () => getMapPoints(filters, options),
        (points) => {
          const count = renderMapPoints(points, ROUTE.center);
          const datasets = getDatasetSummary(filters);
          const maximum = 250 * datasets.count;
          document.getElementById("map-panel").querySelector(".limit-note").textContent = !datasets.count
            ? "No dataset overlaps the selected dates and years"
            : count
            ? `${numberFormatter.format(count)} of up to ${numberFormatter.format(maximum)} points (${datasets.count} dataset${datasets.count === 1 ? "" : "s"})`
            : `Up to 250 points per applicable dataset`;
        },
        "No geocoded requests match these filters.",
      )];
    case "agency": {
      const tasks = [
        loadPanel("average-panel", () => getAverageDaysToClose(filters, options), renderAverageDays, "No closed requests match these filters."),
        loadPanel("agencies-panel", () => getAgencyBreakdown(filters, options), renderAgencyChart, "No agencies match these filters."),
        loadPanel("statuses-panel", () => getStatusBreakdown(filters, options), renderStatusChart, "No statuses match these filters."),
      ];
      if (elements.agencyStatusDetails.open) {
        tasks.push(loadPanel("agency-status-details", () => getAgencyStatusBreakdown(filters, options), renderAgencyStatusTable, "No agency and status combinations match these filters."));
      }
      return tasks;
    }
    case "trends":
      return [
        loadPanel("timeline-panel", () => getTimeline(filters, options), renderTimelineChart, "No requests match this period."),
        loadPanel(
          "comparison-panel",
          async () => {
            let complaintTypes = filters.complaints.slice(0, 8);
            if (!complaintTypes.length) {
              const leading = await getTopComplaintTypes(filters, options);
              complaintTypes = leading.slice(0, 5).map((row) => row.label);
            }
            if (!complaintTypes.length) return { granularity: "day", complaintTypes: [], rows: [] };
            return getComplaintTimeline(filters, complaintTypes, options);
          },
          renderComplaintComparisonChart,
          "No complaint comparison is available.",
        ),
      ];
    case "annual":
      return [loadPanel("annual-panel", () => getAnnualBreakdown(filters, options), renderAnnualChart, "No annual totals match these filters.")];
    case "monthly":
      return state.monthlyMode === "complaints"
        ? [loadPanel("monthly-complaints-panel", () => getMonthlyComplaintBreakdown(filters, options), renderMonthlyComplaintMix, "No monthly complaint mix matches these filters.")]
        : [loadPanel("monthly-panel", () => getMonthlyBreakdown(filters, options), renderMonthlyChart, "No monthly totals match these filters.")];
    default:
      return [];
  }
}

async function refreshCurrentView() {
  const validationMessage = getValidationMessage();
  if (validationMessage) {
    showValidation(validationMessage);
    elements.status.textContent = "Dashboard was not refreshed.";
    elements.retry.disabled = false;
    return;
  }

  showValidation("");
  activeViewController?.abort();
  const controller = new AbortController();
  activeViewController = controller;
  const filters = toApiFilters();
  const options = { signal: controller.signal };
  elements.retry.disabled = true;

  if (state.view === "filters") {
    renderStateSummary();
    elements.status.textContent = "Shared filters are ready.";
    elements.retry.disabled = false;
    return;
  }

  elements.status.textContent = "Refreshing this view…";
  const results = await Promise.all(viewTasks(filters, options));
  if (activeViewController !== controller || results.every((result) => result === "aborted") || getValidationMessage()) return;
  const failures = results.filter((result) => result === "failed").length;
  elements.status.textContent = failures
    ? `View refreshed with ${failures} panel${failures === 1 ? "" : "s"} unavailable.`
    : "View updated with NYC Open Data.";
  elements.retry.disabled = false;
}

async function refreshFilterOptions() {
  const validationMessage = getValidationMessage();
  if (validationMessage) return;
  filterOptionsController?.abort();
  const controller = new AbortController();
  filterOptionsController = controller;
  elements.filterOptionsStatus.textContent = "Refreshing filter options…";
  try {
    const results = await getFilterOptions(toApiFilters(), { signal: controller.signal });
    if (controller.signal.aborted || filterOptionsController !== controller) return;
    lastFilterOptions = results;
    ["complaints", "descriptors", "agencies", "statuses"].forEach(renderCheckboxOptions);
    elements.filterOptionsStatus.textContent = "Filter options updated.";
  } catch (error) {
    if (controller.signal.aborted || filterOptionsController !== controller || error.name === "AbortError") return;
    elements.filterOptionsStatus.textContent = `Filter options could not be refreshed. ${error.message}`;
  }
}

function scheduleViewRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshCurrentView, REFRESH_DELAY);
}

function scheduleOptionRefresh() {
  if (!elements.sharedFilterPanel.open) return;
  window.clearTimeout(optionRefreshTimer);
  optionRefreshTimer = window.setTimeout(refreshFilterOptions, OPTION_REFRESH_DELAY);
}

function invalidatePendingWork() {
  window.clearTimeout(refreshTimer);
  window.clearTimeout(optionRefreshTimer);
  window.clearTimeout(addressSearchTimer);
  activeViewController?.abort();
  filterOptionsController?.abort();
  addressSearchController?.abort();
  elements.addressSuggestions.replaceChildren();
  elements.addressSearchStatus.textContent = "";
  document.querySelectorAll('[data-has-content="true"], [aria-busy="true"]').forEach((panel) => {
    const message = panel.querySelector(".panel-state");
    if (!message) return;
    panel.setAttribute("aria-busy", "false");
    if (panel.dataset.hasContent === "true") panel.dataset.stale = "true";
    message.textContent = "Selection changed. Refresh this view to load matching results.";
  });
}

function handleFilterStateChange({ push = false } = {}) {
  invalidatePendingWork();
  renderStateSummary();
  renderSelectedAddresses();
  const message = getValidationMessage();
  showValidation(message);
  if (message) {
    elements.filterOptionsStatus.textContent = "Filter options are unchanged until the selection is valid.";
    elements.status.textContent = "Dashboard was not refreshed.";
    elements.retry.disabled = false;
    return;
  }
  writeUrl({ push });
  scheduleViewRefresh();
  scheduleOptionRefresh();
}

function setActiveView(view, { push = false, focusTab = false } = {}) {
  if (!VIEWS.includes(view)) return;
  window.clearTimeout(refreshTimer);
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.hidden = panel.id !== `view-${view}`;
  });
  if (view === "filters") elements.sharedFilterPanel.open = true;
  writeUrl({ push });
  refreshCurrentView();
  if (focusTab) document.querySelector(`[data-view="${view}"]`).focus({ preventScroll: true });
}

function renderAddressSuggestions(rows) {
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.addressSuggestion = row.label;
    button.textContent = `${row.label} (${numberFormatter.format(row.count)})`;
    item.append(button);
    fragment.append(item);
  });
  elements.addressSuggestions.replaceChildren(fragment);
}

async function runAddressSearch() {
  const term = elements.addressSearch.value.trim();
  addressSearchController?.abort();
  if (term.length < 2) {
    elements.addressSuggestions.replaceChildren();
    elements.addressSearchStatus.textContent = term ? "Enter at least two characters." : "";
    return;
  }

  const controller = new AbortController();
  addressSearchController = controller;
  elements.addressSearchStatus.textContent = "Searching addresses…";
  try {
    const rows = await searchAddresses(toApiFilters(), term, { signal: controller.signal });
    if (controller.signal.aborted || addressSearchController !== controller) return;
    renderAddressSuggestions(rows);
    elements.addressSearchStatus.textContent = rows.length
      ? `${rows.length} address suggestion${rows.length === 1 ? "" : "s"} found.`
      : "No matching public incident addresses found.";
  } catch (error) {
    if (controller.signal.aborted || addressSearchController !== controller || error.name === "AbortError") return;
    elements.addressSearchStatus.textContent = `Address search failed. ${error.message}`;
  }
}

function addAddress(address, { push = false } = {}) {
  if (state.addresses.includes(address)) return true;
  if (state.addresses.length >= 10) {
    elements.addressSearchStatus.textContent = "Remove an address before selecting another; the limit is 10.";
    return false;
  }
  state.addresses = [...state.addresses, address];
  elements.addressSearch.value = "";
  elements.addressSuggestions.replaceChildren();
  elements.addressSearchStatus.textContent = `${address} added to the shared filters.`;
  handleFilterStateChange({ push });
  return true;
}

elements.form.addEventListener("change", () => {
  readFormState();
  handleFilterStateChange();
});
elements.form.addEventListener("submit", (event) => event.preventDefault());

document.querySelectorAll("[data-option-search]").forEach((input) => {
  input.addEventListener("input", () => applyOptionSearch(input.dataset.optionSearch));
});

document.addEventListener("click", (event) => {
  const clearButton = event.target.closest("[data-clear-filter]");
  if (clearButton) {
    state[clearButton.dataset.clearFilter] = [];
    syncFormFromState();
    handleFilterStateChange();
    return;
  }

  const suggestion = event.target.closest("[data-address-suggestion]");
  if (suggestion) {
    addAddress(suggestion.dataset.addressSuggestion);
    return;
  }

  const pair = event.target.closest("[data-use-complaint]");
  if (pair) {
    state.complaints = [pair.dataset.useComplaint];
    state.descriptors = [pair.dataset.useDescriptor];
    syncFormFromState();
    handleFilterStateChange({ push: true });
    return;
  }

  const rankedAddress = event.target.closest("[data-add-ranked-address]");
  if (rankedAddress) {
    addAddress(rankedAddress.dataset.addRankedAddress, { push: true });
    return;
  }

  const viewedAddress = event.target.closest("[data-view-ranked-address]");
  if (viewedAddress) {
    if (addAddress(viewedAddress.dataset.viewRankedAddress, { push: true })) setActiveView("address");
    return;
  }

  const removeAddress = event.target.closest("[data-remove-address]");
  if (removeAddress) {
    state.addresses = state.addresses.filter((address) => address !== removeAddress.dataset.removeAddress);
    handleFilterStateChange();
  }
});

elements.reset.addEventListener("click", () => {
  invalidatePendingWork();
  elements.addressSearch.value = "";
  document.querySelectorAll("[data-option-search]").forEach((input) => { input.value = ""; });
  state = getDefaultState();
  elements.rankingsDetails.open = false;
  elements.agencyStatusDetails.open = false;
  lastFilterOptions = { complaints: [], descriptors: [], agencies: [], statuses: [] };
  syncFormFromState();
  renderSelectedAddresses();
  renderStateSummary();
  showValidation("");
  setActiveView(state.view);
  if (elements.sharedFilterPanel.open) refreshFilterOptions();
});

elements.retry.addEventListener("click", () => {
  window.clearTimeout(refreshTimer);
  refreshCurrentView();
});

elements.clearAddresses.addEventListener("click", () => {
  state.addresses = [];
  handleFilterStateChange();
});

elements.addressSearch.addEventListener("input", () => {
  window.clearTimeout(addressSearchTimer);
  addressSearchController?.abort();
  elements.addressSuggestions.replaceChildren();
  addressSearchTimer = window.setTimeout(runAddressSearch, ADDRESS_SEARCH_DELAY);
});

elements.sharedFilterPanel.addEventListener("toggle", () => {
  if (elements.sharedFilterPanel.open) refreshFilterOptions();
});

elements.rankingsDetails.addEventListener("toggle", () => {
  if (elements.rankingsDetails.open && state.view === "overview") refreshCurrentView();
});

elements.agencyStatusDetails.addEventListener("toggle", () => {
  if (elements.agencyStatusDetails.open && state.view === "agency") refreshCurrentView();
});

Object.entries({ "map-mode": "mapMode", "monthly-mode": "monthlyMode" }).forEach(([name, stateKey]) => {
  document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      state[stateKey] = input.value;
      syncFormFromState();
      writeUrl({ push: true });
      refreshCurrentView();
    });
  });
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setActiveView(button.dataset.view, { push: true }));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = VIEWS.indexOf(state.view);
    const targetIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? VIEWS.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + VIEWS.length) % VIEWS.length;
    setActiveView(VIEWS[targetIndex], { push: true, focusTab: true });
  });
});

elements.pageTitle.textContent = `${ROUTE.name} 311 dashboard`;
if (!ROUTE_FIXED) document.title = `BoardStat ${ROUTE.name} Historical Prototype`;
if (elements.boroughRoute) {
  elements.boroughRoute.value = ROUTE.slug;
  elements.boroughRoute.addEventListener("change", () => {
    const nextRoute = getBoroughConfig(elements.boroughRoute.value);
    if (!nextRoute || nextRoute === ROUTE) return;
    const url = new URL(window.location.href);
    url.search = "";
    if (nextRoute !== BOROUGHS.manhattan) url.searchParams.set("borough", nextRoute.slug);
    window.location.assign(url);
  });
}

window.addEventListener("popstate", () => {
  invalidatePendingWork();
  state = parseUrlState();
  syncFormFromState();
  renderSelectedAddresses();
  renderStateSummary();
  setActiveView(state.view);
  if (elements.sharedFilterPanel.open) refreshFilterOptions();
});

state = parseUrlState();
syncFormFromState();
renderSelectedAddresses();
renderRecentRequests([]);
renderStateSummary();
setActiveView(state.view);
if (elements.sharedFilterPanel.open) refreshFilterOptions();
