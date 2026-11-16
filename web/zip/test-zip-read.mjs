// ci: web-runner order=599 runner=bun
// The strict zip reader (web/zip/read.ts), each refusal by its code, against archives a small writer here makes:
// the valid forms (STORE and DEFLATE, a data descriptor with and without its signature, UTF-8 names, the export
// writer's own layout: bits 3 and 11, directory members and a Zip64 end record, allowed only by its options); for
// each refusal code, at least one archive that breaks one fence and nothing else; and for each field of the Zip64 end
// record and its locator, one archive with only that field wrong.  With `unzip` on the PATH, the valid ones are also tested by it,
// so the writer here is a real zip writer and not one that only this reader understands.
//   bun web/zip/test-zip-read.mjs
import { deflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, ZipError } from "./read.ts";
import { crc32Final, crc32Init, crc32Update } from "./crc32.ts";

let failures = 0, count = 0;
const ok = (c, msg) => { count++; if (c) console.log("ok   " + msg); else { failures++; console.log("FAIL " + msg); } };
const enc = new TextEncoder();
const crc = (b) => crc32Final(crc32Update(crc32Init(), b));

/** A zip from `members` [{ name, data, method?, descriptor?: "sig"|"bare", flags?, ... overrides }], with `opts` to
 * break it: every field can be overridden per member (central or local), and the end can carry a Zip64 record. */
function zip(members, opts = {}) {
  const parts = [];
  const central = [];
  let off = 0;
  const push = (b) => { parts.push(b); off += b.length; };
  for (const m of members) {
    const nameBytes = m.nameBytes ?? enc.encode(m.name);
    const data = typeof m.data === "string" ? enc.encode(m.data) : m.data ?? new Uint8Array(0);
    const method = m.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : m.body ?? data;
    const c = m.crc ?? crc(data);
    const flags = m.flags ?? ((1 << 11) | (m.descriptor ? 1 << 3 : 0));
    const usize = m.usize ?? data.length, csize = m.csize ?? body.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, m.lflags ?? flags, true); lh.setUint16(8, m.lmethod ?? method, true);
    const lzero = m.descriptor && m.localZero !== false;
    lh.setUint32(14, lzero ? 0 : m.lcrc ?? c, true); lh.setUint32(18, lzero ? 0 : m.lcsize ?? csize, true); lh.setUint32(22, lzero ? 0 : m.lusize ?? usize, true);
    const lname = m.lnameBytes ?? nameBytes;
    const lextra = m.lextra ?? new Uint8Array(0);
    lh.setUint16(26, lname.length, true); lh.setUint16(28, lextra.length, true);
    const localOffset = m.localOffset ?? off;
    push(new Uint8Array(lh.buffer)); push(lname); push(lextra); push(body);
    if (m.descriptor) {
      const d = new DataView(new ArrayBuffer(m.descriptor === "sig" ? 16 : 12));
      let at = 0;
      if (m.descriptor === "sig") { d.setUint32(0, 0x08074b50, true); at = 4; }
      d.setUint32(at, m.dcrc ?? c, true); d.setUint32(at + 4, m.dcsize ?? csize, true); d.setUint32(at + 8, m.dusize ?? usize, true);
      push(new Uint8Array(d.buffer));
    }
    const extra = m.extra ?? new Uint8Array(0);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, m.madeBy ?? (3 << 8) | 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, flags, true);
    ch.setUint16(10, method, true); ch.setUint32(16, c, true); ch.setUint32(20, csize, true); ch.setUint32(24, usize, true);
    ch.setUint16(28, nameBytes.length, true); ch.setUint16(30, extra.length, true); ch.setUint32(38, m.external ?? (0o100644 << 16) >>> 0, true);
    ch.setUint32(42, localOffset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes, extra);
  }
  const cdOffset = off;
  for (const b of central) push(b);
  const cdSize = off - cdOffset;
  if (opts.zip64End) {
    // (the export writer's form; opts.z64 breaks one field: size, needed, disk, cdDisk, onDisk, n64, cdSize64,
    // off64, locDisk, locTotal, gap (bytes between the record and its locator), locAt (where the locator points))
    const z64 = opts.z64 ?? {};
    const z = new DataView(new ArrayBuffer(56));
    z.setUint32(0, 0x06064b50, true); z.setBigUint64(4, BigInt(z64.size ?? 44), true); z.setUint16(12, (3 << 8) | 45, true); z.setUint16(14, z64.needed ?? 45, true);
    z.setUint32(16, z64.disk ?? 0, true); z.setUint32(20, z64.cdDisk ?? 0, true);
    z.setBigUint64(24, BigInt(z64.onDisk ?? members.length), true); z.setBigUint64(32, BigInt(z64.n64 ?? opts.n64 ?? members.length), true);
    z.setBigUint64(40, BigInt(z64.cdSize64 ?? cdSize), true); z.setBigUint64(48, BigInt(z64.off64 ?? cdOffset), true);
    const at = off;
    push(new Uint8Array(z.buffer));
    if (z64.gap) push(new Uint8Array(z64.gap));
    const l = new DataView(new ArrayBuffer(20));
    l.setUint32(0, 0x07064b50, true); l.setUint32(4, z64.locDisk ?? 0, true); l.setBigUint64(8, BigInt(z64.locAt ?? at), true); l.setUint32(16, z64.locTotal ?? 1, true);
    push(new Uint8Array(l.buffer));
  }
  const e = new DataView(new ArrayBuffer(22));
  const n = opts.count ?? members.length;
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true); e.setUint16(10, n, true);
  e.setUint32(12, opts.cdSize ?? cdSize, true); e.setUint32(16, opts.cdOffset ?? cdOffset, true);
  push(new Uint8Array(e.buffer));
  const all = new Uint8Array(off);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return opts.truncate ? all.subarray(0, all.length - opts.truncate) : all;
}

const ANY = { accept: () => true, caps: { entries: 100, perEntry: 1 << 20, total: 4 << 20 } };
const read = async (bytes, opts = ANY) => { const a = open(bytes, opts); const out = {}; for (const e of a.entries) if (!e.directory) out[e.name] = new TextDecoder().decode(await a.read(e.name)); return { a, out }; };
async function refuses(code, msg, bytes, opts = ANY, readAll = true) {
  try {
    const a = open(bytes, opts);
    if (readAll) for (const e of a.entries) if (!e.directory) await a.read(e.name);
    ok(false, `${msg}: refused with "${code}" (it was accepted)`);
  } catch (e) {
    ok(e instanceof ZipError && e.code === code, `${msg}: refused with "${code}" (${e instanceof ZipError ? e.code + ": " + e.message : e})`);
  }
}

const unzipOk = (() => { try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
const dir = mkdtempSync(join(tmpdir(), "zip-read-"));
function unzipTest(label, bytes) {
  if (!unzipOk) return;
  const p = join(dir, "a.zip");
  writeFileSync(p, bytes);
  let good = true;
  try { execFileSync("unzip", ["-tqq", p], { stdio: "ignore" }); } catch { good = false; }
  ok(good, `${label}: unzip -t accepts it too`);
}

try {
  // ---- valid forms
  const plain = zip([{ name: "README.md", data: "# hi\n", method: 0 }, { name: "manifest.json", data: '{"v":1}' }, { name: "dir/ünïcödé.json", data: "x".repeat(5000) }]);
  let r = await read(plain);
  ok(r.out["README.md"] === "# hi\n" && r.out["manifest.json"] === '{"v":1}' && r.out["dir/ünïcödé.json"].length === 5000, "STORE and DEFLATE members, a UTF-8 name: read back exactly");
  ok(r.a.inflated === 5 + 7 + 5000, `the archive's inflated count: ${r.a.inflated}`);
  unzipTest("STORE + DEFLATE + UTF-8", plain);
  const desc = zip([{ name: "a.json", data: "aaaa", descriptor: "sig" }, { name: "b.json", data: "bbbbbbbb", descriptor: "bare" }]);
  r = await read(desc);
  ok(r.out["a.json"] === "aaaa" && r.out["b.json"] === "bbbbbbbb", "data descriptors, with and without their signature (bit 3, local fields zero): read back");
  unzipTest("data descriptors", desc);
  const exportLike = zip([{ name: "folder/", data: "", method: 0, descriptor: "sig", external: (0o040755 << 16) >>> 0 }, { name: "folder/n.ipynb", data: "{}", descriptor: "sig" }], { zip64End: true });
  r = await read(exportLike, { ...ANY, directories: true, zip64End: true });
  ok(r.a.entries.length === 2 && r.a.entries[0].directory && r.out["folder/n.ipynb"] === "{}", "the export writer's layout (bits 3+11, a directory member, a Zip64 end record): read with directories and zip64End allowed");
  unzipTest("the export writer's layout", exportLike);
  await refuses("zip64", "the export writer's layout without zip64End", exportLike, { ...ANY, directories: true });
  await refuses("name", "the export writer's layout without directories", exportLike, { ...ANY, zip64End: true });
  r = await read(zip([{ name: "manifest.json", data: "{}" }]), { ...ANY, required: ["manifest.json"] });
  ok(r.a.has("manifest.json"), "a required member present: accepted");
  {
    // (has() and read() find a name after NFC, as required and the duplicate check do)
    const a = open(zip([{ name: "caf\u00e9.json", data: "x" }]), ANY);
    ok(a.has("cafe\u0301.json") && new TextDecoder().decode(await a.read("cafe\u0301.json")) === "x", "has() and read() find a name given in another Unicode normal form");
    await a.read("caf\u00e9.json");
    ok(a.inflated === 2, `reading a member twice counts it twice against the total: ${a.inflated}`);
  }

  // ---- each fence, broken alone
  await refuses("missing", "a required member absent", zip([{ name: "a.json", data: "{}" }]), { ...ANY, required: ["manifest.json"] });
  await refuses("name", "a name the caller's allow-list refuses", zip([{ name: "evil.json", data: "{}" }]), { ...ANY, accept: (n) => n === "ok.json" });
  for (const [name, why] of [["", "nothing (an empty name)"], ["../x", "a .. segment"], ["/abs", "an absolute path"], ["C:x", "a drive letter"], ["c:/x", "a drive letter and a slash"], ["a//b", "an empty segment"], ["a/./b", "a . segment"], ["a\\b", "a backslash"], ["a\u0001b", "a control character"], ["d/", "a directory entry (not allowed)"]]) {
    await refuses("name", `a name with ${why}`, zip([{ name, data: name.endsWith("/") ? "" : "x", method: name.endsWith("/") ? 0 : 8 }]));
  }
  await refuses("name", "a symbolic link (unix mode 120777)", zip([{ name: "link", data: "target", method: 0, external: (0o120777 << 16) >>> 0 }]));
  await refuses("name", "a non-ASCII name without the UTF-8 flag", zip([{ name: "x", nameBytes: new Uint8Array([0x63, 0xe9]), data: "x", flags: 0 }]));
  await refuses("name", "a UTF-8-flagged name that isn't valid UTF-8", zip([{ name: "x", nameBytes: new Uint8Array([0x63, 0xff, 0xfe]), data: "x" }]));
  await refuses("duplicate", "a name twice", zip([{ name: "a.json", data: "1" }, { name: "a.json", data: "2" }]));
  await refuses("duplicate", "two names equal after NFC (é composed and decomposed)", zip([{ name: "café.json", data: "1" }, { name: "café.json", data: "2" }]));
  await refuses("count", "more entries than the cap", zip([{ name: "a", data: "1" }, { name: "b", data: "2" }, { name: "c", data: "3" }]), { ...ANY, caps: { ...ANY.caps, entries: 2 } });
  await refuses("encrypted", "the encryption flag", zip([{ name: "a", data: "1", flags: (1 << 11) | 1 }]));
  await refuses("method", "an unknown method (12, bzip2)", zip([{ name: "a", data: "1", method: 12, body: enc.encode("1") }]));
  await refuses("method", "a flag outside {1,2,3,11} (bit 5, patched data)", zip([{ name: "a", data: "1", flags: (1 << 11) | (1 << 5) }]));
  await refuses("zip64", "a Zip64 extra field on a member", zip([{ name: "a", data: "1", extra: new Uint8Array([1, 0, 0, 0]) }]));
  await refuses("zip64", "a Zip64 end record without zip64End", zip([{ name: "a", data: "1" }], { zip64End: true }));
  await refuses("mismatch", "a Zip64 end record that disagrees with the end record", zip([{ name: "a", data: "1" }], { zip64End: true, n64: 5 }), { ...ANY, zip64End: true });
  // (each field of the Zip64 end record and locator, alone, off the export writer's single-disk form)
  const Z64 = { ...ANY, zip64End: true };
  r = await read(zip([{ name: "a", data: "1" }], { zip64End: true }), Z64);
  ok(r.out["a"] === "1", "the export writer's Zip64 end record, untouched: accepted with zip64End");
  for (const [field, value, code] of [
    ["size", 0, "zip64"], ["size", 52, "zip64"], ["needed", 20, "zip64"], ["needed", 99, "zip64"],
    ["disk", 7, "zip64"], ["cdDisk", 7, "zip64"], ["onDisk", 7, "mismatch"], ["n64", 7, "mismatch"], ["cdSize64", 7, "mismatch"], ["off64", 7, "mismatch"],
    ["locDisk", 7, "zip64"], ["locTotal", 7, "zip64"], ["locTotal", 0, "zip64"], ["gap", 4, "zip64"], ["locAt", 0, "zip64"],
  ]) {
    await refuses(code, `a Zip64 end record with ${field} = ${value}`, zip([{ name: "a", data: "1" }], { zip64End: true, z64: { [field]: value } }), Z64);
  }
  await refuses("truncated", "a central record pointing past the end of the bytes", zip([{ name: "a", data: "1", localOffset: 99999 }]));
  await refuses("eocd", "no end record (bytes cut)", zip([{ name: "a", data: "1" }], { truncate: 3 }));
  await refuses("eocd", "a central directory offset that's wrong", zip([{ name: "a", data: "1" }], { cdOffset: 3 }));
  await refuses("eocd", "a central directory size that's wrong", zip([{ name: "a", data: "1" }], { cdSize: 999 }));
  await refuses("mismatch", "a local header's name differs from the central record's", zip([{ name: "safe.json", lnameBytes: enc.encode("evil.json"), data: "1" }]));
  await refuses("mismatch", "a local header's method differs", zip([{ name: "a", data: "1", lmethod: 0 }]));
  await refuses("mismatch", "a local header's size differs (no descriptor)", zip([{ name: "a", data: "12345", lusize: 1 }]));
  await refuses("mismatch", "a data descriptor's size differs from the central record's", zip([{ name: "a", data: "12345", descriptor: "sig", dusize: 1 }]));
  await refuses("mismatch", "a stored member whose sizes differ", zip([{ name: "a", data: "12345", method: 0, usize: 9 }]));
  await refuses("mismatch", "a central record pointing at another member's local header", zip([{ name: "a", data: "1" }, { name: "b", data: "2", localOffset: 0, lnameBytes: enc.encode("b") }]));
  {
    // (a member hidden inside another's bytes: a's STOREd data is a whole local header and data for "b", and b's
    // central record points there; every name, size and CRC agrees, so only the overlap check can refuse it)
    const inner = zip([{ name: "b", data: "hidden", method: 0 }]);
    const innerLocal = inner.subarray(0, 30 + 1 + 6);
    const m = zip([{ name: "a", data: innerLocal, method: 0 }, { name: "b", data: "hidden", method: 0, localOffset: 30 + 1 }]);
    await refuses("mismatch", "a member hidden inside another member's bytes (overlap)", m);
  }
  await refuses("crc", "a CRC that doesn't match (central and local agree, the data doesn't)", zip([{ name: "a", data: "hello", crc: 12345 }]));
  // (bombs: honest declared sizes over the cap are refused at open; a lying small size is caught while inflating)
  const big = "z".repeat(3 << 20);
  await refuses("cap", "a member declared over its cap (refused before inflating)", zip([{ name: "a", data: big }]), { ...ANY, caps: { ...ANY.caps, perEntry: 1 << 20 } }, false);
  await refuses("cap", "a member declaring 10 bytes that inflates to 3 MiB (stopped at the first chunk over)", zip([{ name: "a", data: big, usize: 10 }]));
  await refuses("cap", "members declared over the archive's total", zip([{ name: "a", data: "x".repeat(600) }, { name: "b", data: "y".repeat(600) }]), { ...ANY, caps: { ...ANY.caps, total: 1000 } }, false);
  await refuses("cap", "a per-name cap (a function)", zip([{ name: "log.json", data: "x".repeat(2000) }]), { ...ANY, caps: { ...ANY.caps, perEntry: (n) => (n === "log.json" ? 1000 : 1 << 20) } }, false);
  await refuses("mismatch", "a member that inflates to less than it declares", zip([{ name: "a", data: "12345", usize: 9 }]));
  {
    // (a corrupt DEFLATE body: method 8 with bytes that aren't a deflate stream, sizes and CRC consistent)
    const bad = zip([{ name: "a", data: "hello" }]);
    const at = 30 + 1; // the first body byte of the only member
    bad[at] = 0xff; bad[at + 1] = 0xff; bad[at + 2] = 0xff;
    await refuses("inflate", "a DEFLATE body the decompressor refuses", bad);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${count} FAILED` : `${count}/${count} passed`);
if (failures) process.exit(1);
