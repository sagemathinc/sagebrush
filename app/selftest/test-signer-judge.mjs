// ci: web-runner order=295 runner=bun
// The signer probe's verdict (app/selftest/signer-judge.mjs, N1): for each run (no control, and each control), a log
// that shows what it must passes, and each way it can fail is caught.
//   bun app/selftest/test-signer-judge.mjs
import { signerVerdict, signerLog } from "./signer-judge.mjs";
import { controlsMode, controlNamesIn, releaseSignerVerdict, CONTROL_NAMES } from "./release-judge.mjs";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
// (a dispatch, and its caller line: the calling document's origin, by default the window's own page's)
const d = (n, label, origin = label === "signer" ? "tauri://localhost" : "http://127.0.0.1:5", caller = origin) => `[signer] dispatch ${n} from ${label} at ${origin}` + (caller === null ? "" : `\n[signer] caller ${n}: ${caller}`);
const s = (n, k, label) => `[signer] signed ${n} (signature ${k}) for ${label}`;
const refusedLine = "ok persist: signer at http://127.0.0.1:5: this page's signing call refused: Command not allowed; a page's signer_open refused: Command not found; an output frame's refused: not allowed; second window opened";
const reachedLine = "ok persist: signer at http://127.0.0.1:5: this page's signing call REACHED probe-signature-2; a page's signer_open refused: Command not found; an output frame's refused: not allowed; second window opened";
// (every run's log ends with the signer page loaded and its state read, unless `bare`: the rows on those lines say so)
const GOOD_STATE = "[signer] state: ready=complete probe=yes tauri=yes ran=yes protocol=tauri body=yes";
const SECOND = "[page] signer second window: refused: Command not allowed";
const LOADED = [SECOND, "[signer] startup data folder: removed", "[signer] page started null/signer/index.html", "[signer] page finished null/signer/index.html", "[signer] state check sent", GOOD_STATE];
const FRAME = ["frame: requested", "frame: loaded", "frame: refused: not allowed", "frame: signer refused: not allowed"];
const v = (err, { out = refusedLine, seen = FRAME, control, code = 0, signal = null, problems = [], left = null, bare = false } = {}) => signerVerdict({ err: (bare ? err : [...err, ...LOADED]).join("\n"), out, seen, control, code, signal, problems, left });

ok(signerLog([d(1, "signer"), s(1, 1, "signer"), "[signer] refused 2: not the signer window's page", d(2, "main")].join("\n")).dispatches.length === 2, "the log's lines are read: dispatches and signatures");

// no control
ok(v([d(1, "signer"), s(1, 1, "signer")]).ok, "no control: the signer page's one signature, nothing else reaching the command: passes");
ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "main"), "[signer] refused 2: not the signer window's page"]).ok, "no control: another window's call reaching the command at all fails (the capability must refuse it before)");
ok(!v([]).ok, "no control: the positive missing (the signer page didn't sign) fails");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { seen: ["frame: REACHED signer probe"] }).ok, "the other server's page reaching a command fails");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { out: reachedLine }).ok, "the main page's call answered (REACHED) fails, outside cap+check");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { out: "" }).ok, "no report from the main page fails");

// cap: dispatched, never signed
ok(v([d(1, "signer"), s(1, 1, "signer"), d(2, "main"), "[signer] refused 2: not the signer window's page", d(3, "doc-1")], { control: "cap" }).ok, "cap: other windows' calls reach the command, refused by its own check, the signer page's one signature: passes");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "cap" }).ok, "cap: no other window's call reaching the command (the weakening didn't take) fails");
ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "main"), s(2, 2, "main")], { control: "cap" }).ok, "cap: another window's call signing (the caller check didn't hold) fails");

// cap+check: the positive control
ok(v([d(1, "signer"), s(1, 1, "signer"), d(2, "main"), s(2, 2, "main")], { control: "cap+check", out: reachedLine }).ok, "cap+check: another window's call signs: passes (the probe sees the path it checks)");
ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "main")], { control: "cap+check", out: reachedLine }).ok, "cap+check: no other window signing fails");

// csp-off and guard-off: the other origin's page loaded there, and reached nothing
ok(v([d(1, "signer"), s(1, 1, "signer")], { control: "csp-off", seen: [...FRAME, "sframe: loaded", "sframe: refused: not allowed", "sframe: signer refused: not allowed"] }).ok, "csp-off: the other server's page loaded in the signer page's frame, and reached nothing: passes");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "csp-off" }).ok, "csp-off: the frame never loaded (the control didn't run) fails");
ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "signer", "http://127.0.0.1:9")], { control: "csp-off", seen: [...FRAME, "sframe: loaded"] }).ok, "csp-off: the framed page reaching the command fails");
ok(v([d(1, "signer"), s(1, 1, "signer")], { control: "guard-off", seen: [...FRAME, "stop: loaded", "stop: refused: not allowed", "stop: signer refused: not allowed"] }).ok, "guard-off: the other server's page loaded in the signer window, and reached nothing: passes");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "guard-off" }).ok, "guard-off: the page never loaded there fails");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "nonsense" }).ok, "an unknown control fails");

// frame+cap and the caller's origin (N1): the frame's call reaches the command in the signer window, on its page, and
// its check of the calling document refuses it
{
  const SF = [...FRAME, "sframe: loaded", "sframe: refused: not allowed", "sframe: signer refused: only the approvals window's page signs"];
  const framed = (n) => [d(n, "signer", "tauri://localhost", "http://127.0.0.1:9"), `[signer] refused ${n}: not the signer page's own document`];
  ok(v([d(1, "signer"), s(1, 1, "signer"), ...framed(2)], { control: "frame+cap", seen: SF }).ok, "frame+cap: the frame's call reaches the command and is refused by its origin check, the signer page's one signature: passes");
  ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "frame+cap", seen: SF }).ok, "frame+cap: no call from the frame reaching the command (the widening didn't take) fails");
  ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "signer", "tauri://localhost", "http://127.0.0.1:9"), s(2, 2, "signer")], { control: "frame+cap", seen: SF }).ok, "frame+cap: the frame's call signing (the origin check didn't hold) fails");
  ok(!v([d(1, "signer"), s(1, 1, "signer"), ...framed(2)], { control: "frame+cap" }).ok, "frame+cap: the frame never loaded fails");
  ok(!v([d(1, "signer"), s(1, 1, "signer"), ...framed(2)], { control: "frame+cap", seen: [...FRAME, "sframe: loaded"] }).ok, "frame+cap: the frame's own report of its call missing fails");
  ok(!v([d(1, "signer"), s(1, 1, "signer"), ...framed(2), d(3, "main"), "[signer] refused 3: not the signer window's page"], { control: "frame+cap", seen: SF }).ok, "frame+cap: another window's call reaching the command fails");
  // (any run but cap+check: a signature whose caller isn't the app protocol's, or isn't said, fails)
  ok(!v([d(1, "signer", "tauri://localhost", "null"), s(1, 1, "signer")]).ok, "no control: a signature for a sandboxed document's call (null) fails");
  ok(!v([d(1, "signer", "tauri://localhost", null), s(1, 1, "signer")]).ok, "no control: a signature whose caller isn't logged fails");
  ok(v([d(1, "signer", "http://tauri.localhost"), s(1, 1, "signer")]).ok, "no control: the signer page's signature on Windows' app origin: passes");
  ok(signerLog([d(4, "signer", "tauri://localhost", "http://127.0.0.1:9")].join("\n")).dispatches[0].caller === "http://127.0.0.1:9", "the caller line is read with its dispatch");
}

// the state check runs on the signer's own loaded page only (never the guard-off destination, a frame or nothing)
{
  const pg = (ev, at) => `[signer] page ${ev} ${at}`;
  const sent = "[signer] state check sent";
  const stop = [pg("started", "null/signer/index.html"), pg("finished", "null/signer/index.html"), sent, "[signer] state: ready=complete probe=yes tauri=yes ran=yes protocol=tauri body=yes", d(1, "signer"), s(1, 1, "signer"), pg("started", "http://127.0.0.1:9/stop"), pg("finished", "http://127.0.0.1:9/stop"), "[signer] state: not-signer-page"];
  ok(v(stop, { control: "guard-off", seen: [...FRAME, "stop: loaded", "stop: signer refused: not allowed"] }).ok, "the state check: once on the signer page, none on the guard-off destination: passes");
  ok(!v([...stop, sent], { control: "guard-off", seen: [...FRAME, "stop: loaded"] }).ok, "the state check: sent on the guard-off destination fails");
  ok(!v([sent, d(1, "signer"), s(1, 1, "signer")]).ok, "the state check: sent with no page loaded before it fails");
  ok(!v([pg("started", "null/signer/index.html"), sent, d(1, "signer"), s(1, 1, "signer")]).ok, "the state check: sent before the page finished loading fails");
  ok(!v([pg("finished", "http://127.0.0.1:9/sframe"), sent, d(1, "signer"), s(1, 1, "signer")], { control: "csp-off", seen: [...FRAME, "sframe: loaded"] }).ok, "the state check: sent on a frame's or another server's page fails");
  ok(!v([pg("finished", "null/index.html"), sent, d(1, "signer"), s(1, 1, "signer")]).ok, "the state check: sent on another app page fails");
  ok(v([pg("finished", "http://tauri.localhost/signer/index.html"), sent, d(1, "signer"), s(1, 1, "signer")]).ok && v([pg("finished", "null/signer/probe-nocsp.html"), sent, d(1, "signer"), s(1, 1, "signer")], { control: "csp-off", seen: [...FRAME, "sframe: loaded", "sframe: signer refused: not allowed"] }).ok, "the state check: on the signer page on Windows, and the csp-off page: passes");
}

// the signer page must be its own document with its script run (the Linux failure: an empty document, ran=no)
{
  const pre = [SECOND, "[signer] startup data folder: removed", "[signer] page finished null/signer/index.html", "[signer] state check sent"];
  const good = [d(1, "signer"), s(1, 1, "signer")];
  ok(!v([...pre, "[signer] state: ready=complete probe=yes tauri=yes ran=no protocol=other body=no", ...good], { bare: true }).ok, "the state: an empty document (ran=no protocol=other body=no, Linux on Nov 23) fails");
  ok(!v(good, { bare: true }).ok, "the state: no state line at all fails");
  ok(!v([...pre, "[signer] state: no-answer", ...good], { bare: true }).ok && !v([...pre, "[signer] state: unreadable", ...good], { bare: true }).ok, "the state: no-answer or unreadable fails");
  ok(!v([...pre, "[signer] state: ready=complete probe=yes tauri=yes ran=yes protocol=other body=yes", ...good], { bare: true }).ok, "the state: our page's script, but not on the app protocol, fails");
  ok(v([...pre, "[signer] state: ready=complete probe=yes tauri=yes ran=yes protocol=http body=yes", ...good], { bare: true }).ok, "the state: Windows' http://tauri.localhost passes");
  ok(v([...pre, GOOD_STATE, ...good], { bare: true }).ok, "the state: the page's own document, its script run: passes");
}

// once the app has quit, the approvals window's data folder is gone; the launch's cleanup removed the old one
{
  const good = [d(1, "signer"), s(1, 1, "signer")];
  ok(v(good, { left: null }).ok, "the data folder: gone: passes");
  ok(!v(good, { left: [] }).ok, "the data folder: there but empty fails (it must be gone)");
  ok(!v(good, { left: ["salt", "mediakeys/"] }).ok, "the data folder: other framework files left fail");
  ok(!v(["[signer] startup data folder: refused", ...LOADED.slice(1), ...good], { bare: true }).ok, "the launch's cleanup: refused (the leftover kept) fails");
  ok(!v([...LOADED.slice(1), ...good], { bare: true }).ok, "the launch's cleanup: no line fails");
  ok(!v(["[signer] startup data folder: absent", ...LOADED.slice(1), ...good], { bare: true }).ok, "the launch's cleanup: absent (the leftover not seen) fails");
  for (const bad of ["Cookies", "cookies.sqlite", "LocalStorage/", "Local Storage/leveldb/000003.log", "IndexedDB/", "Session Storage/", "CacheStorage/", "Cache/", "Service Worker/", "databases/", "storage/", "WebsiteData/hsts-storage.sqlite", "History", "Web Data", "Login Data", "x.db", "x.db-wal"]) {
    ok(!v(good, { left: ["ok-file", bad] }).ok, `the data folder: ${bad} left fails`);
  }
}

// (a review row: a run whose log shows everything it must, but whose app didn't end cleanly, never passes)
const good = [d(1, "signer"), s(1, 1, "signer")];
ok(!v(good, { code: 1 }).ok, "an otherwise passing run whose app exited 1 fails");
ok(!v(good, { code: null, signal: "SIGKILL" }).ok, "an otherwise passing run whose app was killed (a signal) fails");
ok(!v(good, { problems: ["the app did not report and end its output within 120 s"] }).ok, "an otherwise passing run that timed out fails");
ok(!v(good, { problems: ["the app's output did not end within 20 s of its exit"] }).ok, "an otherwise passing run whose output never ended fails");
ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "main"), s(2, 2, "main")], { control: "cap+check", out: reachedLine, code: 101 }).ok, "the positive control with a crashed app fails too");

// every claimed caller must have run and reported: each missing in turn fails, by name
{
  const good = [d(1, "signer"), s(1, 1, "signer")];
  const why = (r) => r.why.join("; ");
  const noSecondLine = v(good, { out: refusedLine.replace("; second window opened", "; second window open failed: no window") });
  ok(!noSecondLine.ok && /the second window didn't open/.test(why(noSecondLine)), "a caller missing: the second window's opening failed fails, by name");
  const noSecond = signerVerdict({ err: [...good, ...LOADED.filter((l) => l !== SECOND)].join("\n"), out: refusedLine, seen: FRAME, code: 0, signal: null, problems: [] });
  ok(!noSecond.ok && /the second window's call didn't report/.test(why(noSecond)), "a caller missing: no answer from the second window's call (never ran, or late past the run) fails, by name");
  const secondReached = signerVerdict({ err: [...good, ...LOADED.map((l) => (l === SECOND ? "[page] signer second window: REACHED probe-signature-2" : l))].join("\n"), out: refusedLine, seen: FRAME, code: 0, signal: null, problems: [] });
  ok(!secondReached.ok && /second window's call: REACHED/.test(why(secondReached)), "the second window's call answered (REACHED) fails, outside cap+check");
  // (no frame of the other server in the main window is claimed: the window's guard refuses it, so nothing from it is
  // needed, and a run whose other server saw nothing at all passes)
  ok(v(good, { seen: [] }).ok, "no control: the other server seeing nothing (its frame refused by the main window's guard) passes");
  ok(v(good).ok, "...and with every caller reported: passes");
}

// each control's destination must finish: loaded AND its signing call answered (refused); loaded alone (it stopped or
// hung before trying) fails by name, while the ordinary frame's result can't stand in for it
{
  const good = [d(1, "signer"), s(1, 1, "signer")];
  const why = (r) => r.why.join("; ");
  const cspHalf = v(good, { control: "csp-off", seen: [...FRAME, "sframe: loaded"] });
  ok(!cspHalf.ok && /signer page's frame didn't report its signing call/.test(why(cspHalf)), "csp-off: the framed destination loaded but never reported its signing call fails, by name");
  const stopHalf = v(good, { control: "guard-off", seen: [...FRAME, "stop: loaded"] });
  ok(!stopHalf.ok && /signer window didn't report its signing call/.test(why(stopHalf)), "guard-off: the destination loaded but never reported its signing call fails, by name");
  // (another destination's result can't stand in: guard-off with only the frame's, or csp-off with only the window's)
  const stopFromFrame = v(good, { control: "guard-off", seen: [...FRAME, "stop: loaded", "sframe: loaded", "sframe: signer refused: not allowed"] });
  ok(!stopFromFrame.ok && /signer window didn't report its signing call/.test(why(stopFromFrame)), "guard-off: only the csp-off frame's result present, not the window's own, fails by name");
  const frameFromStop = v(good, { control: "csp-off", seen: [...FRAME, "sframe: loaded", "stop: loaded", "stop: signer refused: not allowed"] });
  ok(!frameFromStop.ok && /signer page's frame didn't report its signing call/.test(why(frameFromStop)), "csp-off: only the guard-off window's result present, not the frame's own, fails by name");
  ok(v(good, { control: "csp-off", seen: [...FRAME, "sframe: loaded", "sframe: signer refused: not allowed"] }).ok && v(good, { control: "guard-off", seen: [...FRAME, "stop: loaded", "stop: signer refused: not allowed"] }).ok, "...and each control with its destination's call refused: passes");
}

// a release build (release-judge.mjs, C1): the build says which it is, holds none of the controls' names, and with
// the signer's widest control set refuses every call
ok(controlsMode("x\n[app] self-test controls: compiled out\ny") === "out" && controlsMode("[app] self-test controls: compiled in") === "in" && controlsMode("[app] the page is at http://127.0.0.1:5/") === null, "the build's word on its controls is read; none said is null");
ok(controlNamesIn(Buffer.from("...a release binary...signer_probe_sign...probe-nocsp...[signer] refused: no stand-in in this build...http://127.0.0.1:")).length === 0, "a release executable's names: the command's name in the ACL, the bundled page's file name and the release stand-in's line aren't controls");
ok(CONTROL_NAMES.every((n) => controlNamesIn(Buffer.from(`\0${n}\0`)).join() === n), "each control's name in an executable is found");
{
  const RL = "FAIL persist: signer at http://127.0.0.1:5: this page's signing call refused: Command not allowed; a page's signer_open refused: Command not found; an output frame's refused: not allowed; second window opened";
  const rv = (err, o = {}) => releaseSignerVerdict({ err: err.join("\n"), out: RL, seen: [], code: 0, signal: null, problems: [], ...o });
  ok(rv(["[app] self-test controls: compiled out", "[signer] startup data folder: none"]).ok, "release, cap+check set: nothing reached the command, the window wasn't opened, the main page refused: passes");
  ok(!rv(["[signer] refused: no stand-in in this build (main)", "[signer] dispatch 1 from main at http://127.0.0.1:5"]).ok, "release: a call that reached the command fails");
  ok(!rv(["[signer] signed 1 (signature 1) for main"]).ok, "release: a signature fails");
  ok(!rv(["[signer] page started null/signer/index.html"]).ok, "release: the probe opening the approvals window fails");
  ok(!rv([], { seen: ["frame: REACHED signer x"] }).ok, "release: the other server's page reaching a command fails");
  ok(!rv([], { out: RL.replace("signing call refused", "signing call REACHED") }).ok && !rv([], { out: "" }).ok, "release: the main page's call answered, or no report, fails");
  ok(!rv([], { code: 1 }).ok && !rv([], { signal: "SIGKILL" }).ok, "release: an unclean end fails");
}

console.log(fails ? `${fails} of ${checks} failed` : `test-signer-judge: all ${checks} passed`);
process.exit(fails ? 1 : 0);
