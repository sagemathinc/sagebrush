// The site's Content-Security-Policy, for every HTML page: a second line of
// defense (design/security.md).  Were something ever to slip markup past
// web/safe-html.ts and the other checks, no script it brought could run:
// scripts only from this site, and a page's own inline scripts by their
// hashes; no plugins, no <base>, no forms; and Cloudflare's Web Analytics
// beacon, which the site's host adds to its pages.  (Images and fetches may
// come from elsewhere: Markdown's images, ?doc= boards.  The Python worker,
// which compiles to JavaScript, has its own response and so its own policy:
// none.)  Static pages get it from _headers (web/csp.ts writes them), the
// atlas's pages, which its Worker renders, from web/atlas/server.ts.
export function pagePolicy(scriptHashes: string[] = []): string {
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com", ...scriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: https: http:",
    "worker-src 'self' blob:",
    "media-src 'self' data: blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "manifest-src 'self'",
  ].join("; ");
}
