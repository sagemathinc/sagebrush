// Page views, counted on the server: the site's Worker (Workers Analytics Engine) and the self-hosted server (SQLite)
// both count with these pure functions, so the two count the same things the same way. Nothing here runs in the
// browser, sets a cookie or reads an account: a view is its page's class (never an id, a query or a hash), the country
// the request came from, the referring site's host, whether it looks like a bot, and a visitor hash that is the same
// for one browser on one day only (the salt changes every day and is kept only for its day).
//   classify(request)              the view's fields, or null for a page that isn't counted
//   isView(request, response)      whether this response is a page someone navigated to
//   visitorHash(salt, ip, ua)      the day's anonymous visitor hash
// The counted pages: / (the notebook page), the docs, the blog, the articles and the shared read-only /s/ pages.

/** A request as both servers have it: its URL and headers (and, at Cloudflare, `cf.country`). */
export interface ViewRequest {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
  cf?: { country?: unknown } | null;
}
export interface ViewResponse {
  status: number;
  headers: { get(name: string): string | null };
}
export interface ViewFields {
  /** "/", "docs", "docs:<topic>", "blog", "blog:<slug>", "articles", "articles:<series>", "s" */
  pathClass: string;
  /** two letters, from Cloudflare (cf.country, or CF-IPCountry behind it); "" when unknown */
  country: string;
  /** the referring page's host; "self" for this site; "" for none */
  refHost: string;
  agent: "human" | "bot";
}

// (a page's name in a class: the names the site's own pages have; anything else is counted under the section alone)
const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** The class of a counted page's path, or null when the path isn't counted (/gh/, assets, the API, anything else). */
export function pathClassOf(pathname: string): string | null {
  const p = pathname.replace(/\/index\.html$/, "/");
  if (p === "/") return "/";
  if (p === "/s" || p.startsWith("/s/")) return "s";
  for (const section of ["docs", "blog", "articles"]) {
    if (p === `/${section}` || p === `/${section}/`) return section;
    if (!p.startsWith(`/${section}/`)) continue;
    const name = p.slice(section.length + 2).split("/")[0].replace(/\.html$/, "");
    return NAME.test(name) ? `${section}:${name}` : section;
  }
  return null;
}

/** The referring page's host: "" for none (or one that isn't a web page's), "self" for `ownHost`. */
export function refHostOf(referer: string | null, ownHost: string): string {
  if (!referer) return "";
  let u: URL;
  try {
    u = new URL(referer);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = u.hostname.toLowerCase();
  return host === ownHost.toLowerCase() ? "self" : host;
}

// (a crawler, a link-preview fetcher, a monitor or a script: by its User-Agent; none at all is a script too)
const BOT = /bot|crawl|spider|slurp|preview|monitor|uptime|headless|phantom|lighthouse|facebookexternalhit|embedly|curl|wget|python|httpie|go-http|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy/i;
export const agentOf = (ua: string | null): "human" | "bot" => (!ua || BOT.test(ua) ? "bot" : "human");

/** A counted page's fields (not yet its visitor), or null when the request's path isn't counted. */
export function classify(request: ViewRequest): ViewFields | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const pathClass = pathClassOf(url.pathname);
  if (!pathClass) return null;
  const c = request.cf?.country ?? request.headers.get("cf-ipcountry");
  return {
    pathClass,
    country: typeof c === "string" && /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : "",
    refHost: refHostOf(request.headers.get("referer"), url.hostname),
    agent: agentOf(request.headers.get("user-agent")),
  };
}

/** Whether `response` to `request` is a page view: a GET of the page itself (not a prefetch or prerender, not a fetch
 * from a script), answered with the page (200, HTML) or a revalidation of it (304). */
export function isView(request: ViewRequest, response: ViewResponse): boolean {
  if (request.method !== "GET") return false;
  if (response.status !== 200 && response.status !== 304) return false;
  if (response.status === 200 && !/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return false;
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""} ${request.headers.get("x-purpose") ?? ""}`;
  if (/prefetch|prerender|preview/i.test(purpose)) return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";
  return /text\/html/i.test(request.headers.get("accept") ?? "");
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** The day's visitor hash: 16 hex digits of SHA-256(salt, ip, user agent), the same for one browser on one day only.
 * The salt is the day's (newSalt), kept only for that day: without it, the hash can't be recomputed or linked. */
export async function visitorHash(salt: string, ip: string, ua: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error("visitorHash: the salt is 32 random bytes, as hex (newSalt)");
  const data = new TextEncoder().encode(`${salt}\n${ip}\n${ua}`);
  return hex(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
}

/** A new day's salt: 32 random bytes, as hex. */
export const newSalt = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));
/** The UTC day a salt and a view belong to, "YYYY-MM-DD". */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** How long the hosted site keeps a day's salt (Workers KV's expirationTtl, seconds): its day, and a little after. */
export const SALT_TTL_S = 26 * 3600;
