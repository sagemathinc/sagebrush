// The canvas view of a graph's picture (Graph.plot's
// application/vnd.sagebrush.graph+json, lib/_sage_graph.py GraphPlot):
// drawn over the SVG the notebook shows, which stays for saving, agents and
// when this cannot start. Vertices can be dragged; the background pans; the
// wheel zooms; "Lay out again" animates web/graph/spring.ts's layout with the
// vertices a person moved held where they put them (with none moved, it ends
// where the picture began: the same layout, seed and scale as Python's).
//
//   window.SagebrushGraphView.mount(figure, json)   true if the view started
//
// The data is untrusted (a saved notebook's): check() refuses anything but
// the shape below, within the spring layout's caps, before anything is drawn.
// Text is drawn with fillText, never as markup.

import { springSteps, MAX_NODES, MAX_EDGES, type SpringNode } from "./spring.ts";

export type GraphNode = { label: string | null; x: number; y: number; color: string };
export type GraphEdge = { s: number; t: number; color: string; label: string | null };
export type GraphData = {
  format: 1;
  directed: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  radius: number;
  thickness: number;
  dash: string;
  loop: number;
  offset: number;
  label_background: string | null;
  spring: boolean;
  iterations: number | null;
  range: [number, number, number, number];
};

class Refused extends Error {}
const no = (why: string): never => {
  throw new Refused(why);
};
const MAX_LABEL = 200;
/** The longest graph text parsed: a graph at the caps, every label at
 * MAX_LABEL, is under 6 million characters (HARD-4D6-1). */
export const MAX_JSON = 8_000_000;
const MAX_COLOR = 64;
// (a CSS colour as Python's to_color gives it: a hex colour, a name, or rgb()/rgba() of numbers)
const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|rgba?\(\s*[0-9.]+%?\s*(,\s*[0-9.]+%?\s*){2,3}\))$/;
const DASHES: Record<string, number[]> = { "-": [], "--": [6, 4], ":": [1.5, 3], "-.": [6, 3, 1.5, 3] };

const num = (v: unknown, what: string, lo = -1e12, hi = 1e12): number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : no(what + " is not a number in range");
const color = (v: unknown, what: string): string => (typeof v === "string" && v.length <= MAX_COLOR && COLOR.test(v) ? v : no(what + " is not a colour"));
const label = (v: unknown, what: string): string | null =>
  v === null ? null : typeof v === "string" && v.length <= MAX_LABEL ? v : no(what + " is not a short string");

/** The data, checked: its shape, numbers finite and in range, colours CSS
 * colours, labels short strings, at most MAX_NODES vertices and MAX_EDGES
 * edges whose ends are vertices. */
export function check(raw: unknown): GraphData {
  const d = (raw ?? no("is empty")) as any;
  if (typeof d !== "object" || d.format !== 1) no("is not format 1");
  if (!Array.isArray(d.nodes) || d.nodes.length > MAX_NODES) no("has more than " + MAX_NODES + " vertices");
  if (!Array.isArray(d.edges) || d.edges.length > MAX_EDGES) no("has more than " + MAX_EDGES + " edges");
  const n = d.nodes.length;
  const nodes = d.nodes.map((v: any, i: number) => ({
    label: label(v?.label, "vertex " + i + "'s label"), x: num(v?.x, "a position"), y: num(v?.y, "a position"), color: color(v?.color, "a vertex colour"),
  }));
  const end = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < n ? (v as number) : no("has an edge to no vertex"));
  const edges = d.edges.map((e: any, i: number) => ({ s: end(e?.s), t: end(e?.t), color: color(e?.color, "an edge colour"), label: label(e?.label, "edge " + i + "'s label") }));
  const r = d.range;
  if (!Array.isArray(r) || r.length !== 4) no("has no range");
  const range = r.map((v: unknown) => num(v, "the range")) as [number, number, number, number];
  if (!(range[1] > range[0]) || !(range[3] > range[2])) no("has an empty range");
  if (typeof d.dash !== "string" || !(d.dash in DASHES)) no("has an unknown edge style");
  return {
    format: 1, directed: d.directed === true, nodes, edges,
    radius: num(d.radius, "the vertex size", 0, 200), thickness: num(d.thickness, "the edge thickness", 0, 50), dash: d.dash,
    loop: num(d.loop, "the loop size", 0, 1e6), offset: num(d.offset, "the offset", 0, 1e6),
    label_background: d.label_background === null ? null : color(d.label_background, "the label background"),
    spring: d.spring === true, range,
    iterations: d.iterations === null || d.iterations === undefined ? null : num(d.iterations, "the iterations", 0, 1e15),
  };
}

// (Python's layout of the spring's positions, lib/_sage_graph.py _spring_pos:
// vertices as 20-unit boxes, divided by 64, y up; and back)
const BOX = 20, SCALE = 64;
const toSpring = (x: number, y: number) => ({ x: x * SCALE - BOX / 2, y: -y * SCALE - BOX / 2 });
const fromSpring = (p: { x: number; y: number }) => ({ x: (p.x + BOX / 2) / SCALE, y: -(p.y + BOX / 2) / SCALE });

/** data: the graph's text (refused past MAX_JSON characters before it is
 * parsed), or its JSON as a saved notebook keeps it, which check() reads
 * property by property, never serialized. */
export function mount(fig: HTMLElement, data: unknown): boolean {
  const fallback = fig.querySelector("svg") as SVGSVGElement | null;
  const explain = (why: string) => {
    const p = document.createElement("p");
    p.className = "sbgraph-why";
    p.style.cssText = "margin:4px 0;font-size:13px;opacity:.75";
    p.textContent = why;
    fig.appendChild(p);
    return false;
  };
  let g: GraphData;
  try {
    if (typeof data === "string") {
      if (data.length > MAX_JSON) no("is more than " + MAX_JSON + " characters");
      data = JSON.parse(data);
    }
    g = check(data);
  } catch (e) {
    return explain("This is a still picture: the interactive view was not shown, because the graph " + (e instanceof Refused ? e.message : "is malformed") + ".");
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return explain("This is a still picture: this browser gave no canvas to draw on.");
  const wrap = document.createElement("div");
  wrap.className = "sbgraph";
  wrap.style.cssText = "position:relative;max-width:640px";
  canvas.style.cssText = "display:block;width:100%;aspect-ratio:4/3;touch-action:none;cursor:grab;background:#fff";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", fallback?.getAttribute("aria-label") ?? "A graph");
  canvas.tabIndex = 0;
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;margin-top:4px;font-size:13px";
  const button = (text: string, title: string, f: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.onclick = f;
    bar.appendChild(b);
    return b;
  };
  wrap.append(canvas, bar);

  // the view: data coordinates to CSS pixels, aspect 1, the data's range
  // fitted to the canvas, then the person's pan (tx, ty) and zoom (k)
  const original = g.nodes.map((v) => ({ x: v.x, y: v.y }));
  const range0 = [...g.range] as GraphData["range"];
  const pinned = new Set<number>();
  let k = 1, tx = 0, ty = 0;
  let W = 640, H = 480, base = 1, ox = 0, oy = 0;
  const fit = () => {
    const [x0, x1, y0, y1] = g.range;
    base = Math.min(W / (x1 - x0), H / (y1 - y0));
    ox = (W - (x1 - x0) * base) / 2 - x0 * base;
    oy = (H - (y1 - y0) * base) / 2 + y1 * base;
  };
  const sx = (x: number) => (x * base + ox) * k + tx;
  const sy = (y: number) => (-y * base + oy) * k + ty;
  const dx = (px: number) => ((px - tx) / k - ox) / base;
  const dy = (py: number) => -(((py - ty) / k - oy) / base);

  // (both arrows of u -> v and v -> u apart, as Python draws them: each to
  // its left by 1.2% of the vertices' extent, which a translation does not
  // change, CORR-4D6-3)
  let pairs = new Set<string>(), off = 0;
  const geometry = () => {
    pairs = new Set(g.edges.map((e) => e.s + "," + e.t));
    if (!g.nodes.length) return;
    const xs = g.nodes.map((v) => v.x), ys = g.nodes.map((v) => v.y);
    off = 0.012 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-9);
  };
  const dataEnds = (e: GraphEdge): [number, number, number, number] => {
    const a = g.nodes[e.s], b = g.nodes[e.t];
    if (!(g.directed && pairs.has(e.t + "," + e.s))) return [a.x, a.y, b.x, b.y];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / L) * off, ny = ((b.x - a.x) / L) * off;
    return [a.x + nx, a.y + ny, b.x + nx, b.y + ny];
  };

  function draw() {
    geometry();
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width || 640;
    H = rect.height || 480;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    fit();
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#fff";
    c.fillRect(0, 0, W, H);
    const r = g.radius;
    const ends = (e: GraphEdge) => {
      const [ax, ay, bx, by] = dataEnds(e);
      return [sx(ax), sy(ay), sx(bx), sy(by)];
    };
    c.lineWidth = g.thickness * 0.9;
    c.setLineDash(DASHES[g.dash]);
    for (const e of g.edges) {
      c.strokeStyle = c.fillStyle = e.color;
      if (e.s === e.t) {
        const v = g.nodes[e.s];
        c.beginPath();
        // (radius loop_size, through its vertex, up and to its left, as Python draws it)
        c.arc(sx(v.x - g.loop / Math.SQRT2), sy(v.y + g.loop / Math.SQRT2), g.loop * base * k, 0, 2 * Math.PI);
        c.stroke();
        continue;
      }
      const [ax, ay, bx, by] = ends(e);
      if (!g.directed) {
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
        continue;
      }
      // (the head stops at its vertex's marker, as the SVG's arrowshorten)
      const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
      const cut = Math.min(r + 1, L), hx = bx - ux * cut, hy = by - uy * cut;
      const w = g.thickness * 0.9, hl = 4 + 3 * w, hw = 2 + 1.6 * w;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(hx - ux * hl, hy - uy * hl); c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(hx, hy);
      c.lineTo(hx - ux * hl - uy * hw, hy - uy * hl + ux * hw);
      c.lineTo(hx - ux * hl + uy * hw, hy - uy * hl - ux * hw);
      c.closePath();
      c.fill();
      c.setLineDash(DASHES[g.dash]);
    }
    c.setLineDash([]);
    c.font = "11px system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    for (const e of g.edges) {
      if (e.label === null) continue;
      let x: number, y: number;
      if (e.s === e.t) {
        const v = g.nodes[e.s];
        x = sx(v.x - Math.SQRT2 * g.loop); y = sy(v.y + Math.SQRT2 * g.loop);
      } else {
        const [ax, ay, bx, by] = ends(e);
        x = (ax + bx) / 2; y = (ay + by) / 2;
      }
      if (g.label_background !== null) {
        const tw = c.measureText(e.label).width + 4;
        c.fillStyle = g.label_background;
        c.fillRect(x - tw / 2, y - 6.5, tw, 13);
      }
      c.fillStyle = "black";
      c.fillText(e.label, x, y);
    }
    g.nodes.forEach((v, i) => {
      c.beginPath();
      c.arc(sx(v.x), sy(v.y), r, 0, 2 * Math.PI);
      c.fillStyle = v.color;
      c.fill();
      if (pinned.has(i)) { c.strokeStyle = "#555"; c.lineWidth = 1; c.stroke(); }
      if (v.label !== null) {
        c.fillStyle = "black";
        c.fillText(v.label, sx(v.x), sy(v.y));
      }
    });
  }

  // ------------------------------------------------------------ interaction
  const hit = (px: number, py: number) => {
    for (let i = g.nodes.length - 1; i >= 0; i--) {
      const v = g.nodes[i];
      if (Math.hypot(sx(v.x) - px, sy(v.y) - py) <= g.radius + 2) return i;
    }
    return -1;
  };
  let drag: { node: number; px: number; py: number; tx: number; ty: number } | null = null;
  let animating = false;
  canvas.addEventListener("pointerdown", (ev) => {
    if (animating) return;
    const r = canvas.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    drag = { node: hit(px, py), px, py, tx, ty };
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {}
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    if (drag.node >= 0) {
      const v = g.nodes[drag.node];
      v.x = dx(px); v.y = dy(py);
      pinned.add(drag.node);
    } else {
      tx = drag.tx + px - drag.px; ty = drag.ty + py - drag.py;
    }
    draw();
  });
  const up = () => { drag = null; canvas.style.cursor = "grab"; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    const f = Math.exp(-ev.deltaY * 0.0015), k2 = Math.min(20, Math.max(0.05, k * f));
    tx = px - (px - tx) * (k2 / k); ty = py - (py - ty) * (k2 / k);
    k = k2;
    draw();
  }, { passive: false });

  // "Lay out again": spring.ts's layout, animated, the moved vertices fixed
  const relayout = button("Lay out again", "Lay the graph out again with the spring layout, keeping the vertices you moved where they are", () => {
    if (animating) return;
    const ids = g.nodes.map((_, i) => "v" + i);
    const nodes: SpringNode[] = g.nodes.map((v, i) => ({ id: ids[i], w: BOX, h: BOX, fixed: pinned.has(i) ? toSpring(v.x, v.y) : null }));
    const edges: [string, string][] = g.edges.filter((e) => e.s !== e.t).map((e) => [ids[e.s], ids[e.t]]);
    // (Python's layout's options: the same seed, and its iterations, CORR-4D6-4)
    const steps = springSteps(nodes, edges, g.iterations === null ? { seed: 0 } : { seed: 0, iterations: g.iterations }, 1);
    animating = true;
    relayout.disabled = true;
    const frame = () => {
      const { value, done } = steps.next();
      if (value) ids.forEach((id, i) => { const p = value.get(id); if (p) Object.assign(g.nodes[i], fromSpring(p)); });
      if (done) {
        animating = false;
        relayout.disabled = false;
        refit();
        draw();
        return;
      }
      refit();
      draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  // (the range: what Python's picture's range covers, the vertices, the
  // arrows' ends, the edges' labels and the loops and theirs, with its 10%
  // margin, CORR-4D6-5)
  const refit = () => {
    if (!g.nodes.length) return;
    geometry();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const at = (x: number, y: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    for (const v of g.nodes) at(v.x, v.y);
    const R = g.loop;
    for (const e of g.edges) {
      if (e.s === e.t) {
        const v = g.nodes[e.s], cx = v.x - R / Math.SQRT2, cy = v.y + R / Math.SQRT2;
        at(cx - R, cy - R); at(cx + R, cy + R);
        if (e.label !== null) at(v.x - Math.SQRT2 * R, v.y + Math.SQRT2 * R);
        continue;
      }
      const [ax, ay, bx, by] = dataEnds(e);
      at(ax, ay); at(bx, by);
      if (e.label !== null) at((ax + bx) / 2, (ay + by) / 2);
    }
    const pad = 0.1 * Math.max(x1 - x0, y1 - y0, 1);
    g.range = [x0 - pad, x1 + pad, y0 - pad, y1 + pad];
  };
  button("Reset", "Put the vertices back where the picture had them, and the view as it was", () => {
    if (animating) return;
    original.forEach((p, i) => Object.assign(g.nodes[i], p));
    pinned.clear();
    k = 1; tx = 0; ty = 0;
    g.range = [...range0] as GraphData["range"];
    draw();
  });
  button("Save PNG", "Download this view as a PNG picture", () => {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "graph.png";
    a.click();
  });
  // (for tests, web/test-graph-view.mjs: where a vertex is drawn, in CSS
  // pixels of the canvas, its position, and which are pinned)
  (canvas as any).sbGraph = {
    screen: (i: number) => ({ x: sx(g.nodes[i].x), y: sy(g.nodes[i].y) }),
    pos: (i: number) => ({ x: g.nodes[i].x, y: g.nodes[i].y }),
    pinned: () => [...pinned].sort((a, b) => a - b),
    busy: () => animating,
    offset: () => (geometry(), off),
    range: () => [...g.range],
    all: () => g.nodes.map((v) => [v.x, v.y]),
  };
  if (fallback) fallback.style.display = "none";
  fig.appendChild(wrap);
  new ResizeObserver(() => draw()).observe(canvas);
  draw();
  return true;
}

if (typeof window !== "undefined") (window as any).SagebrushGraphView ??= { mount, check };
