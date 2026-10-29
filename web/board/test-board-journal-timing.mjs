// The board journal's cost on the input path (test 17): a large board (2,000
// notes), edited in a typing run (200 edits, one every 30 ms) and a 10 s run of moves (one edit a frame), with the
// journal on against off, each in a profile of its own, the same build, the same machine.  The bound, stated in the
// design before any data:
//   (a) no Long Task over 50 ms beyond those the journal off has (counted the same way);
//   (b) the 95th percentile of an edit's time to the next frame, on, at most off's + 5 ms;
//   (c) the last edit's T2 in the row within 2 s of it.
// Prints JSON; exits 1 if the bound is missed (BOUND=0 to only report).
//   bun web/build.ts && CHROME=google-chrome bun web/board/test-board-journal-timing.mjs
import { join } from "node:path";
import { serve, browser, sleep, rowExpr, activateExpr } from "./test-board-journal-lib.mjs";

const here = new URL(".", import.meta.url).pathname;
const J = JSON.stringify;
const NOTES = Number(process.env.NOTES ?? 2000);
const B = "window.sagebrush.board";
const big = { title: "large", nodes: Array.from({ length: NOTES }, (_, i) => ({ id: "n" + i, x: (i % 50) * 220, y: Math.floor(i / 50) * 160, title: "Note " + i, text: "Some text of note " + i + ", ".repeat(8) })).concat([{ id: "tj", x: -300, y: 0, text: "start" }]) };
const LONG = `(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: "longtask", buffered: true }); })()`;
// (the runs, in the page: each edit's time to the next frame; the long tasks while they ran)
const RUNS = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tj = (d) => d.nodes.find((n) => n.id === "tj");
  await wait(3000);
  window.__lt = [];
  const lat = [];
  for (let i = 0; i < 200; i++) { const t0 = performance.now(); ${B}.edit((d) => { tj(d).text = "typed " + i; }); lat.push((await frame()) - t0); await wait(30); }
  const end = performance.now() + 10000;
  for (let i = 0; performance.now() < end; i++) { const t0 = performance.now(); ${B}.edit((d) => { tj(d).x = -300 + (i % 100); tj(d).text = "moved " + i; }); lat.push((await frame()) - t0); }
  const last = tj(${B}.snapshot().doc).text, t1 = performance.now();
  return { lat, long: window.__lt.slice(), last, t1 };
})()`;
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

const { origin, stop } = await serve({ "": process.env.SB_DIST ?? join(here, "../dist") });
const out = { notes: NOTES };
let code = 1;
try {
  for (const mode of ["off", "on"]) {
    const br = await browser();
    try {
      const helper = await br.tab();
      await helper.go(`${origin}/__bj/`);
      await helper.until("window.ready === true");
      if (mode === "on" && !(await helper.ev(activateExpr))) throw new Error("the journal not activated");
      const id = await helper.ev(`(async () => { const w = await window.M.W.Workspace.open(); const e = await w.create("/large.board.json", { content: ${J(big)} }); w.close(); return e.ref; })()`);
      const t = await br.tab();
      await t.send("Page.addScriptToEvaluateOnNewDocument", { source: LONG });
      await t.go(`${origin}/board/?doc=local:${id}`);
      if (!(await t.until(`!!${B}?.snapshot?.().doc && (!window.sagebrush.boardJournal || !!window.sagebrush.boardJournal())`, 60000))) throw new Error("the large board didn't open");
      const r = await t.ev(RUNS);
      let landed = null;
      for (const t0 = Date.now(); Date.now() - t0 < 10000; await sleep(20)) {
        if (await t.ev(`${rowExpr(id)}.then((x) => !!x && x.doc.nodes.find((n) => n.id === "tj")?.text === ${J(r.last)})`)) { landed = (await t.ev("performance.now()")) - r.t1; break; }
      }
      out[mode] = { edits: r.lat.length, p95: Math.round(p95(r.lat) * 10) / 10, max: Math.round(Math.max(...r.lat)), longTasks: r.long.length, over50: r.long.filter((d) => d > 50).length, lastT2ms: landed === null ? null : Math.round(landed), journaled: mode === "on" ? typeof (await t.ev(rowExpr(id))).hash === "string" : false };
    } finally {
      await br.close();
    }
  }
  const on = out.on, off = out.off;
  out.bound = { a: on.over50 <= off.over50, b: on.p95 <= off.p95 + 5, c: on.lastT2ms !== null && on.lastT2ms <= 2000, journaled: on.journaled };
  console.log(J(out));
  if (process.env.BOUND === "0" || (out.bound.a && out.bound.b && out.bound.c && out.bound.journaled)) code = 0;
  else console.error("FAIL: the board journal's cost bound missed: " + J(out.bound));
} catch (e) {
  console.error("FAIL: " + (e?.stack ?? e));
} finally {
  stop();
}
process.exit(code);
