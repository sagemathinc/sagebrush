// sagebrush-math.js in a LaTeX build (web/build.ts, SAGEBRUSH_LATEX_PREVIEW set): web/math.ts unchanged, plus KaTeX's
// renderToString for the LaTeX editor's worker, from the same copy of KaTeX (no second copy in the LaTeX files).
// A build without the flag uses web/math.ts itself, byte for byte as before.
export { typeset } from "../math";
export { renderToString } from "katex";
