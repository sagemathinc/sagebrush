# Agent flows: the case format

A person asks an agent for something; the thing gets made, opens, runs and shows its result, with the agent still there to continue. Each case here says what the agent does and what the person must see, and `test-agent-flows.mjs` runs it on every surface it names:

- **mcp**: sagebrush-mcp's own server (engine/py/python/sagebrush/mcp_server.py), its tool calls as Claude Code makes them, paired with the notebook page through the one link it gives.
- **chat**: the Agents page (/agents/), paired with a scripted stand-in for sagebrush-agent. The person sends the prompt; the stand-in plays the case's tool calls in that turn as the page verbs sagebrush-agent makes, and shows them as sagebrush-agent does: a tool call started and finished, and a file it wrote as an artifact beside the chat. It speaks for the published sagebrush-agent 0.7.7 in the part these cases use: its hello offers notebook.edit, run.context and edit.turn (0.7.7's also offers permission.digest, chat.resume, chat.steer, egress.turn and chat.resume.tag, which these cases don't use), so an existing notebook is changed by cell (`workspace_edit_notebook`, from a `workspace_read` of it), never written whole, and a run and an edit each say the chat turn they come from. A case that changes a notebook on chat does it that way.

No model is called: the agent's side is the case's script. The harness does the pairing and the grant, and runs the page in headless Chrome.

```sh
SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=chromium bun web/agent-flows/test-agent-flows.mjs [--case ID] [--surface mcp|chat]
```

`SAGEBRUSH_LATEX_PREVIEW=test` is the LaTeX editor's test build, the only one whose hosts include loopback: without it the
editor's page doesn't come up on 127.0.0.1, and a case with a `.tex` (sagetex-derivative) can't show its document.

`SHOT_DIR=dir` keeps a screenshot at each `h.shot(name)`.

## A case

One file per scenario, `cases/<id>.mjs`:

```js
export default {
  id: "matlab-notebook",
  prompt: "make a MATLAB notebook plotting sin(x^2)",   // what the person types (sent from the composer on chat)
  surfaces: ["mcp", "chat"],
  grant: { folders: ["/"], write: true, run: true },    // what the person allows (this is the default)
  given: { "/course/ode.ipynb": { json: { cells: [{ code: "..." }] } } },   // (optional) the person's files before
  agent: [                                              // the agent's tool calls, by sagebrush-mcp's names
    { tool: "workspace_create", args: { path: "/sin.ipynb", mode: "matlab", content: { json: { cells: [{ code: "x = linspace(0, 3, 200);\nplot(x, sin(x.^2))" }] } } } },
  ],
  async expect(h) {
    await h.shown("/sin.ipynb");
    await h.ran("/sin.ipynb", { images: 1, errors: 0 });
    h.ok((await h.read("/sin.ipynb"))?.mode === "matlab", "a MATLAB notebook");
    await h.agentStillThere();
  },
};
```

- `unpaired(h)`, instead of the harness's pairing: what the agent does before anything is connected (the one-link case).
- `gaps: { chat: "why" }`: a declared known gap on a surface, for the report only. The case still runs and still fails there; the report names the declared gap (it doesn't say which of the failed checks it covers), and once the case passes it says to take the gap out.
- `ms`: the case's budget, 120 s unless it says otherwise.

What makes a notebook run, the intended rule on every surface (decided Nov 19 2026): a notebook the agent has just created runs once by itself when the person's grant has both Everything and May run code. With a narrower grant, it waits for the person's Run. The notebook page does this today; the Agents page's pane doesn't yet, a known gap the cases record. A case that checks the self-run must not call `workspace_run_notebook` first; the agent may call it to run again after an edit.

## The helpers (h)

| helper | what it does |
|---|---|
| `h.tool(name, args)` | one more agent tool call on this surface: `{ text, structured, isError }` |
| `h.shown(path, ms?)` | waits until exactly `path` is what the person sees (the notebook page's notebook; the Agents page's pane tab, on chat) |
| `h.ran(path, { images, errors, text }, ms?)` | waits until it has run: at least `images` images, exactly `errors` errors, and `text` (a RegExp) in some output. Checked as the person sees it (the notebook page's notebook, or the pane's rendered cells, while exactly `path` is shown) and on the saved copy; both must have it |
| `h.read(path)` | the saved copy, as the agent reads it: `{ mode, cells, text }`, or null |
| `h.files()` | the workspace's paths |
| `h.open(urlOrPath)` | navigates as the person would (a link, Open in Sagebrush) |
| `h.agentStillThere()` | the agent's next call works |
| `h.ev(js)`, `h.until(js, ms?)` | the page, for anything else |
| `h.click(selector)` | a real click at the element's centre (the mouse, not `el.click()`): a tab it opens opens |
| `h.tab(match, ms?)` | the tab the person opened whose address matches `match` (a RegExp): `{ ev, until, shot, close }`, closed when the case ends |
| `h.ok(cond, msg, detail?)`, `h.shot(name)` | a check, and a screenshot |

`h.surface` is `"mcp"` or `"chat"` where they differ. A case fails on an error on the page, on a Connect or Allow that doesn't come, or past its budget.

A helper a case needs that isn't here: write it in the case first, then move it into `harness.mjs`.
