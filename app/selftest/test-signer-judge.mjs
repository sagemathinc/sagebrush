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
const v = (err, { out = refusedLine, seen = ["frame: requested", "frame: loaded", "frame: refused: not allowed"], control } = {}) => signerVerdict({ err: err.join("\n"), out, seen, control });

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

console.log(fails ? `${fails} of ${checks} failed` : `test-signer-judge: all ${checks} passed`);
process.exit(fails ? 1 : 0);
