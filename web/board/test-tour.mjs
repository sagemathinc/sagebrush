// A board's tour across its pages (mount.ts, William's B4): → and ← go
// through every page's intro and steps, and the caption, its arrows with
// it, is shown on every page of a board of pages, a page without an intro
// saying its title (astra's UI-118-2, friction 9); the document's intro is
// the first page's when it has none (friction 7); a file dropped on
// /board/ has its own caption, not the welcome's (friction 7); and the
// reader's moves made while a page is still being drawn are made in turn,
// from where it lands, the caption, page, picker and address agreeing
// (astra's UI-118-1), and none of them made, nor its page drawn, in another
// document loaded or dropped meanwhile.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-tour.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9471), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-tour-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = "window.sagebrush.board";
const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: code }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); };
const right = () => key("ArrowRight", 39), left = () => key("ArrowLeft", 37);
// where the board is, as each part of the page says it
const state = () => ev(`(() => { const b = ${B}.snapshot(), q = (s) => document.querySelector('[data-sbb=' + s + ']');
  return { page: b.page, step: b.step, hash: location.hash, sel: q('pgsel').value, hidden: q('tour').hidden, say: q('say').textContent.trim(), where: q('where').textContent, prev: q('prev').disabled, next: q('next').disabled }; })()`);
const hashOf = (p, i) => (p ? `#p${p + 1}${i >= 0 ? "-" + (i + 1) : ""}` : i >= 0 ? "#" + (i + 1) : "");
const at = (p, i) => until(`(() => { const b = ${B}.snapshot(); return b.page === ${p} && b.step === ${i} && location.hash === ${JSON.stringify(hashOf(p, i))}; })()`);
const note = (id) => ({ id, title: id });
const step = (id, k = "") => ({ focus: id, say: `Step ${id}${k}` });
// (a document loaded opens at the page and step in the address: none, here)
const unaddress = "history.replaceState(null, '', location.pathname + location.search)";
const load = async (d) => { await ev(unaddress); await ev(`${B}.load(${JSON.stringify(d)}).then(() => 1)`); await ev(`${B}.editing(false)`); await at(0, -1); };
// (the board's pictures held back as a page is drawn, until let go: a slow page)
const hold = () => ev(`(async () => { const m = await import(new URL('board.js', location.href).href), im = m.host.images; window.__ensure ??= im.ensure.bind(im); window.__gates = [];
  im.ensure = (names) => new Promise((ok) => window.__gates.push(() => window.__ensure(names).then(ok))); return 1; })()`);
const release = async () => { await ev(`import(new URL('board.js', location.href).href).then((m) => { m.host.images.ensure = window.__ensure; window.__gates.splice(0).forEach((g) => g()); return 1; })`); };
// (everything agreeing on where the board is: page, step, picker, address, and the caption saying it)
const agrees = (s, p, i, say) => s.page === p && s.step === i && s.sel === String(p) && s.hash === hashOf(p, i) && !s.hidden && (say === undefined || s.say === say);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);

  // a board dropped on /board/: its own caption, not the welcome's and its tour (friction 7)
  await send("Page.navigate", { url: `${base}board/?runner=0` });
  if (!(await until(`${B}?.snapshot().items.length > 0`, 60000))) throw new Error("the board did not open");
  check((await state()).where === "11 steps", "(the welcome says its tour: 11 steps): " + (await state()).where);
  const DROP = { title: "Mine", intro: "My own intro", pages: [{ title: "First", nodes: [note("a")], steps: [step("a"), step("a", 2)] }, { title: "Second", nodes: [note("b")] }] };
  await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(JSON.stringify(DROP))}], "mine.board.json", { type: "application/json" }));
    document.querySelector('.board-world').dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); return 1; })()`);
  await until(`${B}.snapshot().doc.title === "Mine"`);
  await sleep(300);
  let s = await state();
  check(s.say === "My own intro" && s.where === "2 steps", "a dropped board says its own intro and tour, not the welcome's: " + JSON.stringify(s));

  // the document's intro is the first page's, when it has none of its own (friction 7)
  await load({ title: "Doc", intro: "The **board's** intro", pages: [{ title: "One", nodes: [note("a")], steps: [step("a")] }, { title: "Two", intro: "Two's own", nodes: [note("b")] }] });
  s = await state();
  check(s.say === "The board's intro" && s.where === "1 step", "the document's intro on the first page: " + JSON.stringify(s));
  await right(); await right();
  check(await at(1, -1), "(→ to the second page)");
  check((await state()).say === "Two's own", "a page's own intro on its page");
  await load({ title: "Doc", intro: "The board's intro", pages: [{ title: "One", intro: "One's own", nodes: [note("a")] }, { title: "Two", nodes: [note("b")] }] });
  check((await state()).say === "One's own", "a first page's own intro, not the document's");

  // every position, → and then ←: page, step, picker, address and the
  // caption agree; on a board of pages the caption and its arrows are
  // there on every page, a page without an intro saying its title (UI-118-2)
  const walks = [
    { title: "Single", nodes: [note("one")], steps: [step("one")] },
    { title: "Single empty", nodes: [note("one")] },
    { title: "Mixed", pages: [{ title: "Start", intro: "Intro A", nodes: [note("a")], steps: [step("a")] }, { title: "Empty middle", nodes: [] }, { title: "Intro only", intro: "Intro C", nodes: [note("c")] }, { nodes: [note("d")], steps: [step("d")] }, { title: "Last empty", nodes: [note("e")] }] },
  ];
  for (const d of walks) {
    await load(d);
    const pages = d.pages ?? [d], seq = pages.flatMap((p, k) => Array.from({ length: 1 + (p.steps ?? []).length }, (_, i) => [k, i - 1]));
    // (what the caption says at each: a step's words; else the page's intro, or its title, or "Page N")
    const says = ([k, i]) => (i >= 0 ? pages[k].steps[i].say : pages[k].intro ?? (d.pages ? pages[k].title ?? `Page ${k + 1}` : d.title));
    const walk = async (dir) => {
      const order = dir > 0 ? seq.map((_, k) => k) : seq.map((_, k) => seq.length - 1 - k);
      for (const k of order.slice(1)) {
        await (dir > 0 ? right() : left());
        const [p, i] = seq[k];
        if (!(await at(p, i))) { check(false, `${d.title}: ${dir > 0 ? "→" : "←"} did not reach ${seq[k]}: ${JSON.stringify(await state())}`); return; }
        s = await state();
        const hidden = !d.pages && !d.steps;
        check(hidden ? s.hidden : agrees(s, p, i, says(seq[k])), `${d.title} ${dir > 0 ? "→" : "←"} at ${seq[k]}: ${JSON.stringify(s)} (saying ${says(seq[k])})`);
        check(s.prev === (k === 0) && s.next === (k === seq.length - 1), `${d.title}: the caption's arrows disabled only at the board's ends, at ${seq[k]}: ${JSON.stringify(s)}`);
      }
    };
    s = await state();
    check(d.pages || d.steps ? agrees(s, 0, -1, says([0, -1])) : s.hidden, `${d.title}: at its start: ${JSON.stringify(s)}`);
    await walk(1);
    await right(); await sleep(200);
    check(JSON.stringify(await ev(`[${B}.snapshot().page, ${B}.snapshot().step]`)) === JSON.stringify(seq.at(-1)), `${d.title}: → at the end stays`);
    await walk(-1);
  }

  // the reader's moves while a page is still being drawn (UI-118-1): two →
  // from page 1's last step, the second while page 2 is drawn: page 2's
  // intro, then its first step, never past it
  const SLOW = { title: "Slow", pages: [{ title: "A", nodes: [note("a")], steps: [step("a", 1), step("a", 2), step("a", 3)] }, { title: "B", intro: "B intro", nodes: [note("b")], steps: [step("b", 1), step("b", 2)] }, { title: "C", nodes: [note("c")], steps: [step("c", 1)] }] };
  await load(SLOW);
  await ev(`${B}.step(2)`);
  await at(0, 2);
  await hold();
  await right(); await sleep(250); await right(); await sleep(250);
  await release();
  check(await at(1, 0), "→ twice while page 2 is drawn: its first step, not past its tour: " + JSON.stringify(await state()));
  check(agrees(await state(), 1, 0, "Step b1"), "...the caption, picker and address there too: " + JSON.stringify(await state()));
  // ← twice from page 3's start, the second while page 2 is drawn: page 2's last step, then the one before
  await ev(`${B}.page(2)`);
  await at(2, -1);
  await hold();
  await left(); await sleep(250); await left(); await sleep(250);
  await release();
  check(await at(1, 0), "← twice while page 2 is drawn: its next-to-last step: " + JSON.stringify(await state()));
  check(agrees(await state(), 1, 0, "Step b1"), "...the caption, picker and address there too: " + JSON.stringify(await state()));
  // the caption's → clicked three times from page 1's last step, while pages are drawn
  await ev(`${B}.page(0)`); await at(0, -1); await ev(`${B}.step(2)`); await at(0, 2);
  await hold();
  for (let k = 0; k < 3; k++) { await ev("document.querySelector('[data-sbb=next]').click(), 1"); await sleep(150); }
  await release();
  check(await at(1, 1), "the caption's → three times: page 2's second step: " + JSON.stringify(await state()));
  check(agrees(await state(), 1, 1, "Step b2"), "...the caption, picker and address there too: " + JSON.stringify(await state()));
  // the page picker changed while a page is drawn: the page picked, from its start
  await ev(`${B}.page(0)`); await at(0, -1); await ev(`${B}.step(2)`); await at(0, 2);
  await hold();
  await right(); await sleep(150);
  await ev("(() => { const s = document.querySelector('[data-sbb=pgsel]'); s.value = '2'; s.dispatchEvent(new Event('change')); return 1; })()");
  await sleep(150);
  await release();
  check(await at(2, -1), "the picker changed while page 2 is drawn: page 3, from its start: " + JSON.stringify(await state()));
  check(agrees(await state(), 2, -1, "C"), "...the caption (the page's title), picker and address there too: " + JSON.stringify(await state()));
  // a move still waiting as another document loads: dropped, and the page
  // still being drawn not shown over it
  await ev(`${B}.page(0)`); await at(0, -1); await ev(`${B}.step(2)`); await at(0, 2);
  await hold();
  await right(); await sleep(100); await right(); await sleep(100);
  await ev(unaddress);
  await ev(`(${B}.load(${JSON.stringify({ title: "Other", pages: [{ title: "X", nodes: [note("x")], steps: [step("x")] }, { title: "Y", nodes: [note("y")] }] })}), 1)`);
  await sleep(100);
  await release();
  await until(`${B}.snapshot().doc.title === "Other"`);
  await sleep(800);
  check(agrees(await state(), 0, -1, "X"), "another document loaded: from its start, no move of the last one made in it: " + JSON.stringify(await state()));

  // another document (loaded, or a file dropped) while the last one's page
  // is still drawn: that page not drawn over it, the last one's waiting
  // move dropped, and the new one's moves not waiting for it (astra's
  // replacement probe, on 3df6006)
  {
  const original={title:'Original',pages:[{title:'A',nodes:[note('a')],steps:[step('a')]},{title:'B',nodes:[note('b')],steps:[step('b'),step('b','2')]}]};
  const replacement={title:'Replacement',pages:[{title:'X',intro:'Replacement intro',nodes:[note('x')],steps:[step('x')]},{title:'Y',nodes:[note('y')]}]};
  const fullState=async()=>({...await state(), title:await ev(`${B}.snapshot().doc.title`),items:await ev(`${B}.snapshot().items.map(x=>x.id)`) });
  const holdOne=()=>ev(`(async()=>{const im=(await import(new URL('board.js',location.href).href)).host.images;const old=im.ensure.bind(im); window.__releaseOne=null; im.ensure=(names)=>{im.ensure=old;return new Promise(ok=>window.__releaseOne=()=>old(names).then(ok))};return 1})()`);
  const releaseOne=()=>ev('window.__releaseOne(),1');
  for(const kind of ['api','drop']){
    await load(original); await ev(`${B}.step(0)`);await at(0,0);
    await holdOne();await right();await until('!!window.__releaseOne');await right();
    await ev(unaddress);
    if(kind==='api')await ev(`${B}.load(${JSON.stringify(replacement)}).then(()=>1)`);
    else await ev(`(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(JSON.stringify(replacement))}],'replacement.board.json',{type:'application/json'}));document.querySelector('.board-world').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:300,clientY:300}));return 1})()`);
    check(await until(`${B}.snapshot().doc.title==='Replacement'`),kind+' replacement appears before old transition releases');
    await sleep(200);console.log(kind,'replacement shown',JSON.stringify(await fullState()));
    if(kind==='api'){
      await right(); await sleep(300);const pending=await fullState();console.log(kind,'new Right while old transition held',JSON.stringify(pending));
      check(pending.step===0&&pending.say==='Step x', 'new document navigation is independent of the old pending transition');
    }
    await releaseOne();await sleep(700);const landed=await fullState();console.log(kind,'after release',JSON.stringify(landed));
    check(landed.title==='Replacement'&&landed.items.includes('x'),kind+' replacement is not overwritten by old page rendering');
    check(landed.page===0&&landed.step===(kind==='api'?0:-1),kind+' old queued move is dropped');
  }
  }
  check(!errors.length, "no errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
