// The export's controls (E1 r2, grader's G-1/G-2): each rule undone in a copy of the export's chunk (or worker), built as
// web/build.ts builds them, with a fixed text substitution asserted to have happened; then test-export.mjs runs the
// scenario that covers the rule against that copy (served in place of the built file), and its named check must FAIL,
// with every other check of the run passing.  A control whose check doesn't fail means the test doesn't guard its rule.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-export-controls.mjs [name ...]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..", "..");
const X = "web/workspace/export/";
// [name, the rule, file, find, replace, scenario, the checks that must fail (a regex on their FAIL lines: a closed list,
// the rule's own checks and those that follow from it alone; at least one must fail, and no other may), which file]
const CONTROLS = [
  ["C1", "a member's bytes are those of its capture", X + "run.ts", "const src = memberOf(c.entry, c.content, pace, images);", "const src = memberOf(c.entry, (await w.read(e.path)).content, pace, images);", "capture", /saved after its capture is not|a notebook saved after its capture|a board: the save before its capture in/, "chunk"],
  ["C2", "the tree check runs", X + "run.ts", "await treeUnchanged(w, plan.s0, log, opts.signal);", "void log;", "structure", /(a new file|a restore|a server-applied rename|a write that changed the file's (identity|folder|kind)|the log trimmed (before|while) the check(| runs)) stops the export|the status line unchanged by every stopped export/, "chunk"],
  ["C3", "the member's cap is checked on its actual bytes", X + "zip.ts", "if (w.usize > cap) throw new ExportStopped(capWhy);", "", "capsgrow", /a document grown past its cap after preflight|the total grown past its cap after preflight|a manifest past a cap lowered after preflight/, "chunk"],
  ["C4", "the manifest is the last member", X + "run.ts", "    await zip.finish();", "    await zip.member(\"files/zz-after.bin\", [new Uint8Array(1)], false, Date.now(), 10, \"x\");\n    await zip.finish();", "basic", /manifest\.json is the last local member/, "chunk"],
  // (Cancel reaches a member's writing two ways, the pump's own check between slices and the worker's requests ended at
  // once: either alone stops it in time, so the rule is undone as both)
  ["C5", "Cancel stops a member's writing between slices", X + "zip.ts", "          this.check();\n          const slice = s.subarray(at, Math.min(s.length, at + SLICE));", "          const slice = s.subarray(at, Math.min(s.length, at + SLICE));", "cancel", /Cancel inside a 200 MB member/, "chunk", [X + "entry.ts", "  worker.cancelOn(ac.signal);", ""]],
  ["C6", "a stopped export aborts the picker's file", X + "zip.ts", "async abort() { try { await this.out.abort(); } catch {} }", "async abort() { try { await this.out.close(); } catch {} }", "picker", /aborts the picker's file/, "chunk"],
  ["C7", "the status line is stamped only after the file is committed", X + "run.ts", "    const closed = await sink.close(name);", "    await w.setLastExport({ at: Date.now(), partial: false, members: 0, bytes: 0 });\n    const closed = await sink.close(name);", "picker", /a picker whose close fails/, "chunk"],
  ["A1a", "an accepted write kept the file's identity, exactly as captured", X + "run.ts", "c.ident !== null && c.ident === a.id", "true", "structure", /changed the file's identity|the status line unchanged by every stopped export/, "chunk"],
  ["A1b", "the log's floor is read again after the scan", X + "run.ts", "    await pause();\n  }\n  if ((await w.opsFloor()) > s0) throw new ExportStopped(trimmed);", "    await pause();\n  }", "structure", /the log trimmed while the check runs|the status line unchanged by every stopped export/, "chunk"],
  ["A1c", "an accepted write kept the kind captured at its path (astra's E1-R2-A1)", X + "run.ts", "!!c && c.kind === op.kind && c.ident", "!!c && c.ident", "structure", /a write that changed the file's kind|the status line unchanged by every stopped export/, "chunk"],
  // (E1 r2a, daybreak2's and grader's buffering controls: the observation boundary, the lookup's settle, removed)
  ["A1t", "the capture log's lookup settles its spool's buffered tail before reading", X + "run.ts", "    await this.spool.settle();\n", "", "tail", /tail t0: an accepted write|tail t1: an accepted write|tail t1: the capture log as the lookup read it/, "chunk"],
  ["A2", "preflight checks a data file's bytes are here", X + "run.ts", "if (!(await w.present(e.path)))", "if (false)", "unavailable", /a data file whose bytes aren't here/, "chunk"],
  // (the lock's hold through the handoff undone: the sweep then removes the handing-off archive.  The sweep's own half,
  // a file removed only under its export's lock, is A2s, in the worker)
  ["A3", "a live export's files are kept from other exports' sweeps (its lock held through the handoff)", X + "entry.ts", "    void after.finally(() => { worker.terminate(); release(); });", "    release();\n    void after.finally(() => { worker.terminate(); });", "hand", /during the handoff the archive's scratch file stays|leaving the handing-off archive alone|then the lock let go/, "chunk"],
  // (astra's E1-R2-A2, grader's controls: the sweep's per-file lock undone into r2's snapshot of the live exports, taken
  // when the sweep starts; each setup fault's cleanup removed.  These are in the worker, served by the test in place of
  // the built one, which the test asserts)
  ["A2s", "a sweep removes a file only while holding its export's lock, not by a snapshot of the live exports", X + "worker.ts", "      if (m.pauseMs) await new Promise((r) => setTimeout(r, m.pauseMs));\n      const d = await scratch();\n      const names: string[] = [];\n      for await (const [name] of (d as any).entries()) names.push(name);\n      let n = 0;\n      for (const name of names) {\n        const id = name.slice(0, 36);\n        await navigator.locks.request(m.lockPrefix + id, { ifAvailable: true }, async (lock: unknown) => {\n          if (!lock) return;\n          try { await d.removeEntry(name); n++; } catch {}\n        });\n      }", "      const q = await navigator.locks.query();\n      const live = new Set([...(q.held ?? []), ...(q.pending ?? [])].map((l: any) => String(l.name)).filter((n) => n.startsWith(m.lockPrefix)).map((n) => n.slice(m.lockPrefix.length)));\n      if (m.pauseMs) await new Promise((r) => setTimeout(r, m.pauseMs));\n      const d = await scratch();\n      const names: string[] = [];\n      for await (const [name] of (d as any).entries()) names.push(name);\n      let n = 0;\n      for (const name of names) {\n        if (live.has(name.slice(0, 36))) continue;\n        try { await d.removeEntry(name); n++; } catch {}\n      }", "scratch", /leaves its handing-off archive/, "worker"],
  ["A2p", "a failed probe leaves no file", X + "worker.ts", "      } finally { await d.removeEntry(m.name).catch(() => {}); }\n      return true;", "      } finally {}\n      return true;", "scratch", /the probe's (write|flush) fails|a scratch spool's open fails|the archive's scratch file's open fails/, "worker"],
  ["A2o", "a failed open closes its handle and removes its file", X + "worker.ts", "      } catch (e) {\n        try { h?.close(); } catch {}\n        await d.removeEntry(m.name).catch(() => {});\n        throw e;", "      } catch (e) {\n        throw e;", "scratch", /a scratch spool's open fails|the archive's scratch file's open fails/, "worker"],
  // (astra's E1-R2-A3 / E1-A4: the capture's wait for the workspace's lock not given the export's Cancel)
  ["A3w", "the capture's wait for the workspace's lock ends on Cancel", X + "run.ts", "r = await w.readLocked(e.path, signal);", "r = await w.readLocked(e.path);", "lockwait", /while the export waits for the workspace's lock|its request for the lock is withdrawn|the lock let go, nothing late/, "chunk"],
  // (astra's E1-A5: the board page's own saves settled before preflight)
  ["A5", "an export from a page waits for that page's own saves, and stops on a refused one", X + "entry.ts", "    await host.saveOpen?.();", "", "boardsave", /while this board's save is paused|while this board's last save was refused/, "chunk"],
  ["A6", "a failed stamp after the archive is saved is said as such", X + "run.ts", "    } catch (e) { r.stampFailed = String((e as Error)?.message ?? e); }", "    } catch (e) { throw e; }", "stamp", /a failed status write after the archive is saved/, "chunk"],
  ["D21", "a document is written as a stream, in bounded pieces of work", X + "run.ts", "  if (e.kind === \"notebook\") return notebookSlices(content, ipynbObject, pace);", "  if (e.kind === \"notebook\") return [new TextEncoder().encode(notebookFileText(content))];", "nearcap", /no main-thread task over 50 ms/, "chunk"],
  // ---------------------------------------------------------------- E1 r2a heap plan r2c (frozen e3bd7f07): each rule
  // undone, its own checks FAIL and no other
  // (P-3 and r1's: the folder's manifest line from its record)
  ["R-fid", "a folder's fid is in its manifest entry", X + "rows.ts", "  if (R[FID] >= 0) { at = putBytes(o, at, M_FID, 0, M_FID.length); at = putBytes(o, at, b, R[FID], R[FID + 1]); }", "", "writer,identity", /^FAIL (writer: the direct writer|identity \((opfs|picker|blob)\)(: every member| P-1| P-3))/, "chunk"],
  ["R-mode", "a folder's mode is in its manifest entry", X + "rows.ts", "  if (R[MODE] >= 0) { at = putBytes(o, at, M_MODE, 0, M_MODE.length); at = putBytes(o, at, b, R[MODE], R[MODE + 1]); }", "", "writer,identity", /^FAIL (writer: the direct writer|identity \((opfs|picker|blob)\)(: every member| P-3))/, "chunk"],
  ["R-empty", "an absent field is left out, not written as \"\"", X + "rows.ts", "  if (R[FID] >= 0) { at = putBytes(o, at, M_FID, 0, M_FID.length); at = putBytes(o, at, b, R[FID], R[FID + 1]); }", "  if (R[FID] >= 0) { at = putBytes(o, at, M_FID, 0, M_FID.length); at = putBytes(o, at, b, R[FID], R[FID + 1]); } else { at = putBytes(o, at, M_FID, 0, M_FID.length); o[at++] = 0x22; o[at++] = 0x22; }", "writer,identity", /^FAIL (writer: the direct writer|identity \((opfs|picker|blob)\)(: every member| P-3))/, "chunk"],
  ["R-order", "the manifest fragments in manifestEntry's key order", X + "rows.ts", "  at = putBytes(o, at, M_PATH, 0, M_PATH.length);\n  at = putBytes(o, at, b, R[PATH], R[PATH + 1]);\n  at = putBytes(o, at, M_KIND, 0, M_KIND.length);", "  at = putBytes(o, at, SWAP, 0, SWAP.length);\n  at = putBytes(o, at, b, R[PATH], R[PATH + 1]);", "writer,identity", /^FAIL (writer: the direct writer|identity \((opfs|picker|blob)\)(: every member| P-1| P-3))/, "chunk", [X + "rows.ts", "const M_PATH = frag('{\"path\":'),", "const SWAP = frag('{\"kind\":\"folder\",\"path\":'), M_PATH = frag('{\"path\":'),"]],
  ["R-slash", "a folder's member name ends in \"/\"", X + "rows.ts", "  if (folder) b[at++] = 0x2f;\n", "", "writer,identity", /^FAIL (writer: the direct writer|identity \((opfs|picker|blob)\): every member)/, "chunk", [X + "rows.ts", "+ (e.kind === \"folder\" ? 1 : 0) + 4 + jsonLen(e.path)", "+ 4 + jsonLen(e.path)"]],
  // (P-1, H-A3: the numbers' JSON)
  ["R-num", "a number is written with JSON.stringify's semantics (NaN, ±Infinity as null)", X + "bytes.ts", "  if (n !== n || n === Infinity || n === -Infinity) return putAscii(b, at, \"null\");\n  if (n === 0)", "  if (n === 0)", "writer,identity", /^FAIL (writer: the direct writer|identity( \((opfs|picker|blob)\))?(: every member| P-1))/, "chunk", [X + "bytes.ts", "  if (n !== n || n === Infinity || n === -Infinity) return 4;\n", ""]],
  // (P-6: each fast path's slow path dropped)
  ["R-emit", "a folder's local header waits for the archive's slice when it is due", X + "zip.ts", "    if (p) return p.then(() => this.central(n, 0x0800, 0, time, date, 0, 0, 0, offset, true));", "    if (p) void p;", "fastpaths", /^FAIL (fastpaths \(the archive held\)|no page errors: DataCloneError)/, "chunk"],
  ["R-central", "a folder's central record waits for the CD spool's slice when it is due", X + "zip.ts", "    return this.central(n, 0x0800, 0, time, date, 0, 0, 0, offset, true);\n  }", "    void this.central(n, 0x0800, 0, time, date, 0, 0, 0, offset, true);\n    return undefined;\n  }", "fastpaths", /^FAIL (fastpaths \(the central directory held\)|no page errors: DataCloneError)/, "chunk"],
  ["R-append", "a folder's capture line waits for the capture spool's slice when it is due", X + "rows.ts", "  if (p) return p.then(() => captureFolderNow(log, b));", "  if (p) { void p.then(() => captureFolderNow(log, b)); return; }", "fastpaths", /^FAIL (fastpaths \(the capture log held\)|no page errors: DataCloneError)/, "chunk"],
  ["R-breathe", "the writing loop yields when 8 ms have passed", X + "run.ts", "  if (performance.now() - lastYield > 8) return pause().then(() => { lastYield = performance.now(); });", "  if (performance.now() - lastYield > 8) lastYield = performance.now();", "yields", /^FAIL yields: without OPFS/, "chunk"],
  // (R1: the clock at every record boundary)
  ["R-clock", "breathe reads the clock at every record boundary", X + "run.ts", "let clockReads = 0;\nconst breathe = (): Promise<void> | undefined => {\n  clockReads++;", "let clockReads = 0, skip = 0;\nconst breathe = (): Promise<void> | undefined => {\n  if ((++skip & 63) !== 0) return;\n  clockReads++;", "identity70k", /^FAIL identity70k \(R1\)/, "chunk"],
  // (O-1, R3: the recycled slices)
  ["R-alloc", "a spool's flush recycles its two slices (no new slice per flush)", X + "zip.ts", "    this.a = this.b ?? newSlot();\n    this.b = s;\n    if (this.a.back) this.waits++;\n    return this.a.back ?? undefined;\n  }\n  /** What is in the slice written out", "    this.a = newSlot();\n    this.b = s;\n    if (this.a.back) this.waits++;\n    return undefined;\n  }\n  /** What is in the slice written out", "identity70k", /^FAIL identity70k \(R3\)/, "chunk"],
  ["R-reuse", "the picker's slice is reused only after its write resolved", X + "zip.ts", "  async write(buf: Uint8Array, len: number) { await this.out.write(buf.subarray(0, len)); return buf; }", "  async write(buf: Uint8Array, len: number) { void this.out.write(buf.subarray(0, len)); return buf; }", "identity", /^FAIL identity \(picker\)/, "chunk"],
  // (H-A2: only a slice's valid prefix consumed, per consumer)
  ["R-whole-append", "the worker writes only a slice's valid length", X + "worker.ts", "      const data = new Uint8Array(m.data as ArrayBuffer, 0, m.len);", "      const data = new Uint8Array(m.data as ArrayBuffer);", "identity", /^FAIL identity( \((opfs|picker)\)(: every member|: this build| P-1| P-3)| P-1: every capture line)/, "worker"],
  ["R-whole-read", "a read's consumer takes only [0, n)", X + "zip.ts", "      yield s.buf.subarray(0, r.n);", "      yield s.buf;", "identity", /^FAIL identity( \((opfs|picker)\)(: every member|: this build| P-1| P-3)| P-1: every capture line)/, "chunk"],
  ["R-whole-picker", "the picker writes only a slice's valid prefix", X + "zip.ts", "await this.out.write(buf.subarray(0, len)); return buf; }", "await this.out.write(buf); return buf; }", "identity", /^FAIL identity \(picker\)/, "chunk"],
  ["R-whole-blob", "the Blob sink keeps only a slice's valid prefix", X + "zip.ts", "    this.parts.push(new Blob([buf.subarray(0, len) as BlobPart]));", "    this.parts.push(new Blob([buf as BlobPart]));", "identity", /^FAIL identity \(blob\)/, "chunk"],
  ["R-late", "a Cancel ends the requests in flight; their late answers are ignored", X + "zip.ts", "counts.stopped = true; for (const [, p] of this.waiting) p[1](new ExportStopped(\"cancelled\")); this.waiting.clear();", "counts.stopped = true;", "slicecancel", /^FAIL slices: Cancel with a slice in the worker's hands/, "chunk"],
  // (H-A1, rows-framing)
  ["R-early", "a record that doesn't fit the slice flushes it first", X + "rows.ts", "  const n = rowLen(e, captured);\n  const p = rows.room(n);", "  const n = rowLen(e, captured);\n  const p = rows.room(1);", "framing", /^FAIL (framing: (the fixture's records are the sizes|the rows spool's segments|no padding|every record|the rows spool cut short \(OPFS\))|P-8: (the threshold the test computes|without OPFS, \d+ folders))/, "chunk"],
  ["R-fixed", "replay reads the rows spool's segments, not fixed 1 MiB slices", X + "zip.ts", "      const len = this.segmented ? this.segs[i] : Math.min(SLICE, this.out - at);", "      const len = Math.min(SLICE, this.out - at);", "framing", /^FAIL framing: (the fixture's records are the sizes|the rows spool's segments|no padding|every record)/, "chunk"],
  ["R-trunc", "a rows spool found shorter than written is refused", X + "run.ts", "        if (end < 0) cutShort();", "        if (end < 0) break;", "framing", /^FAIL framing: the rows spool cut short/, "chunk", [[X + "zip.ts", "      if (r.n !== len) { if (this.segmented) cutShort(); throw", "      if (r.n !== len && !this.segmented) { throw"], [X + "zip.ts", "        if (this.segmented && ab.byteLength !== this.segs[i]) cutShort();\n", ""]]],
  // (P-7, O-2: each removal site of the rows spool, and its ownership)
  ["R-refusal", "the rows spool is removed before the refusal is shown (not after its dismissal)", X + "entry.ts", "    if (plan.unavailable.length) { await rows.remove(); return await refused(plan); }", "    if (plan.unavailable.length) { const r = await refused(plan); await rows.remove(); return r; }", "rows", /^FAIL rows: refusal/, "chunk"],
  ["R-stopped", "the rows spool is removed before the stopped panel is shown", X + "entry.ts", "    await rows.remove();\n    await stopped(e);", "    await stopped(e);\n    await rows.remove();", "rows", /^FAIL rows: Cancel in preflight/, "chunk"],
  ["R-ready", "Cancel at Ready removes the rows spool", X + "entry.ts", "      if ((await ready(plan)) === \"cancel\") { await rows.remove(); box.replaceChildren(); return; }", "      if ((await ready(plan)) === \"cancel\") { box.replaceChildren(); return; }", "rows", /^FAIL rows: (Cancel at Ready|the picker closed at Ready)/, "chunk"],
  ["R-picker", "a closed picker keeps the rows spool for the Save… that follows", X + "entry.ts", "          if (e?.name === \"AbortError\") continue; // (the picker closed: back to ready)", "          if (e?.name === \"AbortError\") { await rows.remove(); continue; }", "rows", /^FAIL rows: the picker closed at Ready/, "chunk"],
  ["R-finally", "writing's own cleanup removes the rows spool", X + "run.ts", "    await rows.remove();\n    const st = T().stats;", "    const st = T().stats;", "rows", /^FAIL rows: a finished export leaves no records/, "chunk"],
  ["R-sweep", "the stale sweep removes an abandoned rows file", X + "worker.ts", "        const id = name.slice(0, 36);", "        const id = name.slice(0, 36);\n        if (name.endsWith(\"-rows\")) continue;", "rows", /^FAIL rows: an abandoned -rows file/, "worker"],
  ["R-own", "the rows spool is owned before its open (a failure after its file is made removes it)", X + "run.ts", "  await rows.open();", "  await rows.open().catch((e) => { rows.remove = async () => {}; throw e; });", "rows", /^FAIL rows \(O-2\): the rows spool fails after its file is made/, "chunk"],
  // (P-9 and O-3)
  ["R-resample", "a folder's captured is preflight's, not resampled in writing", X + "rows.ts", "  at = putBytes(o, at, b, R[CAPTURED], R[CAPTURED + 1]);", "  at = putNum(o, at, Date.now());", "metadata", /^FAIL metadata \(P-9\): every folder's captured/, "chunk"],
  ["R-reread", "writing doesn't read a folder's row again (O-3)", X + "run.ts", "          p = manifestFolder(man, seg, first);\n          if (p) await p;", "          { const e2 = await w.stat(JSON.parse(dec.decode(seg.subarray(R[PATH], R[PATH + 1])))); if (!e2) { p = manifestFolder(man, seg, first); if (p) await p; } else { const s2 = (first ? \"\" : \",\") + manifestEntry(e2, Number(dec.decode(seg.subarray(R[CAPTURED], R[CAPTURED + 1])))); p = man.room(3 * s2.length); if (p) await p; man.done(man.at + new TextEncoder().encodeInto(s2, man.buf.subarray(man.at)).written); } }", "metadata", /^FAIL metadata \(P-9\): an edit before Save is not exported/, "chunk"],
  // (P-8: the records counted toward the in-memory spools' cap)
  ["R-count", "without OPFS the records count toward the in-memory spools' cap", X + "run.ts", "plan.cdSpool + plan.manSpool + plan.capSpool + rows.size > cap(\"spoolBlob\")", "plan.cdSpool + plan.manSpool + plan.capSpool > cap(\"spoolBlob\")", "framing", /^FAIL P-8: without OPFS, the same with the cap at \d+ \(at the threshold\)/, "chunk"],
];

/** The chunk or the worker built as web/build.ts builds it, with the substitutions applied (each asserted once). */
function build(kind, subs, outFile) {
  const entry = kind === "worker" ? X + "worker.ts" : X + "entry.ts";
  const code = `
const subs = ${JSON.stringify(subs)};
const seen = new Map(subs.map(([f]) => [f, 0]));
const r = await Bun.build({ entrypoints: [${JSON.stringify(join(root, entry))}], target: "browser", format: "esm", minify: true,
  plugins: [{ name: "control", setup(b) { b.onLoad({ filter: /\\/web\\/workspace\\/export\\/[a-z0-9-]+\\.ts$/ }, async (a) => {
    let text = await Bun.file(a.path).text();
    for (const [f, find, repl] of subs) if (a.path.endsWith("/" + f)) {
      const n = text.split(find).length - 1;
      if (n !== 1) throw new Error("the control's text is in " + f + " " + n + " times, not once: " + find.slice(0, 80));
      text = text.replace(find, () => repl); seen.set(f, seen.get(f) + 1);
    }
    return { contents: text, loader: "ts" };
  }); } }] });
if (!r.success) { for (const m of r.logs) console.error(m); process.exit(1); }
const want = new Map(); for (const [f] of subs) want.set(f, (want.get(f) ?? 0) + 1);
for (const [f, n] of seen) if (n !== want.get(f)) { console.error("the control's file " + f + " wasn't built"); process.exit(1); }
await Bun.write(${JSON.stringify(outFile)}, r.outputs[0]);
console.log("built");`;
  const p = spawnSync("bun", ["-e", code], { cwd: root, encoding: "utf8" });
  return p.status === 0 ? null : (p.stderr || p.stdout).slice(0, 600);
}

const only = new Set(process.argv.slice(2));
const dir = mkdtempSync(join(tmpdir(), "sb-export-controls-"));
let bad = 0;
try {
  for (const [name, rule, file, find, repl, scenario, mustFail, kind, more, run] of CONTROLS) {
    if (only.size && !only.has(name)) continue;
    // (more: one further substitution, or (r2c) a list of them; run: (r2c) another test file and its environment)
    const subs = [[file, find, repl], ...(more ? (Array.isArray(more[0]) ? more : [more]) : [])];
    const out = join(dir, name + ".js");
    // (a control across both files is built per file: here C5's two are both in the chunk)
    const err = build(kind, subs, out);
    if (err) { bad++; console.log(`FAIL ${name} (${rule}): the control couldn't be built: ${err}`); continue; }
    const r = spawnSync(process.execPath, [join(here, run?.test ?? "test-export.mjs"), ...(run?.args ?? [])], { encoding: "utf8", env: { ...process.env, ONLY: scenario, ...(run?.env ?? {}), [kind === "worker" ? "CHUNK_WORKER" : "CHUNK"]: out }, maxBuffer: 1 << 26 });
    const lines = (r.stdout ?? "").split("\n").filter((l) => /^FAIL /.test(l));
    // (the run's summary repeats each failure at its end: counted once)
    const failed = [...new Set(lines)];
    const named = failed.filter((l) => mustFail.test(l)), others = failed.filter((l) => !mustFail.test(l));
    const ok = named.length > 0 && others.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: undone "${rule}" (${file}): ${named.length ? "its check failed" : "ITS CHECK DIDN'T FAIL"}${others.length ? `; other checks failed too: ${others.join(" | ").slice(0, 400)}` : ""}`);
    // (the exact FAIL set, each line's head: the packet lists it per control)
    for (const l of failed) console.log(`     ${mustFail.test(l) ? "named" : "OTHER"}: ${l.slice(5, 150)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(bad ? `${bad} controls not as required` : "every control's check failed, and only it");
process.exit(bad ? 1 : 0);
