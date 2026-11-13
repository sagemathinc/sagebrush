import { constants, openSync, closeSync, fstatSync, readSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MIME } from '../../web/preview/worker.mjs';
import { installPreviewNotice } from '../../web/preview/notice.js';

export const MAX_OBJECTS = 3000;
export const MAX_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_HTML_BYTES = 8 * 1024 * 1024;
const BANNER = '<div id="sb-preview-notice"></div>';
// No fetch handler: a preview never caches a previous branch's shell.
const NO_SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));\n`;

// One bounded, no-follow read. A concurrent grow cannot cause an unbounded allocation.
function readBounded(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`Preview source must be a regular file at most ${limit} bytes`);
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > stat.size) throw new Error('Preview source grew during preparation');
    return Buffer.from(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}

// A file's Cache-Control when the build's _headers gives none: what production's static assets send.
export const DEFAULT_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
// The opt-in debugging mode's (SAGEBRUSH_PREVIEW_NO_STORE=1): nothing cached, no service worker.
export const NO_STORE = 'no-store, no-transform';
// Directive tokens only: the Worker sends exactly this value, so nothing else may reach a header.
export const CACHE_CONTROL = /^[a-z][a-z0-9-]*(=[0-9]{1,10})?(, [a-z][a-z0-9-]*(=[0-9]{1,10})?){0,7}$/;

// The Cache-Control _headers gives a request path, as production applies it: the exact rule, else the longest
// matching wildcard; none, the default.
export function cacheControlFor(rules, paths) {
  let best = null, rank = -1;
  for (const r of rules) {
    if (!r.cacheControl) continue;
    for (const url of paths) {
      const n = r.pattern === url ? 1e6 : r.pattern.endsWith('*') && url.startsWith(r.pattern.slice(0, -1)) ? r.pattern.length : -1;
      if (n > rank) { rank = n; best = r.cacheControl; }
    }
  }
  return best ?? DEFAULT_CACHE_CONTROL;
}

// The real service worker, its digest table made true of what this preview serves: an entry whose page the
// publisher changed (the notice and config injected, the narrowed policy) gets that page's SHA-256, size and policy,
// so the worker keeps and serves exactly the published bytes; any other entry is unchanged.
export function previewServiceWorker(source, changed) {
  const text = source.toString('utf8');
  const m = /\nconst DIGESTS = (\{.*\});\n/.exec(text);
  if (!m) throw new Error('Preview sw.js lacks its DIGESTS table');
  const digests = JSON.parse(m[1]);
  for (const [key, entry] of Object.entries(digests)) {
    const path = key === './' ? 'index.html' : key.endsWith('/') ? key + 'index.html' : key;
    const c = changed.get(path);
    if (!c) continue;
    if (!entry || typeof entry !== 'object' || typeof entry.headers !== 'object') throw new Error('Preview sw.js has a malformed DIGESTS entry');
    entry.sha256 = c.sha256;
    entry.size = c.size;
    entry.headers = { ...entry.headers, 'Content-Security-Policy': c.csp };
  }
  return Buffer.from(text.slice(0, m.index) + '\nconst DIGESTS = ' + JSON.stringify(digests) + ';\n' + text.slice(m.index + m[0].length));
}

export function prepare(dir, host, mocks, source = { branch: 'unknown', commit: 'unknown', dirty: false }, options = {}) {
  const noStore = options.noStore === true;
  const files = new Map();
  const injected = new Set();
  let builtWorker = null;
  let totalBytes = 0;
  function add(path, bytes, type = MIME[path.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream') {
    if (path.endsWith('.html') && bytes.length > MAX_HTML_BYTES) throw new Error('Preview final HTML exceeds 8 MiB');
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Preview final object exceeds 16 MiB');
    const nextBytes = totalBytes - (files.get(path)?.bytes.length ?? 0) + bytes.length;
    if (files.size + Number(!files.has(path)) > MAX_OBJECTS || nextBytes > MAX_BYTES) throw new Error('Preview final manifest exceeds 3000 objects or 200 MiB');
    files.set(path, Object.freeze({ bytes, type, sha256: createHash('sha256').update(bytes).digest('hex') }));
    totalBytes = nextBytes;
  }
  function walk(rel = '', depth = 0) {
    if (depth > 32) throw new Error('Preview file tree exceeds 32 directory levels');
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) throw new Error('Hidden files are forbidden in preview output');
      if (e.name === '_headers' || e.name === '_redirects') continue;
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(e.name)) throw new Error('Unsupported preview output filename');
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path, depth + 1); continue; }
      if (!e.isFile()) throw new Error('Preview output contains a symlink or special file');
      if (path === 'preview-config.js') continue; // Replaced below, never uploaded from disk.
      // (the build's service worker: published with its digests made true of this preview, below, never as read)
      if (path === 'sw.js') { builtWorker = readBounded(join(dir, path), MAX_FILE_BYTES); continue; }
      let bytes = readBounded(join(dir, path), path.endsWith('.html') ? MAX_HTML_BYTES : MAX_FILE_BYTES);
      if (path.endsWith('.html') && !/^(engine|runner|frame)\//.test(path)) {
        const html = bytes.toString('utf8');
        if (!/<head\b[^>]*>/i.test(html) || !/<body\b[^>]*>/i.test(html)) throw new Error('Preview page lacks head/body');
        bytes = Buffer.from(html.replace(/<head\b[^>]*>/i, m => m + '<script src="/preview-config.js"></script>')
          .replace(/<body\b[^>]*>/i, m => m + BANNER));
        injected.add(path);
      }
      add(path, bytes);
    }
  }
  walk();
  if (!files.has('index.html')) throw new Error('Preview build has no index.html');
  const rules = [];
  let rule;
  const headerFile = readBounded(join(dir, '_headers'), 64 * 1024).toString('utf8');
  for (const line of headerFile.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('/')) {
      if (rules.length >= 200) throw new Error('Preview _headers exceeds 200 rules');
      rule = { pattern: line.trim(), csp: null, cacheControl: null }; rules.push(rule);
    } else {
      const match = /^\s+Content-Security-Policy:\s*(.+)$/i.exec(line);
      if (match && rule) rule.csp = match[1];
      const cache = /^\s+Cache-Control:\s*(.+?)\s*$/i.exec(line);
      if (cache && rule) {
        if (!CACHE_CONTROL.test(cache[1])) throw new Error('Preview _headers has an unsupported Cache-Control value');
        rule.cacheControl = cache[1];
      }
    }
  }
  const changed = new Map();
  for (const [path] of [...files]) {
    if (!path.endsWith('.html') && path !== 'shell/worker-boot.js') continue;
    const url = '/' + path;
    const policies = rules.filter(r => r.csp && (r.pattern === url || (r.pattern.endsWith('*') && url.startsWith(r.pattern.slice(0, -1)))));
    if (policies.length !== 1) throw new Error('Preview HTML/script lacks exactly one built CSP');
    const csp = policies[0].csp.replace(/connect-src [^;]+/, directive =>
      // (a preview page reaches only its own origin, and the agent pairing's loopback socket to sagebrush-mcp: no other)
      directive.includes("'none'") ? directive : "connect-src 'self' data: blob: ws://127.0.0.1:* ws://localhost:*");
    // (a page says who may frame it, security audit G-1: the Worker's X-Frame-Options follows from it)
    if (path.endsWith('.html') && !/(^|;)\s*frame-ancestors\s/.test(csp)) throw new Error('Preview HTML policy lacks frame-ancestors');
    const bytes = Buffer.from(JSON.stringify({ csp }));
    if (bytes.length > 32768) throw new Error('Preview policy exceeds 32 KiB');
    add(`.preview/headers/${path}.json`, bytes, MIME.json);
    if (injected.has(path)) changed.set(path, { sha256: files.get(path).sha256, size: files.get(path).bytes.length, csp });
  }
  const config = `globalThis.__SAGEBRUSH_PREVIEW__=Object.freeze(${JSON.stringify({ host, mocks, source })});\n(${installPreviewNotice.toString()})(globalThis.__SAGEBRUSH_PREVIEW__);\n`;
  add('preview-config.js', Buffer.from(config), MIME.js);
  // (production's service worker, unless this is the no-store debugging mode or the build has none)
  add('sw.js', noStore || !builtWorker ? Buffer.from(NO_SERVICE_WORKER) : previewServiceWorker(builtWorker, changed), MIME.js);
  // Each file's Cache-Control, as production sends it (an HTML file under its own path and its directory's), sent by
  // the Worker from the object's signed metadata; the no-store mode's for every file.
  for (const [path, file] of [...files]) {
    const urls = ['/' + path, ...(path === 'index.html' ? ['/'] : path.endsWith('/index.html') ? ['/' + path.slice(0, -'index.html'.length)] : [])];
    files.set(path, Object.freeze({ ...file, cacheControl: noStore ? NO_STORE : cacheControlFor(rules, urls) }));
  }
  // The uploader uses only these exact, counted and hashed buffers. No path is reopened.
  return { files, totalBytes };
}
