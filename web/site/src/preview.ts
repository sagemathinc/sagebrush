// A shared collection's page, /s/<id> and /s/<id>@<version>, with its link
// preview (share-ux-plan r2 §6.3): for a live share, the static page
// (web/share-client/view.html, whose fixed tags are the generic card) with
// the share's title set in its fixed <title> and og/twitter elements, and
// canonical URLs from the site's configured origin; for anything else, the
// generic card: the static page with, where the origin is configured, its
// image made absolute and its og:url (the page of no share) removed, the same
// bytes for every id that isn't live (#171's review, UI-D1: preview fetchers
// show no image for a relative one).  The title is set as text or as an
// attribute (both escaped by HTMLRewriter), never written into HTML.
//
// Visibility: every committed collection today is for anyone with the link,
// so a live share's title reveals nothing its link doesn't; an uncommitted
// draft has no latest version and gets the generic card.  A future private
// or signed-in-only share mode needs its own gate in sharePreview (#171's
// review, astra3).
import { sharePreview } from "../../share/server.ts";

export const SHARE_PAGE = /^\/s\/([a-z2-7]{12})(?:@([0-9a-f]{8,64}))?\/?$/;

type Env = { ASSETS: { fetch(r: Request): Promise<Response> }; SITE_ORIGIN?: string };
type Preview = (env: any, id: string, at: string | null) => Promise<{ title: string; version: string } | null>;

/** The /s/ page for `request`, or null if `url` isn't one. */
export async function handleSharePage(request: Request, url: URL, env: Env, preview: Preview = sharePreview): Promise<Response | null> {
  const m = SHARE_PAGE.exec(url.pathname);
  if (!m) return null;
  const asset = new URL("/s/", url);
  const origin = env.SITE_ORIGIN?.replace(/\/+$/, "") || null;
  // (only GET and HEAD are rewritten; anything else is the static page as the asset serves it)
  if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(new Request(asset, request));
  const p = await preview(env, m[1], m[2] ?? null).catch(() => null);
  // (without an origin, a share that isn't live is the static page as the asset serves it: the same
  // bytes and headers as an id that never existed)
  if (!p && !origin) return env.ASSETS.fetch(new Request(asset, request));
  // (without the request's conditional headers: a 304 for the static page must never stand in for a
  // rewritten one)
  const page = await env.ASSETS.fetch(new Request(asset, { method: "GET" }));
  if (page.status !== 200) return env.ASSETS.fetch(new Request(asset, request));
  return card(request.method, page, origin, p ? { title: p.title, url: `/s/${m[1]}${m[2] ? "@" + p.version : ""}` } : null);
}

/**
 * The page's card, from the static page: the image absolute (where the origin is known), and, for a
 * live share, its title and canonical URL; for anything else, no og:url.  One function for both, so a
 * share that isn't live gets the same bytes whatever its id: deleted, private or never existing.
 */
function card(method: string, page: Response, origin: string | null, live: { title: string; url: string } | null): Response {
  // (setAttribute escapes only the quote: &, < and > are escaped first, so the value reads back exactly)
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const content = (v: string) => ({ element: (e: any) => e.setAttribute("content", attr(v)) });
  let r = new HTMLRewriter();
  if (origin) r = r.on('meta[property="og:image"]', content(`${origin}/s/og.png`)).on('meta[name="twitter:image"]', content(`${origin}/s/og.png`));
  if (live) {
    r = r
      .on("head > title", { element: (e: any) => e.setInnerContent(`${live.title} — Sagebrush`) })
      .on('meta[property="og:title"]', content(live.title))
      .on('meta[name="twitter:title"]', content(live.title));
  }
  if (live && origin) r = r.on('meta[property="og:url"]', content(origin + live.url));
  else r = r.on('meta[property="og:url"]', { element: (e: any) => e.remove() });
  const headers = new Headers(page.headers);
  for (const h of ["content-length", "etag", "last-modified"]) headers.delete(h);
  // (never cached: a live share's title can change or go, and a share that isn't live now can be with
  // its next version, so the generic card is as much D1's answer as the title)
  headers.set("cache-control", "no-store");
  const out = r.transform(new Response(page.body, { status: 200, headers }));
  return method === "HEAD" ? new Response(null, { status: 200, headers: out.headers }) : out;
}
