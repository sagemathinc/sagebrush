// A demo agent for the whitespace: what working with an agent in a space might be like, before a real one is connected.
// It understands a few requests about an elliptic curve (any curve the engine knows by its Cremona label, 389a by
// default): plot it, draw its rational points, plot it modulo every prime up to 50, and show its complex points in 3D.
// What it understands is scripted; what it shows is not: for each request it writes Sage code, runs it on Sagebrush's
// own engine in this browser, and puts the result in the space as an object carrying that code (open it, edit it, run
// it again).  Its replies quote what the code computed, never a number written here.
//   const a = startDemoAgent(api); a.send(text); a.messages; a.suggestions; a.onChange(f); a.stop()
// `api`: { figure (agent.js), place(nd) -> object (a new object), update(nd), focus(nd), run(code) -> { out, displays,
//   error }, SCENE, eye() }

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
const label = (text) => /\b(\d{2,3}[a-z]{1,2}\d?)\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
const lastJson = (out) => { for (const l of String(out).trim().split("\n").reverse()) { try { if (l.startsWith("{")) return JSON.parse(l); } catch {} } return null; };
// (the Weierstrass equation from its a-invariants, as TeX)
function equation(a) {
  const [a1, a2, a3, a4, a6] = a.map(Number);
  const term = (c, t, first = false) => (c === 0 ? "" : `${c < 0 ? " - " : first ? "" : " + "}${Math.abs(c) === 1 && t ? "" : Math.abs(c)}${t}`);
  const lhs = "y^2" + term(a1, "xy") + term(a3, "y");
  const rhs = "x^3" + term(a2, "x^2") + term(a4, "x") + term(a6, "");
  return `${lhs} = ${rhs}`;
}

export function startDemoAgent(api) {
  const fig = api.figure;
  const messages = [];
  const listeners = new Set();
  let curve = "389a", info = null, busy = false, stopped = false;
  const done = new Set();
  const plotNode = () => api.nodes().find((n) => n.id === "agent:plot") ?? null;
  const changed = () => { for (const f of listeners) try { f(); } catch {} };
  const say = (text) => { messages.push({ from: "agent", text }); fig.say(text, 12000); changed(); };

  const SUGGEST = [
    ["plot", "Please draw a plot of the elliptic curve 389a"],
    ["points", "Please draw some rational points on that curve"],
    ["modp", "Plot it reduced modulo every prime up to 50"],
    ["complex", "Show its complex points in 3D"],
  ];

  // ---- what it can do: each writes code, runs it, and places or changes an object
  // (after each wait: the agent may have been stopped meanwhile (another space), and then it does nothing more)
  const alive = () => { if (stopped) throw new Error("stopped"); };
  // (`needs`: whether the reply quotes what the code printed, its last line of JSON)
  async function runAt(nd, code, needs = true) {
    alive();
    nd.text = code;
    nd.lang = "sage";
    fig.work(api.positionOf(nd));
    let r;
    try { r = await api.run(code); } catch (e) { nd.outputError = true; api.update(nd); throw e; } finally { fig.work(null); }
    alive();
    const last = (mime) => [...r.displays].reverse().find((b) => b[mime])?.[mime];
    nd.output = r.out.replace(/\s+$/, "").split("\n").filter((l) => !l.startsWith("{")).join("\n");
    nd.outputError = r.error;
    if (last(api.SCENE)) { nd.scene = JSON.parse(last(api.SCENE)); nd.svg = null; }
    else nd.svg = last("image/svg+xml") ?? null;
    if (r.stopped) nd.outputError = true;
    api.update(nd);
    if (r.error) throw new Error((r.out.split("\n").filter(Boolean).pop() ?? "it failed"));
    if (r.stopped) throw new Error("the run was stopped");
    const j = lastJson(r.out);
    if (!j && needs) throw new Error("the code gave no result");
    return j;
  }
  async function walkTo(pos) {
    const eye = api.eye();
    // (beside the object, a little toward you, not in front of it)
    const side = pos.clone().add({ x: 4.2, y: 1.5, z: 2.5 });
    await fig.moveTo(side, eye);
    alive();
  }

  async function plot() {
    const nd = plotNode() ?? api.place({ id: "agent:plot", kind: "code", figure: true, title: `The elliptic curve ${curve}`, position: [0, 0, 0], size: [9, 7.2, 0.25], text: "", lang: "sage" });
    nd.title = `The elliptic curve ${curve}`;
    await walkTo(api.positionOf(nd));
    const j = await runAt(nd, `E = EllipticCurve('${curve}')
E.plot(color='darkgreen', thickness=2).show(axes_labels=['$x$', '$y$'])
import json
print(json.dumps({"a": [str(c) for c in E.a_invariants()], "N": int(E.conductor()), "rank": int(E.rank())}))`);
    info = j;
    api.focus(nd);
    return `Here is ${curve}: $${equation(j.a)}$. Its conductor is ${j.N} and its rank is ${j.rank}.`;
  }
  async function points() {
    if (!plotNode()) await plot();
    const nd = plotNode();
    await walkTo(api.positionOf(nd));
    const j = await runAt(nd, `E = EllipticCurve('${curve}')
gens = E.gens()
pts = set((R[0], R[1]) for R in E.torsion_points() if R != E(0))
r = len(gens)
rng = range(-2, 3) if r >= 2 else range(-4, 5)
import itertools
for cs in itertools.product(rng, repeat=r):
    R = sum((c*g for c, g in zip(cs, gens)), E(0))
    if R != E(0) and abs(R[0]) < 6:
        pts.add((R[0], R[1]))
G = E.plot(color='darkgreen', thickness=2) + points([(float(x), float(y)) for x, y in pts], color='red', size=45, zorder=5)
for x, y in pts:
    if x.denominator() == 1:
        G += text(f"({x}, {y})", (float(x) + 0.12, float(y) + 0.45), fontsize=8, color='black', horizontal_alignment='left')
G.show(axes_labels=['$x$', '$y$'])
import json
print(json.dumps({"n": len(pts), "gens": [[str(g[0]), str(g[1])] for g in gens], "torsion": int(E.torsion_order())}))`);
    nd.title = `${curve} and some of its rational points`;
    api.update(nd);
    api.focus(nd);
    const gens = j.gens.map((g) => `(${g[0]}, ${g[1]})`).join(" and ");
    return j.gens.length
      ? `I drew ${j.n} rational points: small combinations of the generators ${gens}${j.torsion > 1 ? `, and the torsion points` : ""} (the integral ones are labelled).`
      : `${curve} has rank 0: its only rational points are its ${j.torsion - 1} nonzero torsion point${j.torsion === 2 ? "" : "s"}, drawn in red.`;
  }
  async function modp() {
    if (!info) await plot();
    const primes = PRIMES.filter((p) => info.N % p !== 0);
    const center = api.positionOf(plotNode() ?? { position: [0, 0, 0] });
    const found = [];
    // (an arc of small plots behind the curve, one per prime, each made where it stands: every other one in a second
    //  row, further back and a little higher, where the ground rises to it)
    for (const [k, p] of primes.entries()) {
      if (stopped) return null;
      const ang = -1.15 + (2.3 * k) / Math.max(1, primes.length - 1), tier = k % 2, R = 17 + tier * 8;
      const pos = [center.x + Math.sin(ang) * R, center.y + tier * 3, center.z - Math.cos(ang) * R * 0.75 - 4];
      const nd = api.nodes().find((n) => n.id === `agent:mod${p}`) ?? api.place({ id: `agent:mod${p}`, kind: "code", figure: true, title: `${curve} mod ${p}`, position: pos, size: [4.2, 4.6, 0.15], text: "", lang: "sage" });
      fig.say(`mod ${p}…`, 3000);
      await fig.moveTo(api.positionOf(nd).clone().add({ x: 0, y: 3.2, z: 2.5 }), api.eye(), 450);
      alive();
      const j = await runAt(nd, `E = EllipticCurve('${curve}'); p = ${p}
Ep = E.change_ring(GF(p))
S = [(int(R[0]), int(R[1])) for R in Ep.points() if R[2] == 1]
points(S, color='purple', size=max(8, 400 // p), xmin=0, xmax=p - 1, ymin=0, ymax=p - 1, aspect_ratio=1).show(axes_labels=['$x$', '$y$'])
import json
print(json.dumps({"p": p, "count": int(Ep.cardinality()), "ap": int(E.ap(p))}))`);
      nd.title = `${curve} mod ${p}: ${j.count} points, a_p = ${j.ap}`;
      api.update(nd);
      found.push(j);
    }
    api.focus(plotNode(), 40);
    const ok = found.every((j) => j.ap * j.ap <= 4 * j.p);
    return `Here is ${curve} over $\\mathbb{F}_p$ for the ${found.length} primes $p < 50$ where it has good reduction: each plot is the affine points, and its title gives $\\#E(\\mathbb{F}_p)$ and $a_p = p + 1 - \\#E(\\mathbb{F}_p)$. ${ok ? "All of them satisfy Hasse's bound $|a_p| \\le 2\\sqrt{p}$." : ""}`;
  }
  async function complex() {
    if (!info) await plot();
    const center = api.positionOf(plotNode());
    const nd = api.nodes().find((n) => n.id === "agent:complex") ?? api.place({ id: "agent:complex", kind: "plot3d", title: `The complex points of ${curve}`, position: [center.x + 15, center.y, center.z + 4], text: "", lang: "sage" });
    await walkTo(api.positionOf(nd));
    fig.think(true);
    await runAt(nd, `E = EllipticCurve('${curve}')
a1, a2, a3, a4, a6 = [CDF(c) for c in E.a_invariants()]
# a point (x, y) of E in C^2: for each complex x, the two roots y of y^2 + (a1 x + a3) y = x^3 + a2 x^2 + a4 x + a6.
# Shown in 3D as (Re x, Im x, Re y): one sheet for each root, glued where the discriminant of the quadratic vanishes.
def re_y(s):
    def f(u, v):
        x = CDF(u, v); b = a1*x + a3
        return ((-b + s*sqrt(b^2 + 4*(x^3 + a2*x^2 + a4*x + a6)))/2).real()
    return f
S = sum(parametric_plot3d((lambda u, v: u, lambda u, v: v, re_y(s)), (-2.5, 2.5), (-2.5, 2.5), plot_points=[48, 48], color=c)
        for s, c in [(1, 'steelblue'), (-1, 'orange')])
S.show()`, false);
    fig.think(false);
    api.focus(nd);
    const [a1, a2, a3, a4, a6] = info.a.map(Number);
    return `Each point of $E(\\mathbb{C})$ is a pair $(x, y) \\in \\mathbb{C}^2$, a surface in 4-space; here it is projected to $(\\mathrm{Re}\\,x, \\mathrm{Im}\\,x, \\mathrm{Re}\\,y)$. The two sheets are the two square roots for $y$ (blue and orange), and they meet over the roots of $${quadDisc(a1, a2, a3, a4, a6)} = 0$, the branch points. Take it in your hands in VR: grip and turn it.`;
  }
  function quadDisc(a1, a2, a3, a4, a6) {
    // (b^2 + 4 f, with b = a1 x + a3 and f = x^3 + a2 x^2 + a4 x + a6, as a polynomial in x)
    const c = [a3 * a3 + 4 * a6, 2 * a1 * a3 + 4 * a4, a1 * a1 + 4 * a2, 4];
    const t = (k, d) => (k === 0 ? "" : `${k < 0 ? " - " : " + "}${Math.abs(k) === 1 && d ? "" : Math.abs(k)}${d === 0 ? "" : d === 1 ? "x" : `x^${d}`}`);
    return (t(c[3], 3) + t(c[2], 2) + t(c[1], 1) + t(c[0], 0)).replace(/^ \+ /, "").replace(/^ - /, "-");
  }

  const INTENTS = [
    [/\b(mod|modulo|reduc|reduced|finite field|f_p|primes?)\b/i, "modp", modp],
    [/\b(complex|surface|4-?space|riemann|3d|three)\b/i, "complex", complex],
    [/\b(rational points?|points)\b/i, "points", points],
    [/\b(plot|draw|show|curve|elliptic)\b/i, "plot", plot],
  ];
  async function send(text) {
    text = String(text ?? "").trim();
    if (!text || stopped) return;
    messages.push({ from: "you", text });
    changed();
    if (busy) { say("One moment: I'm still working on the last one."); return; }
    const lab = label(text);
    const hit = INTENTS.find(([re]) => re.test(text));
    if (!hit) {
      say(`In this demo I know how to plot an elliptic curve (any of conductor under 1000, by its label, such as 389a, 11a or 37a), draw its rational points, plot it modulo the primes up to 50, and show its complex points in 3D. Try: "${SUGGEST.find(([k]) => !done.has(k))?.[1] ?? SUGGEST[0][1]}".`);
      return;
    }
    if (lab && lab !== curve) {
      curve = lab; info = null; done.clear();
      // (another curve: its plot is made again; the other objects are left as they were)
    }
    busy = true;
    fig.think(true);
    fig.say("Let me work on that…");
    changed();
    try {
      const reply = await hit[2]();
      fig.think(false);
      if (reply) { done.add(hit[1]); say(reply); }
    } catch (e) {
      if (stopped) return;
      fig.think(false);
      fig.work(null);
      say(`That didn't work: ${String(e?.message ?? e).slice(0, 300)}`);
    } finally {
      busy = false;
      changed();
    }
  }
  return {
    send,
    get messages() { return messages; },
    get busy() { return busy; },
    get suggestions() { return SUGGEST.filter(([k]) => !done.has(k)).map(([, s]) => s); },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    stop() { stopped = true; listeners.clear(); fig.stop?.(); },
    greet() { fig.wave(); say(`Hi! I'm a demo agent. I can work on an elliptic curve with Sagebrush's engine, right here. Try "${SUGGEST[0][1]}".`); },
  };
}
