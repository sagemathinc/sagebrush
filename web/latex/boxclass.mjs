// The page test's box class: "timing" (VM3/VM4) gates its timing assertions, "build" records them. An explicit input,
// never detected. The run packet's frozen BOXCLASS (beside the trees) WINS whenever it exists: an inherited
// LATEX_BOX_CLASS can neither turn a timing packet report-only nor a build packet timing-gated; it is used only where
// there is no packet file (a run by hand). Pure: the caller passes the environment's value and the file's text (or
// null when there is no file); the result is {box} or {error}.
export function boxClass(envValue, fileText) {
  const ok = (v) => v === "build" || v === "timing";
  if (fileText !== null && fileText !== undefined) {
    const f = String(fileText).trim();
    if (!ok(f)) return { error: "the packet's BOXCLASS is " + JSON.stringify(f) + ", not build or timing" };
    const note = envValue && envValue !== f ? "LATEX_BOX_CLASS " + JSON.stringify(envValue) + " ignored: the packet's BOXCLASS wins" : "";
    return { box: f, note };
  }
  if (ok(envValue)) return { box: envValue, note: "" };
  return { error: "no box class: no packet BOXCLASS, and LATEX_BOX_CLASS is " + JSON.stringify(envValue ?? "") + ", not build or timing" };
}
