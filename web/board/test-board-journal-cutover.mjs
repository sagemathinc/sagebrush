// The board journal's cutover (2c-1b-i, design-2c1b-i r3 §2.1 D-1, test 16): two builds of the site served from ONE
// origin (one IndexedDB), the build from before the board journal under /old/ (SB_DIST_OLD) and this one under /new/
// (SB_DIST): a page of the old build, open on a board, can't change its row once a page of this build has opened the
// workspace (version 9's upgrade closes it), so the row's doc, rev, j, hash and mark stay one coherent set; and an old
// build opening afresh is refused (a VersionError), writing nothing.
//   SB_DIST_OLD=<master's web/dist> SB_DIST=web/dist CHROME=google-chrome bun web/board/test-board-journal-cutover.mjs
import { join } from "node:path";
import { serve, browser, sleep, rowExpr, activateExpr } from "./test-board-journal-lib.mjs";

const here = new URL(".", import.meta.url).pathname;
const J = JSON.stringify;
const results = [];
const check = (ok, what) => { results.push([!!ok, what]); if (process.env.PROGRESS) console.log((ok ? "  ok " : "  FAIL ") + what); };
if (!process.env.SB_DIST_OLD) { console.error("FAIL: SB_DIST_OLD (the earlier build's web/dist) is needed"); process.exit(1); }
const B = "window.sagebrush.board";
const setTj = (text) => `Promise.resolve(${B}.edit((d) => { const ns = d.pages ? d.pages[0].nodes : (d.nodes ??= []); const x = ns.find((n) => n.id === "tj"); if (x) x.text = ${J(text)}; else ns.push({ id: "tj", x: 40, y: 40, text: ${J(text)} }); }))`;
const tjOf = (d) => (d ? (d.pages ? d.pages[0].nodes : d.nodes ?? []).find((n) => n.id === "tj")?.text : undefined);
const dbVersion = `new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const v = r.result.version; r.result.close(); ok(v); }; r.onerror = () => ok(null); })`;

const { origin, stop } = await serve({ "/old": process.env.SB_DIST_OLD, "/new": process.env.SB_DIST ?? join(here, "../dist") });
const br = await browser();
let code = 1;
try {
  // 1. the old build's page makes a board, saves an edit, and stays open on it
  const old = await br.tab();
  await old.go(`${origin}/old/board/?new=python`);
  if (!(await old.until(`location.search.includes("doc=local:") && !!${B}?.snapshot?.().doc`, 30000))) throw new Error("the old build's board didn't open");
  const id = await old.ev(`new URLSearchParams(location.search).get("doc").slice(6)`);
  await old.ev(setTj("old 1"));
  await old.until(`${rowExpr(id)}.then((r) => r && (r.doc.nodes ?? []).some((n) => n.text === "old 1"))`);
  check((await old.ev(dbVersion)) === 8, "the old build's workspace is version 8");
  // 2. this build: the journal activated, and the board opened journaled: the row stamped, then saved
  const helper = await br.tab();
  await helper.go(`${origin}/__bj/`);
  await helper.until("window.ready === true");
  check(await helper.ev(activateExpr), "this build opens the workspace (version 9) and activates the journal");
  const neu = await br.tab();
  await neu.go(`${origin}/new/board/?doc=local:${id}`);
  await neu.until(`!!${B}?.snapshot?.().doc && !!window.sagebrush.boardJournal?.()`, 30000);
  await neu.ev(setTj("new 1"));
  await neu.until(`${rowExpr(id)}.then((r) => r && typeof r.hash === "string" && (r.doc.nodes ?? []).some((n) => n.text === "new 1"))`);
  const r1 = await neu.ev(rowExpr(id));
  check(Number.isSafeInteger(r1.j) && typeof r1.hash === "string" && (await neu.ev(dbVersion)) === 9, "this build's page stamped and saved the row (version 9): " + J({ j: r1.j }));
  // 3. the old page saves again: refused before anything changes
  await old.ev(setTj("old 2")).catch(() => {});
  await sleep(2000);
  await old.ev(setTj("old 3")).catch(() => {});
  await sleep(1000);
  const r2 = await neu.ev(rowExpr(id));
  const pend = await old.ev(`localStorage.getItem("sagebrush-workspace-pending:" + ${J(id)})`);
  const said = await old.ev(`document.body.innerText`);
  check(J(r2) === J(r1), "test 16: the old page's saves after the upgrade changed nothing: the row's doc, rev, j, hash and mark as this build left them");
  check(pend === null, "test 16: …nor wrote a pending copy");
  check(/reload/i.test(said), "test 16: …and it says to reload");
  // 4. the old build opening afresh: refused (a VersionError), nothing written
  const again = await br.tab();
  await again.go(`${origin}/old/board/?doc=local:${id}`);
  await sleep(4000);
  const r3 = await neu.ev(rowExpr(id));
  const hasWs = await again.ev(`!!window.sagebrush?.workspace`).catch(() => false);
  check(!hasWs && J(r3) === J(r1), "test 16: the old build opening afresh gets no workspace (VersionError), the row as it was");
  check(tjOf(r3.doc) === "new 1", "test 16: the row is this build's last save");
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: the board journal's cutover, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
} catch (e) {
  console.error("FAIL: " + (e?.stack ?? e));
} finally {
  await br.close();
  stop();
}
process.exit(code);
