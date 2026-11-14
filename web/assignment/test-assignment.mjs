// ci: web-sync.4 order=34 runner=bun
// The notebook page's assignment mode (web/assignment/assignment.ts), step by step, with every outside part a fake
// and a small stand-in for the page's elements: the hand-over (gone, expired), sign-in (and back to this address, the
// hand-over kept), sync unavailable, the consent screen (the account, this browser's files, sync only on the press), a copy made, found, arriving or refused, and the tool told only after the server acknowledged it;
// and the page's wiring (page.ts): the handout fetched and checked for the copy, and the tool's started call.
//   bun web/assignment/test-assignment.mjs
let checks = 0;
const fails = [];
const ok = (c, what) => { checks++; if (!c) { fails.push(what); console.log("FAIL", what); } };

// ---- a stand-in for the few element features the module uses
class Node0 {
  constructor(tag) { this.tag = tag; this.children = []; this._text = ""; this.hidden = false; this.className = ""; }
  set textContent(t) { this._text = t; this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this._text = ""; this.children = [...n]; }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find?.(pred); if (f) return f; } return null; }
}
globalThis.document = { createElement: (t) => new Node0(t), createTextNode: (t) => Object.assign(new Node0("#text"), { _text: t }) };
class MemStorage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }

const { runAssignment, WORDS } = await import("./assignment.ts");
const { putHandover, HANDOVER_PREFIX, handoverKey } = await import("../share-client/handover.ts");
const flush = () => new Promise((r) => setTimeout(r, 0));

const NOW = 1_800_000_000_000;
const H = { copy: "c".repeat(32), manifest: "https://lti-dev.sagebrush.space/lti/f/cap/manifest", expires: NOW + 600_000, revision: "e".repeat(64), title: "Homework 1" };
function setup(over = {}, h = H) {
  const storage = new MemStorage();
  const key = handoverKey(putHandover(h, storage).slice(1));
  const log = [];
  const ui = new Node0("div");
  const d = {
    key, storage, ui, now: () => NOW,
    status: async () => ({ signedIn: true, account: "student@example.invalid", available: true, on: true }),
    signInUrl: (back) => `/auth/login?return=${encodeURIComponent(back)}`,
    navigate: (u) => log.push(["navigate", u]),
    localUsage: async () => ({ files: { count: 3, bytes: 52_000 } }),
    enableSync: async () => (log.push(["enable"]), { ok: true }),
    handout: async () => [{ path: "hw1.ipynb", kind: "notebook", content: { cells: [] } }],
    startCopy: async (a) => (log.push(["start", a.copyId, a.revision, a.title, a.files.length]), { state: "applied", folder: "/Assignments/Homework 1 (cccccc)", notebooks: [{ path: "/Assignments/Homework 1 (cccccc)/hw1.ipynb", ref: "r1" }] }),
    onCopyReady: (ref, cb) => (log.push(["wait", ref]), (d.fire = cb), () => log.push(["unwait", ref])),
    openNotebook: async (p) => log.push(["open", p]),
    settled: async () => true,
    started: async (x) => log.push(["started", x.copy]),
    left: () => log.push(["left"]),
    ...over,
  };
  return { d, log, ui, storage, key };
}
const text = (ui) => ui.textContent;
const has = (s, key) => s.getItem(HANDOVER_PREFIX + key) !== null;
const btn = (ui, label) => ui.find((n) => n.tag === "button" && n._text === label);

// 1. the hand-over
{
  const { d, ui } = setup();
  d.key = "f".repeat(32);
  ok((await runAssignment(d)) === "expired" && text(ui) === WORDS.expired, "no hand-over under the key: open the assignment again from your course");
  const e = setup({ now: () => NOW + 600_001 });
  ok((await runAssignment(e.d)) === "expired" && !has(e.storage, e.key), "an expired hand-over is dropped and said so");
}
// 2. signed out: sign in, back to this same address; the hand-over kept
{
  const { d, ui, log, storage, key } = setup({ status: async () => ({ signedIn: false }) });
  ok((await runAssignment(d)) === "signin" && text(ui).includes(WORDS.signIn) && text(ui).includes(WORDS.noAccount), "signed out: the sign-in step, with the create-an-account words");
  btn(ui, "Sign in").onclick();
  ok(log.at(-1)[0] === "navigate" && log.at(-1)[1] === `/auth/login?return=${encodeURIComponent(`/#assignment=${key}`)}` && !/lti|manifest|cap/.test(log.at(-1)[1]), "Sign in returns to /#assignment=<key>, and nothing of the link is in that address");
  ok(has(storage, key), "the hand-over is kept through sign-in");
}
// 3. sync not available for the account
{
  const { d, ui, log } = setup({ status: async () => ({ signedIn: true, account: "a@x", available: false, reason: "sync isn't enabled for this account." }) });
  ok((await runAssignment(d)) === "unavailable" && text(ui) === "Homework 1" + WORDS.unavailable("sync isn't enabled for this account.") && !log.some((l) => l[0] === "start"), "sync not available: said in the server's words, and no copy anywhere");
}
// 4. the consent screen: the account, this browser's files; sync only on the press
{
  const { d, ui, log } = setup({ status: async () => ({ signedIn: true, account: "student@example.invalid", available: true, on: false }) });
  ok((await runAssignment(d)) === "consent", "sync off: the consent screen");
  ok(text(ui).includes(WORDS.consent("student@example.invalid")) && text(ui).includes(WORDS.local(3, "52.0 kB")), "...it names the account and says this browser's 3 files (52.0 kB) go into it");
  ok(!ui.find((n) => n.tag === "input") && !/shared computer/.test(text(ui)) && !log.some((l) => l[0] === "enable"), "...no shared-computer choice (nothing would clear yet), and nothing is turned on before the press");
  d.status = async () => ({ signedIn: true, account: "student@example.invalid", available: true, on: true });
  await btn(ui, "Turn on sync").onclick();
  await flush(); await flush();
  ok(log.some((l) => l[0] === "enable") && log.some((l) => l[0] === "start"), "the press: sync turned on, then the copy started");
  const u = setup({ status: async () => ({ signedIn: true, account: "a@x", available: true, on: false }), enableSync: async () => ({ ok: false, why: "unavailable", message: "not in your plan." }) });
  await runAssignment(u.d);
  await btn(u.ui, "Turn on sync").onclick();
  ok(text(u.ui).includes(WORDS.unavailable("not in your plan.")), "turning sync on refused: the server's words");
  for (const why of ["network", "changed", "old"]) {
    const n = setup({ status: async () => ({ signedIn: true, account: "a@x", available: true, on: false }), enableSync: async () => ({ ok: false, why }) });
    await runAssignment(n.d);
    await btn(n.ui, "Turn on sync").onclick();
    ok(text(n.ui).includes(WORDS.timeout) && !!btn(n.ui, "Try again") && !n.log.some((l) => l[0] === "start"), `turning sync on failed (${why}): couldn't reach the account, Try again, no copy`);
  }
  const so = setup({ status: async () => ({ signedIn: true, account: "a@x", available: true, on: false }), enableSync: async () => ({ ok: false, why: "signedout" }) });
  await runAssignment(so.d);
  so.d.status = async () => ({ signedIn: false });
  await btn(so.ui, "Turn on sync").onclick();
  await flush(); await flush();
  ok(text(so.ui).includes(WORDS.signIn), "signed out meanwhile: back to the sign-in step");
  const z = setup({ status: async () => ({ signedIn: true, account: "a@x", available: true, on: false }), localUsage: async () => ({ files: { count: 0, bytes: 0 } }) });
  await runAssignment(z.d);
  ok(!text(z.ui).includes("Turning on sync also puts"), "with no files in this browser, no line about them");
}
// 5. the copy made: the hand-over dropped, the notebook opened, the tool told after the server's acknowledgment
{
  const { d, log, storage, key } = setup();
  ok((await runAssignment(d)) === "applied", "sync on: the copy is made");
  ok(log.find((l) => l[0] === "start")?.join("|") === ["start", H.copy, H.revision, H.title, 1].join("|"), "...from the hand-over's copy id, revision, title and the handout's files");
  ok(!has(storage, key) && log.some((l) => l[0] === "open" && l[1].endsWith("/hw1.ipynb")) && log.at(-1)[0] === "started", "...the hand-over dropped, the notebook opened, and the tool told it was started, last");
  ok(log.findIndex((l) => l[0] === "left") >= 0 && log.findIndex((l) => l[0] === "left") < log.findIndex((l) => l[0] === "open"), "...and the page's #assignment= address left before the notebook opens");
  const f = setup({ startCopy: async () => ({ state: "found", folder: "/A", notebooks: [{ path: "/A/hw1.ipynb", ref: "r" }] }), settled: async () => false });
  ok((await runAssignment(f.d)) === "found" && f.log.some((l) => l[0] === "open") && !f.log.some((l) => l[0] === "started"), "found: opened; not acknowledged yet, so the tool isn't told");
}
// 6. arriving from another device
{
  const { d, ui, log } = setup({ startCopy: async () => ({ state: "arriving", folder: "/A", notebooks: [{ path: "/A/hw1.ipynb", ref: "r9" }] }) });
  ok((await runAssignment(d)) === "arriving" && text(ui).includes(WORDS.arriving) && !log.some((l) => l[0] === "open"), "arriving: said, and nothing opened yet");
  d.fire();
  await flush();
  ok(log.some((l) => l[0] === "open" && l[1] === "/A/hw1.ipynb") && log.some((l) => l[0] === "unwait") && ui.hidden, "...when it's here, it opens");
}
// 7. refused, off, timeout: said, the hand-over kept for Try again
for (const [state, words] of [["refused", WORDS.refused("storage full: 200 MB of 200 MB.")], ["off", WORDS.off], ["timeout", WORDS.timeout]]) {
  const { d, ui, storage, key, log } = setup({ startCopy: async () => ({ state, notebooks: [], reason: "storage full: 200 MB of 200 MB." }) });
  ok((await runAssignment(d)) === state && text(ui).includes(words) && !!btn(ui, "Try again") && has(storage, key) && !log.some((l) => l[0] === "left"), `${state}: said ("${words.slice(0, 50)}…"), with Try again, the hand-over and the address kept`);
}
// 8. the handout's files not loadable any more: open the assignment again
{
  const { d, ui } = setup({ handout: async () => { throw new Error("410"); } });
  ok((await runAssignment(d)) === "expired" && text(ui).includes(WORDS.expired), "the handout's link no longer works: open the assignment again from your course");
}
// 9. the handout fetched for the copy (page.ts): the tool's list of this same revision, each file checked; a notebook
// its document, a data file its bytes; the tool's fetches without cookies, redirects or referrer
{
  const { handoutFiles, tellStarted } = await import("./page.ts");
  const { createHash } = await import("node:crypto");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const SITE = "https://dev.sagebrush.space", TOOLO = "https://lti-dev.sagebrush.space";
  const base = `${TOOLO}/lti/f/cap1/`;
  const NB = Buffer.from('{"cells":[]}'), CSV = Buffer.from("x,y\n1,2\n");
  const fake = (o = {}) => {
    const calls = [];
    const f = async (url, init) => {
      calls.push([url, init]);
      if (url === base + "manifest") return new Response(JSON.stringify({ copy: o.copy ?? H.copy, title: "Homework 1", created: NOW, sha256: o.revision ?? H.revision, expires: NOW + 600_000, files: [
        { path: "hw1.ipynb", size: NB.length, sha256: sha(NB), url: `${base}0-${NB.length}.${"0".repeat(32)}` },
        { path: "data/points.csv", size: CSV.length, sha256: o.wrong ? sha("other") : sha(CSV), url: `${base}${NB.length}-${CSV.length}.${"0".repeat(31)}1` }] }), { status: 200 });
      if (url.endsWith("0".repeat(32))) return new Response(NB);
      if (url.endsWith("0".repeat(31) + "1")) return new Response(o.short ? CSV.subarray(1) : CSV);
      return new Response("", { status: 404 });
    };
    return { f, calls };
  };
  const h = { ...H, manifest: base + "manifest" };
  const fromFile = (name, text, mode) => ({ made: name, text, mode });
  const { f, calls } = fake();
  const files = await handoutFiles(h, { site: SITE, mode: "python", fetch: f, fromFile });
  ok(files.length === 2 && files[0].path === "hw1.ipynb" && files[0].kind === "notebook" && files[0].content.made === "hw1.ipynb" && files[0].content.text === '{"cells":[]}' && files[0].content.mode === "python", "the handout: its .ipynb is a notebook document, made by the page's own reader");
  ok(files[1].path === "data/points.csv" && files[1].kind === "file" && files[1].content instanceof Uint8Array && Buffer.from(files[1].content).equals(CSV), "...and its data file is its bytes");
  ok(calls.length === 3 && calls.every(([, i]) => i?.credentials === "omit" && i?.redirect === "error" && i?.referrerPolicy === "no-referrer"), "...every fetch from the tool: no cookies, no redirects, no referrer");
  for (const [what, o] of [["another revision", { revision: "f".repeat(64) }], ["another copy", { copy: "d".repeat(32) }], ["a file not the one listed (SHA-256)", { wrong: true }], ["a file cut short", { short: true }]]) {
    const r = await handoutFiles(h, { site: SITE, mode: "python", fetch: fake(o).f, fromFile }).then(() => "made", () => "refused");
    ok(r === "refused", `the handout refused for ${what}: no copy made from it`);
  }
  ok((await handoutFiles(h, { site: "https://elsewhere.example", mode: "python", fetch: f, fromFile }).then(() => "made", () => "refused")) === "refused", "...and on any site but the tool's paired one");
  const sent = [];
  await tellStarted(h, async (url, init) => (sent.push([url, init]), new Response(null, { status: 204 })));
  ok(sent.length === 1 && sent[0][0] === base + "started" && sent[0][1].method === "POST" && sent[0][1].body === undefined && sent[0][1].credentials === "omit" && !sent[0][1].headers, "started: one POST to the capability's /started, with no body, no cookies, no headers");
}
console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
