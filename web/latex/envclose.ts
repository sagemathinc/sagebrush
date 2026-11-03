// An environment closed as it is opened (William, Nov 3, L2: "autoclose environments in the actual editor, e.g., if
// type \begin{verbatim} then \end{verbatim} gets inserted"): the "}" that completes an unescaped \begin{X} also puts
// \end{X} on the next line, at the line's indentation; the caret stays after the "}", so X's arguments ({cc}, [h],
// {Title}) can still be typed, and Enter then opens the body between the two. Not inside a comment or in an open
// verbatim-like environment (its text is literal), not before other text on the line, and never a second close: a
// matching \end{X} already next after the caret (past blank space) is left as it is.

// (environments whose body is not LaTeX: a \begin{X} typed inside one of them is text)
const LITERAL = new Set(["verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "lstlisting", "minted", "comment",
  "filecontents", "filecontents*", "sageblock", "sagesilent", "sageverbatim", "sagecommandline", "sageexample",
  "pycode", "pyblock", "pyverbatim", "pyconsole", "pysub", "matlabcode", "matlabblock", "matlabsilent"]);

// (an environment's name as LaTeX takes it: any characters but braces, backslashes, % and white space, an optional
//  star included)
const NAME = "[^{}\\\\%\\s]+";
const MARK = new RegExp("(\\\\+)(begin|end)\\{(" + NAME + ")\\}", "g");

/** Whether `head` (whole lines) leaves a verbatim-like environment open. */
function literalOpen(head: string): boolean {
  let open: string | null = null;
  for (const line of head.split("\n")) {
    // (a line's text up to its first unescaped %, unless inside a literal environment, where % is text)
    let text = line;
    if (open === null) { const c = /(?:^|[^\\\\])(?:\\\\\\\\)*%/.exec(line); if (c) text = line.slice(0, c.index + c[0].length - 1); }
    MARK.lastIndex = 0;
    for (let r = MARK.exec(text); r; r = MARK.exec(text)) {
      if (r[1].length % 2 === 0) continue;   // (\\begin: a line break, then text)
      if (open === null) { if (r[2] === "begin" && LITERAL.has(r[3])) open = r[3]; }
      else if (r[2] === "end" && r[3] === open) open = null;
    }
  }
  return open !== null;
}

/** What to insert at `at`, just after a "}" the person typed (text[at - 1]), to close the environment it opened; or null. */
export function autoClose(text: string, at: number): string | null {
  if (text[at - 1] !== "}") return null;
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = text.indexOf("\n", at);
  // (only at the end of the line's text: before other text, a close would split it)
  if (text.slice(at, lineEnd < 0 ? text.length : lineEnd).trim() !== "") return null;
  const before = text.slice(lineStart, at - 1);
  // (an unescaped \begin{X just before the "}": an odd run of backslashes, so \\begin, a line break, is not one)
  const m = new RegExp("(?:^|[^\\\\])((?:\\\\\\\\)*)\\\\begin\\{(" + NAME + ")$").exec(before);
  if (!m) return null;
  const name = m[2];
  // (a comment: an unescaped % earlier on the line)
  if (/(?:^|[^\\])(?:\\\\)*%/.test(before.slice(0, m.index + 1 + m[1].length))) return null;
  // (in an open verbatim-like environment: one begun before this line and not ended; a \begin or \end in a comment or
  //  after an escaped backslash (\\begin) is text, never one)
  if (literalOpen(text.slice(0, lineStart))) return null;
  // (a matching close already next: nothing more)
  if (text.slice(lineEnd < 0 ? text.length : lineEnd).trimStart().startsWith("\\end{" + name + "}")) return null;
  return "\n" + /^[ \t]*/.exec(before)![0] + "\\end{" + name + "}";
}
