// Comfort first (walking, the default): you stand on the floor; the left thumbstick walks, the right turns in steps; a
// move to an object or Back is a blink (a quick fade), never a glide through the air; point at the floor and pull the
// trigger to step there; above the floor, a disc stands under your feet; the view's edges darken while you walk. Fly
// (the wrist menu) brings back gliding flights and the right thumbstick's up and down.
// The space in a headset (WebXR: Meta Quest's browser, and others): Enter VR (or AR, the space in your room through
// passthrough). You stand in the space at a scale where a slab is about a metre wide. Each controller casts a ray:
// the trigger selects what it points at: you fly to it (as the desktop does) and its reading panel opens beside it (the
// drawer's text, its output, Run; the page's own HTML isn't drawn inside a headset). Left thumbstick: move where you
// look; right thumbstick: up and down, and turn in steps. Hold the grip to go faster. A or X closes the panel; B or Y
// goes back. The menu on your left wrist: Back, Forward, See all, Run all, Exit VR. A directory, a file or a class is
// entered from its panel (Enter): its room replaces the space around you, and Back past it brings you out again.
import * as THREE from "three";
import { texToText } from "./tex.js";

const SCALE = 5; // (world units per metre: a slab, 5 units wide, is a metre across)
const EYE = 1.6; // (where the floor is, below the eye, in metres: the space starts where the camera was)

export function setupXR(api) {
  const { renderer, scene, camera, controls } = api;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  const rig = new THREE.Group();
  scene.add(rig);
  rig.add(camera);
  let session = null, mode = null, saved = null;
  // (walking or flying; kept for the next visit)
  let walk = (() => { try { return localStorage.getItem("whitespace:xr-move") !== "fly"; } catch { return true; } })();
  // (the blink: black around the eyes, faded in and out)
  const fader = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false }));
  fader.renderOrder = 1000;
  fader.visible = false;
  camera.add(fader);
  // (the vignette: the view's edges darkened while walking, which eases the feeling of moving)
  const vc = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
  // (wide enough to cover the whole view, so it has no edge: clear in the middle, dark from about 70° out)
  { const g = vc.getContext("2d"), gr = g.createRadialGradient(128, 128, 26, 128, 128, 64); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,1)"); g.fillStyle = "#000"; g.fillRect(0, 0, 256, 256); g.clearRect(0, 0, 0, 0); g.globalCompositeOperation = "copy"; g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
  const vignette = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(vc), transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  vignette.position.z = -0.2;
  vignette.renderOrder = 999;
  vignette.visible = false;
  camera.add(vignette);
  let vig = 0, lastFloor = NaN;
  // (the disc under your feet when you stand above the floor, and the mark where a teleport would put you)
  const disc = new THREE.Mesh(new THREE.RingGeometry(0.12 * SCALE, 0.42 * SCALE, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4a9d6f, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
  disc.visible = false;
  scene.add(disc);
  const mark = new THREE.Mesh(new THREE.RingGeometry(0.18 * SCALE, 0.26 * SCALE, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  mark.visible = false;
  scene.add(mark);

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
      if (e.data?.handedness === "left") { c.add(menu); c.add(chatPanel); drawMenu(); }
    });
    c.addEventListener("disconnected", () => (c.userData.source = null));
    c.addEventListener("select", () => onSelect(c));
    rig.add(c);
    return c;
  });
  const ray = new THREE.Raycaster();

  // ---------------------------------------------------------------- flying: to an object's view, Back and Forward
  // (your head at `to`, facing `toT` (turned about the vertical only), in `ms`; where you were is remembered for Back)
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
    flyPose({ pos: new THREE.Vector3(p.x - head.x, api.floorY(), p.z - head.z), yaw: rig.rotation.y });
    drawMenu();
  }
  function setWalk(on) {
    walk = !!on;
    try { localStorage.setItem("whitespace:xr-move", walk ? "walk" : "fly"); } catch {}
    // (to the floor, when walking starts: below where you are)
    if (walk && session && rig.position.y > api.floorY() + 0.05) { settle(); backStack.push(pose()); flyPose({ pos: rig.position.clone().setY(api.floorY()), yaw: rig.rotation.y }); }
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
  // (the space around you changed rooms (here, on the desktop, or by an agent): the panel shows an object of the room
  //  left, and Forward's places are in it)
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
  const PW = 1024, PH = 1280, PANEL_LINES = 400;
  const canvas = Object.assign(document.createElement("canvas"), { width: PW, height: PH });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.0 * SCALE, 1.25 * SCALE), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true }));
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
    if (nd.src && !nd._full && !nd.text) add("fetching its text…", "hint");
    if (nd.kind === "note") add(texToText(nd.text).replace(/^#+\s*/gm, "").replace(/\*\*|`/g, ""), "prose");
    else {
      // (a long file: its first lines here; the drawer on a screen has more)
      const ls = String(nd.text ?? "").split("\n");
      add(ls.slice(0, PANEL_LINES).join("\n"), "code");
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
      g.fillText(r.text, pad + (r.mono ? 4 : 0), y + 26);
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
    button("✕ Close", "close");
    if (state && state !== "running") { g.fillStyle = C.muted; g.font = "26px system-ui, sans-serif"; g.fillText(state, x + 8, PH - 70); }
    tex.needsUpdate = true;
  }
  function open(nd, fly = true, tourStop = null) {
    shown = nd; scroll = 0; state = ""; stop = tourStop;
    draw();
    // (a file whose text is elsewhere: drawn again when it has come)
    if (nd.src && !nd._full) api.fullText(nd).then(() => shown === nd && api.has(nd) && draw(), () => { if (shown === nd) { state = "couldn't fetch its text"; draw(); } });
    api.select(nd);
    if (fly) {
      // (to the object, as the desktop flies to it; the panel then opens to its right, facing where you'll be)
      const v = api.viewOf(nd);
      flyRig(v.to, v.toT);
      const d = new THREE.Vector3().subVectors(v.toT, v.to).setY(0).normalize();
      const right = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
      const eyeTo = v.to.clone();
      panel.position.copy(eyeTo).addScaledVector(d, 1.1 * SCALE).addScaledVector(right, 0.75 * SCALE).add(new THREE.Vector3(0, -0.1 * SCALE, 0));
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
    panel.visible = true;
  }
  function close() { panel.visible = false; shown = null; stop = null; api.select(null); }
  // (a tour: the next or previous stop, flown to with its narration; past the last, the tour ends)
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
    if (act === "down") { scroll += 8; return draw(); }
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
  const MW = 512, MH = 484;
  const mcanvas = Object.assign(document.createElement("canvas"), { width: MW, height: MH });
  const mtex = new THREE.CanvasTexture(mcanvas);
  mtex.colorSpace = THREE.SRGBColorSpace;
  const menu = new THREE.Mesh(new THREE.PlaneGeometry(0.2, (0.2 * MH) / MW), new THREE.MeshBasicMaterial({ map: mtex, side: THREE.DoubleSide, transparent: true }));
  menu.position.set(0, 0.07, -0.02);
  menu.rotation.x = -Math.PI / 4;
  menu.renderOrder = 21;
  let menuButtons = [];
  function drawMenu() {
    const g = mcanvas.getContext("2d"), T = api.theme(), dark = T.fg !== "#1f2328";
    const C = dark ? { bg: "#161b22", fg: "#e6edf3", btn: "#21262d", off: "#555d66" } : { bg: "#ffffff", fg: "#1f2328", btn: "#eef1f5", off: "#a0a8b2" };
    g.clearRect(0, 0, MW, MH);
    g.fillStyle = C.bg; g.beginPath(); g.roundRect(0, 0, MW, MH, 28); g.fill();
    menuButtons = [];
    const tours = api.tours().length, now = api.tourNow();
    const items = [["← Back", "back", backStack.length > 0 || api.inRoom()], ["Forward →", "forward", fwdStack.length > 0], ["See all", "home", true], ["Run all", "runall", true],
      [now ? "Next stop ▶" : "Tour", "tour", tours > 0 || !!now], [chatOpen ? "Chat ✕" : "Chat", "chat", !!api.chat()],
      [walk ? "Fly: off" : "Fly: on", "fly", true], ["Exit VR", "exit", true]];
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
    else if (act === "chat" && api.chat()) openChat(!chatOpen);
    else if (act === "fly") setWalk(!walk);
  }

  // ---------------------------------------------------------------- the agent's chat (a space with an agent)
  // On your left wrist, above the menu, while it is open (the menu's Chat, or pointing at the agent): the conversation's
  // last messages, the line you are typing, Send, and the next things to try as buttons to point at. Lower your wrist
  // and it is out of your way. Typing goes into a text field of the page (Meta's WebXR keyboard: focusing a text field
  // shows the headset's own keyboard, with its microphone for dictation; a Bluetooth keyboard types into it too).
  const CW = 1024, CH = 600, CHAT_W = 0.3, CHAT_H = (0.3 * CH) / CW;
  const ccanvas = Object.assign(document.createElement("canvas"), { width: CW, height: CH });
  const ctex = new THREE.CanvasTexture(ccanvas);
  ctex.colorSpace = THREE.SRGBColorSpace;
  const chatPanel = new THREE.Mesh(new THREE.PlaneGeometry(CHAT_W, CHAT_H), new THREE.MeshBasicMaterial({ map: ctex, side: THREE.DoubleSide, transparent: true }));
  chatPanel.renderOrder = 22;
  chatPanel.visible = false;
  // (above the menu, in its tilted plane)
  {
    const up = new THREE.Vector3(0, Math.cos(Math.PI / 4), -Math.sin(Math.PI / 4)), gap = (0.2 * MH) / MW / 2 + CHAT_H / 2 + 0.012;
    chatPanel.position.copy(menu.position).addScaledVector(up, gap);
    chatPanel.rotation.x = -Math.PI / 4;
  }
  const field = Object.assign(document.createElement("input"), { type: "text", autocomplete: "off", ariaLabel: "Your message to the agent" });
  field.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;border:0;padding:0;font-size:16px;z-index:-1";
  field.tabIndex = -1;
  field.maxLength = 500;
  document.body.appendChild(field);
  let typed = "", chatButtons = [], chatOpen = false;
  field.addEventListener("input", () => { typed = field.value.slice(0, 500); drawChat(); });
  field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); chatSend(field.value); } });
  const systemKeyboard = () => !!session?.isSystemKeyboardSupported;
  function openChat(on) {
    chatOpen = !!on && !!api.chat() && !!session;
    typed = ""; field.value = "";
    if (chatOpen && systemKeyboard()) field.focus(); else field.blur();
    drawChat();
    drawMenu();
  }
  function drawChat() {
    const chat = api.chat();
    if (chatOpen && (!chat || !session)) { chatOpen = false; field.blur(); }
    chatPanel.visible = chatOpen;
    if (!chatPanel.visible) return;
    const g = ccanvas.getContext("2d"), T = api.theme(), dark = T.fg !== "#1f2328";
    const C = dark ? { bg: "rgba(22,27,34,0.96)", fg: "#e6edf3", muted: "#8d96a0", btn: "#21262d" } : { bg: "rgba(255,255,255,0.97)", fg: "#1f2328", muted: "#57606a", btn: "#eef1f5" };
    g.clearRect(0, 0, CW, CH);
    g.fillStyle = C.bg; g.beginPath(); g.roundRect(0, 0, CW, CH, 30); g.fill();
    const pad = 32;
    // (the last messages, the newest at the bottom)
    g.font = "30px system-ui, sans-serif";
    const rows = [];
    for (const m of chat.messages.slice(-4)) {
      const words = texToText(String(m.text)).replace(/\*\*|`/g, "").split(/\s+/);
      let row = (m.from === "you" ? "You: " : "Agent: ");
      const mine = [];
      for (const w of words) { const t = row + w + " "; if (g.measureText(t).width > CW - 2 * pad && row.trim()) { mine.push(row); row = w + " "; } else row = t; }
      mine.push(row);
      rows.push(...mine.map((r) => ({ r, you: m.from === "you" })));
    }
    let y = pad + 28;
    for (const { r, you } of rows.slice(-7)) { g.fillStyle = you ? "#1f6feb" : C.fg; g.fillText(r, pad, y); y += 38; }
    // (the line being typed)
    const lineY = CH - 196;
    g.fillStyle = C.btn; g.beginPath(); g.roundRect(pad - 8, lineY - 36, CW - 2 * pad + 16, 54, 12); g.fill();
    g.fillStyle = typed ? C.fg : C.muted; g.font = "30px system-ui, sans-serif";
    g.fillText(typed ? typed + "▏" : chat.busy ? "The agent is working…" : systemKeyboard() ? "Type or speak (the keyboard's microphone), or point at a suggestion" : "Type, or point at a suggestion", pad, lineY, CW - 2 * pad);
    // (Send, the keyboard again, Close; and the suggestions)
    chatButtons = [];
    let x = pad, by = CH - 126;
    const button = (label, act, primary = false) => {
      g.font = "600 28px system-ui, sans-serif";
      const w = Math.min(CW - 2 * pad, g.measureText(label).width + 40);
      if (x + w > CW - pad) { x = pad; by += 62; }
      if (by > CH - 52) return;
      g.fillStyle = primary ? "#1f6feb" : C.btn; g.beginPath(); g.roundRect(x, by, w, 52, 14); g.fill();
      g.fillStyle = primary ? "#ffffff" : C.fg; g.fillText(label, x + 20, by + 36, w - 40);
      chatButtons.push({ x, y: by, w, h: 52, act });
      x += w + 12;
    };
    if (typed) button("Send ▶", { send: typed }, true);
    if (systemKeyboard()) button("⌨ 🎤", { keyboard: true });
    button("✕", { close: true });
    for (const s of chat.suggestions.slice(0, typed ? 1 : 2)) button(s.length > 40 ? s.slice(0, 38) + "…" : s, { send: s });
    ctex.needsUpdate = true;
  }
  function chatSend(text) {
    const chat = api.chat();
    if (!chat || !String(text).trim()) return;
    chat.send(String(text));
    // (sent: the chat folds away, the keyboard goes, and you watch the agent work; its answer is in its bubble)
    openChat(false);
  }
  // (a keyboard whose keys reach the page while the text field isn't focused (no system keyboard: an emulator, a
  //  desktop browser's WebXR): printable keys, Backspace, Enter)
  addEventListener("keydown", (e) => {
    if (!session || !chatOpen || document.activeElement === field || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
    if (e.key === "Enter") { chatSend(typed); e.preventDefault(); return; }
    if (e.key === "Backspace") { typed = typed.slice(0, -1); drawChat(); e.preventDefault(); return; }
    if (e.key === "Escape") { openChat(false); return; }
    if (e.key.length === 1 && typed.length < 500) { typed += e.key; drawChat(); e.preventDefault(); }
  });

  // ---------------------------------------------------------------- pointing and selecting
  let figOf = null, figParts = [];
  function hit(c) {
    ray.setFromXRController(c);
    const own = (m) => m.parent && m.parent !== c; // (the wrist's panels: pointed at by the other hand)
    const targets = [...(panel.visible ? [panel] : []), ...(chatPanel.visible && own(chatPanel) ? [chatPanel] : []), ...(own(menu) ? [menu] : []), ...api.pickables()];
    let h = ray.intersectObjects(targets, false)[0] ?? null;
    // (the agent: its chat)
    const fig = api.agentFigure();
    // (its solid parts only: its speech bubble is a sprite, which a controller's ray can't test (no camera); listed
    //  once per figure)
    if (fig !== figOf) { figOf = fig; figParts = []; fig?.traverse((m) => { if (m.isMesh) figParts.push(m); }); }
    const hf = figParts.length ? ray.intersectObjects(figParts, false)[0] : null;
    if (hf && (!h || hf.distance < h.distance)) h = { ...hf, agent: true };
    // (nothing else: the floor, to step to, when walking)
    if (!h && walk && api.ground().visible) { const hg = ray.intersectObject(api.ground(), false)[0]; if (hg && hg.distance < 120 * SCALE) h = { ...hg, floor: true }; }
    return h;
  }
  function onSelect(c) {
    const h = hit(c);
    if (!h) return;
    if (h.agent) { openChat(!chatOpen); return; }
    if (h.floor) { teleport(h.point); return; }
    if (h.object === menu) {
      const px = h.uv.x * MW, py = (1 - h.uv.y) * MH;
      const b = menuButtons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
      if (b) menuPress(b.act);
      return;
    }
    if (h.object === chatPanel) {
      const px = h.uv.x * CW, py = (1 - h.uv.y) * CH;
      const b = chatButtons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
      if (b?.act.send) chatSend(b.act.send);
      else if (b?.act.keyboard) { field.blur(); field.focus(); } // (again, after the keyboard was put away)
      else if (b?.act.close) openChat(false);
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
  let turnArmed = true, backArmed = true, backHeld = false;
  function step(dt) {
    if (!session) return;
    stepFlight();
    backHeld = false;
    let marked = false;
    for (const c of controllers) {
      const h = c.userData.source ? hit(c) : null;
      c.userData.line.scale.z = h ? h.distance / SCALE : 30;
      // (where a step would put you)
      if (h?.floor && !marked) { mark.position.copy(h.point).setY(api.floorY() + 0.02); marked = true; }
      const nd = h && !h.agent && !h.floor && h.object !== panel && h.object !== chatPanel ? h.object.userData.node ?? null : null;
      if (nd !== c.userData.hovered) {
        if (c.userData.hovered) api.glow(c.userData.hovered, 0);
        c.userData.hovered = nd;
        if (nd) api.glow(nd, 0.25);
      }
    }
    const head = camera.getWorldPosition(new THREE.Vector3());
    const fwd = camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    mark.visible = marked;
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    let moving = false;
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 4) continue;
      const ax = Math.abs(gp.axes[2]) > 0.15 ? gp.axes[2] : 0, ay = Math.abs(gp.axes[3]) > 0.15 ? gp.axes[3] : 0;
      const fast = gp.buttons[1]?.pressed ? 4 : 1, speed = 2.5 * SCALE * fast * dt;
      if ((ax || ay) && flight) { if (flight.blink) settle(); else flight = null; } // (your own move wins over a flight)
      if (src.handedness === "left") {
        rig.position.addScaledVector(fwd, -ay * speed).addScaledVector(right, ax * speed);
        if (ax || ay) moving = true;
      } else if (src.handedness === "right") {
        // (up and down only when flying: walking keeps you on your floor)
        if (!walk) rig.position.y -= ay * speed;
        // (turning in 30° steps, about where you stand)
        if (Math.abs(gp.axes[2]) > 0.7 && turnArmed) {
          turnArmed = false;
          const a = -Math.sign(gp.axes[2]) * Math.PI / 6;
          rig.position.sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), a).add(head);
          rig.rotation.y += a;
        } else if (Math.abs(gp.axes[2]) < 0.3) turnArmed = true;
      }
      if (gp.buttons[4]?.pressed && panel.visible) close();
      if (gp.buttons[5]?.pressed) backHeld = true;
    }
    // (B or Y: back, once per press)
    if (backHeld && backArmed) goBack();
    backArmed = !backHeld;
    // (the vignette while walking; the disc under your feet above the floor)
    vig += ((moving && walk ? 1 : 0) - vig) * Math.min(1, dt * 8);
    vignette.visible = vig > 0.02;
    vignette.material.opacity = 0.8 * vig;
    // (the floor moved (another room, a new object lower down): standing on it, you stay on it)
    const fy = api.floorY();
    if (walk && !flight && Math.abs(rig.position.y - lastFloor) < 1e-3 && fy !== lastFloor) rig.position.y = fy;
    lastFloor = fy;
    const feet = rig.position.y;
    disc.visible = walk && feet > api.floorY() + 0.3 * SCALE;
    if (disc.visible) disc.position.set(head.x, feet + 0.01, head.z);
  }

  // ---------------------------------------------------------------- entering and leaving
  async function supported(m) {
    try { return !!navigator.xr && (await navigator.xr.isSessionSupported(m)); } catch { return false; }
  }
  async function enter(m = "immersive-vr") {
    if (session) return session.end();
    if (!(await supported(m))) throw new Error(`this browser has no ${m === "immersive-ar" ? "AR" : "VR"}`);
    const s = await navigator.xr.requestSession(m, { optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"] });
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
    chatOpen = false;
    drawChat();
    drawMenu();
  }
  function leave() {
    session = null; mode = null; flight = null; backStack.length = 0; fwdStack.length = 0;
    chatOpen = false; chatPanel.visible = false; typed = ""; field.value = ""; field.blur();
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
    enter, supported, step,
    get presenting() { return !!session; },
    get mode() { return mode; },
    get panel() { return shown ? { id: shown.id, state, buttons: buttons.map((b) => b.act) } : null; },
    press, open: (nd) => open(nd), rig, menuPress, tour, roomChanged,
    // (the agent's chat: redrawn when it changes; and a flight to what the agent made)
    chatChanged: () => drawChat(),
    openChat: (on) => openChat(on),
    get chatOpen() { return chatOpen; },
    get walking() { return walk; },
    setWalk: (on) => setWalk(on),
    teleport: (x, z) => teleport(new THREE.Vector3(x, 0, z)),
    look(nd, dist) { if (!session) return; const v = api.viewOf(nd, dist); flyRig(v.to, v.toT, 700); },
    chatSend: (t) => chatSend(t),
    get chat() { return chatPanel.visible ? { typed, buttons: chatButtons.filter((b) => b.act.send).map((b) => b.act.send) } : null; },
    get history() { return { back: backStack.length, forward: fwdStack.length, flying: !!flight }; },
  };
}
