// Deferred runtime checks: run on an authorized VM/CI, not the shared project.
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, { route, MIME } from './worker.mjs';
import * as deployEntry from './entry.mjs';
import { mockEnabled } from './mock.js';
import { checkNoticeBrowser } from './browser-notice.mjs';
import { prepare, MAX_OBJECTS, MAX_BYTES, MAX_FILE_BYTES, MAX_HTML_BYTES } from '../../scripts/preview/prepare.mjs';
import { R2, MAX_PREVIOUS_OBJECTS } from '../../scripts/preview/r2.mjs';
import { upload, UPLOAD_CONCURRENCY } from '../../scripts/preview/upload.mjs';

function bucket(entries) {
  const calls = [];
  return { calls, async get(key) {
    calls.push(key);
    const value = entries[key];
    if (value === undefined) return null;
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    return { body: new Response(bytes).body, size: bytes.length, httpEtag: '"fixture"', json: async () => JSON.parse(bytes) };
  } };
}
test('host and path validation cannot cross preview prefixes', () => {
  for (const host of ['sagebrush.cloud', 'a.b.sagebrush.cloud', '-a.sagebrush.cloud', 'a_b.sagebrush.cloud', 'a.sagebrush.cloud.evil.test']) {
    assert.equal(route(`https://${host}/`), null);
  }
  for (const path of ['/a%2fb', '/a%5cb', '/a%00b', '/%252e%252e/secret', '/.preview/headers/index.html.json', '/_headers', '/%ff', '//bad']) {
    assert.equal(route(`https://latex.sagebrush.cloud${path}`), null);
  }
  assert.deepEqual(route('https://latex.sagebrush.cloud/?tex=id'), { name: 'latex', path: 'index.html' });
  assert.deepEqual(route('https://latex.sagebrush.cloud/runner/'), { name: 'latex', path: 'runner/index.html' });
});
test('Worker headers, policy, HEAD and no cookie/metadata reflection', async () => {
  const store = bucket({ 'latex/index.html': '<html></html>', 'latex/.preview/headers/index.html.json': { csp: "default-src 'self'; script-src 'self'" } });
  const response = await worker.fetch(new Request('https://latex.sagebrush.cloud/'), { PREVIEWS: store });
  assert.equal(response.status, 200);
  for (const [name, value] of Object.entries({ 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'content-type': MIME.html })) assert.equal(response.headers.get(name), value);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'");
  assert.equal(await response.text(), '<html></html>');
  const head = await worker.fetch(new Request('https://latex.sagebrush.cloud/', { method: 'HEAD' }), { PREVIEWS: store });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
test("a page's X-Frame-Options is its policy's frame-ancestors (security audit G-1): DENY, SAMEORIGIN, none for *", async () => {
  const page = (csp) => ({ 'agents/x/index.html': '<html></html>', 'agents/.preview/headers/x/index.html.json': { csp } });
  for (const [fa, want] of [["'none'", 'DENY'], ["'self'", 'SAMEORIGIN'], ['*', null]]) {
    const csp = `default-src 'self'; script-src 'self'; frame-ancestors ${fa}`;
    const r = await worker.fetch(new Request('https://agents.sagebrush.cloud/x/'), { PREVIEWS: bucket(page(csp)) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-security-policy'), csp);
    assert.equal(r.headers.get('x-frame-options'), want, `frame-ancestors ${fa}`);
  }
  // (a policy without frame-ancestors gets none either: _headers, test-frame-ancestors.mjs, is where that is refused)
  const r = await worker.fetch(new Request('https://agents.sagebrush.cloud/x/'), { PREVIEWS: bucket(page("default-src 'self'")) });
  assert.equal(r.headers.get('x-frame-options'), null);
  // (the Worker's twin of web/csp-policy.mts frameOptions: the same answer for every shape)
  const { frameOptions: site } = await import('../csp-policy.mts');
  const { frameOptions: twin } = await import('./worker.mjs');
  for (const p of ["frame-ancestors 'none'", "a; frame-ancestors 'self'", "a; frame-ancestors 'self'; b", "frame-ancestors *", "frame-ancestors 'self' https://x.example", "a", "a; frame-ancestors  'none' ", "xframe-ancestors 'none'"]) assert.equal(twin(p), site(p), p);
});

test("the publisher's page policies keep web/csp.ts's framing, and the Worker serves them so (G-1)", async () => {
  // (the agents host's HTML policy is what prepare writes, from the build's _headers: through both, as published)
  // (web/csp.ts is TypeScript that node runs as CommonJS: bun writes its _headers, as web/build.ts does)
  const headersFor = d => execFileSync('bun', ['-e', `process.stdout.write((await import(${JSON.stringify(join(import.meta.dirname, '..', 'csp.ts'))})).headersFor(${JSON.stringify(d)}))`], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'preview-frame-'));
  try {
    for (const p of ['index.html', 'agents/index.html', 'frame/board/index.html']) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>');
    }
    writeFileSync(join(dir, '_headers'), headersFor(dir));
    const output = prepare(dir, 'agents.sagebrush.cloud', []);
    const entries = {};
    for (const [p, f] of output.files) entries[`agents/${p}`] = f.bytes.toString('utf8');
    for (const [path, fa, xfo] of [['/', "'self'", 'SAMEORIGIN'], ['/agents/', "'none'", 'DENY'], ['/frame/board/', '*', null]]) {
      const r = await worker.fetch(new Request('https://agents.sagebrush.cloud' + path), { PREVIEWS: bucket(entries) });
      assert.equal(r.status, 200, path);
      const fas = r.headers.get('content-security-policy').split(';').map(d => d.trim()).filter(d => d.startsWith('frame-ancestors'));
      assert.deepEqual(fas, [`frame-ancestors ${fa}`], path);
      assert.equal(r.headers.get('x-frame-options'), xfo, path);
    }
    // (and the publisher refuses a page whose policy doesn't say: the control)
    writeFileSync(join(dir, '_headers'), headersFor(dir).replace(/; frame-ancestors 'none'/, ''));
    assert.throws(() => prepare(dir, 'agents.sagebrush.cloud', []), /lacks frame-ancestors/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing policy fails closed; invalid host/method has no R2 calls', async () => {
  const store = bucket({ 'latex/index.html': '<html></html>' });
  assert.equal((await worker.fetch(new Request('https://latex.sagebrush.cloud/'), { PREVIEWS: store })).status, 503);
  store.calls.length = 0;
  for (const req of [new Request('https://sagebrush.cloud/'), new Request('https://latex.sagebrush.cloud/', { method: 'POST' })]) {
    assert.ok((await worker.fetch(req, { PREVIEWS: store })).status >= 400);
  }
  assert.deepEqual(store.calls, []);
});
test('engine bytes are served exactly and missing APIs are never app fallbacks', async () => {
  const store = bucket({ 'latex/engine/id/test.wasm': 'wasm bytes', 'latex/index.html': '<html></html>' });
  const response = await worker.fetch(new Request('https://latex.sagebrush.cloud/engine/id/test.wasm'), { PREVIEWS: store });
  assert.equal(await response.text(), 'wasm bytes');
  assert.equal(response.headers.get('content-type'), 'application/wasm');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await worker.fetch(new Request('https://latex.sagebrush.cloud/api/auth'), { PREVIEWS: store })).status, 404);
  assert.ok(store.calls.every(k => k.startsWith('latex/')));
});
test('prepare preserves hashed engine HTML, injects banner/config and disables SW caching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-fixture-'));
  try {
    mkdirSync(join(dir, 'engine', 'id', 'runner'), { recursive: true });
    const page = '<html><head><script>example()</script></head><body>page</body></html>';
    writeFileSync(join(dir, 'index.html'), page);
    writeFileSync(join(dir, 'engine/id/runner/index.html'), page);
    writeFileSync(join(dir, '_headers'), "/index.html\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-fixture'; connect-src 'self' https:; frame-ancestors 'self'\n/engine/*\n  Content-Security-Policy: default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; frame-ancestors 'self'\n");
    const output = prepare(dir, 'latex.sagebrush.cloud', ['sagetex']);
    const bytes = p => output.files.get(p).bytes.toString();
    assert.match(bytes('index.html'), /id="sb-preview-notice"/);
    assert.match(bytes('preview-config.js'), /PREVIEW, not production/);
    assert.match(bytes('preview-config.js'), /Hide for this session/);
    assert.match(bytes('index.html'), /preview-config\.js/);
    assert.match(bytes('index.html'), /<script>example\(\)<\/script>/);
    assert.equal(bytes('engine/id/runner/index.html'), page);
    assert.match(bytes('sw.js'), /unregister/);
    assert.doesNotMatch(bytes('sw.js'), /fetch|caches/);
    assert.doesNotMatch(bytes('.preview/headers/index.html.json'), /https:/);
    // (exactly: the page's origin, data: and blob:, and the agent pairing's loopback socket; no other ws: or wss:)
    assert.equal(/connect-src [^;"]+/.exec(JSON.parse(bytes('.preview/headers/index.html.json')).csp)[0], "connect-src 'self' data: blob: ws://127.0.0.1:* ws://localhost:*");
    symlinkSync(join(dir, 'index.html'), join(dir, 'leak.txt'));
    assert.throws(() => prepare(dir, 'latex.sagebrush.cloud', []), /symlink/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('mock switches require a preview host; explicit query overrides build defaults', () => {
  const before = { location: globalThis.location, config: globalThis.__SAGEBRUSH_PREVIEW__ };
  try {
    globalThis.__SAGEBRUSH_PREVIEW__ = { host: 'latex.sagebrush.cloud', mocks: ['sagetex'] };
    globalThis.location = new URL('https://latex.sagebrush.cloud/');
    assert.equal(mockEnabled('sagetex'), true);
    globalThis.location = new URL('https://latex.sagebrush.cloud/?mock=remote-kernel');
    assert.equal(mockEnabled('sagetex'), false);
    assert.equal(mockEnabled('remote-kernel'), true);
    globalThis.location = new URL('https://sagebrush.space/?mock=sagetex');
    assert.equal(mockEnabled('sagetex'), false);
  } finally {
    if (before.location === undefined) delete globalThis.location; else globalThis.location = before.location;
    if (before.config === undefined) delete globalThis.__SAGEBRUSH_PREVIEW__; else globalThis.__SAGEBRUSH_PREVIEW__ = before.config;
  }
});
test('R2 client refuses prefix traversal before network and never follows redirects', async () => {
  const client = new R2({ accountId: '0'.repeat(32), accessKeyId: '1'.repeat(32), secretAccessKey: '2'.repeat(64) }, 'latex');
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('', { status: 200 }); };
  try {
    for (const key of ['', 'other/index.html', 'latex/../other/index.html', 'latex/./x', 'latex/\\x', 'latex//x']) await assert.rejects(client.delete(key), /unsafe|outside|empty/);
    assert.equal(calls.length, 0);
    await client.put('latex/index.html', Buffer.from('hello'), MIME.html);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://${'0'.repeat(32)}.r2.cloudflarestorage.com/sagebrush-preview/latex/index.html`);
    assert.equal(calls[0].options.redirect, 'error');
    assert.match(calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 /);
  } finally { globalThis.fetch = original; }
});
test('S3 listing validates every returned key before yielding a stale-delete set', async () => {
  const client = new R2({ accountId: '0'.repeat(32), accessKeyId: '1'.repeat(32), secretAccessKey: '2'.repeat(64) }, 'latex');
  const original = globalThis.fetch;
  try {
    const listing = key => `<ListBucketResult><EncodingType>url</EncodingType><Contents><Key>${encodeURIComponent(key)}</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`;
    globalThis.fetch = async () => new Response(listing('latex/index.html'));
    assert.deepEqual(await client.list(), ['latex/index.html']);
    globalThis.fetch = async () => new Response(listing('other/index.html'));
    await assert.rejects(client.list(), /outside|unsafe/);
    globalThis.fetch = async () => new Response(listing('latex/../other/index.html'));
    await assert.rejects(client.list(), /outside|unsafe/);
    globalThis.fetch = async () => new Response('secret response body fixture', { status: 403 });
    await assert.rejects(client.delete('latex/index.html'), error => /HTTP 403/.test(error.message) && !error.message.includes('secret'));
  } finally { globalThis.fetch = original; }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'preview-caps-'));
  const page = '<html><head></head><body>page</body></html>';
  writeFileSync(join(dir, 'index.html'), page);
  writeFileSync(join(dir, '_headers'), "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'self'\n");
  return { dir, page, build: () => prepare(dir, 'latex.sagebrush.cloud', []) };
}
test('final buffers survive changed/deleted sources and their exact sizes/hashes are recorded', () => {
  const f = fixture();
  try {
    const output = f.build();
    const before = Buffer.from(output.files.get('index.html').bytes);
    writeFileSync(join(f.dir, 'index.html'), 'changed after preparation');
    rmSync(join(f.dir, '_headers'));
    assert.deepEqual(output.files.get('index.html').bytes, before);
    assert.equal(output.totalBytes, [...output.files.values()].reduce((n, x) => n + x.bytes.length, 0));
    assert.equal(output.files.size, 4); // HTML, its policy, injected config, replacement SW.
    for (const file of output.files.values()) {
      assert.equal(file.sha256, createHash('sha256').update(file.bytes).digest('hex'));
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('final object cap counts every policy and synthetic object at 3000 and 3001', () => {
  const f = fixture();
  try {
    // 1499 HTML files + 1499 policies + config + SW = 3000.
    for (let i = 1; i < 1499; i++) writeFileSync(join(f.dir, `p${i}.html`), f.page);
    assert.equal(f.build().files.size, MAX_OBJECTS);
    writeFileSync(join(f.dir, 'extra.txt'), '');
    assert.throws(f.build, /final manifest exceeds 3000/);
    assert.equal(MAX_PREVIOUS_OBJECTS, 2 * MAX_OBJECTS);
    assert.equal(MAX_OBJECTS + MAX_OBJECTS, 6000); // Successful generation plus interrupted successor.
    assert.equal(MAX_PREVIOUS_OBJECTS + MAX_OBJECTS, 9000); // Recovery publish's peak.
    assert.ok(MAX_PREVIOUS_OBJECTS + MAX_OBJECTS < 50000);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('8 MiB cap applies after HTML injection, not just to its source', () => {
  const f = fixture();
  try {
    const overhead = f.build().files.get('index.html').bytes.length - Buffer.byteLength(f.page);
    const padding = MAX_HTML_BYTES - overhead - Buffer.byteLength(f.page);
    writeFileSync(join(f.dir, 'index.html'), f.page + ' '.repeat(padding));
    assert.equal(f.build().files.get('index.html').bytes.length, MAX_HTML_BYTES);
    writeFileSync(join(f.dir, 'index.html'), f.page + ' '.repeat(padding + 1));
    assert.throws(f.build, /final HTML exceeds 8 MiB/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('200 MiB total includes transformed HTML, policy/config/SW and binary bodies', () => {
  const f = fixture();
  try {
    const base = f.build().totalBytes;
    const block = Buffer.alloc(MAX_FILE_BYTES);
    let remaining = MAX_BYTES - base;
    let i = 0;
    while (remaining > 0) {
      const size = Math.min(remaining, block.length);
      writeFileSync(join(f.dir, `block${i++}.bin`), block.subarray(0, size));
      remaining -= size;
    }
    assert.equal(f.build().totalBytes, MAX_BYTES);
    writeFileSync(join(f.dir, 'extra.bin'), 'x');
    assert.throws(f.build, /200 MiB/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('_headers refuses 201 rules including non-CSP slash records, and 64 KiB plus one', () => {
  const f = fixture();
  try {
    const policy = "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'self'\n";
    const rules = Array.from({ length: 199 }, (_, i) => `/unused${i}\n`).join('');
    writeFileSync(join(f.dir, '_headers'), policy + rules);
    assert.equal(f.build().files.size, 4);
    writeFileSync(join(f.dir, '_headers'), policy + rules + '/one-too-many\n');
    assert.throws(f.build, /200 rules/);
    writeFileSync(join(f.dir, '_headers'), policy + '#' + ' '.repeat(64 * 1024 - policy.length - 1));
    assert.equal(f.build().files.size, 4);
    writeFileSync(join(f.dir, '_headers'), policy + '#' + ' '.repeat(64 * 1024 - policy.length));
    assert.throws(f.build, /65536 bytes/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('previous listing admits 6000 and refuses 6001 before any writes', async () => {
  const original = globalThis.fetch;
  const credentials = { accountId: '0'.repeat(32), accessKeyId: '1'.repeat(32), secretAccessKey: '2'.repeat(64) };
  const pages = truncated => {
    let page = 0;
    return async (_url, options) => {
      assert.equal(options.method, 'GET');
      const keys = Array.from({ length: 1000 }, (_, i) => `<Contents><Key>latex%2Ffile${page * 1000 + i}</Key></Contents>`).join('');
      page++;
      return new Response(`<ListBucketResult><EncodingType>url</EncodingType>${keys}<IsTruncated>${page < 6 || truncated}</IsTruncated><NextContinuationToken>page${page}</NextContinuationToken></ListBucketResult>`);
    };
  };
  try {
    globalThis.fetch = pages(false);
    assert.equal((await new R2(credentials, 'latex').list()).length, MAX_PREVIOUS_OBJECTS);
    globalThis.fetch = pages(true);
    await assert.rejects(new R2(credentials, 'latex').list(), /6000 objects or 6 pages/);
  } finally { globalThis.fetch = original; }
});
test('remote-phase abort cancels an active request instead of granting another 30 seconds', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const client = new R2({ accountId: '0'.repeat(32), accessKeyId: '1'.repeat(32), secretAccessKey: '2'.repeat(64) }, 'latex', controller.signal);
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    controller.abort(new Error('test remote deadline'));
    assert.equal(options.signal.aborted, true);
  });
  try {
    await assert.rejects(client.put('latex/index.html', Buffer.from('html'), MIME.html), /timed out/);
    await assert.rejects(client.delete('latex/index.html'), /test remote deadline/);
  } finally { globalThis.fetch = original; }
});

test('deploy entry exports only the default Worker, keeping helper objects out of the runtime API', () => {
  assert.deepEqual(Object.keys(deployEntry), ['default']);
  assert.equal(deployEntry.default, worker);
});

test('non-HTML files admit 16 MiB exactly and refuse one byte more', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'compiled.json'), Buffer.alloc(MAX_FILE_BYTES));
    assert.equal(f.build().files.get('compiled.json').bytes.length, MAX_FILE_BYTES);
    writeFileSync(join(f.dir, 'compiled.json'), Buffer.alloc(MAX_FILE_BYTES + 1));
    assert.throws(f.build, /16777216 bytes/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('upload pool caps eight active operations, skips hashes, and retains phase barriers', async () => {
  let active = 0, peak = 0;
  const completed = [], files = new Map();
  for (let i = 0; i < 24; i++) files.set(`asset${i}.js`, { bytes: Buffer.from('x'), type: MIME.js, sha256: 'a'.repeat(64) });
  files.set('index.html', { bytes: Buffer.from('html'), type: MIME.html, sha256: 'b'.repeat(64) });
  const work = async name => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--; completed.push(name);
  };
  const client = {
    async list() { return ['latex/asset0.js', 'latex/asset1.js', 'latex/stale.js']; },
    async matches(key) { await work('head:' + key); return key === 'latex/asset0.js'; },
    async put(key) {
      if (key.endsWith('.html')) assert.equal(completed.filter(x => x.startsWith('put:latex/asset')).length, 23);
      await work('put:' + key);
    },
    async delete(key) { assert.ok(completed.includes('put:latex/index.html')); await work('delete:' + key); },
  };
  assert.deepEqual(await upload(client, 'latex', { files }, new AbortController().signal), { uploaded: 24, skipped: 1 });
  assert.equal(UPLOAD_CONCURRENCY, 8); assert.equal(peak, 8); assert.equal(active, 0);
  assert.ok(!completed.includes('put:latex/asset0.js'));
  assert.equal(completed.at(-1), 'delete:latex/stale.js');
});

test('failed pool drains in-flight work, admits no HTML or stale deletions, and honors abort', async () => {
  const files = new Map(Array.from({ length: 30 }, (_, i) => [`asset${i}.js`, { bytes: Buffer.from('x'), type: MIME.js }]));
  files.set('index.html', { bytes: Buffer.from('html'), type: MIME.html });
  let started = 0, active = 0, deleted = false;
  const client = {
    async list() { return ['latex/stale.js']; },
    async put(key) {
      assert.ok(!key.endsWith('.html')); started++; active++;
      try { if (key.endsWith('asset0.js')) throw new Error('controlled failure'); await new Promise(resolve => setTimeout(resolve, 5)); }
      finally { active--; }
    },
    async delete() { deleted = true; },
  };
  await assert.rejects(upload(client, 'latex', { files }, new AbortController().signal), /controlled failure/);
  assert.equal(started, 8); assert.equal(active, 0); assert.equal(deleted, false);
  started = 0;
  const controller = new AbortController(); controller.abort(new Error('deadline'));
  await assert.rejects(upload(client, 'latex', { files }, controller.signal), /deadline/);
  assert.equal(started, 0);
});

test('skip compares current signed object metadata, size and type; missing/legacy objects reupload', async () => {
  const original = globalThis.fetch;
  const client = new R2({ accountId: '0'.repeat(32), accessKeyId: '1'.repeat(32), secretAccessKey: '2'.repeat(64) }, 'latex');
  const bytes = Buffer.from('same'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = { bytes, sha256, type: MIME.js };
  let headers = { 'x-amz-meta-preview-sha256': sha256, 'content-length': '4', 'content-type': MIME.js }, status = 200;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'PUT') {
      assert.equal(options.headers['x-amz-meta-preview-sha256'], sha256);
      assert.match(options.headers.authorization, /SignedHeaders=[^,]*x-amz-meta-preview-sha256/);
    } else assert.equal(options.method, 'HEAD');
    return new Response(null, { headers, status });
  };
  try {
    assert.equal(await client.matches('latex/a.js', file), true);
    for (const field of Object.keys(headers)) {
      const saved = headers[field]; headers[field] = 'different';
      assert.equal(await client.matches('latex/a.js', file), false); headers[field] = saved;
    }
    headers = {}; assert.equal(await client.matches('latex/a.js', file), false);
    status = 404; assert.equal(await client.matches('latex/a.js', file), false);
    status = 200; await client.put('latex/a.js', bytes, MIME.js);
  } finally { globalThis.fetch = original; }
});

test('peer failure while an item is in HEAD prevents its successor PUT', async () => {
  const files = new Map(['fail.js', 'head.js', 'index.html'].map(path => [path, { bytes: Buffer.from('x'), type: MIME.js }]));
  let releaseHead, releaseFailure, startedHead;
  const headStarted = new Promise(resolve => { startedHead = resolve; });
  const heldHead = new Promise(resolve => { releaseHead = resolve; });
  const failNow = new Promise(resolve => { releaseFailure = resolve; });
  const puts = [];
  const client = {
    async list() { return ['latex/head.js', 'latex/stale.js']; },
    async matches() { startedHead(); await heldHead; return false; },
    async put(key) { puts.push(key); await failNow; throw new Error('peer failed'); },
    async delete() { assert.fail('no stale deletion after failure'); },
  };
  const result = upload(client, 'latex', { files }, new AbortController().signal);
  await headStarted; releaseFailure();
  await new Promise(resolve => setTimeout(resolve, 5)); // Failure reaches pool while HEAD stays held.
  releaseHead();
  await assert.rejects(result, /peer failed/);
  assert.deepEqual(puts, ['latex/fail.js']);
});

test('eight 16 MiB non-HTML buffers bound active transport input to 128 MiB', async () => {
  const files = new Map(Array.from({ length: UPLOAD_CONCURRENCY }, (_, i) => [`large${i}.bin`, { bytes: Buffer.alloc(MAX_FILE_BYTES), type: MIME.bin }]));
  let activeBytes = 0, peakBytes = 0;
  const client = {
    async list() { return []; },
    async put(key, bytes) {
      assert.equal(bytes, files.get(key.slice('latex/'.length)).bytes);
      activeBytes += bytes.length; peakBytes = Math.max(peakBytes, activeBytes);
      await new Promise(resolve => setTimeout(resolve, 5));
      activeBytes -= bytes.length;
    },
  };
  assert.deepEqual(await upload(client, 'latex', { files }, new AbortController().signal), { uploaded: 8, skipped: 0 });
  assert.equal(peakBytes, 128 * 1024 * 1024); assert.equal(activeBytes, 0);
});

test('phone preview notice preserves controls, opens metadata modal and dismisses for this session under CSP', { timeout: 60000 }, async () => {
  const geometry = await checkNoticeBrowser();
  assert.ok(geometry.controlsBottom <= geometry.top);
});
test("the site's page policy: connect-src exactly as stated, the agent pairing's loopback socket included", async () => {
  const { pagePolicy } = await import('../csp-policy.mts');
  assert.equal(/connect-src [^;]+/.exec(pagePolicy())[0], "connect-src 'self' data: blob: https: http: ws://127.0.0.1:* ws://localhost:*");
});
