// A shared collection's page, /s/<id> and /s/<id>@<version>, with its link
// preview (share-ux-plan r2 §6.3): for a live share, the static page
// (web/share-client/view.html, whose fixed tags are the generic card) with
// the share's title set in its fixed <title> and og/twitter elements, and
// canonical URLs from the site's configured origin; for anything else, the
// static page exactly as the asset serves it.  The title is set as text or as
// an attribute (both escaped by HTMLRewriter), never written into HTML.
import { sharePreview } from "../../share/server.ts";

export const SHARE_PAGE = /^\/s\/([a-z2-7]{12})(?:@([0-9a-f]{8,64}))?\/?$/;

type Env = { ASSETS: { fetch(r: Request): Promise<Response> }; SITE_ORIGIN?: string };
type Preview = (env: any, id: string, at: string | null) => Promise<{ title: string; version: string } | null>;

/** The /s/ page for `request`, or null if `url` isn't one. */
export async function handleSharePage(request: Request, url: URL, env: Env, preview: Preview = sharePreview): Promise<Response | null> {
  const m = SHARE_PAGE.exec(url.pathname);
  if (!m) return null;
  const asset = new URL("/s/", url);
  // (only GET and HEAD are rewritten; anything else, and every share that
  // isn't live, is the static page as the asset serves it: the same bytes
  // and headers as an id that never existed)
  const p = request.method === "GET" || request.method === "HEAD" ? await preview(env, m[1], m[2] ?? null).catch(() => null) : null;
  if (!p) return env.ASSETS.fetch(new Request(asset, request));
  // (without the request's conditional headers: a 304 for the static page
  // must never stand in for a page with this share's title)
  const page = await env.ASSETS.fetch(new Request(asset, { method: "GET" }));
  if (page.status !== 200) return env.ASSETS.fetch(new Request(asset, request));
  const origin = env.SITE_ORIGIN?.replace(/\/+$/, "");
  const canonical = origin ? `${origin}/s/${m[1]}${m[2] ? "@" + p.version : ""}` : null;
  const image = origin ? `${origin}/s/og.png` : null;
  // (setAttribute escapes only the quote: &, < and > are escaped first, so the value reads back exactly)
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const content = (v: string) => ({ element: (e: any) => e.setAttribute("content", attr(v)) });
  let r = new HTMLRewriter()
    .on("head > title", { element: (e: any) => e.setInnerContent(`${p.title} — Sagebrush`) })
    .on('meta[property="og:title"]', content(p.title))
    .on('meta[name="twitter:title"]', content(p.title));
  if (canonical) r = r.on('meta[property="og:url"]', content(canonical));
  else r = r.on('meta[property="og:url"]', { element: (e: any) => e.remove() });
  if (image) r = r.on('meta[property="og:image"]', content(image)).on('meta[name="twitter:image"]', content(image));
  const headers = new Headers(page.headers);
  for (const h of ["content-length", "etag", "last-modified"]) headers.delete(h);
  headers.set("cache-control", "no-store");
  const out = r.transform(new Response(page.body, { status: 200, headers }));
  return request.method === "HEAD" ? new Response(null, { status: 200, headers: out.headers }) : out;
}
