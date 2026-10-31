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
  ["C2", "the tree check runs", X + "run.ts", "await treeUnchanged(w, plan.s0, got, opts.signal);", "void got;", "structure", /(a new file|a restore|a server-applied rename|a write that changed the file's (identity|folder)|the log trimmed (before|while) the check(| runs)) stops the export|the status line unchanged by every stopped export/, "chunk"],
  ["C3", "the member's cap is checked on its actual bytes", X + "zip.ts", "if (w.usize > cap) throw new ExportStopped(capWhy);", "", "capsgrow", /a document grown past its cap after preflight|the total grown past its cap after preflight|a manifest past a cap lowered after preflight/, "chunk"],
  ["C4", "the manifest is the last member", X + "run.ts", "    await zip.finish();", "    await zip.folder(\"files/zz-after/\", Date.now());\n    await zip.finish();", "basic", /manifest\.json is the last local member/, "chunk"],
  // (Cancel reaches a member's writing two ways, the pump's own check between slices and the worker's requests ended at
  // once: either alone stops it in time, so the rule is undone as both)
  ["C5", "Cancel stops a member's writing between slices", X + "zip.ts", "          this.check();\n          const slice = s.subarray(at, Math.min(s.length, at + SLICE));", "          const slice = s.subarray(at, Math.min(s.length, at + SLICE));", "cancel", /Cancel inside a 200 MB member/, "chunk", [X + "entry.ts", "  worker.cancelOn(ac.signal);", ""]],
  ["C6", "a stopped export aborts the picker's file", X + "zip.ts", "async abort() { try { await this.out.abort(); } catch {} }", "async abort() { try { await this.out.close(); } catch {} }", "picker", /aborts the picker's file/, "chunk"],
  ["C7", "the status line is stamped only after the file is committed", X + "run.ts", "    const closed = await sink.close(name);", "    await w.setLastExport({ at: Date.now(), partial: false, members: 0, bytes: 0 });\n    const closed = await sink.close(name);", "picker", /a picker whose close fails/, "chunk"],
  ["A1a", "an accepted write kept the file's identity", X + "run.ts", "&& got.is(op.path, a.id) && (parent", "&& (parent", "structure", /changed the file's identity|the status line unchanged by every stopped export/, "chunk"],
  ["A1b", "the log's floor is read again after the scan", X + "run.ts", "    await pause();\n  }\n  if ((await w.opsFloor()) > s0) throw new ExportStopped(trimmed);", "    await pause();\n  }", "structure", /the log trimmed while the check runs|the status line unchanged by every stopped export/, "chunk"],
  ["A2", "preflight checks a data file's bytes are here", X + "run.ts", "if (!(await w.present(e.path)))", "if (false)", "unavailable", /a data file whose bytes aren't here/, "chunk"],
  // (the rule's other half, the sweep skipping a file whose export holds its lock, is in the worker, which this harness
  // can't serve a copy of: the page's request interception doesn't reach a worker's script.  Undoing the lock's hold
  // through the handoff shows the same: the sweep then removes the handing-off archive)
  ["A3", "a live export's files are kept from other exports' sweeps (its lock held through the handoff)", X + "entry.ts", "    void after.finally(() => { worker.terminate(); release(); });", "    release();\n    void after.finally(() => { worker.terminate(); });", "hand", /during the handoff the archive's scratch file stays|leaving the handing-off archive alone|then the lock let go/, "chunk"],
  ["A6", "a failed stamp after the archive is saved is said as such", X + "run.ts", "    } catch (e) { r.stampFailed = String((e as Error)?.message ?? e); }", "    } catch (e) { throw e; }", "stamp", /a failed status write after the archive is saved/, "chunk"],
  ["D21", "a document is written as a stream, in bounded pieces of work", X + "run.ts", "  if (e.kind === \"notebook\") return notebookSlices(K.ipynbObject(content, toLines), pace);", "  if (e.kind === \"notebook\") return [new TextEncoder().encode(K.notebookFileText(content))];", "nearcap", /no main-thread task over 50 ms/, "chunk"],
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
for (const [f, n] of seen) if (n !== 1) { console.error("the control's file " + f + " wasn't built"); process.exit(1); }
await Bun.write(${JSON.stringify(outFile)}, r.outputs[0]);
console.log("built");`;
  const p = spawnSync("bun", ["-e", code], { cwd: root, encoding: "utf8" });
  return p.status === 0 ? null : (p.stderr || p.stdout).slice(0, 600);
}

const only = new Set(process.argv.slice(2));
const dir = mkdtempSync(join(tmpdir(), "sb-export-controls-"));
let bad = 0;
try {
  for (const [name, rule, file, find, repl, scenario, mustFail, kind, more] of CONTROLS) {
    if (only.size && !only.has(name)) continue;
    const subs = [[file, find, repl], ...(more ? [more] : [])];
    const out = join(dir, name + ".js");
    // (a control across both files is built per file: here C5's two are both in the chunk)
    const err = build(kind, subs, out);
    if (err) { bad++; console.log(`FAIL ${name} (${rule}): the control couldn't be built: ${err}`); continue; }
    const r = spawnSync(process.execPath, [join(here, "test-export.mjs")], { encoding: "utf8", env: { ...process.env, ONLY: scenario, [kind === "worker" ? "CHUNK_WORKER" : "CHUNK"]: out }, maxBuffer: 1 << 26 });
    const lines = (r.stdout ?? "").split("\n").filter((l) => /^FAIL /.test(l));
    // (the run's summary repeats each failure at its end: counted once)
    const failed = [...new Set(lines)];
    const named = failed.filter((l) => mustFail.test(l)), others = failed.filter((l) => !mustFail.test(l));
    const ok = named.length > 0 && others.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: undone "${rule}" (${file}): ${named.length ? "its check failed" : "ITS CHECK DIDN'T FAIL"}${others.length ? `; other checks failed too: ${others.join(" | ").slice(0, 400)}` : ""}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(bad ? `${bad} controls not as required` : "every control's check failed, and only it");
process.exit(bad ? 1 : 0);
