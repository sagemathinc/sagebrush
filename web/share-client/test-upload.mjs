// uploadCollection (web/share-client/upload.ts): the batch is sent before the next file is read
// whenever that file would take it over the limit, or its size isn't known, so at most
// max(batchBytes, the largest file) is held (#172 r2's review: daybreak3's LIMIT-SHAREB-1, astra3's
// observation).  A fake share API records the order of reads and requests, and the bytes held.
//   bun web/share-client/test-upload.mjs
import { uploadCollection } from "./upload.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
globalThis.location = { href: "https://sagebrush.test/" };
let events = [], live = new Set(), peak = 0;
const track = () => (peak = Math.max(peak, [...live].reduce((n, d) => n + d.length, 0)));
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body;
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (u.endsWith("/api/share/collections") && init.method === "POST") return json({ id: "c1" });
  if (u.endsWith("/api/share/check")) {
    const b = JSON.parse(body);
    events.push(`check ${b.blobs.length}`);
    return json({ missing: b.blobs.map((x) => x.sha256) });
  }
  if (u.includes("/api/share/blob/")) {
    events.push(`put ${body.length}`);
    return new Response("{}", { status: 200 });
  }
  if (u.includes("/versions")) return json({ version: "v", url: "/s/c1", frozen: "/s/c1@v" });
  throw new Error("unexpected " + u);
};
// lazy files that say when they're read, and stay "held" until the batch that holds them is sent
const lazy = (name, n, { listed = true } = {}) => ({
  path: name,
  size: listed ? n : undefined,
  read: async () => {
    const d = new Uint8Array(n).fill(name.charCodeAt(0));
    events.push(`read ${name}`);
    live.add(d);
    track();
    return d;
  },
});
// (a sent batch's bytes are dropped: a PUT forgets the bodies it sent)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const r = await realFetch(url, init);
  if (String(url).includes("/api/share/blob/")) for (const d of live) if (d === init.body || (d.length === init.body.length && d[0] === init.body[0])) live.delete(d);
  return r;
};
const run = async (files, limit) => {
  events = [];
  live = new Set();
  peak = 0;
  await uploadCollection({ id: null, title: "t", files }, () => {}, { batchBytes: limit });
  return { events, peak };
};

{
  const r = await run([lazy("a", 8), lazy("b", 8)], 10);
  ok(JSON.stringify(r.events) === JSON.stringify(["read a", "check 1", "put 8", "read b", "check 1", "put 8"]), `astra3's case, limit 10 and two 8-byte files: a is sent before b is read (${JSON.stringify(r.events)})`);
  ok(r.peak === 8, `...so at most 8 bytes are held, not 16 (peak ${r.peak})`);
}
{
  const r = await run([lazy("a", 63), lazy("b", 63)], 64);
  ok(r.peak === 63, `daybreak3's case, a 63-byte batch then a 63-byte file at a limit of 64: peak ${r.peak}, max(64, 63)`);
}
{
  const r = await run([lazy("a", 4), lazy("b", 4), lazy("c", 4)], 10);
  ok(JSON.stringify(r.events) === JSON.stringify(["read a", "read b", "check 2", "put 4", "put 4", "read c", "check 1", "put 4"]), `files that fit are still batched together (${JSON.stringify(r.events)})`);
  ok(r.peak <= 10, `...within the limit (peak ${r.peak})`);
}
{
  const r = await run([lazy("a", 6), lazy("b", 6, { listed: false })], 100);
  ok(JSON.stringify(r.events.slice(0, 3)) === JSON.stringify(["read a", "check 1", "put 6"]) && r.peak === 6, `a file of unknown size: the batch is sent before it is read (${JSON.stringify(r.events)}, peak ${r.peak})`);
}
{
  const r = await run([lazy("a", 30), lazy("b", 50)], 10);
  ok(r.peak === 50, `a file larger than the batch: held alone (peak ${r.peak} = the largest file)`);
}

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
