// ci: web-runner order=355 runner=bun chrome
// The fleet pages (/agents/fleet/; design agent-autonomous-pages-fleet r2.1 §4) in headless Chromium, on the agent's
// own signed fixtures: every signed object verified on the page before it is shown; the host's state an "Unverified
// report" (its source and age, closed values, stale or missing is unknown, never healthy, and never promoting a verified
// state); a fork offering only Reset this device; the fixture service only on a loopback page that asks for it; and the
// pages' own code naming nothing that signs, with Reset their only write.
//   CHROME=chromium bun web/agents/fleet/test-fleet-pages.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { browser } from "../a14-cases.mjs";
import { sourceKind } from "./client.ts";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

// ---- the pages' own text: nothing that signs, and Reset the only write
{
  const strip = (s) => s.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  const files = ["page.ts", "client.ts", "view.ts"].map((f) => [f, strip(readFileSync(join(here, f), "utf8"))]);
  const signing = files.flatMap(([f, s]) => (s.match(/\b(?:seal|sealAdd|sealPackage|sealCap|sign|signBytes|keyFromSeed|recoveryKey|newRecoveryCode|setupSender|hpkeSeal|makeDeviceKey|asKey|advancePin|advancePinOnChain)\b|subtle\.sign/g) ?? []).map((m) => `${f}: ${m}`));
  ok(signing.length === 0, "S-1: the pages name no signing or key-making function, and never move the pin themselves (comments aside)", signing);
  const imports = files.flatMap(([f, s]) => [...s.matchAll(/from\s+"([^"]+)"/g)].map((m) => `${f}: ${m[1]}`));
  const allowed = new Set(["page.ts: ../../workspace/fleet-verify", "page.ts: ../../workspace/fleet-device", "page.ts: ./client", "page.ts: ./view"]);
  ok(imports.every((i) => allowed.has(i)), "S-2: the pages import only fleet-verify (verifying), fleet-device (the device key's reading and Reset), and each other", imports);
  const fd = files[0][1].match(/import \{([^}]*)\} from "\.\.\/\.\.\/workspace\/fleet-device"/)?.[1].split(",").map((x) => x.trim()).sort().join();
  ok(fd === "deviceKey,resetDevice", "S-3: from fleet-device only deviceKey (read) and resetDevice (the one write)", fd);
  const writes = files.flatMap(([f, s]) => (s.match(/method:\s*"(?!GET")[A-Z]+"|localStorage\.setItem|indexedDB\.|\.put\(|\.delete\(/g) ?? []).map((m) => `${f}: ${m}`));
  ok(writes.length === 0, "S-4: no request but GET, no storage write of their own", writes);
}
// ---- the mock gate's truth table (§4)
{
  const rows = [
    ["http://127.0.0.1:8000/agents/fleet/?fixtures=1", "fixtures"], ["http://localhost:8000/agents/fleet/?fixtures=1", "fixtures"],
    ["http://127.0.0.1:8000/agents/fleet/", "service"], ["http://127.0.0.1:8000/agents/fleet/?fixtures=0", "service"],
    ["https://sagebrush.space/agents/fleet/?fixtures=1", "service"], ["https://dev.sagebrush.space/agents/fleet/?fixtures=1", "service"],
    ["http://127.0.0.2:8000/agents/fleet/?fixtures=1", "service"], ["http://localhost.example.com/agents/fleet/?fixtures=1", "service"],
  ];
  const bad = rows.filter(([u, want]) => sourceKind(new URL(u)) !== want);
  ok(bad.length === 0, `G-1: the mock gate: fixtures only on localhost or 127.0.0.1 with ?fixtures=1; the flag elsewhere is ignored (${rows.length} rows)`, bad);
}

// ---- the page, built, and a server: the page, its fixtures (the agent's own signed vectors), and no service routes
const built = await Bun.build({ entrypoints: [join(here, "page.ts")], target: "browser", format: "esm" });
if (!built.success) throw new Error("the fleet page didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
const html = readFileSync(join(here, "index.html"), "utf8");
const F = JSON.parse(readFileSync(join(here, "..", "..", "workspace", "fleet", "fleet-fixtures.json"), "utf8"));
const NOW = F.now_ms, HOST = F.ids.host, AGENT = F.ids.agent;
const grant = F.objects.grants.find((c) => c.name === "a grant" && c.expect === "ok").bytes;
const ackAhead = F.objects.grant_acks.find((c) => c.name === "an ack of the current generation").bytes; // (gen 3: ahead of grant 1)
const report = (over = {}, agent = {}) => ({ host: { reported_at_ms: NOW - 1500, last_seen_ms: NOW - 1000, health: "ok", health_reasons: [], ...over }, agents: { [AGENT]: { run: "running", fences: [], lease: "live", lease_expires_at_ms: NOW + 600_000, restore: null, ...agent } } });
const hostRow = (over = {}) => ({ host: HOST, cert: F.objects.host_cert, revocation: null, grant_gen: 1, ack: ackAhead, ...over });
const base = () => ({ fleet: F.ids.fleet, aud: F.aud, now_ms: NOW, chain: F.objects.chain, hosts: [hostRow()], grants: { [HOST]: [grant] }, state: { [HOST]: report() }, ops: {} });
let fixtures = base();
// (the service's routes, when a case turns them on: the person's reads, with the chain paged 2 entries at a time)
let service = null;
const served = [];
const jsonRes = (v, status = 200) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
function api(u) {
  const p = u.pathname, svc = service;
  served.push(p + u.search);
  if (!svc) return jsonRes({ error: "not_found" }, 404);
  if (svc.status) return jsonRes({ error: svc.error }, svc.status);
  if (p === "/api/fleet/v1/fleet") return jsonRes({ fleet: F.ids.fleet, aud: F.aud });
  if (p === "/api/fleet/v1/chain") {
    const after = u.searchParams.has("after") ? Number(u.searchParams.get("after")) : -1, head = F.objects.chain.length - 1;
    const entries = F.objects.chain.slice(after + 1, after + 3);
    return jsonRes(svc.chainPage ? svc.chainPage(entries, head) : JSON.stringify({ entries, head }));
  }
  if (p === "/api/fleet/v1/hosts") return jsonRes({ hosts: [hostRow({ ack: null })] });
  if (p === `/api/fleet/v1/hosts/${HOST}/grants`) return jsonRes({ grants: [grant], head: 1 });
  return jsonRes({ error: "not_found" }, 404);
}
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const u = new URL(r.url), p = u.pathname;
  if (p.startsWith("/api/")) return api(u);
  if (p === "/agents/fleet/fleet.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (p === "/agents/fleet/fixtures.json") return new Response(JSON.stringify(fixtures), { headers: { "content-type": "application/json" } });
  if (p === "/agents/fleet/") return new Response(html, { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404 });
} });
const site = `http://127.0.0.1:${server.port}/agents/fleet/`;
const B = await browser();
const text = (P) => P.ev(`document.querySelector("#fleet").innerText`);
const open = async (P, url, until) => {
  const n = P.loads;
  await P.send("Page.navigate", { url });
  for (const t = Date.now(); P.loads === n && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50));
  try { await P.until(until, 20000); } catch (e) { console.log("the page: " + JSON.stringify({ url, text: await P.ev(`document.querySelector("#fleet")?.innerText ?? null`).catch(() => "?"), errors: P.errors })); throw e; }
};
// (one tab at a time: a tab still open holds the fleet database, and the next one's delete would wait for it)
let last = null;
const fresh = async () => { if (last) await B.send("Target.closeTarget", { targetId: last.targetId }).catch(() => {}); const P = (last = await B.tab()); await open(P, site, `!!document.querySelector("#fleet")?.textContent`); await P.ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase("sagebrush-fleet-v1"); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`); return P; };
const notLoading = `document.querySelector("#fleet")?.innerText && !/^Loading/.test(document.querySelector("#fleet").innerText)`;
try {
  {
    // (G-2: loopback without the flag reads the service; this server has none (404): no fleet, nothing made up)
    const P = await fresh();
    await open(P, site, notLoading);
    ok(/You have no fleet yet/.test(await text(P)), "G-2: loopback without ?fixtures=1 reads the service, which has no fleet here: \"You have no fleet yet\"", await text(P));
  }
  {
    // (G-3: the same page against the service's routes (loopback, no flag): the chain read in pages by the core's reader,
    //  then verified whole; the hosts and the grant lineage as on the fixtures)
    service = {};
    served.length = 0;
    let P = await fresh();
    await open(P, site + "#hosts", `!!document.querySelector("li.host .grant")`);
    const g = await P.ev(`document.querySelector("li.host .grant").textContent`);
    const chainReads = served.filter((x) => x.startsWith("/api/fleet/v1/chain"));
    // (the service path reads the real clock; the fixtures' grant starts in 2027, so it isn't in force yet: said, and never applied)
    ok(g === "grant 1 · not yet in force · waiting for the host" && chainReads.join() === "/api/fleet/v1/chain,/api/fleet/v1/chain?after=1,/api/fleet/v1/chain?after=3", "G-3: the service's routes: the chain read in 3 pages (from genesis, then after=1, after=3), the host and its grant verified", { g, chainReads });
    ok(served.some((x) => x === `/api/fleet/v1/hosts/${HOST}/grants`), "G-3: the grant lineage read newest first (no cursor)", served);
    service = { status: 401, error: "unauthenticated" };
    P = await fresh();
    await open(P, site, notLoading);
    ok(/^Sign in to see your fleet\.$/.test((await text(P)).trim()), "G-4: no session (401): \"Sign in to see your fleet.\"", await text(P));
    service = { chainPage: (entries, head) => JSON.stringify({ entries, extra: 1, head }) };
    P = await fresh();
    await open(P, site, notLoading);
    ok(/This device list didn't verify \(bad_form\)/.test(await text(P)), "G-5: a chain page not exactly {entries, head}: the core's reader refuses it (bad_form), nothing trusted", await text(P));
    service = null;
  }
  {
    const P = await fresh();
    await open(P, site + "?fixtures=1#device", notLoading);
    const t = await text(P);
    ok(/This browser/.test(t) && /isn't one of this fleet's devices/.test(t) && /Device list checked up to entry 5 \([A-Za-z0-9_-]{8}\)/.test(t), "P-1: This device: the tier, not enrolled (no key here), and the pin at the verified chain's head", t);
    await open(P, site + "?fixtures=1#hosts", `!!document.querySelector("li.host")`);
    const h = await P.ev(`(() => { const li = document.querySelector("li.host"); return { name: li.querySelector(".name").textContent, fp: li.querySelector(".fp").textContent, grant: li.querySelector(".grant").textContent, host: li.dataset.host }; })()`);
    ok(h.name === "lab-box" && /^[a-z2-7]{4}(-[a-z2-7]{4}){4}$/.test(h.fp) && h.host === HOST, "P-2: Hosts: the verified certificate's name and its fingerprint, recomputed (20 base32 characters in groups of 4)", h);
    ok(h.grant === "grant 1 · expires in 1 h · waiting for the host", "P-3: the verified grant (gen 1, its lifetime); its ack names gen 3, ahead of the grant, so it is refused: \"waiting for the host\", never applied", h.grant);
    await open(P, site + `?fixtures=1#host/${HOST}`, `!!document.querySelector("li.agent")`);
    const a = await P.ev(`(() => { const li = document.querySelector("li.agent"); const r = li.querySelector(".report"); return { agent: li.dataset.agent, label: r.querySelector(".report-label").textContent, src: r.querySelector(".report-src").textContent, text: r.innerText, grant: document.querySelector(".card .grant").textContent, verifiedMark: !!document.querySelector(".report .verified") }; })()`);
    ok(a.agent === AGENT && a.label === "Unverified report" && a.src === `from host ${HOST}, received just now` && /run\s+running/.test(a.text) && /lease\s+live, ends about/.test(a.text) && !a.verifiedMark, "P-4: A host: the grant's agent, its report labelled Unverified report, with its source host and age; no verified mark", a);
    ok(a.grant === "grant 1 · expires in 1 h · waiting for the host", "P-5: a fresh \"ok\" report beside it doesn't promote the grant: still \"waiting for the host\"", a.grant);
    ok(P.errors.length === 0, "no page errors", P.errors);
  }
  {
    fixtures = { ...base(), state: { [HOST]: report({ last_seen_ms: NOW - 45_000 }, { restore: "validated", run: "stopped" }) } };
    let P = await fresh();
    await open(P, site + `?fixtures=1#host/${HOST}`, `!!document.querySelector("li.agent")`);
    const t = await P.ev(`[...document.querySelectorAll(".report")].map((r) => r.innerText).join(" | ")`);
    ok(/\(stale\)/.test(t) && /health\s+unknown/.test(t) && /run\s+unknown/.test(t) && /restore\s+unknown/.test(t) && !/health\s+ok/.test(t), "P-6: a report older than 30 s: stale, and its health and the agent's fields unknown (never ok)", t);
    fixtures = { ...base(), state: {} };
    P = await fresh();
    await open(P, site + `?fixtures=1#host/${HOST}`, `!!document.querySelector("li.agent")`);
    const n = await P.ev(`document.querySelector(".report").innerText`);
    ok(/This host hasn't reported yet/.test(n) && /health\s+unknown/.test(n), "P-7: no report: \"This host hasn't reported yet\", health unknown", n);
    P = await fresh();
    fixtures = { ...base(), state: { [HOST]: report({ health: "<img src=x onerror=window.__pwned=1>", health_reasons: ["clone_detected", "x".repeat(300)] }, { run: "<b>ok</b>", fences: ["lease", "zzz"], restore: "validated" }) } };
    await open(P, site + `?fixtures=1#host/${HOST}`, `!!document.querySelector("li.agent")`);
    const u = await P.ev(`({ t: [...document.querySelectorAll(".report")].map((r) => r.innerText).join(" | "), img: document.querySelectorAll("#fleet img, #fleet b").length, pwned: !!window.__pwned })`);
    ok(/health\s+unknown/.test(u.t) && /reasons\s+clone_detected, unknown/.test(u.t) && /run\s+unknown/.test(u.t) && /fenced\s+waiting for an execution lease/.test(u.t) && /fenced\s+unknown/.test(u.t) && /restore\s+unknown/.test(u.t) && u.img === 0 && !u.pwned, "P-8: values outside their closed lists show unknown; nothing from a report becomes markup", u);
    fixtures = { ...base(), state: { [HOST]: report({}, { restore: "validated", run: "stopped", fences: ["restore"] }) } };
    P = await fresh();
    await open(P, site + `?fixtures=1#host/${HOST}`, `!!document.querySelector("li.agent")`);
    const r = await P.ev(`document.querySelector("li.agent .report").innerText`);
    ok(/restore\s+restored, waiting to resume/.test(r) && /fenced\s+restored, waiting for resume/.test(r) && (await P.ev(`document.querySelectorAll("#fleet button").length`)) === 0, "P-9: restored and not running: \"restored, waiting to resume\", and no action is offered (Resume is a signed flow, not here)", r);
    ok(P.errors.length === 0, "no page errors (P-9)", P.errors);
  }
  {
    // (A-1: an answer that arrives after the person moved on is dropped: the host's report held, the person goes to Hosts)
    fixtures = base();
    const P = await fresh();
    await P.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__fleetRelease = null; window.__fleetHold = () => new Promise((r) => { window.__fleetRelease = r; });` });
    await open(P, site + `?fixtures=1#host/${HOST}`, `typeof window.__fleetRelease === "function"`);
    await P.ev(`(location.hash = "#hosts", true)`);
    await P.until(`!!document.querySelector("li.host")`, 10000);
    await P.ev(`(window.__fleetRelease(), true)`);
    await new Promise((r) => setTimeout(r, 500));
    const after = await P.ev(`({ hosts: !!document.querySelector("li.host"), agent: !!document.querySelector("li.agent"), hash: location.hash })`);
    ok(after.hosts && !after.agent && after.hash === "#hosts", "A-1: a host's report that arrives after the person went back to Hosts is dropped, not drawn", after);
  }
  {
    // (A-2: this browser's storage fails: said, and nothing is shown as trusted (no pin, no host))
    fixtures = base();
    const P = await fresh();
    await P.send("Page.addScriptToEvaluateOnNewDocument", { source: `indexedDB.open = () => { const r = {}; setTimeout(() => { r.error = new DOMException("refused", "UnknownError"); r.onerror?.(); }, 0); return r; };` });
    await open(P, site + "?fixtures=1#device", notLoading);
    const t = await text(P);
    ok(/couldn't save its fleet record\. Nothing was trusted\./.test(t) && !/Device list checked/.test(t), "A-2: storage that fails: \"couldn't save its fleet record. Nothing was trusted.\", and no pin shown", t);
    await open(P, site + "?fixtures=1#hosts", notLoading);
    ok(!(await P.ev(`!!document.querySelector("li.host")`)), "A-2: and no host is shown either");
  }
  {
    // (the lineage: verified in order, each against the previous VERIFIED grant; the walk stops at the first refusal)
    const older = F.objects.grants.find((c) => c.name === "an older generation" && c.expect === "stale_generation");
    const same = F.objects.grants.find((c) => c.name === "the same bytes again" && c.expect === "ok");
    let lastP = null;
    const P0class = () => lastP.ev(`!!document.querySelector("li.host .warn, li.host.refused")`);
    const line = async (fx) => { fixtures = fx; const P = (lastP = await fresh()); await open(P, site + "?fixtures=1#hosts", `!!document.querySelector("li.host .grant")`); return P.ev(`document.querySelector("li.host .grant").textContent`); };
    // (L-1: the anchor is grant 1, the newest that verifies on its own; the next one doesn't verify: the walk stops there)
    const g1 = await line({ ...base(), hosts: [hostRow({ grant_gen: 3, ack: null })], grants: { [HOST]: [grant, older.current.bytes.replace(/"gen":2/, '"gen":3')] } });
    ok(/^grant 1 · expires in 1 h · waiting for the host · a newer grant didn't verify \(\w+\)$/.test(g1), "L-1: a grant after the anchor that doesn't verify: the anchor shown, the refusal after it said, nothing after it verified", g1);
    // (L-2: an earlier grant that doesn't verify any more (as a removed device's): before the anchor, it no longer counts)
    const g2 = await line({ ...base(), hosts: [hostRow({ ack: null })], grants: { [HOST]: [grant.replace(/"at_ms":(\d)/, (m, d) => `"at_ms":${(Number(d) + 1) % 10}`), grant] } });
    ok(g2 === "grant 1 · expires in 1 h · waiting for the host · checked from grant 1; earlier grants no longer count", "L-2: history before the anchor: \"no longer counts\", said plainly, not as a refusal", g2);
    const g2c = await P0class();
    ok(g2c === false, "L-2: and the host isn't shown in a warning style", g2c);
    const g3 = await line({ ...base(), hosts: [hostRow({ ack: null })], grants: { [HOST]: "not a list" } });
    ok(g3 === "its newest grants couldn't be read: not checked", "L-3: the service names a grant but none can be read: unresolved, not \"no grant yet\"", g3);
    const g4 = await line({ ...base(), hosts: [hostRow({ grant_gen: 5, ack: null })] });
    ok(g4 === "grant 1 · expires in 1 h · waiting for the host · its newest grants couldn't be read: not checked", "L-4: the service says gen 5 but serves only up to 1: gen 1 verified, the rest unresolved", g4);
    const g5 = await line({ ...base(), hosts: [hostRow({ grant_gen: null, ack: null })], grants: {} });
    ok(g5 === "no grant yet", "L-5: a host with no grant: \"no grant yet\"", g5);
  }
  {
    fixtures = { ...base(), hosts: [hostRow({ cert: F.objects.host_cert.replace(/"name":"/, '"name":"x'), ack: null })] };
    const P = await fresh();
    await open(P, site + "?fixtures=1#hosts", `!!document.querySelector("li.host")`);
    const t = await text(P);
    ok(/Its certificate didn't verify \(\w+\)\. Nothing about this host is shown\./.test(t) && !/lab-box|xlab-box/.test(t) && !(await P.ev(`!!document.querySelector("li.host a")`)), "P-10: a certificate changed by a byte: refused, and nothing about the host is shown (no name, no link)", t);
  }
  {
    // (a fork: this device pinned another hash at the head's seq; the page offers only Reset, which clears the pin)
    fixtures = base();
    const P = await fresh();
    await P.ev(`new Promise((ok, no) => { const r = indexedDB.open("sagebrush-fleet-v1", 1); r.onupgradeneeded = () => { for (const s of ["keys", "pins"]) r.result.createObjectStore(s); }; r.onsuccess = () => { const tx = r.result.transaction("pins", "readwrite"); tx.objectStore("pins").put({ seq: 5, hash: "${"A".repeat(43)}" }, ${JSON.stringify(F.ids.fleet)}); tx.oncomplete = () => { r.result.close(); ok(true); }; tx.onerror = () => no(tx.error); }; })`);
    await open(P, site + "?fixtures=1#device", notLoading);
    const f = await P.ev(`({ t: document.querySelector("#fleet").innerText, buttons: [...document.querySelectorAll("#fleet button")].map((b) => b.textContent), links: [...document.querySelectorAll("#fleet a")].map((a) => a.textContent) })`);
    ok(/two different device lists/.test(f.t) && f.buttons.join() === "Reset this device", "P-11: a fork: said, and Reset this device is the only action", f);
    await P.ev(`(window.confirm = () => true, document.querySelector("#reset").click(), true)`);
    await P.until(`/This device was reset/.test(document.querySelector("#fleet").innerText)`, 10000);
    const pin = await P.ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-fleet-v1", 1); r.onsuccess = () => { const g = r.result.transaction("pins").objectStore("pins").get(${JSON.stringify(F.ids.fleet)}); g.onsuccess = () => { r.result.close(); ok(g.result ?? null); }; }; })`);
    ok(pin === null, "P-11: Reset this device deleted this device's pin (and its fork mark) for the fleet", pin);
    { const n = P.loads; await P.send("Page.reload", {}); for (const t = Date.now(); P.loads === n && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(notLoading, 20000); }
    ok(/Device list checked up to entry 5/.test(await text(P)), "P-11: reloaded after the reset, the device list verifies again from nothing", await text(P));
  }
} catch (e) {
  ok(false, "the case ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close().catch(() => {});
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
