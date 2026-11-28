// ci: none (needs the packed sagebrush-agent tarball: SAGEBRUSH_AGENT_TGZ and SAGEBRUSH_AGENT_TGZ_SHA256; run before an agent release)
// Delegate end to end (Pair and Delegate plan, E2E): the real sagebrush-agent, started from its packed tarball with the
// fake model (tarball-agent.mjs), and the Agents page in headless Chrome, as a person uses them:
//   0. Pair: the person asks for a notebook; the agent writes /notes/plot.ipynb, shown beside the chat;
//   1. turns Delegate on (its confirmation);
//   2. starts a task on that notebook (Delegate…, the sheet: the file open in the pane as its document);
//   3. closes the page while the task is still working (checked: its chip, and the agent's own task record);
//   4. with no page paired, the agent finishes the task: its own record (task.json, under the agent's tasks home)
//      reaches the proposal before anything is opened again;
//   5. reopens the page, pairs again with the agent's fresh code, and turns Delegate on again (a new pairing starts
//      with it off);
//   6. sees the task's proposal: Proposal ready, the notebook changed, its diff with the added cell;
//   7. merges it: the chip says Merged, the agent's own record says merged, and the person's notebook, open beside the
//      chat, has the cell the agent added.
// DELEGATE_E2E_CONTROL=paused, a negative control: the agent is paused while no page is paired, so step 4 must FAIL
// (the case then exits 1, saying so).
//   (the agent's record: SAGEBRUSH_TASKS_HOME/.sagebrush/tasks/<task>/task.json, its status and proposals)
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && SAGEBRUSH_AGENT_TGZ=... SAGEBRUSH_AGENT_TGZ_SHA256=... \
//     CHROME=chromium bun web/agent-flows/test-delegate-e2e.mjs        (SHOT_DIR=dir: a screenshot at each step)
//   DELEGATE_E2E_SITE=https://dev.sagebrush.space: the same steps against a deployed site's Agents page instead of a
//   local build (the agent still runs here, with the fake model)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startSite, startChrome, sleep } from "./harness.mjs";
import { startTarballAgent, pairTarballAgent } from "./tarball-agent.mjs";

// (May run code off: with it on, a notebook the agent creates would run once by itself in the browser; not needed here)
const GRANT = { folders: ["/"], write: true, run: false };
const NOTEBOOK = "/notes/plot.ipynb", NOTE = "Done by the fake model, for this task.";
const CONTROL = process.env.DELEGATE_E2E_CONTROL === "paused";
// (how long the agent has, with no page, to reach the proposal: its fake model waits 3 s, then works)
const UNPAIRED_MS = CONTROL ? 20_000 : 60_000;
/** The agent's own record of a task (task.json), as it keeps it on disk; null until it exists. */
const record = (agent, task) => { const f = join(agent.tasksHome, ".sagebrush", "tasks", task, "task.json"); try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; } };
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

const SITE = process.env.DELEGATE_E2E_SITE;
if (SITE && !/^https:\/\/[a-z0-9.-]+$/.test(SITE)) throw new Error("DELEGATE_E2E_SITE: an https origin, nothing after it");
const site = SITE ? { origin: SITE, close() {} } : await startSite();
let page = null, agent = null;
try {
  page = await startChrome();
  // (a deployed https site reaching the agent on this computer needs the person's OK for local network access, as
  //  Chrome asks a person; headless, it is granted here, for that origin only)
  //  (Chrome's names for it change across versions: each one this Chrome knows is granted, the others refused)
  if (SITE) {
    const granted = [];
    for (const name of ["localNetworkAccess", "localNetwork", "loopbackNetwork"]) {
      try { await page.send("Browser.grantPermissions", { origin: SITE, permissions: [name] }); granted.push(name); } catch {}
    }
    console.log("local network access granted to " + SITE + ": " + (granted.join(", ") || "none (this Chrome knows none of them)"));
  }
  agent = await startTarballAgent({ origin: site.origin });
  const shot = async (name) => { if (process.env.SHOT_DIR) await page.shot(join(process.env.SHOT_DIR, `delegate-e2e-${name}.png`)); };
  const must = async (js, what, ms = 30000) => { if (!(await page.until(js, ms))) throw new Error(`${what}: not seen in ${ms / 1000} s (${await page.ev("location.href").catch(() => "?")})`); };
  const turnOn = async () => {
    await must(`!!document.querySelector("#delegate-switch")?.offsetParent && document.querySelector("#delegate-switch").textContent === "Delegate: off"`, "the Delegate switch, off");
    await page.ev(`(document.querySelector("#delegate-switch").click(), true)`);
    await must(`[...document.querySelectorAll("dialog.delegate-dlg[open] button")].some((b) => b.textContent === "Turn on")`, "the switch's confirmation");
    await page.ev(`([...document.querySelectorAll("dialog.delegate-dlg[open] button")].find((b) => b.textContent === "Turn on").click(), true)`);
    await must(`document.querySelector("#delegate-switch").textContent === "Delegate: on"`, "Delegate: on");
  };

  // ---- 0. Pair: the person asks for a notebook
  await pairTarballAgent(page, site, agent, GRANT);
  await must(`document.querySelector("#connect")?.textContent === "Connected"`, "connected");
  await must(`!!document.querySelector("#editor .mb-block, #editor textarea")`, "the composer");
  // (as the harness's chat surface types: the composer's textarea is there only once a real click on its block starts it)
  if (await page.ev(`!!document.querySelector("#editor textarea")`)) await page.ev(`(document.querySelector("#editor textarea").focus(), true)`);
  else {
    const at = await page.ev(`(() => { const r = document.querySelector("#editor .mb-block").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  }
  await must(`document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest("#editor")`, "the composer's textarea", 10000);
  await page.send("Input.insertText", { text: "make the e2e notebook" });
  await page.ev(`(document.querySelector("#send").click(), true)`);
  await must(`document.querySelector(".pane-head .tab.on")?.dataset.tab === ${JSON.stringify(NOTEBOOK)}`, "the agent's notebook beside the chat", 60000);
  await must(`[...document.querySelectorAll(".turn")].some((t) => t.textContent.includes("Done: run the cells beside the chat."))`, "the Pair turn's end", 60000);
  ok(true, "0. Pair: the agent wrote " + NOTEBOOK + ", shown beside the chat");
  await shot("0-pair");

  // ---- 1. Delegate on
  await turnOn();
  ok(true, "1. Delegate turned on, after its confirmation");

  // ---- 2. a task on that notebook
  await page.ev(`(document.querySelector("#delegate").click(), true)`);
  await must(`!!document.querySelector("dialog.sheet[open]")`, "the Delegate sheet");
  const docs = await page.ev(`[...document.querySelectorAll("dialog.sheet[open] .docs li")].map((li) => li.dataset.path)`);
  if (!docs.includes(NOTEBOOK.slice(1))) await page.ev(`(() => { const i = document.querySelector("#delegate-add"); i.value = ${JSON.stringify(NOTEBOOK.slice(1))}; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); return true; })()`);
  await page.ev(`(() => { const d = document.querySelector("dialog.sheet[open]"); d.querySelector("#delegate-prompt").value = "Add a closing note to the notebook, slowly."; d.querySelector("#delegate-title").value = "A closing note"; const r = d.querySelector("#delegate-run"); if (r.checked) r.click(); return true; })()`);
  await shot("2-sheet");
  await page.ev(`(document.querySelector("dialog.sheet[open] button[type=submit]").click(), true)`);
  await must(`!document.querySelector("dialog.sheet[open]") && document.querySelector("#task-view h2")?.textContent === "A closing note"`, "the started task's view");
  const task = await page.ev(`document.querySelector("#tasks .task.on")?.dataset.task ?? null`);
  ok(/^[0-9a-f]{32}$/.test(task ?? ""), "2. a task started on " + NOTEBOOK + ": its view shown, listed", { task });
  await shot("2-started");

  // ---- 3. the page closed while the task still works (its chip, and the agent's own record)
  const chip0 = await page.ev(`document.querySelector("#tasks .task.on .chip").textContent`), rec0 = record(agent, task);
  ok(chip0 === "Working" && rec0?.status === "working" && (rec0.proposals ?? []).length === 0, "3. before the page closes the task is still working: chip Working, the agent's record working with no proposal", { chip0, status: rec0?.status, proposals: rec0?.proposals });
  const code = agent.latestCode();
  await page.navigate("about:blank");
  if (CONTROL) agent.pause();
  ok(true, "3. the page closed" + (CONTROL ? " (control: the agent paused while no page is paired)" : ""));

  // ---- 4. no page paired: the agent's own record reaches the proposal
  let rec = null;
  for (const t = Date.now(); Date.now() - t < UNPAIRED_MS; await sleep(250)) {
    rec = record(agent, task);
    if (rec?.status === "proposal" && (rec.proposals ?? []).length > 0) break;
  }
  const done = rec?.status === "proposal" && (rec.proposals ?? []).length > 0;
  if (CONTROL) agent.resume();
  if (!done) throw new Error(`4. with no page paired, the task didn't reach its proposal in ${UNPAIRED_MS / 1000} s (the agent's record: ${JSON.stringify({ status: rec?.status, proposals: rec?.proposals?.length })})` + (CONTROL ? " (as the paused control must)" : ""));
  ok(true, "4. with no page paired, the agent finished the task: its own record says proposal, with its commit, before the page reopens");

  // ---- 5. reopened, paired again with the fresh code, Delegate on again
  await agent.nextCode(code);
  await pairTarballAgent(page, site, agent, GRANT);
  await must(`document.querySelector("#connect")?.textContent === "Connected"`, "connected again");
  await turnOn();
  ok(true, "5. the page reopened and paired again; Delegate turned on again (a new pairing starts with it off)");

  // ---- 6. the proposal
  const chipJs = `document.querySelector('#tasks .task[data-task="${task}"] .chip')`;
  await must(`!!${chipJs}`, "the task in the list again");
  await must(`${chipJs}.textContent === "Proposal ready"`, "the task's chip, Proposal ready", 30000);
  ok(true, "6. reopened: the task's chip says Proposal ready");
  await page.ev(`(document.querySelector('#tasks .task[data-task="${task}"]').click(), true)`);
  await must(`!!document.querySelector("#task-view .proposal-card")`, "the proposal's card");
  const card = await page.ev(`document.querySelector("#task-view .proposal-card").textContent`);
  ok(/^Proposal: 1 file changed · base [0-9a-f]{7} · proposal [0-9a-f]{7}$/.test(card), "6. the task's proposal card: one file changed, both commits", card);
  // (its thread read, then nothing in it still going: no tool call with its spinner (the propose call answered), no
  //  turn still working; sagebrush-agent 0.8.11 closes the turn with the proposal)
  await must(`!!document.querySelector("#task-view .turn")`, "the task's thread");
  await sleep(2000);
  const still = await page.ev(`({ spinners: document.querySelectorAll("#task-view .spinner").length, working: document.querySelector("#task-view").textContent.includes("Working…"), running: [...document.querySelectorAll("#task-view details.tool")].filter((d) => d.querySelector(".spinner")).map((d) => d.querySelector("summary")?.textContent.trim().slice(0, 80)) })`);
  ok(still.spinners === 0 && !still.working, "6. nothing in the task's view is still going: no tool call spinning, no turn working", still);
  await shot("6-task");
  await page.ev(`(document.querySelector("#task-view .proposal-card").click(), true)`);
  await must(`!!document.querySelector("dialog.proposal[open] .sbpv .file")`, "the proposal view", 30000);
  const rows = await page.ev(`[...document.querySelectorAll("dialog.proposal[open] .sbpv .file")].map((r) => r.textContent.trim().slice(0, 80))`);
  ok(rows.length === 1 && rows[0].startsWith(NOTEBOOK.slice(1)) && /changed/.test(rows[0]), "the proposal view: the notebook, changed", rows);
  // (one file changed: opened at once; its cell-by-cell diff and the notebook as proposed)
  await must(`document.querySelector("dialog.proposal[open]").textContent.includes(${JSON.stringify(NOTE)})`, "the added cell in the diff", 30000);
  ok(true, "the diff shows the cell the agent added: " + JSON.stringify(NOTE));
  await shot("6-proposal");

  // ---- 7. Merge: the person's notebook gets the agent's cell, recorded by the page and by the agent
  const mergeJs = `document.querySelector('dialog.proposal[open] button[data-act="merge"]')`;
  await must(`${mergeJs}?.getAttribute("aria-disabled") === null`, "Merge, on");
  // (its control: before Merge, the person's notebook beside the chat doesn't have the cell)
  const before = await page.ev(`({ tab: document.querySelector(".pane-head .tab.on")?.dataset.tab ?? null, has: document.querySelector(".pane-body")?.textContent.includes(${JSON.stringify(NOTE)}) ?? null })`);
  ok(before.tab === NOTEBOOK && before.has === false, "7. before Merge: the person's notebook beside the chat, without the agent's cell", before);
  await page.ev(`(${mergeJs}.click(), true)`);
  await must(`${chipJs}.textContent === "Merged"`, "the task's chip, Merged", 30000);
  ok(true, "7. Merge: the task's chip says Merged");
  let merged = null;
  for (const t = Date.now(); Date.now() - t < 20_000; await sleep(250)) if ((merged = record(agent, task))?.status === "merged") break;
  ok(merged?.status === "merged", "7. the agent's own record says merged", { status: merged?.status });
  await shot("7-merged");
  await page.ev(`(document.querySelector("dialog.proposal[open]")?.close(), true)`);
  await page.ev(`(document.querySelector('.pane-head .tab[data-tab=${JSON.stringify(NOTEBOOK)}]')?.click(), true)`);
  await must(`document.querySelector(".pane-head .tab.on")?.dataset.tab === ${JSON.stringify(NOTEBOOK)} && document.querySelector(".pane-body").textContent.includes(${JSON.stringify(NOTE)})`, "the merged cell in the person's notebook beside the chat", 30000);
  ok(true, "7. the person's notebook beside the chat has the cell the agent added");
  await shot("7-notebook");
  ok(page.errors.length === 0, "no page errors", page.errors);
} catch (e) {
  ok(false, "the case ran to its end: " + (e?.stack ?? e));
  if (page) console.log("the page: " + JSON.stringify(await page.ev(`({ tasks: [...document.querySelectorAll("#tasks .task")].map((b) => b.textContent), view: document.querySelector("#task-view")?.textContent?.slice(0, 300) ?? null })`).catch((x) => String(x))));
  if (agent) { const o = agent.output(); console.log("the agent said (last lines):\n  " + String(o.stdout ?? "").concat(String(o.stderr ?? "")).split("\n").slice(-25).join("\n  ")); }
} finally {
  await agent?.stop().catch(() => {});
  await page?.close().catch(() => {});
  site.close();
}
console.log(failures ? `${failures} FAILED` + (CONTROL ? " (the paused control: expected)" : "") : "all passed");
process.exit(failures ? 1 : 0);
