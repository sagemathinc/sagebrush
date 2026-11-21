// The chat's code blocks in colour: each fenced block of a message highlighted as the code page highlights a file
// (web/code/tokens.ts: Python and Sage, MATLAB, Magma, JavaScript, JSON), the notebook's classes (hc comment, hs
// string, hn number, hk keyword, hb builtin, hf a name being defined). The fence's language says which; a fence without
// one, or with one these don't know, is guessed from the code ("even wrong is better than nothing. It's just color.",
// William, Nov 20). The tokens join to the code exactly, so only the colour changes, never the text.
import { tokensOf, type Lang } from "../code/tokens";

// (a fence's language, by its usual names; C-like languages take the JavaScript scanner, the shells Python's)
const NAMES: Record<string, Lang> = {
  python: "python", py: "python", python3: "python", ipython: "python", pycon: "python",
  sh: "python", bash: "python", shell: "python", zsh: "python", console: "python", toml: "python", yaml: "python", yml: "python",
  sage: "sage", sagemath: "sage", gp: "sage", pari: "sage",
  matlab: "matlab", octave: "matlab", m: "matlab",
  magma: "magma",
  js: "js", javascript: "js", mjs: "js", node: "js", ts: "js", typescript: "js", jsx: "js", tsx: "js",
  c: "js", h: "js", cpp: "js", "c++": "js", java: "js", rust: "js", rs: "js", go: "js", css: "js", scss: "js",
  json: "json", jsonc: "json", json5: "json",
  text: "text", txt: "text", plain: "text", plaintext: "text", output: "text",
};

/** A block's language: the fence's, if it's one of NAMES; else a guess from the code. */
export function blockLang(code: string, fence: string): Lang {
  const name = fence.trim().toLowerCase().split(/[\s{,]/)[0];
  if (name && Object.hasOwn(NAMES, name)) return NAMES[name];
  return guessLang(code);
}

/** A guess at the language of `code`, from a few strong signs; Sage (Python's tokens, Sage's names) by default. */
export function guessLang(code: string): Lang {
  const t = code.trim();
  if (/^[[{]/.test(t)) { try { JSON.parse(t); return "json"; } catch {} }
  if (/^\s*%/m.test(code) || (/^\s*function\b[^\n]*=/m.test(code) && /^\s*end\b/m.test(code))) return "matlab";
  if (/:=/.test(code) && /;\s*$/m.test(code)) return "magma";
  if (/\b(?:const|let|var)\s+\w|=>|^\s*function\s+\w+\s*\(|\bconsole\.log\b/m.test(code) || /;\s*$/m.test(code) && !/^\s*(?:def|import|from)\b/m.test(code)) return "js";
  return "sage";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A block's HTML for markdown's highlight hook: escaped text, and <span class="hX"> for each coloured token. */
export function colorBlock(code: string, fence: string): string {
  return tokensOf(code, blockLang(code, fence)).map(([cls, text]) => (cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text))).join("");
}
