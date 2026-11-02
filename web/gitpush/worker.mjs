// The git smart-HTTP proxy for "Push project to GitHub" (Stage A MVP, M1). github.com sends no CORS headers,
// so the page's isomorphic-git reaches it through here (its `corsProxy`: `<proxy>/github.com/<owner>/<repo>.git/...`).
// The upstream host is FIXED: the client names only an owner, a repo and one git endpoint, so this is never an open
// relay and can't reach any other host. Only git's two smart-HTTP services exist: git-receive-pack (push, M1) and
// git-upload-pack (fetch, M4b's Copy from GitHub branch), each as its info/refs advertisement and its POST.
// The person's token arrives in Authorization and is forwarded to github.com only. It is never stored and never
// logged: there is no logging call here, no error response echoes a request header or body, and observability is off
// (wrangler.jsonc).
export const UPSTREAM = 'https://github.com';
export const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
export const MAX_BODY = 100 * 1024 * 1024;
const SERVICES = ['git-receive-pack', 'git-upload-pack'];
const FORWARD = ['authorization', 'content-type', 'accept', 'git-protocol'];
const ALLOW_HEADERS = 'authorization, content-type, accept, git-protocol, user-agent';
const PASS_BACK = ['content-type'];

// `{owner, repo, endpoint, service}` for an allowed request line, or null. endpoint is 'refs' (GET info/refs with exactly
// ?service=<one of SERVICES>) or 'post' (POST <one of SERVICES>). Nothing is decoded: a percent sign fails SEGMENT.
export function route(method, input) {
  const u = new URL(input);
  const m = /^\/github\.com\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-receive-pack|git-upload-pack)$/.exec(u.pathname);
  // (SEGMENT's first character is never a dot, so `.` and `..` can't pass; said again here, as the rule that matters)
  const dots = (s) => s === '.' || s === '..';
  if (!m || dots(m[1]) || dots(m[2]) || !SEGMENT.test(m[1]) || !SEGMENT.test(m[2]) || m[2].endsWith('.git')) return null;
  const [, owner, repo, tail] = m;
  if (tail === 'info/refs') {
    const service = SERVICES.find((x) => u.search === `?service=${x}`);
    if (method !== 'GET' || !service) return null;
    return { owner, repo, endpoint: 'refs', service };
  }
  if (method !== 'POST' || u.search !== '') return null;
  return { owner, repo, endpoint: 'post', service: tail };
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
const WORDS = { 400: 'Not a git request this proxy takes', 401: 'A token is required', 403: 'Origin not allowed', 411: 'Length required',
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
  if (target.endpoint === 'post') {
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
  const path = target.endpoint === 'refs' ? `info/refs?service=${target.service}` : target.service;
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
