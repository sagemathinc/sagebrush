// Code in the overlay: highlighted (highlight.js, a few languages bundled), and editable as highlighted text (a
// textarea over the highlighted copy of what it holds).
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import matlab from "highlight.js/lib/languages/matlab";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("json", json);
hljs.registerLanguage("matlab", matlab);

// (Sage is Python with a few extras; Magma has no grammar here: Python's is close enough to read)
const LANG = { sage: "python", magma: "python", py: "python", ts: "typescript", js: "javascript", mjs: "javascript", rs: "rust", m: "matlab" };
export const langOf = (lang) => (lang = LANG[lang] ?? lang) && hljs.getLanguage(lang) ? lang : null;

export function highlight(code, lang) {
  const l = langOf(lang);
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return l ? hljs.highlight(code, { language: l, ignoreIllegals: true }).value : esc(code);
}

/** An editor in `el`: returns {get value(), set value(v), set lang(l), focus()}; onRun on Shift+Enter or Ctrl+Enter */
export function editor(el, { value, lang, onRun, onChange }) {
  el.classList.add("editor");
  el.innerHTML = '<pre class="hl" aria-hidden="true"><code></code></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>';
  const ta = el.querySelector("textarea"), code = el.querySelector("code");
  let language = lang;
  const paint = () => {
    // (a final newline, so an empty last line has height, as the textarea's does)
    code.innerHTML = highlight(ta.value, language) + "\n";
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight, 60) + "px";
  };
  ta.value = value ?? "";
  ta.addEventListener("input", () => { paint(); onChange?.(ta.value); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); onRun?.(); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const a = ta.selectionStart;
      ta.setRangeText("    ", a, ta.selectionEnd, "end");
      paint(); onChange?.(ta.value);
    }
    e.stopPropagation();
  });
  requestAnimationFrame(paint);
  return {
    get value() { return ta.value; },
    set value(v) { ta.value = v; paint(); },
    set lang(l) { language = l; paint(); },
    focus() { ta.focus(); },
  };
}

// A text's lines as coloured runs, for a canvas (an object's face, the headset's reading panel): highlight.js's
// classes in GitHub's colours (as the page's CSS has them), light or dark. Read from an inert parse of its output.
const PALETTE = {
  light: { keyword: "#cf222e", built_in: "#cf222e", type: "#cf222e", title: "#8250df", string: "#0a3069", regexp: "#0a3069", number: "#0550ae",
    literal: "#0550ae", attr: "#0550ae", symbol: "#0550ae", variable: "#0550ae", comment: "#6e7781", quote: "#6e7781", meta: "#953800" },
  dark: { keyword: "#ff7b72", built_in: "#ff7b72", type: "#ff7b72", title: "#d2a8ff", string: "#a5d6ff", regexp: "#a5d6ff", number: "#79c0ff",
    literal: "#79c0ff", attr: "#79c0ff", symbol: "#79c0ff", variable: "#79c0ff", comment: "#8b949e", quote: "#8b949e", meta: "#ffa657" },
};
export function codeRuns(code, lang, dark = false, maxLines = 400) {
  const text = String(code ?? "").split("\n").slice(0, maxLines).join("\n");
  const pal = PALETTE[dark ? "dark" : "light"];
  // (in a div: a <pre> would drop a newline right after its start, and with it a leading blank line)
  const doc = new DOMParser().parseFromString(`<div>${highlight(text, lang)}</div>`, "text/html");
  const lines = [[]];
  const walk = (node, color) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        ch.nodeValue.split("\n").forEach((part, i) => { if (i) lines.push([]); if (part) lines[lines.length - 1].push({ text: part, color }); });
      } else if (ch.nodeType === 1) {
        const cls = [...ch.classList].map((c) => c.replace(/^hljs-/, "")).find((c) => pal[c]);
        walk(ch, cls ? pal[cls] : color);
      }
    }
  };
  walk(doc.body.firstElementChild, null);
  return lines;
}
