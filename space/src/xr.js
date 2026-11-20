// The space in a headset (WebXR: Meta Quest's browser, and others): Enter VR (or AR, the space in your room through
// passthrough). You stand in the space at a scale where a slab is about a metre wide. Each controller casts a ray:
// the trigger selects what it points at, and a reading panel opens in front of you (the drawer's text, its output, Run;
// the page's own HTML isn't drawn inside a headset). Left thumbstick: move where you look; right thumbstick: up and
// down, and turn in steps. Hold the grip to go faster. A or X closes the panel.
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
    c.addEventListener("connected", (e) => (c.userData.source = e.data));
    c.addEventListener("disconnected", () => (c.userData.source = null));
    c.addEventListener("select", () => onSelect(c));
    rig.add(c);
    return c;
  });
  const ray = new THREE.Raycaster();

  // ---------------------------------------------------------------- the reading panel
  const PW = 1024, PH = 1280;
  const canvas = Object.assign(document.createElement("canvas"), { width: PW, height: PH });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.0 * SCALE, 1.25 * SCALE), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true }));
  panel.renderOrder = 20;
  panel.visible = false;
  scene.add(panel);
  let shown = null, scroll = 0, state = "", buttons = [];

  function lines(nd) {
    const out = [];
    const add = (text, style) => { for (const l of String(text ?? "").split("\n")) out.push({ text: l, style }); };
    if (nd.kind === "note") add(texToText(nd.text).replace(/^#+\s*/gm, "").replace(/\*\*|`/g, ""), "prose");
    else add(nd.text, "code");
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
    const C = dark ? { bg: "#161b22", fg: "#e6edf3", muted: "#8d96a0", code: "#0d1117", out: "#0f2a1b", err: "#3a1418", btn: "#21262d", line: "#30363d" }
      : { bg: "#ffffff", fg: "#1f2328", muted: "#57606a", code: "#f6f8fa", out: "#e7f6ec", err: "#ffebe9", btn: "#eef1f5", line: "#d0d7de" };
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
      g.font = mono ? "30px ui-monospace, Menlo, monospace" : l.style === "label" ? "600 24px system-ui, sans-serif" : "34px Georgia, serif";
      for (const r of wrap(g, l.text, PW - 2 * pad - 24)) rows.push({ ...l, text: r, mono });
    }
    const top = y + 20, bottom = PH - 150, rowH = 42, fit = Math.floor((bottom - top) / rowH);
    scroll = Math.max(0, Math.min(scroll, rows.length - fit));
    y = top;
    for (const r of rows.slice(scroll, scroll + fit)) {
      if (r.style !== "prose" && r.style !== "label" && r.style !== "hint") {
        g.fillStyle = r.style === "code" ? C.code : r.style === "output" ? C.out : C.err;
        g.fillRect(pad - 8, y - 8, PW - 2 * pad + 16, rowH);
      }
      g.font = r.mono ? "30px ui-monospace, Menlo, monospace" : r.style === "label" ? "600 24px system-ui, sans-serif" : r.style === "hint" ? "italic 30px system-ui, sans-serif" : "34px Georgia, serif";
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
    if (api.runnable(nd)) button(state === "running" ? "Running…" : "▶ Run", "run", true);
    if (rows.length > fit) { button("▲", "up"); button("▼", "down"); }
    button("✕ Close", "close");
    if (state && state !== "running") { g.fillStyle = C.muted; g.font = "26px system-ui, sans-serif"; g.fillText(state, x + 8, PH - 70); }
    tex.needsUpdate = true;
  }
  function open(nd) {
    shown = nd; scroll = 0; state = "";
    draw();
    // (in front of you, at eye height, turned to face you)
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    panel.position.copy(head).addScaledVector(dir, 1.2 * SCALE).add(new THREE.Vector3(0, -0.15 * SCALE, 0));
    panel.lookAt(head.x, panel.position.y, head.z);
    panel.visible = true;
    api.select(nd);
  }
  function close() { panel.visible = false; shown = null; api.select(null); }
  async function press(act) {
    if (act === "close") return close();
    if (act === "up") { scroll -= 8; return draw(); }
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

  // ---------------------------------------------------------------- pointing and selecting
  function hit(c) {
    ray.setFromXRController(c);
    const targets = panel.visible ? [panel, ...api.pickables()] : api.pickables();
    return ray.intersectObjects(targets, false)[0] ?? null;
  }
  function onSelect(c) {
    const h = hit(c);
    if (!h) return;
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
    for (const c of controllers) {
      const h = c.userData.source ? hit(c) : null;
      c.userData.line.scale.z = h ? h.distance / SCALE : 30;
      const nd = h && h.object !== panel ? h.object.userData.node ?? null : null;
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
    }
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
  }
  function leave() {
    session = null; mode = null;
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
    press, open: (nd) => open(nd), rig,
  };
}
