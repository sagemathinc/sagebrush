// Markdown for the notebook's text cells (marked, GitHub flavor), bundled
// into the page script (web/build.ts).  Safe for untrusted notebooks: raw
// HTML is shown as text (except <br>), links and images keep only harmless
// URLs, and math ($...$, $$...$$, \(...\), \[...\]) becomes elements the page
// typesets with KaTeX (web/math.ts).  Images may refer to a cell's
// attachments (attachment:name), as in Jupyter.
import { Marked, type Tokens } from "marked";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SAFE_LINK = /^(https?:|mailto:|#|\/(?!\/)|\.{1,2}\/|[\w.~-]+(?:[/?#]|$))/i;
const SAFE_IMG = /^(https?:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);)/i;

export interface Options {
  // syntax highlighting of fenced code (Python and Sage), as HTML
  highlight?: (code: string, lang: string) => string | null;
  // a cell's attachments: name -> {mime: base64}
  attachments?: Record<string, Record<string, string>> | null;
}

function mathExtension() {
  const inline = (re: RegExp, display: boolean) => ({
    name: display ? "mathDisplayInline" : "mathInline",
    level: "inline" as const,
    start: (src: string) => {
      const i = src.search(/\$|\\\(|\\\[/);
      return i < 0 ? undefined : i;
    },
    tokenizer(src: string) {
      const m = re.exec(src);
      if (m) return { type: display ? "mathDisplayInline" : "mathInline", raw: m[0], tex: m[1] ?? m[2] };
      return undefined;
    },
    renderer: (t: any) => `<span class="math${display ? " display" : ""}" data-tex="${esc(t.tex.trim())}">${esc(t.raw)}</span>`,
  });
  return {
    extensions: [
      {
        name: "mathBlock",
        level: "block" as const,
        start: (src: string) => {
          const i = src.search(/^ {0,3}(\$\$|\\\[)/m);
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(src);
          if (m) return { type: "mathBlock", raw: m[0], tex: m[1] ?? m[2] };
          return undefined;
        },
        renderer: (t: any) => `<div class="math display" data-tex="${esc(t.tex.trim())}">${esc(t.raw.trim())}</div>\n`,
      },
      inline(/^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])/, true),
      // $x$: no space just inside the dollars, and no digit right after (prices)
      inline(/^(?:\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)|\\\(([\s\S]+?)\\\))/, false),
    ],
  };
}

export function render(src: string, opts: Options = {}): string {
  const md = new Marked({ gfm: true, breaks: false });
  md.use(mathExtension());
  md.use({
    renderer: {
      html(t: Tokens.HTML | Tokens.Tag) {
        return /^<br\s*\/?>$/i.test(t.text.trim()) ? "<br>" : esc(t.text);
      },
      link(t: Tokens.Link) {
        const text = this.parser.parseInline(t.tokens);
        if (!SAFE_LINK.test(t.href)) return text;
        const ext = /^https?:/i.test(t.href);
        return `<a href="${esc(t.href)}"${t.title ? ` title="${esc(t.title)}"` : ""}${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
      },
      image(t: Tokens.Image) {
        let src = t.href;
        const a = /^attachment:(.+)$/.exec(src);
        if (a && opts.attachments?.[a[1]]) {
          const [mime, b64] = Object.entries(opts.attachments[a[1]])[0];
          src = `data:${mime};base64,${b64}`;
        }
        if (!SAFE_IMG.test(src)) return esc(t.text);
        return `<img src="${esc(src)}" alt="${esc(t.text)}"${t.title ? ` title="${esc(t.title)}"` : ""}>`;
      },
      code(t: Tokens.Code) {
        const lang = (t.lang ?? "").trim().split(/\s/)[0];
        const hl = opts.highlight?.(t.text, lang) ?? null;
        return `<pre class="code"><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${hl ?? esc(t.text)}</code></pre>\n`;
      },
    },
  });
  return md.parse(src, { async: false }) as string;
}
