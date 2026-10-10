// The CLI bundle's notebook server (`sagebrush notebook`) serves every file
// the page loads: the scripts it references (found in the page itself, so a
// new one cannot be forgotten), KaTeX and the notices, at the top and under
// /nb/<notebook>/.  No browser needed.
//   node web/test-cli-assets.mjs [bundle]      (default build/cli/pyjs.cjs)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bundle = process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sb-assets-"));
const port = 9800 + Math.floor(Math.random() * 150);
const server = spawn(process.execPath, [bundle, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "inherit"] });
let printed = "";
server.stdout.on("data", (d) => (printed += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !/token=/.test(printed); i++) await sleep(100);
let fail = 0;
try {
  const token = /token=(\w+)/.exec(printed)?.[1];
  if (!token) throw new Error("the server printed no URL with a token: " + printed);
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => fetch(base + p, { headers: { Cookie: `sagebrush_token=${token}` }, redirect: "manual" });
  const page = await (await get("/nb/probe.ipynb/")).text();
  if (!/<html/i.test(page)) throw new Error("no notebook page: " + page.slice(0, 200));
  // every sagebrush-*.js the page names, KaTeX's stylesheet, the notices
  const names = [...new Set(page.match(/sagebrush-[a-z0-9]+\.js/g) ?? [])].filter((n) => !["sagebrush-worker.js", "sagebrush-notebook.js"].includes(n));
  for (const f of [...names, "katex/katex.min.css", "THIRD-PARTY-NOTICES.txt"]) {
    for (const p of [`/${f}`, `/nb/probe.ipynb/${f}`]) {
      const r = await get(p);
      const ok = r.status === 200;
      if (!ok) fail++;
      console.log((ok ? "ok   " : "FAIL ") + p + " " + r.status);
    }
  }
} catch (e) {
  console.log("FAIL " + e.message);
  fail++;
} finally {
  server.kill();
}
console.log(fail ? `${fail} failures` : "every asset served");
process.exit(fail ? 1 : 0);
