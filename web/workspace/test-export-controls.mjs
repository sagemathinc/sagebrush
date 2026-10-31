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
  ["C4", "the manifest is the last member", X + "run.ts", "    await zip.finish();", "    await zip.folder(\"files/zz-after/\", Date.now());\n    await zip.finish();", "basic", /manifest\.json is the last local member/, "chunk"],
  // (Cancel reaches a member's writing two ways, the pump's own check between slices and the worker's requests ended at
  // once: either alone stops it in time, so the rule is undone as both)
  ["C5", "Cancel stops a member's writing between slices", X + "zip.ts", "          this.check();\n          const slice = s.subarray(at, Math.min(s.length, at + SLICE));", "          const slice = s.subarray(at, Math.min(s.length, at + SLICE));", "cancel", /Cancel inside a 200 MB member/, "chunk", [X + "entry.ts", "  worker.cancelOn(ac.signal);", ""]],
  ["C6", "a stopped export aborts the picker's file", X + "zip.ts", "async abort() { try { await this.out.abort(); } catch {} }", "async abort() { try { await this.out.close(); } catch {} }", "picker", /aborts the picker's file/, "chunk"],
  ["C7", "the status line is stamped only after the file is committed", X + "run.ts", "    const closed = await sink.close(name);", "    await w.setLastExport({ at: Date.now(), partial: false, members: 0, bytes: 0 });\n    const closed = await sink.close(name);", "picker", /a picker whose close fails/, "chunk"],
  ["A1a", "an accepted write kept the file's identity, exactly as captured", X + "run.ts", "c.ident !== null && c.ident === a.id", "true", "structure", /changed the file's identity|the status line unchanged by every stopped export/, "chunk"],
  ["A1b", "the log's floor is read again after the scan", X + "run.ts", "    await pause();\n  }\n  if ((await w.opsFloor()) > s0) throw new ExportStopped(trimmed);", "    await pause();\n  }", "structure", /the log trimmed while the check runs|the status line unchanged by every stopped export/, "chunk"],
  ["A1c", "an accepted write kept the kind captured at its path (astra's E1-R2-A1)", X + "run.ts", "!!c && c.kind === op.kind && c.ident", "!!c && c.ident", "structure", /a write that changed the file's kind|the status line unchanged by every stopped export/, "chunk"],
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
