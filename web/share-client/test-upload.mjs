// uploadCollection (web/share-client/upload.ts): the batch is sent before the next file is read
// whenever that file would take it over the limit, or its size isn't known, so at most
// max(batchBytes, the largest file) is held (#172 r2's review: daybreak3's LIMIT-SHAREB-1, astra3's
// observation).  A fake share API records the order of reads and requests, and the bytes held.
//   bun web/share-client/test-upload.mjs
import { uploadCollection, AttemptError } from "./upload.ts";

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
let events = [], live = new Set(), peak = 0, answer = null, failing = null, oldServer = false;
const track = () => (peak = Math.max(peak, [...live].reduce((n, d) => n + d.length, 0)));
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body;
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  // (a new share: one request, with its files and attempt, makes it; a title alone, an older page's empty collection)
  if ((u.endsWith("/api/share/first-upload") || u.endsWith("/api/share/collections")) && init.method === "POST") {
    const b = JSON.parse(body);
    if (oldServer && u.endsWith("/api/share/first-upload")) return new Response('{"error":"not found"}', { status: 404 });
    events.push(u.endsWith("/api/share/first-upload") ? `new ${b.files.length} ${b.attempt}` : "create");
    if (answer) return answer(b);
    return json({ collection: "c1", version: "v", url: "/s/c1", frozen: "/s/c1@v" });
  }
  if (u.endsWith("/api/share/check")) {
    if (failing === "check") return new Response("{}", { status: 503 });
    const b = JSON.parse(body);
    events.push(`check ${b.blobs.length}`);
    return json({ missing: b.blobs.map((x) => x.sha256) });
  }
  if (u.includes("/api/share/blob/")) {
    if (failing === "put") return new Response("{}", { status: 503 });
    events.push(`put ${body.length}`);
    return new Response("{}", { status: 200 });
  }
  if (u.includes("/versions")) {
    events.push("version");
    return json({ version: "v", url: "/s/c1", frozen: "/s/c1@v" });
  }
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
const ATT = "0123456789abcdef0123456789abcdef";
const run = async (files, limit) => {
  events = [];
  live = new Set();
  peak = 0;
  await uploadCollection({ id: null, attempt: ATT, title: "t", files }, () => {}, { batchBytes: limit });
  return { events: events.filter((e) => !e.startsWith("new ")), peak };
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

// ---- a new share is made by the upload's last request, never before (plan-upload-leak r3 §3c)
{
  events = [];
  const r = await uploadCollection({ id: null, attempt: ATT, title: "t", files: [lazy("a", 4), lazy("b", 4)] });
  const made = events.filter((e) => e.startsWith("new ") || e === "create");
  ok(made.length === 1 && made[0] === `new 2 ${ATT}` && events.at(-1) === made[0] && !events.includes("version") && r.id === "c1" && r.version === "v", `U1 a new share: the only request to /api/share/collections is the last, with the files and the attempt (${JSON.stringify(events)})`);
}
{
  const outcomes = [];
  for (const why of ["read", "put", "check"]) {
    events = [];
    failing = why === "read" ? null : why;
    const files = [lazy("a", 4), why === "read" ? { path: "gone", size: 4, read: async () => { throw new Error("gone changed"); } } : lazy("b", 4)];
    const e = await uploadCollection({ id: null, attempt: ATT, title: "t", files }).then(() => null, (x) => x);
    outcomes.push(`${why}:${!!e && !events.some((x) => x.startsWith("new ") || x === "create")}`);
  }
  failing = null;
  ok(outcomes.every((o) => o.endsWith(":true")), `U2 a file that can't be read, a blob PUT or a check that fails: the upload fails, and nothing is sent to /api/share/collections (${outcomes.join(", ")})`);
}
{
  events = [];
  await uploadCollection({ id: "c9", title: "t", files: [lazy("a", 4)] });
  ok(events.at(-1) === "version" && !events.some((x) => x.startsWith("new ") || x === "create"), `U3 a new version of a share: as before, only .../versions (${JSON.stringify(events)})`);
  const e = await uploadCollection({ id: null, title: "t", files: [lazy("a", 4)] }).then(() => null, (x) => x);
  ok(e instanceof Error && /attempt/.test(e.message), "U3 ...and a new share without its attempt is refused before anything is sent");
}
{
  const json = (v, status) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  answer = () => json({ error: "attempt_used", collection: "c7", version: "v7", url: "/s/c7", frozen: "/s/c7@v7" }, 409);
  const used = await uploadCollection({ id: null, attempt: ATT, title: "t", files: [lazy("a", 4)] }).then(() => null, (x) => x);
  answer = () => json({ error: "attempt_retired" }, 410);
  const gone = await uploadCollection({ id: null, attempt: ATT, title: "t", files: [lazy("a", 4)] }).then(() => null, (x) => x);
  answer = null;
  ok(used instanceof AttemptError && used.kind === "used" && used.share?.id === "c7" && used.share.url === "https://sagebrush.test/s/c7" && gone instanceof AttemptError && gone.kind === "retired", "U4 409 attempt_used and 410 attempt_retired: typed errors (the earlier share named), never a result");
}
{
  // U5 (daybreak3's S2): this page against a server from before this change (a Worker rolled back), which has
  // no first-upload route (404) and whose /api/share/collections would make an empty collection: the upload
  // fails, and nothing is ever sent to that older path
  events = [];
  oldServer = true;
  const e = await uploadCollection({ id: null, attempt: ATT, title: "t", files: [lazy("a", 4)] }).then(() => null, (x) => x);
  oldServer = false;
  ok(e instanceof Error && /not found/.test(e.message) && !events.includes("create"), `U5 against a rolled-back server: the upload fails (${e?.message}), and no empty collection is asked for (${JSON.stringify(events)})`);
}
{
  // U6 (astra3's L1): beforeCommit runs before the first-upload request, and its refusal sends nothing
  events = [];
  let called = 0;
  const e = await uploadCollection({ id: null, attempt: ATT, title: "t", files: [lazy("a", 4)] }, () => {}, { beforeCommit: () => { called++; throw new Error("the notebook's share changed"); } }).then(() => null, (x) => x);
  ok(called === 1 && e?.message === "the notebook's share changed" && !events.some((x) => x.startsWith("new ")), `U6 beforeCommit refuses: no first-upload request (${JSON.stringify(events)})`);
}

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
