import { constants, openSync, closeSync, fstatSync, readSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MIME } from '../../web/preview/worker.mjs';

export const MAX_OBJECTS = 3000;
export const MAX_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const BANNER = '<aside role="status" style="position:fixed;top:0;right:0;z-index:2147483647;background:#ffe08a;color:#111;padding:6px 12px;font:14px sans-serif;pointer-events:none">PREVIEW, not production</aside>';
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

export function prepare(dir, host, mocks) {
  const files = new Map();
  let totalBytes = 0;
  function add(path, bytes, type = MIME[path.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream') {
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Preview final object exceeds 8 MiB');
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
      if (path === 'sw.js' || path === 'preview-config.js') continue; // Replaced below, never uploaded from disk.
      let bytes = readBounded(join(dir, path), MAX_FILE_BYTES);
      if (path.endsWith('.html') && !/^(engine|runner|frame)\//.test(path)) {
        const html = bytes.toString('utf8');
        if (!/<head\b[^>]*>/i.test(html) || !/<body\b[^>]*>/i.test(html)) throw new Error('Preview page lacks head/body');
        bytes = Buffer.from(html.replace(/<head\b[^>]*>/i, m => m + '<script src="/preview-config.js"></script>')
          .replace(/<body\b[^>]*>/i, m => m + BANNER));
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
      rule = { pattern: line.trim(), csp: null }; rules.push(rule);
    } else {
      const match = /^\s+Content-Security-Policy:\s*(.+)$/i.exec(line);
      if (match && rule) rule.csp = match[1];
    }
  }
  for (const [path] of [...files]) {
    if (!path.endsWith('.html') && path !== 'shell/worker-boot.js') continue;
    const url = '/' + path;
    const policies = rules.filter(r => r.csp && (r.pattern === url || (r.pattern.endsWith('*') && url.startsWith(r.pattern.slice(0, -1)))));
    if (policies.length !== 1) throw new Error('Preview HTML/script lacks exactly one built CSP');
    const csp = policies[0].csp.replace(/connect-src [^;]+/, directive =>
      directive.includes("'none'") ? directive : "connect-src 'self' data: blob:")
      .replace(' https://static.cloudflareinsights.com', '');
    const bytes = Buffer.from(JSON.stringify({ csp }));
    if (bytes.length > 32768) throw new Error('Preview policy exceeds 32 KiB');
    add(`.preview/headers/${path}.json`, bytes, MIME.json);
  }
  const config = `globalThis.__SAGEBRUSH_PREVIEW__=Object.freeze(${JSON.stringify({ host, mocks })});\n`;
  add('preview-config.js', Buffer.from(config), MIME.js);
  add('sw.js', Buffer.from(NO_SERVICE_WORKER), MIME.js);
  // The uploader uses only these exact, counted and hashed buffers. No path is reopened.
  return { files, totalBytes };
}
