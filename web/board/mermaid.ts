// Mermaid flowcharts as boards: fromMermaid(text) parses a flowchart
// (`graph` or `flowchart`, any direction) into a board document (doc.ts),
// which the board then lays out and routes itself, so labels do not overlap
// and edges go around boxes.  What carries over:
// - nodes, with their labels and shapes (rectangles, rounded, stadiums,
//   circles, diamonds, hexagons, cylinders, subroutines, parallelograms,
//   trapezoids, flags; also the `A@{ shape: ..., label: ... }` syntax);
// - edges, chained (`a --> b --> c`) and fanned (`a & b --> c`), with labels
//   (`-->|yes|` and `-- yes -->`), arrowheads at none, one or both ends,
//   dotted and thick lines, and `~~~` (invisible: only placing);
// - subgraphs (nested) as groups, with titles and `direction`;
// - colors from `classDef` + `class`/`:::`, and `style`;
// - `click id href "url"` (or `click id "url"`) as the note's link;
// - a title from the front matter (`---\ntitle: ...\n---`).
// Markdown strings ("`**bold**`") stay Markdown, `<br>` breaks a line, and
// math ($$...$$) is typeset as everywhere on a board.  The grammar followed is
// Mermaid's flow.jison (MIT); mermaidBlocks() finds the diagrams in Markdown.

import { fromCocalcBoard, isCocalcBoard, leftOut } from "./cocalc";
import { canvasLeftOut, fromCanvas, isCanvas } from "./canvas";
import { boardFromHtml, isHtml } from "./fromhtml";
import { pageCount, pageView, type BoardDoc, type DocEdge, type DocGroup, type DocNode, type DocNote, type NoteShape } from "./doc";

/** Whether a text looks like a Mermaid flowchart. */
export function isMermaid(text: string): boolean {
  return /^(graph|flowchart)(-elk)?\b/m.test(stripPreamble(text).trimStart().split("\n")[0] ?? "");
}

/** The flowcharts in ```mermaid fences of a Markdown text, each with the heading above it. */
export function mermaidBlocks(md: string): { text: string; heading?: string }[] {
  const out: { text: string; heading?: string }[] = [];
  for (const m of md.matchAll(/^([ \t]*)(```+|~~~+)[ \t]*mermaid[ \t]*\n([\s\S]*?)\n\1\2[ \t]*$/gm)) {
    if (!isMermaid(m[3])) continue;
    const heading = [...md.slice(0, m.index).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].pop()?.[1];
    out.push({ text: m[3], ...(heading ? { heading } : {}) });
  }
  return out;
}

/** A text as a board: JSON, a Mermaid flowchart, or Markdown with flowcharts (a page each); `name` (a file's) titles it. */
export function boardFromText(text: string, name?: string, note?: (md: string) => void): BoardDoc {
  const t = text.trimStart();
  const titled = (d: BoardDoc) => { if (!d.title && name) d.title = name.replace(/\.[^.]*$/, ""); return d; };
  // (a board downloaded as HTML: the JSON it holds, never the page itself, fromhtml.ts)
  if (isHtml(t)) return boardFromHtml(t) as BoardDoc;
  // (a CoCalc whiteboard or slides file: JSON lines of its elements, cocalc.ts)
  if (isCocalcBoard(t)) {
    const c = fromCocalcBoard(t, { slides: /\.slides$/i.test(name ?? "") }), l = leftOut(c.left);
    note?.(`Converted from a CoCalc ${/\.slides$/i.test(name ?? "") ? "slides" : "whiteboard"} file.` + (l ? ` Left out, as a board has nothing like them yet: ${l}.` : ""));
    return titled(c.doc);
  }
  // (a JSON Canvas: Obsidian's .canvas, canvas.ts)
  if (isCanvas(t)) {
    const c = fromCanvas(t), l = canvasLeftOut(c.left);
    note?.("Converted from a JSON Canvas file." + (l ? ` Left out, as a board has nothing like them: ${l}.` : ""));
    return titled(c.doc);
  }
  if (t.startsWith("{")) return JSON.parse(t) as BoardDoc;
  if (isMermaid(t)) return titled(fromMermaid(t));
  const blocks = mermaidBlocks(text);
  if (!blocks.length) throw new Error("not a board: neither JSON nor a Mermaid flowchart (graph or flowchart), nor Markdown with one");
  if (blocks.length === 1) { const d = fromMermaid(blocks[0].text); d.title ??= blocks[0].heading; return titled(d); }
  const title = /^#\s+(.+)$/m.exec(text)?.[1];
  return titled({ ...(title ? { title } : {}), pages: blocks.map((b, i) => {
    const d = fromMermaid(b.text);
    return { title: d.title ?? b.heading ?? `Diagram ${i + 1}`, layout: d.layout, direction: d.direction, nodes: d.nodes ?? [], edges: d.edges };
  }) });
}

// the front matter (its title), %%{init}%% directives and %% comments
function stripPreamble(text: string): string {
  return text.replace(/^﻿/, "").replace(/^\s*---\s*\n[\s\S]*?\n\s*---\s*\n/, "").replace(/%%\{[\s\S]*?\}%%/g, "").split("\n").filter((l) => !/^\s*%%/.test(l)).join("\n");
}

const SHAPES: [string, string, NoteShape][] = [
  // (longest openings first)
  ["(((", ")))", "circle"],
  ["((", "))", "circle"],
  ["([", "])", "stadium"],
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["{{", "}}", "hexagon"],
  ["(-", "-)", "round"],
  ["[/", "/]", "lean-right"],
  ["[\\", "\\]", "lean-left"],
  ["(", ")", "round"],
  ["[", "]", "rect"],
  ["{", "}", "diamond"],
  [">", "]", "flag"],
];

// the new syntax's shape names (A@{ shape: ... })
const NAMED: Record<string, NoteShape> = {
  rect: "rect", rectangle: "rect", proc: "rect", process: "rect", square: "rect",
  rounded: "round", event: "round", round: "round",
  stadium: "stadium", pill: "stadium", terminal: "stadium",
  circle: "circle", circ: "circle", "dbl-circ": "circle", "double-circle": "circle", "sm-circ": "circle", "small-circle": "circle", start: "circle", stop: "circle", "fr-circ": "circle",
  diam: "diamond", diamond: "diamond", decision: "diamond", question: "diamond",
  hex: "hexagon", hexagon: "hexagon", prepare: "hexagon",
  cyl: "cylinder", cylinder: "cylinder", database: "cylinder", db: "cylinder", "h-cyl": "cylinder", das: "cylinder", "lin-cyl": "cylinder", "disk": "cylinder",
  subproc: "subroutine", subprocess: "subroutine", subroutine: "subroutine", "fr-rect": "subroutine", framed: "subroutine",
  "lean-r": "lean-right", "lean-right": "lean-right", "in-out": "lean-right",
  "lean-l": "lean-left", "lean-left": "lean-left", "out-in": "lean-left",
  "trap-b": "trapezoid", trapezoid: "trapezoid", priority: "trapezoid", "trapezoid-bottom": "trapezoid",
  "trap-t": "inv-trapezoid", "inv-trapezoid": "inv-trapezoid", manual: "inv-trapezoid", "trapezoid-top": "inv-trapezoid",
  "odd": "flag", flag: "flag", "paper-tape": "flag",
};

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " ", apos: "'", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", hearts: "♥", infin: "∞", deg: "°", times: "×", divide: "÷", plusmn: "±", ne: "≠", le: "≤", ge: "≥", alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", sigma: "σ", lambda: "λ", mu: "μ" };

// Mermaid's entity codes (#35; #quot;) and HTML entities as characters, in
// one pass (what one decodes is not decoded again: #35;quot; is "#quot;")
const entities = (s: string) => s.replace(/&#x([0-9a-f]+);|&?#(\d+);|[#&]([a-z]+);/gi, (m, hex, n, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : n ? String.fromCodePoint(Number(n)) : ENTITIES[name.toLowerCase()] ?? m);

// A node's label as Markdown: <br> (and \n) breaks a line, <b>/<i>/<code>
// become Markdown, other tags and Font Awesome icons are dropped; a plain
// label's *, _ and line-starting list or heading marks are text.
function label(raw: string, markdown = false): string {
  // (a Markdown string: its entity codes too, as Mermaid reads them)
  if (markdown) return entities(raw.replace(/\\n/g, "\n")).trim();
  // (math, $$...$$ or $...$, is left as it is)
  const s = entities(raw).split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/).map((part, i) => i % 2 ? part : part
    .replace(/\\n|<br\s*\/?>/gi, "\n").replace(/\bfa[bsrl]?:fa-[\w-]+\s*/g, "")
    .replace(/([*_`\\])/g, "\\$1")
    .replace(/<\/?(b|strong)>/gi, "**").replace(/<\/?(i|em)>/gi, "*").replace(/<\/?code>/gi, "`")
    // (an image, as Markdown's; other HTML tags dropped, their text kept; <word> that is not HTML stays)
    .replace(/<img\b[^>]*?\bsrc\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>/gi, " ![]($1) ")
    .replace(new RegExp(`</?(${HTML_TAGS})\\b[^>]*>`, "gi"), "")).join("");
  return s.split("\n").map((l) => l.trim().replace(/^(\d+)\.(\s)/, "$1\\.$2").replace(/^([-+>#])/, "\\$1")).join("  \n").trim();
}

const HTML_TAGS = "a|abbr|b|big|blockquote|br|center|cite|code|del|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|samp|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|tt|u|ul|var";

// An edge's label: one line of plain text (drawn on the canvas)
// (tags dropped before entity codes are read: a coded <b> is text)
const plain = (raw: string) => entities(raw.replace(/\\n|<br\s*\/?>/gi, " ").replace(/<\/?[a-z][^>]*>/gi, "").replace(/^\s*"`?|`?"\s*$/g, "")).replace(/\s+/g, " ").trim();

// a CSS color from Mermaid styles ("fill:#f9f,stroke:#333"): the fill,
// made light enough for dark text when it is dark
function fillOf(styles: string): string | undefined {
  const m = /(?:^|[,;\s])fill\s*:\s*([^,;]+)/.exec(styles);
  if (!m) return;
  const c = m[1].trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (!hex) return /^[a-z]+$/i.test(c) || /^(rgb|hsl)a?\(/.test(c) ? c : undefined;
  let h = hex[1];
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.55) {
    // (mixed with white until light)
    const t = Math.min(0.85, (0.8 - lum) / (1 - lum));
    [r, g, b] = [r, g, b].map((v) => Math.round(v + (255 - v) * t));
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  return "#" + h;
}

interface Vertex { id: string; text?: string; md?: boolean; shape?: NoteShape; classes: string[]; style?: string; ref?: string; group?: string }
interface Sub { id: string; title?: string; md?: boolean; direction?: string; members: string[]; parent?: Sub }

/** A Mermaid flowchart as a board document (throws on what it cannot read, saying where). */
export function fromMermaid(text: string): BoardDoc {
  const t0 = /^\s*---\s*\n[\s\S]*?^\s*title\s*:\s*(.+?)\s*$[\s\S]*?\n\s*---/m.exec(text.replace(/^﻿/, ""))?.[1]?.replace(/^["']|["']$/g, "");
  const title = t0 === undefined ? undefined : entities(t0);
  const src = stripPreamble(text);
  const verts = new Map<string, Vertex>();
  const subs = new Map<string, Sub>();
  const order: string[] = []; // vertices and subgraphs in the order they are first seen
  const edges: DocEdge[] = [];
  const edgeIds = new Set<string>(); // (e1@--> names an edge; e1@{...} then sets its data, not a node's)
  const classDefs = new Map<string, string>();
  let direction = "TB";
  const stack: Sub[] = [];
  let subCount = 0;

  const vertex = (id: string) => {
    let v = verts.get(id);
    if (!v) { v = { id, classes: [] }; verts.set(id, v); if (!subs.has(id)) order.push(id); }
    return v;
  };
  // (a subgraph claims the nodes mentioned in it; the first to close keeps them)
  const mention = (id: string) => { if (stack.length) stack[stack.length - 1].members.push(id); };

  // statements: lines, and ; outside quotes and brackets (a quoted label may span lines)
  const statements: { s: string; line: number }[] = [];
  {
    let depth = 0, q = false, cur = "", pipe = false, line = 1, first = 1;
    for (let i = 0; i <= src.length; i++) {
      const ch = src[i] ?? "\n";
      if (ch === "\n" && !q) {
        statements.push({ s: cur, line: first });
        cur = ""; depth = 0; pipe = false; first = ++line;
        continue;
      }
      if (ch === "\n") line++;
      if (ch === '"') q = !q;
      else if (!q && "[({".includes(ch)) depth++;
      else if (!q && "])}".includes(ch)) depth = Math.max(0, depth - 1);
      else if (!q && ch === "|" && depth === 0) pipe = !pipe;
      // (not the ; ending an entity code: #quot; or &gt;)
      if (ch === ";" && !q && depth === 0 && !pipe && !/[&#]\w+$/.test(cur)) { statements.push({ s: cur, line: first }); cur = ""; first = line; continue; }
      cur += ch;
    }
    // (a line that starts with a link continues the one before, and one
    // ending in a link continues on the next, as Mermaid's lexer reads them)
    const LINK_AT_START = /^\s*[xo<]?(--|==|-\.|~~~)/, LINK_AT_END = /(^|[\s\w\])}"])[xo<]?(-{2,}[->xo]?|={2,}[=>xo]?|-?\.+-[>xo]?|~{3,})\s*(\|[^|]*\|)?\s*$/;
    for (let k = statements.length - 1; k > 0; k--) {
      const prev = statements[k - 1], cur = statements[k];
      if (!cur.s.trim() || !prev.s.trim() || /^\s*---\s*$/.test(prev.s)) continue;
      if (LINK_AT_START.test(cur.s) || LINK_AT_END.test(prev.s)) { prev.s += " " + cur.s; statements.splice(k, 1); }
    }
  }

  let header = false;
  for (let si = 0; si < statements.length; si++) {
    const { s: raw, line } = statements[si];
    const s = raw.trim();
    if (!s) continue;
    const fail = (why: string): never => { throw new Error(`Mermaid, line ${line}: ${why}: ${s.slice(0, 80)}`); };
    if (!header) {
      const m = /^(graph|flowchart)(-elk)?(?:\s+(TB|TD|BT|LR|RL|[<>^v]))?\s*(.*)$/.exec(s);
      if (!m) fail("a flowchart starts with `graph` or `flowchart`");
      direction = ({ ">": "LR", "<": "RL", "^": "BT", v: "TB" } as Record<string, string>)[m![3]] ?? m![3] ?? "TB";
      header = true;
      if (m![4]) statements.splice(si + 1, 0, { s: m![4], line });
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^subgraph(?:\s+(.*))?$/.exec(s))) {
      const rest = (m[1] ?? "").trim();
      let id: string | undefined, t: string | undefined, md = false;
      let mm: RegExpExecArray | null;
      if ((mm = /^([^\s\[\]"]+)\s*\[\s*"`([\s\S]*)`"\s*\]$/.exec(rest))) { id = mm[1]; t = mm[2]; md = true; }
      else if ((mm = /^([^\s\[\]"]+)\s*\[\s*"([\s\S]*)"\s*\]$/.exec(rest)) || (mm = /^([^\s\[\]"]+)\s*\[([\s\S]*)\]$/.exec(rest))) { id = mm[1]; t = mm[2]; }
      else if ((mm = /^"`([\s\S]*)`"$/.exec(rest)) || (mm = /^"([\s\S]*)"$/.exec(rest))) {
        // (a quoted title without spaces is the id too)
        t = mm[1];
        md = rest.startsWith('"`');
        if (!/\s/.test(t)) id = t;
      }
      else if (rest && !/\s/.test(rest)) { id = rest; t = rest; }
      else t = rest || undefined;
      id ??= "subGraph" + subCount;
      subCount++;
      const sub: Sub = { id, title: t, md, members: [], parent: stack[stack.length - 1] };
      mention(id);
      stack.push(sub);
      continue;
    }
    if (/^end$/.test(s)) {
      const sub = stack.pop();
      if (!sub) fail("`end` without a subgraph");
      const old = subs.get(sub!.id);
      if (old) old.members.push(...sub!.members);
      else { subs.set(sub!.id, sub!); if (!order.includes(sub!.id)) order.push(sub!.id); }
      // (a node first used outside belongs here now; one in a subgraph that
      // closed earlier, an inner one say, stays there)
      for (const id of sub!.members) {
        const v = verts.get(id);
        if (v && !v.group && id !== sub!.id) v.group = sub!.id;
        // (and a subgraph defined earlier, at the top, mentioned here: inside this one)
        const g = subs.get(id);
        if (g && id !== sub!.id && !g.parent) g.parent = old ?? sub!;
      }
      continue;
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)\b/.exec(s))) {
      if (stack.length) stack[stack.length - 1].direction = m[1];
      else direction = m[1];
      continue;
    }
    if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(s))) { for (const c of m[1].split(",")) classDefs.set(c.trim(), m[2]); continue; }
    // (a class or style on an edge, by its id, is not a node's)
    if ((m = /^class\s+(\S+)\s+(\S+)\s*$/.exec(s))) { for (const id of m[1].split(",")) if (!edgeIds.has(id.trim())) vertex(id.trim()).classes.push(m[2]); continue; }
    if ((m = /^style\s+(\S+)\s+(.*)$/.exec(s))) { if (!edgeIds.has(m[1])) vertex(m[1]).style = m[2]; continue; }
    if (/^(linkStyle|accTitle|accDescr|title)\b/.test(s)) continue;
    if ((m = /^click\s+(\S+)\s+(.*)$/.exec(s))) {
      const url = /(?:^href\s+)?"([^"]+)"/.exec(m[2])?.[1];
      if (url && /^https?:\/\//i.test(url)) vertex(m[1]).ref = url;
      continue;
    }
    chain(s, fail);
  }
  if (!header) throw new Error("Mermaid: a flowchart starts with `graph` or `flowchart`");
  if (stack.length) throw new Error(`Mermaid: subgraph ${stack[stack.length - 1].id} has no \`end\``);

  // A statement: vertices joined by links, each side possibly a & list.
  function chain(s: string, fail: (why: string) => never) {
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const group = (): string[] => {
      const ids = [node()];
      for (;;) {
        const save = i;
        ws();
        if (s[i] === "&") { i++; ws(); ids.push(node()); }
        else { i = save; return ids; }
      }
    };
    // a vertex: its id, then its shape and label, data, and :::class
    const node = (): string => {
      ws();
      const start = i;
      while (i < s.length) {
        const ch = s[i], next = s[i + 1];
        if (/\s/.test(ch) || "[](){}|&;\"<>@".includes(ch)) break;
        if (ch === ":" && s.startsWith(":::", i)) break;
        if (ch === "-" && (next === "-" || next === ">" || next === ".")) break;
        if (ch === "=" && next === "=") break;
        if (ch === "~" && next === "~") break;
        i++;
      }
      // (an id may start with what looks like a link's end: `o` and `x` after --)
      const id = s.slice(start, i);
      if (!id) fail("expected a node");
      const edgeData = edgeIds.has(id) && s.startsWith("@{", i);
      const v = subs.has(id) || stack.some((x) => x.id === id) || edgeData ? null : vertex(id);
      if (!edgeData) mention(id);
      // the shape and its label
      for (const [open, close, shape] of SHAPES) {
        if (!s.startsWith(open, i) || !v) continue;
        // (`>` opens a flag only right after the id)
        let j = i + open.length, text: string, md = false;
        const q = /^\s*"(`?)/.exec(s.slice(j));
        if (q) {
          const end = s.indexOf(q[1] + '"', j + q[0].length);
          if (end < 0) fail("an unclosed string");
          text = s.slice(j + q[0].length, end);
          md = !!q[1];
          j = end + q[1].length + 1;
          while (s[j] === " ") j++;
          // (a parallelogram's or trapezoid's closing slant says which it is)
          if ((open === "[/" || open === "[\\") && s.startsWith(open === "[/" ? "\\]" : "/]", j)) {
            v.shape = open === "[/" ? "trapezoid" : "inv-trapezoid";
            v.text = label(text, md);
            i = j + 2;
            break;
          }
          if (!s.startsWith(close, j)) fail(`expected ${close}`);
          j += close.length;
        } else {
          // (a parallelogram's or trapezoid's closing slant says which it is)
          const ends = open === "[/" || open === "[\\" ? ["/]", "\\]"] : [close];
          let end = -1, which = close;
          for (const c of ends) { const k = s.indexOf(c, j); if (k >= 0 && (end < 0 || k < end)) { end = k; which = c; } }
          if (end < 0) fail(`expected ${close}`);
          text = s.slice(j, end);
          j = end + which.length;
          if (open === "[/" && which === "\\]") { v.shape = "trapezoid"; v.text = label(text); v.md = false; i = j; break; }
          if (open === "[\\" && which === "/]") { v.shape = "inv-trapezoid"; v.text = label(text); v.md = false; i = j; break; }
        }
        v.text = label(text, md);
        v.shape = shape;
        i = j;
        break;
      }
      // @{ shape: ..., label: "..." }
      if (s.startsWith("@{", i)) {
        const end = s.indexOf("}", i);
        if (end < 0) fail("an unclosed @{");
        const body = s.slice(i + 2, end);
        i = end + 1;
        if (v) {
          for (const kv of body.matchAll(/(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|[^,]+)/g)) {
            const val = kv[2].trim().replace(/^"([\s\S]*)"$|^'([\s\S]*)'$/, "$1$2");
            if (kv[1] === "shape") v.shape = NAMED[val] ?? "rect";
            else if (kv[1] === "label") v.text = label(val.replace(/\\n|\n\s*/g, "<br>"));
          }
        }
      }
      if (s.startsWith(":::", i)) {
        i += 3;
        const st = i;
        while (i < s.length && /[\w-]/.test(s[i])) i++;
        if (v) v.classes.push(s.slice(st, i));
      }
      return id;
    };
    // a link: its arrowheads, line, and label
    const link = (): { arrow?: "none" | "both"; line?: "dotted" | "thick"; hidden?: boolean; label?: string } | null => {
      ws();
      const rest = s.slice(i);
      const idm = /^[\w-]+@(?=[-=.<~xo])/.exec(rest);
      const r = idm ? rest.slice(idm[0].length) : rest;
      const skip = idm ? idm[0].length : 0;
      if (idm) edgeIds.add(idm[0].slice(0, -1));
      const kind = (startCh: string, body: string, endCh: string) => {
        const thick = body.includes("="), dotted = body.includes(".");
        const head = endCh === ">" || endCh === "x" || endCh === "o", tail = startCh === "<" || startCh === "x" || startCh === "o";
        return { arrow: head && tail ? "both" as const : head ? undefined : tail ? undefined : "none" as const, line: thick ? "thick" as const : dotted ? "dotted" as const : undefined, reverse: tail && !head };
      };
      let m: RegExpExecArray | null;
      if ((m = /^~{3,}/.exec(r))) { i += skip + m[0].length; return { hidden: true }; }
      // a whole link: --> --- ==> === -.-> -.- --x --o <--> (longer ones too)
      if ((m = /^([<xo]?)(-{2,}|={2,}|-?\.+-)([->=xo]?)(?![-=.])/.exec(r)) && (m[3] || /^-?\.+-$/.test(m[2]) || m[2].length >= 3)) {
        // (`--` alone, then text, opens a labeled link instead)
        const body = m[3] === "-" || m[3] === "=" ? m[2] + m[3] : m[2];
        const endCh = m[3] === "-" || m[3] === "=" ? "" : m[3];
        i += skip + m[0].length;
          const k = kind(m[1], body, endCh);
          ws();
          let lab: string | undefined;
          if (s[i] === "|") {
            const end = s.indexOf("|", i + 1);
            if (end < 0) fail("an unclosed |label|");
            lab = s.slice(i + 1, end).trim().replace(/^"(.*)"$/, "$1");
            i = end + 1;
          }
          return { ...k, label: lab };
      }
      // a labeled link: -- text -->, == text ==>, -. text .->
      if ((m = /^([<xo]?)(--|==|-\.)(?=[^->=.])/.exec(r))) {
        const open = m[2];
        const tail = open === "--" ? /([<xo]?)-{2,}([->xo])/ : open === "==" ? /([<xo]?)={2,}([=>xo])/ : /([<xo]?)-?\.+-([>xo]?)/;
        const from = skip + m[0].length;
        const after = s.slice(i + from);
        const t = tail.exec(after);
        if (!t) fail("a link's label without its end");
        const lab = after.slice(0, t!.index).trim().replace(/^"(.*)"$/, "$1");
        i += from + t!.index + t![0].length;
        const endCh = t![2] === "-" || t![2] === "=" ? "" : t![2];
        return { ...kind(m[1], open === "-." ? "." : open, endCh), label: lab };
      }
      return null;
    };

    let left = group();
    for (;;) {
      ws();
      if (i >= s.length) break;
      const l = link();
      if (!l) fail("expected a link (-->, ---, -.->, ==>, ~~~) or the end of the statement");
      const right = group();
      for (const a of left) for (const b of right) {
        const { reverse, ...rest } = l as any;
        const e: DocEdge = reverse ? { from: b, to: a } : { from: a, to: b };
        // (Mermaid's own id for it, L_a_b_0, can be given data with @{...})
        let k = 0;
        while (edgeIds.has(`L_${a}_${b}_${k}`)) k++;
        edgeIds.add(`L_${a}_${b}_${k}`);
        if (rest.label && plain(rest.label)) e.label = plain(rest.label);
        if (rest.hidden) e.hidden = true;
        if (rest.arrow) e.arrow = rest.arrow;
        if (rest.line) e.line = rest.line;
        edges.push(e);
      }
      left = right;
    }
  }

  // a subgraph mentioned in another, before or after it was defined, is
  // inside it (unless already inside one, or that would make a cycle)
  for (const sg of subs.values()) for (const id of sg.members) {
    const g = subs.get(id);
    if (!g || g === sg || g.parent) continue;
    let cyc = false;
    for (let p: Sub | undefined = sg; p; p = p.parent && subs.get(p.parent.id)) if (p === g) { cyc = true; break; }
    if (!cyc) g.parent = sg;
  }

  // the board: groups for subgraphs (nested), notes for vertices
  const dir = (d?: string): "TB" | "LR" | undefined => (d === "LR" || d === "RL" ? "LR" : d ? "TB" : undefined);
  const note = (v: Vertex): DocNote => {
    const styles = [...v.classes.map((c) => classDefs.get(c) ?? ""), ...(classDefs.has("default") ? [classDefs.get("default")!] : []), v.style ?? ""].join(",");
    // (a blank label shows the id, as Mermaid's do)
    const n: DocNote = { id: v.id, text: v.text?.replace(/\s|\\/g, "") ? v.text : label(v.id), shape: v.shape ?? "rect", fit: true };
    const color = fillOf(v.style ? v.style + "," + styles : styles);
    if (color) n.color = color;
    if (v.ref) n.ref = v.ref;
    return n;
  };
  const groupOf = new Map<string, string | undefined>(); // node or subgraph -> its subgraph
  for (const v of verts.values()) if (!subs.has(v.id)) groupOf.set(v.id, v.group);
  for (const g of subs.values()) groupOf.set(g.id, g.parent && subs.get(g.parent.id) ? g.parent.id : undefined);
  const build = (parent: string | undefined): DocNode[] => order.filter((id) => groupOf.get(id) === parent && (verts.has(id) || subs.has(id))).map((id) => {
    const g = subs.get(id);
    if (!g) return note(verts.get(id)!);
    const gv = verts.get(id);
    const node: DocGroup = { id, kind: "group", title: g.title !== undefined ? label(g.title, g.md) : undefined, layout: "graph", direction: dir(g.direction) ?? dir(direction), children: build(id) };
    const color = gv && fillOf([gv.style ?? "", ...gv.classes.map((c) => classDefs.get(c) ?? "")].join(","));
    if (color) node.color = color;
    return node;
  });
  const nodes = build(undefined);
  const doc: BoardDoc = { layout: "graph", direction: dir(direction), nodes, edges };
  if (title) doc.title = title;
  return doc;
}

// ---- a board as Mermaid ------------------------------------------------------
//
// toMermaid(doc) writes a page as a flowchart: groups as subgraphs (with
// their direction), notes as nodes with their shapes, colors and web links,
// edges with their labels, arrowheads and lines; fromMermaid reads it back
// as the same graph.  What a flowchart has nothing like (places, sizes, pen
// strokes, stickers, code, pictures, details, tours) is left out, and said.
// Every text is untrusted: labels are Markdown strings whose <, >, ", `, #,
// &, | and \ are Mermaid's entity codes, so no renderer (HTML labels or not)
// meets a tag or a quote, and ids that are not plain words are renamed.

const SHAPE_OF: Record<NoteShape, [string, string]> = {
  rect: ["[", "]"], round: ["(", ")"], stadium: ["([", "])"], circle: ["((", "))"], diamond: ["{", "}"], hexagon: ["{{", "}}"],
  cylinder: ["[(", ")]"], subroutine: ["[[", "]]"], "lean-right": ["[/", "/]"], "lean-left": ["[\\", "\\]"],
  trapezoid: ["[/", "\\]"], "inv-trapezoid": ["[\\", "/]"], flag: [">", "]"],
};
const CODES: Record<string, string> = { "#": "#35;", "&": "#38;", "<": "#60;", ">": "#62;", '"': "#34;", "`": "#96;", "|": "#124;", "\\": "#92;" };
/** A text as Mermaid's entity codes where it could end a string or be read as markup. */
const coded = (s: string) => s.replace(/[#&<>"`|\\]/g, (c) => CODES[c]);
// (Mermaid's words, and what its lexer could read as part of a link)
const RESERVED = /^(end|graph|flowchart|subgraph|style|class|classdef|click|linkstyle|direction|default|call|href|interpolate|accTitle|accDescr|title)$/i;

/** A page of a board (`page`, the first by default) as a Mermaid flowchart; `left`: what it has that a flowchart cannot say. */
export function toMermaid(doc: BoardDoc, page = 0): { text: string; left: string[] } {
  const v = pageView(doc, page), left = new Set<string>();
  if (pageCount(doc) > 1) left.add("other pages");
  const out: string[] = [];
  if (v.title) out.push("---", `title: "${coded(v.title.replace(/[\r\n]+/g, " "))}"`, "---");
  const axis = (layout?: DocGroup["layout"], direction?: "TB" | "LR") => {
    if (layout === "row") { left.add("layouts other than a graph's"); return "LR"; }
    if (layout === "column" || layout === "grid") { left.add("layouts other than a graph's"); return "TB"; }
    if (!layout) left.add("places");
    return direction ?? "TB";
  };
  out.push("flowchart " + axis(v.layout, v.direction));
  // ids: a plain word as it is; else (or taken) a new one
  const ids = new Map<string, string>(), taken = new Set<string>();
  const idOf = (id: string) => {
    let m = ids.get(id);
    if (m) return m;
    // (words, joined by single hyphens: as Mermaid's lexer and fromMermaid read an id)
    m = /^[A-Za-z_]\w*(?:-\w+)*$/.test(id) && !RESERVED.test(id) && !taken.has(id) ? id : "";
    for (let k = 1; !m; k++) if (!taken.has("n" + k) && !ids.has("n" + k)) m = "n" + k;
    ids.set(id, m);
    taken.add(m);
    return m;
  };
  const shown = new Set<string>(), styles: string[] = [];
  const color = (id: string, c?: string) => { if (c && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(c)) styles.push(`style ${id} fill:${c}`); };
  const md = (s: string) => '"`' + coded(s) + '`"';
  const walk = (ns: DocNode[], indent: string) => {
    for (const n of ns) {
      if (n.kind === "ink") { left.add("pen strokes"); continue; }
      if (n.kind === "sticker") { left.add("stickers"); continue; }
      if (n.x !== undefined || n.y !== undefined) left.add("places");
      const id = idOf(n.id);
      shown.add(n.id);
      if (n.kind === "group") {
        out.push(`${indent}subgraph ${id}[${md(n.title ?? " ")}]`);
        if (n.text) left.add("groups' text");
        const dir = axis(n.layout ?? "graph", n.direction);
        if (n.layout !== undefined || n.direction) out.push(`${indent}  direction ${dir}`);
        walk(n.children, indent + "  ");
        out.push(`${indent}end`);
        color(id, n.color);
        continue;
      }
      const note = n as DocNote;
      if (note.code !== undefined) left.add("code");
      if (note.image) left.add("pictures");
      if (note.detail) left.add("details");
      if (note.w !== undefined || note.h !== undefined) left.add("sizes");
      // (a title, Markdown's special characters as text, then the text)
      const title = note.title?.replace(/([\\*_[\]~])/g, "\\$1");
      const label = title && note.text ? `**${title}**\n${note.text}` : title ?? note.text ?? (note.code !== undefined ? "code" : "");
      const [open, close] = SHAPE_OF[note.shape ?? "rect"] ?? SHAPE_OF.rect;
      out.push(`${indent}${id}${open}${md(label || " ")}${close}`);
      color(id, note.color);
      if (note.ref) {
        if (/^https?:\/\/[^\s"<>`]+$/i.test(note.ref)) out.push(`${indent}click ${id} href ${JSON.stringify(note.ref)}`);
        else left.add("links that are not web addresses");
      }
    }
  };
  walk(v.nodes ?? [], "  ");
  for (const e of v.edges ?? []) {
    if (!shown.has(e.from) || !shown.has(e.to)) continue;
    const a = idOf(e.from), b = idOf(e.to);
    const body = e.line === "thick" ? "==" : e.line === "dotted" ? "-.-" : "--";
    const link = e.hidden ? "~~~" : e.arrow === "none" ? (e.line === "dotted" ? "-.-" : body + (e.line === "thick" ? "=" : "-")) : (e.arrow === "both" ? "<" : "") + (e.line === "dotted" ? "-.->" : body + ">");
    // (quoted: what is in it is a label's text, never the flowchart's syntax)
    const lab = e.label && !e.hidden ? `|"${coded(e.label.replace(/\s+/g, " "))}"|` : "";
    out.push(`  ${a} ${link}${lab} ${b}`);
  }
  if (v.steps?.length) left.add("tours");
  if (v.intro) left.add("the introduction");
  out.push(...styles.map((s) => "  " + s));
  return { text: out.join("\n") + "\n", left: [...left] };
}

/** Every page of a board as Markdown: a heading and a flowchart each (boardFromText reads it back as pages). */
export function toMermaidMarkdown(doc: BoardDoc): { text: string; left: string[] } {
  const n = pageCount(doc), left = new Set<string>(), parts: string[] = [];
  if (doc.title) parts.push("# " + doc.title.replace(/[\r\n]+/g, " "), "");
  for (let i = 0; i < n; i++) {
    const { text, left: l } = toMermaid({ ...pageView(doc, i), title: undefined }, 0);
    l.filter((x) => x !== "other pages").forEach((x) => left.add(x));
    parts.push(`## ${(doc.pages?.[i]?.title ?? `Page ${i + 1}`).replace(/[\r\n]+/g, " ")}`, "", "```mermaid", text.trimEnd(), "```", "");
  }
  return { text: parts.join("\n"), left: [...left] };
}
