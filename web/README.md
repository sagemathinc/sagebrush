# Sagebrush in the browser — https://sagebrush.space

The pyjs compiler and runtime built for browsers: `worker.ts` runs Python
in a Web Worker (so the page's Stop button can terminate a runaway program),
and `index.html` is a small notebook UI:

- Shift+Enter, Jupyter-style `[n]`/`[*]` prompts, a running indicator, a
  focus bar; a ⋯ menu per cell (insert above/below, move up/down, clear,
  delete) and Alt+↑/↓ to move cells.
- A dependency-free syntax highlighter (a transparent textarea over a
  highlighted `<pre>`).
- **Console**: an interactive prompt in xterm.js (`console.ts`, its own
  356 kB file loaded only when opened) sharing `__main__` with the notebook:
  history, Tab completion (the CLI's, from `src/interactive.ts`),
  auto-indent, paste, Ctrl+C.
- Light/dark/system themes; Python/Sage switch; shareable links in the URL
  fragment and `?run` to run on load.
- Accessibility: labelled controls and cells, an ARIA menu with arrow keys,
  Esc then Tab leaves a cell, a live region announcing finished cells and
  console output, WCAG AA contrast in both themes, reduced motion.
- For agents: `llms.txt`, and two WebMCP tools, `run_python` and
  `read_notebook` (`navigator.modelContext`; Chrome 149 needs
  `--enable-experimental-web-platform-features`).

Lighthouse 13.4 (mobile and desktop): 100 in performance, accessibility,
best practices, SEO and agentic browsing.

**Sage mode** (also `sagebrush --sage` and `.sage` files): the lexer reads
`^` as `**` and `^^` as xor, `/` on two ints gives an exact `Rational` (and
so does an int to a negative int power), and `lib/sage_all.py` (factor,
is_prime, next_prime, divisors, euler_phi, crt, ...) is star-imported.

    node scripts/build-cli.mjs   # generates the embedded Python library (build/cli/lib.gen.js)
    bun web/build.ts             # web/dist/{index.html, llms.txt, sagebrush-worker.js (0.85 MB), sagebrush-console.js}

Node APIs are replaced by `web/shims/` (no file system; stdout/stderr are
posted to the page). The Unicode name table for `\N{...}` escapes is left
out of the browser build (it is 1.1 MB).

**Deploy** (`web/site`, a static-assets Worker on the custom domain
sagebrush.space, using Cloudflare's `cf` CLI while logged in):

    bun web/build.ts && cd web/site && npm install && npx cf build && npx cf deploy --prebuilt

Local preview: `cd web/dist && python3 -m http.server` (a module Worker needs http://, not file://).
