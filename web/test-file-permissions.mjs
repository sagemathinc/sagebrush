// ci: web-runner order=116 chrome
// A notebook's permission to change files (web/notebook/permissions.js; William, Nov 2: code from elsewhere runs, but
// changes nothing until the person allows it; plan-no-mutation r3, astra's CLEAR 5fe204ad), in headless Chromium:
//   - a remote notebook (?open=…&run) runs nothing on open; Run all then runs it: it reads the person's files, and its
//     write, mkdir, remove, rename and replace each raise PermissionError, /tmp's writes don't; the workspace is unchanged
//     and the page shows "This notebook wants to change files";
//   - a synthetic click on Allow changes nothing; the person's own (trusted) click does, and the cell run again writes;
//   - the person's own notebook writes; File > Permissions…, its "Don't allow file changes" (trusted) makes its writes refused, a run in
//     flight at its next write; "Allow file changes" makes them work again; an explicit "don't allow" survives a reopen;
//   - a change queued before "don't allow" isn't kept; a change the page didn't ask for (a forged fsChanged) isn't kept;
//   - a notebook that can't change files never runs in a plain worker (?runner=0): it says why; one that can, runs;
//   - a change past the queue's own check, held there, then "don't allow": the workspace's locked admission refuses it
//     (a new file, a write over one, a remove), as it refuses one from an interpreter since restarted (a late message
//     from the old worker included), and the old
//     store's write where there is no workspace (astra's NM-ADMIT-1); with each a control that does write;
//   - a notebook of the person's reopened while the page runs (?runner=0) starts a plain interpreter, never a refusing one;
//   - "don't allow" holds in the page when storage can't keep it, and says so; no number of other choices evicts a
//     "don't allow" back into the own-notebook default (NM-DENY-2: the record's own module, in node).
//   bun web/build.ts, then node web/test-file-permissions.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-fileperm-"));
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", "--window-size=1280,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
// (the remote notebook: its one cell tries every kind of change, and reads)
const PROBE = [
  "import os",
  "r = []",
  "def t(name, f):",
  "    try:",
  "        f(); r.append(name + ':ok')",
  "    except PermissionError:",
  "        r.append(name + ':refused')",
  "    except Exception as e:",
  "        r.append(name + ':' + type(e).__name__)",
  "t('read', lambda: open('keep.txt').read())",
  "t('write', lambda: open('nm-w.txt', 'w').write('x'))",
  "t('append', lambda: open('keep.txt', 'a').write('y'))",
  "t('mkdir', lambda: os.mkdir('nm-dir'))",
  "t('remove', lambda: os.remove('keep.txt'))",
  "t('rename', lambda: os.rename('keep.txt', 'keep2.txt'))",
  "t('move', lambda: os.replace('keep.txt', 'moved.txt'))",
  "t('tmp', lambda: (os.makedirs('/tmp', exist_ok=True), open('/tmp/nm-t.txt', 'w').write('x')))",
  "print('NM:' + ','.join(r))",
].join("\n");
const ipynb = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", source: PROBE, metadata: {}, outputs: [], execution_count: null }] });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  if (m.method === "Fetch.requestPaused") {
    if (/\/remote2?\.ipynb$/.test(m.params.request.url)) send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(ipynb).toString("base64") });
    else send("Fetch.continueRequest", { requestId: m.params.requestId });
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
// ---- the record itself, with a storage of its own; the confinement spec's phase 1b (r3.2): file changes are OFF for
// every document until the person allows them (O1, O6); the switch is the scoped record's write scope "/"; the old
// switch's key is read once, its explicit choices moved into the record, then retired (@sagebrush's ruling A). The
// scoped grants are recorded, canonical, the latest decision winning atomically, and bounded (@sagebrush's R2-R4)
{
  const store = new Map(); let failing = false;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { if (failing) throw new Error("QuotaExceededError"); store.set(k, String(v)); }, removeItem: (k) => store.delete(k) } });
  const { createPermissions, GRANT_CAPS, canonicalScope, scopeCovers } = await import("data:text/javascript," + encodeURIComponent(readFileSync(join(here, "notebook", "permissions.js"), "utf8")));
  const rec = () => JSON.parse(store.get("sagebrush-grants") ?? "null");
  // (off for every document: the person's own, the bundled examples', one from elsewhere, one unknown)
  const p = createPermissions();
  p.provenance("own", "person"); p.provenance("ex", "host"); p.provenance("far", "elsewhere");
  check(["own", "ex", "far", "unknown"].every((d) => p.may(d, "files") === false), "file changes are off for every notebook until the person allows them: their own, a bundled example, one from elsewhere, one unknown");
  // (the switch: a stored write grant of "/", or a stored write denial of it; a reload keeps both)
  check(p.set("own", "files", true) && p.may("own", "files") === true && p.grants("own").write.stored.includes("/"), "allowing stores a write grant of the whole workspace (\"/\"), and the notebook may change files");
  check(p.set("far", "files", false) && p.may("far", "files") === false && p.grants("far").denied.stored.some(([k, x]) => k === "write" && x === "/"), "\"don't allow\" stores a write denial of \"/\"");
  check(p.set("own", "files", false) && p.may("own", "files") === false && !p.grants("own").write.stored.includes("/"), "…which takes the grant away");
  p.set("own", "files", true);
  const q = createPermissions();
  check(q.may("own", "files") === true && q.may("far", "files") === false, "…and a reload keeps both");
  check(!store.has("sagebrush-permissions"), "the old switch's key is never written");
  // (a write grant of a folder isn't the switch: only "/" lets the notebook's code change files, until phase 2 checks trees)
  check(q.grant("tree", "write", "/out").ok && q.may("tree", "files") === false, "a write grant of one folder doesn't turn file changes on");
  // (storage refusing the choice: it holds in this page, and set says it wasn't kept)
  failing = true;
  const k1 = q.set("own", "files", false), k2 = q.set("new", "files", true);
  failing = false;
  check(k1 === false && q.may("own", "files") === false && k2 === false && q.may("new", "files") === true && createPermissions().may("own", "files") === true, "storage refusing a choice: set says it wasn't kept, it holds in this page, and the stored one is unchanged");
  // (the migration, ruling A: allow -> grant, don't allow -> denial, absent -> off; read once, then the key retired)
  store.clear();
  store.set("sagebrush-permissions", JSON.stringify({ aOld: { files: true }, dOld: { files: false }, bad: { files: "yes" }, bad2: 7, bad3: null }));
  const m = createPermissions(); m.provenance("nOld", "person"); m.provenance("aOld", "elsewhere");
  check(m.may("aOld", "files") === true && rec().docs.aOld?.write?.includes("/"), "migration: an old explicit allow becomes a stored write grant of \"/\", with no prompt");
  check(m.may("dOld", "files") === false && rec().docs.dOld?.denied?.some((x) => x[0] === "write" && x[1] === "/"), "…an old \"don't allow\" a stored write denial");
  check(m.may("nOld", "files") === false && !rec().docs.nOld, "…and a notebook with no old choice, the person's own included, starts off (no one-time grant)");
  check(!rec().docs.bad && !rec().docs.bad2 && !rec().docs.bad3 && ["bad", "bad2", "bad3"].every((d) => m.may(d, "files") === false), "…a corrupt old entry moves nothing");
  check(!store.has("sagebrush-permissions") && rec().migrated === 1, "…and the old key is retired, the record marked migrated");
  store.set("sagebrush-permissions", JSON.stringify({ aOld: { files: false }, late: { files: true } }));
  const m2 = createPermissions();
  check(m2.may("aOld", "files") === true && m2.may("late", "files") === false && store.has("sagebrush-permissions"), "a second load doesn't read the old key again (an old tab writing it changes nothing)");
  store.clear();
  store.set("sagebrush-permissions", "{not json");
  check(createPermissions().may("x", "files") === false && rec().migrated === 1 && !store.has("sagebrush-permissions") && Object.keys(rec().docs).length === 0, "an old key that isn't JSON migrates nothing, and is retired");
  store.clear();
  store.set("sagebrush-permissions", JSON.stringify({ h: { files: false }, a: { files: true } }));
  failing = true;
  const mf = createPermissions();
  failing = false;
  check(mf.may("h", "files") === false && mf.may("a", "files") === true && store.has("sagebrush-permissions") && !store.has("sagebrush-grants"), "the record can't be written: the old choices hold in this page, and the old key stays");
  check(createPermissions().may("a", "files") === true && !store.has("sagebrush-permissions"), "…and the next load migrates them");
  // (astra's MIG-RETRY-1: the migration's write fails, storage recovers, the person turns file changes off: that
  // write carries the pending old choices first, with the mark, so the newer choice wins and a reload keeps it)
  store.clear();
  store.set("sagebrush-permissions", JSON.stringify({ r1: { files: true }, r2: { files: true } }));
  failing = true;
  const mr = createPermissions();
  failing = false;
  check(mr.may("r1", "files") === true && mr.set("r1", "files", false) === true && mr.may("r1", "files") === false, "migration failed, storage back, then \"don't allow\": kept, and in effect");
  check(rec().migrated === 1 && !store.has("sagebrush-permissions") && rec().docs.r1?.denied?.some((x) => x[0] === "write" && x[1] === "/") && !rec().docs.r1?.write?.includes("/"), "…that write carried the old choices and the mark, and the old key is retired");
  const mr2 = createPermissions();
  check(mr2.may("r1", "files") === false && mr2.may("r2", "files") === true, "…a reload keeps the newer \"don't allow\" (the old allow isn't replayed), and the other notebook's old allow");
  check(mr.revoke("r2", "write", "/") && mr.may("r2", "files") === false, "…and in the first page, what it held for the old choices is let go once they are stored: removing the other notebook's grant there turns it off");
  // (daybreak3's same-choice case: the migration's write fails, storage recovers, the person repeats an old allow: a
  // change of nothing itself, the write still carries the pending migration, so the notebook stays allowed)
  store.clear();
  store.set("sagebrush-permissions", JSON.stringify({ same: { files: true }, other: { files: true } }));
  failing = true;
  const ms = createPermissions();
  failing = false;
  check(ms.set("same", "files", true) === true && ms.may("same", "files") === true && ms.may("other", "files") === true, "migration failed, storage back, then an old allow repeated: still allowed at once, the other notebook too");
  check(rec().migrated === 1 && rec().docs.same?.write?.includes("/") && rec().docs.other?.write?.includes("/") && !store.has("sagebrush-permissions"), "…that write carried both old choices and the mark, and the old key is retired");
  const ms2 = createPermissions();
  check(ms2.may("same", "files") === true && ms2.may("other", "files") === true && rec().migrated === 1, "…and a reload is stable");
  // (astra's MIG-BOUND-2: held in the page, the old choices are bounded as the record is: every "don't allow", and
  // only the newest docsKept allows; a "don't allow" held over a stored grant still wins)
  store.clear();
  store.set("sagebrush-grants", JSON.stringify({ v: 1, seq: 1, docs: { gd: { write: ["/"], t: 1 } } }));
  const many = [["gd", { files: false }], ["d0", { files: false }], ...Array.from({ length: GRANT_CAPS.docsKept + 500 }, (_, i) => ["ab" + i, { files: true }]), ["d1", { files: false }]];
  store.set("sagebrush-permissions", JSON.stringify(Object.fromEntries(many)));
  failing = true;
  const mh = createPermissions();
  const allowedHeld = Array.from({ length: GRANT_CAPS.docsKept + 500 }, (_, i) => mh.may("ab" + i, "files")).filter(Boolean).length;
  failing = false;
  check(allowedHeld === GRANT_CAPS.docsKept && mh.may("ab0", "files") === false && mh.may("ab" + (GRANT_CAPS.docsKept + 499), "files") === true, "migration failed: the page holds the newest 2,000 old allows, the oldest only off: " + allowedHeld);
  check(["gd", "d0", "d1"].every((d) => mh.may(d, "files") === false), "…and every old \"don't allow\", one over a stored grant included");
  store.clear();
  store.set("sagebrush-permissions", JSON.stringify(Object.fromEntries(Array.from({ length: GRANT_CAPS.docsKept + 500 }, (_, i) => ["mm" + i, { files: i % 2 === 0 }]))));
  const mb = createPermissions();
  check(Object.keys(rec().docs).length === GRANT_CAPS.docsKept && !rec().docs.mm0 && !!rec().docs["mm" + (GRANT_CAPS.docsKept + 499)] && mb.may("mm0", "files") === false, "migrating more old choices than the record keeps: bounded at 2,000 notebooks, the oldest go (which only turns them off)");
  store.clear();
  // (scoped grants: recorded, not enforced)
  const g = createPermissions(); g.provenance("doc", "elsewhere");
  check(g.grant("doc", "write", "/out").ok && g.may("doc", "files") === false, "a write tree is recorded but enforces nothing yet: may(files) stays the switch's");
  // (canonical scopes, R4: folders; hosts lowercase, IDNA, the port explicit and normalized first; idempotent)
  check(["/a/../b", "/a/", "a", "//x", "/x/./y"].every((t) => canonicalScope("write", t) === null) && canonicalScope("write", "/") === "/", "folders are canonical: no . or .. or empty parts");
  check(["h.org", "H.ORG", "h.org:443", "h.org:00443"].every((h) => canonicalScope("net", h) === "h.org:443") && canonicalScope("net", "h.org:8443") === "h.org:8443" && canonicalScope("net", "münchen.de") === "xn--mnchen-3ya.de:443", "a host is lowercase IDNA with its port explicit, the port normalized first: h.org, H.ORG, h.org:443, h.org:00443 are one");
  check(["h.org", "münchen.de:8443", "X.org:00080"].every((h) => canonicalScope("net", canonicalScope("net", h)) === canonicalScope("net", h)), "…and canonicalizing twice changes nothing");
  check(["*.x.org", "https://x.org", "u@x.org", "x.org/p", "x.org:0", "x.org:70000", "[::1]", ""].every((h) => canonicalScope("net", h) === null), "…no wildcard, scheme, user, path, bad port or IPv6 literal");
  check([".example.com", "example.com."].every((h) => canonicalScope("net", h) === null), "…nor a leading or trailing dot");
  const label = (n) => "a".repeat(n), h253 = [label(63), label(63), label(63), label(61)].join("."), h254 = [label(63), label(63), label(63), label(62)].join(".");
  check(canonicalScope("net", h253) === h253 + ":443" && canonicalScope("net", h254) === null, "…a host of 253 characters is a scope, one of 254 isn't");
  const p1024 = "/" + "a".repeat(1023);
  check(canonicalScope("write", p1024) === p1024 && canonicalScope("write", p1024 + "a") === null, "a folder of 1,024 characters is a scope, one of 1,025 isn't");
  check(["/a\nb", "/a\u0000b", "/a\u001fb", "/a\tb"].every((t) => canonicalScope("write", t) === null), "…nor one with a control character in it");
  // (what a grant covers: a folder its own tree, a host itself; never a sibling or a lookalike)
  check(scopeCovers("write", "/a", "/a") && scopeCovers("write", "/a", "/a/b") && scopeCovers("write", "/", "/x") && !scopeCovers("write", "/a", "/ab") && !scopeCovers("write", "/a", "/a.txt"), "a grant of /a covers /a and /a/b, never /ab or /a.txt");
  check(scopeCovers("net", "example.com:443", "example.com:443") && !scopeCovers("net", "example.com:443", "evil-example.com:443") && !scopeCovers("net", "example.com:443", "sub.example.com:443") && !scopeCovers("net", "example.com:443", "example.com:8443"), "a grant of example.com covers it alone: not evil-example.com, sub.example.com or another port");
  // (the cap at its edge: the 32nd scope of a kind granted, the 33rd refused)
  const k32 = createPermissions();
  const got32 = Array.from({ length: 32 }, (_, i) => k32.grant("k", "write", "/c" + i).ok).filter(Boolean).length;
  check(got32 === 32 && k32.grant("k", "write", "/c32").why === "cap", "a kind's 32nd scope is granted, its 33rd refused (cap)");
  // (the cap, stored and once together)
  for (let i = 0; i < 20; i++) g.grant("doc", "write", "/s" + i);
  for (let i = 20; i < 40; i++) g.grant("doc", "write", "/s" + i, { once: true });
  const w = g.grants("doc").write;
  check(w.stored.length + w.once.length === GRANT_CAPS.perKind && g.grant("doc", "write", "/more").why === "cap" && g.grant("doc", "write", "/more", { once: true }).why === "cap" && g.grant("doc", "write", "/s3").ok, "stored and once grants share one cap of 32 a kind: past it, refused (nothing widens), an existing scope still fine");
  // (R2: the latest decision wins: promoting once to stored at the full cap leaves the total at 32)
  const once0 = g.grants("doc").write.once[0];
  check(g.grant("doc", "write", once0).ok && g.grants("doc").write.once.indexOf(once0) === -1 && g.grants("doc").write.stored.includes(once0) && g.grants("doc").write.stored.length + g.grants("doc").write.once.length === GRANT_CAPS.perKind, "promoting a once grant to stored at the full cap: one entry, the total still 32");
  check(g.grant("doc", "write", once0, { once: true }).ok && !g.grants("doc").write.once.includes(once0), "…a once grant of a scope already stored changes nothing");
  g.revoke("doc", "write", "/s3");
  check(g.grant("doc", "write", "/more").ok, "…removing one makes room");
  check(g.deny("doc", "write", "/more") && !g.grants("doc").write.stored.includes("/more"), "a denial removes the scope's stored grant");
  const once1 = g.grants("doc").write.once[0];
  check(g.deny("doc", "write", once1) && !g.grants("doc").write.once.includes(once1), "…and its once grant");
  g.deny("doc", "read", "/x", { stored: true });
  g.grant("doc", "read", "/x", { once: true });
  check(!g.grants("doc").denied.stored.some(([k, x]) => k === "read" && x === "/x") && g.grants("doc").read.once.includes("/x"), "a once grant removes the scope's stored denial");
  g.deny("doc", "read", "/y");
  g.grant("doc", "read", "/y");
  check(!g.grants("doc").denied.session.some(([k, x]) => k === "read" && x === "/y") && g.grants("doc").read.stored.includes("/y"), "…a stored grant removes its session denial");
  // (R2: a stored write that fails changes nothing and refuses)
  failing = true;
  const before = JSON.stringify(g.grants("doc"));
  const r1 = g.grant("doc", "read", "/z"), r2 = g.deny("doc", "read", "/y"), r3 = g.revoke("doc", "read", "/y");
  failing = false;
  check(r1.why === "storage" && r2 === false && r3 === false && JSON.stringify(g.grants("doc")) === before, "storage refusing a stored change: the grant, the denial and the removal are refused, and nothing changed");
  g.endSession("doc");
  check(g.grants("doc").write.once.length === 0 && g.grants("doc").write.stored.includes(once0), "the end of a session takes its once grants, and keeps the stored ones");
  // (R3: session bounds; a repeated denial is fresh; empty entries pruned)
  const sb = createPermissions();
  for (let i = 0; i < GRANT_CAPS.sessionDenialsPerDoc; i++) sb.deny("e", "net", "h" + i + ".org");
  sb.deny("e", "net", "h0.org");
  sb.deny("e", "net", "h256.org");
  const den = sb.grants("e").denied.session.map(([, h]) => h);
  check(den.length === GRANT_CAPS.sessionDenialsPerDoc && den.includes("h0.org:443") && !den.includes("h1.org:443") && den.includes("h256.org:443"), "a document's session denials are bounded at 256, the oldest evicted, a repeated one counted as fresh");
  const sc = createPermissions();
  for (let i = 0; i < GRANT_CAPS.sessionDocs; i++) sc.deny("x" + i, "net", "a.org");
  check(sc.sessionCounts().docs === GRANT_CAPS.sessionDocs && sc.deny("x" + GRANT_CAPS.sessionDocs, "net", "a.org") === false && sc.grant("y", "write", "/a", { once: true }).why === "cap" && sc.sessionCounts().docs === GRANT_CAPS.sessionDocs, "4,096 documents with session entries admitted; the 4,097th refused, a denial and a once grant alike");
  check(sc.deny("x0", "net", "b.org") && sc.sessionCounts().denials === GRANT_CAPS.sessionDenialsPage, "…a document already admitted still records; the page's session denials stay at 4,096, the oldest evicted");
  for (let i = 0; i < GRANT_CAPS.sessionDocs; i++) sc.endSession("x" + i);
  check(sc.sessionCounts().docs === 0 && sc.sessionCounts().denials === 0, "…and ended sessions leave nothing behind");
  const sp = createPermissions();
  sp.deny("p", "net", "c.org"); sp.grant("p", "net", "c.org", { once: true }); sp.deny("p", "net", "c.org"); sp.forgetDenials("p");
  check(sp.sessionCounts().docs === 0, "a document's session entry left empty is pruned");
  const rv = createPermissions();
  rv.grant("r", "write", "/o", { once: true }); rv.revoke("r", "write", "/o");
  check(!rv.grants("r").write.once.includes("/o") && rv.sessionCounts().docs === 0, "removing a scope granted once takes it from this session too");
  const fg = createPermissions();
  for (let i = 0; i < 100; i++) fg.deny("f", "net", "h" + i + ".org");
  fg.forgetDenials("f");
  check(fg.sessionCounts().denials === 0 && fg.sessionCounts().docs === 0, "forgetting a document's denials takes them from the page's count");
  const pe = createPermissions();
  pe.deny("old", "net", "o.org");
  for (let d = 0; d < GRANT_CAPS.sessionDenialsPage / GRANT_CAPS.sessionDenialsPerDoc; d++) for (let i = 0; i < GRANT_CAPS.sessionDenialsPerDoc; i++) pe.deny("p" + d, "net", "h" + i + ".org");
  check(pe.grants("old").denied.session.length === 0 && pe.sessionCounts().denials === GRANT_CAPS.sessionDenialsPage && pe.sessionCounts().docs === GRANT_CAPS.sessionDenialsPage / GRANT_CAPS.sessionDenialsPerDoc, "a document whose last session denial the page's bound evicts leaves no entry behind");
  // (stored denials, page-wide: the record preloaded at its cap in one write, then one more denial: the oldest goes)
  store.set("sagebrush-grants", JSON.stringify({ v: 1, seq: GRANT_CAPS.storedDenials, docs: Object.fromEntries(Array.from({ length: 50 }, (_, d) => ["big" + d, { denied: Array.from({ length: GRANT_CAPS.storedDenials / 50 }, (_, j) => ["net", `h${j * 50 + d}.org:443`, j * 50 + d + 1]), t: 1 }])) }));
  const sd = createPermissions();
  check(sd.deny("big0", "net", "new.org", { stored: true }), "(one more stored denial)");
  const kept2 = Object.values(JSON.parse(store.get("sagebrush-grants")).docs).reduce((n, e) => n + (e.denied?.length ?? 0), 0);
  check(kept2 === GRANT_CAPS.storedDenials && !sd.grants("big0").denied.stored.some(([, h]) => h === "h0.org:443") && sd.grants("big0").denied.stored.some(([, h]) => h === "new.org:443") && sd.grants("big1").denied.stored.some(([, h]) => h === "h1.org:443"), "stored denials are bounded at 20,000 page-wide, the oldest evicted: " + kept2);
  // (the scoped record: past docsKept the least recently changed document goes; an emptied one leaves nothing; only v 1 is read)
  store.set("sagebrush-grants", JSON.stringify({ v: 1, seq: GRANT_CAPS.docsKept, docs: Object.fromEntries(Array.from({ length: GRANT_CAPS.docsKept }, (_, i) => ["dd" + i, { write: ["/w"], t: i + 1 }])) }));
  const dk = createPermissions();
  const gdocs = () => JSON.parse(store.get("sagebrush-grants")).docs;
  check(dk.grant("dd-new", "write", "/w").ok && "dd-new" in gdocs() && !("dd0" in gdocs()) && "dd1" in gdocs() && Object.keys(gdocs()).length === GRANT_CAPS.docsKept, "past 2,000 documents, the least recently changed one's record goes and the newest stays");
  dk.grant("t8", "write", "/a"); dk.revoke("t8", "write", "/a");
  check(!("t8" in gdocs()), "a document whose grants are all removed leaves no entry in the stored record");
  store.set("sagebrush-grants", JSON.stringify({ v: 2, seq: 5, docs: { v2: { write: ["/a"], net: ["x.org:443"], t: 1 } } }));
  const v2 = createPermissions().grants("v2");
  check(v2.write.stored.length === 0 && v2.net.stored.length === 0 && JSON.parse(store.get("sagebrush-grants")).v === 2, "a stored record of another version is read as empty, not used, and not rewritten");
  delete globalThis.localStorage;
}
const W = "window.sagebrush.workspace";
const base = `http://127.0.0.1:${port}/`;
const go = async (url) => { await send("Page.navigate", { url }); await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000); await sleep(300); };
// (the person's own click: one the browser marks isTrusted)
const trusted = async (sel) => {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error("no " + sel);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(200);
};
// (File > Permissions…, the panel with the File writes switch: opened and closed as a person does, by clicks and Escape)
const openPerms = async () => { await trusted("#filebtn"); await trusted("#permsmenu"); };
const closePerms = async () => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(150); };
const filesSwitch = async () => { await openPerms(); await trusted("#filesperm"); await closePerms(); };
const out = (i = 0) => ev(`[...document.querySelectorAll('#cells .cell')][${i}]?.querySelector('.out')?.textContent ?? ''`);
const setCode = (code, i = 0) => ev(`(() => { const ta = [...document.querySelectorAll('#cells .cell textarea')][${i}]; ta.value = ${JSON.stringify(code)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
const runAll = () => ev("sagebrush.notebook.runAll().then(() => 1)");
const stat = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then((e) => !!e, () => false)`);
const files = () => ev("sagebrush.permissions()?.files");
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/remote.ipynb", requestStage: "Request" }, { urlPattern: "*/remote2.ipynb", requestStage: "Request" }] });
  // (the person's data file, made in their workspace first)
  await go(base);
  await until(`!!${W}`, 60000);
  await ev(`${W}.create("/keep.txt", { content: new TextEncoder().encode("kept") }).then(() => 1)`);

  // ---- a remote notebook: runs nothing on open; Run all runs it, changing nothing
  await go(base + "?open=" + encodeURIComponent(base + "remote.ipynb") + "&run");
  check((await ev("[...document.querySelectorAll('#cells .cell textarea')][0]?.value.startsWith('import os')")), "a remote notebook opens (?open=…&run)");
  await sleep(3000);
  check((await out()) === "" && !(await ev("!!document.querySelector('#cells .running, #cells .queued')")), "…and runs nothing on open (?run is gone)");
  check((await files()) === false, "…its code can't change files: " + JSON.stringify(await ev("sagebrush.permissions()")));
  await runAll();
  check(await until("/NM:/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 60000), "Run all runs it");
  const res = (await out()).trim();
  check(res === "NM:read:ok,write:refused,append:refused,mkdir:refused,remove:refused,rename:refused,move:refused,tmp:ok", "…it reads the person's files; its write, append, mkdir, remove, rename and replace are each refused with PermissionError; /tmp's write isn't: " + res);
  await sleep(1500);
  check((await stat("/keep.txt")) && !(await stat("/nm-w.txt")) && !(await stat("/nm-dir")) && !(await stat("/keep2.txt")) && !(await stat("/moved.txt")) && !(await stat("/tmp/nm-t.txt")), "…and the workspace is unchanged (/tmp kept nowhere)");
  check(await ev("!document.querySelector('#filesbar').hidden && /wants to change \\/nm-w\\.txt, at the top of your files/.test(document.querySelector('#filesbar').textContent) && !document.querySelector('#fbperms').hidden && document.querySelector('#fballow').hidden"), "…the page asks about its first refused change, at the top of the files: no Allow there, only File > Permissions… (confinement phase 2: anywhere is never a prompt's default)");
  // (a forged change, as if from its interpreter: kept nowhere)
  await ev(`(() => { sagebrush.kernel.worker.onmessage?.({ data: { fsChanged: "/forged.txt", data: new Uint8Array([1, 2]) } }); return 1; })()`);
  await sleep(1500);
  check(!(await stat("/forged.txt")), "a change its interpreter sends anyway (a forged fsChanged) is kept nowhere");
  // (the prompt's File > Permissions…: a synthetic click does nothing; the person's own click opens the panel, whose
  // switch allows changes anywhere; the next run, an explicit one, starts an interpreter that may)
  await sleep(700);
  await ev("(document.querySelector('#fbperms').click(), 1)");
  check((await files()) === false && !(await ev("document.querySelector('#permsdlg').open")), "a synthetic click on the prompt's Permissions… changes nothing");
  await trusted("#fbperms");
  check(await ev("document.querySelector('#permsdlg').open"), "the person's own click on it opens File > Permissions…");
  await trusted("#filesperm");
  await closePerms();
  check((await files()) === true && (await ev("document.querySelector('#filesbar').hidden")), "…whose switch, the person's own click, allows changes: it may change files now, the bar gone");
  await runAll();
  check(await until(`${W}.stat("/nm-w.txt").then((e) => !!e)`, 30000), "…and the cell run again writes: /nm-w.txt is in the workspace");

  // (another notebook from elsewhere: A's Allow is A's alone)
  await go(base + "?open=" + encodeURIComponent(base + "remote2.ipynb"));
  check((await files()) === false, "a second notebook from elsewhere can't change files: the first's Allow is the first's alone");

  // ---- a notebook that can't change files never runs in a plain worker
  const remoteId = await ev("localStorage.getItem('sagebrush-current')");
  await go(base + "?open=" + encodeURIComponent(base + "remote.ipynb") + "&runner=0");
  await runAll();
  // (it says why in the run bar, above the notebook, with its one way to run it; its cells untouched)
  check(await until(`!document.querySelector('#runbar').hidden && /To run in this page, this notebook needs permission to change files/.test(document.querySelector('#rbtext').textContent)`, 30000) && !/can't run here/.test(await out()), "?runner=0: a notebook from elsewhere doesn't run in the page's own interpreter, and the run bar says why: " + (await ev("document.querySelector('#rbtext').textContent")).slice(0, 160));

  // ---- the person's own notebook: writes; Don't allow file changes; a run in flight; reopen; Allow again
  await go(base + "?runner=1");
  await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
  await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value", 20000);
  await sleep(1000);
  // (confinement 1b, O1: the person's own new notebook starts with file changes off too; its first write is refused and
  // the bar asks; the person's own click allows, and the cell run again writes)
  check((await files()) === false, "the person's own new notebook starts with file changes off (O1): " + JSON.stringify(await ev("sagebrush.permissions()")));
  await setCode("try:\n    open('own-1.txt', 'w').write('x'); print('W1')\nexcept PermissionError as e:\n    print('REFUSED', e)");
  const tFirst = Date.now();
  await runAll();
  check(await until("/REFUSED/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 60000), "…its first write is refused: " + (await out()).trim().slice(0, 160));
  console.log(`(the own notebook's first run, in the sandbox frame: ${Date.now() - tFirst} ms)`);
  check(!(await stat("/own-1.txt")) && (await ev("!document.querySelector('#filesbar').hidden && /wants to change \\/own-1\\.txt/.test(document.querySelector('#filesbar').textContent)")), "…nothing is written, and the bar asks about it");
  await filesSwitch();
  check((await files()) === true && (await ev("document.querySelector('#filesbar').hidden")), "…the person's own click on File > Permissions…'s switch: it may change files now, the bar gone");
  await setCode("open('own-1.txt', 'w').write('x'); print('W1')");
  await runAll();
  check(await until(`${W}.stat("/own-1.txt").then((e) => !!e)`, 30000), "…and the cell run again writes: /own-1.txt");
  await openPerms();
  check(/Don't allow file changes/.test(await ev("document.querySelector('#filesperm').textContent")), "File > Permissions… offers Don't allow file changes");
  const panel = await ev("document.querySelector('#permsdlg').open && document.querySelector('#permsdlg').textContent");
  check(typeof panel === "string" && /File writes/.test(panel) && /Allowed: this notebook's code may change your files/.test(panel) && /never in the notebook, so anyone you send it to starts with nothing allowed/.test(panel) && !/trust/i.test(panel), "…a panel drawn by the page: File writes, what it allows now, never the word trust");
  await trusted("#filesperm");
  check(/Not allowed: this notebook's code can't change your files/.test(await ev("document.querySelector('#permsfiles').textContent")), "…and it says so at once");
  await closePerms();
  check((await files()) === false, "…the person's own click: it can't change files now");
  await setCode("try:\n    open('own-2.txt', 'w').write('x'); print('W2')\nexcept PermissionError as e:\n    print('REFUSED', e)");
  await runAll();
  check(await until("/REFUSED/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000), "…a write raises PermissionError, saying why: " + (await out()).trim().slice(0, 160)); check(/isn't allowed to change this file/.test(await out()), "…in words: " + (await out()).trim().slice(0, 160));
  check(!(await stat("/own-2.txt")), "…and nothing is written");
  const ownId = await ev("localStorage.getItem('sagebrush-current')");
  await go(base + "?nb=" + encodeURIComponent(ownId));
  await sleep(800);
  check((await files()) === false, "…the person's choice survives a reopen");
  await openPerms();
  check(/^Allow file changes/.test(await ev("document.querySelector('#filesperm').textContent")), "File > Permissions… now offers Allow file changes");
  await trusted("#filesperm");
  await closePerms();
  check((await files()) === true, "…which allows them again");
  await setCode("open('own-3.txt', 'w').write('x'); print('W3')");
  await runAll();
  check(await until(`${W}.stat("/own-3.txt").then((e) => !!e)`, 30000), "…and the write works: /own-3.txt");
  // (a run in flight: a loop writing a file every 0.25 s, its permission withdrawn part-way: refused at its next write)
  await setCode("import time\nh = open('flight.txt', 'w')\nfor i in range(40):\n    try:\n        h.write('x'); h.flush(); print('w', i, flush=True)\n    except PermissionError:\n        print('refused at', i); break\n    time.sleep(0.25)");
  await ev("(sagebrush.notebook.runAll(), 1)");
  await until("/w 3/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
  await filesSwitch();
  check(await until("/refused at \\d+/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 20000), "a run in flight is refused at its next write once file changes aren't allowed, through a file it opened before: " + (await out()).trim().split("\n").slice(-1)[0]);
  await filesSwitch();
  check((await files()) === true, "(allowed again)");
  // (a choice made in another tab while the panel was closed: opening it shows the one now in effect)
  // (another tab's choice is the scoped record's write scope "/": granted, or denied)
  const otherTab = (on) => ev(`(() => { const k = "sagebrush-grants", r = JSON.parse(localStorage.getItem(k)), e = (r.docs[${JSON.stringify(ownId)}] ??= {}); e.write = (e.write ?? []).filter((x) => x !== "/"); e.denied = (e.denied ?? []).filter((x) => !(x[0] === "write" && x[1] === "/")); if (${on}) e.write.push("/"); else e.denied.push(["write", "/", ++r.seq]); e.t = ++r.seq; localStorage.setItem(k, JSON.stringify(r)); return 1; })()`);
  await otherTab(false);
  await openPerms();
  check(/Not allowed: this notebook's code can't change your files/.test(await ev("document.querySelector('#permsfiles').textContent")) && /^Allow file changes/.test(await ev("document.querySelector('#filesperm').textContent")), "opening the panel shows the choice in effect now, one made in another tab included");
  await closePerms();
  await otherTab(true);
  check((await files()) === true, "(allowed again)");
  // (a change still queued when file changes stop being allowed: not kept)
  await ev("(window.__release = sagebrush.files.holdDrain(), 1)");
  await setCode("open('queued.txt', 'w').write('x'); print('Q')");
  await runAll();
  await until("/Q/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
  await until("sagebrush.files.queue().paths > 0", 10000);
  await filesSwitch();
  await ev("(window.__release(), 1)");
  await sleep(1500);
  check((await files()) === false && !(await stat("/queued.txt")), "a change queued before file changes stopped being allowed isn't kept");

  // ---- past the queue's own check (held there): "don't allow" before it is kept; the workspace's admission refuses
  const VS = (p) => ev(`${W}.stat(${JSON.stringify(p)}).then(async (e) => e ? [e.fid, e.size ?? null, (await ${W}.history(${JSON.stringify(p)}).catch(() => [])).length].join(":") : "none", () => "err")`);
  const allowOwn = async () => { if (!(await files())) { await filesSwitch(); } };
  const taken = () => until("sagebrush.files.queue().draining && sagebrush.files.queue().paths === 0", 20000);
  const lateCase = async (code, revoke) => {
    await allowOwn();
    await ev("(window.__go = sagebrush.files.holdAdmit(), 1)");
    await setCode(code + "; print('L')");
    await runAll();
    await until("/L/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
    await taken(); await sleep(500);
    if (revoke) { await filesSwitch(); }
    await ev("(window.__go(), 1)");
    await until("!sagebrush.files.queue().draining", 20000); await sleep(800);
  };
  await allowOwn();
  await setCode("open('late-over.txt', 'w').write('one'); open('late-del.txt', 'w').write('d'); print('S')");
  await runAll();
  await until(`${W}.stat("/late-del.txt").then((e) => !!e)`, 30000); await sleep(800);
  // (controls: held the same way and released, still allowed: kept)
  await lateCase("open('late-ctl.txt', 'w').write('x')", false);
  check(await stat("/late-ctl.txt"), "control: a change held past the queue's check, released while allowed, is kept");
  await lateCase("open('late-new.txt', 'w').write('x')", true);
  check(!(await stat("/late-new.txt")) && (await files()) === false, "a new file held past the queue's check, then \"don't allow\": the workspace's locked create refuses it, nothing made");
  const over0 = await VS("/late-over.txt");
  await lateCase("open('late-over.txt', 'w').write('two, longer')", true);
  check((await VS("/late-over.txt")) === over0 && over0 !== "none", "a write over a file, held so, then \"don't allow\": refused at the locked write, the file, its size and its versions unchanged: " + over0);
  const del0 = await VS("/late-del.txt");
  await lateCase("import os; os.remove('late-del.txt')", true);
  check((await VS("/late-del.txt")) === del0 && del0 !== "none" && !(await ev(`${W}.list("/Trash").then((l) => l.some((e) => /late-del/.test(e.path)), () => false)`)), "a remove, held so, then \"don't allow\": refused at the locked remove, the file still there, nothing in Trash");
  // (an interpreter restarted meanwhile: its old change isn't the document's any more)
  await allowOwn();
  await ev("(window.__go = sagebrush.files.holdAdmit(), 1)");
  await setCode("open('late-gen.txt', 'w').write('x'); print('G')");
  await runAll();
  await until("/G/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
  await taken(); await sleep(500);
  await ev("(sagebrush.notebook.restart?.() ?? document.querySelector('#restart').click(), 1)");
  await setCode("print('fresh')"); await runAll();
  await until("/fresh/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
  await ev("(window.__go(), 1)");
  await until("!sagebrush.files.queue().draining", 20000); await sleep(800);
  check((await files()) === true && !(await stat("/late-gen.txt")), "a change from an interpreter restarted before it was kept isn't kept, file changes still allowed");
  // (a message from the worker before a restart, arriving after it: judged by its sender, not by when it arrives)
  await ev("(window.__oldMsg = sagebrush.kernel.worker.onmessage, 1)");
  await ev("(sagebrush.notebook.restart?.() ?? document.querySelector('#restart').click(), 1)");
  await setCode("print('fresh2')"); await runAll();
  await until("/fresh2/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
  // (a second live interpreter, another notebook's, which would be given the change if it were taken)
  await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
  await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value", 20000);
  await sleep(800);
  await allowOwn(); // (a new notebook starts off (O1): allowed by the person's click, as the rest of this needs)
  check((await files()) === true, "(the second notebook, allowed by the person)");
  const seen = async (tag) => { await setCode(`import os; print('${tag}', os.path.exists('stale.txt'))`); await runAll(); await until(`/${tag} (True|False)/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')`, 30000); return /True/.test(await out()); };
  check((await seen("B0")) === false, "(a second notebook's interpreter running, without /stale.txt)");
  // (the queue held while the old worker's message arrives: only the sender check can refuse it there)
  await ev("(window.__rel = sagebrush.files.holdDrain(), 1)");
  await ev(`(window.__oldMsg({ data: { fsChanged: "/stale.txt", data: new Uint8Array([7]) } }), 1)`);
  await sleep(300);
  check((await ev("sagebrush.files.queue().paths")) === 0, "a change from the worker before a restart, arriving after it, the queue held: not queued");
  check((await seen("B1")) === false, "…nor given to another live interpreter");
  await ev("(window.__rel(), 1)");
  await sleep(1500);
  check((await files()) === true && !(await stat("/stale.txt")), "…and, the queue released, kept nowhere, file changes still allowed");
  await ev(`(sagebrush.kernel.worker.onmessage({ data: { fsChanged: "/cur-ctl.txt", data: new Uint8Array([7]) } }), 1)`);
  check(await until(`${W}.stat("/cur-ctl.txt").then((e) => !!e)`, 15000), "control: the same change from the current worker is kept");

  // ---- "don't allow" when storage can't keep it: in effect, and said
  await ev(`(() => { const o = Storage.prototype.setItem; window.__setItem = o; Storage.prototype.setItem = function (k, v) { if (k === "sagebrush-grants") throw new DOMException("full", "QuotaExceededError"); return o.call(this, k, v); }; return 1; })()`);
  await filesSwitch();
  check((await files()) === false && /couldn't keep the choice/.test(await ev("document.querySelector('#status').textContent")), "\"don't allow\" with storage refusing it: in effect anyway, and the page says it couldn't keep it: " + (await ev("document.querySelector('#status').textContent")).slice(0, 140));
  await setCode("try:\n    open('unkept.txt', 'w').write('x'); print('W')\nexcept PermissionError:\n    print('REFUSED')");
  await runAll();
  check(await until("/REFUSED/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000) && !(await stat("/unkept.txt")), "…the next write is refused, nothing written");
  await ev("(Storage.prototype.setItem = window.__setItem, 1)");
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));

  // ---- with no sandbox (?runner=0, as in the app): a notebook allowed to change files, reopened while the page runs,
  // has its grant known before its interpreter starts, so that interpreter is a plain one from the start, never one
  // that can't change files (whose ready has no version) restarted once it's known; one not allowed (the person's own
  // included, and an example: O1, O6) gets no plain interpreter at all
  const newOwn = async () => {
    await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
    await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value", 20000);
    await sleep(800);
    return ev("localStorage.getItem('sagebrush-current')");
  };
  await go(base + "?runner=0");
  const idA = await newOwn();
  await filesSwitch();
  check((await files()) === true, "(A, the person's, allowed to change files)");
  const idB = await newOwn();
  check(idA && idB && idA !== idB && (await files()) === false, "(two notebooks of the person's: A, then B, which isn't allowed)");
  await setCode("print('B ran')");
  await runAll();
  check(await until(`!document.querySelector('#runbar').hidden && /To run in this page, this notebook needs permission to change files/.test(document.querySelector('#rbtext').textContent)`, 30000) && !/B ran/.test(await out()), "?runner=0: the person's own notebook not allowed to change files doesn't run in the page's own interpreter, and the run bar says why");
  const { identifier: statusLog } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__statuses = []; new MutationObserver((ms) => { for (const m of ms) if (m.target.id === "status" || m.target.parentElement?.id === "status") for (const n of m.addedNodes) window.__statuses.push(n.textContent); }).observe(document, { childList: true, subtree: true });` });
  await go(base + "?runner=0");
  check((await ev("localStorage.getItem('sagebrush-current')")) === idB, "(reloaded into B; A has no interpreter in this page)");
  await ev("(window.__statuses.length = 0, 1)");
  await ev(`sagebrush.open(${JSON.stringify(idA)}).then(() => 1)`);
  await until(`localStorage.getItem('sagebrush-current') === ${JSON.stringify(idA)} && !!sagebrush.kernel?.context`, 30000);
  const reopened = await ev("window.__statuses");
  check(!reopened.some((t) => /^ready \(sagebrush ,/.test(t)) && (await files()) === true, "A reopened while the page runs: its interpreter a plain one from the start (no refusing interpreter's ready), files allowed: " + JSON.stringify(reopened.filter((t) => /ready/.test(t))));
  // (and one of Sagebrush's own examples, opened from the Examples dialog while the page runs: host-made before it opens)
  await ev("(window.__statuses.length = 0, 1)");
  await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="examples"]').click(); return 1; })()`);
  await until("!!document.querySelector('#exlist button')", 10000);
  const exBefore = await ev("localStorage.getItem('sagebrush-current')");
  await ev("(document.querySelector('#exlist button').click(), 1)");
  await until(`localStorage.getItem('sagebrush-current') !== ${JSON.stringify(exBefore)}`, 30000);
  await sleep(800);
  const exStatuses = await ev("window.__statuses");
  check((await files()) === false, "an example opened from the Examples dialog starts with file changes off too (O6): " + JSON.stringify(exStatuses.filter((t) => /ready/.test(t))));
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: statusLog });

  // ---- no workspace (it can't be opened): the old store's write asks the same authority, in its own transaction
  const { identifier: noWs } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `{ const o = IDBFactory.prototype.open; IDBFactory.prototype.open = function (name, ...a) { if (name === "sagebrush-workspace") throw new DOMException("blocked for the test", "UnknownError"); return o.call(this, name, ...a); }; }` });
  await go(base + "?runner=1");
  await ev(`(() => { document.querySelector('#filebtn')?.click(); document.querySelector('#filemenu [data-group="new"]')?.click(); document.querySelector('#filemenu [data-f="new"]').click(); return 1; })()`);
  await until("sagebrush.notebook.cells().length === 1 && !sagebrush.notebook.cells()[0].ta.value", 20000);
  await sleep(1000);
  check(!(await ev("!!window.sagebrush.workspace")), "(no workspace in this page)");
  const legacy = (k) => ev(`new Promise((r) => { const q = indexedDB.open("sagebrush"); q.onsuccess = () => { try { const g = q.result.transaction("files").objectStore("files").get(${JSON.stringify(k)}); g.onsuccess = () => { r(g.result !== undefined); q.result.close(); }; g.onerror = () => r(null); } catch { r(null); } }; q.onerror = () => r(null); })`);
  await allowOwn();
  const fbCase = async (name, revoke) => {
    await allowOwn();
    await ev("(window.__go = sagebrush.files.holdAdmit(), 1)");
    await setCode(`open('${name}', 'w').write('x'); print('F')`);
    await runAll();
    await until("/F/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 30000);
    await taken(); await sleep(500);
    if (revoke) { await filesSwitch(); }
    await ev("(window.__go(), 1)");
    await until("!sagebrush.files.queue().draining", 20000); await sleep(800);
  };
  await fbCase("fb-ctl.txt", false);
  check((await legacy("/fb-ctl.txt")) === true, "control, without a workspace: a change held and released while allowed is kept in the old store");
  await fbCase("fb-late.txt", true);
  check((await legacy("/fb-late.txt")) === false && (await files()) === false, "…held, then \"don't allow\": the old store's write refuses it, nothing kept");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: noWs });
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
  void remoteId;
} catch (e) {
  check(false, "threw: " + String(e?.stack ?? e).slice(0, 800));
} finally {
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill(); serve.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
