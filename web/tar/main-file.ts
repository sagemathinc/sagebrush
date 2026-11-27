// Which file of an arXiv source is the paper (design/arxiv-proxy.md §4, as arXiv's AutoTeX decides):
//   1. 00README.json: the first source with "usage": "toplevel";
//   2. else 00README.XXX: the first `<file> toplevelfile` line;
//   3. else every .tex file with \documentclass or \documentstyle outside comments: if one, that one; if several, those
//      no other file \input's or \include's, then the first by name.
// A name from a 00README is only a hint: it must equal (after the same normalization) a .tex file that was kept, or
// step 3 decides. A hint file over HINT_MAX bytes is ignored unread, and 00README.json is parsed with a bounded
// parser (at most JSON_DEPTH deep, JSON_VALUES values); anything over is ignored. TeX files are scanned as bytes
// (the commands are ASCII), never decoded to strings.

export const HINT_MAX = 64 * 1024, JSON_DEPTH = 8, JSON_VALUES = 1000;
// (a JSON number or literal at a position: sticky, so a long number is read whole, never from a copy)
const LITERAL = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
/** The most \input and \include arguments texInputs returns, and the most bytes of one argument. */
const INPUTS_MAX = 1000, ARG_MAX = 256;

const BS = 0x5c, PCT = 0x25, NL = 0x0a, CR = 0x0d;
const isLetter = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const enc = new TextEncoder();
const CLASS = enc.encode("documentclass"), STYLE = enc.encode("documentstyle"), INPUT = enc.encode("input"), INCLUDE = enc.encode("include");

const at = (b: Uint8Array, i: number, word: Uint8Array) => {
  if (i + word.length > b.length) return false;
  for (let k = 0; k < word.length; k++) if (b[i + k] !== word[k]) return false;
  return !isLetter(b[i + word.length] ?? 0x20);
};

/** Calls `fn` at each backslash outside comments (a % not escaped by an odd run of backslashes starts one). */
function scan(b: Uint8Array, fn: (i: number) => boolean | void): void {
  let comment = false, run = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (comment) {
      if (c === NL || c === CR) comment = false;
      continue;
    }
    if (c === PCT && run % 2 === 0) comment = true;
    else if (c === BS && run % 2 === 0 && fn(i)) return;
    run = c === BS ? run + 1 : 0;
  }
}

/** Whether TeX source holds \documentclass or \documentstyle outside comments. */
export function hasDocumentClass(b: Uint8Array): boolean {
  let found = false;
  scan(b, (i) => (found = at(b, i + 1, CLASS) || at(b, i + 1, STYLE)));
  return found;
}

/** Whether bytes are TeX text: no NUL or other binary control bytes (tab, newlines, form feed and escape allowed),
 * UTF-8 or Latin-1 alike, with \documentclass or \documentstyle outside comments. */
export function isTexText(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x1b) return false;
  }
  return hasDocumentClass(b);
}

/** The arguments of \input and \include outside comments (\input{x}, \input x), at most INPUTS_MAX, each at most
 * ARG_MAX bytes, decoded. */
export function texInputs(b: Uint8Array): string[] {
  const out: string[] = [];
  eachInput(b, (arg) => {
    out.push(arg);
    return out.length >= INPUTS_MAX;
  });
  return out;
}

/** Calls `fn` with each \input or \include argument (each at most ARG_MAX bytes) until it returns true; nothing is
 * kept here, so every argument of the file is seen. */
function eachInput(b: Uint8Array, fn: (arg: string) => boolean | void): void {
  const dec = new TextDecoder();
  scan(b, (i) => {
    const w = at(b, i + 1, INPUT) ? INPUT : at(b, i + 1, INCLUDE) ? INCLUDE : null;
    if (!w) return;
    let j = i + 1 + w.length;
    // (spaces and tabs, and one line end, as TeX reads them: two would be a paragraph)
    while (j < b.length && (b[j] === 0x20 || b[j] === 0x09)) j++;
    if (b[j] === CR && b[j + 1] === NL) j += 2;
    else if (b[j] === NL || b[j] === CR) j++;
    while (j < b.length && (b[j] === 0x20 || b[j] === 0x09)) j++;
    let end: number;
    if (b[j] === 0x7b) {
      j++;
      end = j;
      while (end < b.length && end - j <= ARG_MAX && b[end] !== 0x7d && b[end] !== NL) end++;
      if (b[end] !== 0x7d) return;
    } else {
      end = j;
      while (end < b.length && end - j <= ARG_MAX && b[end] > 0x20 && b[end] !== 0x7d && b[end] !== PCT && b[end] !== BS) end++;
    }
    if (end === j || end - j > ARG_MAX) return;
    return !!fn(dec.decode(b.subarray(j, end)).trim());
  });
}

/** A JSON value, or undefined if the text isn't JSON or goes past `maxDepth` levels or `maxValues` values. Objects
 * have no prototype, so a key like "__proto__" is only a key. */
export function parseBoundedJson(text: string, maxDepth = JSON_DEPTH, maxValues = JSON_VALUES): unknown {
  let i = 0, values = 0;
  const fail = () => {
    throw new SyntaxError("not JSON within its bounds");
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const str = (): string => {
    if (text[i] !== '"') fail();
    i++;
    let s = "";
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i++];
      if (c === '"') return s;
      if (c < " ") fail();
      if (c !== "\\") {
        s += c;
        continue;
      }
      const e = text[i++];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (e in simple) s += simple[e];
      else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) {
        s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
        i += 4;
      } else fail();
    }
  };
  const value = (depth: number): unknown => {
    if (++values > maxValues) fail();
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth + 1 > maxDepth) fail();
      i++;
      ws();
      if (c === "[") {
        const a: unknown[] = [];
        if (text[i] === "]") return i++, a;
        for (;;) {
          a.push(value(depth + 1));
          ws();
          if (text[i] === ",") i++;
          else if (text[i] === "]") return i++, a;
          else fail();
        }
      }
      const o: Record<string, unknown> = Object.create(null);
      if (text[i] === "}") return i++, o;
      for (;;) {
        ws();
        const k = str();
        ws();
        if (text[i++] !== ":") fail();
        o[k] = value(depth + 1);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return i++, o;
        else fail();
      }
    }
    if (c === '"') return str();
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(text);
    if (!m) fail();
    i += m![0].length;
    return JSON.parse(m![0]);
  };
  try {
    const v = value(0);
    ws();
    return i === text.length ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A path as the reader keeps it: NFC, without a leading "./". */
const norm = (p: string) => {
  let s = p.normalize("NFC");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
};

export type Main = { main: string | null; via: "00README.json" | "00README.XXX" | "tex" | null; others: string[] };

/** The main file among the kept files (paths as the tar reader returns them), and the other TeX candidates. */
export function mainFileOf(files: { path: string; bytes: Uint8Array }[]): Main {
  const tex = new Map(files.filter((f) => f.path.toLowerCase().endsWith(".tex")).map((f) => [f.path, f.bytes]));
  const byName = new Map(files.map((f) => [f.path, f.bytes]));
  const hint = (name: unknown) => (typeof name === "string" && tex.has(norm(name)) ? norm(name) : null);
  const small = (p: string) => {
    const b = byName.get(p);
    return b && b.length <= HINT_MAX ? new TextDecoder().decode(b) : null;
  };
  const candidates = [...tex].filter(([, b]) => hasDocumentClass(b)).map(([p]) => p).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const others = (main: string) => candidates.filter((p) => p !== main);

  const json = small("00README.json");
  if (json !== null) {
    const v = parseBoundedJson(json) as any;
    const sources = v && typeof v === "object" && Array.isArray(v.sources) ? v.sources : [];
    const top = sources.find((s: any) => s && typeof s === "object" && s.usage === "toplevel");
    const main = hint(top?.filename);
    if (main) return { main, via: "00README.json", others: others(main) };
  }
  const xxx = small("00README.XXX");
  if (xxx !== null) {
    for (const line of xxx.split(/\r\n|\r|\n/)) {
      const [name, directive] = line.trim().split(/\s+/);
      if (directive === "toplevelfile") {
        const main = hint(name);
        if (main) return { main, via: "00README.XXX", others: others(main) };
        break;
      }
    }
  }
  if (candidates.length <= 1) return { main: candidates[0] ?? null, via: candidates.length ? "tex" : null, others: [] };
  // (only hits on the candidates are kept, never every argument: at most one entry per candidate)
  const cands = new Set(candidates);
  const included = new Set<string>();
  for (const [p, b] of tex) {
    eachInput(b, (arg) => {
      // (as TeX finds it: a name with .tex is that file; one without is name.tex if that exists, else the name itself)
      const a = norm(arg);
      const c = a.toLowerCase().endsWith(".tex") || !tex.has(a + ".tex") ? a : a + ".tex";
      if (c !== p && cands.has(c)) included.add(c);
      return included.size === cands.size;
    });
  }
  const main = candidates.find((p) => !included.has(p)) ?? candidates[0];
  return { main, via: "tex", others: others(main) };
}
