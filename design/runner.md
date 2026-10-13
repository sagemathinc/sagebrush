# The runner: Python where an escape gets nothing

*Status: built and tested behind a flag (`?runner` on the notebook page). It becomes the default once every browser suite passes with it and it runs from the user-content domain.*

## Why

Python compiled to JavaScript runs in a Web Worker. Without the runner, that worker has the page's origin. Any escape from Python's sandbox into JavaScript (design/security.md lists those found and fixed) would get that origin's power:
- the IndexedDB holding every notebook, board and file kept in the browser;
- requests to any site;
- in an embed, the host site's origin.

The runner moves the interpreter somewhere with **no storage, no page and no network**.

## How

`RunnerWorker` (web/notebook/runner-worker.js) is a drop-in for `new Worker("sagebrush-worker.js")`. `WorkerKernel`, the notebook, boards and the console don't change.

1. **The frame.** It adds a hidden `<iframe sandbox="allow-scripts">` (with no `allow-same-origin`) showing web/runner/index.html. The frame's origin is opaque: no cookies, no IndexedDB, no localStorage, and no access to the page.
2. **The worker.** The page sends the frame one message carrying a `MessagePort`. The frame:
   - fetches `sagebrush-worker.js` with CORS (optionally checking its SHA-256);
   - starts it as a classic worker from a `blob:` URL. Chrome refuses a *module* worker from a `blob:` in an opaque origin, and the bundle has no imports or exports;
   - tells the worker where its other files (the engine, the precompiled library) are.
3. **Relaying.** From then on messages go page ↔ frame ↔ worker.
4. **Stop.** The interrupt flag (a SharedArrayBuffer) stays in the frame, which is cross-origin isolated (`allow="cross-origin-isolated"` and the site's COOP/COEP). The page asks for Stop by message. KeyboardInterrupt keeps the variables, as without the runner.

**The runner page's Content-Security-Policy** (web/csp-policy.mts `runnerPolicy`), which the `blob:` worker inherits:
- `default-src 'none'`;
- scripts: the page's own inline script by hash, `blob:`, `'unsafe-eval'` (compiled Python) and `'wasm-unsafe-eval'`;
- `connect-src 'self'`: Sagebrush's own static files, which are served with `Access-Control-Allow-Origin: *`.

So code in the worker can read the files it is sent, but can't send them anywhere:
- other sites, WebSockets and beacons are blocked by the policy;
- the site's pages aren't readable (no CORS);
- cookies aren't sent (an opaque origin is cross-site to everything).

## Measured

In headless Chromium (web/test-runner.mjs):
- **Startup:** about 300 ms to ready, against about 265 ms without the runner, so about 35 ms more.
- **Isolation:** from inside the frame and inside its worker:
  - the origin is `null`;
  - localStorage and IndexedDB fail;
  - there's no parent document;
  - fetches elsewhere fail, as do the site's pages and WebSockets;
  - Sagebrush's static files load;
  - each blocked attempt is a CSP report.
- **The test discriminates:** without `?runner`, the same probes find the page's origin and its storage.

## Next

1. **Every browser suite with `?runner`:** notebook, widgets, TimeTravel replay (the worker's name carries replay's parameters, and is passed through), boards, the console. Then the runner becomes the default.
2. **The user-content domain** (`run.cocalcusercontent.com`): a second wall. A different site adds process isolation and partitions the HTTP cache.
3. **A strict check of each message's shape** on the page side: everything from the runner is untrusted. Outputs already are (design/security.md, rules 1–4).
4. **Firefox and Safari:** opaque-origin cross-origin isolation, and `blob:` workers in sandboxed frames.
5. **Then the attribute-read backstop** (`SAGEBRUSH_HARDENED`) can default off: the runner contains what it was guarding against.
