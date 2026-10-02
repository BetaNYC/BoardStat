import { getBoroughConfig } from "./boroughs.js";

export const DATASETS = Object.freeze({
  current: Object.freeze({ id: "erm2-nwe9", label: "2020–present", start: "2020-01-01", end: null }),
  historical: Object.freeze({ id: "76ig-c548", label: "2010–2019", start: "2010-01-01", end: "2019-12-31" }),
});

export const MAP_POINT_LIMIT = 250;
export const RECENT_REQUEST_LIMIT = 100;
export const FILTER_OPTION_LIMIT = 5000;
export const RANKING_CANDIDATE_LIMIT = 1000;
export const HOTSPOT_LIMIT = 100;
export const REQUEST_TIMEOUT_MS = 45_000;
export const CACHE_TTL_MS = 5 * 60_000;

const API_ROOT = "https://data.cityofnewyork.us/resource";
const EARLIEST_DATE = DATASETS.historical.start;
const MAX_CACHE_ENTRIES = 100;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const responseCache = new Map();
const inFlightRequests = new Map();

const DIMENSIONS = Object.freeze({
  boards: "community_board",
  complaints: "complaint_type",
  descriptors: "descriptor",
  agencies: "agency",
  statuses: "status",
  addresses: "incident_address",
});

export class SocrataError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SocrataError";
    this.status = status;
  }
}

function escapeSoqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function isRealDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function addUtcDays(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function daysInRange(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

function timelinePeriods(filters, granularity) {
  const date = new Date(`${filters.startDate}T00:00:00Z`);
  if (granularity === "month") date.setUTCDate(1);
  const periods = [];
  while (date.toISOString().slice(0, 10) <= filters.endDate) {
    if (!filters.years?.length || filters.years.includes(date.getUTCFullYear())) {
      periods.push(date.toISOString().slice(0, -1));
    }
    if (granularity === "day") date.setUTCDate(date.getUTCDate() + 1);
    else date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return periods;
}

function validateStringValues(values, name, maximum = 25) {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new TypeError(`Choose no more than ${maximum} ${name}.`);
  }
  values.forEach((value) => {
    if (typeof value !== "string" || value.length > 200 || CONTROL_CHARACTER_PATTERN.test(value)) {
      throw new TypeError(`One or more selected ${name} are invalid.`);
    }
  });
}

export function validateFilters(filters) {
  const route = getBoroughConfig(filters.borough);
  if (!route) throw new TypeError("Choose a supported borough route.");
  if (!Array.isArray(filters.boards) || filters.boards.length === 0) {
    throw new TypeError("Choose at least one Community Board.");
  }
  if (filters.boards.some((board) => !route.boards.includes(board))) {
    throw new TypeError(`Choose only permitted ${route.name} Community Board values.`);
  }

  validateStringValues(filters.complaints || [], "complaint types");
  validateStringValues(filters.descriptors || [], "descriptors");
  validateStringValues(filters.agencies || [], "agencies");
  validateStringValues(filters.statuses || [], "statuses");
  validateStringValues(filters.addresses || [], "addresses", 10);

  const currentYear = new Date().getFullYear();
  const years = filters.years || [];
  if (!Array.isArray(years) || years.length > currentYear - 2009) {
    throw new TypeError("Choose valid years.");
  }
  if (years.some((year) => !Number.isInteger(year) || year < 2010 || year > currentYear)) {
    throw new TypeError("Choose years from 2010 onward.");
  }

  if (!isRealDate(filters.startDate) || !isRealDate(filters.endDate)) {
    throw new TypeError("Choose valid start and end dates.");
  }
  if (filters.startDate < EARLIEST_DATE) {
    throw new TypeError("BoardStat data begins on January 1, 2010.");
  }
  if (filters.startDate > filters.endDate) {
    throw new TypeError("Start date must be on or before end date.");
  }
  const today = new Date();
  const latestDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (filters.endDate > latestDate) {
    throw new TypeError("End date must be today or earlier.");
  }
}

function buildStringInClause(field, values) {
  const literals = values.map((value) => `'${escapeSoqlLiteral(value)}'`).join(", ");
  return `${field} IN (${literals})`;
}

function getDatasetSlices(filters) {
  validateFilters(filters);
  const slices = [];
  [DATASETS.historical, DATASETS.current].forEach((dataset) => {
    const startDate = filters.startDate > dataset.start ? filters.startDate : dataset.start;
    const datasetEnd = dataset.end || filters.endDate;
    const endDate = filters.endDate < datasetEnd ? filters.endDate : datasetEnd;
    if (startDate > endDate) return;
    if (filters.years.length) {
      const hasSelectedYear = filters.years.some((year) => (
        year >= Number(startDate.slice(0, 4)) && year <= Number(endDate.slice(0, 4))
      ));
      if (!hasSelectedYear) return;
    }
    slices.push({ dataset, startDate, endDate });
  });
  return slices;
}

function buildWhere(filters, slice, extraClauses = [], { omit = [] } = {}) {
  const route = getBoroughConfig(filters.borough);
  const omitted = new Set(omit);
  const clauses = [
    `borough = '${escapeSoqlLiteral(route.datasetValue)}'`,
    buildStringInClause(DIMENSIONS.boards, filters.boards),
    `created_date >= '${slice.startDate}T00:00:00.000'`,
    `created_date < '${addUtcDays(slice.endDate, 1)}T00:00:00.000'`,
  ];

  Object.entries(DIMENSIONS).forEach(([filterName, field]) => {
    if (filterName === "boards" || omitted.has(filterName)) return;
    const values = filters[filterName] || [];
    if (values.length) clauses.push(buildStringInClause(field, values));
  });
  if (!omitted.has("years") && filters.years.length) {
    clauses.push(`date_extract_y(created_date) IN (${filters.years.join(", ")})`);
  }
  return [...clauses, ...extraClauses].join(" AND ");
}

function buildUrl(parameters, datasetId) {
  const search = new URLSearchParams();
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(`$${key}`, String(value));
  });
  return `${API_ROOT}/${datasetId}.json?${search.toString()}`;
}

async function fetchRows(url, signal) {
  let response;
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new SocrataError("NYC Open Data could not be reached. Check your connection and try again.");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body.message ? ` ${body.message}` : "";
    } catch {
      // The HTTP status remains useful when Socrata does not return JSON.
    }
    throw new SocrataError(`NYC Open Data returned an error (${response.status}).${detail}`, response.status);
  }

  return response.json();
}

function cacheRows(url, rows) {
  responseCache.set(url, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
  if (responseCache.size > MAX_CACHE_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function getInFlightRequest(url) {
  const existing = inFlightRequests.get(url);
  // An immediate refresh can arrive before an aborted fetch has settled.
  if (existing && !existing.controller.signal.aborted) return existing;
  const controller = new AbortController();
  const entry = { controller, subscribers: 0, promise: null, timedOut: false };
  const timeoutId = setTimeout(() => {
    entry.timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  entry.promise = fetchRows(url, controller.signal)
    .then((rows) => {
      controller.signal.throwIfAborted();
      cacheRows(url, rows);
      return rows;
    })
    .catch((error) => {
      if (entry.timedOut) {
        throw new SocrataError("NYC Open Data took too long to respond. Try again or narrow the filters.");
      }
      throw error;
    })
    .finally(() => {
      clearTimeout(timeoutId);
      if (inFlightRequests.get(url) === entry) inFlightRequests.delete(url);
    });
  inFlightRequests.set(url, entry);
  return entry;
}

function subscribeToRequest(entry, signal) {
  entry.subscribers += 1;
  return new Promise((resolve, reject) => {
    let active = true;
    const cleanup = () => {
      if (!active) return false;
      active = false;
      signal?.removeEventListener("abort", handleAbort);
      entry.subscribers -= 1;
      return true;
    };
    const handleAbort = () => {
      if (!cleanup()) return;
      if (entry.subscribers === 0) entry.controller.abort();
      reject(signal.reason || new DOMException("The request was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    entry.promise.then(
      (rows) => {
        if (cleanup()) resolve(rows);
      },
      (error) => {
        if (cleanup()) reject(error);
      },
    );
  });
}

async function query(parameters, { signal, datasetId = DATASETS.current.id } = {}) {
  const url = buildUrl(parameters, datasetId);
  if (signal?.aborted) throw signal.reason || new DOMException("The request was aborted.", "AbortError");
  if (responseCache.has(url)) {
    const cached = responseCache.get(url);
    responseCache.delete(url);
    if (cached.expiresAt > Date.now()) {
      responseCache.set(url, cached);
      return cached.rows;
    }
  }
  return subscribeToRequest(getInFlightRequest(url), signal);
}

async function querySlices(filters, parameterFactory, options = {}) {
  const slices = getDatasetSlices(filters);
  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await Promise.all(slices.map(async (slice) => ({
      slice,
      rows: await query(parameterFactory(slice), { ...options, signal: controller.signal, datasetId: slice.dataset.id }),
    })));
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function mergeCounts(resultSets, getKey, makeRow) {
  const totals = new Map();
  resultSets.flatMap((result) => result.rows).forEach((row) => {
    const key = getKey(row);
    totals.set(key, (totals.get(key) || 0) + (Number(row.count) || 0));
  });
  return [...totals.entries()].map(([key, count]) => makeRow(key, count));
}

function mergeDimensionCounts(resultSets, field) {
  return mergeCounts(resultSets, (row) => row[field] || "Unknown", (label, count) => ({ label, count }))
    .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label));
}

function mergeTupleCounts(resultSets, fields, makeRow) {
  return mergeCounts(
    resultSets,
    (row) => fields.map((field) => row[field] || "Unknown").join("\u0000"),
    (key, count) => makeRow(key.split("\u0000"), count),
  ).sort((first, second) => second.count - first.count);
}

async function getDimensionBreakdown(filters, filterName, options, omit = []) {
  const field = DIMENSIONS[filterName];
  const results = await querySlices(filters, (slice) => ({
    select: `${field}, count(*) AS count`,
    where: buildWhere(filters, slice, [`${field} IS NOT NULL`], { omit }),
    group: field,
    order: "count DESC",
    limit: FILTER_OPTION_LIMIT,
  }), options);
  return mergeDimensionCounts(results, field);
}

export async function getTotalRequests(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "count(*) AS count",
    where: buildWhere(filters, slice),
  }), options);
  return results.reduce((total, result) => total + (Number(result.rows[0]?.count) || 0), 0);
}

export function getTopComplaintTypes(filters, options) {
  return getDimensionBreakdown(filters, "complaints", options);
}

export function getDescriptorBreakdown(filters, options) {
  return getDimensionBreakdown(filters, "descriptors", options);
}

export function getAgencyBreakdown(filters, options) {
  return getDimensionBreakdown(filters, "agencies", options);
}

export function getStatusBreakdown(filters, options) {
  return getDimensionBreakdown(filters, "statuses", options);
}

export function getBoardBreakdown(filters, options) {
  return getDimensionBreakdown(filters, "boards", options);
}

export async function getComplaintDescriptorBreakdown(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "complaint_type, descriptor, count(*) AS count",
    where: buildWhere(filters, slice, ["complaint_type IS NOT NULL", "descriptor IS NOT NULL"]),
    group: "complaint_type, descriptor",
    order: "count DESC",
    limit: FILTER_OPTION_LIMIT,
  }), options);
  return mergeTupleCounts(
    results,
    ["complaint_type", "descriptor"],
    ([complaintType, descriptor], count) => ({ complaintType, descriptor, count }),
  ).slice(0, 30);
}

export async function getAddressBreakdown(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "incident_address, count(*) AS count",
    where: buildWhere(filters, slice, ["incident_address IS NOT NULL"]),
    group: "incident_address",
    order: "count DESC",
    limit: RANKING_CANDIDATE_LIMIT,
  }), options);
  return {
    rows: mergeDimensionCounts(results, "incident_address").slice(0, 30),
    isCandidateRanking: results.length > 1,
  };
}

export async function getTimeline(filters, options) {
  const granularity = daysInRange(filters.startDate, filters.endDate) <= 90 ? "day" : "month";
  const bucket = granularity === "day" ? "date_trunc_ymd(created_date)" : "date_trunc_ym(created_date)";
  const results = await querySlices(filters, (slice) => ({
    select: `${bucket} AS period, count(*) AS count`,
    where: buildWhere(filters, slice),
    group: "period",
    order: "period ASC",
  }), options);
  const rows = mergeCounts(results, (row) => row.period, (period, count) => ({ period, count }));
  const counts = new Map(rows.map((row) => [row.period.slice(0, 10), row.count]));
  return { granularity, rows: rows.length ? timelinePeriods(filters, granularity).map((period) => ({
    period, count: counts.get(period.slice(0, 10)) || 0,
  })) : [] };
}

export async function getComplaintTimeline(filters, complaintTypes, options) {
  const comparisonFilters = { ...filters, complaints: complaintTypes };
  validateFilters(comparisonFilters);
  const granularity = daysInRange(filters.startDate, filters.endDate) <= 90 ? "day" : "month";
  const bucket = granularity === "day" ? "date_trunc_ymd(created_date)" : "date_trunc_ym(created_date)";
  const results = await querySlices(comparisonFilters, (slice) => ({
    select: `${bucket} AS period, complaint_type, count(*) AS count`,
    where: buildWhere(comparisonFilters, slice, ["complaint_type IS NOT NULL"]),
    group: "period, complaint_type",
    order: "period ASC, complaint_type ASC",
    // Socrata otherwise truncates grouped results at 1,000 rows.
    limit: timelinePeriods(slice, granularity).length * Math.max(complaintTypes.length, 1),
  }), options);
  const rows = mergeCounts(
    results,
    (row) => `${row.period}\u0000${row.complaint_type}`,
    (key, count) => {
      const [period, complaintType] = key.split("\u0000");
      return { period, complaintType, count };
    },
  ).sort((first, second) => first.period.localeCompare(second.period) || first.complaintType.localeCompare(second.complaintType));
  return { granularity, complaintTypes, rows, periods: timelinePeriods(filters, granularity) };
}

export async function getDescriptorTimeline(filters, options) {
  if (!filters.complaints.length) return { granularity: "month", descriptors: [], rows: [] };
  const granularity = daysInRange(filters.startDate, filters.endDate) <= 90 ? "day" : "month";
  const bucket = granularity === "day" ? "date_trunc_ymd(created_date)" : "date_trunc_ym(created_date)";
  const results = await querySlices(filters, (slice) => ({
    select: `${bucket} AS period, descriptor, count(*) AS count`,
    where: buildWhere(filters, slice, ["descriptor IS NOT NULL"]),
    group: "period, descriptor",
    order: "period ASC, descriptor ASC",
    limit: 50000,
  }), options);
  const rows = mergeCounts(
    results,
    (row) => `${row.period}\u0000${row.descriptor}`,
    (key, count) => {
      const [period, descriptor] = key.split("\u0000");
      return { period, descriptor, count };
    },
  ).sort((first, second) => first.period.localeCompare(second.period) || first.descriptor.localeCompare(second.descriptor));
  const totals = new Map();
  rows.forEach((row) => totals.set(row.descriptor, (totals.get(row.descriptor) || 0) + row.count));
  const descriptors = [...totals.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .slice(0, 8)
    .map(([descriptor]) => descriptor);
  return { granularity, descriptors, rows: rows.filter((row) => descriptors.includes(row.descriptor)), periods: timelinePeriods(filters, granularity) };
}

export async function getAverageDaysToClose(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "avg(date_diff_d(closed_date, created_date)) AS average_days, count(*) AS closed_count",
    where: buildWhere(filters, slice, ["closed_date IS NOT NULL", "closed_date >= created_date"]),
  }), options);
  let totalDays = 0;
  let totalClosed = 0;
  results.forEach(({ rows }) => {
    const average = Number(rows[0]?.average_days);
    const count = Number(rows[0]?.closed_count) || 0;
    if (Number.isFinite(average) && count) {
      totalDays += average * count;
      totalClosed += count;
    }
  });
  return totalClosed ? totalDays / totalClosed : null;
}

export async function getAnnualBreakdown(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "date_extract_y(created_date) AS year, count(*) AS count",
    where: buildWhere(filters, slice),
    group: "year",
    order: "year ASC",
  }), options);
  return mergeCounts(results, (row) => String(row.year), (year, count) => ({ year: Number(year), count }))
    .sort((first, second) => first.year - second.year);
}

export async function getMonthlyBreakdown(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "date_extract_m(created_date) AS month, count(*) AS count",
    where: buildWhere(filters, slice),
    group: "month",
    order: "month ASC",
  }), options);
  return mergeCounts(results, (row) => String(row.month), (month, count) => ({ month: Number(month), count }))
    .sort((first, second) => first.month - second.month);
}

export async function getMonthlyComplaintBreakdown(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "date_extract_m(created_date) AS month, complaint_type, count(*) AS count",
    where: buildWhere(filters, slice, ["complaint_type IS NOT NULL"]),
    group: "month, complaint_type",
    order: "month ASC, count DESC",
    limit: 50000,
  }), options);
  return mergeCounts(
    results,
    (row) => `${row.month}\u0000${row.complaint_type}`,
    (key, count) => {
      const [month, complaintType] = key.split("\u0000");
      return { month: Number(month), complaintType, count };
    },
  ).sort((first, second) => first.month - second.month || second.count - first.count || first.complaintType.localeCompare(second.complaintType));
}

export async function getAgencyStatusBreakdown(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "agency, status, count(*) AS count",
    where: buildWhere(filters, slice, ["agency IS NOT NULL", "status IS NOT NULL"]),
    group: "agency, status",
    order: "count DESC",
    limit: FILTER_OPTION_LIMIT,
  }), options);
  return mergeTupleCounts(
    results,
    ["agency", "status"],
    ([agency, status], count) => ({ agency, status, count }),
  );
}

function mergeRequests(results) {
  return results.flatMap(({ slice, rows }) => rows.map((row) => ({
    ...row,
    dataset: slice.dataset.id,
    datasetLabel: slice.dataset.label,
  }))).sort((first, second) => String(second.created_date || "").localeCompare(String(first.created_date || "")));
}

export async function getMapPoints(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "latitude,longitude,complaint_type,descriptor,agency,status,community_board,created_date,unique_key,incident_address",
    where: buildWhere(filters, slice, ["latitude IS NOT NULL", "longitude IS NOT NULL"]),
    order: "created_date DESC",
    limit: MAP_POINT_LIMIT,
  }), options);
  return mergeRequests(results);
}

export async function getMapHotspots(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "latitude, longitude, incident_address, count(*) AS count",
    where: buildWhere(filters, slice, ["latitude IS NOT NULL", "longitude IS NOT NULL", "incident_address IS NOT NULL"]),
    group: "latitude, longitude, incident_address",
    order: "count DESC",
    limit: RANKING_CANDIDATE_LIMIT,
  }), options);
  return {
    rows: mergeTupleCounts(
      results,
      ["latitude", "longitude", "incident_address"],
      ([latitude, longitude, address], count) => ({ latitude, longitude, address, count }),
    ).slice(0, HOTSPOT_LIMIT),
    isCandidateRanking: results.length > 1,
  };
}

export async function getHotspotBreakdown(filters, hotspot, options) {
  const latitude = Number(hotspot.latitude);
  const longitude = Number(hotspot.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || typeof hotspot.address !== "string") {
    throw new TypeError("Choose a valid hotspot.");
  }
  const results = await querySlices(filters, (slice) => ({
    select: "complaint_type, descriptor, count(*) AS count",
    where: buildWhere(filters, slice, [
      `latitude = ${latitude}`,
      `longitude = ${longitude}`,
      `incident_address = '${escapeSoqlLiteral(hotspot.address)}'`,
      "complaint_type IS NOT NULL",
    ]),
    group: "complaint_type, descriptor",
    order: "count DESC",
    limit: 100,
  }), options);
  return mergeTupleCounts(
    results,
    ["complaint_type", "descriptor"],
    ([complaintType, descriptor], count) => ({ complaintType, descriptor: descriptor === "Unknown" ? "" : descriptor, count }),
  ).slice(0, 10);
}

export async function getRecentRequests(filters, options) {
  const results = await querySlices(filters, (slice) => ({
    select: "created_date,closed_date,complaint_type,descriptor,agency,incident_address,status,community_board,unique_key",
    where: buildWhere(filters, slice),
    order: "created_date DESC",
    limit: RECENT_REQUEST_LIMIT,
  }), options);
  return mergeRequests(results).slice(0, RECENT_REQUEST_LIMIT);
}

export async function getFilterOptions(filters, options) {
  const names = ["complaints", "descriptors", "agencies", "statuses"];
  const entries = await Promise.all(names.map(async (filterName) => [
    filterName,
    await getDimensionBreakdown(filters, filterName, options, [filterName]),
  ]));
  return Object.fromEntries(entries);
}

export async function searchAddresses(filters, rawTerm, options) {
  const term = String(rawTerm)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .trim()
    .slice(0, 60);
  if (term.length < 2) return [];
  // Source addresses can contain repeated spaces; preserve their exact spelling in results.
  const pattern = term.toUpperCase().split(/\s+/).map(escapeSoqlLiteral).join("%");

  const results = await querySlices(filters, (slice) => ({
    select: "incident_address, count(*) AS count",
    where: buildWhere(
      filters,
      slice,
      ["incident_address IS NOT NULL", `upper(incident_address) LIKE '%${pattern}%'`],
      { omit: ["addresses"] },
    ),
    group: "incident_address",
    order: "count DESC",
    limit: 100,
  }), options);
  return mergeDimensionCounts(results, "incident_address").slice(0, 20);
}

export function getDatasetSummary(filters) {
  const slices = getDatasetSlices(filters);
  return {
    count: slices.length,
    labels: slices.map((slice) => slice.dataset.label),
    ids: slices.map((slice) => slice.dataset.id),
  };
}

export function clearApiCache() {
  responseCache.clear();
}
