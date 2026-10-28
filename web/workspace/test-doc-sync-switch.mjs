// DEV's switch for notebooks' contents (web/workspace/doc-sync-switch.ts): it fails closed.  Every combination of its
// three conditions (the origin, the server's `available`, a running sync client): on only for DEV's own origin with
// both others true; PROD's origin never, whatever else holds; nothing asked past the first failing condition.  And,
// read from the sources, no way for a page, a URL or storage to widen it: the allowed origins are a frozen constant,
// the page calls the gate without an origins argument, and only the switch's own block turns DOC_SYNC on.
//   bun web/workspace/test-doc-sync-switch.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_SYNC_ORIGINS, DOC_SYNC_NOTE, docSyncOrigin, docSyncAvailable, docSyncAllowed } from "./doc-sync-switch.ts";

const here = dirname(fileURLToPath(import.meta.url)), web = join(here, "..");
const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;

const DEV = "https://dev.sagebrush.space", PROD = "https://sagebrush.space";
check(J(DOC_SYNC_ORIGINS) === J([DEV]) && Object.isFrozen(DOC_SYNC_ORIGINS), "the allowed origins: DEV's only, frozen: " + J(DOC_SYNC_ORIGINS));
let pushed = "no throw";
try { DOC_SYNC_ORIGINS.push(PROD); } catch (e) { pushed = "threw"; }
check(pushed === "threw" && !DOC_SYNC_ORIGINS.includes(PROD), "the allowed origins can't be added to at run time");

// (each status answer: what the fake fetch gives, and whether it is `available`)
const statuses = {
  "200 available": () => new Response(J({ available: true, state: "active" }), { status: 200 }),
  "200 not available": () => new Response(J({ available: false, reason: "not_allowlisted", state: "off" }), { status: 200 }),
  "200 available as a string": () => new Response(J({ available: "true" }), { status: 200 }),
  "200 not JSON": () => new Response("<html>", { status: 200 }),
  "404 (no sync route: PROD's site)": () => new Response("not found", { status: 404 }),
  "401": () => new Response(J({ error: "sign in first" }), { status: 401 }),
  "503 whose body says available": () => new Response(J({ available: true }), { status: 503 }),
  "202 whose body says available": () => new Response(J({ available: true }), { status: 202 }),
  "a network failure": () => { throw new TypeError("failed to fetch"); },
};
const clients = { running: async () => true, "not running": async () => false, "a failure": async () => { throw new Error("x"); }, "a truthy non-true": async () => "yes" };
const origins = [DEV, PROD, "http://localhost:8000", "http://127.0.0.1:5173", "https://dev.sagebrush.space.evil.test", "https://DEV.sagebrush.space", "null", ""];
let cases = 0, wrong = [];
for (const origin of origins) for (const [sname, sf] of Object.entries(statuses)) for (const [cname, cf] of Object.entries(clients)) {
  let asked = 0, askedClient = 0;
  const fetchFn = async (url) => { asked++; if (url !== origin + "/api/sync/v1/status") throw new Error("asked " + url); return sf(); };
  const got = await docSyncAllowed({ origin, fetch: fetchFn, clientRunning: () => { askedClient++; return cf(); } });
  const want = origin === DEV && sname === "200 available" && cname === "running";
  cases++;
  if (got !== want) wrong.push(`${origin} / ${sname} / ${cname}: ${got}`);
  // (nothing asked past the first failing condition)
  if (origin !== DEV && (asked || askedClient)) wrong.push(`${origin}: asked the server or the client on an origin that isn't DEV's`);
  if (origin === DEV && sname !== "200 available" && askedClient) wrong.push(`${origin} / ${sname}: asked the client after the server said no`);
}
check(wrong.length === 0, `the gate over ${cases} combinations: on only for DEV + available + a running client; nothing asked past a failing condition: ` + J(wrong.slice(0, 5)));
const prodAll = await docSyncAllowed({ origin: PROD, fetch: async () => statuses["200 available"](), clientRunning: async () => true });
check(prodAll === false, "PROD's origin with every other condition true: off");
check(docSyncOrigin(PROD) === false && docSyncOrigin(DEV) === true, "docSyncOrigin: DEV yes, PROD no");
check((await docSyncAvailable(DEV, async () => statuses["200 available"]())) === true && (await docSyncAvailable(DEV, async () => statuses["404 (no sync route: PROD's site)"]())) === false, "docSyncAvailable: 200 available yes, 404 no");
check(DOC_SYNC_NOTE.some((t) => /lasting for this browser/.test(t)) && DOC_SYNC_NOTE.some((t) => /sagebrush\.space \(not DEV\) is a separate site/.test(t)) && DOC_SYNC_NOTE.some((t) => /Boards don't sync yet/.test(t)), "the Sync panel's note says the activation lasts, that PROD isn't affected, and that boards don't sync yet");

// ---- from the sources: no reachable override
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|js|mjs|html)$/.test(n) && !/^test-|\.page\.js$|-cases\.js$/.test(n)) files.push(p);
  }
})(web);
const src = (p) => readFileSync(p, "utf8");
const using = (re) => files.filter((p) => re.test(src(p))).map((p) => relative(web, p)).sort();
check(J(using(/DOC_SYNC_ORIGINS/)) === J(["workspace/doc-sync-switch.ts", "workspace/index.ts"]), "DOC_SYNC_ORIGINS named only where it is defined and re-exported: " + J(using(/DOC_SYNC_ORIGINS/)));
const sw = src(join(here, "doc-sync-switch.ts"));
check(!/window\.|globalThis\.|localStorage|sessionStorage|URLSearchParams|location\.|document\./.test(sw), "the switch's module reads no window, global, storage, URL or location of its own");
const page = src(join(web, "index.html"));
const calls = [...page.matchAll(/docSyncAllowed\(/g)].length;
const oneArg = page.includes("docSyncAllowed({ origin: location.origin, fetch: globalThis.fetch.bind(globalThis), clientRunning: () => owner.clientRunning() });");
check(calls === 1 && oneArg, "the page calls the gate once, with no origins argument (the frozen default)");
check([...page.matchAll(/docSyncOrigin\(([^)]*)\)/g)].every((m) => m[1] === "location.origin"), "the page's origin checks are of location.origin alone");
check(J(using(/DOC_SYNC\.on = true/)) === J(["index.html"]) && /if \(!allowed\) return false;[\s\S]*mod\.DOC_SYNC\.on = true/.test(page), "only the page's switch turns DOC_SYNC on, after the gate");
check(J(using(/activateJournal\(\)/).filter((p) => p !== "workspace/api.ts")) === J(["index.html"]) && /if \(!allowed\) return false;[\s\S]*w\.activateJournal\(\)/.test(page), "only the page's switch activates the journal, after the gate");

const fails = results.filter(([ok]) => !ok).map(([, w]) => w);
if (fails.length) { console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: the DEV switch for notebooks' contents fails closed, ${results.length} checks`);
if (process.env.SHOW) for (const [, w] of results) console.log("  " + w);
