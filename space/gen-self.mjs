// public/whitespace-code.space.json: the whitespace's own code as a space, to learn how it works. Each file, and each
// part of the two long ones (src/main.js, src/xr.js, split where their sections begin), with what it is for (its
// summary), its text and its length; links for imports and for who calls whom across the parts; and guided tours.
//   node gen-self.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

// (the long files' parts: where each begins, by a line that starts it)
const PARTS = {
  "src/main.js": [
    ["scene", "the scene", /^import /],
    ["faces", "faces and textures", /^function canvasFor/],
    ["objects", "objects and their shapes", /^function makeObject/],
    ["zoom", "semantic zoom", /^\/\/ semantic zoom/],
    ["landmarks", "group labels", /^\/\/ landmarks:/],
    ["load", "loading and framing", /^function clear\(\)/],
    ["flying", "flying, Back, Forward", /^\/\/ -+ flying/],
    ["picking", "picking", /^\/\/ -+ picking/],
    ["selection", "selection (for agents)", /^\/\/ -+ selection/],
    ["tours", "guided tours", /^\/\/ -+ guided tours/],
    ["running", "running code", /^\/\/ -+ running code/],
    ["keeping", "what this browser keeps", /^\/\/ what was edited/],
    ["controls", "panel, theme, keys", /^\/\/ the overlay's width/],
    ["search", "search", /^\/\/ -+ search/],
    ["start", "which space; embedding", /^\/\/ -+ which space/],
    ["headset", "the headset hookup", /^\/\/ -+ a headset/],
  ],
  "src/xr.js": [
    ["setup", "setup and the rig", /^\/\/ The space in a headset/],
    ["controllers", "controllers", /^ {2}\/\/ -+ the controllers/],
    ["flying", "flying in VR", /^ {2}\/\/ -+ flying/],
    ["panel", "the reading panel", /^ {2}\/\/ -+ the reading panel/],
    ["menu", "the wrist menu", /^ {2}\/\/ -+ the wrist menu/],
    ["pointing", "pointing and selecting", /^ {2}\/\/ -+ pointing/],
    ["frame", "each frame: rays and thumbsticks", /^ {2}\/\/ -+ each frame/],
    ["enter", "entering and leaving", /^ {2}\/\/ -+ entering/],
  ],
};

const SUMMARY = {
  "src/main.js#scene": "Sets up the 3D world: the WebGL renderer, the scene, the camera and its orbit controls, the lights, and the colour themes (light by default, dark, or following the system).",
  "src/main.js#faces": "Draws what you read on each slab. A face is a canvas painted with the title, the summary, the first lines of text or code, and the output, then used as a texture. A plot's surface becomes a mesh coloured by height. Math is drawn as readable text (tex.js).",
  "src/main.js#objects": "Makes the 3D object for each item: a slab sized by kind (a file's grows with its length), a small shape above it chosen by the item's id, and, for a plot, the 3D plot standing on its face.",
  "src/main.js#zoom": "Semantic zoom: far away a slab is a plain block in its group's colour, nearer it shows its title and summary, close up its whole face. Textures are made lazily, the nearest first, a few per frame.",
  "src/main.js#landmarks": "The big labels above each group (a directory, a crate, a topic), placed over the group and faded in as you leave it. Each frame, labels that would overlap on screen are hidden, the biggest groups first.",
  "src/main.js#load": "Loads a space: checks its format, makes the objects and the links between them, lays them out (saved positions, or a force layout), builds the search index, and frames the camera on everything.",
  "src/main.js#flying": "Moves the camera. Flying to an object goes to the view in front of its face (or below and in front of a plot), along an arc over the space. Every flight is remembered, for Back and Forward.",
  "src/main.js#picking": "Turns the mouse into objects: a ray from the camera through the pointer finds what is under it. Hovering lights it up; a click (not a drag) opens it in the drawer.",
  "src/main.js#selection": "What the person is looking at, for agents: the selected object goes into the address (#sel=), window.whitespace.selection, an event, and a message to the page around it, which writes it into the file as \"selected\".",
  "src/main.js#tours": "Guided tours: a list of stops, each an object and some narration. A tour flies from stop to stop; the drawer shows the stop with Back, Next and End (keys N and P), and the headset shows it on the panel.",
  "src/main.js#running": "Runs an object's code on Sagebrush's engine in the browser (run.js). The output, figures and 3D plots are kept on the object and drawn on its face; a Sage 3D plot replaces the object's shape. Run all runs every object in order.",
  "src/main.js#keeping": "Keeps what you edited and ran in this browser (localStorage), each copy tagged with the file text it came from, so the agent's next version of an object always wins over an old copy.",
  "src/main.js#controls": "The drawer's width (drag its edge), the light/dark theme switch, full screen, and flying with the keyboard (W A S D or arrows, E and Q up and down, Shift for speed).",
  "src/main.js#search": "Full-text search over titles, summaries, text and output. The best matches first; click one to fly there.",
  "src/main.js#start": "Picks the space to show: from the list of example spaces, or, embedded in the agents chat (?embed=1), from messages the page sends each time the agent writes the file.",
  "src/main.js#headset": "Connects the headset mode (xr.js): the Enter VR and Enter AR buttons, what it may call back (select, run, fly to an object, tours), and the animation loop shared by the screen and the headset.",
  "src/xr.js#setup": "The headset mode, built on WebXR: the rig that carries the camera (scaled so a slab is about a metre wide) and the reference space with its floor.",
  "src/xr.js#controllers": "A ray from each controller, drawn as a line that stops at whatever it points at.",
  "src/xr.js#flying": "Flying in VR: to an object's view (the same view the desktop flies to), smoothly, and Back, Forward and See all, each flight remembered.",
  "src/xr.js#panel": "The reading panel: a canvas texture floating beside the object, with the title, summary, tour narration, code and output, and buttons (Run, scroll, Next stop, Close), because a page's own HTML isn't drawn inside a headset.",
  "src/xr.js#menu": "The menu on the left wrist: Back, Forward, See all, Run all, Tour or Next stop, and Exit VR.",
  "src/xr.js#pointing": "Pointing and pulling the trigger: a hit on the panel or the menu presses its button; a hit on an object flies there and opens it.",
  "src/xr.js#frame": "Each frame: the rays and what they hover, the thumbsticks (move, rise and fall, turn in steps; the grip for speed), and B or Y for Back.",
  "src/xr.js#enter": "Entering VR or AR (in AR the background goes, so the room shows) and leaving: the camera goes back where it was.",
  "src/run.js": "Runs code on Sagebrush's engine in a Web Worker, one engine per language (so MATLAB can't see Sage's names), and turns a Sage 3D scene into three.js objects.",
  "src/code.js": "Syntax highlighting (highlight.js) and the small code editor in the drawer: a textarea over a highlighted copy; Shift+Enter runs.",
  "src/layout.js": "The force layout: links pull objects together, everything pushes everything else apart, and groups gather around their centre. Fixed positions stay put; `near` puts an object beside another.",
  "src/tex.js": "TeX as plain text for canvases, where KaTeX can't draw: $\\frac{4}{3}\\pi r^3$ becomes 4/3 π r³. Used on faces and the VR panel; the drawer typesets the real thing.",
  "index.html": "The page: the panel (title, Back, Forward, See all, Flatten, Full screen, Run all, Theme, tours, search), the drawer, and all the styles, with the light and dark colours as variables.",
  "build.mjs": "Bundles src/main.js with esbuild into space.js (three.js inside, nothing fetched from other sites) and copies the page and example spaces into dist/, or into a built site's /space/ (--site).",
  "build-alpha.sh": "Builds the whole Sagebrush site with the space in it, from clean, checks it fits a static host, and copies it to site/public for the Worker that serves space.sagebrush.cloud.",
  "serve.mjs": "A local server for dist/ that sends the cross-origin isolation headers the engine needs and fetches anything else from sagebrush.space (caching it).",
  "site/cloudflare.config.ts": "The Cloudflare Worker for space.sagebrush.cloud: static assets only, no other bindings or secrets, with a route so it wins over the preview Worker's wildcard.",
  "site/src/index.ts": "The Worker's code: anything that isn't a file gets the assets' own answer (their 404 page).",
  "gen-modular.mjs": "Makes the modular-forms space from a Sagebrush checkout: the Rust crates file by file, the Python layers that call them, a note per crate, runnable Sage samples and a 3D plot of the dimensions of spaces of cusp forms.",
  "gen-web-tree.mjs": "Makes the web-tree space: every file under web/ with its first lines, linked by its imports.",
  "gen-demo.mjs": "Makes the demo space: notes, Python, Sage, MATLAB and matplotlib code, and two 3D plots.",
  "gen-self.mjs": "Makes this space: the whitespace's own code, its long files in parts, with summaries and tours.",
  "layout-cli.mjs": "Lays out a space once and saves the positions into it, so it opens the same way every time.",
  "public/format.md": "The space format, written for agents: objects, links, groups, `near`, summaries, tours, what the person selected, and which Sage 3D functions run.",
  "test-agents-space.mjs": "End-to-end test of the agents chat with a stand-in agent: the space appears, selections reach the file, rewrites update it in place, math is typeset, scripts never run, Run works.",
  "test-xr.mjs": "End-to-end test of VR on Meta's emulated Quest 3: entering, flying to an object, the panel and Run, the thumbsticks, the wrist menu, AR, and leaving.",
  "../web/agents/page.ts": "The agents chat page (most of it is other work). Its mountSpace shows a .space.json the agent wrote: the space in a frame, sent the file again each time it changes, with the person's selection written back into the file.",
};

const GROUP = (id) => id.startsWith("src/main.js") ? "main.js" : id.startsWith("src/xr.js") ? "xr.js" : id.startsWith("src/") || id === "index.html" ? "viewer"
  : /^(build|serve|site\/)/.test(id) ? "build and deploy" : /^(gen-|layout-cli|public\/)/.test(id) ? "making spaces" : /^test-/.test(id) ? "tests" : "agents chat";

const nodes = [], edges = [];
const lineCount = (t) => t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
for (const [file, parts] of Object.entries(PARTS)) {
  const lines = read(file).split("\n");
  const starts = parts.map(([id, title, re]) => {
    const at = lines.findIndex((l) => re.test(l));
    if (at < 0) throw new Error(`${file}: no line starts part ${id}`);
    return { id, title, at };
  }).sort((a, b) => a.at - b.at);
  starts.forEach((p, k) => {
    const text = lines.slice(k === 0 ? 0 : p.at, k + 1 < starts.length ? starts[k + 1].at : lines.length).join("\n").replace(/\s+$/, "");
    const id = `${file}#${p.id}`;
    nodes.push({ id, kind: "file", lang: "javascript", title: `${file.split("/").pop()} · ${p.title}`, group: GROUP(id), summary: SUMMARY[id], text, lines: lineCount(text) });
  });
}
for (const file of Object.keys(SUMMARY).filter((k) => !k.includes("#"))) {
  const text = read(file).replace(/\s+$/, "");
  const lang = /\.ts$/.test(file) ? "typescript" : /\.(m?js)$/.test(file) ? "javascript" : /\.md$/.test(file) ? "" : /\.sh$/.test(file) ? "" : "";
  const shown = file === "../web/agents/page.ts" ? (() => {
    // (only mountSpace: the rest of the page is other work)
    const a = text.indexOf("// A space (space/README.md"), b = text.indexOf("// An artifact that is a workspace file");
    return a >= 0 && b > a ? text.slice(a, b).replace(/\s+$/, "") : text.slice(0, 4000);
  })() : text;
  nodes.push({ id: file, kind: "file", lang, title: file.replace(/^\.\.\//, ""), group: GROUP(file), summary: SUMMARY[file], text: shown, lines: lineCount(text) });
}
const has = new Set(nodes.map((n) => n.id));
const link = (from, to) => { if (has.has(from) && has.has(to)) edges.push({ from, to }); };
// imports
for (const [f, deps] of Object.entries({
  "src/main.js#scene": ["src/layout.js", "src/tex.js", "src/xr.js#setup", "src/code.js", "src/run.js"],
  "src/xr.js#setup": ["src/tex.js"], "layout-cli.mjs": ["src/layout.js"], "build.mjs": ["src/main.js#scene", "index.html"],
  "build-alpha.sh": ["build.mjs", "site/cloudflare.config.ts"], "site/cloudflare.config.ts": ["site/src/index.ts"],
  "../web/agents/page.ts": ["index.html", "src/main.js#start", "src/main.js#selection"],
  "test-agents-space.mjs": ["../web/agents/page.ts"], "test-xr.mjs": ["src/xr.js#enter"],
  "gen-modular.mjs": ["public/format.md"], "gen-self.mjs": ["public/format.md"],
})) for (const t of deps) link(f, t);
// who calls whom, across the parts
for (const [f, ts] of Object.entries({
  "src/main.js#load": ["src/main.js#objects", "src/layout.js", "src/main.js#landmarks", "src/main.js#search", "src/main.js#keeping"],
  "src/main.js#objects": ["src/main.js#faces"], "src/main.js#zoom": ["src/main.js#faces"], "src/main.js#faces": ["src/tex.js"],
  "src/main.js#picking": ["src/main.js#selection", "src/main.js#flying"], "src/main.js#selection": ["src/main.js#running", "src/code.js"],
  "src/main.js#running": ["src/run.js", "src/main.js#keeping"], "src/main.js#tours": ["src/main.js#selection", "src/main.js#flying"],
  "src/main.js#start": ["src/main.js#load"], "src/main.js#headset": ["src/xr.js#setup", "src/main.js#zoom", "src/main.js#landmarks"],
  "src/xr.js#pointing": ["src/xr.js#panel", "src/xr.js#flying", "src/xr.js#menu"], "src/xr.js#frame": ["src/xr.js#pointing", "src/xr.js#flying"],
  "src/xr.js#menu": ["src/main.js#tours", "src/main.js#running"], "src/xr.js#panel": ["src/main.js#running"],
})) for (const t of ts) link(f, t);

const tours = [
  { id: "click", title: "How a click becomes a flight", steps: [
    { node: "src/main.js#picking", text: "It starts with the mouse. On a click (a press and release that didn't drag), a ray goes from the camera through the pointer, and the first object it hits is the one you meant." },
    { node: "src/main.js#selection", text: "**openOverlay** first remembers where you are (for Back), then shows the object in the drawer and marks it selected. The selection goes into the address and, in the agents chat, to the page around the space, so the agent can see what you mean by \"this\"." },
    { node: "src/main.js#flying", text: "**flyTo** asks **viewOf** where to look from (in front of the face, or below and in front of a plot) and starts a flight. Each frame, **stepFlight** moves the camera along an arc, so a long flight passes over the space rather than through it." },
    { node: "src/main.js#zoom", text: "As you arrive, semantic zoom notices you're close and makes the object's full face texture (the nearest objects first, a few per frame), so the text sharpens as you land." },
    { node: "src/main.js#faces", text: "The face itself: a canvas painted with the title, the summary in its blue band, the first lines, and the output, turned into a texture. Math is drawn as readable text; the drawer next to it has the typeset version." },
  ] },
  { id: "agent", title: "How the agent's file reaches the space", steps: [
    { node: "public/format.md", text: "The agent learns the format here: objects, links, groups, summaries, tours. It writes a `.space.json` into your workspace with its usual write tool." },
    { node: "../web/agents/page.ts", text: "The agents chat sees a written `.space.json` and shows it with **mountSpace**: the space page in a frame. It reads the file, sends it to the frame, and sends it again whenever the file changes. Clicks come back the other way and are written into the file as `\"selected\"`." },
    { node: "src/main.js#start", text: "Inside the frame (?embed=1) the space waits for the page's message and loads what it's sent. The same file again (the agent rewrote it) keeps your camera and selection, so the space changes in place." },
    { node: "src/main.js#load", text: "**load** checks the format, makes the objects and links, and lays them out. Positions are never in the file unless saved: the layout is deterministic, so the same file looks the same every time." },
    { node: "src/main.js#keeping", text: "One subtlety: what you edited and ran is kept in this browser, tagged with the file text it came from. When the agent rewrites an object, the tag no longer matches and the agent's version wins." },
  ] },
  { id: "run", title: "How Run works", steps: [
    { node: "src/main.js#running", text: "Run (or Run all) calls **runNode**, which takes the object's code and language and hands them to run.js, following progress in the drawer if it's open." },
    { node: "src/run.js", text: "**run** gets an engine for that language (started on first use, one per language) and executes the code in a Web Worker, collecting output, figures and 3D scenes as they arrive." },
    { node: "src/main.js#faces", text: "Back in main.js, the output is kept on the object and its face is redrawn with it. A Sage 3D plot is turned into three.js objects by **sceneObject** and stands on the slab's face." },
    { node: "src/main.js#keeping", text: "The result is saved in this browser, so it's still there after a reload, unless the agent has since changed the object." },
  ] },
  { id: "vr", title: "VR: from Enter VR to the panel", steps: [
    { node: "src/main.js#headset", text: "The Enter VR button appears only if the browser has immersive VR. main.js hands xr.js what it needs: selecting, running, the desktop's views of objects, tours." },
    { node: "src/xr.js#enter", text: "Entering puts you where the camera was, facing the same way, on a rig scaled so a slab is about a metre wide. In AR the background is removed, so your room shows." },
    { node: "src/xr.js#frame", text: "Every frame: the controllers' rays find what they point at, and the thumbsticks move and turn the rig." },
    { node: "src/xr.js#pointing", text: "Pulling the trigger on an object flies you to it and opens its panel; on the panel or the wrist menu it presses a button." },
    { node: "src/xr.js#panel", text: "The panel is a canvas drawn like a face, but bigger and sharper, with buttons: Run, scroll, Next stop, Close. A page's HTML can't be shown inside a headset, so everything you read in VR is drawn this way." },
  ] },
];

const overview = { id: "overview", kind: "note", title: "How the whitespace works", group: "overview", summary: "Start here: the parts of the whitespace and how they fit, with guided tours in the panel's tour menu.",
  text: "# How the whitespace works\n\nA *space* is a JSON file of objects (notes, code, files, 3D plots) and links. The viewer (**src/main.js**) lays them out in 3D with three.js and lets you fly around, read, search and run code.\n\n- **Objects and faces**: each object is a slab whose face is a texture drawn on a canvas; semantic zoom shows less from afar and more up close.\n- **Running code**: Sagebrush's own engine, in the browser (**src/run.js**).\n- **The agents chat**: the agent writes a `.space.json`; the chat page shows it in a frame and writes your selection back into the file.\n- **VR**: **src/xr.js** puts the same space in a headset, with controllers, a reading panel and a wrist menu.\n\nThis space is made by **gen-self.mjs** from the code itself, so it is always current. Pick a tour in the panel to follow one path through it." };
nodes.unshift(overview);
for (const t of ["src/main.js#scene", "src/xr.js#setup", "../web/agents/page.ts", "src/run.js"]) link("overview", t);

const space = { format: "sagebrush-space", version: 1, title: "The whitespace's own code", nodes, edges, tours };
for (const n of nodes) if (!n.summary) throw new Error(`no summary for ${n.id}`);
for (const t of tours) for (const s of t.steps) if (!has.has(s.node)) throw new Error(`tour ${t.id}: no object ${s.node}`);
writeFileSync(join(here, "public", "whitespace-code.space.json"), JSON.stringify(space));
console.log(`public/whitespace-code.space.json: ${nodes.length} objects, ${edges.length} links, ${tours.length} tours`);
