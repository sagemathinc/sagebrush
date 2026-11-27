// The LaTeX editor's build mode, as web/build.ts writes it into version.json (latexMode) and as the size check of
// latex_build's first use (web/workspace/test-agent-run-size.mjs) reads it. Read by the build script and that test
// only, never bundled.

/** version.json's latexMode for SAGEBRUSH_LATEX_PREVIEW ("0", "1" or "test", the build's own default "1" applied):
 *  "off", "shipped" or "test" (the build with the LaTeX tests' seams); throws on anything else. */
export function latexModeName(mode) {
  if (mode === "test") return "test";
  if (mode === "1") return "shipped";
  if (mode === "0") return "off";
  throw new Error(`SAGEBRUSH_LATEX_PREVIEW must be unset, 0, 1 or test, not ${JSON.stringify(mode)}`);
}

/** Whether a check run with this SAGEBRUSH_LATEX_PREVIEW expects the editor in the build: unset, empty or "1" (the
 *  build's default) yes; "0" no; "test" no (a test build is refused by its mode anyway). */
export function expectsLatex(env) {
  return !["0", "test"].includes(env ?? "");
}
