import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { MIME } from '../../web/preview/worker.mjs';

const BANNER = '<aside role="status" style="position:fixed;top:0;right:0;z-index:2147483647;background:#ffe08a;color:#111;padding:6px 12px;font:14px sans-serif;pointer-events:none">PREVIEW, not production</aside>';
// The preview must never keep a previous branch's shell in a service worker cache.
// No fetch handler: all resources go through the preview Worker on every request.
const NO_SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));\n`;

export function prepare(dir, host, mocks) {
  const files = new Map();
  let total = 0;
  function walk(rel = '', depth = 0) {
    if (depth > 32) throw new Error('Preview file tree exceeds 32 directory levels');
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) throw new Error('Hidden files are forbidden in preview output');
      if (e.name === '_headers' || e.name === '_redirects') continue;
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(e.name)) throw new Error('Unsupported preview output filename');
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path, depth + 1); continue; }
      if (!e.isFile()) throw new Error('Preview output contains a symlink or special file');
      const stat = lstatSync(join(dir, path));
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('Preview file exceeds 128 MiB or changed type');
      if (path.endsWith('.html') && stat.size > 8 * 1024 * 1024) throw new Error('Preview HTML exceeds 8 MiB');
      total += stat.size;
      if (files.size >= 20000 || total > 1024 * 1024 * 1024) throw new Error('Preview exceeds 20000 files or 1 GiB');
      files.set(path, { path, size: stat.size });
    }
  }
  walk();
  if (!files.has('index.html')) throw new Error('Preview build has no index.html');
  const rules = [];
  let rule;
  const headerStat = lstatSync(join(dir, '_headers'));
  if (!headerStat.isFile() || headerStat.size > 1024 * 1024) throw new Error('Preview _headers must be a regular file at most 1 MiB');
  const headerFile = readFileSync(join(dir, '_headers'), 'utf8');
  if (headerFile.length > 1024 * 1024) throw new Error('Preview _headers exceeds 1 MiB');
  for (const line of headerFile.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('/')) { rule = { pattern: line.trim(), csp: null }; rules.push(rule); }
    else {
      const match = /^\s+Content-Security-Policy:\s*(.+)$/i.exec(line);
      if (match && rule) rule.csp = match[1];
    }
  }
  for (const [path] of [...files]) {
    if (!path.endsWith('.html') && path !== 'shell/worker-boot.js') continue;
    const url = '/' + path;
    const policies = rules.filter(r => r.csp && (r.pattern === url || (r.pattern.endsWith('*') && url.startsWith(r.pattern.slice(0, -1)))));
    if (policies.length !== 1) throw new Error('Preview HTML/script lacks exactly one built CSP');
    // A static preview cannot contact production/auth services. Keep the runner's
    // stricter connect-src 'none'; narrow only the ordinary page/frame policy.
    const csp = policies[0].csp.replace(/connect-src [^;]+/, directive =>
      directive.includes("'none'") ? directive : "connect-src 'self' data: blob:")
      .replace(' https://static.cloudflareinsights.com', '');
    const bytes = Buffer.from(JSON.stringify({ csp }));
    if (bytes.length > 32768) throw new Error('Preview policy exceeds 32 KiB');
    files.set(`.preview/headers/${path}.json`, { bytes, type: MIME.json });
  }
  const config = `globalThis.__SAGEBRUSH_PREVIEW__=Object.freeze(${JSON.stringify({ host, mocks })});\n`;
  files.set('preview-config.js', { bytes: Buffer.from(config), type: MIME.js });
  files.set('sw.js', { bytes: Buffer.from(NO_SERVICE_WORKER), type: MIME.js });
  // Build metadata and dotfiles are not public routes, including the policy sidecars.
  return {
    files,
    bytes(path, file) {
      let bytes = file.bytes ?? readFileSync(join(dir, file.path));
      if (path.endsWith('.html') && !/^(engine|runner|frame)\//.test(path)) {
        const html = bytes.toString('utf8');
        if (!/<head\b[^>]*>/i.test(html) || !/<body\b[^>]*>/i.test(html)) throw new Error('Preview page lacks head/body');
        bytes = Buffer.from(html.replace(/<head\b[^>]*>/i, m => m + '<script src="/preview-config.js"></script>')
          .replace(/<body\b[^>]*>/i, m => m + BANNER));
      }
      return bytes;
    },
    type(path, file) { return file.type ?? MIME[path.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream'; },
  };
}
