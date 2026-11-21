// sagebrush notebook run FILE.ipynb [--json] [--timeout S] [--write]: every code cell of a notebook run as the
// reactive notebook runs it (design/reactive-notebook.md), here, without a browser, and each cell's outputs or its
// error reported; --write puts this run's outputs into the file.  For an agent working on its own copy of a notebook
// (a Delegate task, pair-delegate plan E1): it runs the copy and checks it, never the person's.
//
// As the notebook page runs it: one interpreter in the notebook's language (its kernelspec, web/notebook/nbformat.js
// modeOf), the reactive scheduler over its code cells in page order (src/reactive-session.ts runCells: dependencies,
// page-order scoping, a cell that raises cancelling what reads it), each cell run with the seed the page gives it
// (SHA-256 of "<the notebook's seed>:<the cell's id>", web/notebook/notebook.js cellSeed) and its `_` names its own.
// The notebook's seed is kept in the file as metadata.sagebrush.seed; a notebook with none gets a new one, which
// --write keeps.  The interpreter's working directory is the notebook's folder, so the files beside it (a module it
// imports, data it reads) are there, as in `sagebrush notebook`.
//
// What --write writes, per code cell: its outputs as the notebook keeps them (board-run.ts collect: streams joined,
// displays, under the same caps), its run time (metadata.sagebrush.ms) and its execution count (the order cells
// finished in); a cell not run gets no outputs and no count.  Everything else in the file is written back as it was
// read.  The file is replaced whole (src/fs-write.ts), and only if it is still as it was read: a file changed while
// the cells ran is left alone, and said.
//
// The code runs here, as you, as `sagebrush -c` runs it.  Confinement is the caller's: an agent's runner runs this
// command under an enforced sandbox (Deno's permissions, limited to the task's folder), and with --confine, which
// the engine enforces too (src/runtime/modules.ts setConfine): every path the program uses is resolved where it really
// leads and refused outside the folders named, so a link to the outside, which Deno's checks (by the path as written)
// let through, is refused here.
//
// Loaded only for `notebook run` (src/cli.ts), so nothing else starts slower.

import { readFileSync, realpathSync } from "fs";
import { basename, dirname, resolve } from "path";
import { createHash, randomBytes } from "crypto";
import { startInterpreter, runCells, type Mode } from "./reactive-session";
import { collect, interactError, outputLine } from "./board-run";
import { oneLine, textLines } from "./terminal-text";
import { writeReplacing } from "./fs-write";
import { confinedPath } from "./runtime/modules";

const USAGE = `usage: sagebrush notebook run FILE.ipynb [--json] [--timeout S] [--write] [--confine DIR]...
  run every code cell of a notebook as the reactive notebook runs it (its
  language, its order by what each cell reads, and its seeds), in the
  notebook's folder, and report each cell's output, or its error; the exit
  status is 1 if a cell failed, has an error, was not run or ran out of time
  --json         the report as JSON
  --timeout S    the seconds a cell may run (default 60), from when the
                 interpreter begins it; longer is an error: the cell is
                 interrupted, and the interpreter stopped 2 s later if it
                 doesn't stop
  --write        put this run's outputs into FILE (each cell's outputs, run
                 time and count; the notebook's seed), only if FILE is still
                 as it was read
  --confine DIR  the program may use files only inside DIR (give it once
                 per folder; FILE's must be one of them): a path is refused
                 unless it ends inside one, and inside them no link is
                 followed, even one pointing inside, nor a FIFO, device or
                 file with more than one hard link opened; the folders above
                 them may be links (on macOS, /var is), and are resolved.
                 Kept: standard input, output and error; any other inherited
                 descriptor is refused. A build that reads its Python library
                 from disk admits the library's folder too
  The code runs here, as you, as \`sagebrush -c\` runs it: run notebooks you trust.
`;

/** The largest notebook file read (bytes): a notebook's outputs make it large, but not past this. */
export const NOTEBOOK_FILE_MAX = 64 * 2 ** 20;
// (seconds: Node's timers are at most 2^31 - 1 ms)
const MAX_TIMEOUT = 2147483;
const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const SEED = /^[0-9a-f]{64}$/;
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const say = (msg: string) => process.stderr.write(`sagebrush notebook run: ${oneLine(msg)}\n`);

type Status = "ok" | "failed" | "error" | "not run" | "timeout";
export interface CellReport {
  /** its place among the notebook's code cells, from 1 */
  n: number;
  id: string;
  status: Status;
  ms?: number;
  stdout: string;
  stderr: string;
  outputs: { type: string; text?: string; bytes?: number }[];
  error?: string;
}

/** The language a notebook's metadata names (web/notebook/nbformat.js modeOf, the same rule). */
export function modeOf(metadata: any): Mode {
  const k = metadata?.kernelspec ?? {};
  const lang = `${k.name ?? ""} ${k.language ?? ""} ${metadata?.language_info?.name ?? ""}`;
  return /magma/i.test(lang) ? "magma" : /matlab|octave/i.test(lang) ? "matlab" : /sage/i.test(lang) ? "sage" : "python";
}
const joinText = (t: unknown) => (Array.isArray(t) ? t.join("") : typeof t === "string" ? t : "");

/** A notebook's JSON read for running: its code cells (key = the cell's id), its mode and seed; or why it can't be. */
export function readNotebook(text: string): { nb: any; mode: Mode; seed: string; newSeed: boolean; cells: { key: string; code: string; index: number }[] } | Error {
  let nb: any;
  try { nb = JSON.parse(text); } catch (e: any) { return new Error(`not JSON: ${e?.message ?? e}`); }
  if (!nb || typeof nb !== "object" || Array.isArray(nb) || !Array.isArray(nb.cells)) return new Error("not a Jupyter notebook (nbformat 4): no cells");
  if (nb.nbformat !== undefined && nb.nbformat !== 4) return new Error(`nbformat ${JSON.stringify(nb.nbformat)}: only nbformat 4 is run (open it in Sagebrush and save it first)`);
  const seen = new Set<string>(), cells: { key: string; code: string; index: number }[] = [];
  for (const [index, c] of nb.cells.entries()) {
    if (!c || typeof c !== "object" || c.cell_type !== "code") continue;
    // (a cell's id is its seed's and its names' key: one without a valid one gets `cell-<place>`, which --write keeps)
    let id = typeof c.id === "string" && VALID_ID.test(c.id) ? c.id : `cell-${index + 1}`;
    if (seen.has(id)) return new Error(`two cells have the id ${JSON.stringify(id)}: a cell's id must be its own`);
    seen.add(id);
    cells.push({ key: id, code: joinText(c.source), index });
  }
  const given = nb.metadata?.sagebrush?.seed;
  const newSeed = !(typeof given === "string" && SEED.test(given));
  return { nb, mode: modeOf(nb.metadata), seed: newSeed ? randomBytes(32).toString("hex") : given, newSeed, cells };
}

/** The `notebook run` command; returns the exit code. */
export async function notebookRun(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) { process.stdout.write(USAGE); return 0; }
  let file: string | null = null, json = false, write = false, timeout = 60;
  const confine: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--write") write = true;
    else if (a === "--timeout") timeout = Number(argv[++i]);
    else if (a === "--confine") { const d = argv[++i]; if (d === undefined || d === "") { say("--confine takes a folder"); return 2; } confine.push(d); }
    else if (a.startsWith("-")) { say(`unknown option ${a}`); process.stderr.write(USAGE); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null) { process.stderr.write(USAGE); return 2; }
  if (!/\.ipynb$/i.test(file)) { say(`${file}: a notebook is an .ipynb file`); return 2; }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) { say(`--timeout takes a number of seconds, more than 0 and at most ${MAX_TIMEOUT}`); return 2; }

  // (confined: the roots as real paths; the notebook itself is read and written only through the same check its
  // program's paths get: within a root, no link on the way, a regular file with one link)
  let roots: string[] | undefined;
  if (confine.length) {
    try { roots = confine.map((d) => realpathSync(d)); } catch (e: any) { say(`--confine: ${e?.code ?? e?.message ?? e}`); return 2; }
    try { confinedPath(roots, process.cwd(), file); } catch { say(`${file} is not in a folder named with --confine, or is reached through a link`); return 2; }
  }
  const at = (f: string) => (roots ? confinedPath(roots, process.cwd(), f) : f);
  let bytes: Buffer;
  try { bytes = readFileSync(at(file)); } catch (e: any) { say(`${file}: ${e?.code ?? e?.message ?? e}`); return 1; }
  if (bytes.length > NOTEBOOK_FILE_MAX) { say(`${file}: ${bytes.length} bytes, more than the ${NOTEBOOK_FILE_MAX} a notebook run reads`); return 1; }
  const read = readNotebook(bytes.toString("utf8"));
  if (read instanceof Error) { say(`${file}: ${read.message}`); return 1; }
  const { nb, mode, seed, newSeed, cells } = read;

  // (the library on disk, in a build that doesn't embed it, is read by the importer through the same checks)
  if (roots) { const lib = libOnDisk(); if (lib) roots = [...roots, lib]; }
  const run = await runNotebook(cells, { mode, seed, timeout, dir: dirname(resolve(file)), confine: roots });

  // the file, with this run's outputs, if asked: only if it is still as it was read
  let wrote = false;
  if (write) {
    let now: Buffer | null = null;
    try { now = readFileSync(at(file)); } catch {}
    if (!now || !now.equals(bytes)) { say(`${file} changed while its cells ran: not written`); return 1; }
    const order = [...run.finished];
    for (const { key, index } of cells) {
      const c = nb.cells[index], r = run.reports.get(key)!;
      c.id = key;
      const ran = r.status === "ok" || r.status === "failed" || r.status === "timeout";
      c.outputs = ran ? run.outputs.get(key) ?? [] : [];
      c.execution_count = ran && order.includes(key) ? order.indexOf(key) + 1 : null;
      const md = c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? c.metadata : {};
      const sb = md.sagebrush && typeof md.sagebrush === "object" && !Array.isArray(md.sagebrush) ? { ...md.sagebrush } : {};
      if (ran && r.ms !== undefined) sb.ms = r.ms;
      else delete sb.ms;
      c.metadata = Object.keys(sb).length ? { ...md, sagebrush: sb } : (({ sagebrush: _s, ...rest }) => rest)(md);
    }
    const md = nb.metadata && typeof nb.metadata === "object" && !Array.isArray(nb.metadata) ? nb.metadata : {};
    const sb = md.sagebrush && typeof md.sagebrush === "object" && !Array.isArray(md.sagebrush) ? md.sagebrush : {};
    nb.metadata = { ...md, sagebrush: { ...sb, seed } };
    try {
      const target = at(file);
      writeReplacing(dirname(target), basename(target), new TextEncoder().encode(JSON.stringify(nb, null, 1)));
    } catch (e: any) { say(`could not write ${file}: ${e?.code ?? e?.message ?? e}`); return 1; }
    wrote = true;
  }

  // the report
  const list = cells.map(({ key }) => run.reports.get(key)!);
  const allOk = list.every((r) => r.status === "ok");
  if (json) {
    process.stdout.write(JSON.stringify({ file, mode, ok: allOk, seed: newSeed ? "new" : "kept", cells: list, ...(wrote ? { wrote: file } : {}) }, null, 2) + "\n");
  } else {
    const w = process.stdout;
    if (!list.length) w.write(`${oneLine(file)}: no code cells\n`);
    for (const r of list) {
      w.write(`${String(r.n).padStart(3)}  ${r.status.toUpperCase().padEnd(8)} (${oneLine(JSON.stringify(r.id))})${r.ms !== undefined ? `  ${r.ms} ms` : ""}\n`);
      const body = r.status === "ok" ? [r.stdout, ...r.outputs.map(outputLine)].filter(Boolean).join("\n") : r.error ?? "";
      if (body.trim()) w.write(indent(cutLines(textLines(body.replace(/\n+$/, "")), 40)) + "\n");
    }
    const count = (s: Status) => list.filter((r) => r.status === s).length;
    const parts = (["ok", "failed", "error", "timeout", "not run"] as Status[]).filter((s) => count(s)).map((s) => `${count(s)} ${s}`);
    if (list.length) w.write(`${oneLine(file)}: ${parts.join(", ")} (of ${list.length} code cell${list.length === 1 ? "" : "s"}, ${mode})\n`);
    if (wrote) w.write(`wrote ${oneLine(file)}\n`);
    if (run.dead && run.workerErr.length) process.stderr.write(textLines(run.workerErr.join("")).slice(0, 4000));
  }
  return allOk ? 0 : 1;
}

/** A notebook's code cells run as the reactive notebook runs them, in `dir`: each cell's report and outputs (as the
 * notebook keeps them), and the order cells finished in. */
export async function runNotebook(cells: { key: string; code: string }[], o: { mode: Mode; seed: string; timeout: number; dir: string; confine?: string[] }) {
  const reports = new Map<string, CellReport>(cells.map(({ key }, i) => [key, { n: i + 1, id: key, status: "not run" as Status, stdout: "", stderr: "", outputs: [] }]));
  const label = (k: string) => { const r = reports.get(k); return r ? `cell ${r.n}` : "a cell"; };
  const outputs = new Map<string, any[]>(), kept = { run: 0 };
  const finished = new Set<string>();
  if (!cells.length) return { reports, outputs, finished, dead: null as string | null, workerErr: [] as string[] };
  const interp = await startInterpreter({ mode: o.mode, label, dir: o.dir, ...(o.confine ? { confine: o.confine } : {}) });
  try {
    const r = await runCells(interp, cells, {
      mode: o.mode, seedOf: (k) => hex(`${o.seed}:${k}`), timeoutMs: o.timeout * 1000, label, noun: "cell",
      onMessage: (k, m) => { let l = outputs.get(k); if (!l) outputs.set(k, (l = [])); collect(l, m, kept); },
    });
    for (const k of r.reactive.times.keys()) finished.add(k);
    const dead = interp.dead();
    const late = r.reactive.graph.closure([...r.timedOut]);
    for (const { key } of cells) {
      const rep = reports.get(key)!, list = outputs.get(key) ?? [];
      Object.assign(rep, summary(list));
      const ms = r.reactive.times.get(key);
      if (ms !== undefined && r.reactive.outcome.has(key)) rep.ms = Math.round(ms);
      if (r.errors.has(key)) { rep.status = "error"; rep.error = r.errors.get(key); rep.stdout = rep.stderr = ""; rep.outputs = []; outputs.set(key, []); }
      else if (r.timedOut.has(key)) { rep.status = "timeout"; rep.error = `ran out of time: stopped after ${o.timeout} s` + (rep.stderr ? "\n" + rep.stderr : ""); }
      else if (r.reactive.outcome.get(key) === "ok" && !r.failed.has(key)) {
        rep.status = "ok";
        const ie = interactError(list);
        if (ie !== null) { rep.status = "failed"; rep.error = ie; }
      } else if (r.failed.has(key) || r.reactive.outcome.get(key) === "exception") { rep.status = "failed"; rep.error = rep.stderr.trim() || "raised an error"; }
      else {
        const st = r.states.get(key), by = st?.state === "cancelled" ? st : null;
        const slow = [...r.timedOut].find((t) => t !== key && late.has(key) && r.reactive.graph.closure([t]).has(key));
        rep.error = slow ? `not run: ${label(slow)}, which it depends on, ran out of time` : by ? `not run: ${label((by as any).by)}, which it depends on, ${(by as any).why === "exception" ? "raised an error" : (by as any).why === "error" ? "has an error" : "was interrupted"}` : dead ? `not run: ${dead}` : r.cancelled.has(key) ? "not run: a cell it depends on did not run" : "not run";
        outputs.set(key, []);
      }
    }
    return { reports, outputs, finished, dead, workerErr: interp.err };
  } finally {
    await interp.close();
  }
}

// stdout, stderr, and each display's text (or its kind and size)
function summary(list: any[]): Pick<CellReport, "stdout" | "stderr" | "outputs"> {
  let stdout = "", stderr = "";
  const outputs: CellReport["outputs"] = [];
  for (const o of list) {
    if (o.output_type === "stream") (o.name === "stderr" ? (stderr += o.text) : (stdout += o.text));
    else {
      const d = o.data ?? {}, text = d["text/plain"] ?? d["text/markdown"] ?? d["text/latex"];
      const other = Object.keys(d).find((t) => !t.startsWith("text/"));
      if (other) outputs.push({ type: other, bytes: String(d[other]).length, ...(typeof text === "string" ? { text } : {}) });
      else if (typeof text === "string") outputs.push({ type: d["text/plain"] !== undefined ? "text/plain" : Object.keys(d)[0], text });
    }
  }
  return { stdout, stderr, outputs };
}

// (the Python library's folder when this build reads it from disk, not embedded: src/compile.ts libDir)
function libOnDisk(): string | null {
  const { libDir } = require("./compile");
  const d: string = libDir();
  try { return d.startsWith("/") ? realpathSync(d) : null; } catch { return null; }
}

const indent = (s: string) => s.split("\n").map((l) => "       " + l).join("\n");
const cutLines = (s: string, max: number) => { const ls = s.split("\n"); return ls.length <= max ? s : [...ls.slice(0, max - 5), `… ${ls.length - max + 1} more lines …`, ...ls.slice(-4)].join("\n"); };
