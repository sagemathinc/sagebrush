// The board page in the desktop app, for the app's self-test (selftest() in web/index.html, before the LaTeX editor's,
// which takes the page over): an example board opened from the app's own files (board/, app/build-frontend.mjs) runs its
// code items; a page or a module the app doesn't have is the app's server's 404 (lib.rs serve_page), never the notebook
// page at that path, which loaded its analyzer and KaTeX from there and failed until the app was restarted; and after
// the board, this page's analyzer and KaTeX module still load.
export const BOARD_CHECKS = ["a board opens and runs its code", "a page the app doesn't have isn't the notebook", "the analyzer and KaTeX still load"];
// (the example board app/dist/board/examples/ has, and what one of its items prints)
const BOARD = "/board/?doc=examples/live.board.json", PRINTS = /871 takes 178 steps/;
const until = async (f, ms) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 200))) { const v = await f(); if (v) return v; }
  return null;
};

/** The checks, each [name, ok, detail], in the desktop app only (`desktop`, the page's desktopApp(): none elsewhere, so
 * a phone's report has none, as its judge requires, app/selftest/android-report.py without --desktop); `analyze(code)`,
 * the page's analyzer's answer for a Python cell. */
export async function boardChecks({ desktop, analyze, base = location.href }) {
  if (desktop !== true) return [];
  const out = [];
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:0;top:0;width:900px;height:600px;opacity:0;pointer-events:none";
  frame.src = new URL(BOARD, base).href;
  document.body.append(frame);
  try {
    let last = "(no board)";
    const ran = await until(async () => {
      const b = frame.contentWindow?.sagebrush?.board;
      if (!b) return null;
      const os = await b.outputs().catch(() => []);
      last = JSON.stringify(os.map((o) => [o.id, o.state, (o.output ?? "").slice(0, 30)])).slice(0, 300);
      return os.some((o) => PRINTS.test(o.output ?? ""));
    }, 120000);
    out.push([BOARD_CHECKS[0], !!ran, ran ? "its items ran (\"871 takes 178 steps\")" : `at ${frame.contentWindow?.location?.pathname ?? "?"}: ${last}`]);
  } finally { frame.remove(); }
  // (a page asked for as a page, a module at the path the notebook page would have had at /board/, a file the app has not)
  const ask = async (p, accept) => {
    try {
      const r = await fetch(new URL(p, base).href, { cache: "no-store", ...(accept ? { headers: { Accept: accept } } : {}) });
      const text = await r.text();
      return `${r.status}${/isn't part of the Sagebrush app/.test(text) ? " not-in-app" : /<html|<!doctype/i.test(text) ? " html" : ""}`;
    } catch (e) { return "error " + (e?.message ?? e); }
  };
  const got = { "/agents/": await ask("/agents/", "text/html"), "/board/sagebrush-analyze.js": await ask("/board/sagebrush-analyze.js"), "/no-such-module.js": await ask("/no-such-module.js") };
  out.push([BOARD_CHECKS[1], got["/agents/"] === "404 not-in-app" && got["/board/sagebrush-analyze.js"] === "404" && got["/no-such-module.js"] === "404", JSON.stringify(got)]);
  // (this page's own: its analyzer answers, and its KaTeX module is a script, from where this page is)
  let a = null, k = "";
  try { a = await Promise.race([analyze("selftest_board_y = 2"), new Promise((r) => setTimeout(() => r({ error: { message: "no answer in 30 s" } }), 30000))]); } catch (e) { a = { error: { message: String(e?.message ?? e) } }; }
  try { const r = await fetch(new URL("sagebrush-math.js", base).href, { cache: "no-store" }); k = `${r.status} ${r.headers.get("content-type") ?? ""}`; await r.body?.cancel(); } catch (e) { k = "error " + (e?.message ?? e); }
  const analyzed = !a?.error && (a?.defs ?? []).includes("selftest_board_y");
  out.push([BOARD_CHECKS[2], analyzed && /^200 .*javascript/.test(k), `at ${new URL(base).pathname}: analyzer ${analyzed ? "answered" : JSON.stringify(a?.error ?? a).slice(0, 120)}; sagebrush-math.js ${k}`]);
  return out;
}
