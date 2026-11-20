// The whitespace prototype: a board in 3D.  Loads a foo.space.json; objects keep the positions written in it
// (layout-cli.mjs lays a space out once), and only those without one are placed (layout.js).  What an object shows
// depends on how near it is (semantic zoom): far, a block in its group's color under the group's landmark label;
// nearer, its title; near, its face (title and first lines).  A click shows its sharp text in an overlay; the search
// panel finds any text and flies there; Back returns; 2D / 3D shows the same space on a plane, for comparison.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
// (notes: the site's own Markdown, web/markdown.ts: raw HTML limited to formatting, no pictures from other sites, and
//  math marked for KaTeX; a space is the agent's or anyone's text, shown on the site's origin)
import { render as markdown } from "../../web/markdown.ts";
import { layout } from "./layout.js";
import { texToText } from "./tex.js";
import { setupXR } from "./xr.js";
import { highlight, editor } from "./code.js";
import { run, interrupt, sceneObject, SCENE } from "./run.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- the scene
// (alpha: in AR the room shows where the space has no background)
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$("#view").appendChild(renderer.domElement);
const scene = new THREE.Scene();
// the theme: light (a white space), or dark; Auto follows the system (prefers-color-scheme)
const THEMES = {
  light: { bg: 0xf5f6f8, edge: 0x51657f, edgeOpacity: 0.3, label: "rgba(255, 255, 255, 0.85)", labelFg: "#1f2328", code: "#f6f8fa", plot: "#eef1f5",
    fg: "#1f2328", fileL: 0.86, sideL: 0.72, out: "#dff3e6", outFg: "#116329", glow: [0.05, 0.16, 0.45] },
  dark: { bg: 0x0e1116, edge: 0x7f9cc0, edgeOpacity: 0.22, label: "rgba(14, 17, 22, 0.55)", labelFg: "#f0f4fa", code: "#1d2330", plot: "#20262f",
    fg: "#e8eef7", fileL: 0.25, sideL: 0.3, out: "#0b3d2a", outFg: "#9ff0c1", glow: [0.55, 0.6, 0.7] },
};
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
let themeSetting = (() => { try { const v = localStorage.getItem("whitespace:theme"); return ["light", "dark"].includes(v) ? v : "auto"; } catch { return "auto"; } })();
const themeName = () => (themeSetting === "auto" ? (darkQuery.matches ? "dark" : "light") : themeSetting);
let T = THEMES[themeName()];
document.documentElement.dataset.theme = themeName();
scene.background = new THREE.Color(T.bg);
scene.fog = new THREE.Fog(T.bg, 60, 400);
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
const bgOf = (nd) => nd.kind === "note" ? "#f4ecd8" : nd.kind === "code" ? T.code : nd.kind === "plot3d" ? T.plot : "#" + new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.45, T.fileL).getHexString();
const fgOf = (nd) => nd.kind === "note" ? "#2b2a26" : T.fg;
const sideColor = (nd) => new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.35, nd.kind === "note" ? 0.75 : T.sideL);
// (a title as drawn on a face: its math as text, texToText; the drawer typesets it)
const shortTitle = (nd) => (nd.kind === "file" ? nd.title.split("/").pop() : texToText(nd.title));
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
  for (const raw of String(nd.kind === "plot3d" ? "" : nd.kind === "note" ? texToText(nd.text).replace(/\n\s*\n(\s*\n)+/g, "\n\n") : nd.text ?? "").split("\n")) {
    if (y > c.height - pad) break;
    let line = raw, size = fs, weight = "";
    if (!mono && /^#+\s/.test(raw)) { line = raw.replace(/^#+\s/, ""); size = fs * 1.3; weight = "600 "; }
    g.font = `${weight}${size}px ${mono ? "ui-monospace, Menlo, monospace" : "Georgia, serif"}`;
    g.fillStyle = fg;
    // (a note's paragraph wrapped to the face, never squeezed; code keeps its lines)
    const parts = mono ? [line] : wrap(g, line.replace(/\*\*|`/g, ""), c.width - 2 * pad);
    for (const part of parts.length ? parts : [""]) {
      if (y > c.height - pad) break;
      g.fillText(part, pad, y, c.width - 2 * pad);
      y += size * 1.35;
    }
  }
  if (nd.svg) {
    // (a figure the code made: drawn in the lower part once its image has loaded)
    const img = new Image(), top = Math.min(y + fs, c.height * 0.45), tex = { ref: null };
    img.onload = () => {
      const h = c.height - top - pad, w = Math.min(c.width - 2 * pad, h * img.width / img.height);
      g.fillStyle = "#ffffff"; g.fillRect(pad, top, w, h);
      g.drawImage(img, pad, top, w, h);
      if (tex.ref) tex.ref.needsUpdate = true;
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(nd.svg)));
    const t = texture(c);
    tex.ref = t;
    return t;
  }
  if (nd.kind === "code" && nd.output) {
    y = Math.min(y + fs * 0.6, c.height - pad - fs * 1.4);
    g.fillStyle = T.out; g.fillRect(pad * 0.6, y - fs, c.width - 1.2 * pad, fs * 1.7);
    g.fillStyle = T.outFg; g.font = `${fs}px ui-monospace, monospace`;
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
  const side = new THREE.MeshStandardMaterial({ color: sideColor(nd), roughness: 0.8 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, side, side, face, side]);
  slab.userData.node = nd;
  group.add(slab);
  pickables.push(slab);
  group.userData = { node: nd, face, side, level: 0, tex: [], plot: null };
  if (nd.scene) setPlot(group, sceneObject(nd.scene));
  else if (nd.kind === "plot3d" && nd.surface) setPlot(group, surfaceMesh(nd));
  return group;
}
// an object's 3D content (a surface, or a scene a run made), standing on the front of its slab
function setPlot(group, obj) {
  const nd = group.userData.node, [, , d] = sizeOf(nd);
  if (group.userData.plot) {
    group.remove(group.userData.plot);
    group.userData.plot.traverse((m) => { const k = pickables.indexOf(m); if (k >= 0) pickables.splice(k, 1); });
  }
  obj.position.z = d / 2;
  obj.traverse((m) => { if (m.isMesh) { m.userData.node = nd; pickables.push(m); } });
  group.add(obj);
  group.userData.plot = obj;
}

// semantic zoom: 0 far (a block in its group's color), 1 its title, 2 its face; textures made lazily, a few a frame
const LEVEL_DIST = { file: [14, 45], note: [26, 90], code: [26, 90], plot3d: [26, 90] };
// (where you see from: the camera's place in the world, which in a headset is your head's)
const eyeV = new THREE.Vector3();
const eye = () => camera.getWorldPosition(eyeV);
function stepZoom() {
  const cam = eye().clone(), pending = [];
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
  g.fillStyle = T.label;
  g.beginPath(); g.roundRect(0, 0, c.width, c.height, size * 0.4); g.fill();
  g.fillStyle = T.labelFg; g.textBaseline = "middle";
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
    const d = eye().distanceTo(l.center);
    const a = THREE.MathUtils.clamp((d - l.radius * 1.2) / (l.radius * 1.5), 0, 1);
    // (smaller in a headset, where you're among them rather than looking at a screen)
    const h = Math.max(1.6, d * 0.03) * Math.min(1.5, 0.8 + Math.sqrt(l.members.length) / 10) * (renderer.xr.isPresenting ? 0.45 : 1);
    l.sprite.scale.set(h * l.sprite.userData.aspect, h, 1);
    let show = a > 0.02;
    if (show) {
      v.copy(l.sprite.position).project(camera);
      if (v.z > 1) show = false;
      else {
        const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight, dist = eye().distanceTo(l.sprite.position);
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

// (`data`: the space itself, as the page around an embedded one sends it; `again`: the same space written again (by
//  an agent), so the camera, the selection and Back stay as they are)
async function load(name, data = null, again = false) {
  $("#status").textContent = "loading " + name + "…";
  const next = data ?? (await (await fetch(name)).json());
  if (next?.format !== "sagebrush-space" || !Array.isArray(next.nodes)) throw new Error(name + " is not a sagebrush-space");
  const view = again && space ? { pos: camera.position.clone(), target: controls.target.clone(), sel: selected } : null;
  space = next;
  clear();
  const nodes = space.nodes, index = new Map(nodes.map((n, i) => [n.id, i]));
  restore(nodes);
  objects = nodes.map(makeObject);
  objects.forEach((o) => scene.add(o));
  const pairs = [];
  for (const e of space.edges ?? []) {
    const i = index.get(e.from), j = index.get(e.to);
    if (i !== undefined && j !== undefined) pairs.push([i, j]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
  edgeLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: T.edge, transparent: true, opacity: T.edgeOpacity }));
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
  selected = null;
  if (view) {
    frame(P3);
    flight = null;
    camera.position.copy(view.pos);
    controls.target.copy(view.target);
    const nd = view.sel === null ? null : nodes.find((n) => n.id === view.sel);
    if (nd) { selected = nd.id; setGlow(nd, 0.4); }
  } else {
    history.length = 0; future.length = 0;
    frame(P3);
  }
  navButtons();
  buildIndex();
  document.title = (space.title ?? name) + " · whitespace";
  $("#title").textContent = space.title ?? name;
  $("#status").textContent = `${nodes.length} objects, ${pairs.length} links · ${r3.laid ? "laid out in " + Math.round(performance.now() - t0) + " ms" : "at their saved places"}`;
  if (!view || selected === null) closeOverlay();
  else if (!$("#overlay").hidden) showOverlay(nodes.find((n) => n.id === selected));
}

// the camera: everything in view
// (the view of everything: the centre, and a place to see most of the space from; a few outliers don't shrink the rest)
function homeView(P) {
  const n = P.length / 3, c = new THREE.Vector3();
  for (let i = 0; i < n; i++) c.add(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2]));
  c.divideScalar(Math.max(n, 1));
  const ds = [];
  for (let i = 0; i < n; i++) ds.push(c.distanceTo(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2])));
  ds.sort((a, b) => a - b);
  const r = Math.max(ds[Math.floor(ds.length * 0.8)] ?? 6, 6);
  return { to: c.clone().add(new THREE.Vector3(0.35, 0.25, 1).normalize().multiplyScalar(r * 2.2)), toT: c, r };
}
function frame(P, remember = false) {
  if (remember) pushView();
  const { to, toT: c, r } = homeView(P);
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
// (where to see object i from: in front of its face (the slabs face +z), or a plot from in front and below its middle,
//  far enough to have it whole)
function viewOf(i, dist) {
  const nd = space.nodes[i];
  const p = new THREE.Vector3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
  const d = dist ?? (nd.kind === "file" ? 5 : 9);
  if (nd.kind === "plot3d" || nd.scene) {
    const t = p.clone().add(new THREE.Vector3(0, 0, 1.4));
    return { to: t.clone().add(new THREE.Vector3(0, -8.5, 7.5)), toT: t };
  }
  return { to: p.clone().add(new THREE.Vector3(0, 0, d)), toT: p };
}
function flyTo(i, dist, remember = true) {
  if (remember) pushView();
  const { to, toT } = viewOf(i, dist);
  flyToView(to, toT);
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
  // (clamped below too: a frame's time can be a little before the flight's start, which flung the camera far out for
  //  that frame)
  const u = Math.max(0, Math.min(1, (now - flight.t0) / flight.ms)), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
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
  const u = Math.max(0, Math.min(1, (now - morph.t0) / morph.ms)), e = u * u * (3 - 2 * u);
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
  // (a white glow on a dark space; on a light one, a faint blue, which keeps the face's text readable)
  const glow = T.glow;
  o?.traverse((m) => { for (const mat of [].concat(m.material ?? [])) if (mat.emissive) mat.emissive.setRGB(glow[0] * v, glow[1] * v, glow[2] * v); });
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
  if (window.parent !== window) window.parent.postMessage({ sagebrush: "space-select", version: 1, selection: detail }, embedded ? location.origin : "*");
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
const RUNS = ["python", "sage", "matlab", "magma"];
const runnable = (nd) => nd.kind === "code" || nd.kind === "plot3d";
function showOverlay(nd) {
  let body = "";
  if (nd.kind === "note") body = `<div class="md">${markdown(String(nd.text ?? ""), { remote: false })}</div>`;
  else if (runnable(nd)) {
    const mode = RUNS.includes(nd.lang) ? nd.lang : nd.kind === "plot3d" ? "sage" : "python";
    body = `<div class="runbar"><select class="mode" title="The language">${RUNS.map((m) => `<option${m === mode ? " selected" : ""}>${m}</option>`).join("")}</select>` +
      `<button class="run" title="Run (Shift+Enter)">▶ Run</button><button class="stop" title="Stop" hidden>■ Stop</button><span class="runstate"></span></div>` +
      `<div class="code-edit"></div><div class="label">Output</div><div class="output">${outputHtml(nd)}</div>` +
      (nd.kind === "plot3d" || nd.scene ? `<p class="hint">A 3D plot is a real object in the space: drag to turn around it. Edit its code and run it to change it.</p>` : "");
  } else body = `<div class="meta">${esc(nd.lang ?? "")}${Number(nd.lines) > 0 ? " · " + Number(nd.lines) + " lines" : ""}</div><pre class="code hljs"><code>${highlight(String(nd.text ?? ""), nd.lang ?? "")}</code></pre>${Number(nd.lines) > 60 ? '<div class="hint">(its first 60 lines)</div>' : ""}`;
  const links = (label, list) => list.length ? `<div class="label">${label} (${list.length})</div><ul class="links">${list.map((m) => `<li><a href="#" data-i="${space.nodes.indexOf(m)}">${esc(m.title)}</a></li>`).join("")}</ul>` : "";
  $("#overlay").innerHTML = `<div class="grip" title="Drag to resize"></div><button class="close" title="Close (Esc)">×</button><h2>${esc(nd.title)}</h2>${body}${links(nd.kind === "file" ? "Imports" : "Links to", nd._out)}${links(nd.kind === "file" ? "Imported by" : "Linked from", nd._in)}`;
  grip($("#overlay .grip"));
  if (runnable(nd)) mountRunner(nd);
  typeset($("#overlay"));
  $("#overlay").hidden = false;
  document.body.classList.add("reading");
  $("#overlay").scrollTop = 0;
  viewOffset();
  $("#overlay .close").onclick = closeOverlay;
  for (const a of $("#overlay").querySelectorAll("a[data-i]")) a.onclick = (e) => { e.preventDefault(); openOverlay(space.nodes[+a.dataset.i]); };
  setSelected(nd.id);
  if (runningNode === nd) runState(nd, "running…", true);
}
// (math: KaTeX, the site's /sagebrush-math.js, loaded the first time a note has some)
let mathModule = null;
function typeset(el) {
  if (!el.querySelector(".math[data-tex]")) return;
  const url = "/sagebrush-math.js";
  mathModule ??= import(url);
  mathModule.then((m) => m.typeset(el)).catch(() => {});
}
const isBase64 = (s) => typeof s === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
function closeOverlay() { $("#overlay").hidden = true; document.body.classList.remove("reading"); viewOffset(); if (space) setSelected(null); }
// (while the overlay covers the right of the screen, the view is shifted so what it is about stays in the free part)
function viewOffset() {
  const w = $("#overlay").hidden ? 0 : $("#overlay").getBoundingClientRect().width + 12;
  if (w) camera.setViewOffset(innerWidth, innerHeight, w / 2, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener("resize", viewOffset);

// ---------------------------------------------------------------- running code: edit, Run, and the space follows
// (an object's output: its text, its figure (SVG), and, for a 3D plot, a note that the object in the space is it)
function outputHtml(nd) {
  let h = "";
  if (nd.output) h += `<pre class="out${nd.outputError ? " err" : ""}">${esc(nd.output)}</pre>`;
  if (nd.svg) h += `<img class="fig" alt="the figure" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(nd.svg)))}">`;
  if (isBase64(nd.png)) h += `<img class="fig" alt="the figure" src="data:image/png;base64,${nd.png}">`;
  if (nd.scene) h += `<p class="hint">Its 3D plot is the object in the space.</p>`;
  return h || `<p class="hint">Not run yet.</p>`;
}
function mountRunner(nd) {
  const box = $("#overlay"), out = box.querySelector(".output"), state = box.querySelector(".runstate");
  const mode = box.querySelector(".mode"), runB = box.querySelector(".run"), stopB = box.querySelector(".stop");
  const ed = editor(box.querySelector(".code-edit"), {
    value: nd.text ?? "", lang: mode.value,
    onRun: () => go(),
    onChange: (v) => { nd.text = v; save(nd); },
  });
  mode.onchange = () => { nd.lang = mode.value; ed.lang = mode.value; save(nd); };
  async function go() {
    nd.text = ed.value; nd.lang = mode.value;
    await runNode(nd);
  }
  runB.onclick = go;
  stopB.onclick = () => interrupt();
}
// Running an object's code: its output, figure and 3D plot kept on it, its face drawn again, and the overlay (when it
// shows this object) following along. The overlay's Run and Run all both come here.
let runningNode = null;
const shownRunner = (nd) => (!$("#overlay").hidden && selected === nd.id && $("#overlay .runbar") ? $("#overlay") : null);
function runState(nd, text, busy) {
  const box = shownRunner(nd);
  if (!box) return;
  box.querySelector(".runstate").textContent = text;
  box.querySelector(".run").disabled = busy;
  box.querySelector(".stop").hidden = !busy;
}
async function runNode(nd) {
  const mode = RUNS.includes(nd.lang) ? nd.lang : nd.kind === "plot3d" ? "sage" : "python";
  const t0 = performance.now();
  runningNode = nd;
  runState(nd, "starting the engine…", true);
  try {
    const r = await run(String(nd.text ?? ""), mode, {
      start: () => runState(nd, "running…", true),
      update: (r) => { const box = shownRunner(nd); if (box) box.querySelector(".output").innerHTML = liveHtml(r); },
    });
    nd.output = r.out.replace(/\s+$/, "") + (r.stopped ? (r.out ? "\n" : "") + r.stopped : "");
    nd.outputError = r.error;
    const last = (mime) => [...r.displays].reverse().find((b) => b[mime])?.[mime];
    nd.svg = last("image/svg+xml") ?? null;
    nd.png = last("image/png") ?? null;
    const scene = last(SCENE);
    // (a 3D plot: the object in the space becomes it; its SVG is only the still picture)
    if (scene) { nd.scene = JSON.parse(scene); nd.svg = null; }
    const o = objects[space.nodes.indexOf(nd)];
    if (o) {
      if (scene) setPlot(o, sceneObject(nd.scene));
      // (its face drawn again, with the new output)
      o.userData.tex = []; o.userData.level = -1;
    }
    const box = shownRunner(nd);
    if (box) box.querySelector(".output").innerHTML = outputHtml(nd);
    runState(nd, (r.error ? "failed" : "done") + ` in ${Math.round(performance.now() - t0)} ms`, false);
    save(nd);
    return { ok: !r.error && !r.stopped, stopped: !!r.stopped };
  } catch (e) {
    const box = shownRunner(nd);
    if (box) box.querySelector(".output").innerHTML = `<pre class="out err">${esc("couldn't start Sagebrush's engine: " + (e?.message ?? e))}</pre>`;
    runState(nd, "", false);
    return { ok: false, stopped: false, failed: true };
  } finally {
    runningNode = null;
  }
}

// Run all: every object with code, in the space's order, one after another (one engine, as a notebook's cells);
// the button stops it
let runAll = null;
$("#runall").onclick = async () => {
  if (runAll) { runAll.stop = true; interrupt(); return; }
  if (!space) return;
  const todo = space.nodes.filter(runnable);
  if (!todo.length) { $("#status").textContent = "nothing here has code to run"; return; }
  runAll = { stop: false };
  const btn = $("#runall");
  let done = 0, failed = 0;
  for (const [i, nd] of todo.entries()) {
    if (runAll.stop) break;
    btn.textContent = `Stop (${i + 1} of ${todo.length})`;
    $("#status").textContent = `running ${i + 1} of ${todo.length}: ${nd.title}`;
    const r = await runNode(nd);
    // (the one Stop interrupted is stopped, not failed)
    if (runAll.stop) break;
    if (r.failed) { failed++; break; }
    if (r.ok) done++; else if (!r.stopped) failed++;
  }
  const stopped = runAll.stop;
  runAll = null;
  btn.textContent = "Run all";
  $("#status").textContent = (stopped ? `stopped after ${done + failed} of ${todo.length}` : `ran ${done + failed} of ${todo.length}`) + (failed ? `, ${failed} failed` : "");
};

function liveHtml(r) {
  let h = r.out ? `<pre class="out${r.error ? " err" : ""}">${esc(r.out)}</pre>` : "";
  for (const b of r.displays) {
    if (b["image/svg+xml"] && !b[SCENE]) h += `<img class="fig" alt="the figure" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(b["image/svg+xml"])))}">`;
    else if (isBase64(b["image/png"])) h += `<img class="fig" alt="the figure" src="data:image/png;base64,${b["image/png"]}">`;
    else if (b[SCENE]) h += `<p class="hint">A 3D plot: it appears in the space.</p>`;
  }
  return h || `<p class="hint">running…</p>`;
}

// what was edited and run here, kept in this browser per space and object (an agent edits the file itself). Each copy
// names the file's text it was made from (`base`): once the file says something else (the agent wrote it again),
// the file wins and the copy is dropped. The code itself is kept only if it was really edited here.
const KEEP = ["lang", "output", "outputError", "svg", "png", "scene"];
const keyOf = (nd) => `whitespace:${$("#space").value}:${nd.id}`;
const fileText = (nd) => (nd._file ? nd._file.text : String(nd.text ?? ""));
function save(nd) {
  const edited = String(nd.text ?? "") !== fileText(nd);
  const v = { base: fileText(nd), text: edited ? nd.text : null, ...Object.fromEntries(KEEP.map((k) => [k, nd[k] ?? null])) };
  try { localStorage.setItem(keyOf(nd), JSON.stringify(v)); } catch {}
}
function restore(nodes) {
  for (const nd of nodes) {
    nd._file = { text: String(nd.text ?? "") };
    try {
      const key = keyOf(nd), v = JSON.parse(localStorage.getItem(key) ?? "null");
      if (!v) continue;
      // (a copy from before `base` was kept: its text stands in for it, so an old copy of other code is dropped too)
      if ((v.base ?? v.text) !== nd._file.text) { localStorage.removeItem(key); continue; }
      if (typeof v.text === "string" && v.text !== nd._file.text) nd.text = v.text;
      for (const k of KEEP) if (v[k] !== null && v[k] !== undefined) nd[k] = v[k];
    } catch {}
  }
}

// the overlay's width: drag its left edge (kept for the next visit)
function grip(el) {
  el.onpointerdown = (e) => {
    e.preventDefault();
    const move = (ev) => {
      const w = Math.min(innerWidth - 80, Math.max(320, innerWidth - ev.clientX - 12));
      $("#overlay").style.width = w + "px";
      viewOffset();
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); try { localStorage.setItem("whitespace:overlay-width", $("#overlay").style.width); } catch {} };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
}
try { const w = localStorage.getItem("whitespace:overlay-width"); if (w) $("#overlay").style.width = w; } catch {}

// the theme: Auto, Light, Dark (kept for the next visit); a change redraws the faces and labels in its colors
function applyTheme() {
  const name = themeName();
  T = THEMES[name];
  document.documentElement.dataset.theme = name;
  $("#theme").textContent = "Theme: " + themeSetting[0].toUpperCase() + themeSetting.slice(1);
  scene.background.set(T.bg);
  scene.fog.color.set(T.bg);
  if (edgeLines) { edgeLines.material.color.set(T.edge); edgeLines.material.opacity = T.edgeOpacity; }
  for (const o of objects) {
    for (const t of o.userData.tex) t?.dispose();
    o.userData.tex = [];
    o.userData.level = -1; // (made again, in these colors, as the zoom asks for them)
    o.userData.side.color.copy(sideColor(o.userData.node));
  }
  if (space) for (const nd of space.nodes) setGlow(nd, 0);
  if (space) buildLandmarks();
}
$("#theme").onclick = () => {
  // (Auto, then the other theme than the system's, then the system's own, then Auto again: the first click changes it)
  const other = darkQuery.matches ? "light" : "dark", own = darkQuery.matches ? "dark" : "light";
  themeSetting = themeSetting === "auto" ? other : themeSetting === other ? own : "auto";
  try { localStorage.setItem("whitespace:theme", themeSetting); } catch {}
  applyTheme();
};
darkQuery.addEventListener("change", () => themeSetting === "auto" && applyTheme());
applyTheme();

// full screen
$("#fs").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
document.addEventListener("fullscreenchange", () => { $("#fs").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; });
// flying with the keyboard: W/S or Up/Down forward and back, A/D or Left/Right sideways, E/Q up and down (Shift:
// faster), while held; the camera and what it looks at move together, so the view keeps its direction
const held = new Set();
const FLY = { w: [0, 0, 1], arrowup: [0, 0, 1], s: [0, 0, -1], arrowdown: [0, 0, -1], a: [-1, 0, 0], arrowleft: [-1, 0, 0],
  d: [1, 0, 0], arrowright: [1, 0, 0], e: [0, 1, 0], q: [0, -1, 0] };
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));
addEventListener("blur", () => held.clear());
let lastFly = performance.now();
function stepFly(now) {
  const dt = Math.max(0, Math.min(0.1, (now - lastFly) / 1000));
  lastFly = now;
  if (!held.size || typing()) return;
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position);
  const dist = Math.max(fwd.length(), 1e-6);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize(), up = camera.up.clone().normalize();
  const move = new THREE.Vector3();
  for (const k of held) {
    const v = FLY[k];
    if (v) move.addScaledVector(right, v[0]).addScaledVector(up, v[1]).addScaledVector(fwd, v[2]);
  }
  if (!move.lengthSq()) return;
  // (speed with the size of what is in view: slow up close, fast across the space)
  const speed = Math.max(4, dist * 1.2) * (held.has("shift") ? 4 : 1);
  move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);
  controls.target.add(move);
  flight = null;
}
addEventListener("keydown", (e) => {
  if (typing()) { if (e.key === "Escape") document.activeElement.blur(); return; }
  const k = e.key.toLowerCase();
  if (!e.altKey && !e.ctrlKey && !e.metaKey && (FLY[k] || k === "shift")) { held.add(k); if (FLY[k]) e.preventDefault(); return; }
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
// (?embed=1: shown in a frame by a page of this site (the agents chat's artifact pane), which sends the space, and
//  again each time its file is written: {sagebrush: "space-load", version: 1, name, space}; the selection goes back
//  to it as "space-select")
const embedded = new URLSearchParams(location.search).has("embed") && window.parent !== window;
function embed() {
  document.body.classList.add("embed");
  let current = null;
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== window.parent || e.origin !== location.origin || m?.sagebrush !== "space-load" || m.version !== 1) return;
    const name = String(m.name ?? "space");
    const again = name === current;
    if (!again) $("#space").innerHTML = `<option selected>${esc(name)}</option>`;
    current = name;
    load(name, m.space, again).then(() => {
      if (!again && typeof m.selected === "string") setTimeout(() => window.whitespace.select(m.selected), 300);
    }, fail);
  });
  window.parent.postMessage({ sagebrush: "space-ready", version: 1 }, location.origin);
}
async function start() {
  if (embedded) return embed();
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

// ---------------------------------------------------------------- a headset (src/xr.js): Enter VR, Enter AR
const xr = setupXR({
  renderer, scene, camera, controls, runnable,
  pickables: () => pickables,
  select: (nd) => setSelected(nd ? nd.id : null),
  // (the views the desktop flies to: an object's, and everything's)
  viewOf: (nd) => viewOf(space.nodes.indexOf(nd)),
  home: () => space && homeView(positions),
  runAll: () => $("#runall").click(),
  run: (nd) => runNode(nd),
  glow: (nd, v) => setGlow(nd, v),
  theme: () => T,
  changed(on, mode) {
    $("#vr").textContent = on && mode === "immersive-vr" ? "Exit VR" : "Enter VR";
    $("#ar").textContent = on && mode === "immersive-ar" ? "Exit AR" : "Enter AR";
  },
});
const xrFail = (e) => ($("#status").textContent = "couldn't start: " + (e?.message ?? e));
$("#vr").onclick = () => xr.enter("immersive-vr").catch(xrFail);
$("#ar").onclick = () => xr.enter("immersive-ar").catch(xrFail);
xr.supported("immersive-vr").then((ok) => ($("#vr").hidden = !ok));
xr.supported("immersive-ar").then((ok) => ($("#ar").hidden = !ok));

let lastTick = performance.now();
function tick(now) {
  const dt = Math.max(0, Math.min(0.1, (now - lastTick) / 1000));
  lastTick = now;
  if (xr.presenting) xr.step(dt);
  else {
    stepFlight(now);
    stepFly(now);
    controls.update();
  }
  stepMorph(now);
  if (space) { stepZoom(); stepLandmarks(); }
  renderer.render(scene, camera);
}
// (the renderer's loop: the browser's frames, or the headset's while in VR)
renderer.setAnimationLoop(tick);
// (for tests and the curious: the loaded space and the camera)
// (the API for an agent driving the page, and for tests: what is selected, select an object (and fly to it), the
// space, Back and Forward)
window.whitespace = {
  get space() { return space; }, get objects() { return objects; }, camera, controls,
  get selection() { return selectionOf(selected); },
  select(id) { const nd = space?.nodes.find((n) => n.id === id); if (!nd) return false; openOverlay(nd); return true; },
  back, forward, frame: () => frame(positions, true), flyTo,
  xr,
};
