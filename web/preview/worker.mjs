// No account APIs, outbound fetches, secrets, or writable storage operations.
export const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const MIME = Object.freeze(Object.assign(Object.create(null), {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  webmanifest: 'application/manifest+json', pdf: 'application/pdf', tzif: 'application/octet-stream',
}));
export const DENY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// (a page's X-Frame-Options, for browsers without frame-ancestors: its policy's, as web/csp-policy.mts frameOptions
// gives it to _headers; none for the embeddable frame's *, which the header would forbid)
export function frameOptions(policy) {
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*?)\s*(?:;|$)/.exec(policy)?.[1];
  return fa === "'none'" ? 'DENY' : fa === "'self'" ? 'SAMEORIGIN' : null;
}
export const SCRIPT_POLICY = "default-src 'none'; script-src 'self' blob: 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'";

export function baseHeaders() {
  return new Headers({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store, no-transform',
    'Access-Control-Allow-Origin': '*', // Opaque-origin runner fetches, as on sagebrush.space.
    'Content-Security-Policy': DENY,
  });
}
function error(status) {
  const h = baseHeaders();
  h.set('Content-Type', MIME.txt);
  return new Response(status === 404 ? 'Preview file not found\n' : 'Preview unavailable\n', { status, headers: h });
}

// Decode once, then reject separators, dot components and hidden/control paths.
// All R2 lookups are formed from a validated host prefix and validated segments.
export function route(input) {
  const u = new URL(input);
  const suffix = '.sagebrush.cloud';
  if (u.protocol !== 'https:' || u.port || !u.hostname.endsWith(suffix)) return null;
  const name = u.hostname.slice(0, -suffix.length);
  if (!NAME.test(name)) return null;
  const parts = u.pathname.split('/').slice(1);
  if (parts.at(-1) === '') parts[parts.length - 1] = 'index.html';
  const decoded = [];
  for (const part of parts) {
    let p;
    try { p = decodeURIComponent(part); } catch { return null; }
    if (!p || p.startsWith('.') || /[\\/\x00-\x1f\x7f%?#]/.test(p)) return null;
    decoded.push(p);
  }
  const path = decoded.join('/');
  if (path === '_headers' || path === '_redirects') return null;
  return { name, path };
}

export default {
  async fetch(request, env) {
    const target = route(request.url);
    if (!target) return error(404);
    if (!['GET', 'HEAD'].includes(request.method)) return error(405);
    const { name, path } = target;
    try {
      // Exact file or a directory index only. Missing API routes never fall back to the app.
      let key = path;
      let object = await env.PREVIEWS.get(`${name}/${key}`);
      if (!object && !path.split('/').at(-1).includes('.')) {
        key = `${path}/index.html`;
        object = await env.PREVIEWS.get(`${name}/${key}`);
      }
      if (!object) return error(404);
      const headers = baseHeaders();
      const extension = key.split('.').at(-1).toLowerCase();
      headers.set('Content-Type', MIME[extension] ?? 'application/octet-stream');
      if (extension === 'js' || extension === 'mjs') headers.set('Content-Security-Policy', SCRIPT_POLICY);
      if (extension === 'html' || key === 'shell/worker-boot.js') {
        const policy = await env.PREVIEWS.get(`${name}/.preview/headers/${key}.json`);
        if (!policy || policy.size > 32768) return error(503);
        const { csp } = await policy.json();
        if (typeof csp !== 'string' || !csp.includes('default-src ') || /[\r\n]/.test(csp)) return error(503);
        headers.set('Content-Security-Policy', csp);
        if (extension === 'html' && frameOptions(csp)) headers.set('X-Frame-Options', frameOptions(csp));
      }
      headers.set('Content-Length', String(object.size));
      headers.set('ETag', object.httpEtag);
      // No R2 httpMetadata is copied: in particular no cookies or arbitrary response headers.
      if (request.method === 'HEAD') await object.body.cancel();
      return new Response(request.method === 'HEAD' ? null : object.body, { headers });
    } catch {
      return error(503);
    }
  },
};
