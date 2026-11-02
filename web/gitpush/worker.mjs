// The git smart-HTTP proxy for "Push project to GitHub" (Stage A MVP, M1). github.com sends no CORS headers,
// so the page's isomorphic-git reaches it through here (its `corsProxy`: `<proxy>/github.com/<owner>/<repo>.git/...`).
// The upstream host is FIXED: the client names only an owner, a repo and one git endpoint, so this is never an open
// relay and can't reach any other host. Only the push endpoints exist (pull's git-upload-pack comes with M4/M5).
// The person's token arrives in Authorization and is forwarded to github.com only. It is never stored and never
// logged: there is no logging call here, no error response echoes a request header or body, and observability is off
// (wrangler.jsonc).
export const UPSTREAM = 'https://github.com';
export const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
export const MAX_BODY = 100 * 1024 * 1024;
const SERVICE = 'git-receive-pack';
const FORWARD = ['authorization', 'content-type', 'accept', 'git-protocol'];
const ALLOW_HEADERS = 'authorization, content-type, accept, git-protocol, user-agent';
const PASS_BACK = ['content-type'];

// `{owner, repo, endpoint}` for an allowed request line, or null. endpoint is 'refs' (GET info/refs with exactly
// ?service=git-receive-pack) or 'receive' (POST git-receive-pack). Nothing is decoded: a percent sign fails SEGMENT.
export function route(method, input) {
  const u = new URL(input);
  const m = /^\/github\.com\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-receive-pack)$/.exec(u.pathname);
  if (!m || !SEGMENT.test(m[1]) || !SEGMENT.test(m[2]) || m[2].endsWith('.git')) return null;
  const [, owner, repo, tail] = m;
  if (tail === 'info/refs') {
    if (method !== 'GET' || u.search !== `?service=${SERVICE}`) return null;
    return { owner, repo, endpoint: 'refs' };
  }
  if (method !== 'POST' || u.search !== '') return null;
  return { owner, repo, endpoint: 'receive' };
}

export function origins(env) {
  return String(env?.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

// Fixed words per status: never anything from the request.
const WORDS = { 400: 'Not a git push request', 401: 'A token is required', 403: 'Origin not allowed', 411: 'Length required',
  413: 'Push too large', 429: 'Too many requests, try again in a minute', 502: 'GitHub could not be reached', 503: 'Proxy unavailable' };
function fail(status, origin) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', ...(origin ? cors(origin) : { 'Cache-Control': 'no-store' }) };
  return new Response(`${WORDS[status]}\n`, { status, headers });
}

export async function handle(request, env, fetchImpl = fetch) {
  const origin = request.headers.get('origin');
  if (!origin || !origins(env).includes(origin)) return fail(403, null);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors(origin), 'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Max-Age': '600' } });
  }
  const target = route(request.method, request.url);
  if (!target) return fail(400, origin);
  if (!request.headers.get('authorization')) return fail(401, origin);
  if (!env?.LIMITER) return fail(503, origin); // fail closed: never unlimited
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.LIMITER.limit({ key: ip });
  if (!success) return fail(429, origin);
  let body = null;
  if (target.endpoint === 'receive') {
    const length = request.headers.get('content-length');
    if (length === null || !/^\d{1,10}$/.test(length)) return fail(411, origin);
    if (Number(length) > MAX_BODY) return fail(413, origin);
    body = request.body;
  }
  const headers = new Headers();
  for (const name of FORWARD) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('user-agent', 'git/sagebrush-gitpush');
  const path = target.endpoint === 'refs' ? `info/refs?service=${SERVICE}` : SERVICE;
  let upstream;
  try {
    upstream = await fetchImpl(`${UPSTREAM}/${target.owner}/${target.repo}.git/${path}`, { method: request.method, headers, body, redirect: 'manual' });
  } catch {
    return fail(502, origin);
  }
  // A redirect (a renamed repo, a login page) is never followed or passed on.
  if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return fail(502, origin); }
  const out = new Headers(cors(origin));
  for (const name of PASS_BACK) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  // (no WWW-Authenticate, Set-Cookie or anything else of GitHub's)
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch {
      return fail(503, null);
    }
  },
};
