// The desktop app's file permissions across launches (#1565): the record web/notebook/permissions.js keeps in
// localStorage ("sagebrush-grants", {v: 1, seq, docs: {doc id: {write, read, net, denied, t}}}) is forgotten at quit
// (the app's web view keeps nothing between launches), and a workspace notebook's id is new at every launch (the
// workspace is made again from disk, disk-mirror.ts importDisk). So the app keeps it in grants.json beside
// settings.json (disk.rs grants_read/grants_write), each document named by where it is: "ws:" and a workspace
// notebook's path, or a notebook file's own id ("file:" and its path, the same at every launch).
//   restoreGrants(ws, invoke): at launch, once the workspace is the disk's copy: the kept record back, each
//     "ws:<path>" named by the notebook at that path now (a path that isn't a notebook now: left out, its permission
//     gone, so a prompt comes back; never more than was kept); what this page already holds for a document wins,
//     unless another window of this launch merged the record here before: then three ways, as adopt (the record's seenFile).
//   grantsToKeep(ws): the record as grants.json keeps it (a notebook no longer in the workspace: left out).
//   keepGrants(ws, invoke, onChange): grants.json written whenever the record changes, one write at a time.
//   grantsSync(ws, invoke): the app's windows (#1541) each keep the whole record and write all of it, so each page's
//     reads and writes of grants.json go through one queue, and each is merged with what the page last saw of it:
//     - restore() at launch, adopt() when another window wrote it: grants.json's record merged into this page's, by
//       document: what this page changed since it last saw grants.json kept, every other document as grants.json has
//       it (so a permission another window took back is gone here too), one both changed scope by scope;
//     - every write is made only over the grants.json this page last saw (disk.rs grants_write's `expect`, checked by
//       the app under a lock): one that finds another window's write there merges it (as adopt) and writes again.
//     No ordering is read from the record itself (its seq is a page's own); the app's check is the order.

import { validGrantEntry, GRANT_CAPS } from "../notebook/permissions.js";

export const GRANTS_KEY = "sagebrush-grants";
// The record's base, in the record itself (so it is kept with the record in one write; permissions.js keeps fields it
// doesn't know): `seenFile`, grants.json's text as the record was last merged with or written to it, by whichever
// window of the app did so, the base of every merge, so a window opening, or past its first merge, merges three ways
// over the record it reads and a grant another window took back isn't read as this page's own; and `pending`, each
// window's write of grants.json begun whose end isn't kept yet (its text and when, by the window's own name): until it
// lands, or is older than MARK_MS, either text may be grants.json's last, and a merge holds to what both allow. A window
// removes only its own mark, and moves the base on only if no merge moved it since it marked; every write carries a
// nonce (`w`), so grants.json the same text means the same write. (One copy of grants.json's text, and one a write in
// flight: the record in localStorage is about twice the size of the permissions it holds, both within GRANT_CAPS's
// bounds.)
type Mark = { text: string; at: number };
type Rec = { v: 1; seq?: number; migrated?: number; w?: string; docs: Record<string, unknown>; seenFile?: string; pending?: Record<string, Mark> };
/** How long another window's write may be in flight: past it, its mark is no longer waited for (a write is one local
 * call to the app). */
export const MARK_MS = 120_000;
/** At most this many windows' writes in flight (a mark each): a write that finds this many live marks of others isn't
 * made (tried again later), so marks are never dropped for room, only once landed, settled or past MARK_MS. */
export const MARKS_MAX = 32;
const WRITER = /^[0-9a-f]{16}$/;
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
export interface GrantsWorkspace {
  stat(p: string): Promise<{ kind: string; ref: string | null } | undefined>;
  pathOf(kind: "notebook", ref: string): Promise<string | undefined>;
}
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Store = Pick<Storage, "getItem" | "setItem">;

/** The page's record, or null if `text` isn't one. */
export function parseGrants(text: unknown): Rec | null {
  if (typeof text !== "string" || !text) return null;
  try {
    const r = JSON.parse(text);
    if (!(r && typeof r === "object" && r.v === 1 && r.docs && typeof r.docs === "object" && !Array.isArray(r.docs))) return null;
    // (each document's entry as the page writes one (validGrantEntry), or left out: it grants nothing)
    for (const [d, e] of Object.entries(r.docs)) if (!validGrantEntry(e)) delete r.docs[d];
    // (the record's own fields: a base that isn't a text, or a mark that isn't one, is left out)
    if (r.seenFile !== undefined && typeof r.seenFile !== "string") delete r.seenFile;
    delete r.pendingFile;
    if (r.pending !== undefined) {
      const ok = r.pending && typeof r.pending === "object" && !Array.isArray(r.pending) ? Object.entries(r.pending).filter(([w, m]: [string, any]) => WRITER.test(w) && m && typeof m.text === "string" && Number.isSafeInteger(m.at)) : [];
      // (every one kept, never cut to a number: a mark dropped unmerged would lose its write's evidence)
      if (ok.length) r.pending = Object.fromEntries(ok.map(([w, m]: [string, any]) => [w, { text: m.text, at: m.at }]));
      else delete r.pending;
    }
    return r;
  } catch {
    return null;
  }
}

/** grants.json's record back into localStorage at launch (what this page already holds for a document wins, unless
 * another window merged it before: then three ways); how
 * many documents changed here.  (grantsSync's restore, for a page that writes nothing back.) */
export async function restoreGrants(ws: GrantsWorkspace, invoke: Invoke, storage: Store = localStorage): Promise<number> {
  return grantsSync(ws, invoke, storage).restore();
}

/** The id of the document grants.json names `k`, here: the notebook at a "ws:" path now (none if there is none), or a
 * notebook file's own "file:" id. */
async function idOf(ws: GrantsWorkspace, k: string): Promise<string | null> {
  if (k.startsWith("ws:")) {
    const s = await ws.stat(k.slice(3)).catch(() => undefined);
    return s?.kind === "notebook" && s.ref ? s.ref : null;
  }
  return k.startsWith("file:") ? k : null;
}
const J = (x: unknown) => JSON.stringify(x);
/** By document (grants.json's keys): what `local` changed since `base` (an entry made, changed or taken out) kept;
 * every other document as `file` has it; a document both changed, scope by scope (mergeEntry), when `known` (`base`
 * is a grants.json this record was merged with; not known, the first window of a launch: `local`'s entry wins). */
export function mergeGrants(base: Record<string, unknown>, file: Record<string, unknown>, local: Record<string, unknown>, known = true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(file), ...Object.keys(local)])) {
    const mine = J(local[k]) !== J(base[k]), theirs = J(file[k]) !== J(base[k]);
    const e = mine && theirs && known && J(local[k]) !== J(file[k]) ? mergeEntry(base[k], file[k], local[k]) : mine ? local[k] : file[k];
    if (e !== undefined) out[k] = e;
  }
  return out;
}
/** Two merges of one record, each over a base that may be grants.json's last: by document, only what both allow (a
 * scope both grant, every denial of either, the later of two), so not knowing which base it was never widens. */
function narrower(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    const x = a[k] as Entry, y = b[k] as Entry, e: Entry = {};
    for (const kind of ["write", "read", "net"] as const) if (x[kind] || y[kind]) e[kind] = (x[kind] ?? []).filter((s) => (y[kind] ?? []).includes(s));
    if (x.denied || y.denied) {
      const later = new Map<string, [string, string, number]>();
      for (const d of [...(x.denied ?? []), ...(y.denied ?? [])]) { const key = d[0] + "\u0000" + d[1]; if (!later.has(key) || later.get(key)![2] < d[2]) later.set(key, d); }
      e.denied = [...later.values()].sort((p, q) => p[2] - q[2]).slice(-GRANT_CAPS.storedDenials);
    }
    const t = Math.max(Number(x.t) || 0, Number(y.t) || 0);
    if (t) e.t = t;
    out[k] = e;
  }
  return out;
}
type Entry = { write?: string[]; read?: string[]; net?: string[]; denied?: [string, string, number][]; t?: number };
/** One document changed both here and in grants.json since `base`: each scope, and each denial, three ways: one that
 * was in `base` stays only if neither took it out; one that wasn't comes in from either (so a grant taken back by
 * either is gone, a grant or a denial made by either is in), unless one side newly denied every file change ("/").
 * Within GRANT_CAPS, so the entry stays whole. */
function mergeEntry(base: unknown, file: unknown, local: unknown): Entry | undefined {
  const b = (base ?? {}) as Entry, f = (file ?? {}) as Entry, l = (local ?? {}) as Entry;
  const three = <T>(bs: T[], fs: T[], ls: T[], key: (x: T) => string) => {
    const inB = new Set(bs.map(key)), inF = new Set(fs.map(key)), inL = new Set(ls.map(key)), out = new Map<string, T>();
    for (const x of [...fs, ...ls]) { const k = key(x); if (out.has(k)) continue; if (inB.has(k) ? inF.has(k) && inL.has(k) : true) out.set(k, x); }
    return [...out.values()];
  };
  const e: Entry = {};
  for (const kind of ["write", "read", "net"] as const) {
    if (!(kind in f) && !(kind in l)) continue;
    e[kind] = three(b[kind] ?? [], f[kind] ?? [], l[kind] ?? [], String).slice(0, GRANT_CAPS.perKind);
  }
  // ("Don't allow file changes" made on one side (a denial of "/" that `base` hadn't): only the write grants that side
  // holds stay, so a folder the other side allowed meanwhile goes too; no order is read from either side's counters)
  const deniedAll = (x: Entry) => (x.denied ?? []).some((d) => d[0] === "write" && d[1] === "/");
  for (const side of [f, l]) if (deniedAll(side) && !deniedAll(b) && e.write) e.write = e.write.filter((s) => (side.write ?? []).includes(s));
  if (f.denied || l.denied) {
    // (a denial both have: the later of the two)
    const later = new Map<string, [string, string, number]>();
    for (const x of [...(f.denied ?? []), ...(l.denied ?? [])]) { const k = x[0] + "\u0000" + x[1]; if (!later.has(k) || later.get(k)![2] < x[2]) later.set(k, x); }
    const kept = three(b.denied ?? [], f.denied ?? [], l.denied ?? [], (x) => x[0] + "\u0000" + x[1]).map((x) => later.get(x[0] + "\u0000" + x[1])!);
    e.denied = kept.sort((x, y) => x[2] - y[2]).slice(-GRANT_CAPS.storedDenials);
  }
  const t = Math.max(Number(f.t) || 0, Number(l.t) || 0);
  if (t) e.t = t;
  return e;
}
/** The app's error for a write over a grants.json another window changed (disk.rs GRANTS_CHANGED). */
const CHANGED = "grants.json was changed by another window";

/** One page's grants.json: its reads, merges and writes one at a time (see the top of this file). */
export function grantsSync(ws: GrantsWorkspace, invoke: Invoke, storage: Store = localStorage, opts: { now?: () => number } = {}) {
  // (this page's own name for its marks, and the clock their age is told by: a test's own)
  const me = hex(8), now = opts.now ?? (() => Date.now());
  // (grants.json as this page last read or wrote it: its text, which a write must find there, and its documents, the
  // merge's base)
  let seen = "", base: Record<string, unknown> = {};
  let tail: Promise<unknown> = Promise.resolve();
  const one = <T>(f: () => Promise<T>): Promise<T> => { const p = tail.then(f, f); tail = p.catch(() => {}); return p; };
  const read = async () => { const t = await invoke("grants_read"); return typeof t === "string" ? t : ""; };
  // (the record's base fields changed, the rest of it as it is; at once, so no change of the record is lost)
  const mark = (f: (r: Rec) => Rec) => { const r = parseGrants(storage.getItem(GRANTS_KEY)) ?? { v: 1, seq: 0, docs: {} }; storage.setItem(GRANTS_KEY, J(f(r))); };
  /** grants.json's `text` merged into this page's record; how many documents changed here, and whether this page has
   * changes grants.json hasn't (a write must follow).  A change of the record here while it merges (the person's
   * Allow, which writes localStorage) makes it merge again, so none is lost. */
  const take = async (text: string): Promise<{ changed: number; ahead: boolean }> => {
    const kept = parseGrants(text), file = kept?.docs ?? {};
    for (let tries = 0; ; tries++) {
      const raw = storage.getItem(GRANTS_KEY), cur = parseGrants(raw) ?? { v: 1, seq: 0, docs: {} };
      // (this page's record by grants.json's keys, and what it holds that grants.json can't name: kept as it is)
      const local: Record<string, unknown> = {}, docs: Record<string, unknown> = {};
      for (const [id, e] of Object.entries(cur.docs)) {
        if (id.startsWith("file:")) { local[id] = e; continue; }
        const p = await ws.pathOf("notebook", id).catch(() => undefined);
        if (p) local["ws:" + p] = e;
        else docs[id] = e;
      }
      // (the base: grants.json as the shared record was last merged with or written to, by any window (seenFile), so a
      // window never merges over an older base than the record it reads; none kept: this page's own)
      // (grants.json as the marked write left it: it landed; as before it: it didn't; neither, another window's write
      // since: not known, so both)
      // (each window's write marked: one whose text grants.json is landed, and is the base; this page's own, not in flight
      // here, is settled now, merged over too unless grants.json is still the base, which every write's own nonce makes
      // mean nothing was written since; another window's, maybe still in flight, merged over and kept, until it lands or
      // is older than MARK_MS)
      const marks = Object.entries(cur.pending ?? {}), landed = marks.find(([, m]) => m.text === text);
      const keepMarks: Record<string, Mark> = {}, over: string[] = [];
      for (const [w, m] of marks) {
        if (m === landed?.[1]) continue;
        if (w === me) { if (text !== cur.seenFile) over.push(m.text); continue; }
        over.push(m.text);
        if (now() - m.at <= MARK_MS) keepMarks[w] = m;
      }
      const shared = parseGrants(landed ? landed[1].text : cur.seenFile), known = !!shared || over.length > 0 || seen !== "";
      let merged = mergeGrants(shared ? shared.docs : base, file, local, known);
      for (const t of over) { const p = parseGrants(t); if (p) merged = narrower(merged, mergeGrants(p.docs, file, local, known)); }
      for (const [k, e] of Object.entries(merged)) { const id = await idOf(ws, k); if (id) docs[id] = e; }
      if (storage.getItem(GRANTS_KEY) !== raw) { if (tries < 20) continue; throw new Error("grants: the record kept changing here while it was merged"); }
      const ids = new Set([...Object.keys(cur.docs), ...Object.keys(docs)]);
      const changed = [...ids].filter((id) => J(cur.docs[id]) !== J(docs[id])).length;
      // (seq: permissions.js's own counter, kept no lower than grants.json's; never read as an order here)
      // (the merge and what it was merged over, in one write: neither is ever kept without the other)
      // (nothing here and nothing to keep, grants.json no record either: no record made)
      const sameMarks = J(keepMarks) === J(cur.pending ?? {});
      if (changed || !sameMarks || (cur.seenFile !== text && (raw !== null || kept))) {
        const { pending: _, ...rest } = cur;
        storage.setItem(GRANTS_KEY, J({ ...rest, seq: Math.max(Number(cur.seq) || 0, Number(kept?.seq) || 0), docs, ...(kept?.migrated === 1 || cur.migrated === 1 ? { migrated: 1 } : {}), seenFile: text, ...(Object.keys(keepMarks).length ? { pending: keepMarks } : {}) }));
      }
      // (only once the merge is kept here: a merge that couldn't be stored (localStorage full) leaves grants.json unseen,
      // so the next try merges it again rather than taking it for done)
      seen = text;
      base = file;
      return { changed, ahead: J(merged) !== J(file) };
    }
  };
  const sync = {
    /** At launch: grants.json merged in, over what the record here was last merged with (its seenFile; none, the
     * first window of a launch: what this page already holds wins); how many changed. */
    restore: () => one(async () => { try { return (await take(await read())).changed; } catch (e) { console.warn("grants.json:", e); return 0; } }),
    /** Another window wrote grants.json: merged in; how many documents changed here (and `ahead`: this page has
     * changes of its own to write).  A grants.json that isn't a record reads as none, as at launch (nothing stays
     * allowed but what this page changed since).  One that can't be read, or merged, is `failed`: this page can't
     * know what is allowed now (reconcileGrants then sets its grants aside). */
    adopt: () => one(async (): Promise<{ changed: number; ahead: boolean; failed?: unknown }> => {
      try {
        const text = await read();
        // (the same text as last seen is nothing new, unless a write's end wasn't kept: then merged, so the mark is settled)
        if (text === seen && parseGrants(storage.getItem(GRANTS_KEY))?.pending === undefined) return { changed: 0, ahead: false };
        return await take(text);
      } catch (e) { console.warn("grants.json:", e); return { changed: 0, ahead: false, failed: e }; }
    }),
    /** This page's record written, over the grants.json it last saw; another window's write found there merged in,
     * then written again. */
    write: () => one(async () => {
      for (let tries = 0; tries < 10; tries++) {
        // (an earlier write's end not kept (its mark still there): merged first, over both texts, as the next merge
        // would, so a new mark never takes the place of one not yet reconciled)
        if (parseGrants(storage.getItem(GRANTS_KEY))?.pending !== undefined) await take(await read());
        // (each write's text its own: a nonce, so grants.json the same text means the same write)
        const rec = await grantsToKeep(ws, storage), json = J({ ...rec, w: hex(8) });
        // (the write marked in the record before it is made (none made if that can't be kept), its end after: one that
        // can't be kept leaves the mark, and the next merge holds to what both texts allow)
        let was: string | undefined;
        mark((r) => {
          // (too many other windows writing at once: this write isn't made, and is tried again later; its mark would
          // be past MARKS_MAX)
          const live = Object.entries(r.pending ?? {}).filter(([w, m]) => w !== me && now() - m.at <= MARK_MS).length;
          if (live >= MARKS_MAX) throw new Error(`grants.json: ${live} other windows are writing it at once; tried again shortly`);
          was = r.seenFile;
          return { ...r, pending: { ...r.pending, [me]: { text: json, at: now() } } };
        });
        try {
          await invoke("grants_write", { json, expect: seen });
          seen = json;
          base = rec.docs;
          // (its own mark goes, and only its own; the base moves on only if no merge moved it since the mark, else that
          // merge's base stands)
          try { mark((r) => { const { [me]: _, ...rest } = r.pending ?? {}; const { pending: __, ...out } = r; return { ...out, ...(r.seenFile === was ? { seenFile: json } : {}), ...(Object.keys(rest).length ? { pending: rest } : {}) }; }); } catch (e) { console.warn("grants.json:", e); }
          return;
        } catch (e) {
          if (!String((e as any)?.message ?? e).includes(CHANGED)) throw e;
          // (refused by the app: not written, so its own mark goes, and only its own; any other failure leaves it, the
          // write maybe made)
          mark((r) => { const { [me]: _, ...rest } = r.pending ?? {}; const { pending: __, ...out } = r; return { ...out, ...(Object.keys(rest).length ? { pending: rest } : {}) }; });
          await take(await read());
        }
      }
      throw new Error("grants.json kept being changed by another window");
    }),
  };
  return sync;
}
/** The record as grants.json keeps it: each document by where it is now. */
export async function grantsToKeep(ws: GrantsWorkspace, storage: Store = localStorage): Promise<Rec> {
  const cur = parseGrants(storage.getItem(GRANTS_KEY)) ?? { v: 1, seq: 0, docs: {} };
  const out: Rec = { v: 1, seq: Number(cur.seq) || 0, ...(cur.migrated === 1 ? { migrated: 1 } : {}), docs: {} };
  for (const [id, e] of Object.entries(cur.docs)) {
    if (id.startsWith("file:")) out.docs[id] = e;
    else {
      const p = await ws.pathOf("notebook", id).catch(() => undefined);
      if (p) out.docs["ws:" + p] = e;
    }
  }
  return out;
}

/** After another window wrote grants.json (and again while it can't be read): adopted; while it can't be read, every
 * grant this page holds is set aside (permissions.js suspend: nothing allowed, nothing widens), and they come back only
 * once it is read and merged.  `changed`: what the page's code may do changed (the page tells every interpreter);
 * `ahead`: this page has changes of its own to write; `failed`: still set aside. */
export async function reconcileGrants(sync: ReturnType<typeof grantsSync>, perms: { suspend(why: string | null): boolean }) {
  const r = await sync.adopt();
  const why = r.failed ? `Sagebrush couldn't read its file permissions (${String((r.failed as any)?.message ?? r.failed).slice(0, 200)}), so no notebook may change files until it can` : null;
  const flipped = perms.suspend(why);
  return { changed: r.changed > 0 || flipped, ahead: r.ahead, failed: !!r.failed };
}

/** The desktop app's grants at launch (#1541, Codex S14 F3), in this order, so no change another window makes is missed:
 * every grant set aside first; the listener for another window's change ("sb-grants-changed") registered and waited
 * for; only then grants.json read (restore), and read again and merged (reconcile), so a change made while the first
 * read ran is in too, and grants come back once that succeeds. A listener that can't be registered leaves every
 * grant set aside, and is tried again after `retryMs`, then twice as long each time, up to `retryMaxMs`; a read
 * that fails is tried again every `retryMs`, as reconcileGrants's caller does. `changed()` is called whenever what
 * the page's code may do changed; `ahead()` when this page has changes of its own to write. */
export function startGrants(sync: ReturnType<typeof grantsSync>, perms: { suspend(why: string | null): boolean }, listen: (f: () => void) => Promise<unknown>, hooks: { changed(): void; ahead?(): void }, retryMs = 5000, retryMaxMs = 60_000) {
  let again: ReturnType<typeof setTimeout> | null = null, stopped = false;
  const reconcile = async () => {
    if (again) clearTimeout(again);
    again = null;
    try {
      const r = await reconcileGrants(sync, perms);
      if (r.changed) hooks.changed();
      if (r.ahead) hooks.ahead?.();
      if (r.failed && !stopped) again = setTimeout(reconcile, retryMs);
    } catch (e) { console.warn("grants.json:", e); if (!stopped) again = setTimeout(reconcile, retryMs); }
  };
  if (perms.suspend("Sagebrush is reading its file permissions; no notebook may change files until it has")) hooks.changed();
  // (`ready`: settled once grants are back, or once the first try at the listener has failed (grants still set aside,
  // tried again meanwhile), so a launch never waits on the retries; `done`: once grants are back)
  let firstFailed: () => void = () => {};
  const failedOnce = new Promise<void>((r) => (firstFailed = r));
  const done = (async () => {
    for (let wait = retryMs; !stopped; wait = Math.min(wait * 2, retryMaxMs)) {
      try { await listen(() => void reconcile()); break; } catch (e) {
        console.warn("grants.json: can't watch for other windows' changes:", e);
        if (perms.suspend(`Sagebrush can't watch for changes to its file permissions (${String((e as any)?.message ?? e).slice(0, 200)}), so no notebook may change files until it can`)) hooks.changed();
        firstFailed();
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (stopped) return;
    try { if (await sync.restore()) hooks.changed(); } catch (e) { console.warn("grants.json:", e); }
    await reconcile();
  })();
  return { ready: Promise.race([done, failedOnce]), done, reconcile, stop() { stopped = true; if (again) clearTimeout(again); } };
}

/** grants.json written at each change of the record (`onChange`), one write at a time, the record as it is when each
 * write starts (over the grants.json this page last saw: grantsSync's write); a change during a write makes one more. A write that fails keeps the latest change unwritten: tried
 * again after `retryMs`, and at the next flush. `flush()` resolves once the latest change is in grants.json, and
 * rejects, saying why, if it can't be written now (the quit's and the leave's barrier, disk-mirror.ts keepAll).
 * `after` (startGrants's `done`): nothing is written until it settles, grants.json read and merged first, so this
 * page's record from before that read never goes over a grant another window took back (changes are counted
 * meanwhile, and written then). */
export function keepGrants(ws: GrantsWorkspace, invoke: Invoke, onChange: (f: () => void) => void, storage: Store = localStorage, retryMs = 3000, sync = grantsSync(ws, invoke, storage), after?: Promise<unknown>) {
  let changes = 0, written = 0, failed: unknown = null, busy: Promise<void> | null = null, open = !after;
  after?.then(() => { open = true; void run(); });
  let timer: ReturnType<typeof setTimeout> | null = null;
  // (one job at a time, `busy` while it runs: nothing to write is no job at all, and a job yields before it starts, so
  // it can never finish before it is `busy`; it clears `busy` only if it is still the one there)
  const run = (): Promise<void> => {
    if (busy) return busy;
    if (!open || written >= changes) return Promise.resolve();
    const job: Promise<void> = (async () => {
    await Promise.resolve();
    try {
      while (written < changes) {
        const upTo = changes;
        try {
          await sync.write();
          written = upTo;
          failed = null;
        } catch (e) {
          failed = e;
          console.warn("grants.json:", e);
          if (!timer) timer = setTimeout(() => { timer = null; void run(); }, retryMs);
          return;
        }
      }
    } finally { if (busy === job) busy = null; }
    })();
    busy = job;
    return job;
  };
  const changed = () => { changes++; void run(); };
  onChange(changed);
  const flush = async (): Promise<void> => {
    let last: Promise<void> | null = null;
    if (!open && written < changes) throw new Error("grants.json isn't read yet, so this page's file permissions aren't written to it");
    for (;;) {
      const job = run();
      // (the same job twice is one already done that was never let go of: said, never a loop that spins)
      if (job === last) throw new Error("grants.json: the latest change wasn't written, and no write is running");
      last = job;
      await job;
      if (written >= changes) return;
      if (failed) throw new Error(`grants.json: ${(failed as any)?.message ?? failed}`);
    }
  };
  // (`changed`: a change of the record this page must write, as its own Allow is: grantsSync's merge left it ahead)
  return { flush, save: flush, changed, get unwritten() { return written < changes; } };
}
