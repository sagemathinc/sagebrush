// The escape-hatch policy for tsconfig.web.json's closure (tooling plan r2 G-C4; astra2 and @sagebrush on #232 r1-r5).
// No lexer decides what is checked (r6): a guessed lexer can be wrong both ways (a division read as a regex, or a
// regex read as a division, then a fake string), so enforcement runs over a SUPERSET of the real comments:
//
//   every raw "/*" occurrence, to the first "*/" after it   (block comments don't nest: each real one is exactly this)
//   every raw "//", "<!--" and "-->", to the next line terminator (\n, \r, \u2028 or \u2029: exactly a real line comment)
//   a "#!" hashbang at the very start, to its line's end
//
// wherever they occur, inside strings, regexes, templates or other candidates included.  Soundness: a real comment
// starts at one of those raw sequences and ends exactly where its candidate ends, so every real comment IS a
// candidate, and the policy, applied to each candidate's own text only, sees every real hatch.  A reason counts only
// inside its own candidate (never from text after it), so a fake candidate can't lend a reason to a real comment, and
// a real comment is always judged on its own exact text.  An unterminated "/*" fails closed.  The price: hatch text
// inside a string, regex or template also fails, so such text is written differently (e.g. "@" + "ts-ignore"), or
// reviewed.  Today's three roots don't trip it (asserted in test/tsc-web.test.ts).
//
// Kinds, counted with permitted uses (each hatch once, by its position in the source; if a real and a fake candidate
// see the same hatch differently, the refusal wins):
//   ts-nocheck, ts-ignore   refused, always
//   ts-expect-error         permitted with a reason (three or more letters) in the same comment
//   jsdoc-any               a /** comment whose tag type holds any or the * wildcard: permitted with "any: <reason>"
//                           inside the same comment

export type Kind = "ts-nocheck" | "ts-ignore" | "ts-expect-error" | "jsdoc-any";
export type Candidate = { start: number; end: number; text: string; line: number; kind: "block" | "line" | "html" | "hashbang" };
export type Finding = { kind: Kind; at: number; line: number; reasoned: boolean; permitted: boolean; why?: string };
export type Scan = { candidates: number; findings: Finding[]; problems: string[]; counts: Record<Kind, { permitted: number; refused: number }> };

const TERMINATOR = /[\n\r\u2028\u2029]/g;
const lineOf = (src: string, at: number) => src.slice(0, at).split(/\r\n|[\n\r\u2028\u2029]/).length;
const toLineEnd = (src: string, from: number) => {
  TERMINATOR.lastIndex = from;
  const m = TERMINATOR.exec(src);
  return m ? m.index : src.length;
};
function indexes(src: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Every comment candidate (a superset of the real comments), and a problem for each "/*" with no "*\/" after it. */
export function candidates(src: string): { list: Candidate[]; problems: string[] } {
  const list: Candidate[] = [];
  const problems: string[] = [];
  for (const i of indexes(src, "/*")) {
    const e = src.indexOf("*/", i + 2);
    if (e < 0) { problems.push(`line ${lineOf(src, i)}: a "/*" with no "*/" after it (unterminated, or hatch-like text the scan can't place): fails closed`); continue; }
    list.push({ start: i, end: e + 2, text: src.slice(i, e + 2), line: lineOf(src, i), kind: "block" });
  }
  for (const [needle, kind] of [["//", "line"], ["<!--", "html"], ["-->", "html"]] as const)
    for (const i of indexes(src, needle)) { const e = toLineEnd(src, i); list.push({ start: i, end: e, text: src.slice(i, e), line: lineOf(src, i), kind }); }
  if (src.startsWith("#!")) { const e = toLineEnd(src, 0); list.push({ start: 0, end: e, text: src.slice(0, e), line: 1, kind: "hashbang" }); }
  return { list, problems };
}

/** A /** comment's tag type expressions (braces balanced across lines), with their offsets in the comment. */
function jsdocTypes(text: string): { at: number; type: string }[] {
  const out: { at: number; type: string }[] = [];
  const re = /@(?:type|param|returns?|typedef|property|prop|template|this|enum|satisfies|callback|arg|argument)\b[\s*]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let k = m.index + m[0].length, deep = 1;
    while (k < text.length && deep) { if (text[k] === "{") deep++; else if (text[k] === "}") deep--; k++; }
    out.push({ at: m.index, type: text.slice(m.index + m[0].length, k - 1).replace(/^[ \t]*\*[ \t]?/gm, "") });
  }
  return out;
}
const reasonOf = (s: string) => /[A-Za-z]{3,}/.test(s.replace(/\*\/\s*$/, "").replace(/^[\s*]*$/gm, ""));

export function hatches(src: string): Scan {
  const { list, problems } = candidates(src);
  const byPos = new Map<string, Finding>(); // (kind, absolute position) -> the finding, the refusal winning
  const note = (f: Finding) => {
    const k = `${f.kind}@${f.at}`;
    const old = byPos.get(k);
    if (!old || (old.permitted && !f.permitted)) byPos.set(k, f);
  };
  for (const c of list) {
    for (const [kind, re] of [["ts-nocheck", /@ts-nocheck\b/g], ["ts-ignore", /@ts-ignore\b/g]] as [Kind, RegExp][])
      for (const m of c.text.matchAll(re)) note({ kind, at: c.start + m.index!, line: lineOf(src, c.start + m.index!), reasoned: false, permitted: false, why: `@${kind} turns the check off` });
    for (const m of c.text.matchAll(/@ts-expect-error\b/g)) {
      const reasoned = reasonOf(c.text.slice(m.index! + m[0].length));
      note({ kind: "ts-expect-error", at: c.start + m.index!, line: lineOf(src, c.start + m.index!), reasoned, permitted: reasoned, ...(reasoned ? {} : { why: "@ts-expect-error without a reason in its comment" }) });
    }
    if (c.kind === "block" && c.text.startsWith("/**")) {
      const reasoned = (() => { const m = c.text.match(/\bany:\s*([\s\S]*)$/); return !!m && reasonOf(m[1]); })();
      for (const t of jsdocTypes(c.text)) if (/\bany\b|\*/.test(t.type))
        note({ kind: "jsdoc-any", at: c.start + t.at, line: lineOf(src, c.start + t.at), reasoned, permitted: reasoned, ...(reasoned ? {} : { why: 'a JSDoc any without "any: <reason>" in its comment' }) });
    }
  }
  const findings = [...byPos.values()].sort((a, b) => a.at - b.at);
  const counts = { "ts-nocheck": { permitted: 0, refused: 0 }, "ts-ignore": { permitted: 0, refused: 0 }, "ts-expect-error": { permitted: 0, refused: 0 }, "jsdoc-any": { permitted: 0, refused: 0 } };
  for (const f of findings) counts[f.kind][f.permitted ? "permitted" : "refused"]++;
  return { candidates: list.length, findings, problems, counts };
}
