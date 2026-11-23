// ci: web-runner order=295 runner=bun
// The signer probe's verdict (app/selftest/signer-judge.mjs, N1): for each run (no control, and each control), a log
// that shows what it must passes, and each way it can fail is caught.
//   bun app/selftest/test-signer-judge.mjs
import { signerVerdict, signerLog } from "./signer-judge.mjs";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const d = (n, label, origin = label === "signer" ? "tauri://localhost" : "http://127.0.0.1:5") => `[signer] dispatch ${n} from ${label} at ${origin}`;
const s = (n, k, label) => `[signer] signed ${n} (signature ${k}) for ${label}`;
const refusedLine = "ok persist: signer at http://127.0.0.1:5: this page's signing call refused: Command not allowed; a page's signer_open refused: Command not found; an output frame's refused: not allowed";
const reachedLine = "ok persist: signer at http://127.0.0.1:5: this page's signing call REACHED probe-signature-2; a page's signer_open refused: Command not found; an output frame's refused: not allowed";
const v = (err, { out = refusedLine, seen = ["frame: requested", "frame: loaded", "frame: refused: not allowed"], control, code = 0, signal = null, problems = [] } = {}) => signerVerdict({ err: err.join("\n"), out, seen, control, code, signal, problems });

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
ok(v([d(1, "signer"), s(1, 1, "signer")], { control: "csp-off", seen: ["frame: loaded", "sframe: loaded", "sframe: refused: not allowed"] }).ok, "csp-off: the other server's page loaded in the signer page's frame, and reached nothing: passes");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "csp-off" }).ok, "csp-off: the frame never loaded (the control didn't run) fails");
ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "signer", "http://127.0.0.1:9")], { control: "csp-off", seen: ["sframe: loaded"] }).ok, "csp-off: the framed page reaching the command fails");
ok(v([d(1, "signer"), s(1, 1, "signer")], { control: "guard-off", seen: ["stop: loaded", "stop: refused: not allowed"] }).ok, "guard-off: the other server's page loaded in the signer window, and reached nothing: passes");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "guard-off" }).ok, "guard-off: the page never loaded there fails");
ok(!v([d(1, "signer"), s(1, 1, "signer")], { control: "nonsense" }).ok, "an unknown control fails");

// the state check runs on the signer's own loaded page only (never the guard-off destination, a frame or nothing)
{
  const pg = (ev, at) => `[signer] page ${ev} ${at}`;
  const sent = "[signer] state check sent";
  const stop = [pg("started", "null/signer/index.html"), pg("finished", "null/signer/index.html"), sent, "[signer] state: ready=complete probe=yes tauri=yes ran=yes protocol=tauri body=yes", d(1, "signer"), s(1, 1, "signer"), pg("started", "http://127.0.0.1:9/stop"), pg("finished", "http://127.0.0.1:9/stop"), "[signer] state: not-signer-page"];
  ok(v(stop, { control: "guard-off", seen: ["stop: loaded"] }).ok, "the state check: once on the signer page, none on the guard-off destination: passes");
  ok(!v([...stop, sent], { control: "guard-off", seen: ["stop: loaded"] }).ok, "the state check: sent on the guard-off destination fails");
  ok(!v([sent, d(1, "signer"), s(1, 1, "signer")]).ok, "the state check: sent with no page loaded before it fails");
  ok(!v([pg("started", "null/signer/index.html"), sent, d(1, "signer"), s(1, 1, "signer")]).ok, "the state check: sent before the page finished loading fails");
  ok(!v([pg("finished", "http://127.0.0.1:9/sframe"), sent, d(1, "signer"), s(1, 1, "signer")], { control: "csp-off", seen: ["sframe: loaded"] }).ok, "the state check: sent on a frame's or another server's page fails");
  ok(!v([pg("finished", "null/index.html"), sent, d(1, "signer"), s(1, 1, "signer")]).ok, "the state check: sent on another app page fails");
  ok(v([pg("finished", "http://tauri.localhost/signer/index.html"), sent, d(1, "signer"), s(1, 1, "signer")]).ok && v([pg("finished", "null/signer/probe-nocsp.html"), sent, d(1, "signer"), s(1, 1, "signer")], { control: "csp-off", seen: ["sframe: loaded"] }).ok, "the state check: on the signer page on Windows, and the csp-off page: passes");
}

// (astra2: a run whose log shows everything it must, but whose app didn't end cleanly, never passes)
const good = [d(1, "signer"), s(1, 1, "signer")];
ok(!v(good, { code: 1 }).ok, "an otherwise passing run whose app exited 1 fails");
ok(!v(good, { code: null, signal: "SIGKILL" }).ok, "an otherwise passing run whose app was killed (a signal) fails");
ok(!v(good, { problems: ["the app did not report and end its output within 120 s"] }).ok, "an otherwise passing run that timed out fails");
ok(!v(good, { problems: ["the app's output did not end within 20 s of its exit"] }).ok, "an otherwise passing run whose output never ended fails");
ok(!v([d(1, "signer"), s(1, 1, "signer"), d(2, "main"), s(2, 2, "main")], { control: "cap+check", out: reachedLine, code: 101 }).ok, "the positive control with a crashed app fails too");

console.log(fails ? `${fails} of ${checks} failed` : `test-signer-judge: all ${checks} passed`);
process.exit(fails ? 1 : 0);
