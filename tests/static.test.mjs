import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BOROUGHS } from "../js/boroughs.js";

const root = new URL("../", import.meta.url);
const productionRoutes = Object.values(BOROUGHS).map((borough) => `${borough.slug}.html`);
const dashboardRoutes = ["prototype.html", ...productionRoutes];

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("production routes retain analytics, fixed borough scope, and no Power BI embeds", async () => {
  for (const borough of Object.values(BOROUGHS)) {
    const html = await source(`${borough.slug}.html`);
    assert.match(html, new RegExp(`<body data-borough="${borough.slug}" data-default-boards="all" data-route-fixed="true">`));
    assert.match(html, /src="\.\/js\/analytics\.js\?/);
    assert.match(html, /rel="icon" href="\.\/images\/BetaNYC_short_white_on_blue\.png"/);
    assert.doesNotMatch(html, /app\.powerbi\.com/i);
  }
});

test("dashboard documents contain unique element IDs", async () => {
  for (const route of dashboardRoutes) {
    const html = await source(route);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${route} contains a duplicate id`);
  }
});

test("pinned dashboard CDN assets use subresource integrity", async () => {
  for (const route of dashboardRoutes) {
    const html = await source(route);
    const tags = html.match(/<(?:link|script)\b[^>]+https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)[^>]*>/g) || [];
    assert.equal(tags.length, 8, `${route} should load eight audited dashboard CDN assets`);
    tags.forEach((tag) => {
      assert.match(tag, /@[0-9]+\.[0-9]+\.[0-9]+/);
      assert.match(tag, /integrity="sha384-[^"]+"/);
      assert.match(tag, /crossorigin="anonymous"/);
    });
  }
});

test("home page and documentation describe the live data path", async () => {
  const [home, readme] = await Promise.all([source("index.html"), source("README.md")]);
  assert.match(home, /queries live NYC 311 data directly from NYC Open Data/i);
  assert.doesNotMatch(home, /can no longer be refreshed/i);
  assert.match(readme, /AI assistance and human verification/);
  assert.match(readme, /Human verification status:\*\* in progress/);
  assert.match(readme, /AI is not used at runtime/);
});

test("the production domain remains unchanged", async () => {
  assert.equal((await source("CNAME")).trim(), "boardstat.beta.nyc");
  assert.ok((await readFile(new URL("favicon.ico", root))).length > 0);
});
