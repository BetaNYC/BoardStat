// Keep Google measurement away from dashboard URLs, history, and form controls.
(() => {
  if (window.location.hostname !== "boardstat.beta.nyc") return;
  const routes = ["index", "manhattan", "bronx", "brooklyn", "queens", "statenisland"];
  const requestedRoute = window.location.pathname.split("/").pop().replace(/\.html$/, "") || "index";
  const route = routes.includes(requestedRoute) ? requestedRoute : "index";
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.title = "Aggregate page analytics";
  frame.referrerPolicy = "no-referrer";
  frame.src = `./analytics.html?route=${route}`;
  document.body.append(frame);
})();
