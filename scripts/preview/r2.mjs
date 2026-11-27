// Minimal S3 SigV4 client. Only this bucket and the caller's validated name/ prefix.
// Never uses AWS/Cloudflare environment credentials or follows redirects.
import { createHash, createHmac } from 'node:crypto';
import { NAME } from '../../web/preview/worker.mjs';
import { MAX_OBJECTS } from './prepare.mjs';
export const MAX_PREVIOUS_OBJECTS = 2 * MAX_OBJECTS;
const BUCKET = 'sagebrush-preview';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const hmac = (k, v) => createHmac('sha256', k).update(v).digest();
const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const xml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[k]);

// An idempotent request (HEAD, a listing GET, a PUT of the same key with the same bytes) that fails at the network, runs
// over its 30 s, or gets HTTP 429 or 5xx is tried again, at most ATTEMPTS times in all, after a short pause: one R2
// request that hangs must not end a publish of a thousand checks. A DELETE is never tried again. Each attempt keeps its
// own 30 s, and the caller's remote deadline still bounds them all.
export const ATTEMPTS = 3;
const ATTEMPT_MS = 30000, BACKOFF_MS = [1000, 3000];
// (an error worth another attempt; anything else, a refusal or a check of ours, ends the request at once)
const again = (message) => Object.assign(new Error(message), { retryable: true });

export class R2 {
  constructor(credentials, name, remoteSignal = AbortSignal.timeout(20 * 60 * 1000), timing = {}) {
    if (!NAME.test(name)) throw new Error('Invalid preview name');
    this.remoteSignal = remoteSignal;
    // (the tests' shorter clock; the publisher always uses the defaults)
    this.attemptMs = timing.attemptMs ?? ATTEMPT_MS;
    this.backoffMs = timing.backoffMs ?? BACKOFF_MS;
    this.credentials = credentials;
    this.prefix = `${name}/`;
    this.host = `${credentials.accountId}.r2.cloudflarestorage.com`;
  }
  validateKey(key) {
    if (!key.startsWith(this.prefix) || key.split('/').some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f\x7f]/.test(p))) {
      throw new Error('R2 operation outside the preview prefix or with an unsafe key');
    }
  }
  // (check: the upload pool's, asked before each further attempt, so a peer's failure stops this request's retries)
  async request(method, key = '', query = {}, bytes = Buffer.alloc(0), contentType, cacheControl, check) {
    if (method === 'DELETE') return this.once(method, key, query, bytes, contentType, cacheControl, true);
    return this.retrying(key ? method : 'LIST', key || this.prefix, () => this.once(method, key, query, bytes, contentType, cacheControl, false), check);
  }
  // At most ATTEMPTS tries of an idempotent request; a retry is logged with its kind and key only (never a header, a
  // signature or a credential), and the pause before it ends at once with the remote deadline.
  async retrying(kind, key, attempt, check) {
    for (let n = 1; ; n++) {
      try { return await attempt(); } catch (error) {
        if (!error?.retryable || this.remoteSignal.aborted) throw error;
        if (n >= ATTEMPTS) throw new Error(`${error.message} (after ${ATTEMPTS} attempts)`);
        console.error(`R2 retry ${n + 1} of ${ATTEMPTS}: ${kind} ${key} (${error.message})`);
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); this.remoteSignal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, this.backoffMs[n - 1] ?? this.backoffMs.at(-1));
          this.remoteSignal.addEventListener('abort', done, { once: true });
        });
        this.remoteSignal.throwIfAborted();
        check?.();
      }
    }
  }
  async once(method, key, query, bytes, contentType, cacheControl, final) {
    if (!key && (method !== 'GET' || query['list-type'] !== '2' || query.prefix !== this.prefix)) throw new Error('R2 object key must not be empty');
    if (key) this.validateKey(key);
    this.remoteSignal.throwIfAborted();
    const uri = '/' + BUCKET + (key ? '/' + key.split('/').map(enc).join('/') : '');
    const qs = Object.entries(query).map(([k, v]) => [enc(k), enc(v)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('&');
    const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = stamp.slice(0, 8);
    const digest = sha(bytes);
    const headers = { host: this.host, 'x-amz-content-sha256': digest, 'x-amz-date': stamp };
    if (contentType) headers['content-type'] = contentType;
    if (method === 'PUT') headers['x-amz-meta-preview-sha256'] = digest;
    // (the Cache-Control the Worker sends for this object, as production's _headers give it: signed with the rest)
    if (method === 'PUT' && cacheControl) headers['x-amz-meta-preview-cache-control'] = cacheControl;
    const names = Object.keys(headers).sort();
    const signed = names.join(';');
    const canonical = [method, uri, qs, names.map(k => `${k}:${headers[k].trim()}\n`).join(''), signed, digest].join('\n');
    const scope = `${date}/auto/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + this.credentials.secretAccessKey, date), 'auto'), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha(canonical)}`).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    let response;
    try {
      response = await fetch(`https://${this.host}${uri}${qs ? '?' + qs : ''}`, {
        method, headers, body: method === 'PUT' ? bytes : undefined,
        redirect: 'error', signal: AbortSignal.any([this.remoteSignal, AbortSignal.timeout(this.attemptMs)]),
      });
    } catch {
      if (final) throw new Error('R2 request failed or timed out (no automatic retry)');
      throw again('R2 request failed or timed out');
    }
    if (!response.ok && !(method === 'HEAD' && response.status === 404)) {
      await response.body?.cancel();
      if (final) throw new Error(`R2 ${method} refused (HTTP ${response.status}); no automatic retry`);
      if (response.status === 429 || response.status >= 500) throw again(`R2 ${method} refused (HTTP ${response.status})`);
      throw new Error(`R2 ${method} refused (HTTP ${response.status})`);
    }
    return response;
  }
  async list() {
    const keys = [];
    let token = '';
    // Finite even if R2 repeats a token or another publisher keeps adding files.
    for (let page = 0; page < 6; page++) {
      const query = {
        'list-type': '2', prefix: this.prefix, 'max-keys': '1000', 'encoding-type': 'url',
        ...(token ? { 'continuation-token': token } : {}),
      };
      // (the page's request and the reading of its body, tried again together: a body that stalls past the attempt's
      //  30 s is a failed attempt like a request that does)
      const text = await this.retrying('LIST', this.prefix, async () => {
        const response = await this.once('GET', '', query, Buffer.alloc(0), undefined, undefined, false);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          let part;
          try { part = await reader.read(); } catch { throw again('R2 listing failed or timed out'); }
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('R2 listing exceeds 8 MiB'); }
          chunks.push(Buffer.from(part.value));
        }
        return Buffer.concat(chunks).toString('utf8');
      });
      if (!text.includes('<ListBucketResult') || !text.includes('<EncodingType>url</EncodingType>')) throw new Error('Invalid R2 listing');
      for (const match of text.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const key = decodeURIComponent(xml(match[1]));
        this.validateKey(key);
        keys.push(key);
        if (keys.length > MAX_PREVIOUS_OBJECTS) throw new Error('Preview previous listing exceeds 6000 objects');
      }
      if (/<IsTruncated>false<\/IsTruncated>/.test(text)) return keys;
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(text)?.[1];
      if (!next || xml(next) === token) throw new Error('Invalid R2 continuation token');
      token = xml(next);
    }
    throw new Error('Preview previous listing exceeds 6000 objects or 6 pages; no uploads or deletions started');
  }
  async put(key, bytes, type, cacheControl, check) {
    const response = await this.request('PUT', key, {}, bytes, type, cacheControl, check);
    await response.body?.cancel();
  }
  async matches(key, file, check) {
    const response = await this.request('HEAD', key, {}, Buffer.alloc(0), undefined, undefined, check);
    const same = response.status === 200 &&
      response.headers.get('x-amz-meta-preview-sha256') === file.sha256 &&
      response.headers.get('content-length') === String(file.bytes.length) &&
      response.headers.get('content-type') === file.type &&
      (response.headers.get('x-amz-meta-preview-cache-control') ?? undefined) === file.cacheControl;
    await response.body?.cancel();
    return same;
  }
  async delete(key) {
    const response = await this.request('DELETE', key);
    await response.body?.cancel();
  }
}
