// "Export all current files (.zip)": export plan E1 r2c (frozen 5467a038), the Storage panel's export.  This module
// and the writer (zip.ts) are the lazy chunk sagebrush-export.js; its worker is sagebrush-export-worker.js.
//   preflight(): S0 (the op log's last seq) first; the entries paged in path order; every document serialized once
//     and measured, every cap checked; contents that aren't on this device listed; the bound for the sink and the
//     spool's size.  It writes nothing.
//   write(): the members in path order, each captured in one locked read and checked against its identity, its bytes
//     those Download writes (file-bytes.ts); every cap checked again on the actual output; then the op log after S0
//     against the allow-list (§2 rule 1); then manifest.json, the last member; the central directory; the end
//     records; the sink closed; only then "Last export prepared" (§5a).  Any failure: the sink aborted, the scratch
//     removed, the status line untouched.
import type { Entry, Op, Workspace } from "../api";
import type { BoardDoc } from "../../board/doc";
import { Images } from "../../board/images";
import { BlobSink, ExportStopped, ExportWorker, OpfsSink, PickerSink, SLICE, Spool, ZipWriter, type Sink } from "./zip";

/** What the page gives this chunk, from its own bundle, so the chunk carries no second copy of the workspace or the
 * serializers: Download's own functions (file-bytes.ts), how a "missing" read looks, the data-file cap, Trash. */
export type Kit = {
  notebookFileText(doc: any): string;
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
};
const T = (): TestHooks => ((globalThis as any).__SB_EXPORT_TEST__ as TestHooks | undefined) ?? {};
const cap = (k: keyof typeof CAPS) => T().caps?.[k] ?? CAPS[k];

const enc = new TextEncoder();
const pause = () => new Promise<void>((r) => setTimeout(r, 0));
/** A yield to the event loop once 8 ms of work have passed since the last one: the loops over entries call it per
 * entry, so no task runs long however the awaits inside resolve (E1 r2c §6: at most 50 ms a task). */
let lastYield = 0;
const breathe = async () => { if (performance.now() - lastYield > 8) { await pause(); lastYield = performance.now(); } };
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

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
  /** the spool's bound (central records and manifest entries) */
  spool: number;
  unavailable: Unavailable[];
};
export type Progress = { phase: "preflight" | "writing" | "finishing"; files: number; of: number; bytes: number; total: number };

/** Every current entry outside Trash, page by page, in path order. */
async function* entries(w: Workspace): AsyncGenerator<Entry[]> {
  let after: string | null = null;
  for (;;) {
    const rows = await w.entriesPage(after, PAGE);
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

/** A document's or data file's bytes, as Download gives them, from a captured read. */
async function bytesOf(e: Entry, content: any): Promise<Uint8Array> {
  if (e.kind === "notebook") return enc.encode(K.notebookFileText(content));
  if (e.kind === "board") {
    const images = new Images();
    try { return enc.encode(await K.boardFileText(content, images)); } finally { images.dispose(); }
  }
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  throw new ExportStopped(`${e.path}: its bytes are in a form the export doesn't know`);
}
const capOf = (kind: Entry["kind"]) => (kind === "notebook" || kind === "board" ? cap("doc") : cap("file"));
const capWhy = (path: string, kind: Entry["kind"]) => kind === "notebook" || kind === "board"
  ? `${path} is larger than ${cap("doc") / 2 ** 20} MiB as a file, more than an import takes: it can't be exported`
  : `${path} is larger than ${Math.floor(cap("file") / 2 ** 20)} MiB: it can't be exported`;

/** An entry whose contents aren't in this browser (found at its read). */
export class Missing extends ExportStopped {}

/** The read that captures one entry (E1 r2c §2 rule 2): its identity, kind and path as enumerated, or stopped. */
async function capture(w: Workspace, e: Entry): Promise<{ entry: Entry; content: any; rev: number; at: number }> {
  let r;
  try {
    r = await w.readLocked(e.path);
  } catch (err) {
    // (nothing at its path any more: it was moved, renamed or deleted since it was listed; there, but its contents
    // not in this browser: missing)
    if (!(await w.stat(e.path).catch(() => undefined))) throw new ExportStopped(`${e.path} was moved, renamed or deleted while exporting`);
    if (K.isMissing(err)) throw new Missing(`${e.path}: ${(err as Error).message}`);
    throw err;
  }
  const at = Date.now();
  if (r.entry.kind !== e.kind || r.entry.ident !== e.ident || r.entry.path !== e.path) throw new ExportStopped(`${e.path} changed while exporting (it is another ${r.entry.kind} now)`);
  return { ...r, at };
}

export async function preflight(w: Workspace, signal: AbortSignal, progress: (p: Progress) => void): Promise<Plan> {
  const s0 = await w.lastSeq();
  const plan: Plan = { s0, files: 0, folders: 0, bytes: 0, bound: 98, spool: 0, unavailable: [] };
  let manifest = 512, lastPre = 0;
  for await (const page of entries(w)) {
    for (const e of page) {
      if (signal.aborted) throw new ExportStopped("cancelled");
      await breathe();
      const name = utf8Len(e.path) + 5 + (e.kind === "folder" ? 1 : 0);
      const why = unavailableWhy(e);
      if (why) { plan.unavailable.push({ path: e.path, kind: e.kind, why }); continue; }
      const me = manifestEntryLen(e, Date.now()) + 1;
      manifest += me;
      plan.spool += 46 + 12 + name + me;
      plan.bound += 30 + 46 + 16 + 12 + 2 * name;
      if (e.kind === "folder") { plan.folders++; continue; }
      plan.files++;
      let size: number;
      if (e.kind === "file") size = e.size ?? 0;
      else {
        // (a document serialized once, to measure it, then let go)
        let c;
        try { c = await capture(w, e); } catch (err) {
          if (err instanceof Missing) { plan.unavailable.push({ path: e.path, kind: e.kind, why: "missing" }); continue; }
          throw err;
        }
        size = (await bytesOf(e, c.content)).length;
      }
      if (size > capOf(e.kind)) throw new ExportStopped(capWhy(e.path, e.kind));
      plan.bytes += size;
      plan.bound += deflateBound(size);
      if (performance.now() - lastPre > 100) { lastPre = performance.now(); progress({ phase: "preflight", files: plan.files, of: 0, bytes: plan.bytes, total: 0 }); }
      if (plan.bytes > cap("total")) throw new ExportStopped(`the files come to more than ${cap("total") / 2 ** 30} GiB, more than an import takes`);
    }
  }
  plan.spool += manifest;
  if (manifest > cap("manifest")) throw new ExportStopped(`the export's index (manifest.json) would be over ${cap("manifest") / 2 ** 20} MiB: too many files with long names`);
  plan.bytes += manifest;
  plan.bound += deflateBound(manifest) + 30 + 46 + 16 + 12 + 2 * 13;
  if (plan.bytes > cap("total")) throw new ExportStopped(`the files come to more than ${cap("total") / 2 ** 30} GiB, more than an import takes`);
  return plan;
}

/** Ops after S0, against the allow-list (E1 r2c §2 rule 1): a content `write` that keeps its entry's name and doesn't
 * put it in Trash, a dropVersions, an emptyTrash.  Anything else stops the export, naming its path. */
export async function treeUnchanged(w: Workspace, s0: number): Promise<void> {
  if ((await w.opsFloor()) > s0) throw new ExportStopped("the workspace's change log was trimmed while exporting, so the export can't show nothing moved");
  let after = s0;
  for (;;) {
    const ops: Op[] = await w.opsPage(after, PAGE);
    for (const op of ops) {
      await breathe();
      const ok = op.op === "dropVersions" || op.op === "emptyTrash"
        || (op.op === "write" && !!op.after && !op.after.trashed && op.after.name === nameOf(op.path) && op.after.kind === op.kind);
      if (!ok) throw new ExportStopped(`${op.path}${op.to ? ` (to ${op.to})` : ""}: "${op.op}" while exporting`);
    }
    if (ops.length < PAGE) return;
    after = ops[ops.length - 1].seq!;
    await pause();
  }
}

export type Choice = { partial: boolean };
export type Result = { name: string; members: number; bytes: number; partial: boolean; omitted: number };

/** The sink, chosen on the plan's bound (§5): the picker (opened by the caller, on a click), else OPFS when it has
 * room, else a Blob only up to 256 MiB, else refused. */
export async function chooseSink(plan: Plan, wk: ExportWorker | null, picked: any | null, id: string): Promise<{ sink: Sink; kind: "picker" | "opfs" | "blob" }> {
  if (picked) return { sink: new PickerSink(picked), kind: "picker" };
  if (wk) {
    const est = await (navigator.storage as any)?.estimate?.().catch(() => undefined);
    if (est && typeof est.quota === "number" && est.quota - est.usage >= plan.bound + plan.spool) {
      const file = `${id}-out.zip`;
      const s = new OpfsSink(wk, file, async () => (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("sagebrush-export")).getFileHandle(file)).getFile(), T().onHand ?? undefined);
      await s.open();
      return { sink: s, kind: "opfs" };
    }
  }
  if (plan.bound <= cap("blob")) return { sink: new BlobSink(cap("blob"), T().onHand ?? undefined), kind: "blob" };
  throw new ExportStopped(`this export can be up to ${Math.ceil(plan.bound / 2 ** 20)} MiB, and this browser can't save a file that large here: use a browser that can save files (Chrome, Edge, or the desktop app)`);
}

/** The worker (the CRC's, always), and whether OPFS gives it a usable scratch file (§6): an earlier export's leftover
 * scratch removed first. */
export async function startWorker(url: string): Promise<{ worker: ExportWorker; opfs: boolean; id: string }> {
  const worker = new ExportWorker(new Worker(url, { type: "module" })), id = crypto.randomUUID();
  if (T().noOpfs) return { worker, opfs: false, id };
  // (this export's scratch files are named by its id: another tab's export, running, keeps its own; the leftovers of
  // one that ended without cleaning up are removed, and a file still open in another tab refuses removal)
  try { await worker.ask("removeStale"); await worker.ask("probe", { name: `${id}-probe` }); return { worker, opfs: true, id }; } catch { return { worker, opfs: false, id }; }
}

export async function write(w: Workspace, plan: Plan, choice: Choice, opts: { worker: ExportWorker; opfs: boolean; id: string; picked: any | null; signal: AbortSignal; progress: (p: Progress) => void; site: string; app: string }): Promise<Result> {
  if (plan.unavailable.length && !choice.partial) throw new ExportStopped(`${plan.unavailable.length} files aren't on this device`);
  if (!opts.opfs && plan.spool > cap("spoolBlob")) throw new ExportStopped("This browser can't hold the export's index; use a browser that can save files, or export a smaller workspace");
  const spoolWk = opts.opfs ? opts.worker : null;
  const cd = new Spool(`${opts.id}-cd`, spoolWk, plan.spool), man = new Spool(`${opts.id}-manifest`, spoolWk, plan.spool);
  let sink: Sink | undefined;
  let finished = false;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await cd.open();
    await man.open();
    const s = await chooseSink(plan, opts.opfs ? opts.worker : null, opts.picked, opts.id);
    sink = s.sink;
    let written = 0, files = 0, done = 0, total = 0, first = true, phase: Progress["phase"] = "writing";
    const zip = new ZipWriter(sink, cd, { signal: opts.signal, crc: opts.worker, progress: (n) => { written += n; }, slicePause: T().slicePause });
    const omitted: Unavailable[] = [];
    // (progress: the files and folders written and the archive's bytes so far, its index included; at most every 100
    // ms from the loop, and every 200 ms from a timer too, so a wait on storage or the index's writing still shows
    // (E1 r2c §6: at least every 250 ms while bytes move); never an object and a string per entry)
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
    progressTimer = setInterval(() => tick(phase, true), 200);
    for await (const page of entries(w)) {
      for (const e of page) {
        if (opts.signal.aborted) throw new ExportStopped("cancelled");
        await breathe();
        const why = unavailableWhy(e);
        if (why) {
          // (only an explicit partial export leaves anything out: one that wasn't, finding a file gone from this
          // device since preflight, stops)
          if (!choice.partial) throw new ExportStopped(`${e.path} isn't on this device any more`);
          omitted.push({ path: e.path, kind: e.kind, why });
          continue;
        }
        let line: string;
        if (e.kind === "folder") {
          await zip.folder(zipName(e), e.updated);
          line = manifestEntry(e, Date.now());
        } else {
          await T().beforeCapture?.(e.path);
          const c = await capture(w, e);
          await T().afterCapture?.(e.path);
          const bytes = await bytesOf(c.entry, c.content);
          if (bytes.length > capOf(e.kind)) throw new ExportStopped(capWhy(e.path, e.kind));
          if (total + bytes.length > cap("total")) throw new ExportStopped(`the export passed ${cap("total") / 2 ** 30} GiB while it was written (files grew meanwhile)`);
          total += bytes.length;
          const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
          await zip.member(zipName(e), [bytes], await deflates(e.path, e.kind, bytes), c.entry.updated, capOf(e.kind), capWhy(e.path, e.kind));
          line = manifestEntry(c.entry, c.at, { rev: c.rev, size: bytes.length, sha256 });
          files++;
        }
        if (!first) await man.appendText(",");
        await man.appendText(line);
        first = false;
        done++;
        tick("writing");
        await T().between?.(zip.members);
      }
    }
    // (rule 1: nothing in the tree moved since S0)
    await treeUnchanged(w, plan.s0);
    tick("finishing", true);
    // (§5a: created right before the manifest is serialized; the manifest is the last member)
    const created = new Date().toISOString();
    const head = enc.encode(JSON.stringify({ format: "sagebrush-workspace-bundle", version: 1, mode: "files", created, site: opts.site, app: opts.app }).slice(0, -1) + ',"entries":[');
    const tail = enc.encode("]," + JSON.stringify({ omitted, totals: { files, folders: plan.folders, bytes: total } }).slice(1));
    const left = cap("total") - total;
    async function* manifest() { yield head; for await (const s of man.replay()) yield s; yield tail; }
    await zip.member("manifest.json", manifest(), true, Date.now(), Math.min(cap("manifest"), left), `the export's index (manifest.json) passed ${cap("manifest") / 2 ** 20} MiB, or the export passed ${cap("total") / 2 ** 30} GiB, while it was written`);
    await zip.finish();
    const name = `sagebrush-${localDate()}${omitted.length ? "-partial" : ""}.zip`;
    await sink.close(name);
    finished = true;
    const at = Date.now();
    const r: Result = { name, members: zip.members, bytes: zip.offset, partial: omitted.length > 0, omitted: omitted.length };
    await w.setLastExport({ at, partial: r.partial, members: r.members, bytes: r.bytes });
    const st = T().stats;
    if (st) { st.spoolChunks = cd.chunks + man.chunks; st.members = zip.members; }
    return r;
  } catch (e) {
    if (!finished) await sink?.abort();
    throw e;
  } finally {
    clearInterval(progressTimer);
    await cd.remove();
    await man.remove();
  }
}

export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export { ExportStopped, ExportWorker, SLICE };
