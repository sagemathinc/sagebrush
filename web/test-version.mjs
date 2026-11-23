// ci: checks.3 order=51 runner=bun
// The site's version stamp (web/version.ts): GET /api/version from the Worker's build id and release, the page's
// strict check of the answer, the one-line stamp, and where the pages show it.
//   bun web/test-version.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appStampText, handleVersion, mountVersionStamp, parseAppVersion, parseVersion, stampText, versionOf } from "./version.ts";

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};

const CORE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const BUILT = "2026-11-21T21:40:12.345Z";
const good = { core: CORE, n: 38, built: BUILT };

// ---- the answer's shape: exactly three keys, each checked
ok(JSON.stringify(parseVersion(good)) === JSON.stringify(good), "a well-formed answer is taken");
for (const [bad, why] of [
  [null, "null"],
  [[good], "an array"],
  ["core", "a string"],
  [{ ...good, extra: 1 }, "an extra key"],
  [{ core: CORE, n: 38 }, "a missing key"],
  [{ ...good, core: CORE.toUpperCase() }, "an uppercase sha"],
  [{ ...good, core: CORE.slice(0, 39) }, "a short sha"],
  [{ ...good, core: "<b>" + CORE.slice(3) }, "markup in the sha"],
  [{ ...good, n: 0 }, "n 0"],
  [{ ...good, n: 1.5 }, "a fractional n"],
  [{ ...good, n: "38" }, "n as a string"],
  [{ ...good, built: "2026-11-21" }, "a date without a time"],
  [{ ...good, built: "2026-13-45T99:99:99.999Z" }, "an impossible time"],
  [{ ...good, built: BUILT + "<script>" }, "markup after the time"],
]) ok(parseVersion(bad) === null, `refused: ${why}`);

// ---- the stamp
ok(stampText(good) === "core 1a2b3c4d · cloud n38 · 2026-11-21 21:40 UTC", `the stamp: ${stampText(good)}`);

// ---- from build-id.ts: BUILD is the build's time in base 36; RELEASE only on a release build
const ms = Date.parse(BUILT);
const BUILD = ms.toString(36);
ok(JSON.stringify(versionOf({ BUILD, RELEASE: { n: 38, core: CORE } })) === JSON.stringify(good), "versionOf: BUILD and RELEASE");
ok(versionOf({ BUILD }) === null, "versionOf: no RELEASE (a local or preview build) is nothing");
ok(versionOf({ BUILD, RELEASE: null }) === null, "versionOf: a null RELEASE is nothing");
ok(versionOf({ BUILD, RELEASE: { n: 0, core: CORE } }) === null, "versionOf: a bad release is nothing");
ok(versionOf({ BUILD: "not base36!", RELEASE: { n: 38, core: CORE } }) === null, "versionOf: a bad BUILD is nothing");
ok(versionOf({ RELEASE: { n: 38, core: CORE } }) === null, "versionOf: no BUILD is nothing");

// ---- the route
const id = { BUILD, RELEASE: { n: 38, core: CORE } };
const req = (path, method = "GET") => new Request("https://dev.example.test" + path, { method });
const r = handleVersion(req("/api/version"), id);
ok(r?.status === 200, "GET /api/version answers 200");
ok(r?.headers.get("cache-control") === "no-store", "never cached");
ok(r?.headers.get("content-type") === "application/json", "JSON");
ok(JSON.stringify(await r?.json()) === JSON.stringify(good), "its body is the version");
const h = handleVersion(req("/api/version", "HEAD"), id);
ok(h?.status === 200 && (await h.text()) === "", "HEAD: 200 with no body");
ok(handleVersion(req("/api/version", "POST"), id) === null, "POST isn't answered here");
ok(handleVersion(req("/api/versions"), id) === null, "another path isn't answered");
ok(handleVersion(req("/api/version/x"), id) === null, "a longer path isn't answered");
ok(handleVersion(req("/api/version"), { BUILD }) === null, "a build with no release answers nothing (the 404 page)");

// ---- the page side: shown only for a checked answer, written as text
const el = () => {
  const e = { hidden: true, textContent: "", title: "" };
  Object.defineProperty(e, "innerHTML", { set() { throw new Error("innerHTML written"); } });
  return e;
};
const answer = (status, body) => async (url, init) => {
  if (url !== "/api/version" || init?.cache !== "no-store") throw new Error("unexpected request " + url);
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};
let e = el();
ok((await mountVersionStamp(e, answer(200, good))) === true && e.hidden === false, "shown for a good answer");
ok(e.textContent === stampText(good), "its text is the stamp");
ok(e.title.includes(CORE) && e.title.includes(BUILT), "its title has the full sha and time");
for (const [status, body, why] of [
  [404, "not found", "a 404"],
  [200, "<html>", "a body that isn't JSON"],
  [200, { ...good, n: "38" }, "a malformed answer"],
  [500, good, "an error status"],
]) {
  e = el();
  ok((await mountVersionStamp(e, answer(status, body))) === false && e.hidden === true && e.textContent === "", `hidden for ${why}`);
}
e = el();
ok((await mountVersionStamp(e, async () => { throw new Error("offline"); })) === false && e.hidden === true, "hidden when the fetch fails");
ok((await mountVersionStamp(null, answer(200, good))) === false, "no element: nothing");

// ---- the desktop app: its own build (window.__SB_APP_VERSION__, app/src-tauri/src/version.rs), and no request
const APP = { version: "0.4.0", commit: CORE };
const never = async () => { throw new Error("the app's stamp asked a server"); };
e = el();
ok((await mountVersionStamp(e, never, APP)) === true && e.hidden === false && e.textContent === `Sagebrush app 0.4.0 · ${CORE.slice(0, 8)}`, `the app's stamp: ${e.textContent}`);
ok(e.title.includes(CORE) && e.title.includes("0.4.0"), "its title has the full commit and the version");
e = el();
ok((await mountVersionStamp(e, never, { version: "0.4.0", commit: "unknown" })) === true && e.textContent === "Sagebrush app 0.4.0 · commit unknown", "a build outside a checkout says so");
for (const [bad, why] of [
  [{ version: "0.4.0" }, "no commit"],
  [{ ...APP, extra: 1 }, "an extra key"],
  [{ ...APP, commit: CORE.toUpperCase() }, "an uppercase commit"],
  [{ ...APP, commit: CORE.slice(0, 8) }, "a short commit"],
  [{ ...APP, version: "0.4" }, "a version of two numbers"],
  [{ ...APP, version: "<b>0.4.0</b>" }, "markup in the version"],
  [null, "null"],
  ["0.4.0", "a string"],
]) {
  e = el();
  ok(parseAppVersion(bad) === null && (await mountVersionStamp(e, never, bad)) === false && e.hidden === true && e.textContent === "", `the app's stamp is hidden for ${why}`);
}
ok(appStampText(parseAppVersion(APP)) === `Sagebrush app 0.4.0 · ${CORE.slice(0, 8)}`, "appStampText");

// ---- where the pages put it
const index = readFileSync(join(here, "index.html"), "utf8");
const foot = index.slice(index.indexOf("  <footer>\n"), index.indexOf("  </footer>"));
ok(foot.includes('<p class="sbver" id="sbversion" hidden></p>'), "the landing page's footer has the stamp's place, hidden");
ok(/mountVersionStamp\(document\.getElementById\("sbversion"\)\)/.test(index), "the landing page mounts it");
const agents = readFileSync(join(here, "agents", "index.html"), "utf8");
ok(agents.includes('<div class="foot sbver" id="sbversion" hidden></div>'), "the agents page has the stamp's place, hidden");
const page = readFileSync(join(here, "agents", "page.ts"), "utf8");
ok(page.includes('void mountVersionStamp(document.getElementById("sbversion"));'), "the agents page mounts it");
const site = readFileSync(join(here, "site", "src", "index.ts"), "utf8");
const at = site.indexOf("handleVersion(request, BUILD_ID)");
ok(at > 0 && at < site.indexOf("handleShare(request"), "the site Worker answers /api/version before anything else");

if (fails.length) {
  console.log(`FAIL: ${fails.length} of ${checks} checks`);
  process.exit(1);
}
console.log(`version: all ${checks} checks passed`);
