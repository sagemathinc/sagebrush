// A small hand-made space: Markdown notes, code with its output, and real 3D plots (surfaces given as data, as an
// agent would write them).  Writes public/demo.space.json.   node gen-demo.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const grid = (f, a, b, n) => {
  const xs = Array.from({ length: n }, (_, i) => +(a + (b - a) * i / (n - 1)).toFixed(4));
  return { x: xs, y: xs, z: xs.map((y) => xs.map((x) => +f(x, y).toFixed(4))) };
};
const sinc = (x, y) => { const r = Math.hypot(x, y); return r < 1e-9 ? 1 : Math.sin(r) / r; };
const space = {
  format: "sagebrush-space", version: 1,
  title: "A whitespace: notes, code and its output, and 3D plots",
  nodes: [
    { id: "intro", kind: "note", title: "What is a whitespace?", group: "notes",
      text: "# A whitespace\n\nA terminal is **immutable 1D**, a notebook **mutable 1D**, a whiteboard **mutable 2D**, and a whitespace **mutable 3D**.\n\n- Fly with the mouse: drag to turn, scroll to move, right-drag to pan.\n- Click anything to read it sharply.\n- Search (top left) and click a result to fly there.\n\nThe objects here are described in plain JSON (`demo.space.json`), so an agent can write one." },
    { id: "format", kind: "note", title: "The format", group: "notes",
      text: "## foo.space.json\n\n```json\n{\"format\": \"sagebrush-space\", \"version\": 1,\n \"nodes\": [{\"id\": \"a\", \"kind\": \"note\", \"text\": \"# Hi\"}],\n \"edges\": [{\"from\": \"a\", \"to\": \"b\"}]}\n```\n\nKinds: `note` (Markdown), `code` (with `output`), `plot3d` (`surface` data), `file`. Positions are optional: the layout places what has none, in 3D, by its edges and its `group`." },
    { id: "logistic", kind: "code", title: "The logistic map's Lyapunov exponent", group: "code", lang: "python",
      text: "import numpy as np\nrs = np.linspace(2.5, 4.0, 1500)\nx = np.full_like(rs, 0.4)\nlyap = np.zeros_like(rs)\nfor i in range(700):\n    x = rs * x * (1 - x)\n    if i >= 500:\n        lyap += np.log(np.abs(rs * (1 - 2 * x)))\nlyap /= 200\nprint('chaos from r =', rs[np.argmax(lyap > 0)])",
      output: "chaos from r = 3.570713809206138" },
    { id: "zeta", kind: "code", title: "A sum, in Sage", group: "code", lang: "sage",
      text: "sum(1/n^2 for n in [1..oo])", output: "1/6*pi^2" },
    { id: "sinc", kind: "plot3d", title: "z = sin(r)/r", group: "plots", text: "plot3d(sin(sqrt(x^2+y^2))/sqrt(x^2+y^2), (x,-10,10), (y,-10,10))",
      surface: grid(sinc, -10, 10, 48) },
    { id: "saddle", kind: "plot3d", title: "A saddle: z = x^2 - y^2", group: "plots", text: "plot3d(x^2 - y^2, (x,-1,1), (y,-1,1))",
      surface: grid((x, y) => x * x - y * y, -1, 1, 32) },
    { id: "why3d", kind: "note", title: "Why 3D?", group: "notes",
      text: "## Why 3D?\n\nA codebase of hundreds of files and their imports overlaps on a plane. In 3D the same layout has **less overlap** and **clearer clusters**: open `web-tree.space.json` and press **2D / 3D** to compare.\n\nText is fuzzy at a distance on purpose: 3D is for *navigating* an information-rich space, and a click gives the sharp text." },
  ],
  edges: [
    { from: "intro", to: "format" }, { from: "intro", to: "why3d" }, { from: "intro", to: "logistic" },
    { from: "logistic", to: "zeta" }, { from: "logistic", to: "sinc" }, { from: "sinc", to: "saddle" }, { from: "why3d", to: "saddle" },
  ],
};
const out = join(here, "public", "demo.space.json");
writeFileSync(out, JSON.stringify(space) + "\n");
console.log(out, space.nodes.length, "nodes");
