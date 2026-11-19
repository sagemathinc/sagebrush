// The whitespace prototype: a board in 3D.  Loads a foo.space.json; objects keep the positions written in it
// (layout-cli.mjs lays a space out once), and only those without one are placed (layout.js).  What an object shows
// depends on how near it is (semantic zoom): far, a block in its group's color under the group's landmark label;
// nearer, its title; near, its face (title and first lines).  A click shows its sharp text in an overlay; the search
// panel finds any text and flies there; Back returns; 2D / 3D shows the same space on a plane, for comparison.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { marked } from "marked";
import { layout } from "./layout.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- the scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$("#view").appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);
scene.fog = new THREE.Fog(0x0e1116, 60, 400);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 60, 40);
scene.add(sun);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- objects
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 360) / 360; };
const groupColor = (nd) => new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.5, 0.45);
const SIZE = { file: [2.6, 1.6, 0.12], note: [5, 3.8, 0.45], code: [5, 3.8, 0.2], plot3d: [5, 5, 0.15] };
const sizeOf = (nd) => SIZE[nd.kind] ?? SIZE.file;

function canvasFor(nd, px) {
  const [w, h] = sizeOf(nd);
  const c = document.createElement("canvas");
  c.width = Math.round(w * px); c.height = Math.round(h * px);
  return c;
}
const bgOf = (nd) => nd.kind === "note" ? "#f4ecd8" : nd.kind === "code" ? "#1d2330" : nd.kind === "plot3d" ? "#20262f" : "#" + groupColor(nd).multiplyScalar(0.55).getHexString();
const fgOf = (nd) => nd.kind === "note" ? "#2b2a26" : "#e8eef7";
const shortTitle = (nd) => nd.kind === "file" ? nd.title.split("/").pop() : nd.title;
function texture(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function wrap(g, text, maxW) {
  const words = String(text).split(/\s+/), lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

// the middle distance: the title alone, large (readable from further than the face's small text)
function titleTexture(nd) {
  const c = canvasFor(nd, 64), g = c.getContext("2d");
  g.fillStyle = bgOf(nd); g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#" + groupColor(nd).getHexString(); g.fillRect(0, 0, c.width, Math.max(4, c.height * 0.05));
  g.fillStyle = fgOf(nd);
  let size = c.height * (nd.kind === "file" ? 0.26 : 0.17);
  g.font = `600 ${size}px system-ui, sans-serif`;
  const lines = wrap(g, shortTitle(nd), c.width * 0.9).slice(0, 3);
  const y0 = (c.height - lines.length * size * 1.2) / 2 + size;
  lines.forEach((l, i) => g.fillText(l, c.width * 0.05, y0 + i * size * 1.2, c.width * 0.9));
  return texture(c);
}

// near: the title and the first lines (still small: the overlay gives the sharp text)
function faceTexture(nd) {
  const c = canvasFor(nd, nd.kind === "file" ? 160 : 140), g = c.getContext("2d");
  g.fillStyle = bgOf(nd); g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#" + groupColor(nd).getHexString(); g.fillRect(0, 0, c.width, Math.max(6, c.height * 0.04));
  const pad = c.width * 0.05, fg = fgOf(nd);
  let y = pad + c.height * 0.06;
  g.fillStyle = fg;
  const titleSize = nd.kind === "file" ? c.height * 0.12 : c.height * 0.085;
  g.font = `600 ${titleSize}px system-ui, sans-serif`;
  g.fillText(shortTitle(nd), pad, y + titleSize * 0.8, c.width - 2 * pad);
  y += titleSize * 1.5;
  if (nd.kind === "file") {
    g.font = `${c.height * 0.07}px system-ui, sans-serif`;
    g.globalAlpha = 0.75;
    g.fillText(nd.title.includes("/") ? nd.title.slice(0, nd.title.lastIndexOf("/")) : "web", pad, y, c.width - 2 * pad);
    g.globalAlpha = 1;
    y += c.height * 0.1;
  }
  const mono = nd.kind !== "note";
  const fs = mono ? c.height * (nd.kind === "file" ? 0.05 : 0.04) : c.height * 0.045;
  for (const raw of String(nd.kind === "plot3d" ? "" : nd.text ?? "").split("\n")) {
    if (y > c.height - pad) break;
    let line = raw, size = fs, weight = "";
    if (!mono && /^#+\s/.test(raw)) { line = raw.replace(/^#+\s/, ""); size = fs * 1.3; weight = "600 "; }
    g.font = `${weight}${size}px ${mono ? "ui-monospace, Menlo, monospace" : "Georgia, serif"}`;
    g.fillStyle = fg;
    g.fillText(mono ? line : line.replace(/\*\*|`/g, ""), pad, y, c.width - 2 * pad);
    y += size * 1.35;
  }
  if (nd.kind === "code" && nd.output) {
    y = Math.min(y + fs * 0.6, c.height - pad - fs * 1.4);
    g.fillStyle = "#0b3d2a"; g.fillRect(pad * 0.6, y - fs, c.width - 1.2 * pad, fs * 1.7);
    g.fillStyle = "#9ff0c1"; g.font = `${fs}px ui-monospace, monospace`;
    g.fillText(nd.output.split("\n")[0], pad, y + fs * 0.4, c.width - 2 * pad);
  }
  return texture(c);
}

// a plot3d: its surface as a mesh, colored by height
function surfaceMesh(nd) {
  const S = nd.surface, nx = S.x.length, ny = S.y.length;
  let zmin = Infinity, zmax = -Infinity;
  for (const row of S.z) for (const v of row) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), c = new THREE.Color();
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, t = (S.z[j][i] - zmin) / (zmax - zmin || 1);
    pos[3 * k] = (i / (nx - 1) - 0.5) * 4.6; pos[3 * k + 1] = (j / (ny - 1) - 0.5) * 4.6; pos[3 * k + 2] = 0.2 + t * 2.4;
    c.setHSL(0.7 - 0.7 * t, 0.75, 0.5);
    col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; idx.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.05 }));
  mesh.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 })));
  return mesh;
}

let space = null, objects = [], pickables = [], edgeLines = null, positions = null, P3 = null, P2 = null, dims = 3;
let landmarks = [];

function makeObject(nd) {
  const [w, h, d] = sizeOf(nd);
  const group = new THREE.Group();
  // (the face starts plain: its textures are made only when the object is near enough to need them)
  const face = new THREE.MeshStandardMaterial({ color: groupColor(nd), roughness: 0.9 });
  const side = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.35, nd.kind === "note" ? 0.75 : 0.3), roughness: 0.8 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, side, side, face, side]);
  slab.userData.node = nd;
  group.add(slab);
  pickables.push(slab);
  if (nd.kind === "plot3d" && nd.surface) {
    const s = surfaceMesh(nd);
    s.position.z = d / 2;
    s.userData.node = nd;
    group.add(s);
    pickables.push(s);
  }
  group.userData = { node: nd, face, level: 0, tex: [] };
  return group;
}

// semantic zoom: 0 far (a block in its group's color), 1 its title, 2 its face; textures made lazily, a few a frame
const LEVEL_DIST = { file: [14, 45], note: [26, 90], code: [26, 90], plot3d: [26, 90] };
function stepZoom() {
  const cam = camera.position, pending = [];
  for (const o of objects) {
    const nd = o.userData.node, [nearD, midD] = LEVEL_DIST[nd.kind] ?? LEVEL_DIST.file;
    const d = cam.distanceTo(o.position);
    const want = d < nearD ? 2 : d < midD ? 1 : 0;
    if (want === o.userData.level) continue;
    if (want > 0 && !o.userData.tex[want]) pending.push([d, o, want]);
    else setLevel(o, want);
  }
  // (the textures still to make, the nearest first: what you are looking at sharpens first)
  pending.sort((a, b) => a[0] - b[0]);
  for (const [, o, want] of pending.slice(0, 6)) {
    o.userData.tex[want] = want === 2 ? faceTexture(o.userData.node) : titleTexture(o.userData.node);
    setLevel(o, want);
  }
}
function setLevel(o, want) {
  const f = o.userData.face;
  f.map = want ? o.userData.tex[want] : null;
  f.color.set(want ? 0xffffff : groupColor(o.userData.node));
  f.needsUpdate = true;
  o.userData.level = want;
}

// landmarks: a big label above each group (a directory, a topic), seen from afar and hidden from inside it
function landmarkSprite(text) {
  const c = document.createElement("canvas"), g = c.getContext("2d");
  const size = 64;
  g.font = `600 ${size}px system-ui, sans-serif`;
  c.width = Math.ceil(g.measureText(text).width + size); c.height = Math.ceil(size * 1.6);
  g.font = `600 ${size}px system-ui, sans-serif`;
  g.fillStyle = "rgba(14, 17, 22, 0.55)";
  g.beginPath(); g.roundRect(0, 0, c.width, c.height, size * 0.4); g.fill();
  g.fillStyle = "#f0f4fa"; g.textBaseline = "middle";
  g.fillText(text, size / 2, c.height / 2);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture(c), transparent: true, depthWrite: false, fog: false }));
  sprite.userData.aspect = c.width / c.height;
  sprite.renderOrder = 10;
  return sprite;
}
function buildLandmarks() {
  for (const l of landmarks) scene.remove(l.sprite);
  landmarks = [];
  // (a group's own label, and one for each top-level directory over all of its subdirectories: from afar the big
  // ones show, and the finer ones as you come closer, as the screen has room for them)
  const groups = new Map();
  const add = (g, i) => { if (!groups.has(g)) groups.set(g, new Set()); groups.get(g).add(i); };
  space.nodes.forEach((n, i) => {
    const g = n.group ?? "";
    add(g, i);
    const parts = g.split("/");
    if (parts.length > 2) add(parts.slice(0, 2).join("/"), i);
  });
  for (const [g, set] of groups) {
    const members = [...set];
    if (!g || members.length < 2) continue;
    const sprite = landmarkSprite(g.replace(/^web\//, "") + "  (" + members.length + ")");
    scene.add(sprite);
    landmarks.push({ g, members, sprite, center: new THREE.Vector3(), radius: 1 });
  }
  placeLandmarks();
}
function placeLandmarks() {
  for (const l of landmarks) {
    const c = new THREE.Vector3();
    for (const i of l.members) c.add(new THREE.Vector3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]));
    c.divideScalar(l.members.length);
    let r = 0;
    for (const i of l.members) r = Math.max(r, c.distanceTo(new THREE.Vector3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2])));
    l.center.copy(c); l.radius = Math.max(r, 3);
    l.sprite.position.copy(c).add(new THREE.Vector3(0, l.radius * 0.6 + 2, 0));
  }
}
function stepLandmarks() {
  // (each label: faded in as the camera leaves its cluster, sized to stay readable; then, the biggest groups first,
  // a label that would overlap one already placed on the screen is left out)
  const placed = [], v = new THREE.Vector3(), pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const order = [...landmarks].sort((a, b) => b.members.length - a.members.length);
  for (const l of order) {
    const d = camera.position.distanceTo(l.center);
    const a = THREE.MathUtils.clamp((d - l.radius * 1.2) / (l.radius * 1.5), 0, 1);
    const h = Math.max(1.6, d * 0.03) * Math.min(1.5, 0.8 + Math.sqrt(l.members.length) / 10);
    l.sprite.scale.set(h * l.sprite.userData.aspect, h, 1);
    let show = a > 0.02;
    if (show) {
      v.copy(l.sprite.position).project(camera);
      if (v.z > 1) show = false;
      else {
        const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight, dist = camera.position.distanceTo(l.sprite.position);
        const hh = h * pxPerUnit / dist, ww = hh * l.sprite.userData.aspect;
        const r = [x - ww / 2, y - hh / 2, x + ww / 2, y + hh / 2];
        if (placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) show = false;
        else placed.push(r);
      }
    }
    l.sprite.material.opacity = a;
    l.sprite.visible = show;
  }
}

function clear() {
  for (const o of objects) scene.remove(o);
  for (const l of landmarks) scene.remove(l.sprite);
  if (edgeLines) scene.remove(edgeLines);
  objects = []; pickables = []; edgeLines = null; landmarks = [];
}

function place(P) {
  positions = P;
  objects.forEach((o, i) => o.position.set(P[3 * i], P[3 * i + 1], P[3 * i + 2]));
  if (edgeLines) {
    const a = edgeLines.geometry.attributes.position;
    edgeLines.userData.pairs.forEach(([i, j], e) => {
      a.setXYZ(2 * e, P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      a.setXYZ(2 * e + 1, P[3 * j], P[3 * j + 1], P[3 * j + 2]);
    });
    a.needsUpdate = true;
    edgeLines.geometry.computeBoundingSphere();
  }
  if (landmarks.length) placeLandmarks();
}

// the positions written in the file (position, or position2d for the plane); the layout only for those without
function positionsOf(nodes, edges, d) {
  const key = d === 3 ? "position" : "position2d";
  const spacing = nodes.length > 60 ? 5 : 9;
  if (nodes.every((n) => Array.isArray(n[key]))) {
    const P = new Float64Array(nodes.length * 3);
    nodes.forEach((n, i) => { P[3 * i] = n[key][0]; P[3 * i + 1] = n[key][1]; P[3 * i + 2] = d === 3 ? n[key][2] ?? 0 : 0; });
    return { P, laid: false };
  }
  return { P: layout(nodes.map((n) => ({ ...n, position: n[key] })), edges, { dims: d, spacing }), laid: true };
}

async function load(name) {
  $("#status").textContent = "loading " + name + "…";
  const r = await fetch(name);
  space = await r.json();
  if (space.format !== "sagebrush-space") throw new Error(name + " is not a sagebrush-space");
  clear();
  const nodes = space.nodes, index = new Map(nodes.map((n, i) => [n.id, i]));
  objects = nodes.map(makeObject);
  objects.forEach((o) => scene.add(o));
  const pairs = [];
  for (const e of space.edges ?? []) {
    const i = index.get(e.from), j = index.get(e.to);
    if (i !== undefined && j !== undefined) pairs.push([i, j]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
  edgeLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x7f9cc0, transparent: true, opacity: 0.22 }));
  edgeLines.userData.pairs = pairs;
  scene.add(edgeLines);
  for (const n of nodes) (n._out = []), (n._in = []);
  for (const [i, j] of pairs) (nodes[i]._out.push(nodes[j]), nodes[j]._in.push(nodes[i]));
  const t0 = performance.now();
  const r3 = positionsOf(nodes, space.edges ?? [], 3);
  P3 = r3.P; P2 = null; dims = 3;
  $("#dims").textContent = "Flatten to 2D";
  place(P3);
  buildLandmarks();
  history.length = 0; future.length = 0; selected = null; navButtons();
  frame(P3);
  buildIndex();
  document.title = (space.title ?? name) + " · whitespace";
  $("#title").textContent = space.title ?? name;
  $("#status").textContent = `${nodes.length} objects, ${pairs.length} links · ${r3.laid ? "laid out in " + Math.round(performance.now() - t0) + " ms" : "at their saved places"}`;
  closeOverlay();
}

// the camera: everything in view
function frame(P, remember = false) {
  if (remember) pushView();
  // (the centre, and the distance within which most of the space is: a few outliers don't shrink the rest)
  const n = P.length / 3, c = new THREE.Vector3();
  for (let i = 0; i < n; i++) c.add(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2]));
  c.divideScalar(Math.max(n, 1));
  const ds = [];
  for (let i = 0; i < n; i++) ds.push(c.distanceTo(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2])));
  ds.sort((a, b) => a - b);
  const r = Math.max(ds[Math.floor(ds.length * 0.8)] ?? 6, 6);
  const to = c.clone().add(new THREE.Vector3(0.35, 0.25, 1).normalize().multiplyScalar(r * 2.2));
  camera.far = r * 20;
  scene.fog.near = r * 1.2; scene.fog.far = r * 6;
  camera.updateProjectionMatrix();
  flight = { from: camera.position.clone(), fromT: controls.target.clone(), to, toT: c, t0: performance.now(), ms: remember ? 900 : 1 };
}

// ---------------------------------------------------------------- flying, Back and Forward
// (a view: where the camera was, and which object was selected; a new flight clears Forward, as a browser's does)
let flight = null;
const history = [], future = [];
const viewNow = () => ({ pos: camera.position.clone(), target: controls.target.clone(), sel: selected });
function pushView() {
  history.push(viewNow());
  if (history.length > 100) history.shift();
  future.length = 0;
  navButtons();
}
function navButtons() {
  $("#back").disabled = !history.length;
  $("#fwd").disabled = !future.length;
}
function flyToView(to, toT, ms = 900) {
  flight = { from: camera.position.clone(), fromT: controls.target.clone(), to, toT, t0: performance.now(), ms };
}
function flyTo(i, dist, remember = true) {
  const nd = space.nodes[i];
  const p = new THREE.Vector3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
  const d = dist ?? (nd.kind === "file" ? 5 : 9);
  if (remember) pushView();
  // (seen from the front of its face: the slabs face +z)
  flyToView(p.clone().add(new THREE.Vector3(0, 0, d)), p);
}
function go(from, to) {
  const v = from.pop();
  if (!v) return;
  to.push(viewNow());
  navButtons();
  const i = v.sel === null ? -1 : space.nodes.findIndex((n) => n.id === v.sel);
  if (i >= 0) showOverlay(space.nodes[i]); else closeOverlay();
  flyToView(v.pos, v.target);
}
const back = () => go(history, future);
const forward = () => go(future, history);
function stepFlight(now) {
  if (!flight) return;
  const u = Math.min(1, (now - flight.t0) / flight.ms), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  // (an arc: up and over, so a long flight passes above the space instead of through it)
  const lift = Math.sin(Math.PI * u) * flight.from.distanceTo(flight.to) * 0.25;
  camera.position.lerpVectors(flight.from, flight.to, e).add(new THREE.Vector3(0, lift, 0));
  controls.target.lerpVectors(flight.fromT, flight.toT, e);
  if (u >= 1) flight = null;
}
$("#back").onclick = back;
$("#fwd").onclick = forward;
$("#home").onclick = () => space && frame(positions, true);

// 2D / 3D: the same space on a plane (its saved position2d, else laid out), animated
let morph = null;
$("#dims").onclick = () => {
  if (!space) return;
  if (!P2) P2 = positionsOf(space.nodes, space.edges ?? [], 2).P;
  const target = dims === 3 ? P2 : P3;
  dims = dims === 3 ? 2 : 3;
  $("#dims").textContent = dims === 3 ? "Flatten to 2D" : "Back to 3D";
  morph = { from: Float64Array.from(positions), to: target, t0: performance.now(), ms: 1200 };
};
function stepMorph(now) {
  if (!morph) return;
  const u = Math.min(1, (now - morph.t0) / morph.ms), e = u * u * (3 - 2 * u);
  const P = new Float64Array(morph.from.length);
  for (let i = 0; i < P.length; i++) P[i] = morph.from[i] + (morph.to[i] - morph.from[i]) * e;
  place(P);
  if (u >= 1) { place(morph.to); frame(morph.to, true); morph = null; }
}

// ---------------------------------------------------------------- picking: hover, click for the sharp text
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let hovered = null, down = null;
function pick(ev) {
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(pickables, false)[0];
  return hit ? hit.object.userData.node : null;
}
renderer.domElement.addEventListener("pointermove", (ev) => {
  const nd = pick(ev);
  if (nd !== hovered) {
    if (hovered) setGlow(hovered, 0);
    hovered = nd;
    if (hovered) setGlow(hovered, 0.25);
    renderer.domElement.style.cursor = nd ? "pointer" : "";
    $("#hover").textContent = nd ? nd.title : "";
  }
});
renderer.domElement.addEventListener("pointerdown", (ev) => (down = [ev.clientX, ev.clientY]));
renderer.domElement.addEventListener("pointerup", (ev) => {
  // (a click, not the end of a drag)
  if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4) return;
  const nd = pick(ev);
  if (nd) openOverlay(nd); else closeOverlay();
});
function setGlow(nd, v) {
  const o = objects[space.nodes.indexOf(nd)];
  // (the selected object keeps its own glow)
  if (nd.id === selected && v < 0.4) v = 0.4;
  o?.traverse((m) => { for (const mat of [].concat(m.material ?? [])) if (mat.emissive) mat.emissive.setScalar(v); });
}

// ---------------------------------------------------------------- selection: what the person is looking at, for agents
// (the selected object's id is in the address (#sel=ID), in window.whitespace.selection, in a "whitespace:select"
// event, and, when the space is shown in a frame (an agents chat's), in a message to the page around it)
let selected = null;
function setSelected(id) {
  if (id === selected) return;
  const old = selected;
  selected = id;
  for (const x of [old, id]) {
    const nd = x === null ? null : space.nodes.find((n) => n.id === x);
    if (nd) setGlow(nd, x === id ? 0.4 : 0);
  }
  window.history.replaceState(null, "", location.pathname + location.search + (id === null ? "" : "#sel=" + encodeURIComponent(id)));
  const detail = selectionOf(id);
  dispatchEvent(new CustomEvent("whitespace:select", { detail }));
  if (window.parent !== window) window.parent.postMessage({ sagebrush: "space-select", version: 1, selection: detail }, "*");
}
function selectionOf(id) {
  const nd = id === null ? null : space?.nodes.find((n) => n.id === id);
  return nd ? { id: nd.id, kind: nd.kind, title: nd.title, group: nd.group ?? null, space: $("#space").value } : null;
}

function openOverlay(nd) {
  // (the view left behind is remembered before the selection changes: Back returns to it, and to what it had open)
  pushView();
  showOverlay(nd);
  flyTo(space.nodes.indexOf(nd), undefined, false);
}
function showOverlay(nd) {
  let body = "";
  if (nd.kind === "note") body = `<div class="md">${marked.parse(nd.text ?? "")}</div>`;
  else if (nd.kind === "code") body = `<pre class="code">${esc(nd.text)}</pre>` + (nd.output ? `<div class="label">Output</div><pre class="out">${esc(nd.output)}</pre>` : "");
  else if (nd.kind === "plot3d") body = (nd.text ? `<pre class="code">${esc(nd.text)}</pre>` : "") + `<p class="hint">The surface is a real 3D object: drag to turn around it.</p>`;
  else body = `<div class="meta">${esc(nd.lang ?? "")}${nd.lines ? " · " + nd.lines + " lines" : ""}</div><pre class="code">${esc(nd.text)}</pre>${nd.lines > 60 ? '<div class="hint">(its first 60 lines)</div>' : ""}`;
  const links = (label, list) => list.length ? `<div class="label">${label} (${list.length})</div><ul class="links">${list.map((m) => `<li><a href="#" data-i="${space.nodes.indexOf(m)}">${esc(m.title)}</a></li>`).join("")}</ul>` : "";
  $("#overlay").innerHTML = `<button class="close" title="Close (Esc)">×</button><h2>${esc(nd.title)}</h2>${body}${links(nd.kind === "file" ? "Imports" : "Links to", nd._out)}${links(nd.kind === "file" ? "Imported by" : "Linked from", nd._in)}`;
  $("#overlay").hidden = false;
  $("#overlay").scrollTop = 0;
  viewOffset();
  $("#overlay .close").onclick = closeOverlay;
  for (const a of $("#overlay").querySelectorAll("a[data-i]")) a.onclick = (e) => { e.preventDefault(); openOverlay(space.nodes[+a.dataset.i]); };
  setSelected(nd.id);
}
function closeOverlay() { $("#overlay").hidden = true; viewOffset(); if (space) setSelected(null); }
// (while the overlay covers the right of the screen, the view is shifted so what it is about stays in the free part)
function viewOffset() {
  const w = $("#overlay").hidden ? 0 : $("#overlay").getBoundingClientRect().width + 12;
  if (w) camera.setViewOffset(innerWidth, innerHeight, w / 2, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener("resize", viewOffset);
addEventListener("keydown", (e) => {
  if (document.activeElement === $("#q")) { if (e.key === "Escape") $("#q").blur(); return; }
  if (e.key === "Escape") closeOverlay();
  else if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
  else if (e.key === "b" || e.key === "B" || e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) back();
  else if (e.key === "f" || e.key === "F" || (e.altKey && e.key === "ArrowRight")) forward();
  else if (e.key === "h" || e.key === "H") space && frame(positions, true);
});

// ---------------------------------------------------------------- search: full text, click to fly there
let docs = [];
function buildIndex() {
  docs = space.nodes.map((n, i) => ({ i, title: (n.title ?? "").toLowerCase(), all: [n.title, n.text, n.output, n.group].join("\n").toLowerCase() }));
  search();
}
function search() {
  const q = $("#q").value.trim().toLowerCase();
  const ul = $("#results");
  if (!q || !space) { ul.innerHTML = ""; return; }
  const words = q.split(/\s+/);
  const hits = docs.filter((d) => words.every((w) => d.all.includes(w)))
    .map((d) => ({ ...d, score: words.reduce((s, w) => s + (d.title.includes(w) ? 10 : 0) + (d.all.split(w).length - 1), 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 60);
  ul.innerHTML = hits.map((h) => {
    const nd = space.nodes[h.i], text = String(nd.text ?? "");
    const k = text.toLowerCase().indexOf(words[0]);
    const snip = k >= 0 ? text.slice(Math.max(0, k - 30), k + 60).replace(/\s+/g, " ") : "";
    return `<li data-i="${h.i}"><b>${esc(nd.title)}</b><span>${esc(snip)}</span></li>`;
  }).join("") || "<li class='none'>nothing found</li>";
  for (const li of ul.querySelectorAll("li[data-i]")) li.onclick = () => openOverlay(space.nodes[+li.dataset.i]);
}
$("#q").addEventListener("input", search);

// ---------------------------------------------------------------- which space
async function start() {
  const list = await (await fetch("spaces.json")).json().catch(() => []);
  const want = new URLSearchParams(location.search).get("space") ?? (list.includes("demo.space.json") ? "demo.space.json" : list[0]);
  const sel = $("#space");
  sel.innerHTML = list.map((f) => `<option${f === want ? " selected" : ""}>${esc(f)}</option>`).join("");
  sel.onchange = () => { window.history.replaceState(null, "", "?space=" + encodeURIComponent(sel.value)); load(sel.value).catch(fail); };
  // (#sel=ID: that object selected, as an agent or a link left it)
  const wantSel = /#sel=([^&]+)/.exec(location.hash)?.[1];
  await load(want);
  if (wantSel) setTimeout(() => window.whitespace.select(decodeURIComponent(wantSel)), 300);
}
function fail(e) { $("#status").textContent = "couldn't load: " + (e?.message ?? e); }
start().catch(fail);

function tick(now) {
  stepFlight(now);
  stepMorph(now);
  controls.update();
  if (space) { stepZoom(); stepLandmarks(); }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
// (for tests and the curious: the loaded space and the camera)
// (the API for an agent driving the page, and for tests: what is selected, select an object (and fly to it), the
// space, Back and Forward)
window.whitespace = {
  get space() { return space; }, get objects() { return objects; }, camera, controls,
  get selection() { return selectionOf(selected); },
  select(id) { const nd = space?.nodes.find((n) => n.id === id); if (!nd) return false; openOverlay(nd); return true; },
  back, forward, frame: () => frame(positions, true), flyTo,
};
