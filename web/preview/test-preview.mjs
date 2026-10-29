// Deferred runtime checks: run on an authorized VM/CI, not the shared project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, { route, MIME } from './worker.mjs';
import { mockEnabled } from './mock.js';
import { prepare } from '../../scripts/preview/prepare.mjs';
import { R2 } from '../../scripts/preview/r2.mjs';

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
    writeFileSync(join(dir, '_headers'), "/index.html\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-fixture'; connect-src 'self' https:\n/engine/*\n  Content-Security-Policy: default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'\n");
    const output = prepare(dir, 'latex.sagebrush.cloud', ['sagetex']);
    const bytes = p => output.bytes(p, output.files.get(p)).toString();
    assert.match(bytes('index.html'), /PREVIEW, not production/);
    assert.match(bytes('index.html'), /preview-config\.js/);
    assert.match(bytes('index.html'), /<script>example\(\)<\/script>/);
    assert.equal(bytes('engine/id/runner/index.html'), page);
    assert.match(bytes('sw.js'), /unregister/);
    assert.doesNotMatch(bytes('sw.js'), /fetch|caches/);
    assert.doesNotMatch(bytes('.preview/headers/index.html.json'), /https:/);
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
    for (const key of ['other/index.html', 'latex/../other/index.html', 'latex/./x', 'latex/\\x', 'latex//x']) await assert.rejects(client.delete(key), /unsafe|outside/);
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
