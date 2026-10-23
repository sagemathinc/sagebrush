import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// IPython.lib.display's YouTubeVideo, VimeoVideo and IFrame (and their names
// in IPython.display), as IPython's: each case's Jupyter text/html, its
// text/plain and its attributes are IPython 9.17.1's
// (test/ipython_lib_display_cases.json, from its display formatter on
// CPython 3.14.8, addresses masked). No thumbnail (IPython's image/jpeg,
// fetched from YouTube) is in the bundle.
const CASES: [string, string, string, any][] = JSON.parse(readFileSync(__dirname + "/../../test/ipython_lib_display_cases.json", "utf8"));

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    const of = (stream: string) => msgs.filter((m) => m.id === n && m.stream === stream).map((m) => m.text).join("");
    return { out: of("stdout"), err: of("stderr"), shown: msgs.filter((m) => m.id === n && m.display).map((m) => m.display) };
  };
}

test("YouTubeVideo, VimeoVideo and IFrame: IPython's HTML, text and attributes", async () => {
  const run = await session();
  assert.equal((await run("from IPython.display import YouTubeVideo, IFrame, VimeoVideo\nimport json")).err, "");
  for (const [code, plain, html, attrs] of CASES) {
    assert.equal((await run(`v = ${code}`)).err, "", code);
    assert.equal((await run("print(json.dumps(v._repr_html_()))")).out, JSON.stringify(html) + "\n", `${code}: text/html`);
    // (the cell's value, shown: IPython's text/html and text/plain, no thumbnail)
    const { shown } = await run("v");
    assert.equal(shown.length, 1, code);
    assert.deepEqual(Object.keys(shown[0]).sort(), ["text/html", "text/plain"], code);
    assert.equal(shown[0]["text/html"], html, `${code}: shown text/html`);
    assert.equal(shown[0]["text/plain"].replace(/0x[0-9a-f]+/g, "0x?"), plain, `${code}: text/plain`);
    assert.deepEqual(JSON.parse((await run("print(json.dumps(sorted(vars(v).items()), default=str))")).out), attrs, `${code}: attributes`);
  }
});

test("their names, as IPython's: IPython.display, IPython.lib.display, IPython.core.display", async () => {
  const run = await session();
  const { out, err } = await run([
    "import IPython.display as d, IPython.lib.display as ld, IPython.core.display as cd",
    "print(d.YouTubeVideo is ld.YouTubeVideo, d.IFrame is ld.IFrame, d.VimeoVideo is ld.VimeoVideo)",
    "print(cd.HTML is d.HTML, cd.Markdown is d.Markdown, cd.Image is d.Image, cd.Latex is d.Latex)",
    "print(hasattr(cd, 'display'), ld.YouTubeVideo.__mro__[1] is ld.IFrame)",
    "from IPython.core.display import HTML",
    "print(HTML('<b>x</b>')._repr_mimebundle_())",
  ].join("\n"));
  assert.equal(err, "");
  assert.equal(out, "True True True\nTrue True True True\nFalse True\n{'text/html': '<b>x</b>'}\n");
  // (and what Sagebrush lacks is an error, not something else)
  assert.match((await run("from IPython.core.display import Javascript")).err, /ImportError: cannot import name 'Javascript'/);
  assert.match((await run("from IPython.display import YouTubeVideo\nYouTubeVideo()")).err, /TypeError: .*missing 1 required positional argument: 'id'/);
  // (CPython names both missing arguments; Sagebrush's message names the first)
  assert.match((await run("from IPython.display import IFrame\nIFrame('s')")).err, /TypeError: .*missing .*'width'/);
});
