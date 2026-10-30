# The runner: Python where an escape gets nothing

*Status: the default on the notebook page and on boards, and the only way the shared-collection page runs code. The interpreter in it has no network at all. Every notebook and board browser suite passes with it. It still runs from a path of sagebrush.space; the user-content domain comes next.*

## Why

Python compiled to JavaScript runs in a Web Worker. Without the runner, that worker has the page's origin. Any escape from Python's sandbox into JavaScript (design/security.md lists those found and fixed) would get that origin's power:
- the IndexedDB holding every notebook, board and file kept in the browser;
- requests to any site;
- in an embed, the host site's origin.

The runner moves the interpreter somewhere with **no storage, no page and no network**.

## How

`RunnerWorker` (web/notebook/runner-worker.js) is a drop-in for `new Worker("sagebrush-worker.js")`. `WorkerKernel`, the notebook, boards and the console don't change.

1. **The frame.** It adds a hidden `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) showing web/runner/index.html. The frame's origin is opaque: no cookies, no IndexedDB, no localStorage, and no access to the page.
2. **The worker.** The page fetches `sagebrush-worker.js` itself and sends its text with one message carrying a `MessagePort`. The frame starts it as a classic worker from a `blob:` URL. (Chrome refuses a *module* worker from a `blob:` in an opaque origin, and the bundle has no imports or exports.)
3. **No network.** The runner's Content-Security-Policy (web/csp-policy.mts, `runnerPolicy`), which the `blob:` worker inherits, is:
   - `default-src 'none'`;
   - scripts: its inline script by hash, `blob:`, `'unsafe-eval'` (compiled Python) and `'wasm-unsafe-eval'`;
   - **`connect-src 'none'`.**
4. **Files the interpreter needs** (its engine, its precompiled library, the files of a shared collection it was told to mount) are fetched by the page and handed over:
   - the worker asks the frame;
   - the page fetches, but only those files: its own interpreter files, and URLs it mounted;
   - the frame copies the bytes, a 4 MB chunk at a time, into a SharedArrayBuffer while the worker waits on `Atomics.wait`. Python's file reads are synchronous.
   - The worker still checks each file's SHA-256.
5. **Relaying.** Other messages go page ↔ frame ↔ worker.
6. **Stop.** The interrupt flag stays in the frame, which is cross-origin isolated (`allow="cross-origin-isolated"` and the site's COOP/COEP). The page asks for Stop by message. KeyboardInterrupt keeps the variables. The worker's shared progress slots (its `ready` message's `progress`) stay in the frame too: the frame forwards `ready` without them, since a SharedArrayBuffer can't cross to the page.
7. **input().** A run that calls `input()` posts `{id, input: {prompt, max, key}, buffer}` and waits on `buffer` (web/worker.ts's `stdin`):
   - **The buffer:** Int32 `[0]` is the state (0 waiting, 1 a line, 2 end of input) and `[1]` the line's length in bytes; the UTF-8 bytes follow. It is the answer's own SharedArrayBuffer, not the interrupt flag.
   - **The buffer stays in the frame**, like the interrupt flag: the frame keeps it by the request's `key` with its run's id, and forwards the question to the page without it.
   - **The page answers by message:** `{runnerInput: id, key, text}`, where `text` is the line, or null for end of input. The frame writes the line (cut to fit, at a character's boundary) only to the open request with that key and run, and only once.
   - **A request is over** when it is answered, when its run asks another question or ends, and on a Stop. An answer to a request that is over writes nothing: a line typed into a field from before a caught KeyboardInterrupt can't fill the next `input()`. The key is the worker's random tag and a count, so an answer meant for a previous worker matches nothing either.
   - **A Stop wins** over an answer that arrives during the same wait (src/stdin-wait.ts). The page's kernel retires the question's reply on the same events, and the notebook removes its field then.

**Not a secure context.** The worker in the opaque frame has no `crypto.subtle`, so it checks hashes with the synchronous SHA-256 in src/runtime/sha256.ts.

**Where it is used:**
- **Always** on the shared-collection page (someone else's code), with no fallback.
- **By default** on the notebook page and on boards, where the page is cross-origin isolated and not the desktop app. There, if the frame doesn't answer within a few seconds, a plain worker is used instead. Offline, a service worker doesn't serve a sandboxed frame. `?runner=0` turns the runner off, on a loopback host only (for tests): on the site, a link could add it to someone else's code, which would then run with the site's origin, its storage and its sign-in cookie.

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

1. **Bound every message from the runner** on the page side: everything from the runner is untrusted. Outputs already are (design/security.md, rules 1–4).
2. **The user-content domain** (`run.cocalcusercontent.com`): a second wall. A different site adds process isolation and partitions the HTTP cache. This needs:
   - the page's `frame-src` widened to it;
   - the runner's `frame-ancestors` set to the sites that may embed it.
3. **Startup without V8's code cache:** a `blob:` worker compiles its script afresh each time. It is about 330 ms to ready, against 165 ms for a plain worker.
4. **Firefox and Safari:** opaque-origin cross-origin isolation, and classic `blob:` workers in sandboxed frames.
5. **Then the attribute-read backstop** (`SAGEBRUSH_HARDENED`) can default off: the runner contains what it was guarding against.
