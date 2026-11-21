// An agent's branch's history: a small git object store of its own, one per workspace, in this browser's
// IndexedDB, only in the pages that offer branches.  No .git folder anywhere in the workspace, no git library, and
// nothing here is ever pushed: it is the record of what an agent submitted, and of what the person accepted.
//
//   - Objects are git's own (blob, tree, commit, with their SHA-1 ids, as `git hash-object` gives them), so a later
//     push to GitHub (design/git-projects.md) maps them as they are.
//   - Its database is "sagebrush-branches:" + the SHA-256 of the workspace's actual database name (named and test
//     databases included), so two workspaces never share a store, and no two names can collide by sanitizing.
//   - A branch's ref is "agent/" + the first 40 hex of the SHA-256 of its root folder's fid: keyed by the fid, never
//     by the branch's name (a name is a display label, and a renamed root is no longer a branch, as git_branch has it).
//   - Objects are written first; a ref moves only by compare-and-swap, in one transaction (setRef's `expect`), so two
//     writers can't both advance one ref, and a half-made commit is unreferenced, never visible.
//   - What is committed is each document's canonical bytes (branch-canon.ts): the same bytes the base hashes are of.
//   - Lifetime bounds (not git_branch's creation-only ones): STORE_LIMITS.

import { sha256Hex as bytesHash } from "./sha256-hex";
import type { Canon } from "./branch-canon";

const MiB = 1024 * 1024;
/** Lifetime bounds of a workspace's branch history, and of what a review carries (astra's point 6). */
export const STORE_LIMITS = Object.freeze({
  /** commits on one branch, the first (its base) included */
  commits: 200,
  /** new blob bytes the store has taken, all branches, all time */
  historyBytes: 64 * MiB,
  /** characters */
  message: 10_000,
  note: 2_000,
  title: 200,
  reason: 2_000,
  /** git_wait calls waiting at once, per grant */
  waitsPerGrant: 4,
  /** git_wait's longest wait in one call, seconds */
  waitSeconds: 50,
});

/** The history bound in force: STORE_LIMITS.historyBytes, but for tests (a near-cap race needs a small one). */
export const HISTORY_CAP = { bytes: STORE_LIMITS.historyBytes };
/** A commit refused because the workspace's history would pass HISTORY_CAP (nothing of it was written). */
export class HistoryFull extends Error {}

/** Relative path (within the branch) -> canonical bytes. */
export type Files = Map<string, Uint8Array>;
/** A file's whole document as submitted (a notebook's or board's JSON, outputs included; a data file's bytes), with
 * its kind and mode: what accepting it writes, so nothing changed after the review is applied. */
export type Full = { bytes: Uint8Array; kind: string; mode?: string };
export type Who = { name: string; email?: string };
/** A commit as log() gives it (the shape isomorphic-git's log has). */
export type LogEntry = { oid: string; commit: { message: string; tree: string; parent: string[]; author: { name: string; email: string; timestamp: number; timezoneOffset: number } } };

const enc = new TextEncoder(), dec = new TextDecoder();
const hexOf = (s: string): Promise<string> => bytesHash(enc.encode(s));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));
const concat = (...xs: Uint8Array[]) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { out.set(x, i); i += x.length; } return out; };

type ObjType = "blob" | "tree" | "commit";
/** A git object's id and its stored form: SHA-1 of "<type> <length>\0" + body. */
export async function objectId(type: ObjType, body: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", concat(enc.encode(`${type} ${body.length}\0`), body))));
}

/** The store for the workspace whose database is named `dbName`. */
export async function openBranchStore(dbName: string): Promise<BranchStore> {
  return new BranchStore("sagebrush-branches:" + (await hexOf(dbName)));
}

/** The ref of the branch whose root folder's fid is `fid`. */
export async function refOf(fid: string): Promise<string> {
  return "agent/" + (await hexOf(fid)).slice(0, 40);
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error ?? new Error("aborted")); });

/** A folder's entries by name (a Map, never a plain object: a name like __proto__ is only a name), or a blob's oid. */
type Node = Map<string, Node | string>;

export class BranchStore {
  private db: Promise<IDBDatabase> | undefined;
  constructor(readonly name: string) {}

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((ok, no) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => { for (const s of ["objects", "refs", "meta"]) r.result.createObjectStore(s); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    }));
  }

  private async get<T>(store: string, key: string): Promise<T | undefined> {
    const tx = (await this.open()).transaction(store, "readonly");
    return (await req(tx.objectStore(store).get(key))) as T | undefined;
  }

  /** The new blob bytes `files` would add (the blobs the store doesn't hold yet). */
  async newBytes(files: Files): Promise<number> {
    let n = 0;
    const seen = new Set<string>();
    for (const b of files.values()) {
      const oid = await objectId("blob", b);
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (!(await this.hasObject(oid))) n += b.length;
    }
    return n;
  }

  /** The new blob bytes the store has taken so far (all branches, all time). */
  async usage(): Promise<number> {
    return (await this.get<number>("meta", "usage")) ?? 0;
  }

  /** Whether an object is held (by its key alone: its bytes aren't read). */
  private async hasObject(oid: string): Promise<boolean> {
    const tx = (await this.open()).transaction("objects", "readonly");
    return (await req(tx.objectStore("objects").getKey(oid))) !== undefined;
  }

  /** Whether `files` would fit the lifetime bound now: advisory, for an early refusal; writeCommit decides, in the
   * transaction that writes. */
  async fits(files: Files): Promise<boolean> {
    return ((await this.get<number>("meta", "usage")) ?? 0) + (await this.newBytes(files)) <= HISTORY_CAP.bytes;
  }

  /** A commit of `files` with `parent` (null: a branch's first), written as objects only, in one transaction: no ref
   * moves (setRef does, by compare-and-swap).  Its message ends with the canonical version, as a trailer. */
  async writeCommit(files: Files, parent: string | null, message: string, who: Who, canon: Canon, full?: Map<string, Full>): Promise<{ oid: string; tree: string }> {
    const objects: [string, ObjType, Uint8Array][] = [];
    const blob = async (b: Uint8Array) => { const oid = await objectId("blob", b); objects.push([oid, "blob", b]); return oid; };
    const root: Node = new Map();
    for (const [p, b] of files) {
      const parts = p.split("/");
      let n = root;
      for (const s of parts.slice(0, -1)) {
        let next = n.get(s);
        if (typeof next === "string") throw new Error(`a file and a folder of one name in the branch: /${p}`);
        if (!next) { next = new Map(); n.set(s, next); }
        n = next;
      }
      n.set(parts[parts.length - 1], await blob(b));
    }
    // (a tree: its entries in git's order, a folder's name compared as if it ended in "/")
    const tree = async (node: Node): Promise<string> => {
      const rows: { key: string; bytes: Uint8Array }[] = [];
      for (const [name, v] of node) {
        const isTree = typeof v !== "string";
        const oid = isTree ? await tree(v as Node) : (v as string);
        rows.push({ key: isTree ? name + "/" : name, bytes: concat(enc.encode(`${isTree ? "40000" : "100644"} ${name}\0`), unhex(oid)) });
      }
      rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const body = concat(...rows.map((r) => r.bytes));
      const oid = await objectId("tree", body);
      objects.push([oid, "tree", body]);
      return oid;
    };
    const treeOid = await tree(root);
    const now = Math.floor(Date.now() / 1000), tz = -new Date().getTimezoneOffset();
    const zone = (tz >= 0 ? "+" : "-") + String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0") + String(Math.abs(tz) % 60).padStart(2, "0");
    const person = `${who.name.replace(/[<>\n]/g, "")} <${(who.email ?? "").replace(/[<>\n]/g, "")}> ${now} ${zone}`;
    const text = `tree ${treeOid}\n${parent ? `parent ${parent}\n` : ""}author ${person}\ncommitter ${person}\n\n${message.trim()}\n\nSagebrush-Canon: ${canon}\n`;
    const body = enc.encode(text);
    const oid = await objectId("commit", body);
    objects.push([oid, "commit", body]);
    // (ids computed before the transaction opens: an await on anything but its own requests would end it)
    // (path and entry pairs, never an object keyed by path: a file named __proto__ is a name like any other)
    let fullIndex: [string, { oid: string; kind: string; mode?: string }][] | undefined;
    if (full) {
      fullIndex = [];
      for (const [p, f] of full) { const id = await blob(f.bytes); fullIndex.push([p, { oid: id, kind: f.kind, ...(f.mode ? { mode: f.mode } : {}) }]); }
    }
    const tx = (await this.open()).transaction(["objects", "meta"], "readwrite");
    const os = tx.objectStore("objects");
    let added = 0;
    for (const [id, type, bytes] of objects) {
      if (await req(os.getKey(id))) continue;
      os.put({ type, bytes }, id);
      if (type === "blob") added += bytes.length;
    }
    // (the bound decided here, in the transaction that writes: two branches committing at once can't both pass it;
    //  over it, the transaction is aborted and nothing of this commit is kept)
    // (each file's whole submitted document, beside the commit: its blob (written above), kind and mode, by path)
    if (fullIndex) tx.objectStore("meta").put(fullIndex, "full:" + oid);
    const meta = tx.objectStore("meta");
    const used = ((await req(meta.get("usage"))) as number | undefined) ?? 0;
    if (used + added > HISTORY_CAP.bytes) { tx.abort(); await done(tx).catch(() => {}); throw new HistoryFull("history full"); }
    meta.put(used + added, "usage");
    await done(tx);
    return { oid, tree: treeOid };
  }

  /** A file's whole document as submitted in the commit `oid` (null: not captured, or no such file). */
  async fullAt(oid: string, path: string): Promise<Full | null> {
    const index = await this.get<[string, { oid: string; kind: string; mode?: string }][]>("meta", "full:" + oid);
    const e = index?.find(([p]) => p === path)?.[1];
    if (!e) return null;
    return { bytes: (await this.object(e.oid)).bytes, kind: e.kind, ...(e.mode ? { mode: e.mode } : {}) };
  }

  /** A file's whole document's kind and mode as submitted in the commit `oid`, without reading its bytes (null: not
   * captured, or no such file). */
  async fullKind(oid: string, path: string): Promise<{ kind: string; mode?: string } | null> {
    const index = await this.get<[string, { oid: string; kind: string; mode?: string }][]>("meta", "full:" + oid);
    const e = index?.find(([p]) => p === path)?.[1];
    return e ? { kind: e.kind, ...(e.mode ? { mode: e.mode } : {}) } : null;
  }

  /** The ref's commit, or null. */
  async head(ref: string): Promise<string | null> {
    return (await this.get<string>("refs", ref)) ?? null;
  }

  /** The ref moved to `oid` only if it is `expect` now (null: absent), in one transaction; whether it moved. */
  async setRef(ref: string, oid: string, expect: string | null): Promise<boolean> {
    const tx = (await this.open()).transaction("refs", "readwrite"), st = tx.objectStore("refs");
    const cur = ((await req(st.get(ref))) as string | undefined) ?? null;
    if (cur !== expect) { tx.abort(); await done(tx).catch(() => {}); return false; }
    st.put(oid, ref);
    await done(tx);
    return true;
  }

  private async object(oid: string): Promise<{ type: ObjType; bytes: Uint8Array }> {
    const o = await this.get<{ type: ObjType; bytes: Uint8Array }>("objects", oid);
    if (!o) throw new Error(`the branch history has no object ${oid}`);
    return o;
  }

  private async commitOf(oid: string): Promise<LogEntry["commit"]> {
    const text = dec.decode((await this.object(oid)).bytes);
    const [head, ...rest] = text.split("\n\n");
    const lines = head.split("\n");
    const tree = lines.find((l) => l.startsWith("tree "))!.slice(5);
    const parent = lines.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
    const a = /^author (.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(lines.find((l) => l.startsWith("author ")) ?? "");
    const tz = a ? (a[4][0] === "-" ? -1 : 1) * (Number(a[4].slice(1, 3)) * 60 + Number(a[4].slice(3))) : 0;
    return { message: rest.join("\n\n"), tree, parent, author: { name: a?.[1] ?? "", email: a?.[2] ?? "", timestamp: Number(a?.[3] ?? 0), timezoneOffset: -tz } };
  }

  /** The tree oid of a commit. */
  async treeOf(oid: string): Promise<string> {
    return (await this.commitOf(oid)).tree;
  }

  /** The files of a commit (null: none). */
  async filesAt(oid: string | null): Promise<Files> {
    const out: Files = new Map();
    if (!oid) return out;
    const walk = async (tree: string, pre: string) => {
      const b = (await this.object(tree)).bytes;
      for (let i = 0; i < b.length; ) {
        const sp = b.indexOf(0x20, i), nul = b.indexOf(0, sp);
        const mode = dec.decode(b.subarray(i, sp)), name = dec.decode(b.subarray(sp + 1, nul)), id = hex(b.subarray(nul + 1, nul + 21));
        i = nul + 21;
        if (mode === "40000") await walk(id, pre + name + "/");
        else out.set(pre + name, (await this.object(id)).bytes);
      }
    };
    await walk(await this.treeOf(oid), "");
    return out;
  }

  /** A commit's files by their blob ids, from its trees alone: no blob is read (the review page's list, and its run
   * line, which compares ids).  With `max`: null as soon as the files pass `max.files` or their paths `max.pathBytes`
   * (UTF-16 units), so a branch grown past them since it was made is never listed whole. */
  async oidsAt(oid: string | null, max?: { files: number; pathBytes: number }): Promise<Map<string, string> | null> {
    const out = new Map<string, string>();
    if (!oid) return out;
    let bytes = 0;
    const walk = async (tree: string, pre: string): Promise<boolean> => {
      for (const [mode, name, id] of await this.entriesOf(tree)) {
        if (mode === "40000") { if (!(await walk(id, pre + name + "/"))) return false; continue; }
        out.set(pre + name, id);
        bytes += pre.length + name.length;
        if (max && (out.size > max.files || bytes > max.pathBytes)) return false;
      }
      return true;
    };
    return (await walk(await this.treeOf(oid), "")) ? out : null;
  }

  /** One file's canonical bytes in a commit (null: not there), reading only the trees on its path and that blob. */
  async blobAt(oid: string, path: string): Promise<Uint8Array | null> {
    let tree = await this.treeOf(oid);
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const e = (await this.entriesOf(tree)).find(([, name]) => name === parts[i]);
      if (!e) return null;
      const last = i === parts.length - 1;
      if ((e[0] === "40000") === last) return null;
      if (last) return (await this.object(e[2])).bytes;
      tree = e[2];
    }
    return null;
  }

  /** A tree's entries: mode, name and id. */
  private async entriesOf(tree: string): Promise<[string, string, string][]> {
    const b = (await this.object(tree)).bytes, out: [string, string, string][] = [];
    for (let i = 0; i < b.length; ) {
      const sp = b.indexOf(0x20, i), nul = b.indexOf(0, sp);
      out.push([dec.decode(b.subarray(i, sp)), dec.decode(b.subarray(sp + 1, nul)), hex(b.subarray(nul + 1, nul + 21))]);
      i = nul + 21;
    }
    return out;
  }

  /** The commits on `ref`, newest first, following first parents (at most `depth`). */
  async log(ref: string, depth = STORE_LIMITS.commits): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    let at = await this.head(ref);
    while (at && out.length < depth) {
      const commit = await this.commitOf(at);
      out.push({ oid: at, commit });
      at = commit.parent[0] ?? null;
    }
    return out;
  }
}

// ---- diffs between two file sets

export type Change = { path: string; kind: "added" | "deleted" | "changed" };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
/** What changed from `a` to `b`, in path order. */
export function diff(a: Files, b: Files): Change[] {
  const out: Change[] = [];
  for (const [p, x] of b) { const y = a.get(p); if (!y) out.push({ path: p, kind: "added" }); else if (!same(x, y)) out.push({ path: p, kind: "changed" }); }
  for (const p of a.keys()) if (!b.has(p)) out.push({ path: p, kind: "deleted" });
  return out.sort((u, v) => (u.path < v.path ? -1 : u.path > v.path ? 1 : 0));
}
