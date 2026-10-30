// The escape-hatch policy for tsconfig.web.json's closure (tooling plan r2 G-C4; astra2, daybreak2 and @sagebrush on
// #232 r1-r6).  No lexer decides what is checked (r6): enforcement runs over a SUPERSET of the real comments, the
// candidates
//
//   every raw "/*" occurrence, to the first "*/" after it   (block comments don't nest: each real one is exactly this)
//   every raw "//", "<!--" and "-->", to the next line terminator (LF, CR, U+2028 or U+2029: exactly a real line one)
//   a "#!" hashbang at offset 0, to its line's end
//
// wherever they occur, inside strings, regexes, templates or other candidates included, so every real comment IS a
// candidate (the soundness argument: packet soundness.md).  In linear time (r7, daybreak2): no candidate is
// materialized or rescanned.  Each hatch token is found once in the raw text, and whether it lies inside SOME
// candidate, and what that candidate allows, is answered in O(1) from passes made once:
//   nextClose[i]   the first "*/" at or after i (backward pass);
//   lastOpen[i]    the latest "/*" starting at or before i (forward); a token at p is inside some block candidate iff
//                  s = lastOpen[p - 2] exists and nextClose[s + 2] reaches past the token (nextClose is nondecreasing,
//                  so the latest start reaches farthest), and all such candidates end at the same "*/";
//   lineStart      the earliest "//", "<!--" or "-->" since the last line terminator (forward: containment, the longest
//                  line candidate), lineLast the latest (reasons: the shortest), and nextEnd[i] the next terminator;
//   next3[i]       the end of the first run of three letters at or after i (backward): a reason;
//   nextAnyColon   the first "any:" at or after i, with where its reason ends;
//   braceMatch     every "{"'s matching "}" (one stack pass), and nextAnyStar[i] the first "any" word or wildcard "*"
//                  (a JSDoc line's leading "*" excluded) at or after i: a tag's type holds any iff it's before the
//                  type's end.
// A reason is judged in the SHORTEST candidate holding the token (the latest start): stricter than the real comment's
// own text, so conservative.  Inside both a block and a line candidate, both must allow it.  An unterminated "/*"
// fails closed.  The price: hatch-like text inside a string, regex or template is refused (written split, e.g.
// "@" + "ts-ignore", or reviewed); today's three roots contain none (asserted).  Plain /* comments are judged as
// JSDoc too (conservative).
//
// Kinds, counted with permitted uses, each token once (by its position):
//   ts-nocheck, ts-ignore   refused, always
//   ts-expect-error         permitted with a reason (three letters in a row) after it in its candidate
//   jsdoc-any               a tag type holding any or the * wildcard: permitted with "any: <reason>" in its candidate

export type Kind = "ts-nocheck" | "ts-ignore" | "ts-expect-error" | "jsdoc-any";
export type Finding = { kind: Kind; at: number; line: number; reasoned: boolean; permitted: boolean; why?: string };
export type Scan = { findings: Finding[]; problems: string[]; counts: Record<Kind, { permitted: number; refused: number }> };
/** Deterministic scanner work, for the linearity gate.  One step is one source read or one character charged to an
 *  engine operation that scans without going through `at` (the token regexp and typed-array initialization). */
export type HatchWork = { steps: number };

const isTerm = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isWord = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 95 || c === 36;

export function hatches(src: string, work?: HatchWork): Scan {
  const n = src.length;
  const step = work ? (k = 1) => { work.steps += k; } : (_k = 1) => {};
  const at = work
    ? (i: number) => { work.steps++; return i < n ? src.charCodeAt(i) : -1; }
    : (i: number) => i < n ? src.charCodeAt(i) : -1;
  const NONE = n + 1;
  const terms: number[] = [];
  for (let i = 0; i < n; i++) if (isTerm(at(i)) && !(at(i) === 10 && at(i - 1) === 13)) terms.push(i);
  // backward passes
  step(5 * (n + 2)); // zero-initialize five Int32Arrays
  const nextClose = new Int32Array(n + 2), nextEnd = new Int32Array(n + 2), next3 = new Int32Array(n + 2), nextAnyColon = new Int32Array(n + 2), nextAnyStar = new Int32Array(n + 2);
  nextClose[n] = nextClose[n + 1] = NONE; nextEnd[n] = nextEnd[n + 1] = n; next3[n] = next3[n + 1] = NONE; nextAnyColon[n] = nextAnyColon[n + 1] = NONE; nextAnyStar[n] = nextAnyStar[n + 1] = NONE;
  // (a "*" that is the first non-blank character on its line is a JSDoc line prefix, not a wildcard: forward pass)
  step(n + 1); // zero-initialize the Uint8Array
  const prefixStar = new Uint8Array(n + 1);
  for (let i = 0, blank = true; i < n; i++) {
    const c = at(i);
    if (isTerm(c)) { blank = true; continue; }
    if (c === 32 || c === 9) continue;
    if (c === 42 && blank) prefixStar[i] = 1;
    blank = false;
  }
  for (let i = n - 1; i >= 0; i--) {
    const c = at(i);
    nextClose[i] = c === 42 && at(i + 1) === 47 ? i : nextClose[i + 1];
    nextEnd[i] = isTerm(c) ? i : nextEnd[i + 1];
    next3[i] = isLetter(c) && isLetter(at(i + 1)) && isLetter(at(i + 2)) ? i + 3 : next3[i + 1];
    nextAnyColon[i] = c === 97 && at(i + 1) === 110 && at(i + 2) === 121 && at(i + 3) === 58 && !isWord(at(i - 1)) ? i : nextAnyColon[i + 1];
    const any = c === 97 && at(i + 1) === 110 && at(i + 2) === 121 && !isWord(at(i - 1)) && !isWord(at(i + 3));
    nextAnyStar[i] = any || (c === 42 && !prefixStar[i] && at(i + 1) !== 47 && at(i - 1) !== 47) ? i : nextAnyStar[i + 1];
  }
  // forward passes: the latest block start, the latest line-comment start since the last terminator
  // (lineStart: the EARLIEST line opener since the last terminator, for containment (the longest line candidate);
  // lineLast: the LATEST, for reasons (the shortest candidate holding the token, as for blocks))
  step(3 * (n + 1)); // zero-initialize three Int32Arrays
  const lastOpen = new Int32Array(n + 1), lineStart = new Int32Array(n + 1), lineLast = new Int32Array(n + 1);
  const problems: string[] = [];
  let open = -1, ls = src.startsWith("#!") ? 0 : -1, ll = ls, line = 1;
  for (let i = 0; i < n; i++) {
    const c = at(i);
    if (c === 47 && at(i + 1) === 42) {
      open = i;
      if (nextClose[i + 2] === NONE && problems.length === 0) problems.push(`line ${line}: a "/*" with no "*/" after it (unterminated, or hatch-like text the scan can't place): fails closed`);
    }
    if (isTerm(c)) ls = ll = -1;
    else if ((c === 47 && at(i + 1) === 47) || (c === 60 && src.startsWith("<!--", i)) || (c === 45 && src.startsWith("-->", i))) { if (ls < 0) ls = i; ll = i; }
    lastOpen[i] = open;
    lineStart[i] = ls;
    lineLast[i] = ll;
    if (isTerm(c) && !(c === 10 && at(i - 1) === 13)) line++;
  }
  // every "{"'s matching "}" (unmatched: none), one stack pass
  step(2 * (n + 1)); // zero-initialize, then fill, the Int32Array
  const braceMatch = new Int32Array(n + 1).fill(-1);
  { const st: number[] = []; for (let i = 0; i < n; i++) { const c = at(i); if (c === 123) st.push(i); else if (c === 125 && st.length) braceMatch[st.pop()!] = i; } }
  /** the candidates holding [p, p + len): the block one's start (latest) and end, the line one's end; null if none */
  const holders = (p: number, len: number) => {
    const s = p >= 2 ? lastOpen[p - 2] : -1;
    const block = s >= 0 && nextClose[s + 2] !== NONE && nextClose[s + 2] >= p + len ? { start: s, end: nextClose[s + 2] } : null;
    const lsP = lineStart[p];
    const line = lsP >= 0 && lsP < p ? { start: lineLast[p - 1], end: nextEnd[p] } : null;
    return { block, line };
  };
  const reasonIn = (from: number, end: number) => next3[from] <= end;
  const anyReasonIn = (start: number, end: number) => { const q = nextAnyColon[start]; return q < end && next3[q + 4] <= end; };
  const findings: Finding[] = [];
  // TOKEN reports positions in increasing order, so one monotone cursor assigns all line numbers in O(n + findings).
  let term = 0;
  const add = (kind: Kind, p: number, permitted: boolean, why?: string) => {
    while (term < terms.length && terms[term] < p) { step(); term++; }
    findings.push({ kind, at: p, line: term + 1, reasoned: permitted, permitted, ...(why ? { why } : {}) });
  };
  const TOKEN = /@ts-(nocheck|ignore|expect-error)\b|@(?:type|param|returns?|typedef|property|prop|template|this|enum|satisfies|callback|arg|argument)\b[\s*]*\{/g;
  step(n); // matchAll's regexp scan reads the source without going through at()
  for (const m of src.matchAll(TOKEN)) {
    const p = m.index!, len = m[0].length;
    const { block, line } = holders(p, len);
    if (!block && !line) continue; // (in no candidate: not in any comment)
    if (m[1] === "nocheck" || m[1] === "ignore") { add(`ts-${m[1]}` as Kind, p, false, `@ts-${m[1]} turns the check off`); continue; }
    if (m[1] === "expect-error") {
      const ok = (!block || reasonIn(p + len, block.end)) && (!line || reasonIn(p + len, line.end));
      add("ts-expect-error", p, ok, ok ? undefined : "@ts-expect-error without a reason in its comment");
      continue;
    }
    // (a tag's type: from its "{" to the matching "}", cut at the candidate's end)
    const ob = p + len - 1;
    const cand = block ?? line!;
    const close = braceMatch[ob] >= 0 && braceMatch[ob] < cand.end ? braceMatch[ob] : cand.end;
    if (nextAnyStar[ob + 1] >= close) continue;
    const ok = (!block || anyReasonIn(block.start, block.end)) && (!line || anyReasonIn(line.start, line.end));
    add("jsdoc-any", p, ok, ok ? undefined : 'a JSDoc any without "any: <reason>" in its comment');
  }
  const counts = { "ts-nocheck": { permitted: 0, refused: 0 }, "ts-ignore": { permitted: 0, refused: 0 }, "ts-expect-error": { permitted: 0, refused: 0 }, "jsdoc-any": { permitted: 0, refused: 0 } };
  for (const f of findings) counts[f.kind][f.permitted ? "permitted" : "refused"]++;
  return { findings, problems, counts };
}
