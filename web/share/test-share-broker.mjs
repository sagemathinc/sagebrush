// G-10 (plan r2..r2.3.1; astra's placement ruling 0f2a9a14): the runner's fetch broker on the share client, the one
// page that mounts files (share-client/view.ts: `onStart: w => w.postMessage({ mount })`), against the share API in
// Miniflare (web/share/serve-dev.mjs) and web/dist. The harness is web/test-broker-lib.mjs's: requests forged from
// the runner's own worker, the page's recorder installed before the page starts (each relayed request and each
// answer, by id and URL; a request with no answer is a failure), CDP's Network events in every session, and the
// servers' own logs.
//
// Three cases, each in a world of its own: a fresh dev server (its own ports, database and bucket), a fresh
// Chromium profile, and a fresh collection shared through the page (as test-share-ui.mjs does), so no allowlist,
// mount, cache or frame crosses between them.
//   G1s  the share page's runner refuses `sagebrush-engine.wasm?leak=SENTINEL`; and, first, the positive mounted
//        case: Run all reads the mounted data file (its URL answered with bytes)
//   G4   the mounted data file's URL answers 302 (CDP Fetch interception) to a target the interception would answer
//        200 "SENTINEL-G4": the approved request is relayed and answered null, and the target is never requested
//   G10  the worker posts {mount} of a fresh, ungranted sentinel URL up through the frame, then asks for it: the
//        mount arrives at the page (witnessed), the request is answered null, and nothing is requested (the
//        interception would answer it 200 "SENTINEL-G10")
//
//   bun web/build.ts && node web/share/test-share-broker.mjs      (CHROME=... for another browser)
import { startDev } from "./serve-dev.mjs";
import { browser, runnerWorker, forge, refused, sleep, until } from "../test-broker-lib.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const LIMITS = { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// A world: its server, its browser, a collection shared from the notebook page (a notebook that reads
// data/points.csv), then the shared page opened with the recorder in place, Run all done, and the runner's worker
async function world(name, sitePort, filesPort, intercept = null) {
  const dev = await startDev({ sitePort, filesPort, limits: LIMITS });
  const b = await browser();
  const uev = (expr, ms = 30000) => until(() => b.ev(expr).catch(() => false), ms).then((v) => { if (!v) throw new Error(`${name}: timeout: ${expr.slice(0, 120)}`); return v; });
  const runFirst = async (code) => {
    await b.ev(`(() => { const c = document.querySelector('.cell'); const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
    await sleep(200);
    await uev("(() => { const c = document.querySelector('.cell'); return !c.classList.contains('running') && !c.classList.contains('queued') && /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()");
  };
  try {
    await b.send("Page.navigate", { url: dev.site + "/" });
    await uev("document.querySelector('#status')?.textContent.startsWith('ready')", 60000);
    await b.ev("document.querySelector('#filemenu [data-f=new]').click()");
    await uev("document.querySelectorAll('.cell').length === 1 && !document.querySelector('.cell textarea').value");
    await runFirst("import os\nos.makedirs('data', exist_ok=True)\nopen('data/points.csv', 'w').write('x,y\\n1,2\\n3,4\\n')");
    await runFirst("print(open('data/points.csv').read().strip().replace('\\n', ';'))");
    const signed = await b.ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ token: 'dev-token', account_id: '${A}' }) }).then((r) => r.status)`);
    if (signed !== 200) throw new Error(`${name}: dev sign-in ${signed}`);
    await b.ev("document.querySelector('#sharemenu').click()");
    await uev("!document.querySelector('#shareform').hidden");
    await uev("/^Checked /.test(document.querySelector('#sharestatus').textContent)");
    await b.ev("document.querySelector('#sharetitlein').value = 'Points'; document.querySelector('#shareupload').click()");
    await uev("document.querySelector('#shareresult a')");
    const link = await b.ev("document.querySelector('#shareresult a').href");
    // the shared page, with the recorder from its start (and the interception, if the case has one)
    await b.record();
    if (intercept) await intercept.enable(b, dev);
    dev.log.files.length = 0;
    dev.log.site.length = 0;
    await b.send("Page.navigate", { url: link });
    await uev("document.querySelector('#title').textContent === 'Points'");
    await uev("document.querySelectorAll('#nb .cell').length >= 1");
    const files = await b.ev("window.shared.c.manifest.files.map((f) => f.path)");
    const filesOrigin = await b.ev("window.shared.c.files_origin");
    // (the data file's URL as the page mounts it, share-client/view.ts fileUrl: known before Run all, so a case's
    // interception is in place for the broker's first fetch of it; the frame keeps what it was given)
    const csvUrl = await b.ev("(() => { const c = window.shared.c, f = c.manifest.files.find((x) => x.path === 'data/points.csv'); return new URL('/c/' + c.id + '/' + f.sha256, c.files_origin).href; })()");
    if (intercept?.ready) intercept.ready({ csvUrl, filesOrigin });
    await b.ev("document.querySelector('#runall').click()");
    await uev("(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued') && !document.querySelector('#nb .cell .stale, #nb .cell.stale'); })()", 60000);
    const out = await b.ev("document.querySelector('#nb .cell .out').textContent");
    const log = await b.log();
    const mountOut = log.find((x) => x.kind === "mount-out");
    if (mountOut?.urls?.[files.indexOf("data/points.csv")] !== csvUrl) throw new Error(`${name}: the page's mount of data/points.csv isn't ${csvUrl}: ${JSON.stringify(mountOut)}`);
    const wk = await runnerWorker(b, name);
    return { dev, b, wk, link, out, csvUrl, filesOrigin, seen: () => [...dev.log.site, ...dev.log.files] };
  } catch (e) {
    await b.close().catch(() => {});
    await dev.close().catch(() => {});
    throw e;
  }
}
const end = async (w) => { await w.b.close().catch(() => {}); await w.dev.close().catch(() => {}); };

// CDP Fetch interception of the files domain, in the page's session (where the broker fetches): `rules` maps a URL to
// a response; any other request goes on unchanged. Each URL a rule answered is counted.
function interception(rules) {
  const hits = new Map();
  return {
    hits,
    async enable(b, dev) {
      const files = new URL(dev.files).origin;
      b.listeners.push(async (method, params, sessionId) => {
        if (method !== "Fetch.requestPaused" || sessionId) return;
        const url = params.request.url, rule = rules(url);
        if (!rule) return b.send("Fetch.continueRequest", { requestId: params.requestId });
        hits.set(url, (hits.get(url) ?? 0) + 1);
        b.send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: rule.status, responseHeaders: rule.headers, body: rule.body === undefined ? undefined : b64(rule.body) });
      });
      await b.send("Fetch.enable", { patterns: [{ urlPattern: files + "/*", requestStage: "Request" }] });
    },
  };
}

// G1s, and the positive mounted case
try {
  const w = await world("G1s", 18890, 18891);
  try {
    const log = await w.b.log();
    const req = log.find((x) => x.kind === "request" && x.url === w.csvUrl);
    const ans = req && log.find((x) => x.kind === "answer" && x.id === req.id && x.url === w.csvUrl);
    ok(!!req && !!ans && ans.bytes > 0 && w.out.includes("x,y;1,2;3,4"), `mounted: Run all reads the mounted data file through the broker: relayed (${req ? "id " + req.id : "NOT SEEN"}), answered ${ans ? ans.bytes + " bytes" : "NEVER"}; the cell printed ${JSON.stringify(w.out.trim().slice(0, 80))}`);
    const S = "SENTINEL-G1s-" + Date.now();
    const r = await forge(w.b, w.wk, new URL(`/sagebrush-engine.wasm?leak=${S}`, w.dev.site).href, w.seen);
    refused(ok, "G1s", "the share page's runner, engine?leak=SENTINEL", r, (u) => !u.includes(S));
  } finally { await end(w); }
} catch (e) { ok(false, "G1s: " + (e?.stack ?? e)); }

// G4: the mounted URL answers 302
try {
  let target = null, csv = null;
  const icpt = interception((url) => {
    if (target && url === target) return { status: 200, headers: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Content-Type", value: "text/csv" }], body: "SENTINEL-G4\n" };
    if (csv && url === csv) return { status: 302, headers: [{ name: "Location", value: target }, { name: "Access-Control-Allow-Origin", value: "*" }] };
    return null;
  });
  icpt.ready = ({ csvUrl, filesOrigin }) => { csv = csvUrl; target = new URL("/g4-redirect-target-SENTINEL", filesOrigin).href; };
  const w = await world("G4", 18892, 18893, icpt);
  try {
    const l = await w.b.log();
    const req = l.find((x) => x.kind === "request" && x.url === csv);
    const ans = req && l.find((x) => x.kind === "answer" && x.id === req.id && x.url === csv);
    const toTarget = w.b.requests.filter((r) => r.url === target).length + (icpt.hits.get(target) ?? 0);
    ok(!!req && !!ans && ans.bytes === null && (icpt.hits.get(csv) ?? 0) >= 1 && toTarget === 0 && !w.out.includes("SENTINEL-G4"),
      `G4: the mounted URL answering 302: relayed (${req ? "id " + req.id : "NOT SEEN"}), answered ${ans ? (ans.bytes === null ? "null" : ans.bytes + " bytes") : "NEVER"}, the 302 given ${icpt.hits.get(csv) ?? 0} time(s), ${toTarget} request(s) to the redirect's target; the cell: ${JSON.stringify(w.out.trim().split("\n").at(-1)?.slice(0, 100))}`);
  } finally { await end(w); }
} catch (e) { ok(false, "G4: " + (e?.stack ?? e)); }

// G10: a mount posted from the worker, up through the frame
try {
  let S = null;
  const icpt = interception((url) => (S && url === S ? { status: 200, headers: [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Content-Type", value: "text/plain" }], body: "SENTINEL-G10\n" } : null));
  const w = await world("G10", 18894, 18895, icpt);
  try {
    S = new URL(`/c/g10-SENTINEL-${Date.now()}/${"0".repeat(64)}`, w.filesOrigin).href;
    const mark = (await w.b.log()).length;
    await w.b.ev(`(postMessage({ mount: [["/x", { url: ${JSON.stringify(S)} }]] }), true)`, w.wk);
    const arrived = await until(async () => (await w.b.log()).slice(mark).find((x) => x.kind === "mount-in" && x.urls.includes(S)), 5000);
    const r = await forge(w.b, w.wk, S, w.seen);
    ok(!!arrived, `G10: the worker's {mount} of the sentinel arrived at the page through the frame: ${arrived ? "yes" : "NOT SEEN"}`);
    refused(ok, "G10", "the sentinel the worker mounted", r, (u) => !u.includes("g10-SENTINEL"));
    ok((icpt.hits.get(S) ?? 0) === 0, `G10: the interception was never asked for the sentinel (${icpt.hits.get(S) ?? 0})`);
  } finally { await end(w); }
} catch (e) { ok(false, "G10: " + (e?.stack ?? e)); }

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
