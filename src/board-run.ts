// sagebrush board run FILE [--json] [--timeout S] [--store-previews [-o OUT]]:
// every code item of a board run as the board runs it in a browser, here,
// without one, and each item's outputs or its error reported, so that an
// agent writing a board can fix what fails before handing it over.
//
// As the board runs it (web/board/code.ts): one interpreter for the board,
// in its language (BoardDoc.mode), its code items the cells of a reactive
// notebook in the board's reading order (doc.ts codeOrder), scheduled by the
// notebook's own scheduler (src/notebook-reactive.ts: dependencies,
// page-order scoping, a cell that raises cancelling what reads it), each
// run with the seed the board gives it (SHA-256 of "seed:id") and its `_`
// names its own.  The interpreter is src/notebook-session.ts in a worker
// thread, as `sagebrush notebook` runs it, in an empty directory of its own
// (a board's code has no files in a browser).  An item over its time is
// interrupted (KeyboardInterrupt), and if it does not stop, the interpreter
// is stopped and what was left is not run.
//
// --store-previews writes the board with the outputs of its slow items as
// their previews, as the board keeps them (web/board/preview.ts: an item
// over PREVIEW_MS from root; --preview-ms 0: every item), to OUT, else to
// NAME.previews.board.json beside FILE, never over a file that is there
// unless it is named with -o.  Pictures are kept as they are when they fit
// a preview (there is no canvas here to draw them smaller).
//
// Loaded only for `board run` (src/cli.ts), so nothing else starts slower.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { createHash } from "crypto";
import { Worker, parentPort } from "worker_threads";
import { boardFromText } from "../web/board/mermaid";
import { canonical, cleanDoc, codeOrder, formatError, isBoard, pageCount, pageView, type BoardDoc, type DocNode, type DocNote } from "../web/board/doc";
import { PREVIEW_MS, imageSize, makePreview, overCap, type Preview, type Raster } from "../web/board/preview";
import { Reactive, SCOPE_SEP, type Analysis, type CellState, type RunReport } from "./notebook-reactive";
import type { CellError } from "./notebook-graph";
import { analyzeCell, ImportStarError } from "./dataflow";
import { renameRedefinitions } from "./rename";

const USAGE = `usage: sagebrush board run FILE [--json] [--timeout S] [--store-previews [-o OUT] [--preview-ms MS]]
  run every code item of a board as the board runs it in a browser (its
  language, its reactive order and its seeds), and report each item's
  output, or its error; the exit status is 1 if an item failed, has an
  error, was not run or ran out of time
  --json            the report as JSON
  --timeout S       the seconds an item may run (default 60); longer is an error
  --store-previews  write the board with its slow items' outputs as their
                    previews, so it shows them at once: to OUT, else to
                    NAME.previews.board.json beside FILE (not over a file
                    that is there); --preview-ms MS: the items over MS from
                    root (default ${PREVIEW_MS}, as the board keeps them; 0: all)
  The code runs here, as you, as \`sagebrush -c\` runs it: run boards you trust.
`;

/** The seed of a board without one of its own (web/board/code.ts BOARD_SEED). */
const BOARD_SEED = "0".repeat(64);
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

type Status = "ok" | "failed" | "error" | "not run" | "timeout";
interface ItemReport {
  n: number;
  id: string;
  /** its page (from 1), on a board of pages */
  page?: number;
  title?: string;
  status: Status;
  ms?: number;
  stdout: string;
  stderr: string;
  outputs: { type: string; text?: string; bytes?: number }[];
  error?: string;
}

// ---- the worker thread: the board's interpreter
export function boardRunWorker(data: { dir: string }) {
  const { notebookSession } = require("./notebook-session");
  const port = parentPort!;
  const session = notebookSession((m: any) => port.postMessage(m), {
    captureStreams: true,
    init: (R: any) => R.importModule("os").chdir(data.dir),
  });
  port.on("message", (m: any) => session.handle(m));
  const { R } = require("./compile");
  session.ready.then(() => port.postMessage({ ready: true, $intr: R.INTR.buffer }));
}

// (seconds: Node's timers are at most 2^31 - 1 ms, CORR-CD6-4)
const MAX_TIMEOUT = 2147483;
// (a message on stderr: a board's text, a file's name, an option, as anyone wrote them, HARD-CD6-3)
const say = (msg: string) => process.stderr.write(`sagebrush board run: ${safe(msg)}\n`);

/** The `board run` command; returns the exit code. */
export async function boardRun(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) { process.stdout.write(USAGE); return 0; }
  let file: string | null = null, out: string | null = null, json = false, store = false, timeout = 60, previewMs = PREVIEW_MS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--store-previews") store = true;
    else if (a === "-o" || a === "--output") out = argv[++i] ?? null;
    else if (a === "--timeout") timeout = Number(argv[++i]);
    else if (a === "--preview-ms") previewMs = Number(argv[++i]);
    else if (a.startsWith("-") && a !== "-") { say(`unknown option ${a}`); process.stderr.write(USAGE); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null || ((argv.includes("-o") || argv.includes("--output")) && out === null)) { process.stderr.write(USAGE); return 2; }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) { say(`--timeout takes a number of seconds, more than 0 and at most ${MAX_TIMEOUT}`); return 2; }
  if (!Number.isFinite(previewMs) || previewMs < 0) { say("--preview-ms takes a number of milliseconds, 0 or more"); return 2; }
  if (out !== null && !store) { say("-o is for --store-previews"); return 2; }
  // (where the board with its previews goes: never over a file that is there, unless named)
  const target = !store ? null : out ?? (file === "-" ? null : join(dirname(file), basename(file).replace(/(\.board)?\.json$/i, "").replace(/\.[^.]*$/, "") + ".previews.board.json"));
  if (store && target === null) { say("a board from standard input needs -o OUT for --store-previews"); return 2; }
  // (said early, before anything runs; and the file is made only if it is still not there, HARD-CD6-2)
  if (store && out === null && existsSync(target!)) { say(`${target} is there already: name it with -o to write over it`); return 2; }

  let doc: BoardDoc;
  try {
    const d = boardFromText(readFileSync(file === "-" ? 0 : file, "utf8"), file === "-" ? undefined : basename(file));
    const bad = formatError(d);
    if (bad) throw new Error(bad);
    if (!isBoard(d)) throw new Error("not a board: a document needs nodes (or pages of them)");
    doc = cleanDoc(d);
  } catch (e: any) {
    say(`${file}: ${e?.message ?? e}`);
    return 1;
  }
  const mode = doc.mode ?? "python";
  const seed = typeof doc.seed === "string" && /^[0-9a-f]{64}$/.test(doc.seed) ? doc.seed : BOARD_SEED;
  // the code items, page by page, each page in reading order (as doc.ts
  // codeOrder runs them); an id is one item's on a page, and may be
  // another's on another page: those are told apart by their page in the
  // scheduler and the report (`key`), and keep their ids for their seeds
  // (CORR-CD6-1)
  const pages = pageCount(doc);
  const all = Array.from({ length: pages }, (_, page) => codeOrder(pageView(doc, page)).map((it) => ({ ...it, page }))).flat();
  const repeated = new Set(all.map((it) => it.id).filter((id, k, ids) => ids.indexOf(id) !== k));
  const items = all.map((it) => ({ ...it, key: repeated.has(it.id) ? `${it.id}@p${it.page + 1}` : it.id }));
  const byKey = new Map(items.map((it) => [it.key, it]));
  const notes = new Map<string, DocNote>();
  for (let page = 0; page < pages; page++) {
    const on = codeNotes(pageView(doc, page));
    for (const it of items) if (it.page === page && on.has(it.id)) notes.set(it.key, on.get(it.id)!);
  }
  const reports = new Map<string, ItemReport>(items.map(({ key, id, page }, i) => [key, { n: i + 1, id, ...(pages > 1 ? { page: page + 1 } : {}), title: notes.get(key)?.title, status: "not run", stdout: "", stderr: "", outputs: [] }]));
  const seedOf = (key: string) => hex(`${seed}:${byKey.get(key)?.id ?? key}`);
  const label = (id: string) => { const r = reports.get(id); return r ? `item ${r.n}${r.title ? ` ${JSON.stringify(r.title)}` : ""}` : "an item"; };

  // the interpreter, and what each run sends back
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-board-"));
  const outputs = new Map<string, any[]>(); // (Jupyter's outputs, as the notebook saves them)
  let ran = 0, worker: Worker | null = null, intr: Int32Array | null = null, dead: string | null = null;
  const sinks = new Map<number, (m: any) => void>();
  let nextId = 1;
  const workerErr: string[] = [];
  try {
    if (items.length) {
      worker = new Worker(require.main?.filename ?? process.argv[1], { workerData: { sagebrushBoardRun: { dir } }, stdout: true, stderr: true });
      worker.stdout.resume();
      worker.stderr.on("data", (b) => { if (workerErr.length < 100) workerErr.push(String(b)); });
      await new Promise<void>((resolve, reject) => {
        worker!.on("message", (m: any) => {
          if (m.ready) { intr = new Int32Array(m.$intr); return resolve(); }
          sinks.get(m.id)?.(m);
        });
        worker!.on("error", (e: any) => { dead = String(e?.message ?? e); reject(e); for (const f of [...sinks.values()]) f({ done: true, error: true, ms: 0, dead: true }); });
        worker!.on("exit", () => { dead ??= "the interpreter stopped"; for (const f of [...sinks.values()]) f({ done: true, error: true, ms: 0, dead: true }); });
      });
    }
    // (one run: code with its options; its messages to `on`; resolves when it is done)
    const send = (msg: any, on: (m: any) => void, limit = Infinity) => new Promise<{ ms: number; error: boolean; timedOut: boolean; dead: boolean }>((resolve) => {
      if (dead || !worker) return resolve({ ms: 0, error: true, timedOut: false, dead: true });
      const id = nextId++;
      let timedOut = false, timer: any = null, kill: any = null;
      sinks.set(id, (m) => {
        if (!m.done && !m.skipped) return on(m);
        sinks.delete(id);
        clearTimeout(timer);
        clearTimeout(kill);
        resolve({ ms: m.ms ?? 0, error: !!m.error || !!m.skipped, timedOut, dead: !!m.dead });
      });
      if (limit < Infinity) timer = setTimeout(() => {
        // over its time: interrupted (KeyboardInterrupt), and if it does not stop, the interpreter stopped
        timedOut = true;
        if (intr) { Atomics.store(intr, 1, id); Atomics.store(intr, 0, 1); }
        kill = setTimeout(() => { dead = `the interpreter was stopped: ${label(msg.cell)} did not stop when interrupted`; worker?.terminate(); }, 2000);
      }, limit);
      worker.postMessage({ id, code: msg.code, sage: mode === "sage", magma: mode === "magma", matlab: mode === "matlab", ...msg.opts });
    });
    const timedOut = new Set<string>();
    const syntax = new Map<string, string>(); // (syntax errors, as the interpreter says them)
    const states = new Map<string, CellState>(); // (each item's last state, as the scheduler says it)
    const analyses = new Map<string, Analysis>();
    const reactive = new Reactive({
      cells: () => items.map((it) => ({ id: it.key, code: it.code })),
      async analyze(code) {
        if (!analyses.has(code)) {
          let a: Analysis;
          try { a = analyzeCell(code, "c", { mode }); } catch (e: any) { a = { error: { kind: e instanceof ImportStarError ? "import-star" : "syntax", message: String(e?.message ?? e) } }; }
          analyses.set(code, a);
        }
        return analyses.get(code)!;
      },
      async execute(id, code, forget, scoped) {
        const list: any[] = [];
        outputs.set(id, list);
        const r = await send({ cell: id, code, opts: { forget, mangle: id.replace(/[^A-Za-z0-9]/g, ""), seed: seedOf(id), ...(scoped && Object.keys(scoped).length ? { scoped } : {}) } }, (m) => collect(list, m), timeout * 1000);
        ran++;
        if (r.timedOut) timedOut.add(id);
        return { ok: !r.error, ms: r.ms, ...(r.timedOut ? { stopped: true, interrupted: true } : r.dead ? { stopped: true } : {}) };
      },
      forget: (names) => send({ code: "", opts: { forget: names } }, () => {}).then(() => {}),
      rename: async (q) => {
        try {
          const r = renameRedefinitions(q.cells, q.name, new Set(q.taken), mode, SCOPE_SEP);
          return r ? [...r] : null;
        } catch {
          return null;
        }
      },
      status: (id, st) => states.set(id, st),
    });
    const failed = new Set<string>(), cancelled = new Set<string>();
    const note = (r: RunReport) => { for (const id of r.failed) failed.add(id); for (const id of r.cancelled) cancelled.add(id); };
    if (items.length) {
      await reactive.load({ stale: true });
      note(await reactive.runAll());
      // (an item out of time stops the scheduler's run, as Stop does in a
      // notebook; the interpreter is still there: the others run, but not
      // what reads an item out of time)
      for (let round = 0; round < items.length && timedOut.size && !dead; round++) {
        const blocked = reactive.graph.closure([...timedOut]);
        const left = items.map((it) => it.key).filter((id) => !reactive.outcome.has(id) && !reactive.errors.has(id) && !blocked.has(id) && !cancelled.has(id));
        if (!left.length) break;
        const before = reactive.outcome.size;
        note(await reactive.run(left, { budget: Infinity }));
        if (reactive.outcome.size === before) break;
      }
      // (a syntax error: the interpreter says it, where, in the board's
      // language, as the notebook shows it; such code defines nothing)
      for (const { key: id, code } of items) {
        const errs = reactive.errors.get(id);
        if (!errs?.length || !errs.every((e) => e.kind === "syntax") || dead) continue;
        const list: any[] = [];
        await send({ cell: id, code, opts: { mangle: id.replace(/[^A-Za-z0-9]/g, ""), seed: seedOf(id) } }, (m) => collect(list, m), timeout * 1000);
        const said = summary(list).stderr.trim();
        if (said) syntax.set(id, said);
      }
    }

    // each item: how it ended, its outputs, its error
    const late = items.length ? reactive.graph.closure([...timedOut]) : new Set<string>();
    for (const { key: id } of items) {
      const r = reports.get(id)!, list = outputs.get(id) ?? [];
      Object.assign(r, summary(list));
      const errs = reactive.errors.get(id);
      const ms = reactive.times.get(id);
      if (ms !== undefined && reactive.outcome.has(id)) r.ms = Math.round(ms);
      if (errs?.length) { r.status = "error"; r.error = syntax.get(id) ?? errs.map((e) => errorText(e, label, (n) => reactive.written(n))).join("\n"); r.stdout = r.stderr = ""; r.outputs = []; }
      else if (timedOut.has(id)) { r.status = "timeout"; r.error = `ran out of time: stopped after ${timeout} s` + (r.stderr ? "\n" + r.stderr : ""); }
      else if (reactive.outcome.get(id) === "ok" && !failed.has(id)) r.status = "ok";
      else if (failed.has(id) || reactive.outcome.get(id) === "exception") { r.status = "failed"; r.error = r.stderr.trim() || "raised an error"; }
      else {
        r.status = "not run";
        const st = states.get(id), by = st?.state === "cancelled" ? st : null;
        const slow = [...timedOut].find((t) => t !== id && late.has(id) && reactive.graph.closure([t]).has(id));
        r.error = slow ? `not run: ${label(slow)}, which it depends on, ran out of time` : by ? `not run: ${label(by.by)}, which it depends on, ${by.why === "exception" ? "raised an error" : by.why === "error" ? "has an error" : "was interrupted"}` : dead ? `not run: ${dead}` : cancelled.has(id) ? "not run: an item it depends on did not run" : "not run";
      }
    }

    // the board with its previews, if asked
    let wrote: string | null = null;
    if (store && target) {
      const at = new Date().toISOString(), kept = new Map<string, Preview>();
      for (const { key: id } of items) {
        const r = reports.get(id)!, n = notes.get(id);
        if (!n || (r.status !== "ok" && r.status !== "failed")) continue;
        const total = reactive.fromRoot(id).ms;
        const p = total > previewMs || previewMs === 0 ? await makePreview(previewable(outputs.get(id) ?? []), { at, ms: reactive.times.get(id) ?? 0, total }, keepRaster) : null;
        if (p) n.preview = p;
        else delete n.preview;
      }
      for (const [id, n] of notes) if (n.preview) kept.set(id, n.preview);
      for (const id of overCap(kept)) delete notes.get(id)!.preview;
      // (a file named with -o is written over; else it is made, and only if
      // it is still not there: the board's code, or anyone, may have made
      // it meanwhile, or put a link there, HARD-CD6-2)
      try {
        writeFileSync(target, canonical(doc), { flag: out !== null ? "w" : "wx" });
      } catch (e: any) {
        say(e?.code === "EEXIST" ? `${target} is there now (made while the board ran): not written over; name it with -o to write over it` : `could not write ${target}: ${e?.code ?? e?.message ?? e}`);
        return 1;
      }
      wrote = target;
    }

    // the report
    const list = items.map(({ key }) => reports.get(key)!);
    const count = (s: Status) => list.filter((r) => r.status === s).length;
    const allOk = list.every((r) => r.status === "ok");
    if (json) {
      process.stdout.write(JSON.stringify({ file, title: doc.title ?? null, mode, ok: allOk, items: list, ...(wrote ? { wrote } : {}) }, null, 2) + "\n");
    } else {
      const w = process.stdout;
      if (!list.length) w.write(`${safe(file)}: no code items\n`);
      for (const r of list) {
        const head = `${String(r.n).padStart(3)}  ${r.status.toUpperCase().padEnd(8)} ${r.title ? safe(JSON.stringify(r.title)) + " " : ""}(${safe(JSON.stringify(r.id))}${r.page ? `, page ${r.page}` : ""})${r.ms !== undefined ? `  ${r.ms} ms` : ""}`;
        w.write(head + "\n");
        // (a picture as what it is and its size, not its text: a figure's text says little)
        const body = r.status === "ok" ? [r.stdout, ...r.outputs.map((o) => (o.bytes ? `[${o.type}, ${Math.max(1, Math.round(o.bytes / 1024))} kB]` : o.text ?? ""))].filter(Boolean).join("\n") : r.error ?? "";
        if (body.trim()) w.write(indent(cutLines(safe(body.replace(/\n+$/, "")), 40)) + "\n");
      }
      const parts = (["ok", "failed", "error", "timeout", "not run"] as Status[]).filter((s) => count(s)).map((s) => `${count(s)} ${s}`);
      if (list.length) w.write(`${safe(file)}: ${parts.join(", ")} (of ${list.length} code item${list.length === 1 ? "" : "s"}, ${mode})\n`);
      if (wrote) w.write(`wrote ${safe(wrote)}, with ${[...notes.values()].filter((n) => n.preview).length} preview(s)\n`);
      if (dead && workerErr.length) process.stderr.write(safe(workerErr.join("")).slice(0, 4000));
    }
    return allOk ? 0 : 1;
  } finally {
    await worker?.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
}

// a run's messages, as the notebook keeps them (Jupyter's outputs): streams
// joined, displays as display_data, clear_output() as it says
function collect(list: any[], m: any) {
  if (m.target != null) return; // (an @interact's own output area: shown when it is moved)
  if (m.clear) { list.length = 0; return; }
  if (m.stream) {
    const last = list[list.length - 1];
    if (last?.output_type === "stream" && last.name === m.stream) last.text += m.text;
    else list.push({ output_type: "stream", name: m.stream, text: m.text });
  } else if (m.display) list.push({ output_type: "display_data", data: m.display, metadata: {} });
  else if (m.interact) list.push({ output_type: "display_data", data: { "text/plain": "[interactive controls]" }, metadata: {} });
}

// stdout, stderr, and each display's text (or its kind and size)
function summary(list: any[]): Pick<ItemReport, "stdout" | "stderr" | "outputs"> {
  let stdout = "", stderr = "";
  const outputs: ItemReport["outputs"] = [];
  for (const o of list) {
    if (o.output_type === "stream") (o.name === "stderr" ? (stderr += o.text) : (stdout += o.text));
    else {
      const d = o.data ?? {}, text = d["text/plain"] ?? d["text/markdown"] ?? d["text/latex"];
      const other = Object.keys(d).find((t) => !t.startsWith("text/"));
      if (other && !/^text\/plain$/.test(other)) outputs.push({ type: other, bytes: String(d[other]).length, ...(typeof text === "string" ? { text } : {}) });
      else if (typeof text === "string") outputs.push({ type: d["text/plain"] !== undefined ? "text/plain" : Object.keys(d)[0], text });
    }
  }
  return { stdout, stderr, outputs };
}

// (as the notebook says them, web/notebook/notebook.js errorText; items for cells)
function errorText(e: CellError, label: (id: string) => string, written: (n: string) => string): string {
  const list = (ids: string[]) => ids.map(label).join(", ").replace(/, ([^,]*)$/, " and $1");
  switch (e.kind) {
    case "multiple-definition":
      return e.reading
        ? `${written(e.name)} is defined by ${list(e.cells)}, so this item cannot tell which one it reads. Rename it in all but one of them.`
        : `${written(e.name)} is also defined by ${list(e.cells)}. A name read by other items can be defined by only one item: rename it in one of them, or start it with _ to keep it private to its item.`;
    case "cycle":
      return `${list(e.cells)} depend on each other in a cycle, so none of them can run first. Move a definition to break it.`;
    case "import-star":
      return `${e.message} Import the names you use (from m import a, b), or the module (import m).`;
    case "analyzer":
      return `This item could not be analyzed (${e.message}).`;
    default:
      return /^SyntaxError\b/.test(e.message) ? e.message : `SyntaxError: ${e.message}`;
  }
}

// (a display whose picture a preview can't hold here, an SVG plot: left
// out, its text too, which says only "<Figure ...>"; the board shows the
// picture once it runs)
const KEPT = /^image\/(png|jpeg|webp)$/;
const previewable = (list: any[]) => list.filter((o) => o.output_type !== "display_data" || !Object.keys(o.data ?? {}).some((t) => t.startsWith("image/")) || Object.keys(o.data).some((t) => KEPT.test(t)));

// A picture kept as it is, if it fits a preview (no canvas here to draw it smaller).
const keepRaster: Raster = async (src, maxWidth) => {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(src);
  if (!m) return null;
  const s = imageSize(m[1], m[2]);
  return s && s.w <= maxWidth ? [m[1], m[2]] : null;
};

// The board's code notes by id, every page, in groups too.
function codeNotes(d: BoardDoc): Map<string, DocNote> {
  const out = new Map<string, DocNote>();
  const walk = (ns: DocNode[] | undefined) => {
    for (const n of ns ?? []) {
      if (n.kind === "group") walk(n.children);
      else if ((n.kind === undefined || n.kind === "note") && n.code !== undefined) out.set(n.id, n);
    }
  };
  for (let i = 0; i < pageCount(d); i++) walk(pageView(d, i).nodes);
  return out;
}

// (text for a terminal: no control characters but newlines and tabs; a board's text and its code's output are anyone's)
const safe = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const indent = (s: string) => s.split("\n").map((l) => "       " + l).join("\n");
const cutLines = (s: string, max: number) => { const ls = s.split("\n"); return ls.length <= max ? s : [...ls.slice(0, max - 5), `… ${ls.length - max + 1} more lines …`, ...ls.slice(-4)].join("\n"); };
