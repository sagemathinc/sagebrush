// Engines by their content, for the site's Worker (web/site/src/index.ts):
// GET /engine/<id>/<file> from R2 (the releases bucket, where
// scripts/publish-engine.mjs puts each engine web/build.ts makes, and
// leaves it forever).  Each file is served with the headers its manifest
// gives it (its type; the runner page its CSP and isolation), plus: never
// changes (immutable), readable from any page or file (CORS *).  The latest
// engine's id is /engine/latest.json, a static file of the site.
// design/engines.md.

interface R2Obj { body: ReadableStream; size: number }
export interface EnginesEnv { ENGINES?: { get(key: string): Promise<R2Obj | null> } }
interface Manifest { files: Record<string, { sha256: string; size: number; headers: Record<string, string> }> }

const manifests = new Map<string, Manifest>();
// (ids with no manifest, briefly: each would cost an R2 read (HARD-CAC-5),
// and one may be published at any time)
const missing = new Map<string, number>();
const MISSING_MS = 60_000, MISSING_MAX = 1000;

const COMMON: Record<string, string> = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

// (requests for one id at the same time each read it: a Worker can't share
// a promise between requests)
async function manifest(env: EnginesEnv, id: string): Promise<Manifest | null> {
  const known = manifests.get(id);
  if (known) return known;
  const t = missing.get(id);
  if (t !== undefined && Date.now() - t < MISSING_MS) return null;
  const o = await env.ENGINES!.get(`engine/${id}/manifest.json`);
  const m = o ? ((await new Response(o.body).json()) as Manifest) : null;
  if (m && m.files && typeof m.files === "object") {
    missing.delete(id);
    manifests.set(id, m);
    return m;
  }
  if (missing.size >= MISSING_MAX) missing.delete(missing.keys().next().value!);
  missing.set(id, Date.now());
  return null;
}

/** The response for an engine's file, or null if the request is not for one. */
export async function handleEngines(req: Request, env: EnginesEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/engine\/([0-9a-f]{20})\/([a-z0-9][a-z0-9./-]*)$/);
  if (!m || !env.ENGINES || m[2].includes("..")) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const [, id, file] = m;
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(`${url.origin}/engine/${id}/${file}`);
  // (HEAD from the GET kept at the edge too)
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return req.method === "HEAD" ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
  }
  const man = await manifest(env, id);
  // (its own entries only: not "constructor" or the like, SEC-CAC-3)
  const entry = file === "manifest.json" ? { headers: { "Content-Type": "application/json" } } : man && Object.hasOwn(man.files, file) ? man.files[file] : undefined;
  if (!man || !entry) return new Response("no such engine file", { status: 404, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  const o = await env.ENGINES.get(`engine/${id}/${file}`);
  if (!o) return new Response("no such engine file", { status: 404, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  const res = new Response(req.method === "HEAD" ? null : o.body, { headers: { ...entry.headers, ...COMMON, "Content-Length": String(o.size) } });
  if (req.method === "GET" && cache) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
