// The atlas's routes, for the site's Worker (web/site/src/index.ts) and the
// local test server (web/atlas/serve.mjs).  `asset(path)` fetches a static
// file (the data under /atlas/data/); null means "not an atlas page".
//
//   /atlas/                 front page            /atlas/about   about
//   /atlas/mf/?...          search (q= jumps to a label; format=json)
//   /atlas/mf/N.k.a[.json]  a newspace            /atlas/mf/N.k.a.x[.json]  a newform orbit
import { type Orbit, type Space, derive, parseLabel, spaceLabel } from "./model.ts";
import { type IndexRow, type Query, esc, href, orbitBody, orbitTitle, page, pendingBody, search, searchBody, spaceBody, spaceCrumbs, spaceTitle } from "./render.ts";
import { type Stats, aboutBody, homeBody } from "./pages.ts";

type Asset = (path: string) => Promise<Response>;

let indexCache: IndexRow[] | null = null;
let statsCache: Stats | null = null;

async function json<T>(asset: Asset, path: string): Promise<T | null> {
  const r = await asset(path);
  return r.ok ? ((await r.json()) as T) : null;
}

const html = (body: string, status = 200, cache = "public, max-age=600") => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache } });
const jsonResponse = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=600" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

function orbitJson(sp: Space, f: Orbit) {
  return { ...f, space: sp.label, level: sp.level, weight: sp.weight, T: sp.T, status: sp.status, derived: derive(sp, f), url: `https://sagebrush.space${href(f.label)}` };
}

function notFound(what: string, wantJson: boolean) {
  if (wantJson) return jsonResponse({ error: `${what} not found` }, 404);
  return html(page({ title: "Not found", description: "Not found", path: "/atlas/", crumbs: [["Atlas", "/atlas/"]], body: `<h1>Not found</h1><p>${esc(what)} is not in the atlas. <a href="/atlas/mf/">Search</a>, or open a label such as <a href="/atlas/mf/389.2.a">389.2.a</a>.</p>`, noindex: true }), 404);
}

/** Where a search box's text leads: a label, a level, or a curve. */
async function jump(q: string, asset: Asset): Promise<string | null> {
  const s = q.trim().replace(/\s+/g, "");
  if (parseLabel(s)) return href(s);
  let m = /^(\d+)\.(\d+)$/.exec(s);
  if (m) return href(spaceLabel(+m[1], +m[2]));
  if (/^\d+$/.test(s)) return href(spaceLabel(+s, 2));
  m = /^(\d+)\.([a-z]+)\d*$/.exec(s); // LMFDB curve or class: the newform has its letter
  if (m) return href(`${m[1]}.2.a.${m[2]}`);
  m = /^(\d+)([a-z]+)(\d*)$/.exec(s); // Cremona's label
  if (m) {
    const idx = await loadIndex(asset);
    const row = idx.find((r) => r[7] && r[7][0] === `${m![1]}${m![2]}1`);
    if (row) return href(row[0]);
  }
  return null;
}

async function loadIndex(asset: Asset) {
  return (indexCache ??= (await json<IndexRow[]>(asset, "/atlas/data/index.json")) ?? []);
}
async function loadStats(asset: Asset) {
  return (statsCache ??= await json<Stats>(asset, "/atlas/data/stats.json"));
}

export async function handleAtlas(request: Request, asset: Asset): Promise<Response | null> {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path === "/atlas") return redirect("/atlas/");
  if (!path.startsWith("/atlas/")) return null;
  const wantJson = path.endsWith(".json") || url.searchParams.get("format") === "json" || /application\/json/.test(request.headers.get("accept") ?? "");
  if (path === "/atlas/" || path === "/atlas/about") {
    const st = await loadStats(asset);
    if (!st) return null;
    if (wantJson) return jsonResponse(st);
    return path === "/atlas/"
      ? html(page({ title: "Modular forms", description: `Every newform orbit of weight 2 and level up to 1000 (and weights 4-12), proven by Sagebrush's Rust engines; anything else computed in your browser.`, path, crumbs: [["Atlas"]], body: homeBody(st), json: "/atlas/data/stats.json" }))
      : html(page({ title: "About", description: "How the Sagebrush Atlas is computed and checked.", path, crumbs: [["Atlas", "/atlas/"], ["About"]], body: aboutBody(st), json: "/atlas/data/stats.json" }));
  }
  if (path === "/atlas/mf" || path === "/atlas/mf/") {
    const p = url.searchParams;
    if (p.get("q")) {
      const to = await jump(p.get("q")!, asset);
      if (to) return redirect(to);
    }
    if (p.get("go") && /^\d+$/.test(p.get("level") ?? "")) return redirect(href(spaceLabel(+p.get("level")!, +(p.get("weight") || 2))));
    const q: Query = {};
    for (const k of ["weight", "level", "dim", "cm", "sign", "rank"] as const) if (p.get(k)) q[k] = p.get(k)!;
    const start = Math.max(0, +(p.get("start") ?? 0) || 0), size = Math.min(1000, Math.max(1, +(p.get("limit") ?? 100) || 100));
    const rows = search(await loadIndex(asset), q);
    if (wantJson) return jsonResponse({ query: q, total: rows.length, start, results: rows.slice(start, start + size).map((r) => ({ label: r[0], level: r[1], weight: r[2], dim: r[3], cm: r[4] || null, sign: r[5] || null, traces: r[6], curve: r[7] ? { cremona: r[7][0], rank: r[7][1], torsion: r[7][2] } : null, lmfdb: r[8] > 0 ? "agrees" : r[8] < 0 ? "differs" : null })) });
    const unknown = p.get("q") ? `<p class="status bad">“${esc(p.get("q"))}” is not a label the atlas understands (try 389.2.a.e, 389.2.a, 389, 11a1 or 11.a).</p>` : "";
    return html(page({ title: "Search", description: "Search the newform orbits of the Sagebrush Atlas.", path: "/atlas/mf/", crumbs: [["Atlas", "/atlas/"], ["Modular forms", "/atlas/"], ["Search"]], body: unknown + searchBody(q, rows.slice(start, start + size), rows.length, start, size), json: `/atlas/mf/?${p.toString()}&format=json`, noindex: true }));
  }
  if (path.startsWith("/atlas/mf/")) {
    const name = decodeURIComponent(path.slice("/atlas/mf/".length)).replace(/\.json$/, "");
    const L = parseLabel(name);
    if (!L) return notFound(name, wantJson);
    const { level: n, weight: k, letter } = L;
    const sp = await json<Space>(asset, `/atlas/data/mf/${k}/${n}.json`);
    if (!sp) {
      if (wantJson) return jsonResponse({ error: `${name} is not stored`, stored: false, compute: `Run newform_orbits(${n}, ${k}) in Sage mode (npx sagebrush --sage), or open https://sagebrush.space${href(name)} in a browser, which computes it.` }, 404);
      const body = k % 2 === 1 || k < 2
        ? `<h1>Newspace ${esc(spaceLabel(n, k))}</h1><p>With the trivial character there are no modular forms of odd weight: this space is 0.</p>`
        : pendingBody(n, k, letter);
      return html(page({ title: name, description: `The newspace ${spaceLabel(n, k)}, computed in your browser.`, path: href(name), crumbs: spaceCrumbs(n, k), body, noindex: true }), 200, "public, max-age=3600");
    }
    if (!letter) {
      if (wantJson) return jsonResponse({ ...sp, url: `https://sagebrush.space${href(sp.label)}`, newforms: sp.newforms.map((f) => ({ ...f, derived: derive(sp, f) })) });
      return html(page({ title: spaceTitle(n, k), description: `Newspace ${sp.label}: dimension ${sp.dims.new}, ${sp.newforms.length} Galois orbits of newforms of weight ${k} and level ${n}.`, path: href(sp.label), crumbs: spaceCrumbs(n, k), body: spaceBody(sp), json: href(sp.label) + ".json" }));
    }
    const f = sp.newforms.find((o) => o.letter === letter);
    if (!f) return notFound(name, wantJson);
    if (wantJson) return jsonResponse(orbitJson(sp, f));
    return html(page({ title: orbitTitle(f), description: `Newform orbit ${f.label}: dimension ${f.dim}, weight ${k}, level ${n}. q-expansion, coefficient field, Atkin-Lehner signs, traces of a_p.`, path: href(f.label), crumbs: [...spaceCrumbs(n, k).slice(0, -1), [sp.label, href(sp.label)], [f.label]], body: orbitBody(sp, f), json: href(f.label) + ".json" }));
  }
  return null;
}
