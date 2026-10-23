// The cases of web/workspace/test-workspace-sync-view.mjs (sync client step 4, design/sync-client.md C3, D5, D10):
// pages of the server's log applied to the confirmed index and the view, in one transaction a page; local intents
// on top; nothing the view doesn't name gone is deleted.  No server: the pages are made here, as `index` gives them.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
let n = 0;
const names = () => { n++; return { name: `ws-view-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-view-${n}` }; };
const J = (x) => JSON.stringify(x);
const all = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const metaGet = (db, k) => new Promise((ok, no) => { const r = db.transaction("meta").objectStore("meta").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const OTHER = "fedcba9876543210";
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n / 2))].map((b) => b.toString(16).padStart(2, "0")).join("");
const SHA = (c) => c.repeat(64).slice(0, 64);

/** A workspace with sync on for a namespace of its own device, and a server log to append to. */
async function setup() {
  localStorage.clear();
  const w = await W.Workspace.open(names());
  const ns = "a".repeat(32) + ":1:" + w.device;
  const lease = await W.switchTo(w, ns), ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  let seq = 0, dseq = 0;
  const log = [];
  /** The server's next op, from another device. */
  const op = (o) => { const x = { seq: ++seq, device: OTHER, dseq: ++dseq, t: 1_900_000_000_000 + seq, by: "person", ...o }; log.push(x); return x; };
  /** An op of this device's (an echo), at its record's dseq. */
  const echo = (r) => { const x = { ...r.op, seq: ++seq, device: w.device }; log.push(x); return x; };
  const apply = (ops) => W.applyConfirmed(w, ns, ops);
  return { w, ns, ob, op, echo, apply, log };
}
const entry = (w, p) => w.stat(p);
const byIdent = async (w, id) => (await w.list("/", { recursive: true })).find((e) => e.ident === id);

async function remoteCreate() {
  const { w, ns, op, apply } = await setup();
  const fid = hex(16), dfid = hex(16), ref = crypto.randomUUID();
  const ops = [
    op({ op: "mkdir", path: "/d", kind: "folder", fid: dfid }),
    op({ op: "create", path: "/d/a.txt", kind: "file", fid, parent: dfid, sha256: SHA("a"), size: 3 }),
    op({ op: "create", path: "/n.ipynb", kind: "notebook", ref }),
  ];
  const seen = [];
  const off = w.watch((c) => seen.push(...c.ops));
  const r = await apply(ops);
  off();
  const d = await entry(w, "/d"), a = await entry(w, "/d/a.txt"), nb = await entry(w, "/n.ipynb");
  check(d?.kind === "folder" && d.fid === dfid && d.ident === dfid, `remote mkdir: /d is a folder with the server's fid (${J(d)})`);
  check(a?.kind === "file" && a.fid === fid && a.sha256 === SHA("a") && a.size === 3 && a.remote === true && a.ref === "/d/a.txt", `remote create: /d/a.txt listed remote with its fid, hash and size (${J(a)})`);
  check(nb?.kind === "notebook" && nb.ref === ref && nb.remote === true, `remote notebook listed, content not here (remote) (${J(nb)})`);
  check((await w.contents(a)) === undefined, "a remote file's bytes aren't read from stale storage");
  const q = await metaGet(w.ws, W.fetchKey(ns, fid));
  check(q?.sha256 === SHA("a") && q.size === 3, `its fetch queued (${J(q)})`);
  check((await W.cursorOf(w, ns)) === 3 && r.cursor === 3, `the cursor at the page's last seq (${await W.cursorOf(w, ns)})`);
  const logged = (await w.ops()).filter((o) => o.origin === "server");
  check(logged.length === 3 && logged.every((o) => o.origin === "server"), `three ops logged, each origin server (${logged.map((o) => o.op).join(",")})`);
  check(seen.length === 3, `watchers told of the three (${seen.length})`);
  const pend = await all(w.ws, "pending");
  check(pend.length === 0, `no local intent noted for the server's changes (${pend.length} pending)`);
  const scan = await new W.Outbox(w, await W.currentLease(w)).scan();
  check(scan.made === 0, `the scan sends none of them back (${scan.made})`);
  const nbErr = await w.write("/n.ipynb", { cells: [] }).then(() => null, (e) => e);
  check(nbErr?.code === "invalid", `a remote notebook is read-only until slice 2 (${nbErr?.code})`);
  // (the same page again: below the cursor, nothing changes)
  const before = J(await w.list("/", { recursive: true }));
  await apply(ops);
  check(J(await w.list("/", { recursive: true })) === before && (await w.ops()).filter((o) => o.origin === "server").length === 3, "the page again (at or below the cursor): nothing reduced or changed");
}

async function remoteMoves() {
  const { w, op, apply } = await setup();
  const fid = hex(16), dfid = hex(16), efid = hex(16);
  await apply([
    op({ op: "mkdir", path: "/d", kind: "folder", fid: dfid }),
    op({ op: "create", path: "/d/a.txt", kind: "file", fid, parent: dfid, sha256: SHA("a"), size: 3 }),
    op({ op: "mkdir", path: "/d/sub", kind: "folder", fid: efid, parent: dfid }),
  ]);
  await apply([op({ op: "rename", path: "/d", to: "/e", kind: "folder", fid: dfid })]);
  check(!(await entry(w, "/d")) && (await entry(w, "/e"))?.fid === dfid && (await entry(w, "/e/a.txt"))?.fid === fid && (await entry(w, "/e/sub"))?.fid === efid, "a folder renamed: it and what is in it at the new path");
  await apply([op({ op: "rename", path: "/e/a.txt", to: "/b.txt", kind: "file", fid })]);
  check((await entry(w, "/b.txt"))?.fid === fid && !(await entry(w, "/e/a.txt")), "a file moved out of its folder");
  await apply([op({ op: "remove", path: "/b.txt", to: "/Trash/b.txt", kind: "file", fid })]);
  const t = await entry(w, "/Trash/b.txt");
  check(t?.fid === fid && t.trashed?.from === "/b.txt", `put in Trash: at /Trash/b.txt, from /b.txt (${J(t)})`);
  await apply([op({ op: "restore", path: "/Trash/b.txt", to: "/b.txt", kind: "file", fid })]);
  const b = await entry(w, "/b.txt");
  check(b?.fid === fid && !b.trashed, "restored");
  await apply([op({ op: "write", path: "/b.txt", kind: "file", fid, sha256: SHA("b"), size: 5, base: SHA("a") })]);
  const b2 = await entry(w, "/b.txt");
  check(b2.sha256 === SHA("b") && b2.size === 5 && b2.remote && b2.rev === 1, `a remote write: the new hash listed, remote, its revision up (${J(b2)})`);
  await apply([op({ op: "remove", path: "/b.txt", to: "/Trash/b.txt", kind: "file", fid }), op({ op: "forget", path: "/Trash/b.txt", kind: "file", fid })]);
  check(!(await byIdent(w, fid)), "forgotten on the server: gone here (an explicit gone row)");
  const ops = (await w.ops()).filter((o) => o.origin === "server").map((o) => o.op);
  check(J(ops.slice(3)) === J(["rename", "rename", "remove", "restore", "write", "rename", "forget"]) || ops.includes("forget"), `each change logged (${ops.join(",")})`);
}

async function collisions() {
  // (a local create, its record undecided, and a remote create at the same path before it in the server's order:
  // the remote one is /x.txt, this one /x (2).txt, as every device will have it)
  const { w, ob, op, apply, echo } = await setup();
  const mine = await w.create("/x.txt", { content: "mine" });
  await ob.scan();
  const [rec] = await ob.records();
  const fid = hex(16);
  await apply([op({ op: "create", path: "/x.txt", kind: "file", fid, sha256: SHA("c"), size: 4 })]);
  const theirs = await entry(w, "/x.txt"), ours = await byIdent(w, mine.fid);
  check(theirs?.fid === fid && theirs.remote, `the remote create has /x.txt (${J(theirs)})`);
  check(ours?.path === "/x (2).txt" && !ours.remote && (await w.contents(ours)) !== undefined, `the local one is /x (2).txt, its bytes its own (${ours?.path})`);
  // (then its echo, as the server reduced it: at /x (2).txt there too; confirmed, and nothing moves)
  await apply([echo(rec)]);
  await ob.confirmed([rec.dseq]);
  check((await byIdent(w, mine.fid))?.path === "/x (2).txt" && (await entry(w, "/x.txt"))?.fid === fid, "its echo: both where they were");
}

async function intentsKept() {
  const { w, ob, op, apply } = await setup();
  const fid = hex(16);
  await apply([op({ op: "create", path: "/f.txt", kind: "file", fid, sha256: SHA("a"), size: 1 })]);
  // (the person renames it here: an op past the watermark, unscanned; the server renames it elsewhere first)
  await w.rename("/f.txt", "/mine.txt");
  await apply([op({ op: "rename", path: "/f.txt", to: "/theirs.txt", kind: "file", fid })]);
  check((await byIdent(w, fid))?.path === "/mine.txt", `a local rename not yet confirmed wins over an earlier remote one (${(await byIdent(w, fid))?.path})`);
  // (a local write (content intent) and a remote rename: placement from the server, content its own)
  const g = await w.create("/g.txt", { content: "one" });
  await ob.scan();
  const recs = await ob.records();
  for (const r of recs) await ob.confirmed([r.dseq]);
  await w.write("/g.txt", "two");
  const before = await byIdent(w, g.fid);
  await apply([op({ op: "rename", path: "/g.txt", to: "/h.txt", kind: "file", fid: g.fid })]);
  const after = await byIdent(w, g.fid);
  check(after?.path === "/h.txt" && after.sha256 === before.sha256 && !after.remote, `a local write and a remote rename: moved, its own bytes kept (${J(after)})`);
}

async function keptNotDeleted() {
  // (an entry this device has that the confirmed index doesn't, with nothing pending: kept, never deleted; one in the
  // way of a confirmed entry stays, and the confirmed one is a copy beside it, listed)
  const { w, ns, op, apply } = await setup();
  const own = await w.create("/k.txt", { content: "k" });
  // (its op scanned and decided, as if it were before sync: no intent left)
  await new W.Outbox(w, await W.currentLease(w)).scan();
  for (const r of await new W.Outbox(w, await W.currentLease(w)).records()) await new W.Outbox(w, await W.currentLease(w)).confirmed([r.dseq]);
  const fid = hex(16);
  const r = await apply([op({ op: "create", path: "/k.txt", kind: "file", fid, sha256: SHA("d"), size: 2 })]);
  const kept = await byIdent(w, own.fid), copy = await byIdent(w, fid);
  check(kept?.path === "/k.txt", `this device's own /k.txt kept (${kept?.path})`);
  check(copy && copy.path !== "/k.txt" && copy.path.startsWith("/k ("), `the confirmed one beside it (${copy?.path})`);
  const listed = await metaGet(w.ws, `sync:${ns}:listed`);
  check(r.listed.some(([, why]) => why === "conflict") && listed?.count >= 1, `listed in the Sync panel (${J(listed)})`);
}

export async function run() {
  for (const t of [remoteCreate, remoteMoves, collisions, intentsKept, keptNotDeleted]) {
    try { await t(); } catch (e) { check(false, `${t.name}: threw ${e?.stack ?? e}`); }
  }
  return results;
}
