// Cloudflare Web Analytics on sagebrush.space's public pages (the docs, the blog, the articles and the shared read-only
// /s/<id> pages): a count of page views, with no cookies and no personal data. The beacon is
// Cloudflare's manual snippet, as given, added by this script, never by Cloudflare at the edge. Only on
// sagebrush.space itself: a self-hosted site, a preview, a test or this computer, built from the same pages, sends
// nothing. Never on /gh/ (served from the /s/ page), an LTI launch (#lti=, a class's own page) or in a frame. Which
// pages load this, and the policy that admits the beacon there: web/analytics.mts.
(() => {
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }
  if (location.hostname !== "sagebrush.space") return;
  if (location.pathname.startsWith("/gh/") || location.hash.startsWith("#lti=")) return;
  const s = document.createElement("script");
  s.type = "module";
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", '{"token": "bbae8a56ea934552933137eedcc08651"}');
  document.head.append(s);
})();
