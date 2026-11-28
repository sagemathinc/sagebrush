// The 3D view in a headset (WebXR: Meta Quest's browser, and others): Enter VR, or AR (the space in your room through
// passthrough). Loaded only where the browser can enter one (main.ts asks web/xr-input.js first).
// Comfort first (walking, the default): you stand on the floor; the left thumbstick walks, the right turns in steps; a
// move to an object or Back is a blink (a quick fade), never a glide through the air; point at the floor and pull the
// trigger to step there; above the floor, a disc stands under your feet; the view's edges darken while you walk. Fly
// (the wrist menu) brings back gliding flights and the right thumbstick's up and down.
// You stand in the space at a scale where a slab is about a metre wide. Each controller casts a ray: the trigger
// selects what it points at: you go to it (as the desktop does) and its reading panel opens beside it (its text, its
// output, Run; the page's own HTML isn't drawn inside a headset). Hold the grip to go faster. A or X closes the panel;
// B or Y goes back. The menu on your left wrist: Back, Forward, See all, Run all, Tour, Fly, Exit. A folder, a file or
// a class is entered from its panel (Enter): its room replaces the space around you, and Back past it brings you out.
// The controllers are read with web/xr-input.js (thumbsticks with a dead zone, buttons and their presses), as the 3D
// plot viewer's headset mode reads them; the session is three.js's (renderer.xr), started on the person's click.
import * as THREE from "three";
import { texToText } from "./tex.ts";
import { codeRuns } from "./code.ts";
import { supported as xrSupported, createInput } from "../../xr-input.js";

const SCALE = 5; // (world units per metre: a slab, 5 units wide, is a metre across)
const EYE = 1.6; // (where the floor is, below the eye, in metres: the space starts where the camera was)
const STEP_UP = 1.05; // (the highest step walked up, in the space's units: ground.ts's STEP)
const keep = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* (not kept) */ } } };

export function setupXR(api) {
  const { renderer, scene, camera, controls } = api;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  const rig = new THREE.Group();
  scene.add(rig);
  rig.add(camera);
  const input = createInput();
  let session = null, mode = null, saved = null;
  // (walking or flying; kept for the next visit)
  let walk = keep.get("space3d:xr-move") !== "fly";
  // (the blink: black around the eyes, faded in and out)
  const fader = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false }));
  fader.renderOrder = 1000;
  fader.visible = false;
  camera.add(fader);
  // (the vignette: the view's edges darkened while walking, which eases the feeling of moving; wide enough to cover the
  //  whole view, so it has no edge: clear in the middle, dark from about 70° out)
  const vc = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
  { const g = vc.getContext("2d"), gr = g.createRadialGradient(128, 128, 26, 128, 128, 64); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,1)"); g.globalCompositeOperation = "copy"; g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
  const vignette = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(vc), transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  vignette.position.z = -0.2;
  vignette.renderOrder = 999;
  vignette.visible = false;
  camera.add(vignette);
  let vig = 0, lastFloor = NaN;
  // (the disc under your feet when you stand above the floor, and the mark where a step would put you)
  const disc = new THREE.Mesh(new THREE.RingGeometry(0.12 * SCALE, 0.42 * SCALE, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4a9d6f, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
  disc.visible = false;
  scene.add(disc);
  const mark = new THREE.Mesh(new THREE.RingGeometry(0.18 * SCALE, 0.26 * SCALE, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  mark.visible = false;
  scene.add(mark);

  // ---------------------------------------------------------------- the wrist menu's mesh (drawn below)
  const MW = 512, MH = 484;
  const mcanvas = Object.assign(document.createElement("canvas"), { width: MW, height: MH });
  const mtex = new THREE.CanvasTexture(mcanvas);
  mtex.colorSpace = THREE.SRGBColorSpace;
  const menu = new THREE.Mesh(new THREE.PlaneGeometry(0.2, (0.2 * MH) / MW), new THREE.MeshBasicMaterial({ map: mtex, side: THREE.DoubleSide, transparent: true }));
  menu.position.set(0, 0.07, -0.02);
  menu.rotation.x = -Math.PI / 4;
  menu.renderOrder = 21;

  // ---------------------------------------------------------------- the controllers: a ray each
  const controllers = [0, 1].map((i) => {
    const c = renderer.xr.getController(i);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.8 }));
    line.scale.z = 30; // (in the rig's units, metres: the rig is scaled by SCALE)
    c.add(line);
    c.userData = { line, source: null, hovered: null };
    c.addEventListener("connected", (e) => {
      c.userData.source = e.data;
      if (e.data?.handedness === "left") { c.add(menu); drawMenu(); }
    });
    c.addEventListener("disconnected", () => (c.userData.source = null));
    c.addEventListener("select", () => onSelect(c));
    rig.add(c);
    return c;
  });
  const ray = new THREE.Raycaster();

  // ---------------------------------------------------------------- moving: to an object's view, Back and Forward
  // (your head at `to`, facing `toT` (turned about the vertical only); where you were is remembered for Back)
  let flight = null;
  const backStack = [], fwdStack = [];
  // (each place remembered with how many rooms deep it was: a place in a room that has since been left is passed over)
  const pose = () => ({ pos: rig.position.clone(), yaw: rig.rotation.y, depth: api.depth() });
  function flyRig(to, toT, ms = 450, remember = true) {
    settle();
    if (remember) { backStack.push(pose()); fwdStack.length = 0; drawMenu(); }
    const d = new THREE.Vector3().subVectors(toT, to);
    const yaw = Math.atan2(-d.x, -d.z);
    // (the rig's place that puts the head, where it is in the rig now, at `to`)
    const head = camera.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiplyScalar(SCALE);
    flyPose({ pos: to.clone().sub(head), yaw }, ms);
  }
  // (a blink under way, finished at once: you are where it was taking you, the fader gone)
  function settle() {
    if (!flight?.blink) return;
    rig.position.copy(flight.to.pos); rig.rotation.y = flight.to.yaw;
    fader.visible = false; fader.material.opacity = 0;
    flight = null;
  }
  function flyPose(target, ms = 450) {
    settle();
    // (walking: never below the ground (a view from below, such as a 3D plot's, is taken from the floor instead), and
    //  standing on it when the view is about at standing height there)
    const g = api.floorY(target.pos.x, target.pos.z);
    if (walk && target.pos.y < g + 0.5 * SCALE) target = { ...target, pos: target.pos.clone().setY(g) };
    let dy = target.yaw - rig.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // (the short way round)
    // (walking: a blink, there in the dark; flying: a glide)
    flight = { from: pose(), to: { pos: target.pos, yaw: rig.rotation.y + dy }, t0: performance.now(), ms: walk ? 300 : ms, blink: walk, jumped: false };
  }
  function stepFlight() {
    if (!flight) return;
    const u = Math.max(0, Math.min(1, (performance.now() - flight.t0) / flight.ms)), e = u * u * (3 - 2 * u);
    if (flight.blink) {
      fader.visible = true;
      fader.material.opacity = u < 0.5 ? u * 2 : (1 - u) * 2;
      if (u >= 0.5 && !flight.jumped) { rig.position.copy(flight.to.pos); rig.rotation.y = flight.to.yaw; flight.jumped = true; }
      if (u >= 1) { fader.visible = false; fader.material.opacity = 0; flight = null; }
      return;
    }
    rig.position.lerpVectors(flight.from.pos, flight.to.pos, e);
    rig.rotation.y = flight.from.yaw + (flight.to.yaw - flight.from.yaw) * e;
    if (u >= 1) flight = null;
  }
  // (a step to a point of the floor: your feet there, facing as you were)
  function teleport(p) {
    settle();
    backStack.push(pose()); fwdStack.length = 0;
    const head = camera.position.clone().setY(0).applyAxisAngle(new THREE.Vector3(0, 1, 0), rig.rotation.y).multiplyScalar(SCALE);
    flyPose({ pos: new THREE.Vector3(p.x - head.x, api.floorY(p.x, p.z), p.z - head.z), yaw: rig.rotation.y });
    drawMenu();
  }
  function setWalk(on) {
    walk = !!on;
    keep.set("space3d:xr-move", walk ? "walk" : "fly");
    // (to the floor, when walking starts: below where you are)
    const g = api.floorY(rig.position.x, rig.position.z);
    if (walk && session && rig.position.y > g + 0.05) { settle(); backStack.push(pose()); flyPose({ pos: rig.position.clone().setY(g), yaw: rig.rotation.y }); }
    drawMenu();
  }
  // (Back past where a room was entered: out of the room, to where you stood; with nothing to go back to inside a room
  //  entered before the headset, out of it to the view of everything)
  function goBack() {
    settle();
    const cur = api.depth();
    while (backStack.length && backStack.at(-1).depth > cur) backStack.pop();
    const v = backStack.at(-1)?.depth === cur ? backStack.pop() : null;
    if (v?.leave) { close(); api.leave(); fwdStack.length = 0; flyPose(v); }
    else if (v) { fwdStack.push(pose()); flyPose(v); }
    else if (api.inRoom()) { close(); api.leave(); fwdStack.length = 0; const h = api.home(); if (h) flyRig(h.to, h.toT, 450, false); }
    drawMenu();
  }
  const goForward = () => {
    settle();
    const v = fwdStack.pop();
    if (v && v.depth === api.depth()) { backStack.push(pose()); flyPose(v); } else fwdStack.length = 0;
    drawMenu();
  };
  // (the space around you changed rooms (here, or on the desktop): the panel shows an object of the room left, and
  //  Forward's places are in it)
  function roomChanged() {
    if (shown && !api.has(shown)) close();
    fwdStack.length = 0;
    if (session) drawMenu();
  }
  function seeAll() {
    const h = api.home();
    if (h) flyRig(h.to, h.toT, 700);
  }

  // ---------------------------------------------------------------- the reading panel
  // (wider than tall: code's lines are long; without wrapping (the default), a line too long simply runs off its edge)
  const PW = 1280, PH = 1280, PANEL_LINES = 400, PANEL_W = 1.25 * SCALE, PANEL_H = 1.25 * SCALE;
  let wrapCode = keep.get("space3d:xr-wrap") === "on";
  const canvas = Object.assign(document.createElement("canvas"), { width: PW, height: PH });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true }));
  panel.renderOrder = 20;
  panel.visible = false;
  scene.add(panel);
  let shown = null, scroll = 0, state = "", buttons = [], stop = null; // (stop: the tour's, when the panel shows one)

  function lines(nd) {
    const out = [];
    const add = (text, style) => { for (const l of String(text ?? "").split("\n")) out.push({ text: l, style }); };
    if (stop) {
      out.push({ text: `${String(stop.title).toUpperCase()} · STOP ${stop.i + 1} OF ${stop.n}`, style: "label" });
      add(texToText(stop.text).replace(/\*\*|`/g, ""), "tour");
      out.push({ text: "", style: "prose" });
    }
    if (api.noRoomWhy(nd)) { add(api.noRoomWhy(nd), "hint"); out.push({ text: "", style: "prose" }); }
    if (nd.summary) { add(texToText(nd.summary).replace(/\*\*|`/g, ""), "summary"); out.push({ text: "", style: "prose" }); }
    // (its links, by name: what it calls and what calls it, in a room)
    const [outL, inL] = api.linkLabels(nd);
    for (const [label, list] of [[outL, nd._out ?? []], [inL, nd._in ?? []]]) {
      if (!list.length) continue;
      out.push({ text: `${label.toUpperCase()} (${list.length})`, style: "label" });
      add(list.slice(0, 12).map((m) => m.title).join(" · ") + (list.length > 12 ? ` · and ${list.length - 12} more` : ""), "prose");
      out.push({ text: "", style: "prose" });
    }
    if (fetches(nd)) add("fetching its text…", "hint");
    if (nd.kind === "note") add(texToText(nd.text).replace(/^#+\s*/gm, "").replace(/\*\*|`/g, ""), "prose");
    else {
      // (a long file: its first lines here, each as its coloured runs; the drawer on a screen has more)
      const ls = String(nd.text ?? "").split("\n");
      for (const runs of codeRuns(nd.text ?? "", nd.lang ?? "", api.theme().fg !== "#1f2328", PANEL_LINES)) out.push({ style: "code", runs, text: runs.map((r) => r.text).join("") });
      if (ls.length > PANEL_LINES) add(`(its first ${PANEL_LINES} lines of ${ls.length})`, "hint");
    }
    if (nd.output) { out.push({ text: "", style: "prose" }); out.push({ text: "OUTPUT", style: "label" }); add(nd.output, nd.outputError ? "error" : "output"); }
    if (nd.kind === "plot3d" || nd.scene) { out.push({ text: "", style: "prose" }); out.push({ text: "Its 3D plot is the object in the space.", style: "hint" }); }
    return out;
  }
  function wrap(g, text, maxW) {
    if (!text) return [""];
    const words = text.split(/(\s+)/), rows = [];
    let row = "";
    for (const w of words) {
      if (g.measureText(row + w).width > maxW && row.trim()) { rows.push(row.trimEnd()); row = w.trimStart(); } else row += w;
    }
    rows.push(row);
    return rows;
  }
  function draw() {
    const nd = shown, g = canvas.getContext("2d"), T = api.theme();
    const dark = T.fg !== "#1f2328";
    const C = dark ? { bg: "#161b22", fg: "#e6edf3", muted: "#8d96a0", code: "#0d1117", out: "#0f2a1b", err: "#3a1418", btn: "#21262d", line: "#30363d", sum: "#14233a", tour: "#33290d" }
      : { bg: "#ffffff", fg: "#1f2328", muted: "#57606a", code: "#f6f8fa", out: "#e7f6ec", err: "#ffebe9", btn: "#eef1f5", line: "#d0d7de", sum: "#e8f0fd", tour: "#fdf3d8" };
    g.clearRect(0, 0, PW, PH);
    g.fillStyle = C.bg; g.beginPath(); g.roundRect(0, 0, PW, PH, 36); g.fill();
    g.strokeStyle = C.line; g.lineWidth = 4; g.stroke();
    const pad = 48;
    g.fillStyle = C.fg; g.font = "600 46px system-ui, sans-serif";
    let y = pad + 40;
    for (const row of wrap(g, texToText(nd.title), PW - 2 * pad).slice(0, 2)) { g.fillText(row, pad, y); y += 56; }
    g.fillStyle = C.muted; g.font = "28px system-ui, sans-serif";
    g.fillText([nd.kind, nd.lang, nd.group].filter(Boolean).join(" · "), pad, y); y += 30;
    // (the body: wrapped rows, from `scroll`)
    const rows = [];
    for (const l of lines(nd)) {
      const mono = l.style === "code" || l.style === "output" || l.style === "error";
      g.font = mono ? "30px ui-monospace, Menlo, monospace" : l.style === "label" ? "600 24px system-ui, sans-serif" : l.style === "summary" || l.style === "tour" ? "italic 32px system-ui, sans-serif" : "34px Georgia, serif";
      if (l.runs && !wrapCode) { rows.push({ ...l, mono }); continue; } // (unwrapped: one row, running off the edge)
      if (l.runs) {
        // (a line of code: wrapped at the column the panel fits, its runs kept with their colours)
        const cols = Math.max(20, Math.floor((PW - 2 * pad - 24) / g.measureText("M").width));
        let row = [], n = 0;
        for (const run of l.runs) {
          let t = run.text;
          while (t.length) {
            const take = t.slice(0, cols - n);
            row.push({ text: take, color: run.color }); n += take.length; t = t.slice(take.length);
            if (n >= cols) { rows.push({ ...l, runs: row, mono }); row = []; n = 0; }
          }
        }
        if (row.length || !l.runs.length) rows.push({ ...l, runs: row, mono });
        continue;
      }
      for (const r of wrap(g, l.text, PW - 2 * pad - 24)) rows.push({ ...l, text: r, mono });
    }
    const top = y + 20, bottom = PH - 150, rowH = 42, fit = Math.floor((bottom - top) / rowH);
    scroll = Math.max(0, Math.min(scroll, rows.length - fit));
    y = top;
    for (const r of rows.slice(scroll, scroll + fit)) {
      if (r.style !== "prose" && r.style !== "label" && r.style !== "hint") {
        g.fillStyle = r.style === "code" ? C.code : r.style === "output" ? C.out : r.style === "summary" ? C.sum : r.style === "tour" ? C.tour : C.err;
        g.fillRect(pad - 8, y - 8, PW - 2 * pad + 16, rowH);
      }
      g.font = r.mono ? "30px ui-monospace, Menlo, monospace" : r.style === "label" ? "600 24px system-ui, sans-serif" : r.style === "hint" || r.style === "summary" || r.style === "tour" ? "italic 32px system-ui, sans-serif" : "34px Georgia, serif";
      g.fillStyle = r.style === "label" || r.style === "hint" ? C.muted : C.fg;
      if (r.runs) {
        // (clipped at the panel's inner edge: a long line runs off it)
        g.save(); g.beginPath(); g.rect(pad - 8, y - 8, PW - 2 * pad + 16, rowH); g.clip();
        let x = pad + 4;
        for (const run of r.runs) { if (x > PW - pad) break; g.fillStyle = run.color ?? C.fg; g.fillText(run.text, x, y + 26); x += g.measureText(run.text).width; }
        g.restore();
      } else g.fillText(r.text, pad + (r.mono ? 4 : 0), y + 26);
      y += rowH;
    }
    // (the buttons, along the bottom)
    buttons = [];
    let x = pad;
    const button = (label, act, primary = false) => {
      g.font = "600 34px system-ui, sans-serif";
      const w = g.measureText(label).width + 56, bx = x, by = PH - 118, bh = 76;
      g.fillStyle = primary ? "#1f6feb" : C.btn; g.beginPath(); g.roundRect(bx, by, w, bh, 18); g.fill();
      g.fillStyle = primary ? "#ffffff" : C.fg; g.fillText(label, bx + 28, by + 50);
      buttons.push({ x: bx, y: by, w, h: bh, act });
      x += w + 18;
    };
    if (stop) { button("◀", "tourprev"); button(stop.i + 1 < stop.n ? "Next stop ▶" : "Finish", "tournext", true); }
    if (api.canEnter(nd)) button(nd.kind === "import" ? "Go there ▶" : "Enter ▶", "enter", !stop);
    if (api.runnable(nd)) button(state === "running" ? "Running…" : "▶ Run", "run", !stop && !api.canEnter(nd));
    if (rows.length > fit) { button("▲", "up"); button("▼", "down"); }
    if (rows.some((r) => r.runs)) button(wrapCode ? "Wrap: on" : "Wrap: off", "wrap");
    button("✕ Close", "close");
    if (state && state !== "running") { g.fillStyle = C.muted; g.font = "26px system-ui, sans-serif"; g.fillText(state, x + 8, PH - 70); }
    tex.needsUpdate = true;
  }
  // (a file whose text is elsewhere is fetched when its panel opens, as the drawer does; not a notebook's or a board's,
  //  which are read only when entered)
  const fetches = (nd) => !!nd.src && !nd._full && nd.doc !== "notebook" && nd.doc !== "board";
  function open(nd, fly = true, tourStop = null) {
    shown = nd; scroll = 0; state = ""; stop = tourStop;
    draw();
    if (fetches(nd)) api.fullText(nd).then(() => shown === nd && api.has(nd) && draw(), () => { if (shown === nd) { state = "couldn't fetch its text"; draw(); } });
    api.select(nd);
    if (fly) {
      // (to the object, as the desktop goes to it; the panel then opens to its right, facing where you'll be)
      const v = api.viewOf(nd);
      flyRig(v.to, v.toT);
      const d = new THREE.Vector3().subVectors(v.toT, v.to).setY(0).normalize();
      const right = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
      // (where your head will be: walking, never below standing height on the floor)
      const eyeTo = v.to.clone();
      if (walk) eyeTo.y = Math.max(eyeTo.y, api.floorY(eyeTo.x, eyeTo.z) + 1.6 * SCALE);
      panel.position.copy(eyeTo).addScaledVector(d, 1.1 * SCALE).addScaledVector(right, 0.9 * SCALE).add(new THREE.Vector3(0, -0.1 * SCALE, 0));
      panel.lookAt(eyeTo.x, panel.position.y, eyeTo.z);
    } else {
      // (in front of you, at eye height, turned to face you)
      const head = camera.getWorldPosition(new THREE.Vector3());
      const dir = camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      panel.position.copy(head).addScaledVector(dir, 1.2 * SCALE).add(new THREE.Vector3(0, -0.15 * SCALE, 0));
      panel.lookAt(head.x, panel.position.y, head.z);
    }
    // (never into the floor: its buttons, along its bottom edge, stay where you can point at them)
    panel.position.y = Math.max(panel.position.y, api.floorY(panel.position.x, panel.position.z) + PANEL_H / 2 + 0.15 * SCALE);
    panel.visible = true;
  }
  function close() { panel.visible = false; shown = null; stop = null; api.select(null); }
  // (a tour: the next or previous stop, gone to with its narration; past the last, the tour ends)
  function tour(delta) {
    const r = api.tourNow() ? api.tourStep(delta) : api.startTour(0);
    if (r && r.nd) open(r.nd, true, r);
    else if (!api.tourNow()) close();
    drawMenu();
  }
  async function press(act) {
    if (act === "close") { if (stop) api.endTour(); drawMenu(); return close(); }
    if (act === "tournext") return tour(1);
    if (act === "tourprev") return tour(-1);
    if (act === "up") { scroll -= 8; return draw(); }
    if (act === "down") { scroll += 8; return draw(); }
    if (act === "wrap") { wrapCode = !wrapCode; keep.set("space3d:xr-wrap", wrapCode ? "on" : "off"); scroll = 0; return draw(); }
    if (act === "enter" && shown && state !== "entering…") {
      // (into the room: the panel closes, Back will bring you out to where you stand now)
      const nd = shown, from = pose();
      state = "entering…"; draw();
      const ok = await api.enter(nd);
      if (!ok) { if (shown === nd) { state = "couldn't enter it"; draw(); } return; }
      close();
      backStack.push({ ...from, leave: true }); fwdStack.length = 0;
      // (through an import that named one thing: to it, its panel open; else the view of the whole room)
      const f = api.focus();
      if (f) { open(f, false); const v = api.viewOf(f); flyRig(v.to, v.toT, 700, false); }
      else { const h = api.home(); if (h) flyRig(h.to, h.toT, 700, false); }
      drawMenu();
      return;
    }
    if (act === "run" && shown && state !== "running") {
      const nd = shown;
      state = "running"; draw();
      const r = await api.run(nd);
      if (shown !== nd) return;
      state = r?.failed ? "couldn't start the engine" : r?.ok ? "done" : r?.stopped ? "stopped" : "failed";
      scroll = 1e9; // (the output, at the end)
      draw();
    }
  }

  // ---------------------------------------------------------------- the wrist menu (left controller)
  let menuButtons = [];
  function drawMenu() {
    const g = mcanvas.getContext("2d"), T = api.theme(), dark = T.fg !== "#1f2328";
    const C = dark ? { bg: "#161b22", fg: "#e6edf3", btn: "#21262d", off: "#555d66" } : { bg: "#ffffff", fg: "#1f2328", btn: "#eef1f5", off: "#a0a8b2" };
    g.clearRect(0, 0, MW, MH);
    g.fillStyle = C.bg; g.beginPath(); g.roundRect(0, 0, MW, MH, 28); g.fill();
    menuButtons = [];
    const tours = api.tours().length, now = api.tourNow();
    const items: [string, string, boolean][] = [["← Back", "back", backStack.length > 0 || api.inRoom()], ["Forward →", "forward", fwdStack.length > 0], ["See all", "home", true], ["Run all", "runall", true],
      [now ? "Next stop ▶" : "Tour", "tour", tours > 0 || !!now], [walk ? "Fly: off" : "Fly: on", "fly", true], [mode === "immersive-ar" ? "Exit AR" : "Exit VR", "exit", true]];
    const bw = (MW - 3 * 20) / 2, bh = 96;
    items.forEach(([label, act, on], k) => {
      const x = 20 + (k % 2) * (bw + 20), y = 20 + Math.floor(k / 2) * (bh + 20), w = bw;
      g.fillStyle = act === "exit" ? "#b42318" : C.btn; g.beginPath(); g.roundRect(x, y, w, bh, 18); g.fill();
      g.fillStyle = act === "exit" ? "#ffffff" : on ? C.fg : C.off; g.font = "600 38px system-ui, sans-serif"; g.textAlign = "center";
      g.fillText(label, x + w / 2, y + 62);
      menuButtons.push({ x, y, w, h: bh, act, on });
    });
    g.textAlign = "left";
    mtex.needsUpdate = true;
  }
  function menuPress(act) {
    if (act === "back") goBack();
    else if (act === "forward") goForward();
    else if (act === "home") seeAll();
    else if (act === "runall") api.runAll();
    else if (act === "tour" && (api.tours().length || api.tourNow())) tour(1);
    else if (act === "exit") session?.end();
    else if (act === "fly") setWalk(!walk);
  }

  // ---------------------------------------------------------------- pointing and selecting
  function hit(c) {
    ray.setFromXRController(c);
    const own = (m) => m.parent && m.parent !== c; // (the wrist's menu: pointed at by the other hand)
    const targets = [...(panel.visible ? [panel] : []), ...(own(menu) ? [menu] : []), ...api.pickables()];
    let h = ray.intersectObjects(targets, false)[0] ?? null;
    // (nothing else: the floor, to step to, when walking)
    if (!h && walk && api.ground().visible) { const hg = ray.intersectObjects(api.walkable(), false)[0]; if (hg && hg.distance < 120 * SCALE) h = { ...hg, floor: true }; }
    return h;
  }
  function onSelect(c) {
    const h = hit(c);
    if (!h) return;
    if (h.floor) { teleport(h.point); return; }
    if (h.object === menu) {
      const px = h.uv.x * MW, py = (1 - h.uv.y) * MH;
      const b = menuButtons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
      if (b) menuPress(b.act);
      return;
    }
    if (h.object === panel) {
      const px = h.uv.x * PW, py = (1 - h.uv.y) * PH;
      const b = buttons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
      if (b) press(b.act);
      return;
    }
    const nd = h.object.userData.node;
    if (nd) open(nd);
  }

  // ---------------------------------------------------------------- each frame: rays, and the thumbsticks
  let turnArmed = true;
  function step(dt) {
    if (!session) return;
    stepFlight();
    let marked = false;
    for (const c of controllers) {
      const h = c.userData.source ? hit(c) : null;
      c.userData.line.scale.z = h ? h.distance / SCALE : 30;
      // (where a step would put you)
      if (h?.floor && !marked) { mark.position.copy(h.point).setY(api.floorY(h.point.x, h.point.z) + 0.02); marked = true; }
      const nd = h && !h.floor && h.object !== panel && h.object !== menu ? h.object.userData.node ?? null : null;
      if (nd !== c.userData.hovered) {
        if (c.userData.hovered) api.glow(c.userData.hovered, 0);
        c.userData.hovered = nd;
        if (nd) api.glow(nd, 0.25);
      }
    }
    mark.visible = marked;
    const head = camera.getWorldPosition(new THREE.Vector3());
    const fwd = camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    // (the controllers, read once a frame: thumbsticks dead-zoned, buttons with the frame a press begins)
    const frame = renderer.xr.getFrame(), refSpace = renderer.xr.getReferenceSpace();
    if (!frame || !refSpace) return;
    const pads = input.poll(frame, refSpace);
    let moving = false, back = false;
    for (const hand of ["left", "right"] as const) {
      const s = pads[hand];
      if (!s.connected) continue;
      const [ax, ay] = s.axes;
      const speed = 2.5 * SCALE * (s.held.squeeze ? 4 : 1) * dt;
      if ((ax || ay) && flight) { if (flight.blink) settle(); else flight = null; } // (your own move wins over a flight)
      if (hand === "left") {
        const m = fwd.clone().multiplyScalar(-ay * speed).addScaledVector(right, ax * speed);
        // (walking: up a step, yes; into a terrace's side, no; standing on the ground, you follow it up and down)
        if (walk && (ax || ay)) {
          const feet = rig.position.y, here = api.floorY(head.x, head.z), there = api.floorY(head.x + m.x, head.z + m.z);
          if (there > feet + STEP_UP) m.set(0, 0, 0);
          else if (Math.abs(feet - here) < 0.05 && !flight) rig.position.y = there;
        }
        rig.position.add(m);
        if (ax || ay) moving = true;
      } else {
        // (up and down only when flying: walking keeps you on your floor)
        if (!walk) rig.position.y -= ay * speed;
        // (turning in 30° steps, about where you stand)
        if (Math.abs(ax) > 0.7 && turnArmed) {
          turnArmed = false;
          const a = -Math.sign(ax) * Math.PI / 6;
          rig.position.sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), a).add(head);
          rig.rotation.y += a;
        } else if (Math.abs(ax) < 0.3) turnArmed = true;
      }
      // (A or X: close the panel; B or Y: back, once per press)
      if (s.pressed.a && panel.visible) close();
      if (s.pressed.b) back = true;
    }
    if (back) goBack();
    // (the vignette while walking; the disc under your feet above the floor)
    vig += ((moving && walk ? 1 : 0) - vig) * Math.min(1, dt * 8);
    vignette.visible = vig > 0.02;
    vignette.material.opacity = 0.8 * vig;
    // (the floor moved (another room, a new object lower down): standing on it, you stay on it)
    const fy = api.floorY();
    if (walk && !flight && Math.abs(rig.position.y - lastFloor) < 1e-3 && fy !== lastFloor) rig.position.y = fy;
    lastFloor = fy;
    const feet = rig.position.y;
    disc.visible = walk && feet > api.floorY(head.x, head.z) + 0.3 * SCALE;
    if (disc.visible) disc.position.set(head.x, feet + 0.01, head.z);
  }

  // ---------------------------------------------------------------- entering and leaving
  // (on the person's click only: the browser asks for that; entering again while in one leaves it)
  async function enter(m = "immersive-vr") {
    if (session) return session.end();
    // (WebXR's types aren't in the page's type check: the session is the browser's, handed to three.js)
    const nx = (navigator as unknown as { xr?: { requestSession(mode: string, init?: object): Promise<any> } }).xr;
    if (!nx) throw new Error(`this browser has no ${m === "immersive-ar" ? "AR" : "VR"}`);
    const s = await nx.requestSession(m, { optionalFeatures: ["local-floor"] });
    // (where you'll stand: where the camera is, facing where it looks)
    saved = { pos: camera.position.clone(), quat: camera.quaternion.clone(), bg: scene.background, fog: scene.fog };
    const dir = new THREE.Vector3().subVectors(controls.target, camera.position);
    rig.position.copy(camera.position).add(new THREE.Vector3(0, -EYE * SCALE, 0));
    rig.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0);
    rig.scale.setScalar(SCALE);
    controls.enabled = false;
    if (m === "immersive-ar") { scene.background = null; scene.fog = null; api.ground().visible = false; }
    s.addEventListener("end", leave);
    await renderer.xr.setSession(s);
    session = s; mode = m;
    api.changed(true, m);
    drawMenu();
  }
  function leave() {
    session = null; mode = null; flight = null; backStack.length = 0; fwdStack.length = 0;
    fader.visible = false; vignette.visible = false; disc.visible = false; mark.visible = false; vig = 0;
    api.ground().visible = true;
    close();
    for (const c of controllers) { if (c.userData.hovered) api.glow(c.userData.hovered, 0); c.userData.hovered = null; }
    rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0); rig.scale.setScalar(1);
    if (saved) {
      camera.position.copy(saved.pos); camera.quaternion.copy(saved.quat);
      scene.background = saved.bg; scene.fog = saved.fog; saved = null;
    }
    controls.enabled = true;
    api.changed(false, null);
  }
  return {
    enter, supported: xrSupported, step,
    get presenting() { return !!session; },
    get mode() { return mode; },
    get panel() { return shown ? { id: shown.id, state, buttons: buttons.map((b) => b.act) } : null; },
    press, open: (nd) => open(nd), rig, menuPress, tour, roomChanged,
    get walking() { return walk; },
    setWalk: (on) => setWalk(on),
    teleport: (x, z) => teleport(new THREE.Vector3(x, 0, z)),
    get history() { return { back: backStack.length, forward: fwdStack.length, flying: !!flight }; },
  };
}
