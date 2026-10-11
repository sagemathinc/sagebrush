// The differential fuzzer of the reactive notebook (test/fuzz-reactive.ts,
// the command; test/fuzz-reactive.test.ts, the regression cases and a short
// run in npm test).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { Reactive, SCOPE_SEP, type CellInfo, type CellState } from "../src/notebook-reactive";
import { analyzeCell } from "../src/dataflow";
import { renameRedefinitions } from "../src/rename";

// ------------------------------------------------------------ the interpreter

export interface RunOut { out: string; err: string | null; ms: number }

export class Kernel {
  private p: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiting: ((x: any) => void)[] = [];
  constructor() {
    this.p = spawn("python3", [join(__dirname, "../../test/fuzz_kernel.py")], { stdio: ["pipe", "pipe", "pipe"] });
    this.p.stdout.setEncoding("utf8");
    this.p.stdout.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.waiting.shift()?.(JSON.parse(line));
      }
    });
    this.p.stderr.on("data", (d) => process.stderr.write(d));
  }
  call(m: object): Promise<any> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.p.stdin.write(JSON.stringify(m) + "\n");
    });
  }
  close() { this.p.stdin.end(); }
}

// ------------------------------------------------------------ randomness

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ the generator

// redefinable integer names; f, g functions; C, D classes; K defined once
const NAMES = ["x", "y", "z"];
const FUNCS = ["f", "g"];
const CLASSES = ["C", "D"];

export class Gen {
  private n = 0;
  constructor(private rand: () => number) {}
  int(k: number) { return Math.floor(this.rand() * k); }
  pick<T>(xs: T[]): T { return xs[this.int(xs.length)]; }
  chance(p: number) { return this.rand() < p; }
  // what is (probably) defined at this point, top to bottom
  ints = new Set<string>(["K"]);
  funcs = new Set<string>();
  classes = new Map<string, Set<string>>();

  // an integer expression reading what is defined; `local`: names usable in this scope too
  expr(depth = 0, local: string[] = []): string {
    const names = [...this.ints, ...local];
    const r = this.rand();
    if (depth > 2 || r < 0.25) return String(this.int(10));
    if (r < 0.5) return names.length ? this.pick(names) : String(this.int(10));
    if (r < 0.65) return `${this.expr(depth + 1, local)} ${this.pick(["+", "-", "*"])} ${this.expr(depth + 1, local)}`;
    if (r < 0.72 && this.funcs.size) return `${this.pick([...this.funcs])}(${this.expr(depth + 1, local)})`;
    if (r < 0.79 && this.classes.size) {
      const [c, attrs] = this.pick([...this.classes]);
      if (attrs.size) return `${c}.${this.pick([...attrs])}`;
    }
    if (r < 0.86) return `sum([${this.expr(depth + 1, [...local, "i"])} for i in range(3)])`;
    if (r < 0.92) return `(lambda q: q + ${this.expr(depth + 1, [...local, "q"])})(${this.expr(depth + 1, local)})`;
    return `(${this.expr(depth + 1, local)} if ${this.expr(depth + 1, local)} > 3 else ${this.expr(depth + 1, local)})`;
  }

  // a class body's statements: its own attributes (some named like the
  // notebook's names, whose reads depend on order), compound statements,
  // a comprehension, a lambda, a method with a default
  classBody(): { lines: string[]; attrs: Set<string> } {
    const lines: string[] = [];
    const attrs = new Set<string>();
    const k = 1 + this.int(4);
    for (let j = 0; j < k; j++) {
      const v = this.pick([...NAMES, "a", "b"]);
      const r = this.rand();
      if (r < 0.3) { lines.push(`    ${v} = ${this.expr(1, [...attrs])}`); attrs.add(v); }
      else if (r < 0.4 && attrs.size) { const a = this.pick([...attrs]); lines.push(`    del ${a}`); attrs.delete(a); }
      else if (r < 0.5) { lines.push(`    if True:`, `        ${v} = ${this.expr(1, [...attrs])}`); attrs.add(v); }
      else if (r < 0.6) { lines.push(`    for ${v} in range(${1 + this.int(3)}):`, `        pass`); attrs.add(v); }
      // (a tuple: a list here would be shared by the names bound to it, and
      // `x += x` would change it in place, a documented limit)
      else if (r < 0.7) { lines.push(`    ${v}v = tuple([${this.expr(1, ["i"])} for i in range(2)])`); attrs.add(`${v}v`); }
      else if (r < 0.8) { lines.push(`    def m${j}(self, p=${this.expr(1, [...attrs])}):`, `        return p`); }
      else if (r < 0.9 && attrs.size) { const a = this.pick([...attrs]); lines.push(`    ${a} += ${this.expr(1, [...attrs])}`); }
      else { lines.push(`    ${v} = (lambda: ${this.expr(1)})()`); attrs.add(v); }
    }
    if (!attrs.size) { lines.push(`    a = ${this.expr(1)}`); attrs.add("a"); }
    return { lines, attrs };
  }

  stmt(): string {
    const v = this.pick(NAMES);
    const r = this.rand();
    const def = (x: string) => this.ints.add(x);
    if (r < 0.2) { const e = this.expr(); def(v); return `${v} = ${e}`; }
    if (r < 0.28 && this.ints.has(v)) return `${v} += ${this.expr()}`;
    if (r < 0.33) { const u = this.pick(NAMES); const e1 = this.expr(), e2 = this.expr(); def(v); def(u); return `${v}, ${u} = ${e1}, ${e2}`; }
    if (r < 0.48) return `print(${this.expr()}, ${this.expr()})`;
    if (r < 0.52) { def(v); return `for ${v} in range(${1 + this.int(4)}):\n    pass`; }
    if (r < 0.58) {
      const f = this.pick(FUNCS);
      const body = this.chance(0.5) ? "a * K + b" : "a - b";
      const s = `def ${f}(a, b=${this.expr(1)}):\n    return ${body}`;
      this.funcs.add(f);
      return s;
    }
    if (r < 0.64 && this.funcs.size) return `print(${this.pick([...this.funcs])}(${this.expr()}))`;
    if (r < 0.72) {
      const c = this.pick(CLASSES);
      const { lines, attrs } = this.classBody();
      this.classes.set(c, attrs);
      return [`class ${c}:`, ...lines].join("\n");
    }
    if (r < 0.76) { const e = this.expr(); def(v); return `print((${v} := ${e}))`; }
    if (r < 0.8) { const e = this.expr(); def(v); return `if True:\n    ${v} = ${e}`; }
    if (r < 0.84 && this.ints.has(v)) { this.ints.delete(v); return `del ${v}`; }
    if (r < 0.88) {
      // a function setting a global, called at once in its cell
      const s = `def set${++this.n}():\n    global ${v}\n    ${v} = ${this.int(10)}\nset${this.n}()`;
      def(v);
      return s;
    }
    if (r < 0.92) {
      const e = this.expr();
      if (this.chance(0.3)) { this.ints.delete(v); return `try:\n    1 // 0\nexcept ZeroDivisionError as ${v}:\n    print(type(${v}).__name__)`; }
      def(v);
      return `try:\n    ${v} = 10 // (${e})\nexcept ZeroDivisionError:\n    ${v} = -1`;
    }
    if (r < 0.96 && this.ints.has(v)) return `print(${v})`;
    const e = this.expr();
    def(v);
    return `${v} = ${e}`;
  }

  cell(): string[] {
    const k = 1 + this.int(3);
    return Array.from({ length: k }, () => this.stmt());
  }
}

// ------------------------------------------------------------ cases

export interface Cell { id: string; stmts: string[] }
export type Op =
  | { kind: "edit"; id: string; stmts: string[] }
  | { kind: "insert"; at: number; id: string; stmts: string[] }
  | { kind: "delete"; id: string }
  | { kind: "move"; id: string; to: number };
export interface Case { seed: number; cells: Cell[]; ops: Op[] }

const code = (c: Cell) => c.stmts.join("\n");

// a generator positioned after `cells` (what they define, approximately)
export function genAfter(rand: () => number, cells: Cell[]): Gen {
  const g = new Gen(rand);
  for (const c of cells) {
    try {
      const a = analyzeCell(code(c));
      for (const d of a.defs) {
        if (NAMES.includes(d)) g.ints.add(d);
        if (FUNCS.includes(d)) g.funcs.add(d);
      }
      for (const d of a.deleted ?? []) g.ints.delete(d);
    } catch {}
  }
  return g;
}

export function makeCase(seed: number, steps: number): Case {
  const rand = mulberry32(seed);
  const g = new Gen(rand);
  let n = 0;
  const cells: Cell[] = [{ id: `c${n++}`, stmts: ["K = 7"] }];
  const k = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < k; i++) cells.push({ id: `c${n++}`, stmts: g.cell() });
  const ops: Op[] = [];
  const now = cells.map((c) => ({ ...c }));
  for (let s = 0; s < steps; s++) {
    const r = rand();
    if (r < 0.4 && now.length > 1) {
      const i = 1 + Math.floor(rand() * (now.length - 1));
      const stmts = genAfter(rand, now.slice(0, i)).cell();
      ops.push({ kind: "edit", id: now[i].id, stmts });
      now[i] = { ...now[i], stmts };
    } else if (r < 0.65) {
      const at = 1 + Math.floor(rand() * now.length);
      const c = { id: `c${n++}`, stmts: genAfter(rand, now.slice(0, at)).cell() };
      ops.push({ kind: "insert", at, id: c.id, stmts: c.stmts });
      now.splice(at, 0, c);
    } else if (r < 0.8 && now.length > 2) {
      const i = 1 + Math.floor(rand() * (now.length - 1));
      ops.push({ kind: "delete", id: now[i].id });
      now.splice(i, 1);
    } else if (now.length > 2) {
      const i = 1 + Math.floor(rand() * (now.length - 1));
      const to = 1 + Math.floor(rand() * (now.length - 1));
      ops.push({ kind: "move", id: now[i].id, to });
      const [c] = now.splice(i, 1);
      now.splice(to, 0, c);
    }
  }
  return { seed, cells, ops };
}

// ------------------------------------------------------------ running a case

export interface Failure { step: number; cell: string; why: string; detail: string }
export interface Stats { compared: number; refused: number; unclean: number; steps: number }

export async function runCase(k: Kernel, c: Case, stats: Stats): Promise<Failure | null> {
  await k.call({ op: "reset" });
  let cells: Cell[] = c.cells.map((x) => ({ ...x }));
  const outs = new Map<string, RunOut>();
  const states = new Map<string, CellState>();
  const r = new Reactive({
    cells: (): CellInfo[] => cells.map((x) => ({ id: x.id, code: code(x) })),
    analyze: async (src) => {
      try {
        return analyzeCell(src);
      } catch (e: any) {
        return { error: { kind: e.name === "ImportStarError" ? "import-star" : "syntax", message: e.message } };
      }
    },
    execute: async (id, src, forget) => {
      const o: RunOut = await k.call({ op: "exec", code: src, forget });
      outs.set(id, o);
      return { ok: !o.err, ms: o.ms };
    },
    forget: async (names) => { await k.call({ op: "forget", names }); },
    status: (id, s) => states.set(id, s),
    rename: async (q) => {
      const m = renameRedefinitions(q.cells, q.name, new Set(q.taken), "python", SCOPE_SEP);
      return m ? [...m] : null;
    },
  });
  r.budget = Infinity;

  const check = async (step: number): Promise<Failure | null> => {
    stats.steps++;
    // the reference: the cells not shown with an error, top to bottom
    const shown = cells.filter((x) => states.get(x.id)?.state !== "error");
    stats.refused += cells.length - shown.length;
    const ref: { cells: RunOut[] } = await k.call({ op: "ref", cells: shown.map(code) });
    const want = new Map(shown.map((x, i) => [x.id, ref.cells[i]]));
    if (ref.cells.some((o) => o.err)) stats.unclean++;
    for (const x of shown) {
      const w = want.get(x.id)!;
      if (w.err) break; // (after an exception, the reference says nothing more)
      const s = states.get(x.id);
      if (s?.state === "cancelled") continue; // (waiting for an error elsewhere)
      const got = outs.get(x.id);
      const ctx = () => `state ${JSON.stringify(s)}\nran:\n${r.effective(x.id)}\ngot: ${JSON.stringify(got)}\nwant: ${JSON.stringify(w)}`;
      if (s?.state !== "done") return { step, cell: x.id, why: `not computed (${s?.state})`, detail: ctx() };
      if (!s.ok) return { step, cell: x.id, why: "raised, but plain Python does not", detail: ctx() };
      if (got?.out !== w.out) return { step, cell: x.id, why: "output differs from plain Python", detail: ctx() };
      stats.compared++;
    }
    return null;
  };

  const debug = (what: string, rep: any) => { if (process.env.FUZZ_DEBUG) console.log(what, JSON.stringify(rep), JSON.stringify(cells.map((x) => [x.id, r.effective(x.id)]))); };
  await r.load();
  debug("runAll", await r.runAll());
  let f = await check(0);
  if (f) return f;
  for (let s = 0; s < c.ops.length; s++) {
    const op = c.ops[s];
    if (op.kind === "edit") {
      const i = cells.findIndex((x) => x.id === op.id);
      if (i < 0) continue;
      cells[i] = { ...cells[i], stmts: op.stmts };
      debug(`edit ${op.id}`, await r.run([op.id]));
    } else if (op.kind === "insert") {
      cells.splice(Math.min(op.at, cells.length), 0, { id: op.id, stmts: op.stmts });
      debug(`insert ${op.id}`, await r.run([op.id]));
    } else if (op.kind === "delete") {
      if (!cells.some((x) => x.id === op.id)) continue;
      cells = cells.filter((x) => x.id !== op.id);
      outs.delete(op.id);
      states.delete(op.id);
      debug(`delete ${op.id}`, await r.remove([op.id]));
    } else {
      const i = cells.findIndex((x) => x.id === op.id);
      if (i < 0) continue;
      const [x] = cells.splice(i, 1);
      cells.splice(Math.min(op.to, cells.length), 0, x);
      debug(`move ${op.id}`, await r.reordered());
    }
    f = await check(s + 1);
    if (f) return f;
  }
  return null;
}

// ------------------------------------------------------------ shrinking

export async function fails(k: Kernel, c: Case): Promise<Failure | null> {
  try {
    return await runCase(k, c, { compared: 0, refused: 0, unclean: 0, steps: 0 });
  } catch (e: any) {
    return { step: -1, cell: "", why: "the harness threw", detail: String(e?.stack ?? e) };
  }
}

export async function shrink(k: Kernel, c: Case, f: Failure): Promise<[Case, Failure]> {
  let best = c, bf = f;
  const tryCase = async (cand: Case) => {
    const g = await fails(k, cand);
    if (g && g.why === bf.why) { best = cand; bf = g; return true; }
    return false;
  };
  let progress = true;
  while (progress) {
    progress = false;
    // fewer steps (everything after the failure first)
    if (best.ops.length > bf.step) { if (await tryCase({ ...best, ops: best.ops.slice(0, Math.max(0, bf.step)) })) progress = true; }
    for (let i = best.ops.length - 1; i >= 0; i--) if (await tryCase({ ...best, ops: best.ops.filter((_, j) => j !== i) })) progress = true;
    // fewer cells (and the steps on them)
    for (let i = best.cells.length - 1; i >= 0; i--) {
      const id = best.cells[i].id;
      if (await tryCase({ ...best, cells: best.cells.filter((_, j) => j !== i), ops: best.ops.filter((o) => o.id !== id) })) progress = true;
    }
    // fewer statements
    for (let i = 0; i < best.cells.length; i++) {
      for (let j = best.cells[i].stmts.length - 1; j >= 0 && best.cells[i].stmts.length > 1; j--) {
        const cells = best.cells.map((x, a) => (a === i ? { ...x, stmts: x.stmts.filter((_, b) => b !== j) } : x));
        if (await tryCase({ ...best, cells })) progress = true;
      }
    }
    for (let i = 0; i < best.ops.length; i++) {
      const op = best.ops[i];
      if (op.kind !== "edit" && op.kind !== "insert") continue;
      for (let j = op.stmts.length - 1; j >= 0 && op.stmts.length > 1; j--) {
        const ops = best.ops.map((o, a) => (a === i ? { ...o, stmts: (o as any).stmts.filter((_: string, b: number) => b !== j) } : o)) as Op[];
        if (await tryCase({ ...best, ops })) progress = true;
      }
    }
  }
  return [best, bf];
}

export function show(c: Case): string {
  const lines = [`seed ${c.seed}`, "cells:"];
  for (const x of c.cells) lines.push(`--- ${x.id}`, code(x));
  for (const op of c.ops) {
    if (op.kind === "edit") lines.push(`=== edit ${op.id}:`, op.stmts.join("\n"));
    else if (op.kind === "insert") lines.push(`=== insert ${op.id} at ${op.at}:`, op.stmts.join("\n"));
    else if (op.kind === "delete") lines.push(`=== delete ${op.id}`);
    else lines.push(`=== move ${op.id} to ${op.to}`);
  }
  return lines.join("\n");
}

