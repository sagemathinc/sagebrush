// How much the web views' localStorage holds (app/src-tauri/src/disk.rs THREADS_MAX, the agents page's chats on the
// desktop app's disk, is measured by this): the longest single value, in UTF-16 units, one site's localStorage takes
// under a one-letter key, for ASCII, Latin-1, other BMP and astral text, and its length in UTF-8.  Chromium (Windows'
// WebView2) headless; WebKit (macOS's and Linux's web views) too where PLAYWRIGHT names a directory with node_modules/playwright-core (or playwright).
//   node web/measure-local-storage.mjs
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const PAGE = `<pre id=o></pre><script>
const out = [];
for (const [name, ch] of [["ascii", "a"], ["latin1", "\\u00e9"], ["bmp", "\\u4e2d"], ["astral", "\\u{1F600}"]]) {
  localStorage.clear();
  let lo = 0, hi = 64 * 1024 * 1024;
  while (lo < hi) { const m = Math.ceil((lo + hi) / 2); try { localStorage.setItem("k", ch.repeat(m)); lo = m; } catch { hi = m - 1; } localStorage.removeItem("k"); }
  out.push(name + "=" + lo * ch.length + " (" + new TextEncoder().encode(ch.repeat(lo)).length + " bytes of UTF-8)");
}
document.getElementById("o").textContent = "units " + out.join(" ");
</script>`;

const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
try {
  const chrome = process.env.CHROME ?? "chromium";
  // (run asynchronously: this process serves the page it loads)
  const run = (args) => promisify(execFile)(chrome, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 20 }).then((r) => r.stdout, (e) => `no result (${e.message.split("\n")[0]})`);
  const v = (await run(["--version"])).trim();
  const r = await run(["--headless", "--no-sandbox", "--dump-dom", url]);
  console.log(`${v}: ${/units [^<]*/.exec(r)?.[0] ?? r}`);
  if (process.env.PLAYWRIGHT) {
    const req = createRequire(join(process.env.PLAYWRIGHT, "node_modules", "x.js"));
    let pw;
    try { pw = req("playwright-core"); } catch { pw = req("playwright"); }
    const browser = await pw.webkit.launch(process.env.WEBKIT ? { executablePath: process.env.WEBKIT } : {});
    const page = await browser.newPage();
    await page.goto(url);
    console.log(`WebKit ${browser.version()}: ${await page.textContent("#o")}`);
    await browser.close();
  }
} finally {
  server.close();
}
