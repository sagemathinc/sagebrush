// ci: checks.3 order=131 runner=bun
// The export's member names (names.ts, astra's EXPORT-ZIPNAME-1): what a .zip can't hold safely is refused, never
// renamed, by bytes and by string alike; what it can hold is left alone.
//   bun web/workspace/export/test-names.mjs
import { unsafeMember, unsafeMemberBytes, unsafeNamesWhy } from "./names.ts";
import { ExportStopped, ZipWriter } from "./zip.ts";

let fails = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) fails++; };
const J = JSON.stringify;
const enc = new TextEncoder();

// (astra's evidence: the normalized workspace entries that made traversal members at b418745c)
const refused = [
  ["files/..\\..\\outside.txt", false], ["files/dir/..\\..\\..\\outside.txt", false],
  ["files/a\\b.txt", false], ["files/C:x", false], ["files/a:b", false], ["files/c:/x", false],
  ["/a/b.py", false], ["files//b.py", false], ["files/a//b.py", false], ["", false],
  ["files/./x", false], ["files/../x", false], ["files/a/..", false], ["files/.", false],
  ["files/x\u0000y", false], ["files/x\u001fy", false], ["files/x\u007fy", false],
  ["files/a<b", false], ["files/a>b", false], ["files/a\"b", false], ["files/a|b", false], ["files/a?b", false], ["files/a*b", false],
  ["files/NUL", false], ["files/nul.txt", false], ["files/Con", false], ["files/prn.tar.gz", false], ["files/AUX", false],
  ["files/COM1", false], ["files/lpt9.log", false], ["files/COM\u00b9", false], ["files/LPT\u00b2.txt", false], ["files/com\u00b3", false],
  ["files/dir/NUL/x.txt", false], ["files/NUL/", true],
  ["files/a.", false], ["files/a ", false], ["files/dir./x", false], ["files/dir /x", false], ["files/...", false],
  ["files/x/", false], ["files/x", true], ["files/x//", true],
];
for (const [name, folder] of refused) {
  const s = unsafeMember(name, folder), b = enc.encode(name), y = unsafeMemberBytes(b, b.length, folder);
  ok(s !== null && s === y, `refused${folder ? " (folder)" : ""}: ${J(name)}: ${s}`);
}
const allowed = [
  ["files/safe/helpers.py", false], ["files/_code/helpers.py", false], ["files/.config", false], ["files/.config/x.toml", false],
  ["files/a b.txt", false], ["files/données/été.csv", false], ["files/日本語.txt", false], ["files/COM0", false], ["files/COM10", false],
  ["files/CONSOLE.txt", false], ["files/nul-ish.txt", false], ["files/LPT", false], ["files/a.b.c", false], ["files/x..y", false],
  ["files/dir/", true], ["files/a/b/", true], ["manifest.json", false], ["files/€¹.txt", false],
];
for (const [name, folder] of allowed) {
  const b = enc.encode(name);
  ok(unsafeMember(name, folder) === null && unsafeMemberBytes(b, b.length, folder) === null, `allowed${folder ? " (folder)" : ""}: ${J(name)}`);
}
// (the bytes route reads only b[0, n): a safe name in a longer buffer, as the writer's name buffer is)
{
  const buf = new Uint8Array(64), n = enc.encodeInto("files/ok.txt", buf).written;
  buf.set(enc.encode("\\..\\x"), n);
  ok(unsafeMemberBytes(buf, n, false) === null, "the bytes route reads only the name's length");
}
ok(/2 files' names .*\.\.\\x, b:c\. Rename them/.test(unsafeNamesWhy(["/..\\x", "/b:c"], 2)) && /and 3 more/.test(unsafeNamesWhy(["/a:"], 4)), "the words name the files, and count the rest: " + unsafeNamesWhy(["/..\\x", "/b:c"], 2));

// (the writer's own check, behind preflight's: a member's string name and a folder's record bytes alike, refused before
// anything is written to the sink)
{
  let wrote = 0;
  const sink = { write: async (b) => { wrote++; return b; }, close: async () => {}, abort: async () => {} };
  const z = new ZipWriter(sink, { put: () => { wrote++; } }, { signal: new AbortController().signal, crc: { ask: async () => 0 }, progress: () => {} });
  let a = null, f = null;
  try { await z.member("files/..\\..\\outside.txt", [enc.encode("x")], false, Date.now(), 1 << 20, "cap"); } catch (e) { a = e; }
  const rec = enc.encode("files/bad:dir/");
  try { await z.folderAt(rec, 0, rec.length, 0, 0); } catch (e) { f = e; }
  ok(a instanceof ExportStopped && /can't go safely into a \.zip/.test(a.why) && f instanceof ExportStopped && /a : in a name/.test(f.why) && wrote === 0 && z.members === 0, "the writer refuses an unsafe name itself, by string and by a folder's record, writing nothing: " + J([a?.why, f?.why, wrote]));
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("all passed");
