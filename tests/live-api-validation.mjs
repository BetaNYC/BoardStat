import { getTotalRequests } from "../js/api.js";
import { BOROUGHS } from "../js/boroughs.js";

const API_ROOT = "https://data.cityofnewyork.us/resource";
const cases = [
  { name: "current", startDate: "2025-08-01", endDate: "2025-08-07", slices: [["erm2-nwe9", "2025-08-01", "2025-08-08"]] },
  { name: "historical", startDate: "2019-08-01", endDate: "2019-08-07", slices: [["76ig-c548", "2019-08-01", "2019-08-08"]] },
  {
    name: "boundary",
    startDate: "2019-12-30",
    endDate: "2020-01-02",
    slices: [
      ["76ig-c548", "2019-12-30", "2020-01-01"],
      ["erm2-nwe9", "2020-01-01", "2020-01-03"],
    ],
  },
];

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function directCount(route, board, dataset, start, end) {
  const parameters = new URLSearchParams({
    "$select": "count(*) AS count",
    "$where": [
      `borough = ${quote(route.datasetValue)}`,
      `community_board = ${quote(board)}`,
      `created_date >= ${quote(`${start}T00:00:00.000`)}`,
      `created_date < ${quote(`${end}T00:00:00.000`)}`,
    ].join(" AND "),
  });
  const url = `${API_ROOT}/${dataset}.json?${parameters}`;
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Direct query failed with ${response.status}: ${await response.text()}`);
  return { count: Number((await response.json())[0]?.count || 0), url };
}

let failed = false;
console.log(`# BoardStat live validation ${new Date().toISOString()}`);

for (const route of Object.values(BOROUGHS)) {
  for (const item of cases) {
    const filters = {
      borough: route.slug,
      boards: [route.defaultBoard],
      complaints: [], descriptors: [], agencies: [], statuses: [], addresses: [], years: [],
      startDate: item.startDate,
      endDate: item.endDate,
    };
    const dashboard = await getTotalRequests(filters);
    let direct = 0;
    const urls = [];
    for (const slice of item.slices) {
      const result = await directCount(route, route.defaultBoard, ...slice);
      direct += result.count;
      urls.push(result.url);
      await pause(150);
    }
    const match = dashboard === direct;
    failed ||= !match;
    console.log(JSON.stringify({ borough: route.slug, board: route.defaultBoard, case: item.name, dashboard, direct, match, urls }));
  }
}

if (failed) process.exitCode = 1;
