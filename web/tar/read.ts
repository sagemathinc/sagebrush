// A strict, bounded reader for arXiv's source downloads (design/arxiv-proxy.md §4): a gzipped tar, or a single
// gzipped file. Pure TypeScript with no DOM, so it runs in a Worker and in tests; nothing imports it yet (the arXiv
// page, a later change, will). Nothing the archive declares is trusted, and every refusal is a TarError (errors.ts).
//
//   const x = new SourceExtractor();
//   for each chunk of the download: x.push(chunk);
//   const result = x.end();
//
// What it does:
//   - counts every compressed byte against the download cap and hashes it (the tarball's SHA-256, incrementally);
//   - inflates through the bounded inflater (inflate.ts), whose caps (total and ratio) apply to every output byte;
//   - decides the shape from the first 512 output bytes: a valid tar header (its checksum matches; ustar, GNU or v7)
//     means a tar, anything else a single file, kept as `main.tex` only if it is TeX text;
//   - reads the tar block by block: every header, kept or skipped, is checked and counted; regular files and
//     directories are kept, everything else is skipped and listed; pax `x` (only `path` and `size`) and GNU `L`
//     (a long name) apply to the next entry only, and two in a row refuse; `g` is ignored; sparse entries refuse;
//   - checks every kept name (NFC, no `..`, nothing absolute, within the workspace's bounds), refuses duplicates
//     (two names with the same NFC form are the same name here, so lookalikes are duplicates) and a file that is
//     also a folder, and counts every entry the import would create, implicit folders included;
//   - requires the gzip trailer, the tar end marker, and only zero bytes after it.
//
// Memory (LIMITS L1): every allocation is counted before it is made, by its full capacity: a kept file's exact size
// (from its checked header), a pax or GNU long-name payload (bounded before allocation), and for the single-file
// shape each 1 MiB chunk and the final join. The fixed buffers (the inflater's slab and windows, the header blocks)
// are counted from the start. `peak` is the most ever counted. This is accounting of payload and buffers only, not a
// whole-process figure: entry objects, paths and parser state come on top, bounded by the entry caps, and the
// workspace's own admission still applies when the files are written.

import { Sha256 } from "../workspace/export/sha256.ts";
import { MAX_DEPTH, MAX_NAME, MAX_PATH } from "../workspace/paths.ts";
import { TarError } from "./errors.ts";
import { GzipInflater, INPUT_WINDOW, SLAB, WINDOW } from "./inflate.ts";
import { isTexText } from "./main-file.ts";

export { TarError } from "./errors.ts";

const MiB = 2 ** 20;
const BLOCK = 512;
/** The fixed buffers: the inflater's output slab, back-reference window and input window, and two 512-byte blocks
 * (the tar header being read, and the first output block the shape is decided from). */
export const FIXED_BYTES = SLAB + WINDOW + INPUT_WINDOW + 2 * BLOCK;

export interface Caps {
  /** compressed bytes */
  download: number;
  /** decompressed bytes, every one (headers, padding, skipped data, the end marker and what follows it) */
  total: number;
  /** one kept file's bytes (a tar member, or the single file) */
  perFile: number;
  /** tar header blocks of any kind */
  headers: number;
  /** kept regular files */
  files: number;
  /** workspace entries the import would create: every file and folder, implicit folders included */
  entries: number;
  /** decompressed bytes per compressed byte consumed */
  ratio: number;
  /** a pax `x` header's payload */
  meta: number;
  /** a GNU `L` long name's payload */
  longName: number;
  /** a kept path's length (UTF-16 code units, as the workspace counts), leaving room for the copy's folder */
  maxPath: number;
  /** a kept path's depth, leaving room for /arXiv/<copy>/ */
  maxDepth: number;
  /** every counted allocation together, fixed buffers included */
  budget: number;
}

/** The caps LIMITS accepted (§4), in bytes. GNU `L`: the most UTF-8 bytes a workspace path can have (3 per UTF-16
 * code unit of MAX_PATH), and never over 4 KiB. The budget allows the single-file shape's chunks and join (twice the
 * per-file cap) or the expanded cap's retained files, whichever is larger, plus the fixed buffers. */
export const CAPS: Caps = {
  download: 50 * MiB,
  total: 100 * MiB,
  perFile: 64 * MiB,
  headers: 5000,
  files: 2000,
  entries: 5000,
  ratio: 100,
  meta: 4096,
  longName: Math.min(4096, 3 * MAX_PATH),
  maxPath: MAX_PATH - 128,
  maxDepth: MAX_DEPTH - 2,
  budget: Math.max(100 * MiB + 4096, 2 * 64 * MiB) + FIXED_BYTES,
};

export type TarFile = { path: string; bytes: Uint8Array; sha256: string };
export type Skipped = { path: string; type: string };
export type Extracted = {
  shape: "tar" | "single";
  files: TarFile[];
  /** every folder the import would create, explicit or implicit, parents before children */
  dirs: string[];
  /** entries that weren't kept (links, devices…), at most SKIPPED_LISTED of them; `skippedCount` counts all */
  skipped: Skipped[];
  skippedCount: number;
  /** the compressed download's SHA-256, 64 lowercase hex digits */
  tarSha256: string;
  compressed: number;
  expanded: number;
  /** the most bytes ever counted as allocated at once */
  peak: number;
};

export const SKIPPED_LISTED = 100;

/** The kind of a download, from its first bytes: gzip, a PDF (a PDF-only paper), or anything else. */
export function sniff(first: Uint8Array): "gzip" | "pdf" | "other" {
  if (first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b) return "gzip";
  if (first.length >= 5 && String.fromCharCode(...first.subarray(0, 5)) === "%PDF-") return "pdf";
  return "other";
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const CONTROL = /[\u0000-\u001f\u007f]/;
const SAFE = Number.MAX_SAFE_INTEGER;

/** A NUL-terminated field's bytes. */
function field(h: Uint8Array, off: number, len: number): Uint8Array {
  const f = h.subarray(off, off + len);
  const z = f.indexOf(0);
  return z < 0 ? f : f.subarray(0, z);
}

/** An octal number field: optional leading spaces, 1 to `digits` octal digits, then only NULs or spaces. Base-256
 * (the high bit of the first byte) and anything else refuse. */
function octal(h: Uint8Array, off: number, len: number, digits: number, what: string): number {
  if (h[off] & 0x80) throw new TarError("size", `a base-256 ${what}`);
  let i = off;
  const end = off + len;
  while (i < end && h[i] === 0x20) i++;
  let n = 0, d = 0;
  while (i < end && h[i] >= 0x30 && h[i] <= 0x37) {
    n = n * 8 + (h[i] - 0x30);
    i++;
    if (++d > digits) throw new TarError("size", `a ${what} with more than ${digits} digits`);
  }
  if (d === 0) throw new TarError("size", `a ${what} with no digits`);
  for (; i < end; i++) if (h[i] !== 0 && h[i] !== 0x20) throw new TarError("size", `a malformed ${what}`);
  return n;
}

/** A numeric field the reader doesn't use (mode, uid, gid, mtime, device numbers) is still well formed: empty
 * (NULs or spaces), base-256 (the high bit of its first byte, as GNU tar writes large ids and times), or octal digits
 * between optional leading spaces and trailing NULs or spaces. */
function numericOk(h: Uint8Array, off: number, len: number): boolean {
  if (h[off] & 0x80) return true;
  let i = off;
  const end = off + len;
  while (i < end && h[i] === 0x20) i++;
  while (i < end && h[i] >= 0x30 && h[i] <= 0x37) i++;
  for (; i < end; i++) if (h[i] !== 0 && h[i] !== 0x20) return false;
  return true;
}
const NUMERIC: [number, number][] = [[100, 8], [108, 8], [116, 8], [136, 12]];
const DEVICES: [number, number][] = [[329, 8], [337, 8]];

const isZero = (h: Uint8Array) => h.every((b) => b === 0);
const ascii = (h: Uint8Array, off: number, s: string) => [...s].every((c, i) => h[off + i] === c.charCodeAt(0));

/** Whether a header's checksum field matches its bytes (summed unsigned, or signed as some old tars did, with the
 * field itself counted as spaces). */
function checksumMatches(h: Uint8Array): boolean {
  let unsigned = 0, signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  let want: number;
  try {
    want = octal(h, 148, 8, 7, "header checksum");
  } catch {
    return false;
  }
  return want === unsigned || want === signed;
}

/** A header's format by its magic: "ustar" (POSIX), "gnu", "v7" (no magic), else null. */
function magicOf(h: Uint8Array): "ustar" | "gnu" | "v7" | null {
  if (ascii(h, 257, "ustar\u000000")) return "ustar";
  if (ascii(h, 257, "ustar  \u0000")) return "gnu";
  if (h.subarray(257, 265).every((b) => b === 0)) return "v7";
  return null;
}

/** The format of a valid tar header (its checksum matches and its magic is known), else null. */
export const headerFormat = (h: Uint8Array) => (checksumMatches(h) ? magicOf(h) : null);

/** A kept name, cleaned and checked (§4 Names), or null for the archive's root entry ("./"). */
function cleanName(raw: string, dir: boolean, caps: Caps): string | null {
  if (raw === "") throw new TarError("name", "an empty name");
  let p = raw.normalize("NFC");
  while (p.startsWith("./")) p = p.slice(2);
  if (dir) {
    // (the archive's own root, "./" or ".", is the only folder ignored)
    if (p === "" || p === ".") return null;
    if (p.endsWith("/")) p = p.slice(0, -1);
  }
  const bad = (why: string) => new TarError("name", `${why}: ${JSON.stringify(raw.slice(0, 200))}`);
  if (p === "") throw bad("an empty name");
  if (CONTROL.test(p)) throw bad("a name with a control character");
  if (p.includes("\\")) throw bad("a name with a backslash");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw bad("an absolute name");
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") throw bad("a name with an empty, \".\" or \"..\" part");
    if (s.length > MAX_NAME) throw bad(`a name with a part over ${MAX_NAME} characters`);
  }
  if (segs.length > caps.maxDepth) throw bad(`a name more than ${caps.maxDepth} folders deep`);
  if (p.length > caps.maxPath) throw bad(`a name over ${caps.maxPath} characters`);
  return p;
}

/** A name for the list of skipped entries: shown, never used as a path. */
const shown = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);

const TYPES: Record<string, string> = {
  "1": "a hard link", "2": "a symbolic link", "3": "a character device", "4": "a block device", "6": "a FIFO",
  "7": "a contiguous file", S: "a GNU sparse file", V: "a GNU volume header", M: "a GNU multi-volume part",
};

type Pending = { from: "x" | "L"; path?: string; size?: number };
type Target =
  | { kind: "file"; path: string; buf: Uint8Array; at: number; sha: Sha256 }
  | { kind: "meta"; type: "x" | "L"; buf: Uint8Array; at: number }
  | { kind: "skip" };

/** The tar layer: decompressed bytes in, files out. */
class TarParser {
  private hdr = new Uint8Array(BLOCK);
  private hfill = 0;
  private state: "header" | "data" | "pad" | "after" = "header";
  private remaining = 0;
  private pad = 0;
  /** zero bytes after the end marker's first block */
  private after = 0;
  /** decompressed bytes fed so far, and up to the end of the header being read */
  private fed = 0;
  private fedAtHeader = 0;
  private target: Target = { kind: "skip" };
  private pending: Pending | null = null;
  private headers = 0;
  /** kept paths: a file, a folder named by a header, or a folder only implied by a deeper path */
  private entries = new Map<string, "file" | "dir" | "implicit">();
  private fileCount = 0;
  readonly files: TarFile[] = [];
  readonly skipped: Skipped[] = [];
  skippedCount = 0;

  constructor(private caps: Caps, private alloc: (n: number) => void, private free: (n: number) => void) {}

  feed(b: Uint8Array): void {
    this.fed += b.length;
    let i = 0;
    while (i < b.length) {
      switch (this.state) {
        case "header": {
          const n = Math.min(BLOCK - this.hfill, b.length - i);
          this.hdr.set(b.subarray(i, i + n), this.hfill);
          this.hfill += n;
          i += n;
          if (this.hfill === BLOCK) {
            this.hfill = 0;
            this.fedAtHeader = this.fed - (b.length - i);
            this.header();
          }
          break;
        }
        case "data": {
          const n = Math.min(this.remaining, b.length - i);
          const t = this.target;
          if (t.kind !== "skip") {
            const part = b.subarray(i, i + n);
            t.buf.set(part, t.at);
            t.at += n;
            if (t.kind === "file") t.sha.update(part);
          }
          this.remaining -= n;
          i += n;
          if (this.remaining === 0) this.entryDone();
          break;
        }
        case "pad": {
          const n = Math.min(this.pad, b.length - i);
          this.pad -= n;
          i += n;
          if (this.pad === 0) this.state = "header";
          break;
        }
        case "after": {
          for (; i < b.length; i++, this.after++) if (b[i] !== 0) throw new TarError("trailing", "data after the tar end marker");
          break;
        }
      }
    }
  }

  /** The input has ended: the end marker must have been read, at a block boundary. */
  finish(): void {
    if (this.state !== "after" || this.after < BLOCK) throw new TarError("end", "the tar archive has no end marker (two zero blocks)");
  }

  get dirs(): string[] {
    return [...this.entries].filter(([, k]) => k !== "file").map(([p]) => p).sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  }

  private header(): void {
    const h = this.hdr;
    if (++this.headers > this.caps.headers) throw new TarError("cap-headers", `more than ${this.caps.headers} tar headers`);
    if (isZero(h)) {
      if (this.pending) throw new TarError("meta", "a pax or GNU long-name header with no entry after it");
      // (the end marker is two zero blocks: the second, and any padding after it, must be zeros too)
      this.state = "after";
      return;
    }
    if (!checksumMatches(h)) throw new TarError("checksum", "a tar header whose checksum doesn't match");
    const format = magicOf(h);
    if (!format) throw new TarError("header", "a tar header of an unknown format");
    const type = String.fromCharCode(h[156]);
    let size = octal(h, 124, 12, 11, "size");
    for (const [off, len] of format === "v7" ? NUMERIC : [...NUMERIC, ...DEVICES]) {
      if (!numericOk(h, off, len)) throw new TarError("header", "a tar header with a malformed numeric field");
    }
    if (type === "x" || type === "L") {
      if (this.pending) throw new TarError("meta", "two pax or GNU long-name headers in a row");
      if (type === "x" && size > this.caps.meta) throw new TarError("cap-meta", `a pax header over ${this.caps.meta} bytes`);
      if (type === "L" && size > this.caps.longName) throw new TarError("cap-longname", `a GNU long name over ${this.caps.longName} bytes`);
      this.alloc(size);
      return this.begin(size, { kind: "meta", type, buf: new Uint8Array(size), at: 0 });
    }
    if (type === "g" || type === "K") return this.begin(size, { kind: "skip" });
    const p = this.pending;
    this.pending = null;
    if (p?.size !== undefined) size = p.size;
    let raw: string;
    try {
      if (p?.path !== undefined) raw = p.path;
      else {
        const name = utf8.decode(field(h, 0, 100));
        const prefix = format === "ustar" ? utf8.decode(field(h, 345, 155)) : "";
        raw = prefix ? prefix + "/" + name : name;
      }
    } catch {
      throw new TarError("name", "a name that isn't UTF-8");
    }
    const regular = type === "0" || type === "\u0000";
    if (type === "5" || (regular && format === "v7" && raw.endsWith("/") && size === 0)) {
      const d = cleanName(raw, true, this.caps);
      if (d !== null) this.add(d, "dir");
      return this.begin(size, { kind: "skip" });
    }
    if (!regular) {
      // (never created, but its name is checked like any: an archive with a link named "../x" isn't a clean one)
      cleanName(raw, raw.endsWith("/"), this.caps);
      if (++this.skippedCount <= SKIPPED_LISTED) this.skipped.push({ path: shown(raw), type: TYPES[type] ?? `an entry of type ${JSON.stringify(shown(type))}` });
      return this.begin(size, { kind: "skip" });
    }
    const path = cleanName(raw, false, this.caps)!;
    if (size > this.caps.perFile) throw new TarError("cap-file", `a file over ${this.caps.perFile} bytes: ${JSON.stringify(shown(path))}`);
    // (the data follows this header: it must fit under what the expanded cap has left, every byte so far counted)
    if (this.fedAtHeader + size > this.caps.total) throw new TarError("cap-total", `files over ${this.caps.total} bytes in all`);
    this.add(path, "file");
    this.alloc(size);
    this.begin(size, { kind: "file", path, buf: new Uint8Array(size), at: 0, sha: new Sha256() });
  }

  private begin(size: number, t: Target): void {
    this.target = t;
    this.remaining = size;
    this.pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size === 0) this.entryDone();
    else this.state = "data";
  }

  private entryDone(): void {
    const t = this.target;
    this.target = { kind: "skip" };
    if (t.kind === "file") this.files.push({ path: t.path, bytes: t.buf, sha256: t.sha.hex() });
    if (t.kind === "meta") {
      this.pending = t.type === "x" ? this.pax(t.buf) : this.longName(t.buf);
      this.free(t.buf.length);
    }
    this.state = this.pad ? "pad" : "header";
  }

  /** A pax `x` payload: records "<len> <key>=<value>\n", each `len` exactly its byte length; only `path` and `size`
   * are used, `GNU.sparse.*` refuses. */
  private pax(buf: Uint8Array): Pending {
    const out: Pending = { from: "x" };
    let i = 0;
    while (i < buf.length) {
      let j = i, len = 0;
      while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x39 && j - i < 5) len = len * 10 + (buf[j++] - 0x30);
      if (j === i || buf[i] === 0x30 || buf[j] !== 0x20 || len < j - i + 3 || i + len > buf.length || buf[i + len - 1] !== 0x0a) {
        throw new TarError("meta", "a malformed pax record");
      }
      const rec = buf.subarray(j + 1, i + len - 1);
      const eq = rec.indexOf(0x3d);
      if (eq <= 0) throw new TarError("meta", "a malformed pax record");
      let key: string;
      try {
        key = utf8.decode(rec.subarray(0, eq));
      } catch {
        throw new TarError("meta", "a pax key that isn't UTF-8");
      }
      // (only the values used are decoded: a path must be UTF-8 like any name)
      const value = () => {
        try {
          return utf8.decode(rec.subarray(eq + 1));
        } catch {
          throw new TarError(key === "path" ? "name" : "size", `a pax ${key} that isn't UTF-8`);
        }
      };
      if (key.startsWith("GNU.sparse.")) throw new TarError("sparse", "a sparse pax entry");
      if (key === "path") {
        if (out.path !== undefined) throw new TarError("meta", "two pax path records");
        out.path = value();
      } else if (key === "size") {
        if (out.size !== undefined) throw new TarError("meta", "two pax size records");
        const v = value();
        if (!/^(0|[1-9][0-9]{0,15})$/.test(v) || Number(v) > SAFE) throw new TarError("size", "a pax size that isn't a safe decimal integer");
        out.size = Number(v);
      }
      i += len;
    }
    return out;
  }

  private longName(buf: Uint8Array): Pending {
    const z = buf.indexOf(0);
    try {
      return { from: "L", path: utf8.decode(z < 0 ? buf : buf.subarray(0, z)) };
    } catch {
      throw new TarError("name", "a GNU long name that isn't UTF-8");
    }
  }

  /** A kept path: no duplicate, no file that is also a folder; its implicit parent folders counted too. */
  private add(path: string, kind: "file" | "dir"): void {
    const segs = path.split("/");
    for (let k = 1; k < segs.length; k++) {
      const a = segs.slice(0, k).join("/");
      const e = this.entries.get(a);
      if (e === "file") throw new TarError("conflict", `${JSON.stringify(shown(a))} is both a file and a folder`);
      if (e === undefined) this.count(a, "implicit");
    }
    const e = this.entries.get(path);
    if (e === "implicit" && kind === "dir") return void this.entries.set(path, "dir");
    if (e === "implicit") throw new TarError("conflict", `${JSON.stringify(shown(path))} is both a file and a folder`);
    if (e !== undefined) throw new TarError(e === kind ? "duplicate" : "conflict", `${JSON.stringify(shown(path))} is in the archive twice`);
    if (kind === "file" && ++this.fileCount > this.caps.files) throw new TarError("cap-files", `more than ${this.caps.files} files`);
    this.count(path, kind);
  }

  private count(path: string, kind: "file" | "dir" | "implicit"): void {
    if (this.entries.size + 1 > this.caps.entries) throw new TarError("cap-entries", `more than ${this.caps.entries} files and folders`);
    this.entries.set(path, kind);
  }
}

/** The single-file shape: output kept in 1 MiB chunks, each counted by its full capacity before it is allocated. */
class SingleFile {
  private chunks: Uint8Array[] = [];
  private fill = 0;
  private sha = new Sha256();
  size = 0;

  constructor(private caps: Caps, private alloc: (n: number) => void, private free: (n: number) => void) {}

  feed(b: Uint8Array): void {
    if (this.size + b.length > this.caps.perFile) throw new TarError("cap-file", `a file over ${this.caps.perFile} bytes`);
    this.sha.update(b);
    let i = 0;
    while (i < b.length) {
      let c = this.chunks[this.chunks.length - 1];
      if (!c || this.fill === c.length) {
        this.alloc(MiB);
        c = new Uint8Array(MiB);
        this.chunks.push(c);
        this.fill = 0;
      }
      const n = Math.min(c.length - this.fill, b.length - i);
      c.set(b.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
    }
    this.size += b.length;
  }

  /** The chunks joined once into an exact-size array (counted too), then let go. */
  finish(): TarFile {
    this.alloc(this.size);
    const bytes = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      const n = Math.min(c.length, this.size - at);
      bytes.set(c.subarray(0, n), at);
      at += n;
    }
    this.free(this.chunks.length * MiB);
    this.chunks = [];
    if (!isTexText(bytes)) throw new TarError("format", "arXiv sent a single file that isn't a TeX source");
    return { path: "main.tex", bytes, sha256: this.sha.hex() };
  }
}

export class SourceExtractor {
  private caps: Caps;
  private sha = new Sha256();
  private compressed = 0;
  private inflater: GzipInflater;
  private first = new Uint8Array(BLOCK);
  private firstFill = 0;
  private tar: TarParser | null = null;
  private single: SingleFile | null = null;
  private counted = FIXED_BYTES;
  /** the most bytes ever counted as allocated at once */
  peak = FIXED_BYTES;

  constructor(caps: Partial<Caps> = {}) {
    this.caps = { ...CAPS, ...caps };
    this.inflater = new GzipInflater((out) => this.output(out), { total: this.caps.total, ratio: this.caps.ratio });
  }

  /** Bytes counted as allocated now. */
  get allocated(): number {
    return this.counted;
  }

  private alloc = (n: number): void => {
    if (this.counted + n > this.caps.budget) throw new TarError("cap-budget", `more than ${this.caps.budget} bytes would be held at once`);
    this.counted += n;
    this.peak = Math.max(this.peak, this.counted);
  };

  private free = (n: number): void => {
    this.counted -= n;
  };

  /** The next chunk of the download, in order. */
  push(chunk: Uint8Array): void {
    if (this.compressed + chunk.length > this.caps.download) throw new TarError("cap-download", `a download over ${this.caps.download} bytes`);
    this.compressed += chunk.length;
    this.sha.update(chunk);
    this.inflater.push(chunk);
  }

  /** The download has ended: everything is checked, and the result returned. */
  end(): Extracted {
    this.inflater.end();
    if (!this.tar && !this.single) this.decide();
    let files: TarFile[], dirs: string[], skipped: Skipped[] = [], skippedCount = 0;
    if (this.tar) {
      this.tar.finish();
      ({ files, skipped, skippedCount } = this.tar);
      dirs = this.tar.dirs;
    } else {
      files = [this.single!.finish()];
      dirs = [];
    }
    return {
      shape: this.tar ? "tar" : "single", files, dirs, skipped, skippedCount, tarSha256: this.sha.hex(),
      compressed: this.compressed, expanded: this.inflater.out, peak: this.peak,
    };
  }

  private output(out: Uint8Array): void {
    let rest = out;
    if (!this.tar && !this.single) {
      const n = Math.min(BLOCK - this.firstFill, rest.length);
      this.first.set(rest.subarray(0, n), this.firstFill);
      this.firstFill += n;
      rest = rest.subarray(n);
      if (this.firstFill < BLOCK) return;
      this.decide();
    }
    if (rest.length) this.tar ? this.tar.feed(rest) : this.single!.feed(rest);
  }

  /** The shape, from the first block (or all of the output, if shorter): a tar header, or a single file. */
  private decide(): void {
    const head = this.first.subarray(0, this.firstFill);
    if (this.firstFill === BLOCK && (isZero(head) || headerFormat(head))) {
      this.tar = new TarParser(this.caps, this.alloc, this.free);
      this.tar.feed(head);
    } else {
      this.single = new SingleFile(this.caps, this.alloc, this.free);
      this.single.feed(head);
    }
  }
}
