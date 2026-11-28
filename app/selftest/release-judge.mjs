// A build without the self-test's controls (C1, the native signing design note; app/src-tauri/src/lib.rs
// SELFTEST_CONTROLS): the release build has none of the controls that leave a guard out, nor the stand-in signing
// command, whatever environment it is started with.  run.mjs reads which build it has from the app's own line, and for
// a build without them checks that:
//   - the executable holds none of the controls' names (CONTROL_NAMES);
//   - started with the controls' variables set (SAGEBRUSH_APP_SIGNER_CONTROL=cap+check, SAGEBRUSH_APP_NAV_CONTROL=wide),
//     it still refuses: no call reaches a signing command and nothing signs, the approvals window isn't opened by the
//     self-test's probe, the main page's signing call is refused, and the other server's pages reach nothing.
/** K3: why a run that expects the release build (SAGEBRUSH_EXPECT_RELEASE=1, the signed job's) fails, or null. */
export function expectation(expectRelease, controls) {
  return expectRelease === "1" && controls !== "out" ? `this run expects the release build (SAGEBRUSH_EXPECT_RELEASE=1), and the app says its controls are ${controls === "in" ? "compiled in" : "(not said)"}` : null;
}

/** The build's own word: "in", "out", or null if it didn't say. */
export function controlsMode(err) {
  return /^\[app\] self-test controls: compiled (in|out)$/m.exec(err)?.[1] ?? null;
}

/** What only the controls' code holds: none of these may be in a release executable, and the self-test's build holds
 * every one (run.mjs checks both, so the search is shown to see what it looks for).  The controls' variables, the
 * nav control's widened origin, and the stand-in command's log lines: a control's own short name ("cap+check") isn't
 * listed, since a compiler may compare it as an integer and keep no copy of its text. */
export const CONTROL_NAMES = ["SAGEBRUSH_APP_SIGNER_CONTROL", "SAGEBRUSH_APP_NAV_CONTROL", "http://127.0.0.1:*", "[signer] dispatch ", "[signer] signed "];
/** The names of CONTROL_NAMES that `bytes` (a Buffer) holds. */
export function controlNamesIn(bytes) {
  return CONTROL_NAMES.filter((n) => bytes.includes(Buffer.from(n, "latin1")));
}

/** The verdict on a release build's signer launch with SAGEBRUSH_APP_SIGNER_CONTROL=cap+check set. */
export function releaseSignerVerdict({ err, out, seen, code, signal, problems }) {
  const why = [];
  const dispatched = err.split("\n").filter((l) => /^\[signer\] (dispatch|signed|caller) /.test(l));
  if (dispatched.length) why.push(`a call reached the signing command: ${dispatched.slice(0, 5).join("; ")}`);
  const pages = err.split("\n").filter((l) => /^\[signer\] (page|state)/.test(l));
  if (pages.length) why.push(`the self-test's probe opened the approvals window: ${pages.slice(0, 3).join("; ")}`);
  const reached = seen.filter((s) => /REACHED/.test(s));
  if (reached.length) why.push(`the other server's pages reached a command: ${reached.join("; ")}`);
  const line = /^(ok|FAIL) persist: signer at .*$/m.exec(out)?.[0] ?? "";
  if (!line) why.push("the main page's probe didn't report");
  else if (!/this page's signing call refused/.test(line)) why.push(`the main page's signing call wasn't refused (${line})`);
  if (code !== 0 || signal != null || (problems ?? []).length) why.push(`the app didn't end cleanly (exit ${code}, signal ${signal ?? "none"}${(problems ?? []).length ? `; ${problems.join("; ")}` : ""})`);
  return { ok: !why.length, why };
}
