// Background loading (L0, design-background-loading r1 + r2): after the notebook page is drawn and the browser is idle,
// the files the open document's first Run (or the LaTeX editor's first page) will fetch are downloaded at low
// priority, so they are already in the cache when they're needed. Bytes only: nothing here creates a worker, compiles
// or runs anything (X1's "never at opening" holds: web/test-warm.mjs), and nothing is pinned or kept for good.
//
// What is fetched comes from the document's intent, never "everything": its mode's library groups (a Sage, MATLAB or
// Magma notebook: that mode's start fetches them) and the groups its code cells' import lines name (numpy -> sci),
// by the build's own table (web/build.ts PRELOAD, from the worker's library manifest), so the URLs are exactly the
// worker's. A plain Python notebook that imports nothing from the library fetches nothing: its first Run needs no file
// the page doesn't already have.
//
// Skipped on a Save-Data, slow or offline connection, in a hidden tab, or with little storage left; at most one
// mode's groups per page. A Run doesn't cancel a fetch in flight (the Run's own request for the same file joins it in
// Chromium's cache); it only stops the next one from starting.

/** The build's table (web/build.ts): each library group's bytes and its chunks' name hashes (src, then pre: the files
 * lib/<group>.<kind>.<hash>.json), each mode's groups, and the group each top-level module's entry file is in */
export type PreloadTable = { groups: Record<string, [number, string, string?]>; modes: Record<string, string[]>; tops: Record<string, string> };

/** The top-level module names a document's import lines name, each once, in order. Python's import lines, by text
 * only, anywhere in a cell (inside a function too): `import a, b.c as d` and `from a.b import c`; a string or a comment
 * that looks like one costs a prefetch, never a run. A linear scan, line by line, with no regular expression that
 * could backtrack (PRELOAD674-SCAN-1: the notebook's text is anyone's, and this runs on the page before a Run); a
 * line longer than SCAN_LINE characters is skipped (no import line is that long) */
export const SCAN_LINE = 1000;
export function importTops(codes: readonly string[]): string[] {
  const out: string[] = [];
  const add = (n: string) => { const t = n.split(".")[0]; if (/^[A-Za-z_]\w*$/.test(t) && !out.includes(t)) out.push(t); };
  const sp = (c: string) => c === " " || c === "\t";
  // (the words of `s` split at spaces and tabs)
  const words = (s: string) => s.split(" ").flatMap((w) => w.split("\t")).filter((w) => w !== "");
  for (const code of codes)
    for (const raw of code.split("\n")) {
      if (raw.length > SCAN_LINE) continue;
      let i = 0;
      while (i < raw.length && sp(raw[i])) i++;
      const line = raw.slice(i).replace(/\r$/, "");
      if (line.startsWith("import") && sp(line[6] ?? "")) {
        const h = line.indexOf("#"), rest = h < 0 ? line.slice(7) : line.slice(7, h);
        if (/[^\w. \t,]/.test(rest)) continue; // (only names, dots, commas and spaces: `import a, b.c as d`)
        for (const part of rest.split(",")) {
          const w = words(part);
          if (w.length === 1 || (w.length === 3 && w[1] === "as")) add(w[0]);
        }
      } else if (line.startsWith("from") && sp(line[4] ?? "")) {
        const w = words(line.slice(5));
        if (w.length >= 2 && w[1] === "import" && /^[\w.]+$/.test(w[0])) add(w[0]);
      }
    }
  return out;
}

/** The groups a document's first Run will fetch, in order: its mode's, then those its import lines name (at most one
 * mode's groups: a document has one mode) */
export function intentGroups(t: PreloadTable, mode: string, codes: readonly string[]): string[] {
  const out: string[] = [];
  const add = (g: string | undefined) => { if (g && t.groups[g] && !out.includes(g)) out.push(g); };
  for (const g of t.modes[mode] ?? []) add(g);
  if (mode === "python" || mode === "sage") for (const n of importTops(codes)) add(t.tops[n]);
  return out;
}

/** The files to fetch for those groups, as the worker requests them (beside it, at the site's root) */
export function intentUrls(t: PreloadTable, groups: readonly string[], base: string): string[] {
  return groups.flatMap((g) => { const e = t.groups[g]; return !e ? [] : [`lib/${g}.src.${e[1]}.json`, ...(e[2] ? [`lib/${g}.pre.${e[2]}.json`] : [])]; }).map((f) => new URL(f, base).href);
}

/** Whether background loading may run now, and why not: the user's Save-Data, a slow or offline connection, a hidden
 * tab (asked again before each file) */
export function preloadBlocked(nav: any = navigator, doc: { visibilityState: string } = document): string | null {
  const c = nav.connection;
  if (c?.saveData) return "save-data";
  if (c && /^(slow-2g|2g|3g)$/.test(c.effectiveType ?? "")) return "slow";
  if (nav.onLine === false) return "offline";
  if (doc.visibilityState !== "visible") return "hidden";
  return null;
}

/** Whether `bytes` more fit with room to spare: at least four times them left of the origin's quota (unknown: yes) */
export async function preloadRoom(bytes: number, nav: any = navigator): Promise<boolean> {
  const e = await nav.storage?.estimate?.().catch(() => null);
  if (!e || typeof e.quota !== "number" || typeof e.usage !== "number") return true;
  return e.quota - e.usage >= 4 * bytes;
}

let stopped = false;
/** A Run started (or the page is leaving): no further file is started; one in flight finishes */
export function preloadStop() {
  stopped = true;
}

/** Fetch `urls` one at a time at low priority, reading each to its end (so it is cached); stops before the next file
 * once stopped or blocked, or after a failure. A file that sends nothing for `stallMs` is abandoned, and the loop ends.
 * Each request has the runner broker's shape (no cookie, no referrer, no redirect followed: a redirect is a failure,
 * PRELOAD674-REDIRECT-1; web/notebook/runner-worker.js), so it is the same request the worker's own will be. Resolves to the URLs fetched. */
export async function preloadFetch(urls: readonly string[], blocked: () => string | null = () => preloadBlocked(), stallMs = 30_000): Promise<string[]> {
  const done: string[] = [];
  for (const u of urls) {
    if (stopped || blocked()) break;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), stallMs); };
    try {
      arm();
      const r = await fetch(u, { priority: "low", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: ac.signal } as RequestInit);
      if (!r.ok || !r.body) break;
      const reader = r.body.getReader();
      for (;;) {
        arm();
        const { done: end } = await reader.read();
        if (end) break;
      }
      done.push(u);
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return done;
}

/** What the page's background loading did: null until it ran; then why it skipped, or the files it fetched (the
 * notebook page shows it as window.sagebrush.preload, for its tests and an agent's look) */
export const preloadState: { outcome: null | "off" | "stopped" | "save-data" | "slow" | "offline" | "hidden" | "nothing" | "no-room" | "fetched"; urls: string[]; fetched: string[] } = { outcome: null, urls: [], fetched: [] };

/** At the browser's next idle moment (at most `wait` ms later), once per page: the open document's intent, fetched */
export function preloadSoon(o: { table: PreloadTable; doc: () => { mode: string; codes: string[] } | null; extra?: () => Promise<{ urls: string[]; bytes: number } | null>; wait?: number }) {
  const go = async () => {
    // (a test turns it off before the page loads: window.__sbPreloadOff, set by nothing else)
    if ((globalThis as any).__sbPreloadOff === true) return void (preloadState.outcome = "off");
    const why = stopped ? "stopped" : preloadBlocked();
    if (why) return void (preloadState.outcome = why as typeof preloadState.outcome);
    const d = o.doc(), groups = d ? intentGroups(o.table, d.mode, d.codes) : [];
    const urls = intentUrls(o.table, groups, location.href);
    let bytes = groups.reduce((n, g) => n + o.table.groups[g][0], 0);
    const x = await o.extra?.().catch(() => null);
    if (x) for (const u of x.urls) if (!urls.includes(u)) (urls.push(u), (bytes += x.bytes / x.urls.length));
    preloadState.urls = urls;
    if (!urls.length) return void (preloadState.outcome = "nothing");
    if (!(await preloadRoom(bytes))) return void (preloadState.outcome = "no-room");
    preloadState.fetched = await preloadFetch(urls);
    preloadState.outcome = "fetched";
  };
  const idle = (globalThis as any).requestIdleCallback as ((f: () => void, o: { timeout: number }) => void) | undefined;
  if (idle) idle(() => void go(), { timeout: o.wait ?? 2000 });
  else setTimeout(() => void go(), o.wait ?? 2000);
}
