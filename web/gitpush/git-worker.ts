// "Push project to GitHub" (Stage A MVP r1 §1): the git side, in its own worker (sagebrush-gitpush-worker.js).
//   - The person's token lives ONLY here, in this browser's IndexedDB ("sagebrush-gitpush"/tokens): the panel hands it
//     over once (setToken) and never gets it back (status says only whether there is one). It goes to GitHub only,
//     through the push proxy (web/gitpush/worker.mjs), in the Authorization of each git request.
//   - The pushed folder's local repository is isomorphic-git's, in lightning-fs (IndexedDB), one per workspace,
//     repository and branch. The panel sends the folder's files (collect.ts); this writes only those that differ,
//     removes what's gone, commits, and pushes to sagebrush/<name>: never main, never forced.
//   - Errors are fixed words (rules.ts pushWords): nothing from GitHub's answer is shown.
import "./buffer-global";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import FS from "@isomorphic-git/lightning-fs";
import { BRANCH, PUSH_BATCH, parseRepo, pushWords } from "./rules";

const DB = "sagebrush-gitpush";
let dbp: Promise<IDBDatabase> | undefined;
const db = () => (dbp ??= new Promise((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore("tokens"); r.result.createObjectStore("state"); };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
}));
async function idb<T>(store: "tokens" | "state", mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode), r = f(t.objectStore(store));
    t.oncomplete = () => resolve(r.result as T);
    t.onerror = () => reject(t.error);
  });
}
const tokenKey = (scope: string, repo: string) => `${scope}\n${repo}`;
const getToken = (scope: string, repo: string) => idb<string | undefined>("tokens", "readonly", (s) => s.get(tokenKey(scope, repo)));

type Last = { at: number; commit: string; branch: string; parts: number };
type State = { repo: string; folder: string; sigs: Record<string, string>; last?: Last };
const getState = (scope: string) => idb<State | undefined>("state", "readonly", (s) => s.get(scope));
const putState = (scope: string, st: State) => idb("state", "readwrite", (s) => s.put(st, scope));

/** One push, from begin to end: the worker's only one (M2-SEC-1). Its id goes with every put, keep, end and abort; a
 * request with any other id is refused, and a second begin is refused while it runs, never put in its place. */
type Run = {
  id: string;
  scope: string; repo: string; url: string; branch: string; folder: string; proxy: string; token: string;
  fs: any; dir: string; cache: object; author: { name: string; email: string };
  tracked: Set<string>; seen: Set<string>; sigs: Record<string, string>;
  changed: number; removed: number; pending: number; parts: number; head?: string;
  /** added or removed since the last commit */
  dirty: boolean;
};
let run: Run | undefined;

async function mkdirp(fs: any, p: string) {
  const parts = p.split("/").filter(Boolean);
  let at = "";
  for (const seg of parts) {
    at += "/" + seg;
    try { await fs.promises.mkdir(at); } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
  }
}
// (the token on every request, from the first: the proxy refuses one without it, so git's ask-then-answer would only
// cost a request)
const authOf = (r: Run) => ({ headers: { authorization: "Basic " + btoa("x-access-token:" + r.token) }, onAuth: () => ({ username: "x-access-token", password: r.token }) });
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function commitAndPush(r: Run, message: string): Promise<void> {
  r.head = await git.commit({ fs: r.fs, dir: r.dir, cache: r.cache, message, author: { ...r.author, timestamp: Math.floor(Date.now() / 1000) } });
  r.parts++;
  r.pending = 0;
  r.dirty = false;
  let res;
  try {
    res = await git.push({ fs: r.fs, http, dir: r.dir, cache: r.cache, url: r.url, corsProxy: r.proxy, ref: r.branch, remoteRef: r.branch, force: false, ...authOf(r) });
  } catch (e: any) {
    throw new Error(pushWords(e, r.branch, `${r.repo}`));
  }
  if (!res?.ok || res.refs?.[`refs/heads/${r.branch}`]?.ok === false) throw new Error(pushWords({ code: "PushRejectedError" }, r.branch, r.repo));
}

/** The run a request names, or a refusal (never touching the run under way). */
function owned(id: unknown): Run {
  if (!run || id !== run.id) throw new Error("That push is no longer under way.");
  return run;
}
let beginning = false;

async function beginNow({ scope, repo, folder, branch, proxy, author }: { scope: string; repo: string; folder: string; branch: string; proxy: string; author: { name: string; email: string } }) {
  const p = parseRepo(repo);
  if (!p) throw new Error("That isn't a GitHub repository address (https://github.com/owner/repo).");
  if (!BRANCH.test(branch)) throw new Error(`Pushes go only to a sagebrush/… branch, not ${branch}.`);
  if (!/^https:\/\/|^http:\/\/127\.0\.0\.1:\d+$/.test(proxy)) throw new Error("No push proxy is set for this site.");
  const token = await getToken(scope, repo);
  if (!token) throw new Error("Save a token for this repository first.");
  const fs = new FS(`sagebrush-gitpush:${scope}`);
  const dir = `/${p.owner}/${p.repo}/${branch}`;
  await mkdirp(fs, dir);
  let tracked: string[] = [];
  try { await fs.promises.stat(dir + "/.git"); } catch { await git.init({ fs, dir, defaultBranch: branch }); }
  const cache = {};
  try { tracked = await git.listFiles({ fs, dir, cache }); } catch { tracked = []; }
  const st = await getState(scope);
  // (a signature counts only for a path this repository holds: a lost or new local repository reads everything)
  const sigs: Record<string, string> = {};
  if (st && st.repo === repo && st.folder === folder) for (const t of tracked) if (st.sigs[t]) sigs[t] = st.sigs[t];
  const id = crypto.randomUUID();
  run = { id, scope, repo, url: p.url, branch, folder, proxy, token, fs, dir, cache, author, tracked: new Set(tracked), seen: new Set(), sigs: { ...sigs }, changed: 0, removed: 0, pending: 0, parts: 0, dirty: false };
  return { sigs, run: id };
}

const ops: Record<string, (a: any) => Promise<unknown>> = {
  async status({ scope, repo }: { scope: string; repo?: string }) {
    const st = await getState(scope);
    const r = repo ?? st?.repo;
    return { repo: st?.repo, folder: st?.folder, last: st?.last, hasToken: r ? !!(await getToken(scope, r)) : false };
  },
  async setToken({ scope, repo, token }: { scope: string; repo: string; token: string }) {
    if (!parseRepo(repo) || typeof token !== "string" || !/^[\x21-\x7e]{20,255}$/.test(token)) throw new Error("That doesn't look like a GitHub token.");
    await idb("tokens", "readwrite", (s) => s.put(token, tokenKey(scope, repo)));
    return true;
  },
  async forgetToken({ scope, repo }: { scope: string; repo: string }) {
    await idb("tokens", "readwrite", (s) => s.delete(tokenKey(scope, repo)));
    return true;
  },
  async begin({ scope, repo, folder, branch, proxy, author }: { scope: string; repo: string; folder: string; branch: string; proxy: string; author: { name: string; email: string } }) {
    if (run || beginning) throw new Error("Another push is under way here. Try again when it finishes.");
    beginning = true;
    try { return await beginNow({ scope, repo, folder, branch, proxy, author }); } finally { beginning = false; }
  },
  /** Files that may have changed: written when they differ, and in a batch's commit once PUSH_BATCH bytes are waiting. */
  async put({ run: id, files }: { run: string; files: { path: string; bytes: Uint8Array; sig?: string }[] }) {
    const r = owned(id);
    const add: string[] = [];
    for (const f of files) {
      r.seen.add(f.path);
      const full = `${r.dir}/${f.path}`;
      let old: Uint8Array | undefined;
      try { old = await r.fs.promises.readFile(full); } catch {}
      if (f.sig) r.sigs[f.path] = f.sig; else delete r.sigs[f.path];
      if (old && same(old, f.bytes) && r.tracked.has(f.path)) continue;
      await mkdirp(r.fs, full.slice(0, full.lastIndexOf("/")));
      await r.fs.promises.writeFile(full, f.bytes);
      add.push(f.path);
      r.pending += f.bytes.length;
    }
    if (add.length) { await git.add({ fs: r.fs, dir: r.dir, cache: r.cache, filepath: add }); r.changed += add.length; for (const a of add) r.tracked.add(a); r.dirty = true; }
    if (r.pending >= PUSH_BATCH) await commitAndPush(r, `Sagebrush: push, part ${r.parts + 1}`);
    return { parts: r.parts };
  },
  /** Paths kept as they were pushed (unchanged, or not on this device now, or too large now). */
  async keep({ run: id, paths }: { run: string; paths: string[] }) {
    const r = owned(id);
    for (const p of paths) r.seen.add(p);
    return true;
  },
  /** Everything not sent or kept is removed; a commit if anything changed, and the push. */
  async end({ run: id }: { run: string }) {
    const r = owned(id);
    for (const p of r.tracked) {
      if (r.seen.has(p)) continue;
      await git.remove({ fs: r.fs, dir: r.dir, cache: r.cache, filepath: p });
      try { await r.fs.promises.unlink(`${r.dir}/${p}`); } catch {}
      delete r.sigs[p];
      r.removed++;
      r.dirty = true;
    }
    if (r.dirty) await commitAndPush(r, `Sagebrush: ${r.changed} changed, ${r.removed} removed`);
    else if (!r.parts) {
      // (nothing changed here: still push, in case the last push failed after its commit)
      let head: string | undefined;
      try { head = await git.resolveRef({ fs: r.fs, dir: r.dir, ref: r.branch }); } catch {}
      if (!head) { run = undefined; return { nothing: true }; }
      r.head = head;
      try {
        const res = await git.push({ fs: r.fs, http, dir: r.dir, cache: r.cache, url: r.url, corsProxy: r.proxy, ref: r.branch, remoteRef: r.branch, force: false, ...authOf(r) });
        if (!res?.ok) throw { code: "PushRejectedError" };
      } catch (e: any) { throw new Error(pushWords(e, r.branch, r.repo)); }
    }
    const last: Last = { at: Date.now(), commit: r.head!, branch: r.branch, parts: r.parts };
    await putState(r.scope, { repo: r.repo, folder: r.folder, sigs: r.sigs, last });
    run = undefined;
    return { ...last, changed: r.changed, removed: r.removed };
  },
  /** The run let go, after a failure on the page's side (a read that threw): only that run. */
  async abort({ run: id }: { run: string }) {
    if (run && run.id === id) run = undefined;
    return true;
  },
  /** (M4's History list, and the tests) the branch's commits here, newest first. */
  async log({ scope, repo, branch, depth = 50 }: { scope: string; repo: string; branch: string; depth?: number }) {
    const p = parseRepo(repo);
    if (!p || !BRANCH.test(branch)) return [];
    const fs = new FS(`sagebrush-gitpush:${scope}`);
    try {
      return (await git.log({ fs, dir: `/${p.owner}/${p.repo}/${branch}`, ref: branch, depth })).map((c) => ({ oid: c.oid, message: c.commit.message, at: c.commit.author.timestamp * 1000 }));
    } catch { return []; }
  },
  /** (M4a's History) the files of one of the branch's commits, in path order: at most 5,000. */
  async files({ scope, repo, branch, oid }: { scope: string; repo: string; branch: string; oid: string }) {
    const at = historyAt(scope, repo, branch, oid);
    const all = await git.listFiles({ fs: at.fs, dir: at.dir, ref: oid });
    return { files: all.slice(0, 5000), more: Math.max(0, all.length - 5000) };
  },
  /** (M4a's History) one file as that commit holds it: its first VIEW_MAX bytes and its size. Only a path the commit
   * lists is read (git objects, never the working files). */
  async read({ scope, repo, branch, oid, path }: { scope: string; repo: string; branch: string; oid: string; path: string }) {
    const at = historyAt(scope, repo, branch, oid);
    if (typeof path !== "string" || !(await git.listFiles({ fs: at.fs, dir: at.dir, ref: oid })).includes(path)) throw new Error("That file isn't in this version.");
    const { blob } = await git.readBlob({ fs: at.fs, dir: at.dir, oid, filepath: path });
    return { size: blob.length, bytes: blob.slice(0, VIEW_MAX), truncated: blob.length > VIEW_MAX };
  },
};

/** At most this much of a file is shown or downloaded from the History list. */
const VIEW_MAX = 50 * 2 ** 20;
/** The local repository a History request names, with its commit id checked. */
function historyAt(scope: string, repo: string, branch: string, oid: string) {
  const p = parseRepo(repo);
  if (!p || !BRANCH.test(branch) || typeof oid !== "string" || !/^[0-9a-f]{40}$/.test(oid)) throw new Error("That version can't be shown.");
  return { fs: new FS(`sagebrush-gitpush:${scope}`), dir: `/${p.owner}/${p.repo}/${branch}` };
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, op, args } = ev.data ?? {};
  try {
    const f = ops[op];
    if (!f) throw new Error("unknown request");
    (self as any).postMessage({ id, ok: true, value: await f(args ?? {}) });
  } catch (e: any) {
    // (only our own words: an Error made here; anything else, the general one)
    const message = e instanceof Error && !(e as any).code ? e.message : "The push failed.";
    // (a failed put or end lets its own run go; any other request, a refused begin included, leaves it as it is)
    if ((op === "put" || op === "end") && run && args?.run === run.id) run = undefined;
    (self as any).postMessage({ id, ok: false, error: message });
  }
};
