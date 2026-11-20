# Whitespace: a prototype

A terminal is immutable 1D, a notebook is mutable 1D, a whiteboard is mutable 2D, and a whitespace is mutable 3D: a board in 3D space. This is a quick prototype; it isn't reviewed and doesn't ship.

## Run it

You need Node.js (18 or later) and npm. No bun is needed.

```sh
git fetch origin space-prototype && git checkout space-prototype   # (or a fresh clone of the branch)
cd space
npm ci
npm run build        # bundles three.js and everything else into dist/
npm run serve        # http://127.0.0.1:8080/
```

`dist/` is a plain static site (index.html, space.js and the *.space.json files), so it can be deployed as it is. The generated spaces are committed; `npm run gen` makes them again from `../web` and the demo script, and `node layout-cli.mjs public/X.space.json` saves the layout into a space.

## Using it

- **Mouse:** drag to turn, scroll to move closer, right-drag to pan.
- **Read:** click an object to read it sharply, in the panel on the right. Its links (imports, imported by) are clickable.
- **Search:** `/` focuses the search box, which searches the full text; click a result to fly there.
- **Keys:** `B` goes back to where you were, and `H` shows everything.
- **Run all:** runs every object's code, one after another (the button shows which, and stops it).
- **Theme:** light by default (a white space), dark when your system is; the Theme button switches between Auto, Light and Dark.
- **Flatten to 2D:** the same space on a plane, for comparison.
- **Semantic zoom:** from afar you see the groups' names (directories) over colored blocks; nearer, each object's title; near, its first lines; and on a click, the sharp text.

## Something to try

In `web-tree.space.json` (Sagebrush's own web/ code: 513 files and 1,009 imports):

1. Find the file that saves a board page's document, and what uses it. Search "board page", or wander into the `board` cluster.
2. Find the agents chat's code, and then the module it shares with the notebook page.
3. Press **Flatten to 2D** and do (1) again on the plane. Which was easier, and which was faster?

`demo.space.json` has Markdown notes, code with its output, and two real 3D plots: turn around them.

`modular-forms.space.json` answers the prompt "lay out in 3D the Rust code related to modular forms in Sagebrush so I can browse it, with sample code I can run". It has:
- the crates `modsym`, `hmf`, `ap` and `lfun`, file by file, linked by `mod`, `use` and cross-crate paths;
- the Python layers that call them;
- a note per crate, from its own docs;
- Sage samples with their real output, and a 3D plot of $\dim S_k(\Gamma_0(N))$.

Click a sample, change it, and press Shift+Enter. `node gen-modular.mjs` makes this space again.

## In the agents chat

The chat on the left, the space on the right: a file the agent writes whose name ends in `.space.json` opens beside the chat as a space. When the agent writes it again, the space changes in place (your camera and selection stay). When you click an object, its id is written into the file as `"selected"`, so the agent knows what you mean by "this". The format, written for agents, is [public/format.md](public/format.md) (on a built site, `/space/format.md`).

Run the whole thing on your own computer (the agent pairs with a page on 127.0.0.1 through `--origin`):

```sh
git checkout space-prototype
pnpm install --frozen-lockfile && node scripts/wasm-fetch.mjs   # the site's dependencies and its pinned WebAssembly
pnpm run build && node scripts/build-cli.mjs                    # the TypeScript (dist/) and the CLI's bundle, which the site's build needs
bun web/build.ts                                                # the site, into web/dist (bun 1.3 or later)
(cd space && npm ci && node build.mjs --site ../web/dist)       # the space viewer, into web/dist/space
bun web/csp.ts                                                  # web/dist/_headers, now covering /space/
python3 web/serve.py 8765                                       # http://127.0.0.1:8765/agents/
```

and in another terminal:

```sh
SAGEBRUSH_AGENT_PAGE=http://127.0.0.1:8765/agents/ npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-0.7.6.tgz --origin http://127.0.0.1:8765
```

Open the link it prints, press Connect, and Allow. Then ask, for example:

> Read the space format at https://raw.githubusercontent.com/sagemathinc/sagebrush/space-prototype/space/public/format.md (all of it, verbatim). Then make a space, /polytopes.space.json, with notes on the regular polytopes and Sage code I can run that plots the icosahedron, dodecahedron and the others in 3D.

With agent 0.7.6, fetches return the page itself (no summary), and "Allow for this turn" covers a turn's fetches. The file opens beside the chat as a space; if it shows as JSON text instead, the page was built without the space: `grep -c space-frame web/dist/agents/agents.js` says 0. Build again (the four commands above, from `bun web/build.ts` on), then reload the page and click the file's card.

Over this connection Claude has the web and your Sagebrush files, not your disk. With 0.7.6 it reads public GitHub repositories without asking, so a space of a codebase on GitHub (such as "lay out the Rust code for modular forms") is practical; older agents asked once per file. `modular-forms.space.json` (above) is that space, already made by `gen-modular.mjs` from a checkout.

`bun space/test-agents-space.mjs` (from the repository's root, after the build above) checks this end to end in headless Chromium, with a stand-in for the agent.

## For understanding code: summaries, shapes, tours

- Each object can carry a `summary` (what it is *for*), drawn on its face and readable from a distance, and at the top of the drawer.
- A file's slab grows with its length (`lines`), and every object has its own small shape above its slab, chosen by its id: the same file always looks the same.
- `tours` are guided paths through a space: pick one in the panel and go **Next** / **Back** (or **N** / **P**); in a headset, **Tour** / **Next stop** on the wrist menu.
- `whitespace-code.space.json` is this code itself (`node gen-self.mjs`), with four tours. `modular-forms.space.json` has a summary for every object and four tours, written by reading the code.
- `node annotate.mjs public/X.space.json notes/X.json` merges a notes file (`{ summaries, tours }`) into a space: an agent writes the notes, the tool checks every id.

## The rough alpha (a static site)

`space/build-alpha.sh` builds the whole site with the space into `web/dist` (from clean, with checks) and copies it to `space/site/public`, the assets of the Worker that serves https://space.sagebrush.cloud (`space/site/cloudflare.config.ts`: static assets only, as sagebrush.space is served; deploy with `cd space/site && npm ci && npx cf deploy`). Cloudflare applies `_headers`: every page gets COOP/COEP, which the engine's interrupt needs, and its CSP. The engine, its worker and the space are all in `web/dist`; nothing is fetched from elsewhere. The space says "rough alpha" in its corner, and the site isn't indexed (`robots.txt`).

To use the Agents page there, start the agent with that site's origin, e.g. for https://space.sagebrush.cloud:

```sh
SAGEBRUSH_AGENT_PAGE=https://space.sagebrush.cloud/agents/ npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-0.7.6.tgz --origin https://space.sagebrush.cloud
```

## In a headset (Meta Quest 3, and other WebXR browsers)

**Enter VR** (in the panel, where the browser has WebXR) puts you in the space, where a slab is about a metre wide; **Enter AR** puts the space in your room through the headset's passthrough.

- Point a controller at an object and pull the **trigger**: you fly to it (as the desktop does) and its reading panel opens beside it (its text, code and output), with **Run**, scrolling and **Close**. The object is selected, as a click selects it, so the agent sees it.
- **Left thumbstick**: move where you look. **Right thumbstick**: up and down, and turn in 30° steps. Hold the **grip** to go 4× faster. **A** or **X** closes the panel; **B** or **Y** goes back.
- **The menu on your left wrist**: Back, Forward, See all, Run all, Exit VR.
- WebXR needs a secure page: the https alpha, or your laptop's server over USB (`adb reverse tcp:8765 tcp:8765`, then http://localhost:8765/ in the headset's browser).
- `node space/test-xr.mjs` checks it without a headset, on Meta's emulated Quest 3 (IWER).

## Running code

Code and plots edit and run on Sagebrush's own engine (Python, Sage, MATLAB, Magma), in your browser. A Sage 3D plot becomes the object in the space. The engine is fetched from sagebrush.space by `npm run serve` on the first Run (about 37 MB, then cached in `.cache/`). Edits are kept in this browser.

## The format: foo.space.json

```json
{ "format": "sagebrush-space", "version": 1, "title": "…",
  "nodes": [
    { "id": "a", "kind": "note", "title": "Hello", "text": "# Markdown", "group": "notes" },
    { "id": "b", "kind": "code", "title": "…", "lang": "python", "text": "print(1)", "output": "1", "near": "a" },
    { "id": "c", "kind": "plot3d", "title": "…", "surface": { "x": [], "y": [], "z": [[]] } },
    { "id": "d", "kind": "file", "title": "path/to/file.ts", "text": "its first lines" }
  ],
  "edges": [ { "from": "a", "to": "b" } ] }
```

- **Coordinates are optional**, as on the board: an agent writes structure, not geometry. `group` clusters objects together, edges pull them together, and `near` (another object's id) places one beside another.
- `position` (and `position2d`, for the plane) is saved by `layout-cli.mjs`, so a space keeps its shape from visit to visit. A new object is placed around what is already there.
