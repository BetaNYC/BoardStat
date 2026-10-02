(() => {
  const routes = {
    index: "NYC BoardStat Home",
    manhattan: "BoardStat Manhattan",
    bronx: "BoardStat Bronx",
    brooklyn: "BoardStat Brooklyn",
    queens: "BoardStat Queens",
    statenisland: "BoardStat Staten Island",
  };
  const requestedRoute = new URLSearchParams(window.location.search).get("route");
  const route = Object.hasOwn(routes, requestedRoute) ? requestedRoute : "index";
  // Also sanitize direct visits to this document before any Google code loads.
  window.history.replaceState(null, "", `./analytics.html?route=${route}`);
  if (window.location.hostname !== "boardstat.beta.nyc") return;

  const measurementId = "G-TJ936HGY1Z";
  const page = {
    page_location: `https://boardstat.beta.nyc/${route === "index" ? "" : `${route}.html`}`,
    page_referrer: "",
    page_title: routes[route],
  };
  window.dataLayer = [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("set", page);
  window.gtag("config", measurementId, {
    ...page,
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  window.gtag("event", "page_view", { ...page, send_to: measurementId });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.append(script);
})();
