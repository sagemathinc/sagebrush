// Code in the overlay and on objects' faces, highlighted by Sagebrush's one highlighter (web/code/tokens.ts: the
// notebook's own for Python, Sage and MATLAB, a small scanner for Magma, JavaScript and TypeScript, JSON and Rust),
// drawn as text nodes only; and editable as highlighted text (a textarea over the highlighted copy of what it holds).
import { tokensOf, drawTokens, type Lang, type Tok } from "../../code/tokens.ts";

// (a space's `lang`, or a file's extension, as the highlighter's language; TypeScript reads as JavaScript)
const LANG: Record<string, Lang> = {
  python: "python", py: "python", sage: "sage", magma: "magma", matlab: "matlab", m: "matlab",
  js: "js", javascript: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", typescript: "js", mts: "js", cts: "js", tsx: "js",
  json: "json", rust: "rust", rs: "rust",
};
export const langOf = (lang: string | null | undefined): Lang => LANG[String(lang ?? "").toLowerCase()] ?? "text";

/** `code`, highlighted, into `el` (its children replaced; nothing parsed as HTML). */
export function drawCode(el: HTMLElement, code: string, lang: string | null | undefined): void {
  drawTokens(el, tokensOf(code, langOf(lang)));
}

export type Editor = { value: string; lang: string; focus(): void };
/** An editor in `el`: its value, its language, focus(); onRun on Shift+Enter or Ctrl+Enter. */
export function editor(el: HTMLElement, { value, lang, onRun, onChange }: { value?: string; lang?: string; onRun?: () => void; onChange?: (v: string) => void }): Editor {
  el.classList.add("editor");
  const doc = el.ownerDocument;
  const pre = doc.createElement("pre"), code = doc.createElement("code"), ta = doc.createElement("textarea");
  pre.className = "hl";
  pre.setAttribute("aria-hidden", "true");
  pre.append(code);
  ta.spellcheck = false;
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("autocomplete", "off");
  el.replaceChildren(pre, ta);
  let language = lang ?? "";
  const paint = () => {
    // (a final newline, so an empty last line has height, as the textarea's does)
    drawCode(code, ta.value + "\n", language);
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight, 60) + "px";
  };
  ta.value = value ?? "";
  ta.addEventListener("input", () => { paint(); onChange?.(ta.value); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); onRun?.(); }
    else if (e.key === "Tab") {
      e.preventDefault();
      ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end");
      paint(); onChange?.(ta.value);
    }
    e.stopPropagation();
  });
  requestAnimationFrame(paint);
  return {
    get value() { return ta.value; },
    set value(v: string) { ta.value = v; paint(); },
    get lang() { return language; },
    set lang(l: string) { language = l; paint(); },
    focus() { ta.focus(); },
  };
}

// A text's lines as coloured runs, for a canvas (an object's face): the highlighter's classes in the page's colours,
// light or dark (hc comment, hs string, hn number, hk keyword, hb builtin, hf a name being defined, hd a decorator).
export type Run = { text: string; color: string | null };
const PALETTE: Record<"light" | "dark", Record<string, string>> = {
  light: { hk: "#cf222e", hb: "#cf222e", hf: "#8250df", hs: "#0a3069", hn: "#0550ae", hc: "#6e7781", hd: "#953800" },
  dark: { hk: "#ff7b72", hb: "#ff7b72", hf: "#d2a8ff", hs: "#a5d6ff", hn: "#79c0ff", hc: "#8b949e", hd: "#ffa657" },
};
export function codeRuns(code: unknown, lang: string | null | undefined, dark = false, maxLines = 400): Run[][] {
  const text = String(code ?? "").split("\n").slice(0, maxLines).join("\n");
  const pal = PALETTE[dark ? "dark" : "light"];
  const lines: Run[][] = [[]];
  for (const [cls, part] of tokensOf(text, langOf(lang)) as Tok[]) {
    part.split("\n").forEach((piece, i) => {
      if (i) lines.push([]);
      if (piece) lines[lines.length - 1].push({ text: piece, color: pal[cls] ?? null });
    });
  }
  return lines;
}
