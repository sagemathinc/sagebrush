// The shape of a translated pattern, for re.ts. JS's RegExp and CPython's
// sre (Modules/_sre/sre_lib.h) find the same matches for the patterns
// translate() writes, except where a repeat or a group reference works
// differently in them. This module reads the JS source back into a tree,
// finds those places, and writes the source again so that the two agree
// there, or refuses the pattern (NotImplementedError) where it cannot:
//
// - A repeat whose item can match the empty string. Once its minimum is
//   met, JS fails an iteration that matches nothing; sre takes it, and then
//   repeats no more (MAX_UNTIL's last_ptr). So (a?)* on '' sets group 1 in
//   sre only, and (?:|a)* on 'a' matches '' in sre and 'a' in JS.
//   - A lazy repeat is the same in both: sre tries what follows first, and
//     after an empty iteration it fails again where it failed before.
//   - X? (one at most) is sre's exactly as (?:X|), and X{m,m+1} as
//     X{m}(?:X|): no iteration is refused there.
//   - X* (no maximum), when X tries every nonempty way of matching before
//     an empty one: matches as in JS, and only the groups of X differ, by
//     one last empty iteration, which (?:X)*(?:X'|) adds (X' is X again,
//     its groups new ones in JS, read as X's).
//   - Anything else is refused.
// - A group in a repeat. JS forgets it at each iteration, sre keeps it from
//   an earlier one: (a|(b))+ on 'ba' has group 2 'b' in sre, None in JS.
//   Refused unless the group matches in every iteration (A26).
// - A reference to a group that has not matched: in JS it matches the
//   empty string, in sre it fails. Refused unless the group must have
//   matched wherever the reference is (A23).
//
// sre's lastindex is the group that closed last; with the cases above
// rewritten or refused, that is, of the groups that matched, the one whose
// ")" comes last (A25). And the shape gives what a match that must not be
// empty needs (sre's must_advance, A22): whether the pattern can match a
// character at all, how far back its look-behinds and \b can look, and
// whether it has ^.

type Kind = "cap" | "nc" | "la" | "nla" | "lb" | "nlb";
type W = [number, number];
interface Base {
  w?: W; // the widths it can match, in code points, as CPython's getwidth
  cnt?: number; // how many of its ways of matching are empty: 0, 1, or 2 for more
  el?: boolean; // whether no way of matching after an empty one matches text
}
type Node = Base &
  (
    | { t: "seq"; items: Node[] }
    | { t: "alt"; alts: Node[] }
    | { t: "group"; kind: Kind; open: string; body: Node; cap: number }
    | { t: "quant"; body: Node; min: number; max: number; lazy: boolean; q: string; rw?: "opt" | "tail" }
    | { t: "atom"; src: string; width: number; caret: boolean; back: number }
    | { t: "ref"; src: string; cap: number; name: string | null }
  );

export interface Shape {
  src: string; // the JS source to compile
  groups: number;
  names: string[]; // Python group -> name ("" if none), index 0 unused
  jsToPy: number[] | null; // JS group -> Python group, null if they are the same
  closeSeq: number[]; // JS group -> the order of its ")" in src
  canConsume: boolean; // whether a match can be other than empty
  back: number; // how far before a position the pattern can look, code points
  caret: boolean; // whether the pattern has ^ (\A, or ^ without MULTILINE)
  variant: () => string; // src with ^ never matching
}

const PARSE = Symbol("unparsed");
const OPEN = /\((?:\?(?::|=|!|<=|<!|<([A-Za-z_]\w*)>|i:|-i:))?/y;
const BRACES = /\{(\d+)(?:(,)(\d*))?\}/y;
const KREF = /\\k<([A-Za-z_]\w*)>/y;

function parse(src: string): { root: Node; names: string[] } | null {
  let i = 0;
  const names: string[] = [""];
  const byName = new Map<string, number>();
  const fail = (): never => {
    throw PARSE;
  };
  const alt = (): Node => {
    const alts: Node[] = [seq()];
    while (src[i] === "|") {
      i++;
      alts.push(seq());
    }
    return alts.length === 1 ? alts[0] : { t: "alt", alts };
  };
  const seq = (): Node => {
    const items: Node[] = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") {
      const a = atom();
      const q = quant();
      items.push(q === null ? a : { t: "quant", body: a, ...q });
    }
    return { t: "seq", items };
  };
  const quant = (): { min: number; max: number; lazy: boolean; q: string } | null => {
    const at = i;
    let min: number, max: number;
    const c = src[i];
    if (c === "*") [min, max] = [0, Infinity];
    else if (c === "+") [min, max] = [1, Infinity];
    else if (c === "?") [min, max] = [0, 1];
    else if (c === "{") {
      BRACES.lastIndex = i;
      const m = BRACES.exec(src);
      if (m === null) fail();
      min = Number(m![1]);
      max = m![2] === undefined ? min : m![3] === "" ? Infinity : Number(m![3]);
      i += m![0].length - 1;
    } else return null;
    i++;
    const lazy = src[i] === "?";
    if (lazy) i++;
    return { min: min!, max: max!, lazy, q: src.slice(at, i) };
  };
  const plain = (n: number, width: number, extra: Partial<{ caret: boolean; back: number }> = {}): Node => {
    const s = src.slice(i, i + n);
    i += n;
    return { t: "atom", src: s, width, caret: extra.caret ?? false, back: extra.back ?? 0 };
  };
  const upTo = (ch: string): number => {
    const k = src.indexOf(ch, i);
    if (k < 0) fail();
    return k + 1 - i;
  };
  const atom = (): Node => {
    const c = src[i];
    if (c === "(") {
      OPEN.lastIndex = i;
      const m = OPEN.exec(src)!;
      const o = m[0];
      if (o === "(" && src[i + 1] === "?") fail();
      i += o.length;
      let kind: Kind = "nc", cap = 0;
      if (o === "(" || m[1] !== undefined) {
        kind = "cap";
        cap = names.length;
        names.push(m[1] ?? "");
        if (m[1] !== undefined) byName.set(m[1], cap);
      } else if (o === "(?=") kind = "la";
      else if (o === "(?!") kind = "nla";
      else if (o === "(?<=") kind = "lb";
      else if (o === "(?<!") kind = "nlb";
      const body = alt();
      if (src[i] !== ")") fail();
      i++;
      return { t: "group", kind, open: o, body, cap };
    }
    if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      for (; j < src.length && src[j] !== "]"; j++) if (src[j] === "\\") j++;
      if (j >= src.length) fail();
      return plain(j + 1 - i, 1);
    }
    if (c === "\\") {
      const d = src[i + 1];
      if (d === "k") {
        KREF.lastIndex = i;
        const m = KREF.exec(src);
        if (m === null || !byName.has(m[1])) fail();
        i += m![0].length;
        return { t: "ref", src: m![0], cap: byName.get(m![1])!, name: m![1] };
      }
      if (d !== undefined && d >= "1" && d <= "9") {
        const m = /\\(\d+)/y;
        m.lastIndex = i;
        const r = m.exec(src)!;
        i += r[0].length;
        const cap = Number(r[1]);
        if (cap >= names.length) fail();
        return { t: "ref", src: r[0], cap, name: null };
      }
      if (d === "p" || d === "P") return plain(upTo("}"), 1);
      if (d === "u") return plain(src[i + 2] === "{" ? upTo("}") : 6, 1);
      if (d === "x") return plain(4, 1);
      if (d === "c") return plain(3, 1);
      if (d === "b" || d === "B") return plain(2, 0, { back: 1 });
      if (d === undefined) fail();
      return plain(src.codePointAt(i + 1)! > 0xffff ? 3 : 2, 1);
    }
    if (c === "^") return plain(1, 0, { caret: true });
    if (c === "$") return plain(1, 0);
    if (c === "*" || c === "+" || c === "?" || c === "{" || c === "}" || c === "]") fail();
    return plain(src.codePointAt(i)! > 0xffff ? 2 : 1, 1);
  };
  try {
    const root = alt();
    if (i !== src.length) fail();
    return { root, names };
  } catch (e) {
    if (e === PARSE) return null;
    throw e;
  }
}

// The widths (CPython's getwidth: look-arounds are 0 wide, a reference
// as wide as its group), and look-behinds fixed-width, as _compiler wants.
function widths(root: Node, capW: W[], badBehind: () => never): void {
  const go = (n: Node): W => {
    let w: W;
    switch (n.t) {
      case "atom":
        w = [n.width, n.width];
        break;
      case "ref":
        w = capW[n.cap] ?? [0, Infinity];
        break;
      case "seq":
        w = [0, 0];
        for (const x of n.items) {
          const v = go(x);
          w = [w[0] + v[0], w[1] + v[1]];
        }
        break;
      case "alt": {
        const vs = n.alts.map(go);
        w = [Math.min(...vs.map((v) => v[0])), Math.max(...vs.map((v) => v[1]))];
        break;
      }
      case "group": {
        const v = go(n.body);
        if (n.kind === "cap") capW[n.cap] = v;
        if ((n.kind === "lb" || n.kind === "nlb") && v[0] !== v[1]) badBehind();
        w = n.kind === "cap" || n.kind === "nc" ? v : [0, 0];
        break;
      }
      case "quant": {
        const v = go(n.body);
        w = [v[0] * n.min, n.max === Infinity ? (v[1] > 0 ? Infinity : 0) : v[1] * n.max];
        break;
      }
    }
    n.w = w;
    return w;
  };
  go(root);
}

// How a node's ways of matching are ordered, as sre tries them: how many
// are empty (cnt), and whether an empty one is never followed by one that
// matches text (el)
function order(n: Node): void {
  const c2 = (k: number) => Math.min(k, 2);
  switch (n.t) {
    case "atom":
    case "ref":
      // (one way of matching: empty if it can be)
      n.cnt = n.w![0] === 0 ? 1 : 0;
      n.el = true;
      return;
    case "group":
      order(n.body);
      if (n.kind === "cap" || n.kind === "nc") {
        n.cnt = n.body.cnt;
        n.el = n.body.el;
      } else {
        n.cnt = 1;
        n.el = true;
      }
      return;
    case "seq":
      n.items.forEach(order);
      seqOrder(n, n.items);
      return;
    case "alt": {
      n.alts.forEach(order);
      n.cnt = c2(n.alts.reduce((k, a) => k + a.cnt!, 0));
      const f = n.alts.findIndex((a) => a.cnt! > 0);
      n.el = f < 0 || (n.alts[f].el! && n.alts.slice(f + 1).every((a) => a.w![1] === 0));
      return;
    }
    case "quant": {
      const x = n.body;
      order(x);
      if (n.max === 0) {
        n.cnt = 1;
        n.el = true;
      } else if (x.w![0] > 0) {
        // (an item that is never empty: only no iteration at all is empty;
        // a greedy repeat tries it last, a lazy one first)
        n.cnt = n.min > 0 ? 0 : 1;
        n.el = n.min > 0 || !n.lazy;
      } else if (x.w![1] === 0) {
        n.cnt = 2;
        n.el = true;
      } else if (n.lazy) {
        n.cnt = 2;
        n.el = false;
      } else {
        // (m iterations, then sre's loop: X's ways in its order, then none)
        const loop: Base = { w: [0, Infinity], cnt: 2, el: x.el };
        seqOrder(n, [...Array(n.min).fill(x), loop]);
      }
      return;
    }
  }
}
// A sequence's ways: every way of each item, the first item's first; an
// empty one is all items empty; after the first empty one, a later one
// differs first in an item with two empty ways, and items after that one
// may then match text unless they are always empty
function seqOrder(n: Base, items: Base[]): void {
  if (items.some((x) => x.cnt === 0)) {
    n.cnt = 0;
    n.el = true;
    return;
  }
  n.cnt = Math.min(2, items.reduce((k, x) => k * x.cnt!, 1));
  n.el = items.every((x, j) => x.el && (x.cnt! < 2 || items.slice(j + 1).every((y) => y.w![1] === 0)));
}

// The groups a node can set (not those in a negative look-around)
function caps(n: Node, out: number[] = []): number[] {
  switch (n.t) {
    case "seq":
      n.items.forEach((x) => caps(x, out));
      break;
    case "alt":
      n.alts.forEach((x) => caps(x, out));
      break;
    case "group":
      if (n.kind === "nla" || n.kind === "nlb") break;
      if (n.kind === "cap") out.push(n.cap);
      caps(n.body, out);
      break;
    case "quant":
      if (n.max > 0) caps(n.body, out);
      break;
  }
  return out;
}
function allCaps(n: Node, out: number[] = []): number[] {
  if (n.t === "seq") n.items.forEach((x) => allCaps(x, out));
  else if (n.t === "alt") n.alts.forEach((x) => allCaps(x, out));
  else if (n.t === "group") {
    if (n.cap) out.push(n.cap);
    allCaps(n.body, out);
  } else if (n.t === "quant") allCaps(n.body, out);
  return out;
}

// The groups that have matched, whichever way a node matched, after it
// (from those before it, D); with check, references are checked there
function defined(n: Node, D: Set<number>, check: ((r: Node & { t: "ref" }, D: Set<number>) => void) | null): Set<number> {
  switch (n.t) {
    case "atom":
      return D;
    case "ref":
      check?.(n, D);
      return D;
    case "seq":
      for (const x of n.items) D = defined(x, D, check);
      return D;
    case "alt": {
      const ds = n.alts.map((a) => defined(a, D, check));
      return new Set([...ds[0]].filter((g) => ds.every((d) => d.has(g))));
    }
    case "group": {
      const d = defined(n.body, D, check);
      if (n.kind === "nla" || n.kind === "nlb") return D;
      if (n.kind !== "cap") return d;
      return new Set([...d, n.cap]);
    }
    case "quant": {
      const d = defined(n.body, D, check);
      return n.min > 0 && n.max > 0 ? d : D;
    }
  }
}

// (null: a source this module cannot read, which only a pattern JS refuses
// should be)
export function shape(src: string, refuse: (msg: string) => never, patternError: (msg: string) => never): Shape | null {
  const parsed = parse(src);
  if (parsed === null) return null;
  const { root, names } = parsed;
  const groups = names.length - 1;
  const capW: W[] = [];
  widths(root, capW, () => patternError("look-behind requires fixed-width pattern"));
  order(root);
  // Each repeat: rewritten, refused or left (see the top of this file)
  const copied = new Set<number>();
  let rewrites = false;
  // (inside a look-behind JS matches from right to left, so there a repeat
  // is refused rather than rewritten)
  const visit = (n: Node, behind: boolean): void => {
    if (n.t === "seq") n.items.forEach((x) => visit(x, behind));
    else if (n.t === "alt") n.alts.forEach((x) => visit(x, behind));
    else if (n.t === "group") visit(n.body, behind || n.kind === "lb" || n.kind === "nlb");
    else if (n.t === "quant") {
      visit(n.body, behind);
      const x = n.body;
      if (n.max > 1) {
        // (A26: every group of a repeated item matches in each iteration)
        const must = defined(x, new Set(), null);
        const g = caps(x).find((k) => !must.has(k));
        if (g !== undefined)
          refuse(`group ${g} may not match in every repetition of the repeated part of the pattern around it, and Sagebrush cannot keep its earlier match as CPython does: such a group is not supported yet`);
      }
      if (n.lazy || n.max <= n.min || x.w![0] > 0) return;
      const hasCaps = caps(x).length > 0;
      if (behind && (hasCaps || !x.el)) refuse("inside a look-behind, repeating a part of the pattern that can match the empty string is not supported yet");
      if (n.max === n.min + 1) {
        if (hasCaps || !x.el) {
          n.rw = "opt";
          rewrites = true;
          if (n.min > 0) allCaps(x).forEach((g) => copied.add(g));
        }
      } else if (!x.el)
        refuse("repeating a part of the pattern that can match the empty string before it tries to match text (such as (?:|a)* or (a*?)*) is not supported yet");
      else if (hasCaps) {
        if (n.max !== Infinity)
          refuse("a group inside a part of the pattern that can match the empty string and repeats a bounded number of times ({m,n} with n > m + 1) is not supported yet");
        n.rw = "tail";
        rewrites = true;
        allCaps(x).forEach((g) => copied.add(g));
      }
    }
  };
  visit(root, false);
  // (A23: a reference only to a group that has matched wherever it is)
  defined(root, new Set(), (r, D) => {
    if (copied.has(r.cap)) refuse(`a reference to group ${r.cap}, which is inside a repeated part of the pattern that can match the empty string, is not supported yet`);
    if (!D.has(r.cap)) refuse(`a reference to group ${r.cap}, which may not have matched at that point, is not supported yet (CPython's match fails there, JavaScript's matches the empty string)`);
  });
  // What a match that must not be empty needs (A22)
  let back = 0, caret = false;
  const look = (n: Node): number => {
    switch (n.t) {
      case "atom":
        if (n.caret) caret = true;
        return n.back;
      case "ref":
        return 0;
      case "seq":
        return Math.max(0, ...n.items.map(look));
      case "alt":
        return Math.max(0, ...n.alts.map(look));
      case "group":
        return n.kind === "lb" || n.kind === "nlb" ? n.body.w![1] + look(n.body) : look(n.body);
      case "quant":
        return look(n.body);
    }
  };
  back = look(root);
  const emitted = (caretFail: boolean) => emit(root, names, caretFail);
  const main = emitted(false);
  if (main.src.length > 16 * src.length + 4096) refuse("the pattern nests too many repeats of parts that can match the empty string");
  return {
    src: main.src,
    groups,
    names,
    jsToPy: rewrites ? main.jsToPy : null,
    closeSeq: main.closeSeq,
    canConsume: root.w![1] > 0,
    back,
    caret,
    variant: () => emitted(true).src,
  };
}

// The JS source of a tree: repeats rewritten, quantified look-arounds in
// (?:...) (JS's u mode repeats no assertion), and with caretFail ^ as
// (?!) (for a match on a slice of the subject, where ^ is never at its
// start); each JS group's Python group, and the order of the ")"s
function emit(root: Node, names: string[], caretFail: boolean): { src: string; jsToPy: number[]; closeSeq: number[] } {
  const jsToPy: number[] = [0];
  const closeSeq: number[] = [0];
  const pyToJs: number[] = [];
  let closes = 0;
  const go = (n: Node, copy: boolean): string => {
    switch (n.t) {
      case "atom":
        return n.caret && caretFail ? "(?!)" : n.src;
      case "ref":
        return n.name !== null ? n.src : `\\${pyToJs[n.cap]}`;
      case "seq":
        return n.items.map((x) => go(x, copy)).join("");
      case "alt":
        return n.alts.map((x) => go(x, copy)).join("|");
      case "group": {
        if (n.kind !== "cap") return n.open + go(n.body, copy) + ")";
        const j = jsToPy.length;
        jsToPy.push(n.cap);
        closeSeq.push(0);
        if (!copy) pyToJs[n.cap] = j;
        const open = copy ? "(" : n.open;
        const s = open + go(n.body, copy) + ")";
        closeSeq[j] = ++closes;
        return s;
      }
      case "quant": {
        const x = n.body;
        const b = go(x, copy);
        const wrap = x.t === "group" && x.kind !== "cap" && x.kind !== "nc" ? `(?:${b})` : b;
        if (n.rw === undefined) return wrap + n.q;
        if (n.rw === "opt" && n.min === 0) return `(?:${b}|)`;
        const head = n.rw === "opt" ? `(?:${b}){${n.min}}` : `(?:${b})${n.q}`;
        return head + `(?:${go(x, true)}|)`;
      }
    }
  };
  void names;
  const src = go(root, false);
  return { src, jsToPy, closeSeq };
}

// A JS match as Python's groups: each Python group the last of its JS
// groups that matched (a copy matches after its original)
export function normalize(sh: Shape, m: RegExpExecArray): RegExpExecArray {
  const map = sh.jsToPy;
  if (map === null) return m;
  const ix = (m as any).indices as ([number, number] | undefined)[];
  const out: any = new Array(sh.groups + 1).fill(undefined);
  const oix: any[] = new Array(sh.groups + 1).fill(undefined);
  out[0] = m[0];
  oix[0] = ix[0];
  for (let j = 1; j < map.length; j++) {
    if (ix[j] === undefined) continue;
    out[map[j]] = m[j];
    oix[map[j]] = ix[j];
  }
  out.index = m.index;
  out.input = m.input;
  out.indices = oix;
  return out as RegExpExecArray;
}

// sre's lastindex: of the groups that matched, the one whose ")" is last
export function lastIndex(sh: Shape, m: RegExpExecArray): number | null {
  const ix = (m as any).indices as ([number, number] | undefined)[];
  let best = 0, seq = 0;
  for (let j = 1; j < ix.length; j++) {
    if (ix[j] !== undefined && sh.closeSeq[j] > seq) {
      seq = sh.closeSeq[j];
      best = j;
    }
  }
  if (best === 0) return null;
  return sh.jsToPy === null ? best : sh.jsToPy[best];
}
