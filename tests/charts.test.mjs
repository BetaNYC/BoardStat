import assert from "node:assert/strict";
import test from "node:test";
import { BOROUGHS } from "../js/boroughs.js";
import { renderBoardChart, renderComplaintComparisonChart, renderMonthlyComplaintChart } from "../js/charts.js";
import { createDocument } from "./dom-helper.mjs";

test("board charts retain every selected district and replace their prior chart", (t) => {
  const configurations = [];
  let destroyed = 0;
  class Chart {
    static defaults = { font: {}, plugins: { legend: { labels: {} } } };
    constructor(_canvas, configuration) { configurations.push(configuration); }
    destroy() { destroyed += 1; }
  }
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = { Chart };
  globalThis.document = createDocument();
  ["boards-chart", "boards-summary", "comparison-chart", "comparison-summary", "monthly-complaints-chart", "monthly-complaints-summary"].forEach((id) => document.add(id));
  t.after(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });

  for (const route of [BOROUGHS.brooklyn, BOROUGHS.queens]) {
    renderBoardChart(route.boards.map((label, index) => ({ label, count: index + 1 })));
    assert.deepEqual(configurations.at(-1).data.labels, route.boards);
  }
  assert.equal(destroyed, 1);

  renderComplaintComparisonChart({
    granularity: "day", complaintTypes: ["Noise"],
    periods: ["2020-01-01T00:00:00.000", "2020-01-02T00:00:00.000", "2020-01-03T00:00:00.000"],
    rows: [{ period: "2020-01-02T00:00:00.000", complaintType: "Noise", count: 4 }],
  });
  assert.deepEqual(configurations.at(-1).data.datasets[0].data, [0, 4, 0]);
  const details = document.getElementById("comparison-chart-data");
  const table = details.children[1].children[0];
  assert.deepEqual(table.children[2].children.map((row) => row.children[1].textContent), ["0", "4", "0"]);
  assert.equal(table.children[1].children[0].children[1].textContent, "Noise");
  details.open = true;
  renderComplaintComparisonChart({ granularity: "day", complaintTypes: ["Noise", "Heat"], periods: ["2020-01-01"], rows: [{ period: "2020-01-01", complaintType: "Heat", count: 7 }] });
  assert.equal(document.getElementById("comparison-chart-data"), details);
  assert.equal(details.open, true);
  assert.notDeepEqual(configurations.at(-1).data.datasets[0].borderDash, configurations.at(-1).data.datasets[1].borderDash);
  assert.notEqual(configurations.at(-1).data.datasets[0].pointStyle, configurations.at(-1).data.datasets[1].pointStyle);
  renderComplaintComparisonChart({ rows: [], complaintTypes: [] });
  assert.equal(document.getElementById("comparison-chart-data"), null);
  renderMonthlyComplaintChart([{ month: 1, complaintType: "Noise", count: 2 }, { month: 1, complaintType: "Heat", count: 5 }], ["Noise"]);
  const monthly = document.getElementById("monthly-complaints-chart-data").children[1].children[0];
  assert.deepEqual(monthly.children[1].children[0].children.map((cell) => cell.textContent), ["Category / period", "Noise", "Other"]);
  assert.deepEqual(monthly.children[2].children[0].children.map((cell) => cell.textContent), ["January", "2", "5"]);
});
