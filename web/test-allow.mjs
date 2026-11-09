// ci: none (imported by other suites, not one itself: web/test-catalog.mjs, web/test-chunk-stall.mjs, web/test-pandas-on-demand.mjs, web/test-pkgset-page.mjs, web/test-png.mjs, web/test-pwa-first-visit.mjs, web/test-pwa.mjs, web/test-reactive.mjs, web/test-replay.mjs, web/test-runner-broker.mjs, web/test-runner.mjs, web/share/test-share-broker.mjs, web/share/test-share-dialog.mjs, web/share/test-share-ui.mjs, web/workspace/test-workspace-pages.mjs)
// The person allowing the open notebook's file changes, as a person does: File > Permissions…, its switch, then
// Escape, each a trusted input through the DevTools protocol (a synthetic click changes nothing). Every notebook starts
// with file changes off (confinement phase 1b: William's O1 and O6), so a suite whose notebook writes files calls this
// once the notebook is open and before the cells that write. `send` is the suite's DevTools sender, `ev` its evaluate
// (an expression's value, promises awaited).
export async function allowFiles(send, ev) {
  if (await ev("window.sagebrush?.permissions?.()?.files === true")) return;
  const click = async (sel) => {
    const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new Error("allowFiles: no " + sel);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
    await new Promise((ok) => setTimeout(ok, 200));
  };
  await click("#filebtn");
  await click("#permsmenu");
  await click("#filesperm");
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  if (!(await ev("window.sagebrush?.permissions?.()?.files === true"))) throw new Error("allowFiles: the notebook's file changes are still off");
  // (a widening reaches the notebook through the person's next Run, which starts a new interpreter (confinement phase
  // 2): that moment, as the page's onExplicitRun has it, since a suite's own runs go through the notebook's API; then
  // the new interpreter, ready)
  // (the interpreter restarts in the same kernel: its worker is a new one)
  if (!(await ev("(() => { const s = window.sagebrush; window.__allowWorker = s.kernel?.worker; return s.kernels.get(s.permissions()?.doc)?.rotateIfWidened?.() === true; })()"))) return;
  for (let t = Date.now(); Date.now() - t < 60_000; await new Promise((ok) => setTimeout(ok, 100)))
    if (await ev("window.sagebrush.kernel?.worker !== window.__allowWorker && window.sagebrush.kernel?.ready === true")) return;
  throw new Error("allowFiles: no new interpreter after the widening");
}
