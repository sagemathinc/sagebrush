// ci: web-sync.4 order=34 runner=bun
// The notebook page's assignment mode (web/assignment/assignment.ts), step by step, with every outside part a fake
// and a small stand-in for the page's elements: the hand-over (gone, expired), sign-in (and back to this address, the
// hand-over kept), sync unavailable, the consent screen (the account, this browser's files, shared on by default, sync
// only on the press), a copy made, found, arriving or refused, and the tool told only after the server acknowledged it.
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
    handout: async () => [{ path: "hw1.ipynb", kind: "notebook", sha256: "a".repeat(64), bytes: new Uint8Array([1]) }],
    startCopy: async (a) => (log.push(["start", a.copyId, a.revision, a.title, a.files.length]), { state: "applied", folder: "/Assignments/Homework 1 (cccccc)", notebooks: [{ path: "/Assignments/Homework 1 (cccccc)/hw1.ipynb", ref: "r1" }] }),
    onCopyReady: (ref, cb) => (log.push(["wait", ref]), (d.fire = cb), () => log.push(["unwait", ref])),
    openNotebook: async (p) => log.push(["open", p]),
    settled: async () => true,
    started: async (x) => log.push(["started", x.copy]),
    setShared: (s) => log.push(["shared", s]),
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
// 4. the consent screen: the account, this browser's files, shared on by default; sync only on the press
{
  const { d, ui, log } = setup({ status: async () => ({ signedIn: true, account: "student@example.invalid", available: true, on: false }) });
  ok((await runAssignment(d)) === "consent", "sync off: the consent screen");
  ok(text(ui).includes(WORDS.consent("student@example.invalid")) && text(ui).includes(WORDS.local(3, "52.0 kB")) && text(ui).includes(WORDS.shared), "...it names the account, says this browser's 3 files (52.0 kB) go into it, and offers the shared-computer choice");
  const box = ui.find((n) => n.tag === "input");
  ok(box?.checked === true && !log.some((l) => l[0] === "enable"), "...shared is on by default, and nothing is turned on before the press");
  d.status = async () => ({ signedIn: true, account: "student@example.invalid", available: true, on: true });
  await btn(ui, "Turn on sync").onclick();
  await flush(); await flush();
  ok(log.some((l) => l[0] === "shared" && l[1] === true) && log.some((l) => l[0] === "enable") && log.some((l) => l[0] === "start"), "the press: the shared choice kept, sync turned on, then the copy started");
  const u = setup({ status: async () => ({ signedIn: true, account: "a@x", available: true, on: false }), enableSync: async () => ({ ok: false, why: "unavailable", message: "not in your plan." }) });
  await runAssignment(u.d);
  await btn(u.ui, "Turn on sync").onclick();
  ok(text(u.ui).includes(WORDS.unavailable("not in your plan.")), "turning sync on refused: the server's words");
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
  const { d, ui, storage, key } = setup({ startCopy: async () => ({ state, notebooks: [], reason: "storage full: 200 MB of 200 MB." }) });
  ok((await runAssignment(d)) === state && text(ui).includes(words) && !!btn(ui, "Try again") && has(storage, key), `${state}: said ("${words.slice(0, 50)}…"), with Try again, the hand-over kept`);
}
// 8. the handout's files not loadable any more: open the assignment again
{
  const { d, ui } = setup({ handout: async () => { throw new Error("410"); } });
  ok((await runAssignment(d)) === "expired" && text(ui).includes(WORDS.expired), "the handout's link no longer works: open the assignment again from your course");
}
console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
