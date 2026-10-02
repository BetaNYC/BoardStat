const chartInstances = new Map();
const numberFormatter = new Intl.NumberFormat("en-US");
const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const palette = ["#103fef", "#1700ae", "#007a33", "#b45f06", "#007c91", "#7a2e8e", "#c10e1a", "#4c6b16", "#3157a4", "#595959"];
let chartThemeApplied = false;

function applyChartTheme() {
  if (chartThemeApplied) return;
  window.Chart.defaults.color = "#555555";
  window.Chart.defaults.borderColor = "#e5e5e5";
  window.Chart.defaults.font.family = '"Noto Sans", Arial, sans-serif';
  window.Chart.defaults.font.size = 13;
  window.Chart.defaults.plugins.legend.labels.color = "#333333";
  window.Chart.defaults.plugins.legend.labels.usePointStyle = false;
  chartThemeApplied = true;
}

function requireChartJs() {
  if (!window.Chart) throw new Error("Chart.js did not load.");
  applyChartTheme();
}

function replaceChart(canvasId, configuration) {
  requireChartJs();
  chartInstances.get(canvasId)?.destroy();
  const canvas = document.getElementById(canvasId);
  configuration.options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    ...configuration.options,
  };
  renderChartData(canvas, configuration.data);
  distinguishSeries(configuration);
  const chart = new window.Chart(canvas, configuration);
  chartInstances.set(canvasId, chart);
}

function destroyChart(canvasId) {
  chartInstances.get(canvasId)?.destroy();
  chartInstances.delete(canvasId);
  document.getElementById(`${canvasId}-data`)?.remove();
  document.getElementById(canvasId)?.removeAttribute("aria-details");
}

// Every plotted value has the same label and position in the equivalent table.
function chartDataRows(data) {
  return data.labels.map((label, index) => [label, ...data.datasets.map((series) => series.data[index] ?? 0)]);
}

function renderChartData(canvas, data) {
  const id = `${canvas.id}-data`;
  let details = document.getElementById(id);
  if (!details) {
    details = document.createElement("details");
    details.id = id;
    details.className = "chart-data";
    canvas.closest(".chart-wrap").after(details);
  }
  const title = canvas.getAttribute("aria-label") || "Chart";
  const summary = document.createElement("summary");
  summary.textContent = `View data: ${title}`;
  const region = document.createElement("div");
  region.className = "table-scroll";
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", `${title} data`);
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = `${title} — all displayed values`;
  table.append(caption);
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  ["Category / period", ...data.datasets.map((series) => series.label || "Requests")].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    header.append(cell);
  });
  head.append(header);
  const body = document.createElement("tbody");
  chartDataRows(data).forEach((values) => {
    const row = document.createElement("tr");
    values.forEach((value, index) => {
      const cell = document.createElement(index ? "td" : "th");
      if (!index) cell.scope = "row";
      cell.textContent = index ? numberFormatter.format(value) : value;
      row.append(cell);
    });
    body.append(row);
  });
  table.append(head, body);
  region.append(table);
  details.replaceChildren(summary, region);
  canvas.setAttribute("aria-details", id);
}

const seriesPatterns = Object.freeze([
  "horizontal", "vertical", "diagonal", "grid", "dots",
  "squares", "reverse-diagonal", "diamonds", "diagonal-horizontal", "checkerboard",
]);

function seriesPattern(index, color) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 16;
  const context = tile.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 16, 16);
  context.strokeStyle = "white";
  context.fillStyle = "white";
  context.lineWidth = 2;
  const kind = seriesPatterns[index % seriesPatterns.length];
  if (["horizontal", "vertical", "diagonal", "grid", "diagonal-horizontal"].includes(kind)) {
    context.beginPath();
    if (["horizontal", "grid", "diagonal-horizontal"].includes(kind)) {
      context.moveTo(0, 8);
      context.lineTo(16, 8);
    }
    if (["vertical", "grid"].includes(kind)) {
      context.moveTo(8, 0);
      context.lineTo(8, 16);
    }
    if (["diagonal", "diagonal-horizontal"].includes(kind)) {
      context.moveTo(0, 16);
      context.lineTo(16, 0);
    }
    context.stroke();
  } else if (kind === "dots") {
    context.beginPath();
    context.arc(8, 8, 3, 0, Math.PI * 2);
    context.fill();
  } else if (kind === "squares") {
    context.strokeRect(4, 4, 8, 8);
  } else if (kind === "reverse-diagonal") {
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(16, 16);
    context.stroke();
  } else if (kind === "diamonds") {
    context.beginPath();
    context.moveTo(0, 8);
    context.lineTo(8, 0);
    context.lineTo(16, 8);
    context.lineTo(8, 16);
    context.closePath();
    context.stroke();
  } else {
    context.fillRect(2, 2, 5, 5);
    context.fillRect(10, 10, 5, 5);
  }
  return context.createPattern(tile, "repeat");
}

function distinguishSeries(configuration) {
  const datasets = configuration.data.datasets;
  if (configuration.type === "line" && datasets.length > 1) {
    configuration.options.plugins.legend.labels = { usePointStyle: true, boxWidth: 24, boxHeight: 16 };
    datasets.forEach((series, index) => {
      series.borderDash = index === 0 ? [] : [2 + index * 2, 3, 2, 3];
      series.pointStyle = ["circle", "triangle", "rect", "rectRot", "cross", "star", "crossRot", "dash", "line"][index % 9];
      series.pointRadius = configuration.data.labels.length > 45 ? 2 : 4;
    });
  } else if (configuration.type === "doughnut") {
    configuration.options.plugins.legend.labels = { ...configuration.options.plugins.legend.labels, boxWidth: 32, boxHeight: 20 };
    datasets[0].backgroundColor = configuration.data.labels.map((_, index) => seriesPattern(index, palette[index % palette.length]));
  } else if (datasets.length > 1) {
    configuration.options.plugins.legend.labels = { boxWidth: 32, boxHeight: 20 };
    datasets.forEach((series, index) => {
      series.backgroundColor = seriesPattern(index, palette[index % palette.length]);
      series.borderColor = "#333333";
      series.borderWidth = 1;
    });
  }
}

function writeSummary(elementId, text) {
  document.getElementById(elementId).textContent = text;
}

function parseSocrataPeriod(value) {
  return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
}

function formatPeriod(value, granularity) {
  const formatter = granularity === "day" ? shortDateFormatter : monthFormatter;
  return formatter.format(parseSocrataPeriod(value));
}

function summarizeTop(rows, noun) {
  if (!rows.length) return `No ${noun} were reported for this selection.`;
  return rows
    .slice(0, 3)
    .map((row) => `${row.label}: ${numberFormatter.format(row.count)}`)
    .join("; ");
}

function renderRankedBar({ canvasId, summaryId, rows, noun, color = palette[0], limit = 10, horizontal = true }) {
  const displayed = rows.slice(0, limit);
  if (!displayed.length) {
    destroyChart(canvasId);
    writeSummary(summaryId, `No ${noun} were reported for this selection.`);
    return;
  }

  replaceChart(canvasId, {
    type: "bar",
    data: {
      labels: displayed.map((row) => row.label),
      datasets: [{ label: "Requests", data: displayed.map((row) => row.count), backgroundColor: color }],
    },
    options: {
      indexAxis: horizontal ? "y" : "x",
      plugins: { legend: { display: false } },
      scales: { [horizontal ? "x" : "y"]: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  writeSummary(summaryId, `Leading ${noun} — ${summarizeTop(displayed, noun)}.`);
}

export function renderComplaintChart(rows) {
  renderRankedBar({ canvasId: "complaints-chart", summaryId: "complaints-summary", rows, noun: "complaint types" });
}

export function renderAddressComplaintChart(rows) {
  renderRankedBar({
    canvasId: "address-complaints-chart",
    summaryId: "address-complaints-summary",
    rows,
    noun: "complaint types at the selected addresses",
    color: palette[4],
  });
}

export function renderDescriptorChart(rows) {
  renderRankedBar({ canvasId: "descriptors-chart", summaryId: "descriptors-summary", rows, noun: "descriptors", color: palette[1] });
}

export function renderBoardChart(rows) {
  renderRankedBar({
    canvasId: "boards-chart",
    summaryId: "boards-summary",
    rows,
    noun: "Community Boards",
    color: palette[4],
    limit: rows.length,
    horizontal: false,
  });
}

function renderTimeline(canvasId, result, color, backgroundColor) {
  replaceChart(canvasId, {
    type: "line",
    data: {
      labels: result.rows.map((row) => formatPeriod(row.period, result.granularity)),
      datasets: [{
        label: "Requests",
        data: result.rows.map((row) => row.count),
        borderColor: color,
        backgroundColor,
        borderWidth: 3,
        pointRadius: result.rows.length > 45 ? 0 : 2,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.2,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });

  return numberFormatter.format(result.rows.reduce((sum, row) => sum + row.count, 0));
}

export function renderTimelineChart(result) {
  if (!result.rows.length) {
    destroyChart("timeline-chart");
    writeSummary("timeline-summary", "No requests were reported over this period.");
    return;
  }
  const total = renderTimeline("timeline-chart", result, palette[0], "rgba(16, 63, 239, 0.12)");
  writeSummary(
    "timeline-summary",
    `${total} requests shown in ${result.granularity === "day" ? "daily" : "monthly"} intervals.`,
  );
}

export function renderAddressTimelineChart(result) {
  if (!result.rows.length) {
    destroyChart("address-timeline-chart");
    writeSummary("address-timeline-summary", "No requests were reported over this period for the selected addresses.");
    return;
  }
  const total = renderTimeline("address-timeline-chart", result, palette[4], "rgba(0, 124, 145, 0.12)");
  writeSummary("address-timeline-summary", `${total} requests across the selected address spellings.`);
}

export function renderAgencyChart(rows) {
  const displayed = rows.slice(0, 10);
  if (!displayed.length) {
    destroyChart("agencies-chart");
    writeSummary("agencies-summary", "No agencies were reported for this selection.");
    return;
  }

  replaceChart("agencies-chart", {
    type: "doughnut",
    data: {
      labels: displayed.map((row) => row.label),
      datasets: [{ data: displayed.map((row) => row.count), backgroundColor: palette, borderColor: "#ffffff", borderWidth: 2 }],
    },
    options: {
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, padding: 14 } } },
    },
  });
  writeSummary("agencies-summary", `Leading agencies — ${summarizeTop(displayed, "agencies")}.`);
}

export function renderStatusChart(rows) {
  if (!rows.length) {
    destroyChart("statuses-chart");
    writeSummary("statuses-summary", "No statuses were reported for this selection.");
    return;
  }

  replaceChart("statuses-chart", {
    type: "bar",
    data: {
      labels: rows.map((row) => row.label),
      datasets: [{ label: "Requests", data: rows.map((row) => row.count), backgroundColor: palette[2] }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  writeSummary("statuses-summary", `Status totals — ${summarizeTop(rows, "statuses")}.`);
}

function renderComparisonTimeline(canvasId, result, labels, key) {
  const periods = result.periods || [...new Set(result.rows.map((row) => row.period))].sort();
  const datasets = labels.map((label, index) => {
    const counts = new Map(
      result.rows
        .filter((row) => row[key] === label)
        .map((row) => [row.period, row.count]),
    );
    return {
      label,
      data: periods.map((period) => counts.get(period) || 0),
      borderColor: palette[index % palette.length],
      backgroundColor: palette[index % palette.length],
      borderWidth: 2,
      pointRadius: periods.length > 45 ? 0 : 2,
      tension: 0.18,
    };
  });

  replaceChart(canvasId, {
    type: "line",
    data: { labels: periods.map((period) => formatPeriod(period, result.granularity)), datasets },
    options: {
      plugins: { legend: { position: "bottom" } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

export function renderComplaintComparisonChart(result) {
  if (!result.rows.length || !result.complaintTypes.length) {
    destroyChart("comparison-chart");
    writeSummary("comparison-summary", "No complaint comparison is available for this selection.");
    return;
  }
  renderComparisonTimeline("comparison-chart", result, result.complaintTypes, "complaintType");
  writeSummary("comparison-summary", `Comparing ${result.complaintTypes.join(", ")} over time.`);
}

export function renderDescriptorTimelineChart(result) {
  if (!result.rows.length || !result.descriptors.length) {
    destroyChart("address-descriptors-chart");
    writeSummary("address-descriptors-summary", "Select at least one complaint type to compare its descriptors over time.");
    return;
  }
  renderComparisonTimeline("address-descriptors-chart", result, result.descriptors, "descriptor");
  writeSummary("address-descriptors-summary", `Leading descriptors for the selected complaint filter: ${result.descriptors.join(", ")}.`);
}

export function renderAgencyStatusChart(rows) {
  if (!rows.length) {
    destroyChart("agency-status-chart");
    writeSummary("agency-status-summary", "No agency and status combinations were reported for this selection.");
    return;
  }
  const totals = new Map();
  rows.forEach((row) => totals.set(row.agency, (totals.get(row.agency) || 0) + row.count));
  const agencies = [...totals.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .slice(0, 10)
    .map(([agency]) => agency);
  const statuses = [...new Set(rows.map((row) => row.status))].sort();
  const values = new Map(rows.map((row) => [`${row.agency}\u0000${row.status}`, row.count]));
  replaceChart("agency-status-chart", {
    type: "bar",
    data: {
      labels: agencies,
      datasets: statuses.map((status, index) => ({
        label: status,
        data: agencies.map((agency) => values.get(`${agency}\u0000${status}`) || 0),
        backgroundColor: palette[index % palette.length],
      })),
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { position: "bottom" } },
      scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true } },
    },
  });
  writeSummary("agency-status-summary", `Status composition for the ${agencies.length} leading agencies. Exact values are listed in the table.`);
}

export function renderAnnualChart(rows) {
  if (!rows.length) {
    destroyChart("annual-chart");
    writeSummary("annual-summary", "No annual totals were reported for this selection.");
    return;
  }
  replaceChart("annual-chart", {
    type: "bar",
    data: {
      labels: rows.map((row) => String(row.year)),
      datasets: [{ label: "Requests", data: rows.map((row) => row.count), backgroundColor: palette[0] }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  writeSummary("annual-summary", `${rows.length} annual total${rows.length === 1 ? "" : "s"} shown.`);
}

export function renderMonthlyChart(rows) {
  if (!rows.length) {
    destroyChart("monthly-chart");
    writeSummary("monthly-summary", "No monthly totals were reported for this selection.");
    return;
  }
  const counts = new Map(rows.map((row) => [row.month, row.count]));
  replaceChart("monthly-chart", {
    type: "bar",
    data: {
      labels: monthNames,
      datasets: [{ label: "Requests", data: monthNames.map((_, index) => counts.get(index + 1) || 0), backgroundColor: palette[1] }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  writeSummary("monthly-summary", "Totals are grouped by calendar month across the selected years and date range.");
}

export function renderMonthlyComplaintChart(rows, selectedComplaintTypes = []) {
  if (!rows.length) {
    destroyChart("monthly-complaints-chart");
    writeSummary("monthly-complaints-summary", "No monthly complaint mix was reported for this selection.");
    return { displayedTypes: [], leaders: [] };
  }
  const totals = new Map();
  rows.forEach((row) => totals.set(row.complaintType, (totals.get(row.complaintType) || 0) + row.count));
  const displayedTypes = selectedComplaintTypes.length
    ? selectedComplaintTypes.slice(0, 8)
    : [...totals.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
      .slice(0, 8)
      .map(([complaintType]) => complaintType);
  const displayed = new Set(displayedTypes);
  const values = new Map(rows.map((row) => [`${row.month}\u0000${row.complaintType}`, row.count]));
  const hasOther = rows.some((row) => !displayed.has(row.complaintType));
  const datasets = displayedTypes.map((complaintType, index) => ({
    label: complaintType,
    data: monthNames.map((_, monthIndex) => values.get(`${monthIndex + 1}\u0000${complaintType}`) || 0),
    backgroundColor: palette[index % palette.length],
  }));
  if (hasOther) {
    datasets.push({
      label: "Other",
      data: monthNames.map((_, monthIndex) => rows
        .filter((row) => row.month === monthIndex + 1 && !displayed.has(row.complaintType))
        .reduce((sum, row) => sum + row.count, 0)),
      backgroundColor: "#b8b8b8",
    });
  }
  replaceChart("monthly-complaints-chart", {
    type: "bar",
    data: { labels: monthNames, datasets },
    options: {
      plugins: { legend: { position: "bottom" } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
  const leaders = monthNames.map((monthName, index) => {
    const candidates = rows.filter((row) => row.month === index + 1).sort((first, second) => second.count - first.count || first.complaintType.localeCompare(second.complaintType));
    return { month: monthName, complaintType: candidates[0]?.complaintType || "—", count: candidates[0]?.count || 0 };
  });
  writeSummary(
    "monthly-complaints-summary",
    `${displayedTypes.length} complaint type${displayedTypes.length === 1 ? "" : "s"} shown${hasOther ? " with remaining requests grouped as Other" : ""}. Exact monthly leaders are listed below.`,
  );
  return { displayedTypes, leaders };
}
