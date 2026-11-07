# N1-6: candidate 4's boundary (design note, prototype branch only)

*#825 N1 plan r3, item N1-6. Candidate 4 keeps pyjs in the system webview (today's page and worker) and links the
engine into the Tauri Rust core. This note asks whether pyjs's synchronous engine call can cross Tauri's
asynchronous IPC without deadlock, with Stop ordering kept, and at what cost. It is a design note, not a
measurement. Claims are marked: **from the code** (read at master 2c7816a2), **from the docs**, or **a guess** (to
test in N1).*

## The mismatch

- **pyjs calls the engine synchronously** (from the code). `src/runtime/engine.ts` `engineCall(request)` returns the
  reply string at once: today it is a wasm call, `sb_call`, on the worker's own thread. Python code waits for it
  inside a cell.
- **Tauri's commands are asynchronous** (from the docs). `invoke()` returns a Promise, and Rust answers through the
  IPC custom protocol. A worker can't turn a Promise into a value without giving up its thread, and pyjs can't
  give up its thread in the middle of a cell.

So candidate 4 needs a synchronous bridge from the worker to Rust.

## Three bridges

| | How | What it needs | Risks |
|---|---|---|---|
| **(a) Atomics.wait relay** | The worker writes the request into a SharedArrayBuffer, posts to the page's main thread and blocks on `Atomics.wait`. The page calls `invoke("engine_call")`, writes the reply into the buffer and `Atomics.notify`s. | Cross-origin isolation (the app already serves COOP/COEP through the localhost plugin: from the code); a page main thread that's free; buffers sized for large replies, or chunking. | Engine calls stall whenever the page's main thread is busy (layout, a modal dialog, a long task). That's a liveness hazard, not a deadlock, unless the page ever waits on the worker. **Two copies** of each payload (the worker's buffer to the page; the page to Rust). |
| **(b) Synchronous XHR to a custom scheme** | The worker makes a synchronous `XMLHttpRequest` to a Tauri custom protocol (`sagebrush-engine://call`), and a Rust handler runs the engine and answers. | WKWebView, WebKitGTK and WebView2 all allowing synchronous XHR **from a worker** to a custom scheme (**a guess**; pyjs already uses synchronous fetches for its engine bytes: `__SAGEBRUSH_FETCH_SYNC__`, from the code). The protocol handler must run off the UI thread (from the docs: Tauri's async protocol handlers). | No page main-thread dependency. But synchronous XHR is deprecated territory, and support for custom schemes from workers differs by engine. **The first thing to test.** |
| **(c) Engine in a helper process** | As (a) or (b), but the Rust side forwards to a per-document engine helper process. | A helper binary and framed IPC. | This restores per-document crash isolation (see Crash). It is then close to candidate 3 without V8, and adds a hop. |

## Stop

- The worker is blocked in (a) or (b), so Stop can't come from it. The page sends a separate
  `invoke("engine_stop", token)`, and the Rust host does `host_stop(token)` (the `host-word` feature on this
  branch). The engine's checks, rayon's included, see it.
- In (a), the page's main thread is free to send Stop, unless it's the thing that's busy (the risk above).
- In (b), the page needs nothing from the worker to send Stop.
- §5.3's ordering applies unchanged. `RUN` lives in the page and worker, as today; the add-on's `ARMED` lives in the
  Rust core. A Stop for a stale token is inert at both.

## Progress, input and permission

- **Progress** today is engine-written shared slots read by the page (from the code: `src/runtime/progress.ts`). The
  Rust engine would instead emit progress through a Tauri Channel to the page, at most ten times a second.
- **`input()` and permission** don't change: both stay in the page and worker exactly as on the web. This is
  candidate 4's main attraction: no control bridge across a process boundary is needed for them.

## Crash

- With the engine linked into the Tauri core (a or b), an engine panic is caught (`sagebrush_interrupt::catch`
  catches only its own unwind; others propagate). But an abort, a stack overflow or memory corruption takes **the
  whole app** down, every document with it.
- So candidate 4's crash/restart rows are **NOT COMPARABLE** with 1, 2 and 3 unless bridge (c) is used.

## JS engine

pyjs runs on JavaScriptCore in candidate 4 on macOS and Linux (WKWebView, WebKitGTK), and on V8 (WebView2) on
Windows. N1's big-integer corpus runs in those webviews for this candidate only (plan r3, N1-8).

## What N1 measures for candidate 4

1. Whether (b) works in all three webviews: synchronous XHR from a worker to a custom scheme. If it doesn't, (a).
2. Per-call cost of (a) and (b):
   - an empty call;
   - `aplist(200000)` (a 226 KB reply);
   - `det` 200×200 (a 137 KB request).

   Each against a direct call in candidate 1.
3. Stop latency during the blocking `spin` export, with the page's main thread idle, and with it busy (for (a)).
4. Whether a busy page main thread stalls engine calls under (a), and for how long.
5. The conformance corpus (plan r3, E2), with crash rows NOT COMPARABLE unless (c).
