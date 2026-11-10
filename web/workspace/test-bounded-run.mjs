// ci: web-export order=5
// ci: export-controls order=5
// bounded-run.mjs, the export controls' per-control bound (#974): the parent alone ends a child that won't end, by its
// own process group, SIGTERM then SIGKILL, and leaves nothing of it behind. Each case is a real child: one that ignores
// SIGTERM while blocked in a synchronous call of its own (the hazard: its JS handler can't run), one that obeys it, one
// that exits at once leaving a process in its group holding the output, and one that just finishes; then the stubborn
// one as a control through test-export-controls.mjs itself, its named FAIL. Each case must return within its bound plus
// the grace, the sweep and a 10 s margin (an outer bound, not a measurement: a run that waits much longer, as one that
// didn't kill its group would, fails by name), and its group must be empty.
//   node web/workspace/test-bounded-run.mjs
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, stopped } from "./bounded-run.mjs";

const node = process.execPath;
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const SWEEP = 5_000, MARGIN = 10_000;
const returns = (p, within, what) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), within + SWEEP + MARGIN).unref())])
  .then((r) => { if (!r) check(false, `${what}: runBounded didn't return within ${(within + SWEEP + MARGIN) / 1000} s`); return r; });

// (1) stubborn: SIGTERM ignored, the main thread blocked in spawnSync on a child of its own (as test-export.mjs is in
// python3 or unzip), the grandchild ignoring SIGTERM too: only the parent's SIGKILL of the group ends them
const stubborn = `process.on("SIGTERM", () => {}); console.log("blocked"); require("node:child_process").spawnSync("sh", ["-c", "trap '' TERM; sleep 600"], { stdio: "ignore" });`;
const a = await returns(runBounded(node, ["-e", stubborn], { ms: 500, graceMs: 500 }), 1_000, "stubborn");
if (a) check(a.timedOut && a.signal === "SIGKILL" && !a.survivors && a.stdout.includes("blocked"),
  "a child that ignores SIGTERM while blocked in a synchronous call is killed by its group: " + JSON.stringify({ timedOut: a.timedOut, signal: a.signal, survivors: a.survivors }));

// (2) polite: SIGTERM ends it, its grandchild (in its group) too
const polite = `require("node:child_process").spawn("sleep", ["600"], { stdio: "ignore" }); console.log("waiting"); setInterval(() => {}, 1000);`;
const b = await returns(runBounded(node, ["-e", polite], { ms: 500, graceMs: 30_000 }), 500, "polite");
if (b) check(b.timedOut && b.signal === "SIGTERM" && !b.survivors, "a child that obeys SIGTERM ends on it, and its group with it: " + JSON.stringify({ timedOut: b.timedOut, signal: b.signal, survivors: b.survivors }));

// (3) left behind: the child exits at once, a process of its group (a browser) still holding its output: swept
const leaves = `require("node:child_process").spawn("sleep", ["600"], { stdio: "inherit" }).unref(); console.log("left one");`;
const c = await returns(runBounded(node, ["-e", leaves], { ms: 30_000 }), 0, "left behind");
if (c) check(!c.timedOut && c.status === 0 && !c.survivors && c.stdout.includes("left one"), "a child that exits leaving a process in its group: that process is swept, the output kept: " + JSON.stringify({ timedOut: c.timedOut, status: c.status, survivors: c.survivors }));

// (4) ordinary: it finishes, its exit status and output as they were
const d = await returns(runBounded(node, ["-e", `console.log("done"); process.exit(3);`], { ms: 30_000 }), 0, "ordinary");
if (d) check(!d.timedOut && d.status === 3 && d.signal === null && d.stdout === "done\n" && !d.survivors, "a child that finishes: its status and output, nothing stopped: " + JSON.stringify({ timedOut: d.timedOut, status: d.status }));

// (5) through the harness: the stubborn child as a control of test-export-controls.mjs, its bound lowered to 1 s and its
// grace to 1 s: the control's named FAIL, the runner's own exit within its bound (a synchronous run of it, itself bounded
// by spawnSync's SIGKILL at the outer limit), and nothing of the control left
// (its processes found afterwards by a token of this run in their command lines, and only by it)
const token = `sb-pin-${process.pid}-${Date.now()}`;
const harness = join(dirname(fileURLToPath(import.meta.url)), "test-export-controls.mjs"), LIMIT = 1_000 + 1_000 + SWEEP + MARGIN;
const script = stubborn.replace("trap '' TERM; sleep 600", `trap '' TERM; sleep 600 # ${token}`) + ` // ${token}`;
const h = spawnSync(node, [harness], { encoding: "utf8", env: { ...process.env, EXPORT_CONTROLS_PIN: JSON.stringify({ script, ms: 1_000, graceMs: 1_000 }) }, timeout: LIMIT, killSignal: "SIGKILL" });
const left = spawnSync("pgrep", ["-a", "-f", token], { encoding: "utf8" }).stdout.trim();
check(h.status === 1 && !h.signal && h.stdout.includes("FAIL PIN (the pin's stubborn control): its run didn't finish in 1 s (stopped); its last lines:") && h.stdout.includes("PIN: stopped") && !h.stdout.includes("outlived") && !left,
  `a stubborn, sync-blocked control through the harness: its named FAIL within ${LIMIT / 1000} s, nothing left: ` + JSON.stringify({ status: h.status, signal: h.signal, left: left || null, out: h.stdout.trim().split("\n").slice(0, 2) }));

// (6) the words of a named FAIL, the build's and the run's (stopped()): a group outliving the final SIGKILL can't be
// made on purpose here (a process in uninterruptible sleep), so its words are pinned on the record itself
const w = [stopped({ timedOut: true, signal: "SIGKILL", survivors: false }, 900_000, "its run"), stopped({ timedOut: false, signal: null, status: 0, survivors: true }, 180_000, "the build"),
  stopped({ timedOut: false, signal: "SIGSEGV", survivors: false }, 180_000, "the build"), stopped({ timedOut: false, signal: null, status: 1, survivors: false }, 900_000, "its run")];
check(w[0] === "its run didn't finish in 900 s (stopped)" && w[1] === "the build ended, and its process group outlived the kill" && w[2] === "the build ended by SIGSEGV" && w[3] === null,
  "a named FAIL's words: stopped at the bound; a group outliving the kill (a build that exited 0 too); a signal; none for a run that ended by itself: " + JSON.stringify(w));

console.log(fails ? `test-bounded-run: ${fails} FAILED` : "test-bounded-run: all passed");
process.exit(fails ? 1 : 0);
