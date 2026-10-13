# Engines by their content

An **engine** is what runs code in the browser:
- the worker (`sagebrush-worker.js`), the WebAssembly engine and the precompiled library;
- the notebook module, the reactive notebook's analyzer and the 3D viewer;
- the runner's page.

**Each build's engine is published by its content and kept forever** at `https://sagebrush.space/engine/<id>/`. A board or notebook saved with one engine can therefore keep running with it, years later. An exported HTML file records the id it was made with.

## The pieces

- **`web/build.ts`** writes `web/dist/engine/<id>/`:
  - the files;
  - a `manifest.json`: `{format: "sagebrush-engine", id, api, files: {name: {sha256, size, headers}}}`.
  - `<id>` is the first 20 hex digits of the SHA-256 of the files' names and hashes, so a build that changes no engine file makes the same id.
  - `headers` is what each file is served with: its type, and for the runner's page its Content-Security-Policy (no network) and cross-origin isolation.
- **`web/dist/engine/latest.json`** (`{id, api}`) is the deployed engine, a static file of the site, cached for a minute.
- **`scripts/publish-engine.mjs`** uploads a new engine to R2 (the `sagebrush-releases` bucket, under `engine/<id>/`), manifest last. An id already there is left alone: its files never change. It runs before each deploy of the site.
- **`web/engines.ts`** is the site Worker's route for `/engine/<id>/<file>`. It serves the file from R2 with the manifest's headers, plus:
  - `Cache-Control: immutable`;
  - `Access-Control-Allow-Origin: *`, so pages and downloaded files anywhere can read it;
  - `nosniff`.

  It also keeps a copy in the edge cache. A file not in the manifest, or an engine that doesn't exist, is a 404.

## `api`

`api` is the version of the interface between a page and an engine: `WorkerKernel`, `RunnerWorker` and the worker's messages. A page uses another engine, such as the latest from an old file, only if its `api` is the same; otherwise it uses its own. Raise it whenever that interface changes incompatibly.

## Files mode: a page that carries its engine

A board downloaded as one HTML file can embed the engine. A `file://` page is never cross-origin isolated, so there is no SharedArrayBuffer and so no broker.

`RunnerWorker` in files mode (`new RunnerWorker(null, {files})`):
- the page hands the frame the worker's script, the engine and the precompiled library;
- the frame is a `srcdoc` of its own, sandboxed with an opaque origin, whose policy allows no network but its own `blob:` URLs;
- it makes `blob:` URLs of the files, and the worker reads them through `__SB_FILES__`;
- with no interrupt flag, Stop restarts the worker.

`web/test-runner-files.mjs` (in CI) checks that Python and Sage run that way in a page with no SharedArrayBuffer, and that the worker reaches no network and no storage.

## Integrity

A page that loads an engine by id checks each file against the SHA-256 built into it (the board's export does this). Neither a changed server nor an edited file can substitute an engine. The latest engine is trusted as the site is, over HTTPS.

## Testing

`node web/test-engines.mjs` (in CI) checks the route in Miniflare, against the engine web/build.ts made:
- each file comes back byte for byte, with its headers;
- the runner page gets the runner's policy;
- an unknown id or file is a 404;
- only GET and HEAD are allowed.
