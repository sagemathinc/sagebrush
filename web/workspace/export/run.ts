// "Export all current files (.zip)": export plan E1 r2c (frozen 5467a038), the Storage panel's export.  This module
// and the writer (zip.ts) are the lazy chunk sagebrush-export.js; its worker is sagebrush-export-worker.js.
//   preflight(): S0 (the op log's last seq) first; the entries paged in path order; every document streamed once
//     and measured, every cap checked; contents that aren't on this device listed (and then the export refuses:
//     nothing is ever left out); the bound for the sink and the spools' sizes.  It writes nothing.
//   write(): the members in path order, each captured in one locked read and checked against its identity, its bytes
//     those Download writes (file-bytes.ts); every cap checked again on the actual output; then the op log after S0
//     against the allow-list (§2 rule 1); then manifest.json, the last member; the central directory; the end
//     records; the sink closed; only then "Last export prepared" (§5a).  Any failure: the sink aborted, the scratch
//     removed, the status line untouched.
import type { Entry, Op, Workspace } from "../api";
import type { BoardDoc } from "../../board/doc";
import { Images } from "../../board/images";
import { BlobSink, ExportStopped, ExportWorker, OpfsSink, PickerSink, SLICE, Spool, ZipWriter, type Sink } from "./zip";
import { boardSlices, notebookSlices, sizes, toLines, type Pace } from "./stream";

/** What the page gives this chunk, from its own bundle, so the chunk carries no second copy of the workspace or the
 * serializers: Download's own functions (file-bytes.ts), how a "missing" read looks, the data-file cap, Trash. */
export type Kit = {
  notebookFileText(doc: any): string;
  /** the notebook's JSON value, which notebookFileText writes (web/notebook/ipynb.js), for its streaming */
  ipynbObject(doc: any, toLines: (t: unknown) => unknown): unknown;
  boardFileText(doc: BoardDoc, images: { inline(d: BoardDoc): Promise<BoardDoc> }): Promise<string>;
  isMissing(err: unknown): boolean;
  maxFileBytes: number;
  trash: string;
};
let K: Kit;
export const setKit = (k: Kit) => { K = k; CAPS.file = k.maxFileBytes; };
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const inTrash = (p: string) => p === K.trash || p.startsWith(K.trash + "/");

/** The shared caps (design/workspace-files.md §7.11's table; E1 r2c §6). */
export const CAPS = {
  doc: 64 * 2 ** 20,
  file: 200 * 2 ** 20,
  total: 20 * 2 ** 30,
  manifest: 64 * 2 ** 20,
  /** the in-memory Blob sink's bound */
  blob: 256 * 2 ** 20,
  /** the spool's bound when it can only be Blob parts (no OPFS scratch) */
  spoolBlob: 64 * 2 ** 20,
};
/** Entries read at a time.  Small, so each page's rows die young: rows kept across the many yields of a larger page
 * were promoted and grew the heap with garbage (the 100,000-entry test: 75 MiB at 500, retained nothing) */
export const PAGE = 50;

/** Test hooks (web/workspace/test-export.mjs), honored only when the test page set them. */
type TestHooks = {
  beforeCapture?(path: string): Promise<void> | void;
  afterCapture?(path: string): Promise<void> | void;
  caps?: Partial<typeof CAPS>;
  noOpfs?: boolean;
  noPicker?: boolean;
  onHand?(blob: Blob, name: string): void;
  stats?: { spoolChunks?: number; members?: number };
  slicePause?: number;
  /** after each member is written (its count), between members: the r2d heap checkpoints wait here */
  between?(written: number): Promise<void> | void;
  /** preflight's plan, before Save… (a test lowers a cap to what it found, to test the checks on actual output) */
  onPlan?(plan: Plan): Promise<void> | void;
  /** preflight about to stream a document to measure it; write about to write a member */
  preflightMember?(path: string): Promise<void> | void;
  onMember?(path: string): Promise<void> | void;
  /** the tree check, after its first page of ops (a test trims the log there) */
  duringTreeScan?(): Promise<void> | void;
  /** "Last export prepared" can't be written (E1-A6's test) */
  failStamp?: boolean;
  /** the worker fails the OPFS spool's nth append (T13) */
  failSpoolAfter?: number;
  /** the instrument's own check (grader's C8): a busy loop of this many ms on the main thread after the first member */
  busyMs?: number;
  /** stream.ts's slice and piece sizes, small, so that cuts land everywhere (the byte-equality tests) */
  streamSizes?: [number, number];
  /** the stalls' profile (E1 r2, @sagebrush's (c)): each wait of the writing loop, its start (0) and end (1) */
  probe?(what: "page" | "capture" | "member" | "spool", edge: 0 | 1): void;
};
/** A wait of the writing loop, told to the profile's probe when a test page set one. */
async function timed<R>(what: "page" | "capture" | "member" | "spool", p: () => Promise<R>): Promise<R> {
  const probe = T().probe;
  if (!probe) return p();
  probe(what, 0);
  try { return await p(); } finally { probe(what, 1); }
}
/** The stream's sizes for this run: a test's, else the real ones. */
const sizesNow = () => { const s = T().streamSizes ?? [256 * 1024, 64 * 1024]; sizes(s[0], s[1]); };
/** The caps in effect: the real table unless a test page set its own (grader's N-3: a page without the hooks has the
 * real ones). */
export const capsInEffect = () => ({ ...CAPS, ...(T().caps ?? {}) });
const T = (): TestHooks => ((globalThis as any).__SB_EXPORT_TEST__ as TestHooks | undefined) ?? {};
const cap = (k: keyof typeof CAPS) => T().caps?.[k] ?? CAPS[k];

const enc = new TextEncoder();
const pause = () => new Promise<void>((r) => setTimeout(r, 0));
/** A yield to the event loop once 8 ms of work have passed since the last one: the loops over entries call it per
 * entry, so no task runs long however the awaits inside resolve (E1 r2c §6: at most 50 ms a task). */
let lastYield = 0;
const breathe = async () => { if (performance.now() - lastYield > 8) { await pause(); lastYield = performance.now(); } };

const STORE_EXT = new Set("png jpg jpeg gif webp avif heic heif pdf zip gz tgz bz2 xz zst 7z rar wasm mp4 m4a m4v mov webm mkv avi mp3 ogg oga opus flac aac woff woff2 jar docx xlsx pptx odt ods odp epub sbreplay npz parquet".split(" "));
const TEXT_EXT = new Set("ipynb json py sage m mag tex bib sty cls md markdown txt csv tsv html htm css js mjs ts xml svg yaml yml toml ini cfg log sql r jl c h cc cpp hpp java rs go sh gp g mpl".split(" "));
const extOf = (p: string) => { const n = nameOf(p).toLowerCase(), i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1) : ""; };

/** STORE or DEFLATE (E1 r2c §3): text deflated, known-compressed stored, anything else deflated unless its first
 * 64 KiB compress to more than 95% of their size. */
export async function deflates(path: string, kind: Entry["kind"], bytes: Uint8Array): Promise<boolean> {
  if (kind === "notebook" || kind === "board") return true;
  const x = extOf(path);
  if (TEXT_EXT.has(x)) return true;
  if (STORE_EXT.has(x)) return false;
  const head = bytes.subarray(0, 65536);
  if (head.length < 64) return true;
  const out = await new Response(new Blob([head as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
  return out.byteLength <= head.length * 0.95;
}

/** zlib's deflateBound: the most a deflated member can take. */
const deflateBound = (n: number) => n + (n >> 12) + (n >> 14) + (n >> 25) + 13;

export type Unavailable = { path: string; kind: Entry["kind"]; why: "remote" | "missing" };
export type Member = { path: string; kind: Entry["kind"]; ident: string | undefined };
export type Plan = {
  s0: number;
  files: number;
  folders: number;
  /** uncompressed bytes of the members, as measured now (the manifest's bound included) */
  bytes: number;
  /** the bundle's upper bound */
  bound: number;
  /** the spools' bounds: the central records', and the manifest entries' (each entry once: astra's accounting note) */
  cdSpool: number;
  manSpool: number;
  unavailable: Unavailable[];
};
export type Progress = { phase: "preflight" | "writing" | "finishing"; files: number; of: number; bytes: number; total: number };

/** Every current entry outside Trash, page by page, in path order. */
async function* entries(w: Workspace): AsyncGenerator<Entry[]> {
  let after: string | null = null;
  for (;;) {
    const rows = await timed("page", () => w.entriesPage(after, PAGE));
    if (!rows.length) return;
    after = rows[rows.length - 1].path;
    const shown = rows.filter((e) => e.path !== "/" && !inTrash(e.path));
    if (shown.length) yield shown;
    if (rows.length < PAGE) return;
    await pause();
  }
}

const zipName = (e: Pick<Entry, "path" | "kind">) => "files/" + e.path.slice(1) + (e.kind === "folder" ? "/" : "");
const unavailableWhy = (e: Entry): Unavailable["why"] | null => (e.remote ? "remote" : e.missing ? "missing" : null);

/** UTF-8 bytes of `s` as TextEncoder writes it (a lone surrogate as U+FFFD), counted without encoding it. */
export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
/** UTF-8 bytes of JSON.stringify(s), quotes included, counted without building it. */
export function jsonLen(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) n += 2;
    else if (c < 0x20) n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { if (i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 6; }
    else if (c >= 0xdc00 && c <= 0xdfff) n += 6;
    else n += 3;
  }
  return n;
}
const numLen = (x: number) => String(x).length;
/** The byte length of manifestEntry(e, captured) with its widest captured fields (preflight's bound), computed
 * without building it: the same fields, in the same order. */
export function manifestEntryLen(e: Entry, captured: number): number {
  let n = 1;
  const add = (key: string, v: number) => { n += (n > 1 ? 1 : 0) + key.length + 3 + v; };
  add("path", jsonLen(e.path));
  add("kind", jsonLen(e.kind));
  if (e.ref !== null && e.kind !== "file" && e.kind !== "folder") add("ref", jsonLen(e.ref));
  if (e.fid !== undefined) add("fid", jsonLen(e.fid));
  add("created", numLen(e.created));
  add("modified", numLen(e.updated));
  add("captured", numLen(captured));
  if (e.kind !== "folder") { add("rev", numLen(Number.MAX_SAFE_INTEGER)); add("size", numLen(Number.MAX_SAFE_INTEGER)); add("sha256", 66); }
  if (e.mode !== undefined) add("mode", jsonLen(e.mode));
  return n + 1;
}

/** A manifest entry's JSON, with a captured revision and hash (or, for preflight's bound, their widest forms). */
function manifestEntry(e: Entry, captured: number, got?: { rev: number; size: number; sha256: string }): string {
  const o: Record<string, unknown> = { path: e.path, kind: e.kind };
  if (e.ref !== null && e.kind !== "file" && e.kind !== "folder") o.ref = e.ref;
  if (e.fid !== undefined) o.fid = e.fid;
  o.created = e.created;
  o.modified = e.updated;
  o.captured = captured;
  if (e.kind !== "folder") {
    o.rev = got?.rev ?? Number.MAX_SAFE_INTEGER;
    o.size = got?.size ?? Number.MAX_SAFE_INTEGER;
    o.sha256 = got?.sha256 ?? "f".repeat(64);
  }
  if (e.mode !== undefined) o.mode = e.mode;
  return JSON.stringify(o);
}

/** A captured entry's member, as slices (E1 r2d §6; daybreak2's E1-D2-1): a notebook's and a board's file written as
 * they stream (stream.ts), never as one string or buffer; a data file's bytes as they are (one buffer, read whole by
 * its capture; the pump slices it).  `images`: the board's pictures, let go by the caller. */
function memberOf(e: Entry, content: any, pace: Pace, images: Images): AsyncIterable<Uint8Array> | Iterable<Uint8Array> {
  if (e.kind === "notebook") return notebookSlices(K.ipynbObject(content, toLines), pace);
  if (e.kind === "board") return boardSlices(content as BoardDoc, images, K.boardFileText, pace);
  if (content instanceof Uint8Array) return [content];
  if (content instanceof ArrayBuffer) return [new Uint8Array(content)];
  if (ArrayBuffer.isView(content)) return [new Uint8Array(content.buffer, content.byteOffset, content.byteLength)];
  throw new ExportStopped(`${e.path}: its bytes are in a form the export doesn't know`);
}
const capOf = (kind: Entry["kind"]) => (kind === "notebook" || kind === "board" ? cap("doc") : cap("file"));
const capWhy = (path: string, kind: Entry["kind"]) => kind === "notebook" || kind === "board"
  ? `${path} is larger than ${cap("doc") / 2 ** 20} MiB as a file, more than an import takes: it can't be exported`
  : `${path} is larger than ${Math.floor(cap("file") / 2 ** 20)} MiB: it can't be exported`;

/** An entry whose contents aren't in this browser (found at its read). */
export class Missing extends ExportStopped {}

/** The pace of one export: its Cancel, and a yield once 8 ms of work have passed. */
const paceOf = (signal: AbortSignal): Pace => ({ signal, breathe, stopped: () => { throw new ExportStopped("cancelled"); } });
const stopIf = (signal: AbortSignal) => { if (signal.aborted) throw new ExportStopped("cancelled"); };

/** The read that captures one entry (E1 r2c §2 rule 2): its identity, kind and path as enumerated, or stopped.  The
 * lock is waited for under the export's Cancel (astra's E1-A4). */
async function capture(w: Workspace, e: Entry, signal: AbortSignal): Promise<{ entry: Entry; content: any; rev: number; at: number }> {
  let r;
  try {
    r = await w.readLocked(e.path, signal);
  } catch (err) {
    stopIf(signal);
    // (nothing at its path any more: it was moved, renamed or deleted since it was listed; there, but its contents
    // not in this browser: missing)
    if (!(await w.stat(e.path).catch(() => undefined))) throw new ExportStopped(`${e.path} was moved, renamed or deleted while exporting`);
    if (K.isMissing(err)) throw new Missing(`${e.path} isn't on this device`);
    throw err;
  }
  stopIf(signal);
  const at = Date.now();
  if (r.entry.kind !== e.kind || r.entry.ident !== e.ident || r.entry.path !== e.path) throw new ExportStopped(`${e.path} changed while exporting (it is another ${r.entry.kind} now)`);
  return { ...r, at };
}

/** The bytes a member streams to, counted (preflight's measure of a document): past `max`, stopped with `why`. */
async function measure(src: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, max: number, why: string): Promise<number> {
  let n = 0;
  for await (const s of src as AsyncIterable<Uint8Array>) { n += s.length; if (n > max) throw new ExportStopped(why); }
  return n;
}

/** What isn't on this device, said plainly (E1 r2 simplification: the export refuses rather than leaving anything out;
 * @sagebrush's rule, Oct 31). */
export function unavailableWhyText(u: Unavailable[]): string {
  const n = u.length;
  return `${n.toLocaleString()} file${n === 1 ? " isn't" : "s aren't"} on this device yet, so nothing can be exported: open ${n === 1 ? "it" : "them"} here, or turn sync on and let ${n === 1 ? "it" : "them"} download, then export again`;
}

export async function preflight(w: Workspace, signal: AbortSignal, progress: (p: Progress) => void): Promise<Plan> {
  const s0 = await w.lastSeq();
  const plan: Plan = { s0, files: 0, folders: 0, bytes: 0, bound: 98, cdSpool: 0, manSpool: 0, unavailable: [] };
  sizesNow();
  const pace = paceOf(signal);
  let lastPre = 0;
  for await (const page of entries(w)) {
    for (const e of page) {
      stopIf(signal);
      await breathe();
      const name = utf8Len(e.path) + 6 + (e.kind === "folder" ? 1 : 0);
      const flagged = unavailableWhy(e);
      if (flagged) { plan.unavailable.push({ path: e.path, kind: e.kind, why: flagged }); continue; }
      // (the spools: each member's central record, at most 46 + name + a Zip64 extra; its manifest entry and comma)
      plan.cdSpool += 46 + 12 + name;
      plan.manSpool += manifestEntryLen(e, Date.now()) + 1;
      plan.bound += 30 + 46 + 16 + 12 + 2 * name;
      if (e.kind === "folder") { plan.folders++; continue; }
      plan.files++;
      let size: number;
      if (e.kind === "file") {
        // (its bytes there, checked by key without reading them: an unflagged file without them is refused here, not
        // found halfway through writing (astra's E1-A2))
        if (!(await w.present(e.path))) { plan.unavailable.push({ path: e.path, kind: e.kind, why: "missing" }); continue; }
        size = e.size ?? 0;
      } else {
        // (a document streamed once, to measure it, then let go)
        await T().preflightMember?.(e.path);
        let c;
        try { c = await timed("capture", () => capture(w, e, signal)); } catch (err) {
          if (err instanceof Missing) { plan.unavailable.push({ path: e.path, kind: e.kind, why: "missing" }); continue; }
          throw err;
        }
        const images = new Images();
        try { size = await measure(memberOf(c.entry, c.content, pace, images), capOf(e.kind), capWhy(e.path, e.kind)); } finally { images.dispose(); }
      }
      if (size > capOf(e.kind)) throw new ExportStopped(capWhy(e.path, e.kind));
      plan.bytes += size;
      plan.bound += deflateBound(size);
      if (performance.now() - lastPre > 100) { lastPre = performance.now(); progress({ phase: "preflight", files: plan.files, of: 0, bytes: plan.bytes, total: 0 }); }
      if (plan.bytes > cap("total")) throw new ExportStopped(`the files come to more than ${cap("total") / 2 ** 30} GiB, more than an import takes`);
    }
  }
  // (the manifest: its entries (manSpool) between its head and tail)
  const manifest = plan.manSpool + MANIFEST_ENDS;
  if (manifest > cap("manifest")) throw new ExportStopped(`the export's index (manifest.json) would be over ${cap("manifest") / 2 ** 20} MiB: too many files with long names`);
  plan.bytes += manifest;
  plan.bound += deflateBound(manifest) + 30 + 46 + 16 + 12 + 2 * 13;
  if (plan.bytes > cap("total")) throw new ExportStopped(`the files come to more than ${cap("total") / 2 ** 30} GiB, more than an import takes`);
  return plan;
}
/** The manifest's head and tail around its entries, at their widest. */
const MANIFEST_ENDS = 512;

/** A 53-bit hash of a string (cyrb53), for the tree check's record of what was exported: per path, its identity. */
function h53(s: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
/** What the export captured: per path (hashed), the identity (hashed) it captured there; "/" is the root's. */
export class Captured {
  private m = new Map<number, number>();
  add(path: string, ident: string | undefined) { this.m.set(h53(path), ident === undefined ? -1 : h53(ident)); }
  /** whether `path` was captured with identity `ident` (undefined: none) */
  is(path: string, ident: string | null | undefined): boolean {
    const v = this.m.get(h53(path));
    return v !== undefined && v !== -1 && ident != null && v === h53(ident);
  }
}
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/** Ops after S0, against the allow-list (E1 r2c §2 rule 1; astra's E1-A1): a content `write` that kept its entry's
 * identity, its name, its folder (by the folder's identity) and its kind, and didn't put it in Trash, each as the
 * export captured them; a dropVersions; an emptyTrash.  Anything else stops the export, naming its path; server-
 * applied ops alike.  The log's floor is read before and after the scan: ops after S0 pruned meanwhile stop it. */
export async function treeUnchanged(w: Workspace, s0: number, got: Captured, signal: AbortSignal): Promise<void> {
  const trimmed = "the workspace's change log was trimmed while exporting, so the export can't show nothing moved";
  if ((await w.opsFloor()) > s0) throw new ExportStopped(trimmed);
  let after = s0;
  for (;;) {
    stopIf(signal);
    const ops: Op[] = await w.opsPage(after, PAGE);
    if (after === s0) await T().duringTreeScan?.();
    for (const op of ops) {
      await breathe();
      const a = op.after;
      const parent = parentOf(op.path);
      const ok = op.op === "dropVersions" || op.op === "emptyTrash"
        || (op.op === "write" && !!a && !a.trashed && a.name === nameOf(op.path) && a.kind === op.kind
          && got.is(op.path, a.id) && (parent === "/" ? a.parent == null : got.is(parent, a.parent)));
      if (!ok) throw new ExportStopped(`${op.path}${op.to ? ` (to ${op.to})` : ""}: "${op.op}" while exporting`);
    }
    if (ops.length < PAGE) break;
    after = ops[ops.length - 1].seq!;
    await pause();
  }
  if ((await w.opsFloor()) > s0) throw new ExportStopped(trimmed);
}

export type Result = { name: string; members: number; bytes: number; stampFailed?: string };

/** The sink, chosen on the plan's bound (§5): the picker (opened by the caller, on a click), else OPFS when it has
 * room, else a Blob only up to 256 MiB, else refused. */
export async function chooseSink(plan: Plan, wk: ExportWorker | null, id: string): Promise<Sink> {
  if (wk) {
    const est = await (navigator.storage as any)?.estimate?.().catch(() => undefined);
    if (est && typeof est.quota === "number" && est.quota - est.usage >= plan.bound + plan.cdSpool + plan.manSpool) {
      const file = `${id}-out.zip`;
      const s = new OpfsSink(wk, file, async () => (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("sagebrush-export")).getFileHandle(file)).getFile(), T().onHand ?? undefined);
      await s.open();
      return s;
    }
  }
  if (plan.bound <= cap("blob")) return new BlobSink(cap("blob"), T().onHand ?? undefined);
  throw new ExportStopped(`this export can be up to ${Math.ceil(plan.bound / 2 ** 20)} MiB, and this browser can't save a file that large here: use a browser that can save files (Chrome, Edge, or the desktop app)`);
}

/** The worker (the hashes', always), and whether OPFS gives it a usable scratch file (§6): earlier exports' leftover
 * scratch removed first, but never a running or handing-off export's (its lock, held, keeps its files: astra's E1-A3). */
export async function startWorker(url: string, id: string): Promise<{ worker: ExportWorker; opfs: boolean }> {
  const worker = new ExportWorker(new Worker(url, { type: "module" }));
  if (T().noOpfs) return { worker, opfs: false };
  try { await worker.ask("removeStale", { lockPrefix: LOCK_PREFIX }); await worker.ask("probe", { name: `${id}-probe` }); return { worker, opfs: true }; } catch { return { worker, opfs: false }; }
}
/** Each export holds the Web Lock LOCK_PREFIX + its id from its start until its last scratch file is removed. */
export const LOCK_PREFIX = "sagebrush-export:";

/**
 * The bundle written and handed over.  `picked`: the picker's writable, opened on the Save… click: owned from here, so
 * any failure, the earliest included, aborts it (astra's E1-A3).  `after(p)`: what must outlive this call (the OPFS
 * scratch's delayed removal), for the caller to keep the worker and the export's lock until it settles.
 */
export async function write(w: Workspace, plan: Plan, opts: { worker: ExportWorker; opfs: boolean; id: string; picked: any | null; signal: AbortSignal; progress: (p: Progress) => void; site: string; app: string; after(p: Promise<void>): void }): Promise<Result> {
  let sink: Sink | undefined = opts.picked ? new PickerSink(opts.picked) : undefined;
  let committed = false;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const spoolWk = opts.opfs ? opts.worker : null;
  const cd = new Spool(`${opts.id}-cd`, spoolWk, plan.cdSpool), man = new Spool(`${opts.id}-manifest`, spoolWk, plan.manSpool);
  const pace = paceOf(opts.signal);
  sizesNow();
  try {
    if (plan.unavailable.length) throw new ExportStopped(unavailableWhyText(plan.unavailable));
    if (!opts.opfs && plan.cdSpool + plan.manSpool > cap("spoolBlob")) throw new ExportStopped("This browser can't hold the export's index; use a browser that can save files, or export a smaller workspace");
    await cd.open();
    await man.open();
    if (spoolWk && T().failSpoolAfter) await spoolWk.ask("failAfter", { n: T().failSpoolAfter });
    sink ??= await chooseSink(plan, spoolWk, opts.id);
    let written = 0, files = 0, done = 0, total = 0, first = true, phase: Progress["phase"] = "writing";
    const zip = new ZipWriter(sink, cd, { signal: opts.signal, crc: opts.worker, progress: (n) => { written += n; }, slicePause: T().slicePause });
    const got = new Captured();
    // (progress: the files and folders written and the archive's bytes so far, its index included; at most every 100
    // ms from the loop, and every 100 ms from a timer too, so the line is rewritten at least every 250 ms whatever
    // the work waits on (E1 r2d §6, @sagebrush's ruling of Oct 31); never an object and a string per entry)
    let lastTick = 0;
    const tick = (p: Progress["phase"], now = false) => {
      const t = performance.now();
      if (!now && t - lastTick < 100) return;
      lastTick = t;
      phase = p;
      // (bytes: what has been processed, each member's input and the central directory as it is written, which moves
      // steadily; the archive's own offset moves in bursts while the compressor holds its output)
      opts.progress({ phase, files: done, of: plan.files + plan.folders, bytes: written, total: plan.bound });
    };
    progressTimer = setInterval(() => tick(phase, true), 100);
    for await (const page of entries(w)) {
      for (const e of page) {
        stopIf(opts.signal);
        await breathe();
        // (nothing is left out: anything not on this device now, though it was at preflight, stops the export)
        if (unavailableWhy(e)) throw new ExportStopped(`${e.path} isn't on this device any more`);
        let line: string;
        if (e.kind === "folder") {
          await zip.folder(zipName(e), e.updated);
          got.add(e.path, e.ident);
          line = manifestEntry(e, Date.now());
        } else {
          await T().beforeCapture?.(e.path);
          const c = await timed("capture", () => capture(w, e, opts.signal));
          await T().afterCapture?.(e.path);
          got.add(e.path, c.entry.ident);
          // (the member's cap, or what is left of the total if that is less: both checked on the bytes as they go)
          const left = cap("total") - total, docCap = capOf(e.kind);
          const max = Math.min(docCap, left), why = left < docCap ? `the export passed ${cap("total") / 2 ** 30} GiB while it was written (files grew meanwhile)` : capWhy(e.path, e.kind);
          const images = new Images();
          let m;
          await T().onMember?.(e.path);
          try {
            const src = memberOf(c.entry, c.content, pace, images);
            const deflate = e.kind === "file" ? await deflates(e.path, e.kind, (src as Uint8Array[])[0]) : true;
            m = await timed("member", () => zip.member(zipName(e), src, deflate, c.entry.updated, max, why));
          } finally { images.dispose(); }
          total += m.usize;
          line = manifestEntry(c.entry, c.at, { rev: c.rev, size: m.usize, sha256: m.sha256! });
          files++;
        }
        await timed("spool", async () => { if (!first) await man.appendText(","); await man.appendText(line); });
        first = false;
        done++;
        tick("writing");
        await T().between?.(zip.members);
        // (grader's C8: a known long task, which the long-task observer must see)
        const busy = T().busyMs;
        if (busy && done === 1) { const t = performance.now(); while (performance.now() - t < busy) {} }
      }
    }
    // (rule 1: nothing in the tree moved since S0)
    await treeUnchanged(w, plan.s0, got, opts.signal);
    tick("finishing", true);
    // (§5a: created right before the manifest is serialized; the manifest is the last member)
    const created = new Date().toISOString();
    const head = enc.encode(JSON.stringify({ format: "sagebrush-workspace-bundle", version: 1, mode: "files", created, site: opts.site, app: opts.app }).slice(0, -1) + ',"entries":[');
    const tail = enc.encode("]," + JSON.stringify({ omitted: [], totals: { files, folders: plan.folders, bytes: total } }).slice(1));
    const left = cap("total") - total;
    async function* manifest() { yield head; for await (const s of man.replay()) yield s; yield tail; }
    await zip.member("manifest.json", manifest(), true, Date.now(), Math.min(cap("manifest"), left), `the export's index (manifest.json) passed ${cap("manifest") / 2 ** 20} MiB, or the export passed ${cap("total") / 2 ** 30} GiB, while it was written`);
    await zip.finish();
    stopIf(opts.signal);
    const name = `sagebrush-${localDate()}.zip`;
    // (from here the archive is the person's: committed, a Cancel no longer undoes it, and a failure after this is
    // reported as such, never as "nothing was saved" (astra's E1-A6))
    const closed = await sink.close(name);
    committed = true;
    opts.after(closed?.later ?? Promise.resolve());
    const r: Result = { name, members: zip.members, bytes: zip.offset };
    try {
      if (T().failStamp) throw new Error("this device's storage refused the write (a test)");
      await w.setLastExport({ at: Date.now(), partial: false, members: r.members, bytes: r.bytes });
    } catch (e) { r.stampFailed = String((e as Error)?.message ?? e); }
    const st = T().stats;
    if (st) { st.spoolChunks = cd.chunks + man.chunks; st.members = zip.members; }
    return r;
  } catch (e) {
    if (!committed) await sink?.abort();
    throw e;
  } finally {
    clearInterval(progressTimer);
    await cd.remove();
    await man.remove();
  }
}

export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export { ExportStopped, ExportWorker, SLICE };
