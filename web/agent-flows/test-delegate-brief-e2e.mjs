// ci: none (needs the packed sagebrush-agent tarball: SAGEBRUSH_AGENT_TGZ and SAGEBRUSH_AGENT_TGZ_SHA256; run before an agent release)
// Delegate briefs end to end (PLAN-delegate-brief r2, its E2E): the real sagebrush-agent, started from its packed tarball
// with the fake model (tarball-agent.mjs), and the Agents page in headless Chrome, as a person uses them:
//   0. Pair: the person asks for a notebook, then says "Decision: plot with matplotlib, not plotly"; two turns;
//   1. turns Delegate on;
//   2. Delegate… with nothing typed: the sheet drafts the task from the chat, and its brief carries the decision;
//   3. the person edits the title, adds the notebook and starts it: the agent's own record of the task (task.json) has
//      a prompt with the decision in it;
//   4. the Pair chat shows no draft turn (still its two turns).
// BRIEF_E2E_CONTROL=old, a negative control: an agent without chat.brief (an older tarball) gives the empty sheet, as
// before; step 2 then checks that instead.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && SAGEBRUSH_AGENT_TGZ=... SAGEBRUSH_AGENT_TGZ_SHA256=... \
//     CHROME=chromium bun web/agent-flows/test-delegate-brief-e2e.mjs        (SHOT_DIR=dir: a screenshot at each step)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startSite, startChrome, sleep } from "./harness.mjs";
import { startTarballAgent, pairTarballAgent } from "./tarball-agent.mjs";

const GRANT = { folders: ["/"], write: true, run: false };
const NOTEBOOK = "/notes/plot.ipynb", DECISION = "plot with matplotlib, not plotly";
const CONTROL = process.env.BRIEF_E2E_CONTROL === "old";
/** The agent's own record of a task (task.json); null until it exists. */
const record = (agent, task) => { const f = join(agent.tasksHome, ".sagebrush", "tasks", task, "task.json"); try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; } };
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

const site = await startSite();
let page = null, agent = null;
try {
  page = await startChrome();
  agent = await startTarballAgent({ origin: site.origin });
  const shot = async (name) => { if (process.env.SHOT_DIR) await page.shot(join(process.env.SHOT_DIR, `brief-e2e-${name}.png`)); };
  const must = async (js, what, ms = 30000) => { if (!(await page.until(js, ms))) throw new Error(`${what}: not seen in ${ms / 1000} s (${await page.ev("location.href").catch(() => "?")})`); };
  const turns = () => page.ev(`document.querySelectorAll("#log .turn").length`);
  // (as the harness's chat surface types: the composer's textarea is there only once a real click on its block starts it)
  const say = async (text) => {
    if (await page.ev(`!!document.querySelector("#editor textarea")`)) await page.ev(`(document.querySelector("#editor textarea").focus(), true)`);
    else {
      const at = await page.ev(`(() => { const r = document.querySelector("#editor .mb-block").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
    await must(`document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest("#editor")`, "the composer's textarea", 10000);
    const n = await turns();
    await page.send("Input.insertText", { text });
    await page.ev(`(document.querySelector("#send").click(), true)`);
    // (a turn is done when its status line says so (.status.done), and the chat list's working dot is gone)
    await must(`document.querySelectorAll("#log .turn").length > ${n} && document.querySelectorAll("#log .turn .status.done").length === document.querySelectorAll("#log .turn").length && !document.querySelector("#threads .dot")`, `the turn for ${JSON.stringify(text)}, ended`, 60000);
  };

  // ---- 0. Pair: a notebook, then a decision
  await pairTarballAgent(page, site, agent, GRANT);
  await must(`document.querySelector("#connect")?.textContent === "Connected"`, "connected");
  await must(`!!document.querySelector("#editor .mb-block, #editor textarea")`, "the composer");
  await say("make the e2e notebook");
  await must(`document.querySelector(".pane-head .tab.on")?.dataset.tab === ${JSON.stringify(NOTEBOOK)}`, "the agent's notebook beside the chat", 60000);
  await say("Decision: " + DECISION);
  const pairTurns = await turns();
  ok(pairTurns >= 2, "0. Pair: a notebook made, then the decision said; the chat's turns: " + pairTurns);
  await shot("0-pair");

  // ---- 1. Delegate on
  await must(`!!document.querySelector("#delegate-switch")?.offsetParent && document.querySelector("#delegate-switch").textContent === "Delegate: off"`, "the Delegate switch, off");
  await page.ev(`(document.querySelector("#delegate-switch").click(), true)`);
  await must(`[...document.querySelectorAll("dialog.delegate-dlg[open] button")].some((b) => b.textContent === "Turn on")`, "the switch's confirmation");
  await page.ev(`([...document.querySelectorAll("dialog.delegate-dlg[open] button")].find((b) => b.textContent === "Turn on").click(), true)`);
  await must(`document.querySelector("#delegate-switch").textContent === "Delegate: on"`, "Delegate: on");
  ok(true, "1. Delegate turned on");

  // ---- 2. Delegate… with nothing typed: the brief drafted from the chat
  // (the agent may still be retiring the last turn a moment after the page shows it done, and answers busy then: the
  //  sheet is opened again, as a person would, a few times)
  for (let i = 0; i < 4; i++) {
    await page.ev(`(document.querySelector("#delegate").click(), true)`);
    await must(`!!document.querySelector("dialog.sheet[open]")`, "the Delegate sheet");
    if (CONTROL) break;
    await must(`!document.querySelector("dialog.sheet[open] .brief-drafting") || document.querySelector("dialog.sheet[open] .brief-drafting").hidden`, "the draft's end", 70000);
    if (!/busy/.test(await page.ev(`document.querySelector("dialog.sheet[open] .msg").textContent`))) break;
    await page.ev(`([...document.querySelectorAll("dialog.sheet[open] button")].find((b) => b.textContent === "Cancel").click(), true)`);
    await sleep(2000);
  }
  if (CONTROL) {
    await sleep(1500);
    const s = await page.ev(`(() => { const d = document.querySelector("dialog.sheet[open]"); const l = d.querySelector(".brief-drafting"); return { drafting: !!l && !l.hidden, prompt: d.querySelector("#delegate-prompt").value }; })()`);
    ok(!s.drafting && s.prompt === "", "2. (control) an agent without chat.brief: the sheet empty, as before, nothing drafted", s);
  } else {
    await must(`document.querySelector("dialog.sheet[open] #delegate-prompt").value !== "" && document.querySelector("dialog.sheet[open] .brief-drafting")?.hidden`, "the drafted brief in the sheet", 70000);
    const s = await page.ev(`(() => { const d = document.querySelector("dialog.sheet[open]"); return { prompt: d.querySelector("#delegate-prompt").value, title: d.querySelector("#delegate-title").value, ro: d.querySelector("#delegate-prompt").readOnly, msg: d.querySelector(".msg").textContent }; })()`);
    ok(s.prompt.includes(DECISION) && s.title.length > 0 && !s.ro && s.msg === "", "2. the sheet drafted the task from the chat: its brief carries the decision, title and brief editable", { title: s.title, prompt: s.prompt.slice(0, 300), msg: s.msg });
    await shot("2-drafted");

    // ---- 3. edited, started: the agent's own record has the decision in its prompt
    await page.ev(`(() => { const d = document.querySelector("dialog.sheet[open]"); d.querySelector("#delegate-title").value = "Plot with matplotlib"; const r = d.querySelector("#delegate-run"); if (r.checked) r.click(); return true; })()`);
    const docs = await page.ev(`[...document.querySelectorAll("dialog.sheet[open] .docs li")].map((li) => li.dataset.path)`);
    if (!docs.includes(NOTEBOOK.slice(1))) await page.ev(`(() => { const i = document.querySelector("#delegate-add"); i.value = ${JSON.stringify(NOTEBOOK.slice(1))}; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); return true; })()`);
    await page.ev(`(document.querySelector("dialog.sheet[open] button[type=submit]").click(), true)`);
    await must(`!document.querySelector("dialog.sheet[open]") && document.querySelector("#task-view h2")?.textContent === "Plot with matplotlib"`, "the started task's view");
    const task = await page.ev(`document.querySelector("#tasks .task.on")?.dataset.task ?? null`);
    let rec = null;
    for (const t = Date.now(); Date.now() - t < 10000 && !rec; await sleep(200)) rec = task && record(agent, task);
    ok(/^[0-9a-f]{32}$/.test(task ?? "") && rec?.title === "Plot with matplotlib" && String(rec?.prompt ?? "").includes(DECISION), "3. started with the edited title: the agent's own record (task.json) has the decision in its prompt", { task, title: rec?.title, prompt: String(rec?.prompt ?? "").slice(0, 200) });
    await shot("3-started");

    // ---- 4. the Pair chat: no draft turn
    await page.ev(`(document.querySelector("#task-view .task-head .link").click(), true)`);
    await must(`!!document.querySelector("#log")?.offsetParent`, "the chat again");
    const after = await turns();
    ok(after === pairTurns, "4. the Pair chat shows no draft turn: still its " + pairTurns + " turns", { pairTurns, after });
  }
  ok(page.errors.length === 0, "no page errors", page.errors);
} catch (e) {
  ok(false, "the case ran to its end: " + (e?.stack ?? e));
  if (page) console.log("the sheet: " + JSON.stringify(await page.ev(`(() => { const d = document.querySelector("dialog.sheet[open]"); if (!d) return null; const l = d.querySelector(".brief-drafting"); return { drafting: !!l && !l.hidden, prompt: d.querySelector("#delegate-prompt").value.slice(0, 200), title: d.querySelector("#delegate-title").value, msg: d.querySelector(".msg").textContent }; })()`).catch((x) => String(x))));
  if (agent) { const o = agent.output(); console.log("the agent said (last lines):\n  " + String(o.stdout ?? "").concat(String(o.stderr ?? "")).split("\n").slice(-25).join("\n  ")); }
} finally {
  await agent?.stop().catch(() => {});
  await page?.close().catch(() => {});
  site.close();
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
