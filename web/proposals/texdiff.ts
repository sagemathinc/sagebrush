// A rendered LaTeX diff, in the spirit of latexdiff (William, Nov 3: "people much prefer ... looking at a diff in the
// rendered doc, not the source"): the new document's source with what was added marked \DIFadd{...} (blue,
// underlined) and what was removed kept and marked \DIFdel{...} (red, struck through), so the preview shows both.
//
// Small and scoped, no library: the bodies are cut into tokens LaTeX treats as units (words, spaces, inline math, a
// command with its arguments, a whole display or environment), diffed with Myers' algorithm over tokens, and written
// back. Text and inline math are marked in place. A block (a display, an environment, \section{...}) can't be wrapped
// in a macro, so a new one is shown after a marker, and a removed one as a marker naming it.

export type Tok = { t: string; kind: "space" | "par" | "word" | "math" | "cmd" | "block" };

const BLOCK_ENVS = /^(equation|align|gather|multline|eqnarray|figure|table|itemize|enumerate|description|theorem|lemma|proof|definition|corollary|proposition|remark|example|verbatim|lstlisting|tabular|center|quote|abstract)\*?$/;
const SECTIONING = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|item|maketitle|tableofcontents|label|caption|includegraphics|bibliography|bibliographystyle|input|include)\b/;

/** The body cut into tokens (an unbalanced brace or environment ends the token at the end of the text). */
export function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = s.length;
  // (a balanced {...} or [...] group starting at j: its end)
  const group = (j: number, open: string, close: string) => { let d = 0; for (; j < n; j++) { const c = s[j]; if (c === "\\") { j++; continue; } if (c === open) d++; else if (c === close && --d === 0) return j + 1; } return n; };
  while (i < n) {
    const c = s[i];
    if (c === "\n" && /^\n[ \t]*\n/.test(s.slice(i, i + 64))) { let j = i; while (j < n && /\s/.test(s[j])) j++; out.push({ t: s.slice(i, j), kind: "par" }); i = j; continue; }
    if (/\s/.test(c)) { let j = i; while (j < n && /\s/.test(s[j]) && !(s[j] === "\n" && /^\n[ \t]*\n/.test(s.slice(j, j + 64)))) j++; out.push({ t: s.slice(i, j), kind: "space" }); i = j; continue; }
    if (c === "%") { let j = s.indexOf("\n", i); if (j < 0) j = n; out.push({ t: s.slice(i, j), kind: "space" }); i = j; continue; }
    if (c === "$") {
      const dbl = s[i + 1] === "$", close = dbl ? "$$" : "$";
      let j = i + close.length;
      while (j < n && !(s.startsWith(close, j) && s[j - 1] !== "\\")) j++;
      j = Math.min(n, j + close.length);
      out.push({ t: s.slice(i, j), kind: dbl ? "block" : "math" }); i = j; continue;
    }
    if (c === "\\") {
      if (s.startsWith("\\[", i)) { let j = s.indexOf("\\]", i + 2); j = j < 0 ? n : j + 2; out.push({ t: s.slice(i, j), kind: "block" }); i = j; continue; }
      if (s.startsWith("\\(", i)) { let j = s.indexOf("\\)", i + 2); j = j < 0 ? n : j + 2; out.push({ t: s.slice(i, j), kind: "math" }); i = j; continue; }
      const m = /^\\begin\{([^}]*)\}/.exec(s.slice(i, i + 80));
      if (m) {
        // (the whole environment, nested ones of the same name counted)
        const name = m[1], esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\\\(begin|end)\\{${esc}\\}`, "g");
        re.lastIndex = i; let d = 0, j = n, r: RegExpExecArray | null;
        while ((r = re.exec(s))) { if (r[1] === "begin") d++; else if (--d === 0) { j = r.index + r[0].length; break; } }
        out.push({ t: s.slice(i, j), kind: BLOCK_ENVS.test(name) ? "block" : "cmd" }); i = j; continue;
      }
      // (a command, its star, and its [..] and {..} arguments right after it)
      let j = i + 1;
      if (/[a-zA-Z@]/.test(s[j] ?? "")) { while (j < n && /[a-zA-Z@]/.test(s[j])) j++; if (s[j] === "*") j++; }
      else j++;
      const head = s.slice(i, j);
      for (;;) { if (s[j] === "[") j = group(j, "[", "]"); else if (s[j] === "{") j = group(j, "{", "}"); else break; }
      out.push({ t: s.slice(i, j), kind: SECTIONING.test(head) ? "block" : "cmd" }); i = j; continue;
    }
    if (c === "{") { const j = group(i, "{", "}"); out.push({ t: s.slice(i, j), kind: "cmd" }); i = j; continue; }
    let j = i;
    while (j < n && !/[\s$\\{%]/.test(s[j])) j++;
    if (j === i) j = i + 1;
    out.push({ t: s.slice(i, j), kind: "word" }); i = j;
  }
  return out;
}

/** Myers' O(ND) diff of two token lists by their text: the edit script as runs of equal, deleted and inserted tokens.
 * Bounded: past `maxD` edits, everything between the common prefix and suffix is one replacement. */
export function diffTokens(a: Tok[], b: Tok[], maxD = 6000): { op: "=" | "-" | "+"; toks: Tok[] }[] {
  let pre = 0; while (pre < a.length && pre < b.length && a[pre].t === b[pre].t) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf].t === b[b.length - 1 - suf].t) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const N = A.length, M = B.length, max = N + M;
  const ops: ("=" | "-" | "+")[] = [];
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 2);
  let found = false;
  for (let d = 0; d <= Math.min(max, maxD) && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x].t === B[y].t) { x++; y++; }
      v[max + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  if (!found) {
    for (let i = 0; i < N; i++) ops.push("-");
    for (let i = 0; i < M; i++) ops.push("+");
  } else {
    // (back through the trace: the path's moves, last first)
    let x = N, y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
      const vd = trace[d], k = x - y;
      const prevK = k === -d || (k !== d && vd[max + k - 1] < vd[max + k + 1]) ? k + 1 : k - 1;
      const px = vd[max + prevK], py = px - prevK;
      while (x > px && y > py) { ops.push("="); x--; y--; }
      if (d > 0) ops.push(x === px ? "+" : "-");
      x = px; y = py;
    }
    ops.reverse();
  }
  const runs: { op: "=" | "-" | "+"; toks: Tok[] }[] = [];
  const add = (op: "=" | "-" | "+", t: Tok) => { const last = runs[runs.length - 1]; if (last && last.op === op) last.toks.push(t); else runs.push({ op, toks: [t] }); };
  for (let i = 0; i < pre; i++) add("=", a[i]);
  let ia = 0, ib = 0;
  for (const op of ops) { if (op === "=") { add("=", A[ia++]); ib++; } else if (op === "-") add("-", A[ia++]); else add("+", B[ib++]); }
  for (let i = a.length - suf; i < a.length; i++) add("=", a[i]);
  return runs;
}

export const DIFF_MACROS = String.raw`\newcommand{\DIFadd}[1]{\textcolor{blue}{\uline{#1}}}
\newcommand{\DIFdel}[1]{\textcolor{red}{\sout{#1}}}
\newcommand{\DIFblock}[1]{\textcolor{#1}{\textbf{\textsf{[#1]}}}}
`;

const split = (s: string) => {
  const b = s.indexOf("\\begin{document}"), e = s.lastIndexOf("\\end{document}");
  if (b < 0) return { pre: "", body: s, post: "" };
  const bodyStart = b + "\\begin{document}".length;
  return { pre: s.slice(0, bodyStart), body: s.slice(bodyStart, e < 0 ? s.length : e), post: e < 0 ? "" : s.slice(e) };
};
// (a removed block, named by its first words, as text LaTeX shows literally)
const nameOf = (t: string) => t.replace(/\s+/g, " ").slice(0, 60).replace(/[\\{}$&#^_%~]/g, (c) => ({ "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" } as Record<string, string>)[c] ?? "\\" + c);

/** The marked document: the new preamble (with the macros) and the merged body. */
export function texDiff(before: string, after: string): { source: string; added: number; removed: number } {
  const A = split(before), B = split(after);
  const runs = diffTokens(tokenize(A.body), tokenize(B.body));
  let added = 0, removed = 0;
  const out: string[] = [];
  // (inside one run, text and inline math are wrapped together; a block or paragraph break is written on its own)
  const wrap = (toks: Tok[], mac: "DIFadd" | "DIFdel") => {
    let inline: string[] = [];
    const flush = () => { const t = inline.join(""); if (t.trim()) out.push(`\\${mac}{${t}}`); else out.push(mac === "DIFadd" ? t : ""); inline = []; };
    for (const tk of toks) {
      if (tk.kind === "block") {
        flush();
        if (mac === "DIFadd") out.push(`\\DIFadd{\\textsf{[new:]}} \\textcolor{blue}{${tk.t}}`);
        else out.push(`\\DIFdel{\\textsf{[removed: ${nameOf(tk.t)}…]}} `);
      } else if (tk.kind === "par") { flush(); if (mac === "DIFadd") out.push(tk.t); }
      else if (tk.kind === "cmd" && /^\\(label|ref|eqref|cite)\b/.test(tk.t)) { flush(); if (mac === "DIFadd") out.push(tk.t); }
      else inline.push(tk.t);
    }
    flush();
  };
  for (const r of runs) {
    if (r.op === "=") { out.push(r.toks.map((t) => t.t).join("")); continue; }
    const words = r.toks.filter((t) => t.kind !== "space" && t.kind !== "par").length;
    if (r.op === "+") { added += words; wrap(r.toks, "DIFadd"); }
    else { removed += words; wrap(r.toks, "DIFdel"); }
  }
  const pre = B.pre.includes("\\begin{document}") ? B.pre.replace("\\begin{document}", DIFF_MACROS + "\\begin{document}") : DIFF_MACROS + B.pre;
  return { source: pre + out.join("") + B.post, added, removed };
}
