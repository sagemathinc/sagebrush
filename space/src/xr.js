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

  // ---------------------------------------------------------------- flying: to an object's view, Back and Forward
  // (your head at `to`, facing `toT` (turned about the vertical only), in `ms`; where you were is remembered for Back)
  let flight = null;
  const backStack = [], fwdStack = [];
  // (each place remembered with how many rooms deep it was: a place in a room that has since been left is passed over)
  const pose = () => ({ pos: rig.position.clone(), yaw: rig.rotation.y, depth: api.depth() });
  function flyRig(to, toT, ms = 450, remember = true) {
    if (remember) { backStack.push(pose()); fwdStack.length = 0; drawMenu(); }
    const d = new THREE.Vector3().subVectors(toT, to);
    const yaw = Math.atan2(-d.x, -d.z);
    // (the rig's place that puts the head, where it is in the rig now, at `to`)
    const head = camera.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiplyScalar(SCALE);
    flyPose({ pos: to.clone().sub(head), yaw }, ms);
  }
  function flyPose(target, ms = 450) {
    let dy = target.yaw - rig.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // (the short way round)
    flight = { from: pose(), to: { pos: target.pos, yaw: rig.rotation.y + dy }, t0: performance.now(), ms };
  }
  function stepFlight() {
    if (!flight) return;
    const u = Math.max(0, Math.min(1, (performance.now() - flight.t0) / flight.ms)), e = u * u * (3 - 2 * u);
    rig.position.lerpVectors(flight.from.pos, flight.to.pos, e);
    rig.rotation.y = flight.from.yaw + (flight.to.yaw - flight.from.yaw) * e;
    if (u >= 1) flight = null;
  }
  // (Back past where a room was entered: out of the room, to where you stood; with nothing to go back to inside a room
  //  entered before the headset, out of it to the view of everything)
  function goBack() {
    const cur = api.depth();
    while (backStack.length && backStack.at(-1).depth > cur) backStack.pop();
    const v = backStack.at(-1)?.depth === cur ? backStack.pop() : null;
    if (v?.leave) { close(); api.leave(); fwdStack.length = 0; flyPose(v); }
    else if (v) { fwdStack.push(pose()); flyPose(v); }
    else if (api.inRoom()) { close(); api.leave(); fwdStack.length = 0; const h = api.home(); if (h) flyRig(h.to, h.toT, 450, false); }
    drawMenu();
  }
  const goForward = () => {
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
  const MW = 512, MH = 368;
  const mcanvas = Object.assign(document.createElement("canvas"), { width: MW, height: MH });
  const mtex = new THREE.CanvasTexture(mcanvas);
  mtex.colorSpace = THREE.SRGBColorSpace;
  const menu = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.144), new THREE.MeshBasicMaterial({ map: mtex, side: THREE.DoubleSide, transparent: true }));
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
      [now ? "Next stop ▶" : "Tour", "tour", tours > 0 || !!now], ["Exit VR", "exit", true]];
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
  }

  // ---------------------------------------------------------------- the agent's chat (a space with an agent)
  // A panel below your view, turned to you, following your head slowly: the conversation's last messages, the line
  // you are typing (a Bluetooth keyboard types into it), and the next things to try as buttons to point at.
  const CW = 1024, CH = 600;
  const ccanvas = Object.assign(document.createElement("canvas"), { width: CW, height: CH });
  const ctex = new THREE.CanvasTexture(ccanvas);
  ctex.colorSpace = THREE.SRGBColorSpace;
  const chatPanel = new THREE.Mesh(new THREE.PlaneGeometry(0.9 * SCALE, (0.9 * SCALE * CH) / CW), new THREE.MeshBasicMaterial({ map: ctex, side: THREE.DoubleSide, transparent: true }));
  chatPanel.renderOrder = 19;
  chatPanel.visible = false;
  scene.add(chatPanel);
  let typed = "", chatButtons = [], chatPlaced = false;
  function drawChat() {
    const chat = api.chat();
    chatPanel.visible = !!(session && chat);
    if (!chatPanel.visible) return;
    const g = ccanvas.getContext("2d"), T = api.theme(), dark = T.fg !== "#1f2328";
    const C = dark ? { bg: "rgba(22,27,34,0.94)", fg: "#e6edf3", muted: "#8d96a0", you: "#1d3557", btn: "#21262d" } : { bg: "rgba(255,255,255,0.95)", fg: "#1f2328", muted: "#57606a", you: "#dbe8fd", btn: "#eef1f5" };
    g.clearRect(0, 0, CW, CH);
    g.fillStyle = C.bg; g.beginPath(); g.roundRect(0, 0, CW, CH, 30); g.fill();
    const pad = 32;
    // (the last messages, the newest at the bottom)
    g.font = "28px system-ui, sans-serif";
    const rows = [];
    for (const m of chat.messages.slice(-4)) {
      const text = texToText(String(m.text)).replace(/\*\*|`/g, "");
      const words = text.split(/\s+/);
      let row = (m.from === "you" ? "You: " : "Agent: ");
      const mine = [];
      for (const w of words) { const t = row + w + " "; if (g.measureText(t).width > CW - 2 * pad && row.trim()) { mine.push(row); row = w + " "; } else row = t; }
      mine.push(row);
      rows.push(...mine.map((r) => ({ r, you: m.from === "you" })));
    }
    let y = pad + 26;
    for (const { r, you } of rows.slice(-9)) { g.fillStyle = you ? "#1f6feb" : C.fg; g.fillText(r, pad, y); y += 36; }
    // (the line being typed)
    const lineY = CH - 190;
    g.fillStyle = C.btn; g.beginPath(); g.roundRect(pad - 8, lineY - 34, CW - 2 * pad + 16, 52, 12); g.fill();
    g.fillStyle = typed ? C.fg : C.muted; g.font = "28px system-ui, sans-serif";
    g.fillText(typed ? typed + "▏" : chat.busy ? "The agent is working…" : "Type on your keyboard, or point at a suggestion", pad, lineY);
    // (the suggestions, and Send)
    chatButtons = [];
    let x = pad, by = CH - 120;
    const button = (label, act, primary = false) => {
      g.font = "600 26px system-ui, sans-serif";
      const w = Math.min(CW - 2 * pad, g.measureText(label).width + 40);
      if (x + w > CW - pad) { x = pad; by += 62; }
      if (by > CH - 50) return;
      g.fillStyle = primary ? "#1f6feb" : C.btn; g.beginPath(); g.roundRect(x, by, w, 50, 14); g.fill();
      g.fillStyle = primary ? "#ffffff" : C.fg; g.fillText(label, x + 20, by + 34, w - 40);
      chatButtons.push({ x, y: by, w, h: 50, act });
      x += w + 12;
    };
    if (typed) button("Send ▶", { send: typed }, true);
    for (const s of chat.suggestions.slice(0, typed ? 1 : 2)) button(s.length > 46 ? s.slice(0, 44) + "…" : s, { send: s });
    ctex.needsUpdate = true;
  }
  function placeChat(snap = false) {
    // (below and in front of your head; it follows your turns, gently)
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const want = head.clone().addScaledVector(dir, 0.75 * SCALE).add(new THREE.Vector3(0, -0.42 * SCALE, 0));
    // (gently when near; quickly when far behind, after a flight)
    if (snap || !chatPlaced) chatPanel.position.copy(want); else chatPanel.position.lerp(want, chatPanel.position.distanceTo(want) > 0.5 * SCALE ? 0.2 : 0.04);
    chatPlaced = true;
    chatPanel.lookAt(head);
  }
  function chatSend(text) {
    const chat = api.chat();
    if (!chat || !text.trim()) return;
    chat.send(text);
    typed = "";
    drawChat();
  }
  // (the keyboard, in a headset with an agent: printable keys, Backspace, Enter)
  addEventListener("keydown", (e) => {
    if (!session || !api.chat() || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
    if (e.key === "Enter") { chatSend(typed); e.preventDefault(); return; }
    if (e.key === "Backspace") { typed = typed.slice(0, -1); drawChat(); e.preventDefault(); return; }
    if (e.key === "Escape") { typed = ""; drawChat(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && typed.length < 500) { typed += e.key; drawChat(); e.preventDefault(); }
  });

  // ---------------------------------------------------------------- pointing and selecting
  function hit(c) {
    ray.setFromXRController(c);
    const targets = [...(panel.visible ? [panel] : []), ...(chatPanel.visible ? [chatPanel] : []), ...(menu.parent && menu.parent !== c ? [menu] : []), ...api.pickables()];
    return ray.intersectObjects(targets, false)[0] ?? null;
  }
  function onSelect(c) {
    const h = hit(c);
    if (!h) return;
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
    if (chatPanel.visible) placeChat();
    backHeld = false;
    for (const c of controllers) {
      const h = c.userData.source ? hit(c) : null;
      c.userData.line.scale.z = h ? h.distance / SCALE : 30;
      const nd = h && h.object !== panel && h.object !== chatPanel ? h.object.userData.node ?? null : null;
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
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 4) continue;
      const ax = Math.abs(gp.axes[2]) > 0.15 ? gp.axes[2] : 0, ay = Math.abs(gp.axes[3]) > 0.15 ? gp.axes[3] : 0;
      const fast = gp.buttons[1]?.pressed ? 4 : 1, speed = 2.5 * SCALE * fast * dt;
      if ((ax || ay) && flight) flight = null; // (your own move wins over a flight)
      if (src.handedness === "left") {
        rig.position.addScaledVector(fwd, -ay * speed).addScaledVector(right, ax * speed);
      } else if (src.handedness === "right") {
        rig.position.y -= ay * speed;
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
    if (m === "immersive-ar") { scene.background = null; scene.fog = null; }
    s.addEventListener("end", leave);
    await renderer.xr.setSession(s);
    session = s; mode = m;
    api.changed(true, m);
    chatPlaced = false;
    drawChat();
  }
  function leave() {
    session = null; mode = null; flight = null; backStack.length = 0; fwdStack.length = 0;
    chatPanel.visible = false; typed = "";
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
    look(nd, dist) { if (!session) return; const v = api.viewOf(nd, dist); flyRig(v.to, v.toT, 700); },
    chatSend: (t) => chatSend(t),
    get chat() { return chatPanel.visible ? { typed, buttons: chatButtons.map((b) => b.act.send) } : null; },
    get history() { return { back: backStack.length, forward: fwdStack.length, flying: !!flight }; },
  };
}
