// The questions preview (web/questions), in headless Chromium: three questions
// render with typeset math; each student gets their own numbers; a right numeric
// answer, a right symbolic answer (checked by Sage in the page's worker) and a
// right choice are accepted, a wrong one is refused and costs a try, text Sage
// can't read costs none; and the mock gradebook shows the posted total.
// Builds nothing: run `bun web/build.ts` first. It serves web/dist itself.
//   node web/test-questions.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort, startServe } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };

let server = null;
const serve = startServe(() => (server = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] })));
const base = `http://127.0.0.1:${await serve.port}/`;
const profile = mkdtempSync(join(tmpdir(), "sb-questions-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }

async function tab(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(`${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timed out: " + expr); };
  return { ws, send, ev, until, errors };
}

try {
  const a = await tab(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await a.send("Runtime.enable"); await a.send("Log.enable");
  await a.send("Page.navigate", { url: new URL("questions/", base).href });
  await a.until("window.demo && document.querySelectorAll('#items .q').length === 4");
  await a.until("document.querySelectorAll('#items .katex').length >= 4");
  ok(true, "four questions render, their math typeset");
  ok(await a.ev("document.querySelectorAll('#gb tr').length") === 4, "the mock gradebook lists the roster");

  // each student their own numbers
  const promptOf = (s) => `(document.getElementById('student').value = ${JSON.stringify(s)}, document.getElementById('student').dispatchEvent(new Event('change')), document.querySelector('#items .q .prompt').textContent)`;
  const p1 = await a.ev(promptOf("Ada Lovelace")), p2 = await a.ev(promptOf("Alan Turing")), p1b = await a.ev(promptOf("Ada Lovelace"));
  ok(p1 === p1b, "a student's numbers are the same each time");
  ok(p1 !== p2, "another student's numbers differ");

  // q1 numeric: a wrong answer costs a try, the right one scores
  const q = (i) => `document.querySelectorAll('#items .q')[${i}]`;
  await a.ev(`(${q(0)}.querySelector('input').value = '1', ${q(0)}.querySelector('button').click())`);
  ok(await a.ev(`${q(0)}.querySelector('.fb').classList.contains('bad') && /2 of 3/.test(${q(0)}.querySelector('.attempts').textContent)`), "numeric: a wrong answer is refused and costs a try");
  const v = await a.ev(`(() => { const m = /v_0 = (\\d+)/.exec(${q(0)}.querySelector('.prompt [data-tex]')?.dataset.tex ?? ''); return m ? Number(m[1]) : null; })()`);
  ok(v !== null, "numeric: the prompt carries this student's v0");
  await a.ev(`(${q(0)}.querySelector('input').value = '${((v * v) / 19.6).toFixed(3)}', ${q(0)}.querySelector('button').click())`);
  ok(await a.ev(`${q(0)}.querySelector('.fb').classList.contains('ok')`), "numeric: the right answer is accepted");
  ok(await a.ev(`document.getElementById('score').textContent === '3 / 14'`), "the score counts it");

  // q2 symbolic, checked by Sage in the page's worker
  const tex = await a.ev(`${q(1)}.querySelector('.prompt [data-tex]').dataset.tex`);
  const m = /x\^\{(\d+)\} \\sin\((\d+)x\)/.exec(tex);
  ok(!!m, "symbolic: the prompt carries this student's exponent and frequency");
  const [ea, eb] = [Number(m[1]), Number(m[2])];
  await a.ev(`(${q(1)}.querySelector('input').value = '3x^2 sin(x', ${q(1)}.querySelector('button').click())`);
  await a.until(`${q(1)}.querySelector('.fb').classList.contains('bad')`, 120000);
  ok(await a.ev(`/didn't count/.test(${q(1)}.querySelector('.fb').textContent) && /3 of 3/.test(${q(1)}.querySelector('.attempts').textContent)`), "symbolic: text Sage can't read costs no try");
  await a.ev(`(${q(1)}.querySelector('input').value = 'x^${ea}*(${ea}*sin(${eb}*x)/x + ${eb}*cos(${eb}*x))', ${q(1)}.querySelector('button').click())`);
  await a.until(`${q(1)}.querySelector('.fb.ok, .fb.bad') && !${q(1)}.querySelector('.fb').classList.contains('wait')`, 120000);
  ok(await a.ev(`${q(1)}.querySelector('.fb').classList.contains('ok')`), "symbolic: an equivalent form of the derivative is accepted by Sage");
  ok(await a.ev(`!!${q(1)}.querySelector('.preview .katex')`), "symbolic: Sage's reading of the answer is typeset");

  // q3 choice
  // the right one is (c/2) e^{x^2}: the only choice with a fraction and no x^2 in front of e
  await a.ev(`(() => { const box = ${q(2)}; const right = [...box.querySelectorAll('label')].find((l) => { const t = l.querySelector('[data-tex]').dataset.tex; return t.includes('frac') && !t.includes('x^2 e'); }); right.querySelector('input').checked = true; box.querySelector('button').click(); })()`);
  ok(await a.ev(`${q(2)}.querySelector('.fb').classList.contains('ok')`), "choice: the right choice is accepted");
  ok(await a.ev(`document.getElementById('score').textContent === '10 / 14'`), "the auto-graded total is 10 / 14");
  ok(await a.ev(`[...document.querySelectorAll('#gb tr')].some((r) => /Ada Lovelace/.test(r.textContent) && /10 \\/ 14/.test(r.textContent))`), "the gradebook shows the posted total");
  ok(await a.ev(`[...document.querySelectorAll('#items .q')].slice(0, 3).every((q) => [...q.querySelectorAll('button')].every((b) => b.disabled))`), "answered questions are closed");
  ok(await a.ev(`[...document.querySelectorAll('#gb tr')].filter((r) => /\\d+ \\/ 14/.test(r.textContent)).length === 4`), "the classmates' (mock) scores are in the gradebook");

  // q4, graded by the instructor
  await a.ev(`(${q(3)}.querySelector('textarea').value = 'The product rule: one term differentiates each factor.', ${q(3)}.querySelector('button').click())`);
  ok(await a.ev(`/instructor will grade/.test(${q(3)}.querySelector('.attempts').textContent)`), "manual: the answer is submitted for grading");
  await a.ev(`document.getElementById('as-instructor').click()`);
  await a.until(`!document.getElementById('grader').hidden && document.querySelectorAll('#grader .roster button').length === 4`);
  ok(await a.ev(`document.querySelector('#grader .tabs button.on').textContent.includes('Question 4') && /to grade/.test(document.querySelector('#grader .roster button').textContent)`), "instructor: question-major view, Ada's answer to grade");
  ok(await a.ev(`/product rule/.test(document.querySelector('#grader .work .answer').textContent)`), "instructor: the stored answer is shown, nothing rerun");
  await a.ev(`(document.querySelectorAll('#grader .rubric input').forEach((c) => (c.checked = true)), document.querySelector('#grader .save').click())`);
  ok(await a.ev(`document.querySelector('#grader .roster button.on').textContent.includes('Alan Turing')`), "instructor: save moves to the next student");
  ok(await a.ev(`[...document.querySelectorAll('#gb tr')].some((r) => /Ada Lovelace/.test(r.textContent) && /14 \\/ 14/.test(r.textContent))`), "instructor: the graded total, 14 / 14, reaches the gradebook");
  await a.ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))`);
  ok(await a.ev(`document.querySelector('#grader .roster button.on').textContent.includes('Emmy Noether')`), "instructor: j goes to the next student");
  // the pager stays in one place whatever the answer's length (William, Oct 29), on a desktop and on a phone
  const pagerAt = async (i) => {
    await a.ev(`document.querySelectorAll('#grader .roster button')[${i}].click()`);
    return a.ev(`JSON.stringify(['button[data-d="-1"]', 'button[data-d="1"]', '.save'].map((sel) => { const r = document.querySelector('#grader .pager ' + sel).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }))`);
  };
  for (const [w, h, label] of [[1400, 1000, "desktop"], [390, 844, "phone"]]) {
    await a.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await a.ev(`window.scrollTo(0, 0)`);
    const at = [];
    for (const i of [0, 1, 2, 3]) at.push(await pagerAt(i));
    ok(at.every((x) => x === at[0]), `${label}: the pager's buttons are in the same place for answers of different lengths (${at[0]})`);
    ok(await a.ev(`(() => { const r = document.querySelector('#grader .pager').getBoundingClientRect(); return r.left >= 0 && r.right <= ${w} + 1; })()`), `${label}: the pager fits the width`);
    await a.ev(`document.querySelectorAll('#grader .roster button')[1].click()`);
    await a.ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await sleep(100);
    ok(await a.ev(`(() => { const g = document.getElementById('grader').getBoundingClientRect(), r = document.querySelector('#grader .pager').getBoundingClientRect(); return g.top < 0 ? Math.abs(r.top) <= 1 : r.top >= g.top; })()`), `${label}: scrolled down, the pager stays at the top of the view`);
  }
  await a.send("Emulation.clearDeviceMetricsOverride");
  await a.ev(`window.scrollTo(0, 0)`);
  await a.ev(`document.querySelector('#grader .tabs button[data-q="1"]').click()`);
  ok(await a.ev(`!!document.querySelector('#grader .work .chip.ok')`), "instructor: an auto-graded question shows its stored verdicts");
  await a.ev(`document.getElementById('as-student').click()`);
  ok(await a.ev(`document.getElementById('score').textContent === '14 / 14' && /Graded by your instructor/.test(${q(3)}.querySelector('.attempts').textContent)`), "the student sees the graded total");

  // a reload keeps the attempts (the mock course service's storage)
  await a.send("Page.reload");
  await a.until("window.demo && document.querySelectorAll('#items .q').length === 4");
  ok(await a.ev(`document.getElementById('score').textContent === '14 / 14'`), "a reload keeps this student's attempts and grades");
  ok(a.errors.length === 0, `no page errors${a.errors.length ? ": " + a.errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) {
  console.log("FAIL " + (e?.stack ?? e));
  process.exitCode = 1;
} finally {
  chrome.kill();
  server?.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), 500);
}
