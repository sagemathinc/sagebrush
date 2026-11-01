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
import { BlobSink, counts, cutShort, ExportStopped, ExportWorker, OpfsSink, PickerSink, resetCounts, SLICE, Spool, ZipWriter, type Sink } from "./zip";
import { jsonLen, numLen as jsonNumLen, utf8Len } from "./bytes";
import { captureFolder, captureLine, CAPTURED, DATE, IDENT, KIND, KINDS, manifestFolder, manifestLine, NAME, PATH, putRow, R, readRow, TIME } from "./rows";
import { boardSlices, notebookSlices, sizes, type BoardKit, type Pace } from "./stream";
// (the serializers: Download's own functions, from the module Download calls (file-bytes.ts), built into this chunk
// rather than handed over by the page, so that a page carries them only if it uses them itself before any click
// (E1 r2a, @sagebrush's eager-size ruling); the same source, so the export's bytes are Download's by construction)
import { boardFileText, boardTextParts, cleanDocSteps, ipynbObject, notebookFileText } from "../file-bytes";
const SER: BoardKit = { cleanDocSteps, boardTextParts };

/** What the page gives this chunk, from its own bundle, so the chunk carries no second copy of the workspace: how a
 * "missing" read looks (the page's WorkspaceError), the data-file cap, Trash. */
export type Kit = {
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
  stats?: Stats;
  slicePause?: number;
  /** after each member is written (its count), between members: the r2d heap checkpoints wait here */
  between?(written: number): Promise<void> | void;
  /** (r2a) the capture log at its observation boundary, before it settles: chunks written out, bytes still buffered */
  onLookup?(at: { chunks: number; buffered: number }): void;
  /** (r2a) each chunk the capture log's lookup reads, in order: the log as the tree check sees it */
  captureChunk?(chunk: Uint8Array): void;
  /** preflight's plan, before Save… (a test lowers a cap to what it found, to test the checks on actual output) */
  onPlan?(plan: Plan): Promise<void> | void;
  /** preflight about to stream a document to measure it; write about to write a member */
  preflightMember?(path: string): Promise<void> | void;
  onMember?(path: string): Promise<void> | void;
  /** the tree check, after its first page of ops (a test trims the log there) */
  duringTreeScan?(): Promise<void> | void;
  /** "Last export prepared" can't be written (E1-A6's test) */
  failStamp?: boolean;
  /** the worker fails the OPFS spool's nth append (T13); (r2c, O-2) the rows spool's nth append, in preflight */
  failSpoolAfter?: number;
  failRowsAfter?: number;
  /** (r2c) the rows spool cut by its last byte before writing replays it: the export must stop, "cut short" */
  cutRows?: boolean;
  /** (r2c, P-9) after preflight, before writing replays the records: a test edits the workspace there */
  beforeReplay?(): Promise<void> | void;
  /** (r2c, "slices") the worker holds each append this long first, so a Cancel lands with a slice in flight */
  appendDelayMs?: number;
  /** only the scratch files whose names match it (the archive's, a spool's) */
  appendDelayRe?: string;
  /** (astra's E1-R2-A2) the stale sweep pauses this long between listing and removing; the probe's write or flush
   * fails; a scratch file's open (truncate) fails */
  sweepPauseMs?: number;
  failProbe?: "write" | "flush";
  failOpen?: "spool" | "sink" | "rows" | "rows-late";
  /** the instrument's own check (grader's C8): a busy loop of this many ms on the main thread after the first member */
  busyMs?: number;
  /** stream.ts's slice and piece sizes, small, so that cuts land everywhere (the byte-equality tests) */
  streamSizes?: [number, number];
  /** (tests only, never with timing checks) each document's Download bytes, through the page's own notebookFileText
   * and boardFileText, hashed into stats.refs by path: the streamed member's sha256 must equal it */
  reference?: boolean;
  /** the stalls' profile (E1 r2, @sagebrush's (c)): each wait of the writing loop, its start (0) and end (1) */
  probe?(what: "page" | "capture" | "member" | "spool", edge: 0 | 1): void;
};
/** What a test page reads after an export (E1 r2a; r2c R3: the slices, Blob retention, the rows spool's framing). */
type Stats = {
  spoolChunks?: number; members?: number; refs?: Record<string, string>;
  /** chunks flushed per spool, the rows spool's included (spoolChunks: the CD's, the manifest's and the capture log's) */
  flushes?: { cd: number; manifest: number; capture: number; rows: number };
  sizes?: { cd: number; manifest: number; capture: number; rows: number };
  /** (P-6's fixtures) boundaries that waited for a slice still away, per file; and the sink used */
  waits?: { archive: number; cd: number; manifest: number; capture: number; rows: number }; sink?: string;
  /** the rows spool: its segments' lengths, the bytes of its records, its size */
  rowSegs?: number[]; rowBytes?: number; rowSize?: number;
  /** slices made (each 1 MiB) and their bytes in all; bytes held in Blob parts; read back from them; hash copies;
   * slices made after a Cancel */
  slices?: number; sliceBytes?: number; blobBytes?: number; blobReadBytes?: number; hashCopyBytes?: number; slicesAfterStop?: number;
  /** slices handed over (to the worker or a sink) after a Cancel: none */
  postsAfterStop?: number;
  /** a Cancel to the export's stop, ms (its cleanup after) */
  stopMs?: number;
  /** (R1) the records writing replayed, and breathe's clock reads meanwhile (one per record boundary at least) */
  records?: number; clockReads?: number;
  /** each export's preflight and writing, ms (r2c: elapsed next to b00fb43f's) */
  preflightMs?: number; writingMs?: number;
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
/** (r2c §2, §4) the clock read at every call, each record boundary; a promise only when a yield is due */
let clockReads = 0;
const breathe = (): Promise<void> | undefined => {
  clockReads++;
  if (performance.now() - lastYield > 8) return pause().then(() => { lastYield = performance.now(); });
};

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
  /** the spools' bounds: the central records', the manifest entries' (each entry once: astra's accounting note), and
   * the capture log's (astra's E1-R2-A1) */
  cdSpool: number;
  manSpool: number;
  capSpool: number;
  unavailable: Unavailable[];
  /** preflight's elapsed time, ms (r2c's evidence) */
  preflightMs?: number;
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

// (a number's length as the manifest writes it, JSON.stringify's: NaN and ±Infinity as null (r2c, P-1; String(n) gave
// "NaN", a byte short))
const numLen = (x: number) => jsonNumLen(x);
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
export function manifestEntry(e: Entry, captured: number, got?: { rev: number; size: number; sha256: string }): string {
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
  if (e.kind === "notebook") return notebookSlices(content, ipynbObject, pace);
  if (e.kind === "board") return boardSlices(content as BoardDoc, images, SER, pace);
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
const paceOf = (signal: AbortSignal): Pace => ({ signal, breathe: async () => { const p = breathe(); if (p) await p; }, stopped: () => { throw new ExportStopped("cancelled"); } });
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

/** The no-OPFS refusal (E1 r2a heap plan r2c P-8; @sagebrush's condition: the cause in plain words): without the
 * browser's file storage every spool, the rows spool included, is held in memory, up to CAPS.spoolBlob. */
export const NO_OPFS_WHY = "This workspace is too large to export in this browser without its file storage. Use a browser with file storage (Chrome, Edge) or the desktop app.";

/**
 * Preflight, and the entries read once (r2c §1): one record per shown, available entry into `rows`, which the caller
 * owns (created, and removed on every exit, by openExport: astra's obligations), opened here.  `opfs`: false when the
 * spools are Blob parts, which then count, the records included, toward CAPS.spoolBlob.
 */
export async function preflight(w: Workspace, signal: AbortSignal, progress: (p: Progress) => void, rows: Spool, opfs: boolean): Promise<Plan> {
  const t0 = performance.now();
  resetCounts();
  rowStats.rowBytes = 0;
  const s0 = await w.lastSeq();
  const plan: Plan = { s0, files: 0, folders: 0, bytes: 0, bound: 98, cdSpool: 0, manSpool: 0, capSpool: 0, unavailable: [] };
  sizesNow();
  const pace = paceOf(signal);
  await rows.open();
  if (T().failRowsAfter && rows.wk) await rows.wk.ask("failAfter", { n: T().failRowsAfter, re: "-rows$" });
  let lastPre = 0;
  for await (const page of entries(w)) {
    for (const e of page) {
      stopIf(signal);
      { const y = breathe(); if (y) await y; }
      const name = utf8Len(e.path) + 6 + (e.kind === "folder" ? 1 : 0);
      const flagged = unavailableWhy(e);
      if (flagged) { plan.unavailable.push({ path: e.path, kind: e.kind, why: flagged }); continue; }
      // (the spools: each member's central record, at most 46 + name + a Zip64 extra; its manifest entry and comma)
      plan.cdSpool += 46 + 12 + name;
      plan.manSpool += manifestEntryLen(e, Date.now()) + 1;
      plan.capSpool += captureLineLen(e);
      plan.bound += 30 + 46 + 16 + 12 + 2 * name;
      if (e.kind === "folder") {
        plan.folders++;
        // (P-9: a folder's captured is its observation, here)
        const p = putRow(rows, e, Date.now(), rowStats);
        if (p) await p;
        if (!opfs && blobSpoolsOver(plan, rows)) throw new ExportStopped(NO_OPFS_WHY, true);
        continue;
      }
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
      { const p = putRow(rows, e, 0, rowStats); if (p) await p; }
      if (!opfs && blobSpoolsOver(plan, rows)) throw new ExportStopped(NO_OPFS_WHY, true);
      if (performance.now() - lastPre > 100) { lastPre = performance.now(); progress({ phase: "preflight", files: plan.files, of: 0, bytes: plan.bytes, total: 0 }); }
      if (plan.bytes > cap("total")) throw new ExportStopped(`the files come to more than ${cap("total") / 2 ** 30} GiB, more than an import takes`);
    }
  }
  // (the records written out, every slice back: an append's failure is seen here, in preflight)
  await rows.settle();
  // (the manifest: its entries (manSpool) between its head and tail)
  const manifest = plan.manSpool + MANIFEST_ENDS;
  if (manifest > cap("manifest")) throw new ExportStopped(`the export's index (manifest.json) would be over ${cap("manifest") / 2 ** 20} MiB: too many files with long names`);
  plan.bytes += manifest;
  plan.bound += deflateBound(manifest) + 30 + 46 + 16 + 12 + 2 * 13;
  if (plan.bytes > cap("total")) throw new ExportStopped(`the files come to more than ${cap("total") / 2 ** 30} GiB, more than an import takes`);
  plan.preflightMs = performance.now() - t0;
  return plan;
}
/** The rows spool's record bytes, counted as they are written (the framing's check: no padding). */
const rowStats = { rowBytes: 0 };
/** Without OPFS, every spool is held in memory: the spools' bounds and the records so far, past CAPS.spoolBlob (P-8). */
const blobSpoolsOver = (plan: Plan, rows: Spool) => plan.cdSpool + plan.manSpool + plan.capSpool + rows.size > cap("spoolBlob");
/** The manifest's head and tail around its entries, at their widest. */
const MANIFEST_ENDS = 512;

/** What the export captured, exactly (astra's E1-R2-A1): per member, its path, kind and identity, as one JSON line in
 * a spool of its own (OPFS or Blob parts, as the others), so the record is exact and the heap stays flat however
 * many entries there are.  The tree check reads back only the lines of the paths it needs. */
export class CaptureLog {
  constructor(readonly spool: Spool) {}
  /** A folder's line, copied from its record (rows.ts R): written into the spool's slice at once; a promise only when
   * the slice is due to be flushed (r2a: at 100,000 entries, an awaited append per line was 92 MiB of short-lived
   * allocation; r2c: no string per line either). */
  addFolder(b: Uint8Array): Promise<void> | undefined { return captureFolder(this.spool, b); }
  /** A captured document's or data file's line, by the direct writer. */
  add(path: string, kind: Entry["kind"], ident: unknown): Promise<void> { return captureLine(this.spool, path, kind, ident); }
  /** The captured kind and identity of each of `paths` that was captured. */
  async lookup(paths: Set<string>): Promise<Map<string, { kind: string; ident: string | null }>> {
    // (the observation boundary: the lines still in the spool's buffer (at most its 1 MiB slice) written out first, here,
    // so that no reader of the log can miss them; lookup is the log's only reader, E1 r2a)
    T().onLookup?.({ chunks: this.spool.chunks, buffered: this.spool.buffered });
    await this.spool.settle();
    const out = new Map<string, { kind: string; ident: string | null }>();
    const dec = new TextDecoder();
    let carry = "";
    for await (const chunk of this.spool.read()) {
      T().captureChunk?.(chunk);
      const text = carry + dec.decode(chunk, { stream: true });
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const l of lines) {
        if (!l) continue;
        const [p, kind, ident] = JSON.parse(l) as [string, string, string | null];
        if (paths.has(p)) out.set(p, { kind, ident });
      }
      { const y = breathe(); if (y) await y; }
    }
    return out;
  }
}
/** A line's length in the capture log, at its widest (preflight's bound). */
const captureLineLen = (e: Entry) => jsonLen(e.path) + jsonLen(e.kind) + (e.ident === undefined ? 4 : jsonLen(e.ident)) + 5;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/** Ops after S0, against the allow-list (E1 r2c §2 rule 1; astra's E1-A1 and E1-R2-A1): a content `write` that kept,
 * exactly as the export captured them, its entry's identity and kind, its folder (by the folder's identity, itself
 * captured as a folder) and its name, and didn't put it in Trash; a dropVersions; an emptyTrash.  Anything else stops
 * the export, naming its path; server-applied ops alike.  Two passes: the ops (any other kind stops at once; the writes
 * kept), then the capture log, read once for just the paths the writes need.  The log's floor is read before and
 * after: ops after S0 pruned meanwhile stop it. */
export async function treeUnchanged(w: Workspace, s0: number, log: CaptureLog, signal: AbortSignal): Promise<void> {
  const trimmed = "the workspace's change log was trimmed while exporting, so the export can't show nothing moved";
  if ((await w.opsFloor()) > s0) throw new ExportStopped(trimmed);
  const stop = (op: Op): never => { throw new ExportStopped(`${op.path}${op.to ? ` (to ${op.to})` : ""}: "${op.op}" while exporting`); };
  const writes: Op[] = [];
  let after = s0;
  for (;;) {
    stopIf(signal);
    const ops: Op[] = await w.opsPage(after, PAGE);
    if (after === s0) await T().duringTreeScan?.();
    for (const op of ops) {
      { const y = breathe(); if (y) await y; }
      if (op.op === "dropVersions" || op.op === "emptyTrash") continue;
      const a = op.after;
      if (op.op !== "write" || !a || a.trashed || a.name !== nameOf(op.path) || a.kind !== op.kind) stop(op);
      writes.push(op);
    }
    if (ops.length < PAGE) break;
    after = ops[ops.length - 1].seq!;
    await pause();
  }
  if ((await w.opsFloor()) > s0) throw new ExportStopped(trimmed);
  if (!writes.length) return;
  const need = new Set<string>();
  for (const op of writes) { need.add(op.path); const p = parentOf(op.path); if (p !== "/") need.add(p); }
  stopIf(signal);
  const got = await log.lookup(need);
  for (const op of writes) {
    const a = op.after!, c = got.get(op.path), parent = parentOf(op.path), pc = got.get(parent);
    const ok = !!c && c.kind === op.kind && c.ident !== null && c.ident === a.id
      && (parent === "/" ? a.parent == null : !!pc && pc.kind === "folder" && pc.ident !== null && pc.ident === a.parent);
    if (!ok) stop(op);
  }
}

export type Result = { name: string; members: number; bytes: number; stampFailed?: string };

/** The sink, chosen on the plan's bound (§5): the picker (opened by the caller, on a click), else OPFS when it has
 * room, else a Blob only up to 256 MiB, else refused. */
export async function chooseSink(plan: Plan, wk: ExportWorker | null, id: string): Promise<Sink> {
  if (wk) {
    const est = await (navigator.storage as any)?.estimate?.().catch(() => undefined);
    if (est && typeof est.quota === "number" && est.quota - est.usage >= plan.bound + plan.cdSpool + plan.manSpool + plan.capSpool) {
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
  try { await worker.ask("removeStale", { lockPrefix: LOCK_PREFIX, pauseMs: T().sweepPauseMs ?? 0 }); await worker.ask("probe", { name: `${id}-probe`, fail: T().failProbe }); return { worker, opfs: true }; } catch { return { worker, opfs: false }; }
}
/** Each export holds the Web Lock LOCK_PREFIX + its id from its start until its last scratch file is removed. */
export const LOCK_PREFIX = "sagebrush-export:";

/**
 * The bundle written and handed over.  `picked`: the picker's writable, opened on the Save… click: owned from here, so
 * any failure, the earliest included, aborts it (astra's E1-A3).  `after(p)`: what must outlive this call (the OPFS
 * scratch's delayed removal), for the caller to keep the worker and the export's lock until it settles.
 */
export async function write(w: Workspace, plan: Plan, opts: { worker: ExportWorker; opfs: boolean; id: string; picked: any | null; signal: AbortSignal; progress: (p: Progress) => void; site: string; app: string; after(p: Promise<void>): void; rows: Spool }): Promise<Result> {
  const t0 = performance.now();
  let sink: Sink | undefined = opts.picked ? new PickerSink(opts.picked) : undefined;
  let committed = false;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const spoolWk = opts.opfs ? opts.worker : null, rows = opts.rows;
  const cd = new Spool(`${opts.id}-cd`, spoolWk, plan.cdSpool, false, opts.signal), man = new Spool(`${opts.id}-manifest`, spoolWk, plan.manSpool, false, opts.signal);
  const capSpool = new Spool(`${opts.id}-capture`, spoolWk, plan.capSpool, false, opts.signal), log = new CaptureLog(capSpool);
  const pace = paceOf(opts.signal);
  let zip: ZipWriter | undefined;
  // (tests: how long the export takes to decide it is stopped after a Cancel, its cleanup apart)
  let abortAt = 0;
  opts.signal.addEventListener("abort", () => { abortAt = performance.now(); }, { once: true });
  sizesNow();
  try {
    if (plan.unavailable.length) throw new ExportStopped(unavailableWhyText(plan.unavailable));
    await cd.open();
    await man.open();
    await capSpool.open();
    if (spoolWk && T().failSpoolAfter) await spoolWk.ask("failAfter", { n: T().failSpoolAfter });
    sink ??= await chooseSink(plan, spoolWk, opts.id);
    let written = 0, files = 0, done = 0, total = 0, first = true, phase: Progress["phase"] = "writing";
    zip = new ZipWriter(sink, cd, { signal: opts.signal, crc: opts.worker, progress: (n) => { written += n; }, slicePause: T().slicePause });
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
    await T().beforeReplay?.();
    if (spoolWk && T().appendDelayMs) await spoolWk.ask("appendDelay", { ms: T().appendDelayMs, re: T().appendDelayRe });
    clockReads = 0;
    let records = 0;
    if (T().cutRows) await rows.cutForTest();
    const dec = new TextDecoder();
    // (r2c §1: the records preflight wrote, segment by segment, each segment whole records; nothing read from
    // IndexedDB again but each document's and data file's own capture)
    for await (const seg of rows.replay()) {
      const n = seg.length;
      for (let at = 0; at < n; ) {
        stopIf(opts.signal);
        { const y = breathe(); if (y) await y; }
        const end = readRow(seg, at, n);
        if (end < 0) cutShort();
        records++;
        if (R[KIND] === 0) {
          // (a folder: its record's bytes copied into the archive, the central record, the capture line and the
          // manifest line; its values as preflight observed them (P-9))
          let p = zip.folderAt(seg, R[NAME], R[NAME + 1], R[TIME], R[DATE]);
          if (p) await p;
          p = log.addFolder(seg);
          if (p) await p;
          p = manifestFolder(man, seg, first);
          if (p) await p;
        } else {
          const e = { path: JSON.parse(dec.decode(seg.subarray(R[PATH], R[PATH + 1]))), kind: KINDS[R[KIND]], ident: R[IDENT] < 0 ? undefined : JSON.parse(dec.decode(seg.subarray(R[IDENT], R[IDENT + 1]))) } as Entry;
          const name = seg.subarray(R[NAME], R[NAME + 1]);
          await T().beforeCapture?.(e.path);
          const c = await timed("capture", () => capture(w, e, opts.signal));
          await T().afterCapture?.(e.path);
          // (nothing is left out: anything not on this device now, though it was at preflight, stops the export)
          if (unavailableWhy(c.entry)) throw new ExportStopped(`${e.path} isn't on this device any more`);
          await log.add(e.path, c.entry.kind, c.entry.ident);
          // (the member's cap, or what is left of the total if that is less: both checked on the bytes as they go)
          const left = cap("total") - total, docCap = capOf(e.kind);
          const max = Math.min(docCap, left), why = left < docCap ? `the export passed ${cap("total") / 2 ** 30} GiB while it was written (files grew meanwhile)` : capWhy(e.path, e.kind);
          const images = new Images();
          let m;
          await T().onMember?.(e.path);
          try {
            const src = memberOf(c.entry, c.content, pace, images);
            const deflate = e.kind === "file" ? await deflates(e.path, e.kind, (src as Uint8Array[])[0]) : true;
            m = await timed("member", () => zip!.member(name, src, deflate, c.entry.updated, max, why));
          } finally { images.dispose(); }
          total += m.usize;
          const got = { rev: c.rev, size: m.usize, sha256: m.sha256! }, f = first;
          await timed("spool", () => manifestLine(man, c.entry, c.at, got, f));
          if (T().reference && (e.kind === "notebook" || e.kind === "board")) {
            const ref = e.kind === "notebook" ? notebookFileText(c.content) : await boardFileText(c.content as BoardDoc, new Images());
            const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(ref)));
            const st = T().stats;
            if (st) (st.refs ??= {})[e.path] = Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
          }
          files++;
        }
        first = false;
        done++;
        tick("writing");
        { const h = T().between; if (h) await h(zip.members); }
        // (grader's C8: a known long task, which the long-task observer must see)
        const busy = T().busyMs;
        if (busy && done === 1) { const t = performance.now(); while (performance.now() - t < busy) {} }
        at = end;
      }
    }
    { const st = T().stats; if (st) { st.records = records; st.clockReads = clockReads; } }
    // (rule 1: nothing in the tree moved since S0)
    await treeUnchanged(w, plan.s0, log, opts.signal);
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
    if (st) { st.spoolChunks = cd.chunks + man.chunks + capSpool.chunks; st.members = zip.members; }
    return r;
  } catch (e) {
    { const st = T().stats; if (st && abortAt) st.stopMs = performance.now() - abortAt; }
    if (!committed) await sink?.abort();
    throw e;
  } finally {
    clearInterval(progressTimer);
    await cd.remove();
    await man.remove();
    await capSpool.remove();
    await rows.remove();
    const st = T().stats;
    if (st) {
      st.flushes = { cd: cd.chunks, manifest: man.chunks, capture: capSpool.chunks, rows: rows.chunks };
      st.sizes = { cd: cd.size, manifest: man.size, capture: capSpool.size, rows: rows.size };
      st.waits = { archive: zip?.waits ?? 0, cd: cd.waits, manifest: man.waits, capture: capSpool.waits, rows: rows.waits };
      st.sink = sink?.constructor?.name;
      st.rowSegs = rows.segs.slice(); st.rowBytes = rowStats.rowBytes; st.rowSize = rows.size;
      st.slices = counts.slices; st.sliceBytes = counts.sliceBytes; st.blobBytes = counts.blobBytes; st.blobReadBytes = counts.blobReadBytes;
      st.hashCopyBytes = counts.hashCopyBytes; st.slicesAfterStop = counts.afterStop; st.postsAfterStop = counts.postsAfterStop;
      st.preflightMs = plan.preflightMs; st.writingMs = performance.now() - t0;
    }
  }
}

export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export { ExportStopped, ExportWorker, SLICE, Spool };

/** (tests only: the writer's own test, r2c §2) the direct writer against JSON.stringify and TextEncoder, in this
 * browser: each string as JSON and as UTF-8, each number as JSON, and each entry's record (written, counted, read
 * back) and its capture and manifest lines, a folder's copied from its record, against manifestEntry and the
 * capture line JSON.stringify makes.  The mismatches, as [what, mine, theirs]. */
export async function writerCheck(strings: string[], numbers: number[], entries: Entry[]): Promise<[string, string, string][]> {
  const bad: [string, string, string][] = [];
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const buf = new Uint8Array(1 << 16);
  const { putJson, putUtf8, putNum, jsonLen, utf8Len, numLen } = await import("./bytes");
  for (const s of strings) {
    let a = hex(buf.subarray(0, putJson(buf, 0, s))), b = hex(enc.encode(JSON.stringify(s)));
    if (a !== b) bad.push(["json " + JSON.stringify(s), a, b]);
    if (jsonLen(s) !== b.length / 2) bad.push(["jsonLen " + JSON.stringify(s), String(jsonLen(s)), String(b.length / 2)]);
    a = hex(buf.subarray(0, putUtf8(buf, 0, s))); b = hex(enc.encode(s));
    if (a !== b) bad.push(["utf8 " + JSON.stringify(s), a, b]);
    if (utf8Len(s) !== b.length / 2) bad.push(["utf8Len " + JSON.stringify(s), String(utf8Len(s)), String(b.length / 2)]);
  }
  for (const n of numbers) {
    const a = new TextDecoder().decode(buf.subarray(0, putNum(buf, 0, n))), b = JSON.stringify(n);
    if (a !== b) bad.push(["num " + String(n), a, b]);
    if (numLen(n) !== b.length) bad.push(["numLen " + String(n), String(numLen(n)), String(b.length)]);
  }
  const text = async (s: Spool) => { await s.settle(); let t = ""; for await (const c of s.read()) t += new TextDecoder().decode(c); return t; };
  for (const e of entries) {
    const captured = 1761900000123;
    const rows = new Spool("check-rows", null, Number.MAX_SAFE_INTEGER, true), log = new Spool("check-cap", null, Number.MAX_SAFE_INTEGER), man = new Spool("check-man", null, Number.MAX_SAFE_INTEGER);
    try {
      const p = putRow(rows, e, captured, { rowBytes: 0 });
      if (p) await p;
      await rows.settle();
      const got = { rev: 7, size: 12, sha256: "ab".repeat(32) };
      for await (const seg of rows.read()) {
        const end = readRow(seg, 0, seg.length);
        if (end !== seg.length) { bad.push(["record " + e.path, String(end), String(seg.length)]); continue; }
        const name = new TextDecoder().decode(seg.subarray(R[NAME], R[NAME + 1])), wantName = "files/" + e.path.slice(1) + (e.kind === "folder" ? "/" : "");
        if (hex(seg.subarray(R[NAME], R[NAME + 1])) !== hex(enc.encode(wantName))) bad.push(["name " + e.path, name, wantName]);
        if (e.kind === "folder") {
          const q = captureFolder(log, seg); if (q) await q;
          const r = manifestFolder(man, seg, true); if (r) await r;
        } else {
          await captureLine(log, e.path, e.kind, e.ident);
          await manifestLine(man, e, captured, got, true);
        }
      }
      const capWant = JSON.stringify([e.path, e.kind, e.ident ?? null]) + "\n", manWant = e.kind === "folder" ? manifestEntry(e, captured) : manifestEntry(e, captured, got);
      const capGot = await text(log), manGot = await text(man);
      if (capGot !== capWant) bad.push(["capture " + e.path, capGot, capWant]);
      if (manGot !== manWant) bad.push(["manifest " + e.path, manGot, manWant]);
    } catch (err) { bad.push(["threw " + e.path, String(err), ""]); }
  }
  return bad;
}
