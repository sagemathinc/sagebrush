// A strict, bounded zip reader for archives that arrive as bytes, intended for report uploads on the server,
// history zips opened in the page, and examples (no caller imports it yet).  Pure TypeScript with no DOM and no Node
// APIs: inflating uses DecompressionStream("deflate-raw"), which Workers and browsers both have.
//
// Two steps, so a caller can refuse early and read the manifest first:
//   - open(bytes, opts) checks the end record, the whole central directory and every member's local header, and
//     returns the entries (names exactly as stored, methods, sizes, CRCs) without inflating anything;
//   - read(name) inflates one member, counting its output against the member's cap and the archive's total cap as the
//     bytes come out (a declared size is never trusted), and checks its size and CRC.
// Every refusal is a ZipError with a stable `code`, so a page can say what was wrong and a test can assert it.
//
// What open() refuses (before anything is inflated):
//   - no end record, a comment that doesn't end the file, more than one disk, or a central directory that isn't
//     exactly between the last member and the end record ("eocd");
//   - more entries than caps.entries ("count");
//   - Zip64 in any form (its end record or locator, 0xffff/0xffffffff markers, a Zip64 extra field) ("zip64"),
//     unless opts.zip64End allows the end record alone, and then only in the export writer's single-disk form;
//   - encryption, by flag or by method ("encrypted"); a method other than STORE or DEFLATE, or a flag outside
//     {1, 2, 3, 11} ("method");
//   - a name that isn't valid UTF-8 (bit 11) or plain ASCII (without it), is empty, has a NUL or control character
//     or a backslash, is absolute or starts with a drive letter, has an empty, "." or ".." segment, names a
//     directory (unless opts.directories) or a symlink, or that opts.accept refuses ("name");
//   - two names equal after Unicode NFC ("duplicate");
//   - a local header that disagrees with its central record (name bytes, method, flags, and, without a data
//     descriptor, CRC and sizes), a data descriptor that disagrees, a STOREd member whose sizes differ, or members
//     whose bytes overlap or run past the central directory ("mismatch");
//   - a member whose declared size is over its cap, or declared sizes over caps.total ("cap");
//   - a name in opts.required that isn't there ("missing");
//   - bytes that end too soon ("truncated").
// read() adds: inflating past the member's cap, past the declared size, or past the archive's total ("cap"); output
// that ends short of the declared size ("mismatch"); a CRC that doesn't match ("crc"); a stream the decompressor
// refuses ("inflate").

import { crc32Final, crc32Init, crc32Update } from "./crc32.ts";

export type ZipErrorCode =
  | "eocd" | "truncated" | "count" | "zip64" | "encrypted" | "method" | "name" | "duplicate" | "mismatch" | "cap" | "missing" | "crc" | "inflate";

export class ZipError extends Error {
  constructor(public code: ZipErrorCode, message: string, public entry?: string) {
    super(entry === undefined ? message : `${message} (${JSON.stringify(entry)})`);
    this.name = "ZipError";
  }
}

export interface ZipCaps {
  /** the most entries the central directory may list */
  entries: number;
  /** the most bytes one member may inflate to: one number for all, or per name */
  perEntry: number | ((name: string) => number);
  /** the most bytes all reads together may inflate to */
  total: number;
}

export interface ZipOptions {
  /** whether a name may be in this archive (the caller's allow-list); called after the generic name checks, which
   * refuse what's unsafe in any path (absolute, a drive letter, a backslash, "..", control characters); the allow-list
   * is still where a name is mapped to anything on a disk or a page */
  accept: (name: string) => boolean;
  caps: ZipCaps;
  /** names that must be present (e.g. ["manifest.json"]) */
  required?: string[];
  /** allow directory entries (`name/`, size 0); off by default */
  directories?: boolean;
  /** allow a Zip64 end record and its locator before the classic end record (and nothing else of Zip64); off by
   * default */
  zip64End?: boolean;
}

export interface ZipEntry {
  /** the name exactly as stored, decoded */
  name: string;
  /** 0 STORE, 8 DEFLATE */
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc32: number;
  /** a directory entry (only with opts.directories) */
  directory: boolean;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** whether `name` is in the archive (compared after Unicode NFC, as `required` and the duplicate check are) */
  has(name: string): boolean;
  /** the member's bytes, inflated and checked (the name found after NFC); reading a member twice counts it twice
   * against caps.total */
  read(name: string): Promise<Uint8Array>;
  /** bytes inflated so far by read(), against caps.total */
  readonly inflated: number;
}

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50, SIG_DESCRIPTOR = 0x08074b50;
const SIG_ZIP64_END = 0x06064b50, SIG_ZIP64_LOCATOR = 0x07064b50;
const ALLOWED_FLAGS = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 11);
const S_IFMT = 0o170000, S_IFLNK = 0o120000, S_IFDIR = 0o040000;

interface Internal extends ZipEntry {
  flags: number;
  nameBytes: Uint8Array;
  localOffset: number;
  dataStart: number;
  /** where the member's bytes end, its data descriptor included */
  end: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(raw: Uint8Array, flags: number): string {
  if (flags & (1 << 11)) {
    try {
      return utf8.decode(raw);
    } catch {
      throw new ZipError("name", "a member's name isn't valid UTF-8");
    }
  }
  for (const b of raw) if (b >= 0x80) throw new ZipError("name", "a member's name isn't UTF-8-flagged and isn't plain ASCII");
  return String.fromCharCode(...raw);
}

/** The generic checks every name gets, whatever the caller allows. */
function nameProblem(name: string, directories: boolean): string | null {
  if (name.length === 0) return "an empty name";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "a control character in a name";
  if (name.includes("\\")) return "a backslash in a name";
  if (name.startsWith("/")) return "an absolute path";
  if (/^[A-Za-z]:/.test(name)) return "a drive letter";
  const dir = name.endsWith("/");
  if (dir && !directories) return "a directory entry";
  const segs = (dir ? name.slice(0, -1) : name).split("/");
  for (const s of segs) if (s === "" || s === "." || s === "..") return "an empty, \".\" or \"..\" path segment";
  return null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function open(bytes: Uint8Array, opts: ZipOptions): ZipArchive {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  const need = (o: number, n: number) => {
    if (o < 0 || o + n > len) throw new ZipError("truncated", "the archive ends too soon");
  };

  // ---- the end record: the last one whose comment ends exactly at the end of the bytes
  if (len < 22) throw new ZipError("eocd", "no end of central directory record");
  let eocd = -1;
  for (let o = len - 22; o >= Math.max(0, len - 22 - 0xffff); o--) {
    if (u32(o) === SIG_END && o + 22 + u16(o + 20) === len) {
      eocd = o;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("eocd", "no end of central directory record");
  const disk = u16(eocd + 4), cdDisk = u16(eocd + 6), onDisk = u16(eocd + 8), total = u16(eocd + 10);
  const cdSize = u32(eocd + 12), cdOffset = u32(eocd + 16);
  if (total === 0xffff || onDisk === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64", "Zip64 archives aren't accepted");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError("eocd", "a multi-disk archive");
  if (total > opts.caps.entries) throw new ZipError("count", `${total} entries, more than ${opts.caps.entries}`);

  // ---- a Zip64 end record and locator, refused unless allowed, and then only in the one form the export's writer
  // makes: a single disk, a 44-byte record (no extensible data) right before its locator, right before the classic
  // end record, every count, size and offset equal to the classic end record's
  let cdEnd = eocd;
  if (eocd >= 20 && u32(eocd - 20) === SIG_ZIP64_LOCATOR) {
    if (!opts.zip64End) throw new ZipError("zip64", "Zip64 archives aren't accepted");
    const loc = eocd - 20;
    const u64 = (o: number) => v.getBigUint64(o, true);
    if (u32(loc + 4) !== 0 || u32(loc + 16) !== 1) throw new ZipError("zip64", "a Zip64 locator for more than one disk");
    const at = loc - 56;
    if (at < 0 || u64(loc + 8) !== BigInt(at) || u32(at) !== SIG_ZIP64_END) throw new ZipError("zip64", "a Zip64 end record that isn't right before its locator");
    const needed = u16(at + 14);
    if (u64(at + 4) !== 44n || needed < 45 || needed > 63) throw new ZipError("zip64", "a Zip64 end record of a form that isn't accepted");
    if (u32(at + 16) !== 0 || u32(at + 20) !== 0) throw new ZipError("zip64", "a Zip64 end record for more than one disk");
    if (u64(at + 24) !== BigInt(total) || u64(at + 32) !== BigInt(total) || u64(at + 40) !== BigInt(cdSize) || u64(at + 48) !== BigInt(cdOffset)) {
      throw new ZipError("mismatch", "the Zip64 end record disagrees with the end record");
    }
    cdEnd = at;
  }
  if (cdOffset + cdSize !== cdEnd) throw new ZipError("eocd", "the central directory isn't where the end record says");

  // ---- the central directory
  const entries: Internal[] = [];
  const seen = new Set<string>();
  const perEntry = (name: string) => (typeof opts.caps.perEntry === "number" ? opts.caps.perEntry : opts.caps.perEntry(name));
  let declared = 0;
  let o = cdOffset;
  for (let i = 0; i < total; i++) {
    need(o, 46);
    if (u32(o) !== SIG_CENTRAL) throw new ZipError("eocd", "a central directory record is missing");
    const madeBy = u16(o + 4), flags = u16(o + 8), method = u16(o + 10), crc = u32(o + 16);
    const csize = u32(o + 20), usize = u32(o + 24), nlen = u16(o + 28), xlen = u16(o + 30), clen = u16(o + 32);
    const startDisk = u16(o + 34), external = u32(o + 38), localOffset = u32(o + 42);
    need(o + 46, nlen + xlen + clen);
    const nameBytes = bytes.subarray(o + 46, o + 46 + nlen);
    if (flags & 1 || flags & (1 << 6) || method === 99) throw new ZipError("encrypted", "an encrypted member");
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff || startDisk === 0xffff) throw new ZipError("zip64", "Zip64 members aren't accepted");
    if (hasExtra(v, o + 46 + nlen, xlen, 0x0001)) throw new ZipError("zip64", "Zip64 members aren't accepted");
    if (method !== 0 && method !== 8) throw new ZipError("method", `compression method ${method} isn't accepted`);
    if (flags & ~ALLOWED_FLAGS) throw new ZipError("method", "general-purpose flags that aren't accepted");
    if (startDisk !== 0) throw new ZipError("eocd", "a multi-disk archive");
    const name = decodeName(nameBytes, flags);
    const problem = nameProblem(name, !!opts.directories);
    if (problem) throw new ZipError("name", problem, name);
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    if ((unixMode & S_IFMT) === S_IFLNK) throw new ZipError("name", "a symbolic link", name);
    const directory = name.endsWith("/") || (unixMode & S_IFMT) === S_IFDIR;
    if (directory && (!opts.directories || !name.endsWith("/") || usize !== 0)) throw new ZipError("name", "a directory entry", name);
    if (!opts.accept(name)) throw new ZipError("name", "a name this archive may not have", name);
    const nfc = name.normalize("NFC");
    if (seen.has(nfc)) throw new ZipError("duplicate", "a name that appears twice", name);
    seen.add(nfc);
    if (method === 0 && csize !== usize) throw new ZipError("mismatch", "a stored member's sizes differ", name);
    if (usize > perEntry(name)) throw new ZipError("cap", `a member of ${usize} bytes, over its cap`, name);
    declared += usize;
    if (declared > opts.caps.total) throw new ZipError("cap", "the members' sizes are over the archive's cap");

    // ---- its local header
    need(localOffset, 30);
    if (u32(localOffset) !== SIG_LOCAL) throw new ZipError("mismatch", "a member's local header is missing", name);
    const lflags = u16(localOffset + 6), lmethod = u16(localOffset + 8), lcrc = u32(localOffset + 14);
    const lcsize = u32(localOffset + 18), lusize = u32(localOffset + 22), lnlen = u16(localOffset + 26), lxlen = u16(localOffset + 28);
    need(localOffset + 30, lnlen + lxlen);
    if (lflags !== flags || lmethod !== method) throw new ZipError("mismatch", "a local header's flags or method disagree with the central directory", name);
    if (!bytesEqual(bytes.subarray(localOffset + 30, localOffset + 30 + lnlen), nameBytes)) throw new ZipError("mismatch", "a local header's name disagrees with the central directory", name);
    if (hasExtra(v, localOffset + 30 + lnlen, lxlen, 0x0001)) throw new ZipError("zip64", "Zip64 members aren't accepted", name);
    const dataStart = localOffset + 30 + lnlen + lxlen;
    need(dataStart, csize);
    let end = dataStart + csize;
    if (flags & (1 << 3)) {
      // (a data descriptor: the local fields may be zero, or else must agree; the descriptor must agree)
      if ((lcrc !== 0 && lcrc !== crc) || (lcsize !== 0 && lcsize !== csize) || (lusize !== 0 && lusize !== usize)) throw new ZipError("mismatch", "a local header's sizes or CRC disagree with the central directory", name);
      let d = end;
      need(d, 12);
      if (u32(d) === SIG_DESCRIPTOR) d += 4;
      need(d, 12);
      if (u32(d) !== crc || u32(d + 4) !== csize || u32(d + 8) !== usize) throw new ZipError("mismatch", "a data descriptor disagrees with the central directory", name);
      end = d + 12;
    } else if (lcrc !== crc || lcsize !== csize || lusize !== usize) {
      throw new ZipError("mismatch", "a local header's sizes or CRC disagree with the central directory", name);
    }
    if (end > cdOffset) throw new ZipError("mismatch", "a member runs into the central directory", name);
    entries.push({ name, method, compressedSize: csize, size: usize, crc32: crc, directory, flags, nameBytes, localOffset, dataStart, end });
    o += 46 + nlen + xlen + clen;
  }
  if (o !== cdEnd) throw new ZipError("eocd", "the central directory's size disagrees with its records");

  // ---- members don't overlap
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < byOffset.length; i++) {
    if (byOffset[i].localOffset < byOffset[i - 1].end) throw new ZipError("mismatch", "two members' bytes overlap", byOffset[i].name);
  }

  for (const r of opts.required ?? []) if (!seen.has(r.normalize("NFC"))) throw new ZipError("missing", "a required member is missing", r);

  const byName = new Map(entries.map((e) => [e.name.normalize("NFC"), e]));
  let inflated = 0;
  const archive: ZipArchive = {
    entries: entries.map(({ name, method, compressedSize, size, crc32, directory }) => ({ name, method, compressedSize, size, crc32, directory })),
    has: (name) => byName.has(name.normalize("NFC")),
    get inflated() {
      return inflated;
    },
    async read(name) {
      const e = byName.get(name.normalize("NFC"));
      if (!e) throw new ZipError("missing", "no such member", name);
      const cap = Math.min(e.size, perEntry(e.name));
      const data = bytes.subarray(e.dataStart, e.dataStart + e.compressedSize);
      let out: Uint8Array;
      if (e.method === 0) {
        if (inflated + data.length > opts.caps.total) throw new ZipError("cap", "the archive's members inflate past its cap", name);
        out = data.slice();
        inflated += out.length;
      } else {
        out = await inflateCapped(data, cap, name, (n) => {
          inflated += n;
          if (inflated > opts.caps.total) throw new ZipError("cap", "the archive's members inflate past its cap", name);
        });
      }
      if (out.length !== e.size) throw new ZipError("mismatch", "a member's inflated size disagrees with the central directory", name);
      if (crc32Final(crc32Update(crc32Init(), out)) !== e.crc32) throw new ZipError("crc", "a member's CRC doesn't match", name);
      return out;
    },
  };
  return archive;
}

/** Whether an extra-field block has a field with this id (a malformed block counts as having it: refused). */
function hasExtra(v: DataView, at: number, n: number, id: number): boolean {
  let o = at;
  while (o + 4 <= at + n) {
    const fid = v.getUint16(o, true), size = v.getUint16(o + 2, true);
    if (fid === id) return true;
    o += 4 + size;
    if (o > at + n) return true;
  }
  return o !== at + n && n !== 0 ? true : false;
}

/** `data` inflated, at most `cap` bytes kept: the first output chunk that takes the count past `cap` is rejected
 * before it's kept, and the decompressor is cancelled.
 * `count` sees each chunk's length first (the archive's total). */
async function inflateCapped(data: Uint8Array, cap: number, name: string, count: (n: number) => void): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        throw new ZipError("inflate", `a member doesn't inflate: ${(e as Error)?.message ?? e}`, name);
      }
      if (r.done) break;
      count(r.value.length);
      n += r.value.length;
      if (n > cap) throw new ZipError("cap", "a member inflates past its cap or its declared size", name);
      parts.push(r.value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
