// The board's palette (plan-board-dark r2 §2, step 1): every color board.css
// and the canvas use is one of the custom properties board.css defines on
// :where(.sbb, .sbb-layer), the canvas's with palette.ts's LIGHT values
// exactly (so light draws as before), and readPalette takes each property,
// else LIGHT's.
//   bun web/board/test-palette.mjs
import { readFileSync } from "node:fs";
import { LIGHT, PALETTE_VARS, readPalette } from "./palette.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const here = new URL(".", import.meta.url);

// board.ts: no color but the palette's (a line holding a document's own colors says so)
const ts = readFileSync(new URL("board.ts", here), "utf8").split("\n");
const literal = ts.map((l, i) => [i + 1, l]).filter(([, l]) => COLOR.test(l.replace(/\/\/.*$/, "")) && !l.includes("palette-exempt"));
check(literal.length === 0, "board.ts draws with the palette, no color of its own: " + literal.map(([n, l]) => n + ": " + l.trim()).join(" | "));

// board.css: the definitions, and no color outside them (Find's ::highlight aside)
const css = readFileSync(new URL("board.css", here), "utf8");
const def = /:where\(\.sbb, \.sbb-layer\) \{([^{}]*)\}/.exec(css);
check(!!def, "board.css defines its colors on :where(.sbb, .sbb-layer)");
const defs = new Map();
for (const m of (def?.[1] ?? "").replace(/\/\*.*?\*\//gs, "").matchAll(/(--board-[a-z0-9-]+):\s*([^;]+);/g)) {
  check(!defs.has(m[1]), "defined once: " + m[1]);
  defs.set(m[1], m[2].trim());
}
check(defs.size > 90, "board.css's variables: " + defs.size);
const rest = css.slice(0, def?.index ?? 0) + css.slice((def?.index ?? 0) + (def?.[0].length ?? 0));
const rules = [...rest.replace(/\/\*.*?\*\//gs, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const stray = rules.filter(([, sel, body]) => COLOR.test(body) && sel.trim() !== "::highlight(sb-find)").map(([, sel]) => sel.trim());
check(stray.length === 0, "every color in board.css is a variable: " + stray.join(" | "));
const used = new Set([...rest.matchAll(/var\((--board-[a-z0-9-]+)\)/g)].map((m) => m[1]));
const undef = [...used].filter((v) => !defs.has(v));
check(undef.length === 0, "every variable used is defined: " + undef.join(", "));

// the canvas's: defined, with LIGHT's values
for (const [k, v] of Object.entries(PALETTE_VARS)) check(defs.get(v) === LIGHT[k], `${k}: board.css's ${v} (${defs.get(v)}) is LIGHT's ${LIGHT[k]}`);
check(Object.keys(PALETTE_VARS).length === Object.keys(LIGHT).length, "every color the canvas draws with has its property");

// readPalette: a property set is taken (trimmed); one missing or empty is LIGHT's
const style = { "--board-edge": " #123456", "--board-ink": "" };
globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => style[n] ?? "" });
const p = readPalette({});
check(p.edge === "#123456", "a property's value is drawn with: " + p.edge);
check(p.ink === LIGHT.ink && p.group === LIGHT.group, "a missing or empty one is LIGHT's");
check(Object.isFrozen(LIGHT) && LIGHT.edge === "#5f7457", "LIGHT is not changed by reading");

if (fails.length) { console.error(fails.map((f) => "FAIL " + f).join("\n")); process.exit(1); }
console.log(`palette: ${checks} checks pass`);
