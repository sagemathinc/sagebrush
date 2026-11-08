// ci: web-browser/terminal.1 order=50 runner=bun
// The Terminal's palette (web/shell/palette.ts; E5.3, board's TP-9, kept from the old renderer's test for the Terminal
// on xterm): both themes' contrast, computed from the CSS the panel injects and xterm reads back as its theme: each of
// the 16 colours >= 4.5:1 on its theme's background (min 4.91 light, 6.15 dark), and the system setting's dark block
// the same as the chosen dark.
//   bun web/shell/test-panel-palette.mjs
import { palette } from "./palette.ts";

let checks = 0, fails = 0;
const check = (c, what) => { checks++; if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${what}`); };
const css = palette();
const blocks = [...css.matchAll(/\{([^{}]*--sb-term-c0[^{}]*)\}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/--sb-term-(\w+):(#[0-9a-f]{6})/g)].map((x) => [x[1], x[2]]))).filter((b) => b.c0 && b.bg);
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const L = (h) => 0.2126 * lin(parseInt(h.slice(1, 3), 16)) + 0.7152 * lin(parseInt(h.slice(3, 5), 16)) + 0.0722 * lin(parseInt(h.slice(5, 7), 16));
const cr = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
check(blocks.length === 3 && JSON.stringify(blocks[1]) === JSON.stringify(blocks[2]), `the palette: light, dark, and dark again for the system setting (${blocks.length} blocks)`);
for (const [name, t, minWant] of [["light", blocks[0], 4.91], ["dark", blocks[1], 6.15]]) {
  const ratios = Array.from({ length: 16 }, (_, i) => cr(t["c" + i], t.bg));
  const min = Math.min(...ratios);
  check(min >= 4.5 && Math.abs(min - minWant) < 0.005, `${name}: every colour >= 4.5:1 on the background (min ${min.toFixed(2)})`);
  check(cr(t.fg, t.bg) >= 7, `${name}: the text colour on the background >= 7:1 (${cr(t.fg, t.bg).toFixed(2)})`);
}
console.log(`${checks - fails}/${checks} checks passed`);
if (fails) process.exit(1);
