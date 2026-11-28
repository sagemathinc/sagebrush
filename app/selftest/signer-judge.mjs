// The signer probe's verdict (N1; app/src-tauri/src/signer.rs, run.mjs "signer"): from the app's own log (signer.rs's
// "[signer] dispatch …" and "[signer] signed …" lines, one per call that reached the signing command and per signature)
// and what the other local server's pages said to it, whether each run showed what it must.  Each expectation is
// written out, with the number of calls that reached the command (dispatches) and of signatures:
//   - no control: the approvals window's own page signs once (the positive), and nothing else reaches the command at
//     all: dispatches 1, signatures 1, both the signer window's;
//   - "cap" (the command in the page's capability too): the main page's call reaches the command (dispatches from
//     other windows >= 1), and the command's own caller check refuses it: signatures 1, the signer window's;
//   - "cap+check" (that, and no caller check): another window's call signs (signatures from other windows >= 1): the
//     probe sees the path it checks;
//   - "csp-off" (the signer's page without its CSP, framing the other server's page): that page loaded in the frame,
//     and said what its signing call got (refused), and still nothing of it reached the command: dispatches 1,
//     signatures 1, the signer window's own;
//   - "guard-off" (the signer window's navigation guard left out, the window sent to the other server): that page
//     loaded in the signer window and said what its signing call got (refused), and nothing of it reached the command:
//     dispatches 1, signatures 1.
// In every run each caller the probe claims must have run and reported: the second window opened and its call
// answered (in the app's log, "[page] signer second window: …"), and in the csp-off and guard-off controls the other
// server's page loaded where the control puts it and said what its signing call got; a result that is missing, or comes
// after the run, fails by name.  (A frame of the other server in the main window is never claimed: on macOS and Linux
// that window's navigation guard refuses it before it loads, nav.rs may_load; on Windows it loads and the exact-origin
// capability refuses its calls. The "nav" probe and its controls show both.)
// In every run the other server's pages must have reached nothing ("REACHED" in what they said), and in every run but
// "cap+check" the main page's own call, a page's signer_open and an output frame's call must have been refused.  And in
// every run the app must have ended cleanly: exit 0, no signal, its output captured to the end (no timeout), so a run
// that printed every expected line and then crashed, was killed or timed out never passes.  And the self-test's state
// check ("[signer] state check sent", signer.rs) may only ever run on the signer's own page: each one must follow a
// finished load of that page (tauri://localhost, or http://tauri.localhost on Windows), never another page the window
// loaded (the guard-off control's destination) and never with no load before it.  On that page, in every run, it
// must find the page's own document with its script run ("ran=yes", "body=yes", on tauri: or Windows' http:), so a
// page that never loaded fails by name.  The launch's cleanup must have removed the previous launch's leftover the
// self-test puts there ("[signer] startup data folder: removed").  And once the app has quit, the approvals window's
// web view data folder (`left`: its entries, or null if it's gone) must be gone: nothing at all left, a framework's
// empty profile included (and anything like stored web data is named: cookies, storage, databases, caches, sessions,
// service workers, history).
export function signerLog(err) {
  const dispatches = [...err.matchAll(/^\[signer\] dispatch (\d+) from (\S+) at (\S+)$/gm)].map((m) => ({ n: +m[1], label: m[2], origin: m[3] }));
  const signed = [...err.matchAll(/^\[signer\] signed (\d+) \(signature (\d+)\) for (\S+)$/gm)].map((m) => ({ n: +m[1], label: m[3] }));
  return { dispatches, signed };
}

/** The state checks sent on a page other than the signer's own (each with the page last loaded, or "none"). */
export function stateChecksElsewhere(err) {
  const bad = [];
  let last = "none";
  for (const l of err.split("\n")) {
    const p = /^\[signer\] page (started|finished) (\S+)$/.exec(l);
    if (p) last = `${p[1]} ${p[2]}`;
    else if (l === "[signer] state check sent" && !/^finished (null|http:\/\/tauri\.localhost|https:\/\/tauri\.localhost)\/signer\/(index|probe-nocsp)\.html$/.test(last)) bad.push(last);
  }
  return bad;
}

/** The leftover entries that look like stored web data. */
export const STORED = /cookie|storage|indexeddb|database|cache|session|service ?worker|history|login|web ?data|leveldb|\.ldb$|\.sqlite|\.db$|\.db-|hsts/i;
export function storedLeft(left) {
  return (left ?? []).filter((e) => STORED.test(e));
}

export function signerVerdict({ err, out, seen, control, code, signal, problems, left = null }) {
  const { dispatches, signed } = signerLog(err);
  const why = [];
  const elsewhere = stateChecksElsewhere(err);
  if (elsewhere.length) why.push(`the state check ran on another page than the signer's: ${elsewhere.join("; ")}`);
  const states = [...err.matchAll(/^\[signer\] state: (.*)$/gm)].map((m) => m[1]).filter((x) => x !== "not-signer-page");
  if (!states.some((x) => /^ready=complete probe=yes tauri=yes ran=yes protocol=(tauri|http) body=yes$/.test(x))) {
    why.push(`the approvals window's page wasn't its own document with its script run (state: ${states.join("; ") || "none"})`);
  }
  if (!/^\[signer\] startup data folder: removed$/m.test(err)) why.push(`the launch's cleanup didn't remove the previous launch's leftover (${/^\[signer\] startup data folder: (.*)$/m.exec(err)?.[1] ?? "no line"})`);
  if (left !== null) {
    const stored = storedLeft(left);
    why.push(`the approvals window's data folder was still there after the app quit (${left.length} entries${stored.length ? `, stored web data: ${stored.slice(0, 20).join(", ")}` : ""})`);
  }
  if (code !== 0 || signal != null || (problems ?? []).length) why.push(`the app didn't end cleanly (exit ${code}, signal ${signal ?? "none"}${(problems ?? []).length ? `; ${problems.join("; ")}` : ""})`);
  const fromSigner = (xs) => xs.filter((x) => x.label === "signer");
  const fromOthers = (xs) => xs.filter((x) => x.label !== "signer");
  const reached = seen.filter((s) => /REACHED/.test(s));
  if (reached.length) why.push(`the other server's pages reached a command: ${reached.join("; ")}`);
  const line = /^(ok|FAIL) persist: signer at .*$/m.exec(out)?.[0] ?? "";
  if (!line.startsWith("ok")) why.push(`the main page's probe didn't report (${line || "no line"})`);
  // (every caller the probe claims must have run and said so: a result missing, or late past the run, fails by name)
  if (!/; second window opened$/.test(line)) why.push(`the second window didn't open (${/; second window ([^;]*)$/.exec(line)?.[1] ?? "not said"})`);
  const second = /^\[page\] signer second window: (REACHED|refused)\b.*$/m.exec(err);
  if (!second) why.push("the second window's call didn't report");
  else if (control !== "cap+check" && second[1] !== "refused") why.push(`the second window's call: ${second[1]}, not refused`);
  if (control !== "cap+check") {
    for (const what of ["this page's signing call", "a page's signer_open", "an output frame's"]) {
      const m = new RegExp(`${what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (REACHED|refused|\\(no answer\\))`).exec(line);
      if (!m || m[1] !== "refused") {
        // ("cap": the main page's call reaches the command, which refuses it: its page sees it refused too)
        why.push(`${what}: ${m?.[1] ?? "not said"}, not refused`);
      }
    }
  }
  if (fromSigner(signed).length !== 1) why.push(`the approvals window's page signed ${fromSigner(signed).length} times, not once (the positive)`);
  switch (control ?? "") {
    case "":
    case "csp-off":
    case "guard-off":
      if (dispatches.length !== 1 || fromOthers(dispatches).length) why.push(`dispatches ${dispatches.length} (${fromOthers(dispatches).length} not the signer window's), not exactly the signer page's 1`);
      if (signed.length !== 1) why.push(`signatures ${signed.length}, not 1`);
      if (control === "csp-off" && !seen.includes("sframe: loaded")) why.push("the other server's page didn't load in the signer page's frame: the control didn't run");
      if (control === "csp-off" && !seen.some((x) => /^sframe: signer (refused|REACHED)/.test(x))) why.push("the other server's page in the signer page's frame didn't report its signing call: the control didn't finish");
      if (control === "guard-off" && !seen.includes("stop: loaded")) why.push("the other server's page didn't load in the signer window: the control didn't run");
      if (control === "guard-off" && !seen.some((x) => /^stop: signer (refused|REACHED)/.test(x))) why.push("the other server's page in the signer window didn't report its signing call: the control didn't finish");
      break;
    case "cap":
      if (!fromOthers(dispatches).length) why.push("no call from another window reached the command: the weakened capability didn't take");
      if (fromOthers(signed).length) why.push(`another window's call signed (${fromOthers(signed).map((s) => s.label).join(", ")}): the caller check didn't hold`);
      break;
    case "cap+check":
      if (!fromOthers(signed).length) why.push("no other window's call signed with both guards left out: the probe doesn't see the path it checks");
      break;
    default:
      why.push(`no such control ${JSON.stringify(control)}`);
  }
  return { ok: !why.length, why, counts: { dispatches: dispatches.length, dispatchesOthers: fromOthers(dispatches).length, signed: signed.length, signedOthers: fromOthers(signed).length } };
}
