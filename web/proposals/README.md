# Proposals: a prototype (branch `proposals-proto`, not for merge)

An agent **proposes** a change instead of making it. You see each changed document before and after, in its own terms, and accept or reject it.

## Try it

```sh
git fetch origin proposals-proto && git checkout proposals-proto
bun web/build.ts                          # as usual: web/dist
bun web/proposals/serve.mjs web/dist 8711 # any static server works; this one sets the page's isolation headers
```

Then:

1. Open `http://127.0.0.1:8711/board/` and pair your agent there, as usual.
   - You can also open a page from a preview site, or anything else that serves this `web/dist`.
   - The pairing link is `workspace_connect`'s `/board/?pair=…`. With the CLI's dev origin, set `SAGEBRUSH_MCP_DEV_ORIGIN=http://127.0.0.1:8711`.
2. Open `http://127.0.0.1:8711/proposals/` in another tab, in the same browser.
3. Under **For your agent** there, copy the instructions and paste them to your agent. Then ask it to propose something, for example: "Propose a clearer introduction for /Papers/curves.tex".
4. The proposal appears in the list as soon as the agent writes it. For a `.tex` file, there are three views:
   - **Marked changes:** one rendered document, latexdiff-style. Added text is blue and underlined, removed text is red and struck through. A new block (an equation or an environment) is shown in blue after a **[new:]** mark. A removed block is named in red.
   - **Side by side:** the rendered document before and after.
   - **Source:** a line diff with context.
5. **Accept** writes the files.
   - It is refused if a file was edited after the proposal was made. The agent then rereads the file and updates its proposal.
   - Each replaced text stays in that file's history.
   - A proposal that deletes a file asks first.
6. **Reject** leaves your files alone.

## What a proposal is

A proposal is a folder the agent writes with the workspace tools it already has (sagebrush-mcp 0.8.2), so no new release is needed:

```
/Proposals/<name>/proposal.json   {"title", "description", "author", "changes": [{"path", "file", "base"?, "action"?}]}
/Proposals/<name>/<file>          each proposed file's complete new text
```

## What it isn't yet

- It is not the agent's own workspace. William's direction (Nov 3) is that the agent works in its own copy of the files, verifies its work fully, and then proposes. Here, the agent writes into a folder in yours.
- There are no notebook, board or Markdown views yet. The rendered diff is LaTeX only; other files show the source diff.
- Accept doesn't use an approval step or passkey. Protection here means only that a delete asks first.
- `web/proposals/texdiff.ts` is the small rendered-diff component: it tokenizes the LaTeX, runs a Myers diff over the tokens, and writes `\DIFadd` and `\DIFdel` marks into the source. The proposals page also uses `lineDiff`, the line diff from `web/latex/posmap.ts`.
