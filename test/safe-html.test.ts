import test from "node:test";
import assert from "node:assert/strict";
import { parseFragment } from "parse5";
import { safeHtml } from "../web/safe-html";
import { render } from "../web/markdown";

// web/safe-html.ts against XSS payloads: its output, parsed as a browser
// parses HTML (parse5, the WHATWG algorithm, foreign content included), has
// only allowed elements, no event handler or other attribute outside the
// allowlist, and no link or image whose address could run script.

const ALLOWED = new Set(("b strong i em u s strike del ins sub sup small big mark code kbd samp var abbr cite q dfn tt br hr wbr p div span center blockquote pre address " +
  "h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col font img a details summary figure figcaption section article header footer nav aside main").split(" "));
const ATTRS = new Set("style title align dir lang start type reversed value border cellpadding cellspacing width height valign colspan rowspan scope span color size face src alt href open target rel".split(" "));

function problems(html: string): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.tagName) {
      if (n.namespaceURI !== "http://www.w3.org/1999/xhtml" || !ALLOWED.has(n.tagName)) out.push(`element <${n.tagName}> (${n.namespaceURI})`);
      for (const a of n.attrs ?? []) {
        if (!ATTRS.has(a.name)) out.push(`attribute ${a.name} on <${n.tagName}>`);
        if (a.name === "href" || a.name === "src") {
          const v = a.value.replace(/[\u0000- ]/g, "");
          let scheme = "";
          try { scheme = new URL(v, "https://sagebrush.space/x/").protocol; } catch { scheme = "bad:"; }
          if (!["https:", "http:", "mailto:", "data:"].includes(scheme) || (scheme === "data:" && !/^data:image\//i.test(v))) out.push(`${a.name}=${JSON.stringify(a.value)}`);
        }
        if (a.name === "style" && /url|expression|javascript|import|\\/i.test(a.value)) out.push(`style=${JSON.stringify(a.value)}`);
      }
    }
    for (const c of n.childNodes ?? []) walk(c);
    if (n.content) walk(n.content);
  };
  walk(parseFragment(html));
  return out;
}

const PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<img src=\"x\" onerror=\"alert(1)\">",
  "<IMG SRC=JaVaScRiPt:alert(1)>",
  "<a href=\"javascript:alert(1)\">x</a>",
  "<a href=\"  javascript:alert(1)\">x</a>",
  "<a href=\"java\tscript:alert(1)\">x</a>",
  "<a href=\"java&#x09;script:alert(1)\">x</a>",
  "<a href=\"&#106;avascript:alert(1)\">x</a>",
  "<a href=\"&#x6A;avascript&colon;alert(1)\">x</a>",
  "<a href=\"vbscript:msgbox(1)\">x</a>",
  "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>",
  "<img src=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">",
  "<svg onload=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>",
  "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>",
  "<iframe src=\"javascript:alert(1)\"></iframe>",
  "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
  "<object data=\"javascript:alert(1)\"></object>",
  "<embed src=\"javascript:alert(1)\">",
  "<form><button formaction=\"javascript:alert(1)\">x</button></form>",
  "<base href=\"javascript:alert(1)//\">",
  "<meta http-equiv=\"refresh\" content=\"0;url=javascript:alert(1)\">",
  "<link rel=\"stylesheet\" href=\"https://evil.example/x.css\">",
  "<style>@import 'https://evil.example/x.css'; body{background:url(javascript:alert(1))}</style>",
  "<div style=\"background:url(javascript:alert(1))\">x</div>",
  "<div style=\"width: expression(alert(1))\">x</div>",
  "<div style=\"background-image: url('https://evil.example/leak')\">x</div>",
  "<span style=\"color:red;background:u&#114;l(x)\">x</span>",
  "<div id=\"getElementById\" name=\"cookie\">x</div>",
  "<p class=\"sbnb\" onclick=\"alert(1)\">x</p>",
  "<<script>script>alert(1)<</script>/script>",
  "<scr<script>ipt>alert(1)</script>",
  "<img src=x onerror=alert(1)//",
  "<img/src=x/onerror=alert(1)>",
  "<img src=`x` onerror=`alert(1)`>",
  "<a href=x\nonclick=alert(1)>x</a>",
  "<!--<img src=x onerror=alert(1)>-->",
  "<!-- --!><img src=x onerror=alert(1)>-->",
  "<template><img src=x onerror=alert(1)></template>",
  "<textarea><img src=x onerror=alert(1)></textarea>",
  "<title><img src=x onerror=alert(1)></title>",
  "<xmp><img src=x onerror=alert(1)></xmp>",
  "<table><td><img src=x onerror=alert(1)></td></table>",
  "<details open ontoggle=alert(1)>x</details>",
  "<video><source onerror=alert(1)></video>",
  "<input autofocus onfocus=alert(1)>",
  "<select autofocus onfocus=alert(1)>",
  "<marquee onstart=alert(1)>",
  "<body onload=alert(1)>",
  "<a href=\"https://ok.example\" target=\"_self\">ok</a>",
  "<font color=\"red;background:url(x)\" face=\"x\" size=\"3\">t</font>",
  "<span style=\"color:green\">green</span>",
  "<img src=\"attachment:a.png\" width=\"600px\">",
];

test("safe HTML: XSS payloads come out harmless, as a browser parses them", () => {
  const bad: string[] = [];
  for (const p of PAYLOADS) {
    for (const o of [{}, { remote: false }]) {
      const out = safeHtml(p, o);
      const ps = problems(out);
      if (ps.length) bad.push(`${JSON.stringify(p)} -> ${JSON.stringify(out)}: ${ps.join("; ")}`);
    }
    // (and through Markdown: inline and block HTML)
    for (const md of [p, `text ${p} text`, `* ${p}`, `| a |\n|---|\n| ${p} |`]) {
      const out = render(md);
      const ps = problems(out);
      if (ps.length) bad.push(`markdown ${JSON.stringify(md)} -> ${JSON.stringify(out)}: ${ps.join("; ")}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("safe HTML: what Jupyter notebooks use survives", () => {
  assert.equal(safeHtml('<span style="color:green">'), '<span style="color: green">');
  assert.equal(safeHtml("<b>bold</b> <u>under</u> <i>it</i>"), "<b>bold</b> <u>under</u> <i>it</i>");
  const att = { "a.png": { "image/png": "iVBORw0KGgo=" } };
  assert.equal(safeHtml('<img src="attachment:a.png" width="600px">', { attachments: att }), '<img src="data:image/png;base64,iVBORw0KGgo=" width="600px">');
  assert.equal(safeHtml('<a href="https://x.example/p">x</a>'), '<a href="https://x.example/p" target="_blank" rel="noopener noreferrer">x</a>');
  assert.match(safeHtml("<table border=1><tr><th colspan=2>h</th></tr><tr><td>1</td><td>2</td></tr></table>"), /^<table border="1"><tr><th colspan="2">h<\/th>/);
  // (remote images: kept for what a person wrote, not for what code made)
  assert.equal(safeHtml('<img src="https://x.example/i.png">'), '<img src="https://x.example/i.png">');
  assert.equal(safeHtml('<img src="https://x.example/i.png">', { remote: false }), "");
  assert.equal(render("![a](https://x.example/i.png)", { remote: false }), "<p>a</p>\n");
  // (the Lab notebooks' Markdown: colored text renders, not as source)
  assert.equal(render('<span style="color:green">**Answer**</span>'), '<p><span style="color: green"><strong>Answer</strong></span></p>\n');
});
