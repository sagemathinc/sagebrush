// The self-test report's lines in an app's output (run.mjs): the check lines
// ("ok   …", "FAIL …"), the diagnosis lines ("info <key>: <value>") and "all
// passed", in order, CR removed (Windows); anything else the app printed is
// left out.  The pass/fail verdict stays run.mjs's (exit code 0 and "all
// passed"); the info lines never change it.
export function reportLines(out) {
  return out.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => /^(ok {3}|FAIL |info [a-z-]+: )/.test(l) || l === "all passed");
}
