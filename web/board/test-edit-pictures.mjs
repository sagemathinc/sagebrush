// The frame's side of pictures by reference (web/board/edit-pictures.ts; web/board-host-protocol.md, "Pictures:
// imagePut and imageGet"), against a scripted host.  Run with Bun:
//   bun web/board/test-edit-pictures.mjs
// - imagePut: the bytes transferred with their type and name; resolved by imageSaved for that name only, or by a
//   refusal with its reason; a name the host has already, at once; at most 4 unanswered and 8 MiB of their bytes;
//   a picture past 2,000,000 bytes or of another type never sent;
// - imageGet: at most 32 names a message and 2 in flight; `more` asked again once; bytes kept only under the name
//   they hash to; names the host doesn't have reported missing; an answer that never comes given up on.
import { PictureChannel, PICTURE_BOUNDS, byReference } from "./edit-pictures.ts";
import { EditChannel } from "./edit-channel.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashName = async (bytes) => "i" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join("");
const png = (seed, size = 64) => { const b = new Uint8Array(size); b.set([0x89, 0x50, 0x4e, 0x47]); for (let i = 4; i < size; i++) b[i] = (seed * 31 + i) & 255; return b; };

// The browser's pictures, as images.ts keeps them: by the name their bytes hash to.
function store() {
  const m = new Map();
  let gate = null, held = 0;
  const st = {
    m, puts: 0,
    get held() { return held; },
    hold() { let r; gate = new Promise((x) => (r = x)); return () => { gate = null; r(); }; },
    async blob(n) { return m.get(n); },
    async put(blob) { st.puts++; if (gate) { held++; await gate; held--; } const n = await hashName(await blob.arrayBuffer()); m.set(n, blob); return n; },
  };
  return st;
}
const harness = () => {
  const st = store(), sent = [];
  const ch = new PictureChannel((msg, transfer) => sent.push({ msg, transfer }), st);
  return { st, sent, ch };
};

// 1. imagePut: sent with its bytes transferred; resolved by imageSaved for its name
{
  const h = harness();
  const name = await h.st.put(new Blob([png(1)], { type: "image/png" }));
  const p = h.ch.put(name);
  await sleep(10);
  const m = h.sent[0]?.msg;
  check(m?.sagebrush === "imagePut" && m.name === name && m.type === "image/png" && m.bytes instanceof ArrayBuffer && h.sent[0].transfer?.[0] === m.bytes, "imagePut: name, type, the bytes transferred: " + J({ s: m?.sagebrush, n: m?.name === name, t: m?.type }));
  // (an imageSaved for another name: not this put's answer)
  h.ch.receive({ sagebrush: "imageSaved", version: 1, id: m.id, name: "i" + "0".repeat(32) });
  let settled = false;
  p.then(() => (settled = true));
  await sleep(10);
  check(!settled, "an imageSaved naming another picture: not taken as its answer");
  h.ch.receive({ sagebrush: "imageSaved", version: 1, id: m.id, name });
  check(J(await p) === J({ ok: true }) && h.ch.hostHas.has(name), "imageSaved: resolved, the host has it");
  check(J(await h.ch.put(name)) === J({ ok: true }) && h.sent.length === 1, "put again: at once, nothing sent");
}

// 2. a refusal, with its reason; a picture never sent: too large, another type, a name not of the form
{
  const h = harness();
  const name = await h.st.put(new Blob([png(2)], { type: "image/png" }));
  const p = h.ch.put(name);
  await sleep(10);
  h.ch.receive({ sagebrush: "refused", version: 1, id: h.sent[0].msg.id, message: "Your picture quota is spent.", reason: "quota" });
  const r = await p;
  check(!r.ok && r.reason === "quota" && /quota/.test(r.message) && !h.ch.hostHas.has(name), "refused: its reason and words: " + J(r));
  const big = await h.st.put(new Blob([png(3, PICTURE_BOUNDS.pictureBytes + 1)], { type: "image/png" }));
  const svg = await h.st.put(new Blob([png(4)], { type: "image/svg+xml" }));
  const rb = await h.ch.put(big), rs = await h.ch.put(svg), rn = await h.ch.put("not-a-name");
  check(!rb.ok && rb.reason === "too-large" && !rs.ok && !rn.ok && h.sent.length === 1, "past 2,000,000 bytes, another type, a bad name: never sent: " + J({ rb, rs, rn }));
}

// 3. at most 4 imagePuts unanswered, and 8 MiB of their bytes
{
  const h = harness();
  const names = [];
  for (let i = 0; i < 6; i++) names.push(await h.st.put(new Blob([png(10 + i)], { type: "image/png" })));
  const ps = names.map((n) => h.ch.put(n));
  await sleep(20);
  check(h.sent.length === 4, "4 unanswered at most: the fifth waits: " + h.sent.length);
  h.ch.receive({ sagebrush: "imageSaved", version: 1, id: h.sent[0].msg.id, name: h.sent[0].msg.name });
  await sleep(20);
  check(h.sent.length === 5, "one answered: the next sent");
  for (const s of h.sent.slice(1)) h.ch.receive({ sagebrush: "imageSaved", version: 1, id: s.msg.id, name: s.msg.name });
  await sleep(20);
  for (const s of h.sent.slice(5)) h.ch.receive({ sagebrush: "imageSaved", version: 1, id: s.msg.id, name: s.msg.name });
  check((await Promise.all(ps)).every((r) => r.ok) && h.sent.length === 6, "all six saved, each once");
  // (bytes: five pictures of 1.9 MB: at most four at once, 7.6 MB, under 8 MiB; the fifth waits)
  const h2 = harness();
  const bigs = [];
  for (let i = 0; i < 5; i++) bigs.push(await h2.st.put(new Blob([png(30 + i, 1_900_000)], { type: "image/png" })));
  bigs.forEach((n) => h2.ch.put(n));
  await sleep(50);
  const inFlight = h2.sent.reduce((t, s) => t + s.msg.bytes.byteLength, 0);
  check(h2.sent.length === 4 && inFlight <= PICTURE_BOUNDS.putBytes, "bytes in flight within 8 MiB: " + J({ n: h2.sent.length, inFlight }));
}

// 4. imageGet: 32 names a message, 2 in flight, more asked again once, bytes kept only under their own name
{
  const h = harness();
  const host = new Map();
  for (let i = 0; i < 70; i++) { const b = png(100 + i); host.set(await hashName(b), b); }
  const names = [...host.keys()];
  const missingName = "i" + "f".repeat(32);
  const done = h.ch.fetch([...names, missingName]);
  await sleep(20);
  const gets = () => h.sent.filter((s) => s.msg.sagebrush === "imageGet");
  check(gets().length === 2 && gets().every((g) => g.msg.names.length <= 32), "imageGet: 32 names a message, 2 in flight: " + J(gets().map((g) => g.msg.names.length)));
  let answered = 0;
  const wrong = png(999);
  while (answered < gets().length) {
    const g = gets()[answered++];
    const imgs = [], more = [];
    g.msg.names.forEach((n, k) => {
      if (!host.has(n)) return;
      // (the first message: half of them left for later: `more`; one given bytes that aren't its own)
      if (answered === 1 && k % 2) more.push(n);
      else imgs.push({ name: n, type: "image/png", bytes: (answered === 1 && k === 0 ? wrong : host.get(n)).buffer.slice(0) });
    });
    h.ch.receive({ sagebrush: "images", version: 1, id: g.msg.id, images: imgs, missing: g.msg.names.filter((n) => !host.has(n)), more });
    await sleep(20);
  }
  const missing = await done;
  const firstName = gets()[0].msg.names[0];
  check(missing.includes(missingName) && missing.includes(firstName) && !h.st.m.has(firstName) && missing.length === 2, "the host's missing name reported; bytes that aren't the name's never kept under it: " + J({ missing: missing.length }));
  check(names.filter((n) => n !== firstName).every((n) => h.st.m.has(n)), "every other picture kept, those left for `more` asked again");
}

// 6. two fetches at once (the board's pictures, and a remote change's): still 2 imageGets in flight in all
{
  const h = harness();
  const a = [], b = [];
  for (let i = 0; i < 40; i++) a.push(await hashName(png(700 + i)));
  for (let i = 0; i < 40; i++) b.push(await hashName(png(800 + i)));
  const d1 = h.ch.fetch(a), d2 = h.ch.fetch(b);
  await sleep(30);
  const gets = () => h.sent.filter((s) => s.msg.sagebrush === "imageGet");
  check(gets().length === 2, "two fetches at once: 2 imageGets in flight in all: " + gets().length);
  for (let k = 0; k < 10 && gets().length; k++) {
    for (const g of gets().slice(k ? 0 : 0)) if (!g.answered) { g.answered = true; h.ch.receive({ sagebrush: "images", version: 1, id: g.msg.id, images: [], missing: g.msg.names, more: [] }); }
    await sleep(20);
  }
  const [m1, m2] = await Promise.all([d1, d2]);
  check(m1.length === 40 && m2.length === 40, "both finish, the names reported missing");
}

// 5. a host that keeps saying more: asked again once, then given up on
{
  const h = harness();
  const b = png(500), n = await hashName(b);
  const done = h.ch.fetch([n]);
  for (let k = 0; k < 3; k++) {
    await sleep(20);
    const g = h.sent.filter((s) => s.msg.sagebrush === "imageGet").at(-1);
    if (g) h.ch.receive({ sagebrush: "images", version: 1, id: g.msg.id, images: [], missing: [], more: [n] });
  }
  const missing = await done;
  check(J(missing) === J([n]) && h.sent.filter((s) => s.msg.sagebrush === "imageGet").length === 2, "more, again and again: asked twice, then missing: " + J(missing));
}

// 7. LIMIT-BPR-1: an images answer admitted whole or not at all, before anything of it is hashed or kept
{
  const answer = async (h, f) => { await sleep(10); const g = h.sent.filter((x) => x.msg.sagebrush === "imageGet").at(-1); h.ch.receive({ sagebrush: "images", version: 1, id: g.msg.id, ...f(g.msg.names) }); };
  const names = async (k, size = 64) => { const out = []; for (let i = 0; i < k; i++) { const b = png(2000 + i * 7 + size, size); out.push([await hashName(b), b]); } return out; };
  // (more entries than names asked)
  {
    const h = harness(), ns = await names(32);
    const done = h.ch.fetch(ns.map(([n]) => n));
    await answer(h, (asked) => ({ images: [...ns, ns[0]].map(([n, b]) => ({ name: n, type: "image/png", bytes: b.buffer.slice(0) })), missing: [], more: [] }));
    const missing = await done;
    check(missing.length === 32 && h.st.puts === 0, "33 pictures for 32 names: refused whole, nothing hashed or kept: " + J({ missing: missing.length, puts: h.st.puts }));
  }
  // (one name twice)
  {
    const h = harness(), ns = await names(2);
    const done = h.ch.fetch(ns.map(([n]) => n));
    await answer(h, () => ({ images: [ns[0], ns[0]].map(([n, b]) => ({ name: n, type: "image/png", bytes: b.buffer.slice(0) })), missing: [], more: [] }));
    check((await done).length === 2 && h.st.puts === 0, "one name twice: refused whole");
  }
  // (each picture within its bound, together past 8 MiB)
  {
    const h = harness(), ns = await names(5, 1_900_000);
    const done = h.ch.fetch(ns.map(([n]) => n));
    await answer(h, () => ({ images: ns.map(([n, b]) => ({ name: n, type: "image/png", bytes: b.buffer.slice(0) })), missing: [], more: [] }));
    check((await done).length === 5 && h.st.puts === 0, "five pictures of 1.9 MB in one answer (9.5 MB): refused whole");
  }
  // (a huge more)
  {
    const h = harness(), ns = await names(1);
    const done = h.ch.fetch(ns.map(([n]) => n));
    const t0 = performance.now();
    await answer(h, () => ({ images: [], missing: [], more: new Array(1_000_000).fill(ns[0][0]) }));
    const missing = await done;
    check(missing.length === 1 && performance.now() - t0 < 200, "a more of a million names: refused at once: " + Math.round(performance.now() - t0) + " ms");
  }
  // (store.put held while the host answers every get at once: still 2 answers held, never more)
  {
    const h = harness(), ns = await names(128);
    const release = h.st.hold();
    // (two fetches at once, as a board's and a remote change's are: their answers still held 2 at most, in all)
    const d1 = h.ch.fetch(ns.slice(0, 64).map(([n]) => n)), d2 = h.ch.fetch(ns.slice(64).map(([n]) => n));
    const done = Promise.all([d1, d2]).then(([a, b]) => [...a, ...b]);
    const byName = new Map(ns);
    let answered = new Set();
    for (let k = 0; k < 30; k++) {
      await sleep(10);
      for (const g of h.sent.filter((x) => x.msg.sagebrush === "imageGet")) {
        if (answered.has(g.msg.id)) continue;
        answered.add(g.msg.id);
        h.ch.receive({ sagebrush: "images", version: 1, id: g.msg.id, images: g.msg.names.map((n) => ({ name: n, type: "image/png", bytes: byName.get(n).buffer.slice(0) })), missing: [], more: [] });
      }
    }
    // (and a fetch begun now, while those answers are still being kept, waits for their places too)
    const late = await names(8, 77);
    for (const [n, b] of late) byName.set(n, b);
    const d3 = h.ch.fetch(late.map(([n]) => n));
    await sleep(30);
    const gets = h.sent.filter((x) => x.msg.sagebrush === "imageGet").length;
    check(gets === 2, "store.put held, three fetches, the host answering at once: 2 gets sent in all, no more (their places kept while their answers are kept): " + gets);
    release();
    for (let k = 0; k < 50 && answered.size < 5; k++) {
      await sleep(10);
      for (const g of h.sent.filter((x) => x.msg.sagebrush === "imageGet")) {
        if (answered.has(g.msg.id)) continue;
        answered.add(g.msg.id);
        h.ch.receive({ sagebrush: "images", version: 1, id: g.msg.id, images: g.msg.names.map((n) => ({ name: n, type: "image/png", bytes: byName.get(n).buffer.slice(0) })), missing: [], more: [] });
      }
    }
    for (let k = 0; k < 50; k++) {
      await sleep(10);
      for (const g of h.sent.filter((x) => x.msg.sagebrush === "imageGet")) {
        if (answered.has(g.msg.id)) continue;
        answered.add(g.msg.id);
        h.ch.receive({ sagebrush: "images", version: 1, id: g.msg.id, images: g.msg.names.map((n) => ({ name: n, type: "image/png", bytes: byName.get(n).buffer.slice(0) })), missing: [], more: [] });
      }
    }
    const missing = [...(await done), ...(await d3)];
    check(missing.length === 0 && ns.every(([n]) => h.st.m.has(n)), "released: all 136 kept: " + missing.length);
  }
}

// 8. CORR-PICREF-3: through PictureChannel, byReference and EditChannel: busy and no answer tried again, the action
// kept, never dropped; quota and too-large take it out; busy every time: kept for download, its text and all
{
  const board0 = J({ format: "sagebrush-board", version: 1, nodes: [{ id: "a", text: "a0" }] });
  const setup = async (answerPut, seed, retry = { retries: 2, maxWaitMs: 50 }) => {
    const st = store(), sent = [], shown = [], said = [];
    let kept = [];
    const pc = new PictureChannel((msg) => { sent.push(msg); queueMicrotask(() => answerPut(msg, pc)); }, st);
    const ch = new EditChannel(board0, "r0", (m) => sent.push(m), { show: (d, note) => { shown.push(d); if (note) said.push(note); }, allowed: () => {}, kept: (c) => (kept = [...c]), say: (x) => said.push(x) }, undefined, { pictures: retry ? byReference(pc, retry) : byReference(pc) });
    const name = await st.put(new Blob([png(seed)], { type: "image/png" }));
    ch.save({ format: "sagebrush-board", version: 1, images: { [name]: { w: 1, h: 1 } }, nodes: [{ id: "a", text: "a with a picture", image: name }] });
    return { st, sent, shown, said, ch, name, kept: () => kept };
  };
  const settle = async (h) => { for (let k = 0; k < 60; k++) { await sleep(10); h.ch.flush(); if (h.sent.some((m) => m.sagebrush === "edit") || h.kept().length || !h.ch.pending) break; } };
  // (busy once, then saved)
  let tries = 0;
  let h = await setup((m, pc) => { if (m.sagebrush !== "imagePut") return; pc.receive(++tries === 1 ? { sagebrush: "refused", version: 1, id: m.id, message: "busy", reason: "busy", retryAfter: 5 } : { sagebrush: "imageSaved", version: 1, id: m.id, name: m.name }); }, 1);
  await settle(h);
  check(tries === 2 && h.sent.some((m) => m.sagebrush === "edit" && J(m.changes).includes("a with a picture")), "busy once: tried again, saved, the edit sent with its text: " + J({ tries }));
  // (no answer once, then saved)
  const was = PICTURE_BOUNDS.answerMs;
  PICTURE_BOUNDS.answerMs = 20;
  tries = 0;
  h = await setup((m, pc) => { if (m.sagebrush !== "imagePut") return; if (++tries > 1) pc.receive({ sagebrush: "imageSaved", version: 1, id: m.id, name: m.name }); }, 2);
  await settle(h);
  PICTURE_BOUNDS.answerMs = was;
  check(tries === 2 && h.sent.some((m) => m.sagebrush === "edit"), "no answer once: tried again, saved, the edit sent: " + J({ tries }));
  // (busy every time: kept for download, its text in it)
  h = await setup((m, pc) => { if (m.sagebrush === "imagePut") pc.receive({ sagebrush: "refused", version: 1, id: m.id, message: "busy", reason: "busy", retryAfter: 5 }); }, 3);
  await settle(h);
  const k = h.kept();
  const dl = k.length ? JSON.parse(await h.ch.download(k[0].id).blob.text()) : null;
  check(k.length === 1 && h.ch.pending === 0 && !h.sent.some((m) => m.sagebrush === "edit") && J(dl?.transactions).includes("a with a picture"), "busy every time: never sent, kept for download with its text: " + J({ copies: k.length }));
  // (#38: `retries` is how many times it is tried again after the first attempt: busy every time, the puts counted)
  for (const [retry, attempts] of [[{ retries: 0, maxWaitMs: 50 }, 1], [{ retries: 2, maxWaitMs: 50 }, 3], [null, 5]]) {
    let puts = 0;
    h = await setup((m, pc) => { if (m.sagebrush === "imagePut") { puts++; pc.receive({ sagebrush: "refused", version: 1, id: m.id, message: "busy", reason: "busy", retryAfter: 5 }); } }, 10 + attempts, retry);
    await settle(h);
    check(puts === attempts && h.kept().length === 1, `retries ${retry ? retry.retries : "4 (the default)"}: ${attempts} attempts in all, then kept: ` + J({ puts }));
  }
  // (quota, too-large: that action taken out, said)
  for (const reason of ["quota", "too-large"]) {
    h = await setup((m, pc) => { if (m.sagebrush === "imagePut") pc.receive({ sagebrush: "refused", version: 1, id: m.id, message: reason + " refusal", reason }); }, reason === "quota" ? 4 : 5);
    await settle(h);
    check(h.ch.pending === 0 && !h.kept().length && h.said.some((x) => x.includes(reason + " refusal")), `refused (${reason}): the action taken out, said`);
  }
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the frame's pictures by reference, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
