// MyST directives and roles in a Jupytext MyST notebook's Markdown cells
// (plan-myst-notebooks r3): built as its own asset, sagebrush-myst.js, which
// the notebook loads only for such a notebook (web/notebook/notebook.js), so
// no other page or notebook carries it (§8.1).
//
// It is a marked extension that web/markdown.ts's render() takes through its
// `myst` option (MystHook), with render() itself, one level deeper, for the
// bodies: so raw HTML in a body is still safeHtml's, its links safeLink's,
// its pictures safeImage's (§8.2).  What this file writes itself is fixed
// markup: element, attribute and class names are literals from the tables
// below; every value from the notebook (a title, an option, a label, an
// {eval}'s stored result) is escaped text; a :class: only selects an entry of
// a closed table; anchors are opaque numbers ("data-myst-anchor", never a
// label, never an id), found through the index (a Map) when a reference is
// clicked.  A directive it doesn't know, or one nested deeper than MAX_DEPTH,
// is shown as its text, escaped, never dropped.
//
// Numbering follows the built book (jupyter-book with sphinx-proof): each kind
// of prf box counted on its own in a chapter ("Algorithm 9.1", "Proposition
// 9.1"), labelled equations as "(9.1)"; the chapter number is the notebook's
// (metadata.sagebrush.myst.chapter, from the .md's name), none if it has none.

import { buildBook, hold, type Book, type BookCap, type BookChapter, type Pending } from "./book";

export const MAX_DEPTH = 8;

/** The boxes' styles, added to the page once with this asset (web/notebook/notebook.js): one box, its kind word
 * always shown, four families of admonition, the notebook's own colours (so its dark theme too). */
export const css = `
.sbnb :is(.mdout, .mb) .myst-box { --mk: var(--line); border: 1px solid var(--line); border-left: 4px solid var(--mk); border-radius: 6px; padding: 2px 12px; margin: .7em 0; }
.sbnb :is(.mdout, .mb) .myst-info { --mk: var(--hb); } .sbnb :is(.mdout, .mb) .myst-emphasis { --mk: var(--accent); } .sbnb :is(.mdout, .mb) .myst-warning { --mk: var(--hs); } .sbnb :is(.mdout, .mb) .myst-prf { --mk: var(--accent2); }
.sbnb :is(.mdout, .mb) .myst-proof { border: 0; padding: 0; } .sbnb :is(.mdout, .mb) .myst-qed { text-align: right; margin-top: -.3em; }
.sbnb :is(.mdout, .mb) .myst-unknown pre { white-space: pre-wrap; font: .9em ui-monospace, Menlo, monospace; color: var(--muted); }
.sbnb :is(.mdout, .mb) .myst-eq { display: flex; align-items: center; gap: 1em; } .sbnb :is(.mdout, .mb) .myst-eq > .math { flex: 1; }
.sbnb :is(.mdout, .mb) :is(.myst-note, .myst-ref-missing) { color: var(--muted); } .sbnb :is(.mdout, .mb) figure { margin: .7em 0; }
.sbnb :is(.mdout, .mb) details.myst-box > summary { cursor: pointer; margin: .5em 0; }
.sbnb .myst-bookline { margin: 4px 0 8px; color: var(--muted); } .sbnb .myst-bookline button { font: inherit; }
.sbnb .myst-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.sbnb :is(.mdout, .mb) .myst-toc ol { margin: .2em 0 .6em; } .sbnb :is(.mdout, .mb) .myst-toc-part { margin: .6em 0 0; font-weight: 600; }
`;

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// sphinx-proof's kinds: the word shown
const PRF: Record<string, string> = {
  "prf:theorem": "Theorem", "prf:definition": "Definition", "prf:proposition": "Proposition", "prf:lemma": "Lemma",
  "prf:corollary": "Corollary", "prf:algorithm": "Algorithm", "prf:example": "Example", "prf:property": "Property",
  "prf:conjecture": "Conjecture", "prf:remark": "Remark", "prf:axiom": "Axiom", "prf:criterion": "Criterion",
  "prf:observation": "Observation", "prf:assumption": "Assumption",
};
// admonitions: their family (a fixed class) and the word shown
const ADMON: Record<string, [string, string]> = {
  note: ["info", "Note"], tip: ["info", "Tip"], hint: ["info", "Hint"], seealso: ["info", "See also"],
  important: ["emphasis", "Important"], attention: ["emphasis", "Attention"],
  warning: ["warning", "Warning"], caution: ["warning", "Caution"], danger: ["warning", "Danger"], error: ["warning", "Error"],
  admonition: ["neutral", "Note"],
};
const has = (o: object, k: string) => Object.hasOwn(o, k);
// the :class: values that mean something here (anything else is dropped)
const CLASSES = new Set(["dropdown"]);
// :width: and :align: as fixed styles
const WIDTH = new Map([["25%", "25%"], ["50%", "50%"], ["75%", "75%"], ["100%", "100%"]]);
const ALIGN = new Map([["left", "left"], ["center", "center"], ["right", "right"]]);

export type Directive = { raw: string; name: string; arg: string; opts: Map<string, string>; body: string };

const OPEN = /^( {0,3})(`{3,}|:{3,})\{([A-Za-z][\w:.-]*)\}[ \t]*([^\n]*)(?:\n|$)/;

/** A directive at the start of `src` (a backtick or colon fence with a {name}), or null.  Shared by the
 * renderer's tokenizer and the index, so both see the same directives. */
export function matchDirective(src: string): Directive | null {
  const m = OPEN.exec(src);
  if (!m) return null;
  const ch = m[2][0], n = m[2].length, name = m[3], arg = m[4].trim();
  let pos = m[0].length, end = src.length, bodyEnd = src.length, depth = 0;
  const closeTicks = new RegExp(`^ {0,3}\`{${n},}[ \\t]*$`);
  while (pos < src.length) {
    const nl = src.indexOf("\n", pos), line = src.slice(pos, nl < 0 ? src.length : nl);
    let close = false;
    if (ch === "`") close = closeTicks.test(line);
    else {
      const c = /^ {0,3}(:{3,})(\{)?/.exec(line);
      if (c && c[2] && c[1].length === n) depth++;
      else if (c && !c[2] && /^ {0,3}:{3,}[ \t]*$/.test(line) && c[1].length >= n) {
        if (depth > 0 && c[1].length === n) depth--;
        else close = true;
      }
    }
    if (close) { bodyEnd = pos; end = nl < 0 ? src.length : nl + 1; break; }
    pos = nl < 0 ? src.length : nl + 1;
  }
  let body = src.slice(m[0].length, bodyEnd);
  const opts = new Map<string, string>();
  // its options: ":key: value" lines at the start, or a "---" block of "key: value" lines
  if (/^---[ \t]*\n/.test(body)) {
    const close = /\n---[ \t]*(?:\n|$)/.exec(body);
    if (close) {
      for (const l of body.slice(body.indexOf("\n") + 1, close.index).split("\n")) {
        const o = /^([\w-]+):[ \t]*(.*)$/.exec(l.trim());
        if (o) opts.set(o[1], o[2].trim());
      }
      body = body.slice(close.index + close[0].length);
    }
  } else {
    let o: RegExpExecArray | null;
    while ((o = /^[ \t]*:([\w-]+):[ \t]*([^\n]*)(?:\n|$)/.exec(body))) {
      opts.set(o[1], o[2].trim());
      body = body.slice(o[0].length);
    }
  }
  return { raw: src.slice(0, end), name, arg, opts, body: body.replace(/\n$/, "") };
}

// ---------------------------------------------------------------- the index

export type Entry = { kind: string; display: string; cell: string; anchor: number };
export type Occurrence = { name: string; number?: string; anchor?: number; dup?: string };
export type MystIndex = {
  chapter: number;
  labels: Map<string, Entry>;
  // per cell id: its directives and its (label)= targets, in the order they render
  directives: Map<string, Occurrence[]>;
  targets: Map<string, Occurrence[]>;
  texts: Map<string, string>;
};

const num = (chapter: number, n: number) => (chapter > 0 ? `${chapter}.${n}` : `${n}`);
const KNOWN = (name: string) => has(PRF, name) || has(ADMON, name) || ["prf:proof", "math", "table", "figure", "tableofcontents"].includes(name);

/** The index of a notebook's Markdown cells, in order: labels (a Map: no inherited names), each
 * directive's number and anchor, each (label)= target's anchor. */
export function buildIndex(cells: { id: string; text: string }[], chapter: number): MystIndex {
  const idx: MystIndex = { chapter, labels: new Map(), directives: new Map(), targets: new Map(), texts: new Map() };
  const counts = new Map<string, number>();
  let anchors = 0;
  const label = (lab: string | undefined, kind: string, display: string, cell: string, o: Occurrence) => {
    if (!lab) return;
    if (idx.labels.has(lab)) { o.dup = lab; return; }
    o.anchor = ++anchors;
    idx.labels.set(lab, { kind, display, cell, anchor: o.anchor });
  };
  const scan = (text: string, cell: string, depth: number) => {
    const ds = idx.directives.get(cell)!, ts = idx.targets.get(cell)!;
    let pos = 0, fence: [string, number] | null = null;
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos), line = text.slice(pos, nl < 0 ? text.length : nl);
      const next = nl < 0 ? text.length : nl + 1;
      if (fence) {
        if (new RegExp(`^ {0,3}\\${fence[0]}{${fence[1]},}[ \\t]*$`).test(line)) fence = null;
        pos = next;
        continue;
      }
      const d = matchDirective(text.slice(pos));
      if (d) {
        // (as the renderer: past MAX_DEPTH, or not known, shown as text: no number, nothing inside scanned)
        if (depth < MAX_DEPTH && KNOWN(d.name)) {
          const o: Occurrence = { name: d.name };
          ds.push(o);
          const lab = d.opts.get("label") ?? d.opts.get("name");
          const nonumber = d.opts.has("nonumber");
          if (has(PRF, d.name)) {
            if (!nonumber) {
              const c = (counts.get(d.name) ?? 0) + 1;
              counts.set(d.name, c);
              o.number = num(chapter, c);
            }
            label(lab, d.name, o.number ? `${PRF[d.name]} ${o.number}` : PRF[d.name], cell, o);
          } else if (d.name === "math") {
            if (lab && !nonumber) {
              const c = (counts.get("math") ?? 0) + 1;
              counts.set("math", c);
              o.number = num(chapter, c);
            }
            label(lab, "math", o.number ? `(${o.number})` : lab ?? "", cell, o);
          } else if (d.name === "table" || d.name === "figure") label(lab, d.name, d.arg || lab || "", cell, o);
          if (d.name !== "math") scan(d.body, cell, depth + 1);
        }
        pos += d.raw.length || next - pos;
        continue;
      }
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) { fence = [f[1][0], f[1].length]; pos = next; continue; }
      const t = /^\(([^()\s]+)\)=[ \t]*$/.exec(line);
      if (t) {
        const o: Occurrence = { name: "target" };
        ts.push(o);
        // (what it names: the heading after it, else the label)
        const rest = text.slice(next).replace(/^\s*\n/, "");
        const h = /^ {0,3}#{1,6}[ \t]+([^\n]*)/.exec(rest);
        label(t[1], "target", h ? h[1].replace(/[ \t]+#*[ \t]*$/, "").trim() : t[1], cell, o);
      }
      pos = next;
    }
  };
  for (const c of cells) {
    idx.texts.set(c.id, c.text);
    idx.directives.set(c.id, []);
    idx.targets.set(c.id, []);
    scan(c.text, c.id, 0);
  }
  return idx;
}

// ---------------------------------------------------------------- rendering

/** The renderer's view of one render (web/markdown.ts MystHook): `render` a body as Markdown with the same
 * options one level deeper, `inline` a title, `depth` this level. */
export type Renderer = { render(src: string): string; inline(src: string): string; depth: number };

/** The hook web/markdown.ts takes (Options.myst) for one cell's render: its directives and targets numbered
 * from the index, in the order they render; `evals`: its stored {eval} results (text/plain), shown as text. */
export function hook(idx: MystIndex | null, cell: string, evals?: Map<string, string>, book?: Book | null) {
  let d = 0, t = 0;
  const ds = idx?.directives.get(cell) ?? [], ts = idx?.targets.get(cell) ?? [];
  // (the next occurrence, if it is this directive's; else none: no number rather than a wrong one)
  const take = (name: string) => (ds[d]?.name === name ? ds[d++] : undefined);
  return {
    extension(r: Renderer) {
      return {
        extensions: [
          {
            name: "mystDirective",
            level: "block",
            start: (src: string) => { const i = src.search(/^ {0,3}(?:`{3,}|:{3,})\{/m); return i < 0 ? undefined : i; },
            tokenizer(src: string) {
              const m = matchDirective(src);
              return m ? { type: "mystDirective", raw: m.raw, d: m } : undefined;
            },
            renderer: (tok: any) => directive(tok.d, r),
          },
          {
            name: "mystTarget",
            level: "block",
            start: (src: string) => { const i = src.search(/^\([^()\s]+\)=[ \t]*$/m); return i < 0 ? undefined : i; },
            tokenizer(src: string) {
              const m = /^\(([^()\s]+)\)=[ \t]*(?:\n|$)/.exec(src);
              return m ? { type: "mystTarget", raw: m[0], label: m[1] } : undefined;
            },
            renderer: () => {
              const o = ts[t++];
              if (o?.dup) return `<p class="myst-note">Duplicate label: ${esc(o.dup)}</p>\n`;
              return o?.anchor ? `<span class="myst-target" data-myst-anchor="${o.anchor}"></span>\n` : "";
            },
          },
          {
            name: "mystRole",
            level: "inline",
            start: (src: string) => { const i = src.search(/\{[A-Za-z][\w:.-]*\}`/); return i < 0 ? undefined : i; },
            tokenizer(src: string) {
              const m = /^\{([A-Za-z][\w:.-]*)\}`([^`\n]*)`/.exec(src);
              return m ? { type: "mystRole", raw: m[0], role: m[1], text: m[2] } : undefined;
            },
            renderer: (tok: any) => role(tok.role, tok.text),
          },
        ],
      };
    },
  };

  function role(name: string, text: string): string {
    if (name === "math") return `<span class="math" data-tex="${esc(text)}">${esc(text)}</span>`;
    if (name === "eval") {
      const v = evals?.get(text.trim());
      return v === undefined ? `<code>${esc(text)}</code>` : `<span class="myst-eval">${esc(v)}</span>`;
    }
    if (name === "prf:ref" || name === "ref" || name === "numref" || name === "eq") {
      const m = /^([\s\S]*?)\s*<([^<>]+)>$/.exec(text);
      const lab = (m ? m[2] : text).trim(), shown = m ? m[1].trim() : "";
      const e = idx?.labels.get(lab);
      // (not in this notebook: another chapter's, P2 links it; its own text as text, else its label said so, no dead link)
      if (!e) {
        // (another chapter's, in this notebook's book (P2): a link that reads as that chapter numbers it, followed by
        // the page's book capability; a label two chapters define: the first's, said)
        const be = book?.labels.get(lab);
        if (be) return `<a href="#" class="myst-ref myst-ref-book" data-myst-ref="${esc(lab)}">${esc(shown || be.display)}</a>` + (book!.dups.has(lab) ? `<span class="myst-note"> (label in two chapters)</span>` : "");
        return shown ? `<span class="myst-ref-other">${esc(shown)}</span>` : `<span class="myst-ref-missing">${esc(lab)} (in another chapter)</span>`;
      }
      return `<a href="#" class="myst-ref" data-myst-ref="${esc(lab)}">${esc(shown || e!.display)}</a>`;
    }
    return `<code>${esc(text)}</code>`;
  }

  function directive(x: Directive, r: Renderer): string {
    if (r.depth >= MAX_DEPTH || !KNOWN(x.name)) return asText(x);
    const o = take(x.name);
    const dup = o?.dup ? `<p class="myst-note">Duplicate label: ${esc(o.dup)}</p>\n` : "";
    const anchor = o?.anchor ? ` data-myst-anchor="${o.anchor}"` : "";
    const classes = new Set((x.opts.get("class") ?? "").split(/\s+/).filter((c) => CLASSES.has(c)));
    if (x.name === "math") {
      const tex = x.body.trim();
      const m = `<div class="math display" data-tex="${esc(tex)}">${esc(tex)}</div>`;
      return dup + (o?.number ? `<div class="myst-eq"${anchor}>${m}<span class="myst-eqno">(${esc(o.number)})</span></div>\n` : anchor ? `<div class="myst-eq"${anchor}>${m}</div>\n` : m + "\n");
    }
    if (x.name === "tableofcontents") return book ? tocNav(book) : `<p class="myst-note">The book's table of contents: open _toc.yml's chapters from the file browser.</p>\n`;
    if (x.name === "table") return dup + `<figure class="myst-table"${anchor}>${x.arg ? `<figcaption>${r.inline(x.arg)}</figcaption>` : ""}${r.render(x.body)}</figure>\n`;
    if (x.name === "figure") {
      const path = x.arg, alt = x.opts.get("alt") ?? "";
      const w = WIDTH.get(x.opts.get("width") ?? ""), a = ALIGN.get(x.opts.get("align") ?? "");
      const style = [w ? `max-width: ${w}` : "", a ? `text-align: ${a}` : ""].filter(Boolean).join("; ");
      // (the picture through render(): safeImage decides what it may be; an address it can't take is its text)
      const pic = /^[^<>\n\\]+$/.test(path) ? r.render(`![${alt.replace(/[[\]\\]/g, "")}](<${path}>)`) : `<p>${esc(alt || path)}</p>`;
      return dup + `<figure class="myst-figure"${anchor}${style ? ` style="${style}"` : ""}>${pic}${x.body.trim() ? `<figcaption>${r.render(x.body)}</figcaption>` : ""}</figure>\n`;
    }
    const prf = has(PRF, x.name) ? PRF[x.name] : "";
    let family: string, word: string, title = "";
    if (x.name === "prf:proof") { family = "proof"; word = "Proof."; }
    else if (prf) { family = "prf"; word = o?.number ? `${prf} ${o.number}` : prf; title = x.arg; }
    else { [family, word] = ADMON[x.name]; if (x.name === "admonition") { word = ""; title = x.arg || "Note"; } }
    const label = [word, title].filter(Boolean).join(" ");
    const head = (x.name === "prf:proof" ? `<i>${esc(word)}</i>` : word ? `<b class="myst-kind">${esc(word)}</b>` : "")
      + (title ? (word ? ` (${r.inline(title)})` : `<b class="myst-kind">${r.inline(title)}</b>`) : "");
    const body = r.render(x.body) + (x.name === "prf:proof" ? `<p class="myst-qed">∎</p>` : "");
    const cls = `myst-box myst-${family}${prf ? ` myst-${x.name.slice(4)}` : ""}`;
    if (classes.has("dropdown")) return dup + `<details class="${cls} myst-dropdown"${anchor}><summary class="myst-title">${head}</summary>${body}</details>\n`;
    return dup + `<aside class="${cls}" role="note" aria-label="${esc(label)}"${anchor}><p class="myst-title">${head}</p>${body}</aside>\n`;
  }
}

// The book's chapters ({tableofcontents} in a book: P2, agents-ui's A-2): a nav, an ol per part, captions as text; a
// chapter's number and title (text), a link (by its place in the TOC, a number) if it can be opened as a notebook;
// the open one marked current, not a link; a missing one by its name, said so
function tocNav(book: Book): string {
  const item = (c: BookChapter, i: number) => {
    const words = (c.number ? `${c.number} · ` : "") + (c.present ? c.title || c.entry : c.entry) + (c.file && !c.present ? " (not in this folder)" : "");
    if (i === book.own) return `<li><span aria-current="page">${esc(words)}</span></li>`;
    return c.present && c.myst ? `<li><a href="#" class="myst-toc-ch" data-myst-chapter="${i}">${esc(words)}</a></li>` : `<li>${esc(words)}</li>`;
  };
  let out = "";
  const roots = book.chapters.map((c, i) => [c, i] as const).filter(([c]) => c.root);
  if (roots.length) out += `<ol>${roots.map(([c, i]) => item(c, i)).join("")}</ol>`;
  book.parts.forEach((p, k) => {
    const cs = book.chapters.map((c, i) => [c, i] as const).filter(([c]) => !c.root && c.part === k);
    out += (p.caption ? `<p class="myst-toc-part">${esc(p.caption)}</p>` : "") + `<ol>${cs.map(([c, i]) => item(c, i)).join("")}</ol>`;
  });
  return `<nav class="myst-toc" aria-label="Contents">${out}</nav>\n`;
}

// a directive shown as its text: a box naming it, its source escaped
function asText(x: Directive): string {
  return `<div class="myst-box myst-unknown"><p class="myst-title">${esc(x.name)}</p><pre>${esc(x.raw)}</pre></div>\n`;
}

// ---------------------------------------------------------------- in a notebook (web/notebook/notebook.js)

type Cell = { id: string; type?: string; el: HTMLElement; md: HTMLElement; ta: HTMLTextAreaElement; metadata?: any };
type Notebook = { root: HTMLElement; cells: () => Cell[]; renderMd: (c: Cell) => unknown; h: (tag: string, cls: string, props?: object) => HTMLElement; book?: () => Promise<BookCap | null> };

const BOOK_REFUSED = {
  unsupported: "This book's table of contents isn't supported, so chapters open one at a time.",
  large: "This book is too large to link its chapters; chapters open one at a time.",
};

/** What a notebook needs from this asset, once it has loaded it: its styles added to the page (once), references
 * followed by a click, and `hookFor(cell)` for each Markdown cell's render.  The index is built from the Markdown
 * cells, again when they changed (a cell's text, or the cells themselves); `editing`: a block of a cell being
 * written, drawn as typed: the index as it was, its boxes unnumbered there rather than numbered wrongly.
 * `nb.book` (the workspace page's, P2): the open document's book capability, as a promise; its book is built in the
 * background (web/myst/book.ts) and the cells drawn again with it, unless another document opened meanwhile. */
export function attach(nb: Notebook) {
  if (!document.querySelector("style[data-sbnb-myst]")) {
    // (after the notebook's own styles: the page's still win)
    const st = nb.h("style", "", { textContent: css });
    st.dataset.sbnbMyst = "";
    const own = document.querySelector("style[data-sbnb]");
    if (own) own.after(st); else document.head.prepend(st);
  }
  let idx: MystIndex | null = null, key = "", chapterUsed = -1;
  // the book: the promise of the document's capability it is for, its capability, the book, its build's stop
  let bookP: Promise<BookCap | null> | null = null, cap: BookCap | null = null, book: Book | null = null, stop: AbortController | null = null;
  let line: HTMLElement | null = null;
  // (said for a screen reader: cleared, then set on the next frame, so a repeat is said too: A-4)
  const live = nb.h("div", "myst-live");
  live.setAttribute("aria-live", "polite");
  nb.root.append(live);
  const announce = (t: string) => { live.textContent = ""; requestAnimationFrame(() => { live.textContent = t; }); };
  // (another document opened, MyST or not: this one's lines go; the page's getter gives a new promise per document,
  // and for one that isn't a MyST copy answers without reading anything)
  const cellsEl = nb.root.querySelector(".cells");
  if (cellsEl) new MutationObserver(() => { const p = nb.book?.() ?? null; if (p !== bookP) switchTo(p); }).observe(cellsEl, { childList: true });
  const cellOf = (el: Element) => nb.cells().find((c) => c.el.contains(el));
  const drawAll = () => { for (const c of nb.cells()) if (c.type === "markdown" && c.el.classList.contains("rendered")) nb.renderMd(c); };
  // a line at the notebook's top (the book's refusal, or the way back): one at a time, gone with the document
  const showLine = (el: HTMLElement | null) => {
    line?.remove();
    line = el;
    if (el) { el.classList.add("myst-bookline"); nb.root.prepend(el); }
  };
  // the target shown: scrolled to; its anchor focused if drawn, else its cell's text (edit mode kept): N-1
  const reveal = (cell: Cell | undefined, anchor?: number) => {
    if (!cell) return;
    const at = anchor && cell.el.classList.contains("rendered") ? (cell.md.querySelector(`[data-myst-anchor="${anchor}"]`) as HTMLElement | null) : null;
    (at ?? cell.el).scrollIntoView({ block: "center" });
    if (at) { at.setAttribute("tabindex", "-1"); at.focus({ preventScroll: true }); }
    else if (cell.el.classList.contains("rendered")) { cell.el.setAttribute("tabindex", "-1"); cell.el.focus({ preventScroll: true }); }
    else cell.ta.focus({ preventScroll: true });
  };
  // what the chapter that opened this one asked to be shown here, and the way back to it (A-3)
  const arrived = (c: BookCap, t: Pending) => {
    let said = "";
    if (t.label) {
      const e = idx?.labels.get(t.label);
      reveal(e ? nb.cells().find((x) => x.id === e.cell) : undefined, e?.anchor);
      if (e) said = e.display;
    } else if (t.cell) reveal(nb.cells().find((x) => x.id === t.cell));
    const n = book && book.own >= 0 ? book.chapters[book.own].number : 0;
    announce(`Opened ${n ? `chapter ${n}` : "the chapter"}${said ? `: ${said}` : ""}`);
    if (t.back) {
      const back = t.back, div = nb.h("div", ""), b = nb.h("button", "", { type: "button", textContent: `← Back to ${back.number ? `Chapter ${back.number}` : back.name}` });
      // (with this document's capability: the one that opened this was the last document's)
      b.addEventListener("click", () => void follow(b, () => c.open(back.name, { cell: back.cell, number: back.number })));
      div.append(b);
      showLine(div);
    }
  };
  // a chapter opened from a click: cancelled, focus back on what was clicked; refused, said there (not an alert)
  const follow = async (a: HTMLElement, go: () => ReturnType<BookCap["open"]>) => {
    a.parentElement?.querySelector(":scope > .myst-said")?.remove();
    const r = await go();
    if (r === "cancelled") a.focus();
    else if (typeof r === "object" && r.refused !== "stale") {
      const s = nb.h("span", "myst-note myst-said", { textContent: ` ${r.refused}` });
      s.setAttribute("role", "status");
      a.after(s);
    }
  };
  // another chapter of the book, opened (a reference's target, or a TOC entry), with the way back here
  const open = (a: HTMLElement, ch: BookChapter, label?: string) => {
    const c = cap, b = book;
    if (!c || !b) return;
    const own = b.own >= 0 ? b.chapters[b.own] : null, from = cellOf(a);
    const back = own && from ? { name: own.entry, cell: from.id, number: own.number } : undefined;
    void follow(a, () => c.open(ch.entry, { label, number: ch.number, title: ch.title, back }));
  };
  // a book for the document open now: the last one's build stopped, its lines gone; this one's built, then drawn
  const switchTo = (p: Promise<BookCap | null> | null) => {
    stop?.abort();
    bookP = p; cap = null; book = null; stop = null;
    showLine(null);
    if (!p) return;
    p.then(async (c) => {
      if (bookP !== p || !c) return;
      cap = c;
      const ctl = (stop = new AbortController());
      const r = await buildBook(c, ctl.signal);
      await hold("before-publish");
      // (published only for the document it was built for: g4)
      if (bookP !== p || ctl.signal.aborted || !c.live()) return;
      if (r && "book" in r) { book = r.book; idx = null; drawAll(); }
      else if (r) { const d = nb.h("div", "", { textContent: BOOK_REFUSED[r.refused] }); d.setAttribute("role", "status"); showLine(d); }
      const t = c.take();
      if (t) arrived(c, t);
    }, () => {});
  };
  // a reference followed: its target found through the index when clicked (an edit may have renumbered anchors);
  // one in another chapter, through the book; a TOC entry, its chapter
  nb.root.addEventListener("click", (e) => {
    const el = e.target as Element | null;
    const ch = el?.closest?.("a.myst-toc-ch") as HTMLElement | null;
    if (ch && nb.root.contains(ch)) {
      e.preventDefault();
      const c = book?.chapters[Number(ch.dataset.mystChapter)];
      if (c) open(ch, c);
      return;
    }
    const a = el?.closest?.("a.myst-ref") as HTMLElement | null;
    if (!a || !nb.root.contains(a)) return;
    e.preventDefault();
    const lab = a.dataset.mystRef ?? "";
    const ent = idx?.labels.get(lab);
    if (ent) { reveal(nb.cells().find((c) => c.id === ent.cell), ent.anchor); return; }
    const be = book?.labels.get(lab);
    if (be && book) open(a, book.chapters[be.chapter], lab);
  });
  return {
    hookFor(cell: Cell, editing: boolean, chapter: number) {
      const p = nb.book?.() ?? null;
      if (p !== bookP) switchTo(p);
      // (in a book, its own chapter's number is the TOC's)
      if (book && book.own >= 0) chapter = book.chapters[book.own].number;
      const md = nb.cells().filter((c) => c.type === "markdown"), k = md.map((c) => c.id).join(",");
      if (!idx || chapter !== chapterUsed || (!editing && (k !== key || idx.texts.get(cell.id) !== cell.ta.value))) {
        const again = !!idx;
        idx = buildIndex(md.map((c) => ({ id: c.id, text: c.ta.value })), chapter);
        key = k;
        chapterUsed = chapter;
        // (an edit can renumber what follows: the other cells shown are drawn again)
        if (again) queueMicrotask(() => { for (const c of md) if (c !== cell && c.el.classList.contains("rendered")) nb.renderMd(c); });
      }
      // (its stored {eval} results: text/plain only, shown as text)
      const ue = cell.metadata?.user_expressions;
      const evals = Array.isArray(ue) ? new Map<string, string>(ue.filter((u: any) => typeof u?.expression === "string" && typeof u?.result?.data?.["text/plain"] === "string").map((u: any) => [u.expression, u.result.data["text/plain"]])) : undefined;
      return hook(idx, editing ? "" : cell.id, evals, book);
    },
  };
}
