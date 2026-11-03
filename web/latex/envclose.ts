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

/** What to insert at `at`, just after a "}" the person typed (text[at - 1]), to close the environment it opened; or null. */
export function autoClose(text: string, at: number): string | null {
  if (text[at - 1] !== "}") return null;
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = text.indexOf("\n", at);
  // (only at the end of the line's text: before other text, a close would split it)
  if (text.slice(at, lineEnd < 0 ? text.length : lineEnd).trim() !== "") return null;
  const before = text.slice(lineStart, at - 1);
  // (an unescaped \begin{X just before the "}": an odd run of backslashes, so \\begin, a line break, is not one)
  const m = /(?:^|[^\\])((?:\\\\)*)\\begin\{([A-Za-z@]+\*?)$/.exec(before);
  if (!m) return null;
  const name = m[2];
  // (a comment: an unescaped % earlier on the line)
  if (/(?:^|[^\\])(?:\\\\)*%/.test(before.slice(0, m.index + 1 + m[1].length))) return null;
  // (in an open verbatim-like environment: one begun before this line and not ended)
  const re = /\\(begin|end)\{([A-Za-z@]+\*?)\}/g, head = text.slice(0, lineStart);
  const open: string[] = [];
  for (let r = re.exec(head); r; r = re.exec(head)) {
    if (!LITERAL.has(r[2])) continue;
    if (r[1] === "begin") open.push(r[2]); else if (open[open.length - 1] === r[2]) open.pop();
  }
  if (open.length) return null;
  // (a matching close already next: nothing more)
  if (text.slice(lineEnd < 0 ? text.length : lineEnd).trimStart().startsWith("\\end{" + name + "}")) return null;
  return "\n" + /^[ \t]*/.exec(before)![0] + "\\end{" + name + "}";
}
