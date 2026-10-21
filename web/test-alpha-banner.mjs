// The early-alpha notice (web/alpha-banner.js, SECURITY.md): shown on
// sagebrush.space's own pages, never in a frame, never once dismissed; and
// put only in the site's pages, never in the board template (which the frame
// CoCalc embeds and downloaded boards are made from), the runner, the
// notebook component, or the page the CLI serves.
// Run after `bun web/build.ts` and `node scripts/build-cli.mjs`:
//   node web/test-alpha-banner.mjs
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const TAG = '<script src="/alpha-banner.js" defer></script>';
const script = readFileSync(join(here, "alpha-banner.js"), "utf8");

// ---- its behavior, in a small stand-in for a page
function page({ framed = false, crossOrigin = false, dismissed = false, storage = true } = {}) {
  const store = new Map(dismissed ? [["sagebrush-alpha-banner-dismissed", "1"]] : []);
  const els = [];
  const el = (tag) => {
    const e = { tag, children: [], style: {}, attrs: {}, listeners: {}, textContent: "", id: "" };
    e.setAttribute = (k, v) => (e.attrs[k] = v);
    e.addEventListener = (t, f) => (e.listeners[t] = f);
    e.append = (...c) => e.children.push(...c);
    e.remove = () => els.splice(els.indexOf(e), 1);
    return e;
  };
  const body = { append: (e) => els.push(e) };
  const document = { body, createElement: el, getElementById: (id) => els.find((e) => e.id === id) ?? null, addEventListener: () => {} };
  const localStorage = {
    getItem: (k) => {
      if (!storage) throw new Error("no storage");
      return store.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (!storage) throw new Error("no storage");
      store.set(k, v);
    },
  };
  const window = {};
  if (crossOrigin) Object.defineProperty(window, "top", { get: () => { throw new Error("cross-origin"); } });
  else window.top = framed ? {} : window;
  vm.runInNewContext(script, { window, document, localStorage });
  return { els, store };
}
{
  const p = page();
  const bar = p.els[0];
  ok(p.els.length === 1 && bar.id === "sb-alpha-banner" && /not yet security-hardened/.test(bar.children[0].textContent), "a page of the site's own shows the notice");
  ok(/position:fixed/.test(bar.style.cssText) && /bottom:0/.test(bar.style.cssText), "fixed at the window's foot: it moves nothing on the page");
  const close = bar.children.find((c) => c.tag === "button");
  close.listeners.click();
  ok(p.els.length === 0 && p.store.get("sagebrush-alpha-banner-dismissed") === "1", "dismissed, it goes, and this browser remembers");
  ok(page({ dismissed: true }).els.length === 0, "and it isn't shown again once dismissed");
  ok(page({ framed: true }).els.length === 0, "never in a frame (a page another site embeds)");
  ok(page({ crossOrigin: true }).els.length === 0, "never in a cross-origin frame either");
  ok(page({ storage: false }).els.length === 1, "without storage it is still shown (and can be dismissed for the page)");
}

// ---- where it is put
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const dist = join(here, "dist");
ok(!read(join(here, "board", "index.html")).includes("alpha-banner"), "the board template (frame and downloads are made from it) has no notice");
if (!existsSync(join(dist, "index.html"))) {
  console.log("note: no web/dist (run `bun web/build.ts`): the built pages aren't checked");
} else {
  for (const [p, what] of [
    ["index.html", "the app and landing page"],
    ["s/index.html", "a shared collection's page"],
    ["board/index.html", "the site's board page"],
  ]) ok(read(join(dist, p))?.includes(TAG), `${what} (${p}) loads the notice`);
  for (const [p, what] of [
    ["frame/board/index.html", "the frame CoCalc and other sites embed"],
    ["embed/index.html", "the notebook component's page"],
    ["runner/index.html", "the runner"],
  ]) ok(read(join(dist, p)) !== null && !read(join(dist, p)).includes("alpha-banner"), `${what} (${p}) has no notice`);
  ok(read(join(dist, "alpha-banner.js")) === script && read(join(here, "site", "public", "alpha-banner.js")) === script, "the script is served from the site's root");
}
const atlas = read(join(here, "atlas", "render.ts"));
ok(atlas.includes(TAG), "the atlas's pages (rendered by its Worker) load the notice");
ok(read(join(here, "build-articles.ts")).includes(TAG), "the articles' pages load the notice");
const gen = read(join(root, "build", "cli", "web.gen.js"));
if (gen) {
  const web = new Function(`const globalThis = {}; ${gen}; return globalThis.__SAGEBRUSH_WEB__;`)();
  const cliPage = Buffer.from(web["index.html"], "base64").toString("utf8");
  ok(!cliPage.includes("alpha-banner") && cliPage.includes("</head>"), "the page the CLI serves (sagebrush notebook) has no notice");
} else {
  console.log("note: no build/cli/web.gen.js (run node scripts/build-cli.mjs): the CLI's page isn't checked");
}

console.log(`${checks - fails.length}/${checks} passed`);
if (fails.length) process.exit(1);
