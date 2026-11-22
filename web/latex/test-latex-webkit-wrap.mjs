// ci: inline (ci.yml)
// The LaTeX source pane's two layers: a transparent textarea over the highlighted lines drawn behind it. Each line behind
// must be exactly as tall as its rows in the textarea, or the caret is drawn away from the text typed. In Safari and the
// Mac app (WebKit with the Mac's fonts) a row of the textarea is the font's rounded line height (18 px for 13 px text,
// line-height 1.45), while each line behind had min-height: 1.45em (18.85 px): every one-row line was 0.85 px too tall,
// two rows lower after a few dozen lines, more with A+. Here, in a real browser through Playwright, the shipped page
// module's mountEditor (web/dist, `bun web/build.ts` first):
//   - no line behind has a height of its own (min-height): the rows are the text's, as in the textarea (any engine);
//   - a talk with long wrapped lines (a Unicode minus among them), at many pane widths and at each Source size A+ gives:
//     the textarea and the lines behind the same height; typing below the wrapped lines keeps them so, scrolled together.
//     On the Mac's WebKit this failed before the fix (64 px apart at 13 px); Linux's fonts give 18.85 px rows either way.
//   BROWSER=webkit|firefox|chromium PLAYWRIGHT=<playwright's dir> node web/latex/test-latex-webkit-wrap.mjs   (CI: WebKit)
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const dist = join(new URL(".", import.meta.url).pathname, "..", "dist");
if (!existsSync(join(dist, "sagebrush-latex.js"))) { console.error("no web/dist/sagebrush-latex.js: run `bun web/build.ts` first"); process.exit(1); }
const ENGINE = process.env.BROWSER ?? "webkit";
let failures = 0, checks = 0;
const ok = (c, what, got) => { checks++; console.log((c ? "ok   " : "FAIL ") + what + (!c && got !== undefined ? "  " + JSON.stringify(got).slice(0, 500) : "")); if (!c) failures++; };

const long = "In this frame we explain the main idea at some length, so that the source line wraps several times in the pane.";
const code = "counts = table([['$p$'] + small, [r'$\\#E(\\mathbb{F}_p)$'] + [p + 1 \u2212 E.ap(p) for p in small], ['$a_p$'] + [E.ap(p) for p in small]])";
const frames = Array.from({ length: 12 }, (_, i) => `\\begin{frame}{Frame ${i}}\n  ${long}\n${code}\n\n  \\begin{itemize}\n    \\item Second % a comment\n  \\end{itemize}\n\\end{frame}\n`).join("\n");
const TEXT = `\\documentclass{beamer}\n\\begin{document}\n${frames}\n\\end{document}\n`;
const html = `<!doctype html><meta charset=utf-8><body style="margin:0"><div id=r style="position:fixed;inset:0"></div><script type=module>
import { mountEditor } from "/sagebrush-latex.js";
window.E = mountEditor(document.getElementById("r"), { text: ${JSON.stringify(TEXT).replace(/</g, "\\u003c")} });
window.ready = true;
</script>`;
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const server = createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
  const f = normalize(join(dist, p));
  if (!f.startsWith(dist) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const require = createRequire(join(process.env.PLAYWRIGHT ?? process.cwd(), "package.json"));
const pw = require("playwright");
const browser = await pw[ENGINE].launch();
const frame = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";
// (the Source sizes, as A+ sets them on the page: --tex-src-fs)
const SIZES = [13, 15, 17, 19, 21, 24];

try {
  const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  p.on("pageerror", (e) => { if (!/ResizeObserver loop/.test(String(e))) errors.push(String(e)); });
  await p.goto(base + "/");
  await p.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  await p.waitForTimeout(600);
  // (the lines behind take no height of their own: the rows are the text's, whatever the fonts round them to)
  const own = await p.evaluate(() => [...new Set([...document.querySelectorAll(".tex-hl .hl-line")].map((d) => getComputedStyle(d).minHeight))]);
  ok(own.every((m) => m === "0px" || m === "auto"), `${ENGINE}: no line behind the textarea has a minimum height of its own`, own);
  // (an empty line: one row, as tall as a one-row line of text)
  const rows = await p.evaluate(() => { const ls = [...document.querySelectorAll(".tex-hl .hl-line")]; const one = ls.find((d) => d.textContent === "\\begin{document}"), empty = ls.find((d) => d.textContent === "\u200b"); return { one: one?.getBoundingClientRect().height, empty: empty?.getBoundingClientRect().height }; });
  ok(rows.one > 0 && rows.empty === rows.one, `${ENGINE}: an empty line is one row, as tall as a one-row line of text`, rows);
  const at = (fs, w) => p.evaluate(async ([fs, w, frame]) => {
    const s = document.querySelector(".tex-src"), h = document.querySelector(".tex-hl"), page = s.closest(".tex-page"), left = document.querySelector(".tex-left");
    page.style.setProperty("--tex-src-fs", `${fs}px`);
    left.style.flex = w ? `0 0 ${w}px` : ""; left.style.width = w ? `${w}px` : "";
    await eval(frame); await eval(frame);
    return { fs, w, srcH: s.scrollHeight, hlH: h.scrollHeight, line: parseFloat(getComputedStyle(s).lineHeight) };
  }, [fs, w, frame]);
  const bad = [];
  for (const fs of SIZES) for (const w of [0, 260, 340, 420, 520, 640, 760, 900]) { const r = await at(fs, w); if (Math.abs(r.srcH - r.hlH) >= 1) bad.push(r); }
  await at(13, 0);
  ok(bad.length === 0, `${ENGINE}: at each Source size A+ gives (${SIZES.join(", ")} px) and pane widths from 260 to 900 px, the textarea and the lines behind it the same height`, bad.slice(0, 6));
  // (typing below the wrapped lines, at the largest size: still the same height, scrolled together)
  await at(24, 0);
  await p.evaluate(() => { const s = document.querySelector(".tex-src"); const i = s.value.indexOf("\\item Second", s.value.indexOf("Frame 9")); s.focus(); s.setSelectionRange(i, i); });
  await p.keyboard.type("TYPED ");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(400);
  const t = await p.evaluate(() => { const s = document.querySelector(".tex-src"), h = document.querySelector(".tex-hl"); return { srcH: s.scrollHeight, hlH: h.scrollHeight, srcTop: s.scrollTop, hlTop: h.scrollTop }; });
  ok(Math.abs(t.srcH - t.hlH) < 1 && t.srcTop === t.hlTop && t.srcTop > 0, `${ENGINE}: typing below the wrapped lines at 24 px: still the same height, scrolled together`, t);
  ok(errors.length === 0, `${ENGINE}: no page errors`, errors);
  await p.close();
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `FAIL: ${failures} of ${checks} checks` : `ok: the LaTeX source pane's layers in ${ENGINE}, ${checks} checks`);
process.exit(failures ? 1 : 0);
