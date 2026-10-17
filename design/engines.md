# Engines by their content

An **engine** is what runs code in the browser:
- the worker (`sagebrush-worker.js`), the WebAssembly engine and the Python library's chunks (`lib/`: sources and precompiled code, web/lib-chunks.mts);
- the notebook module, the reactive notebook's analyzer and the 3D viewer;
- the runner's page.

**Each build's engine is published by its content and kept forever** at `https://sagebrush.space/engine/<id>/`. A board or notebook saved with one engine can therefore keep running with it, years later. An exported HTML file records the id it was made with.

## The pieces

- **`web/build.ts`** writes `web/dist/engine/<id>/`:
  - the files;
  - a `manifest.json`: `{format: "sagebrush-engine", id, api, files: {name: {sha256, size, headers}}}`.
  - `<id>` is the first 20 hex digits of the SHA-256 of the manifest's content: the format, `api`, and each file's name, SHA-256, size and response headers (web/engine-id.mts). A build that changes no engine file and no header makes the same id. A change of headers alone, such as a tighter runner policy, is a new engine (SEC-CAC-2).
  - `headers` is what each file is served with: its type, and for the runner's page its Content-Security-Policy (no network) and cross-origin isolation.
- **`web/dist/engine/latest.json`** (`{id, api}`) is the deployed engine, a static file of the site, cached for a minute.
- **`scripts/publish-engine.mjs`** uploads a new engine to R2 (the `sagebrush-releases` bucket, under `engine/<id>/`), manifest last. An id already there is left alone if its manifest is this one (its files never change); if it is another, the script fails rather than leave the old one served. It runs before each deploy of the site.
- **The Python library's chunks** (`lib/<group>.<kind>.<hash>.json`, web/lib-chunks.mts) are also uploaded to R2 at `lib/<name>`, a namespace by content that is never cleared. A deploy replaces the site's own `lib/`, but a page opened before it keeps running its worker, which may first import one of its build's chunks hours later. The site's Worker serves a chunk its files no longer have from there, after checking that its bytes have the hash in its name (web/engines.ts `handleLibChunk`; web/test-pwa-update.mjs; HARD-813-1). The script uploads only the ones R2 does not already have (one listing of `lib/`).
- **The pinned zone data** (`lib/tzdata/<sha256>.tzif` and its index, web/tzdata-chunks.mts) is in each engine's manifest but stored only at the shared `lib/tzdata/`, uploaded once for all engines rather than under every new `engine/<id>/` (346 files a deploy). The Worker serves an engine's zone file from the shared copy if its bytes have the manifest's SHA-256, else from the engine's own copy (an engine published before this), else 404.
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
- the page hands the frame the worker's script, the engine and the library's chunks;
- the frame is a `srcdoc` of its own, sandboxed with an opaque origin, whose policy allows no network but its own `blob:` URLs;
- it makes `blob:` URLs of the files, and the worker reads them through `__SB_FILES__`;
- with no interrupt flag, Stop restarts the worker.

`web/test-runner-files.mjs` (in CI) checks that Python and Sage run that way in a page with no SharedArrayBuffer, and that the worker reaches no network and no storage.

## Integrity

A page that loads an engine by id checks each file against the SHA-256 built into it (the board's export does this). Neither a changed server nor a file whose engine parts were edited can substitute an engine. The latest engine is trusted as the site is, over HTTPS: its manifest must have latest.json's id and api, and its content must give that id (HARD-CAC-4). The file itself is not signed, so an edited file can name another site or carry another script.

## Testing

`node web/test-engines.mjs` (in CI) checks the route in Miniflare, against the engine web/build.ts made:
- each file comes back byte for byte, with its headers;
- the runner page gets the runner's policy;
- an unknown id or file is a 404;
- only GET and HEAD are allowed.
