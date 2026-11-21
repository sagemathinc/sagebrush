// ci: web-artifacts.1 order=40 runner=bun chrome
// The grant dialog ("Allow this agent?") fits its box on the Agents page (found in testing, Nov 21 2026): at 100%, 125% and
// 150% zoom, and on a phone's width (360 CSS px), with the "Allow it" select's longest option (the page's "while this page is open (…)"), every part of the
// dialog (the folders, the checkboxes, the note, the select, Cancel and Allow) stays inside the white box. The built
// page (SAGEBRUSH_AGENTS=1), served by web/serve.py, paired as a person pairs it with the stand-in agent
// (test-delegate-host.mjs), up to the dialog.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-grant-dialog.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";
import { delegateHost } from "./test-delegate-host.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 800) : "")); if (!c) failures++; };

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;
const H = delegateHost();
const B = await browser();
try {
  const P = await B.tab();
  await P.navigate(`${site}/agents/?pair=123-456&port=${H.port}`);
  await P.until(`[...document.querySelectorAll('.sbag-dlg button')].some((b) => b.textContent === 'Connect')`, 30000);
  await P.ev(`[...document.querySelectorAll('.sbag-dlg button')].find((b) => b.textContent === 'Connect').click()`);
  await P.until(`[...document.querySelectorAll('.sbag-box h2')].some((h) => h.textContent === 'Allow this agent?')`, 30000);
  // (the select's longest option, as the person can choose it: the page's "while this page is open (…)")
  const longest = await P.ev(`(() => { const s = [...document.querySelectorAll('.sbag-box')].at(-1).querySelector('select'); const o = [...s.options].sort((a, b) => b.text.length - a.text.length)[0]; s.value = o.value; s.dispatchEvent(new Event('change')); return o.text; })()`);
  ok(/while this page is open/.test(longest), "the select's longest option is chosen", longest);
  // (zoom as the browser's: the same window, fewer CSS pixels across, each drawn larger)
  for (const [zoom, w, h] of [[1, 1280, 900], [1.25, 1024, 720], [1.5, 853, 600], [2, 360, 740]]) {
    await P.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: zoom, mobile: false });
    await P.ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    const r = await P.ev(`(() => {
      const box = [...document.querySelectorAll('.sbag-box')].at(-1), b = box.getBoundingClientRect();
      const out = [];
      for (const el of box.querySelectorAll('*')) {
        const e = el.getBoundingClientRect();
        if (!e.width && !e.height) continue;
        if (e.left < b.left - 0.5 || e.right > b.right + 0.5) out.push({ el: el.tagName.toLowerCase() + (el.className ? '.' + el.className : ''), text: (el.textContent || '').trim().slice(0, 40), left: Math.round(e.left - b.left), right: Math.round(e.right - b.right) });
      }
      const fits = (sel) => { const e = box.querySelector(sel)?.getBoundingClientRect(); return !!e && e.left >= b.left - 0.5 && e.right <= b.right + 0.5; };
      return { box: Math.round(b.width), view: innerWidth, out, select: fits('select'), allow: fits('button.primary'), folders: fits('.folders') };
    })()`);
    ok(r.out.length === 0 && r.select && r.allow && r.folders, `at ${Math.round(zoom * 100)}% (${r.view} CSS px across): every part of the dialog inside its box (${r.box} px)`, r);
    if (process.env.SHOTS) (await import("node:fs")).writeFileSync(join(process.env.SHOTS, `grant-dialog-${Math.round(zoom * 100)}.png`), Buffer.from((await P.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  H.stop();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
