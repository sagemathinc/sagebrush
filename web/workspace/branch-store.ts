// An agent's branch's history (W3 PR A): one git repository per workspace, in this browser (isomorphic-git on
// lightning-fs, as web/gitpush keeps its own), only in the pages that offer branches.  No .git folder anywhere in the
// workspace, and nothing here is ever pushed: it is the record of what an agent submitted, and of what the person
// accepted.
//
//   - Its name is "sagebrush-branches:" + the SHA-256 of the workspace's actual database name (named and test
//     databases included), so two workspaces never share a store, and no two names can collide by sanitizing.
//   - A branch's ref is "agent/" + the first 40 hex of the SHA-256 of its root folder's fid: keyed by the fid, never
//     by the branch's name (a name is a display label, and a renamed root is no longer a branch: #957).
//   - Objects are written first; a ref moves only by compare-and-swap (setRef's `expect`), so two writers can't
//     both advance one ref, and a half-made commit is unreferenced, never visible.
//   - What is committed is each document's canonical bytes (branch-canon.ts): the same bytes the base hashes are of.
//   - Lifetime bounds (not #957's creation-only ones): STORE_LIMITS.

import "../gitpush/buffer-global";
import git from "isomorphic-git";
import FS from "@isomorphic-git/lightning-fs";
import { bytesHash } from "../notebook/stores.js";
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

/** Relative path (within the branch) -> canonical bytes. */
export type Files = Map<string, Uint8Array>;
export type Who = { name: string; email?: string };

const enc = new TextEncoder();
const hexOf = (s: string): Promise<string> => bytesHash(enc.encode(s));

/** The store for the workspace whose database is named `dbName`. */
export async function openBranchStore(dbName: string): Promise<BranchStore> {
  return new BranchStore("sagebrush-branches:" + (await hexOf(dbName)));
}

/** The ref of the branch whose root folder's fid is `fid`. */
export async function refOf(fid: string): Promise<string> {
  return "agent/" + (await hexOf(fid)).slice(0, 40);
}

type Node = { [name: string]: Node | string }; // a folder, or a blob's oid

export class BranchStore {
  private readonly fs: any;
  private readonly dir = "/repo";
  private ready: Promise<void> | undefined;
  constructor(readonly name: string) {
    this.fs = new FS(name);
  }

  private init(): Promise<void> {
    return (this.ready ??= (async () => {
      try { await this.fs.promises.stat(this.dir + "/.git"); }
      catch { await this.fs.promises.mkdir(this.dir).catch(() => {}); await git.init({ fs: this.fs, dir: this.dir, defaultBranch: "main" }); }
    })());
  }

  // ---- the lifetime count of new blob bytes (STORE_LIMITS.historyBytes)

  private async used(): Promise<number> {
    try { return Number(JSON.parse(new TextDecoder().decode(await this.fs.promises.readFile("/usage.json"))).bytes) || 0; } catch { return 0; }
  }
  private async addUsed(n: number) {
    if (n > 0) await this.fs.promises.writeFile("/usage.json", enc.encode(JSON.stringify({ bytes: (await this.used()) + n })));
  }
  private async has(oid: string): Promise<boolean> {
    try { await git.readObject({ fs: this.fs, dir: this.dir, oid, format: "deflated" }); return true; } catch { return false; }
  }

  /** A blob's oid as git computes it, without writing it. */
  private blobOid(bytes: Uint8Array): Promise<string> {
    return git.hashBlob({ object: bytes }).then((r: { oid: string }) => r.oid);
  }

  /** The new blob bytes `files` would add (the blobs the store doesn't hold yet). */
  async newBytes(files: Files): Promise<number> {
    await this.init();
    let n = 0;
    const seen = new Set<string>();
    for (const b of files.values()) {
      const oid = await this.blobOid(b);
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (!(await this.has(oid))) n += b.length;
    }
    return n;
  }

  /** Whether `files` fit the lifetime bound (refused before anything is written). */
  async fits(files: Files): Promise<boolean> {
    return (await this.used()) + (await this.newBytes(files)) <= STORE_LIMITS.historyBytes;
  }

  private async writeTree(node: Node): Promise<string> {
    const entries = [];
    for (const [path, v] of Object.entries(node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (typeof v === "string") entries.push({ mode: "100644", path, oid: v, type: "blob" as const });
      else entries.push({ mode: "040000", path, oid: await this.writeTree(v), type: "tree" as const });
    }
    return git.writeTree({ fs: this.fs, dir: this.dir, tree: entries });
  }

  /** A commit of `files` with `parent` (null: a branch's first), written as objects only: no ref moves (setRef does,
   * by compare-and-swap).  Its message ends with the canonical version, as a trailer. */
  async writeCommit(files: Files, parent: string | null, message: string, who: Who, canon: Canon): Promise<{ oid: string; tree: string }> {
    await this.init();
    let added = 0;
    const root: Node = {};
    for (const [p, b] of files) {
      const parts = p.split("/");
      let n = root;
      for (const s of parts.slice(0, -1)) n = (n[s] ??= {}) as Node;
      const before = await this.blobOid(b);
      if (!(await this.has(before))) added += b.length;
      n[parts[parts.length - 1]] = await git.writeBlob({ fs: this.fs, dir: this.dir, blob: b });
    }
    const tree = await this.writeTree(root);
    const now = Math.floor(Date.now() / 1000), tz = new Date().getTimezoneOffset();
    const author = { name: who.name, email: who.email ?? "", timestamp: now, timezoneOffset: tz };
    const body = message.trim() + "\n\nSagebrush-Canon: " + canon + "\n";
    const oid = await git.writeCommit({ fs: this.fs, dir: this.dir, commit: { message: body, tree, parent: parent ? [parent] : [], author, committer: author } });
    await this.addUsed(added);
    return { oid, tree };
  }

  /** The ref's commit, or null. */
  async head(ref: string): Promise<string | null> {
    await this.init();
    try { return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "refs/heads/" + ref }); } catch { return null; }
  }

  /** The ref moved to `oid` only if it is `expect` now (null: absent); whether it moved. */
  async setRef(ref: string, oid: string, expect: string | null): Promise<boolean> {
    if ((await this.head(ref)) !== expect) return false;
    await git.writeRef({ fs: this.fs, dir: this.dir, ref: "refs/heads/" + ref, value: oid, force: true });
    return (await this.head(ref)) === oid;
  }

  /** The tree oid of a commit. */
  async treeOf(oid: string): Promise<string> {
    await this.init();
    return (await git.readCommit({ fs: this.fs, dir: this.dir, oid })).commit.tree;
  }

  /** The files of a commit (null: none). */
  async filesAt(oid: string | null): Promise<Files> {
    const out: Files = new Map();
    if (!oid) return out;
    await this.init();
    const walk = async (tree: string, pre: string) => {
      const t = await git.readTree({ fs: this.fs, dir: this.dir, oid: tree });
      for (const e of t.tree) {
        if (e.type === "tree") await walk(e.oid, pre + e.path + "/");
        else out.set(pre + e.path, (await git.readBlob({ fs: this.fs, dir: this.dir, oid: e.oid })).blob);
      }
    };
    await walk(await this.treeOf(oid), "");
    return out;
  }

  /** The commits on `ref`, newest first (at most `depth`). */
  async log(ref: string, depth = STORE_LIMITS.commits) {
    await this.init();
    try { return await git.log({ fs: this.fs, dir: this.dir, ref: "refs/heads/" + ref, depth }); } catch { return []; }
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
