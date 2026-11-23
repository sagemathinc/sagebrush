// A space in 3D (/space/): a board you can walk through. Loads a foo.space.json (format.md); objects keep the positions
// written in it, and only those without one are placed (layout.js). What an object shows depends on how near it is
// (semantic zoom): far, a block in its group's color under the group's landmark label; nearer, its title; near, its
// face (title and first lines). A click shows its sharp text in an overlay; the search panel finds any text and goes
// there; Back returns; Float and Ground show it in the air or on the ground.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
// (notes: the site's own Markdown, web/markdown.ts: raw HTML limited to formatting, no pictures from other sites, and
//  math marked for KaTeX; a space is the agent's or anyone's text, shown on the site's origin)
import { render as markdown } from "../../markdown.ts";
import { layout } from "./layout.js";
import { texToText } from "./tex.js";
import { highlight, editor, codeRuns } from "./code.js";
import { run, interrupt, sceneObject, SCENE } from "./run.js";
import { sizeOf } from "./sizes.js";
import { treeRoom, resolveImport } from "./treeroom.js";
// (the languages whose files are entered: by their names; each parser loaded the first time one of its files is)
const CODE = { py: "python", sage: "python", js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", mts: "js", cts: "js", tsx: "js" };
const codeOf = (p) => CODE[/\.([a-z]+)$/i.exec(String(p))?.[1]?.toLowerCase()] ?? null;
// (a file's room by its language; at most ROOM_TEXT of text is parsed, so a long file's parse can't hold the page)
const ROOM_TEXT = 1 << 20;
async function codeRoom(text, path, scope = null, lang = null) {
  if (text.length > ROOM_TEXT) throw new Error("it's too long to enter here");
  const k = codeOf(path) ?? (lang === "sage" || lang === "python" ? "python" : null);
  if (k === "js") { const { jsRoom } = await import("./jsroom.js"); return checkSpace(jsRoom(text, { path, scope })); }
  const { pythonRoom } = await import("./pyroom.js");
  return checkSpace(pythonRoom(text, { path, sage: /\.sage$/.test(path) || lang === "sage", scope: scope?.[0] ?? null }));
}
import { checkSpace, readText, sameSite } from "./read.js";
import { EDIT, keepEdit } from "./keep.js";
import { groundPlan, placedOnGround, moundFor, supportAt as blockAt, EYE, SIGN, STEP } from "./ground.js";
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
let themeSetting = (() => { try { const v = localStorage.getItem("space3d:theme"); return ["light", "dark"].includes(v) ? v : "auto"; } catch { return "auto"; } })();
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

// ---------------------------------------------------------------- the ground
// A floor below everything, a little under the lowest object, reaching to the horizon (the fog fades it): something to
// stand on, which a person needs in a headset (src/xr.js walks on it and teleports along it), and a horizon on the screen.
const groundTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  return texture(c);
})();
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
groundTex.repeat.set(400, 400);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: groundTex, fog: true }));
ground.name = "ground";
ground.renderOrder = -1;
scene.add(ground);
function paintGround() {
  // (a tile of 10 units with a line at its edge: light on the light theme, dark on the dark)
  const c = groundTex.image, g = c.getContext("2d"), dark = T.fg !== "#1f2328";
  g.fillStyle = dark ? "#171d26" : "#e2e7ee"; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = dark ? "#2a3442" : "#c6cfdb"; g.lineWidth = 5; g.strokeRect(0, 0, 256, 256);
  groundTex.needsUpdate = true;
}
let floorY = -10;
// (the floor: on the ground (ground.js), at 0; floating, under the lowest object of the space, by 1.5 units at least;
//  centred under it)
function placeGround() {
  if (!space || !positions) return;
  let lo = Infinity, cx = 0, cz = 0;
  space.nodes.forEach((n, i) => { const [, h] = sizeOf(n); lo = Math.min(lo, positions[3 * i + 1] - h / 2); cx += positions[3 * i]; cz += positions[3 * i + 2]; });
  if (!Number.isFinite(lo)) lo = 0;
  floorY = onGround() ? 0 : lo - 1.5;
  ground.position.set(cx / Math.max(1, space.nodes.length), floorY, cz / Math.max(1, space.nodes.length));
}
// On the ground (the default) or floating, as before: the Float / Ground button; a space can ask to float
// (`layout: "floating"`), a space of 3D plots, say, which are seen from all sides.
let groundPref = (() => { try { return localStorage.getItem("space3d:layout") !== "float"; } catch { return true; } })();
const onGround = () => groundPref && space?.layout !== "floating";
// (the ground's shape: a room's terraces and stairs, the mounds under objects placed high, and their slopes; blocks of
//  floor and ramps, a mesh of each)
let blocks = [], terraces = null;
const terraceMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
function paintTerraces() { terraceMat.color.set(T.fg !== "#1f2328" ? 0x232c38 : 0xd3dae4); }
// (a ramp's shape: a unit block whose top falls from 1 at its back (-z) to 0 at its front (+z))
const WEDGE = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), a = g.attributes.position;
  for (let k = 0; k < a.count; k++) if (a.getY(k) > 0.5) a.setY(k, 0.5 - a.getZ(k));
  g.computeVertexNormals();
  return g;
})();
function buildTerraces() {
  if (terraces) { scene.remove(terraces); for (const m of terraces.children) m.dispose(); terraces = null; }
  if (!blocks.length) return;
  terraces = new THREE.Group();
  terraces.name = "terraces";
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  for (const ramp of [false, true]) {
    const bs = blocks.filter((b) => !!b.ramp === ramp);
    if (!bs.length) continue;
    const mesh = new THREE.InstancedMesh(ramp ? WEDGE : UNIT_BOX, terraceMat, bs.length);
    bs.forEach((b, k) => mesh.setMatrixAt(k, m.compose(v.set((b.x0 + b.x1) / 2, ramp ? 0 : b.y / 2, (b.z0 + b.z1) / 2), q, sc.set(b.x1 - b.x0, b.y, b.z1 - b.z0))));
    mesh.computeBoundingSphere();
    terraces.add(mesh);
  }
  terraces.visible = onGround();
  scene.add(terraces);
}
// (how high the ground is where you are: a terrace, a mound, or the floor)
const groundAt = (x, z) => (onGround() && terraces?.visible ? blockAt(blocks, x, z, floorY) : floorY);
// (what you can stand on, and point at to go to: the floor, and the terraces)
const walkable = () => (terraces?.visible ? [ground, ...terraces.children] : [ground]);

// ---------------------------------------------------------------- objects
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 360) / 360; };
const groupColor = (nd) => new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.5, 0.45);

function canvasFor(nd, px) {
  const [w, h] = sizeOf(nd);
  const c = document.createElement("canvas");
  c.width = Math.round(w * px); c.height = Math.round(h * px);
  return c;
}
const bgOf = (nd) => nd.kind === "note" ? "#f4ecd8" : nd.kind === "code" ? T.code : nd.kind === "plot3d" ? T.plot : "#" + new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.45, T.fileL).getHexString();
const fgOf = (nd) => nd.kind === "note" ? "#2b2a26" : T.fg;
const summaryBand = () => (T.fg === "#1f2328" ? "rgba(31, 111, 235, 0.10)" : "rgba(88, 166, 255, 0.16)");
const sideColor = (nd) => new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.35, nd.kind === "note" ? 0.75 : T.sideL);
// (a title as drawn on a face: its math as text, texToText; the drawer typesets it)
const shortTitle = (nd) => (nd.kind === "file" ? nd.title.split("/").pop() : nd.kind === "dir" || ROOM_KINDS.has(nd.kind) ? String(nd.title) : texToText(nd.title));
// (the objects of a room, read from a parse: their titles are code, never math)
const ROOM_KINDS = new Set(["fn", "class", "block", "import"]);
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
  const lines = wrap(g, shortTitle(nd), c.width * 0.9).slice(0, nd.summary ? 2 : 3);
  // (with a summary: the title above, the summary's first lines below it, readable from the middle distance)
  const ss = size * 0.48, sum = nd.summary ? (g.font = `italic ${ss}px system-ui, sans-serif`, wrap(g, texToText(nd.summary).replace(/\*\*|`/g, "").replace(/\s+/g, " "), c.width * 0.9).slice(0, 3)) : [];
  const total = lines.length * size * 1.2 + (sum.length ? size * 0.4 + sum.length * ss * 1.3 : 0);
  const y0 = (c.height - total) / 2 + size;
  g.font = `600 ${size}px system-ui, sans-serif`;
  lines.forEach((l, i) => g.fillText(l, c.width * 0.05, y0 + i * size * 1.2, c.width * 0.9));
  g.font = `italic ${ss}px system-ui, sans-serif`;
  sum.forEach((l, i) => g.fillText(l, c.width * 0.05, y0 + lines.length * size * 1.2 + size * 0.2 + i * ss * 1.3, c.width * 0.9));
  return texture(c);
}

// near: the title and the first lines (still small: the overlay gives the sharp text)
function faceTexture(nd) {
  const c = canvasFor(nd, nd.figure ? 220 : nd.kind === "file" ? 160 : 140), g = c.getContext("2d");
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
    g.fillText(nd.title.includes("/") ? nd.title.slice(0, nd.title.lastIndexOf("/")) : String(nd.group ?? ""), pad, y, c.width - 2 * pad);
    g.globalAlpha = 1;
    y += c.height * 0.1;
  }
  // (what it is for, before what it says: the summary, in a band of its own)
  if (nd.summary) {
    const ss = c.height * (nd.kind === "file" ? 0.062 : 0.05);
    g.font = `italic ${ss}px system-ui, sans-serif`;
    const rows = wrap(g, texToText(nd.summary).replace(/\*\*|`/g, "").replace(/\s+/g, " "), c.width - 2.4 * pad).slice(0, nd.kind === "file" ? 4 : 5);
    g.fillStyle = summaryBand(); g.fillRect(pad * 0.6, y - ss * 0.9, c.width - 1.2 * pad, rows.length * ss * 1.3 + ss * 0.5);
    g.fillStyle = fg;
    for (const r of rows) { g.fillText(r, pad, y + ss * 0.15); y += ss * 1.3; }
    y += ss * 0.9;
  }
  const mono = nd.kind !== "note";
  const fs = mono ? c.height * (nd.kind === "file" ? 0.05 : 0.04) : c.height * 0.045;
  // (a figure's face (`figure`: an agent's plot): the picture, as large as it fits; its code is in the drawer)
  if (nd.figure) {
    if (!nd.svg) {
      g.font = `italic ${c.height * 0.05}px system-ui, sans-serif`; g.globalAlpha = 0.6;
      g.fillText(nd.outputError ? "it failed: open it to see why" : "working…", pad, y + c.height * 0.05); g.globalAlpha = 1;
      return texture(c);
    }
    const img = new Image(), top = y, tex = { ref: null };
    img.onload = () => {
      const hh = c.height - top - pad, ww = c.width - 2 * pad, k = Math.min(ww / img.width, hh / img.height), w = img.width * k, h = img.height * k;
      g.fillStyle = "#ffffff"; g.fillRect(pad, top, ww, hh);
      g.drawImage(img, pad + (ww - w) / 2, top + (hh - h) / 2, w, h);
      // (not if the texture was let go meanwhile: it would be uploaded again, with no owner)
      if (tex.ref && !tex.ref.userData.gone) tex.ref.needsUpdate = true;
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(nd.svg)));
    const t = texture(c);
    tex.ref = t;
    return t;
  }
  // (code: highlighted, in the theme's colours, line by line as it fits)
  if (mono && nd.kind !== "plot3d" && nd.text) {
    g.font = `${fs}px ui-monospace, Menlo, monospace`;
    for (const runs of codeRuns(nd.text, nd.lang ?? "", T.fg !== "#1f2328", 120)) {
      if (y > c.height - pad) break;
      let x = pad;
      for (const r of runs) {
        if (x > c.width - pad) break;
        g.fillStyle = r.color ?? fg;
        g.fillText(r.text, x, y);
        x += g.measureText(r.text).width;
      }
      y += fs * 1.35;
    }
  } else for (const raw of String(nd.kind === "plot3d" ? "" : nd.kind === "note" ? texToText(nd.text).replace(/\n\s*\n(\s*\n)+/g, "\n\n") : nd.text ?? "").split("\n")) {
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

let space = null, objects = [], pickables = [], edgeLines = null, positions = null, P3 = null, PG = null;
// (the post each object stands on, on the ground, and its foot: shared shapes, stretched to the height)
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const POST = new THREE.BoxGeometry(0.22, 1, 0.22).translate(0, -0.5, 0), FOOT = new THREE.BoxGeometry(1.3, 0.12, 0.8).translate(0, 0.06, 0);
const postMat = new THREE.MeshStandardMaterial({ color: 0x8b96a5, roughness: 0.6, metalness: 0.2 });
postMat.userData.shared = true;
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
  const post = new THREE.Mesh(POST, postMat), foot = new THREE.Mesh(FOOT, postMat);
  post.visible = foot.visible = false;
  group.add(post, foot);
  group.userData.post = [post, foot];
  const gl = glyph(nd);
  // (in a room, small and at the top left corner: the arrows arrive at the top's middle)
  if (space?.directed) { gl.scale.setScalar(0.5); gl.position.set(-w / 2 + 0.35, h / 2 + 0.45, 0); }
  else gl.position.set(0, h / 2 + 0.9, 0);
  group.add(gl);
  group.userData.glyph = gl;
  if (nd.scene) setPlot(group, sceneObject(nd.scene));
  else if (nd.kind === "plot3d" && nd.surface) setPlot(group, surfaceMesh(nd));
  return group;
}
// Each object's own shape, above its slab: chosen by its id, so the same file has the same shape every time, in its
// group's colour; something to hold on to while learning where things are (and pointed at, it selects the object)
const GLYPHS = [
  () => new THREE.TetrahedronGeometry(0.55), () => new THREE.OctahedronGeometry(0.55), () => new THREE.IcosahedronGeometry(0.55),
  () => new THREE.DodecahedronGeometry(0.55), () => new THREE.TorusGeometry(0.4, 0.14, 10, 24), () => new THREE.ConeGeometry(0.42, 0.85, 6),
  () => new THREE.CylinderGeometry(0.36, 0.36, 0.7, 6), () => new THREE.BoxGeometry(0.6, 0.6, 0.6), () => new THREE.CapsuleGeometry(0.25, 0.45, 4, 10),
  (r) => new THREE.TorusKnotGeometry(0.33, 0.1, 64, 8, 2 + (r % 3), 3 + (r % 2)), () => new THREE.SphereGeometry(0.45, 6, 4),
  () => new THREE.TorusGeometry(0.42, 0.07, 6, 5),
];
const glyphGeo = new Map();
function glyph(nd) {
  let h = 2166136261;
  for (const ch of String(nd.id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const kind = h % GLYPHS.length, r = (h >>> 8) % 6, key = kind + ":" + (kind === 9 ? r : 0);
  if (!glyphGeo.has(key)) glyphGeo.set(key, GLYPHS[kind](r));
  const c = new THREE.Color().setHSL(hue(nd.group ?? nd.kind), 0.55, 0.42 + ((h >>> 16) % 5) * 0.05);
  const m = new THREE.Mesh(glyphGeo.get(key), new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.1, flatShading: true }));
  m.rotation.set(((h >>> 4) % 7) * 0.4, 0, ((h >>> 12) % 5) * 0.3);
  m.userData.node = nd;
  m.userData.spin = 0.25 + ((h >>> 20) % 5) * 0.08;
  pickables.push(m);
  return m;
}
// (the shapes turn slowly: the near ones only, which are the ones you'd see turning)
function stepGlyphs(dt) {
  const e = eye();
  for (const o of objects) {
    const g = o.userData.glyph;
    if (g && o.position.distanceToSquared(e) < 3600) g.rotation.y += g.userData.spin * dt;
  }
}
// an object's 3D content (a surface, or a scene a run made), standing on the front of its slab
function setPlot(group, obj) {
  const nd = group.userData.node, [, , d] = sizeOf(nd);
  if (group.userData.plot) {
    group.remove(group.userData.plot);
    dispose(group.userData.plot);
    group.userData.plot.traverse((m) => { const k = pickables.indexOf(m); if (k >= 0) pickables.splice(k, 1); });
  }
  obj.position.z = d / 2;
  obj.traverse((m) => { if (m.isMesh) { m.userData.node = nd; pickables.push(m); } });
  group.add(obj);
  group.userData.plot = obj;
}

// semantic zoom: 0 far (a block in its group's color), 1 its title, 2 its face; textures made lazily, a few a frame
const LEVEL_DIST = { file: [14, 45], note: [26, 90], code: [26, 90], plot3d: [26, 90], fn: [16, 50], class: [18, 60], block: [16, 50], import: [10, 32], dir: [16, 55] };
// (where you see from: the camera's place in the world, which in a headset is your head's)
const eyeV = new THREE.Vector3();
const eye = () => camera.getWorldPosition(eyeV);
function stepZoom() {
  const cam = eye().clone(), pending = [];
  for (const o of objects) {
    const nd = o.userData.node, [nearD, midD] = nd.figure ? [120, 240] : LEVEL_DIST[nd.kind] ?? LEVEL_DIST.file;
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
  for (const l of landmarks) { scene.remove(l.sprite); dispose(l.sprite); }
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
  // (a room labels only the groups it names: its levels are its order, and a label over all its functions would float
  //  in the middle of them)
  const only = space.room ? new Set(space.room.labels ?? []) : null;
  for (const [g, set] of groups) {
    const members = [...set];
    if (!g || members.length < 2 || (only && !only.has(g))) continue;
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

// (everything a space made on the GPU is freed with it: rooms come and go with every Enter and Back. The glyphs'
//  shared shapes and the arrows' head stay)
function dispose(obj) {
  const shared = new Set(glyphGeo.values()).add(HEAD).add(POST).add(FOOT).add(UNIT_BOX).add(WEDGE);
  obj.traverse((m) => {
    if (m.geometry && !shared.has(m.geometry) && !m.isSprite) m.geometry.dispose(); // (sprites share three's one quad)
    for (const mat of [].concat(m.material ?? [])) { if (mat.userData.shared) continue; if (mat.map) { mat.map.userData.gone = true; mat.map.dispose(); } mat.dispose(); }
  });
  for (const t of obj.userData?.tex ?? []) if (t) { t.userData.gone = true; t.dispose(); }
}
function clear() {
  for (const o of objects) { scene.remove(o); dispose(o); }
  for (const l of landmarks) { scene.remove(l.sprite); dispose(l.sprite); }
  if (edgeLines) { scene.remove(edgeLines); dispose(edgeLines); }
  if (floorEdges) { scene.remove(floorEdges); dispose(floorEdges); }
  if (arrowHeads) { scene.remove(arrowHeads); arrowHeads.material.dispose(); arrowHeads.dispose(); }
  objects = []; pickables = []; edgeLines = null; floorEdges = null; landmarks = []; arrowHeads = null;
}

// Arrows, in a space whose links have a direction (`directed`: a room's calls and imports): each link runs from the
// edge of one slab to the edge of the other, with a head where it arrives.  The selected object's links stand out:
// what it calls in orange, what calls it in blue.
let arrowHeads = null;
const HEAD = new THREE.ConeGeometry(0.15, 0.5, 10).translate(0, -0.25, 0); // (its tip at the origin, pointing up +y)
function buildArrows(pairs) {
  arrowHeads = new THREE.InstancedMesh(HEAD, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: true }), Math.max(1, pairs.length));
  arrowHeads.count = pairs.length;
  arrowHeads.frustumCulled = false;
  scene.add(arrowHeads);
}
// (where the segment from a slab's centre towards `dir` leaves it: the slab's face rectangle, as seen from in front)
function exitDist(i, dx, dy) {
  const [w, h] = sizeOf(space.nodes[i]);
  const tx = Math.abs(dx) > 1e-6 ? (w / 2) / Math.abs(dx) : Infinity, ty = Math.abs(dy) > 1e-6 ? (h / 2) / Math.abs(dy) : Infinity;
  return Math.min(tx, ty, 50);
}
const EDGE_COLOR = { out: new THREE.Color(0xe8590c), in: new THREE.Color(0x1c7ed6) };
function edgeColors() {
  if (!edgeLines) return;
  const pairs = edgeLines.userData.pairs, kinds = edgeLines.userData.kinds, col = edgeLines.geometry.attributes.color, fcol = floorEdges?.geometry.attributes.color;
  const base = new THREE.Color(T.edge), bg = new THREE.Color(T.bg), c = new THREE.Color();
  const sel = selected === null ? -1 : space.nodes.findIndex((n) => n.id === selected);
  pairs.forEach(([i, j], e) => {
    c.copy(i === sel ? EDGE_COLOR.out : j === sel ? EDGE_COLOR.in : base);
    // (a use, not a call: fainter, when nothing selected marks it)
    if (i !== sel && j !== sel && kinds[e] === "uses") c.lerp(bg, 0.45);
    col.setXYZ(2 * e, c.r, c.g, c.b); col.setXYZ(2 * e + 1, c.r, c.g, c.b);
    if (fcol) for (let k = e * RIBBON_V; k < (e + 1) * RIBBON_V; k++) fcol.setXYZ(k, c.r, c.g, c.b);
    if (arrowHeads) arrowHeads.setColorAt(e, c);
  });
  col.needsUpdate = true;
  if (fcol) { fcol.needsUpdate = true; floorEdges.material.opacity = sel >= 0 ? 0.95 : 0.75; }
  if (arrowHeads?.instanceColor) arrowHeads.instanceColor.needsUpdate = true;
  edgeLines.material.opacity = sel >= 0 || space.directed ? Math.max(T.edgeOpacity, 0.55) : T.edgeOpacity;
}

function place(P) {
  positions = P;
  objects.forEach((o, i) => o.position.set(P[3 * i], P[3 * i + 1], P[3 * i + 2]));
  placeGround();
  // (on the ground, the links run along the floor; in the air, or while the objects move, straight between them)
  const onFloor = !!floorEdges && onGround() && !morph;
  if (edgeLines) edgeLines.visible = !onFloor;
  if (floorEdges) floorEdges.visible = onFloor;
  if (onFloor) routeFloorEdges(P);
  else if (edgeLines) {
    const a = edgeLines.geometry.attributes.position, m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const A = new THREE.Vector3(), B = new THREE.Vector3(), d = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    edgeLines.userData.pairs.forEach(([i, j], e) => {
      A.set(P[3 * i], P[3 * i + 1], P[3 * i + 2]); B.set(P[3 * j], P[3 * j + 1], P[3 * j + 2]);
      if (arrowHeads) {
        // (from slab edge to slab edge, the head's tip on the edge it arrives at)
        d.subVectors(B, A);
        const len = d.length();
        if (len > 1e-6) {
          d.divideScalar(len);
          const s = exitDist(i, d.x, d.y), t = exitDist(j, d.x, d.y);
          if (s + t < len) { A.addScaledVector(d, s); B.addScaledVector(d, -t); }
        }
        q.setFromUnitVectors(up, d.lengthSq() ? d : up);
        arrowHeads.setMatrixAt(e, m.compose(B, q, one));
      }
      a.setXYZ(2 * e, A.x, A.y, A.z);
      a.setXYZ(2 * e + 1, B.x, B.y, B.z);
    });
    a.needsUpdate = true;
    edgeLines.geometry.computeBoundingSphere();
    if (arrowHeads) arrowHeads.instanceMatrix.needsUpdate = true;
  }
  if (landmarks.length) placeLandmarks();
  placePosts();
}
// Links on the floor: a flat ribbon from the foot of one object's post to the foot of the other's, draped over the
// terraces and slopes between them (a few samples along the way), with its arrowhead on the floor, pointing in.
const RIBBON_SEGS = 24, RIBBON_V = RIBBON_SEGS * 6, RIBBON_W = 0.09;
let floorEdges = null;
function buildFloorEdges(pairs) {
  const geo = new THREE.BufferGeometry(), n = Math.max(1, pairs.length) * RIBBON_V;
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  floorEdges = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  floorEdges.frustumCulled = false;
  floorEdges.renderOrder = 1;
  floorEdges.visible = false;
  scene.add(floorEdges);
}
function routeFloorEdges(P) {
  const a = floorEdges.geometry.attributes.position, pts = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), d = new THREE.Vector3();
  const lift = 0.06, headScale = new THREE.Vector3(1.8, 1.8, 1.8), B = new THREE.Vector3();
  edgeLines.userData.pairs.forEach(([i, j], e) => {
    let ax = P[3 * i], az = P[3 * i + 2], bx = P[3 * j], bz = P[3 * j + 2];
    const len = Math.hypot(bx - ax, bz - az), ux = len > 1e-6 ? (bx - ax) / len : 0, uz = len > 1e-6 ? (bz - az) / len : 0;
    // (from beside the first foot to short of the second, where the head is)
    const s = Math.min(0.7, len * 0.2), t = Math.min(arrowHeads ? 1.6 : 0.7, len * 0.3);
    ax += ux * s; az += uz * s; bx -= ux * t; bz -= uz * t;
    pts.length = 0;
    // (each point on the highest ground near it, so the ribbon goes over a step's edge rather than into it)
    const hx = (bx - ax) / RIBBON_SEGS / 2, hz = (bz - az) / RIBBON_SEGS / 2;
    for (let k = 0; k <= RIBBON_SEGS; k++) {
      const x = ax + (bx - ax) * k / RIBBON_SEGS, z = az + (bz - az) * k / RIBBON_SEGS;
      pts.push([x, Math.max(groundAt(x, z), groundAt(x - hx, z - hz), groundAt(x + hx, z + hz)) + lift, z]);
    }
    const px = -uz * RIBBON_W, pz = ux * RIBBON_W;
    let v = e * RIBBON_V;
    for (let k = 0; k < RIBBON_SEGS; k++) {
      const [x0, y0, z0] = pts[k], [x1, y1, z1] = pts[k + 1];
      for (const [x, y, z] of [[x0 - px, y0, z0 - pz], [x0 + px, y0, z0 + pz], [x1 + px, y1, z1 + pz], [x0 - px, y0, z0 - pz], [x1 + px, y1, z1 + pz], [x1 - px, y1, z1 - pz]]) a.setXYZ(v++, x, y, z);
    }
    if (arrowHeads) {
      const [x9, y9, z9] = pts[RIBBON_SEGS], [x8, y8, z8] = pts[RIBBON_SEGS - 1];
      d.set(x9 - x8, y9 - y8, z9 - z8);
      if (d.lengthSq() < 1e-9) d.set(ux, 0, uz);
      d.normalize();
      // (the head's tip a little past the ribbon's end, lying on the floor)
      B.set(x9, y9 + 0.12, z9).addScaledVector(d, 1.2);
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      arrowHeads.setMatrixAt(e, m.compose(B, q, headScale));
    }
  });
  a.needsUpdate = true;
  if (arrowHeads) arrowHeads.instanceMatrix.needsUpdate = true;
}
// (on the ground, each object on its post, down to what is under it; none while it moves between layouts)
function placePosts() {
  const show = onGround() && !morph;
  objects.forEach((o, i) => {
    const [post, foot] = o.userData.post, [, h] = sizeOf(space.nodes[i]);
    const len = show ? o.position.y - h / 2 - groundAt(o.position.x, o.position.z) : 0;
    post.visible = foot.visible = len > 0.3;
    if (!post.visible) return;
    post.position.y = -h / 2; post.scale.y = len;
    foot.position.y = -h / 2 - len;
  });
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
// (`opts.room`: a room being entered or left (rooms.js below): Back's history is kept, and `opts.P` gives the places
//  the space had, so a room left is as it was)
async function load(name, data = null, again = false, opts = {}) {
  $("#status").textContent = "loading " + name + "…";
  let next = checkSpace(data ?? JSON.parse(await readText(sameSite(name, { space: true }))));
  // (a space carrying a whole tree instead of objects: its top directory's room)
  // (and the room made from it, checked the same way: treeroom.js refuses a folder over the limits before laying it out)
  if (next?.format === "sagebrush-space" && next.tree && !next.nodes?.length) next = checkSpace({ ...treeRoom(next.tree, ""), title: next.title ?? next.tree.name, summary: next.summary });
  if (!Array.isArray(next.nodes)) throw new Error(name + " has no objects");
  // (the file written again while you are inside one of its rooms: it is what you'll come back out to)
  if (again && scopes.length && !opts.room) {
    if (tour && tour.space === scopes[0].space) { const t = toursOf(next).find((x) => x.title === tour.t.title); if (t) { tour.space = next; tour.t = t; } else tour = null; }
    scopes[0].space = next; scopes[0].P = null;
    $("#status").textContent = "the space was written again: Back out of the rooms to see it";
    return;
  }
  const view = again && space ? { pos: camera.position.clone(), target: controls.target.clone(), sel: selected } : null;
  if (!opts.room) { scopes.length = 0; spaceName = name; }
  // (the same space written again, on a tour of it: the tour goes on in the new copy, if it is still there)
  if (view && tour && tour.space === space) {
    const t = toursOf(next).find((x) => x.title === tour.t.title);
    if (t) { tour.space = next; tour.t = t; } else tour = null;
  }
  space = next;
  clear();
  const nodes = space.nodes, index = new Map(nodes.map((n, i) => [n.id, i]));
  restore(nodes);
  objects = nodes.map(makeObject);
  objects.forEach((o) => scene.add(o));
  const pairs = [], kinds = [];
  for (const e of space.edges ?? []) {
    const i = index.get(e.from), j = index.get(e.to);
    if (i !== undefined && j !== undefined) { pairs.push([i, j]); kinds.push(e.kind ?? ""); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
  edgeLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: T.edgeOpacity }));
  edgeLines.userData.pairs = pairs;
  edgeLines.userData.kinds = kinds;
  scene.add(edgeLines);
  if (space.directed) buildArrows(pairs);
  buildFloorEdges(pairs);
  for (const n of nodes) (n._out = []), (n._in = []);
  for (const [i, j] of pairs) (nodes[i]._out.push(nodes[j]), nodes[j]._in.push(nodes[i]));
  const t0 = performance.now();
  const r3 = opts.P && opts.P.length === nodes.length * 3 ? { P: opts.P, laid: false } : positionsOf(nodes, space.edges ?? [], 3);
  P3 = r3.P;
  // (the ground's plan: a room's stands, or the space's plan from above (position2d; laid out if it has none))
  const needs2d = !space.room && nodes.some((n) => !Array.isArray(n.position2d) && !Array.isArray(n.position));
  const plan = groundPlan(nodes, { room: !!space.room, P2: needs2d ? positionsOf(nodes, space.edges ?? [], 2).P : null });
  PG = plan.P; blocks = plan.blocks;
  morph = null;
  buildTerraces();
  layoutButton();
  place(onGround() ? PG : P3);
  buildLandmarks();
  selected = null;
  edgeColors();
  if (view) {
    frame(positions);
    flight = null;
    camera.position.copy(view.pos);
    controls.target.copy(view.target);
    if (deskWalk) land(); // (standing where you were, not falling)
    const nd = view.sel === null ? null : nodes.find((n) => n.id === view.sel);
    if (nd) { selected = nd.id; setGlow(nd, 0.4); edgeColors(); }
  } else {
    if (!opts.room) { history.length = 0; future.length = 0; }
    frame(positions, false, opts.room ? 900 : 1);
  }
  navButtons();
  buildIndex();
  // (a tour belongs to its space: entering a room and leaving it keep it; another space ends it)
  if (!view && !opts.room) tour = null;
  renderTours();
  document.title = (space.title ?? name) + " · 3D view";
  crumbs();
  $("#status").textContent = `${nodes.length} objects, ${pairs.length} links · ${r3.laid ? "laid out in " + Math.round(performance.now() - t0) + " ms" : "at their saved places"}`;
  if (!view || selected === null) closeOverlay();
  else if (!$("#overlay").hidden) showOverlay(nodes.find((n) => n.id === selected));
}

// the camera: everything in view
// (the view of everything: the centre, and a place to see most of the space from; a few outliers don't shrink the rest)
function homeView(P) {
  if (onGround() && P === PG) return groundView(P);
  const n = P.length / 3, c = new THREE.Vector3();
  for (let i = 0; i < n; i++) c.add(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2]));
  c.divideScalar(Math.max(n, 1));
  const ds = [];
  for (let i = 0; i < n; i++) ds.push(c.distanceTo(new THREE.Vector3(P[3 * i], P[3 * i + 1], P[3 * i + 2])));
  ds.sort((a, b) => a - b);
  // (a room is seen whole: it is laid out to be)
  const r = Math.max(ds[space?.room ? ds.length - 1 : Math.floor(ds.length * 0.8)] ?? 6, 6) * (space?.room ? 0.95 : 1);
  // (a space can say where it is seen from as a whole: `view: {from, to}`)
  const v = space?.view;
  if (!space?.room && Array.isArray(v?.from) && Array.isArray(v?.to)) {
    const to = new THREE.Vector3(...v.to), from = new THREE.Vector3(...v.from), fit = camera.aspect < 1 ? Math.min(2.2, 1 / camera.aspect) : 1;
    return { to: to.clone().add(from.clone().sub(to).multiplyScalar(fit)), toT: to, r: Math.max(r, from.distanceTo(to) / 2.2) };
  }
  // (a tall, narrow screen (a phone held upright) sees less across: further back, so the width fits too)
  const fit = camera.aspect < 1 ? Math.min(2.2, 1 / camera.aspect) : 1;
  return { to: c.clone().add(new THREE.Vector3(0.35, 0.25, 1).normalize().multiplyScalar(r * 2.2 * fit)), toT: c, r };
}
// (on the ground: a room from its door, on the floor in front of its first row, far enough back to have its stands in
//  view; anything else from a balcony in front of it, above its middle)
function groundView(P) {
  const n = P.length / 3;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = EYE;
  for (let i = 0; i < n; i++) {
    const [w, h] = sizeOf(space.nodes[i]);
    x0 = Math.min(x0, P[3 * i] - w / 2); x1 = Math.max(x1, P[3 * i] + w / 2);
    z0 = Math.min(z0, P[3 * i + 2]); z1 = Math.max(z1, P[3 * i + 2]);
    top = Math.max(top, P[3 * i + 1] + h / 2);
  }
  if (!n) { x0 = x1 = z0 = z1 = 0; }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, W = x1 - x0 + 6, D = z1 - z0 + 6;
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * camera.aspect;
  if (space.room) {
    const dist = Math.max(W / 2 / tanH, (top + 2) / 2 / tanV, 16) * 1.05;
    const to = new THREE.Vector3(cx, floorY + EYE, z1 + dist);
    return { to, toT: new THREE.Vector3(cx, Math.max(EYE, top * 0.45), cz), r: Math.max(W, D, top) / 2 };
  }
  // (a space can say where it is seen from on the ground: `groundView: {from, to}`)
  const v = space.groundView;
  if (Array.isArray(v?.from) && Array.isArray(v?.to)) {
    const to = new THREE.Vector3(...v.to), from = new THREE.Vector3(...v.from), fit = camera.aspect < 1 ? Math.min(2.2, 1 / camera.aspect) : 1;
    return { to: to.clone().add(from.clone().sub(to).multiplyScalar(fit)), toT: to, r: Math.max(12, from.distanceTo(to) / 2) };
  }
  // (a few outliers don't push the rest far off: the middle 80% framed)
  const pct = (k, q) => { const xs = []; for (let i = 0; i < n; i++) xs.push(P[3 * i + k]); xs.sort((a, b) => a - b); return xs[Math.min(n - 1, Math.max(0, Math.round((n - 1) * q)))]; };
  const trim = n > 12 ? 0.1 : 0, qx0 = pct(0, trim) - 3, qx1 = pct(0, 1 - trim) + 3, qz0 = pct(2, trim), qz1 = pct(2, 1 - trim);
  const Wq = qx1 - qx0, Dq = qz1 - qz0 + 6, qx = (qx0 + qx1) / 2, qz = (qz0 + qz1) / 2;
  const r = Math.max(Wq, Dq, 12) / 2, back = Math.max(r * 0.7, Wq / 2 / tanH * 0.8);
  return { to: new THREE.Vector3(qx, floorY + EYE + r * 0.6, qz1 + back), toT: new THREE.Vector3(qx, floorY + EYE, qz), r };
}
function frame(P, remember = false, ms = remember ? 900 : 1) {
  if (remember) pushView();
  const { to, toT: c, r } = homeView(P);
  camera.far = Math.max(r * 20, 400);
  // (no fog: AR clears it; and a headset's view is far less deep than a room is wide)
  if (scene.fog) { scene.fog.near = r * 1.2; scene.fog.far = r * 6; }
  camera.updateProjectionMatrix();
  flight = { from: camera.position.clone(), fromT: controls.target.clone(), to, toT: c, t0: performance.now(), ms };
}

// ---------------------------------------------------------------- flying, Back and Forward
// (a view: where the camera was, and which object was selected; a new flight clears Forward, as a browser's does)
let flight = null;
const history = [], future = [];
const viewNow = () => ({ pos: camera.position.clone(), target: controls.target.clone(), sel: selected });
function pushView() {
  history.push(viewNow());
  // (the oldest view goes, never the place a room was entered from: leaving the room needs it)
  if (history.length > 100) { const k = history.findIndex((v) => !v.leave); if (k >= 0) history.splice(k, 1); }
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
  let d = dist ?? (Array.isArray(nd.size) ? Math.max(9, nd.size[1] * 1.7) : nd.kind === "file" ? 5 : 9);
  // (on the ground: standing in front of it, on whatever is there, looking at it; in a room, on the stairs before its
  //  row, short of the row in front)
  if (onGround() && positions === PG) {
    const plot = nd.kind === "plot3d" || nd.scene;
    if (plot) d = Math.max(d, 12);
    else if (space.room && dist === undefined) d = Math.min(d, 5.5);
    const t = plot ? p.clone().add(new THREE.Vector3(0, 0, 1.4)) : p, z = p.z + d;
    return { to: new THREE.Vector3(p.x, groundAt(p.x, z) + EYE, z), toT: t };
  }
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
  // (Back past the place a room was entered from: out of the room, to that place)
  if (from === history && history.at(-1)?.leave) {
    const v = leaveRoom();
    if (!v) return;
    const i = v.sel === null ? -1 : space.nodes.findIndex((n) => n.id === v.sel);
    if (i >= 0) showOverlay(space.nodes[i]); else closeOverlay();
    flyToView(v.pos, v.target);
    return;
  }
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
  // (walking: a blink: dark, there, light again; then standing where it left you)
  if (deskWalk && flight.ms > 1) {
    $("#fade").style.opacity = String(u < 0.5 ? u * 2 : (1 - u) * 2);
    if (u >= 0.5 && !flight.jumped) { camera.position.copy(flight.to); controls.target.copy(flight.toT); flight.jumped = true; land(); }
    if (u >= 1) { $("#fade").style.opacity = "0"; flight = null; }
    return;
  }
  // (an arc: up and over, so a long flight passes above the space instead of through it)
  const lift = Math.sin(Math.PI * u) * flight.from.distanceTo(flight.to) * 0.25;
  camera.position.lerpVectors(flight.from, flight.to, e).add(new THREE.Vector3(0, lift, 0));
  controls.target.lerpVectors(flight.fromT, flight.toT, e);
  if (u >= 1) { flight = null; if (deskWalk) land(); }
}
$("#back").onclick = back;
$("#fwd").onclick = forward;
$("#home").onclick = () => space && frame(positions, true);

// Ground / Float: the space on the ground (ground.js), or floating in the air as it was laid out; the objects move from
// one to the other
let morph = null;
function layoutButton() {
  $("#dims").hidden = space?.layout === "floating";
  $("#dims").textContent = onGround() ? "Float" : "Ground";
  $("#dims").title = onGround() ? "Float the space in the air, as laid out in 3D" : "Stand the space on the ground: a room as a grandstand, anything else on the floor";
}
function setGround(on) {
  if (!space || on === onGround() || space.layout === "floating") return;
  groundPref = on;
  try { localStorage.setItem("space3d:layout", on ? "ground" : "float"); } catch {}
  if (morph) place(morph.to);
  // (the terraces go before the objects lift off them, and come after they have landed)
  if (terraces) terraces.visible = false;
  morph = { from: Float64Array.from(positions), to: on ? PG : P3, t0: performance.now(), ms: 1200 };
  layoutButton();
  placePosts();
}
$("#dims").onclick = () => setGround(!onGround());
function stepMorph(now) {
  if (!morph) return;
  const u = Math.max(0, Math.min(1, (now - morph.t0) / morph.ms)), e = u * u * (3 - 2 * u);
  const P = new Float64Array(morph.from.length);
  for (let i = 0; i < P.length; i++) P[i] = morph.from[i] + (morph.to[i] - morph.from[i]) * e;
  place(P);
  if (u >= 1) {
    const to = morph.to;
    morph = null;
    if (terraces) terraces.visible = onGround();
    place(to);
    frame(to, true);
  }
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
  // (over the floor, with no button held: where a click would take you)
  const fp = !nd && !ev.buttons && deskWalk ? floorAt(ev) : null;
  floorMark.visible = !!fp;
  if (fp) floorMark.position.copy(fp).setY(fp.y + 0.05);
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
  if (nd) { openOverlay(nd); return; }
  // (a click beside the open drawer closes it, and only that; walking, a click on the floor goes there)
  if (!$("#overlay").hidden) { closeOverlay(); return; }
  closeOverlay();
  const p = deskWalk && !xr.presenting && floorAt(ev);
  if (p) goToFloor(p);
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
// (the selected object's id is in the address (#sel=ID), in window.space3d.selection, in a "space3d:select"
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
  edgeColors();
  tourPill();
  window.history.replaceState(null, "", location.pathname + location.search + (id === null ? "" : "#sel=" + encodeURIComponent(id)));
  const detail = selectionOf(id);
  dispatchEvent(new CustomEvent("space3d:select", { detail }));
  if (embedded) window.parent.postMessage({ sagebrush: "space-select", version: 1, selection: detail }, location.origin);
}
function selectionOf(id) {
  const nd = id === null ? null : space?.nodes.find((n) => n.id === id);
  return nd ? { id: nd.id, kind: nd.kind, title: nd.title, group: nd.group ?? null, space: $("#space").value,
    ...(scopes.length ? { room: roomPath() } : {}), ...(nd.path ? { path: nd.path } : {}), ...(nd.start ? { lines: [nd.start, nd.end] } : {}) } : null;
}

function openOverlay(nd) {
  // (the view left behind is remembered before the selection changes: Back returns to it, and to what it had open)
  pushView();
  showOverlay(nd);
  flyTo(space.nodes.indexOf(nd), undefined, false);
}
const linkLabels = (nd) => (space.room?.kind === "notebook" ? (nd.kind === "note" ? ["Explains", "Explained by"] : ["Read by", "Uses names from"]) : space.room && ROOM_KINDS.has(nd.kind) ? ["Calls and uses", "Called or used by"] : nd.kind === "file" || nd.kind === "dir" ? ["Imports", "Imported by"] : ["Links to", "Linked from"]);
const RUNS = ["python", "sage", "matlab", "magma"];
// (a notebook's cell in its room is read, not run here: it ran in its notebook, with the cells before it)
const runnable = (nd) => (nd.kind === "code" || nd.kind === "plot3d") && !nd.cell;
function showOverlay(nd) {
  let body = "";
  // (a guided tour's stop: its narration first, with Back, Next and End)
  const stop = tourStop(nd);
  if (stop) body += `<div class="tourcard"><div class="tourhead">${esc(stop.title)} · stop ${stop.i + 1} of ${stop.n}</div>` +
    `<div class="md">${markdown(String(stop.text ?? ""), { remote: false })}</div>` +
    `<div class="tourbar"><button data-tour="-1"${stop.i === 0 ? " disabled" : ""}>◀ Back</button><button data-tour="1" class="next">${stop.i + 1 < stop.n ? "Next ▶" : "Finish"}</button><button data-tour="end">End tour</button></div></div>`;
  // (a room to enter: a directory, a Python or Sage file, a class, a space)
  const ek = enterKind(nd);
  if (ek) body += `<div class="enterbar"><button class="enter" title="Enter it (Enter)">${ek === "import" ? "Go there ▶" : "Enter ▶"}</button><span class="hint">${esc(ek === "import" ? ENTER_HINT.import + ": " + importTarget(nd).path : ENTER_HINT[ek] ?? "")}</span></div>`;
  else if (noRoomWhy(nd)) body += `<div class="hint noroom">${esc(noRoomWhy(nd))}</div>`;
  else if (nd.kind === "import" && space.tree) body += `<div class="hint noroom">It isn't in the repository (the standard library, or a package from elsewhere).</div>`;
  // (what it is for, before what it says)
  if (nd.summary) body += `<div class="summary md">${markdown(String(nd.summary), { remote: false })}</div>`;
  if (nd.kind === "dir") body += `<div class="label">Inside</div><pre class="code">${esc(nd.text ?? "")}</pre>`;
  else if (ROOM_KINDS.has(nd.kind)) {
    body += `<div class="meta">${esc([nd.lang, nd.start ? `lines ${nd.start}–${nd.end}` : "", space.room?.path].filter(Boolean).join(" · "))}</div>` +
      `<pre class="code hljs"><code>${highlight(String(nd.text ?? ""), nd.lang ?? "")}</code></pre>` +
      (nd.kind === "import" && nd.names?.length ? `<div class="hint">Names it brings in: ${esc(nd.names.join(", "))}</div>` : "");
  } else if (nd.cell) {
    body += `<div class="meta">${esc([nd.lang, space.room?.path].filter(Boolean).join(" · "))}</div>` +
      `<pre class="code hljs"><code>${highlight(String(nd.text ?? ""), nd.lang ?? "")}</code></pre>` +
      `<div class="label">Output, as the notebook last showed it</div><div class="output">${outputHtml(nd)}</div>`;
  } else if (nd.kind === "note") body += `<div class="md">${markdown(String(nd.text ?? ""), { remote: false })}</div>`;
  else if (runnable(nd)) {
    const mode = RUNS.includes(nd.lang) ? nd.lang : nd.kind === "plot3d" ? "sage" : "python";
    body += `<div class="runbar"><select class="mode" title="The language">${RUNS.map((m) => `<option${m === mode ? " selected" : ""}>${m}</option>`).join("")}</select>` +
      `<button class="run" title="Run (Shift+Enter)">▶ Run</button><button class="stop" title="Stop" hidden>■ Stop</button><span class="runstate"></span></div>` +
      `<div class="code-edit"></div><p class="hint kept">Your edits and runs here are kept in this browser, on this site.</p><div class="label">Output</div><div class="output">${outputHtml(nd)}</div>` +
      (nd.kind === "plot3d" || nd.scene ? `<p class="hint">A 3D plot is a real object in the space: drag to turn around it. Edit its code and run it to change it.</p>` : "");
  } else {
    // (a file whose text is elsewhere (`src`): fetched now, and the drawer drawn again when it comes)
    const pending = nd.src && !nd._full;
    // (only if it is still this object, in this space: ids repeat from room to room)
    const still = () => selected === nd.id && space.nodes.includes(nd) && !$("#overlay").hidden;
    if (pending) fullText(nd).then(() => { if (still()) showOverlay(nd); }, (e) => {
      const h = $("#overlay .fetching");
      if (h && still()) h.textContent = "couldn't fetch its text: " + (e?.message ?? e);
    });
    const shown = String(nd.text ?? "").split("\n"), cut = shown.length > MAX_SHOWN;
    body += `<div class="meta">${esc(nd.lang ?? "")}${Number(nd.lines) > 0 ? " · " + Number(nd.lines) + " lines" : ""}</div>` +
      (pending && !nd.text ? `<div class="hint fetching">fetching its text…</div>` :
        `<pre class="code hljs"><code>${highlight(cut ? shown.slice(0, MAX_SHOWN).join("\n") : String(nd.text ?? ""), nd.lang ?? "")}</code></pre>`) +
      (cut ? `<div class="hint">(its first ${MAX_SHOWN} lines of ${shown.length})</div>` : !pending && shownLines(nd) < Number(nd.lines) ? `<div class="hint">(its first ${shownLines(nd)} lines of ${Number(nd.lines)})</div>` : "");
  }
  const links = (label, list) => list.length ? `<div class="label">${label} (${list.length})</div><ul class="links">${list.map((m) => `<li><a href="#" data-i="${space.nodes.indexOf(m)}">${esc(m.title)}</a></li>`).join("")}</ul>` : "";
  const [outL, inL] = linkLabels(nd);
  $("#overlay").innerHTML = `<div class="grip" title="Drag to resize"></div><button class="close" title="Close (Esc)">×</button><h2>${esc(nd.title)}</h2>${body}${links(outL, nd._out)}${links(inL, nd._in)}`;
  if (space.room) linkNames($("#overlay pre.code code"), nd);
  const eb = $("#overlay .enter");
  if (eb) eb.onclick = () => enterRoom(nd);
  grip($("#overlay .grip"));
  if (runnable(nd)) mountRunner(nd);
  typeset($("#overlay"));
  $("#overlay").hidden = false;
  document.body.classList.add("reading");
  $("#overlay").scrollTop = 0;
  viewOffset();
  $("#overlay .close").onclick = closeOverlay;
  for (const a of $("#overlay").querySelectorAll("a[data-i]")) a.onclick = (e) => { e.preventDefault(); openOverlay(space.nodes[+a.dataset.i]); };
  for (const b of $("#overlay").querySelectorAll("button[data-tour]")) b.onclick = () => (b.dataset.tour === "end" ? endTour() : tourStep(+b.dataset.tour));
  setSelected(nd.id);
  if (runningNode === nd) runState(nd, "running…", true);
}
// ---------------------------------------------------------------- guided tours (the space's `tours`): a path through
// objects, each stop with its narration; the drawer shows the stop, Next flies on (N and P too)
let tour = null; // ({ t: the tour, i: the stop shown, space: the space it is a tour of })
const toursOf = (s = space) => (Array.isArray(s?.tours) ? s.tours.filter((t) => t && Array.isArray(t.steps) && t.steps.length) : []);
function tourStop(nd) {
  if (!tour || space !== tour.space) return null;
  const st = tour.t.steps[tour.i];
  return st && st.node === nd.id ? { title: tour.t.title ?? "Tour", i: tour.i, n: tour.t.steps.length, text: st.text ?? "" } : null;
}
function startTour(t) {
  tour = { t, i: -1, space };
  tourStep(1);
}
// (delta 0: back to the stop shown, from wherever you went meanwhile)
function tourStep(delta) {
  if (!tour) return null;
  // (in a room entered during the tour: out to the tour's space first)
  if (space !== tour.space) {
    const k = scopes.findIndex((s) => s.space === tour.space);
    if (k < 0) { endTour(); return null; }
    leaveTo(k);
    if (space !== tour.space) return null; // (still entering a room: try again then)
  }
  const steps = tour.t.steps;
  let i = tour.i + delta;
  // (stops whose object isn't in the space are passed over)
  while (i >= 0 && i < steps.length && !space.nodes.some((n) => n.id === steps[i].node)) i += Math.sign(delta) || 1;
  if (i >= steps.length) { endTour(); return null; }
  if (i < 0) return null;
  tour.i = i;
  const nd = space.nodes.find((n) => n.id === steps[i].node);
  if (!xr.presenting) openOverlay(nd);
  renderTours();
  return { nd, ...tourStop(nd) };
}
function endTour() {
  tour = null;
  renderTours();
  tourPill();
  if (selected !== null && !$("#overlay").hidden) showOverlay(space.nodes.find((n) => n.id === selected));
}
function renderTours() {
  tourPill();
  const sel = $("#tour"), ts = toursOf(tour ? tour.space : space);
  sel.hidden = !ts.length;
  sel.innerHTML = `<option value="">${tour ? "On a tour: " + esc(tour.t.title ?? "") : "Guided tours…"}</option>` +
    ts.map((t, k) => `<option value="${k}">${esc(t.title ?? "Tour " + (k + 1))} (${t.steps.length} stops)</option>`).join("") +
    (tour ? `<option value="end">End the tour</option>` : "");
}
// (while on a tour, away from its stop (another object, a room): a pill says where the tour is, and goes back to it)
function tourPill() {
  const el = $("#tourpill");
  if (!el) return;
  const st = tour && tour.t.steps[tour.i];
  const atStop = !!st && space === tour.space && selected === st.node && !$("#overlay").hidden;
  el.hidden = !tour || atStop || tour.i < 0;
  if (el.hidden) return;
  el.innerHTML = `<span>On a tour: ${esc(tour.t.title ?? "Tour")} · stop ${tour.i + 1} of ${tour.t.steps.length}</span>` +
    `<button data-t="0" title="Back to the tour's stop">Back to the tour</button><button data-t="1" title="The next stop (N)">Next ▶</button><button data-t="end" title="End the tour">✕</button>`;
  for (const b of el.querySelectorAll("button")) b.onclick = () => (b.dataset.t === "end" ? endTour() : tourStep(+b.dataset.t));
}
$("#tour").onchange = () => {
  const v = $("#tour").value;
  if (v === "end") endTour();
  else if (v !== "") startTour(toursOf(tour ? tour.space : space)[+v]);
  else renderTours();
};

// (math: KaTeX, the site's /sagebrush-math.js, loaded the first time a note has some)
let mathModule = null;
function typeset(el) {
  if (!el.querySelector(".math[data-tex]")) return;
  // (a URL made here, so the bundler leaves the module to the browser: the site's own, as web/code/boot.ts loads its page)
  const url = new URL("/sagebrush-math.js", location.href).href;
  mathModule ??= import(url);
  mathModule.then((m) => m.typeset(el)).catch(() => {});
}
const shownLines = (nd) => String(nd.text ?? "").split("\n").length;
const isBase64 = (s) => typeof s === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
function closeOverlay() { $("#overlay").hidden = true; document.body.classList.remove("reading"); viewOffset(); if (space) setSelected(null); tourPill(); }
// (while the overlay covers the right of the screen, the view is shifted so what it is about stays in the free part)
// (on a phone the overlay is a sheet along the bottom: the view is shifted up instead)
const phone = matchMedia("(max-width: 700px)");
function viewOffset() {
  const r = $("#overlay").hidden ? null : $("#overlay").getBoundingClientRect();
  if (r && phone.matches) camera.setViewOffset(innerWidth, innerHeight, 0, (r.height + 8) / 2, innerWidth, innerHeight);
  else if (r) camera.setViewOffset(innerWidth, innerHeight, (r.width + 12) / 2, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener("resize", viewOffset);

// ---------------------------------------------------------------- rooms: entering an object
// A directory, a Python or Sage file, a class, or a space in a file is entered: it opens as a space of its own (a
// room: treeroom.js, pyroom.js), Back past where you entered leaves it, and the title shows the rooms you are in, each
// a way back out.  `scopes`: the spaces left on the way in, outermost first, with their places.
const scopes = [];
let spaceName = "", entering = false, focusNode = null; // (focusNode: what an import named, arrived at)
const MAX_SHOWN = 4000; // (lines of a file the drawer highlights)
const ENTER_HINT = { dir: "Its folders and files, and what imports what", python: "Its functions and classes, and what calls what",
  import: "Through to the file it imports", js: "Its functions and classes, and what calls what", class: "Its methods, and which calls which",
  space: "The space it holds" };
// (an import in a file's room, when the space knows the repository: the file it leads to, or null)
function importTarget(nd) {
  if (nd?.kind !== "import" || !space?.tree || space.room?.kind !== "file") return null;
  const from = String(space.room.path), lang = codeOf(from);
  if (lang === "js") return jsResolve ? jsResolve(space.tree, from, nd.js?.spec ?? String(nd.title)) : null;
  return resolveImport(space.tree, from, String(nd.title), nd.imported ?? []);
}
// (why a file has no room: its language has no parser here yet)
function noRoomWhy(nd) {
  if (nd?.kind !== "file" || enterKind(nd)) return null;
  if (nd.doc === "board" || nd.doc === "notebook") return "No room for it yet: open it in its editor.";
  const lang = nd.lang || "";
  const NAMES = { matlab: "MATLAB", magma: "Magma", rust: "Rust" };
  const name = /\.(pyx|pxd|pxi)$/.test(String(nd.path ?? nd.title ?? "")) ? "Cython" : NAMES[lang];
  return name ? `No room for ${name} files yet: Python, Sage, JavaScript and TypeScript files can be entered so far.` : null;
}
// (what can be entered: a folder of the space's tree, a file of a language with a parser here, a class in a file's
//  room, an import that leads to a file of the tree, and a space in a file)
function enterKind(nd) {
  if (!nd) return null;
  if (importTarget(nd)) return "import";
  if (nd.enter?.kind === "dir" && space?.tree) return "dir";
  if (nd.enter?.kind === "class" && typeof space?._text === "string") return "class";
  if (nd.kind !== "file") return null;
  const p = String(nd.path ?? nd.title ?? "");
  // (a file is parsed whole: its text fetched from `src`, or all of it in the space)
  const whole = !!nd.src || !(Number(nd.lines) > shownLines(nd));
  // (by its name; by its language only when its title isn't a file name: a .pyx is Cython, which Python's grammar refuses)
  if ((/\.(py|sage)$/.test(p) || (!/\.\w+$/.test(p) && (nd.lang === "python" || nd.lang === "sage"))) && whole) return "python";
  if (codeOf(p) && whole) return codeOf(p);
  if (/\.space\.json$/.test(p) && whole) return "space";
  return null;
}
// (the JS import resolver: set when its module first loads, enterRoom)
let jsResolve = null;
async function loadResolvers() {
  if (codeOf(String(space?.room?.path ?? "")) === "js" && !jsResolve) jsResolve = (await import("./jsroom.js")).resolveJs;
}
// (a file's whole text: from its `src` (a file of this site), once; the faces drawn again with it)
const fetched = new Map();
async function fullText(nd) {
  if (!nd.src || nd._full) return String(nd.text ?? "");
  const url = sameSite(nd.src);
  if (!fetched.has(url.href)) fetched.set(url.href, readText(url));
  let text;
  try { text = await fetched.get(url.href); } catch (e) { fetched.delete(url.href); throw e; }
  nd.text = text; nd._full = true;
  const o = objects[space.nodes.indexOf(nd)];
  if (o) { for (const t of o.userData.tex) t?.dispose(); o.userData.tex = []; o.userData.level = -1; }
  return text;
}
async function roomFor(nd, k) {
  if (k === "dir") return checkSpace(treeRoom(space.tree, nd.enter.path));
  if (k === "import") {
    // (through the portal: the imported file's own room, its text read as any file's, from this site)
    const { path, sub } = importTarget(nd), tree = space.tree;
    const target = { kind: "file", path, title: path, lang: codeOf(path) ?? "", text: "", src: tree.base + path.split("/").map(encodeURIComponent).join("/") };
    const text = await fullText(target);
    const r = await codeRoom(text, path);
    r._text = text; r.tree = tree;
    // (one name taken from a module (not a submodule of it): arriving at it)
    if (!sub && (nd.imported ?? []).length === 1) r._focus = nd.imported[0];
    return r;
  }
  if (k === "space") {
    const s = checkSpace(JSON.parse(await fullText(nd)));
    if (!(Array.isArray(s.nodes) || s.tree)) throw new Error("it has no objects");
    return s;
  }
  // (a file, or a class (a module, a function) in the file whose room this is)
  const text = k === "class" ? space._text : await fullText(nd);
  const path = k === "class" ? space.room.path : String(nd.path ?? nd.title);
  const scope = k === "class" ? (nd.enter.scope ?? [nd.enter.name]) : null;
  const r = await codeRoom(text, path, scope, k === "class" ? space.room.lang : nd.lang);
  r._text = text;
  // (the repository goes along, so its imports lead on)
  if (space.tree) r.tree = space.tree;
  return r;
}
async function enterRoom(nd) {
  const k = enterKind(nd);
  if (!k || entering) return false;
  entering = true;
  $("#status").textContent = "entering " + shortTitle(nd) + "…";
  const from = space, P = P3 ? Float64Array.from(P3) : null;
  let pushed = false;
  try {
    const room = await roomFor(nd, k);
    // (the space changed while the file was fetched or parsed (an agent wrote it, another space was picked): not entered)
    if (space !== from) return false;
    // (where Back will bring you out: here; in a headset, where the camera is isn't a place in the space, so the outer
    //  space's view of everything)
    const here = xr.presenting ? (() => { const h = homeView(positions); return { pos: h.to.clone(), target: h.toT.clone(), sel: null }; })() : viewNow();
    scopes.push({ space: from, P });
    history.push({ ...here, leave: true });
    future.length = 0;
    pushed = true;
    await load(spaceName, room, false, { room: true });
    await loadResolvers();
    if (!$("#overlay").hidden && selected !== null) showOverlay(space.nodes.find((n) => n.id === selected));
    xr.roomChanged();
    focusNode = room._focus ? space.nodes.find((n) => n.name === room._focus) ?? null : null;
    if (focusNode && !xr.presenting) openOverlay(focusNode);
    return true;
  } catch (e) {
    if (pushed) {
      // (half in: back out to where you were)
      scopes.pop();
      const k2 = history.findLastIndex((v) => v.leave);
      if (k2 >= 0) history.length = k2;
      try { await load(spaceName, from, false, { room: true, P }); } catch {}
    }
    $("#status").textContent = "couldn't enter " + shortTitle(nd) + ": " + (e?.message ?? e);
    return false;
  } finally {
    entering = false;
  }
}
// (out of the room you are in, to the space around it, as it was; returns where you were in it when you entered)
function leaveRoom() {
  if (entering) return null;
  const s = scopes.pop();
  if (!s) return null;
  const k = history.findLastIndex((v) => v.leave);
  const v = k >= 0 ? history[k] : null;
  if (k >= 0) history.length = k;
  future.length = 0;
  // (given the space itself, load runs to its end at once)
  load(spaceName, s.space, false, { room: true, P: s.P }).catch(fail);
  xr.roomChanged();
  return v ?? { pos: camera.position.clone(), target: controls.target.clone(), sel: null };
}
function leaveTo(k) {
  if (entering) return;
  let v = null;
  while (scopes.length > k) v = leaveRoom() ?? v;
  if (v) flyToView(v.pos, v.target);
}
function labelOf(s) {
  const r = s.room;
  if (!r) return s.title ?? spaceName;
  if (r.kind === "dir") return r.path ? r.path.split("/").pop() + "/" : s.tree?.name ?? s.title ?? "the top";
  if (r.kind === "file") return String(r.path).split("/").pop();
  // (a Python class by its name; an impl block, trait, module, JS class or function as it is called)
  if (r.kind === "class") return /^(impl|trait|mod|class) |\(\)$/.test(String(r.name)) ? String(r.name) : "class " + r.name;
  if (r.kind === "notebook") return String(r.path).split("/").pop();
  return s.title ?? "";
}
const roomPath = () => [...scopes.map((s) => labelOf(s.space)), labelOf(space)].join(" › ");
// (the title: the rooms you are in, each a link back out to it)
function crumbs() {
  const all = [...scopes.map((s) => s.space), space];
  $("#title").innerHTML = all.map((s, k) => (k < all.length - 1 ? `<a href="#" data-k="${k}">${esc(labelOf(s))}</a>` : `<span>${esc(labelOf(s))}</span>`)).join(" › ");
  $("#title").title = space.summary ? texToText(space.summary) : "";
  for (const a of $("#title").querySelectorAll("a[data-k]")) a.onclick = (e) => { e.preventDefault(); leaveTo(+a.dataset.k); };
}
// (in a room's code: each name of another object in it a link there; not inside strings and comments)
function linkNames(code, nd) {
  if (!code) return;
  const names = new Map();
  space.nodes.forEach((m, i) => {
    if (m !== nd && m.name && !names.has(m.name)) names.set(m.name, i);
    if (m.kind === "import" || m.kind === "block") for (const n of m.names ?? []) if (n !== "*" && !names.has(n)) names.set(n, i);
  });
  if (!names.size) return;
  const plain = [...names.keys()].filter((n) => /^\w+$/.test(n));
  // (and in a class's room, a method named through self or cls)
  const own = space.room?.kind === "class" ? "|(?<=\\b(?:self|cls)\\.)(\\w+)(?!\\w)" : "";
  const re = new RegExp(`(?<![\\w.])(${plain.length ? plain.join("|") : "(?!)"})(?!\\w)${own}`, "g");
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT), texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const t of texts) {
    if (t.parentElement.closest(".hljs-string, .hljs-comment")) continue;
    const s = t.nodeValue, frag = document.createDocumentFragment();
    let at = 0, any = false;
    for (const m of s.matchAll(re)) {
      const name = m[1] ?? m[2], i = names.get(name);
      if (i === undefined) continue;
      any = true;
      frag.append(s.slice(at, m.index));
      const a = Object.assign(document.createElement("a"), { href: "#", className: "ref", textContent: name, title: "Go to " + space.nodes[i].title });
      a.dataset.i = i;
      frag.append(a);
      at = m.index + name.length;
    }
    if (!any) continue;
    frag.append(s.slice(at));
    t.replaceWith(frag);
  }
}

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
// (kept by keep.js: in this browser, on this site, within its byte limits)
const keyOf = (nd) => `${EDIT}${$("#space").value}:${nd.id}`;
const fileText = (nd) => (nd._file ? nd._file.text : String(nd.text ?? ""));
function save(nd) {
  const edited = String(nd.text ?? "") !== fileText(nd);
  const v = { base: fileText(nd), text: edited ? nd.text : null, ...Object.fromEntries(KEEP.map((k) => [k, nd[k] ?? null])) };
  keepEdit(localStorage, keyOf(nd), { at: Date.now(), ...v });
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
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); try { localStorage.setItem("space3d:overlay-width", $("#overlay").style.width); } catch {} };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
}
try { const w = localStorage.getItem("space3d:overlay-width"); if (w) $("#overlay").style.width = w; } catch {}

// the theme: Auto, Light, Dark (kept for the next visit); a change redraws the faces and labels in its colors
function applyTheme() {
  const name = themeName();
  T = THEMES[name];
  paintGround();
  paintTerraces();
  document.documentElement.dataset.theme = name;
  $("#theme").textContent = "Theme: " + themeSetting[0].toUpperCase() + themeSetting.slice(1);
  scene.background.set(T.bg);
  scene.fog.color.set(T.bg);
  edgeColors();
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
  try { localStorage.setItem("space3d:theme", themeSetting); } catch {}
  applyTheme();
};
darkQuery.addEventListener("change", () => themeSetting === "auto" && applyTheme());
applyTheme();

// the controls folded away to the title and Back (a phone starts so; kept for the next visit)
function setFold(on) {
  document.body.classList.toggle("folded", on);
  $("#fold").textContent = on ? "▾" : "▴";
  $("#fold").title = on ? "Show the controls" : "Hide the controls";
  $("#fold").setAttribute("aria-expanded", String(!on));
}
{
  let pref = null;
  try { pref = localStorage.getItem("space3d:folded"); } catch {}
  setFold(pref === null ? phone.matches : pref === "1");
}
$("#fold").onclick = () => {
  const on = !document.body.classList.contains("folded");
  setFold(on);
  try { localStorage.setItem("space3d:folded", on ? "1" : "0"); } catch {}
};
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
  // (Esc with nothing open, in a frame the page opened over itself (Open in 3D): the page closes it)
  if (e.key === "Escape" && helpShown) showHelp(false);
  else if (e.key === "Escape" && $("#overlay").hidden && embedded) window.parent.postMessage({ sagebrush: "space-close", version: 1 }, location.origin);
  else if (e.key === "Escape") closeOverlay();
  else if (e.key === "Enter" && selected !== null && !$("#overlay").hidden && !/^(A|BUTTON)$/.test(document.activeElement?.tagName ?? "")) { const nd = space.nodes.find((n) => n.id === selected); if (enterKind(nd)) enterRoom(nd); }
  else if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
  else if (e.key === "b" || e.key === "B" || e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) back();
  else if (e.key === "f" || e.key === "F" || (e.altKey && e.key === "ArrowRight")) forward();
  else if (e.key === "h" || e.key === "H") space && frame(positions, true);
  else if (e.key === "g" || e.key === "G") setDeskWalk(!deskWalk);
  else if (e.key === " " && deskWalk && !xr.presenting) { e.preventDefault(); if (vy === 0 && Math.abs(feetY() - supportAt()) < 0.05) vy = 26; }
  else if (e.key === "?") showHelp(!helpShown);
  else if ((e.key === "n" || e.key === "N") && tour) tourStep(1);
  else if ((e.key === "p" || e.key === "P") && tour) tourStep(-1);
});


// ---------------------------------------------------------------- walking (with a mouse, the default)
// You stand on the floor, your eye EYE_H above your feet (1.6 m at the headset's scale). Drag to look around; W A S D
// or the arrows walk (Shift: faster); Space jumps; gravity brings you down. A move to an object, Back, See all: a blink
// (a quick fade); where it leaves you above the floor, you stand on a small platform there until you step off it.
// Click the floor to go there. G, or the Walk button: flying instead (drag to orbit, scroll to zoom, E and Q up and
// down), as on a phone, where flying is the default.
const EYE_H = EYE;
let deskWalk = (() => { try { const v = localStorage.getItem("space3d:move"); if (v) return v === "walk"; } catch {} return matchMedia("(pointer: fine)").matches; })();
let vy = 0, platform = null; // (vy: falling or jumping; platform: { x, z, y (feet), r } where a blink left you)
const feetY = () => camera.position.y - EYE_H;
function supportAt() {
  const g = groundAt(camera.position.x, camera.position.z);
  if (platform && feetY() >= platform.y - 0.05 && platform.y > g && Math.hypot(camera.position.x - platform.x, camera.position.z - platform.z) < platform.r) return platform.y;
  return g;
}
// (after a blink: you stand where it left you: on a platform above the ground, or on the ground (raised to it if below))
function land() {
  const f = feetY(), g = groundAt(camera.position.x, camera.position.z);
  if (f > g + 0.5) platform = { x: camera.position.x, z: camera.position.z, y: f, r: 7 };
  else { platform = null; camera.position.y += g - f; controls.target.y += g - f; }
  vy = 0;
}
function setDeskWalk(on) {
  deskWalk = !!on;
  try { localStorage.setItem("space3d:move", deskWalk ? "walk" : "fly"); } catch {}
  controls.enabled = !deskWalk && !xr.presenting;
  controls.enableDamping = !deskWalk; // (no orbit left drifting while you look around)
  floorMark.visible = false;
  $("#move").textContent = deskWalk ? "Walking (G)" : "Flying (G)";
  $("#move").title = deskWalk ? "Walking on the floor: drag to look, W A S D to walk, Space to jump, click the floor to go there. G: fly instead" : "Flying: drag to turn around, scroll to zoom, W A S D and E Q to fly. G: walk instead";
  if (deskWalk) land();
}
// (looking around: a drag turns your head, about where you stand)
function look(dx, dy) {
  const dir = new THREE.Vector3().subVectors(controls.target, camera.position);
  const sph = new THREE.Spherical().setFromVector3(dir);
  sph.radius = Math.max(4, Math.min(30, sph.radius));
  sph.theta -= dx * 0.005;
  sph.phi = Math.max(0.12, Math.min(Math.PI - 0.12, sph.phi + dy * 0.005));
  controls.target.copy(camera.position).add(new THREE.Vector3().setFromSpherical(sph));
  flight = null;
}
renderer.domElement.addEventListener("pointermove", (ev) => {
  if (deskWalk && !xr.presenting && (ev.buttons & 1) && ev.pointerType === "mouse") look(ev.movementX, ev.movementY);
});
// (a touch while walking: flying, which is how touch moves (drag to turn, pinch to zoom))
renderer.domElement.addEventListener("pointerdown", (ev) => { if (deskWalk && ev.pointerType === "touch") setDeskWalk(false); });
renderer.domElement.addEventListener("wheel", (ev) => {
  if (!deskWalk || xr.presenting) return;
  ev.preventDefault();
  walkBy(-Math.sign(ev.deltaY) * 3, 0);
}, { passive: false });
function walkBy(forward, sideways) {
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
  const m = fwd.multiplyScalar(forward).addScaledVector(right, sideways);
  // (up a step, yes; into a terrace's side, no: along it, if one way is open; in short steps, a stair at a time)
  const n = Math.max(1, Math.ceil(Math.hypot(m.x, m.z) / 0.3)), x0 = camera.position.x, z0 = camera.position.z;
  let f = feetY(), x = x0, z = z0;
  const ok = (dx, dz) => groundAt(x + dx, z + dz) <= f + STEP + 0.05;
  for (let k = 0; k < n; k++) {
    let dx = m.x / n, dz = m.z / n;
    if (!ok(dx, dz)) { if (ok(dx, 0)) dz = 0; else if (ok(0, dz)) dx = 0; else break; }
    x += dx; z += dz; f = Math.max(f, groundAt(x, z));
  }
  m.set(x - x0, 0, z - z0);
  camera.position.add(m);
  controls.target.add(m);
  flight = null;
}
function stepWalk(dt) {
  if (!typing()) {
    let f = 0, r = 0;
    for (const k of held) { const v = FLY[k]; if (v) { f += v[2]; r += v[0]; } }
    if (f || r) {
      const n = Math.hypot(f, r), speed = 18 * (held.has("shift") ? 3 : 1) * dt;
      walkBy((f / n) * speed, (r / n) * speed);
    }
  }
  // (gravity: down to what is under you; up onto the floor if it came up)
  const sup = supportAt(), f0 = feetY();
  if (f0 > sup + 1e-3 || vy > 0) {
    vy -= 70 * dt;
    let f1 = f0 + vy * dt;
    if (f1 <= sup) { f1 = sup; vy = 0; }
    camera.position.y += f1 - f0; controls.target.y += f1 - f0;
  } else if (f0 < sup - 1e-3) {
    camera.position.y += sup - f0; controls.target.y += sup - f0; vy = 0;
  }
}
// (clicking the floor: going there, facing as you were; the ring shows where)
const floorMark = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.3, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1f6feb, transparent: true, opacity: 0.75, depthWrite: false }));
floorMark.visible = false;
scene.add(floorMark);
function floorAt(ev) {
  mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const h = ray.intersectObjects(walkable(), false)[0];
  return h && h.distance < 600 ? h.point.clone().setY(groundAt(h.point.x, h.point.z)) : null;
}
function goToFloor(p) {
  pushView();
  const dir = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  const to = new THREE.Vector3(p.x, p.y + EYE_H, p.z);
  flyToView(to, to.clone().add(dir.normalize().multiplyScalar(10)), 600);
}

// ---------------------------------------------------------------- search: full text, click to fly there
let docs = [];
function buildIndex() {
  docs = space.nodes.map((n, i) => ({ i, title: (n.title ?? "").toLowerCase(), all: [n.title, n.summary, n.text, n.output, n.group].join("\n").toLowerCase() }));
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
    if (e.source !== window.parent || e.origin !== location.origin || m?.version !== 1) return;
    if (m.sagebrush !== "space-load") return;
    const name = String(m.name ?? "space");
    const again = name === current;
    if (!again) $("#space").innerHTML = `<option selected>${esc(name)}</option>`;
    current = name;
    load(name, m.space, again).then(() => {
      if (!again && typeof m.selected === "string") setTimeout(() => window.space3d.select(m.selected), 300);
    }, fail);
  });
  window.parent.postMessage({ sagebrush: "space-ready", version: 1 }, location.origin);
}
async function start() {
  if (embedded) return embed();
  const list = await (await fetch("spaces.json")).json().catch(() => []);
  const want = new URLSearchParams(location.search).get("space") ?? (list.includes("intro.space.json") ? "intro.space.json" : list[0]);
  const sel = $("#space");
  sel.innerHTML = list.map((f) => `<option${f === want ? " selected" : ""}>${esc(f)}</option>`).join("");
  sel.onchange = () => { window.history.replaceState(null, "", "?space=" + encodeURIComponent(sel.value)); load(sel.value).catch(fail); };
  // (#sel=ID: that object selected, as an agent or a link left it)
  const wantSel = /#sel=([^&]+)/.exec(location.hash)?.[1];
  await load(want);
  if (wantSel) setTimeout(() => window.space3d.select(decodeURIComponent(wantSel)), 300);
}
function fail(e) { $("#status").textContent = "couldn't load: " + (e?.message ?? e); }
start().catch(fail);

// ---------------------------------------------------------------- a headset: none here yet
// (what the rest of the page asks of one: never presenting)
const xr = { presenting: false, step() {}, roomChanged() {} };
// (walking or flying, as kept)
setDeskWalk(deskWalk);
$("#move").onclick = () => setDeskWalk(!deskWalk);
// (the help card: how to move, and the keys)
let helpShown = false;
function showHelp(on) { helpShown = !!on; $("#helpcard").hidden = !helpShown; }
$("#helpbtn").onclick = () => showHelp(!helpShown);
$("#helpcard .close").onclick = () => showHelp(false);
let lastTick = performance.now();
function tick(now) {
  const dt = Math.max(0, Math.min(0.1, (now - lastTick) / 1000));
  lastTick = now;
  if (xr.presenting) xr.step(dt);
  else {
    stepFlight(now);
    if (deskWalk) { if (!flight && !morph) stepWalk(dt); lastFly = now; } else stepFly(now);
    // (no blink under way (cancelled by a look, a step, a switch): no darkness either)
    if (!(deskWalk && flight?.ms > 1)) $("#fade").style.opacity = "0";
    controls.update();
  }
  stepMorph(now);
  if (space) { stepZoom(); stepLandmarks(); stepGlyphs(dt); }
  renderer.render(scene, camera);
}
// (the renderer's loop: the browser's frames, or the headset's while in VR)
renderer.setAnimationLoop(tick);
// (for tests and the curious: the loaded space and the camera)
// (the API for an agent driving the page, and for tests: what is selected, select an object (and fly to it), the
// space, Back and Forward)
window.space3d = {
  get space() { return space; }, get objects() { return objects; }, camera, controls,
  // (a space given directly: checked as one read from a file)
  load: (s, name = "space") => load(String(name), s),
  get selection() { return selectionOf(selected); },
  select(id) { const nd = space?.nodes.find((n) => n.id === id); if (!nd) return false; openOverlay(nd); return true; },
  back, forward, frame: () => frame(positions, true), flyTo,
  // (rooms: enter the object with this id; leave the room you are in; where you are)
  enter(id) { const nd = space?.nodes.find((n) => n.id === id); return nd ? enterRoom(nd) : Promise.resolve(false); },
  leave() { const v = leaveRoom(); if (v) flyToView(v.pos, v.target); return !!v; },
  get room() { return scopes.length ? roomPath() : null; },
  get floorY() { return floorY; },
  groundAt: (x, z) => groundAt(x, z),
  get grounded() { return onGround(); },
  setGround: (on) => setGround(!!on),
  get terraces() { return blocks.length; },
  get floorLinks() { return floorEdges; },
  get walking() { return deskWalk; },
  get feet() { return feetY(); },
};
