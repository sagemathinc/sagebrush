// What the preview can't show or found wrong in a .tex, each problem with its line: `sagebrush latex check`
// (src/latex-cli.ts) and the LaTeX page's latex_check tool (agent-tools.ts) build the same report from the engine's
// result (render.mjs: problems {kind, name, at}, frames {n, title, at}, the SageTeX items) and the images'.

export interface Problem { severity: "error" | "warning"; kind: string; name: string; line: number | null; message: string }
export interface ImageReport { name: string; found: boolean; path?: string; why?: string }
export interface CheckResult {
  file: string; ok: boolean; class: "beamer" | "other"; outcome: string;
  frames: { n: number; title: string; line: number | null }[];
  problems: Problem[];
  images: ImageReport[];
  code: { n: number; mode: string; state: string }[];
}
/** The engine's result, as render.mjs gives it (and the worker passes on). */
export interface EngineCheck {
  outcome: string; beamer: boolean;
  problems: { kind: string; name: string; at: number }[];
  frames: { n: number; title: string; at: number }[];
  sage: { mode: string; err?: string | null }[];
}

/** The line (1-based) of a source offset, or null for none. */
export function lineOf(text: string, at: number): number | null {
  if (!(at >= 0)) return null;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

const MESSAGES: Record<string, (name: string) => string> = {
  command: (n) => `\\${n} is not supported by the preview (it shows as a grey \\${n} chip)`,
  environment: (n) => `the ${n} environment is not supported by the preview (its content is shown in a plain box)`,
  "not-rendered": (n) => `${n} is not drawn by the preview (a placeholder is shown instead)`,
  math: (n) => `KaTeX can't typeset this math: ${n}`,
  runaway: (n) => `\\${n}: the paragraph ended before its argument was complete (a missing "}"?)`,
  redefined: (n) => `\\newcommand: \\${n} is already defined (LaTeX would stop here; use \\renewcommand)`,
};
const ERRORS = new Set(["math", "runaway", "redefined", "image", "expansion"]);

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
    problems.push({ severity: ERRORS.has(p.kind) ? "error" : "warning", kind: p.kind, name: p.name, line: lineOf(text, p.at), message: m ? m(p.name) : `${p.kind}: ${p.name}` });
  }
  for (const im of images) if (!im.found) problems.push({ severity: "error", kind: "image", name: im.name, line: lineFind(text, im.name), message: `\\includegraphics{${im.name}}: ${im.why}` });
  const code = r.sage.map((it, k) => ({ n: k + 1, mode: String(it.mode), state: it.err ? `refused: ${it.err}` : "not run" }));
  if (code.length) problems.push({ severity: "warning", kind: "code", name: String(code.length), line: null, message: `${code.length} SageTeX item${code.length === 1 ? " is" : "s are"} shown but not run by the preview` });
  problems.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));
  return {
    file, ok: !problems.some((p) => p.severity === "error"), class: r.beamer ? "beamer" : "other", outcome: String(r.outcome),
    frames: r.frames.map((f) => ({ n: f.n, title: f.title, line: lineOf(text, f.at) })),
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
