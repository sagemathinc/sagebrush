// sagebrush board check FILE [--json] [--no-run] [--timeout S]: everything
// that can be said of a board before anyone opens it, in one report, so an
// agent writing a board can fix it first.  The exit status is 1 if there is
// any error (warnings don't count), 2 for a wrong command line.
//
// In order: the file (JSON, within the size a board opens); its header and
// the format's version; the format, against its JSON Schema
// (web/board-format.schema.json, from doc.ts: unknown fields with the one
// meant, values the board would drop); what a schema can't say (an id once
// on its page, edges and tour steps naming items of their page, a page made
// from a template naming one, pictures named in `images` and within the
// pixels the board shows, a sticker's one emoji, previews the board would
// drop); and then every code item, run as `board run` runs it (the board's
// language, its reactive order, its seeds), unless --no-run.
//
// Loaded only for `board check` (src/board-cli.ts).

import { closeSync, openSync, readSync } from "fs";
import { basename } from "path";
import { cleanDoc, formatError, isBoard, oneEmoji, VERSION } from "../web/board/doc";
import { cleanPreview } from "../web/board/preview";
import { BOARD_SCHEMA } from "../web/board/format-schema";
import { dataUrl, imageSize, PixelBudget } from "../web/image-size";
import { SchemaValidator, didYouMean, step } from "./json-schema";
import { CLI_READER } from "./board-cli";
import { oneLine, textLines } from "./terminal-text";

const USAGE = `usage: sagebrush board check FILE [--json] [--no-run] [--timeout S] [--figures DIR]
  check a board (a .board.json file) before anyone opens it, and report
  every problem at once: its JSON, its header and version, every field
  against the format (web/board-format.schema.json; an unknown field with
  the one meant), ids once on each page, edges and tour steps naming items
  of their page, templates, pictures, stickers and previews; then run its
  code items as \`sagebrush board run\` does
  --json      the report as JSON
  --no-run    don't run the code items
  --timeout S the seconds a code item may run (default 60)
  --figures DIR  save the code items' figures in DIR (as board run does)
  The exit status is 1 if there is any error (warnings don't count).
  The code runs here, as you, as \`sagebrush -c\` runs it: check boards you trust.
`;

/** The largest file the board opens (web/board/mount.ts FILE_MAX; the test compares them). */
export const FILE_MAX = 128 * 2 ** 20;
/** How deep objects and lists may nest in a board checked: no board needs
 * more (a group in a group is two levels), and every check below walks the
 * document recursively (HARD-5DF-1). */
export const MAX_DEPTH = 200;

export interface Problem {
  level: "error" | "warning";
  /** where: `pages[1].nodes[3].color`, "" for the whole document */
  path: string;
  message: string;
}

// (a value in a message: a long string cut before it is quoted, never copied whole, HARD-5DF-2)
const show = (v: unknown) => { const s = JSON.stringify(typeof v === "string" && v.length > 60 ? v.slice(0, 57) : v); return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + "..." : s; };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether objects and lists nest in v more than `max` deep (counted
 * without recursion). */
export function tooDeep(v: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (d > max) return true;
    for (const y of Object.values(x as object)) if (y && typeof y === "object") stack.push([y, d + 1]);
  }
  return false;
}

/** The problems of a board's text (its file's name for messages), without running it. */
export function checkText(text: string): { problems: Problem[]; doc: any } {
  const problems: Problem[] = [];
  const err = (path: string, message: string) => problems.push({ level: "error", path, message });
  const warn = (path: string, message: string) => problems.push({ level: "warning", path, message });
  let d: any;
  try {
    d = JSON.parse(text);
  } catch (e: any) {
    // (where, as a line and column: found here, since JSON.parse's message may not say)
    const msg = String(e?.message ?? e), at = jsonErrorAt(text);
    const before = text.slice(0, at), where = ` (line ${before.split("\n").length}, column ${at - before.lastIndexOf("\n")})`;
    // (what is wrong, without the board's own text V8 quotes: the line and column say where)
    err("", `not JSON: ${msg.replace(/^JSON\.parse: /, "").replace(/ in JSON at position \d+( \(line \d+ column \d+\))?/, "").replace(/, [\s\S]* is not valid JSON$/, "")}${where}`);
    return { problems, doc: null };
  }
  if (!isObj(d)) { err("", `not a board: a board is a JSON object, not ${Array.isArray(d) ? "a list" : typeof d}`); return { problems, doc: null }; }
  // (before anything that walks it recursively)
  if (tooDeep(d, MAX_DEPTH)) { err("", `not a board this command checks: objects and lists nest more than ${MAX_DEPTH} deep (a group in a group is two levels)`); return { problems, doc: null }; }
  // the header
  const keys = Object.keys(d);
  if (d.format === undefined) err("", `no header: a board starts with "format": "sagebrush-board", "version": ${VERSION}`);
  else if (keys[0] !== "format" || (d.version !== undefined && keys[1] !== "version")) warn("", `write "format" first and "version" second, as the header`);
  if (d.format !== undefined && d.version === undefined) err("", `no version: write "version": ${VERSION} after "format"`);
  // (another format, a later version: nothing else to say)
  const fe = formatError(d, CLI_READER);
  if (fe && !/two (items|pages)/.test(fe)) { err(/version/.test(fe) ? "version" : "format", fe); return { problems, doc: d }; }

  // the format, field by field
  for (const p of new SchemaValidator(BOARD_SCHEMA as any).validate(d)) err(p.path, p.message);

  // what a schema can't say, page by page
  const pages: { page: any; path: string; index: number }[] = Array.isArray(d.pages) ? d.pages.map((page: any, index: number) => ({ page, path: `pages[${index}]`, index })) : [{ page: d, path: "", index: 0 }];
  const used = new Map<string, string>(); // picture name -> where first used
  const images = isObj(d.images) ? d.images : {};
  // (a picture named constructor or __proto__ is one only if `images` has it, CORR-5DF-2)
  const hasImage = (name: string) => Object.prototype.hasOwnProperty.call(images, name);
  const templates = new Map<string, number>();
  if (Array.isArray(d.pages)) d.pages.forEach((p: any, i: number) => { if (isObj(p) && p.template === true && p.id != null) templates.set(String(p.id), i); });
  const idsOf = new Map<number, Map<string, string>>(); // page -> id -> path
  // (a page's id is one page's: a page made from a template names it, CORR-5DF-1)
  if (Array.isArray(d.pages)) {
    const seen = new Map<string, string>();
    d.pages.forEach((p: any, i: number) => {
      if (!isObj(p) || p.id == null) return;
      const id = String(p.id), at = `pages[${i}].id`;
      if (seen.has(id)) err(at, `the page id ${show(id)} is used twice (also ${seen.get(id)}): the board refuses a document whose pages share an id`);
      else seen.set(id, at);
    });
  }
  for (const { page, path, index } of pages) {
    if (!isObj(page)) continue;
    const ids = new Map<string, string>();
    idsOf.set(index, ids);
    const walk = (ns: unknown, at: string) => {
      if (!Array.isArray(ns)) return;
      ns.forEach((n, i) => {
        const p = step(at, i);
        if (!isObj(n)) return;
        if (n.id != null) {
          const id = String(n.id);
          if (ids.has(id)) err(step(p, "id"), `the id ${show(id)} is on this page twice (also ${ids.get(id)}): an edge or a step names one item`);
          else ids.set(id, p);
        }
        if (n.kind === "group") walk(n.children, step(p, "children"));
        else if (n.kind === "sticker") { if (typeof n.emoji === "string" && !oneEmoji(n.emoji)) err(step(p, "emoji"), `${show(n.emoji)} is not one emoji: a sticker shows one (a single character such as 🌵), else it is left out`); }
        else if (n.kind !== "ink") {
          if (typeof n.image === "string" && !used.has(n.image)) used.set(n.image, step(p, "image"));
          if (typeof n.image === "string" && !hasImage(n.image)) err(step(p, "image"), `no picture named ${show(n.image)} in \`images\`${near(n.image, Object.keys(images))}`);
          if (n.preview !== undefined && n.code !== undefined && !cleanPreview(n.preview)) warn(step(p, "preview"), "not a preview the board can show (it is left out): previews are written by `sagebrush board run --store-previews`");
        }
      });
    };
    walk(page.nodes, step(path, "nodes"));
    const bg = page.background;
    if (isObj(bg) && typeof bg.image === "string") {
      if (!used.has(bg.image)) used.set(bg.image, step(step(path, "background"), "image"));
      if (!hasImage(bg.image)) err(step(step(path, "background"), "image"), `no picture named ${show(bg.image)} in \`images\`${near(bg.image, Object.keys(images))}`);
    }
    // a page made from a template
    if (Array.isArray(d.pages)) {
      if (page.template === true && page.id == null) err(path, "a template page needs an `id`: the pages made from it name it with `uses`");
      if (page.uses != null) {
        const t = templates.get(String(page.uses));
        if (page.template === true) warn(step(path, "uses"), "a template page is not made from another (its `uses` is left aside)");
        else if (t === undefined || t === index) err(step(path, "uses"), `no template page has the id ${show(String(page.uses))}${near(String(page.uses), [...templates.keys()])}; a template page has "template": true and an \`id\``);
      }
    }
  }
  // edges and steps: items of their own page
  for (const { page, path, index } of pages) {
    if (!isObj(page)) continue;
    const ids = idsOf.get(index)!;
    const t = page.uses != null ? templates.get(String(page.uses)) : undefined;
    const tids = t !== undefined && t !== index ? idsOf.get(t) : undefined;
    const ref = (v: unknown, at: string, what: string) => {
      if (typeof v !== "string" && typeof v !== "number") return;
      const id = String(v);
      if (ids.has(id)) return;
      const onTemplate = tids?.has(id) ? `: it is an item of the template page, which an edge or a step of this page can't name` : "";
      err(at, `${what}: no item on ${pages.length > 1 ? "this page" : "the board"} has the id ${show(id)}${onTemplate || near(id, [...ids.keys()])}`);
    };
    if (Array.isArray(page.edges)) page.edges.forEach((e: any, i: number) => { if (isObj(e)) { ref(e.from, step(step(step(path, "edges"), i), "from"), "an edge's start"); ref(e.to, step(step(step(path, "edges"), i), "to"), "an edge's end"); } });
    if (Array.isArray(page.steps)) page.steps.forEach((s: any, i: number) => {
      if (!isObj(s)) return;
      const at = step(step(step(path, "steps"), i), "focus");
      (Array.isArray(s.focus) ? s.focus : [s.focus]).forEach((f: unknown, k: number) => ref(f, Array.isArray(s.focus) ? step(at, k) : at, "a tour step's focus"));
    });
  }
  // pictures: each used, each one the board can show, all within its pixels
  const budget = new PixelBudget();
  for (const [name, v] of Object.entries(images)) {
    const at = step("images", name);
    if (!isObj(v)) continue;
    if (!used.has(name)) warn(at, "not used by any note or background");
    if (v.src === undefined) { warn(at, "no `src`: a file needs the picture itself, a data: URL or an https: address, or the board shows an empty frame"); continue; }
    if (typeof v.src !== "string" || !v.src.toLowerCase().startsWith("data:")) continue;
    const u = dataUrl(v.src);
    if (!u) continue; // (the schema says so)
    const size = imageSize(u.type, u.base64), why = budget.take(size);
    if (why) err(step(at, "src"), `the board won't show this picture: ${why}`);
    else if (size && typeof v.w === "number" && typeof v.h === "number" && v.w > 0 && v.h > 0 && Math.abs(size.w / size.h - v.w / v.h) > 0.01 * (size.w / size.h))
      warn(at, `its w and h (${v.w} × ${v.h}) are not the picture's shape (${size.w} × ${size.h} pixels), so it is drawn stretched`);
  }
  // previews over the document's total, which the board drops (cleanDoc
  // builds a new document from d, sharing its strings: no second copy, HARD-5DF-2)
  const raw = countPreviews(d), kept = countPreviews(cleanDoc(d));
  if (kept < raw) warn("", `${raw - kept} of the ${raw} previews are left out: the board keeps at most 512 kB of them in all`);
  // (whatever the board refuses is an error here, said as the board says
  // it, if nothing above has said why: check and the board stay in step)
  if (!problems.some((p) => p.level === "error")) {
    const refused = formatError(d, CLI_READER) ?? (isBoard(d) ? null : "not a board: a document needs nodes (or pages of them)");
    if (refused) err("", refused);
  }
  return { problems, doc: d };
}

/** Where JSON text stops being JSON: the offset of the first character
 * that can't be there (or the end, if it ends too soon). */
const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
export function jsonErrorAt(t: string): number {
  let i = 0;
  const ws = () => { while (i < t.length && " \t\n\r".includes(t[i])) i++; };
  const fail = () => { throw i; };
  const value = (): void => {
    ws();
    const c = t[i];
    if (c === "{") {
      i++; ws();
      if (t[i] === "}") { i++; return; }
      for (;;) { ws(); if (t[i] !== '"') fail(); string(); ws(); if (t[i] !== ":") fail(); i++; value(); ws(); if (t[i] === ",") { i++; continue; } if (t[i] === "}") { i++; return; } fail(); }
    }
    if (c === "[") {
      i++; ws();
      if (t[i] === "]") { i++; return; }
      for (;;) { value(); ws(); if (t[i] === ",") { i++; continue; } if (t[i] === "]") { i++; return; } fail(); }
    }
    if (c === '"') return string();
    for (const w of ["true", "false", "null"]) if (t.startsWith(w, i)) { i += w.length; return; }
    // (the whole number, however long: from i, CORR-5DF-3)
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(t);
    if (m && m[0]) { i += m[0].length; return; }
    fail();
  };
  const string = () => {
    i++;
    while (i < t.length && t[i] !== '"') {
      if (t.charCodeAt(i) < 0x20) fail();
      if (t[i] === "\\") { i++; if (t[i] === "u") { if (!/^[0-9a-fA-F]{4}$/.test(t.slice(i + 1, i + 5))) fail(); i += 4; } else if (!'"\\/bfnrt'.includes(t[i])) fail(); }
      i++;
    }
    if (i >= t.length) fail();
    i++;
  };
  try { value(); ws(); if (i < t.length) fail(); } catch (at) { return typeof at === "number" ? Math.min(at, t.length) : i; }
  return t.length;
}

function near(name: string, known: string[]) {
  const m = didYouMean(name, known);
  return m ? ` (did you mean ${show(m)}?)` : "";
}

function countPreviews(d: any): number {
  let n = 0;
  const walk = (ns: unknown) => { if (Array.isArray(ns)) for (const x of ns) if (isObj(x)) { if (x.kind === "group") walk(x.children); else if (x.preview !== undefined && x.code !== undefined) n++; } };
  walk(d?.nodes);
  for (const p of Array.isArray(d?.pages) ? d.pages : []) walk(p?.nodes);
  return n;
}

const say = (msg: string) => process.stderr.write(`sagebrush board check: ${oneLine(msg)}\n`);

/** The `board check` command; returns the exit code. */
export async function boardCheck(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) { process.stdout.write(USAGE); return 0; }
  let file: string | null = null, json = false, run = true, timeout = 60, figures: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--no-run") run = false;
    else if (a === "--timeout") timeout = Number(argv[++i]);
    else if (a === "--figures") { figures = argv[++i] ?? null; if (figures === null) { say("--figures takes a directory"); return 2; } }
    else if (a.startsWith("-") && a !== "-") { say(`unknown option ${a}`); process.stderr.write(USAGE); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null) { process.stderr.write(USAGE); return 2; }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483) { say("--timeout takes a number of seconds, more than 0 and at most 2147483"); return 2; }
  let text: string;
  try {
    // (no larger than the board opens: read in pieces, a file, a pipe or
    // standard input alike, and never past it, HARD-5DF-2)
    const bytes = readBounded(file, FILE_MAX);
    if (bytes === null) { say(`${file}: too large for the board to open (at most ${FILE_MAX / 2 ** 20} MB)`); return 1; }
    text = bytes.toString("utf8");
  } catch (e: any) {
    say(`${file}: ${e?.code === "ENOENT" ? "no such file" : e?.message ?? e}`);
    return 1;
  }
  const { problems, doc } = checkText(text);
  // the code items, as the board runs them
  let code: { mode: string; items: any[] } | null = null, notRun: string | null = null;
  // (only a board the board would show: else the problems above say why)
  if (run && doc && (formatError(doc, CLI_READER) || !isBoard(doc))) notRun = "the board can't be shown (see the errors above), so its code items were not run";
  else if (run && doc) {
    const { runBoard, saveFigures } = await import("./board-run");
    let r;
    try {
      r = await runBoard(cleanDoc(doc), timeout);
    } catch (e: any) {
      problems.push({ level: "error", path: "", message: `its code items could not be run: ${e?.message ?? e}` });
      r = null;
    }
    if (r) code = { mode: r.mode, items: r.list };
    // (its figures, if asked)
    if (r && figures !== null) { const why = saveFigures(r, figures); if (why) problems.push({ level: "error", path: "", message: why }); }
  }
  if (code) {
    const r = { list: code.items };
    // (each item that didn't run well: an error, where its item is)
    const where = itemPaths(doc);
    for (const it of r.list) {
      if (it.status === "ok") continue;
      const at = where.get(`${it.page ?? 1}\0${it.id}`) ?? "";
      problems.push({ level: "error", path: at, message: `code item ${show(it.id)}${it.title ? ` (${show(it.title)})` : ""} ${it.status === "timeout" ? "ran out of time" : it.status === "not run" ? "was not run" : it.status === "error" ? "has an error" : "failed"}: ${textLines(String(it.error ?? "")).trim().split("\n").slice(-6).join("\n")}` });
    }
  }
  const errors = problems.filter((p) => p.level === "error").length, warnings = problems.length - errors;
  if (json) {
    process.stdout.write(JSON.stringify({ file, ok: errors === 0, errors, warnings, problems, code: code ? { mode: code.mode, items: code.items } : null, ...(notRun ? { notRun } : {}) }, null, 2) + "\n");
  } else {
    const w = process.stdout, name = oneLine(file === "-" ? "(standard input)" : basename(file));
    const nfig = code ? code.items.reduce((n, i) => n + i.outputs.filter((o: any) => o.figure).length, 0) : 0;
    const figs = nfig ? `, ${nfig} figure${nfig === 1 ? "" : "s"}${figures !== null ? ` saved in ${oneLine(figures)}` : ""}` : "";
    const ran = code ? `; ${code.items.length} code item${code.items.length === 1 ? "" : "s"} run (${code.mode}): ${code.items.filter((i) => i.status === "ok").length} ok${figs}` : notRun ? `; ${notRun}` : run ? "" : "; code items not run (--no-run)";
    w.write(errors || warnings ? `${name}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${ran}\n` : `${name}: no problems${ran}\n`);
    for (const p of problems) {
      const lines = textLines(p.message).split("\n");
      w.write(`${p.level === "error" ? "error  " : "warning"}  ${oneLine(p.path || "(the board)")}: ${lines[0]}\n${lines.slice(1).map((l) => "           " + l + "\n").join("")}`);
    }
  }
  return errors ? 1 : 0;
}

/** A file's bytes (or standard input's, "-"), read to its end in pieces;
 * null as soon as there are more than `max`, the rest unread.  A pipe that
 * isn't ready yet (EAGAIN) is waited for. */
export function readBounded(file: string, max: number): Buffer | null {
  const fd = file === "-" ? 0 : openSync(file, "r");
  const chunks: Buffer[] = [], piece = Buffer.alloc(1 << 20);
  let total = 0;
  try {
    for (;;) {
      let n: number;
      try {
        // (at most one byte past max: enough to know there are more)
        n = readSync(fd, piece, 0, Math.min(piece.length, max - total + 1), null);
      } catch (e: any) {
        if (e?.code === "EAGAIN") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); continue; }
        if (e?.code === "EOF") break;
        throw e;
      }
      if (n === 0) break;
      total += n;
      if (total > max) return null;
      chunks.push(Buffer.from(piece.subarray(0, n)));
    }
  } finally {
    if (fd !== 0) closeSync(fd);
  }
  return Buffer.concat(chunks, total);
}

/** Where each item is, by page (from 1) and id: its path in the file. */
function itemPaths(d: any): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (ns: unknown, at: string, page: number) => {
    if (!Array.isArray(ns)) return;
    ns.forEach((n, i) => { if (isObj(n)) { if (n.id != null && !out.has(`${page}\0${n.id}`)) out.set(`${page}\0${n.id}`, step(at, i)); if (n.kind === "group") walk(n.children, step(step(at, i), "children"), page); } });
  };
  if (Array.isArray(d.pages)) d.pages.forEach((p: any, i: number) => walk(p?.nodes, `pages[${i}].nodes`, i + 1));
  else walk(d.nodes, "nodes", 1);
  return out;
}
