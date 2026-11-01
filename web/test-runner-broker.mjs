// G-10 (plan r2..r2.3.1): what the runner's fetch broker fetches for its interpreter, in headless Chromium, on the
// notebook page. Each forged request comes from the interpreter's own worker, the dedicated worker in the runner's
// sandboxed frame (found by the frame it belongs to, CDP auto-attach), posting `{brokerFetch}` as a compromised
// interpreter would. What reaches the server is read from its own log (web/serve.py SB_SERVE_LOG) and from CDP's
// Network events in every session; the broker's answer is read in the page, where a recorder installed before the
// page starts (Page.addScriptToEvaluateOnNewDocument) logs each request the frame relays and each answer the page
// sends back, by request id and URL. A request with no answer is a failure.
//
// Three pages, each with a server of its own (nothing crosses between them: a fresh server, log and override file,
// a fresh origin by its port, so a fresh RunnerWorker, its allowlist, zones and frame cache):
//   P1  the cases that need no change to the files: G2c (before the index), G1, G2a, G6-i..v, G3, G13, G2b, G5, G8
//   P2  the index served with one byte changed (SB_SERVE_OVERRIDES): G11
//   P3  the test's barrier held until the zone's answer (r2.3.1): G14
// The barrier `globalThis.__g14Barrier` is the test page's only: P1 and P2 resolve it at once, P3 after the
// interpreter's zone request has been answered. Nothing shipped reads it; only C-G14's copy awaits it.
//
//   bun web/build.ts && node web/test-runner-broker.mjs      (CHROME=... for another browser)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { browser, runnerWorker, forge as forgeIn, refused as refusedBy, sleep, until } from "./test-broker-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const work = mkdtempSync(join(tmpdir(), "sb-broker-"));
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

// ---- what the build gave the worker: the engine's ?h=, the zone index and one zone
const list = JSON.parse(readFileSync(join(dist, "runner-fetch.json"), "utf8"));
const engineFile = list.files.find((f) => f.startsWith("sagebrush-engine.wasm?h="));
const chunkFile = list.files.find((f) => f.startsWith("lib/") && f.endsWith(".json"));
const indexBytes = readFileSync(join(dist, list.tzIndex.file));
const index = JSON.parse(indexBytes.toString("utf8"));
const LONDON = index.zones["Europe/London"];
const notInIndex = createHash("sha256").update("G2b: not a zone of the index").digest("hex");

// ---- a server per page: web/serve.py on a free port, with its own log and override file
const servers = [];
async function server(name, overrides = {}) {
  const log = join(work, `${name}.log`), ov = join(work, `${name}.overrides.json`);
  writeFileSync(log, "");
  writeFileSync(ov, JSON.stringify(overrides));
  const p = spawn("python3", [join(here, "serve.py"), "0"], { env: { ...process.env, SB_SERVE_LOG: log, SB_SERVE_OVERRIDES: ov }, stdio: ["ignore", "pipe", "inherit"] });
  servers.push(p);
  const port = await new Promise((res, rej) => {
    let out = "";
    p.stdout.on("data", (b) => { out += b; const m = /^(\d+)\n/.exec(out); if (m) res(Number(m[1])); });
    p.on("exit", (c) => rej(new Error(`serve.py exited (${c})`)));
  });
  const base = `http://127.0.0.1:${port}/`;
  const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { name, base, lines };
}

const b = await browser();
const { ev, send } = b;
// ---- a page: its recorder, then the notebook, then its runner's frame and worker
const forged = new Set(); // (the ids of this page's forged requests: the valid path's records leave them out)
async function openPage(srv, { g14 = false } = {}) {
  forged.clear(); // (ids are each runner's own)
  await b.record(g14);
  await send("Page.navigate", { url: srv.base });
  const ready = await until(() => ev("document.querySelector('#status')?.textContent.startsWith('ready')"), 60000);
  if (!ready) throw new Error(`${srv.name}: the notebook page never got ready`);
  return { srv, wk: await runnerWorker(b, srv.name) };
}
async function run(code) {
  await ev(`(() => { const cs = [...document.querySelectorAll('.cell')]; let c = cs.at(-1); if (c.querySelector('textarea').value.trim()) { document.querySelector('#add').click(); c = [...document.querySelectorAll('.cell')].at(-1); } const ta = c.querySelector('textarea'); ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', shiftKey: true, bubbles: true})); })()`);
  await sleep(150);
  await until(() => ev("(() => { const c = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1); return !c.classList.contains('running') && !c.classList.contains('queued') && /\\[\\d+\\]/.test(c.querySelector('.n').textContent); })()"), 90000);
  return ev("[...document.querySelectorAll('.cell')].filter(c => c.querySelector('textarea').value.trim()).at(-1).querySelector('.out').textContent");
}
const brokerLog = () => b.log();
const pathOf = (u) => { const x = new URL(u); return x.pathname + x.search; };
// (a forged request, with the server's own log as what it saw)
async function forge(page, url) {
  const r = await forgeIn(b, page.wk, url, () => page.srv.lines().map((l) => l.path));
  if (r.req) forged.add(r.req.id);
  return r;
}
// refused, judged on the requests for this case's resource (`token`, a part of its URL no other request has)
const refused = (name, what, r, token) => refusedBy(ok, name, what, r, (u) => !String(u).includes(token));

try {

  // ======== P1
  const s1 = await server("p1");
  // (G5: a cookie for the site, which the page's own requests carry and the broker's must not)
  await send("Network.setCookie", { name: "g5", value: "SENTINEL-G5", url: s1.base });
  const p1 = await openPage(s1);
  const E = (f) => new URL(f, s1.base).href;
  ok(!s1.lines().some((l) => l.path.includes("/lib/tzdata/")), "P1: no zone data fetched before the interpreter asks (G2c's precondition): " + JSON.stringify(s1.lines().filter((l) => l.path.includes("tzdata")).map((l) => l.path)));

  // G2c: a zone the index lists, asked for before the index was fetched
  refused("G2c", "a listed zone before the index", await forge(p1, E(`lib/tzdata/${LONDON}.tzif`)), LONDON);
  // G1: an allowed file with a query of the interpreter's own
  refused("G1", "the engine with ?leak=SENTINEL", await forge(p1, E("sagebrush-engine.wasm?leak=SENTINEL-G1")), "SENTINEL-G1");
  // G2a: a chunk-shaped name that isn't in the list
  refused("G2a", "a chunk-shaped name not in the list", await forge(p1, E("lib/SENTINEL.0123456789abcdef.json")), "SENTINEL.0123456789abcdef");
  // G6: forms of allowed URLs that aren't the canonical, exact member (nothing may reach the engine or the chunk)
  const engine = E(engineFile), chunk = E(chunkFile);
  // (G6: no request for the engine or the chunk at all, in any spelling)
  const touches = (u) => u.includes("sagebrush-engine.wasm") || u.includes(chunkFile.slice(4));
  const refusedG6 = (name, what, r) => refusedBy(ok, name, what, r, (u) => !touches(String(u)));
  refusedG6("G6-i", "the engine's URL relative (./…)", await forge(p1, "./" + engineFile));
  // (as a raw string: new URL() would remove the encoded dot segment and so make it the member itself)
  refusedG6("G6-ii", "an encoded dot segment before a listed chunk", await forge(p1, s1.base + "lib/%2e/" + chunkFile.slice(4)));
  refusedG6("G6-iii", "an allowed URL plus #x", await forge(p1, engine + "#x"));
  const h = engineFile.split("?")[1];
  refusedG6("G6-iv", "the engine with its ?h= twice", await forge(p1, `${engine}&${h}`));
  refusedG6("G6-v", "an allowed URL with the scheme in capitals", await forge(p1, engine.replace(/^http:/, "HTTP:")));

  // G3: the valid path, through the broker: 1+1, a library chunk, a time zone (the index, then its zone), a PNG
  const g3 = (await run("import heapq, zoneinfo, datetime\nimport matplotlib.pyplot as plt\nplt.plot([1, 2]); plt.savefig('g3.png'); a = plt.imread('g3.png')\nprint(1 + 1, heapq.nsmallest(1, [3, 1]), zoneinfo.ZoneInfo('Europe/London').utcoffset(datetime.datetime(2026, 7, 1)), a.shape)")).trim();
  // (the output's first line is the print; the plot's text description follows it)
  const g3line = g3.split("\n")[0];
  ok(g3line === "2 [1] 1:00:00 (480, 640, 4)", "G3: Python runs 1+1, imports a library chunk, uses a time zone and writes and reads a PNG: " + JSON.stringify(g3line));
  // G13 (browser): the zone after the index, fetched and answered
  const l1 = (await brokerLog()).filter((x) => !forged.has(x.id));
  const ans = (re) => l1.filter((x) => x.kind === "answer" && re.test(x.url));
  const idxAns = ans(new RegExp(list.tzIndex.file.replace(/[.]/g, "\\.") + "$"));
  const zoneAns = ans(new RegExp(`/lib/tzdata/${LONDON}\\.tzif$`));
  ok(idxAns.length >= 1 && idxAns.every((x) => x.bytes === indexBytes.length) && zoneAns.some((x) => x.bytes > 0) && s1.lines().some((l) => l.path === `/lib/tzdata/${LONDON}.tzif`),
    `G13: the index answered whole (${JSON.stringify(idxAns.map((x) => x.bytes))} of ${indexBytes.length} bytes), then Europe/London's zone fetched and answered (${JSON.stringify(zoneAns.map((x) => x.bytes))} bytes)`);
  // G2b: after the index, a 64-hex zone file it doesn't list
  refused("G2b", "an unlisted zone after the index", await forge(p1, E(`lib/tzdata/${notInIndex}.tzif`)), notInIndex);
  // G5 and G8: the broker's own requests carry no Cookie and no Referer (the server's log), while the page's do carry
  // the cookie (so the cookie was there to send)
  const brokered = new Set(l1.filter((x) => x.kind === "answer" && x.bytes !== null).map((x) => pathOf(x.url)));
  const lines1 = s1.lines();
  const brokerLines = lines1.filter((l) => brokered.has(l.path));
  ok(lines1.some((l) => l.path === "/" && /g5=SENTINEL-G5/.test(l.cookie ?? "")), "G5's setup: the page's own request carried the site's cookie");
  ok(brokerLines.length >= 3 && brokerLines.every((l) => !l.cookie), `G5: the broker's ${brokerLines.length} requests carry no Cookie` + (brokerLines.some((l) => l.cookie) ? ": " + JSON.stringify(brokerLines.filter((l) => l.cookie).map((l) => l.path)) : ""));
  ok(brokerLines.length >= 3 && brokerLines.every((l) => !l.referer), `G8: the broker's ${brokerLines.length} requests carry no Referer` + (brokerLines.some((l) => l.referer) ? ": " + JSON.stringify(brokerLines.filter((l) => l.referer).map((l) => [l.path, l.referer])) : ""));

  // ======== P2: G11, the index served with one byte changed (in a copy; dist is not touched)
  const bad = Buffer.from(indexBytes);
  const at = bad.indexOf(Buffer.from(LONDON));
  bad[at] = bad[at] === 0x30 ? 0x31 : 0x30; // (one hex digit of a zone's SHA-256: still valid JSON and grammar, a different hash)
  const badFile = join(work, "index-one-byte.json");
  writeFileSync(badFile, bad);
  const s2 = await server("p2", { ["/" + list.tzIndex.file]: { file: badFile } });
  const p2 = await openPage(s2);
  const g11 = (await run("import zoneinfo, datetime\ntry:\n    print(zoneinfo.ZoneInfo('Europe/London').utcoffset(datetime.datetime(2026, 7, 1)))\nexcept Exception as e:\n    print('refused', type(e).__name__)")).trim();
  const l2 = await brokerLog();
  const i2 = l2.filter((x) => x.kind === "answer" && x.url.endsWith(list.tzIndex.file));
  const z2 = l2.filter((x) => x.kind === "answer" && /\/lib\/tzdata\/[0-9a-f]{64}\.tzif$/.test(x.url));
  const z2srv = s2.lines().filter((l) => /^\/lib\/tzdata\/[0-9a-f]{64}\.tzif$/.test(l.path));
  ok(i2.length >= 1 && i2.every((x) => x.bytes === null) && z2.every((x) => x.bytes === null) && z2srv.length === 0 && /^refused/.test(g11),
    `G11: the index with one byte changed is answered null (${JSON.stringify(i2.map((x) => x.bytes))}), and its zone gets no request (${z2srv.length}) and null (${JSON.stringify(z2.map((x) => x.bytes))}): ${JSON.stringify(g11)}`);
  // (and directly: a zone the changed index lists, forged after it, is refused)
  refused("G11", "a zone the changed index lists, after it", await forge(p2, new URL(`lib/tzdata/${LONDON}.tzif`, s2.base).href), LONDON);

  // ======== P3: G14, the barrier held until the zone's answer
  const s3 = await server("p3");
  const p3 = await openPage(s3, { g14: true });
  const g14 = (await run("import zoneinfo, datetime\nprint(zoneinfo.ZoneInfo('Europe/London').utcoffset(datetime.datetime(2026, 7, 1)))")).trim();
  const l3 = await brokerLog();
  const z3 = l3.filter((x) => x.kind === "answer" && x.url.endsWith(`/lib/tzdata/${LONDON}.tzif`));
  ok(g14 === "1:00:00" && z3.length >= 1 && z3.every((x) => x.bytes > 0), `G14: the zone asked for right after the index's reply is fetched (${JSON.stringify(z3.map((x) => x.bytes))} bytes): ${JSON.stringify(g14)}`);
  void p3;
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await b.close();
  for (const s of servers) s.kill();
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
