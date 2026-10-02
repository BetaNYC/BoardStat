import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "./dom-helper.mjs";
import { renderMapHotspots, renderMapPoints } from "../js/map.js";

test("map equivalents expose names, share detail requests, retry, and ignore superseded responses", async (t) => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const document = createDocument();
  globalThis.document = document;
  document.add("request-map");
  const markers = [];
  const layer = () => ({ addTo() { return this; }, clearLayers() {} });
  function marker() {
    const element = document.createElement("div");
    const events = {};
    const value = {
      events, element,
      on(name, handler) { (events[name] ||= []).push(handler); return this; },
      bindPopup(popup) { this.popup = popup; return this; },
      addTo() { return this; }, getElement() { return element; },
      openPopup() { events.popupopen?.forEach((fn) => fn()); },
      closePopup() { events.popupclose?.forEach((fn) => fn()); },
    };
    markers.push(value);
    return value;
  }
  globalThis.window = {
    setTimeout(fn) { fn(); },
    L: {
      map() { return { setView() { return this; }, fitBounds() {}, invalidateSize() {} }; },
      tileLayer: layer, markerClusterGroup: layer, layerGroup: layer,
      divIcon(options) { return options; }, marker, circleMarker: marker,
    },
  };
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const hotspot = { latitude: "40.7", longitude: "-74", address: "Example Street", count: 9 };
  let calls = 0;
  let resolve;
  renderMapHotspots({ rows: [hotspot] }, undefined, () => { calls += 1; return new Promise((done) => { resolve = done; }); });
  const body = () => document.getElementById("map-data").children[1].children[0].children[2];
  const cell = body().children[0].children[3];
  const button = cell.children[0];
  const pending = button.onclick();
  markers.at(-1).openPopup();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.match(markers.at(-1).element.getAttribute("aria-label"), /Example Street: 9 requests/);
  resolve([{ complaintType: "Noise", count: 9 }]);
  await pending;
  assert.match(cell.children[1].children[0].children[0].textContent, /Noise: 9/);
  await button.onclick();
  assert.equal(calls, 1);

  let attempts = 0;
  renderMapHotspots({ rows: [hotspot] }, undefined, async () => {
    if (++attempts === 1) throw new Error("Offline");
    return [];
  });
  const retryCell = body().children[0].children[3];
  await retryCell.children[0].onclick();
  assert.match(retryCell.children[1].textContent, /Offline/);
  assert.equal(retryCell.children[0].getAttribute("aria-disabled"), "false");
  await retryCell.children[0].onclick();
  assert.match(retryCell.children[1].textContent, /No complaint details/);

  renderMapHotspots({ rows: [hotspot] }, undefined, () => new Promise((done) => { resolve = done; }));
  const obsoleteCell = body().children[0].children[3];
  const obsolete = obsoleteCell.children[0].onclick();
  await Promise.resolve();
  renderMapPoints([{ ...hotspot, complaint_type: "Heat", unique_key: "123", incident_address: "Example Street" }]);
  resolve([{ complaintType: "Late result", count: 1 }]);
  await obsolete;
  assert.equal(body().children[0].children[0].textContent, "Heat");
  assert.match(obsoleteCell.children[1].textContent, /Loading/);
  assert.match(markers.at(-1).element.getAttribute("aria-label"), /Heat.*123/);
  renderMapPoints([]);
  assert.equal(body().children.length, 1);
  assert.match(body().children[0].children[0].textContent, /No mapped requests/);
});
