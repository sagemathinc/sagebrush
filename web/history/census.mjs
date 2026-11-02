// The static census of history's change tokens (Stage A layer 1; design stage-a-l1 r2.2 §4 [G2]): every readwrite
// transaction in web/ (tests aside) whose scope names a source store (the workspace's entries, fileBytes, boards; the
// notebooks), or whose scope isn't a plain literal (so it might), must be in census-map.json, classified:
//   TOKEN        it writes each changed identity's token in the transaction (web/history/tokens.ts noteToken)
//   EXEMPT       it changes no content of a source (a reason given; behaviour-checked where the design says so)
//   READ-ONLY    it has a source store in scope only to read it
//   NOT-SOURCE   its stores are none of the sources (another database, or meta-only)
// An unmapped site fails, and so does a mapped site that no longer exists (the map can't go stale).  A site is keyed by
// its file and its trimmed source line, with an ordinal for identical lines in one file, so an edit to a site's line
// makes it unmapped until it is classified again.
//   bun web/history/census.mjs            (exit 1 on any unmapped or stale site)
//   bun web/history/census.mjs --list     (every site found, keyed)
//   bun web/history/census.mjs --extra F  (F scanned too: the control)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const here = new URL(".", import.meta.url).pathname, web = join(here, "..");
const SOURCES = /"(entries|fileBytes|boards|notebooks)"/;
// (a readwrite transaction's opening: inTx/mainTx/idb(db, SCOPE, "readwrite", ...) or db.transaction(SCOPE, "readwrite"))
const SITE = /(?:\b(?:inTx|mainTx|idb)\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*([^]*?)\s*,\s*"readwrite"|\.transaction\(\s*([^]*?)\s*,\s*"readwrite"\s*\))/g;
const LITERAL = /^(?:"[^"]*"|\[\s*(?:"[^"]*"\s*,?\s*)*\])$/;

const skip = (p) => /(^|\/)(node_modules|dist|vendor)(\/|$)/.test(p) || /(^|\/)test-[^/]*$|-cases\.js$|\.page\.js$|(^|\/)census\.mjs$/.test(p);
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), rel = relative(web, p);
    if (skip(rel)) continue;
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|js|mjs|mts|html)$/.test(name)) yield p;
  }
}
export function sites(extra = []) {
  const out = [];
  for (const p of [...files(web), ...extra]) {
    const rel = p.startsWith(web) ? relative(web, p) : p, seen = new Map();
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(SITE)) {
        const scope = (m[1] ?? m[2] ?? "").trim();
        if (!SOURCES.test(scope) && LITERAL.test(scope)) continue;
        const text = line.trim().slice(0, 400), k = `${rel}|${text}`, ord = (seen.get(k) ?? 0) + 1;
        seen.set(k, ord);
        out.push({ key: `${rel}|${ord}|${text}`, file: rel, line: i + 1, scope });
      }
    });
  }
  return out;
}

if (import.meta.main) {
  // (--extra FILE: a file outside web/ scanned too: the census's control, a fixture with a new site, must fail)
  const ei = process.argv.indexOf("--extra"), found = sites(ei > 0 ? [process.argv[ei + 1]] : []);
  if (process.argv.includes("--list")) {
    for (const s of found) console.log(`${s.file}:${s.line}  ${s.scope}`);
    console.log(`${found.length} sites`);
    process.exit(0);
  }
  const map = JSON.parse(readFileSync(join(here, "census-map.json"), "utf8"));
  const CLASSES = new Set(["TOKEN", "EXEMPT", "READ-ONLY", "NOT-SOURCE"]);
  const fails = [];
  for (const s of found) {
    const c = map.sites[s.key];
    if (!c) fails.push(`UNMAPPED ${s.file}:${s.line}  ${s.scope}`);
    else if (!CLASSES.has(c.class) || (c.class === "EXEMPT" && !(c.why?.length > 10))) fails.push(`BAD CLASS ${s.file}:${s.line}  ${J(c)}`);
  }
  const keys = new Set(found.map((s) => s.key));
  for (const k of Object.keys(map.sites)) if (!keys.has(k)) fails.push(`STALE (mapped, not found) ${k.slice(0, 200)}`);
  if (fails.length) {
    console.error(`FAIL: ${fails.length} census problems\n  ` + fails.join("\n  "));
    process.exit(1);
  }
  console.log(`ok: history's census, ${found.length} readwrite sites classified (${[...CLASSES].map((c) => `${c} ${found.filter((s) => map.sites[s.key].class === c).length}`).join(", ")})`);
}
function J(x) { return JSON.stringify(x); }
