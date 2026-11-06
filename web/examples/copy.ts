// An example, copied into the workspace: the one copy path (plan-examples-gallery A1-A3), for the Examples… panel
// (panel.ts), the ?example= link and WebMCP's open_example (PR 4), which call copyExample unchanged.
//
// A1, before anything is written: the id is one the catalog names; its files.json is the one the catalog names (its
// sha256); every path is a strict relative path, no two the same once case-folded and NFC, no file also a folder,
// main among them and of the example's kind; at most 40 files and 2 MiB; the bytes come from the example's ZIP (the
// same origin, no redirect followed), each member named exactly as files.json lists it, in its order, its sha256
// the one listed; a notebook and a board parse as what they are.
// A2: a new folder, /Examples/<title> (or "<title> (2)", ...): made by mkdir, never one that's there already. Then
// each folder and file in it made by mkdir or create only (never write), each with an `admit` that, holding the
// workspace's lock in the same step as the creation, checks that nothing is at the path yet and that the root and
// every folder between it and the new entry are still the ones this copy made (the same fid at the same path). Any
// check failing stops the copy there: what was copied stays, under its name, and the error says it's incomplete.
// A3: create() makes every document "elsewhere"; the conversions are upload's own (fromFile, boardJson): a
// notebook's .ipynb becomes a notebook, a .board.json a board, anything else a data file (an older board, a .json or
// .md, opens as a board from there, as an uploaded one does).
import type { AdmitCheck, Entry, Workspace } from "../workspace/api";
import { boardJson } from "../workspace/upload";
import { fromFile } from "../notebook/ipynb.js";
import { join, kindOf, nameOf, safeName } from "../workspace/paths";

export const ID = /^(notebook|board|latex)\/[a-z0-9]+(-[a-z0-9]+)*$/;
export const LIMITS = { files: 40, depth: 4, bytes: 2 * 1024 * 1024, filesJson: 64 * 1024 };
const SEGMENT = /^[A-Za-z0-9._ -]{1,64}$/;
const MAIN: Record<string, RegExp> = { notebook: /\.ipynb$/, board: /\.(board\.json|json|md)$/, latex: /\.tex$/ };

export type CatalogEntry = { id: string; kind: string; title: string; summary?: string; tags?: string[]; mode?: string; main: string; files_sha256: string; url?: string };
export type Catalog = { examples: CatalogEntry[] };
export type ExampleFile = { path: string; bytes: Uint8Array };

/** Why an example can't be copied: "unknown" (not in the catalog), "invalid" (A1), "fetch" (the network), "stopped"
 * (A2: the copy stopped, `copied` says what is there). */
export class ExampleError extends Error {
  constructor(public code: "unknown" | "invalid" | "fetch" | "stopped", message: string, public copied?: { root: string; made: string[] }) {
    super(message);
  }
}
const invalid = (m: string) => new ExampleError("invalid", m);

/** A path's problem (A1, scripts/examples-lib.mjs pathProblem's rules), or null. */
export function pathProblem(p: unknown): string | null {
  if (typeof p !== "string" || p === "") return "not a path";
  if (p !== p.normalize("NFC")) return "not NFC";
  if (/^[/\\]/.test(p) || p.includes("\\") || /%[0-9a-f]{2}/i.test(p)) return "absolute, a backslash or an escape";
  const segs = p.split("/");
  if (segs.length > LIMITS.depth) return `deeper than ${LIMITS.depth}`;
  for (const s of segs) if (!SEGMENT.test(s) || s === "." || s === ".." || s.startsWith(".")) return `segment ${JSON.stringify(s)}`;
  return null;
}

type FilesJson = { id: string; main: string; files: { path: string; bytes: number; sha256: string; encoding?: string }[] };

/** files.json's problems against its catalog entry (A1), [] when there are none. */
export function filesProblems(fj: any, entry: CatalogEntry): string[] {
  const p: string[] = [];
  if (!fj || typeof fj !== "object" || !Array.isArray(fj.files)) return ["files.json is not {id, main, files}"];
  if (fj.id !== entry.id) p.push(`files.json is ${JSON.stringify(fj.id)}'s, not ${entry.id}'s`);
  if (!fj.files.length || fj.files.length > LIMITS.files) p.push(`1 to ${LIMITS.files} files`);
  const folded = new Set<string>();
  let total = 0;
  for (const f of fj.files) {
    if (!f || typeof f !== "object") {
      p.push("a file that isn't {path, bytes, sha256}");
      continue;
    }
    const why = pathProblem(f.path);
    if (why) p.push(`${JSON.stringify(f.path)}: ${why}`);
    const k = String(f.path).normalize("NFC").toLowerCase();
    if (folded.has(k)) p.push(`${JSON.stringify(f.path)}: the same as another, by case or Unicode`);
    folded.add(k);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) p.push(`${JSON.stringify(f.path)}: its size`);
    else total += f.bytes;
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) p.push(`${JSON.stringify(f.path)}: its sha256`);
  }
  for (const f of fj.files) if (fj.files.some((g: any) => typeof g?.path === "string" && typeof f?.path === "string" && g.path.toLowerCase().startsWith(f.path.toLowerCase() + "/"))) p.push(`${JSON.stringify(f.path)}: both a file and a folder`);
  if (total > LIMITS.bytes) p.push(`${total} bytes, more than ${LIMITS.bytes}`);
  if (fj.main !== entry.main || !fj.files.some((f: any) => f?.path === fj.main)) p.push("main isn't one of its files, or isn't the catalog's");
  else if (!MAIN[entry.kind]?.test(fj.main)) p.push(`main isn't a ${entry.kind}'s file`);
  return p;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** A same-origin fetch of at most `max` bytes, no redirect followed (A1). */
async function fetchBounded(url: string, max: number, o: { fetch: typeof fetch; signal?: AbortSignal }): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await o.fetch(url, { redirect: "error", credentials: "same-origin", signal: o.signal });
  } catch (e) {
    throw new ExampleError("fetch", `${url}: ${(e as Error)?.message ?? e}`);
  }
  if (!res.ok || res.redirected || (res.type !== "basic" && res.type !== "default")) throw new ExampleError("fetch", `${url}: ${res.status} ${res.type}`);
  const said = Number(res.headers.get("content-length") ?? NaN);
  if (said > max) throw invalid(`${url}: ${said} bytes, more than ${max}`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw invalid(`${url}: more than ${max} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

/** What the decompressor gave for the last member inflated: bytes read from it, before the read stopped (the tests'
 * check that a member claiming a small size is never inflated past it: astra's A1-ZIP-1). */
export const inflated = { bytes: 0 };

/** A deflated member, inflated a chunk at a time: the reading stops, and the decompressor is cancelled, as soon as it
 * gives more than `size` bytes (the size its header says, already counted against the whole ZIP's bound). */
async function inflateRaw(data: Uint8Array, size: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const out = new Uint8Array(size);
  let n = 0;
  inflated.bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      inflated.bytes += value.length;
      if (n + value.length > size) throw invalid("a ZIP member inflates past the size its header says");
      out.set(value, n);
      n += value.length;
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e instanceof ExampleError) throw e;
    throw invalid(`a ZIP member doesn't inflate: ${(e as Error)?.message ?? e}`);
  }
  if (n !== size) throw invalid("a ZIP member's size isn't what its header says");
  return out;
}

/** A ZIP's members, in order (the form web/build-examples.ts writes: local headers, stored or deflated, sizes in the
 * header); at most `max` bytes unpacked in all. */
export async function unzip(z: Uint8Array, max: number): Promise<ExampleFile[]> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength), out: ExampleFile[] = [];
  let i = 0, total = 0;
  while (i + 30 <= z.length && v.getUint32(i, true) === 0x04034b50) {
    const flags = v.getUint16(i + 6, true), method = v.getUint16(i + 8, true), csize = v.getUint32(i + 18, true), usize = v.getUint32(i + 22, true);
    const nlen = v.getUint16(i + 26, true), xlen = v.getUint16(i + 28, true);
    if (flags & 0x0008) throw invalid("a ZIP member without its sizes in its header");
    total += usize;
    if (total > max) throw invalid(`the ZIP unpacks to more than ${max} bytes`);
    const start = i + 30 + nlen + xlen;
    if (start + csize > z.length) throw invalid("a ZIP member past its end");
    const path = new TextDecoder("utf-8", { fatal: true }).decode(z.subarray(i + 30, i + 30 + nlen));
    const data = z.subarray(start, start + csize);
    const bytes = method === 0 ? (csize === usize ? data.slice() : (() => { throw invalid("a stored member's sizes differ"); })()) : method === 8 ? await inflateRaw(data, usize) : (() => { throw invalid("a ZIP member neither stored nor deflated"); })();
    out.push({ path, bytes });
    i = start + csize;
  }
  return out;
}

/** An example's files, fetched and checked (A1): nothing is written. */
export async function fetchExample(id: string, o: { catalog: Catalog; base?: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<{ entry: CatalogEntry; files: ExampleFile[] }> {
  const entry = ID.test(id) ? o.catalog.examples.find((e) => e.id === id) : undefined;
  if (!entry) throw new ExampleError("unknown", `${JSON.stringify(id)} is not an example`);
  const base = o.base ?? "/examples/", f = { fetch: o.fetch ?? globalThis.fetch.bind(globalThis), signal: o.signal };
  const fjBytes = await fetchBounded(`${base}${id}/files.json`, LIMITS.filesJson, f);
  if ((await sha256(fjBytes)) !== entry.files_sha256) throw invalid(`${id}: its files.json isn't the one the catalog names`);
  let fj: FilesJson;
  try {
    fj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fjBytes));
  } catch {
    throw invalid(`${id}: files.json isn't JSON`);
  }
  const bad = filesProblems(fj, entry);
  if (bad.length) throw invalid(`${id}: ${bad.slice(0, 4).join("; ")}`);
  const slug = id.split("/")[1];
  const members = await unzip(await fetchBounded(`${base}${id}/${slug}.zip`, LIMITS.bytes + 64 * 1024, f), LIMITS.bytes);
  if (members.length !== fj.files.length || members.some((m, i) => m.path !== fj.files[i].path)) throw invalid(`${id}: the ZIP's members aren't files.json's files, in its order`);
  for (const [i, m] of members.entries()) {
    const want = fj.files[i];
    if (m.bytes.length !== want.bytes || (await sha256(m.bytes)) !== want.sha256) throw invalid(`${id}: ${m.path}: not the bytes files.json names`);
    const text = () => new TextDecoder("utf-8", { fatal: true }).decode(m.bytes);
    try {
      if (kindOf(m.path) === "notebook") fromFile(nameOf(m.path), text(), entry.mode ?? "python");
      else if (kindOf(m.path) === "board") boardJson(text());
    } catch (e) {
      throw invalid(`${id}: ${m.path}: ${(e as Error)?.message ?? e}`);
    }
  }
  return { entry, files: members };
}

class Taken extends Error {}

/**
 * An example copied into the workspace (A1-A3): its files checked, then a new folder `/Examples/<title>[ (n)]` made
 * and every file created in it, each creation checking, holding the lock, that the folders it goes into are the ones
 * this copy made. Returns the folder, every entry made and main's (open it only now: the last file is written).
 */
// (`progress`: called, and awaited, between creations, never holding the workspace's lock)
export async function copyExample(ws: Workspace, id: string, o: { catalog: Catalog; base?: string; fetch?: typeof fetch; signal?: AbortSignal; folder?: string; progress?(made: number, of: number): void | Promise<void> }): Promise<{ root: string; made: Entry[]; main: Entry }> {
  const { entry, files } = await fetchExample(id, o);
  // (each file's contents as create() takes them, converted as upload converts: before anything is made)
  const contents = files.map((f) => {
    const kind = kindOf(f.path), text = () => new TextDecoder().decode(f.bytes);
    return kind === "notebook" ? fromFile(nameOf(f.path), text(), entry.mode ?? "python") : kind === "board" ? boardJson(text()) : f.bytes;
  });
  const folder = o.folder ?? "/Examples", name = safeName(entry.title, 120);
  // the root: made new, never one that's there
  let root = "", rootEntry: Entry | undefined;
  for (let n = 1; n <= 1000 && !rootEntry; n++) {
    root = join(folder, n === 1 ? name : `${name} (${n})`);
    try {
      rootEntry = await ws.mkdir(root, { admit: (c: AdmitCheck) => { if (c.entry) throw new Taken(); } });
    } catch (e) {
      if (!(e instanceof Taken)) throw e;
    }
  }
  if (!rootEntry?.fid) throw new ExampleError("stopped", `no free name for "${name}" in ${folder}`);
  const ours = new Map<string, string>([[root, rootEntry.fid]]);
  const made: Entry[] = [rootEntry];
  const stop = (why: string) => new ExampleError("stopped", `${why}: the copy stopped; ${root} is incomplete (${made.length - 1} of ${files.length} files)`, { root, made: made.map((e) => e.path) });
  // (holding the lock, in the step that makes `c.path`: nothing there yet, and every folder of ours above it the one we made)
  const guard = (c: AdmitCheck) => {
    if (c.entry) throw stop(`${c.path} is there already`);
    for (const [p, fid] of ours)
      if (c.path.startsWith(p + "/") && c.chain.find((e) => e.path === p)?.fid !== fid) throw stop(`${p} was moved or replaced`);
  };
  try {
    const dirs = [...new Set(files.flatMap((f) => f.path.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))))].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
    for (const d of dirs) {
      const e = await ws.mkdir(join(root, d), { admit: guard });
      if (!e.fid) throw stop(`${e.path} has no id`);
      ours.set(e.path, e.fid);
      made.push(e);
    }
    let main: Entry | undefined;
    for (const [i, f] of files.entries()) {
      const p = join(root, f.path);
      const e = await ws.create(p, { content: contents[i], ...(kindOf(p) === "notebook" && entry.mode ? { mode: entry.mode } : {}), signal: o.signal, admit: guard });
      made.push(e);
      if (f.path === entry.main) main = e;
      await o.progress?.(i + 1, files.length);
    }
    // (main is set: filesProblems checked it is one of the files, and every file was created)
    return { root, made, main: main! };
  } catch (e) {
    if (e instanceof ExampleError) throw e;
    throw stop(String((e as Error)?.message ?? e));
  }
}

