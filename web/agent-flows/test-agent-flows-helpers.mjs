// ci: web-runner order=187 runner=bun
// The agent-flow harness's own checks, against a stand-in page and surface (no browser): each must fail where the person
// wouldn't see what the case asks for, so a case can't pass on the saved copy alone or on a file of the same name.
//   bun web/agent-flows/test-agent-flows-helpers.mjs
import { helpers } from "./harness.mjs";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 300))); if (!c) failures++; };
const PLOT = { output_type: "display_data", data: { "image/svg+xml": "<svg/>", "text/plain": "plot" } };

/** A page showing `shown`, with `live` (cells' outputs, or null: nothing rendered), and a saved copy with `saved`. */
function stand(shown, live, saved) {
  const surface = {
    name: "chat",
    shownPath: "SHOWN",
    liveCells: "LIVE",
    tool: async (name) => name === "workspace_read" ? { isError: false, structured: { result: { content: { json: { mode: "sage", cells: saved.map((o) => ({ code: "x", outputs: o })) } } } } } : { isError: false, structured: { result: {} } },
  };
  const ev = async (js) => js === "SHOWN" ? shown : js === "LIVE" ? live : (js.startsWith("Promise.resolve(SHOWN)") ? eval(js.replace("Promise.resolve(SHOWN)", "Promise.resolve(" + JSON.stringify(shown) + ")")) : null);
  const page = { ev, until: async (js, ms = 0) => !!(await ev(js)), origin: "http://x" };
  const fails = [];
  const quiet = console.log;
  return { h: helpers(page, surface, fails, null, "self-check"), fails, quiet };
}

async function check(name, f) {
  const log = console.log;
  console.log = () => {};
  try { return await f(); } finally { console.log = log; }
}

// (1) shown: the full path, exactly; a notebook of the same name in another folder is not it
{
  const a = stand("/wrong-folder/sin.ipynb", null, []);
  await check("shown", () => a.h.shown("/wanted-folder/sin.ipynb", 10));
  ok(a.fails.length === 1, "h.shown fails when the page shows another folder's notebook of the same name", a.fails);
  const b = stand("/wanted-folder/sin.ipynb", null, []);
  await check("shown", () => b.h.shown("/wanted-folder/sin.ipynb", 10));
  ok(b.fails.length === 0, "...and passes when it shows that exact path", b.fails);
}

// (2) ran: as the person sees it, not only the saved copy
{
  const a = stand("/sin.ipynb", null, [[PLOT]]);
  await check("ran", () => a.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(a.fails.length === 1 && /as the person sees it/.test(a.fails[0]), "h.ran fails when the saved copy has the plot but the page shows no outputs", a.fails);
  const b = stand("/other.ipynb", [[PLOT]], [[PLOT]]);
  await check("ran", () => b.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(b.fails.length === 1 && /as the person sees it/.test(b.fails[0]), "...and when the page shows the plot of another notebook", b.fails);
  const c = stand("/sin.ipynb", [[PLOT]], [[]]);
  await check("ran", () => c.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(c.fails.length === 1 && /saved/.test(c.fails[0]), "...and when the page shows it but the saved copy hasn't it", c.fails);
  const d = stand("/sin.ipynb", [[PLOT]], [[PLOT]]);
  await check("ran", () => d.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(d.fails.length === 0, "...and passes when both have it", d.fails);
  const e = stand("/sin.ipynb", [[PLOT, { output_type: "error", ename: "E", evalue: "x", traceback: [] }]], [[PLOT]]);
  await check("ran", () => e.h.ran("/sin.ipynb", { images: 1, errors: 0 }, 10));
  ok(e.fails.length === 1, "...and fails on an error the person sees", e.fails);
}

console.log(failures ? `FAIL: ${failures} of the harness's self-checks` : "ok: the harness's self-checks");
process.exit(failures ? 1 : 0);
