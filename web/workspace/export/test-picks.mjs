// ci: checks.3 order=132 runner=bun
// Download "with its files (.zip)"'s names (selected.ts, astra's DEP2B-ZIPNAME-1): every name is checked before any
// file is read; an unsafe name or a repeated one refuses the download, never renamed; a nested helper's name is fine.
//   bun web/workspace/export/test-picks.mjs
import { picksWhy, zipPicks } from "./selected.ts";
import { ExportStopped } from "./zip.ts";

let fails = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) fails++; };

ok(picksWhy(["nb.ipynb", "_code/helpers.py", "data/points.csv", "a b/ü.txt"]) === null, "a notebook, a nested helper, a data file and a name with a space and a non-ASCII letter: fine");
for (const [name, what] of [["..\\outside.txt", "parent traversal with \\"], ["C:\\temp\\outside.txt", "a drive"], ["\\\\server\\share\\x.txt", "a UNC path"], ["../x.txt", "a .. part"], ["/abs.txt", "a leading /"], ["NUL.txt", "a device name"], ["a:b.txt", "a colon"], ["dir/", "a trailing /"]]) {
  const why = picksWhy(["nb.ipynb", name]);
  ok(typeof why === "string" && why.includes("can't go safely into a .zip") && why.includes(name), `${what} (${name}) refused, by name: ${why?.slice(0, 90)}`);
}
{
  const why = picksWhy(["nb.ipynb", ...Array.from({ length: 7 }, (_, i) => `bad${i}\\x`)]);
  ok(why?.startsWith("7 files' names") && why.includes("and 2 more"), `many unsafe names: counted, the first 5 said: ${why?.slice(0, 60)}`);
}
ok(/the same name/.test(picksWhy(["nb.ipynb", "a.csv", "a.csv"]) ?? ""), "a name twice refused");

// (zipPicks refuses on the names alone, before any read, and before its worker or lock exist)
{
  let reads = 0;
  const pick = (name) => ({ name, read: async () => { reads++; return new Uint8Array(1); } });
  for (const picks of [[pick("nb.ipynb"), pick("..\\outside.txt")], [pick("nb.ipynb"), pick("x"), pick("x")]]) {
    let e;
    try { await zipPicks({ workerUrl: "about:blank", picks, name: "nb.zip", caps: { files: 10, file: 10, total: 10 }, signal: new AbortController().signal }); } catch (x) { e = x; }
    ok(e instanceof ExportStopped && e.plain && reads === 0, `zipPicks refused ${picks.map((p) => p.name).join(", ")} before reading anything: ${e?.why?.slice(0, 70)}`);
  }
  let e;
  try { await zipPicks({ workerUrl: "about:blank", picks: [pick("a"), pick("b"), pick("c")], name: "nb.zip", caps: { files: 2, file: 10, total: 10 }, signal: new AbortController().signal }); } catch (x) { e = x; }
  ok(e instanceof ExportStopped && /At most 2 files/.test(e.why) && reads === 0, `over the file count, refused before any read: ${e?.why}`);
}
console.log(fails ? `${fails} FAILED` : "ok: all");
process.exit(fails ? 1 : 0);
