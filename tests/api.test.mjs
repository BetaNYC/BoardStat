import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";

import { BOROUGHS } from "../js/boroughs.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let moduleNumber = 0;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseFilters(overrides = {}) {
  return {
    borough: "manhattan",
    boards: ["07 MANHATTAN"],
    complaints: [],
    descriptors: [],
    agencies: [],
    statuses: [],
    addresses: [],
    years: [],
    startDate: "2020-01-01",
    endDate: "2020-01-02",
    ...overrides,
  };
}

function requestDetails(rawUrl) {
  const url = new URL(rawUrl);
  return {
    dataset: url.pathname.split("/").at(-1).replace(".json", ""),
    select: url.searchParams.get("$select"),
    where: url.searchParams.get("$where"),
    group: url.searchParams.get("$group"),
    order: url.searchParams.get("$order"),
    limit: url.searchParams.get("$limit"),
  };
}

async function loadApi() {
  moduleNumber += 1;
  return import(`../js/api.js?test=${moduleNumber}`);
}

test("future URL dates are rejected before queries or timeline expansion", async () => {
  const api = await loadApi();
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return jsonResponse([]); };
  for (const endDate of ["9999-12-31", "9998-12-31"]) {
    const filters = baseFilters({ endDate });
    assert.throws(() => api.validateFilters(filters), /today or earlier/);
    await assert.rejects(async () => api.getTimeline(filters), /today or earlier/);
    await assert.rejects(async () => api.getComplaintTimeline(filters), /today or earlier/);
  }
  assert.equal(requests, 0);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  assert.doesNotThrow(() => api.validateFilters(baseFilters({ startDate: "2010-01-01", endDate: today })));
});

test("borough configuration contains unique scoped options and no global unspecified value", () => {
  assert.deepEqual(Object.keys(BOROUGHS), ["bronx", "brooklyn", "manhattan", "queens", "statenisland"]);
  Object.values(BOROUGHS).forEach((route) => {
    assert.ok(route.boards.includes(route.defaultBoard));
    assert.equal(new Set(route.boards).size, route.boards.length);
    assert.ok(route.boards.length <= 25);
    assert.ok(!route.boards.includes("0 Unspecified"));
  });
  assert.ok(BOROUGHS.manhattan.boards.includes("08 BRONX"));
  assert.ok(BOROUGHS.bronx.boards.includes("01 QUEENS"));
  assert.ok(BOROUGHS.queens.boards.includes("QENB"));
  assert.ok(BOROUGHS.statenisland.boards.includes("SILC"));
});

test("production borough routes use their fixed shared dashboard configuration", async () => {
  for (const route of Object.values(BOROUGHS)) {
    const html = await readFile(new URL(`../${route.slug}.html`, import.meta.url), "utf8");
    assert.match(html, new RegExp(`<title>BoardStat ${route.name}</title>`));
    assert.match(html, new RegExp(`<body data-borough="${route.slug}" data-default-boards="all" data-route-fixed="true">`));
    assert.match(html, new RegExp(`<h1 id="page-title">${route.name} 311 dashboard</h1>`));
    assert.match(html, new RegExp(`<strong><u>${route.name}</u></strong>`));
    assert.match(html, /type="module" src="\.\/js\/dashboard\.js(?:\?[^"]+)?"/);
    assert.match(html, /id="rankings-details"/);
    assert.match(html, /id="address-analysis"/);
    assert.match(html, /name="map-mode" value="requests" checked/);
    assert.match(html, /name="map-mode" value="hotspots"/);
    assert.match(html, /id="agency-status-details"/);
    assert.match(html, /name="monthly-mode" value="totals" checked/);
    assert.match(html, /name="monthly-mode" value="complaints"/);
    assert.doesNotMatch(html, /app\.powerbi\.com/i);
  }
});

test("boundary ranges split at 2020 and merge only complete totals", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const details = requestDetails(url);
    calls.push(details);
    return jsonResponse([{ count: details.dataset === "76ig-c548" ? "174" : "234" }]);
  };
  const api = await loadApi();
  const filters = baseFilters({ startDate: "2019-12-30", endDate: "2020-01-02" });

  assert.equal(await api.getTotalRequests(filters), 408);
  assert.equal(calls.length, 2);
  const historical = calls.find((call) => call.dataset === "76ig-c548");
  const current = calls.find((call) => call.dataset === "erm2-nwe9");
  assert.match(historical.where, /created_date >= '2019-12-30T00:00:00\.000'/);
  assert.match(historical.where, /created_date < '2020-01-01T00:00:00\.000'/);
  assert.match(current.where, /created_date >= '2020-01-01T00:00:00\.000'/);
  assert.match(current.where, /created_date < '2020-01-03T00:00:00\.000'/);
});

test("year filters avoid querying an inapplicable dataset", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(requestDetails(url));
    return jsonResponse([{ count: "12" }]);
  };
  const api = await loadApi();
  const filters = baseFilters({
    years: [2019],
    startDate: "2019-01-01",
    endDate: "2021-12-31",
  });

  assert.equal(await api.getTotalRequests(filters), 12);
  assert.deepEqual(calls.map((call) => call.dataset), ["76ig-c548"]);
  assert.match(calls[0].where, /date_extract_y\(created_date\) IN \(2019\)/);
});

test("grouped values merge before ranking", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const details = requestDetails(url);
    calls.push(details);
    return jsonResponse(details.dataset === "76ig-c548"
      ? [{ complaint_type: "Noise", count: "7" }, { complaint_type: "Heat", count: "10" }]
      : [{ complaint_type: "Noise", count: "8" }, { complaint_type: "Parking", count: "11" }]);
  };
  const api = await loadApi();
  const rows = await api.getTopComplaintTypes(baseFilters({ startDate: "2019-12-30" }));

  assert.deepEqual(rows, [
    { label: "Noise", count: 15 },
    { label: "Parking", count: 11 },
    { label: "Heat", count: 10 },
  ]);
  assert.ok(calls.every((call) => call.limit === "5000"));
});

test("worksheet rankings merge complaint pairs and label cross-dataset address candidates", async () => {
  globalThis.fetch = async (url) => {
    const { dataset, select } = requestDetails(url);
    if (select.startsWith("complaint_type, descriptor")) {
      return jsonResponse(dataset === "76ig-c548"
        ? [{ complaint_type: "Noise", descriptor: "Loud Music", count: "7" }]
        : [{ complaint_type: "Noise", descriptor: "Loud Music", count: "8" }, { complaint_type: "Heat", descriptor: "Entire Building", count: "9" }]);
    }
    return jsonResponse(dataset === "76ig-c548"
      ? [{ incident_address: "1 MAIN ST", count: "5" }]
      : [{ incident_address: "1 MAIN ST", count: "6" }, { incident_address: "2 MAIN ST", count: "8" }]);
  };
  const api = await loadApi();
  const filters = baseFilters({ startDate: "2019-12-30" });

  assert.deepEqual(await api.getComplaintDescriptorBreakdown(filters), [
    { complaintType: "Noise", descriptor: "Loud Music", count: 15 },
    { complaintType: "Heat", descriptor: "Entire Building", count: 9 },
  ]);
  assert.deepEqual(await api.getAddressBreakdown(filters), {
    rows: [{ label: "1 MAIN ST", count: 11 }, { label: "2 MAIN ST", count: 8 }],
    isCandidateRanking: true,
  });
});

test("descriptor, agency-status, and monthly complaint aggregates retain their dimensions", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const details = requestDetails(url);
    calls.push(details);
    if (details.select.includes("period, descriptor")) {
      return jsonResponse([
        { period: "2020-01-01T00:00:00.000", descriptor: "Loud Music", count: "4" },
        { period: "2020-01-01T00:00:00.000", descriptor: "Banging", count: "2" },
      ]);
    }
    if (details.select.startsWith("agency, status")) {
      return jsonResponse([{ agency: "NYPD", status: "Closed", count: "6" }]);
    }
    return jsonResponse([{ month: "1", complaint_type: "Noise", count: "7" }]);
  };
  const api = await loadApi();
  const filters = baseFilters({ complaints: ["Noise"] });

  assert.deepEqual(await api.getDescriptorTimeline(filters), {
    granularity: "day",
    descriptors: ["Loud Music", "Banging"],
    periods: ["2020-01-01T00:00:00.000", "2020-01-02T00:00:00.000"],
    rows: [
      { period: "2020-01-01T00:00:00.000", descriptor: "Banging", count: 2 },
      { period: "2020-01-01T00:00:00.000", descriptor: "Loud Music", count: 4 },
    ],
  });
  assert.deepEqual(await api.getAgencyStatusBreakdown(filters), [{ agency: "NYPD", status: "Closed", count: 6 }]);
  assert.deepEqual(await api.getMonthlyComplaintBreakdown(filters), [{ month: 1, complaintType: "Noise", count: 7 }]);
  assert.match(calls.find((call) => call.select.startsWith("agency, status")).group, /agency, status/);
});

test("hotspots preserve the request map and add bounded aggregate drilldowns", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const details = requestDetails(url);
    calls.push(details);
    if (details.select.startsWith("latitude, longitude")) {
      return jsonResponse([{ latitude: "40.7", longitude: "-74", incident_address: "1 MAIN ST", count: "12" }]);
    }
    return jsonResponse([{ complaint_type: "Noise", descriptor: "Loud Music", count: "12" }]);
  };
  const api = await loadApi();
  const filters = baseFilters();
  const result = await api.getMapHotspots(filters);

  assert.deepEqual(result, {
    rows: [{ latitude: "40.7", longitude: "-74", address: "1 MAIN ST", count: 12 }],
    isCandidateRanking: false,
  });
  assert.deepEqual(await api.getHotspotBreakdown(filters, result.rows[0]), [
    { complaintType: "Noise", descriptor: "Loud Music", count: 12 },
  ]);
  assert.equal(calls[0].limit, "1000");
  assert.match(calls[1].where, /latitude = 40\.7/);
  assert.match(calls[1].where, /incident_address = '1 MAIN ST'/);
});

test("average closure time is weighted by each dataset's closed count", async () => {
  globalThis.fetch = async (url) => {
    const { dataset } = requestDetails(url);
    return jsonResponse(dataset === "76ig-c548"
      ? [{ average_days: "10", closed_count: "2" }]
      : [{ average_days: "4", closed_count: "8" }]);
  };
  const api = await loadApi();

  assert.equal(await api.getAverageDaysToClose(baseFilters({ startDate: "2019-12-30" })), 5.2);
});

test("raw requests merge newest-first and maps retain per-dataset provenance", async () => {
  globalThis.fetch = async (url) => {
    const { dataset, select } = requestDetails(url);
    if (select.startsWith("created_date")) {
      const current = dataset === "erm2-nwe9";
      return jsonResponse(Array.from({ length: 60 }, (_, index) => ({
        unique_key: `${dataset}-${index}`,
        created_date: `${current ? "2020-01-02" : "2019-12-31"}T00:${String(index).padStart(2, "0")}:00.000`,
      })));
    }
    return jsonResponse([{
      unique_key: dataset,
      created_date: dataset === "erm2-nwe9" ? "2020-01-02T00:00:00.000" : "2019-12-31T00:00:00.000",
      latitude: "40.7",
      longitude: "-74.0",
    }]);
  };
  const api = await loadApi();
  const filters = baseFilters({ startDate: "2019-12-30" });
  const recent = await api.getRecentRequests(filters);
  const points = await api.getMapPoints(filters);

  assert.equal(recent.length, 100);
  assert.equal(recent.filter((row) => row.dataset === "erm2-nwe9").length, 60);
  assert.equal(recent.filter((row) => row.dataset === "76ig-c548").length, 40);
  assert.equal(recent[0].datasetLabel, "2020–present");
  assert.deepEqual(points.map((point) => point.datasetLabel), ["2020–present", "2010–2019"]);
});

test("SoQL string filters escape apostrophes", async () => {
  let capturedWhere = "";
  globalThis.fetch = async (url) => {
    capturedWhere = requestDetails(url).where;
    return jsonResponse([{ count: "1" }]);
  };
  const api = await loadApi();

  await api.getTotalRequests(baseFilters({ complaints: ["O'Brien"] }));
  assert.match(capturedWhere, /complaint_type IN \('O''Brien'\)/);
});

test("permitted special and anomaly boards remain constrained to their route borough", async () => {
  const capturedWheres = [];
  globalThis.fetch = async (url) => {
    capturedWheres.push(requestDetails(url).where);
    return jsonResponse([{ count: "1" }]);
  };
  const api = await loadApi();
  const routes = [
    { borough: "bronx", board: "01 QUEENS", datasetValue: "BRONX" },
    { borough: "brooklyn", board: "55 BROOKLYN", datasetValue: "BROOKLYN" },
    { borough: "manhattan", board: "08 BRONX", datasetValue: "MANHATTAN" },
    { borough: "queens", board: "QENB", datasetValue: "QUEENS" },
    { borough: "statenisland", board: "SILC", datasetValue: "STATEN ISLAND" },
  ];

  for (const route of routes) {
    await api.getTotalRequests(baseFilters({ borough: route.borough, boards: [route.board] }));
  }

  routes.forEach((route, index) => {
    assert.match(capturedWheres[index], new RegExp(`borough = '${route.datasetValue}'`));
    assert.match(capturedWheres[index], new RegExp(`community_board IN \\('${route.board}'\\)`));
  });
});

test("a dataset failure aborts its sibling and rejects the combined result", async () => {
  let currentAborted = false;
  globalThis.fetch = async (url, { signal }) => {
    const { dataset } = requestDetails(url);
    if (dataset === "76ig-c548") return jsonResponse({ message: "historical unavailable" }, 503);
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        currentAborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  };
  const api = await loadApi();

  await assert.rejects(
    api.getTotalRequests(baseFilters({ startDate: "2019-12-30" })),
    (error) => error.name === "SocrataError" && error.status === 503,
  );
  assert.equal(currentAborted, true);
});

test("caller cancellation aborts active requests", async () => {
  let requestAborted = false;
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      requestAborted = true;
      reject(signal.reason);
    }, { once: true });
  });
  const api = await loadApi();
  const controller = new AbortController();
  const request = api.getTotalRequests(baseFilters(), { signal: controller.signal });
  controller.abort();

  await assert.rejects(request, (error) => error.name === "AbortError");
  assert.equal(requestAborted, true);
});

test("simultaneous identical queries share one network request", async () => {
  let calls = 0;
  let deliverResponse;
  globalThis.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => {
      deliverResponse = () => resolve(jsonResponse([{ count: "9" }]));
    });
  };
  const api = await loadApi();
  const first = api.getTotalRequests(baseFilters());
  const second = api.getTotalRequests(baseFilters());

  assert.equal(calls, 1);
  deliverResponse();
  assert.deepEqual(await Promise.all([first, second]), [9, 9]);
});

test("one cancelled subscriber does not abort a shared request", async () => {
  let underlyingAborted = false;
  let deliverResponse;
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    deliverResponse = () => resolve(jsonResponse([{ count: "6" }]));
    signal.addEventListener("abort", () => {
      underlyingAborted = true;
      reject(signal.reason);
    }, { once: true });
  });
  const api = await loadApi();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = api.getTotalRequests(baseFilters(), { signal: firstController.signal });
  const second = api.getTotalRequests(baseFilters(), { signal: secondController.signal });
  firstController.abort();

  await assert.rejects(first, (error) => error.name === "AbortError");
  assert.equal(underlyingAborted, false);
  deliverResponse();
  assert.equal(await second, 6);
});

test("successful responses are cached and the least recently used entry is evicted", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse([{ count: "1" }]);
  };
  const api = await loadApi();
  const first = baseFilters({ complaints: ["Issue 0"] });

  assert.equal(await api.getTotalRequests(first), 1);
  assert.equal(await api.getTotalRequests(first), 1);
  assert.equal(calls, 1);
  for (let index = 1; index <= 100; index += 1) {
    await api.getTotalRequests(baseFilters({ complaints: [`Issue ${index}`] }));
  }
  await api.getTotalRequests(first);
  assert.equal(calls, 102);
});

test("timeline granularity changes after 90 inclusive days", async () => {
  const selects = [];
  globalThis.fetch = async (url) => {
    selects.push(requestDetails(url).select);
    return jsonResponse([]);
  };
  const api = await loadApi();

  assert.equal((await api.getTimeline(baseFilters({ startDate: "2020-01-01", endDate: "2020-03-30" }))).granularity, "day");
  assert.equal((await api.getTimeline(baseFilters({ startDate: "2020-01-01", endDate: "2020-03-31" }))).granularity, "month");
  assert.match(selects[0], /date_trunc_ymd/);
  assert.match(selects[1], /date_trunc_ym\(created_date\)/);
});

test("requests that exceed the network deadline become actionable Socrata errors", async () => {
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 45_000);
    queueMicrotask(callback);
    return 1;
  };
  globalThis.clearTimeout = () => {};

  const api = await loadApi();
  await assert.rejects(
    api.getTotalRequests(baseFilters()),
    (error) => error instanceof api.SocrataError && /took too long/i.test(error.message),
  );
});

test("an immediately restarted query does not join its aborted predecessor", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls += 1;
    if (calls > 1) return jsonResponse([{ count: "17" }]);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const api = await loadApi();
  const controller = new AbortController();
  const first = api.getTotalRequests(baseFilters(), { signal: controller.signal });
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  controller.abort();
  const replacement = api.getTotalRequests(baseFilters());
  await firstRejected;
  assert.equal(await replacement, 17);
  assert.equal(calls, 2);
});

test("long complaint comparisons are not cut off at Socrata's default 1000 rows", async () => {
  const rows = Array.from({ length: 1440 }, (_, index) => ({
    period: `${2010 + Math.floor(index / 144)}-${String(Math.floor(index / 12) % 12 + 1).padStart(2, "0")}-01T00:00:00.000`,
    complaint_type: `Complaint ${index % 12}`,
    count: "1",
  }));
  globalThis.fetch = async (url) => jsonResponse(rows.slice(0, Number(requestDetails(url).limit || 1000)));
  const api = await loadApi();
  const result = await api.getComplaintTimeline(
    baseFilters({ startDate: "2010-01-01", endDate: "2019-12-31" }),
    Array.from({ length: 12 }, (_, index) => `Complaint ${index}`),
  );
  assert.equal(result.rows.length, 1440);
});

test("cached live results expire without extending their lifetime on reads", async (t) => {
  let now = 1_000;
  let calls = 0;
  t.mock.method(Date, "now", () => now);
  globalThis.fetch = async () => jsonResponse([{ count: String(++calls) }]);
  const api = await loadApi();
  assert.equal(await api.getTotalRequests(baseFilters()), 1);
  now += api.CACHE_TTL_MS - 1;
  assert.equal(await api.getTotalRequests(baseFilters()), 1);
  now += 1;
  assert.equal(await api.getTotalRequests(baseFilters()), 2);
});

test("timeline includes zero-request days at both edges and between reported days", async () => {
  globalThis.fetch = async () => jsonResponse([
    { period: "2020-01-02T00:00:00.000", count: "2" },
    { period: "2020-01-04T00:00:00.000", count: "3" },
  ]);
  const api = await loadApi();
  const result = await api.getTimeline(baseFilters({ endDate: "2020-01-05" }));
  assert.deepEqual(result.rows.map((row) => row.count), [0, 2, 0, 3, 0]);
});

test("monthly zero filling respects selected years and preserves an entirely empty result", async () => {
  globalThis.fetch = async () => jsonResponse([{ period: "2020-03-01T00:00:00.000", count: "5" }]);
  const api = await loadApi();
  const result = await api.getTimeline(baseFilters({ startDate: "2019-01-01", endDate: "2021-12-31", years: [2020] }));
  assert.equal(result.rows.length, 12);
  assert.ok(result.rows.every((row) => row.period.startsWith("2020-")));
  assert.equal(result.rows.reduce((sum, row) => sum + row.count, 0), 5);
  api.clearApiCache();
  globalThis.fetch = async () => jsonResponse([]);
  assert.deepEqual((await api.getTimeline(baseFilters())).rows, []);
});

test("address lookup tolerates source spacing while retaining exact filter values", async () => {
  let where;
  globalThis.fetch = async (url) => {
    where = requestDetails(url).where;
    return jsonResponse([{ incident_address: "48 WEST   68 STREET", count: "1" }]);
  };
  const api = await loadApi();
  const rows = await api.searchAddresses(baseFilters(), "48 WEST 68");
  assert.match(where, /upper\(incident_address\) LIKE '%48%WEST%68%'/);
  assert.equal(rows[0].label, "48 WEST   68 STREET");
  await api.searchAddresses(baseFilters(), "O'BRIEN STREET");
  assert.match(where, /LIKE '%O''BRIEN%STREET%'/);
});

test("a late aborted response cannot replace the restarted query's cache entry", async () => {
  let calls = 0;
  let deliverOldResponse;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > 1) return jsonResponse([{ count: "2" }]);
    return new Promise((resolve) => { deliverOldResponse = () => resolve(jsonResponse([{ count: "99" }])); });
  };
  const api = await loadApi();
  const controller = new AbortController();
  const first = api.getTotalRequests(baseFilters(), { signal: controller.signal });
  const rejected = assert.rejects(first, { name: "AbortError" });
  controller.abort();
  assert.equal(await api.getTotalRequests(baseFilters()), 2);
  deliverOldResponse();
  await rejected;
  await new Promise(setImmediate);
  assert.equal(await api.getTotalRequests(baseFilters()), 2);
  assert.equal(calls, 2);
});
