// Cloudflare Web Analytics (web/analytics.js, the script that adds Cloudflare's beacon on sagebrush.space only): the
// pages that load it, the tag they load it by, and the two Cloudflare origins their policy admits, for the beacon's
// script and the counts it sends (web/csp-policy.mts withAnalytics). The public pages only: never the notebook or any
// editor page, the files origin, /gh/ or the examples' pages.
export const ANALYTICS_TAG = '<script src="/analytics.js" defer></script>';
/** the page groups (web/csp.ts's rules) whose pages load it */
export const ANALYTICS_PAGES = ["/docs/*", "/blog/*", "/articles/*", "/s/*"] as const;
export const ANALYTICS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";
export const ANALYTICS_CONNECT_ORIGIN = "https://cloudflareinsights.com";
