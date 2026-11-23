// ci: web-artifacts.1 order=49 runner=bun chrome
// Closing an artifact's tab on the Agents page (#1792), with the scripted demo agent: three turns, three artifacts.
//   - Each tab has its ×; a middle click closes it too. Closing the tab shown shows the next one; the last closes
//     the pane.
//   - A closed tab stays closed (kept with the chat, across a reload) until the artifact is opened again: from its
//     card in the chat, from All artifacts (in the pane, and in the chat's tools when the pane is closed), or when the
//     agent writes it again.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-artifact-tabs.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "./a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 800) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;
const B = await browser();
const tabs = (P) => P.ev(`[...document.querySelectorAll('#artifacts .tab')].map((t) => t.dataset.tab)`);
const shown = (P) => P.ev(`document.querySelector('#artifacts .tab.on')?.dataset.tab ?? null`);
const closedKept = (P) => P.ev(`(() => { const s = JSON.parse(localStorage.getItem('sagebrush-agents-preview-v1') ?? 'null'); return s ? s.threads.find((t) => t.id === s.current)?.closed ?? [] : null; })()`);
try {
  const P = await B.tab();
  await P.navigate(`${site}/agents/?speed=20`);
  await P.ev(`(localStorage.clear(), true)`);
  await P.navigate(`${site}/agents/?speed=20`);
  // three turns of the scripted agent, three artifacts: a diff, code, notes
  for (const [prompt, id] of [["Please fix the failing tests in src/stats.py", "stats-diff"], ["Plot the first partial sums of a Fourier series", "plot-code"], ["Write notes on the eigenvalues of a 2x2 matrix", "doc-eig"]]) {
    await P.draft(prompt);
    await P.ev(`(document.querySelector('#send').click(), true)`);
    // (the scripted agent asks before it edits a file: allowed)
    await P.until(`(() => { const allow = [...document.querySelectorAll('#log button')].find((b) => b.textContent === 'Allow'); if (allow) allow.click(); return !!document.querySelector('#artifacts .tab[data-tab="${id}"]') && document.querySelector('#stop').hidden; })()`, 60000);
  }
  const t0 = await tabs(P);
  const xs = await P.ev(`[...document.querySelectorAll('#artifacts [data-close]')].map((x) => x.getAttribute('aria-label'))`);
  ok(JSON.stringify(t0) === '["stats-diff","plot-code","doc-eig"]' && xs.length === 3 && xs.every((l) => /^Close /.test(l)), "T1: each of the three tabs has its ×, named for its artifact", { t0, xs });

  // ---- T2: × on the tab shown: the next one is shown (none after it: the one before)
  ok((await shown(P)) === "doc-eig", "T2: the last artifact made is shown");
  await P.ev(`(document.querySelector('#artifacts [data-close="doc-eig"]').click(), true)`);
  await P.until(`!document.querySelector('#artifacts .tab[data-tab="doc-eig"]')`, 5000).catch(() => {});
  ok(JSON.stringify(await tabs(P)) === '["stats-diff","plot-code"]' && (await shown(P)) === "plot-code", "T2: its × closes it, and the tab before it is shown", { tabs: await tabs(P), shown: await shown(P) });

  // ---- T3: a middle click closes a tab not shown; the one shown stays
  await P.ev(`(() => { const t = document.querySelector('#artifacts .tab[data-tab="stats-diff"]'); t.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true })); t.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })); return true; })()`);
  await P.until(`!document.querySelector('#artifacts .tab[data-tab="stats-diff"]')`, 5000).catch(() => {});
  ok(JSON.stringify(await tabs(P)) === '["plot-code"]' && (await shown(P)) === "plot-code", "T3: a middle click closes a tab; the one shown stays", { tabs: await tabs(P), shown: await shown(P) });

  // ---- T4: the last tab's × closes the pane; the chat keeps the artifacts, with All artifacts in its tools
  await P.ev(`(document.querySelector('#artifacts [data-close="plot-code"]').click(), true)`);
  const paneGone = `document.querySelector('#artifacts').offsetWidth === 0`;
  await P.until(paneGone, 5000).catch(() => {});
  await sleep(500); // (the chat is kept 300 ms after a change)
  const k4 = await closedKept(P);
  ok((await P.ev(paneGone)) && (await P.ev(`!document.querySelector('#all-arts-chat').hidden`)) && JSON.stringify([...k4].sort()) === '["doc-eig","plot-code","stats-diff"]', "T4: the last tab's × closes the pane; the closed tabs are kept with the chat; All artifacts is in the chat's tools", k4);
  ok(await P.ev(`document.querySelectorAll('.artifact-card[data-artifact]').length >= 3`), "T4: the artifacts' cards are still in the chat");

  // ---- T5: All artifacts lists them all, closed ones said so; one chosen opens, its tab alone back
  await P.ev(`(document.querySelector('#all-arts-chat').click(), true)`);
  await P.until(`!!document.querySelector('dialog.arts-dlg[open]')`, 5000);
  const l5 = await P.ev(`[...document.querySelectorAll('dialog.arts-dlg[open] .arts-item')].map((b) => [b.dataset.art, b.textContent])`);
  ok(l5.length === 3 && l5.every(([, t]) => /closed/.test(t)) && /src\/stats\.py/.test(l5[0][1]), "T5: All artifacts lists every artifact of the chat, closed ones said so", l5);
  await P.ev(`(document.querySelector('dialog.arts-dlg[open] .arts-item[data-art="doc-eig"]').click(), true)`);
  await P.until(`document.querySelector('#artifacts .tab.on')?.dataset.tab === 'doc-eig'`, 5000).catch(() => {});
  ok(JSON.stringify(await tabs(P)) === '["doc-eig"]' && !(await P.ev(`!!document.querySelector('dialog.arts-dlg[open]')`)), "T5: choosing one opens it, its tab alone back", await tabs(P));

  // ---- T6: across a reload the closed tabs stay closed; a card in the chat brings its tab back
  await sleep(500); // (the chat is kept 300 ms after a change)
  await P.navigate(`${site}/agents/?speed=20`);
  await P.until(`document.querySelectorAll('.artifact-card[data-artifact]').length >= 3`, 15000);
  await P.ev(`(document.querySelector('.artifact-card[data-artifact="plot-code"]').click(), true)`);
  await P.until(`document.querySelector('#artifacts .tab.on')?.dataset.tab === 'plot-code'`, 5000).catch(() => {});
  const t6 = await tabs(P);
  ok(JSON.stringify(t6) === '["plot-code","doc-eig"]' && !t6.includes("stats-diff"), "T6: after a reload the closed tab stays closed; a card in the chat brings its tab back", t6);

  // ---- T7: the pane's All artifacts, the same list; a closed one chosen there comes back too
  await P.ev(`(document.querySelector('#all-arts').click(), true)`);
  await P.until(`!!document.querySelector('dialog.arts-dlg[open]')`, 5000);
  const l7 = await P.ev(`[...document.querySelectorAll('dialog.arts-dlg[open] .arts-item')].map((b) => [b.dataset.art, b.textContent])`);
  await P.ev(`(document.querySelector('dialog.arts-dlg[open] .arts-item[data-art="stats-diff"]').click(), true)`);
  await P.until(`document.querySelector('#artifacts .tab.on')?.dataset.tab === 'stats-diff'`, 5000).catch(() => {});
  ok(l7.length === 3 && /shown/.test(l7.find(([a]) => a === "plot-code")[1]) && /closed/.test(l7.find(([a]) => a === "stats-diff")[1]) && JSON.stringify(await tabs(P)) === '["stats-diff","plot-code","doc-eig"]', "T7: the pane's All artifacts lists them too (shown, closed); a closed one chosen there comes back in its place", { l7, tabs: await tabs(P) });
  await sleep(500);
  const k7 = await closedKept(P);
  ok(Array.isArray(k7) && k7.length === 0, "T7: none is kept closed once all are open again", k7);

  // ---- T8: the agent writing a closed artifact again brings its tab back, shown
  await P.ev(`(document.querySelector('#artifacts [data-close="doc-eig"]').click(), true)`);
  await P.until(`!document.querySelector('#artifacts .tab[data-tab="doc-eig"]') || document.querySelector('#artifacts').offsetWidth === 0`, 5000).catch(() => {});
  const before8 = await tabs(P);
  await P.draft("Write notes on the eigenvalues of a 2x2 matrix");
  await P.ev(`(document.querySelector('#send').click(), true)`);
  await P.until(`document.querySelector('#artifacts .tab.on')?.dataset.tab === 'doc-eig' && document.querySelector('#stop').hidden`, 60000).catch(() => {});
  ok(!before8.includes("doc-eig") && (await shown(P)) === "doc-eig", "T8: the agent writing a closed artifact again brings its tab back, shown", { before8, after: await tabs(P) });

  // ---- T9: by keyboard: Tab from a tab reaches its ×, Enter closes it, and the keyboard's place is the tab shown
  const key = async (k, code, vk, text) => { for (const type of ["keyDown", "keyUp"]) await P.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, ...(type === "keyDown" && text ? { text } : {}) }); };
  await P.ev(`(document.querySelector('#artifacts .tab[data-tab="stats-diff"]').focus(), true)`);
  await key("Tab", "Tab", 9);
  const onX = await P.ev(`document.activeElement?.dataset?.close ?? null`);
  await key("Enter", "Enter", 13, "\r");
  await P.until(`!document.querySelector('#artifacts .tab[data-tab="stats-diff"]')`, 5000).catch(() => {});
  await sleep(200);
  const after9 = await P.ev(`({ tabs: [...document.querySelectorAll('#artifacts .tab')].map((t) => t.dataset.tab), focus: document.activeElement?.dataset?.tab ?? document.activeElement?.id ?? null })`);
  ok(onX === "stats-diff" && JSON.stringify(after9.tabs) === '["plot-code","doc-eig"]' && after9.focus === "doc-eig", "T9: by keyboard, Tab from a tab reaches its ×, Enter closes it, and the keyboard is then on the tab shown", { onX, after9 });
  // (and the last one's ×: the pane closes, and the keyboard is on the chat's All artifacts)
  for (const id of ["plot-code", "doc-eig"]) {
    await P.ev(`(document.querySelector('#artifacts [data-close="${id}"]').focus(), true)`);
    await key("Enter", "Enter", 13, "\r");
    await P.until(`!document.querySelector('#artifacts .tab[data-tab="${id}"]') || document.querySelector('#artifacts').offsetWidth === 0`, 5000).catch(() => {});
    await sleep(200);
  }
  ok((await P.ev(`document.querySelector('#artifacts').offsetWidth === 0`)) && (await P.ev(`document.activeElement?.id ?? null`)) === "all-arts-chat", "T9: the last tab's × by keyboard closes the pane; the keyboard is on the chat's All artifacts", await P.ev(`document.activeElement?.id ?? document.activeElement?.tagName`));
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
