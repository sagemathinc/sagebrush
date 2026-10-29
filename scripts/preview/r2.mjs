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

export class R2 {
  constructor(credentials, name, remoteSignal = AbortSignal.timeout(20 * 60 * 1000)) {
    if (!NAME.test(name)) throw new Error('Invalid preview name');
    this.remoteSignal = remoteSignal;
    this.credentials = credentials;
    this.prefix = `${name}/`;
    this.host = `${credentials.accountId}.r2.cloudflarestorage.com`;
  }
  validateKey(key) {
    if (!key.startsWith(this.prefix) || key.split('/').some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f\x7f]/.test(p))) {
      throw new Error('R2 operation outside the preview prefix or with an unsafe key');
    }
  }
  async request(method, key = '', query = {}, bytes = Buffer.alloc(0), contentType) {
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
        redirect: 'error', signal: AbortSignal.any([this.remoteSignal, AbortSignal.timeout(30000)]),
      });
    } catch { throw new Error('R2 request failed or timed out (no automatic retry)'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`R2 ${method} refused (HTTP ${response.status}); no automatic retry`);
    }
    return response;
  }
  async list() {
    const keys = [];
    let token = '';
    // Finite even if R2 repeats a token or another publisher keeps adding files.
    for (let page = 0; page < 6; page++) {
      const response = await this.request('GET', '', {
        'list-type': '2', prefix: this.prefix, 'max-keys': '1000', 'encoding-type': 'url',
        ...(token ? { 'continuation-token': token } : {}),
      });
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('R2 listing exceeds 8 MiB'); }
        chunks.push(Buffer.from(value));
      }
      const text = Buffer.concat(chunks).toString('utf8');
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
  async put(key, bytes, type) {
    const response = await this.request('PUT', key, {}, bytes, type);
    await response.body?.cancel();
  }
  async delete(key) {
    const response = await this.request('DELETE', key);
    await response.body?.cancel();
  }
}
