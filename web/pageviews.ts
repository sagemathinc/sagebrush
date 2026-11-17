// Page views, counted on the server: the site's Worker (Workers Analytics Engine) and the self-hosted server (SQLite)
// both count with these pure functions, so the two count the same things the same way. Nothing here runs in the
// browser, sets a cookie or reads an account: a view is its page's section (never a path anyone can type, an id, a
// query or a hash), the country the request came from, the referring site's host, whether it looks like a bot, and a
// daily salted hash of the IP and User-Agent, for estimating visitors.
// The salt is the caller's. Malformed salts are refused; randomness and daily rotation are caller obligations (newSalt
// makes a random one, dayOf names the UTC day). Retention too: the intended caller integration is Workers KV with the
// suggested SALT_TTL_S on the hosted site, and memory only on the self-hosted server; this module does neither. The same inputs and salt give the same hash; the hash estimates visitors, it doesn't
// count them exactly (one browser behind two addresses counts twice, two people behind one address and browser once).
//   classify(request, known?)      the view's fields, or null for a page that isn't counted
//   isView(request, response)      whether this response looks like a page someone navigated to
//   visitorHash(salt, ip, ua)      a salted hash of the IP and User-Agent, for estimating visitors
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
  /** "/", "docs", "blog", "articles" or "s"; with `known` pages, "<section>:<name>" for one of them, "<section>:other" else */
  pathClass: string;
  /** two letters, from Cloudflare (cf.country, or CF-IPCountry behind it); "" when unknown */
  country: string;
  /** the referring page's host; "self" for this site; "" for none */
  refHost: string;
  agent: "human" | "bot";
}

/** The site's own page names, by section, when a caller wants per-page counts: a name not among them is "other",
 * so a request for /docs/<anything> can never put a string of its own into the counts. */
export type KnownPages = Partial<Record<"docs" | "blog" | "articles", ReadonlySet<string>>>;

/** The class of a counted page's path, or null when the path isn't counted (/gh/, assets, the API, anything else):
 * its section, and with `known` pages, which of them ("<section>:<name>") or "<section>:other". */
export function pathClassOf(pathname: string, known?: KnownPages): string | null {
  const p = pathname.replace(/\/index\.html$/, "/");
  if (p === "/") return "/";
  if (p === "/s" || p.startsWith("/s/")) return "s";
  for (const section of ["docs", "blog", "articles"] as const) {
    if (p !== `/${section}` && !p.startsWith(`/${section}/`)) continue;
    const names = known?.[section];
    if (!names) return section;
    const name = p.slice(section.length + 2).split("/")[0].replace(/\.html$/, "");
    return name === "" ? section : names.has(name) ? `${section}:${name}` : `${section}:other`;
  }
  return null;
}

/** The referring page's host: "" for none (or one that isn't a web page's), "self" for `ownHost`; else its host name,
 * lowercase, without a port, at most 253 characters (a DNS name's longest). */
export function refHostOf(referer: string | null, ownHost: string): string {
  if (!referer) return "";
  let u: URL;
  try {
    u = new URL(referer);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const host = u.hostname.toLowerCase().slice(0, 253);
  return host === ownHost.toLowerCase().replace(/:\d+$/, "") ? "self" : host;
}

// (a crawler, a link-preview fetcher, a monitor or a script: by its User-Agent; none at all is a script too)
const BOT = /bot|crawl|spider|slurp|preview|monitor|uptime|headless|phantom|lighthouse|facebookexternalhit|embedly|curl|wget|python|httpie|go-http|java\/|okhttp|axios|node-fetch|undici|libwww|scrapy/i;
export const agentOf = (ua: string | null): "human" | "bot" => (!ua || BOT.test(ua) ? "bot" : "human");

/** A counted page's fields (not yet its visitor), or null when the request's path isn't counted. */
export function classify(request: ViewRequest, known?: KnownPages): ViewFields | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const pathClass = pathClassOf(url.pathname, known);
  if (!pathClass) return null;
  const c = request.cf?.country ?? request.headers.get("cf-ipcountry");
  return {
    pathClass,
    country: typeof c === "string" && /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : "",
    refHost: refHostOf(request.headers.get("referer"), url.hostname),
    agent: agentOf(request.headers.get("user-agent")),
  };
}

/** Whether `response` to `request` looks like a page view: a GET answered with an HTML page (200) or a revalidation of
 * one (304). A request that says what it is decides by its headers: Sec-Purpose/Purpose naming a prefetch or prerender
 * is not a view, and Sec-Fetch-Dest must be "document" (so a script's fetch or a frame that says so is not one). A
 * request without Sec-Fetch-Dest is judged by a navigation heuristic, an Accept that includes text/html. */
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

/** A daily salted hash of the IP and User-Agent, for estimating visitors: 16 hex digits of SHA-256(salt, ip, user
 * agent). Matching inputs and salt give the same hash. Malformed salts (not 64 lowercase hex digits) are refused;
 * randomness and daily rotation are caller obligations. */
export async function visitorHash(salt: string, ip: string, ua: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error("visitorHash: a malformed salt: 64 lowercase hex digits, a fresh random one per UTC day (newSalt)");
  const data = new TextEncoder().encode(`${salt}\n${ip}\n${ua}`);
  return hex(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
}

/** A new day's salt: 32 random bytes, as hex. */
export const newSalt = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));
/** The UTC day a salt and a view belong to, "YYYY-MM-DD". */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** A suggested lifetime for a day's salt, in seconds (for the hosted site's intended Workers KV expirationTtl): its day
 * and a little after. Nothing here applies it. */
export const SALT_TTL_S = 26 * 3600;
