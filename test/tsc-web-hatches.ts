// The escape-hatch policy for tsconfig.web.json's closure (tooling plan r2 G-C4; astra2 on #232 r1), on WHOLE comments:
// a small lexer finds every comment (strings, template literals with ${} nesting and regex literals skipped), so a
// directive or a JSDoc type spread over lines is seen whole.  TypeScript 7 ships no JS API to borrow a parser from.
// It fails closed: an unterminated comment, string or template is a problem, never a pass.
// Kinds counted, permitted ones included:
//   ts-nocheck, ts-ignore                  refused, always
//   ts-expect-error                        permitted with a reason (three or more letters) in the same comment
//   jsdoc-any                              a JSDoc type containing any or the * wildcard: permitted with "any: <reason>"
//                                          in the same comment, or in a line comment right after it on its last line

export type Comment = { text: string; line: number; endLine: number; block: boolean; jsdoc: boolean; after: string };
export type Kind = "ts-nocheck" | "ts-ignore" | "ts-expect-error" | "jsdoc-any";
export type Finding = { kind: Kind; line: number; reasoned: boolean; permitted: boolean; why?: string };
export type Scan = { findings: Finding[]; problems: string[]; counts: Record<Kind, { permitted: number; refused: number }> };

// The slash: a regex starts where an operand can't end, so the lexer tracks the last significant token as an operand
// (an identifier, a number, a literal, a postfix ++ or --, a ] or a ) that closes an expression) or an operator (any
// other punctuator, a prefix ++ or --, an operator keyword, a ) closing if/while/for/with's head).  A word after
// . or ?. is a property name, an operand, never a keyword or a control head (obj.return / b, obj.if(a) / b).  A } is
// the one context the grammar leaves ambiguous (a block's end or an object's): there the slash is a division if no
// regex can close on its line, and otherwise the WHOLE candidate span is checked: if a comment could start or end
// inside it or at its end (/*, */ or //), either reading could hide a comment, so the scan fails closed.  Everywhere
// else the context is certain, so a real regex such as /[/*]x/ is harmless (astra2 #232 r2/r3 T1-LEX).
const OPERATOR_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const CONTROL_WORDS = new Set(["if", "while", "for", "with"]);

/** Every comment in a JS/TS text, with its 1-based lines; problems for anything left unterminated or ambiguous. */
export function comments(src: string): { list: Comment[]; problems: string[] } {
  const list: Comment[] = [];
  const problems: string[] = [];
  let i = 0, line = 1;
  let prev: "start" | "operand" | "operator" | "brace" = "start";
  let control = false; // the last word was if/while/for/with: the next ( opens a control head
  const parens: boolean[] = []; // per open (, whether it is a control head
  const braces: number[] = []; // template nesting: the brace depth at each `${`
  let depth = 0;
  const n = src.length;
  const lineAt = (from: number, to: number) => { for (let k = from; k < to; k++) if (src[k] === "\n") line++; };
  /** a regex body from the slash at i: the index of its closing slash, or -1 if it doesn't close on its line */
  const regexEnd = (from: number) => {
    let k = from + 1, cls = false;
    while (k < n && src[k] !== "\n" && (cls || src[k] !== "/")) {
      if (src[k] === "\\") k++;
      else if (src[k] === "[") cls = true;
      else if (src[k] === "]") cls = false;
      k++;
    }
    return k < n && src[k] === "/" ? k : -1;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      list.push({ text: src.slice(i, end), line, endLine: line, block: false, jsdoc: false, after: "" });
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) { problems.push(`line ${line}: an unterminated block comment`); break; }
      const start = line;
      lineAt(i, e + 2);
      const rest = src.slice(e + 2, (src.indexOf("\n", e + 2) + 1 || n + 1) - 1);
      list.push({ text: src.slice(i, e + 2), line: start, endLine: line, block: true, jsdoc: src[i + 2] === "*" && src[i + 3] !== "/", after: rest });
      i = e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      if (src[k] !== c) { problems.push(`line ${line}: an unterminated string`); break; }
      i = k + 1;
      prev = "operand";
      continue;
    }
    if (c === "`" || (c === "}" && braces.length && depth === braces[braces.length - 1])) {
      if (c === "}") braces.pop();
      let k = i + 1, closed = false;
      for (;;) {
        if (k >= n) { problems.push(`line ${line}: an unterminated template literal`); i = n; break; }
        if (src[k] === "\\") { k += 2; continue; }
        if (src[k] === "`") { lineAt(i, k + 1); i = k + 1; prev = "operand"; closed = true; break; }
        if (src[k] === "$" && src[k + 1] === "{") { lineAt(i, k + 2); braces.push(depth); i = k + 2; prev = "operator"; closed = true; break; }
        k++;
      }
      if (!closed) break;
      continue;
    }
    if (c === "/") {
      // (a regex where an operand can't end; division after one; at a }, the ambiguous case)
      if (prev === "operand") { i++; prev = "operator"; continue; }
      const e = regexEnd(i);
      if (prev === "brace") {
        if (e < 0) { i++; prev = "operator"; continue; } // (can't be a regex on this line: division)
        const span = src.slice(i, e + 2); // (the candidate regex and the character after its closing slash)
        if (/\/\*|\*\/|\/\//.test(span.slice(1))) { problems.push(`line ${line}: an ambiguous slash after } (a regex or a division, and a comment could start or end inside ${JSON.stringify(span.slice(0, 60))})`); break; }
      }
      if (e < 0) { problems.push(`line ${line}: an unterminated regular expression`); break; }
      i = e + 1;
      while (/[a-z]/i.test(src[i] ?? "")) i++;
      prev = "operand";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k++;
      const w = src.slice(i, k);
      // (a property name, after . or ?. with nothing but spaces between: an operand, whatever the word)
      const member = /(?:^|[^.])\.\s*$|\?\.\s*$/.test(src.slice(Math.max(0, i - 40), i));
      prev = !member && OPERATOR_WORDS.has(w) ? "operator" : "operand";
      control = !member && CONTROL_WORDS.has(w);
      i = k;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(d ?? ""))) {
      let k = i + 1;
      while (k < n && /[0-9A-Za-z_.]/.test(src[k])) k++;
      i = k;
      prev = "operand";
      control = false;
      continue;
    }
    if ((c === "+" || c === "-") && d === c) { prev = prev === "operand" ? "operand" : "operator"; i += 2; control = false; continue; } // (postfix after an operand)
    if (c === "\n") line++;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(") { parens.push(control); prev = "operator"; }
    else if (c === ")") prev = parens.pop() ? "operator" : "operand";
    else if (c === "]") prev = "operand";
    else if (c === "{") { depth++; prev = "operator"; }
    else if (c === "}") { depth--; prev = "brace"; }
    else prev = "operator";
    control = false;
    i++;
  }
  return { list, problems };
}

/** A JSDoc comment's type expressions after a tag, braces balanced across lines. */
function jsdocTypes(text: string): string[] {
  const body = text.replace(/^\/\*\*|\*\/$/g, "").replace(/^[ \t]*\*[ \t]?/gm, "");
  const out: string[] = [];
  const re = /@(?:type|param|returns?|typedef|property|prop|template|this|enum|satisfies|callback|arg|argument)\b\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let k = m.index + m[0].length, deep = 1;
    while (k < body.length && deep) { if (body[k] === "{") deep++; else if (body[k] === "}") deep--; k++; }
    out.push(body.slice(m.index + m[0].length, k - 1));
  }
  return out;
}
const reasonOf = (s: string) => /[A-Za-z]{3,}/.test(s.replace(/\*\/\s*$/, "").replace(/^[\s*]*$/gm, ""));

export function hatches(src: string): Scan {
  const { list, problems } = comments(src);
  const findings: Finding[] = [];
  for (const c of list) {
    for (const [kind, re] of [["ts-nocheck", /@ts-nocheck\b/], ["ts-ignore", /@ts-ignore\b/]] as [Kind, RegExp][])
      if (re.test(c.text)) findings.push({ kind, line: c.line, reasoned: false, permitted: false, why: `@${kind} turns the check off` });
    const ee = c.text.match(/@ts-expect-error\b([\s\S]*)$/);
    if (ee) {
      const reasoned = reasonOf(ee[1]);
      findings.push({ kind: "ts-expect-error", line: c.line, reasoned, permitted: reasoned, ...(reasoned ? {} : { why: "@ts-expect-error without a reason" }) });
    }
    if (c.jsdoc && jsdocTypes(c.text).some((t) => /\bany\b|\*/.test(t))) {
      // (a reason: "any:" followed by real words, three or more letters, in the comment or a line comment right after it)
      const said = (s: string) => { const m = s.match(/\bany:\s*([\s\S]*)$/); return !!m && reasonOf(m[1]); };
      const reasoned = said(c.text) || (/\/\//.test(c.after) && said(c.after.slice(c.after.indexOf("//"))));
      findings.push({ kind: "jsdoc-any", line: c.line, reasoned, permitted: reasoned, ...(reasoned ? {} : { why: 'a JSDoc any without an "any: <reason>"' }) });
    }
  }
  const counts = { "ts-nocheck": { permitted: 0, refused: 0 }, "ts-ignore": { permitted: 0, refused: 0 }, "ts-expect-error": { permitted: 0, refused: 0 }, "jsdoc-any": { permitted: 0, refused: 0 } };
  for (const f of findings) counts[f.kind][f.permitted ? "permitted" : "refused"]++;
  return { findings, problems, counts };
}
