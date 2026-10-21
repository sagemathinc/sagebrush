// The frame's side of pictures by reference (web/board/edit-pictures.ts; web/board-host-protocol.md, "Pictures:
// imagePut and imageGet"), against a scripted host.  Run with Bun:
//   bun web/board/test-edit-pictures.mjs
// - imagePut: the bytes transferred with their type and name; resolved by imageSaved for that name only, or by a
//   refusal with its reason; a name the host has already, at once; at most 4 unanswered and 8 MiB of their bytes;
//   a picture past 2,000,000 bytes or of another type never sent;
// - imageGet: at most 32 names a message and 2 in flight; `more` asked again once; bytes kept only under the name
//   they hash to; names the host doesn't have reported missing; an answer that never comes given up on.
import { PictureChannel, PICTURE_BOUNDS } from "./edit-pictures.ts";

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
  return {
    m,
    async blob(n) { return m.get(n); },
    async put(blob) { const n = await hashName(await blob.arrayBuffer()); m.set(n, blob); return n; },
  };
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

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the frame's pictures by reference, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
