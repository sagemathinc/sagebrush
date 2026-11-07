// ci: census order=20
// The rich-output sink census (test/rich_sinks.py, OUT-ISO plan r3 phase 1): every
// sink and reader in the web app's sources is registered with a kind and an owner
// phase, and the check itself discriminates: an unregistered sink, a rich sink
// without an owner or readers list, a stale entry and an unregistered reader each
// fail it, in a throwaway git repository.
//   node scripts/test-rich-sinks.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const census = (args) => {
  const r = spawnSync("python3", [join(root, "test", "rich_sinks.py"), "--check", ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  return { status: r.status, out, stderr: r.stderr };
};

// the tree itself
{
  const r = census([]);
  ok(r.status === 0 && r.out && r.out.problems.length === 0, `every sink and reader is registered (${r.out?.sinks} sinks, ${r.out?.readers} readers): ${JSON.stringify(r.out?.problems?.slice(0, 3) ?? r.stderr.slice(0, 300))}`);
}

// the check discriminates, in a fixture repository
const fx = mkdtempSync(join(tmpdir(), "sb-rich-sinks-"));
try {
  const git = (...a) => spawnSync("git", a, { cwd: fx, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(fx, "web"), { recursive: true });
  mkdirSync(join(fx, "test"), { recursive: true });
  writeFileSync(join(fx, "web", "page.js"), "function show(el, html) {\n  el.innerHTML = html;\n}\nfunction read(cell) {\n  return cell.out.textContent;\n}\n");
  git("add", "-A");
  const reg = (o) => writeFileSync(join(fx, "test", "rich-sinks.json"), JSON.stringify(o));
  const sink = "web/page.js :: show :: el.innerHTML = html; #0", reader = "web/page.js :: read :: return cell.out.textContent; #0";
  reg({ sinks: {}, readers: {} });
  let r = census(["--root", fx]);
  ok(r.status === 1 && r.out.problems.some((p) => p.startsWith("unregistered: web/page.js:2")) && r.out.problems.some((p) => p.startsWith("unregistered reader: web/page.js:5")), "an unregistered sink and an unregistered reader each fail the check");
  reg({ sinks: { [sink]: { kind: "rich" } }, readers: { [reader]: { role: "agent-text", owner: "phase-2" } } });
  r = census(["--root", fx]);
  ok(r.status === 1 && r.out.problems.some((p) => p.includes("needs an owner phase and a readers list")), "a rich sink without an owner phase and readers list fails");
  reg({ sinks: { [sink]: { kind: "rich", owner: "phase-2", readers: ["web/page.js :: read"] }, "web/page.js :: gone :: x.innerHTML = y; #0": { kind: "host", owner: "host" } }, readers: { [reader]: { role: "agent-text", owner: "phase-2" } } });
  r = census(["--root", fx]);
  ok(r.status === 1 && r.out.problems.some((p) => p.startsWith("stale (no such line now)")), "a stale entry fails");
  reg({ sinks: { [sink]: { kind: "rich", owner: "phase-2", readers: ["web/page.js :: read"] } }, readers: { [reader]: { role: "agent-text", owner: "phase-2" } } });
  r = census(["--root", fx]);
  ok(r.status === 0 && r.out.problems.length === 0, "registered, it passes");
  writeFileSync(join(fx, "web", "page.js"), "function show(el, html) {\n  el.innerHTML = html + \"!\";\n}\nfunction read(cell) {\n  return cell.out.textContent;\n}\n");
  r = census(["--root", fx]);
  ok(r.status === 1 && r.out.problems.some((p) => p.startsWith("unregistered: web/page.js:2")), "an edited sink line needs registering again");
} finally { rmSync(fx, { recursive: true, force: true }); }
console.log(fails ? `${fails} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(fails ? 1 : 0);
