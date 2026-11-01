// Line 3 of the site asset budget (scripts/site-asset-budget.mjs): the DEV bootstrap's own bytes, measured on an
// identifier-stable measuring variant of the page (not shipped), and cross-checked against the shipped DEV-minus-PROD
// delta. The frozen case document is line-3 case r4 (sha256 2f4170f1…e422), jointly frozen by the grader and
// daybreak2; its section numbers are cited below.
//
// The measuring variant is web/build.ts with SAGEBRUSH_MEASURE_IDS=keep: the app bundle minified for whitespace and
// syntax but NOT identifiers, so the DEV page's script is the PROD page's script with the DEV-only code inserted
// (plus the bundler's deconflicting renames, frozen below). Nothing shipped is built that way.
//
// One run (checkLine3) prints, in order, and stops at the first refusal of steps 0-6 (terminal: exactly one reason,
// no metric):
//   0. pin          bun, typescript, node and zlib are the pinned versions
//      determinism  each measuring page built twice is byte-identical
//   1. html-differs the page outside its app script (the largest inline <script> block without attributes) is the
//                   same in PROD and DEV
//   2. parse        each script parses with no diagnostics
//   3. reconstruct  each script is its parser leaf tokens (full text: leading trivia + text), rejoined exactly
//   4. deletion / length / non-identifier / map-inconsistent: the GNU diff of the two token streams (one
//                   JSON.stringify(fullText) per line) holds only inserted runs and equal-length replaced runs whose
//                   differing tokens are Identifier/Identifier with the same trivia, under ONE consistent map
//   5. baseline-map / baseline-count: the map, its per-pair counts and the PrivateIdentifier counts equal the block
//   6. reconstruct  PROD's tokens with the map applied and the inserted runs placed, in one pass, are DEV's script
//   7. the fragment (the inserted runs, in order, no separators) raw/gzip, then EVERY metric check:
//      baseline-fragment  the fragment equals the block's, exactly
//      xcheck-raw         fragment raw - shipped raw equals the block's gap, exactly
//      xcheck-gzip        fragment gzip - shipped gzip lies in the block's band
//      cap                fragment raw <= 2717 and gzip <= 1395 (absolute; a renewal doesn't move them)
// A renewal (a DEV code change) replaces BASE_BLOCK by the values of a full R1 recalibration, reviewed (§2).
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const PINS = { bun: "1.4.4", typescript: "5.9.3", node: "v24.21.0", zlib: "1.3.2.1-motley-8002e91" };
// (§2: computed by tolerances-r2.py from the 26-commit Node 24.21.0 calibration, line3-calib-n24, kind base)
export const BASE_BLOCK = Object.freeze({
  fragment: { raw: 2589, gzip: 1331 },
  gapRaw: 219,
  pairs: [["open", "open2", 61], ["open2", "open3", 10]],
  privates: { prod: 19, dev: 19 },
  band: [270, 450],
});
export const CAP = Object.freeze({ raw: 2717, gzip: 1395 });
export const VARIANT = "identifier-stable measuring variant (not shipped)";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export const gz = (b) => gzipSync(b, { level: 9 }).length;

// step 0: the four pins, one pure function (the L-pin controls call it with one field changed)
export function pinCheck(observed) {
  const bad = Object.keys(PINS).filter((k) => observed[k] !== PINS[k]);
  return bad.length ? { ok: false, detail: Object.fromEntries(bad.map((k) => [k, { observed: observed[k] ?? null, pinned: PINS[k] }])) } : { ok: true };
}

// step 1: the app script, the largest inline <script> block without attributes
export function splitPage(html) {
  let best = null;
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) if (!best || m[1].length > best[1].length) best = m;
  if (!best) return null;
  const at = best.index + "<script>".length;
  return { before: html.slice(0, at), script: best[1], after: html.slice(at + best[1].length) };
}

// steps 2-3: parse diagnostics, then the parser's leaf tokens with their leading trivia
export function tokens(ts, text) {
  const sf = ts.createSourceFile("app.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostics = sf.parseDiagnostics?.length ?? 0;
  const leaves = [];
  const walk = (n) => { const kids = n.getChildren(sf); if (!kids.length) { leaves.push(n); return; } for (const k of kids) walk(k); };
  walk(sf);
  const toks = leaves.map((n) => ({ full: n.getFullText(sf), text: n.getText(sf), id: n.kind === ts.SyntaxKind.Identifier, priv: n.kind === ts.SyntaxKind.PrivateIdentifier }));
  return { toks, diagnostics, privates: toks.filter((t) => t.priv).length };
}
export const rejoins = (toks, text) => toks.map((t) => t.full).join("") === text;

// step 4: GNU diff (normal format) of the canonical streams: one JSON.stringify(fullText) per line, "\n"-joined, a
// final "\n"; exit 0 or 1 only
export function tokenDiff(A, B) {
  const dir = mkdtempSync(join(tmpdir(), "line3-"));
  try {
    const enc = (t) => t.map((x) => JSON.stringify(x.full)).join("\n") + "\n";
    writeFileSync(join(dir, "a"), enc(A)); writeFileSync(join(dir, "b"), enc(B));
    let out;
    try { out = execFileSync("diff", [join(dir, "a"), join(dir, "b")], { encoding: "utf8", maxBuffer: 1 << 28 }); }
    catch (e) { if (e.status !== 1) throw new Error(`diff exited ${e.status}`); out = e.stdout; }
    return [...out.matchAll(/^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/gm)].map((h) => ({
      kind: h[3],
      a0: h[3] === "a" ? +h[1] : +h[1] - 1, a1: h[3] === "a" ? +h[1] : (h[2] ? +h[2] : +h[1]),
      b0: h[3] === "d" ? +h[4] : +h[4] - 1, b1: h[3] === "d" ? +h[4] : (h[5] ? +h[5] : +h[4]),
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// steps 1-7 on one measuring pair: { ok:false, reason, detail } or { ok:true, fragment, pairs, privates, runs, ... }
export function measurePair(ts, prodHtml, devHtml) {
  const refuse = (reason, detail = {}) => ({ ok: false, reason, detail });
  const P = splitPage(prodHtml), D = splitPage(devHtml);
  if (!P || !D) return refuse("html-differs", { noScript: { prod: !P, dev: !D } });
  if (P.before !== D.before || P.after !== D.after) return refuse("html-differs", { beforeSame: P.before === D.before, afterSame: P.after === D.after });
  const A = tokens(ts, P.script), B = tokens(ts, D.script);
  if (A.diagnostics || B.diagnostics) return refuse("parse", { prod: A.diagnostics, dev: B.diagnostics });
  if (!rejoins(A.toks, P.script)) return refuse("reconstruct", { side: "prod" });
  if (!rejoins(B.toks, D.script)) return refuse("reconstruct", { side: "dev" });
  const hunks = tokenDiff(A.toks, B.toks);
  const map = new Map(), back = new Map(), pairs = new Map(), runs = [];
  for (const h of hunks) {
    if (h.kind === "d") return refuse("deletion", { at: h.a0 });
    if (h.kind === "a") { runs.push({ at: h.b0, text: B.toks.slice(h.b0, h.b1).map((t) => t.full).join("") }); continue; }
    const x = A.toks.slice(h.a0, h.a1), y = B.toks.slice(h.b0, h.b1);
    if (x.length !== y.length) return refuse("length", { at: h.a0, prod: x.length, dev: y.length });
    for (let i = 0; i < x.length; i++) {
      if (x[i].full === y[i].full) continue;
      const lead = (t) => t.full.slice(0, t.full.length - t.text.length);
      if (!x[i].id || !y[i].id || lead(x[i]) !== lead(y[i])) return refuse("non-identifier", { at: h.a0 + i, prod: x[i].full.slice(0, 80), dev: y[i].full.slice(0, 80) });
      if ((map.has(x[i].text) && map.get(x[i].text) !== y[i].text) || (back.has(y[i].text) && back.get(y[i].text) !== x[i].text)) return refuse("map-inconsistent", { prod: x[i].text, dev: y[i].text });
      map.set(x[i].text, y[i].text); back.set(y[i].text, x[i].text);
      const k = x[i].text + "\u0000" + y[i].text; pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  const pairList = [...pairs].map(([k, n]) => [...k.split("\u0000"), n]).sort((a, b) => (a[0] + "\u0000" + a[1] < b[0] + "\u0000" + b[1] ? -1 : 1));
  // step 6: one simultaneous pass
  let rebuilt = "", ai = 0;
  for (const h of hunks) {
    for (; ai < h.a0; ai++) rebuilt += A.toks[ai].full;
    if (h.kind === "a") { rebuilt += B.toks.slice(h.b0, h.b1).map((t) => t.full).join(""); continue; }
    for (; ai < h.a1; ai++) { const t = A.toks[ai]; rebuilt += t.id && map.has(t.text) ? t.full.slice(0, t.full.length - t.text.length) + map.get(t.text) : t.full; }
  }
  for (; ai < A.toks.length; ai++) rebuilt += A.toks[ai].full;
  const frag = Buffer.from(runs.map((r) => r.text).join(""), "utf8");
  return {
    ok: true, rebuiltOk: rebuilt === D.script, pairs: pairList, privates: { prod: A.privates, dev: B.privates },
    runs: runs.map((r) => ({ at: r.at, length: r.text.length })), fragment: { raw: frag.length, gzip: gz(frag) },
  };
}

const samePairs = (a, b) => JSON.stringify(a.map(([x, y]) => [x, y]).sort()) === JSON.stringify(b.map(([x, y]) => [x, y]).sort());
const sameCounts = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// One line-3 run. pages: { prodMeas, devMeas, prodMeas2, devMeas2, prodShip, devShip } (Buffers);
// env: { bun, typescript, node, zlib }; block: BASE_BLOCK unless a control passes a renewed one.
// Returns { reasons: [..], lines: [..], metrics } and never throws on a verdict.
export function checkLine3(ts, pages, env, block = BASE_BLOCK) {
  const lines = [`line 3: ${VARIANT}; shipped deltas labelled shipped`], out = (reasons, metrics = null) => ({ reasons, lines, metrics });
  const stop = (reason, detail) => { lines.push(`line 3 REFUSED ${reason}: ${JSON.stringify(detail)}`); return out([reason]); };
  const pin = pinCheck(env);
  if (!pin.ok) return stop("pin", pin.detail);
  lines.push(`line 3 pin ok: bun ${env.bun}, typescript ${env.typescript}, node ${env.node}, zlib ${env.zlib}`);
  if (sha(pages.prodMeas) !== sha(pages.prodMeas2) || sha(pages.devMeas) !== sha(pages.devMeas2)) return stop("determinism", { prod: [sha(pages.prodMeas), sha(pages.prodMeas2)], dev: [sha(pages.devMeas), sha(pages.devMeas2)] });
  const m = measurePair(ts, pages.prodMeas.toString("utf8"), pages.devMeas.toString("utf8"));
  if (!m.ok) return stop(m.reason, m.detail);
  if (!samePairs(m.pairs, block.pairs)) return stop("baseline-map", { measured: m.pairs, frozen: block.pairs });
  if (!sameCounts(m.pairs, block.pairs) || m.privates.prod !== block.privates.prod || m.privates.dev !== block.privates.dev) return stop("baseline-count", { measured: m.pairs, frozen: block.pairs, privates: m.privates, frozenPrivates: block.privates });
  if (!m.rebuiltOk) return stop("reconstruct", { side: "rebuild" });
  const shipped = { raw: pages.devShip.length - pages.prodShip.length, gzip: gz(pages.devShip) - gz(pages.prodShip) };
  const gap = { raw: m.fragment.raw - shipped.raw, gzip: m.fragment.gzip - shipped.gzip };
  const reasons = [], pf = (ok) => (ok ? "pass" : "FAIL");
  const bf = m.fragment.raw === block.fragment.raw && m.fragment.gzip === block.fragment.gzip;
  const xr = gap.raw === block.gapRaw, xg = gap.gzip >= block.band[0] && gap.gzip <= block.band[1];
  const cr = m.fragment.raw <= CAP.raw, cg = m.fragment.gzip <= CAP.gzip;
  lines.push(`line 3 baseline-fragment ${pf(bf)}: measured ${m.fragment.raw}/${m.fragment.gzip}, frozen ${block.fragment.raw}/${block.fragment.gzip} (${VARIANT})`);
  lines.push(`line 3 xcheck-raw ${pf(xr)}: gap ${gap.raw} = fragment ${m.fragment.raw} - shipped ${shipped.raw}, frozen ${block.gapRaw}`);
  lines.push(`line 3 xcheck-gzip ${pf(xg)}: gap ${gap.gzip} = fragment ${m.fragment.gzip} - shipped ${shipped.gzip}, band [${block.band[0]}, ${block.band[1]}]`);
  lines.push(`line 3 cap raw ${m.fragment.raw}/${CAP.raw} ${pf(cr)}, gzip ${m.fragment.gzip}/${CAP.gzip} ${pf(cg)}`);
  if (!bf) reasons.push("baseline-fragment");
  if (!xr) reasons.push("xcheck-raw");
  if (!xg) reasons.push("xcheck-gzip");
  if (!cr || !cg) reasons.push("cap");
  lines.push(`line 3 reasons: ${JSON.stringify(reasons)}; pairs ${JSON.stringify(m.pairs)}; privates ${m.privates.prod}/${m.privates.dev}; runs ${m.runs.length}`);
  return out(reasons, { fragment: m.fragment, shipped, gap, pairs: m.pairs, privates: m.privates, runs: m.runs });
}
