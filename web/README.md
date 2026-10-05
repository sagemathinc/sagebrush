# Sagebrush in the browser — https://sagebrush.space

The pyjs compiler and runtime built for browsers: `worker.ts` runs Python
cells in a Web Worker (so the page's Stop button can terminate a runaway
program), and `index.html` is a small notebook UI: Shift+Enter, Jupyter-style
`[n]`/`[*]` prompts and a running indicator, a dependency-free syntax
highlighter (a transparent textarea over a highlighted `<pre>`), a
Python/Sage switch, shareable links in the URL fragment and `?run` to run
on load.

**Sage mode** (also `sagebrush --sage` and `.sage` files): the lexer reads
`^` as `**` and `^^` as xor, `/` on two ints gives an exact `Rational` (and
so does an int to a negative int power), and `lib/sage_all.py` (factor,
is_prime, next_prime, divisors, euler_phi, crt, ...) is star-imported.

    node scripts/build-cli.mjs   # generates the embedded Python library (build/cli/lib.gen.js)
    bun web/build.ts             # web/dist/{index.html, sagebrush-worker.js}, ~0.85 MB

Node APIs are replaced by `web/shims/` (no file system; stdout/stderr are
posted to the page). The Unicode name table for `\N{...}` escapes is left
out of the browser build (it is 1.1 MB).

**Deploy** (`web/site`, a static-assets Worker on the custom domain
sagebrush.space, using Cloudflare's `cf` CLI while logged in):

    bun web/build.ts && cd web/site && npm install && npx cf build && npx cf deploy --prebuilt

Local preview: `cd web/dist && python3 -m http.server` (a module Worker needs http://, not file://).
