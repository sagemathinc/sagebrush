// ci: web-sync.2 order=85 chrome
// An assignment opened from a course (/s/#lti=<the course tool's link>), end to end in headless Chromium against
// web/dist (web/share/serve-dev.mjs) and a stand-in for the course tool.  The page is reached at the DEV site's own
// address, https://dev.sagebrush.space, and the tool at https://lti-dev.sagebrush.space: Chrome resolves both names
// to a local TLS server (a throwaway certificate, accepted by this Chrome only), which passes the site's requests on
// to web/dist and answers the tool's itself.  So the page's own pairing of the two origins is what's tested, with no
// switch for tests in it.
//   1. a student's first launch: the assignment's title, "Handed out" and its date, no version line, its files, and
//      its notebook, as handed out; the files are read from the tool, by the page, with the site as their origin;
//   2. it runs, reading its data file from the tool;
//   3. the first edit makes the student's copy, kept in this browser, and the line says how to come back to it;
//   4. a relaunch (a new link: the tool's links last 10 minutes) opens the copy, as left; "Back to the handout"
//      shows the handout, whose edits aren't kept;
//   5. another student, in the same browser, gets the handout, never the first student's copy;
//   6. the tool's refusals, and a link that isn't the paired tool's, are said in the page's words; a file that isn't
//      the one listed (wrong SHA-256) isn't opened;
//   7. where the sandbox doesn't start, the page says so in the assignment's words.
//   bun web/build.ts && node web/share/test-lti-open.mjs
// LTI_SHOTS=<dir> also saves a screenshot of the page at each step, for a look at it.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const SITE = "https://dev.sagebrush.space", TOOL = "https://lti-dev.sagebrush.space";
const dev = await startDev({ sitePort: 0, filesPort: 0 });
// (short: Chrome's singleton socket lives in the profile, and a long path kills it)
const tmp = mkdtempSync(join(tmpdir(), "sb-lti-"));
const profile = join(tmp, "p");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---- the certificate: both names, made here, trusted by no one (Chrome is told to accept any)
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=dev.sagebrush.space", "-addext", "subjectAltName=DNS:dev.sagebrush.space,DNS:lti-dev.sagebrush.space", "-keyout", join(tmp, "k.pem"), "-out", join(tmp, "c.pem")], { stdio: "ignore" });

// ---- the stand-in tool: one assignment; each link names a copy (course, student, placement) and an expiry
const nbJson = (code) => J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: code }] });
const FILES = { "hw1.ipynb": nbJson("print(open('data/points.csv').read().strip().replace('\\n', ';'))"), "data/points.csv": "x,y\n1,2\n3,4\n" };
const BYTES = Object.fromEntries(Object.entries(FILES).map(([p, t]) => [p, Buffer.from(t)]));
const CREATED = Date.UTC(2026, 10, 16, 17, 0);
const links = new Map(); // cap -> { copy, refuse?: [status, code], wrong?: path }
const toolSeen = []; // { path, origin }
const link = (copy, o = {}) => {
  const cap = "c" + randomBytes(24).toString("hex");
  links.set(cap, { copy, ...o });
  return `${TOOL}/lti/f/${cap}/manifest`;
};
const hashOf = (u) => "#lti=" + encodeURIComponent(u);
function tool(req, res) {
  const path = req.url;
  toolSeen.push({ path, origin: req.headers.origin ?? null });
  const head = { "access-control-allow-origin": SITE, vary: "origin", "cross-origin-resource-policy": "cross-origin", "cache-control": "no-store" };
  const m = path.match(/^\/lti\/f\/([A-Za-z0-9_.-]+)\/(manifest|(\d+)-(\d+)\.([0-9a-f]{32}))$/);
  const l = m && links.get(m[1]);
  if (!l) return res.writeHead(404, { ...head, "content-type": "application/json" }).end(J({ error: "not_found" }));
  if (l.refuse) return res.writeHead(l.refuse[0], { ...head, "content-type": "application/json" }).end(J({ error: l.refuse[1] }));
  const paths = Object.keys(FILES);
  if (m[2] === "manifest") {
    let at = 0;
    const files = paths.map((p, i) => {
      const f = { path: p, size: BYTES[p].length, sha256: l.wrong === p ? sha("not these bytes") : sha(BYTES[p]), url: `${TOOL}/lti/f/${m[1]}/${at}-${BYTES[p].length}.${i.toString(16).padStart(32, "0")}` };
      at += BYTES[p].length;
      return f;
    });
    return res.writeHead(200, { ...head, "content-type": "application/json" }).end(J({ copy: l.copy, title: "Homework 1", created: CREATED, sha256: sha("the bundle"), expires: Date.now() + 600_000, files }));
  }
  const p = paths[parseInt(m[5], 16)];
  if (!p) return res.writeHead(404, head).end();
  res.writeHead(200, { ...head, "content-type": "application/octet-stream" }).end(BYTES[p]);
}
// (the site: passed on to web/dist as served by serve-dev, the request as it came)
function site(req, res) {
  const up = httpRequest(dev.site + req.url, { method: req.method, headers: { ...req.headers, host: new URL(dev.site).host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => res.writeHead(502).end());
  req.pipe(up);
}
const tls = createServer({ key: readFileSync(join(tmp, "k.pem")), cert: readFileSync(join(tmp, "c.pem")) }, (req, res) => ((req.headers.host ?? "").startsWith("lti-dev.") ? tool(req, res) : site(req, res)));
await new Promise((r) => tls.listen(0, "127.0.0.1", r));
const port = tls.address().port;

const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  `--host-resolver-rules=MAP dev.sagebrush.space:443 127.0.0.1:${port}, MAP lti-dev.sagebrush.space:443 127.0.0.1:${port}, MAP * ~NOTFOUND`, "--ignore-certificate-errors", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const cdpPort = await devtoolsPort(profile, 60_000, { child: chrome });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
// (a launch: the page the tool's page sends the student to; a fragment change alone wouldn't reload it)
const launch = async (l) => { await send("Page.navigate", { url: "about:blank" }); await send("Page.navigate", { url: `${SITE}/s/${hashOf(l)}` }); };
const status = () => ev("document.querySelector('#status').textContent");
const line = () => ev("document.querySelector('#copyline').hidden ? '' : document.querySelector('#copyline').textContent");
const code = () => ev("document.querySelector('#nb .cell textarea').value");
const edit = (text) => ev(`(() => { const ta = document.querySelector('#nb .cell textarea'); ta.value = ${J(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const mine = (p) => `import(new URL("/sagebrush-share-copy.js", location.href).href).then((m) => m.openWorkspace()).then((w) => w.read(${J(p)})).then((r) => r.content.cells?.map((c) => c.code ?? c.source)).catch(() => null)`;
const ran = "(() => { const c = document.querySelector('#nb .cell'); return /\\[\\d+\\]/.test(c.querySelector('.n').textContent) && !c.classList.contains('running') && !c.classList.contains('queued'); })()";
const shot = async (name) => {
  if (!process.env.LTI_SHOTS) return;
  await sleep(300);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(process.env.LTI_SHOTS, name + ".png"), Buffer.from(r.data, "base64"));
};
const edited = () => ev("document.querySelector('#nb .cell').classList.contains('edited')");
const STUDENT_A = "a".repeat(32), STUDENT_B = "b".repeat(32);

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

  // ---- 1. a student's first launch
  await launch(link(STUDENT_A));
  await until("document.querySelector('#title').textContent === 'Homework 1' && !!document.querySelector('#nb .cell')");
  ok((await ev("location.origin")) === SITE, "the page is on the DEV site's own origin: " + (await ev("location.origin")));
  const meta = await ev("document.querySelector('#meta').textContent");
  ok(meta.includes("Handed out 2026-11-16") && !/Shared|Version/.test(meta), "the assignment says when it was handed out, with no share's version line: " + J(meta));
  ok(J(await ev("[...document.querySelectorAll('#files li')].map((li) => li.firstChild.textContent)")) === J(["hw1.ipynb", "data/points.csv"]), "its files are listed");
  ok((await ev("document.querySelector('#nbname').textContent")) === "hw1.ipynb" && /points\.csv/.test(await code()), "its notebook opens");
  ok(/^Nothing has run yet: the outputs are as handed out\./.test(await status()) && (await line()) === "", "…as handed out, with no copy yet: " + J(await status()));
  ok(J(await ev("[...document.querySelectorAll('#nbbar button')].filter((b) => !b.hidden && b.offsetParent).map((b) => b.textContent)")) === J(["▶ Run all", "■ Stop", "Download .ipynb"]), "one primary action, Run all: no \"Copy to my workspace\" (the first change makes the copy)");
  const reads = toolSeen.filter((x) => /\/manifest$|\.[0-9a-f]{32}$/.test(x.path));
  ok(reads.length >= 2 && reads.every((x) => x.origin === SITE), "the list and the notebook were read from the tool by the page, the site as their origin: " + J(reads.map((x) => x.origin)));

  await shot("1-first-launch");
  // ---- 2. it runs, reading its data file from the tool
  await ev("document.querySelector('#runall').click()");
  await until(ran, 90000);
  ok((await ev("document.querySelector('#nb .cell .out').textContent")).includes("x,y;1,2;3,4"), "it runs, reading its data file (mounted from the tool)");
  ok(/in place of the one as handed out/.test(await status()), "…and the status speaks of the handout: " + J(await status()));

  // ---- 3. the first edit makes the student's copy
  ok(!(await edited()), "the cell, as run, isn't marked edited");
  await edit("print('my answer')");
  ok(await edited(), "after the edit, the cell is marked edited: its output is the handout code's (as the notebook page marks it)");
  await until("/This is your copy/.test(document.querySelector('#copyline').textContent) && !document.querySelector('#copyline').hidden", 20000);
  const l3 = await line();
  ok(/^This is your copy, saved in this browser\. To come back to it, open the assignment from your course in this same browser\./.test(l3), "the first edit makes the student's copy, and says how to come back to it: " + J(l3));
  ok(!/Your first change makes it your own copy/.test(await status()), "…and the status no longer offers to make one: " + J(await status()));
  ok(/Back to the handout/.test(l3), "…with \"Back to the handout\"");
  ok(await ev("document.querySelector('#mine').hidden"), "…and no \"Open my copy\" button: the student is in it");
  await shot("2-first-edit");
  await until(`(${mine("/Homework 1/hw1.ipynb")}).then((c) => !!c && c.some((x) => /my answer/.test(x)))`, 10000);
  ok(true, "…the copy holds the edit, in the student's own files");
  const keys = Object.keys(JSON.parse((await ev("localStorage.getItem('sagebrush-share-copies')")) ?? "{}"));
  ok(J(keys) === J([`lti:${STUDENT_A}:hw1.ipynb`]), "…remembered under the copy's id, never the link: " + J(keys));

  // ---- 4. a relaunch, with a new link: the copy, as left
  const before = toolSeen.length;
  await launch(link(STUDENT_A));
  await until("!!document.querySelector('#nb .cell') && !document.querySelector('#copyline').hidden", 30000);
  ok(toolSeen.length > before, "the relaunch read the new link's list");
  ok(/my answer/.test(await code()) && /This is your copy/.test(await line()) && /^Your copy, as you left it/.test(await status()), "a relaunch opens the student's copy, as left");
  await shot("3-relaunch");
  await ev("document.querySelector('#runall').click()");
  await until(ran, 90000);
  ok((await ev("document.querySelector('#nb .cell .out').textContent")).includes("my answer") && !(await edited()), "run again, the copy's output is its own code's, and the edited mark goes");
  await ev("[...document.querySelectorAll('#copyline button')].find((b) => /Back to the handout/.test(b.textContent)).click()");
  await until("/This is the handout: changes here aren't kept/.test(document.querySelector('#copyline').textContent)");
  ok(!/my answer/.test(await code()), "\"Back to the handout\": the handout, without the student's edit");
  ok(!/first change makes it your own copy/.test(await status()), "…and its status doesn't offer a copy (its changes aren't kept): " + J(await status()));
  await shot("4-back-to-handout");
  await edit("print('an edit to the handout')");
  await sleep(1500);
  const after = await ev(mine("/Homework 1/hw1.ipynb"));
  ok(after && after.some((x) => /my answer/.test(x)) && !after.some((x) => /to the handout/.test(x)), "an edit to the handout isn't kept, and the copy is untouched");

  // ---- 5. another student in the same browser: the handout
  await launch(link(STUDENT_B));
  await until("!!document.querySelector('#nb .cell') && /^Nothing has run yet/.test(document.querySelector('#status').textContent)", 30000);
  ok(!/my answer/.test(await code()) && (await line()) === "", "another student gets the handout, never the first student's copy");

  // ---- 6. refusals, a foreign link, a wrong file
  for (const [st, c, words] of [[410, "expired", "This assignment link has expired. Open the assignment again from your course."], [429, "folder_budget", "This assignment link has been used up. Open the assignment again from your course."], [410, "gone", "This assignment's files are no longer available. Ask your instructor."]]) {
    await launch(link(STUDENT_A, { refuse: [st, c] }));
    await until(`document.querySelector('#status').textContent === ${J(words)}`, 20000).then(() => ok(true, `${st} ${c}: ${J(words)}`), async () => ok(false, `${st} ${c}: ${J(await status())}`));
    ok((await ev("document.querySelector('#title').textContent")) === "This assignment can't be opened", `…under "This assignment can't be opened", not "Not found"`);
    await shot("5-refused-" + c);
  }
  const n0 = toolSeen.length;
  await launch(`https://elsewhere.example/lti/f/c${"0".repeat(48)}/manifest`);
  await until("/This assignment link isn't valid/.test(document.querySelector('#status').textContent)", 20000).then(() => ok(true, "a link to another origin is refused"), async () => ok(false, "a foreign link: " + J(await status())));
  ok(toolSeen.length === n0, "…and nothing was fetched for it");
  await launch(link(STUDENT_B, { wrong: "hw1.ipynb" }));
  await until("/hw1\\.ipynb could not be loaded/.test(document.querySelector('#status').textContent)", 20000).then(() => ok(true, "a file that isn't the one listed (wrong SHA-256) isn't opened"), async () => ok(false, "wrong file: " + J(await status())));

  // ---- 7. where the sandbox doesn't start (its page held unanswered): the assignment's own words, never a share's
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/runner/*" }] });
  await launch(link(STUDENT_B));
  await until("!!document.querySelector('#nb .cell')", 30000);
  await ev("document.querySelector('#runall').click()");
  const FAILED = "Sagebrush's sandbox didn't start in this browser, so this assignment's code can't run here. Reload the page to try again.";
  await until(`document.querySelector('#status').textContent === ${J(FAILED)}`, 60000).then(() => ok(true, "a sandbox that doesn't start: the assignment's words, with no \"Copy to my workspace\" it doesn't have"), async () => ok(false, "a sandbox that doesn't start: " + J(await status())));
  await send("Fetch.disable");
} catch (e) {
  ok(false, "the test stopped: " + String(e?.message ?? e).slice(0, 400));
} finally {
  ws.close();
  chrome.kill();
  tls.close();
  await dev.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
