// What the preview can't show or found wrong in a .tex, each problem with its line: `sagebrush latex check`
// (src/latex-cli.ts) and the LaTeX page's latex_check tool (agent-tools.ts) build the same report from the engine's
// result (render.mjs: problems {kind, name, at}, frames {n, title, at}, the SageTeX items) and the images'.

export interface Problem { severity: "error" | "warning"; kind: string; name: string; line: number | null; message: string }
export interface ImageReport { name: string; found: boolean; path?: string; why?: string }
export interface CheckResult {
  file: string; ok: boolean; class: "beamer" | "other"; outcome: string;
  frames: { n: number; title: string; line: number | null; steps: number }[];
  problems: Problem[];
  images: ImageReport[];
  code: { n: number; mode: string; line: number | null; state: string }[];
}
/** The engine's result, as render.mjs gives it (and the worker passes on). */
export interface EngineCheck {
  outcome: string; beamer: boolean;
  problems: { kind: string; name: string; at: number }[];
  frames: { n: number; title: string; at: number; steps?: number }[];
  /** The code items in order: refused (err), and their state if they were run (s: ok, error, blocked; msg). */
  sage: { mode: string; err?: string | null; at?: number; s?: string; msg?: string }[];
}

/** The line (1-based) of a source offset, or null for none. */
export function lineOf(text: string, at: number): number | null {
  if (!(at >= 0)) return null;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

import { staleWhy, BLOCKED } from "./engine/sagetex.mjs";

const MESSAGES: Record<string, (name: string) => string> = {
  command: (n) => `\\${n} is not supported by the preview (it shows as a grey \\${n} chip)`,
  environment: (n) => `the ${n} environment is not supported by the preview (its content is shown in a plain box)`,
  "not-rendered": (n) => `${n} is not drawn by the preview (a placeholder is shown instead)`,
  // (Codex W01: results whose run imported a file of the .tex's folder since changed or gone: not used)
  stale: (n) => `the SageTeX results beside the .tex aren't used: ${staleWhy(n)}; \`sagebrush latex run\` runs the code again`,
  math: (n) => `KaTeX can't typeset this math: ${n}`,
  runaway: (n) => `\\${n}: the paragraph ended before its argument was complete (a missing "}"?)`,
  redefined: (n) => `\\newcommand: \\${n} is already defined (LaTeX would stop here; use \\renewcommand)`,
  toolarge: (n) => `${n}: the preview and Present show a placeholder instead (make it smaller, or split it)`,
  // (Magma and MATLAB, Sagebrush extensions: a name the document defines itself turns ours off; each of ours used, said
  //  once)
  own: (n) => (EXT[n] ? `This document defines its own \\${n}, so Sagebrush's \\${n}{} is off here.` : `This document defines its own ${n} environment, so Sagebrush's ${n} is off here.`),
  sbonly: (n) => (EXT[n] ? `Sagebrush only: real LaTeX reports \\${n} as an undefined control sequence (no package defines it).` : `Sagebrush only: real LaTeX reports environment ${n} as undefined (no package defines it).`),
};
const EXT: Record<string, string> = { magma: "Magma", matlab: "MATLAB" };
const ERRORS = new Set(["math", "runaway", "redefined", "image", "expansion", "input"]);

/** The first line naming an image (a missing one has no position of its own). */
function lineFind(text: string, name: string): number | null {
  const i = text.indexOf("{" + name + "}");
  return i < 0 ? null : lineOf(text, i);
}

/** The report for `file` (its source `text`), from the engine's result and the images' resolution. */
export function checkResult(file: string, text: string, r: EngineCheck, images: ImageReport[]): CheckResult {
  const problems: Problem[] = [];
  if (r.outcome !== "ok") problems.push({ severity: "error", kind: "expansion", name: String(r.outcome), line: null, message: `expansion stopped (${r.outcome}): the preview shows the document only up to that point` });
  for (const p of r.problems) {
    const m = MESSAGES[p.kind];
    // (an \input or \include not read: where it was looked for, the renderer's reason)
    if (p.kind === "input") { problems.push({ severity: "error", kind: "input", name: p.name, line: lineFind(text, p.name) ?? lineOf(text, p.at), message: `\\input{${p.name}}: ${(p as any).why || "not found"}` }); continue; }
    problems.push({ severity: ERRORS.has(p.kind) ? "error" : "warning", kind: p.kind, name: p.name, line: lineOf(text, p.at), message: m ? m(p.name) : `${p.kind}: ${p.name}` });
  }
  // (a Magma or MATLAB name the document took over, while another of its language's is still ours: the language's last
  //  such note says which still run it, listing exactly those (H6b))
  const owned = new Set(r.problems.filter((p) => p.kind === "own").map((p) => p.name));
  for (const c in EXT) {
    const stillOn = [[c, `\\${c}{}`], [c + "block"], [c + "silent"]].filter(([n]) => !owned.has(n)).map((x) => x[x.length - 1]);
    const lastOwn = problems.filter((x) => x.kind === "own" && x.name.startsWith(c)).pop();
    if (lastOwn && stillOn.length) lastOwn.message += ` ${stillOn.length > 1 ? stillOn.slice(0, -1).join(", ") + " and " + stillOn[stillOn.length - 1] : stillOn[0]} still run${stillOn.length === 1 ? "s" : ""} ${EXT[c]}.`;
  }
  for (const im of images) if (!im.found) problems.push({ severity: "error", kind: "image", name: im.name, line: lineFind(text, im.name), message: `\\includegraphics{${im.name}}: ${im.why}` });
  // (the code items: one refused or failed is an error at its line; one after a failed one (BLOCKED, board's M4, as
  //  the editor and the CLI say it), a warning;
  //  those not run yet, one warning saying how to run them)
  const last = (m?: string) => String(m ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const code = r.sage.map((it, k) => ({ n: k + 1, mode: String(it.mode), line: lineOf(text, it.at ?? -1),
    state: it.err ? `refused: ${it.err}` : it.s === "ok" ? "ok" : it.s === "error" ? `error: ${last(it.msg)}` : it.s === "blocked" ? "blocked" : "not run" }));
  let notRun = 0;
  // (with any PythonTeX, Magma or MATLAB item, "code item": board's rule, as the preview's banner)
  const what = code.some((c) => /^(py|magma|matlab)/.test(c.mode)) ? "code item" : "SageTeX item";
  for (const c of code) {
    if (c.state.startsWith("refused") || c.state.startsWith("error")) problems.push({ severity: "error", kind: "code", name: String(c.n), line: c.line, message: `${what} ${c.n} (${c.mode}) ${c.state.startsWith("refused") ? "can't be run" : "failed"}: ${c.state.replace(/^(refused|error): /, "")}` });
    else if (c.state === "blocked") problems.push({ severity: "warning", kind: "code", name: String(c.n), line: c.line, message: `${what} ${c.n} (${c.mode}): ${BLOCKED}` });
    else if (c.state === "not run") notRun++;
  }
  if (notRun) problems.push({ severity: "warning", kind: "code", name: String(notRun), line: null, message: `${notRun} ${what}${notRun === 1 ? " is" : "s are"} not run yet: \`sagebrush latex run ${file}\` runs them and keeps their results beside it` });
  problems.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  return {
    file, ok: !problems.some((p) => p.severity === "error"), class: r.beamer ? "beamer" : "other", outcome: String(r.outcome),
    frames: r.frames.map((f) => ({ n: f.n, title: f.title, line: lineOf(text, f.at), steps: f.steps ?? 1 })),
    problems, images, code,
  };
}

/** The report as lines of text, compiler style (file:line: severity: message). */
export function checkText(r: CheckResult): string {
  const lines: string[] = [];
  lines.push(`${r.file}: ${r.class === "beamer" ? `beamer, ${r.frames.length} frame${r.frames.length === 1 ? "" : "s"}` : "a document"}; ${r.problems.length ? `${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}` : "no problems"}`);
  for (const p of r.problems) lines.push(`${r.file}:${p.line ?? "-"}: ${p.severity}: ${p.message}`);
  return lines.join("\n") + "\n";
}
