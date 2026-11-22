// ci: web-runner order=168 runner=bun chrome
// The desktop app's agents self-test (web/agents/app-selftest.ts) judges what an output frame's agent_connect got back.
// This build's agent_connect refuses every caller with not_bundled, so the judgment must tell a command that ran from
// a call Tauri refused before any command ran:
//   - outcome() on each kind of answer: resolved or naming not_bundled is "reached"; Tauri's ACL and IPC refusals
//     ("... not allowed ...", "missing Tauri-Invoke-Key header") are "denied"; a missing bridge is "absent"; a fetch
//     with no answer is "blocked"; anything else is "unclassified" (which the self-test fails);
//   - the same, from outcome()'s source alone (the frame's probe runs its toString(), from the minified build), so it
//     names nothing outside itself;
//   - in headless Chromium, frameProbe() itself: a frame with no bridge is absent/blocked on every path; the exposure
//     control, a bridge put into the frame that reaches a stand-in agent_connect refusing not_bundled, as the real
//     stub does, is "reached" (and the stand-in saw the call); a bridge refusing with the ACL's text is "denied".
//   bun web/agents/test-agents-app-probe.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { browser } from "./a14-cases.mjs";

let fails = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const src = fileURLToPath(new URL("./app-selftest.ts", import.meta.url));

// the module as the app's build makes it (minified), and a variant with a bridge put into the frame's probe
async function build(prelude) {
  const text = readFileSync(src, "utf8");
  const needle = "const probe = `<script>(async () => {";
  if (!text.includes(needle)) throw new Error("app-selftest.ts: the probe's opening changed");
  const path = fileURLToPath(new URL(`./.app-probe-${process.pid}-${prelude ? "b" : "a"}.ts`, import.meta.url));
  await Bun.write(path, prelude ? text.replace(needle, needle + "\n" + prelude) : text);
  try {
    const r = await Bun.build({ entrypoints: [path], target: "browser", format: "esm", minify: true });
    if (!r.success) throw new Error("build: " + r.logs.join("; "));
    return await r.outputs[0].text();
  } finally { (await import("node:fs")).rmSync(path, { force: true }); }
}

const plain = await build(null);
const mod = await import("data:text/javascript;base64," + Buffer.from(plain).toString("base64"));
const cases = [
  [true, "x", "reached"],
  [false, "not_bundled", "reached"],
  [false, "HTTP 500 not_bundled", "reached"],
  [false, "agent_connect not allowed on origin [null]. Please create a capability that has this origin", "denied"],
  [false, "agent_connect not allowed. Command not found", "denied"],
  [false, "HTTP 500 missing Tauri-Invoke-Key header", "denied"],
  [false, new TypeError("Cannot read properties of undefined (reading 'core')"), "absent"],
  [false, new TypeError("undefined is not an object (evaluating 'window.__TAURI__.core')"), "absent"],
  [false, new TypeError("Failed to fetch"), "blocked"],
  [false, new TypeError("Load failed"), "blocked"],
  [false, "something else", "unclassified"],
  [false, new Error("denied by something"), "unclassified"],
];
// (outcome() from its source alone, as the frame's probe has it)
const alone = new Function("return " + mod.outcome.toString())();
for (const [res, v, want] of cases) {
  const a = mod.outcome(res, v), b = alone(res, v);
  ok(a.startsWith(want) && b === a, `outcome(${res}, ${JSON.stringify(String(v?.message ?? v))}) is ${want}: ${a}${b === a ? "" : ` (from its source alone: ${b})`}`);
}

// frameProbe() in a real browser
const reachedBridge = `window.__TAURI__ = { core: { invoke: async () => { parent.postMessage({ sbTestReached: 1 }, "*"); throw "not_bundled"; } } };`;
const deniedBridge = `window.__TAURI__ = { core: { invoke: async () => { throw "agent_connect not allowed on origin [null]. Please create a capability that has this origin"; } } };`;
const builds = { none: plain, reached: await build(reachedBridge), denied: await build(deniedBridge) };
const server = Bun.serve({ port: 0, fetch: (r) => {
  const p = new URL(r.url).pathname, m = /^\/(none|reached|denied)\.js$/.exec(p);
  // (the page a14-cases.mjs's tab waits for: #editor .mb)
  return m ? new Response(builds[m[1]], { headers: { "Content-Type": "text/javascript" } }) : new Response("<!doctype html><title>probe</title><div id=editor><div class=mb></div></div>", { headers: { "Content-Type": "text/html" } });
} });
const B = await browser();
try {
  const P = await B.tab();
  await P.navigate(`http://127.0.0.1:${server.port}/`);
  const run = async (k) => P.ev(`(async () => { let saw = 0; const on = (e) => { if (e.data?.sbTestReached) saw++; }; addEventListener("message", on); const m = await import("/${k}.js"); const r = await m.frameProbe(); removeEventListener("message", on); return { ...r, saw }; })()`);
  const none = await run("none");
  const nr = Object.entries(none.results);
  ok(nr.length === 4 && nr.every(([, v]) => /^(absent|blocked)\b/.test(v)), `a frame with no bridge: every path absent or blocked: ${JSON.stringify(none.results)}`);
  const exp = await run("reached");
  ok(exp.saw === 1 && /^reached \(not_bundled\)/.test(exp.results.core ?? ""), `the exposure control: a bridge reaching a stand-in agent_connect that refuses not_bundled is "reached" (the stand-in saw ${exp.saw} call): ${JSON.stringify(exp.results)}`);
  const den = await run("denied");
  ok(/^denied\b/.test(den.results.core ?? ""), `a bridge refusing with the ACL's text is "denied": ${JSON.stringify(den.results)}`);
} finally { await B.close(); server.stop(true); }

console.log(fails ? `${fails} failed` : "test-agents-app-probe: all passed");
process.exit(fails ? 1 : 0);
