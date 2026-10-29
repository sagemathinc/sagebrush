// The board journal's cutover (test 16): two builds of the site served from ONE
// origin (one IndexedDB), the build from before the board journal under /old/ (SB_DIST_OLD) and this one under /new/
// (SB_DIST): a page of the old build, open on a board, can't change its row once a page of this build has opened the
// workspace (version 9's upgrade closes it), so the row's doc, rev, j, hash and mark stay one coherent set; and an old
// build opening afresh is refused (a VersionError), writing nothing.  Each build's pages load their own build's
// board.js (serve() moves a prefixed build's absolute src/href under its prefix; checked here from the
// server's own record: the rewrite counts, each board.js path's sha256 against its dist's, and no 404 under /board/).
//   SB_DIST_OLD=<master's web/dist> SB_DIST=web/dist CHROME=google-chrome bun web/board/test-board-journal-cutover.mjs
import { join } from "node:path";
import { serve, browser, sleep, rowExpr, activateExpr, section, checked, bounded, unlessEnding } from "./test-board-journal-lib.mjs";

const here = new URL(".", import.meta.url).pathname;
const J = JSON.stringify;
const results = [];
// (each check said as it is done)
const check = (ok, what) => { results.push([!!ok, what]); checked(ok, what); };
if (!process.env.SB_DIST_OLD) { console.error("FAIL: SB_DIST_OLD (the earlier build's web/dist) is needed"); process.exit(1); }
const B = "window.sagebrush.board";
const setTj = (text) => `Promise.resolve(${B}.edit((d) => { const ns = d.pages ? d.pages[0].nodes : (d.nodes ??= []); const x = ns.find((n) => n.id === "tj"); if (x) x.text = ${J(text)}; else ns.push({ id: "tj", x: 40, y: 40, text: ${J(text)} }); }))`;
const tjOf = (d) => (d ? (d.pages ? d.pages[0].nodes : d.nodes ?? []).find((n) => n.id === "tj")?.text : undefined);
const dbVersion = `new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => { const v = r.result.version; r.result.close(); ok(v); }; r.onerror = () => ok(null); })`;

// (its own bound, 540 s, under the VM step's 600 s: a hang ends in one FAIL line naming its step, its last check
// and the DevTools call in flight, Chrome closed; a SIGTERM the same)
// (the server and the browser set up inside the one try, so their failure is this run's one FAIL line
// and whatever was set up is cleaned up)
let stop = () => {}, br = null, code = 1;
bounded("the cutover test", 540_000, async () => stop());
try {
  const served = await serve({ "/old": process.env.SB_DIST_OLD, "/new": process.env.SB_DIST ?? join(here, "../dist") });
  stop = served.stop;
  const { origin, stats } = served;
  br = await browser();
  section("1. the old build's page makes a board, saves an edit, and stays open on it");
  const old = await br.tab("old");
  await old.go(`${origin}/old/board/?new=python`);
  if (!(await old.until(`location.search.includes("doc=local:") && !!${B}?.snapshot?.().doc`, 30000))) throw new Error("the old build's board didn't open: " + (await old.state()));
  const id = await old.ev(`new URLSearchParams(location.search).get("doc").slice(6)`);
  await old.ev(setTj("old 1"));
  await old.until(`${rowExpr(id)}.then((r) => r && (r.doc.nodes ?? []).some((n) => n.text === "old 1"))`);
  check((await old.ev(dbVersion)) === 8, "the old build's workspace is version 8");
  section("2. this build: the journal activated, and the board opened journaled: the row stamped, then saved");
  const helper = await br.tab("helper");
  await helper.go(`${origin}/__bj/`);
  if (!(await helper.until("window.ready === true"))) throw new Error("the helper page didn't load: " + (await helper.state()));
  check(await helper.ev(activateExpr), "this build opens the workspace (version 9) and activates the journal");
  const neu = await br.tab("new");
  await neu.go(`${origin}/new/board/?doc=local:${id}`);
  if (!(await neu.until(`!!${B}?.snapshot?.().doc && !!window.sagebrush.boardJournal?.()`, 30000))) throw new Error("this build's board didn't open journaled: " + (await neu.state()));
  await neu.ev(setTj("new 1"));
  await neu.until(`${rowExpr(id)}.then((r) => r && typeof r.hash === "string" && (r.doc.nodes ?? []).some((n) => n.text === "new 1"))`);
  const r1 = await neu.ev(rowExpr(id));
  check(Number.isSafeInteger(r1.j) && typeof r1.hash === "string" && (await neu.ev(dbVersion)) === 9, "this build's page stamped and saved the row (version 9): " + J({ j: r1.j }));
  section("3. the old page saves again: refused before anything changes");
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
  section("4. the old build opening afresh: refused (a VersionError), nothing written");
  const again = await br.tab("old again");
  await again.go(`${origin}/old/board/?doc=local:${id}`);
  await sleep(4000);
  const r3 = await neu.ev(rowExpr(id));
  const hasWs = await again.ev(`!!window.sagebrush?.workspace`).catch(() => false);
  check(!hasWs && J(r3) === J(r1), "test 16: the old build opening afresh gets no workspace (VersionError), the row as it was");
  check(tjOf(r3.doc) === "new 1", "test 16: the row is this build's last save");
  section("5. each build's pages ran their own build's board.js (the prefix rewrite)");
  // (each page's own record: the board.js its document loaded, by URL)
  const ran = async (t) => t.ev(`performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.endsWith("/board/board.js"))`, 5000).catch(() => null);
  const ranOld = await ran(old), ranNew = await ran(neu);
  check(J(ranOld) === J(["/old/board/board.js"]) && J(ranNew) === J(["/new/board/board.js"]), "the prefix rewrite: the old page loaded /old/board/board.js and this build's /new/board/board.js, nothing else: " + J({ old: ranOld, new: ranNew }));
  check(stats.rewrites.get("/old/board/") > 0 && stats.rewrites.get("/new/board/") > 0, "the prefix rewrite: each build's board/index.html had its absolute src/href moved under its prefix: " + J(Object.fromEntries(stats.rewrites)));
  check(!!stats.roots["/old"] && !!stats.roots["/new"] && stats.roots["/old"] !== stats.roots["/new"] && stats.scripts.get("/old/board/board.js") === stats.roots["/old"] && stats.scripts.get("/new/board/board.js") === stats.roots["/new"], "the prefix rewrite: the board.js served under each prefix is that build's own (sha256 as its dist has it), the two builds' different: " + J({ roots: stats.roots, served: Object.fromEntries(stats.scripts) }));
  // (EVERY 404 against an explicit allowlist, so no absolute URL the rewrite didn't move (a
  // single-quoted src, an import(), fetch() or Worker, a CSS url(), a path outside /board/) passes unread)
  const allowed404 = ["/favicon.ico"], stray = [...stats.missing].filter((p) => !allowed404.includes(p));
  check(stray.length === 0, "the prefix rewrite: no 404 but the allowlist's (" + J(allowed404) + "): every 404 path " + J([...stats.missing]));
  await unlessEnding();
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: the board journal's cutover, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
} catch (e) {
  await unlessEnding();
  console.error("FAIL: " + (e?.stack ?? e));
} finally {
  await unlessEnding();
  await br?.close();
  stop();
}
await unlessEnding();
process.exit(code);
