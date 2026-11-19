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
