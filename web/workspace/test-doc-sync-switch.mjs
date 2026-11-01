// The switch for notebooks' contents (web/workspace/doc-sync-switch.ts), DEV's and PROD's: it fails closed.  Every
// combination of its three conditions (the origin, the server's `available`, a running sync client): on only for
// DEV's or PROD's own origin exactly with both others true; any other origin (look-alikes, http:, www.) never,
// whatever else holds; nothing asked past the first failing condition.  And,
// read from the sources, no way for a page, a URL or storage to widen it: the allowed origins are a frozen constant,
// the pages call the gate without an origins argument, and only the switch's own block turns DOC_SYNC on.  Then the
// switch's turning on (enableDocSync) with every failure injected, and a board page's following (followDocSync).
//   bun web/workspace/test-doc-sync-switch.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSite, SITE_GENERATED_ROOTS } from "../site-dir.mts";
import { DOC_SYNC_ORIGINS, DOC_SYNC_NOTE, DOC_SYNC_RELOAD, docSyncOrigin, docSyncAvailable, docSyncAllowed, enableDocSync, followDocSync, docSyncChannel } from "./doc-sync-switch.ts";

const here = dirname(fileURLToPath(import.meta.url)), web = join(here, "..");
const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;

const DEV = "https://dev.sagebrush.space", PROD = "https://sagebrush.space";
check(J(DOC_SYNC_ORIGINS) === J([DEV, PROD]) && Object.isFrozen(DOC_SYNC_ORIGINS), "the allowed origins: DEV's and PROD's exactly, frozen: " + J(DOC_SYNC_ORIGINS));
let pushed = "no throw";
const OTHER = "https://evil.test";
try { DOC_SYNC_ORIGINS.push(OTHER); } catch (e) { pushed = "threw"; }
check(pushed === "threw" && !DOC_SYNC_ORIGINS.includes(OTHER), "the allowed origins can't be added to at run time");

// (each status answer: what the fake fetch gives, and whether it is `available`)
const statuses = {
  "200 available": () => new Response(J({ available: true, state: "active" }), { status: 200 }),
  "200 not available": () => new Response(J({ available: false, reason: "not_allowlisted", state: "off" }), { status: 200 }),
  "200 available as a string": () => new Response(J({ available: "true" }), { status: 200 }),
  "200 not JSON": () => new Response("<html>", { status: 200 }),
  "404 (no sync route: a site without sync)": () => new Response("not found", { status: 404 }),
  "401": () => new Response(J({ error: "sign in first" }), { status: 401 }),
  "503 whose body says available": () => new Response(J({ available: true }), { status: 503 }),
  "202 whose body says available": () => new Response(J({ available: true }), { status: 202 }),
  "a network failure": () => { throw new TypeError("failed to fetch"); },
};
const clients = { running: async () => true, "not running": async () => false, "a failure": async () => { throw new Error("x"); }, "a truthy non-true": async () => "yes" };
const origins = [DEV, PROD, "http://localhost:8000", "http://127.0.0.1:5173", "https://dev.sagebrush.space.evil.test", "https://sagebrush.space.evil.test", "http://sagebrush.space", "https://www.sagebrush.space", "https://DEV.sagebrush.space", "null", ""];
let cases = 0, wrong = [];
for (const origin of origins) for (const [sname, sf] of Object.entries(statuses)) for (const [cname, cf] of Object.entries(clients)) {
  let asked = 0, askedClient = 0;
  const fetchFn = async (url) => { asked++; if (url !== origin + "/api/sync/v1/status") throw new Error("asked " + url); return sf(); };
  const got = await docSyncAllowed({ origin, fetch: fetchFn, clientRunning: () => { askedClient++; return cf(); } });
  const ours = origin === DEV || origin === PROD;
  const want = ours && sname === "200 available" && cname === "running";
  cases++;
  if (got !== want) wrong.push(`${origin} / ${sname} / ${cname}: ${got}`);
  // (nothing asked past the first failing condition)
  if (!ours && (asked || askedClient)) wrong.push(`${origin}: asked the server or the client on an origin that isn't DEV's or PROD's`);
  if (ours && sname !== "200 available" && askedClient) wrong.push(`${origin} / ${sname}: asked the client after the server said no`);
}
check(wrong.length === 0, `the gate over ${cases} combinations: on only for DEV or PROD + available + a running client; nothing asked past a failing condition: ` + J(wrong.slice(0, 5)));
const prodAll = await docSyncAllowed({ origin: PROD, fetch: async () => statuses["200 available"](), clientRunning: async () => true });
check(prodAll === true, "PROD's origin with every other condition true: on");
const prodOff = await docSyncAllowed({ origin: PROD, fetch: async () => statuses["200 not available"](), clientRunning: async () => true });
check(prodOff === false, "PROD's origin when the server says not available (off the allowlist): off");
check(docSyncOrigin(PROD) === true && docSyncOrigin(DEV) === true && docSyncOrigin("https://www.sagebrush.space") === false && docSyncOrigin("http://sagebrush.space") === false, "docSyncOrigin: DEV and PROD yes, www. and http: no");
check((await docSyncAvailable(DEV, async () => statuses["200 available"]())) === true && (await docSyncAvailable(DEV, async () => statuses["404 (no sync route: a site without sync)"]())) === false, "docSyncAvailable: 200 available yes, 404 no");
check(DOC_SYNC_NOTE.some((t) => /lasting for this browser/.test(t)) && DOC_SYNC_NOTE.some((t) => /dev\.sagebrush\.space and sagebrush\.space are separate sites/.test(t)) && !DOC_SYNC_NOTE.some((t) => /DEV only/.test(t)) && DOC_SYNC_NOTE.some((t) => /Boards don't sync yet/.test(t)), "the Sync panel's note says the activation lasts, that the two sites are separate, and that boards don't sync yet (and never 'DEV only')");

// ---- from the sources: no reachable override
const files = [];
// (core's authored sources only.  Skipped by name: dependencies (node_modules) and dot-directories anywhere; the
// server directories directly under web/ (SERVER: the cloud repository's code, which core never reads; this census
// and its claim below are about core's own sources); and these GENERATED roots of
// web/, build output, never authored: dist (the built site) and the site's generated roots as core lists them
// (SITE_GENERATED_ROOTS in web/site-dir.mts; the site repository checks its own .gitignore against that list).  A
// build before this test (CI's checks line) leaves copies there that would count as callers.  The site's roots sit
// under site/, which SERVER skips whole; they stay listed so the census stays right if that skip ever changes.
// Nothing else is skipped, so an activation path added anywhere else in core is counted)
const SERVER = ["site", "files", "share", "sync", "lti"];
const GENERATED = ["dist", ...(hasSite ? SITE_GENERATED_ROOTS.map((r) => "site/" + r) : [])];
const skipped = [], skippedServer = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(d, n);
    if (d === web && SERVER.includes(n)) { skippedServer.push(n); continue; }
    if (GENERATED.includes(relative(web, p))) { skipped.push(relative(web, p)); continue; }
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|js|mjs|html)$/.test(n) && !/^test-|\.page\.js$|-cases\.js$/.test(n)) files.push(p);
  }
})(web);
const src = (p) => readFileSync(p, "utf8");
check(skipped.every((r) => GENERATED.includes(r)) && skippedServer.every((r) => SERVER.includes(r)), "the census of core's sources skips only the generated roots it names (" + GENERATED.join(", ") + ") and the server directories under web/ (" + SERVER.join(", ") + "), by name: skipped " + J([...skipped, ...skippedServer]));
const using = (re) => files.filter((p) => re.test(src(p))).map((p) => relative(web, p)).sort();
check(J(using(/DOC_SYNC_ORIGINS/)) === J(["workspace/doc-sync-switch.ts", "workspace/index.ts"]), "in core's sources, DOC_SYNC_ORIGINS named only where it is defined and re-exported: " + J(using(/DOC_SYNC_ORIGINS/)));
const sw = src(join(here, "doc-sync-switch.ts"));
check(!/window\.|globalThis\.|localStorage|sessionStorage|URLSearchParams|location\.|document\./.test(sw), "the switch's module reads no window, global, storage, URL or location of its own");
const page = src(join(web, "index.html")), board = src(join(web, "board", "page.ts"));
const GATE = "docSyncAllowed({ origin: location.origin, fetch: globalThis.fetch.bind(globalThis), clientRunning: () => owner.clientRunning() });";
check(J(using(/docSyncAllowed\(/)) === J(["board/page.ts", "index.html", "workspace/doc-sync-switch.ts"]), "the gate called only by the notebook page and the board page: " + J(using(/docSyncAllowed\(/)));
for (const [name, s] of [["the notebook page", page], ["the board page", board]]) {
  check([...s.matchAll(/docSyncAllowed\(/g)].length === 1 && s.includes(GATE), `${name} calls the gate once, with no origins argument (the frozen default)`);
  check([...s.matchAll(/docSyncOrigin\(([^)]*)\)/g)].every((m) => m[1] === "location.origin") && /docSyncOrigin\(location\.origin\)/.test(s), `${name}'s origin checks are of location.origin alone`);
}
check(J(using(/DOC_SYNC\.on = true/)) === J(["workspace/doc-sync-switch.ts"]) && J(using(/enableDocSync\(/)) === J(["index.html", "workspace/doc-sync-switch.ts"]) && /if \(!allowed\) return false;\s*return \(await enableDocSync\(\{/.test(page), "only the switch's enableDocSync turns DOC_SYNC on, called only by the notebook page, right after the gate");
check(page.split("await recreating(").length === 3 && page.split("  replaying = true;\n").length === 2 && page.split("    replaying = false;\n").length === 2 && /async function recreating\(run\) \{\n  while \(docSwitch\) await docSwitch;\n  if \(docSyncNeedsReload\) \{/.test(page), "the page's two session recreations (replay, recompute) go through recreating, the one place replaying is set: after the switch, never once it needs a reload (astra's DEVSW-2-R2, R3)");
check(page.split("  nb.setReadOnly(c.readOnly || !!ws?.quarantined || docSyncNeedsReload);").length === 2, "the page's showWriter keeps the switch's reload read-only (astra's DEVSW-2-R3)");
check(["    own: ownNotebook,", "    readOnlyNow: shownReadOnly,", "    reopen: reopenJournaled,", "    needReload: docSyncReload,", "    begun: () => w.journalBegun(),", "    setDocs: (docs) => owner.setDocs(docs),"].every((l) => page.split(l).length === 2), "the notebook page's switch uses its own read-only rule, reopen and reload (tested in test-journal.mjs), and the workspace's journalBegun");
check(J(using(/activateJournal\(\)/).filter((p) => p !== "workspace/api.ts")) === J(["index.html"]) && /if \(!allowed\) return false;[\s\S]*activate: \(\) => w\.activateJournal\(\)/.test(page), "only the page's switch activates the journal, after the gate");
check(J(using(/followDocSync(<[^>]*>)?\(/)) === J(["board/page.ts", "workspace/doc-sync-switch.ts"]) && /if \(!allowed\) return;\s*await followDocSync\(\{/.test(board) && /if \(!NO_SYNC && docSyncOrigin\(location\.origin\)\) void docSyncHere\(ws\)/.test(board), "the board page carries notebooks (followDocSync) only after the gate, on DEV's origin (astra's DEVSW-1)");

// ---- enableDocSync (astra's DEVSW-2, daybreak3): every failure, injected; what it returns, DOC_SYNC, the owner, the
// notebook's read-only, the order of the lasting step
function enableRig(over = {}) {
  const t = { log: [], ro: [], docs: [], kicks: [], all: 0, posted: [], DOC: { on: false, saved: null }, begun: false, roNow: false, reload: 0, onAtReopen: null, warned: 0, released: 0 };
  const ch = { posted: t.posted, onmessage: null, postMessage(m) { this.posted.push(m); } };
  t.ch = ch;
  const d = {
    loadHistory: async () => { t.log.push("history"); return { DOC_SYNC: t.DOC }; },
    makeDocs: () => { t.log.push("docs"); return { kick: (id, startHere) => t.kicks.push(startHere ? id + "!" : id), kickStarted: async () => { t.all++; }, stopped: new Map([["n9", { code: "chain" }]]) }; },
    makeChannel: () => { t.log.push("channel"); return ch; },
    register: (k) => t.log.push("register:" + k),
    own: async () => { t.log.push("own"); return () => { t.log.push("release"); t.released++; }; },
    setReadOnly: (ro) => { t.ro.push(ro); t.log.push("ro:" + ro); },
    readOnlyNow: () => t.roNow,
    flush: () => t.log.push("flush"),
    saved: async () => { t.log.push("saved"); },
    activate: async () => { t.log.push("activate"); t.begun = true; return true; },
    begun: async () => t.begun,
    reopen: async () => { t.log.push("reopen"); t.onAtReopen = t.DOC.on; return true; },
    setDocs: (docs) => { t.log.push("setDocs"); t.docs.push(docs); },
    needReload: () => { t.reload++; },
    warn: () => { t.warned++; },
    ...over(t),
  };
  return { t, run: () => enableDocSync(d) };
}
const rig = (over) => enableRig(over ? (t) => over(t) : () => ({}));
const lastRo = (t) => t.ro.at(-1);
{
  const { t, run } = rig();
  const out = await run();
  check(out === "on" && t.DOC.on === true && typeof t.DOC.saved === "function" && t.docs.length === 1 && t.onAtReopen === true && J(t.ro) === J([true, false]) && t.reload === 0 && J(t.posted) === J([{ on: true }]),
    "enable: all well: on, DOC_SYNC on (before the reopen), one DocSync to the owner, the other tabs told, read-only only meanwhile: " + J({ out, ro: t.ro, posted: t.posted }));
  check(J(t.log) === J(["history", "docs", "channel", "register:notebooks", "register:boards", "own", "ro:true", "flush", "saved", "activate", "reopen", "setDocs", "ro:false", "release"]) && t.released === 1, "enable: the order: what can fail and changes nothing, then the notebook owned, read-only, its saves, the activation, the reopen, the owner; restored, then released: " + J(t.log));
  t.DOC.saved("n1");
  t.ch.onmessage({ data: { kick: "n2" } });
  t.ch.onmessage({ data: { on: true } });
  t.ch.onmessage({ data: { kick: 7 } });
  t.ch.onmessage({ data: null });
  check(J(t.kicks) === J(["n1", "n2"]) && J(t.posted) === J([{ on: true }, { kick: "n1" }]), "enable: a save here kicks this DocSync and is told on the channel; another tab's kick kicks it; anything else ignored: " + J({ kicks: t.kicks, posted: t.posted }));
  // (a page's pull: a notebook listed by sync with none of its history here, started here as a received `changed` does)
  t.DOC.pull("n3");
  t.ch.onmessage({ data: { pull: "n4" } });
  t.ch.onmessage({ data: { pull: 5 } });
  check(J(t.kicks.slice(2)) === J(["n3!", "n4!"]) && J(t.posted.slice(2)) === J([{ pull: "n3" }]), "enable: a page's pull kicks this DocSync to start it here and is told on the channel; another tab's pull the same; anything else ignored: " + J({ kicks: t.kicks, posted: t.posted }));
  check(t.DOC.stoppedOf("n9")?.code === "chain" && t.DOC.stoppedOf("n1") === null, "enable: what this DocSync stopped, by id (never said to be still arriving): " + J(t.DOC.stoppedOf("n9")));
  check(t.all === 1, "enable: another tab's `on` kicks every notebook started on this DocSync (this tab may hold the connection: that tab's reopened notebook was told to no one, #266 r5's case 14): " + t.all);
}
{
  const { t, run } = rig((t) => ({ readOnlyNow: () => t.roNow }));
  t.roNow = true;
  check((await run()) === "on" && lastRo(t) === true, "enable: on, the notebook read-only for its own reason then (another tab writes it, a quarantine): kept read-only");
}
// (each failure: what it returns, whether the journal's activation was asked, DOC_SYNC, the owner, the read-only)
const failures = [
  ["the history bundle's load rejects", (t) => ({ loadHistory: async () => { throw new Error("injected: history"); } }), "off", false],
  ["the DocSync can't be made", (t) => ({ makeDocs: () => { throw new Error("injected: docs"); } }), "off", false],
  ["the channel can't be made", (t) => ({ makeChannel: () => { throw new Error("injected: channel"); } }), "off", false],
  ["the notebook's saves fail", (t) => ({ saved: async () => { throw new Error("injected: saved"); } }), "off", false],
  ["the notebook's saves fail, the journal active from before", (t) => { t.begun = true; return { saved: async () => { throw new Error("injected: saved"); } }; }, "off", false],
  ["the activation refused, never begun (a quarantine)", (t) => ({ activate: async () => { t.log.push("activate"); return false; } }), "off", true],
  ["the activation refused after it began (a fence blocked)", (t) => ({ activate: async () => { t.log.push("activate"); t.begun = true; return false; } }), "reload", true],
  ["the activation throws after the durable fence", (t) => ({ activate: async () => { t.log.push("activate"); t.begun = true; throw new Error("injected: fence"); } }), "reload", true],
  ["the activation throws before anything was written", (t) => ({ activate: async () => { t.log.push("activate"); throw new Error("injected: before"); } }), "off", true],
  ["the activation throws and whether it began can't be told", (t) => ({ activate: async () => { t.log.push("activate"); throw new Error("injected"); }, begun: async () => { throw new Error("injected: begun"); } }), "reload", true],
  ["the activation refused and whether it began can't be told", (t) => ({ activate: async () => { t.log.push("activate"); return false; }, begun: async () => { throw new Error("injected: begun"); } }), "reload", true],
  ["the reopen fails (said false: the store let go)", (t) => ({ reopen: async () => { t.log.push("reopen"); return false; } }), "reload", true],
  ["the reopen throws", (t) => ({ reopen: async () => { t.log.push("reopen"); throw new Error("injected: reopen"); } }), "reload", true],
  ["the owner's setDocs throws", (t) => ({ setDocs: () => { throw new Error("injected: setDocs"); } }), "reload", true],
  ["the notebook can't be owned", (t) => ({ own: async () => { throw new Error("injected: own"); } }), "off", false],
];
for (const [what, over, want, asked] of failures) {
  for (const roNow of [false, true]) {
    const { t, run } = enableRig(over);
    t.roNow = roNow;
    let out, threw = null;
    try { out = await run(); } catch (e) { threw = e; }
    const pre = want === "off" && !asked && !t.log.includes("flush");
    const owned = t.log.includes("own");
    // (owned: restored, then released, last; never owned: nothing restored, nothing released)
    const tail = owned ? J(t.log.slice(-2)) === J(["ro:" + (want === "reload" ? true : roNow), "release"]) && t.released === 1 : t.released === 0 && t.ro.length === 0;
    const ro = want === "reload" ? true : roNow;
    const ok = !threw && out === want && t.log.includes("activate") === asked && t.DOC.on === false && (want !== "reload" || (t.DOC.saved === null && (t.DOC.pull ?? null) === null && (t.DOC.stoppedOf ?? null) === null)) && t.docs.length === 0 &&
      (pre ? t.ro.length === 0 : t.ro[0] === true && lastRo(t) === ro) && t.reload === (want === "reload" ? 1 : 0) && !t.posted.some((m) => m.on) && tail;
    check(ok, `enable: ${what} (read-only for its own reason: ${roNow}): ${want}${asked ? "" : ", the activation never asked"}, DOC_SYNC off, no DocSync to the owner, ${want === "reload" ? "read-only and said (reload)" : "the read-only set back"}: ` + J({ out, threw: threw && String(threw), log: t.log, ro: t.ro, on: t.DOC.on, docs: t.docs.length, reload: t.reload }));
  }
}
{
  // (astra's DEVSW-2-R2: while a session is being recreated the switch waits to own the notebook: nothing read-only,
  // flushed or activated until it ends; then it goes on)
  let ended;
  const replay = new Promise((r) => { ended = r; });
  const { t, run } = rig((t) => ({ own: async () => { t.log.push("own?"); await replay; t.log.push("own"); return () => { t.log.push("release"); t.released++; }; } }));
  const p = run();
  await new Promise((r) => setTimeout(r, 30));
  const during = J(t.log);
  ended();
  const out = await p;
  check(during === J(["history", "docs", "channel", "register:notebooks", "register:boards", "own?"]) && t.ro.length === 2 && out === "on" && t.log.at(-1) === "release", "enable: while the notebook is owned elsewhere (a session recreated), nothing read-only, flushed or activated; then on: " + during);
}
check(typeof DOC_SYNC_RELOAD === "string" && /reload this page/.test(DOC_SYNC_RELOAD) && docSyncChannel("ws1") === "sagebrush-docsync:ws1", "enable: the reload text, and the channel's name");

// ---- followDocSync (astra's DEVSW-1): a board page's connection carries notebooks once the journal is active
function followRig(active) {
  const t = { active, made: 0, set: [], kicks: [], all: [], warned: 0, asks: 0 };
  const ch = { onmessage: null, postMessage() {} };
  t.ch = ch;
  const d = {
    makeDocs: () => { t.made++; const id = t.made; return { id, kick: (k, startHere) => t.kicks.push(id + ":" + k + (startHere ? "!" : "")), kickStarted: async () => { t.all.push(id); } }; },
    makeChannel: () => ch,
    journalActive: async () => { t.asks++; await new Promise((r) => setTimeout(r, 5)); if (t.active === "throw") throw new Error("injected"); return t.active; },
    setDocs: (docs) => t.set.push(docs.id),
    warn: () => { t.warned++; },
  };
  return { t, run: () => followDocSync(d) };
}
{
  const { t, run } = followRig(true);
  const stop = await run();
  t.ch.onmessage({ data: { kick: "n1" } });
  t.ch.onmessage({ data: { on: true } });
  await new Promise((r) => setTimeout(r, 30));
  t.ch.onmessage({ data: { kick: "n2" } });
  check(J(t.set) === J([1]) && t.made === 1 && J(t.kicks) === J(["1:n1", "1:n2"]), "follow: the journal active: one DocSync to the owner at once; notebook saves told on the channel kick it; a later `on` makes no second: " + J(t));
  t.ch.onmessage({ data: { pull: "n3" } });
  check(t.kicks.at(-1) === "1:n3!", "follow: a page's pull told on the channel: kicked here to start it (this page may hold the connection): " + J(t.kicks));
  check(J(t.all) === J([1]), "follow: a notebook page's `on` when this page has already joined: every notebook started is kicked on its DocSync (the one the switch just reopened there was told to no one, #266 r5's case 14): " + J(t.all));
  stop();
  check(t.ch.onmessage === null, "follow: stopped: the channel no longer heard");
}
{
  const { t, run } = followRig(false);
  await run();
  t.ch.onmessage({ data: { kick: "n0" } });
  check(t.set.length === 0 && t.made === 0 && t.kicks.length === 0, "follow: the journal not active: no DocSync, a kick before it ignored");
  t.ch.onmessage({ data: { on: true } });
  await new Promise((r) => setTimeout(r, 30));
  check(t.set.length === 0, "follow: told `on` while the journal still isn't active (the message isn't trusted): still none");
  t.active = true;
  t.ch.onmessage({ data: { on: true } });
  t.ch.onmessage({ data: { on: true } });
  t.ch.onmessage({ data: { on: true } });
  await new Promise((r) => setTimeout(r, 40));
  t.ch.onmessage({ data: { on: true } });
  await new Promise((r) => setTimeout(r, 40));
  t.ch.onmessage({ data: { kick: "n3" } });
  check(J(t.set) === J([1]) && t.made === 1 && J(t.kicks) === J(["1:n3"]), "follow: told `on` (four times, three at once) once the journal is active: exactly one DocSync, then kicks reach it: " + J({ set: t.set, made: t.made, kicks: t.kicks }));
  check(J(t.all) === J([1, 1, 1, 1]), "follow: each of those four `on`s kicks every started notebook on the DocSync, after it joined (none before it existed, none for the `on` while the journal wasn't active): " + J(t.all));
}
{
  const { t, run } = followRig("throw");
  await run();
  check(t.set.length === 0 && t.warned === 1, "follow: whether the journal is active can't be told: none, said");
  t.active = true;
  t.ch.onmessage({ data: { on: true } });
  await new Promise((r) => setTimeout(r, 30));
  check(J(t.set) === J([1]), "follow: …and a later `on` still joins");
}

const fails = results.filter(([ok]) => !ok).map(([, w]) => w);
if (fails.length) { console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: the switch for notebooks' contents (DEV and PROD) fails closed, ${results.length} checks`);
if (process.env.SHOW) for (const [, w] of results) console.log("  " + w);
