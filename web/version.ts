// Which build a site serves, so whoever tests it can say exactly what they tested: "core 1a2b3c4d · cloud n38 ·
// 2026-11-21 21:40 UTC" in the landing page's footer and on the agents page.
//   handleVersion(request, buildId) -> GET /api/version, from the Worker's generated build-id.ts: its BUILD (the
//     build's time, base 36 milliseconds, web/build.ts) and the RELEASE line a release build appends ({n, core}).
//     {"core", "n", "built"}, never cached; a build with no release (a local or preview build) answers nothing here,
//     so the request goes on to the 404 page and no stamp shows.
//   parseVersion(x) -> the answer when it has exactly that shape, else null: the page shows nothing it can't check.
//   stampText(v) -> the stamp's one line.
//   mountVersionStamp(el) -> the page side: fetch, check, and write the line as text into el, shown only then.
//     In the desktop app it shows the app's own build instead, from window.__SB_APP_VERSION__ (the app sets it before
//     the page's script runs: app/src-tauri/src/version.rs), and asks no server: "Sagebrush app 0.4.0 · 1a2b3c4d".
//   parseAppVersion(x), appStampText(v) -> the app's version, checked as strictly, and its line.
// The stamp names the Worker that answered; it is not an attestation of what was built.

export interface SiteVersion {
  core: string;
  n: number;
  built: string;
}

const SHA = /^[0-9a-f]{40}$/;
// (an ISO time as Date#toISOString writes it, UTC, with milliseconds)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseVersion(x: unknown): SiteVersion | null {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "built,core,n") return null;
  const { core, n, built } = o;
  if (typeof core !== "string" || !SHA.test(core)) return null;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return null;
  if (typeof built !== "string" || !ISO.test(built) || Number.isNaN(Date.parse(built))) return null;
  return { core, n, built };
}

export function stampText(v: SiteVersion): string {
  // (minutes are enough to tell two deploys apart; the full time is in /api/version)
  const t = v.built.slice(0, 10) + " " + v.built.slice(11, 16) + " UTC";
  return `core ${v.core.slice(0, 8)} · cloud n${v.n} · ${t}`;
}

/** The build's version from a Worker's build-id.ts module (BUILD, and RELEASE when a release build appended it). */
export function versionOf(buildId: { BUILD?: unknown; RELEASE?: unknown }): SiteVersion | null {
  const { BUILD, RELEASE } = buildId;
  if (typeof BUILD !== "string" || !/^[0-9a-z]{1,12}$/.test(BUILD)) return null;
  const ms = parseInt(BUILD, 36);
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  const r = RELEASE as { n?: unknown; core?: unknown } | null | undefined;
  if (r === null || typeof r !== "object") return null;
  return parseVersion({ core: r.core, n: r.n, built: new Date(ms).toISOString() });
}

export function handleVersion(request: Request, buildId: { BUILD?: unknown; RELEASE?: unknown }): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/api/version" || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const v = versionOf(buildId);
  if (!v) return null;
  return new Response(request.method === "HEAD" ? null : JSON.stringify(v), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export interface AppVersion {
  version: string;
  commit: string;
}

/** The desktop app's {version, commit}: a version of three numbers and a commit of 40 lowercase hex digits (or
 * "unknown", a build outside a git checkout), and nothing else; else null. */
export function parseAppVersion(x: unknown): AppVersion | null {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "commit,version") return null;
  const { version, commit } = o;
  if (typeof version !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return null;
  if (typeof commit !== "string" || !(SHA.test(commit) || commit === "unknown")) return null;
  return { version, commit };
}

export function appStampText(v: AppVersion): string {
  return `Sagebrush app ${v.version} · ${v.commit === "unknown" ? "commit unknown" : v.commit.slice(0, 8)}`;
}

/** Fill el with this site's stamp, if the site answers /api/version with one; otherwise leave it hidden. In the
 * desktop app (`app`, its window.__SB_APP_VERSION__), the app's build instead, and no request. */
export async function mountVersionStamp(el: HTMLElement | null, fetchImpl: typeof fetch = fetch, app: unknown = (globalThis as any).__SB_APP_VERSION__): Promise<boolean> {
  if (!el) return false;
  if (app !== undefined) {
    const v = parseAppVersion(app);
    if (!v) return false;
    el.textContent = appStampText(v);
    el.title = `the Sagebrush app ${v.version}, built from commit ${v.commit}`;
    el.hidden = false;
    return true;
  }
  try {
    const res = await fetchImpl("/api/version", { cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) return false;
    const v = parseVersion(await res.json());
    if (!v) return false;
    el.textContent = stampText(v);
    el.title = `core ${v.core}, release n${v.n}, built ${v.built}`;
    el.hidden = false;
    return true;
  } catch {
    return false;
  }
}
