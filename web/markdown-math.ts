// Math in the site's Markdown, typeset by KaTeX at build time (web/build-articles.ts, web/build-examples.ts): $$...$$
// blocks and $...$ or $$...$$ inline. KaTeX's own trust: false (no \href, \url or HTML extensions) and no throwing:
// a formula KaTeX can't typeset is shown as its source, in red.
import katex from "katex";
import type { MarkedExtension } from "marked";

export const tex = (s: string, displayMode: boolean) => katex.renderToString(s, { displayMode, throwOnError: false, output: "html", trust: false });

export const mathExtensions: NonNullable<MarkedExtension["extensions"]> = [
  {
    name: "mathBlock",
    level: "block",
    start: (src: string) => src.match(/^\$\$/m)?.index,
    tokenizer(src: string) {
      const r = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
      if (r) return { type: "mathBlock", raw: r[0], text: r[1] };
    },
    renderer: (t: any) => `<div class="math-display">${tex(t.text.trim(), true)}</div>\n`,
  },
  {
    name: "mathInline",
    level: "inline",
    start: (src: string) => (src.indexOf("$") < 0 ? undefined : src.indexOf("$")),
    tokenizer(src: string) {
      const d = /^\$\$([\s\S]+?)\$\$/.exec(src);
      if (d) return { type: "mathInline", raw: d[0], text: d[1], display: true };
      // (a single line break may fall inside: source lines are wrapped;
      // without it "$\prod\ng_i$, each $g_i$" paired the wrong dollars)
      const r = /^\$((?:\\.|[^\\$\n]|\n(?![ \t]*\n))+?)\$/.exec(src);
      if (r) return { type: "mathInline", raw: r[0], text: r[1], display: false };
    },
    renderer: (t: any) => tex(t.text.trim(), t.display),
  },
];
