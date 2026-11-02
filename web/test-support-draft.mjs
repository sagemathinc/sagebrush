// The notebook page's WebMCP tool draft_support_request (the addendum to plan-support-requests r12: agents draft
// support requests, people send them), in headless Chromium against the built site:
//   - its answer is only {drafted: true, shown: "card"}; bad drafts are refused with a message an agent can act on;
//   - the person sees a card (one: a new draft replaces it) with no link to the form in it;
//   - nothing goes to the support form's origin until the person clicks;
//   - a script's click() or a dispatched event opens nothing; the person's (trusted) click opens the filled-in form,
//     in a new tab without opener or referrer; Discard opens nothing.
// The pairing verb support.draft: web/workspace/test-agent-e2e.mjs; no verb sends one: test-agent-grant.mjs.
//   bun web/build.ts, then node web/test-support-draft.mjs
//   SUPPORT_LIVE=1 node web/test-support-draft.mjs   (also opens the filled-in form on cocalc.ai, and checks that it
//                                                      sends nothing without a click: the network, so not in CI)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-support-draft-"));
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = []; const asked = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Network.requestWillBeSent") asked.push({ url: m.params.request.url, method: m.params.request.method });
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const toForm = () => asked.filter((r) => /^https:\/\/(cocalc\.ai|support\.sagebrush\.space)\//.test(r.url));
// (the tool, as a browser with WebMCP would be given it: registerTool, caught before the page's script runs)
const draft = (args) => ev(`window.__tools.draft_support_request.execute(${JSON.stringify(args)})`);
const button = (label) => `[...document.querySelectorAll("#supportdraft button")].find((b) => b.textContent === ${JSON.stringify(label)})`;
const trustedClick = async (label) => {
  const at = await ev(`(() => { const r = ${button(label)}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
};
const SUBJECT = "Missing package: networkx";
const BODY = "I tried `import networkx` in a Python cell:\nModuleNotFoundError. Could it be added?";
try {
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `navigator.modelContext = { registerTool(t) { (window.__tools ??= {})[t.name] = t; } }; window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; };` });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  check(await until("!!window.__tools?.draft_support_request && !!window.sagebrush?.notebook"), "the page registers draft_support_request");
  const desc = await ev("window.__tools.draft_support_request.description");
  check(desc.startsWith("When you're blocked, or Sagebrush is missing a feature or package, draft a support request with draft_support_request: the person reviews it and sends it with one click. You can't send it yourself."), "its description says what it's for, and that the agent can't send it");

  // refusals: nothing shown
  for (const [args, want, why] of [
    [{ subject: "Hi", body: BODY }, /subject is 2 characters: it must be 5 to 180/, "a subject under 5"],
    [{ subject: "x".repeat(181), body: BODY }, /subject is 181 characters/, "a subject over 180"],
    [{ subject: SUBJECT, body: "short" }, /body is 5 characters: it must be 10 to 19000/, "a body under 10"],
    [{ subject: SUBJECT, body: "x".repeat(19001) }, /body is 19001 characters/, "a body over 19,000"],
    [{ kind: "urgent", subject: SUBJECT, body: BODY }, /kind is one of bug, pkg, feat, book, other/, "an unknown kind"],
    [{ subject: SUBJECT, body: BODY, email: "a@example.com" }, /unknown argument "email".*no email/, "an email"],
    [{ subject: SUBJECT, body: "é".repeat(5000) }, /as a link to the support form, over its 8000: shorten the body, or put the details in a shared Sagebrush document/, "a body too long for CoCalc's form as a link"],
  ]) {
    const r = await draft(args);
    check(r.isError === true && want.test(r.content?.[0]?.text ?? ""), `refused: ${why} (${JSON.stringify(r.content?.[0]?.text).slice(0, 140)})`);
  }
  check(!(await ev(`!!document.querySelector("#supportdraft")`)), "a refused draft shows nothing");

  // a draft: the answer is only {drafted, shown}; the card shows it, with no link in it
  const r = await draft({ subject: "First draft", body: BODY });
  const r2 = await draft({ kind: "pkg", subject: SUBJECT, body: BODY });
  check(JSON.stringify(r) === JSON.stringify(r2) && JSON.stringify(r2) === '{"content":[{"type":"text","text":"{\\"drafted\\":true,\\"shown\\":\\"card\\"}"}]}', `the answer is only {drafted: true, shown: "card"}: no URL or handle (${JSON.stringify(r2)})`);
  check((await ev(`document.querySelectorAll("#supportdraft").length`)) === 1 && (await ev(`document.querySelector("#supportdraft strong").textContent`)) === SUBJECT, "one card: a new draft replaces the one shown");
  check(/^An agent drafted a support request: Missing package: networkx/.test(await ev(`document.querySelector("#supportdraft").textContent`)), "the card says an agent drafted it, and its subject");
  check(await ev(`!document.querySelector("#supportdraft a, #supportdraft [href], #supportdraft form, #supportdraft iframe") && !/cocalc\\.ai|support\\.sagebrush/.test(document.querySelector("#supportdraft").outerHTML)`), "the card holds no link, form or frame to the support form");

  // a script's clicks open nothing
  await ev(`(() => { const b = ${button("Review and send")}; b.click(); b.dispatchEvent(new MouseEvent("click", { bubbles: true })); b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); ${button("Discard")}.click(); return true; })()`);
  await sleep(500);
  check((await ev("window.__opened.length")) === 0 && (await ev(`!!document.querySelector("#supportdraft")`)), "a script's click(), a dispatched click or key open nothing and discard nothing");
  check(toForm().length === 0, `nothing went to the support form's origin before the person's click (${asked.length} requests in all)`);

  // the person's click opens the form, filled in, in a new tab without opener or referrer
  await trustedClick("Review and send");
  check(await until("window.__opened.length === 1", 5000), "the person's click opens the form");
  const [url, target, features] = await ev("window.__opened[0]");
  const want = "https://cocalc.ai/support/new?type=task&subject=" + encodeURIComponent(`[sagebrush] pkg: ${SUBJECT}`) + "&body=" + encodeURIComponent(BODY) + "&url=https%3A%2F%2Fsagebrush.space%2F&context=";
  const ctx = decodeURIComponent(url.slice(want.length));
  check(url.startsWith(want) && /^Sagebrush [0-9a-f]{12}, python, WebMCP$/.test(ctx), `CoCalc's form, filled in, with the context line (${url.slice(0, 120)}… context ${JSON.stringify(ctx)})`);
  check(target === "_blank" && features === "noopener,noreferrer", `in a new tab, without opener or referrer (${target}, ${features})`);
  check(!(await ev(`!!document.querySelector("#supportdraft")`)), "the card goes once opened");

  // Discard: the person's click, nothing opened
  await draft({ kind: "bug", subject: "A bug, discarded", body: BODY });
  await trustedClick("Discard");
  await sleep(300);
  check(!(await ev(`!!document.querySelector("#supportdraft")`)) && (await ev("window.__opened.length")) === 1, "Discard: the card goes, nothing opened");
  check(toForm().length === 0, "and still nothing went to the support form's origin (the stub stood for the new tab)");
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));

  // the form's own guard, live: CoCalc's filled-in form sends nothing on load (the network: SUPPORT_LIVE=1 only)
  if (process.env.SUPPORT_LIVE) {
    asked.length = 0;
    await send("Page.navigate", { url });
    await sleep(12000);
    const posts = asked.filter((x) => x.method !== "GET" && /cocalc\.ai/.test(x.url));
    const filled = await ev(`[...document.querySelectorAll("input, textarea")].map((e) => e.value).join(" | ").slice(0, 400)`);
    check(!posts.some((x) => /support|ticket/i.test(x.url)), `live: CoCalc's form, opened filled in, sends no ticket without a click (${posts.map((x) => x.method + " " + x.url.slice(0, 80)).join(", ") || "no POSTs"})`);
    check(filled.includes(SUBJECT), `live: the form is filled in (${JSON.stringify(filled.slice(0, 160))})`);
  }
} catch (e) {
  check(false, "threw: " + String(e?.stack ?? e).slice(0, 800));
} finally {
  chrome.kill(); serve.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
