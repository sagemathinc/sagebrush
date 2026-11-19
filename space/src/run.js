// Running code in the space: Sagebrush's own engine (Python, Sage, MATLAB, Magma) in a Web Worker, started at the
// first Run.  The notebook component and the worker come from the page's own origin (serve.mjs fetches them from
// Sagebrush's site; deployed under that site, they are simply there).  A 3D plot's scene becomes a real object.
import * as THREE from "three";

let kernelP = null;
export function engine() {
  if (!kernelP) {
    // (not bundled: the engine is Sagebrush's, loaded from where the page is)
    const url = "/sagebrush-notebook.js";
    kernelP = import(/* @vite-ignore */ url).then((m) => {
      const k = new m.WorkerKernel({ createWorker: () => new Worker("/sagebrush-worker.js", { type: "module" }) });
      k.start();
      return k;
    });
    kernelP.catch(() => (kernelP = null));
  }
  return kernelP;
}

/** Run code; `on.update(result)` as output arrives; resolves with {out, error, displays, ms, stopped} */
export async function run(code, mode, on = {}) {
  const k = await engine();
  return new Promise((resolve) => {
    const r = { out: "", error: false, displays: [], ms: 0, stopped: null };
    const tell = () => on.update?.(r);
    k.execute(code, { mode }, {
      start() { on.start?.(); },
      out(text, isError) { r.out += text; if (isError) r.error = true; tell(); },
      display(bundle) { r.displays.push(bundle); tell(); },
      interact() {},
      clear() { r.out = ""; r.displays = []; tell(); },
      done(ms) { r.ms = ms; resolve(r); },
      stopped(message) { r.stopped = message; r.error = true; resolve(r); },
      skipped() { r.stopped = "not run"; resolve(r); },
    });
  });
}
export function interrupt() { kernelP?.then((k) => k.interrupt()); }

export const SCENE = "application/vnd.sagebrush.scene3d+json";

// a Sagebrush 3D scene (lib/sage_plot3d.py _scene: meshes, lines, points) as three.js objects, fitted into a box of
// `size` across, its lowest point at z = 0
export function sceneObject(scene, size = 4.6) {
  const g = new THREE.Group(), inner = new THREE.Group();
  const lo = scene.lo ?? [0, 0, 0], hi = scene.hi ?? [1, 1, 1];
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-9);
  const s = size / span;
  inner.scale.setScalar(s);
  inner.position.set(-(lo[0] + hi[0]) / 2 * s, -(lo[1] + hi[1]) / 2 * s, -lo[2] * s + 0.15);
  for (const o of scene.objects ?? []) {
    const pos = new THREE.Float32BufferAttribute(o.pos ?? [], 3);
    if (o.type === "mesh") {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", pos);
      if (o.idx) geo.setIndex(o.idx);
      if (o.colors) geo.setAttribute("color", new THREE.Float32BufferAttribute(o.colors.map((v) => v / 255), 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: o.colors ? 0xffffff : o.color ?? "#4a7fd0", vertexColors: !!o.colors, side: THREE.DoubleSide,
        roughness: 0.55, metalness: 0.05, transparent: (o.opacity ?? 1) < 1, opacity: o.opacity ?? 1, flatShading: !!o.flat });
      inner.add(new THREE.Mesh(geo, mat));
    } else if (o.type === "lines") {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", pos);
      inner.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: o.color ?? "#333333" })));
    } else if (o.type === "points") {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", pos);
      inner.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: o.color ?? "#333333", size: (o.size ?? 6) / 60, sizeAttenuation: true })));
    }
  }
  g.add(inner);
  return g;
}
