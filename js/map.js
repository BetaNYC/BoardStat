const DEFAULT_CENTER = [40.7128, -74.006];
const NYC_BASEMAP_URL = "https://tiles.arcgis.com/tiles/yG5s3afENB5iO9fj/arcgis/rest/services/NYC_Basemap_v3/VectorTileServer";
let map;
let requestLayer;
let hotspotLayer;
let fallbackBasemap;
let renderGeneration = 0;

function requireLeaflet() {
  if (!window.L) throw new Error("Leaflet did not load.");
  if (!window.L.markerClusterGroup) throw new Error("Leaflet marker clustering did not load.");
}

function addOpenStreetMapFallback() {
  if (fallbackBasemap) return fallbackBasemap;
  fallbackBasemap = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return fallbackBasemap;
}

function addBasemap() {
  const vectorTiles = window.L.esri?.Vector?.vectorTileLayer;
  if (!vectorTiles) return addOpenStreetMapFallback();

  const layer = vectorTiles(NYC_BASEMAP_URL, {
    attribution: 'Basemap &copy; <a href="https://www.nyc.gov/site/oti/index.page">NYC OTI</a>',
  });
  let loaded = false;
  layer.on("load", () => {
    loaded = true;
  });
  layer.on("load-error", () => {
    if (loaded || fallbackBasemap) return;
    map.removeLayer(layer);
    addOpenStreetMapFallback();
  });
  layer.addTo(map);
  return layer;
}

function initializeMap(center) {
  if (map) return;
  requireLeaflet();
  map = window.L.map("request-map", { scrollWheelZoom: false, maxZoom: 17 }).setView(center, 11);
  addBasemap();
  requestLayer = window.L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 80,
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount();
      return window.L.divIcon({
        html: `<span aria-hidden="true">${count}</span><span class="visually-hidden">Show ${count} requests</span>`,
        className: "marker-cluster marker-cluster-small",
        iconSize: [44, 44],
      });
    },
  }).addTo(map);
  hotspotLayer = window.L.layerGroup().addTo(map);
}

function prepareMap(center, label) {
  renderGeneration += 1;
  initializeMap(center);
  requestLayer.clearLayers();
  hotspotLayer.clearLayers();
  document.getElementById("request-map").setAttribute("aria-label", label);
  return renderGeneration;
}

function fitMap(bounds, center) {
  if (bounds.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  else map.setView(center, 11);
  window.setTimeout(() => map.invalidateSize(), 0);
}

function createRequestIcon() {
  return window.L.divIcon({
    className: "request-marker-shell",
    html: '<span class="request-marker-dot" aria-hidden="true"></span>',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function accessibleMarker(marker, label, popup) {
  const configure = () => {
    const element = marker.getElement();
    if (!element) return;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", label);
    element.setAttribute("tabindex", "0");
    element.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        marker.openPopup();
      }
    };
  };
  marker.on("add", configure);
  configure();
  popup.tabIndex = -1;
  popup.setAttribute("role", "group");
  popup.setAttribute("aria-label", label);
  let returnFocus;
  marker.on("popupopen", () => {
    returnFocus = document.activeElement;
    popup.focus();
  });
  popup.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      marker.closePopup();
    }
  });
  marker.on("popupclose", () => {
    const active = document.activeElement;
    if (returnFocus?.isConnected && (active === document.body || popup.contains?.(active))) returnFocus.focus();
  });
}

function mapDataTable(headers, title) {
  let details = document.getElementById("map-data");
  if (!details) {
    details = document.createElement("details");
    details.id = "map-data";
    details.className = "map-data";
    document.getElementById("request-map").before(details);
  }
  const summary = document.createElement("summary");
  summary.textContent = `View data: ${title}`;
  const region = document.createElement("div");
  region.className = "table-scroll";
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", title);
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = `${title} — the same bounded sample shown on the map`;
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  headers.forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    row.append(cell);
  });
  head.append(row);
  const body = document.createElement("tbody");
  table.append(caption, head, body);
  region.append(table);
  details.replaceChildren(summary, region);
  return body;
}

function dataRow(body, values) {
  const row = document.createElement("tr");
  values.forEach((value) => {
    const cell = document.createElement("td");
    cell.textContent = value || "—";
    row.append(cell);
  });
  body.append(row);
  return row;
}

function addTextLine(container, text, className = "map-popup-detail") {
  if (!text) return;
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  container.append(line);
}

function formatSocrataDateTime(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
}

function createPopup(point) {
  const popup = document.createElement("div");
  addTextLine(popup, point.complaint_type || "311 service request", "map-popup-title");
  addTextLine(popup, point.descriptor);
  addTextLine(popup, [point.agency, point.status].filter(Boolean).join(" · "));
  addTextLine(popup, point.community_board);
  addTextLine(popup, point.incident_address);
  if (point.created_date) {
    addTextLine(popup, formatSocrataDateTime(point.created_date));
  }
  addTextLine(popup, point.unique_key ? `Request ${point.unique_key}` : "");
  addTextLine(popup, point.datasetLabel ? `Dataset: ${point.datasetLabel}` : "");
  return popup;
}

export function renderMapPoints(points, center = DEFAULT_CENTER) {
  const generation = prepareMap(center, "Map of recent 311 service requests");
  const body = mapDataTable(["Complaint", "Descriptor", "Agency", "Status", "Community Board", "Address", "Created", "Request", "Dataset", "Coordinates", "Map action"], "Mapped requests");

  const bounds = [];
  points.forEach((point) => {
    const latitude = Number(point.latitude);
    const longitude = Number(point.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const location = [latitude, longitude];
    const popup = createPopup(point);
    const marker = window.L.marker(location, {
      alt: point.complaint_type || "311 service request",
      icon: createRequestIcon(),
    })
      .bindPopup(popup)
      .addTo(requestLayer);
    accessibleMarker(marker, `${point.complaint_type || "311 request"}, ${point.incident_address || location.join(", ")}, request ${point.unique_key || "unknown"}`, popup);
    const row = dataRow(body, [point.complaint_type, point.descriptor, point.agency, point.status, point.community_board, point.incident_address, point.created_date ? formatSocrataDateTime(point.created_date) : "", point.unique_key, point.datasetLabel, location.join(", ")]);
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Show request ${point.unique_key || point.complaint_type || "at this location"} on map`;
    button.addEventListener("click", () => {
      requestLayer.zoomToShowLayer(marker, () => {
        if (generation === renderGeneration) marker.openPopup();
      });
    });
    cell.append(button);
    row.append(cell);
    bounds.push(location);
  });

  fitMap(bounds, center);
  if (!bounds.length) dataRow(body, ["No mapped requests for this selection."]).firstElementChild.colSpan = 11;
  return bounds.length;
}

function createHotspotPopup(hotspot) {
  const popup = document.createElement("div");
  addTextLine(popup, hotspot.address || "311 hotspot", "map-popup-title");
  addTextLine(popup, `${Number(hotspot.count).toLocaleString("en-US")} matching requests`);
  const details = document.createElement("div");
  details.className = "hotspot-details";
  details.setAttribute("role", "status");
  details.textContent = "Open this hotspot to load its leading complaint and descriptor pairs.";
  popup.append(details);
  return { popup, details };
}

export function renderMapHotspots(result, center = DEFAULT_CENTER, loadDetails) {
  const generation = prepareMap(center, "Map of 311 request hotspots");
  const body = mapDataTable(["Address", "Requests", "Coordinates", "Complaint details"], "Mapped hotspots");
  const bounds = [];
  const maximum = Math.max(...result.rows.map((row) => Number(row.count) || 0), 1);

  result.rows.forEach((hotspot) => {
    const latitude = Number(hotspot.latitude);
    const longitude = Number(hotspot.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const location = [latitude, longitude];
    const radius = 22 + (Math.sqrt(Number(hotspot.count) || 0) / Math.sqrt(maximum)) * 20;
    const { popup, details } = createHotspotPopup(hotspot);
    const row = dataRow(body, [hotspot.address || "Unnamed location", Number(hotspot.count).toLocaleString("en-US"), location.join(", ")]);
    const cell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Load details for ${hotspot.address || location.join(", ")}`;
    const tableDetails = document.createElement("div");
    tableDetails.setAttribute("role", "status");
    cell.append(button, tableDetails);
    row.append(cell);
    let pending;
    let cached;
    const circle = window.L.circleMarker(location, {
      radius,
      color: "#050560",
      weight: 2,
      fillColor: "#103fef",
      fillOpacity: 0.58,
    }).bindPopup(popup).addTo(hotspotLayer);
    accessibleMarker(circle, `${hotspot.address || location.join(", ")}: ${Number(hotspot.count).toLocaleString("en-US")} requests`, popup);
    const showDetails = async () => {
      if (generation !== renderGeneration || typeof loadDetails !== "function" || pending) return;
      [details, tableDetails].forEach((target) => {
        target.textContent = "Loading leading complaint details…";
      });
      button.setAttribute("aria-disabled", "true");
      try {
        if (!cached) {
          pending = Promise.resolve().then(() => loadDetails(hotspot));
        }
        const rows = cached || await pending;
        if (generation !== renderGeneration) return;
        cached = rows;
        [details, tableDetails].forEach((target) => {
          target.replaceChildren();
          if (!rows.length) {
            target.textContent = "No complaint details are available for this hotspot.";
            return;
          }
          const list = document.createElement("ol");
          rows.slice(0, 5).forEach((row) => {
            const item = document.createElement("li");
            item.textContent = `${row.complaintType}${row.descriptor ? ` — ${row.descriptor}` : ""}: ${Number(row.count).toLocaleString("en-US")}`;
            list.append(item);
          });
          target.append(list);
        });
      } catch (error) {
        if (generation !== renderGeneration) return;
        [details, tableDetails].forEach((target) => {
          target.textContent = error.name === "AbortError" ? "Hotspot details were cancelled. Retry using Load details." : `Hotspot details could not be loaded. ${error.message}`;
        });
      } finally {
        pending = undefined;
        button.setAttribute("aria-disabled", "false");
      }
    };
    button.addEventListener("click", showDetails);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Load details / retry";
    retry.addEventListener("click", showDetails);
    popup.append(retry);
    circle.on("popupopen", showDetails);
    bounds.push(location);
  });

  fitMap(bounds, center);
  if (!bounds.length) dataRow(body, ["No hotspots for this selection."]).firstElementChild.colSpan = 4;
  return bounds.length;
}
