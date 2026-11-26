// run.mjs's capture of the desktop app's output and its verdict, apart so that
// test-run-judge.mjs can drive them with a fake child (astra's NC-R1-A2).
//
// capture(): everything the app writes, to the END of both streams.  A child's
// "exit" may come before its stdout/stderr are drained (Node's child_process,
// Event "close"), so the result is settled only on "close" with both streams
// ended; never on "exit" alone.  Fail closed, every problem named:
//   - the deadline (the whole run, through the drain): the app is killed;
//   - the streams not ended within drainMs of the exit (an inherited descriptor
//     held open by another process): no waiting forever;
//   - a stream or spawn error, or a close without both streams' end.
// judge(): the report (stdout's report lines) through android-report.py with
// the engine THIS platform fixes and --desktop (the desktop app's own checks, the
// LaTeX editor's, required too), and the native witness (probe-log.py
// --desktop) on all of stderr, with check 2's nonce.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { reportLines } from "./report-lines.mjs";

export const ENGINE_OF_PLATFORM = { win32: "chromium", darwin: "webkit", linux: "webkit" };

export function capture(p, { deadlineMs, drainMs = 20000, echo = true }) {
  return new Promise((resolve) => {
    const res = { code: null, signal: null, out: "", err: "", problems: [] };
    const ended = { stdout: false, stderr: false };
    let settled = false, drain = null;
    const finish = (problem) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drain);
      if (problem) res.problems.push(problem);
      resolve(res);
    };
    for (const [name, s, sink] of [["stdout", p.stdout, process.stdout], ["stderr", p.stderr, process.stderr]]) {
      s.setEncoding("utf8");
      s.on("data", (d) => { if (settled) return; res[name === "stdout" ? "out" : "err"] += d; if (echo) sink.write(d); });
      s.on("end", () => { ended[name] = true; });
      s.on("error", (e) => res.problems.push(`the app's ${name}: ${e?.message ?? e}`));
    }
    p.on("error", (e) => finish(`the app: ${e?.message ?? e}`));
    p.on("exit", (code, signal) => {
      res.code = code; res.signal = signal;
      drain = setTimeout(() => finish(`the app's output did not end within ${drainMs / 1000} s of its exit`), drainMs);
    });
    p.on("close", (code, signal) => {
      if (res.code === null && res.signal === null) { res.code = code; res.signal = signal; }
      finish(ended.stdout && ended.stderr ? null : `the app's output closed without both streams ending (stdout ${ended.stdout}, stderr ${ended.stderr})`);
    });
    const deadline = setTimeout(() => {
      try { p.kill(); } catch {}
      finish(`the app did not report and end its output within ${deadlineMs / 1000} s`);
    }, deadlineMs);
  });
}

export function python(args) {
  let r = { status: null };
  for (const py of ["python3", "python"]) {
    r = spawnSync(py, ["-I", ...args], { stdio: "inherit" });
    if (!r.error) break;
  }
  return r;
}

/** null when the app's log has exactly one "[agent] bundle:" line and it is what this platform must report. */
export function agentBundleProblem(err, platform) {
  const lines = String(err).split(/\r?\n/).filter((l) => l.startsWith("[agent] bundle: "));
  if (lines.length !== 1) return `${lines.length} "[agent] bundle:" lines in the app's log, not 1`;
  const bundled = platform === "darwin" || platform === "linux";
  const want = bundled ? /^\[agent\] bundle: ok agent=\d+\.\d+\.\d+ node=\d+\.\d+\.\d+ claude_code=\S+ node_check=(bytes|signature)$/ : /^\[agent\] bundle: not_bundled$/;
  return want.test(lines[0]) ? null : `${JSON.stringify(lines[0])} (${bundled ? "the agent is bundled here" : "no agent is bundled here"})`;
}

// -> { passed, report }; prints a FAIL line for each failing part.
export function judge(res, { dir, platform = process.platform }) {
  const here = new URL(".", import.meta.url);
  for (const p of res.problems) console.log(`FAIL the capture: ${p}`);
  const lines = reportLines(res.out);
  const report = join(dir, "report.txt");
  writeFileSync(report, lines.join("\n") + "\n");
  // (the report judge, with this platform's engine, as the desktop app's report: --desktop)
  const engine = Object.hasOwn(ENGINE_OF_PLATFORM, platform) ? ENGINE_OF_PLATFORM[platform] : null;
  let judged = false;
  if (!engine) console.log(`FAIL no engine family is known for the platform ${JSON.stringify(platform)}`);
  else {
    const j = python([fileURLToPath(new URL("android-report.py", here)), "--engine", engine, "--desktop", report]);
    judged = j.status === 0;
    if (!judged) console.log(`FAIL the report judge, --engine ${engine} --desktop (android-report.py: ${j.error ? "no python" : "exit " + j.status})`);
  }
  // (the native witness: the app's log, all of it, this run's nonce from the report's check 2)
  const stderr = join(dir, "stderr.txt");
  writeFileSync(stderr, res.err);
  const nonce = lines.map((l) => /^ok {3}the page reaches the app's bridge: nonce=([0-9a-f-]{36}) /.exec(l)?.[1]).find(Boolean);
  let witness = false;
  if (!nonce) console.log("FAIL the native witness: no nonce in the report's check 2");
  else {
    const w = python([fileURLToPath(new URL("probe-log.py", here)), "--desktop", stderr, nonce, report]);
    witness = w.status === 0;
    if (!witness) console.log(`FAIL the native witness (probe-log.py: ${w.error ? "no python" : "exit " + w.status})`);
  }
  // (the agent bundle's check, run by the app on its own resources and Node: macOS and Linux bundle the agent)
  const bundle = agentBundleProblem(res.err, platform);
  if (bundle) console.log(`FAIL the agent bundle: ${bundle}`);
  const passed = res.problems.length === 0 && res.code === 0 && res.out.includes("all passed") && judged && witness && !bundle;
  return { passed, report };
}
