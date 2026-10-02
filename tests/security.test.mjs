import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const routes = ["index", "manhattan", "bronx", "brooklyn", "queens", "statenisland"];

function environment(location) {
  const appended = [];
  const history = [];
  const window = { location, history: { replaceState: (...args) => history.push(args) } };
  Object.defineProperty(window, "parent", { get() { throw new Error("Analytics must not read the dashboard"); } });
  const document = {
    referrer: "https://boardstat.beta.nyc/manhattan.html?address=PRIVATE-ADDRESS",
    createElement: (tag) => ({ tag }),
    body: { append: (node) => appended.push(node) },
    head: { append: (node) => appended.push(node) },
  };
  return { window, document, appended, history, URLSearchParams };
}

test("page measurement receives only an allowlisted route and no parent referrer", async () => {
  const script = await read("js/analytics.js");
  for (const route of routes) {
    const context = environment({ hostname: "boardstat.beta.nyc", pathname: `/${route}.html`, search: "?address=PRIVATE-ADDRESS", hash: "#PRIVATE-COMPLAINT" });
    vm.runInNewContext(script, context);
    assert.equal(context.appended.length, 1);
    assert.equal(context.appended[0].src, `./analytics.html?route=${route}`);
    assert.equal(context.appended[0].referrerPolicy, "no-referrer");
    assert.equal(context.appended[0].hidden, true);
    assert.doesNotMatch(JSON.stringify(context.appended), /PRIVATE/);
  }
});

test("analytics sanitizes its own URL and explicitly overrides measurement fields", async () => {
  const script = await read("js/analytics-frame.js");
  for (const requested of ["manhattan", "__proto__", "PRIVATE-ADDRESS"]) {
    const context = environment({ hostname: "boardstat.beta.nyc", search: `?route=${requested}&address=PRIVATE-ADDRESS`, hash: "#PRIVATE-COMPLAINT" });
    vm.runInNewContext(script, context);
    const route = requested === "manhattan" ? "manhattan" : "index";
    assert.equal(context.history[0][2], `./analytics.html?route=${route}`);
    const commands = context.window.dataLayer.map((args) => Array.from(args));
    const config = commands.find(([command]) => command === "config")[2];
    assert.equal(config.send_page_view, false);
    assert.equal(config.allow_google_signals, false);
    assert.equal(config.page_referrer, "");
    assert.equal(config.page_location, `https://boardstat.beta.nyc/${route === "index" ? "" : "manhattan.html"}`);
    assert.equal(commands.filter(([command]) => command === "event").length, 1);
    assert.doesNotMatch(JSON.stringify([commands, context.appended, context.history]), /PRIVATE|__proto__/);
  }
});

test("local and fork previews do not send production analytics", async () => {
  for (const file of ["js/analytics.js", "js/analytics-frame.js"]) {
    const script = await read(file);
    for (const hostname of ["127.0.0.1", "localhost", "jflashman.github.io"]) {
      const context = environment({ hostname, pathname: "/manhattan.html", search: "" });
      vm.runInNewContext(script, context);
      assert.deepEqual(context.appended, []);
    }
  }
});

test("active pages enforce CSP, suppress referrers, and load patched jQuery", async () => {
  for (const route of [...routes, "prototype", "analytics"]) {
    const html = await read(`${route}.html`);
    assert.match(html, /<meta name="referrer" content="no-referrer"/);
    const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(policy, route);
    assert.ok(policy.index < html.indexOf("<script"), route);
    assert.match(policy[1], /base-uri 'none'/);
    assert.doesNotMatch(policy[1].match(/script-src[^;]+/)[0], /unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
    if (routes.includes(route)) {
      assert.match(html, /jquery-3\.7\.1\.min\.js/);
      assert.match(html, /sha256-\/JqT3SQfawRcv\/BIHPThkBvs0OEvtFFmqPF\/lYI\/Cxo=/);
      assert.match(html, /src="\.\/js\/analytics\.js/);
      assert.doesNotMatch(html, /googletagmanager\.com/);
    }
  }
});
